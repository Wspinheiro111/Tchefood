/**
 * Etapa 0 — laço de sincronização: a cada 5 s, com internet e sessão da nuvem,
 * envia a fila na ordem e confirma o que o servidor aceitou. Lê da nuvem o que outro
 * aparelho mudou: as contas e a ocupação das mesas a cada 10 s, mesmo com a fila cheia
 * (src/lib/sync/orderPull.ts), e os cadastros a cada minuto, com a fila vazia.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useTcheStore, type PullSource, type PullStatus } from '../../store/useTcheStore';
import { flushOutbox, needsRefresh, refreshDevice, type FetchLike, type SyncConfig } from './supabaseSync';
import { fetchCloudSnapshot } from './cloudPull';
import { fetchCloudOrders, missingCatalog, orderIdsToReconcile, missingHalves, missingModifiers, skippedMessage } from './orderPull';

const INTERVAL_MS = 5_000;
/** Leitura dos cadastros da nuvem pela cadência normal (só com a fila vazia: o que é daqui sobe antes). */
export const PULL_EVERY_MS = 60_000;
/** Leitura das contas e mesas da nuvem (também com a fila cheia: veja syncOnce). */
export const ORDERS_PULL_EVERY_MS = 10_000;
/** Espera depois da 1ª falha da leitura das contas; dobra a cada falha seguida, até ORDERS_BACKOFF_MAX_MS. */
export const ORDERS_BACKOFF_BASE_MS = 10_000;
export const ORDERS_BACKOFF_MAX_MS = 120_000;
/** Leitura dos cadastros pedida pelas contas (cadastro que falta): no máximo uma por minuto por loja. */
export const CATALOG_REREAD_EVERY_MS = 60_000;
/** Contas sem atualizar da nuvem há mais que isto: aviso nas telas da equipe. */
export const ORDERS_STALE_MS = 60_000;
let running = false;

/**
 * Espera e limite por loja, só na memória (auditoria interna, rodada 8 do PR #54). Antes,
 * last_orders_pull_at só andava quando a leitura das contas dava certo: com a leitura falhando
 * ou recusada, toda batida de 5 s lia as contas de novo e, com cadastro faltando, também os
 * cadastros inteiros (umas 17 páginas), sem fim, em 3 ou 4 aparelhos no 4G. Depois de reabrir o
 * app começa do zero (no pior caso, uma tentativa a mais).
 */
interface PullLoopState {
  /**
   * Fim da última leitura das contas que falhou ou foi recusada: a espera conta de quando a
   * resposta voltou, senão uma leitura lenta (4G) comia a espera inteira (auditoria interna,
   * rodada 8 do PR #54).
   */
  lastOrdersFailureMs: number;
  /** Falhas seguidas da leitura das contas (zera quando dá certo). */
  ordersFailures: number;
  /** Início da última leitura dos cadastros pedida pelas contas (deu certo ou não). */
  lastCatalogRereadMs: number | null;
  /**
   * Erro da última leitura dos cadastros, já em português (null: deu certo ou ainda não leu).
   * Vai junto no aviso de cadastro faltando nas contas, que grava por cima do aviso dos cadastros
   * e escondia a causa (auditoria interna, rodada 8 do PR #54).
   */
  lastCatalogError: string | null;
}
const pullLoop = new Map<string, PullLoopState>();

function loopFor(tenantId: string): PullLoopState {
  let s = pullLoop.get(tenantId);
  if (!s) pullLoop.set(tenantId, (s = { lastOrdersFailureMs: 0, ordersFailures: 0, lastCatalogRereadMs: null, lastCatalogError: null }));
  return s;
}

/** Espera depois de `failures` falhas seguidas: 10 s × 2^(n-1), no máximo 2 min. */
export function ordersBackoffMs(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(ORDERS_BACKOFF_BASE_MS * 2 ** Math.min(failures - 1, 20), ORDERS_BACKOFF_MAX_MS);
}

/** Passou a espera da leitura das contas (relógio que voltou conta como passada). */
function ordersBackoffOver(tenantId: string, nowMs: number): boolean {
  const s = pullLoop.get(tenantId);
  if (!s || s.ordersFailures === 0) return true;
  const d = nowMs - s.lastOrdersFailureMs;
  return !(d >= 0 && d < ordersBackoffMs(s.ordersFailures));
}

/** Pode ler os cadastros por pedido das contas agora (relógio que voltou conta como pode). */
function catalogRereadAllowed(tenantId: string, nowMs: number): boolean {
  const last = pullLoop.get(tenantId)?.lastCatalogRereadMs;
  if (last == null) return true;
  const d = nowMs - last;
  return !(d >= 0 && d < CATALOG_REREAD_EVERY_MS);
}

