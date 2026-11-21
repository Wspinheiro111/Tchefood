/**
 * Pagamento já registrado que a nuvem recusou por falta de reserva (TF010 claim_required): fila de um aparelho
 * da versão anterior (dinheiro ou Stone/PagBank sem reserva) reenviada depois da migração (db/tests/rollout).
 * Sem isso o aparelho não tinha saída: "Reenviar recusados" repetia o TF010, a retirada automática só existe para
 * pagamento com reserva daqui (claimSupervisor) e a conta ficava travada para receber (ensureOrderSynced).
 *
 * Recuperação (automática no "Reenviar recusados"):
 *  1. lê o saldo da conta no servidor agora (que ainda não tem este pagamento);
 *  2. grava no registro local a chave e um segredo novo ANTES de chamar (como startPaymentClaim); nova tentativa
 *     depois de resposta perdida usa o mesmo segredo;
 *  3. pede a reserva com a chave do próprio pagamento e os termos exatos dele (conta, forma, adquirente, valor);
 *  4. reserva aberta: o mesmo evento do pagamento volta para a fila (o servidor consome a reserva ao receber).
 * Recusa definitiva (TF003 sem saldo livre — outro aparelho já recebeu esse valor —, conta fechada, chave em
 * uso…): nada some sozinho; o gerente retira o pagamento daqui com PIN ("não aceito pela nuvem") e a trava diz
 * ao caixa para devolver ou estornar e cobrar de novo.
 */
import { getStorageStatus } from '../idbStorage';
import { useTcheStore } from '../../store/useTcheStore';
import type { Payment, RejectedSyncEvent, SyncEvent } from '../../types';
import { fetchServerOrderBalance } from '../sync/cloudPull';
import { beginLocalClaim, detachLocalClaim, endLocalClaim, forgetUnsavedClaim, generateReleaseToken, localClaim, settleLocalClaim } from './claimLedger';
import { CLAIM_NOT_STORED } from './claimFlow';
import { NFCE_ISSUED_NOTE, refundText } from './claimSupervisor';
import { CLAIM_REQUIRED_ERROR, claimPayment, defaultClaimDeps, releaseClaimAfterNoCharge, type ClaimAcquirer, type ClaimDeps, type ClaimMethod } from './paymentClaim';
import { holdAcquirer, setReviewHold } from './reviewHolds';

export const RECOVERY_REASON = 'não aceito pela nuvem';
export const RECOVERY_MANAGER_PATH =
  'O gerente retira este pagamento deste aparelho com PIN ("não aceito pela nuvem"): a conta volta a ter o saldo e o caixa devolve ou estorna e cobra de novo.';

/** Recusa da reserva pedida depois: o dinheiro já foi recebido aqui (os textos de CLAIM_ERRORS dizem "Nada foi recebido"). */
const RECOVERY_REFUSED: Record<string, string> = {
  TF001: 'O servidor não tem esta conta.',
  TF002: 'A conta já está fechada no servidor.',
  TF003: 'O servidor não tem saldo livre nesta conta para este pagamento (outro aparelho ou a Point já recebeu esse valor).',
  TF004: 'O servidor não reconhece o operador como da equipe ativa: entre de novo com o seu PIN e reenvie.',
  TF006: 'O servidor recusou os dados deste pagamento.',
  TF009: 'A chave deste pagamento já tem outra reserva no servidor.',
};

const METHODS: ReadonlySet<string> = new Set(['CASH', 'CREDIT', 'DEBIT', 'PIX']);
const ACQUIRERS: ReadonlySet<string> = new Set(['CASH_DESK', 'STONE', 'PAGBANK']);

function paymentOf(event: SyncEvent): Payment | null {
  const key = event.payload.idempotency_key;
  if (typeof key !== 'string') return null;
  return useTcheStore.getState().payments.find((p) => p.id === event.row_id && p.idempotency_key === key && p.status === 'APPROVED') ?? null;
}

/**
 * Recusado que a recuperação resolve: inclusão de pagamento APROVADO fora do Mercado Pago, recusada com TF010
 * (claim_required), sem reserva deste aparelho para a chave (ou só a que a própria recuperação pediu).
 */
export function isRecoverableRejectedPayment(r: Pick<RejectedSyncEvent, 'event' | 'message'>): boolean {
  const e = r.event;
  if (e.table !== 'payments' || e.op !== 'INSERT') return false;
  if (e.payload.status !== 'APPROVED' || e.payload.acquirer === 'MERCADO_PAGO') return false;
  if (!r.message.startsWith(CLAIM_REQUIRED_ERROR)) return false;
  const p = paymentOf(e);
  if (!p || !p.idempotency_key) return false;
  const own = localClaim(p.idempotency_key);
  return !own || own.terms?.recovery === true;
}

