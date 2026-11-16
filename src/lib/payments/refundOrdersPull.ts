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
import { tenantFromJwt } from '../sync/supabaseSync';
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
 * GPT r16 P0-01: a loja e a sessão da nuvem em que uma leitura começou. Toda resposta só é aplicada (e o ponto de
 * leitura só é gravado) se o aparelho continua nessa loja e nessa sessão; trocou de loja ou desconectou no meio, a
 * resposta antiga é descartada.
 */
export interface PullScope {
  tenantId: string;
  /** url|email|loja da sessão da nuvem; null = sem sessão. */
  session: string | null;
}
export function pullScopeNow(): PullScope {
  const st = useTcheStore.getState();
  return { tenantId: st.tenant.id, session: st.cloud ? `${st.cloud.url}|${st.cloud.email}|${st.cloud.tenant_id}` : null };
}
export function sameScope(scope: PullScope): boolean {
  const now = pullScopeNow();
  return now.tenantId === scope.tenantId && now.session === scope.session;
}

/**
 * GPT r12 (P1-02): traz a conta do servidor para este aparelho (tchefood_order_snapshot). 'applied': este aparelho
 * ficou com o estado do servidor; 'pending': há alteração desta conta na fila daqui (nada mudou); 'rejected': há
 * alteração desta conta recusada pela nuvem (nada mudou até resolver); 'failed': sem leitura, ou a loja/sessão mudou
 * enquanto lia (nada é aplicado).
 */
export async function syncOrderFromServer(orderId: string, deps: ClaimDeps = defaultClaimDeps(), scope: PullScope = pullScopeNow()): Promise<OrderPullResult> {
  const snap = await getOrderSnapshot(orderId, deps);
  if (!sameScope(scope)) return 'failed';
  if (snap.kind === 'missing') return 'missing';
  if (snap.kind !== 'ok') return 'failed';
  const r = useTcheStore.getState().applyServerOrderSnapshot(snap.snapshot);
  return r.ok ? r.data.kind : 'failed';
}

/**
 * Até onde este aparelho já leu e aplicou os estornos e encerramentos da loja (audit_logs.server_seq). Fica no estado
 * do aparelho (pullStatus.refund_seq), junto das contas: GPT r17 (a verificar): no localStorage as abas do mesmo
 * navegador dividiam o ponto, e uma aba que avançava fazia a outra pular uma alteração que ainda não tinha aplicado.
 * Só vale para a loja do estado atual (a leitura confere a loja antes de usar).
 */