/**
 * Lojas que já tiveram uma leitura das contas nesta abertura do app (deu certo ou não). Antes da
 * primeira, a faixa de contas paradas mostrava o horário gravado na abertura anterior ("há 900
 * min") por até 5 s (auditoria interna, rodada 8 do PR #54).
 */
const ordersRoundRan = new Set<string>();
const roundListeners = new Set<() => void>();

function markOrdersRoundRan(tenantId: string): void {
  if (ordersRoundRan.has(tenantId)) return;
  ordersRoundRan.add(tenantId);
  for (const l of roundListeners) l();
}

function subscribeOrdersRound(l: () => void): () => void {
  roundListeners.add(l);
  return () => roundListeners.delete(l);
}

/** Só para testes: zera a espera, o limite e as leituras desta abertura de todas as lojas (não mexe nos adicionais conferidos). */
export function resetPullLoopForTests(): void {
  pullLoop.clear();
  ordersRoundRan.clear();
  for (const l of roundListeners) l();
}

/** Aviso de rede da leitura da nuvem: só o texto em português, sem o do navegador. */
export const NETWORK_PULL_MESSAGE = 'Sem conexão com a nuvem. Tentando de novo.';
/** A nuvem ainda não tem a função de leitura das contas (migration não aplicada no banco). */
export const ORDERS_RPC_MISSING_MESSAGE = 'A nuvem ainda não tem a atualização das contas (migration). Chame o suporte.';

/** Falha de rede do fetch: TypeError com "Failed to fetch" (Chrome), "NetworkError…" (Firefox) ou "Load failed" (Safari). */
function isNetworkError(e: unknown): boolean {
  return e instanceof TypeError && /fetch|network|load failed/i.test(e.message);
}

/**
 * Texto em português do erro de uma leitura da nuvem (auditoria interna, rodada 8 do PR #54):
 * erro de rede vira só o aviso em português ("Failed to fetch" não diz nada à equipe), e a
 * função de leitura das contas que o banco não tem (HTTP 404, PGRST202: "Could not find the
 * function … in the schema cache") vira o pedido de suporte. Outro TypeError é erro de verdade e
 * aparece como veio.
 */
function pullErrorMessage(e: unknown, source: PullSource): string {
  if (isNetworkError(e)) return NETWORK_PULL_MESSAGE;
  const raw = e instanceof Error ? e.message : String(e);
  if (source === 'orders' && /PGRST202|Could not find the function|\bHTTP 404\b/i.test(raw)) return ORDERS_RPC_MISSING_MESSAGE;
  return raw;
}

/**
 * Grava o erro de uma leitura da nuvem. Erro de rede (o fetch rejeita com TypeError, "Failed to
 * fetch") não passa por cima de um aviso que já existe (por exemplo, o de cadastro faltando ou
 * de conta deixada de lado), e a mesma mensagem não é gravada de novo a cada batida
 * (auditoria interna, rodada 8 do PR #54). Sem internet de vez, o laço nem roda (useOnline) e a
 * faixa "Offline" já cobre.
 */
function reportPullError(e: unknown, source: PullSource): void {
  const network = isNetworkError(e);
  const message = pullErrorMessage(e, source);
  const st = useTcheStore.getState();
  const cur = st.pullStatus;
  if (cur?.last_error === message && (cur.last_error_source ?? 'catalog') === source) return;
  if (network && cur?.last_error) return;
  st.setPullError(message, source);
}

/**
 * Adicionais que continuaram faltando depois de uma leitura dos cadastros que começou depois
 * de a foto das contas que os trazia ser lida e deu certo, por loja (GPT, rodada 7 do PR #54):
 * apagados na nuvem ou aceitos pelo banco com PIN de gerente sem estar no cadastro. Não pedem
 * outra leitura; adicional novo, fora daqui, pede. Só na memória: depois de reabrir o app,
 * custa uma leitura dos cadastros.
 */
const checkedModifiers = new Map<string, Set<string>>();
const CHECKED_MODIFIERS_MAX = 2_000;

function checkedFor(tenantId: string): Set<string> {
  let set = checkedModifiers.get(tenantId);
  if (!set) checkedModifiers.set(tenantId, (set = new Set()));
  return set;
}

function markChecked(tenantId: string, ids: readonly string[]): void {
  const set = checkedFor(tenantId);
  for (const id of ids) set.add(id);
  // Teto: sai o mais antigo (no pior caso, uma leitura dos cadastros a mais).
  for (const id of set) {
    if (set.size <= CHECKED_MODIFIERS_MAX) break;
    set.delete(id);
  }
}

