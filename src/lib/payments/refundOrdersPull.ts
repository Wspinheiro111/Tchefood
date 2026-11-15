/**
 * Contas mexidas por estorno da Point em outro aparelho: este aparelho traz o estado oficial do servidor.
 *  - GPT r12 (P1-02): contas reabertas pelo estorno que ainda devem (lista do servidor).
 *  - GPT r15 (P1-01): contas estornadas ou encerradas como venda devolvida desde a última leitura, em qualquer status
 *    (estorno e encerramento feitos em outro aparelho entre duas leituras daqui, ou com este aparelho fechado).
 * Roda no laço da nuvem (a cada minuto e ao abrir o app) e na tela da conciliação.
 */
import { useTcheStore } from '../../store/useTcheStore';
import { toCents } from '../money';
import { defaultClaimDeps, type ClaimDeps } from './paymentClaim';
import { getOrderSnapshot, listRefundOrderChanges, listRefundReopenedOrders, type ServerReopenedOrder } from './pointPaymentsServer';
import type { AuditLog, Order, Payment } from '../../types';

/** Conta reaberta pelo estorno da Point: fechada antes (registro do estorno com order_reopened), com pagamento da Point estornado e saldo. */
export function isRefundReopenedOrder(order: Order, payments: readonly Payment[], logs: readonly AuditLog[] = []): boolean {
  if (order.status === 'CLOSED' || order.status === 'CANCELED' || toCents(order.remaining_balance) <= 0) return false;
  if (!payments.some((p) => p.order_id === order.id && p.acquirer === 'MERCADO_PAGO' && p.status === 'REFUNDED')) return false;
  // GPT r12 (P1-01): a conta é identificada pelo estado financeiro e pelo registro do estorno que a reabriu
  // (POINT_PAYMENT_REFUNDED com order_reopened, o mesmo critério do servidor), nunca pela NFC-e: a nota só decide as
  // providências fiscais (aviso de conferir o cancelamento).
  return logs.some((l) => l.order_id === order.id && l.action_type === 'POINT_PAYMENT_REFUNDED' && l.metadata?.order_reopened === true);
}

export type OrderPullResult = 'applied' | 'pending' | 'rejected' | 'missing' | 'failed';

/**
 * GPT r12 (P1-02): traz a conta do servidor para este aparelho (tchefood_order_snapshot). 'applied': este aparelho
 * ficou com o estado do servidor; 'pending': há alteração desta conta na fila daqui (nada mudou); 'rejected': há
 * alteração desta conta recusada pela nuvem (nada mudou até resolver); 'failed': sem leitura.
 */
export async function syncOrderFromServer(orderId: string, deps: ClaimDeps = defaultClaimDeps()): Promise<OrderPullResult> {
  const snap = await getOrderSnapshot(orderId, deps);
  if (snap.kind === 'missing') return 'missing';
  if (snap.kind !== 'ok') return 'failed';
  const r = useTcheStore.getState().applyServerOrderSnapshot(snap.snapshot);
  return r.ok ? r.data.kind : 'failed';
}

/** Até onde este aparelho já leu os estornos e encerramentos da loja (audit_logs.server_seq), por loja. */
const CHANGES_SEQ = 'tchefood.refundChangesSeq.v1:';
export function refundChangesSeq(tenantId: string): number {
  try {
    const n = Number(localStorage.getItem(CHANGES_SEQ + tenantId));
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0; // Sem armazenamento: lê tudo de novo (repetir é inofensivo).
  }
}
function saveRefundChangesSeq(tenantId: string, seq: number): void {
  try {
    localStorage.setItem(CHANGES_SEQ + tenantId, String(seq));
  } catch {
    // Sem armazenamento: a próxima leitura começa do zero.
  }
}

export type BlockedReason = 'pending' | 'rejected' | 'failed';

export interface RefundOrdersPull {
  /** false: alguma leitura do servidor falhou (o que deu para ler foi aplicado; tenta de novo na próxima). */
  ok: boolean;
  /** Contas reabertas pelo estorno no servidor (null: a lista não pôde ser lida). */
  reopened: ServerReopenedOrder[] | null;
  /** Contas reabertas no servidor que não puderam vir para cá, com o motivo. */
  blocked: Record<string, BlockedReason>;
}