export function refundChangesSeq(): number {
  const n = Number(useTcheStore.getState().pullStatus?.refund_seq);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

export type BlockedReason = 'pending' | 'rejected' | 'failed' | 'missing';

export interface RefundOrdersPull {
  /** false: alguma leitura do servidor falhou (o que deu para ler foi aplicado; tenta de novo na próxima). */
  ok: boolean;
  /** GPT r16 P2-01: false = os estornos e encerramentos feitos em outros aparelhos não puderam ser lidos ou aplicados agora. */
  changesOk: boolean;
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
async function pullRefundOrderChanges(scope: PullScope, deps: ClaimDeps): Promise<boolean> {
  const from = refundChangesSeq();
  const out = await listRefundOrderChanges(from, deps);
  if (out.kind !== 'ok' || !sameScope(scope)) return false;
  let upTo = out.safeSeq;
  let ok = true;
  for (const c of out.items) {
    if (!sameScope(scope)) return false;
    const st = useTcheStore.getState();
    const local = st.orders.find((o) => o.id === c.order_id);
    // Conta que este aparelho não tem: nada aqui está errado por causa dela (a reaberta que ainda deve vem pela lista).
    if (!local) continue;
    const known = st.auditLogs.some((l) => l.id === c.last_audit_id || l.metadata?.server_audit_id === c.last_audit_id);
    if (known && local.status === c.status && toCents(local.remaining_balance) === toCents(c.remaining_balance)) continue;
    const r = await syncOrderFromServer(c.order_id, deps, scope);
    if (r !== 'applied') {
      upTo = Math.min(upTo, c.last_seq - 1);
      // GPT r19 P2-02: conta que não convergiu (evento na fila ou recusado, sem leitura, não encontrada) deixa a leitura incompleta.
      ok = false;
    }
  }
  if (!sameScope(scope)) return false;
  if (upTo > from) useTcheStore.getState().setRefundSeq(upTo);
  return ok;
}

/** Uma leitura por vez por loja e sessão (laço da nuvem e tela ao mesmo tempo dividem a mesma). */
const pulling = new Map<string, Promise<RefundOrdersPull>>();

/**
 * Lê do servidor os estornos e encerramentos e as contas reabertas, na loja e na sessão de `scope` (padrão: as de
 * agora). `deps.config` tem de ser dessa mesma sessão: token de outra loja não lê nada.
 */
export function pullRefundOrders(deps: ClaimDeps = defaultClaimDeps(), scope: PullScope = pullScopeNow()): Promise<RefundOrdersPull> {
  const key = `${scope.tenantId}|${scope.session}`;
  const running = pulling.get(key);
  if (running) return running;
  const run = doPull(deps, scope).finally(() => {
    if (pulling.get(key) === run) pulling.delete(key);
  });
  pulling.set(key, run);
  return run;
}

async function doPull(deps: ClaimDeps, scope: PullScope): Promise<RefundOrdersPull> {
  const blocked: Record<string, BlockedReason> = {};
  const nothing: RefundOrdersPull = { ok: false, changesOk: false, reopened: null, blocked };
  if (!scope.session || !sameScope(scope)) return nothing;
  // O token usado tem de ser da loja em que a leitura começou (sessão capturada antes de uma troca de loja não serve).
  let token: string | null = null;
  try {
    token = (await deps.config())?.accessToken ?? null;
  } catch {
    token = null;
  }
  if (!token || !sameScope(scope)) return nothing;
  const tokenTenant = tenantFromJwt(token);
  if (tokenTenant !== null && tokenTenant !== scope.tenantId) return nothing;
  let changesOk = true;
  try {
    changesOk = await pullRefundOrderChanges(scope, deps);
  } catch {
    changesOk = false;
  }
  if (!sameScope(scope)) return nothing;
  const out = await listRefundReopenedOrders(deps);
  if (out.kind !== 'ok' || !sameScope(scope)) return { ...nothing, changesOk };
  const st = useTcheStore.getState();
  const onServer = new Set(out.items.map((i) => i.order_id));
  // Diferente da daqui (falta a conta, outro status ou outro saldo): o estado oficial vem do servidor.
  const differs = out.items.filter((i) => {
    const o = st.orders.find((x) => x.id === i.order_id);
    return !o || o.status !== 'PAYING' || toCents(o.remaining_balance) !== toCents(i.remaining_balance) || !isRefundReopenedOrder(o, st.payments, st.auditLogs);
  }).map((i) => i.order_id);
  // Só este aparelho ainda vê como reaberta (paga ou encerrada em outro aparelho, ou resposta perdida): confere lá.
  const stale = st.orders.filter((o) => isRefundReopenedOrder(o, st.payments, st.auditLogs) && !onServer.has(o.id)).map((o) => o.id);
  // GPT r18 P2-01 e r19: vale para as duas listas. Conta que não pôde ser atualizada (retrato com erro, evento dela na
  // fila ou recusado, ou não encontrada no servidor) fica bloqueada, sem ações, e a leitura não é "completa" até convergir.
  let refreshIncomplete = false;
  for (const id of [...differs, ...stale]) {
    const r = await syncOrderFromServer(id, deps, scope);
    if (!sameScope(scope)) return { ...nothing, changesOk: false };
    if (r !== 'applied') {
      blocked[id] = r;
      refreshIncomplete = true;
    }
  }
  const complete = changesOk && !refreshIncomplete;
  return { ok: complete, changesOk: complete, reopened: out.items, blocked };
}