/**
 * Pagamento recuperado (reserva pedida pela recuperação) que a nuvem recusou de novo, por outro motivo: o supervisor
 * não o retira sozinho (claimSupervisor); fica aqui, com o caminho do gerente.
 */
export function isRecoveredRejectedPayment(r: Pick<RejectedSyncEvent, 'event' | 'message'>): boolean {
  const e = r.event;
  if (e.table !== 'payments' || e.op !== 'INSERT' || e.payload.status !== 'APPROVED' || e.payload.acquirer === 'MERCADO_PAGO') return false;
  const p = paymentOf(e);
  return Boolean(p?.idempotency_key && localClaim(p.idempotency_key)?.terms?.recovery === true && !isRecoverableRejectedPayment(r));
}

/** Há reserva da recuperação sendo pedida agora para este recusado (a retirada espera). */
export function recoveryInFlight(eventId: string): boolean {
  const r = (useTcheStore.getState().syncRejected ?? []).find((x) => x.event.id === eventId);
  const key = r?.event.payload.idempotency_key;
  return typeof key === 'string' && inFlight.has(key);
}

export type RecoveryResult =
  | { ok: true }
  /** Sem resposta, sem sessão, armazenamento: tentar de novo depois; nada mudou na conta. */
  | { ok: false; transient: true; error: string }
  /** Recusa definitiva: o caminho é o do gerente (withdrawRejectedPayment). */
  | { ok: false; transient: false; code?: string; error: string };

export interface RecoveryDeps extends ClaimDeps {
  balance: (orderId: string) => Promise<{ balanceCents: number; status: string }>;
}

export function defaultRecoveryDeps(): RecoveryDeps {
  const base = defaultClaimDeps();
  return {
    ...base,
    balance: async (orderId) => {
      const cfg = await base.config();
      if (!cfg) throw new Error('sem sessão');
      return fetchServerOrderBalance(cfg, base.fetch, orderId);
    },
  };
}

const inFlight = new Set<string>();

/** Recupera um recusado (por id do evento). Nunca lança. */
export async function recoverRejectedPayment(eventId: string, deps: RecoveryDeps = defaultRecoveryDeps()): Promise<RecoveryResult> {
  if (getStorageStatus() !== 'ok') return { ok: false, transient: true, error: 'Este aparelho não pode gravar agora (outra janela está em uso ou o estado precisa ser recarregado). Nada foi pedido à nuvem.' };
  const r = (useTcheStore.getState().syncRejected ?? []).find((x) => x.event.id === eventId);
  if (!r || !isRecoverableRejectedPayment(r)) return { ok: false, transient: false, error: 'Este recusado não é um pagamento sem reserva.' };
  const p = paymentOf(r.event)!;
  const key = p.idempotency_key!;
  if (!METHODS.has(p.method) || !ACQUIRERS.has(p.acquirer)) return { ok: false, transient: false, error: `Forma ou maquininha sem reserva no servidor (${p.method}/${p.acquirer}). ${RECOVERY_MANAGER_PATH}` };
  if (inFlight.has(key)) return { ok: false, transient: true, error: 'A reserva deste pagamento já está sendo pedida.' };
  inFlight.add(key);
  try {
    let server: { balanceCents: number; status: string };
    try {
      server = await deps.balance(p.order_id);
    } catch (e) {
      return { ok: false, transient: true, error: `Não foi possível ler a conta no servidor (${(e as Error).message}). Tente de novo.` };
    }
    const amountCents = Math.round(p.amount * 100);
    const terms = { method: p.method, acquirer: p.acquirer, amount_cents: amountCents, recovery: true as const };
    // O segredo é gravado antes da chamada; tentativa depois de resposta perdida usa o mesmo (mesma reserva).
    const token = localClaim(key)?.release_token ?? generateReleaseToken();
    if (!beginLocalClaim(key, p.order_id, token, terms)) {
      forgetUnsavedClaim(key);
      return { ok: false, transient: true, error: CLAIM_NOT_STORED };
    }
    const res = await claimPayment(
      { orderId: p.order_id, key, method: p.method as ClaimMethod, acquirer: p.acquirer as ClaimAcquirer, amount: p.amount, releaseToken: token },
      // O saldo esperado é o do servidor agora (a fila desta conta está parada atrás deste pagamento).
      { ...deps, prepareOrder: async () => ({ ok: true, balance_cents: server.balanceCents }) },
    );
    if (res.ok) {
      // Primeiro o evento volta para a fila (o supervisor não o vê mais como recusado), depois o fim conhecido.
      useTcheStore.getState().requeueRejectedEvents([eventId]);
      settleLocalClaim(key);
      return { ok: true };
    }
    if (res.code) {
      // Recusa com código: o servidor não criou nada.
      endLocalClaim(key);
      // O saldo mudou entre a leitura e a reserva: ler de novo resolve.
      if (res.code === 'TF008') return { ok: false, transient: true, error: 'O saldo da conta no servidor mudou durante a reserva: toque em Reenviar recusados de novo.' };
      return { ok: false, transient: false, code: res.code, error: `${RECOVERY_REFUSED[res.code] ?? `O servidor recusou a reserva deste pagamento (${res.code}).`} ${RECOVERY_MANAGER_PATH}` };
    }
    // Sem resposta ou resposta sem prova: a reserva pode ter sido criada; o registro (com o segredo) fica.
    detachLocalClaim(key);
    return { ok: false, transient: true, error: res.error };
  } finally {
    inFlight.delete(key);
  }
}

