import { describe, expect, it, vi } from "vitest";
import { DeliveryConcurrencyError, DeliveryInbox, InMemoryDeliveryRepository, type DeliveryOrderRecord } from "./deliveryInbox";
import { IfoodMerchantApi } from "./ifood/ifoodMerchantApi";
import { IfoodSandbox } from "./ifood/ifoodSandbox";
import { allowedDeliveryActions, mergeDeliveryStatus, type DeliveryEvent, type DeliveryOrder } from "./marketplace";

async function baseOrder(): Promise<DeliveryOrder> {
  const sandbox = new IfoodSandbox();
  const api = new IfoodMerchantApi({
    credentials: { clientId: sandbox.clientId, clientSecret: sandbox.clientSecret },
    baseUrl: sandbox.baseUrl,
    fetchImpl: sandbox.fetch,
  });
  const order = await api.getOrder(sandbox.placeOrder({ items: [{ name: "Xis", externalCode: "301", quantity: 1, unitPrice: 38 }] }));
  return { ...order, externalId: "o1" };
}

function setup(options: { onNewOrder?: (record: DeliveryOrderRecord) => void | Promise<void>; now?: () => Date } = {}) {
  const sandbox = new IfoodSandbox(undefined, undefined, options.now);
  const api = new IfoodMerchantApi({
    credentials: { clientId: sandbox.clientId, clientSecret: sandbox.clientSecret },
    merchantIds: [sandbox.merchantId],
    baseUrl: sandbox.baseUrl,
    fetchImpl: sandbox.fetch,
  });
  const repository = new InMemoryDeliveryRepository();
  const inbox = new DeliveryInbox({ adapters: [api], repository, onNewOrder: options.onNewOrder, now: options.now });
  return { sandbox, api, repository, inbox };
}

const ITEMS = [{ name: "Xis Galpão", externalCode: "301", quantity: 1, unitPrice: 38 }];

describe("regras comuns de status", () => {
  it("status só anda para frente e cancelado é final", () => {
    expect(mergeDeliveryStatus("dispatched", "confirmed")).toBe("dispatched");
    expect(mergeDeliveryStatus("placed", "confirmed")).toBe("confirmed");
    expect(mergeDeliveryStatus("cancelled", "concluded")).toBe("cancelled");
    expect(mergeDeliveryStatus("confirmed", "unknown")).toBe("confirmed");
  });

  it("dispatch só com motoboy da loja; nada anda com cancelamento pendente", () => {
    expect(allowedDeliveryActions({ status: "confirmed", fulfillment: "delivery", courier: "marketplace" })).toEqual([
      "start_preparation",
      "ready_for_pickup",
    ]);
    expect(allowedDeliveryActions({ status: "confirmed", fulfillment: "delivery", courier: "merchant" })).toEqual([
      "start_preparation",
      "dispatch",
    ]);
    expect(allowedDeliveryActions({ status: "placed", fulfillment: "takeout", courier: "unknown" }, true)).toEqual([]);
  });
});

