/**
 * Pagamentos da Point lidos do servidor e a conta reaberta pelo estorno (GPT r10, P1-01 e P1-02).
 *  - listPointPayments: tchefood_list_point_payments, em páginas (cursor), com período e busca;
 *  - listPointRefunds: tchefood_list_point_refunds, os estornos pela data do estorno;
 *  - closeRefundedOrder: tchefood_close_refunded_order, o gerente encerra a conta reaberta como venda devolvida;
 *  - getOrderSnapshot: tchefood_order_snapshot, o estado oficial de uma conta (GPT r12 P1-02/P1-03);
 *  - listRefundReopenedOrders: tchefood_list_refund_reopened_orders, as contas reabertas por estorno da loja.
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

async function listRpc(fn: string, body: Record<string, unknown>, deps: ClaimDeps): Promise<ListPointPaymentsResult> {
  try {
    const cfg = await deps.config();
    if (!cfg) return { kind: 'error', error: 'Sem sessão da nuvem: conecte a loja para ver os pagamentos da Point do servidor.' };
    const out = await callRpc(cfg, fn, body, deps);
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

export async function listPointPayments(input: ListPointPaymentsInput, deps: ClaimDeps = defaultClaimDeps()): Promise<ListPointPaymentsResult> {
  return listRpc('tchefood_list_point_payments', {
    p_from: input.from, p_to: input.to, p_search: input.search?.trim() || null, p_cursor: input.cursor, p_limit: input.limit ?? POINT_PAYMENTS_PAGE,
  }, deps);
}

export interface ListPointRefundsInput {
  /** Período [from, to) da data do estorno no servidor, em ISO; null = sem limite. */
  from: string | null;
  to: string | null;
  cursor: string | null;
  limit?: number;
}

/** tchefood_list_point_refunds: estornos da Point pela data do estorno (qualquer idade da venda). */
export async function listPointRefunds(input: ListPointRefundsInput, deps: ClaimDeps = defaultClaimDeps()): Promise<ListPointPaymentsResult> {
  const r = await listRpc('tchefood_list_point_refunds', { p_from: input.from, p_to: input.to, p_cursor: input.cursor, p_limit: input.limit ?? 200 }, deps);
  // Linha de estorno sem a data do estorno não prova nada: recusa a página.
  if (r.kind === 'ok' && r.items.some((i) => i.refunded_at === null)) return { kind: 'error', error: LIST_FAILED };
  return r;
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
  | {
    kind: 'closed'; auditId: string; managerId: string | null; writtenOffCents: number | null;
    /** GPT r12 P2-02: o total já baixado na conta (esta baixa e as anteriores). */
    cumulativeWrittenOffCents?: number | null;
    /** Decisão do Will (15/11): a hora do primeiro fechamento da conta (o turno da venda original), do servidor. */
    closedAt?: string | null;
  }
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
    const cumulative = Number(body.cumulative_written_off_cents);
    const closedAt = str(body.closed_at);
    return {
      kind: 'closed', auditId, managerId: managerId && UUID_RE.test(managerId) ? managerId : null,
      // GPT r14 P1-02: a diferença pode ser zero ou negativa (o cliente pagou parte do que tinha sido baixado).
      writtenOffCents: Number.isInteger(cents) ? cents : null,
      cumulativeWrittenOffCents: Number.isInteger(cumulative) && cumulative >= 0 ? cumulative : null,
      closedAt: closedAt && Number.isFinite(Date.parse(closedAt)) ? closedAt : null,
    };
  } catch {
    return sent ? { kind: 'unknown', error: CLOSE_REFUNDED_UNKNOWN } : { kind: 'refused', error: 'Sem sessão da nuvem. Conecte a loja e tente de novo; nada foi alterado.' };
  }
}

