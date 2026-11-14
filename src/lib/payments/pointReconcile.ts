/**
 * Conferência no Mercado Pago de uma cobrança da Point em revisão (ação `reconcile` da função point-charge;
 * docs/integracoes/r6-spec.md B2/C2). O PIN de gerente e o motivo só PEDEM a conferência e ficam registrados:
 * quem decide é a leitura do Mercado Pago feita pelo servidor. Sem resposta conclusiva, continua em revisão.
 */
import type { SyncConfig } from '../sync/supabaseSync';
import { parseChargeReply, pointChargeEndpoint, type ChargeReply, type PointFetch } from './mercadoPagoPointDriver';
import { fetchPointReservation } from '../sync/cloudPull';

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
  /** refunded: DECLINED com code REFUNDED (o Mercado Pago provou o estorno: houve cobrança e o dinheiro voltou). */
  | { kind: 'reply'; reply: Exclude<ChargeReply, { status: 'PENDING' }>; refunded?: true }
  /** PIN de gerente recusado (403). */
  | { kind: 'pin'; error: string }
  /**
   * notApplicable: o servidor disse que a cobrança não tem o que conferir (409 not_applicable: já terminou, ou aprovada
   * com o pagamento registrado). Quem chama lê o estado gravado (readPointChargeStatus) antes de decidir a trava.
   */
  | { kind: 'error'; error: string; notApplicable?: true };

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
      if (reply.status === 'DECLINED' && parseObject(out.text)?.code === 'REFUNDED') return { kind: 'reply', reply, refunded: true };
      return { kind: 'reply', reply };
    }
    const err = parseObject(out.text);
    const message = err && typeof err.message === 'string' ? err.message : null;
    if (out.status === 403) return { kind: 'pin', error: message ?? 'PIN de gerente incorreto ou bloqueado. Nada mudou.' };
    if (out.status === 409) {
      const error = message ?? 'Esta cobrança não está em revisão: não há o que conferir.';
      return err?.error === 'not_applicable' ? { kind: 'error', error, notApplicable: true } : { kind: 'error', error };
    }
    if (out.status === 400) return { kind: 'error', error: message ?? 'Pedido de conferência inválido.' };
    return { kind: 'error', error: NO_ANSWER };
  } catch {
    return { kind: 'error', error: NO_ANSWER };
  }
}

export type StatusOutcome = { kind: 'reply'; reply: ChargeReply } | { kind: 'error'; error: string };

/**
 * Estado gravado da cobrança no servidor (ação `status`, a mesma consulta do aparelho que cobra; cobrança final não é
 * reconsultada no Mercado Pago). Usado depois de um 409 not_applicable da conferência (revisão PR #49, P2): só a
 * resposta do servidor sobre ESTA chave decide se a trava local sai.
 */
export async function readPointChargeStatus(idempotencyKey: string, deps: ReconcileDeps = defaultReconcileDeps()): Promise<StatusOutcome> {
  const fail = { kind: 'error', error: 'Não foi possível ler esta cobrança no servidor. A trava continua; tente de novo.' } as const;
  const deadline = deps.timer(RECONCILE_TIMEOUT_MS).then(() => null);
  try {
    const cfg = await Promise.race([deps.config().catch(() => null), deadline]);
    if (!cfg) return { kind: 'error', error: 'Sem sessão da nuvem. Conecte a loja e tente de novo; a trava continua.' };
    const endpoint = pointChargeEndpoint(cfg);
    const out = await Promise.race([
      (async () => {
        const res = await deps.fetch(endpoint.url, { method: 'POST', headers: endpoint.headers, body: JSON.stringify({ action: 'status', idempotency_key: idempotencyKey }) });
        return { status: res.status, text: await res.text() };
      })(),
      deadline,
    ]);
    if (!out || out.status !== 200) return fail;
    const reply = parseChargeReply(out.text);
    return reply ? { kind: 'reply', reply } : fail;
  } catch {
    return fail;
  }
}

/**
 * Pagamento da cobrança no servidor (tchefood_point_reservation da conta), lido logo antes de registrar uma aprovação
 * da Point neste aparelho (auditoria interna 3, P1-02: dois aparelhos registrando o mesmo pagamento = duas NFC-e).
 *  - not_registered: a cobrança aparece aprovada e sem pagamento (pode registrar);
 *  - not_reserving: a cobrança não reserva mais nesta conta (aprovada com o pagamento já registrado no servidor);
 *  - other: aparece em outro estado (mudou no meio);
 *  - error: sem leitura (não registra).
 */
export type ServerPaymentState = { kind: 'not_registered' } | { kind: 'not_reserving' } | { kind: 'other'; status: string } | { kind: 'error'; error: string };

export async function pointPaymentOnServer(orderId: string, idempotencyKey: string, deps: ReconcileDeps = defaultReconcileDeps()): Promise<ServerPaymentState> {
  const fail = { kind: 'error', error: 'Não foi possível confirmar no servidor se este pagamento já foi registrado. Nada foi registrado e a trava continua; tente de novo.' } as const;
  const deadline = deps.timer(RECONCILE_TIMEOUT_MS).then(() => null);
  try {
    const cfg = await Promise.race([deps.config().catch(() => null), deadline]);
    if (!cfg) return fail;
    const r = await Promise.race([fetchPointReservation(cfg, async (url, init) => {
      const res = await deps.fetch(url, { method: init.method, headers: init.headers, body: init.body ?? '', ...(init.signal ? { signal: init.signal } : {}) });
      return { ok: res.status >= 200 && res.status < 300, status: res.status, text: () => res.text() };
    }, orderId), deadline]);
    if (!r) return fail;
    // Banco anterior (sem a lista de cobranças): não dá para provar nada.
    if (!r.charges) return fail;
    const c = r.charges.find((x) => x.idempotencyKey === idempotencyKey);
    if (!c) return { kind: 'not_reserving' };
    if (c.hasPayment) return { kind: 'not_reserving' };
    if (c.status === 'approved') return { kind: 'not_registered' };
    return { kind: 'other', status: c.status };
  } catch {
    return fail;
  }
}
