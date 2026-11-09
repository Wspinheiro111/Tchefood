/**
 * Etapa 0 — laço de sincronização: a cada 5 s, com internet e sessão da nuvem,
 * envia a fila na ordem e confirma o que o servidor aceitou.
 */
import { useEffect } from 'react';
import { useTcheStore } from '../../store/useTcheStore';
import { flushOutbox, needsRefresh, refreshDevice, type FetchLike } from './supabaseSync';

const INTERVAL_MS = 5_000;
let running = false;

const browserFetch: FetchLike = (url, init) => fetch(url, init);

/** Uma rodada de envio. Exportada para o botão "Sincronizar agora" e para testes. */
export async function syncOnce(fetchFn: FetchLike = browserFetch): Promise<void> {
  if (running) return;
  const state = useTcheStore.getState();
  const session = state.cloud;
  if (!session || state.outbox.length === 0) return;
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
    const { outbox: events, syncRejected } = useTcheStore.getState();
    const held = (syncRejected ?? []).map((r) => r.event);
    const result = await flushOutbox(events, { url: session.url, anonKey: session.anon_key, accessToken: token }, fetchFn, 50, held);
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
