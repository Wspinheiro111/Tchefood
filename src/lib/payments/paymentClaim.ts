/**
 * Reserva de pagamento no servidor antes de receber (decisão do Will, 14/11/2026; docs/integracoes/r6-spec.md C1).
 *
 * Loja com Point Smart (alguma maquininha MERCADO_PAGO em `terminals`): todo pagamento que não é cobrado na
 * Point (dinheiro, Stone, PagBank, Pix manual, ficha rápida, retirada) pede ANTES a reserva no servidor
 * (tchefood_claim_payment), com a MESMA chave do pagamento. O servidor trava a conta, confere o saldo e o que
 * a Point e outras reservas já seguram; só depois o caixa recebe ou manda para a maquininha.
 *
 * Sem internet, sem sessão ou sem resposta no prazo: não recebe (nunca cai para "cobra assim mesmo").
 * Loja sem Point: nada muda (nenhuma chamada).
 */
import type { PosTerminal, UUID } from '../../types';
import type { FetchLike, SyncConfig } from '../sync/supabaseSync';
import type { OrderSyncCheck } from '../sync/useCloudSync';
import { addPendingRelease, endLocalClaim, pendingReleases, removePendingRelease } from './claimLedger';

export const CLAIM_TIMEOUT_MS = 10_000;

/** TF010 claim_required: o servidor recusa pagamento sem reserva numa loja com Point. */
export const CLAIM_REQUIRED_ERROR = 'Esta loja tem a Point: o pagamento precisa da reserva no servidor.';

/** Motivo mínimo da liberação pelo gerente (tchefood_release_payment_claim_manager). */
export const MANAGER_RELEASE_MIN_REASON = 10;

export const CLAIM_OFFLINE_ERROR =
  'Sem internet: com a Point na loja, só dá para receber com o servidor confirmando. Tente de novo quando voltar a conexão.';

export type ClaimMethod = 'CASH' | 'CREDIT' | 'DEBIT' | 'PIX';
export type ClaimAcquirer = 'CASH_DESK' | 'STONE' | 'PAGBANK';

/** Mensagem de cada recusa do banco (SQLSTATE de tchefood_claim_payment). */
export const CLAIM_ERRORS: Record<string, string> = {
  TF001: 'O servidor não encontrou esta conta. Nada foi recebido; aguarde a sincronização e tente de novo.',
  TF002: 'Esta conta já está fechada no servidor. Nada foi recebido.',
  TF003: 'O valor passa do saldo livre desta conta no servidor (há cobrança na Point ou outro pagamento reservando). Nada foi recebido.',
  TF004: 'O servidor não reconhece o operador como da equipe ativa desta loja. Entre de novo com o seu PIN. Nada foi recebido.',
  TF006: 'O servidor recusou a reserva: dados do pagamento inválidos. Nada foi recebido.',
  TF008: 'O saldo desta conta no servidor é diferente do deste aparelho. Aguarde a sincronização e tente de novo. Nada foi recebido.',
  TF009: 'A chave deste pagamento já está em uso por outra cobrança. Nada foi recebido; tente de novo.',
  TF010: CLAIM_REQUIRED_ERROR,
};

export interface PaymentClaim {
  id: string;
  idempotency_key: string;
  status: 'open';
  amount_cents: number;
}

export type ClaimResult =
  | { ok: true; claim: PaymentClaim }
  /** offline: sem rede, sem sessão ou sem resposta no prazo. code: SQLSTATE da recusa do banco, quando houve. */
  | { ok: false; offline?: true; code?: string; error: string };

export interface ClaimDeps {
  /** Sessão da nuvem com token válido (useCloudSync.freshCloudConfig); null = sem sessão. */
  config: () => Promise<SyncConfig | null>;
  fetch: FetchLike;
  /** Sobe a fila da conta e devolve o saldo que o servidor tem (useCloudSync.ensureOrderSynced). */
  prepareOrder: (orderId: UUID) => Promise<OrderSyncCheck>;
  /** Quem está no caixa. */
  staff: () => Promise<string | null>;
  /** Resolve depois de ms (prazo de cada etapa). */
  timer: (ms: number) => Promise<void>;
  /** Espera entre tentativas da liberação (padrão: o mesmo timer). */
  sleep?: (ms: number) => Promise<void>;
}

