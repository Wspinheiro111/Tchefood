/**
 * Etapa 0 — laço de sincronização: a cada 5 s, com internet e sessão da nuvem,
 * envia a fila na ordem e confirma o que o servidor aceitou. Com a fila vazia, a
 * cada minuto lê os cadastros da nuvem (mudanças feitas em outro aparelho).
 */
import { useEffect } from 'react';
import { useTcheStore } from '../../store/useTcheStore';
import { flushOutbox, needsRefresh, refreshDevice, type FetchLike, type SyncConfig } from './supabaseSync';
import { fetchCloudSnapshot } from './cloudPull';

const INTERVAL_MS = 5_000;
/** Leitura dos cadastros da nuvem (só com a fila vazia: o que é daqui sobe antes). */
export const PULL_EVERY_MS = 60_000;
let running = false;

const browserFetch: FetchLike = (url, init) => fetch(url, init);

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
  if (running) return;
  const state = useTcheStore.getState();
  const session = state.cloud;
  if (!session) return;
  const wantsPull = opts.forcePull === true || pullDue(state.pullStatus?.last_pull_at, Date.now());
  if (state.outbox.length === 0 && !wantsPull) return;
  running = true;
  try {
    let token = session.access_token;
    if (needsRefresh(session.expires_at)) {
      try {
        const t = await refreshDevice(session.url, session.anon_key, session.refresh_token, fetchFn);
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

export function useCloudSync(online: boolean): void {
  const hasSession = useTcheStore((s) => s.cloud !== null);
  useEffect(() => {
    if (!online || !hasSession) return;
    void syncOnce();
    const timer = setInterval(() => void syncOnce(), INTERVAL_MS);
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
    const t = await refreshDevice(session.url, session.anon_key, session.refresh_token, fetchFn);
    const res = useTcheStore.getState().setCloudSession({ ...session, ...t });
    if (!res.ok) return null;
    return { url: session.url, anonKey: session.anon_key, accessToken: t.access_token };
  } catch {
    return null;
  }
}
