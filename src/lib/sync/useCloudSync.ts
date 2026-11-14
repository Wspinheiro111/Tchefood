/**
 * Etapa 0 — laço de sincronização: a cada 5 s, com internet e sessão da nuvem,
 * envia a fila na ordem e confirma o que o servidor aceitou. Com a fila vazia, a
 * cada minuto lê os cadastros da nuvem (mudanças feitas em outro aparelho).
 */
import { useEffect } from 'react';
import { useTcheStore } from '../../store/useTcheStore';
import { flushOutbox, needsRefresh, refreshDevice, type FetchLike, type SyncConfig } from './supabaseSync';
import { fetchCloudSnapshot } from './cloudPull';
import { dueNfceCalls, dueNfceOrders, requestNfceEmission } from './nfceEmission';
import type { CloudSession } from '../../store/useTcheStore';

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
 * NFC-e real: pede/consulta na emit-nfce as comandas fechadas que já subiram inteiras
 * (no máximo 3 por rodada). A resposta só é gravada se o aparelho ainda é da mesma loja.
 */
async function emitDueNfce(cfg: SyncConfig, session: CloudSession, fetchFn: FetchLike): Promise<void> {
  // A rodada inteira fica presa à loja e ao projeto da sessão que a começou: as comandas são
  // escolhidas, pedidas e gravadas só enquanto o aparelho continua nessa mesma loja.
  const sameStore = () => {
    const st = useTcheStore.getState();
    return st.cloud !== null && st.cloud.tenant_id === session.tenant_id && st.cloud.url === session.url && st.tenant.id === session.tenant_id;
  };
  if (!sameStore()) return;
  for (const { orderId, mode } of dueNfceCalls(useTcheStore.getState(), Date.now())) {
    if (!sameStore() || !useTcheStore.getState().orders.some((o) => o.id === orderId && o.tenant_id === session.tenant_id)) return;
    const outcome = await requestNfceEmission(cfg, orderId, fetchFn, mode);
    if (!sameStore()) return;
    useTcheStore.getState().applyNfceOutcome(orderId, outcome);
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
  const wantsNfce = dueNfceOrders(state, Date.now(), 1).length > 0;
  if (state.outbox.length === 0 && !wantsPull && !wantsNfce) return;
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
      if (wantsPull) await pullOnce(cfg, fetchFn);
      await emitDueNfce(cfg, session, fetchFn);
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
    // Conta que acabou de subir inteira já pede a NFC-e nesta rodada.
    if (!result.retryLater) await emitDueNfce(cfg, session, fetchFn);
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