export function defaultClaimDeps(): ClaimDeps {
  return {
    config: async () => (await import('../sync/useCloudSync')).freshCloudConfig(),
    fetch: (url, init) => fetch(url, init),
    prepareOrder: async (orderId) => (await import('../sync/useCloudSync')).ensureOrderSynced(orderId),
    staff: async () => (await import('../../store/useTcheStore')).useTcheStore.getState().currentUserId,
    timer: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

/**
 * A loja tem Point Smart (maquininha MERCADO_PAGO cadastrada): todo pagamento fora dela pede a reserva antes.
 * Falha fechada: aparelho ligado à nuvem que nunca leu as maquininhas de lá (não sabe se a loja tem Point)
 * também pede (o servidor recusa sem reserva numa loja com Point, TF010).
 */
export function requirePaymentClaim(store: {
  terminals: ReadonlyArray<Pick<PosTerminal, 'acquirer'>>;
  cloud?: unknown;
  pullStatus?: { last_pull_at: string | null } | null;
}): boolean {
  if (store.terminals.some((t) => t.acquirer === 'MERCADO_PAGO')) return true;
  return Boolean(store.cloud) && !store.pullStatus?.last_pull_at;
}

/** `promise` com prazo: erro ou prazo vencido viram `{ done: false }`. */
async function within<T>(promise: Promise<T>, deps: ClaimDeps): Promise<{ done: true; value: T } | { done: false }> {
  const safe = promise.then((value) => ({ done: true as const, value }), () => ({ done: false as const }));
  return Promise.race([safe, deps.timer(CLAIM_TIMEOUT_MS).then(() => ({ done: false as const }))]);
}

function rpcUrl(cfg: SyncConfig, fn: string): string {
  return `${cfg.url.replace(/\/+$/, '')}/rest/v1/rpc/${fn}`;
}

function rpcHeaders(cfg: SyncConfig): Record<string, string> {
  return { apikey: cfg.anonKey, Authorization: `Bearer ${cfg.accessToken}`, 'Content-Type': 'application/json' };
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

type RpcOutcome =
  | { kind: 'ok'; body: Record<string, unknown> | null }
  | { kind: 'offline' }
  | { kind: 'refused'; code: string | null; message: string };

/** POST numa RPC do PostgREST com prazo. Rede, prazo, 401, 408, 429 e 5xx = sem resposta do servidor. */
async function callRpc(cfg: SyncConfig, fn: string, body: Record<string, unknown>, deps: ClaimDeps): Promise<RpcOutcome> {
  const out = await within((async () => {
    const res = await deps.fetch(rpcUrl(cfg, fn), { method: 'POST', headers: rpcHeaders(cfg), body: JSON.stringify(body) });
    return { res, text: await res.text() };
  })(), deps);
  if (!out.done) return { kind: 'offline' };
  const { res, text } = out.value;
  if (res.ok) return { kind: 'ok', body: parseObject(text) };
  if (res.status >= 500 || res.status === 401 || res.status === 408 || res.status === 429) return { kind: 'offline' };
  // PostgREST: { code: "<SQLSTATE>", message, details, hint }.
  const err = parseObject(text);
  return {
    kind: 'refused',
    code: err && typeof err.code === 'string' ? err.code : null,
    message: err && typeof err.message === 'string' ? err.message : `HTTP ${res.status}`,
  };
}

export interface ClaimInput {
  orderId: UUID;
  /** A mesma idempotency_key do pagamento que vai ser registrado (ou mandado para a maquininha). */
  key: string;
  method: ClaimMethod;
  acquirer: ClaimAcquirer;
  /** Em reais. */
  amount: number;
}

/**
 * Reserva o pagamento no servidor (tchefood_claim_payment). Antes, sobe a fila da conta e usa o saldo
 * comprovado (ensureOrderSynced) como saldo esperado: diferença com o do servidor = TF008.
 * Só `{ ok: true }` libera receber.
 */
export async function claimPayment(input: ClaimInput, deps: ClaimDeps = defaultClaimDeps()): Promise<ClaimResult> {
  const offline = (): ClaimResult => ({ ok: false, offline: true, error: CLAIM_OFFLINE_ERROR });
  const amountCents = Math.round(input.amount * 100);
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) return { ok: false, code: 'TF006', error: CLAIM_ERRORS.TF006! };
  const staff = await deps.staff().catch(() => null);
  if (!staff) return { ok: false, error: 'Entre com o seu PIN para receber.' };
  const session = await within(deps.config(), deps);
  if (!session.done || !session.value) return offline();
  const cfg = session.value;
  const sync = await within(deps.prepareOrder(input.orderId), deps);
  if (!sync.done) return offline();
  const prepared = sync.value;
  if (!prepared.ok) return { ok: false, error: prepared.reason };
  const balance = prepared.balance_cents;
  if (!Number.isSafeInteger(balance) || balance < 0) return { ok: false, error: 'Saldo da conta inválido neste aparelho.' };

  const out = await callRpc(cfg, 'tchefood_claim_payment', {
    p_key: input.key,
    p_order: input.orderId,
    p_method: input.method,
    p_acquirer: input.acquirer,
    p_amount_cents: amountCents,
    p_expected_balance_cents: balance,
    p_staff: staff,
  }, deps);
  if (out.kind === 'offline') return offline();
  if (out.kind === 'refused') {
    const known = out.code ? CLAIM_ERRORS[out.code] : undefined;
    return { ok: false, ...(out.code ? { code: out.code } : {}), error: known ?? `O servidor recusou a reserva: ${out.message}. Nada foi recebido.` };
  }
  const b = out.body;
  // Só a reserva desta chave, aberta e com este valor, libera.
  if (!b || typeof b.id !== 'string' || b.idempotency_key !== input.key || b.status !== 'open' || Number(b.amount_cents) !== amountCents) {
    return { ok: false, error: 'O servidor não confirmou a reserva deste pagamento. Nada foi recebido; tente de novo.' };
  }
  return { ok: true, claim: { id: b.id, idempotency_key: input.key, status: 'open', amount_cents: amountCents } };
}

export type ReleaseResult =
  | { ok: true }
  /** transient: sem resposta do servidor (vale tentar de novo); senão o servidor recusou. */
  | { ok: false; transient: boolean; error: string };

/** Uma tentativa de liberar pelo aparelho que criou a reserva (tchefood_release_payment_claim). Nunca lança. */
export async function releasePaymentClaim(key: string, reason: string, deps: ClaimDeps = defaultClaimDeps()): Promise<ReleaseResult> {
  try {
    const staff = await deps.staff().catch(() => null);
    if (!staff) return { ok: false, transient: false, error: 'Sem operador identificado para liberar a reserva.' };
    const session = await within(deps.config(), deps);
    if (!session.done || !session.value) return { ok: false, transient: true, error: CLAIM_OFFLINE_ERROR };
    const cfg = session.value;
    const text = reason.trim().length >= 3 ? reason.trim() : 'Pagamento não recebido';
    const out = await callRpc(cfg, 'tchefood_release_payment_claim', { p_key: key, p_staff: staff, p_reason: text.slice(0, 500) }, deps);
    if (out.kind === 'offline') return { ok: false, transient: true, error: CLAIM_OFFLINE_ERROR };
    // TF005: não há reserva com a chave (nada a liberar). TF007: já virou pagamento (não reserva mais à toa).
    if (out.kind === 'refused' && (out.code === 'TF005' || out.code === 'TF007')) return { ok: true };
    if (out.kind === 'refused') return { ok: false, transient: false, error: `O servidor não liberou a reserva: ${out.message}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, transient: true, error: (e as Error).message };
  }
}

/** Esperas entre as tentativas da liberação depois de uma recusa da maquininha. */
export const RELEASE_BACKOFF_MS = [1_000, 3_000];

/**
 * Nada foi cobrado (maquininha recusou, dinheiro não registrado): libera a reserva, com novas tentativas.
 * Se ainda falhar, guarda a liberação pendente neste aparelho (o laço de sincronização tenta de novo) e a
 * reserva aparece na lista de reservas presas para o gerente. Sempre encerra o registro local da cobrança.
 */
export async function releaseClaimAfterNoCharge(key: string, orderId: string, reason: string, deps: ClaimDeps = defaultClaimDeps()): Promise<ReleaseResult> {
  const sleep = deps.sleep ?? deps.timer;
  let out = await releasePaymentClaim(key, reason, deps);
  for (let i = 0; !out.ok && out.transient && i < RELEASE_BACKOFF_MS.length; i += 1) {
    await sleep(RELEASE_BACKOFF_MS[i]!);
    out = await releasePaymentClaim(key, reason, deps);
  }
  if (out.ok) removePendingRelease(key);
  else addPendingRelease({ key, order_id: orderId, reason, last_error: out.error });
  endLocalClaim(key);
  return out;
}

const RETRY_EVERY_MS = 30_000;
let lastRetry = 0;

/** Tenta de novo as liberações pendentes deste aparelho (abrir o app e laço de sincronização). */
export async function retryPendingClaimReleases(deps: ClaimDeps = defaultClaimDeps(), nowMs = Date.now(), force = false): Promise<number> {
  const list = pendingReleases();
  if (list.length === 0 || (!force && nowMs - lastRetry < RETRY_EVERY_MS)) return 0;
  lastRetry = nowMs;
  let released = 0;
  for (const p of list) {
    const out = await releasePaymentClaim(p.key, p.reason, deps);
    if (out.ok) {
      removePendingRelease(p.key);
      released += 1;
    } else {
      addPendingRelease({ key: p.key, order_id: p.order_id, reason: p.reason, last_error: out.error });
    }
  }
  return released;
}

export type ManagerReleaseResult =
  | { ok: true }
  /** pin: PIN de gerente recusado ou bloqueado (a função devolveu NULL). */
  | { ok: false; pin?: true; error: string };

/**
 * Liberação pelo gerente (tchefood_release_payment_claim_manager): reserva presa de outro aparelho, ou a
 * conferência do extrato da Stone/PagBank. PIN e motivo (10+) conferidos no servidor, que grava o registro.
 * Reserva que não existe ou já liberada contam como liberadas.
 */
export async function releasePaymentClaimManager(key: string, managerPin: string, reason: string, deps: ClaimDeps = defaultClaimDeps()): Promise<ManagerReleaseResult> {
  if (reason.trim().length < MANAGER_RELEASE_MIN_REASON) return { ok: false, error: `Informe o motivo (mínimo ${MANAGER_RELEASE_MIN_REASON} caracteres).` };
  if (!/^\d{4,8}$/.test(managerPin)) return { ok: false, pin: true, error: 'Digite o PIN do gerente.' };
  try {
    const staff = await deps.staff().catch(() => null);
    if (!staff) return { ok: false, error: 'Sessão expirada. Entre com o seu PIN.' };
    const session = await within(deps.config(), deps);
    if (!session.done || !session.value) return { ok: false, error: CLAIM_OFFLINE_ERROR };
    const out = await callRpc(session.value, 'tchefood_release_payment_claim_manager', {
      p_key: key, p_staff: staff, p_manager_pin: managerPin, p_reason: reason.trim().slice(0, 500),
    }, deps);
    if (out.kind === 'offline') return { ok: false, error: CLAIM_OFFLINE_ERROR };
    if (out.kind === 'refused') {
      if (out.code === 'TF005') return { ok: true };
      if (out.code === 'TF007') return { ok: false, error: 'Esta reserva já virou pagamento: não há o que liberar.' };
      return { ok: false, error: `O servidor não liberou a reserva: ${out.message}` };
    }
    if (!out.body) return { ok: false, pin: true, error: 'PIN de gerente incorreto ou bloqueado. Nada foi liberado.' };
    if (out.body.status !== 'released') return { ok: false, error: 'O servidor não confirmou a liberação.' };
    removePendingRelease(key);
    endLocalClaim(key);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
