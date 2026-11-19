import { describe, expect, it, vi } from "vitest";
import {
  DETAIL_OTHER_STORE_RETRY_SECONDS,
  DETAIL_RECOVERED_REASON,
  DETAIL_RECOVERY_BATCH,
  DETAIL_RECOVERY_BUDGET_MS,
  DETAIL_REFRESHED_REASON,
  DETAIL_RETRY_DELAY_SECONDS,
  DeliveryConcurrencyError,
  DeliveryInbox,
  DeliverySentNotSavedError,
  InMemoryDeliveryRepository,
  CANCELLATION_RESERVATION_TTL_MS,
  CONCLUDED_WITH_PENDING_CANCELLATION,
  DISPUTE_RESPONSE_STALE_MS,
  ORDER_DETAIL_MAX_FAILURES,
  ORDER_PATCHED_REASON,
  PARTIAL_CANCELLATION_APPLIED_REASON,
  PARTIAL_CANCELLATION_UNCERTAIN_REASON,
  UNCERTAIN_CANCELLATION_RETRIED,
  type DeliveryOrderRecord,
} from "./deliveryInbox";
import { CANCELLATION_EVENT_UNORDERED_REASON, deliverySaleBlockers } from "./deliverySaleGuard";
import { IfoodMerchantApi } from "./ifood/ifoodMerchantApi";
import { IfoodSandbox } from "./ifood/ifoodSandbox";
import { DeliveryMarketplaceError, allowedDeliveryActions, mergeDeliveryStatus, type DeliveryEvent, type DeliveryOrder } from "./marketplace";

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
  const repository = new InMemoryDeliveryRepository({ now: options.now });
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

  describe("evento de cancelamento sem horário (rodada 5)", () => {
    const UNKNOWN = "1970-01-01T00:00:00.000Z";
    function unorderedSetup() {
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
      const inbox = new DeliveryInbox({ adapters: [adapter], repository });
      const event = (id: string, signal: DeliveryEvent["signal"], createdAt: string): DeliveryEvent => ({
        channel: "ifood", externalEventId: id, externalOrderId: "o1", merchantExternalId: "m", rawCode: id, signal, createdAt, dispute: null,
      });
      return { adapter, inbox, event };
    }

    it("pedido de cancelamento antigo sem horário não reabre a recusa já gravada", async () => {
      const { adapter, inbox, event } = unorderedSetup();
      adapter.queue.push(
        event("e1", "placed", "2026-11-09T10:00:00Z"),
        event("e2", "cancellation_requested", "2026-11-09T10:01:00Z"),
        event("e3", "cancellation_denied", "2026-11-09T10:02:00Z"),
      );
      await inbox.runCycle();
      adapter.queue.push(event("e4", "cancellation_requested", UNKNOWN));
      await inbox.runCycle();
      const [record] = await inbox.listOrders();
      expect(record.cancellationPending).toBe(false);
      expect(record.lastCancellationEventAt).toBe("2026-11-09T10:02:00Z");
      expect(record.reviewReasons).toContain(CANCELLATION_EVENT_UNORDERED_REASON);
      expect(deliverySaleBlockers(record)).toContain(CANCELLATION_EVENT_UNORDERED_REASON);
      // O mesmo evento de novo é duplicado: nada muda e a pendência não se repete.
      adapter.queue.push(event("e4", "cancellation_requested", UNKNOWN));
      const [again] = await inbox.runCycle();
      expect(again!.duplicates).toBe(1);
      const [same] = await inbox.listOrders();
      expect(same.reviewReasons.filter((reason) => reason === CANCELLATION_EVENT_UNORDERED_REASON)).toHaveLength(1);
      expect(same.cancellationPending).toBe(false);
    });

    it("recusa antiga sem horário não libera o pedido de cancelamento com horário", async () => {
      const { adapter, inbox, event } = unorderedSetup();
      adapter.queue.push(event("e1", "placed", "2026-11-09T10:00:00Z"), event("e2", "cancellation_requested", "2026-11-09T10:01:00Z"));
      await inbox.runCycle();
      adapter.queue.push(event("e3", "cancellation_denied", UNKNOWN));
      await inbox.runCycle();
      const [record] = await inbox.listOrders();
      expect(record.cancellationPending).toBe(true);
      expect(record.lastCancellationEventAt).toBe("2026-11-09T10:01:00Z");
      expect(deliverySaleBlockers(record)).toEqual(
        expect.arrayContaining([CANCELLATION_EVENT_UNORDERED_REASON, "Pedido de cancelamento em análise no app: aguarde a resposta."]),
      );
    });

    it("evento sem horário antes de qualquer decisão vale como chegou, mas a venda fica bloqueada até a conferência", async () => {
      const { adapter, inbox, event } = unorderedSetup();
      adapter.queue.push(event("e1", "placed", "2026-11-09T10:00:00Z"), event("e2", "cancellation_requested", UNKNOWN));
      await inbox.runCycle();
      adapter.queue.push(event("e3", "cancellation_denied", "2026-11-09T10:02:00Z"));
      await inbox.runCycle();
      const [record] = await inbox.listOrders();
      expect(record.cancellationPending).toBe(false);
      // A recusa com horário não apaga a dúvida sobre o evento sem horário: só a conferência libera a venda.
      expect(deliverySaleBlockers(record)).toEqual([CANCELLATION_EVENT_UNORDERED_REASON]);
    });
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

    const answered = await inbox.respondToDispute("ifood", id, { kind: "accept" }, disputeId);
    expect(answered.dispute?.respondedAt).not.toBeNull();
    await expect(inbox.respondToDispute("ifood", id, { kind: "accept" }, disputeId)).rejects.toMatchObject({ code: "conflict" });

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
    const disputeId = sandbox.openDispute(id);
    sandbox.pushRawEvent({ id: "hss-1", code: "HSS", fullCode: "HANDSHAKE_SETTLEMENT", orderId: id, merchantId: sandbox.merchantId, createdAt: new Date(Date.now() + 1_000).toISOString(), metadata: { disputeId, status: "EXPIRED" } });
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

  it("negociação: duas respostas ao mesmo tempo chegam ao iFood uma vez só", async () => {
    const { sandbox, api, inbox } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await inbox.runCycle();
    const disputeId = sandbox.openDispute(id);
    await inbox.runCycle();
    const spy = vi.spyOn(api, "respondToDispute");
    const results = await Promise.allSettled([
      inbox.respondToDispute("ifood", id, { kind: "accept" }, disputeId),
      inbox.respondToDispute("ifood", id, { kind: "reject", reason: "Já saiu" }, disputeId),
    ]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
  });

  it("negociação: outro processo com a mesma leitura também não manda a segunda resposta (versão no banco)", async () => {
    const { sandbox, api, repository, inbox } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await inbox.runCycle();
    const disputeId = sandbox.openDispute(id);
    await inbox.runCycle();
    // Segundo processo: outra caixa de entrada no mesmo banco.
    const other = new DeliveryInbox({ adapters: [api], repository });
    const spy = vi.spyOn(api, "respondToDispute");
    await inbox.respondToDispute("ifood", id, { kind: "accept" }, disputeId);
    await expect(other.respondToDispute("ifood", id, { kind: "accept" }, disputeId)).rejects.toMatchObject({ code: "conflict" });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("negociação: iFood aceitou e o banco falhou depois: nova tentativa é recusada sem chamar o iFood", async () => {
    const { sandbox, api, repository, inbox } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await inbox.runCycle();
    const disputeId = sandbox.openDispute(id);
    await inbox.runCycle();
    const spy = vi.spyOn(api, "respondToDispute");
    const save = repository.saveOrder.bind(repository);
    let calls = 0;
    // A reserva grava; a marcação de "respondida" (depois do iFood) falha.
    vi.spyOn(repository, "saveOrder").mockImplementation(async (record) => {
      calls += 1;
      if (calls >= 2) throw new Error("banco fora do ar");
      return save(record);
    });
    await expect(inbox.respondToDispute("ifood", id, { kind: "accept" }, disputeId)).rejects.toThrow(/banco fora do ar/);
    vi.mocked(repository.saveOrder).mockImplementation(save);
    await expect(inbox.respondToDispute("ifood", id, { kind: "accept" }, disputeId)).rejects.toMatchObject({ code: "conflict" });
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await repository.getOrder("ifood", id))!.dispute?.response?.state).toBe("sending");
    // O evento do app fecha a negociação e libera tudo.
    await inbox.runCycle();
    expect((await repository.getOrder("ifood", id))!.dispute).toBeNull();
  });

  it("negociação: falha incerta bloqueia nova tentativa; recusa clara libera", async () => {
    const { sandbox, api, repository, inbox } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await inbox.runCycle();
    const disputeId = sandbox.openDispute(id);
    await inbox.runCycle();
    sandbox.failNext("/disputes/", 400);
    await expect(inbox.respondToDispute("ifood", id, { kind: "accept" }, disputeId)).rejects.toMatchObject({ code: "invalid_request" });
    expect((await repository.getOrder("ifood", id))!.dispute?.response).toBeNull();
    vi.spyOn(api, "respondToDispute").mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(inbox.respondToDispute("ifood", id, { kind: "accept" }, disputeId)).rejects.toThrow(/fetch failed/);
    expect((await repository.getOrder("ifood", id))!.dispute?.response?.state).toBe("uncertain");
    await expect(inbox.respondToDispute("ifood", id, { kind: "accept" }, disputeId)).rejects.toMatchObject({ code: "conflict" });
  });

  it("negociação: proposta de reembolso leva valor validado contra o teto do iFood", async () => {
    const { sandbox, api, inbox } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await inbox.runCycle();
    const disputeId = sandbox.openDispute(id, { alternatives: [{ type: "REFUND", maxAmountCents: 2000 }] });
    await inbox.runCycle();
    const [record] = await inbox.listOrders();
    const alternativeId = record.dispute!.alternatives[0]!.id;
    const respond = vi.spyOn(api, "respondToDispute");
    for (const amountCents of [undefined, 0, -5, 2001, 10.5]) {
      await expect(inbox.respondToDispute("ifood", id, { kind: "alternative", alternativeId, amountCents }, disputeId)).rejects.toMatchObject({ code: "invalid_request" });
    }
    expect(respond).not.toHaveBeenCalled();
    const answered = await inbox.respondToDispute("ifood", id, { kind: "alternative", alternativeId, amountCents: 1500 }, disputeId);
    expect(respond).toHaveBeenCalledWith(record.dispute!.id, { kind: "alternative", alternativeId, alternativeType: "REFUND", amountCents: 1500, currency: "BRL" });
    expect(answered.dispute?.response?.state).toBe("sent");
  });

  it("negociação: proposta de novo prazo só com minutos e motivo da lista do iFood", async () => {
    const { sandbox, api, inbox } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await inbox.runCycle();
    const disputeId = sandbox.openDispute(id, { handshakeType: "DELAY", alternatives: [{ type: "ADDITIONAL_TIME", minutes: [15, 30], reasons: ["HIGH_STORE_DEMAND"] }] });
    await inbox.runCycle();
    const alternativeId = (await inbox.listOrders())[0]!.dispute!.alternatives[0]!.id;
    const respond = vi.spyOn(api, "respondToDispute");
    const attempt = (additionalTimeInMinutes?: number, additionalTimeReason?: string) =>
      inbox.respondToDispute("ifood", id, { kind: "alternative", alternativeId, additionalTimeInMinutes, additionalTimeReason }, disputeId);
    await expect(attempt(20, "HIGH_STORE_DEMAND")).rejects.toMatchObject({ code: "invalid_request" });
    await expect(attempt(15, "LACK_OF_DRIVERS")).rejects.toMatchObject({ code: "invalid_request" });
    await expect(attempt(15)).rejects.toMatchObject({ code: "invalid_request" });
    // Negociação de atraso não aceita recusa: nem chega ao iFood.
    await expect(inbox.respondToDispute("ifood", id, { kind: "reject", reason: "Não" }, disputeId)).rejects.toMatchObject({ code: "conflict" });
    expect(respond).not.toHaveBeenCalled();
    await attempt(15, "HIGH_STORE_DEMAND");
    expect(respond).toHaveBeenCalledTimes(1);
    expect(sandbox.eventHistory().at(-1)?.metadata).toMatchObject({ status: "ALTERNATIVE_REPLIED" });
  });

  it("negociação: aceite exige motivo da lista quando o iFood manda acceptCancellationReasons", async () => {
    const { sandbox, api, inbox } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await inbox.runCycle();
    const disputeId = sandbox.openDispute(id, { acceptCancellationReasons: ["HIGH_STORE_DEMAND", "OTHER_REASONS"] });
    await inbox.runCycle();
    const respond = vi.spyOn(api, "respondToDispute");
    await expect(inbox.respondToDispute("ifood", id, { kind: "accept" }, disputeId)).rejects.toMatchObject({ code: "invalid_request", message: expect.stringMatching(/motivo/) });
    await expect(inbox.respondToDispute("ifood", id, { kind: "accept", reason: "INVENTADO" }, disputeId)).rejects.toMatchObject({ code: "invalid_request" });
    expect(respond).not.toHaveBeenCalled();
    await inbox.respondToDispute("ifood", id, { kind: "accept", reason: "OTHER_REASONS", detailReason: "Sem gás" }, disputeId);
    expect(respond).toHaveBeenCalledWith(expect.any(String), { kind: "accept", reason: "OTHER_REASONS", detailReason: "Sem gás" });
    await inbox.runCycle();
    expect((await inbox.listOrders())[0]!.order.status).toBe("cancelled");
  });

  it("negociação sem lista de motivos: o aceite vai sem corpo", async () => {
    const { sandbox, api, inbox } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await inbox.runCycle();
    const disputeId = sandbox.openDispute(id);
    await inbox.runCycle();
    const respond = vi.spyOn(api, "respondToDispute");
    await inbox.respondToDispute("ifood", id, { kind: "accept", reason: "HIGH_STORE_DEMAND" }, disputeId);
    expect(respond).toHaveBeenCalledWith(expect.any(String), { kind: "accept" });
  });

  it("negociação: contraproposta respondida não fecha; o desfecho com reembolso vira pendência com o valor", async () => {
    const { sandbox, inbox } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await inbox.runCycle();
    const disputeId = sandbox.openDispute(id, { alternatives: ["REFUND"] });
    await inbox.runCycle();
    const alternativeId = (await inbox.listOrders())[0]!.dispute!.alternatives[0]!.id;
    await inbox.respondToDispute("ifood", id, { kind: "alternative", alternativeId, amountCents: 1500 }, disputeId);
    await inbox.runCycle();
    let [record] = await inbox.listOrders();
    // HSS ALTERNATIVE_REPLIED: a negociação continua aberta, esperando o cliente.
    expect(record.dispute).toMatchObject({ id: disputeId, response: { state: "sent" } });
    await expect(inbox.respondToDispute("ifood", id, { kind: "accept" }, disputeId)).rejects.toMatchObject({ code: "conflict" });
    sandbox.settleAlternative(disputeId, true);
    await inbox.runCycle();
    [record] = await inbox.listOrders();
    expect(record.dispute).toBeNull();
    expect(record.needsReview).toBe(true);
    expect(record.reviewReasons.join(" ")).toMatch(/reembolso de R\$ 15,00/);
  });

  it("negociação: fechamento de outra negociação ou ilegível não apaga a atual", async () => {
    const { sandbox, repository, inbox } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await inbox.runCycle();
    const disputeId = sandbox.openDispute(id);
    await inbox.runCycle();
    const later = () => new Date(Date.now() + 1_000).toISOString();
    const hss = (eventId: string, metadata: Record<string, unknown>) =>
      sandbox.pushRawEvent({ id: eventId, code: "HSS", fullCode: "HANDSHAKE_SETTLEMENT", orderId: id, merchantId: sandbox.merchantId, createdAt: later(), metadata });
    hss("hss-outra", { disputeId: "outra-negociacao", status: "ACCEPTED" });
    hss("hss-sem-id", { status: "ACCEPTED" });
    hss("hss-status-novo", { disputeId, status: "NOVO_STATUS" });
    await inbox.runCycle();
    let record = (await repository.getOrder("ifood", id))!;
    expect(record.dispute?.id).toBe(disputeId);
    expect(record.reviewReasons.join(" ")).toMatch(/fechamento de negociação que não deu para ler/);
    sandbox.expireDispute(disputeId);
    await inbox.runCycle();
    record = (await repository.getOrder("ifood", id))!;
    expect(record.dispute).toBeNull();
  });

  it("negociação: 422 DISPUTE_ALREADY_ANSWERED não registra a resposta do PDV como enviada", async () => {
    const { sandbox, api, repository, inbox } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await inbox.runCycle();
    const disputeId = sandbox.openDispute(id, { alternatives: ["REFUND"] });
    await inbox.runCycle();
    const alternativeId = (await inbox.listOrders())[0]!.dispute!.alternatives[0]!.id;
    // Alguém já respondeu por fora (ex.: Portal do Parceiro, R$ 5) antes do PDV (R$ 15).
    await api.respondToDispute(disputeId, { kind: "alternative", alternativeId, alternativeType: "REFUND", amountCents: 500 });
    await expect(
      inbox.respondToDispute("ifood", id, { kind: "alternative", alternativeId, amountCents: 1500 }, disputeId),
    ).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/respondida por fora/) });
    const record = (await repository.getOrder("ifood", id))!;
    // Nada da resposta do PDV fica como enviada; a negociação fica marcada como respondida e vira pendência.
    expect(record.dispute?.response).toBeNull();
    expect(record.dispute?.respondedAt).not.toBeNull();
    expect(record.reviewReasons.join(" ")).toMatch(/não foi aplicada/);
    await expect(inbox.respondToDispute("ifood", id, { kind: "accept" }, disputeId)).rejects.toMatchObject({ code: "conflict" });
  });

  it("evento ilegível com pedido não se perde: entra no histórico do pedido e vira pendência", async () => {
    const { sandbox, repository, inbox } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await inbox.runCycle();
    sandbox.pushRawEvent({ id: "ev-ruim", orderId: id, merchantId: sandbox.merchantId, createdAt: new Date(Date.now() + 1_000).toISOString() });
    const [report] = await inbox.runCycle();
    expect(report).toMatchObject({ acknowledged: 1, deferred: 0, discarded: [] });
    expect(await repository.hasEvent("ifood", "ev-ruim")).toBe(true);
    const record = (await repository.getOrder("ifood", id))!;
    expect(record.needsReview).toBe(true);
    expect(record.reviewReasons.join(" ")).toMatch(/não deu para ler/);
  });

  it("evento ilegível de pedido que o PDV não conhece: busca o pedido; se o detalhe falha, fica sem ack", async () => {
    const { sandbox, repository, inbox } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    // O PLC some (ack perdido no iFood) e chega só um evento ilegível do pedido.
    sandbox.pushRawEvent({ id: "ev-ruim-2", orderId: id, merchantId: sandbox.merchantId, code: 42 });
    sandbox.failNext(`/orders/${id}`, 503);
    const [first] = await inbox.runCycle();
    expect(first!.deferred).toBeGreaterThan(0);
    expect(await repository.getOrder("ifood", id)).toBeNull();
    await inbox.runCycle();
    expect(await repository.getOrder("ifood", id)).not.toBeNull();
    expect(await repository.hasEvent("ifood", "ev-ruim-2")).toBe(true);
  });

  it("evento ilegível sem pedido: confirmado e listado para o log", async () => {
    const { sandbox, inbox } = setup();
    sandbox.pushRawEvent({ id: "ev-sem-pedido", merchantId: sandbox.merchantId, code: "ZZZ" });
    const [report] = await inbox.runCycle();
    expect(report).toMatchObject({ acknowledged: 1, discarded: ["ev-sem-pedido (ZZZ)"] });
  });

  it("negociação vencida ou proposta de outra negociação não chegam ao iFood", async () => {
    let clock = new Date("2026-11-14T15:00:00.000Z");
    const { sandbox, api, inbox } = setup({ now: () => clock });
    const id = sandbox.placeOrder({ items: ITEMS });
    await inbox.runCycle();
    const disputeId = sandbox.openDispute(id, { expiresAt: "2026-11-14T15:05:00.000Z", alternatives: ["REFUND_PARTIAL"] });
    await inbox.runCycle();
    const respond = vi.spyOn(api, "respondToDispute");
    await expect(inbox.respondToDispute("ifood", id, { kind: "alternative", alternativeId: "outra" }, disputeId)).rejects.toMatchObject({ code: "invalid_request" });
    clock = new Date("2026-11-14T15:06:00.000Z");
    await expect(inbox.respondToDispute("ifood", id, { kind: "accept" }, disputeId)).rejects.toMatchObject({ code: "conflict" });
    expect(respond).not.toHaveBeenCalled();
  });

  it("negociação: sem o id da negociação mostrada (ou com o de outra) nada é reservado nem enviado", async () => {
    const { sandbox, api, repository, inbox } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await inbox.runCycle();
    const shown = sandbox.openDispute(id);
    await inbox.runCycle();
    sandbox.expireDispute(shown);
    const current = sandbox.openDispute(id);
    await inbox.runCycle();
    const respond = vi.spyOn(api, "respondToDispute");
    // Chamador em JS (ou com cast) que não manda o id: recusado, não vale "a negociação de agora".
    const missing = undefined as unknown as string;
    await expect(inbox.checkDisputeDecision("ifood", id, { kind: "accept" }, missing)).rejects.toMatchObject({ code: "invalid_request" });
    await expect(inbox.respondToDispute("ifood", id, { kind: "accept" }, missing)).rejects.toMatchObject({ code: "invalid_request" });
    await expect(inbox.respondToDispute("ifood", id, { kind: "accept" }, "")).rejects.toMatchObject({ code: "invalid_request" });
    await expect(inbox.checkDisputeDecision("ifood", id, { kind: "accept" }, shown)).rejects.toMatchObject({ code: "conflict" });
    await expect(inbox.respondToDispute("ifood", id, { kind: "accept" }, shown)).rejects.toMatchObject({ code: "conflict" });
    expect(respond).not.toHaveBeenCalled();
    expect((await repository.getOrder("ifood", id))!.dispute).toMatchObject({ id: current, response: null });
    await inbox.respondToDispute("ifood", id, { kind: "accept" }, current);
    expect(respond).toHaveBeenCalledWith(current, { kind: "accept" });
  });

  it("pedido sem negociação aberta não aceita resposta", async () => {
    const { sandbox, inbox } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await inbox.runCycle();
    await expect(inbox.respondToDispute("ifood", id, { kind: "accept" }, "negociacao-inexistente")).rejects.toMatchObject({ code: "conflict" });
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

  it("cancelamento: dois pedidos ao mesmo tempo chegam ao iFood uma vez só", async () => {
    const { sandbox, api, inbox } = setup();
    sandbox.autoAcceptCancellation = false;
    const id = sandbox.placeOrder({ items: ITEMS });
    await inbox.runCycle();
    const [reason] = await inbox.listCancellationReasons("ifood", id);
    const spy = vi.spyOn(api, "requestCancellation");
    const results = await Promise.allSettled([inbox.requestCancellation("ifood", id, reason), inbox.requestCancellation("ifood", id, reason)]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
  });

  it("cancelamento: outro processo com a mesma leitura também não manda o segundo (versão no banco)", async () => {
    const { sandbox, api, repository, inbox } = setup();
    sandbox.autoAcceptCancellation = false;
    const id = sandbox.placeOrder({ items: ITEMS });
    await inbox.runCycle();
    const other = new DeliveryInbox({ adapters: [api], repository });
    const [reason] = await inbox.listCancellationReasons("ifood", id);
    const spy = vi.spyOn(api, "requestCancellation");
    await inbox.requestCancellation("ifood", id, reason);
    await expect(other.requestCancellation("ifood", id, reason)).rejects.toMatchObject({ code: "conflict" });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("cancelamento: iFood aceitou e o banco falhou depois: erro próprio e nova tentativa recusada sem chamar o iFood", async () => {
    const { sandbox, api, repository, inbox } = setup();
    sandbox.autoAcceptCancellation = false;
    const id = sandbox.placeOrder({ items: ITEMS });
    await inbox.runCycle();
    const [reason] = await inbox.listCancellationReasons("ifood", id);
    const spy = vi.spyOn(api, "requestCancellation");
    const save = repository.saveOrder.bind(repository);
    let calls = 0;
    vi.spyOn(repository, "saveOrder").mockImplementation(async (record) => {
      calls += 1;
      if (calls >= 2) throw new Error("banco fora do ar");
      return save(record);
    });
    const failure = await inbox.requestCancellation("ifood", id, reason).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DeliverySentNotSavedError);
    vi.mocked(repository.saveOrder).mockImplementation(save);
    expect((await repository.getOrder("ifood", id))!.cancellationRequest).toMatchObject({ state: "sending", code: reason.code });
    await expect(inbox.requestCancellation("ifood", id, reason)).rejects.toMatchObject({ code: "conflict" });
    expect(spy).toHaveBeenCalledTimes(1);
    // A reserva não trava o pedido: confirmar segue valendo enquanto o app não responde.
    await inbox.performAction("ifood", id, "confirm");
    // O evento do app (CAR) fecha a reserva; o pedido fica pendente de cancelamento.
    await inbox.runCycle();
    const record = (await repository.getOrder("ifood", id))!;
    expect(record.cancellationRequest).toBeNull();
    expect(record.cancellationPending).toBe(true);
  });

  it("cancelamento: falha incerta bloqueia nova tentativa por 10 min; recusa clara libera; recusa do app (CARF) limpa", async () => {
    let now = new Date("2026-11-14T15:00:00.000Z");
    const { sandbox, api, repository, inbox } = setup({ now: () => now });
    sandbox.autoAcceptCancellation = false;
    const id = sandbox.placeOrder({ items: ITEMS });
    await inbox.runCycle();
    const [reason] = await inbox.listCancellationReasons("ifood", id);
    sandbox.failNext("/requestCancellation", 400);
    await expect(inbox.requestCancellation("ifood", id, reason)).rejects.toMatchObject({ code: "invalid_request" });
    expect((await repository.getOrder("ifood", id))!.cancellationRequest).toBeNull();
    vi.spyOn(api, "requestCancellation").mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(inbox.requestCancellation("ifood", id, reason)).rejects.toThrow(/fetch failed/);
    expect((await repository.getOrder("ifood", id))!.cancellationRequest?.state).toBe("uncertain");
    await expect(inbox.requestCancellation("ifood", id, reason)).rejects.toMatchObject({ code: "conflict" });
    now = new Date(now.getTime() + 9 * 60_000);
    await expect(inbox.requestCancellation("ifood", id, reason)).rejects.toMatchObject({ code: "conflict" });
    // Passado o prazo sem nenhum evento do app, a nova tentativa só vai com a conferência do gerente no portal.
    now = new Date(now.getTime() + 2 * 60_000);
    const pending = await inbox.requestCancellation("ifood", id, reason, undefined, { confirmUncertainRetry: true });
    expect(pending).toMatchObject({ cancellationPending: true, cancellationRequest: { state: "sent" } });
    sandbox.decideCancellation(id, false);
    await inbox.runCycle();
    const record = (await repository.getOrder("ifood", id))!;
    expect(record.cancellationRequest).toBeNull();
    expect(record.cancellationPending).toBe(false);
  });

  describe("cancelamento sem confirmação, passado o prazo da reserva", () => {
    async function expiredUncertain() {
      let now = new Date("2026-11-14T15:00:00.000Z");
      const ctx = setup({ now: () => now });
      ctx.sandbox.autoAcceptCancellation = false;
      const id = ctx.sandbox.placeOrder({ items: ITEMS });
      await ctx.inbox.runCycle();
      const [reason] = await ctx.inbox.listCancellationReasons("ifood", id);
      vi.spyOn(ctx.api, "requestCancellation").mockRejectedValueOnce(new TypeError("fetch failed"));
      await expect(ctx.inbox.requestCancellation("ifood", id, reason)).rejects.toThrow(/fetch failed/);
      now = new Date(now.getTime() + CANCELLATION_RESERVATION_TTL_MS + 60_000);
      const send = vi.spyOn(ctx.api, "requestCancellation");
      send.mockClear();
      const getOrder = vi.spyOn(ctx.api, "getOrder");
      return { ...ctx, id, reason, send, getOrder };
    }

    it("sem a conferência do gerente continua bloqueado e nem consulta o app", async () => {
      const { inbox, repository, id, reason, send, getOrder } = await expiredUncertain();
      await expect(inbox.requestCancellation("ifood", id, reason)).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/Portal do Parceiro/) });
      expect(send).not.toHaveBeenCalled();
      expect(getOrder).not.toHaveBeenCalled();
      expect((await repository.getOrder("ifood", id))!.cancellationRequest?.state).toBe("uncertain");
    });

    it("app já mostra o pedido cancelado: grava, recusa e não pede de novo", async () => {
      const { inbox, repository, id, reason, send, getOrder } = await expiredUncertain();
      const detail = (await repository.getOrder("ifood", id))!.order;
      getOrder.mockResolvedValueOnce({ ...detail, status: "cancelled" });
      await expect(inbox.requestCancellation("ifood", id, reason, undefined, { confirmUncertainRetry: true })).rejects.toMatchObject({ code: "conflict" });
      expect(send).not.toHaveBeenCalled();
      const record = (await repository.getOrder("ifood", id))!;
      expect(record.order.status).toBe("cancelled");
      expect(record.cancellationRequest).toBeNull();
      expect(record.cancellationPending).toBe(false);
    });

    it("app não mostra cancelado: pede uma vez e deixa a pendência registrada", async () => {
      const { inbox, repository, id, reason, send } = await expiredUncertain();
      const record = await inbox.requestCancellation("ifood", id, reason, undefined, { confirmUncertainRetry: true });
      expect(send).toHaveBeenCalledOnce();
      expect(record).toMatchObject({ cancellationPending: true, cancellationRequest: { state: "sent" }, needsReview: true });
      expect(record.reviewReasons).toContain(UNCERTAIN_CANCELLATION_RETRIED);
      // A nova reserva vale de novo: um terceiro pedido não sai.
      await expect(inbox.requestCancellation("ifood", id, reason, undefined, { confirmUncertainRetry: true })).rejects.toMatchObject({ code: "conflict" });
      expect(send).toHaveBeenCalledOnce();
      expect((await repository.getOrder("ifood", id))!.reviewReasons).toContain(UNCERTAIN_CANCELLATION_RETRIED);
    });

    it("consulta ao app falha: continua bloqueado", async () => {
      const { inbox, repository, id, reason, send, getOrder } = await expiredUncertain();
      getOrder.mockRejectedValueOnce(new TypeError("fetch failed"));
      await expect(inbox.requestCancellation("ifood", id, reason, undefined, { confirmUncertainRetry: true })).rejects.toMatchObject({
        code: "conflict",
        message: expect.stringMatching(/Portal do Parceiro/),
      });
      expect(send).not.toHaveBeenCalled();
      expect((await repository.getOrder("ifood", id))!.cancellationRequest?.state).toBe("uncertain");
    });

    it("dentro do prazo a conferência não libera", async () => {
      let now = new Date("2026-11-14T15:00:00.000Z");
      const { sandbox, api, inbox } = setup({ now: () => now });
      const id = sandbox.placeOrder({ items: ITEMS });
      await inbox.runCycle();
      const [reason] = await inbox.listCancellationReasons("ifood", id);
      vi.spyOn(api, "requestCancellation").mockRejectedValueOnce(new TypeError("fetch failed"));
      await expect(inbox.requestCancellation("ifood", id, reason)).rejects.toThrow(/fetch failed/);
      now = new Date(now.getTime() + 60_000);
      const send = vi.spyOn(api, "requestCancellation");
      send.mockClear();
      await expect(inbox.requestCancellation("ifood", id, reason, undefined, { confirmUncertainRetry: true })).rejects.toMatchObject({ code: "conflict" });
      expect(send).not.toHaveBeenCalled();
    });
  });

  it("negociação: iFood aceitou e o banco falhou depois: erro próprio (não 'banco indisponível')", async () => {
    const { sandbox, repository, inbox } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await inbox.runCycle();
    const disputeId = sandbox.openDispute(id);
    await inbox.runCycle();
    const save = repository.saveOrder.bind(repository);
    let calls = 0;
    vi.spyOn(repository, "saveOrder").mockImplementation(async (record) => {
      calls += 1;
      if (calls >= 2) throw new Error("banco fora do ar");
      return save(record);
    });
    await expect(inbox.respondToDispute("ifood", id, { kind: "accept" }, disputeId)).rejects.toBeInstanceOf(DeliverySentNotSavedError);
  });

  it("detalhe ilegível (valor negativo, sem itens): pedido entra mínimo, para conferência, e o evento recebe ack", async () => {
    const onNewOrder = vi.fn();
    const { sandbox, api, repository, inbox } = setup({ onNewOrder });
    const id = sandbox.placeOrder({ items: ITEMS });
    vi.spyOn(api, "getOrder").mockRejectedValue(new DeliveryMarketplaceError("ifood", "invalid_response", "Valor inválido no iFood: total.subTotal."));
    const [report] = await inbox.runCycle();
    expect(report).toMatchObject({ received: 1, acknowledged: 1, deferred: 0, newOrders: [id], error: null });
    expect(sandbox.pendingEventCount()).toBe(0);
    const record = (await repository.getOrder("ifood", id))!;
    expect(record.order).toMatchObject({ status: "placed", items: [], merchantExternalId: sandbox.merchantId, isTest: false });
    expect(record.order.totals.orderCents).toBe(0);
    expect(record.needsReview).toBe(true);
    expect(record.reviewReasons).toContain(
      "Detalhe do pedido ilegível no iFood (Valor inválido no iFood: total.subTotal.): confira e confirme pelo Portal do Parceiro.",
    );
    expect(onNewOrder).toHaveBeenCalledOnce();
    // Os eventos seguintes andam o status normalmente.
    await inbox.performAction("ifood", id, "confirm");
    await inbox.runCycle();
    expect((await repository.getOrder("ifood", id))!.order.status).toBe("confirmed");
  });

  it(`detalhe recusado (403/404) em ${ORDER_DETAIL_MAX_FAILURES} ciclos seguidos: pedido entra mínimo; antes disso só adia`, async () => {
    const { sandbox, api, repository, inbox } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    const getOrder = vi.spyOn(api, "getOrder").mockRejectedValue(new DeliveryMarketplaceError("ifood", "not_found", "Pedido não encontrado no iFood.", 404));
    for (let cycle = 1; cycle < ORDER_DETAIL_MAX_FAILURES; cycle += 1) {
      const [report] = await inbox.runCycle();
      expect(report).toMatchObject({ acknowledged: 0, deferred: 1 });
    }
    expect(await repository.getOrder("ifood", id)).toBeNull();
    const [last] = await inbox.runCycle();
    expect(last).toMatchObject({ acknowledged: 1, newOrders: [id] });
    // Mais uma: a tentativa de recuperar o detalhe, no mesmo ciclo, depois do ack.
    expect(getOrder).toHaveBeenCalledTimes(ORDER_DETAIL_MAX_FAILURES + 1);
    expect((await repository.getOrder("ifood", id))!.detailPending).toBe(true);
    const record = (await repository.getOrder("ifood", id))!;
    expect(record.reviewReasons.join(" ")).toMatch(/Detalhe do pedido ilegível no iFood \(Pedido não encontrado no iFood\.\)/);
  });

  it("falha temporária do detalhe nunca vira pedido mínimo, por mais ciclos que passe", async () => {
    const { sandbox, api, repository, inbox } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    vi.spyOn(api, "getOrder").mockRejectedValue(new DeliveryMarketplaceError("ifood", "unavailable", "iFood indisponível (tempo esgotado)."));
    for (let cycle = 0; cycle < ORDER_DETAIL_MAX_FAILURES + 2; cycle += 1) await inbox.runCycle();
    expect(await repository.getOrder("ifood", id)).toBeNull();
    expect(sandbox.pendingEventCount()).toBe(1);
  });

  it(`pedido mínimo depois de ${ORDER_DETAIL_MAX_FAILURES} respostas 404: entra para revisão e depois recupera o detalhe sem perder o estado`, async () => {
    const announced: DeliveryOrderRecord[] = [];
    const onNewOrder = vi.fn((record: DeliveryOrderRecord) => {
      announced.push(structuredClone(record));
    });
    let offset = 0;
    const { sandbox, api, repository, inbox } = setup({ onNewOrder, now: () => new Date(Date.now() + offset) });
    sandbox.autoAcceptCancellation = false;
    const id = sandbox.placeOrder({ items: ITEMS, isTest: true });
    const realGetOrder = api.getOrder.bind(api);
    const expected = await realGetOrder(id);
    // 404 nas 10 tentativas do primeiro evento e também na primeira recuperação (mesmo ciclo); depois o detalhe vem.
    let calls = 0;
    const getOrder = vi.spyOn(api, "getOrder").mockImplementation(async (orderId) => {
      calls += 1;
      if (calls <= ORDER_DETAIL_MAX_FAILURES + 1) throw new DeliveryMarketplaceError("ifood", "not_found", "Pedido não encontrado no iFood.", 404);
      return realGetOrder(orderId);
    });
    for (let cycle = 1; cycle <= ORDER_DETAIL_MAX_FAILURES; cycle += 1) await inbox.runCycle();
    expect(getOrder).toHaveBeenCalledTimes(ORDER_DETAIL_MAX_FAILURES + 1);
    // Primeiro: pedido mínimo, para revisão, marcado sem detalhe (não vira venda nem NFC-e).
    let record = (await repository.getOrder("ifood", id))!;
    expect(record).toMatchObject({ detailPending: true, needsReview: true, newOrderNotified: true, order: { items: [], payments: [], isTest: false } });
    expect(record.order.totals.orderCents).toBe(0);
    expect(onNewOrder).toHaveBeenCalledOnce();
    expect(announced[0]).toMatchObject({ detailPending: true, needsReview: true });

    // O pedido anda antes da recuperação: confirmado e com pedido de cancelamento da loja esperando o app.
    await inbox.performAction("ifood", id, "confirm");
    // A recuperação que falhou adiou o pedido: a próxima tentativa só depois do espaçamento.
    offset += DETAIL_RETRY_DELAY_SECONDS * 1000;
    await inbox.runCycle();
    // Ciclo acima: CFM aplicado e a recuperação (chamada 12) já trouxe o detalhe.
    record = (await repository.getOrder("ifood", id))!;
    expect(record.detailPending).toBe(false);
    expect(record.order.status).toBe("confirmed");
    expect(record.order.items).toEqual(expected.items);
    expect(record.order.payments).toEqual(expected.payments);
    expect(record.order.totals).toEqual(expected.totals);
    expect(record.order.totals.orderCents).toBeGreaterThan(0);
    expect(record.order.isTest).toBe(true);
    expect(record.order.customer).toEqual(expected.customer);
    expect(record.order.displayId).toBe(expected.displayId);
    expect(record.needsReview).toBe(true);
    expect(record.newOrderNotified).toBe(true);
    expect(record.reviewReasons).toContain(DETAIL_RECOVERED_REASON);
    // A pendência do pedido mínimo fica no histórico de conferência.
    expect(record.reviewReasons.join(" ")).toMatch(/Detalhe do pedido ilegível no iFood/);
    expect(onNewOrder).toHaveBeenCalledOnce();
    expect(sandbox.pendingEventCount()).toBe(0);

    // Recuperado, não busca de novo nem duplica nada.
    const [reasonCode] = await inbox.listCancellationReasons("ifood", id);
    await inbox.requestCancellation("ifood", id, reasonCode!);
    const callsBefore = getOrder.mock.calls.length;
    const [report] = await inbox.runCycle();
    expect(report).toMatchObject({ duplicates: 0, newOrders: [], error: null });
    expect(getOrder.mock.calls.length).toBe(callsBefore);
    record = (await repository.getOrder("ifood", id))!;
    expect(record).toMatchObject({ detailPending: false, cancellationPending: true, order: { status: "confirmed", isTest: true } });
    expect(record.reviewReasons.filter((reason) => reason === DETAIL_RECOVERED_REASON)).toHaveLength(1);
  });

  it("recuperação preserva cancelamento, negociação, pendências e status já processados", async () => {
    let offset = 0;
    const { sandbox, api, repository, inbox } = setup({ now: () => new Date(Date.now() + offset) });
    sandbox.autoAcceptCancellation = false;
    const id = sandbox.placeOrder({ items: ITEMS });
    const realGetOrder = api.getOrder.bind(api);
    let broken = true;
    vi.spyOn(api, "getOrder").mockImplementation(async (orderId) => {
      if (broken) throw new DeliveryMarketplaceError("ifood", "invalid_response", "Valor inválido no iFood: total.subTotal.");
      return realGetOrder(orderId);
    });
    await inbox.runCycle();
    await inbox.performAction("ifood", id, "confirm");
    await inbox.runCycle();
    const [reason] = await inbox.listCancellationReasons("ifood", id);
    await inbox.requestCancellation("ifood", id, reason!);
    await inbox.runCycle();
    sandbox.openDispute(id);
    await inbox.runCycle();
    const before = (await repository.getOrder("ifood", id))!;
    expect(before).toMatchObject({ detailPending: true, cancellationPending: true, order: { status: "confirmed" } });
    expect(before.dispute).not.toBeNull();

    broken = false;
    offset += DETAIL_RETRY_DELAY_SECONDS * 1000;
    await inbox.runCycle();
    const after = (await repository.getOrder("ifood", id))!;
    expect(after.detailPending).toBe(false);
    expect(after.order.items.length).toBeGreaterThan(0);
    // O detalhe do iFood diz "placed": o status gravado pelos eventos não volta.
    expect(after.order.status).toBe("confirmed");
    expect(after.cancellationPending).toBe(true);
    expect(after.cancellationRequest).toEqual(before.cancellationRequest);
    expect(after.dispute).toEqual(before.dispute);
    expect(after.lastEventAt).toBe(before.lastEventAt);
    expect(after.lastCancellationEventAt).toBe(before.lastCancellationEventAt);
    expect(after.reviewReasons).toEqual([...before.reviewReasons, DETAIL_RECOVERED_REASON]);
    expect(after.version).toBe(before.version + 1);
  });

  it("recuperação respeita a versão: gravação concorrente no meio não é sobrescrita", async () => {
    let offset = 0;
    const { sandbox, api, repository, inbox } = setup({ now: () => new Date(Date.now() + offset) });
    const id = sandbox.placeOrder({ items: ITEMS });
    const realGetOrder = api.getOrder.bind(api);
    let broken = true;
    vi.spyOn(api, "getOrder").mockImplementation(async (orderId) => {
      if (broken) throw new DeliveryMarketplaceError("ifood", "invalid_response", "Valor inválido no iFood: total.subTotal.");
      return realGetOrder(orderId);
    });
    await inbox.runCycle();
    broken = false;
    offset += DETAIL_RETRY_DELAY_SECONDS * 1000;
    const save = repository.saveOrder.bind(repository);
    let raced = false;
    vi.spyOn(repository, "saveOrder").mockImplementation(async (record) => {
      if (!raced && !record.detailPending) {
        // Outro processo (ação da tela) grava o pedido entre a leitura e a gravação da recuperação.
        raced = true;
        const other = (await repository.getOrder("ifood", id))!;
        other.cancellationPending = true;
        other.reviewReasons.push("gravação concorrente");
        await save(other);
      }
      return save(record);
    });
    await inbox.runCycle();
    const record = (await repository.getOrder("ifood", id))!;
    expect(raced).toBe(true);
    expect(record.detailPending).toBe(false);
    expect(record.order.items.length).toBeGreaterThan(0);
    expect(record.cancellationPending).toBe(true);
    expect(record.reviewReasons).toContain("gravação concorrente");
    expect(record.reviewReasons).toContain(DETAIL_RECOVERED_REASON);
  });

  it("falha na recuperação (app ou banco) deixa o pedido mínimo e não atrapalha o ack dos outros eventos", async () => {
    let offset = 0;
    const { sandbox, api, repository, inbox } = setup({ now: () => new Date(Date.now() + offset) });
    const minimal = sandbox.placeOrder({ items: ITEMS });
    const realGetOrder = api.getOrder.bind(api);
    let failure: DeliveryMarketplaceError | null = new DeliveryMarketplaceError("ifood", "invalid_response", "Valor inválido no iFood: total.subTotal.");
    const getOrder = vi.spyOn(api, "getOrder").mockImplementation(async (orderId) => {
      if (orderId === minimal && failure) throw failure;
      return realGetOrder(orderId);
    });
    await inbox.runCycle();
    for (const code of ["unavailable", "not_found", "rate_limited"] as const) {
      failure = new DeliveryMarketplaceError("ifood", code, `falha ${code}`);
      // Cada falha adia o pedido: passado o espaçamento ele volta e falha de novo.
      offset += DETAIL_RETRY_DELAY_SECONDS * 1000;
      const callsBefore = getOrder.mock.calls.filter(([orderId]) => orderId === minimal).length;
      const other = sandbox.placeOrder({ items: ITEMS });
      const [report] = await inbox.runCycle();
      expect(report).toMatchObject({ acknowledged: 1, deferred: 0, newOrders: [other], error: null });
      expect(getOrder.mock.calls.filter(([orderId]) => orderId === minimal).length).toBe(callsBefore + 1);
      expect((await repository.getOrder("ifood", minimal))!.detailPending).toBe(true);
    }
    // Banco fora do ar na lista de pendentes: o ciclo segue.
    offset += DETAIL_RETRY_DELAY_SECONDS * 1000;
    vi.spyOn(repository, "listDetailPending").mockRejectedValueOnce(new Error("banco fora do ar"));
    const other = sandbox.placeOrder({ items: ITEMS });
    const [report] = await inbox.runCycle();
    expect(report).toMatchObject({ acknowledged: 1, newOrders: [other], error: null });
    // Polling fora do ar: nem tenta recuperar.
    failure = null;
    vi.spyOn(api, "pollEvents").mockRejectedValueOnce(new DeliveryMarketplaceError("ifood", "unavailable", "iFood fora do ar"));
    await inbox.runCycle();
    expect((await repository.getOrder("ifood", minimal))!.detailPending).toBe(true);
    await inbox.runCycle();
    expect((await repository.getOrder("ifood", minimal))!.detailPending).toBe(false);
  });

  it("pedido com detalhe completo nunca fica pendente; registro antigo sem o campo conta como completo", async () => {
    const { sandbox, repository, inbox } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await inbox.runCycle();
    expect((await repository.getOrder("ifood", id))!.detailPending).toBe(false);
    expect(await repository.listDetailPending("ifood", 20)).toEqual([]);
  });

  it("detalhe sem merchant.id: vale a loja do evento", async () => {
    const { sandbox, api, repository, inbox } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    const getOrder = api.getOrder.bind(api);
    vi.spyOn(api, "getOrder").mockImplementation(async (orderId) => ({ ...(await getOrder(orderId)), merchantExternalId: "" }));
    await inbox.runCycle();
    expect((await repository.getOrder("ifood", id))!.order.merchantExternalId).toBe(sandbox.merchantId);
  });

  it("pedido que o PDV só vê já cancelado não dispara aviso de pedido novo", async () => {
    const onNewOrder = vi.fn();
    const { sandbox, api, repository, inbox } = setup({ onNewOrder });
    const id = sandbox.placeOrder({ items: ITEMS });
    sandbox.emitFromMarketplace(id, "CAN");
    // O PLC se perdeu (ack dado por outra instalação): o primeiro evento que chega é o CAN.
    const poll = api.pollEvents.bind(api);
    vi.spyOn(api, "pollEvents").mockImplementation(async () => (await poll()).filter((event) => event.rawCode !== "PLC"));
    const [report] = await inbox.runCycle();
    expect(report).toMatchObject({ acknowledged: 1, newOrders: [] });
    expect(onNewOrder).not.toHaveBeenCalled();
    const record = (await repository.getOrder("ifood", id))!;
    expect(record).toMatchObject({ newOrderNotified: true, order: { status: "cancelled" } });
  });

  it("clique duplo numa ação de status chama o app uma vez só", async () => {
    const { sandbox, api, inbox } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await inbox.runCycle();
    const spy = vi.spyOn(api, "performAction");
    const results = await Promise.allSettled([inbox.performAction("ifood", id, "confirm"), inbox.performAction("ifood", id, "confirm")]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    // Terminada a chamada, a trava sai (a próxima ação do pedido segue normal).
    await inbox.runCycle();
    await inbox.performAction("ifood", id, "start_preparation");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("negociação depois da entrega (AFTER_DELIVERY) num pedido concluído é gravada e pode ser respondida", async () => {
    const { sandbox, repository, inbox } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await inbox.runCycle();
    sandbox.emitFromMarketplace(id, "CON");
    await inbox.runCycle();
    expect((await repository.getOrder("ifood", id))!.order.status).toBe("concluded");
    const disputeId = sandbox.openDispute(id, { handshakeType: "AFTER_DELIVERY" });
    await inbox.runCycle();
    const record = (await repository.getOrder("ifood", id))!;
    expect(record.order.status).toBe("concluded");
    expect(record.dispute).not.toBeNull();
    expect(record.reviewReasons.join(" ")).toMatch(/negociação/);
    const answered = await inbox.respondToDispute("ifood", id, { kind: "accept" }, disputeId);
    expect(answered.dispute?.response?.state).toBe("sent");
  });
});

describe("recuperação do detalhe: rodízio, espaçamento e orçamento de tempo", () => {
  const START = Date.parse("2026-11-14T12:00:00.000Z");

  async function pendingSetup(count: number, getOrder: (id: string) => Promise<DeliveryOrder>) {
    let clock = START;
    const now = () => new Date(clock);
    const repository = new InMemoryDeliveryRepository({ now });
    const template = await baseOrder();
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const id = `p${String(i).padStart(2, "0")}`;
      ids.push(id);
      const createdAt = new Date(START - (count - i) * 60_000).toISOString();
      await repository.saveOrder({
        order: { ...template, externalId: id, createdAt, items: [], payments: [] },
        cancellationPending: false,
        cancellationRequest: null,
        detailPending: true,
        needsReview: true,
        reviewReasons: ["Detalhe do pedido ilegível no iFood."],
        newOrderNotified: true,
        lastCancellationEventAt: null,
        lastEventAt: createdAt,
        updatedAt: createdAt,
        dispute: null,
        version: 0,
      });
    }
    const asked: string[] = [];
    const adapter = {
      channel: "ifood" as const,
      pollEvents: async () => [],
      acknowledge: async () => undefined,
      getOrder: async (id: string) => {
        asked.push(id);
        return getOrder(id);
      },
      performAction: async () => undefined,
      listCancellationReasons: async () => [],
      requestCancellation: async () => undefined,
      respondToDispute: async () => undefined,
    };
    const inbox = new DeliveryInbox({ adapters: [adapter], repository, now });
    return { repository, inbox, ids, asked, template, advance: (ms: number) => (clock += ms) };
  }

  it(`${DETAIL_RECOVERY_BATCH} pedidos cujo detalhe nunca vem não travam um pedido mínimo novo; voltam depois do espaçamento`, async () => {
    let ctx!: Awaited<ReturnType<typeof pendingSetup>>;
    ctx = await pendingSetup(DETAIL_RECOVERY_BATCH + 1, async (id) => {
      if (id === ctx.ids[DETAIL_RECOVERY_BATCH]) return { ...ctx.template, externalId: id };
      throw new DeliveryMarketplaceError("ifood", "not_found", "Pedido não encontrado no iFood.", 404);
    });
    const newest = ctx.ids[DETAIL_RECOVERY_BATCH]!;
    await ctx.inbox.runCycle();
    expect(ctx.asked).toEqual(ctx.ids.slice(0, DETAIL_RECOVERY_BATCH));
    ctx.asked.length = 0;
    ctx.advance(30_000);
    await ctx.inbox.runCycle();
    // Os antigos foram adiados: o novo é buscado no ciclo seguinte e recuperado.
    expect(ctx.asked).toEqual([newest]);
    expect((await ctx.repository.getOrder("ifood", newest))!.detailPending).toBe(false);
    ctx.asked.length = 0;
    ctx.advance(30_000);
    await ctx.inbox.runCycle();
    expect(ctx.asked).toEqual([]);
    // Passado o espaçamento, os antigos voltam a ser tentados.
    ctx.advance(DETAIL_RETRY_DELAY_SECONDS * 1000);
    await ctx.inbox.runCycle();
    expect(ctx.asked).toEqual(ctx.ids.slice(0, DETAIL_RECOVERY_BATCH));
  });

  it("detalhe de outra loja: marca para conferência uma vez e só tenta de novo depois de 1 h", async () => {
    let ctx!: Awaited<ReturnType<typeof pendingSetup>>;
    ctx = await pendingSetup(1, async (id) => ({ ...ctx.template, externalId: id, merchantExternalId: "outra-loja" }));
    await ctx.inbox.runCycle();
    const record = (await ctx.repository.getOrder("ifood", ctx.ids[0]!))!;
    expect(record.detailPending).toBe(true);
    expect(record.reviewReasons.join(" ")).toMatch(/outra loja/);
    ctx.advance(DETAIL_RETRY_DELAY_SECONDS * 1000);
    await ctx.inbox.runCycle();
    expect(ctx.asked).toHaveLength(1);
    ctx.advance(DETAIL_OTHER_STORE_RETRY_SECONDS * 1000);
    await ctx.inbox.runCycle();
    expect(ctx.asked).toHaveLength(2);
    expect((await ctx.repository.getOrder("ifood", ctx.ids[0]!))!.version).toBe(record.version);
  });

  it("detalhe lento: o laço para no orçamento de tempo e os que sobraram vêm no próximo ciclo", async () => {
    let ctx!: Awaited<ReturnType<typeof pendingSetup>>;
    ctx = await pendingSetup(DETAIL_RECOVERY_BATCH, async (id) => {
      ctx.advance(4_000);
      return { ...ctx.template, externalId: id };
    });
    await ctx.inbox.runCycle();
    const first = Math.ceil(DETAIL_RECOVERY_BUDGET_MS / 4_000);
    expect(ctx.asked).toEqual(ctx.ids.slice(0, first));
    ctx.asked.length = 0;
    ctx.advance(30_000);
    await ctx.inbox.runCycle();
    expect(ctx.asked).toEqual(ctx.ids.slice(first, 2 * first));
  });

  it("app fora do ar ou limite de uso: para no primeiro erro e adia só esse pedido", async () => {
    for (const code of ["unavailable", "rate_limited"] as const) {
      let ctx!: Awaited<ReturnType<typeof pendingSetup>>;
      let fail = true;
      ctx = await pendingSetup(3, async (id) => {
        if (fail) {
          fail = false;
          throw new DeliveryMarketplaceError("ifood", code, `falha ${code}`);
        }
        return { ...ctx.template, externalId: id };
      });
      await ctx.inbox.runCycle();
      expect(ctx.asked).toEqual([ctx.ids[0]]);
      ctx.asked.length = 0;
      ctx.advance(30_000);
      await ctx.inbox.runCycle();
      expect(ctx.asked).toEqual([ctx.ids[1], ctx.ids[2]]);
      expect((await ctx.repository.getOrder("ifood", ctx.ids[0]!))!.detailPending).toBe(true);
      ctx.advance(DETAIL_RETRY_DELAY_SECONDS * 1000);
      await ctx.inbox.runCycle();
      expect((await ctx.repository.getOrder("ifood", ctx.ids[0]!))!.detailPending).toBe(false);
    }
  });

  it("falha ao adiar (banco) não derruba o ciclo", async () => {
    let ctx!: Awaited<ReturnType<typeof pendingSetup>>;
    ctx = await pendingSetup(2, async () => {
      throw new DeliveryMarketplaceError("ifood", "not_found", "404");
    });
    vi.spyOn(ctx.repository, "deferDetail").mockRejectedValue(new Error("banco fora do ar"));
    const [report] = await ctx.inbox.runCycle();
    expect(report.error).toBeNull();
    expect(ctx.asked).toEqual(ctx.ids);
  });
});

describe("resposta à negociação sem confirmação: nova tentativa com a conferência do gerente", () => {
  async function openDispute(now: () => Date, input: { expiresAt?: string } = {}) {
    const ctx = setup({ now });
    const id = ctx.sandbox.placeOrder({ items: ITEMS });
    await ctx.inbox.runCycle();
    const disputeId = ctx.sandbox.openDispute(id, { handshakeType: "PREPARATION_TIME", timeoutAction: "ACCEPT_CANCELLATION", ...input });
    await ctx.inbox.runCycle();
    return { ...ctx, id, disputeId };
  }
  const reject = { kind: "reject", reason: "Já está saindo" } as const;

  it("resposta incerta (iFood 503): sem a conferência é 409 explicando; com ela repete e chega ao iFood", async () => {
    const now = new Date("2026-11-14T15:00:00.000Z");
    const { sandbox, api, repository, inbox, id, disputeId } = await openDispute(() => now);
    sandbox.failNext("/disputes/", 503);
    await expect(inbox.respondToDispute("ifood", id, reject, disputeId)).rejects.toMatchObject({ code: "unavailable" });
    expect((await repository.getOrder("ifood", id))!.dispute?.response?.state).toBe("uncertain");
    const send = vi.spyOn(api, "respondToDispute");
    // Sem a conferência: 409 dizendo que a resposta anterior pode não ter chegado (e não "aguarde o app").
    const blocked = { code: "conflict", message: expect.stringMatching(/pode não ter chegado.*Portal do Parceiro.*confirmando/) };
    await expect(inbox.checkDisputeDecision("ifood", id, reject, disputeId)).rejects.toMatchObject(blocked);
    await expect(inbox.respondToDispute("ifood", id, reject, disputeId)).rejects.toMatchObject(blocked);
    expect(send).not.toHaveBeenCalled();
    // Com a conferência: confere, reserva de novo e manda.
    await expect(inbox.checkDisputeDecision("ifood", id, reject, disputeId, { confirmUncertainRetry: true })).resolves.toMatchObject({ disputeId });
    const answered = await inbox.respondToDispute("ifood", id, reject, disputeId, { confirmUncertainRetry: true });
    expect(send).toHaveBeenCalledOnce();
    expect(answered.dispute).toMatchObject({ response: { state: "sent", decision: { kind: "reject" } } });
    expect(answered.dispute?.respondedAt).not.toBeNull();
    // Depois de enviada, nem com a conferência sai outra.
    await expect(inbox.respondToDispute("ifood", id, reject, disputeId, { confirmUncertainRetry: true })).rejects.toMatchObject({ code: "conflict" });
    expect(send).toHaveBeenCalledOnce();
  });

  it("o 409 sem a conferência cita o prazo da negociação", async () => {
    const now = new Date("2026-11-14T15:00:00.000Z");
    const { api, inbox, id, disputeId } = await openDispute(() => now, { expiresAt: "2026-11-14T15:05:00.000Z" });
    vi.spyOn(api, "respondToDispute").mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(inbox.respondToDispute("ifood", id, reject, disputeId)).rejects.toThrow(/fetch failed/);
    await expect(inbox.respondToDispute("ifood", id, reject, disputeId)).rejects.toMatchObject({
      message: expect.stringContaining("2026-11-14T15:05:00.000Z"),
    });
  });

  it("resposta repetida que o iFood já tinha recebido (422 DISPUTE_ALREADY_ANSWERED) fica como respondida", async () => {
    const now = new Date("2026-11-14T15:00:00.000Z");
    const { sandbox, api, repository, inbox } = setup({ now: () => now });
    const id = sandbox.placeOrder({ items: ITEMS });
    await inbox.runCycle();
    const disputeId = sandbox.openDispute(id, { alternatives: ["REFUND"] });
    await inbox.runCycle();
    const alternativeId = (await repository.getOrder("ifood", id))!.dispute!.alternatives[0]!.id;
    const refund = { kind: "alternative", alternativeId, amountCents: 500 } as const;
    // O iFood aplica a resposta, mas ela não volta (rede).
    const original = api.respondToDispute.bind(api);
    const send = vi.spyOn(api, "respondToDispute").mockImplementationOnce(async (...args) => {
      await original(...args);
      throw new TypeError("fetch failed");
    });
    await expect(inbox.respondToDispute("ifood", id, refund, disputeId)).rejects.toThrow(/fetch failed/);
    await expect(inbox.respondToDispute("ifood", id, refund, disputeId, { confirmUncertainRetry: true })).rejects.toMatchObject({ code: "conflict" });
    expect(send).toHaveBeenCalledTimes(2);
    const record = (await repository.getOrder("ifood", id))!;
    expect(record.dispute?.response).toBeNull();
    expect(record.dispute?.respondedAt).not.toBeNull();
    expect(record.reviewReasons.join(" ")).toMatch(/resposta anterior do PDV pode ter chegado/);
  });

  it("resposta 'sending' (processo caiu no meio): bloqueada por 60 s; depois só com a conferência", async () => {
    let now = new Date("2026-11-14T15:00:00.000Z");
    const { api, repository, inbox, id, disputeId } = await openDispute(() => now);
    const stored = (await repository.getOrder("ifood", id))!;
    stored.dispute!.response = { decision: { kind: "reject", reason: "Já está saindo" }, state: "sending", reservedAt: now.toISOString() };
    stored.version = await repository.saveOrder(stored);
    const send = vi.spyOn(api, "respondToDispute");
    now = new Date(now.getTime() + DISPUTE_RESPONSE_STALE_MS - 1_000);
    await expect(inbox.respondToDispute("ifood", id, reject, disputeId, { confirmUncertainRetry: true })).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringMatching(/em andamento/),
    });
    now = new Date(now.getTime() + 2_000);
    await expect(inbox.respondToDispute("ifood", id, reject, disputeId)).rejects.toMatchObject({ message: expect.stringMatching(/pode não ter chegado/) });
    expect(send).not.toHaveBeenCalled();
    const answered = await inbox.respondToDispute("ifood", id, reject, disputeId, { confirmUncertainRetry: true });
    expect(send).toHaveBeenCalledOnce();
    expect(answered.dispute?.response?.state).toBe("sent");
  });
});

