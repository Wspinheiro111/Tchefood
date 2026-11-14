/**
 * Etapa 0 — laço de sincronização: a cada 5 s, com internet e sessão da nuvem,
 * envia a fila na ordem e confirma o que o servidor aceitou. Com a fila vazia, lê da
 * nuvem o que outro aparelho mudou: as contas e a ocupação das mesas a cada 10 s
 * (src/lib/sync/orderPull.ts) e os cadastros a cada minuto.
 */
import { useEffect } from 'react';
import { useTcheStore } from '../../store/useTcheStore';
import { flushOutbox, needsRefresh, refreshDevice, type FetchLike, type SyncConfig } from './supabaseSync';
import { fetchCloudSnapshot } from './cloudPull';
import { fetchCloudOrders, missingCatalog } from './orderPull';

const INTERVAL_MS = 5_000;
/** Leitura dos cadastros da nuvem (só com a fila vazia: o que é daqui sobe antes). */
export const PULL_EVERY_MS = 60_000;
/** Leitura das contas e mesas da nuvem (também só com a fila vazia). */
export const ORDERS_PULL_EVERY_MS = 10_000;
let running = false;

const browserFetch: FetchLike = (url, init) => fetch(url, init);

function pullDue(lastPullAt: string | null | undefined, nowMs: number, everyMs: number = PULL_EVERY_MS): boolean {
  return !lastPullAt || !(nowMs - Date.parse(lastPullAt) < everyMs);
}

/** Lê os cadastros da nuvem e aplica (o store deixa como está o que ainda não subiu daqui). */
async function pullCatalog(cfg: SyncConfig, fetchFn: FetchLike): Promise<boolean> {
  const tenantId = useTcheStore.getState().tenant.id;
  try {
    const snapshot = await fetchCloudSnapshot(cfg, tenantId, fetchFn);
    const st = useTcheStore.getState();
    // Trocou de loja ou desconectou enquanto lia: descarta.
    if (!st.cloud || st.tenant.id !== tenantId) return false;
    const r = st.applyCloudSnapshot(snapshot);
    if (!r.ok) st.setPullError(r.error);
    return r.ok;
  } catch (e) {
    useTcheStore.getState().setPullError((e as Error).message);
    return false;
  }
}

/**
 * Lê as contas e a ocupação das mesas e aplica (a nuvem manda no dinheiro; conta com
 * mudança daqui pendente fica como está). Conta com produto ou mesa que este aparelho
 * ainda não tem lê os cadastros antes, para a conta não aparecer com item sem nome.
 */
async function pullOrders(cfg: SyncConfig, fetchFn: FetchLike, catalogFresh: boolean): Promise<void> {
  const tenantId = useTcheStore.getState().tenant.id;
  try {
    const snapshot = await fetchCloudOrders(cfg, tenantId, fetchFn);
    let st = useTcheStore.getState();
    if (!st.cloud || st.tenant.id !== tenantId) return;
    if (!catalogFresh && missingCatalog(snapshot, { productIds: st.products.map((p) => p.id), tableIds: st.tables.map((t) => t.id) })) {
      await pullCatalog(cfg, fetchFn);
      st = useTcheStore.getState();
      if (!st.cloud || st.tenant.id !== tenantId) return;
    }
    // Uma mudança deste aparelho pode ter entrado na fila enquanto a leitura voltava: o
    // store confere a fila de agora e deixa essa conta como está.
    const r = st.applyCloudOrders(snapshot);
    if (!r.ok) st.setPullError(r.error);
  } catch (e) {
    useTcheStore.getState().setPullError((e as Error).message);
  }
}

/** Leituras da nuvem que estão na hora (ou todas, com force). */
async function pullOnce(cfg: SyncConfig, fetchFn: FetchLike, due: { catalog: boolean; orders: boolean }): Promise<void> {
  const catalogFresh = due.catalog ? await pullCatalog(cfg, fetchFn) : false;
  if (due.orders) await pullOrders(cfg, fetchFn, catalogFresh);
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
  const nowMs = Date.now();
  const due = {
    catalog: opts.forcePull === true || pullDue(state.pullStatus?.last_pull_at, nowMs),
    orders: opts.forcePull === true || pullDue(state.pullStatus?.last_orders_pull_at, nowMs, ORDERS_PULL_EVERY_MS),
  };
  const wantsPull = due.catalog || due.orders;
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
      await pullOnce(cfg, fetchFn, due);
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
    if (wantsPull && useTcheStore.getState().outbox.length === 0 && !result.retryLater) await pullOnce(cfg, fetchFn, due);
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
