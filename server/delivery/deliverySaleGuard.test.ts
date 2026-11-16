import { describe, expect, it } from "vitest";
import type { DeliveryOrderRecord } from "./deliveryInbox";
import { deliverySaleBlockers, deliverySaleWarnings, type DeliverySaleGuardInput } from "./deliverySaleGuard";

// O registro gravado pelo servidor serve direto na guarda (confere no typecheck).
const registroServe: DeliveryOrderRecord extends DeliverySaleGuardInput ? true : never = true;

function record(overrides: Partial<DeliverySaleGuardInput> & { isTest?: boolean; status?: string } = {}): DeliverySaleGuardInput {
  const { isTest = false, status = "confirmed", ...rest } = overrides;
  return { order: { isTest, status }, needsReview: false, cancellationPending: false, cancellationRequest: null, dispute: null, ...rest };
}

type Dispute = NonNullable<DeliverySaleGuardInput["dispute"]>;
function dispute(overrides: Partial<Dispute> = {}): Dispute {
  return { handshakeType: "PREPARATION_TIME", respondedAt: null, response: null, ...overrides };
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

  // Rodada 3 do GPT: a reserva do cancelamento da loja em andamento ou incerta liberava a venda (cancellationPending
  // só vira true com o evento do app).
  it.each(["sending", "uncertain", "sent"] as const)("cancelamento pedido pela loja (%s) não vira venda", (state) => {
    const r = record({ cancellationRequest: { state } });
    expect(deliverySaleBlockers(r)).toEqual([expect.stringContaining("cancelamento")]);
  });

  it("negociação aberta sem resposta não vira venda", () => {
    expect(deliverySaleBlockers(record({ dispute: dispute() }))).toEqual([expect.stringContaining("egociação")]);
  });

  it.each(["sending", "uncertain"] as const)("negociação com resposta %s (sem confirmação) não vira venda", (state) => {
    const r = record({ dispute: dispute({ response: { decision: { kind: "reject" }, state } }) });
    expect(deliverySaleBlockers(r)).toEqual([expect.stringContaining("egociação")]);
  });

  it("negociação com aceite ou proposta confirmados continua bloqueando (o cancelamento ou a decisão do cliente vem)", () => {
    for (const kind of ["accept", "alternative"] as const) {
      const r = record({ dispute: dispute({ respondedAt: "2026-11-14T10:00:00.000Z", response: { decision: { kind }, state: "sent" } }) });
      expect(deliverySaleBlockers(r)).toEqual([expect.stringContaining("egociação")]);
    }
  });

  it("negociação respondida por fora (Portal), sem saber a resposta, continua bloqueando", () => {
    const r = record({ dispute: dispute({ respondedAt: "2026-11-14T10:00:00.000Z", response: null }) });
    expect(deliverySaleBlockers(r)).toEqual([expect.stringContaining("egociação")]);
  });

  it("negociação com recusa confirmada pelo app não bloqueia: vira aviso até o app fechar", () => {
    const r = record({ dispute: dispute({ respondedAt: "2026-11-14T10:00:00.000Z", response: { decision: { kind: "reject" }, state: "sent" } }) });
    expect(deliverySaleBlockers(r)).toEqual([]);
    expect(deliverySaleWarnings(r)).toEqual([expect.stringContaining("egociação")]);
  });

  it("negociação depois da entrega (AFTER_DELIVERY) de pedido concluído é aviso, não bloqueio", () => {
    const r = record({ status: "concluded", dispute: dispute({ handshakeType: "AFTER_DELIVERY" }) });
    expect(deliverySaleBlockers(r)).toEqual([]);
    expect(deliverySaleWarnings(r)).toEqual([expect.stringContaining("entrega")]);
  });

  it("negociação AFTER_DELIVERY de pedido ainda não concluído bloqueia", () => {
    const r = record({ status: "dispatched", dispute: dispute({ handshakeType: "AFTER_DELIVERY" }) });
    expect(deliverySaleBlockers(r)).toEqual([expect.stringContaining("egociação")]);
  });
});