describe("reserva gravada e resposta do banco perdida (timeout depois do commit)", () => {
  // O banco grava, mas a resposta não chega: a primeira gravação lança depois de gravar.
  function loseFirstSaveReply(repository: InMemoryDeliveryRepository) {
    const save = repository.saveOrder.bind(repository);
    let lost = false;
    return vi.spyOn(repository, "saveOrder").mockImplementation(async (record) => {
      const version = await save(record);
      if (!lost) {
        lost = true;
        throw new Error("Supabase não respondeu (tchefood_delivery_save_order).");
      }
      return version;
    });
  }

  it("negociação: a reserva é desfeita e a nova tentativa vai normal, sem conferência", async () => {
    const { sandbox, api, repository, inbox } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await inbox.runCycle();
    const disputeId = sandbox.openDispute(id);
    await inbox.runCycle();
    const send = vi.spyOn(api, "respondToDispute");
    const spy = loseFirstSaveReply(repository);
    await expect(inbox.respondToDispute("ifood", id, { kind: "reject", reason: "Saindo" }, disputeId)).rejects.toThrow(/não respondeu/);
    spy.mockRestore();
    expect(send).not.toHaveBeenCalled();
    expect((await repository.getOrder("ifood", id))!.dispute?.response).toBeNull();
    const answered = await inbox.respondToDispute("ifood", id, { kind: "reject", reason: "Saindo" }, disputeId);
    expect(send).toHaveBeenCalledOnce();
    expect(answered.dispute?.response?.state).toBe("sent");
  });

  it("negociação: na repetição de uma resposta incerta, volta a reserva incerta anterior", async () => {
    const { sandbox, api, repository, inbox } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await inbox.runCycle();
    const disputeId = sandbox.openDispute(id);
    await inbox.runCycle();
    vi.spyOn(api, "respondToDispute").mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(inbox.respondToDispute("ifood", id, { kind: "accept" }, disputeId)).rejects.toThrow(/fetch failed/);
    const before = (await repository.getOrder("ifood", id))!.dispute?.response;
    expect(before?.state).toBe("uncertain");
    const spy = loseFirstSaveReply(repository);
    await expect(inbox.respondToDispute("ifood", id, { kind: "accept" }, disputeId, { confirmUncertainRetry: true })).rejects.toThrow(/não respondeu/);
    spy.mockRestore();
    expect((await repository.getOrder("ifood", id))!.dispute?.response).toEqual(before);
  });

  it("cancelamento: a reserva é desfeita, a guarda de venda não acusa cancelamento e a nova tentativa vai normal", async () => {
    const { sandbox, api, repository, inbox } = setup();
    sandbox.autoAcceptCancellation = false;
    const id = sandbox.placeOrder({ items: ITEMS });
    await inbox.runCycle();
    const [reason] = await inbox.listCancellationReasons("ifood", id);
    const send = vi.spyOn(api, "requestCancellation");
    const spy = loseFirstSaveReply(repository);
    await expect(inbox.requestCancellation("ifood", id, reason)).rejects.toThrow(/não respondeu/);
    spy.mockRestore();
    expect(send).not.toHaveBeenCalled();
    const record = (await repository.getOrder("ifood", id))!;
    expect(record.cancellationRequest).toBeNull();
    expect(deliverySaleBlockers(record).join(" ")).not.toMatch(/cancelamento/);
    const pending = await inbox.requestCancellation("ifood", id, reason);
    expect(send).toHaveBeenCalledOnce();
    expect(pending).toMatchObject({ cancellationPending: true, cancellationRequest: { state: "sent" } });
  });

  it("cancelamento: na repetição de um pedido vencido, volta a reserva anterior e sai a marca de repetido", async () => {
    let now = new Date("2026-11-14T15:00:00.000Z");
    const { sandbox, api, repository, inbox } = setup({ now: () => now });
    sandbox.autoAcceptCancellation = false;
    const id = sandbox.placeOrder({ items: ITEMS });
    await inbox.runCycle();
    const [reason] = await inbox.listCancellationReasons("ifood", id);
    vi.spyOn(api, "requestCancellation").mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(inbox.requestCancellation("ifood", id, reason)).rejects.toThrow(/fetch failed/);
    now = new Date(now.getTime() + CANCELLATION_RESERVATION_TTL_MS + 60_000);
    const before = (await repository.getOrder("ifood", id))!;
    const spy = loseFirstSaveReply(repository);
    await expect(inbox.requestCancellation("ifood", id, reason, undefined, { confirmUncertainRetry: true })).rejects.toThrow(/não respondeu/);
    spy.mockRestore();
    const after = (await repository.getOrder("ifood", id))!;
    expect(after.cancellationRequest).toEqual(before.cancellationRequest);
    expect(after.reviewReasons).not.toContain(UNCERTAIN_CANCELLATION_RETRIED);
    expect(after.needsReview).toBe(before.needsReview);
  });

  it("recusa por regra (reserva de outra chamada) não desfaz a reserva existente", async () => {
    const { sandbox, api, repository, inbox } = setup();
    sandbox.autoAcceptCancellation = false;
    const id = sandbox.placeOrder({ items: ITEMS });
    await inbox.runCycle();
    const [reason] = await inbox.listCancellationReasons("ifood", id);
    vi.spyOn(api, "requestCancellation").mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(inbox.requestCancellation("ifood", id, reason)).rejects.toThrow(/fetch failed/);
    await expect(inbox.requestCancellation("ifood", id, reason)).rejects.toMatchObject({ code: "conflict" });
    expect((await repository.getOrder("ifood", id))!.cancellationRequest?.state).toBe("uncertain");
  });

  it("cancelamento: desfazer a repetição não apaga a conferência pedida por evento gravado no meio", async () => {
    let now = new Date("2026-11-14T15:00:00.000Z");
    const { sandbox, api, repository, inbox } = setup({ now: () => now });
    sandbox.autoAcceptCancellation = false;
    const id = sandbox.placeOrder({ items: ITEMS });
    await inbox.runCycle();
    const [reason] = await inbox.listCancellationReasons("ifood", id);
    vi.spyOn(api, "requestCancellation").mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(inbox.requestCancellation("ifood", id, reason)).rejects.toThrow(/fetch failed/);
    now = new Date(now.getTime() + CANCELLATION_RESERVATION_TTL_MS + 60_000);
    expect((await repository.getOrder("ifood", id))!.needsReview).toBe(false);
    // O banco grava a reserva da repetição e a resposta demora (e se perde); no meio, o evento CCR é gravado.
    const save = repository.saveOrder.bind(repository);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let first = true;
    const spy = vi.spyOn(repository, "saveOrder").mockImplementation(async (record) => {
      const version = await save(record);
      if (first) {
        first = false;
        await gate;
        throw new Error("Supabase não respondeu (tchefood_delivery_save_order).");
      }
      return version;
    });
    const retry = inbox.requestCancellation("ifood", id, reason, undefined, { confirmUncertainRetry: true });
    await new Promise((resolve) => setTimeout(resolve, 30));
    sandbox.emitFromMarketplace(id, "CCR");
    const cycle = inbox.runCycle();
    await new Promise((resolve) => setTimeout(resolve, 30));
    release();
    await expect(retry).rejects.toThrow(/não respondeu/);
    await cycle;
    spy.mockRestore();
    const after = (await repository.getOrder("ifood", id))!;
    expect(after.reviewReasons).not.toContain(UNCERTAIN_CANCELLATION_RETRIED);
    expect(after.reviewReasons.length).toBeGreaterThan(0);
    expect(after.needsReview).toBe(true);
  });
});