const browserFetch: FetchLike = (url, init) => fetch(url, init);

function pullDue(lastPullAt: string | null | undefined, nowMs: number, everyMs: number = PULL_EVERY_MS): boolean {
  // Diferença negativa (o relógio do aparelho voltou depois da última leitura) conta como vencida.
  const d = lastPullAt ? nowMs - Date.parse(lastPullAt) : NaN;
  return !(d >= 0 && d < everyMs);
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
    loopFor(tenantId).lastCatalogError = r.ok ? null : r.error;
    if (!r.ok) st.setPullError(r.error, 'catalog');
    return r.ok;
  } catch (e) {
    const st = useTcheStore.getState();
    if (st.cloud && st.tenant.id === tenantId) loopFor(tenantId).lastCatalogError = pullErrorMessage(e, 'catalog');
    reportPullError(e, 'catalog');
    return false;
  }
}

/**
 * Lê as contas e a ocupação das mesas e aplica (a nuvem manda no dinheiro; conta com
 * mudança daqui pendente fica como está). Conta com produto ou mesa que este aparelho
 * ainda não tem lê os cadastros antes, para a conta não aparecer com item sem nome
 * (no máximo uma vez por minuto por loja, fora "Sincronizar agora").
 * 'ok' aplicou; 'failed' falhou ou foi recusada (conta para a espera); 'discarded' trocou de
 * loja ou desconectou enquanto lia.
 */
async function pullOrdersOnce(cfg: SyncConfig, fetchFn: FetchLike, catalogFresh: boolean, force: boolean): Promise<'ok' | 'failed' | 'discarded'> {
  const tenantId = useTcheStore.getState().tenant.id;
  try {
    // Só ids UUID vão para p_order_ids (auditoria interna, rodada 8 do PR #54): o banco
    // atualizado ignora o id fora do formato, mas um banco ainda sem a migração recusaria a
    // leitura inteira, e o id inválido ocuparia uma das 500 vagas da lista.
    // Com as contas das entregas ainda sem acerto aqui (Codex no PR #54): ver orderIdsToReconcile.
    const openHere = orderIdsToReconcile(useTcheStore.getState());
    const snapshot = await fetchCloudOrders(cfg, tenantId, fetchFn, openHere);
    let st = useTcheStore.getState();
    if (!st.cloud || st.tenant.id !== tenantId) return 'discarded';
    const known = () => ({ productIds: useTcheStore.getState().products.map((p) => p.id), tableIds: useTcheStore.getState().tables.map((t) => t.id) });
    // Adicionais e sabores do meio a meio que este aparelho não tem e que ainda não foram
    // conferidos numa leitura dos cadastros feita depois de uma foto que os trazia.
    const options = () => {
      const s = useTcheStore.getState();
      return [
        ...missingModifiers(snapshot, s.modifierOptions.map((m) => m.id), checkedFor(tenantId)),
        ...missingHalves(snapshot, s.products.map((p) => p.id), checkedFor(tenantId)),
      ];
    };
    // Adicional desconhecido pede uma leitura dos cadastros que comece depois desta foto,
    // mesmo com os cadastros lidos no começo da rodada (catalogFresh): o item pode ter chegado
    // ao banco entre aquela leitura e esta foto (GPT, rodada 7 do PR #54).
    const unknownOptions = options();
    const nowMs = Date.now();
    if (((!catalogFresh && missingCatalog(snapshot, known())) || unknownOptions.length > 0) && (force || catalogRereadAllowed(tenantId, nowMs))) {
      // Limite de uma por minuto, à parte da cadência normal dos cadastros (auditoria interna,
      // rodada 8 do PR #54): cadastro que nunca chega lia os cadastros inteiros a cada batida.
      loopFor(tenantId).lastCatalogRereadMs = nowMs;
      const ok = await pullCatalog(cfg, fetchFn);
      st = useTcheStore.getState();
      if (!st.cloud || st.tenant.id !== tenantId) return 'discarded';
      // A leitura deu certo e começou depois da foto: o que ainda falta não vai chegar.
      if (ok) {
        const now = new Set([...st.modifierOptions.map((m) => m.id), ...st.products.map((p) => p.id)]);
        markChecked(tenantId, unknownOptions.filter((id) => !now.has(id)));
      }
    }
    // Ainda falta produto ou mesa (a leitura dos cadastros falhou, ou ainda não tem o
    // cadastro novo), ou adicional sem uma leitura dos cadastros que deu certo depois desta
    // foto: a foto não é aplicada, o aparelho fica com a anterior e tenta de novo na próxima
    // rodada (GPT, rodadas 1, 2, 6 e 7 do PR #54).
    if (missingCatalog(snapshot, known()) || options().length > 0) {
      // A última leitura dos cadastros também falhou: vai junto, senão o aviso das contas grava
      // por cima do dos cadastros e a causa some (auditoria interna, rodada 8 do PR #54).
      // Sem o ponto final e o "Tentando de novo" do aviso dos cadastros: a frase das contas já
      // termina com ele (auditoria interna, rodada 8 do PR #54).
      const catalogError = pullLoop.get(tenantId)?.lastCatalogError?.replace(/\s*Tentando de novo\.?\s*$/i, '').replace(/[\s.]+$/, '');
      const also = catalogError ? `; a leitura dos cadastros também falhou: ${catalogError}` : '';
      reportPullError(new Error(`Não foi possível ler as contas da nuvem: falta o cadastro de um produto, adicional ou mesa usado nelas${also}. Tentando de novo.`), 'orders');
      return 'failed';
    }
    // Uma mudança deste aparelho pode ter entrado na fila enquanto a leitura voltava: o
    // store confere a fila de agora e deixa essa conta como está.
    const r = st.applyCloudOrders(snapshot);
    if (!r.ok) {
      st.setPullError(r.error, 'orders');
      return 'failed';
    }
    // Contas deixadas de lado (valor que este aparelho não reconhece): o resto foi aplicado,
    // mas o aviso fica para a equipe ver (auditoria interna, rodada 8 do PR #54).
    const skipped = snapshot.skippedOrderIds?.length ? skippedMessage(snapshot) : null;
    if (skipped) useTcheStore.getState().setPullError(skipped, 'orders');
    return 'ok';
  } catch (e) {
    reportPullError(e, 'orders');
    return 'failed';
  }
}

