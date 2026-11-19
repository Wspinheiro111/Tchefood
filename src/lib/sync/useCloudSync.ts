/**
 * Etapa 0 — laço de sincronização: a cada 5 s, com internet e sessão da nuvem,
 * envia a fila na ordem e confirma o que o servidor aceitou. Com a fila vazia, a
 * cada minuto lê os cadastros da nuvem (mudanças feitas em outro aparelho).
 */
import { useEffect } from 'react';
import { useTcheStore } from '../../store/useTcheStore';
import { flushOutbox, needsRefresh, recordKeys, refreshDevice, type FetchLike, type SyncConfig } from './supabaseSync';
import { fetchCloudSnapshot } from './cloudPull';
import { dueNfceCalls, dueNfceOrders, nfceCallNow, requestNfceEmission } from './nfceEmission';
import type { CloudSession } from '../../store/useTcheStore';
import { pendingRelease } from '../payments/claimLedger';
import { cloudUnreachable, lastCloudContactAt, trackCloudReachability } from './cloudReachability';
import type { SyncEvent, UUID } from '../../types';

const INTERVAL_MS = 5_000;
/** Leitura dos cadastros da nuvem (só com a fila vazia: o que é daqui sobe antes). */
export const PULL_EVERY_MS = 60_000;
let running = false;
/** A rodada em andamento (quem precisa da conta sincronizada espera por ela; ver ensureOrderSynced). */
let current: Promise<void> | null = null;

const browserFetch: FetchLike = (url, init) => fetch(url, init);

/**
 * GPT r17 (a verificar): tempo máximo de cada pedido à nuvem. Um pedido que nunca responde (rede parada, servidor
 * mudo) segurava a rodada inteira para sempre, e com ela a fila e a leitura dos estornos. Passado o prazo o pedido é
 * abortado e vira "sem conexão": a rodada termina e a seguinte tenta de novo (o envio é idempotente, como em qualquer
 * queda de rede).
 */
export const REQUEST_TIMEOUT_MS = 30_000;
function withRequestTimeout(fetchFn: FetchLike, ms: number = REQUEST_TIMEOUT_MS): FetchLike {
  return (url, init) => {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ctrl?.abort();
        reject(new Error('A nuvem não respondeu a tempo.'));
      }, ms);
    });
    expired.catch(() => undefined);
    const stop = () => clearTimeout(timer);
    const call = fetchFn(url, ctrl ? { ...init, signal: ctrl.signal } : init).then(
      (res) => ({ ok: res.ok, status: res.status, text: () => Promise.race([res.text(), expired]).finally(stop) }),
      (e) => {
        stop();
        throw e;
      },
    );
    return Promise.race([call, expired]);
  };
}

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

function pullDue(lastPullAt: string | null | undefined, nowMs: number): boolean {
  return !lastPullAt || nowMs - Date.parse(lastPullAt) >= PULL_EVERY_MS;
}

/** Loja e sessão da nuvem de uma rodada (url, conta e loja do token). */
const sessionKey = (tenantId: string, session: { url: string; email: string; tenant_id: string }) => `${tenantId}|${session.url}|${session.email}|${session.tenant_id}`;

