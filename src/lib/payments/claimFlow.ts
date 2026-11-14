/**
 * A reserva de um pagamento do começo ao fim, para as telas que recebem (caixa da mesa, ficha rápida,
 * retirada). Aparelho sem nuvem: não faz nada. Ligado à nuvem:
 *   1. gera o segredo da reserva e grava neste aparelho (chave + segredo) ANTES de chamar o servidor;
 *      reserva no servidor (claimPayment); sem resposta, tenta de novo com a MESMA chave e o MESMO segredo;
 *      ainda sem resposta, libera com o segredo (a reserva pode ter sido criada) e não recebe;
 *   2. batimento a cada 20 s enquanto a cobrança roda (no máximo PENDING_CHARGE_TTL_MS);
 *   3. antes de registrar uma aprovação (beforeRegister): adquirente igual à reservada e reserva ainda viva
 *      no servidor; senão, a tela não registra e trava a conta para conferência;
 *   4. fim conhecido (settle): o registro local passa a 'settled' e o laço de sincronização mantém a reserva
 *      viva até o servidor consumi-la (claimSupervisor);
 *   5. nada cobrado (recusa, dinheiro não registrado): libera com novas tentativas; se não der, fica pendente
 *      e aparece na lista de reservas presas;
 *   6. saída sem fim conhecido (erro inesperado): o registro local fica, e a reserva aparece na lista com o
 *      aviso de que foi este aparelho.
 */
import { PENDING_CHARGE_TTL_MS, useTcheStore } from '../../store/useTcheStore';
import type { ActionResult, AuditLog } from '../../types';
import { uuid } from '../ids';
import { beginLocalClaim, detachLocalClaim, endLocalClaim, generateReleaseToken, localClaim, settleLocalClaim } from './claimLedger';
import {
  authorizeClaimRefunded, CLAIM_HEARTBEAT_MS, CLAIM_OFFLINE_ERROR, claimPayment, reclaimPayment, releaseClaimAfterNoCharge, releasePaymentClaim,
  requirePaymentClaim, touchPaymentClaim, type ClaimAcquirer, type ClaimDeps, type ClaimInput, type ClaimResult,
} from './paymentClaim';
import { getReviewHoldByKey, reviewHoldKey, setReviewHold, type ReviewHold } from './reviewHolds';

export const CLAIM_RELEASED_DURING_CHARGE = 'A reserva foi liberada pelo gerente durante a cobrança: confira e estorne na maquininha';
export const CLAIM_RELEASED_BEFORE_PUSH = 'Reserva liberada pelo gerente antes do pagamento chegar ao servidor: confira e estorne';
export const CLAIM_UNCONFIRMED = 'Não foi possível confirmar a reserva com o servidor: a maquininha aprovou, mas o pagamento não foi registrado. Quando a conexão voltar, registre pelo comprovante.';
export const CLAIM_TOUCH_UNAVAILABLE = 'Sem conexão com o servidor para conferir a reserva: tente de novo.';

/** Prazo da reserva no servidor (lease): sem batimento confirmado por este tempo, a aprovação não é registrada sozinha. */
export const CLAIM_LEASE_MS = 90_000;

/** Códigos de trava criados pela reserva. CLAIM_RELEASED só sai com "Estornei na maquininha" (PIN de gerente). */
export type ClaimHoldCode = 'CLAIM_RELEASED' | 'CLAIM_UNCONFIRMED' | 'ACQUIRER_MISMATCH';

export type BeforeRegister = { ok: true } | { ok: false; code: ClaimHoldCode; reason: string };

export interface ClaimHandle {
  /** Fim conhecido com dinheiro ou cobrança feita / em revisão. */
  settle(): void;
  /** Nada foi recebido: libera a reserva. */
  noCharge(why: string): void;
  /** Chamar no finally: sem fim conhecido, o registro local fica. */
  leave(): void;
  /**
   * Antes de registrar uma aprovação da maquininha: a adquirente é a reservada e a reserva ainda é desta
   * cobrança? Sem batimento confirmado há 90 s (o prazo da reserva), também não registra.
   */
  beforeRegister(resultAcquirer: string): Promise<BeforeRegister>;
}

const NONE: ClaimHandle = { settle: () => undefined, noCharge: () => undefined, leave: () => undefined, beforeRegister: async () => ({ ok: true }) };

const ACQUIRER_NAME: Record<string, string> = { STONE: 'Stone', PAGBANK: 'PagBank', MERCADO_PAGO: 'Mercado Pago', CASH_DESK: 'Dinheiro' };

function mismatchReason(claimed: ClaimAcquirer, got: string): string {
  return `A maquininha respondeu como ${ACQUIRER_NAME[got] ?? got}, mas a reserva foi para ${ACQUIRER_NAME[claimed] ?? claimed}: confira a maquininha antes de registrar.`;
}