/** Leitura das contas com a espera depois de falha (auditoria interna, rodada 8 do PR #54). */
async function pullOrders(cfg: SyncConfig, fetchFn: FetchLike, catalogFresh: boolean, force: boolean): Promise<void> {
  const tenantId = useTcheStore.getState().tenant.id;
  const r = await pullOrdersOnce(cfg, fetchFn, catalogFresh, force);
  const s = loopFor(tenantId);
  if (r === 'ok') s.ordersFailures = 0;
  else if (r === 'failed') {
    s.ordersFailures += 1;
    // Do fim da leitura (auditoria interna, rodada 8 do PR #54).
    s.lastOrdersFailureMs = Date.now();
  }
  if (r !== 'discarded') markOrdersRoundRan(tenantId);
}

/** Leituras da nuvem que estão na hora (ou todas, com force). */
async function pullOnce(cfg: SyncConfig, fetchFn: FetchLike, due: { catalog: boolean; orders: boolean }, force: boolean): Promise<void> {
  const catalogFresh = due.catalog ? await pullCatalog(cfg, fetchFn) : false;
  if (due.orders) await pullOrders(cfg, fetchFn, catalogFresh, force);
}

/**
 * Uma rodada: envia a fila; lê as contas da nuvem quando passaram 10 s da última leitura que
 * deu certo e a espera depois de falha (ordersBackoffMs) e, com a fila vazia, os cadastros
 * quando passou um minuto (ou tudo, na hora, com forcePull). Exportada para o botão
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
    orders: opts.forcePull === true
      || (pullDue(state.pullStatus?.last_orders_pull_at, nowMs, ORDERS_PULL_EVERY_MS) && ordersBackoffOver(state.tenant.id, nowMs)),
  };
  const force = opts.forcePull === true;
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
    // Mudança antiga da mesa que não pode subir sozinha: vai para os recusados antes do envio (GPT, rodada 11).
    useTcheStore.getState().parkLegacyTableReviews();
    const { outbox: events, syncRejected } = useTcheStore.getState();
    if (events.length === 0) {
      await pullOnce(cfg, fetchFn, due, force);
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
    // Cadastros pela cadência normal: só com a fila zerada nesta rodada (o que é daqui sobe
    // antes). A leitura das contas ainda pode ler os cadastros com a fila cheia, quando falta
    // cadastro usado nelas (pullOrders): é só leitura, e o store deixa como está o que ainda
    // não subiu daqui (auditoria interna, rodada 8 do PR #54).
    // Contas e mesas: na hora certa, mesmo com a fila cheia, segurada atrás de uma recusa ou
    // esperando uma nova tentativa. A junção deixa como está a conta (e a mesa) com evento
    // pendente; as outras descem. Sem isso, um evento de outro registro parado na fila
    // escondia o fechamento e os pagamentos feitos em outro aparelho (GPT, rodada 1 do PR #54),
    // e a conta que ficou na mesa nunca chegava para resolver a recusa de mesa ocupada (Codex).
    const after = useTcheStore.getState();
    const catalog = due.catalog && after.outbox.length === 0 && !result.retryLater;
    if (catalog || due.orders) await pullOnce(cfg, fetchFn, { catalog, orders: due.orders }, force);
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

/**
 * Aviso de contas paradas para as telas da equipe (auditoria interna, rodada 8 do PR #54): com a
 * nuvem conectada, contas sem atualizar há mais de um minuto (ou nunca lidas depois de um minuto
 * de sessão), ou o aviso da leitura das contas (conta deixada de lado, cadastro faltando, rede).
 * O aviso dos cadastros fica só na tela da nuvem. Null: nada a avisar.
 */