describe("repetição conferida recusada com clareza pelo app", () => {
  it("cancelamento: volta a reserva incerta anterior (a guarda de venda segue bloqueando) e sai a marca de repetido", async () => {
    let now = new Date("2026-11-14T15:00:00.000Z");
    const { sandbox, repository, inbox } = setup({ now: () => now });
    sandbox.autoAcceptCancellation = false;
    const id = sandbox.placeOrder({ items: ITEMS });
    await inbox.runCycle();
    const [reason] = await inbox.listCancellationReasons("ifood", id);
    sandbox.failNext("requestCancellation", 503);
    await expect(inbox.requestCancellation("ifood", id, reason)).rejects.toThrow();
    now = new Date(now.getTime() + CANCELLATION_RESERVATION_TTL_MS + 60_000);
    const before = (await repository.getOrder("ifood", id))!;
    expect(before.cancellationRequest?.state).toBe("uncertain");
    sandbox.failNext("requestCancellation", 429);
    await expect(inbox.requestCancellation("ifood", id, reason, undefined, { confirmUncertainRetry: true })).rejects.toMatchObject({
      code: "rate_limited",
    });
    const after = (await repository.getOrder("ifood", id))!;
    expect(after.cancellationRequest).toEqual(before.cancellationRequest);
    expect(after.reviewReasons).not.toContain(UNCERTAIN_CANCELLATION_RETRIED);
    expect(after.needsReview).toBe(before.needsReview);
    expect(deliverySaleBlockers(after).join(" ")).toMatch(/cancelamento/);
    // A próxima repetição continua exigindo a conferência.
    await expect(inbox.requestCancellation("ifood", id, reason)).rejects.toMatchObject({ code: "conflict" });
  });

  it("negociação: volta a resposta incerta anterior e a próxima tentativa continua exigindo a conferência", async () => {
    const { sandbox, api, repository, inbox } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await inbox.runCycle();
    const disputeId = sandbox.openDispute(id);
    await inbox.runCycle();
    vi.spyOn(api, "respondToDispute")
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockRejectedValueOnce(new DeliveryMarketplaceError("ifood", "rate_limited", "429"));
    await expect(inbox.respondToDispute("ifood", id, { kind: "accept" }, disputeId)).rejects.toThrow(/fetch failed/);
    const before = (await repository.getOrder("ifood", id))!.dispute?.response;
    expect(before?.state).toBe("uncertain");
    await expect(inbox.respondToDispute("ifood", id, { kind: "accept" }, disputeId, { confirmUncertainRetry: true })).rejects.toThrow(/429/);
    expect((await repository.getOrder("ifood", id))!.dispute?.response).toEqual(before);
    await expect(inbox.checkDisputeDecision("ifood", id, { kind: "accept" }, disputeId)).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("ação de status já enviada (trava de 60 s)", () => {
  it("gravação sem evento (recuperação do detalhe) muda a versão mas não libera a mesma ação", async () => {
    const { sandbox, api, repository, inbox } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    for (let i = 0; i < ORDER_DETAIL_MAX_FAILURES; i++) {
      sandbox.failNext(`/orders/${id}`, 404);
      // No último ciclo a recuperação não roda, para o pedido ficar mínimo.
      if (i === ORDER_DETAIL_MAX_FAILURES - 1) vi.spyOn(repository, "listDetailPending").mockRejectedValueOnce(new Error("db"));
      await inbox.runCycle();
    }
    const pending = (await repository.getOrder("ifood", id))!;
    expect(pending.detailPending).toBe(true);
    const perform = vi.spyOn(api, "performAction").mockResolvedValue(undefined as never);
    await inbox.performAction("ifood", id, "confirm");
    await inbox.runCycle(); // sem eventos: só a recuperação do detalhe, que grava o pedido
    const recovered = (await repository.getOrder("ifood", id))!;
    expect(recovered.detailPending).toBe(false);
    expect(recovered.version).not.toBe(pending.version);
    expect(recovered.order.status).toBe("placed");
    await expect(inbox.performAction("ifood", id, "confirm")).rejects.toThrow(/já enviada/);
    expect(perform).toHaveBeenCalledTimes(1);
  });
});

describe("ação de status: proteção enquanto finaliza (rodada 4)", () => {
  it("leitura do pedido depois do envio ainda pendente: a segunda requisição não chama o app de novo", async () => {
    const { sandbox, api, repository, inbox } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await inbox.runCycle();
    const perform = vi.spyOn(api, "performAction");
    const realGet = repository.getOrder.bind(repository);
    let releaseRead: () => void = () => undefined;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    let reads = 0;
    vi.spyOn(repository, "getOrder").mockImplementation(async (channel, orderId) => {
      reads += 1;
      if (reads === 2) await readGate; // a leitura logo depois do envio fica pendurada
      return realGet(channel, orderId);
    });
    const first = inbox.performAction("ifood", id, "confirm");
    await vi.waitFor(() => expect(perform).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(reads).toBe(2));
    await expect(inbox.performAction("ifood", id, "confirm")).rejects.toThrow(/andamento|já enviada/);
    releaseRead();
    await first;
    await expect(inbox.performAction("ifood", id, "confirm")).rejects.toThrow(/já enviada/);
    expect(perform).toHaveBeenCalledTimes(1);
  });

  it("app aceitou e a leitura seguinte falhou: não sugere reenvio e a repetição não vai ao app", async () => {
    const { sandbox, api, repository, inbox } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await inbox.runCycle();
    const perform = vi.spyOn(api, "performAction");
    const realGet = repository.getOrder.bind(repository);
    let reads = 0;
    vi.spyOn(repository, "getOrder").mockImplementation(async (channel, orderId) => {
      reads += 1;
      if (reads === 2) throw new Error("Banco indisponível.");
      return realGet(channel, orderId);
    });
    const result = await inbox.performAction("ifood", id, "confirm");
    expect(result.order.externalId).toBe(id);
    expect(perform).toHaveBeenCalledTimes(1);
    await expect(inbox.performAction("ifood", id, "confirm")).rejects.toThrow(/já enviada/);
    expect(perform).toHaveBeenCalledTimes(1);
  });
});

describe("pedido mínimo com horário do evento ausente (rodada 4)", () => {
  it("PLC sem createdAt e detalhe ilegível: entra na recuperação e recupera itens, pagamentos, total e isTest sem duplicar eventos", async () => {
    let offset = 0;
    const { sandbox, api, repository, inbox } = setup({ now: () => new Date(Date.now() + offset) });
    const id = sandbox.placeOrder({ items: ITEMS, isTest: true });
    const expected = await api.getOrder(id);
    const realPoll = api.pollEvents.bind(api);
    // O que o adapter produz para um evento sem createdAt (isoInstant: o mais antigo possível).
    vi.spyOn(api, "pollEvents").mockImplementation(async () =>
      (await realPoll()).map((event) => (event.externalOrderId === id ? { ...event, createdAt: new Date(0).toISOString() } : event)),
    );
    const realGetOrder = api.getOrder.bind(api);
    let calls = 0;
    vi.spyOn(api, "getOrder").mockImplementation(async (orderId) => {
      calls += 1;
      if (calls <= ORDER_DETAIL_MAX_FAILURES + 1) throw new DeliveryMarketplaceError("ifood", "not_found", "Pedido não encontrado no iFood.", 404);
      return realGetOrder(orderId);
    });
    for (let cycle = 1; cycle <= ORDER_DETAIL_MAX_FAILURES; cycle += 1) await inbox.runCycle();
    const minimal = (await repository.getOrder("ifood", id))!;
    expect(minimal.detailPending).toBe(true);
    expect(minimal.order.createdAt).toBe(new Date(0).toISOString()); // o horário do iFood fica como veio
    expect(sandbox.pendingEventCount()).toBe(0); // o evento foi confirmado
    offset += DETAIL_RETRY_DELAY_SECONDS * 1000;
    const report = (await inbox.runCycle())[0]!;
    expect(report.duplicates).toBe(0);
    const record = (await repository.getOrder("ifood", id))!;
    expect(record.detailPending).toBe(false);
    expect(record.order.items).toEqual(expected.items);
    expect(record.order.payments).toEqual(expected.payments);
    expect(record.order.totals).toEqual(expected.totals);
    expect(record.order.isTest).toBe(true);
  });
});

describe("pedido concluído pelo app com o cancelamento em análise", () => {
  it("CAR seguido de CON: zera a pendência e marca para conferência; a venda não fica travada para sempre", async () => {
    const { sandbox, repository, inbox } = setup();
    sandbox.autoAcceptCancellation = false;
    const id = sandbox.placeOrder({ items: ITEMS, orderType: "DELIVERY", deliveredBy: "MERCHANT" });
    await inbox.runCycle();
    await inbox.performAction("ifood", id, "confirm");
    await inbox.runCycle();
    const [reason] = await inbox.listCancellationReasons("ifood", id);
    await inbox.requestCancellation("ifood", id, reason);
    await inbox.runCycle(); // CAR
    expect((await repository.getOrder("ifood", id))!.cancellationPending).toBe(true);
    sandbox.emitFromMarketplace(id, "CON");
    await inbox.runCycle();
    const record = (await repository.getOrder("ifood", id))!;
    expect(record.order.status).toBe("concluded");
    expect(record.cancellationPending).toBe(false);
    expect(record.cancellationRequest).toBeNull();
    expect(record.reviewReasons).toContain(CONCLUDED_WITH_PENDING_CANCELLATION);
    expect(deliverySaleBlockers(record)).toEqual([]);
  });

  it("CON com o pedido de cancelamento da loja ainda sem evento do app (reserva): também libera e marca", async () => {
    const { sandbox, api, repository, inbox } = setup();
    sandbox.autoAcceptCancellation = false;
    const id = sandbox.placeOrder({ items: ITEMS });
    await inbox.runCycle();
    const [reason] = await inbox.listCancellationReasons("ifood", id);
    vi.spyOn(api, "requestCancellation").mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(inbox.requestCancellation("ifood", id, reason)).rejects.toThrow(/fetch failed/);
    sandbox.emitFromMarketplace(id, "CON");
    await inbox.runCycle();
    const record = (await repository.getOrder("ifood", id))!;
    expect(record.order.status).toBe("concluded");
    expect(record.cancellationRequest).toBeNull();
    expect(record.reviewReasons).toContain(CONCLUDED_WITH_PENDING_CANCELLATION);
  });

  it("pedido concluído sem cancelamento nenhum não ganha a marca", async () => {
    const { sandbox, repository, inbox } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await inbox.runCycle();
    sandbox.emitFromMarketplace(id, "CON");
    await inbox.runCycle();
    expect((await repository.getOrder("ifood", id))!.reviewReasons).not.toContain(CONCLUDED_WITH_PENDING_CANCELLATION);
  });
});

describe("pedido alterado pelo app depois de gravado (cancelamento parcial, OPA)", () => {
  const XIS = { name: "Xis Galpão", externalCode: "301", quantity: 1, unitPrice: 38 };
  const REFRI = { name: "Refri lata", externalCode: "501", quantity: 1, unitPrice: 8 };

  async function confirmedOrder(now?: () => Date) {
    const ctx = setup({ now });
    const id = ctx.sandbox.placeOrder({ items: [XIS, REFRI] });
    await ctx.inbox.runCycle();
    await ctx.inbox.performAction("ifood", id, "confirm");
    await ctx.inbox.runCycle();
    const before = (await ctx.repository.getOrder("ifood", id))!;
    expect(before.order.totals.orderCents).toBe(4600);
    return { ...ctx, id };
  }

  it("cancelamento parcial aceito pela loja: bloqueia a venda e busca o detalhe de novo (itens e valor novos)", async () => {
    let offset = 0;
    const { sandbox, api, repository, inbox, id } = await confirmedOrder(() => new Date(Date.now() + offset));
    const disputeId = sandbox.openDispute(id, { action: "PARTIAL_CANCELLATION", handshakeType: "PREPARATION_TIME", remainingItems: [XIS] });
    await inbox.runCycle();
    await inbox.respondToDispute("ifood", id, { kind: "accept" }, disputeId);
    // A primeira busca do detalhe novo falha: o pedido fica bloqueado com o valor antigo, nunca liberado com ele.
    const getOrder = vi.spyOn(api, "getOrder").mockRejectedValueOnce(new DeliveryMarketplaceError("ifood", "unavailable", "fora do ar"));
    await inbox.runCycle();
    expect(getOrder).toHaveBeenCalledTimes(1);
    let record = (await repository.getOrder("ifood", id))!;
    expect(record).toMatchObject({ dispute: null, detailPending: true, needsReview: true, order: { status: "confirmed" } });
    expect(record.order.totals.orderCents).toBe(4600);
    expect(record.reviewReasons).toContain(PARTIAL_CANCELLATION_APPLIED_REASON);
    expect(deliverySaleBlockers(record)).toEqual([expect.stringContaining("sem o detalhe do app")]);

    offset += DETAIL_RETRY_DELAY_SECONDS * 1000;
    await inbox.runCycle();
    record = (await repository.getOrder("ifood", id))!;
    expect(record.detailPending).toBe(false);
    expect(record.order.status).toBe("confirmed");
    expect(record.order.items.map((item) => item.name)).toEqual(["Xis Galpão"]);
    expect(record.order.totals.orderCents).toBe(3800);
    expect(record.reviewReasons).toContain(DETAIL_REFRESHED_REASON);
    expect(record.reviewReasons).not.toContain(DETAIL_RECOVERED_REASON);
    expect(deliverySaleBlockers(record)).toEqual([]);
  });

  it("cancelamento parcial vencido: ACCEPT_CANCELLATION aplica (busca de novo); REJECT_CANCELLATION e VOID não mexem", async () => {
    const expired = async (timeoutAction: string) => {
      const ctx = await confirmedOrder();
      const disputeId = ctx.sandbox.openDispute(ctx.id, { action: "PARTIAL_CANCELLATION", handshakeType: "PREPARATION_TIME", timeoutAction, remainingItems: [XIS] });
      await ctx.inbox.runCycle();
      ctx.sandbox.expireDispute(disputeId);
      const getOrder = vi.spyOn(ctx.api, "getOrder");
      await ctx.inbox.runCycle();
      return { record: (await ctx.repository.getOrder("ifood", ctx.id))!, fetched: getOrder.mock.calls.length };
    };
    const accepted = await expired("ACCEPT_CANCELLATION");
    expect(accepted.fetched).toBe(1);
    expect(accepted.record).toMatchObject({ dispute: null, detailPending: false, order: { totals: { orderCents: 3800 } } });
    expect(accepted.record.reviewReasons).toEqual(expect.arrayContaining([PARTIAL_CANCELLATION_APPLIED_REASON, DETAIL_REFRESHED_REASON]));
    for (const timeoutAction of ["REJECT_CANCELLATION", "VOID"]) {
      const kept = await expired(timeoutAction);
      expect(kept.fetched, timeoutAction).toBe(0);
      expect(kept.record, timeoutAction).toMatchObject({ dispute: null, detailPending: false, order: { totals: { orderCents: 4600 } } });
      expect(kept.record.reviewReasons, timeoutAction).not.toContain(PARTIAL_CANCELLATION_APPLIED_REASON);
    }
  });

  it("cancelamento parcial vencido sem saber a ação padrão do app: busca o detalhe de novo por segurança", async () => {
    const { sandbox, api, repository, inbox, id } = await confirmedOrder();
    const disputeId = sandbox.openDispute(id, { action: "PARTIAL_CANCELLATION", handshakeType: "PREPARATION_TIME" });
    await inbox.runCycle();
    // Negociação gravada sem timeoutAction (o HSD não trouxe o campo).
    const stored = (await repository.getOrder("ifood", id))!;
    await repository.saveOrder({ ...stored, dispute: { ...stored.dispute!, timeoutAction: null } });
    sandbox.expireDispute(disputeId);
    const getOrder = vi.spyOn(api, "getOrder");
    await inbox.runCycle();
    const record = (await repository.getOrder("ifood", id))!;
    expect(getOrder).toHaveBeenCalledTimes(1);
    expect(record.detailPending).toBe(false);
    expect(record.reviewReasons).toContain(PARTIAL_CANCELLATION_UNCERTAIN_REASON);
    expect(record.reviewReasons).not.toContain(PARTIAL_CANCELLATION_APPLIED_REASON);
  });

  it("cancelamento parcial recusado, ou trocado por uma proposta aceita pelo cliente, não busca o detalhe", async () => {
    const rejected = await confirmedOrder();
    const first = rejected.sandbox.openDispute(rejected.id, { action: "PARTIAL_CANCELLATION", handshakeType: "PREPARATION_TIME", remainingItems: [XIS] });
    await rejected.inbox.runCycle();
    await rejected.inbox.respondToDispute("ifood", rejected.id, { kind: "reject", reason: "Pedido já saiu" }, first);
    await rejected.inbox.runCycle();
    expect((await rejected.repository.getOrder("ifood", rejected.id))!).toMatchObject({ dispute: null, detailPending: false });

    const refunded = await confirmedOrder();
    const second = refunded.sandbox.openDispute(refunded.id, { action: "PARTIAL_CANCELLATION", handshakeType: "PREPARATION_TIME", alternatives: ["REFUND"] });
    await refunded.inbox.runCycle();
    const [alternative] = (await refunded.repository.getOrder("ifood", refunded.id))!.dispute!.alternatives;
    await refunded.inbox.respondToDispute("ifood", refunded.id, { kind: "alternative", alternativeId: alternative!.id, amountCents: 800 }, second);
    await refunded.inbox.runCycle();
    refunded.sandbox.settleAlternative(second, true);
    await refunded.inbox.runCycle();
    const record = (await refunded.repository.getOrder("ifood", refunded.id))!;
    expect(record).toMatchObject({ dispute: null, detailPending: false });
    expect(record.reviewReasons).not.toContain(PARTIAL_CANCELLATION_APPLIED_REASON);
    expect(record.reviewReasons.join(" ")).toMatch(/reembolso de R\$ 8,00/);
  });

  it("OPA (pedido alterado pelo app): pendência, venda bloqueada e detalhe buscado de novo", async () => {
    let offset = 0;
    const { sandbox, api, repository, inbox, id } = await confirmedOrder(() => new Date(Date.now() + offset));
    sandbox.patchOrder(id, [XIS]);
    const getOrder = vi.spyOn(api, "getOrder").mockRejectedValueOnce(new DeliveryMarketplaceError("ifood", "unavailable", "fora do ar"));
    const [report] = await inbox.runCycle();
    expect(report).toMatchObject({ acknowledged: 1, deferred: 0, error: null });
    let record = (await repository.getOrder("ifood", id))!;
    expect(record).toMatchObject({ detailPending: true, needsReview: true, order: { status: "confirmed", totals: { orderCents: 4600 } } });
    expect(record.reviewReasons).toContain(ORDER_PATCHED_REASON);
    expect(deliverySaleBlockers(record)).toHaveLength(1);

    offset += DETAIL_RETRY_DELAY_SECONDS * 1000;
    await inbox.runCycle();
    expect(getOrder).toHaveBeenCalledTimes(2);
    record = (await repository.getOrder("ifood", id))!;
    expect(record).toMatchObject({ detailPending: false, order: { status: "confirmed", totals: { orderCents: 3800 } } });
    expect(record.order.items).toHaveLength(1);
    expect(record.reviewReasons).toContain(DETAIL_REFRESHED_REASON);
    expect(deliverySaleBlockers(record)).toEqual([]);
  });

  it("OPA de pedido cancelado não reabre nada", async () => {
    const { sandbox, repository, inbox, id } = await confirmedOrder();
    sandbox.emitFromMarketplace(id, "CAN");
    await inbox.runCycle();
    sandbox.patchOrder(id, [XIS]);
    await inbox.runCycle();
    const record = (await repository.getOrder("ifood", id))!;
    expect(record).toMatchObject({ detailPending: false, order: { status: "cancelled" } });
    expect(record.reviewReasons).not.toContain(ORDER_PATCHED_REASON);
  });

  it("repositório em memória: voltar a pendente zera o adiamento (busca logo); cancelado e pedido de mais de 7 dias saem da lista", async () => {
    let now = Date.parse("2026-11-14T12:00:00Z");
    const repository = new InMemoryDeliveryRepository({ now: () => new Date(now) });
    const order = await baseOrder();
    const save = async (record: DeliveryOrderRecord) => ({ ...record, version: await repository.saveOrder(record) });
    const fresh = (externalId: string): DeliveryOrderRecord => ({
      order: { ...order, externalId, createdAt: new Date(now).toISOString() },
      cancellationPending: false, cancellationRequest: null, detailPending: true, needsReview: false, reviewReasons: [],
      newOrderNotified: true, lastCancellationEventAt: null, lastEventAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
      dispute: null, version: 0,
    });
    let record = await save(fresh("o1"));
    await repository.deferDetail("ifood", "o1", 3600);
    record = await save({ ...record, detailPending: false });
    record = await save({ ...record, detailPending: true });
    expect((await repository.listDetailPending("ifood", 20)).map((r) => r.order.externalId)).toEqual(["o1"]);
    await save({ ...record, order: { ...record.order, status: "cancelled" } });
    expect(await repository.listDetailPending("ifood", 20)).toEqual([]);
    await save(fresh("o2"));
    expect((await repository.listDetailPending("ifood", 20)).map((r) => r.order.externalId)).toEqual(["o2"]);
    now += 8 * 24 * 3600_000;
    expect(await repository.listDetailPending("ifood", 20)).toEqual([]);
  });
});
