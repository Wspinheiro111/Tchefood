import { describe, expect, it, vi } from "vitest";
import { DeliveryMarketplaceError } from "../marketplace";
import { IfoodMerchantApi, mapIfoodEventCode, mapIfoodOrder, parseIfoodEvent } from "./ifoodMerchantApi";
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
    expect(mapIfoodEventCode("HSD")).toBe("unknown");
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
      expect(order.totals).toEqual({ itemsCents: 19430, deliveryFeeCents: 799, additionalFeesCents: 0, benefitsCents: 1000, orderCents: 19229 });
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