export function cloudStaleMessage(input: {
  cloud: boolean;
  pullStatus: Partial<Pick<PullStatus, 'last_orders_pull_at' | 'last_error' | 'last_error_source'>> | null | undefined;
  /** Desde quando este aparelho está com a sessão da nuvem desta loja (nesta abertura do app). */
  sessionSinceMs: number;
  nowMs: number;
  /**
   * Já houve uma leitura das contas desta loja nesta abertura do app. Antes dela, o horário
   * gravado é o da abertura anterior: nada aparece, a não ser que a sessão já passe de um minuto
   * sem leitura nenhuma (auditoria interna, rodada 8 do PR #54). Ausente: já houve.
   */
  ordersRoundRan?: boolean;
}): string | null {
  if (!input.cloud) return null;
  if (input.ordersRoundRan === false && !(input.nowMs - input.sessionSinceMs > ORDERS_STALE_MS)) return null;
  const p = input.pullStatus ?? {};
  const ordersError = p.last_error_source === 'orders' && p.last_error ? p.last_error : null;
  const lastMs = p.last_orders_pull_at ? Date.parse(p.last_orders_pull_at) : NaN;
  let stale: string | null = null;
  if (Number.isFinite(lastMs)) {
    const d = input.nowMs - lastMs;
    if (d > ORDERS_STALE_MS) stale = `Contas sem atualizar da nuvem há ${formatElapsed(d)}: confira o saldo antes de cobrar.`;
  } else if (input.nowMs - input.sessionSinceMs > ORDERS_STALE_MS) {
    stale = 'Contas ainda não atualizadas da nuvem neste aparelho: confira o saldo antes de cobrar.';
  }
  if (stale && ordersError) return `${stale} ${ordersError}`;
  return stale ?? ordersError;
}

/**
 * Tempo parado em min, h ou dias (auditoria interna, rodada 8 do PR #54): "há 900 min" não diz
 * nada a quem está no salão. Até 1 h: "N min"; até 1 dia: "N h" ou "N h M min"; depois: "N dias".
 */
export function formatElapsed(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
  const days = Math.floor(h / 24);
  return days === 1 ? '1 dia' : `${days} dias`;
}

/** O aviso de contas paradas, recalculado a cada 15 s (veja cloudStaleMessage). */
export function useCloudStaleMessage(): string | null {
  const hasSession = useTcheStore((s) => s.cloud !== null);
  const tenantId = useTcheStore((s) => s.tenant.id);
  const pullStatus = useTcheStore((s) => s.pullStatus);
  const roundRan = useSyncExternalStore(subscribeOrdersRound, () => ordersRoundRan.has(tenantId));
  const [since, setSince] = useState(() => ({ tenantId, ms: Date.now() }));
  const [nowMs, setNowMs] = useState(() => Date.now());
  // Recomeça ao conectar e ao trocar de loja: a sessão é da loja (auditoria interna, rodada 8 do
  // PR #54). Na renderização da troca, antes do efeito, já conta como recomeçada.
  useEffect(() => {
    if (hasSession) {
      const t = Date.now();
      setSince({ tenantId, ms: t });
      setNowMs(t);
    }
  }, [hasSession, tenantId]);
  const sessionSinceMs = since.tenantId === tenantId ? since.ms : nowMs;
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);
  return cloudStaleMessage({ cloud: hasSession, pullStatus, sessionSinceMs, nowMs, ordersRoundRan: roundRan });
}

/** URL e chave pública do projeto Supabase vindas do build (.env). */
export function defaultCloudConfig(): { url: string; anonKey: string } {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  return { url: env.VITE_SUPABASE_URL ?? '', anonKey: env.VITE_SUPABASE_ANON_KEY ?? '' };
}