/** Lê os cadastros da nuvem e aplica (o store deixa como está o que ainda não subiu daqui). */
async function pullOnce(cfg: SyncConfig, fetchFn: FetchLike, tenantId: string, session: { url: string; email: string; tenant_id: string }): Promise<void> {
  // GPT r16 P0-01: a loja e a sessão são as do começo da rodada (cfg é dessa sessão). Trocou de loja ou desconectou
  // antes ou enquanto lia: nada é lido nem aplicado com a sessão antiga.
  const same = () => {
    const st = useTcheStore.getState();
    return st.tenant.id === tenantId && st.cloud !== null && sessionKey(st.tenant.id, st.cloud) === sessionKey(tenantId, session);
  };
  if (!same()) return;
  try {
    const snapshot = await fetchCloudSnapshot(cfg, tenantId, fetchFn);
    const st = useTcheStore.getState();
    if (!same()) return;
    const r = st.applyCloudSnapshot(snapshot);
    if (!r.ok) st.setPullError(r.error);
  } catch (e) {
    useTcheStore.getState().setPullError((e as Error).message);
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
async function pullRefunds(tenantId: string, session: { url: string; email: string; tenant_id: string }, cfg: SyncConfig, fetchFn: FetchLike): Promise<void> {
  const key = sessionKey(tenantId, session);
  try {
    const [m, c] = await Promise.all([import('../payments/refundOrdersPull'), import('../payments/paymentClaim')]);
    const scope = { tenantId, session: `${session.url}|${session.email}|${session.tenant_id}` };
    if (!m.sameScope(scope)) return;
    refundPull = { key, at: Date.now() };
    const out = await m.pullRefundOrders({ ...c.defaultClaimDeps(), config: async () => cfg, fetch: fetchFn }, scope);
    // GPT r16 P2-01: a falha desta leitura aparece no estado da nuvem (não fica calada no laço).
    if ((!out.changesOk || !out.reopened) && m.sameScope(scope)) {
      useTcheStore.getState().setPullError('Não foi possível ler os estornos e encerramentos feitos em outros aparelhos; tentando de novo em um minuto.');
    }
  } catch {
    // Sem leitura agora: tenta de novo na próxima rodada.
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
  const tenantId = state.tenant.id;
  const wantsRefunds = pull === 'force' || (pull === 'due' && refundPullDue(sessionKey(tenantId, session), Date.now()));
  // NFC-e real: só nas rodadas normais; a preparação da cobrança (never) só sobe a fila.
  const wantsNfce = pull !== 'never' && dueNfceOrders(state, Date.now(), 1).length > 0;
  if (state.outbox.length === 0 && !wantsPull && !wantsRefunds && !wantsNfce) return;
  running = true;
  const round = runRound(session, trackCloudReachability(withRequestTimeout(fetchFn)), wantsPull, wantsRefunds, tenantId, pull !== 'never');
  current = round;
  try {
    await round;
  } finally {
    if (current === round) current = null;
  }
}

async function runRound(session: NonNullable<ReturnType<typeof useTcheStore.getState>['cloud']>, fetchFn: FetchLike, wantsPull: boolean, wantsRefunds: boolean, tenantId: string, nfce = true): Promise<void> {
  try {
    const cfg = await sendAndPull(session, fetchFn, wantsPull, tenantId);
    // À parte da fila e dos cadastros: roda mesmo com evento preso na fila ou com a leitura dos cadastros falhando.
    if (cfg && wantsRefunds) await pullRefunds(tenantId, session, cfg, fetchFn);
    // NFC-e real das contas que já subiram inteiras (conta com evento na fila ou recusado fica de fora).
    if (cfg && nfce) await emitDueNfce(cfg, session, fetchFn);
  } finally {
    running = false;
  }
}

/** Renova o token, sobe a fila e lê os cadastros. Devolve a sessão usada (null: sem token válido). */
async function sendAndPull(session: NonNullable<ReturnType<typeof useTcheStore.getState>['cloud']>, fetchFn: FetchLike, wantsPull: boolean, tenantId: string): Promise<SyncConfig | null> {
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
    const { outbox: events, syncRejected } = useTcheStore.getState();
    if (events.length === 0) {
      if (wantsPull) await pullOnce(cfg, fetchFn, tenantId, session);
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
    // Fila zerou nesta rodada: lê a nuvem agora, se estava na hora.
    if (wantsPull && useTcheStore.getState().outbox.length === 0 && !result.retryLater) await pullOnce(cfg, fetchFn, tenantId, session);
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

/** Sem nenhum pedido à nuvem há este tempo (fila vazia, leitura recente), o laço faz a verificação leve. */
export const PROBE_EVERY_MS = 15_000;
const PROBE_TIMEOUT_MS = 10_000;
let probing = false;

/**
 * Auditoria #59 r2 P2-01: com a fila vazia e a leitura recente o laço não pede nada à nuvem, e uma queda do Supabase
 * passava sem aviso. Aqui, sem contato há PROBE_EVERY_MS, uma leitura mínima da linha da própria loja (GET em
 * tenants com a sessão atual, RLS; não grava nada) diz se a nuvem responde. Resposta HTTP qualquer = no ar (até 401);
 * queda, prazo de 10 s ou 502/503/504 = fora (ver cloudReachability).
 */
export async function probeCloudIfIdle(fetchFn: FetchLike = browserFetch, now: number = Date.now()): Promise<void> {
  // Não espera a rodada: uma rodada pendurada num pedido (até 30 s) também não pode atrasar o aviso.
  if (probing) return;
  const session = useTcheStore.getState().cloud;
  if (!session) return;
  if (now - lastCloudContactAt() < PROBE_EVERY_MS) return;
  probing = true;
  try {
    const get = trackCloudReachability(withRequestTimeout(fetchFn, PROBE_TIMEOUT_MS));
    // Só o status importa: o corpo não é lido (auditoria #59 r3 P2-01: corpo pendurado não segura a verificação).
    await get(`${session.url.replace(/\/+$/, '')}/rest/v1/tenants?select=id&limit=1`, {
      method: 'GET',
      headers: { apikey: session.anon_key, Authorization: `Bearer ${session.access_token}` },
    });
  } catch {
    // a falha já ficou registrada em cloudReachability
  } finally {
    probing = false;
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
      // Nuvem sem responder: lê a cada volta (não só a cada minuto), para o aviso sumir assim que ela voltar.
      void syncOnce(browserFetch, { forcePull: cloudUnreachable() }).then(() => probeCloudIfIdle());
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
    if (!applyRefreshedSession(session, t).ok) return null;
    return { url: session.url, anonKey: session.anon_key, accessToken: t.access_token };
  } catch {
    return null;
  }
}
