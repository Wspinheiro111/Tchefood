/**
 * Etapa 0 — laço de sincronização: a cada 5 s, com internet e sessão da nuvem,
 * envia a fila na ordem e confirma o que o servidor aceitou. Com a fila vazia, a
 * cada minuto lê os cadastros da nuvem (mudanças feitas em outro aparelho).
 */
import { useEffect } from 'react';
import { useTcheStore } from '../../store/useTcheStore';
import { flushOutbox, needsRefresh, recordKeys, refreshDevice, type FetchLike, type SyncConfig } from './supabaseSync';
import { fetchCloudSnapshot } from './cloudPull';
import type { SyncEvent, UUID } from '../../types';

const INTERVAL_MS = 5_000;
/** Leitura dos cadastros da nuvem (só com a fila vazia: o que é daqui sobe antes). */
export const PULL_EVERY_MS = 60_000;
let running = false;
/** A rodada em andamento (quem precisa da conta sincronizada espera por ela; ver ensureOrderSynced). */
let current: Promise<void> | null = null;

const browserFetch: FetchLike = (url, init) => fetch(url, init);

/**
 * Uma renovação do token por vez, dividida entre o laço e a cobrança na Point: duas renovações com o mesmo
 * refresh token (uma largada pelo prazo da cobrança, outra do laço) podem derrubar a sessão do aparelho.
 */
let refreshing: { token: string; promise: ReturnType<typeof refreshDevice> } | null = null;
function sharedRefresh(session: { url: string; anon_key: string; refresh_token: string }, fetchFn: FetchLike): ReturnType<typeof refreshDevice> {
  if (refreshing && refreshing.token === session.refresh_token) return refreshing.promise;
  const promise = refreshDevice(session.url, session.anon_key, session.refresh_token, fetchFn);
  const entry = { token: session.refresh_token, promise };
  refreshing = entry;
  const clear = () => {
    if (refreshing === entry) refreshing = null;
  };
  promise.then(clear, clear);
  return promise;
}

function pullDue(lastPullAt: string | null | undefined, nowMs: number): boolean {
  return !lastPullAt || nowMs - Date.parse(lastPullAt) >= PULL_EVERY_MS;
}

/** Lê os cadastros da nuvem e aplica (o store deixa como está o que ainda não subiu daqui). */
async function pullOnce(cfg: SyncConfig, fetchFn: FetchLike): Promise<void> {
  const tenantId = useTcheStore.getState().tenant.id;
  try {
    const snapshot = await fetchCloudSnapshot(cfg, tenantId, fetchFn);
    const st = useTcheStore.getState();
    // Trocou de loja ou desconectou enquanto lia: descarta.
    if (!st.cloud || st.tenant.id !== tenantId) return;
    const r = st.applyCloudSnapshot(snapshot);
    if (!r.ok) st.setPullError(r.error);
  } catch (e) {
    useTcheStore.getState().setPullError((e as Error).message);
  }
}

/**
 * Uma rodada: envia a fila e, com ela vazia, lê os cadastros da nuvem quando passou
 * um minuto da última leitura (ou sempre, com forcePull). Exportada para o botão
 * "Sincronizar agora" e para testes.
 */
export async function syncOnce(fetchFn: FetchLike = browserFetch, opts: { forcePull?: boolean } = {}): Promise<void> {
  return startRound(fetchFn, opts.forcePull === true ? 'force' : 'due');
}

/** pull: 'due' = lê a nuvem se passou um minuto; 'force' = lê sempre; 'never' = só sobe a fila (cobrança na Point). */
async function startRound(fetchFn: FetchLike, pull: 'due' | 'force' | 'never'): Promise<void> {
  if (running) return;
  const state = useTcheStore.getState();
  const session = state.cloud;
  if (!session) return;
  const wantsPull = pull === 'force' || (pull === 'due' && pullDue(state.pullStatus?.last_pull_at, Date.now()));
  if (state.outbox.length === 0 && !wantsPull) return;
  running = true;
  const round = runRound(session, fetchFn, wantsPull);
  current = round;
  try {
    await round;
  } finally {
    if (current === round) current = null;
  }
}

async function runRound(session: NonNullable<ReturnType<typeof useTcheStore.getState>['cloud']>, fetchFn: FetchLike, wantsPull: boolean): Promise<void> {
  try {
    let token = session.access_token;
    if (needsRefresh(session.expires_at)) {
      try {
        const t = await sharedRefresh(session, fetchFn);
        const res = useTcheStore.getState().setCloudSession({ ...session, ...t });
        if (!res.ok) {
          useTcheStore.getState().setSyncError(res.error, null);
          return;
        }
        token = t.access_token;
      } catch (e) {
        useTcheStore.getState().setSyncError((e as Error).message, null);
        return;
      }
    }
    const cfg: SyncConfig = { url: session.url, anonKey: session.anon_key, accessToken: token };
    const { outbox: events, syncRejected } = useTcheStore.getState();
    if (events.length === 0) {
      await pullOnce(cfg, fetchFn);
      return;
    }
    const held = (syncRejected ?? []).map((r) => r.event);
    const result = await flushOutbox(events, cfg, fetchFn, 50, held);
    const st = useTcheStore.getState();
    st.ackSyncedEvents(result.sent);
    // Recusados saem da fila (o resto continua subindo) e ficam na lista para revisão.
    st.rejectSyncEvents(result.rejected);
    const first = result.rejected[0];
    if (result.retryLater) st.setSyncError(result.retryLater, null);
    else if (first) {
      const more = result.rejected.length > 1 ? ` (+${result.rejected.length - 1})` : '';
      st.setSyncError(`Servidor recusou um evento${more} (HTTP ${first.status}): ${first.message}`, null);
    }
    // Fila zerou nesta rodada: lê a nuvem agora, se estava na hora.
    if (wantsPull && useTcheStore.getState().outbox.length === 0 && !result.retryLater) await pullOnce(cfg, fetchFn);
  } finally {
    running = false;
  }
}

