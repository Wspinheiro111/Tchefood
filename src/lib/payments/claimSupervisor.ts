/**
 * Reservas deste aparelho aguardando o servidor (r7 P1-4, P1-A, P1-B, P3), a partir do registro persistido
 * (claimLedger), pelo laço de sincronização: não depende da tela nem do app ficar aberto.
 *
 * Terminadas aqui ('settled'):
 *  - pagamento APROVADO aqui com a chave:
 *      recusado pelo servidor (está em syncRejected) → trava PAYMENT_REJECTED com a mensagem do servidor,
 *        o pagamento sai da conta (withdrawUnacceptedPayment) e a reserva não é mais renovada (o segredo fica,
 *        para liberar a reserva antes de confirmar o estorno);
 *      senão renova a reserva (com o segredo) a cada 20 s:
 *        consumed → pronto, sai do registro;
 *        released com o pagamento ainda na fila (ou recusado) → trava CLAIM_RELEASED, o pagamento sai da conta;
 *  - sem pagamento aprovado, mas com trava da chave: guarda o segredo (o registro pelo comprovante confere a
 *    reserva antes) e não renova (a reserva envelhece; o gerente decide);
 *  - nenhum dos dois: sai do registro.
 *
 * Em andamento ('charging') que não estão rodando neste aparelho (o app caiu no meio): NÃO renova (renovar
 * seguraria a reserva para sempre); lê as reservas abertas da conta. Ausente → sai do registro, mas só depois
 * de 3 leituras ausentes espaçadas por 2 min ou mais (a reserva pode ainda ser gravada por uma chamada que se
 * perdeu, r7 P2-F).
 */
import { useTcheStore } from '../../store/useTcheStore';
import type { Payment } from '../../types';
import { endLocalClaim, inFlightClaims, isClaimActiveHere, markClaimAbsent, settledClaims, type LocalClaim } from './claimLedger';
import { CLAIM_RELEASED_BEFORE_PUSH } from './claimFlow';
import { CLAIM_HEARTBEAT_MS, touchPaymentClaim, type TouchResult } from './paymentClaim';
import { getReviewHoldByKey, holdAcquirer, setReviewHold, type ReviewHold } from './reviewHolds';

export const WITHDRAWN_REASON = 'reserva liberada antes de chegar ao servidor';
export const REJECTED_REASON = 'pagamento recusado pelo servidor';

/** Ausente na leitura do servidor: só sai do registro depois de 3 leituras espaçadas por 2 min ou mais. */
export const ABSENT_READS = 3;
export const ABSENT_SPAN_MS = 120_000;

export interface SupervisorDeps {
  touch: (key: string, token: string) => Promise<TouchResult>;
  payments: () => readonly Payment[];
  /** O pagamento ainda está na fila para o servidor. */
  unpushed: (paymentId: string) => boolean;
  /** Mensagem do servidor se recusou o pagamento (syncRejected); null = não recusado. */
  rejected: (paymentId: string) => string | null;
  /** Tira da conta o pagamento que não entrou no servidor. nfceIssued: a conta já tinha NFC-e (cancelar a nota). */
  withdraw: (key: string, reason: string) => { nfceIssued: boolean } | null;
  hold: (key: string) => ReviewHold | null;
  setHold: (hold: Omit<ReviewHold, 'created_at'>) => void;
  alert: (text: string) => void;
  /** Chaves das reservas abertas da conta no servidor (sem renovar); null = sem leitura. */
  openClaimKeys: (orderId: string) => Promise<ReadonlySet<string> | null>;
}

/** Quem mostra o alerta na tela (o App registra o toast; aqui não se importa componente). */
let alertHandler: ((text: string) => void) | null = null;
export function setClaimAlertHandler(fn: ((text: string) => void) | null): void {
  alertHandler = fn;
}

const isInsertOf = (id: string) => (e: { table: string; op: string; row_id: string }) => e.table === 'payments' && e.op === 'INSERT' && e.row_id === id;

function defaultDeps(): SupervisorDeps {
  return {
    touch: (key, token) => touchPaymentClaim(key, token),
    payments: () => useTcheStore.getState().payments,
    unpushed: (id) => useTcheStore.getState().outbox.some(isInsertOf(id)),
    rejected: (id) => (useTcheStore.getState().syncRejected ?? []).find((r) => isInsertOf(id)(r.event))?.message ?? null,
    withdraw: (key, reason) => {
      const r = useTcheStore.getState().withdrawUnacceptedPayment(key, reason);
      return r.ok ? { nfceIssued: r.data.nfceIssued } : null;
    },
    hold: getReviewHoldByKey,
    setHold: (h) => void setReviewHold(h),
    alert: (text) => alertHandler?.(text),
    openClaimKeys: async (orderId) => {
      try {
        const { freshCloudConfig } = await import('../sync/useCloudSync');
        const { fetchPointReservation } = await import('../sync/cloudPull');
        const cfg = await freshCloudConfig();
        if (!cfg) return null;
        const r = await fetchPointReservation(cfg, (url, init) => fetch(url, init), orderId);
        return new Set((r.claims ?? []).map((c) => c.idempotencyKey));
      } catch {
        return null;
      }
    },
  };
}

