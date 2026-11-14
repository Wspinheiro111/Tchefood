/**
 * Conferência no Mercado Pago de uma cobrança da Point em revisão (ação `reconcile` da função point-charge;
 * docs/integracoes/r6-spec.md B2/C2). O PIN de gerente e o motivo só PEDEM a conferência e ficam registrados:
 * quem decide é a leitura do Mercado Pago feita pelo servidor. Sem resposta conclusiva, continua em revisão.
 */
import type { SyncConfig } from '../sync/supabaseSync';
import { parseChargeReply, pointChargeEndpoint, type ChargeReply, type PointFetch } from './mercadoPagoPointDriver';

/** Motivo mínimo que o servidor aceita na conferência (B2). */
export const RECONCILE_MIN_REASON = 10;
export const RECONCILE_TIMEOUT_MS = 30_000;

export interface ReconcileInput {
  idempotency_key: string;
  staff_id: string;
  manager_pin: string;
  reason_text: string;
  /** ID da operação no comprovante / app do Mercado Pago (opcional). */
  operation_id?: string;
}

export type ReconcileOutcome =
  | { kind: 'reply'; reply: Exclude<ChargeReply, { status: 'PENDING' }> }
  /** PIN de gerente recusado (403). */
  | { kind: 'pin'; error: string }
  | { kind: 'error'; error: string };

export interface ReconcileDeps {
  config: () => Promise<SyncConfig | null>;
  fetch: PointFetch;
  timer: (ms: number) => Promise<void>;
}

export function defaultReconcileDeps(): ReconcileDeps {
  return {
    config: async () => (await import('../sync/useCloudSync')).freshCloudConfig(),
    fetch: (url, init) => fetch(url, init),
    timer: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

const NO_ANSWER = 'Sem resposta do servidor. A cobrança continua em revisão e o valor segue reservado; tente de novo.';

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function reconcilePointCharge(input: ReconcileInput, deps: ReconcileDeps = defaultReconcileDeps()): Promise<ReconcileOutcome> {
  if (!/^\d{4,8}$/.test(input.manager_pin)) return { kind: 'pin', error: 'Digite o PIN do gerente.' };
  if (input.reason_text.trim().length < RECONCILE_MIN_REASON) return { kind: 'error', error: `Informe o motivo (mínimo ${RECONCILE_MIN_REASON} caracteres).` };
  const operation = input.operation_id?.trim() ?? '';
  const body: Record<string, unknown> = {
    action: 'reconcile',
    idempotency_key: input.idempotency_key,
    staff_id: input.staff_id,
    manager_pin: input.manager_pin,
    reason_text: input.reason_text.trim(),
    ...(operation ? { operation_id: operation } : {}),
  };
  const deadline = deps.timer(RECONCILE_TIMEOUT_MS).then(() => null);
  try {
    const cfg = await Promise.race([deps.config().catch(() => null), deadline]);
    if (!cfg) return { kind: 'error', error: 'Sem sessão da nuvem. Conecte a loja e tente de novo; a cobrança continua em revisão.' };
    const endpoint = pointChargeEndpoint(cfg);
    const out = await Promise.race([
      (async () => {
        const res = await deps.fetch(endpoint.url, { method: 'POST', headers: endpoint.headers, body: JSON.stringify(body) });
        return { status: res.status, text: await res.text() };
      })(),
      deadline,
    ]);
    if (!out) return { kind: 'error', error: NO_ANSWER };
    if (out.status === 200) {
      const reply = parseChargeReply(out.text);
      if (!reply || reply.status === 'PENDING') return { kind: 'error', error: 'O servidor não trouxe uma resposta conclusiva. A cobrança continua em revisão.' };
      return { kind: 'reply', reply };
    }
    const err = parseObject(out.text);
    const message = err && typeof err.message === 'string' ? err.message : null;
    if (out.status === 403) return { kind: 'pin', error: message ?? 'PIN de gerente incorreto ou bloqueado. Nada mudou.' };
    if (out.status === 409) return { kind: 'error', error: message ?? 'Esta cobrança não está em revisão: não há o que conferir.' };
    if (out.status === 400) return { kind: 'error', error: message ?? 'Pedido de conferência inválido.' };
    return { kind: 'error', error: NO_ANSWER };
  } catch {
    return { kind: 'error', error: NO_ANSWER };
  }
}