/** Estado oficial de uma conta no servidor (tchefood_order_snapshot), com os nomes do banco. */
export interface ServerOrderSnapshot {
  order: Record<string, unknown>;
  items: Record<string, unknown>[];
  payments: Record<string, unknown>[];
  audits: Record<string, unknown>[];
}

export type OrderSnapshotResult =
  | { kind: 'ok'; snapshot: ServerOrderSnapshot }
  /** A conta não existe no servidor (ou é de outra loja). */
  | { kind: 'missing' }
  | { kind: 'error'; error: string };

const SNAPSHOT_FAILED = 'Não foi possível ler a conta no servidor. Confira a internet e tente de novo.';
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

export async function getOrderSnapshot(orderId: string, deps: ClaimDeps = defaultClaimDeps()): Promise<OrderSnapshotResult> {
  try {
    const cfg = await deps.config();
    if (!cfg) return { kind: 'error', error: 'Sem sessão da nuvem: conecte a loja para ler a conta no servidor.' };
    const out = await callRpc(cfg, 'tchefood_order_snapshot', { p_order: orderId }, deps);
    if (out.kind !== 'ok') return { kind: 'error', error: SNAPSHOT_FAILED };
    if (out.text.trim() === 'null') return { kind: 'missing' };
    const b = out.body;
    if (!b || !isRecord(b.order) || b.order.id !== orderId || !Array.isArray(b.items) || !Array.isArray(b.payments) || !Array.isArray(b.audits)) {
      return { kind: 'error', error: SNAPSHOT_FAILED };
    }
    if (![b.items, b.payments, b.audits].every((list) => (list as unknown[]).every((r) => isRecord(r) && typeof r.id === 'string'))) {
      return { kind: 'error', error: SNAPSHOT_FAILED };
    }
    // Linha de outra conta não prova nada sobre esta.
    if ((b.items as Record<string, unknown>[]).some((r) => r.order_id !== orderId) || (b.payments as Record<string, unknown>[]).some((r) => r.order_id !== orderId)) {
      return { kind: 'error', error: SNAPSHOT_FAILED };
    }
    return { kind: 'ok', snapshot: { order: b.order, items: b.items as Record<string, unknown>[], payments: b.payments as Record<string, unknown>[], audits: b.audits as Record<string, unknown>[] } };
  } catch {
    return { kind: 'error', error: SNAPSHOT_FAILED };
  }
}

/** Uma conta reaberta por estorno no servidor (tchefood_list_refund_reopened_orders). */
export interface ServerReopenedOrder {
  order_id: string;
  table_id: string | null;
  remaining_balance: number;
  total_amount: number;
  refunded_at: string;
}

export type ReopenedOrdersResult = { kind: 'ok'; items: ServerReopenedOrder[] } | { kind: 'error'; error: string };

export async function listRefundReopenedOrders(deps: ClaimDeps = defaultClaimDeps()): Promise<ReopenedOrdersResult> {
  const failed = { kind: 'error' as const, error: 'Não foi possível ler as contas reabertas no servidor.' };
  try {
    const cfg = await deps.config();
    if (!cfg) return failed;
    const out = await callRpc(cfg, 'tchefood_list_refund_reopened_orders', {}, deps);
    if (out.kind !== 'ok') return failed;
    const list: unknown = JSON.parse(out.text);
    if (!Array.isArray(list)) return failed;
    const items: ServerReopenedOrder[] = [];
    for (const v of list) {
      const r = isRecord(v) ? v : {};
      const orderId = str(r.order_id);
      const refundedAt = str(r.refunded_at);
      const balance = Number(r.remaining_balance);
      if (!orderId || !UUID_RE.test(orderId) || !refundedAt || !Number.isFinite(balance) || balance <= 0) return failed;
      items.push({ order_id: orderId, table_id: str(r.table_id), remaining_balance: balance, total_amount: Number(r.total_amount) || 0, refunded_at: refundedAt });
    }
    return { kind: 'ok', items };
  } catch {
    return failed;
  }
}
