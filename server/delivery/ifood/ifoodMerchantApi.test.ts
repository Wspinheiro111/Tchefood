import { describe, expect, it, vi } from "vitest";
import { DeliveryMarketplaceError } from "../marketplace";
import { IFOOD_PATHS, IfoodMerchantApi, mapIfoodEventCode, mapIfoodOrder, mapIfoodStoreStatus, parseIfoodEvent } from "./ifoodMerchantApi";
import { IfoodSandbox } from "./ifoodSandbox";

function makeApi(sandbox: IfoodSandbox, overrides: Partial<ConstructorParameters<typeof IfoodMerchantApi>[0]> = {}) {
  return new IfoodMerchantApi({
    credentials: { clientId: sandbox.clientId, clientSecret: sandbox.clientSecret },
    merchantIds: [sandbox.merchantId],
    baseUrl: sandbox.baseUrl,
    fetchImpl: sandbox.fetch,
    ...overrides,
  });
}

const PICANHA = { name: "Picanha na chapa", externalCode: "201", quantity: 2, unitPrice: 89.9 };

describe("iFood: códigos de evento", () => {
  it("traduz os códigos do ciclo do pedido e marca o resto como desconhecido", () => {
    expect(mapIfoodEventCode("PLC")).toBe("placed");
    expect(mapIfoodEventCode("CFM")).toBe("confirmed");
    expect(mapIfoodEventCode("RTP")).toBe("ready_for_pickup");
    expect(mapIfoodEventCode("DSP")).toBe("dispatched");
    expect(mapIfoodEventCode("CON")).toBe("concluded");
    expect(mapIfoodEventCode("CAN")).toBe("cancelled");
    expect(mapIfoodEventCode("CAR")).toBe("cancellation_requested");
    expect(mapIfoodEventCode("CARF")).toBe("cancellation_denied");
    expect(mapIfoodEventCode("PRS")).toBe("preparing");
    expect(mapIfoodEventCode("CCR")).toBe("customer_cancellation_requested");
    expect(mapIfoodEventCode("HSD")).toBe("dispute_opened");
    expect(mapIfoodEventCode("HSS")).toBe("dispute_settled");
    // Entregador, troca de endereço etc.: só histórico.
    expect(mapIfoodEventCode("ADR")).toBe("unknown");
    expect(mapIfoodEventCode("XYZ")).toBe("unknown");
  });

  it("recusa evento sem id ou sem pedido", () => {
    expect(() => parseIfoodEvent({ code: "PLC", orderId: "x" })).toThrow(DeliveryMarketplaceError);
    expect(() => parseIfoodEvent({ id: "e1", code: "PLC" })).toThrow(/orderId/);
  });
});

describe("iFood: tradução do pedido", () => {
  it("converte reais em centavos e soma itens, taxa e desconto", () => {
    const sandbox = new IfoodSandbox();
    const api = makeApi(sandbox);
    const id = sandbox.placeOrder({
      items: [PICANHA, { name: "Coca-Cola 2L", externalCode: "501", quantity: 1, unitPrice: 14.5 }],
      deliveryFee: 7.99,
      benefits: 10,
      payment: { method: "CASH", prepaid: false, changeFor: 200 },
    });
    return api.getOrder(id).then((order) => {
      expect(order.items.map((item) => item.totalPriceCents)).toEqual([17980, 1450]);
      expect(order.totals).toEqual({ itemsCents: 19430, deliveryFeeCents: 799, additionalFeesCents: 0, benefitsCents: 1000, benefitsSponsoredByMarketplaceCents: 0, orderCents: 19229 });
      expect(order.payments).toEqual([{ method: "cash", prepaid: false, amountCents: 19229, cardBrand: null, changeForCents: 20000 }]);
      expect(order.pendingCents).toBe(19229);
      expect(order.address?.city).toBe("Santo Ângelo");
      expect(order.courier).toBe("marketplace");
      expect(order.warnings).toEqual([]);
    });
  });

  it("aceita item sem código PDV, mas avisa o lojista", async () => {
    const sandbox = new IfoodSandbox();
    const id = sandbox.placeOrder({ items: [{ name: "Item novo", externalCode: null, quantity: 1, unitPrice: 20 }] });
    const order = await makeApi(sandbox).getOrder(id);
    expect(order.items[0].externalCode).toBeNull();
    expect(order.warnings[0]).toMatch(/sem código PDV/);
  });

  it("aponta total que não fecha em vez de corrigir sozinho", () => {
    const order = mapIfoodOrder({
      id: "abc",
      displayId: "77",
      createdAt: "2026-11-09T12:00:00Z",
      orderType: "TAKEOUT",
      items: [{ id: "i1", name: "X", externalCode: "1", quantity: 1, unitPrice: 10, totalPrice: 10 }],
      total: { subTotal: 10, deliveryFee: 0, benefits: 0, orderAmount: 12 },
      payments: { methods: [{ value: 12, method: "PIX", type: "ONLINE" }] },
    });
    expect(order.fulfillment).toBe("takeout");
    expect(order.address).toBeNull();
    expect(order.warnings.some((warning) => warning.includes("não fecha"))).toBe(true);
  });

  it("recusa pedido sem itens ou com valor negativo", () => {
    const base = { id: "abc", createdAt: "2026-11-09T12:00:00Z", total: { subTotal: 10, orderAmount: 10 } };
    expect(() => mapIfoodOrder({ ...base, items: [] })).toThrow(/sem itens/);
    expect(() =>
      mapIfoodOrder({ ...base, items: [{ id: "i", name: "X", quantity: 1, unitPrice: -1, totalPrice: 10 }] }),
    ).toThrow(/inválido/);
  });
});