export async function startPaymentClaim(
  required: boolean,
  input: Omit<ClaimInput, 'releaseToken'>,
  now: () => number = Date.now,
): Promise<{ ok: true; handle: ClaimHandle } | { ok: false; code?: string; error: string }> {
  if (!required) return { ok: true, handle: NONE };
  // O segredo vive só aqui e no registro local; nunca vai para a tela nem para log.
  const token = generateReleaseToken();
  beginLocalClaim(input.key, input.orderId, token, { method: input.method, acquirer: input.acquirer, amount_cents: Math.round(input.amount * 100) });
  const full: ClaimInput = { ...input, releaseToken: token };
  const attempt = async (): Promise<ClaimResult> => {
    try {
      return await claimPayment(full);
    } catch {
      return { ok: false, offline: true, error: CLAIM_OFFLINE_ERROR };
    }
  };
  let c = await attempt();
  // Sem resposta: o servidor pode ter criado a reserva. A mesma chave e o mesmo segredo devolvem a mesma reserva.
  if (!c.ok && c.offline) c = await attempt();
  if (!c.ok) {
    // Sem resposta: libera com o segredo (TF005 = nunca existiu, conta como liberada); sem rede, fica pendente.
    // Recusa do servidor: nada foi criado.
    if (c.offline) void releaseClaimAfterNoCharge(input.key, input.orderId, 'Reserva sem resposta do servidor: nada foi recebido', token, undefined, { unknownClaim: true });
    else endLocalClaim(input.key);
    return { ok: false, ...(c.code ? { code: c.code } : {}), error: c.error };
  }

  const startedAt = now();
  let lastOkTouchAt = startedAt;
  let done = false;
  let released = false;
  const markReleased = () => {
    released = true;
    stop();
  };
  // Batimento: renova o prazo da reserva enquanto a cobrança roda (sem ele, o gerente poderia liberar a
  // reserva de uma cobrança em andamento). Para no fim, ou ao passar do prazo de uma cobrança pendente: aí o
  // gerente pode liberar depois de 5 min sem batimento.
  const timer: ReturnType<typeof setInterval> = setInterval(() => {
    if (now() - startedAt >= PENDING_CHARGE_TTL_MS) {
      stop();
      return;
    }
    void touchPaymentClaim(input.key, token).then((t) => {
      if (done) return;
      if (t.ok) lastOkTouchAt = now();
      if (t.ok && t.status === 'released') markReleased();
    });
  }, CLAIM_HEARTBEAT_MS);
  function stop() {
    clearInterval(timer);
  }
  return {
    ok: true,
    handle: {
      settle: () => {
        stop();
        if (done) return;
        done = true;
        // Fica com o segredo até o servidor consumir a reserva (claimSupervisor, pelo laço de sincronização).
        settleLocalClaim(input.key);
      },
      noCharge: (why) => {
        stop();
        if (done) return;
        done = true;
        void releaseClaimAfterNoCharge(input.key, input.orderId, why, token);
      },
      leave: () => {
        stop();
        if (!done) detachLocalClaim(input.key);
      },
      beforeRegister: async (resultAcquirer) => {
        if (resultAcquirer !== input.acquirer) return { ok: false, code: 'ACQUIRER_MISMATCH', reason: mismatchReason(input.acquirer, resultAcquirer) };
        if (released) return { ok: false, code: 'CLAIM_RELEASED', reason: CLAIM_RELEASED_DURING_CHARGE };
        const t = await touchPaymentClaim(input.key, token);
        if (t.ok && t.status === 'released') {
          markReleased();
          return { ok: false, code: 'CLAIM_RELEASED', reason: CLAIM_RELEASED_DURING_CHARGE };
        }
        if (t.ok) {
          lastOkTouchAt = now();
          return { ok: true };
        }
        // Sem resposta agora: dentro do prazo da reserva, o servidor ainda a segura; passou do prazo, não registra.
        if (now() - lastOkTouchAt >= CLAIM_LEASE_MS) return { ok: false, code: 'CLAIM_UNCONFIRMED', reason: CLAIM_UNCONFIRMED };
        return { ok: true };
      },
    },
  };
}

export type ReclaimOutcome = { ok: true; key: string } | { ok: false; error: string };

/**
 * ACQUIRER_MISMATCH: troca a reserva para a adquirente real antes de registrar pelo comprovante. A chave e o
 * segredo novos vão para o registro local (e a chave para a trava) ANTES da chamada; sem resposta, tenta de
 * novo com os mesmos; ainda sem resposta, ficam guardados para a próxima tentativa. Falha: a trava fica.
 */
