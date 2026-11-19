/**
 * Etapa 0 — laço de sincronização: a cada 5 s, com internet e sessão da nuvem,
 * envia a fila na ordem e confirma o que o servidor aceitou. Lê da nuvem o que outro
 * aparelho mudou: as contas e a ocupação das mesas a cada 10 s, mesmo com a fila cheia
 * (src/lib/sync/orderPull.ts), e os cadastros a cada minuto, com a fila vazia.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useTcheStore, type PullSource, type PullStatus } from '../../store/useTcheStore';
import { flushOutbox, needsRefresh, recordKeys, refreshDevice, withRequestTimeout, type FetchLike, type SyncConfig } from './supabaseSync';
export { REQUEST_TIMEOUT_MS } from './supabaseSync';
import { fetchCloudSnapshot } from './cloudPull';
import { fetchCloudOrders, missingCatalog, orderIdsToReconcile, missingHalves, missingModifiers, reconcileWindow, skippedMessage } from './orderPull';
import { dueNfceCalls, dueNfceOrders, nfceCallNow, requestNfceEmission } from './nfceEmission';
import type { CloudSession } from '../../store/useTcheStore';
import { pendingRelease } from '../payments/claimLedger';
import type { SyncEvent, UUID } from '../../types';

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
/** A rodada em andamento (quem precisa da conta sincronizada espera por ela; ver ensureOrderSynced). */
let current: Promise<void> | null = null;

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
  /**
   * Último id do lote pedido pelo id na última foto aplicada (reconcileWindow; GPT, rodadas 13 e
   * 14 do PR #54). Só anda quando a foto é aplicada: foto que falha ou não pode ser aplicada pede
   * o mesmo lote de novo.
   */
  reconcileAfter?: string | null;
  /**
   * Contas antigas já conferidas com a nuvem nesta abertura do app (pedidas num lote ou vindas na
   * foto). As que ainda não foram não são cobradas até o lote delas (GPT, rodada 15 do PR #54).
   */
  reconciledIds?: Set<string>;
  /**
   * Contas deixadas de lado por uma leitura (valor que esta versão não conhece) que ainda não
   * vieram de novo, válidas ou de lado: continuam de lado nos lotes seguintes, que não as pedem
   * (GPT, rodada 17 do PR #54). Saem quando uma leitura as traz válidas, quando o lote delas volta
   * sem elas de lado ou quando deixam de estar abertas aqui.
   */
  skippedIds?: Set<string>;
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
  refundPull = null;
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
/**
 * A loja e a sessão da nuvem de quando a rodada começou ainda são as de agora (GPT, rodada 15 do
 * PR #54): a falha (ou a resposta) de uma leitura da loja anterior não pode virar aviso nem dado
 * na loja atual. O token é o da rodada (a renovação só acontece no começo de syncOnce).
 */
function sameStore(tenantId: string, cfg: SyncConfig): boolean {
  const st = useTcheStore.getState();
  return !!st.cloud && st.tenant.id === tenantId && st.cloud.tenant_id === tenantId
    && st.cloud.url === cfg.url && st.cloud.access_token === cfg.accessToken;
}

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

/**
 * Uma renovação do token por vez, dividida entre o laço e a cobrança na Point: duas renovações com o mesmo
 * refresh token (uma largada pelo prazo da cobrança, outra do laço) podem derrubar a sessão do aparelho.
 */
let refreshing: { token: string; promise: ReturnType<typeof refreshDevice> } | null = null;
function sharedRefresh(session: { url: string; anon_key: string; refresh_token: string }, fetchFn: FetchLike): ReturnType<typeof refreshDevice> {
  if (refreshing && refreshing.token === session.refresh_token) return refreshing.promise;
  const promise = refreshDevice(session.url, session.anon_key, session.refresh_token, withRequestTimeout(fetchFn));
  const entry = { token: session.refresh_token, promise };
  refreshing = entry;
  const clear = () => {
    if (refreshing === entry) refreshing = null;
  };
  promise.then(clear, clear);
  return promise;
}