describe("iFood: chamadas HTTP", () => {
  it("pega token uma vez, reaproveita e manda o merchant no polling", async () => {
    const sandbox = new IfoodSandbox();
    const spy = vi.fn(sandbox.fetch);
    const api = makeApi(sandbox, { fetchImpl: spy as unknown as typeof fetch });
    sandbox.placeOrder({ items: [PICANHA] });
    const [first, second] = await Promise.all([api.pollEvents(), api.pollEvents()]);
    expect(first).toHaveLength(1);
    expect(second[0].signal).toBe("placed");
    expect(sandbox.stats.tokenRequests).toBe(1);
    const pollCall = spy.mock.calls.find(([url]) => String(url).includes("events:polling"));
    expect((pollCall?.[1]?.headers as Record<string, string>)["x-polling-merchants"]).toBe(sandbox.merchantId);
  });

  it("polling sem eventos (204) devolve lista vazia", async () => {
    const sandbox = new IfoodSandbox();
    await expect(makeApi(sandbox).pollEvents()).resolves.toEqual([]);
  });

  it("renova o token quando o iFood responde 401 e repete a chamada", async () => {
    const sandbox = new IfoodSandbox();
    const api = makeApi(sandbox);
    await api.pollEvents();
    sandbox.revokeTokens();
    sandbox.placeOrder({ items: [PICANHA] });
    await expect(api.pollEvents()).resolves.toHaveLength(1);
    expect(sandbox.stats.tokenRequests).toBe(2);
  });

  it("credencial errada vira auth_failed", async () => {
    const sandbox = new IfoodSandbox();
    const api = makeApi(sandbox, { credentials: { clientId: sandbox.clientId, clientSecret: "errada" } });
    await expect(api.pollEvents()).rejects.toMatchObject({ code: "auth_failed" });
  });

  it("erro 5xx é transitório; 400 não é", async () => {
    const sandbox = new IfoodSandbox();
    const api = makeApi(sandbox);
    sandbox.failNext("events:polling", 503);
    const error = await api.pollEvents().catch((caught: DeliveryMarketplaceError) => caught);
    expect(error).toMatchObject({ code: "unavailable", httpStatus: 503 });
    expect((error as DeliveryMarketplaceError).retryable).toBe(true);

    const id = sandbox.placeOrder({ items: [PICANHA] });
    await expect(api.performAction(id, "start_preparation")).rejects.toMatchObject({ code: "invalid_request", retryable: false });
  });

  it("confirma, despacha só com motoboy próprio e lista motivos de cancelamento", async () => {
    const sandbox = new IfoodSandbox();
    const api = makeApi(sandbox);
    const id = sandbox.placeOrder({ items: [PICANHA], deliveredBy: "MERCHANT" });
    await api.performAction(id, "confirm");
    await api.performAction(id, "dispatch");
    expect(sandbox.lastEventCode(id)).toBe("DSP");
    const reasons = await api.listCancellationReasons(id);
    expect(reasons[0]).toEqual({ code: "501", description: "Problemas de sistema" });
  });

  it("iFood que manda cabeçalho e trava no corpo cai no prazo e não prende o polling", async () => {
    const sandbox = new IfoodSandbox();
    const stalled = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes("events:polling")) return sandbox.fetch(input, init);
      const body = new ReadableStream({ start() {} });
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const api = makeApi(sandbox, { fetchImpl: stalled, timeoutMs: 30 });
    await expect(api.pollEvents()).rejects.toMatchObject({ code: "unavailable", message: expect.stringMatching(/tempo esgotado/) });
  });

  it("recusa id de pedido com caractere estranho sem chamar a rede", async () => {
    const sandbox = new IfoodSandbox();
    const spy = vi.fn(sandbox.fetch);
    const api = makeApi(sandbox, { fetchImpl: spy as unknown as typeof fetch });
    await expect(api.getOrder("../merchant")).rejects.toMatchObject({ code: "invalid_request" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("não aceita credencial vazia", () => {
    expect(() => new IfoodMerchantApi({ credentials: { clientId: "", clientSecret: "x" } })).toThrow(/client_id/);
  });
});

describe("iFood: conferência com a documentação oficial", () => {
  it("evento sem pedido é confirmado e ignorado; sem id é descartado; um evento ruim não derruba o lote", async () => {
    const sandbox = new IfoodSandbox();
    const api = makeApi(sandbox);
    sandbox.pushRawEvent({ id: "evt-sem-pedido", code: "PLC", createdAt: "2026-11-14T10:00:00Z", merchantId: sandbox.merchantId });
    sandbox.pushRawEvent({ code: "PLC", orderId: "x" });
    sandbox.placeOrder({ items: [PICANHA] });
    const events = await api.pollEvents();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ externalEventId: "evt-sem-pedido", externalOrderId: "", signal: "unknown" });
    expect(events[1].signal).toBe("placed");
  });

  it("horário do evento sai sempre em UTC, mesmo com fuso ou sem milissegundos", () => {
    const event = parseIfoodEvent({ id: "e1", code: "CFM", orderId: "o1", createdAt: "2026-11-14T07:00:00-03:00" });
    expect(event.createdAt).toBe("2026-11-14T10:00:00.000Z");
    expect(parseIfoodEvent({ id: "e2", code: "CFM", orderId: "o1" }).createdAt).toBe("1970-01-01T00:00:00.000Z");
  });

  it("pedido agendado traz janela, início de preparo, código de retirada e teste", async () => {
    const sandbox = new IfoodSandbox();
    const id = sandbox.placeOrder({
      items: [PICANHA],
      deliveredBy: "IFOOD",
      pickupCode: "4821",
      isTest: true,
      schedule: { start: "2026-11-14T22:00:00.000Z", end: "2026-11-14T22:30:00.000Z", preparationStart: "2026-11-14T21:20:00.000Z" },
    });
    const order = await makeApi(sandbox).getOrder(id);
    expect(order).toMatchObject({
      scheduledFor: "2026-11-14T22:00:00.000Z",
      scheduledUntil: "2026-11-14T22:30:00.000Z",
      preparationStartAt: "2026-11-14T21:20:00.000Z",
      pickupCode: "4821",
      isTest: true,
    });
  });

  it("pedido imediato não tem janela de agendamento", async () => {
    const sandbox = new IfoodSandbox();
    const order = await makeApi(sandbox).getOrder(sandbox.placeOrder({ items: [PICANHA] }));
    expect(order.scheduledFor).toBeNull();
    expect(order.scheduledUntil).toBeNull();
    expect(order.isTest).toBe(false);
  });

  it("desconto pago pelo iFood fica separado do desconto da loja", async () => {
    const sandbox = new IfoodSandbox();
    const ifood = await makeApi(sandbox).getOrder(sandbox.placeOrder({ items: [PICANHA], benefits: 15, benefitsSponsor: "IFOOD" }));
    expect(ifood.totals).toMatchObject({ benefitsCents: 1500, benefitsSponsoredByMarketplaceCents: 1500 });
    const loja = await makeApi(sandbox).getOrder(sandbox.placeOrder({ items: [PICANHA], benefits: 15, benefitsSponsor: "MERCHANT" }));
    expect(loja.totals).toMatchObject({ benefitsCents: 1500, benefitsSponsoredByMarketplaceCents: 0 });
  });

  it("patrocínio com valor inválido recusa o pedido em vez de inventar número", () => {
    const base = {
      id: "abc",
      createdAt: "2026-11-09T12:00:00Z",
      items: [{ id: "i1", name: "X", externalCode: "1", quantity: 1, unitPrice: 10, totalPrice: 10 }],
      total: { subTotal: 10, benefits: 2, orderAmount: 8 },
    };
    expect(() => mapIfoodOrder({ ...base, benefits: [{ value: 2, sponsorshipValues: [{ name: "IFOOD", value: -2 }] }] })).toThrow(/inválido/);
  });

  it("complementos: totalPrice = price + optionsPrice (optionsPrice já soma todas as unidades)", async () => {
    const sandbox = new IfoodSandbox();
    const order = await makeApi(sandbox).getOrder(
      sandbox.placeOrder({ items: [{ name: "Xis", externalCode: "301", quantity: 2, unitPrice: 30, options: [{ name: "Bacon", quantity: 1, unitPrice: 5 }] }] }),
    );
    expect(order.items[0]).toMatchObject({ unitPriceCents: 3000, optionsPriceCents: 1000, totalPriceCents: 7000 });
    expect(order.totals.itemsCents).toBe(7000);
    expect(order.warnings).toEqual([]);
  });

  it("negociação: lê o id e as propostas do evento e responde aceitar, recusar ou propor", async () => {
    const sandbox = new IfoodSandbox();
    const api = makeApi(sandbox);
    const orderId = sandbox.placeOrder({ items: [PICANHA] });
    await api.acknowledge(await api.pollEvents());
    const disputeId = sandbox.openDispute(orderId, { alternatives: ["REFUND_PARTIAL"] });
    const [event] = await api.pollEvents();
    expect(event.signal).toBe("dispute_opened");
    expect(event.dispute).toMatchObject({ id: disputeId, action: "CANCELLATION" });
    expect(event.dispute?.alternatives[0]?.type).toBe("REFUND_PARTIAL");

    await expect(api.respondToDispute(disputeId, { kind: "reject", reason: "  " })).rejects.toMatchObject({ code: "invalid_request" });
    await api.respondToDispute(disputeId, { kind: "alternative", alternativeId: event.dispute!.alternatives[0]!.id });
    expect(sandbox.eventHistory().at(-1)?.code).toBe("HSS");
  });

  it("negociação sem id utilizável não vira negociação respondível", () => {
    const event = parseIfoodEvent({ id: "e1", code: "HSD", orderId: "o1", metadata: { action: "CANCELLATION" } });
    expect(event.signal).toBe("dispute_opened");
    expect(event.dispute).toBeNull();
    expect(parseIfoodEvent({ id: "e2", code: "HSD", orderId: "o1", metadata: { disputeId: "../x" } }).dispute).toBeNull();
  });

  it("loja: status, pausa pelo período pedido e retomada", async () => {
    const now = new Date("2026-11-14T15:00:00.000Z");
    const sandbox = new IfoodSandbox(undefined, undefined, () => now);
    const api = makeApi(sandbox);
    expect((await api.getStoreStatus(sandbox.merchantId)).state).toBe("open");
    const pause = await api.pauseStore(sandbox.merchantId, {
      description: "Falta de gás",
      start: "2026-11-14T15:00:00.000Z",
      end: "2026-11-14T15:30:00.000Z",
    });
    expect(pause).toMatchObject({ description: "Falta de gás", end: "2026-11-14T15:30:00.000Z" });
    const status = await api.getStoreStatus(sandbox.merchantId);
    expect(status).toMatchObject({ state: "closed", message: "Loja fechada por pausa programada" });
    expect(await api.listPauses(sandbox.merchantId)).toHaveLength(1);
    await api.resumeStore(sandbox.merchantId, pause.id);
    expect((await api.getStoreStatus(sandbox.merchantId)).state).toBe("open");
  });

  it("pausa com fim antes do início ou sem motivo não chama o iFood", async () => {
    const sandbox = new IfoodSandbox();
    const spy = vi.fn(sandbox.fetch);
    const api = makeApi(sandbox, { fetchImpl: spy as unknown as typeof fetch });
    await expect(api.pauseStore(sandbox.merchantId, { description: "x", start: "2026-11-14T15:00:00Z", end: "2026-11-14T14:00:00Z" })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(api.pauseStore(sandbox.merchantId, { description: " ", start: "2026-11-14T15:00:00Z", end: "2026-11-14T16:00:00Z" })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(api.resumeStore("../x", "p")).rejects.toMatchObject({ code: "invalid_request" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("status da loja: aberta se alguma operação estiver OK, desconhecida sem dados", () => {
    expect(mapIfoodStoreStatus([{ operation: "DELIVERY", state: "CLOSED" }, { operation: "TAKEOUT", state: "OK" }]).state).toBe("open");
    expect(mapIfoodStoreStatus([{ operation: "DELIVERY", state: "CLOSED" }]).state).toBe("closed");
    expect(mapIfoodStoreStatus([{ operation: "DELIVERY", state: "NOVO" }]).state).toBe("unknown");
    expect(mapIfoodStoreStatus(null).state).toBe("unknown");
  });

  it("todas as rotas ficam num lugar só", () => {
    expect(IFOOD_PATHS.polling).toBe("/order/v1.0/events:polling");
    expect(IFOOD_PATHS.disputeAccept("d1")).toBe("/order/v1.0/disputes/d1/accept");
    expect(IFOOD_PATHS.interruption("m1", "p1")).toBe("/merchant/v1.0/merchants/m1/interruptions/p1");
  });
});
