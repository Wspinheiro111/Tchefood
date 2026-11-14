import { describe, expect, it } from "vitest";
import type { DeliveryOrderRecord } from "./deliveryInbox";
import { deliverySaleBlockers, deliverySaleWarnings, type DeliverySaleGuardInput } from "./deliverySaleGuard";

// O registro gravado pelo servidor serve direto na guarda (confere no typecheck).
const registroServe: DeliveryOrderRecord extends DeliverySaleGuardInput ? true : never = true;

function record(overrides: Partial<DeliverySaleGuardInput> & { isTest?: boolean; status?: string } = {}): DeliverySaleGuardInput {
  const { isTest = false, status = "confirmed", ...rest } = overrides;
  return { order: { isTest, status }, needsReview: false, cancellationPending: false, ...rest };
}

describe("guarda de venda do pedido de delivery (item 5)", () => {
  it("pedido normal, confirmado e sem pendência pode virar venda", () => {
    expect(registroServe).toBe(true);
    expect(deliverySaleBlockers(record())).toEqual([]);
    expect(deliverySaleWarnings(record())).toEqual([]);
  });

  it("pedido de teste do app não vira venda", () => {
    expect(deliverySaleBlockers(record({ isTest: true }))).toEqual([expect.stringContaining("teste")]);
  });

  it("pedido gravado sem o detalhe do app não vira venda", () => {
    expect(deliverySaleBlockers(record({ detailPending: true }))).toEqual([expect.stringContaining("detalhe")]);
  });

  it("registro sem o campo detailPending (antes da rodada 3) não bloqueia por isso", () => {
    const { detailPending: _ignored, ...semCampo } = record({ detailPending: true });
    expect(deliverySaleBlockers(semCampo)).toEqual([]);
  });

  it("pedido cancelado não vira venda", () => {
    expect(deliverySaleBlockers(record({ status: "cancelled" }))).toEqual([expect.stringContaining("cancelado")]);
  });

  it("pedido com cancelamento em análise no app não vira venda", () => {
    expect(deliverySaleBlockers(record({ cancellationPending: true }))).toEqual([expect.stringContaining("cancelamento")]);
  });

  it("junta todos os motivos, na ordem: teste, detalhe, cancelado, cancelamento pendente", () => {
    const motivos = deliverySaleBlockers(record({ isTest: true, detailPending: true, status: "cancelled", cancellationPending: true }));
    expect(motivos).toHaveLength(4);
    expect(motivos[0]).toContain("teste");
    expect(motivos[1]).toContain("detalhe");
    expect(motivos[2]).toContain("cancelado");
    expect(motivos[3]).toContain("cancelamento");
  });

  it("needsReview sozinho não bloqueia: vira aviso", () => {
    const r = record({ needsReview: true });
    expect(deliverySaleBlockers(r)).toEqual([]);
    expect(deliverySaleWarnings(r)).toEqual([expect.stringContaining("conferência")]);
  });
});