describe("caixa de entrada de delivery", () => {
  it("pedido novo é gravado, avisado e confirmado (ack) no iFood", async () => {
    const onNewOrder = vi.fn();
    const { sandbox, inbox } = setup({ onNewOrder });
    const id = sandbox.placeOrder({ items: ITEMS });
    const [report] = await inbox.runCycle();
    expect(report).toMatchObject({ channel: "ifood", received: 1, acknowledged: 1, newOrders: [id], error: null });
    expect(onNewOrder).toHaveBeenCalledOnce();
    expect(sandbox.pendingEventCount()).toBe(0);
    const [record] = await inbox.listOrders();
    expect(record.order.status).toBe("placed");
  });

  it("evento repetido não duplica o pedido nem avisa de novo", async () => {
    const onNewOrder = vi.fn();
    const { sandbox, inbox } = setup({ onNewOrder });
    sandbox.placeOrder({ items: ITEMS });
    const [first] = await inbox.runCycle();
    expect(first.received).toBe(1);
    // O iFood reentrega o mesmo evento.
    sandbox.redeliver(sandbox.eventHistory()[0].id);
    const [second] = await inbox.runCycle();
    expect(second).toMatchObject({ received: 1, duplicates: 1, acknowledged: 1, newOrders: [] });
    expect(onNewOrder).toHaveBeenCalledOnce();
    expect(await inbox.listOrders()).toHaveLength(1);
  });

  it("se o detalhe do pedido falhar, o evento fica sem ack e volta no próximo ciclo", async () => {
    const { sandbox, inbox } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    sandbox.failNext(`/orders/${id}`, 503);
    const [first] = await inbox.runCycle();
    expect(first).toMatchObject({ received: 1, acknowledged: 0, deferred: 1 });
    expect(first.error).toMatch(/503/);
    expect(sandbox.pendingEventCount()).toBe(1);
    const [second] = await inbox.runCycle();
    expect(second).toMatchObject({ acknowledged: 1, newOrders: [id] });
  });

  it("fluxo completo: confirmar, preparar, pronto e concluído pelo app", async () => {
    const { sandbox, inbox } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await inbox.runCycle();
    await inbox.performAction("ifood", id, "confirm");
    await inbox.runCycle();
    await inbox.performAction("ifood", id, "start_preparation");
    await inbox.performAction("ifood", id, "ready_for_pickup");
    await inbox.runCycle();
    let [record] = await inbox.listOrders();
    expect(record.order.status).toBe("ready_for_pickup");
    sandbox.emitFromMarketplace(id, "CON");
    await inbox.runCycle();
    [record] = await inbox.listOrders();
    expect(record.order.status).toBe("concluded");
  });

  it("não deixa pular etapa nem confirmar duas vezes", async () => {
    const { sandbox, inbox } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await inbox.runCycle();
    await expect(inbox.performAction("ifood", id, "ready_for_pickup")).rejects.toMatchObject({ code: "conflict" });
    await inbox.performAction("ifood", id, "confirm");
    await inbox.runCycle();
    await expect(inbox.performAction("ifood", id, "confirm")).rejects.toMatchObject({ code: "conflict" });
  });

  it("cancelamento pedido pela loja só vale quando o app confirma", async () => {
    const { sandbox, inbox } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await inbox.runCycle();
    const [reason] = await inbox.listCancellationReasons("ifood", id);
    const pending = await inbox.requestCancellation("ifood", id, reason);
    expect(pending.cancellationPending).toBe(true);
    expect(pending.order.status).toBe("placed");
    await inbox.runCycle();
    const [record] = await inbox.listOrders();
    expect(record.order.status).toBe("cancelled");
    expect(record.cancellationPending).toBe(false);
  });

  it("cancelamento do app depois de aceito pede conferência", async () => {
    const { sandbox, inbox } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await inbox.runCycle();
    await inbox.performAction("ifood", id, "confirm");
    await inbox.runCycle();
    sandbox.emitFromMarketplace(id, "CAN");
    await inbox.runCycle();
    const [record] = await inbox.listOrders();
    expect(record.order.status).toBe("cancelled");
    expect(record.needsReview).toBe(true);
    expect(record.reviewReasons.join(" ")).toMatch(/depois de aceito/);
  });

  it("falha na impressão/KDS não perde o pedido: vira pendência", async () => {
    const { sandbox, inbox } = setup({ onNewOrder: () => Promise.reject(new Error("impressora offline")) });
    sandbox.placeOrder({ items: ITEMS });
    const [report] = await inbox.runCycle();
    expect(report.acknowledged).toBe(1);
    const [record] = await inbox.listOrders();
    expect(record.needsReview).toBe(true);
    expect(record.reviewReasons[0]).toMatch(/impressora offline/);
  });

  it("falha ao gravar o evento depois do aviso não perde o pedido nem avisa duas vezes", async () => {
    const onNewOrder = vi.fn();
    const { sandbox, repository, inbox } = setup({ onNewOrder });
    const recordEvent = repository.recordEvent.bind(repository);
    const spy = vi.spyOn(repository, "recordEvent").mockRejectedValueOnce(new Error("banco fora do ar"));
    sandbox.placeOrder({ items: ITEMS });
    const [first] = await inbox.runCycle();
    expect(first).toMatchObject({ acknowledged: 0, deferred: 1 });
    expect(onNewOrder).toHaveBeenCalledOnce();
    spy.mockImplementation(recordEvent);
    const [second] = await inbox.runCycle();
    expect(second).toMatchObject({ acknowledged: 1, deferred: 0 });
    expect(onNewOrder).toHaveBeenCalledOnce();
    expect(await inbox.listOrders()).toHaveLength(1);
  });

  it("falha ao gravar o pedido depois do aviso repete o aviso em vez de pulá-lo", async () => {
    const onNewOrder = vi.fn();
    const { sandbox, repository, inbox } = setup({ onNewOrder });
    const saveOrder = repository.saveOrder.bind(repository);
    let calls = 0;
    vi.spyOn(repository, "saveOrder").mockImplementation(async (record) => {
      calls += 1;
      if (calls === 2) throw new Error("banco fora do ar");
      return saveOrder(record);
    });
    sandbox.placeOrder({ items: ITEMS });
    const [first] = await inbox.runCycle();
    expect(first.acknowledged).toBe(0);
    const [second] = await inbox.runCycle();
    expect(second.acknowledged).toBe(1);
    expect(onNewOrder).toHaveBeenCalledTimes(2);
  });

  it("resposta de ação que chega depois do polling não volta o status do pedido", async () => {
    const { sandbox, api, inbox } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await inbox.runCycle();
    const original = api.performAction.bind(api);
    // O iFood confirma, o polling grava o CFM, e só então a resposta da ação volta.
    vi.spyOn(api, "performAction").mockImplementation(async (orderId, action) => {
      await original(orderId, action);
      await inbox.runCycle();
    });
    await inbox.performAction("ifood", id, "confirm");
    const [record] = await inbox.listOrders();
    expect(record.order.status).toBe("confirmed");
  });

  it("cancelamento confirmado pelo polling durante a chamada não fica como pendente", async () => {
    const { sandbox, api, inbox } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await inbox.runCycle();
    const original = api.requestCancellation.bind(api);
    vi.spyOn(api, "requestCancellation").mockImplementation(async (orderId, reason, details) => {
      await original(orderId, reason, details);
      await inbox.runCycle();
    });
    const [reason] = await inbox.listCancellationReasons("ifood", id);
    const result = await inbox.requestCancellation("ifood", id, reason);
    expect(result.order.status).toBe("cancelled");
    expect(result.cancellationPending).toBe(false);
  });

  it("pedido de cancelamento atrasado não reabre o cancelamento já recusado", async () => {
    const repository = new InMemoryDeliveryRepository();
    const adapter = {
      channel: "ifood" as const,
      queue: [] as DeliveryEvent[],
      pollEvents: async () => adapter.queue.splice(0),
      acknowledge: async () => undefined,
      getOrder: async () => ({ ...(await baseOrder()), status: "placed" as const }),
      performAction: async () => undefined,
      listCancellationReasons: async () => [],
      requestCancellation: async () => undefined,
      respondToDispute: async () => undefined,
    };
    const custom = new DeliveryInbox({ adapters: [adapter], repository });
    const event = (id: string, signal: DeliveryEvent["signal"], createdAt: string): DeliveryEvent => ({
      channel: "ifood", externalEventId: id, externalOrderId: "o1", merchantExternalId: "m", rawCode: id, signal, createdAt, dispute: null,
    });
    adapter.queue.push(event("e1", "placed", "2026-11-09T10:00:00Z"), event("e3", "cancellation_denied", "2026-11-09T10:02:00Z"));
    await custom.runCycle();
    adapter.queue.push(event("e2", "cancellation_requested", "2026-11-09T10:01:00Z"));
    await custom.runCycle();
    const [record] = await custom.listOrders();
    expect(record.cancellationPending).toBe(false);
    expect(allowedDeliveryActions(record.order, record.cancellationPending)).toContain("confirm");
  });

  it("recusa de cancelamento recebida durante a chamada não é desfeita", async () => {
    const repository = new InMemoryDeliveryRepository();
    const queue: DeliveryEvent[] = [];
    const event = (id: string, signal: DeliveryEvent["signal"], createdAt: string): DeliveryEvent => ({
      channel: "ifood", externalEventId: id, externalOrderId: "o1", merchantExternalId: "m", rawCode: id, signal, createdAt, dispute: null,
    });
    let inbox: DeliveryInbox;
    const adapter = {
      channel: "ifood" as const,
      pollEvents: async () => queue.splice(0),
      acknowledge: async () => undefined,
      getOrder: async () => baseOrder(),
      performAction: async () => undefined,
      listCancellationReasons: async () => [],
      requestCancellation: async () => {
        queue.push(event("e2", "cancellation_requested", "2026-11-09T10:01:00Z"), event("e3", "cancellation_denied", "2026-11-09T10:02:00Z"));
        await inbox.runCycle();
      },
      respondToDispute: async () => undefined,
    };
    inbox = new DeliveryInbox({ adapters: [adapter], repository });
    queue.push(event("e1", "placed", "2026-11-09T10:00:00Z"));
    await inbox.runCycle();
    const result = await inbox.requestCancellation("ifood", "o1", { code: "501", description: "Problemas de sistema" });
    expect(result.cancellationPending).toBe(false);
  });

  it("falha ao gravar o resultado do aviso reprocessa o evento em vez de esconder a pendência", async () => {
    const { sandbox, repository, inbox } = setup({ onNewOrder: () => Promise.reject(new Error("impressora offline")) });
    const saveOrder = repository.saveOrder.bind(repository);
    let calls = 0;
    vi.spyOn(repository, "saveOrder").mockImplementation(async (record) => {
      calls += 1;
      if (calls === 2) throw new Error("banco fora do ar");
      return saveOrder(record);
    });
    sandbox.placeOrder({ items: ITEMS });
    const [first] = await inbox.runCycle();
    expect(first.acknowledged).toBe(0);
    await inbox.runCycle();
    const [record] = await inbox.listOrders();
    expect(record.needsReview).toBe(true);
    expect(record.reviewReasons.join(" ")).toMatch(/impressora offline/);
  });

  it("app fora do ar não derruba o ciclo", async () => {
    const { sandbox, inbox } = setup();
    sandbox.failNext("events:polling", 500);
    const [report] = await inbox.runCycle();
    expect(report.error).toMatch(/500/);
    expect(report.acknowledged).toBe(0);
  });

  it("evento sem pedido é confirmado sem buscar detalhe nem gravar nada", async () => {
    const { sandbox, api, inbox } = setup();
    const getOrder = vi.spyOn(api, "getOrder");
    sandbox.pushRawEvent({ id: "evt-loja", code: "XYZ", createdAt: "2026-11-14T10:00:00Z", merchantId: sandbox.merchantId });
    const [report] = await inbox.runCycle();
    expect(report).toMatchObject({ received: 1, acknowledged: 1, deferred: 0 });
    expect(getOrder).not.toHaveBeenCalled();
    expect(await inbox.listOrders()).toEqual([]);
    expect(sandbox.pendingEventCount()).toBe(0);
  });

  it("evento do entregador (desconhecido para o status) é confirmado e não muda o pedido", async () => {
    const { sandbox, inbox } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await inbox.runCycle();
    await inbox.performAction("ifood", id, "confirm");
    await inbox.runCycle();
    sandbox.emitFromMarketplace(id, "ADR");
    const [report] = await inbox.runCycle();
    expect(report.acknowledged).toBe(1);
    expect((await inbox.listOrders())[0].order.status).toBe("confirmed");
  });

  it("cancelamento pedido pela loja e negado pelo iFood: pendência some e pedido segue", async () => {
    const { sandbox, inbox } = setup();
    sandbox.autoAcceptCancellation = false;
    const id = sandbox.placeOrder({ items: ITEMS });
    await inbox.runCycle();
    const [reason] = await inbox.listCancellationReasons("ifood", id);
    expect((await inbox.requestCancellation("ifood", id, reason)).cancellationPending).toBe(true);
    await inbox.runCycle();
    expect((await inbox.listOrders())[0].cancellationPending).toBe(true);
    sandbox.decideCancellation(id, false);
    await inbox.runCycle();
    const [record] = await inbox.listOrders();
    expect(record.cancellationPending).toBe(false);
    expect(record.order.status).toBe("placed");
    expect(record.reviewReasons.join(" ")).toMatch(/recusou o pedido de cancelamento/);
  });

  it("cliente pede cancelamento: pedido vai para conferência sem mudar de status", async () => {
    const { sandbox, inbox } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await inbox.runCycle();
    sandbox.emitFromMarketplace(id, "CCR");
    await inbox.runCycle();
    const [record] = await inbox.listOrders();
    expect(record.order.status).toBe("placed");
    expect(record.needsReview).toBe(true);
    expect(record.reviewReasons.join(" ")).toMatch(/cliente pediu o cancelamento/);
  });

  it("negociação: aberta pelo app, respondida uma vez só, fechada pelo evento do app", async () => {
    const { sandbox, inbox } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await inbox.runCycle();
    await inbox.performAction("ifood", id, "confirm");
    await inbox.runCycle();
    const disputeId = sandbox.openDispute(id);
    await inbox.runCycle();
    let [record] = await inbox.listOrders();
    expect(record.dispute).toMatchObject({ id: disputeId, respondedAt: null });
    expect(record.reviewReasons.join(" ")).toMatch(/negociação/);

    const answered = await inbox.respondToDispute("ifood", id, { kind: "accept" });
    expect(answered.dispute?.respondedAt).not.toBeNull();
    await expect(inbox.respondToDispute("ifood", id, { kind: "accept" })).rejects.toMatchObject({ code: "conflict" });

    await inbox.runCycle();
    [record] = await inbox.listOrders();
    expect(record.dispute).toBeNull();
    expect(record.order.status).toBe("cancelled");
  });

  it("evento que falhou segura os seguintes do mesmo pedido: negociação fechada não reabre", async () => {
    const { sandbox, repository, inbox } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    const other = sandbox.placeOrder({ items: ITEMS });
    await inbox.runCycle();
    await inbox.performAction("ifood", id, "confirm");
    await inbox.runCycle();
    sandbox.openDispute(id);
    sandbox.pushRawEvent({ id: "hss-1", code: "HSS", fullCode: "HANDSHAKE_SETTLEMENT", orderId: id, merchantId: sandbox.merchantId, createdAt: new Date(Date.now() + 1_000).toISOString(), metadata: {} });
    sandbox.emitFromMarketplace(other, "CCR");
    const recordEvent = repository.recordEvent.bind(repository);
    // Só o HSD falha ao gravar.
    const spy = vi.spyOn(repository, "recordEvent").mockImplementation(async (event) => {
      if (event.rawCode === "HSD") throw new Error("banco fora do ar");
      return recordEvent(event);
    });
    const first = await inbox.runCycle();
    expect(first[0]).toMatchObject({ acknowledged: 1, deferred: 2 });
    spy.mockImplementation(recordEvent);
    const second = await inbox.runCycle();
    expect(second[0]).toMatchObject({ acknowledged: 2, deferred: 0 });
    const record = (await repository.getOrder("ifood", id))!;
    expect(record.dispute).toBeNull();
    expect((await repository.getOrder("ifood", other))!.reviewReasons.join(" ")).toMatch(/cancelamento/);
  });

  it("negociação vencida ou proposta de outra negociação não chegam ao iFood", async () => {
    let clock = new Date("2026-11-14T15:00:00.000Z");
    const { sandbox, api, inbox } = setup({ now: () => clock });
    const id = sandbox.placeOrder({ items: ITEMS });
    await inbox.runCycle();
    sandbox.openDispute(id, { expiresAt: "2026-11-14T15:05:00.000Z", alternatives: ["REFUND_PARTIAL"] });
    await inbox.runCycle();
    const respond = vi.spyOn(api, "respondToDispute");
    await expect(inbox.respondToDispute("ifood", id, { kind: "alternative", alternativeId: "outra" })).rejects.toMatchObject({ code: "invalid_request" });
    clock = new Date("2026-11-14T15:06:00.000Z");
    await expect(inbox.respondToDispute("ifood", id, { kind: "accept" })).rejects.toMatchObject({ code: "conflict" });
    expect(respond).not.toHaveBeenCalled();
  });

  it("pedido sem negociação aberta não aceita resposta", async () => {
    const { sandbox, inbox } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await inbox.runCycle();
    await expect(inbox.respondToDispute("ifood", id, { kind: "accept" })).rejects.toMatchObject({ code: "conflict" });
  });

  it("gravação de outro processo no meio: o evento fica sem ack e é reaplicado no próximo ciclo", async () => {
    const { sandbox, repository, inbox } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await inbox.runCycle();
    await inbox.performAction("ifood", id, "confirm");
    const saveOrder = repository.saveOrder.bind(repository);
    vi.spyOn(repository, "saveOrder").mockImplementationOnce(async (record) => {
      throw new DeliveryConcurrencyError(record.order.channel, record.order.externalId);
    }).mockImplementation(saveOrder);
    const [first] = await inbox.runCycle();
    expect(first).toMatchObject({ acknowledged: 0, deferred: 1 });
    const [second] = await inbox.runCycle();
    expect(second).toMatchObject({ acknowledged: 1, deferred: 0 });
    expect((await inbox.listOrders())[0].order.status).toBe("confirmed");
  });

  it("repositório recusa gravação com versão velha", async () => {
    const { sandbox, repository, inbox } = setup();
    sandbox.placeOrder({ items: ITEMS });
    await inbox.runCycle();
    const [record] = await inbox.listOrders();
    const stale = structuredClone(record);
    record.needsReview = true;
    await repository.saveOrder(record);
    await expect(repository.saveOrder(stale)).rejects.toBeInstanceOf(DeliveryConcurrencyError);
    await expect(repository.saveOrder({ ...stale, version: 0 })).rejects.toBeInstanceOf(DeliveryConcurrencyError);
  });

  it("pedido de cancelamento relê e tenta de novo se o polling gravou no meio", async () => {
    const { sandbox, repository, inbox } = setup();
    sandbox.autoAcceptCancellation = false;
    const id = sandbox.placeOrder({ items: ITEMS });
    await inbox.runCycle();
    const saveOrder = repository.saveOrder.bind(repository);
    vi.spyOn(repository, "saveOrder").mockImplementationOnce(async (record) => {
      throw new DeliveryConcurrencyError(record.order.channel, record.order.externalId);
    }).mockImplementation(saveOrder);
    const [reason] = await inbox.listCancellationReasons("ifood", id);
    const result = await inbox.requestCancellation("ifood", id, reason);
    expect(result.cancellationPending).toBe(true);
    expect((await inbox.listOrders())[0].cancellationPending).toBe(true);
  });
});

