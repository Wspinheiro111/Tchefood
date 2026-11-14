// supabase/functions/point-charge/mpPayments.ts
//
// Leitura do pagamento do Mercado Pago (GET /v1/payments/{id}) para o comprovante da Point:
// código de autorização, bandeira, final do cartão e a confirmação de status e valor.
// Só leitura; qualquer resposta fora do formato esperado é erro (a cobrança fica sem aprovar).
import type { PaymentDetailsSource, PointPaymentDetails } from './charge.ts';

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null;
}

function asText(value: unknown): string | null {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return null;
}

/** transaction_amount vem como número (ex.: 24.5). Só aceita valores com até 2 casas exatas. */
export function amountToCents(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const cents = Math.round(value * 100);
  if (Math.abs(cents - value * 100) > 1e-6 || !Number.isSafeInteger(cents)) return null;
  return cents;
}

// Em GET /v1/payments/{id}, "order" costuma ser a merchant_order ({ id: <número>, type: "mercadopago" }), que não é
// a ordem da Orders API (ORD…). Só um id da Orders API serve para conferir contra a cobrança; qualquer outro conta
// como ausente.
function ordersApiId(value: unknown): string | null {
  return typeof value === 'string' && /^ORD[0-9A-Za-z]+$/.test(value) ? value : null;
}

export function parsePayment(body: unknown): PointPaymentDetails {
  const p = asObject(body);
  const id = asText(p?.id);
  if (!p || !id) throw new Error('mercado_pago_payment_malformed');
  const installments = p.installments;
  return {
    id,
    status: asText(p.status),
    amountCents: amountToCents(p.transaction_amount),
    paymentMethodId: asText(p.payment_method_id),
    paymentTypeId: asText(p.payment_type_id),
    authorizationCode: asText(p.authorization_code),
    lastFour: asText(asObject(p.card)?.last_four_digits),
    installments: typeof installments === 'number' && Number.isInteger(installments) && installments >= 1 ? installments : null,
    // Só para conferir contra a cobrança (nunca usados sem conferência): referência enviada e ordem do pagamento.
    externalReference: asText(p.external_reference),
    orderId: ordersApiId(asObject(p.order)?.id),
  };
}

export function createMercadoPagoPayments(options: { accessToken: string; fetchImpl: FetchLike; baseUrl?: string; timeoutMs?: number }): PaymentDetailsSource {
  const base = (options.baseUrl ?? 'https://api.mercadopago.com').replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 15_000;
  return {
    async getPayment(paymentId: string): Promise<PointPaymentDetails> {
      if (!/^\d{1,20}$/.test(paymentId)) throw new Error('mercado_pago_payment_id_invalid');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await options.fetchImpl(`${base}/v1/payments/${paymentId}`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${options.accessToken}`, Accept: 'application/json' },
          signal: controller.signal,
        });
        const text = await res.text();
        if (res.status < 200 || res.status >= 300) throw new Error(`mercado_pago_payment_http_${res.status}`);
        return parsePayment(JSON.parse(text));
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