/**
 * "Reenviar recusados": pede a reserva de cada pagamento sem reserva (os que conseguem voltam para a fila), e
 * devolve os demais recusados à fila. Os pagamentos que não conseguiram ficam nos recusados, com o motivo.
 */
export async function resendRejected(deps: RecoveryDeps = defaultRecoveryDeps()): Promise<Map<string, RecoveryResult>> {
  const results = new Map<string, RecoveryResult>();
  const recoverable = (useTcheStore.getState().syncRejected ?? []).filter(isRecoverableRejectedPayment).map((r) => r.event.id);
  for (const id of recoverable) results.set(id, await recoverRejectedPayment(id, deps));
  useTcheStore.getState().retryRejectedSync([...results].filter(([, v]) => !v.ok).map(([id]) => id));
  return results;
}

/**
 * Caminho do gerente para o recusado que a recuperação não resolve: PIN e motivo, o pagamento sai da conta
 * (withdrawUnacceptedPayment, com as consequências na fila) e fica a trava PAYMENT_REJECTED dizendo como devolver.
 */
export function withdrawRejectedPayment(
  eventId: string,
  auth: { managerPin: string; reason: string },
  release: (key: string, orderId: string, reason: string, token: string, unknownClaim: boolean) => Promise<{ ok: boolean }> = (k, o, why, t, unknown) =>
    releaseClaimAfterNoCharge(k, o, why, t, undefined, { unknownClaim: unknown }),
): { ok: true; message: string } | { ok: false; error: string } {
  const st = useTcheStore.getState();
  const r = (st.syncRejected ?? []).find((x) => x.event.id === eventId);
  if (!r || !(isRecoverableRejectedPayment(r) || isRecoveredRejectedPayment(r))) return { ok: false, error: 'Este recusado não é um pagamento sem reserva.' };
  const p = paymentOf(r.event)!;
  if (inFlight.has(p.idempotency_key!)) return { ok: false, error: 'A reserva deste pagamento está sendo pedida agora: aguarde terminar e tente de novo.' };
  const pin = st.verifyManagerPin(auth, { orderId: p.order_id, action: 'CLAIM_RELEASED_REFUNDED' });
  if (!pin.ok) return { ok: false, error: pin.error };
  const w = st.withdrawUnacceptedPayment(p.idempotency_key!, `${RECOVERY_REASON}: ${auth.reason.trim()}`);
  if (!w.ok) return { ok: false, error: w.error };
  // A reserva que a recuperação pediu (aberta, ou sem resposta) não vale mais: sai do servidor pelo segredo (a
  // pendência, com o segredo, fica gravada até terminar) e então do registro.
  const own = localClaim(p.idempotency_key!);
  if (own?.terms?.recovery && own.release_token) {
    const key = p.idempotency_key!;
    void release(key, p.order_id, `${RECOVERY_REASON}: pagamento retirado pelo gerente`, own.release_token, own.state !== 'settled')
      .then((out) => { if (out.ok) endLocalClaim(key); })
      .catch(() => undefined);
  }
  const reason = `${w.data.nfceIssued ? `${NFCE_ISSUED_NOTE} ` : ''}A nuvem não aceitou o pagamento (${r.message}): ele foi retirado desta conta pelo gerente. ${refundText(p)}`;
  setReviewHold({
    order_id: p.order_id, amount: p.amount, reason, code: 'PAYMENT_REJECTED', refund: p.method === 'CASH' ? 'CASH' : 'TERMINAL',
    ...(p.method === 'CREDIT' || p.method === 'DEBIT' || p.method === 'PIX' ? { method: p.method } : {}),
    ...(p.acquirer !== 'CASH_DESK' ? { acquirer: holdAcquirer(p.acquirer) } : {}),
    terminal_id: p.terminal_id, terminal_serial: p.terminal_serial, idempotency_key: p.idempotency_key!,
  });
  return { ok: true, message: reason };
}
