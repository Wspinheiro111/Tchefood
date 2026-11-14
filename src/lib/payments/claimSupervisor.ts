/**
 * Reservas terminadas neste aparelho (estado 'settled' no claimLedger) aguardando o servidor (r7 P1-4).
 *
 * Depois do pagamento registrado aqui, a reserva precisa continuar viva até o pagamento chegar ao servidor e
 * consumi-la. Isso não pode depender da tela (que pode fechar) nem do app ficar aberto: o laço de
 * sincronização (useCloudSync) chama esta função; ela lê o registro persistido e:
 *  - pagamento APROVADO aqui com a chave: renova a reserva (com o segredo) a cada 20 s;
 *      consumed → pronto, sai do registro;
 *      released → o gerente liberou antes do pagamento chegar ao servidor: alerta, trava a conta e sai;
 *  - sem pagamento aprovado, mas com trava de conferência na conta com a chave: guarda o segredo (o registro
 *    pelo comprovante confere a reserva antes) e não renova (a reserva envelhece; o gerente decide);
 *  - nenhum dos dois: nada a proteger, sai do registro (a lista de reservas presas mostra o que restar).
 */
import { useTcheStore } from '../../store/useTcheStore';
import type { Payment } from '../../types';
import { endLocalClaim, settledClaims } from './claimLedger';
import { CLAIM_RELEASED_BEFORE_PUSH } from './claimFlow';
import { CLAIM_HEARTBEAT_MS, touchPaymentClaim, type TouchResult } from './paymentClaim';
import { getReviewHold, holdAcquirer, setReviewHold, type ReviewHold } from './reviewHolds';

export interface SupervisorDeps {
  touch: (key: string, token: string) => Promise<TouchResult>;
  payments: () => readonly Payment[];
  /** O pagamento ainda está na fila para o servidor. */
  unpushed: (paymentId: string) => boolean;
  hold: (orderId: string) => ReviewHold | null;
  setHold: (hold: Omit<ReviewHold, 'created_at'>) => void;
  alert: (text: string) => void;
}

/** Quem mostra o alerta na tela (o App registra o toast; aqui não se importa componente). */
let alertHandler: ((text: string) => void) | null = null;
export function setClaimAlertHandler(fn: ((text: string) => void) | null): void {
  alertHandler = fn;
}

function defaultDeps(): SupervisorDeps {
  return {
    touch: (key, token) => touchPaymentClaim(key, token),
    payments: () => useTcheStore.getState().payments,
    unpushed: (id) => useTcheStore.getState().outbox.some((e) => e.table === 'payments' && e.row_id === id),
    hold: getReviewHold,
    setHold: (h) => void setReviewHold(h),
    alert: (text) => alertHandler?.(text),
  };
}

let lastRun = 0;
let running = false;

/** Uma volta do supervisor. Devolve quantas reservas saíram do registro. */
export async function superviseSettledClaims(deps: SupervisorDeps = defaultDeps(), nowMs = Date.now(), force = false): Promise<number> {
  if (running || (!force && nowMs - lastRun < CLAIM_HEARTBEAT_MS)) return 0;
  const list = settledClaims();
  if (list.length === 0) return 0;
  running = true;
  lastRun = nowMs;
  let pruned = 0;
  try {
    for (const c of list) {
      const paid = deps.payments().find((p) => p.idempotency_key === c.key && p.status === 'APPROVED');
      if (!paid) {
        const h = deps.hold(c.order_id);
        if (h && h.idempotency_key === c.key) continue;
        endLocalClaim(c.key);
        pruned += 1;
        continue;
      }
      if (!c.release_token) {
        // Registro antigo sem o segredo: não dá para renovar; o servidor confere ao receber o pagamento.
        endLocalClaim(c.key);
        pruned += 1;
        continue;
      }
      const t = await deps.touch(c.key, c.release_token);
      if (t.ok && t.status === 'open') continue;
      if (!t.ok && (t.offline || !t.code)) continue;
      if (t.ok && t.status === 'released' && deps.unpushed(paid.id)) {
        deps.setHold({
          order_id: c.order_id, amount: paid.amount, reason: CLAIM_RELEASED_BEFORE_PUSH, code: 'CLAIM_RELEASED',
          ...(paid.method === 'CREDIT' || paid.method === 'DEBIT' || paid.method === 'PIX' ? { method: paid.method } : {}),
          ...(paid.acquirer !== 'CASH_DESK' ? { acquirer: holdAcquirer(paid.acquirer) } : {}),
          terminal_id: paid.terminal_id, terminal_serial: paid.terminal_serial, idempotency_key: c.key,
        });
        deps.alert(CLAIM_RELEASED_BEFORE_PUSH);
      }
      // consumed (o servidor recebeu o pagamento), released, ou recusa definitiva (TF004/TF005): sai do registro.
      endLocalClaim(c.key);
      pruned += 1;
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