/**
 * GPT r15 (P1-01): contas deste aparelho estornadas ou encerradas como venda devolvida no servidor desde a última
 * leitura. Só traz a conta que este aparelho tem e que está diferente (falta o último registro, outro status ou outro
 * saldo). O ponto de leitura só anda até onde tudo foi aplicado aqui e o servidor diz que é seguro; conta com
 * alteração daqui na fila ou recusada segura o ponto (volta na próxima leitura).
 */
async function pullRefundOrderChanges(tenantId: string, deps: ClaimDeps): Promise<boolean> {
  const from = refundChangesSeq(tenantId);
  const out = await listRefundOrderChanges(from, deps);
  if (out.kind !== 'ok') return false;
  let upTo = out.safeSeq;
  let ok = true;
  for (const c of out.items) {
    const st = useTcheStore.getState();
    if (!st.cloud || st.tenant.id !== tenantId) return false;
    const local = st.orders.find((o) => o.id === c.order_id);
    // Conta que este aparelho não tem: nada aqui está errado por causa dela (a reaberta que ainda deve vem pela lista).
    if (!local) continue;
    const known = st.auditLogs.some((l) => l.id === c.last_audit_id || l.metadata?.server_audit_id === c.last_audit_id);
    if (known && local.status === c.status && toCents(local.remaining_balance) === toCents(c.remaining_balance)) continue;
    const r = await syncOrderFromServer(c.order_id, deps);
    if (r !== 'applied') {
      upTo = Math.min(upTo, c.last_seq - 1);
      if (r === 'failed') ok = false;
    }
  }
  if (upTo > from && useTcheStore.getState().tenant.id === tenantId) saveRefundChangesSeq(tenantId, upTo);
  return ok;
}

let pulling: Promise<RefundOrdersPull> | null = null;

/** Uma leitura por vez (laço da nuvem e tela ao mesmo tempo dividem a mesma). */
export function pullRefundOrders(deps: ClaimDeps = defaultClaimDeps()): Promise<RefundOrdersPull> {
  if (pulling) return pulling;
  const run = doPull(deps).finally(() => {
    if (pulling === run) pulling = null;
  });
  pulling = run;
  return run;
}

async function doPull(deps: ClaimDeps): Promise<RefundOrdersPull> {
  const start = useTcheStore.getState();
  const blocked: Record<string, BlockedReason> = {};
  if (!start.cloud) return { ok: false, reopened: null, blocked };
  const tenantId = start.tenant.id;
  let ok = true;
  try {
    ok = await pullRefundOrderChanges(tenantId, deps);
  } catch {
    ok = false;
  }
  const out = await listRefundReopenedOrders(deps);
  if (out.kind !== 'ok') return { ok: false, reopened: null, blocked };
  const st = useTcheStore.getState();
  if (!st.cloud || st.tenant.id !== tenantId) return { ok: false, reopened: null, blocked };
  const onServer = new Set(out.items.map((i) => i.order_id));
  // Diferente da daqui (falta a conta, outro status ou outro saldo): o estado oficial vem do servidor.
  const differs = out.items.filter((i) => {
    const o = st.orders.find((x) => x.id === i.order_id);
    return !o || o.status !== 'PAYING' || toCents(o.remaining_balance) !== toCents(i.remaining_balance) || !isRefundReopenedOrder(o, st.payments, st.auditLogs);
  }).map((i) => i.order_id);
  // Só este aparelho ainda vê como reaberta (paga ou encerrada em outro aparelho, ou resposta perdida): confere lá.
  const stale = st.orders.filter((o) => isRefundReopenedOrder(o, st.payments, st.auditLogs) && !onServer.has(o.id)).map((o) => o.id);
  for (const id of [...differs, ...stale]) {
    const r = await syncOrderFromServer(id, deps);
    if (onServer.has(id) && (r === 'pending' || r === 'rejected' || r === 'failed')) blocked[id] = r;
  }
  return { ok, reopened: out.items, blocked };
}
