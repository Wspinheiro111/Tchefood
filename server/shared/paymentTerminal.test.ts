import { describe, expect, it } from "vitest";
import {
  PAYMENT_TERMINAL_METHODS,
  PAYMENT_TERMINAL_PROVIDERS,
  centsToDecimalString,
  decimalStringToCents,
  getPaymentTerminalIntegrationMode,
  isValidExternalReference,
  normalizePaymentTerminalStatus,
} from "./paymentTerminal";

describe("paymentTerminal helpers", () => {
  it("declara Mercado Pago, Vero, Cielo, Stone e Pix Banrisul remotos e PagBank embarcado no mesmo domínio", () => {
    expect(PAYMENT_TERMINAL_PROVIDERS).toEqual(["mercado_pago_point", "vero_cliente_pdv", "cielo_smart", "pagbank_smartpos", "stone_connect", "banrisul_pix"]);
    expect(getPaymentTerminalIntegrationMode("banrisul_pix")).toBe("remote_order");
    expect(PAYMENT_TERMINAL_METHODS).toEqual(["credit", "debit", "pix"]);
    expect(getPaymentTerminalIntegrationMode("mercado_pago_point")).toBe("remote_order");
    expect(getPaymentTerminalIntegrationMode("vero_cliente_pdv")).toBe("remote_order");
    expect(getPaymentTerminalIntegrationMode("cielo_smart")).toBe("remote_order");
    expect(getPaymentTerminalIntegrationMode("stone_connect")).toBe("remote_order");
    expect(getPaymentTerminalIntegrationMode("pagbank_smartpos")).toBe("embedded_sdk");
  });

  it("converte centavos em string decimal com 2 casas", () => {
    expect(centsToDecimalString(5000)).toBe("50.00");
    expect(centsToDecimalString(5)).toBe("0.05");
    expect(centsToDecimalString(12345)).toBe("123.45");
    expect(() => centsToDecimalString(0)).toThrow();
    expect(() => centsToDecimalString(10.5)).toThrow();
  });

  it("converte string decimal em centavos e recusa formatos ambíguos", () => {
    expect(decimalStringToCents("24.50")).toBe(2450);
    expect(decimalStringToCents("24")).toBe(2400);
    expect(decimalStringToCents("0.5")).toBe(50);
    expect(decimalStringToCents("24,50")).toBeNull();
    expect(decimalStringToCents("1e3")).toBeNull();
    expect(decimalStringToCents("-1.00")).toBeNull();
    expect(decimalStringToCents("1.234")).toBeNull();
    expect(decimalStringToCents(10)).toBeNull();
  });

  it("valida external_reference", () => {
    expect(isValidExternalReference("sale_1-abc")).toBe(true);
    expect(isValidExternalReference("")).toBe(false);
    expect(isValidExternalReference("a".repeat(65))).toBe(false);
    expect(isValidExternalReference("com espaço")).toBe(false);
  });

  it("só aprova processed/accredited; tudo desconhecido vai para revisão manual", () => {
    const n = (s: string | null, d?: string | null, source: "order" | "transaction" = "order") =>
      normalizePaymentTerminalStatus("mercado_pago_point", s, d, source).status;
    expect(n("processed", "accredited")).toBe("manual_review");
    expect(n("processed", "processed")).toBe("approved");
    expect(n("processed", "accredited", "transaction")).toBe("approved");
    expect(n("processed", "processed", "transaction")).toBe("manual_review");
    expect(n("processed", "partially_refunded")).toBe("manual_review");
    expect(n("processed", null)).toBe("manual_review");
    expect(n("created")).toBe("pending");
    expect(n("at_terminal")).toBe("at_terminal");
    expect(n("failed", "rejected_by_issuer", "transaction")).toBe("rejected");
    expect(n("failed", "failed")).toBe("rejected");
    expect(n("failed", "novo_detail", "transaction")).toBe("manual_review");
    expect(n("failed", "rejected")).toBe("manual_review");
    expect(n("canceled", "novo_detail", "transaction")).toBe("manual_review");
    expect(n("canceled", "canceled_on_terminal", "transaction")).toBe("cancelled");
    expect(n("canceled", "canceled_by_api", "transaction")).toBe("cancelled");
    expect(n("canceled", "canceled", "order")).toBe("cancelled");
    expect(n("canceled", "canceled_by_api", "order")).toBe("manual_review");
    expect(n("canceled", "canceled_on_terminal", "order")).toBe("manual_review");
    expect(n("cancelled", "canceled", "order")).toBe("manual_review");
    expect(n("cancelled", "canceled", "transaction")).toBe("manual_review");
    expect(n("expired", "xyz", "transaction")).toBe("manual_review");
    expect(n("refunded", "desconhecido", "transaction")).toBe("manual_review");
    expect(n("failed", "in_review")).toBe("manual_review");
    expect(n("failed", null)).toBe("manual_review");
    expect(n("failed", "")).toBe("manual_review");
    expect(n("canceled", null)).toBe("manual_review");
    expect(n("expired", null)).toBe("manual_review");
    expect(n("refunded", null)).toBe("manual_review");
    expect(n("expired", "expired")).toBe("expired");
    expect(n("refunded", "refunded")).toBe("refunded");
    expect(n("action_required")).toBe("manual_review");
    expect(n("algo_novo")).toBe("manual_review");
    expect(n(null)).toBe("manual_review");
  });

  it("nunca interpreta status do provider embarcado como status cloud do Mercado Pago", () => {
    expect(normalizePaymentTerminalStatus("pagbank_smartpos", "processed", "accredited", "transaction").status).toBe("manual_review");
  });
});