type CloudSessionNow = NonNullable<ReturnType<typeof useTcheStore.getState>['cloud']>;

/**
 * GPT r17 (a verificar): guarda o token renovado só se a sessão do aparelho ainda é a que foi renovada. Durante a
 * renovação o aparelho pode ter sido desconectado, trocado de loja ou entrado com outra conta da mesma loja: a resposta
 * antiga não ressuscita nem sobrescreve a sessão de agora. Duas rodadas dividem a mesma renovação (sharedRefresh): se a
 * outra já guardou este token, vale.
 */
function applyRefreshedSession(session: CloudSessionNow, tokens: Awaited<ReturnType<typeof refreshDevice>>): { ok: true } | { ok: false; error: string | null } {
  const cur = useTcheStore.getState().cloud;
  if (!cur || cur.url !== session.url || cur.email !== session.email || cur.tenant_id !== session.tenant_id) return { ok: false, error: null };
  if (cur.refresh_token === tokens.refresh_token) return { ok: true };
  if (cur.refresh_token !== session.refresh_token) return { ok: false, error: null };
  const res = useTcheStore.getState().setCloudSession({ ...cur, ...tokens });
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

function pullDue(lastPullAt: string | null | undefined, nowMs: number, everyMs: number = PULL_EVERY_MS): boolean {
  // Diferença negativa (o relógio do aparelho voltou depois da última leitura) conta como vencida.
  const d = lastPullAt ? nowMs - Date.parse(lastPullAt) : NaN;
  return !(d >= 0 && d < everyMs);
}

/** Loja e sessão da nuvem de uma rodada (url, conta e loja do token). */
const sessionKey = (tenantId: string, session: { url: string; email: string; tenant_id: string }) => `${tenantId}|${session.url}|${session.email}|${session.tenant_id}`;

/** Lê os cadastros da nuvem e aplica (o store deixa como está o que ainda não subiu daqui). */
async function pullCatalog(cfg: SyncConfig, fetchFn: FetchLike): Promise<boolean> {
  const tenantId = useTcheStore.getState().tenant.id;
  // A loja mudou depois de a rodada começar: o token é o da loja anterior (GPT, rodada 15).
  if (!sameStore(tenantId, cfg)) return false;
  try {
    const snapshot = await fetchCloudSnapshot(cfg, tenantId, fetchFn);
    const st = useTcheStore.getState();
    // Trocou de loja ou desconectou enquanto lia: descarta.
    if (!sameStore(tenantId, cfg)) return false;
    const r = st.applyCloudSnapshot(snapshot);
    loopFor(tenantId).lastCatalogError = r.ok ? null : r.error;
    if (!r.ok) st.setPullError(r.error, 'catalog');
    return r.ok;
  } catch (e) {
    // Trocou de loja ou desconectou enquanto lia: a falha não é desta loja.
    if (!sameStore(tenantId, cfg)) return false;
    loopFor(tenantId).lastCatalogError = pullErrorMessage(e, 'catalog');
    reportPullError(e, 'catalog');
    return false;
  }
}

/** Última leitura dos estornos e encerramentos de outros aparelhos, por loja e sessão (uma por minuto no laço). */
let refundPull: { key: string; at: number } | null = null;
function refundPullDue(key: string, nowMs: number): boolean {
  return !refundPull || refundPull.key !== key || nowMs - refundPull.at >= PULL_EVERY_MS;
}

/**
 * GPT r15 P1-01: estornos da Point e encerramentos como venda devolvida feitos em outro aparelho (também com este
 * fechado): a conta daqui fica com o estado do servidor. GPT r16: roda à parte da leitura dos cadastros e da fila
 * (P1-01: evento de outra coisa preso na fila não segura; conta com alteração daqui na fila ou recusada não é
 * sobrescrita) e só com a loja e a sessão em que a rodada começou (P0-01: trocou de loja no meio, nada é lido nem
 * aplicado com a sessão antiga). Import tardio: o módulo usa este para a sessão.
 */
export const REFUND_PULL_ERROR = 'Não foi possível ler os estornos e encerramentos feitos em outros aparelhos; tentando de novo em um minuto.';

async function pullRefunds(tenantId: string, session: { url: string; email: string; tenant_id: string }, cfg: SyncConfig, fetchFn: FetchLike): Promise<void> {
  const key = sessionKey(tenantId, session);
  try {
    const [m, c] = await Promise.all([import('../payments/refundOrdersPull'), import('../payments/paymentClaim')]);
    const scope = { tenantId, session: `${session.url}|${session.email}|${session.tenant_id}` };
    if (!m.sameScope(scope)) return;
    refundPull = { key, at: Date.now() };
    const out = await m.pullRefundOrders({ ...c.defaultClaimDeps(), config: async () => cfg, fetch: fetchFn }, scope);
    // GPT r16 P2-01: a falha desta leitura aparece no estado da nuvem (não fica calada no laço). Num campo só dela:
    // a leitura das contas ou dos cadastros que dá certo não apaga este aviso, só a dos estornos (GPT, rodada 17 do
    // PR #54).
    if (!m.sameScope(scope)) return;
    useTcheStore.getState().setRefundError(out.changesOk && out.reopened ? null : REFUND_PULL_ERROR);
  } catch {
    // Sem leitura agora: tenta de novo na próxima rodada.
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
  // A loja mudou depois de a rodada começar: o token é o da loja anterior (GPT, rodada 15).
  if (!sameStore(tenantId, cfg)) return 'discarded';
  try {
    // Só ids UUID vão para p_order_ids (auditoria interna, rodada 8 do PR #54): o banco
    // atualizado ignora o id fora do formato, mas um banco ainda sem a migração recusaria a
    // leitura inteira, e o id inválido ocuparia uma das 500 vagas da lista.
    // Com as contas das entregas ainda sem acerto aqui (Codex no PR #54): ver orderIdsToReconcile.
    // Mais de 500: cada leitura pede o lote seguinte (GPT, rodada 13 do PR #54).
    const reconcileIds = orderIdsToReconcile(useTcheStore.getState());
    const batch = reconcileWindow(reconcileIds, loopFor(tenantId).reconcileAfter);
    const snapshot = await fetchCloudOrders(cfg, tenantId, fetchFn, batch.ids);
    let st = useTcheStore.getState();
    if (!sameStore(tenantId, cfg)) return 'discarded';
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
      if (!sameStore(tenantId, cfg)) return 'discarded';
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
    // Contas antigas conferidas: as pedidas neste lote e as que vieram na foto (abertas na nuvem
    // ou encerradas nas últimas 24 h). As outras esperam o lote delas e não são cobradas até lá
    // (GPT, rodada 15 do PR #54). Só as da lista de antes da leitura: conta aberta aqui enquanto
    // a leitura voltava é nova, não está atrasada.
    const loop = loopFor(tenantId);
    // Conta de lado numa leitura anterior e fora desta (o lote dela já passou e ela está encerrada há
    // mais de 24 h): continua de lado, senão perderia o bloqueio no lote seguinte (GPT, rodada 17).
    const answered = new Set<string>([...batch.ids, ...snapshot.orders.map((o) => o.id)]);
    const open = new Set(reconcileIds);
    const skippedOrderIds = [...new Set([
      ...(snapshot.skippedOrderIds ?? []),
      ...[...(loop.skippedIds ?? [])].filter((id) => open.has(id) && !answered.has(id)),
    ])];
    const pulled = { ...snapshot, skippedOrderIds };
    const seen = new Set<string>([...(loop.reconciledIds ?? []), ...batch.ids, ...snapshot.orders.map((o) => o.id), ...skippedOrderIds]);
    const unreconciledOrderIds = reconcileIds.filter((id) => !seen.has(id));
    const r = st.applyCloudOrders(pulled, { unreconciledOrderIds });
    if (!r.ok) {
      st.setPullError(r.error, 'orders');
      return 'failed';
    }
    loop.reconcileAfter = batch.next;
    loop.reconciledIds = new Set(reconcileIds.filter((id) => seen.has(id)));
    loop.skippedIds = new Set(skippedOrderIds);
    // Contas deixadas de lado (valor que este aparelho não reconhece): o resto foi aplicado,
    // mas o aviso fica para a equipe ver (auditoria interna, rodada 8 do PR #54).
    const skipped = skippedOrderIds.length ? skippedMessage(pulled) : null;
    if (skipped) useTcheStore.getState().setPullError(skipped, 'orders');
    return 'ok';
  } catch (e) {
    // Trocou de loja ou desconectou enquanto lia: a falha não é desta loja (GPT, rodada 15).
    if (!sameStore(tenantId, cfg)) return 'discarded';
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

type PullDue = { catalog: boolean; orders: boolean };

/** Leituras da nuvem que estão na hora (ou todas, com force). */
async function pullOnce(cfg: SyncConfig, fetchFn: FetchLike, due: PullDue, force: boolean): Promise<void> {
  const catalogFresh = due.catalog ? await pullCatalog(cfg, fetchFn) : false;
  if (due.orders) await pullOrders(cfg, fetchFn, catalogFresh, force);
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
  for (const { orderId } of dueNfceCalls(useTcheStore.getState(), Date.now())) {
    if (!sameStore()) return;
    const now = useTcheStore.getState();
    if (!now.orders.some((o) => o.id === orderId && o.tenant_id === session.tenant_id)) continue;
    // Elegibilidade conferida de novo logo antes da chamada: durante a chamada anterior a comanda pode
    // ter sido reaberta ou ganhado evento na fila; aí ela fica para uma rodada em que estiver inteira na nuvem.
    const mode = nfceCallNow(now, orderId, Date.now());
    if (!mode) continue;
    const outcome = await requestNfceEmission(cfg, orderId, fetchFn, mode);
    if (!sameStore()) return;
    useTcheStore.getState().applyNfceOutcome(orderId, outcome);
  }
}

/**
 * Uma rodada: envia a fila; lê as contas da nuvem quando passaram 10 s da última leitura que
 * deu certo e a espera depois de falha (ordersBackoffMs) e, com a fila vazia, os cadastros
 * quando passou um minuto (ou tudo, na hora, com forcePull). Exportada para o botão
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
  const nowMs = Date.now();
  const force = pull === 'force';
  const due = {
    catalog: force || (pull === 'due' && pullDue(state.pullStatus?.last_pull_at, nowMs)),
    orders: force
      || (pull === 'due' && pullDue(state.pullStatus?.last_orders_pull_at, nowMs, ORDERS_PULL_EVERY_MS) && ordersBackoffOver(state.tenant.id, nowMs)),
  };
  const wantsPull = due.catalog || due.orders;
  const tenantId = state.tenant.id;
  const wantsRefunds = force || (pull === 'due' && refundPullDue(sessionKey(tenantId, session), nowMs));
  // NFC-e real: só nas rodadas normais; a preparação da cobrança (never) só sobe a fila.
  const wantsNfce = pull !== 'never' && dueNfceOrders(state, Date.now(), 1).length > 0;
  if (state.outbox.length === 0 && !wantsPull && !wantsRefunds && !wantsNfce) return;
  running = true;
  const round = runRound(session, withRequestTimeout(fetchFn), due, force, wantsRefunds, tenantId, pull !== 'never');
  current = round;
  try {
    await round;
  } finally {
    if (current === round) current = null;
  }
}

async function runRound(session: NonNullable<ReturnType<typeof useTcheStore.getState>['cloud']>, fetchFn: FetchLike, due: PullDue, force: boolean, wantsRefunds: boolean, tenantId: string, nfce = true): Promise<void> {
  try {
    const cfg = await sendAndPull(session, fetchFn, due, force);
    // À parte da fila e dos cadastros: roda mesmo com evento preso na fila ou com a leitura dos cadastros falhando.
    if (cfg && wantsRefunds) await pullRefunds(tenantId, session, cfg, fetchFn);
    // NFC-e real das contas que já subiram inteiras (conta com evento na fila ou recusado fica de fora).
    if (cfg && nfce) await emitDueNfce(cfg, session, fetchFn);
  } finally {
    running = false;
  }
}

/** Renova o token, sobe a fila e lê os cadastros. Devolve a sessão usada (null: sem token válido). */
async function sendAndPull(session: NonNullable<ReturnType<typeof useTcheStore.getState>['cloud']>, fetchFn: FetchLike, due: PullDue, force: boolean): Promise<SyncConfig | null> {
  const wantsPull = due.catalog || due.orders;
  {
    let token = session.access_token;
    if (needsRefresh(session.expires_at)) {
      try {
        const t = await sharedRefresh(session, fetchFn);
        const res = applyRefreshedSession(session, t);
        if (!res.ok) {
          // Sessão trocada ou desconectada durante a renovação: esta rodada acaba sem usar o token antigo.
          if (res.error) useTcheStore.getState().setSyncError(res.error, null);
          return null;
        }
        token = t.access_token;
      } catch (e) {
        useTcheStore.getState().setSyncError((e as Error).message, null);
        return null;
      }
    }
    const cfg: SyncConfig = { url: session.url, anonKey: session.anon_key, accessToken: token };
    // Mudança antiga da mesa que não pode subir sozinha: vai para os recusados antes do envio (GPT, rodada 11).
    useTcheStore.getState().parkLegacyTableReviews();
    const { outbox: events, syncRejected } = useTcheStore.getState();
    if (events.length === 0) {
      if (wantsPull) await pullOnce(cfg, fetchFn, due, force);
      return cfg;
    }
    const held = (syncRejected ?? []).map((r) => r.event);
    const result = await flushOutbox(events, cfg, fetchFn, 50, held, declinedAwaitingRelease);
    const st = useTcheStore.getState();
    // Recusa da maquininha que o servidor não aceitou (TF010, sem dinheiro): sai da fila como os enviados, para
    // não parar a conta; o aviso abaixo diz que foi descartada.
    const dropped = result.dropped ?? [];
    st.ackSyncedEvents([...result.sent, ...dropped.map((d) => d.eventId)]);
    // Recusados saem da fila (o resto continua subindo) e ficam na lista para revisão.
    st.rejectSyncEvents(result.rejected);
    const first = result.rejected[0];
    if (result.retryLater) st.setSyncError(result.retryLater, null);
    else if (!first && dropped[0]) st.setSyncError(`O servidor não aceitou o registro de uma recusa da maquininha (nada foi cobrado); ele foi descartado: ${dropped[0].message}`, null);
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
    return cfg;
  }
}

/**
 * Recusa da maquininha (pagamento DECLINED fora do Mercado Pago) cuja reserva ainda está sendo liberada por este
 * aparelho (liberação pendente com o código, ainda tentando): espera a liberação. Com a reserva aberta, o servidor
 * recusa o DECLINED com TF010 (protege o aprovado da mesma chave). Liberação final (só o gerente) não segura.
 */
export function declinedAwaitingRelease(event: SyncEvent): boolean {
  if (event.table !== 'payments' || event.op !== 'INSERT') return false;
  const p = event.payload;
  if (p.status !== 'DECLINED' || p.acquirer === 'MERCADO_PAGO' || typeof p.idempotency_key !== 'string') return false;
  const pending = pendingRelease(p.idempotency_key);
  return Boolean(pending && pending.release_token && !pending.final);
}

/** Evento que mexe nesta conta: a própria conta ou linha dela (item, pagamento, cashback, desconto). */
function touchesOrder(event: SyncEvent, orderId: UUID): boolean {
  // As mesmas ligações que a fila usa para segurar eventos da conta (recordKeys: a conta, linhas dela, mesa,
  // liberação e cashback que dependem dela). Item que saiu desta conta: a conta de origem sobe recalculada
  // (evento da própria conta), e o servidor ainda confere o saldo.
  return recordKeys(event).includes(`orders:${orderId}`) || event.payload?.order_id === orderId;
}

export type OrderSyncCheck = { ok: true; balance_cents: number } | { ok: false; reason: string };

const REJECTED_WHAT: Partial<Record<SyncEvent['table'], string>> = {
  payments: 'um pagamento',
  orders: 'uma alteração',
  order_items: 'um item',
  dining_tables: 'a situação da mesa',
  audit_logs: 'uma autorização do gerente',
  cashback_ledger: 'um cashback',
  own_deliveries: 'uma entrega',
};

/**
 * A conta tem evento recusado pela nuvem: nenhum pagamento (nem dinheiro) é recebido nela até resolver, porque
 * o servidor não tem a conta como este aparelho a mostra. Diz qual evento e o que fazer.
 */
export function rejectedOrderMessage(event: SyncEvent, message: string): string {
  const what = REJECTED_WHAT[event.table] ?? 'uma alteração';
  return `A nuvem recusou ${what} desta conta (${message}). Nada foi recebido: nenhum pagamento entra nesta conta até resolver. Em Retaguarda › Nuvem, corrija a causa e toque em Reenviar recusados.`;
}

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
    if (!st.cloud) return fail('Conecte a loja à nuvem para receber por este caminho. Nada foi recebido.');
    const rejected = (st.syncRejected ?? []).find((r) => touchesOrder(r.event, orderId));
    if (rejected) return fail(rejectedOrderMessage(rejected.event, rejected.message));
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

/**
 * Aviso de contas paradas para as telas da equipe (auditoria interna, rodada 8 do PR #54): com a
 * nuvem conectada, contas sem atualizar há mais de um minuto (ou nunca lidas depois de um minuto
 * de sessão), ou o aviso da leitura das contas (conta deixada de lado, cadastro faltando, rede).
 * O aviso dos cadastros fica só na tela da nuvem. Null: nada a avisar.
 */
export function cloudStaleMessage(input: {
  cloud: boolean;
  pullStatus: Partial<Pick<PullStatus, 'last_orders_pull_at' | 'last_error' | 'last_error_source' | 'refund_error'>> | null | undefined;
  /** Desde quando este aparelho está com a sessão da nuvem desta loja (nesta abertura do app). */
  sessionSinceMs: number;
  nowMs: number;
  /**
   * Já houve uma leitura das contas desta loja nesta abertura do app. Antes dela, o horário
   * gravado é o da abertura anterior: nada aparece, a não ser que a sessão já passe de um minuto
   * sem leitura nenhuma (auditoria interna, rodada 8 do PR #54). Ausente: já houve.
   */
  ordersRoundRan?: boolean;
  /** Contas antigas que ainda esperam o lote delas (cloudUnreconciledOrderIds; GPT, rodada 15). */
  unreconciled?: number;
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
  const waiting = input.unreconciled && input.unreconciled > 0
    ? `${input.unreconciled === 1 ? '1 conta antiga deste aparelho ainda não foi conferida' : `${input.unreconciled} contas antigas deste aparelho ainda não foram conferidas`} com a nuvem: não são cobradas até lá.`
    : null;
  const parts = [stale, ordersError, p.refund_error ?? null, waiting].filter((x): x is string => !!x);
  return parts.length > 0 ? parts.join(' ') : null;
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
  const unreconciled = useTcheStore((s) => (s.cloudUnreconciledOrderIds ?? []).length);
  return cloudStaleMessage({ cloud: hasSession, pullStatus, sessionSinceMs, nowMs, ordersRoundRan: roundRan, unreconciled });
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
    if (!applyRefreshedSession(session, t).ok) return null;
    return { url: session.url, anonKey: session.anon_key, accessToken: t.access_token };
  } catch {
    return null;
  }
}
