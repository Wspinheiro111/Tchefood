/**
 * Pagamentos da Point lidos do servidor e a conta reaberta pelo estorno (GPT r10, P1-01 e P1-02).
 *  - listPointPayments: tchefood_list_point_payments, em páginas (cursor), com período e busca;
 *  - closeRefundedOrder: tchefood_close_refunded_order, o gerente encerra a conta reaberta como venda devolvida.
 */
import { callRpc, defaultClaimDeps, type ClaimDeps } from './paymentClaim';

/** Uma linha de tchefood_list_point_payments, com os nomes do banco. */
export interface ServerPointPayment {
  payment_id: string;
  order_id: string;
  charge_id: string | null;
  idempotency_key: string;
  amount: number;
  method: string;
  nsu: string | null;
  authorization_code: string | null;
  status: string;
  created_at: string;
  refunded_at: string | null;
  refund_audit_id: string | null;
  refunded_by_manager_id: string | null;
}

export interface ListPointPaymentsInput {
  /** Período [from, to) em ISO; null = sem limite. */
  from: string | null;
  to: string | null;
  search: string | null;
  cursor: string | null;
  limit?: number;
}

export type ListPointPaymentsResult =
  | { kind: 'ok'; items: ServerPointPayment[]; nextCursor: string | null }
  | { kind: 'error'; error: string };

export const POINT_PAYMENTS_PAGE = 50;
const LIST_FAILED = 'Não foi possível ler os pagamentos da Point no servidor. Confira a internet e tente de novo.';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

function parseItem(v: unknown): ServerPointPayment | null {
  const r = (v ?? {}) as Record<string, unknown>;
  const amount = Number(r.amount);
  const paymentId = str(r.payment_id);
  const orderId = str(r.order_id);
  const key = str(r.idempotency_key);
  const createdAt = str(r.created_at);
  if (!paymentId || !orderId || !key || !createdAt || !Number.isFinite(amount) || amount <= 0) return null;
  return {
    payment_id: paymentId, order_id: orderId, charge_id: str(r.charge_id), idempotency_key: key, amount, method: str(r.method) ?? '',
    nsu: str(r.nsu), authorization_code: str(r.authorization_code), status: str(r.status) ?? '', created_at: createdAt,
    refunded_at: str(r.refunded_at), refund_audit_id: str(r.refund_audit_id), refunded_by_manager_id: str(r.refunded_by_manager_id),
  };}

export async function listPointPayments(input: ListPointPaymentsInput, deps: ClaimDeps = defaultClaimDeps()): Promise<ListPointPaymentsResult> {
  try {
    const cfg = await deps.config();
    if (!cfg) return { kind: 'error', error: 'Sem sessão da nuvem: conecte a loja para ver os pagamentos da Point do servidor.' };
    const out = await callRpc(cfg, 'tchefood_list_point_payments', {
      p_from: input.from, p_to: input.to, p_search: input.search?.trim() || null, p_cursor: input.cursor, p_limit: input.limit ?? POINT_PAYMENTS_PAGE,
    }, deps);
    if (out.kind !== 'ok' || !out.body) return { kind: 'error', error: LIST_FAILED };
    const items = out.body.items;
    if (!Array.isArray(items)) return { kind: 'error', error: LIST_FAILED };
    const parsed = items.map(parseItem);
    // Linha incompleta: a página inteira é recusada (nunca mostra pagamento pela metade).
    if (parsed.some((p) => p === null)) return { kind: 'error', error: LIST_FAILED };
    return { kind: 'ok', items: parsed as ServerPointPayment[], nextCursor: str(out.body.next_cursor) };
  } catch {
    return { kind: 'error', error: LIST_FAILED };
  }
}

export interface CloseRefundedInput {
  orderId: string;
  /** Quem está no caixa (p_staff). */
  staffId: string;
  managerPin: string;
  reason: string;
  /** Id gerado aqui (metadata.client_audit_id no servidor): repetir com o mesmo id não encerra nem grava de novo. */
  clientAuditId: string;
}

export type CloseRefundedResult =
  /** auditId: o registro ORDER_REFUNDED_WRITE_OFF do servidor; writtenOffCents: o valor baixado lá. */
  | { kind: 'closed'; auditId: string; managerId: string | null; writtenOffCents: number | null }
  | { kind: 'pin'; error: string }
  | { kind: 'refused'; error: string }
  /** Sem resposta conclusiva: pode ter fechado no servidor. Nada muda aqui; repetir com o mesmo id é seguro. */
  | { kind: 'unknown'; error: string };

export const CLOSE_REFUNDED_UNKNOWN = 'Sem resposta do servidor: não dá para saber se a conta foi encerrada. Nada mudou neste aparelho; tente de novo (repetir não encerra duas vezes).';

export async function closeRefundedOrder(input: CloseRefundedInput, deps: ClaimDeps = defaultClaimDeps()): Promise<CloseRefundedResult> {
  if (!/^\d{4,8}$/.test(input.managerPin)) return { kind: 'pin', error: 'Digite o PIN do gerente.' };
  if (input.reason.trim().length < 10) return { kind: 'refused', error: 'Informe o motivo (mínimo 10 caracteres).' };
  let sent = false;
  try {
    const cfg = await deps.config();
    if (!cfg) return { kind: 'refused', error: 'Sem sessão da nuvem. Conecte a loja e tente de novo; nada foi alterado.' };
    sent = true;
    const out = await callRpc(cfg, 'tchefood_close_refunded_order', {
      p_order: input.orderId, p_staff: input.staffId, p_manager_pin: input.managerPin, p_reason: input.reason.trim().slice(0, 500), p_client_audit_id: input.clientAuditId,
    }, deps);
    if (out.kind === 'offline') return { kind: 'unknown', error: CLOSE_REFUNDED_UNKNOWN };
    if (out.kind === 'refused') {
      return { kind: 'refused', error: `O servidor não encerrou a conta${out.code ? ` (código ${out.code})` : ''}. Nada foi alterado.` };
    }
    // PIN errado ou bloqueado: o banco devolve null (como nas outras funções com PIN de gerente).
    if (out.text.trim() === 'null') return { kind: 'pin', error: 'PIN de gerente incorreto ou bloqueado. Nada foi alterado.' };
    // {audit_id, order_id, status: 'CLOSED', written_off_cents}: outra conta, outro status ou sem o registro não prova nada.
    const body = out.body;
    const auditId = body ? str(body.audit_id) : null;
    const cents = body ? Number(body.written_off_cents) : NaN;
    if (!body || !auditId || !UUID_RE.test(auditId) || body.status !== 'CLOSED' || body.order_id !== input.orderId) {
      return { kind: 'unknown', error: CLOSE_REFUNDED_UNKNOWN };
    }
    const managerId = str(body.manager_id);
    return {
      kind: 'closed', auditId, managerId: managerId && UUID_RE.test(managerId) ? managerId : null,
      writtenOffCents: Number.isInteger(cents) && cents > 0 ? cents : null,
    };
  } catch {
    return sent ? { kind: 'unknown', error: CLOSE_REFUNDED_UNKNOWN } : { kind: 'refused', error: 'Sem sessão da nuvem. Conecte a loja e tente de novo; nada foi alterado.' };
  }
}