/** Como devolver ao cliente o pagamento que saiu da conta. */
export function refundText(p: Pick<Payment, 'method'>): string {
  return p.method === 'CASH' ? 'Devolva o dinheiro ao cliente (o pagamento não entrou no servidor).' : 'Estorne na maquininha.';
}

export const NFCE_ISSUED_NOTE = 'NFC-e já emitida: cancele a nota.';
const withNfce = (text: string, w: { nfceIssued: boolean } | null) => (w?.nfceIssued ? `${text} ${NFCE_ISSUED_NOTE}` : text);

function holdFor(c: LocalClaim, paid: Payment, code: 'CLAIM_RELEASED' | 'PAYMENT_REJECTED', reason: string): Omit<ReviewHold, 'created_at'> {
  return {
    order_id: c.order_id, amount: paid.amount, reason, code, refund: paid.method === 'CASH' ? 'CASH' : 'TERMINAL',
    ...(paid.method === 'CREDIT' || paid.method === 'DEBIT' || paid.method === 'PIX' ? { method: paid.method } : {}),
    ...(paid.acquirer !== 'CASH_DESK' ? { acquirer: holdAcquirer(paid.acquirer) } : {}),
    terminal_id: paid.terminal_id, terminal_serial: paid.terminal_serial, idempotency_key: c.key,
  };
}

let lastRun = 0;
let running = false;

/** Uma volta do supervisor. Devolve quantas reservas saíram do registro. */
export async function superviseSettledClaims(deps: SupervisorDeps = defaultDeps(), nowMs = Date.now(), force = false): Promise<number> {
  if (running || (!force && nowMs - lastRun < CLAIM_HEARTBEAT_MS)) return 0;
  const settled = settledClaims();
  const stale = inFlightClaims().filter((c) => c.state !== 'settled' && !isClaimActiveHere(c.key));
  if (settled.length === 0 && stale.length === 0) return 0;
  running = true;
  lastRun = nowMs;
  let pruned = 0;
  const drop = (key: string) => {
    endLocalClaim(key);
    pruned += 1;
  };
  try {
    for (const c of settled) {
      const paid = deps.payments().find((p) => p.idempotency_key === c.key && p.status === 'APPROVED');
      if (!paid) {
        const h = deps.hold(c.key);
        if (!h) drop(c.key);
        continue;
      }
      // Recusado pelo servidor: não renova (seria para sempre); o pagamento sai da conta e o caixa devolve.
      const rejected = deps.rejected(paid.id);
      if (rejected !== null) {
        const w = deps.withdraw(c.key, REJECTED_REASON);
        const reason = withNfce(`O servidor recusou o pagamento (${rejected}): ele foi retirado desta conta. ${refundText(paid)}`, w);
        deps.setHold(holdFor(c, paid, 'PAYMENT_REJECTED', reason));
        deps.alert(reason);
        // Fica no registro (sem renovar: o pagamento saiu da conta e a trava existe): o segredo libera a reserva
        // antes de confirmar o estorno no servidor.
        continue;
      }
      if (!c.release_token) {
        // Registro antigo sem o segredo: não dá para renovar; o servidor confere ao receber o pagamento.
        drop(c.key);
        continue;
      }
      const t = await deps.touch(c.key, c.release_token);
      if (t.ok && t.status === 'open') continue;
      if (!t.ok && (t.offline || !t.code)) continue;
      const notInServer = deps.unpushed(paid.id) || deps.rejected(paid.id) !== null;
      // Recusa com código (TF004/TF005…) com o pagamento ainda fora do servidor: guarda o registro (o segredo) e tenta de novo.
      if (!t.ok && notInServer) continue;
      if (t.ok && t.status === 'released' && notInServer) {
        const w = deps.withdraw(c.key, WITHDRAWN_REASON);
        const reason = withNfce(`${CLAIM_RELEASED_BEFORE_PUSH}: o pagamento foi retirado desta conta. ${refundText(paid)}`, w);
        deps.setHold(holdFor(c, paid, 'CLAIM_RELEASED', reason));
        deps.alert(reason);
      }
      // consumed, released (a trava e a retirada já feitas, ou o pagamento já subiu) ou recusa com o pagamento
      // já no servidor: sai do registro.
      drop(c.key);
    }

    // Em andamento sem ninguém rodando aqui: lê sem renovar.
    const byOrder = new Map<string, LocalClaim[]>();
    for (const c of stale) byOrder.set(c.order_id, [...(byOrder.get(c.order_id) ?? []), c]);
    for (const [orderId, list] of byOrder) {
      const open = await deps.openClaimKeys(orderId);
      if (!open) continue;
      for (const c of list) {
        if (open.has(c.key)) {
          markClaimAbsent(c.key, null);
          continue;
        }
        const seen = markClaimAbsent(c.key, nowMs);
        if (seen && seen.count >= ABSENT_READS && nowMs - seen.firstAt >= ABSENT_SPAN_MS) drop(c.key);
      }
    }
  } finally {
    running = false;
  }
  return pruned;
}

/** Só para testes. */
export function resetClaimSupervisor(): void {
  lastRun = 0;
  running = false;
}