/** Evento que mexe nesta conta: a própria conta ou linha dela (item, pagamento, cashback, desconto). */
function touchesOrder(event: SyncEvent, orderId: UUID): boolean {
  // As mesmas ligações que a fila usa para segurar eventos da conta (recordKeys: a conta, linhas dela, mesa,
  // liberação e cashback que dependem dela). Item que saiu desta conta: a conta de origem sobe recalculada
  // (evento da própria conta), e o servidor ainda confere o saldo.
  return recordKeys(event).includes(`orders:${orderId}`) || event.payload?.order_id === orderId;
}

export type OrderSyncCheck = { ok: true; balance_cents: number } | { ok: false; reason: string };

/** Rodadas de envio que a preparação da cobrança tenta antes de desistir (o driver ainda põe prazo). */
const ENSURE_ROUNDS = 3;

/**
 * Antes de cobrar na maquininha pela nuvem (Point Smart): prova que o servidor tem esta conta como o aparelho
 * a mostra. Espera a rodada de sincronização em andamento (nunca toma "já está rodando" por sucesso), sobe a
 * fila e só responde ok quando NENHUM evento desta conta ficou na fila nem foi recusado pela nuvem. Devolve o
 * saldo da conta no aparelho, em centavos: o servidor confere que é o mesmo dele ao abrir a cobrança
 * (tchefood_open_terminal_charge), então uma diferença que passe por aqui ainda é barrada lá.
 */
export async function ensureOrderSynced(orderId: UUID, fetchFn: FetchLike = browserFetch): Promise<OrderSyncCheck> {
  const fail = (reason: string): OrderSyncCheck => ({ ok: false, reason });
  for (let round = 0; ; round += 1) {
    // Rodada de outro chamador em andamento: espera ela terminar (pode ter começado depois da anterior).
    while (current) await current.catch(() => undefined);
    const st = useTcheStore.getState();
    if (!st.cloud) return fail('Conecte a loja à nuvem para cobrar na Point Smart.');
    if ((st.syncRejected ?? []).some((r) => touchesOrder(r.event, orderId))) {
      return fail('A nuvem recusou uma alteração desta conta. Resolva em Retaguarda › Nuvem antes de cobrar na Point Smart.');
    }
    const order = st.orders.find((o) => o.id === orderId);
    if (!order) return fail('Conta não encontrada neste aparelho.');
    if (!st.outbox.some((e) => touchesOrder(e, orderId))) {
      const cents = Math.round(order.remaining_balance * 100);
      if (!Number.isSafeInteger(cents) || cents < 0) return fail('Saldo da conta inválido neste aparelho.');
      return { ok: true, balance_cents: cents };
    }
    if (round >= ENSURE_ROUNDS) return fail('Ainda há alterações desta conta esperando a nuvem. Nada foi cobrado; tente de novo.');
    // Só sobe a fila: a leitura dos cadastros não entra no prazo da cobrança.
    await startRound(fetchFn, 'never');
  }
}

export function useCloudSync(online: boolean): void {
  const hasSession = useTcheStore((s) => s.cloud !== null);
  useEffect(() => {
    if (!online || !hasSession) return;
    // Liberações de reserva que não chegaram ao servidor (maquininha recusou sem internet): tenta ao abrir o
    // app e a cada volta do laço (a própria função espera 30 s entre tentativas). Import tardio: o módulo da
    // reserva usa este para a sessão.
    // Reservas já pagas aqui: batimento até o servidor consumir (claimSupervisor); sobrevive a fechar a tela e
    // reabrir o app, porque lê o registro persistido.
    const retryReleases = () => {
      void import('../payments/paymentClaim').then((m) => m.retryPendingClaimReleases()).catch(() => undefined);
      void import('../payments/claimSupervisor').then((m) => m.superviseSettledClaims()).catch(() => undefined);
    };
    void syncOnce();
    retryReleases();
    const timer = setInterval(() => {
      void syncOnce();
      retryReleases();
    }, INTERVAL_MS);
    return () => clearInterval(timer);
  }, [online, hasSession]);
}

/** URL e chave pública do projeto Supabase vindas do build (.env). */
export function defaultCloudConfig(): { url: string; anonKey: string } {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  return { url: env.VITE_SUPABASE_URL ?? '', anonKey: env.VITE_SUPABASE_ANON_KEY ?? '' };
}

/**
 * Sessão da nuvem com token válido para chamar uma Edge Function agora (cobrança na
 * Point Smart). Renova o token quando está para vencer. null = loja não conectada
 * ou renovação recusada.
 */
export async function freshCloudConfig(fetchFn: FetchLike = browserFetch): Promise<SyncConfig | null> {
  const session = useTcheStore.getState().cloud;
  if (!session) return null;
  if (!needsRefresh(session.expires_at)) return { url: session.url, anonKey: session.anon_key, accessToken: session.access_token };
  try {
    const t = await sharedRefresh(session, fetchFn);
    const res = useTcheStore.getState().setCloudSession({ ...session, ...t });
    if (!res.ok) return null;
    return { url: session.url, anonKey: session.anon_key, accessToken: t.access_token };
  } catch {
    return null;
  }
}
