import { describe, expect, it, vi } from "vitest";
import { DeliveryInbox, InMemoryDeliveryRepository, type DeliveryOrderRecord } from "./deliveryInbox";
import { IfoodMerchantApi } from "./ifood/ifoodMerchantApi";
import { IfoodSandbox } from "./ifood/ifoodSandbox";
import { allowedDeliveryActions, mergeDeliveryStatus } from "./marketplace";

function setup(options: { onNewOrder?: (record: DeliveryOrderRecord) => void | Promise<void> } = {}) {
  const sandbox = new IfoodSandbox();
  const api = new IfoodMerchantApi({
    credentials: { clientId: sandbox.clientId, clientSecret: sandbox.clientSecret },
    merchantIds: [sandbox.merchantId],
    baseUrl: sandbox.baseUrl,
    fetchImpl: sandbox.fetch,
  });
  const repository = new InMemoryDeliveryRepository();
  const inbox = new DeliveryInbox({ adapters: [api], repository, onNewOrder: options.onNewOrder });
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

  it("app fora do ar não derruba o ciclo", async () => {
    const { sandbox, inbox } = setup();
    sandbox.failNext("events:polling", 500);
    const [report] = await inbox.runCycle();
    expect(report.error).toMatch(/500/);
    expect(report.acknowledged).toBe(0);
  });
});