export async function reclaimForHold(hold: ReviewHold, method: ClaimInput['method'], acquirer: ClaimAcquirer): Promise<ReclaimOutcome> {
  const oldKey = hold.idempotency_key;
  const oldToken = oldKey ? localClaim(oldKey)?.release_token : null;
  if (!oldKey || !oldToken) return { ok: false, error: 'Este aparelho não tem o código da reserva antiga: o gerente libera a reserva na lista e registra de novo.' };
  const newKey = hold.reclaim_key ?? uuid();
  const newToken = localClaim(newKey)?.release_token ?? generateReleaseToken();
  beginLocalClaim(newKey, hold.order_id, newToken, { method, acquirer, amount_cents: Math.round(hold.amount * 100) });
  if (hold.reclaim_key !== newKey) setReviewHold({ ...hold, reclaim_key: newKey });
  const input = { oldKey, oldToken, newKey, newToken, method, acquirer, amount: hold.amount };
  let r = await reclaimPayment(input);
  if (!r.ok && r.offline) r = await reclaimPayment(input);
  if (r.ok) return { ok: true, key: newKey };
  // Sem resposta, ou recusa (TF009…) em que a reserva nova pode existir no servidor: chave e segredo ficam para a
  // próxima tentativa (mesma troca, idempotente). Só sai quando o servidor diz que a chave nova não existe.
  detachLocalClaim(newKey);
  if (!r.offline) {
    const t = await touchPaymentClaim(newKey, newToken);
    if (!t.ok && t.code === 'TF005') {
      endLocalClaim(newKey);
      const { reclaim_key: _drop, ...rest } = getReviewHoldByKey(reviewHoldKey(hold)) ?? hold;
      void _drop;
      setReviewHold(rest);
    }
  }
  return { ok: false, error: r.error };
}

/** Depois de registrar com a chave nova: a reserva nova segue no laço até o servidor consumir; a antiga sai. */
export function finishReclaim(oldKey: string | undefined, newKey: string): void {
  settleLocalClaim(newKey);
  if (oldKey) endLocalClaim(oldKey);
}

export type HoldClaimCheck = { ok: true } | { ok: false; released: boolean; error: string };

/**
 * Antes de registrar pelo comprovante uma cobrança em conferência: a reserva desta chave ainda está no servidor?
 * Liberada → a trava vira CLAIM_RELEASED (estornar); sem resposta → não registra ("tente de novo").
 * Sem registro local da reserva (aparelho sem o segredo): segue, o servidor ainda confere ao gravar.
 */
export async function checkHoldClaim(key: string | null | undefined): Promise<HoldClaimCheck> {
  if (!key) return { ok: true };
  const token = localClaim(key)?.release_token;
  if (!token) return { ok: true };
  const t = await touchPaymentClaim(key, token);
  if (t.ok && t.status === 'released') return { ok: false, released: true, error: CLAIM_RELEASED_DURING_CHARGE };
  if (t.ok) return { ok: true };
  if (t.code === 'TF005') return { ok: false, released: true, error: CLAIM_RELEASED_DURING_CHARGE };
  return { ok: false, released: false, error: CLAIM_TOUCH_UNAVAILABLE };
}

export const REFUND_NEEDS_MANAGER_RELEASE =
  'Este aparelho não tem o código da reserva: o gerente libera a reserva na lista de reservas e confirma o estorno de novo.';

/**
 * "Estornei / devolvi" (CLAIM_RELEASED / PAYMENT_REJECTED). Ligado à nuvem: o servidor registra primeiro
 * (tchefood_authorize_claim_refunded); a trava só sai com o id que ele devolve. Sem resposta, PIN recusado ou
 * recusa: a trava fica. PAYMENT_REJECTED com a reserva ainda aberta (TF007): libera com o segredo deste
 * aparelho e tenta de novo; sem o segredo, o gerente libera pela lista de reservas.
 */
export async function confirmClaimRefunded(
  hold: ReviewHold,
  auth: { managerPin: string; reason: string },
  deps?: ClaimDeps,
): Promise<ActionResult<AuditLog>> {
  const store = useTcheStore.getState();
  const holdKey = reviewHoldKey(hold);
  if (!requirePaymentClaim(store)) return store.resolveRefundedClaimHold(hold.order_id, auth, holdKey);
  const key = hold.idempotency_key;
  if (!key) return { ok: false, error: 'Trava sem a chave da reserva: o gerente confere pela lista de reservas.' };
  const paymentId = store.payments.find((p) => p.idempotency_key === key)?.id;
  const meta = { refund_kind: hold.refund === 'CASH' ? ('cash' as const) : ('card' as const), ...(paymentId ? { payment_local_id: paymentId } : {}) };
  let r = await authorizeClaimRefunded(key, auth.managerPin, auth.reason, meta, deps);
  if (!r.ok && r.notReleased && hold.code === 'PAYMENT_REJECTED') {
    const rel = await releasePaymentClaim(key, 'Pagamento recusado pelo servidor: estornado ou devolvido ao cliente', localClaim(key)?.release_token, deps);
    if (!rel.ok) return { ok: false, error: rel.noToken ? REFUND_NEEDS_MANAGER_RELEASE : rel.error };
    r = await authorizeClaimRefunded(key, auth.managerPin, auth.reason, meta, deps);
  }
  // O servidor não tem esta reserva (TF005): tira a trava só com o PIN e o motivo daqui (audit local marcado).
  if (!r.ok && r.notFound) {
    const local = useTcheStore.getState().resolveRefundedClaimHold(hold.order_id, auth, holdKey, { claimMissing: true });
    if (local.ok) endLocalClaim(key);
    return local;
  }
  if (!r.ok) return { ok: false, error: r.error };
  const res = useTcheStore.getState().resolveRefundedClaimHold(hold.order_id, auth, holdKey, { auditId: r.auditId });
  if (res.ok) endLocalClaim(key);
  return res;
}
