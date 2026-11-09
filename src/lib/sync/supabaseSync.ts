/**
 * Etapa 0 — envio da fila offline (outbox) para o Supabase.
 *
 * Usa o PostgREST direto (fetch), sem SDK, para rodar igual no navegador e na
 * WebView da maquininha. Regras:
 *  - A fila é enviada NA ORDEM em que foi gerada, um evento por vez. O banco tem
 *    triggers que exigem o audit_log antes do cancelamento/desconto: o store
 *    enfileira o audit_log primeiro e serverOrder() corrige filas antigas.
 *  - payments e audit_logs são só INSERT com "ignore-duplicates": reenviar o
 *    mesmo evento nunca altera um pagamento ou um log já gravado.
 *  - Os demais são upsert pelo id (merge-duplicates).
 *  - Segredos da loja (token Focus, CSC) e a situação fiscal da comanda
 *    (nfce_status, nfce_key) nunca saem do aparelho por aqui: o servidor é a fonte deles.
 *  - A autorização de gerente (cancelamento, desconto, remoção dos 10%) NÃO é
 *    gravada direto em audit_logs: o banco só aceita esse registro vindo de
 *    tchefood_authorize_manager(), que confere o PIN de novo. A fila chama essa RPC.
 *  - Equipe (staff_users), permissões (role_permissions) e a loja nova também não são
 *    gravadas direto: o banco não deixa o aparelho escrever nelas. Sobem pelas funções
 *    tchefood_save_staff, tchefood_set_role_permission e tchefood_start_store, que
 *    conferem o PIN de quem alterou e o do gerente e gravam o audit_log junto.
 *  - Evento recusado pelo servidor (4xx) sai da fila para a lista de recusados,
 *    visível na tela, e o envio continua com os próximos. Nada é descartado sozinho:
 *    o operador reenvia os recusados depois de corrigir a causa.
 */
import type { SyncEvent } from '../../types';

export interface SyncConfig {
  url: string;
  anonKey: string;
  accessToken: string;
}

export interface SyncRequest {
  url: string;
  method: 'POST' | 'PATCH' | 'DELETE';
  headers: Record<string, string>;
  body?: string;
  /**
   * Só no PATCH de um UPDATE: se nenhuma linha mudou (o registro ainda não existe na
   * nuvem, ex.: o INSERT dele foi recusado e reenviado depois), sobe como upsert.
   */
  fallback?: SyncRequest;
}

/** Chave de conflito do upsert por tabela (PK no banco). */
const CONFLICT_KEY: Partial<Record<SyncEvent['table'], string>> = {
  product_modifier_groups: 'product_id,group_id',
  role_permissions: 'tenant_id,role,permission',
};

const INSERT_ONLY: ReadonlyArray<SyncEvent['table']> = ['payments', 'audit_logs'];

/** Ações que o banco só aceita pela RPC que confere o PIN (ver tchefood_authorize_manager). */
export const RPC_AUTHORIZED_ACTIONS: ReadonlyArray<string> = ['ITEM_CANCELED', 'SERVICE_FEE_REMOVED', 'DISCOUNT_APPLIED'];
const AUTHORIZE_RPC = 'tchefood_authorize_manager';
const SAVE_STAFF_RPC = 'tchefood_save_staff';
const SET_PERMISSION_RPC = 'tchefood_set_role_permission';
const START_STORE_RPC = 'tchefood_start_store';

/** Eventos que sobem por função do servidor que confere PIN e responde null quando ele não confere. */
export function isPinCheckedRpc(event: SyncEvent): boolean {
  return isManagerAuthorization(event) || event.table === 'staff_users' || event.table === 'role_permissions';
}

/** audit_log de autorização de gerente que precisa subir pela RPC. */
export function isManagerAuthorization(event: SyncEvent): boolean {
  return (
    event.table === 'audit_logs' &&
    event.op === 'INSERT' &&
    event.payload.authorized_by_manager_id != null &&
    RPC_AUTHORIZED_ACTIONS.includes(String(event.payload.action_type))
  );
}

/** Campos que nunca sobem do aparelho para a nuvem. */
const NEVER_UPLOAD: Partial<Record<SyncEvent['table'], ReadonlyArray<string>>> = {
  tenants: ['focus_nfe_token', 'csc_id', 'csc_token', 'created_at'],
  // Situação fiscal é do servidor (emit-nfce + espelho por trigger). A NFC-e local é simulação.
  // Totais da conta são do banco (tchefood_recalc_order a cada item e pagamento) e um
  // gatilho recusa gravação direta deles; mandar o valor do aparelho só arrisca a recusa.
  orders: ['nfce_status', 'nfce_key', 'subtotal_items', 'service_fee_amount', 'total_amount', 'paid_amount', 'remaining_balance'],
  // Ordem de gravação dada pelo banco (GENERATED ALWAYS): o banco recusaria o valor.
  audit_logs: ['server_seq'],
};

export function sanitizePayload(event: SyncEvent): Record<string, unknown> {
  const blocked = NEVER_UPLOAD[event.table] ?? [];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(event.payload)) if (!blocked.includes(k)) out[k] = v;
  return out;
}

function baseHeaders(cfg: SyncConfig): Record<string, string> {
  return {
    apikey: cfg.anonKey,
    Authorization: `Bearer ${cfg.accessToken}`,
    'Content-Type': 'application/json',
  };
}

function buildAuthorizeRequest(event: SyncEvent, cfg: SyncConfig): SyncRequest {
  if (!event.manager_pin) {
    // Fila gravada antes desta correção: sem o PIN, o servidor não tem como conferir.
    throw new Error('Autorização de gerente sem PIN para o servidor conferir. Em Nuvem, digite o PIN do gerente neste evento recusado e toque em Reenviar recusados.');
  }
  const p = event.payload;
  const metadata = { ...((p.metadata as Record<string, unknown> | null | undefined) ?? {}), client_audit_id: event.row_id };
  return {
    url: `${cfg.url.replace(/\/+$/, '')}/rest/v1/rpc/${AUTHORIZE_RPC}`,
    method: 'POST',
    headers: baseHeaders(cfg),
    body: JSON.stringify({
      p_order_id: p.order_id ?? null,
      p_action_type: p.action_type,
      p_manager_pin: event.manager_pin,
      p_performed_by: p.performed_by_user_id,
      p_reason: p.reason,
      p_amount_impact: p.amount_impact ?? 0,
      p_metadata: metadata,
    }),
  };
}

function rpcRequest(cfg: SyncConfig, fn: string, args: Record<string, unknown>): SyncRequest {
  return {
    url: `${cfg.url.replace(/\/+$/, '')}/rest/v1/rpc/${fn}`,
    method: 'POST',
    headers: baseHeaders(cfg),
    body: JSON.stringify(args),
  };
}

const REDO_STAFF = 'Alteração de equipe gravada antes desta versão, sem o PIN para o servidor conferir. Refaça a alteração na tela Equipe.';

function buildStaffRequest(event: SyncEvent, cfg: SyncConfig): SyncRequest {
  if (event.op === 'DELETE') throw new Error('DELETE não permitido em staff_users.');
  const p = event.payload;
  if (event.store_start) {
    return rpcRequest(cfg, START_STORE_RPC, {
      p_owner_id: p.id,
      p_owner_name: p.name,
      p_owner_pin: p.pin_code,
      p_qr_user_id: event.store_start.qr_user_id,
      p_reason: event.store_start.reason,
      p_metadata: { ...event.store_start.metadata, client_event_id: event.id },
      p_created_at: p.created_at ?? null,
    });
  }
  const a = event.staff_auth;
  if (!a) throw new Error(REDO_STAFF);
  return rpcRequest(cfg, SAVE_STAFF_RPC, {
    p_staff_id: p.id,
    p_name: p.name,
    p_role: p.role,
    p_pin: p.pin_code,
    p_active: p.active,
    p_actor_id: a.actor_id,
    p_actor_pin: a.actor_pin,
    p_manager_pin: a.manager_pin,
    p_reason: a.reason,
    p_created_at: p.created_at ?? null,
  });
}

function buildPermissionRequest(event: SyncEvent, cfg: SyncConfig): SyncRequest {
  const a = event.staff_auth;
  if (!a || !a.manager_pin) throw new Error('Troca de permissão gravada antes desta versão, sem o PIN para o servidor conferir. Refaça a troca na tela Loja.');
  const p = event.payload;
  return rpcRequest(cfg, SET_PERMISSION_RPC, {
    p_role: p.role,
    p_permission: p.permission,
    p_allowed: p.allowed,
    p_actor_id: a.actor_id,
    p_actor_pin: a.actor_pin,
    p_manager_pin: a.manager_pin,
    p_reason: a.reason,
  });
}

export function buildSyncRequest(event: SyncEvent, cfg: SyncConfig): SyncRequest {
  if (isManagerAuthorization(event)) return buildAuthorizeRequest(event, cfg);
  if (event.table === 'staff_users') return buildStaffRequest(event, cfg);
  if (event.table === 'role_permissions') return buildPermissionRequest(event, cfg);
  const root = `${cfg.url.replace(/\/+$/, '')}/rest/v1/${event.table}`;
  const headers = baseHeaders(cfg);

  if (event.op === 'DELETE') {
    const p = event.payload;
    let filter: string;
    if (event.table === 'product_modifier_groups') {
      filter = `product_id=eq.${encodeURIComponent(String(p.product_id))}&group_id=eq.${encodeURIComponent(String(p.group_id))}`;
    } else if (event.table === 'modifier_options') {
      filter = `id=eq.${encodeURIComponent(event.row_id)}`;
    } else {
      throw new Error(`DELETE não permitido em ${event.table}.`);
    }
    return { url: `${root}?${filter}`, method: 'DELETE', headers: { ...headers, Prefer: 'return=minimal' } };
  }

  if (event.table === 'tenants') {
    // A linha da loja é criada no servidor; o aparelho só atualiza os dados cadastrais.
    return {
      url: `${root}?id=eq.${encodeURIComponent(event.row_id)}`,
      method: 'PATCH',
      headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify(sanitizePayload(event)),
    };
  }

  const insertOnly = INSERT_ONLY.includes(event.table);
  const conflict = CONFLICT_KEY[event.table] ?? 'id';
  const upsert: SyncRequest = {
    url: `${root}?on_conflict=${conflict}`,
    method: 'POST',
    headers: {
      ...headers,
      Prefer: `${insertOnly ? 'resolution=ignore-duplicates' : 'resolution=merge-duplicates'},return=minimal`,
    },
    body: JSON.stringify(sanitizePayload(event)),
  };
  // UPDATE de linha que já existe vai como PATCH: o upsert do PostgREST é um
  // INSERT ... ON CONFLICT, que roda os gatilhos de INSERT na linha que já existe
  // (conta nasce zerada e PAYING no totem, ficha nasce em aberto, crédito de cashback
  // nasce inteiro) e o banco recusa a atualização.
  if (event.op === 'UPDATE' && !insertOnly && !CONFLICT_KEY[event.table]) {
    return {
      url: `${root}?id=eq.${encodeURIComponent(event.row_id)}`,
      method: 'PATCH',
      headers: { ...headers, Prefer: 'return=representation' },
      body: upsert.body,
      fallback: upsert,
    };
  }
  return upsert;
}

/** PATCH respondeu sem nenhuma linha: o registro não existe (ou não é visível) na nuvem. */
function patchedNothing(req: SyncRequest, body: string): boolean {
  if (req.method !== 'PATCH' || !req.fallback) return false;
  try {
    const v = JSON.parse(body) as unknown;
    return Array.isArray(v) && v.length === 0;
  } catch {
    return false;
  }
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

export interface SyncRejection {
  eventId: string;
  status: number;
  message: string;
}

export interface FlushResult {
  sent: string[];
  /** Erro de rede ou 5xx: tentar de novo depois, sem culpa do evento. Para o envio. */
  retryLater: string | null;
  /** 4xx: o servidor recusou estes eventos. O envio seguiu com os demais. */
  rejected: SyncRejection[];
}

/**
 * Ordem de envio para o servidor. Igual à da fila, exceto que uma autorização de
 * gerente (audit_log de pedido com gerente) sobe antes das atualizações daquele pedido que vieram logo antes dele: as travas do
 * banco (cancelamento, remoção dos 10%, desconto) exigem a autorização já gravada.
 * Cobre filas antigas, gravadas antes de o store enfileirar o audit_log primeiro.
 */
const LEGACY_MAX_MUTATIONS = 2;
const LEGACY_SAME_ACTION_MS = 2_000;

export function serverOrder(events: SyncEvent[]): SyncEvent[] {
  const out = [...events];
  for (let i = 0; i < out.length; i++) {
    const ev = out[i]!;
    // Só a autorização de gerente destrava uma atualização; outro audit_log (ex.: a
    // volta dos 10%) sobe exatamente onde está, porque a ordem de gravação no banco
    // (server_seq) decide qual registro de 10% é o último.
    const orderId = isManagerAuthorization(ev) ? (ev.payload.order_id as string | null | undefined) : null;
    if (!orderId) continue;
    // Só atravessa as atualizações da MESMA ação (gravadas no mesmo instante, no máximo
    // item + comanda). Uma operação anterior, com a sua própria autorização, nunca é ultrapassada.
    const at = Date.parse(ev.created_at);
    let j = i;
    while (j > 0 && i - j < LEGACY_MAX_MUTATIONS) {
      const prev = out[j - 1]!;
      const sameOrder =
        prev.op === 'UPDATE' &&
        ((prev.table === 'orders' && prev.row_id === orderId) || (prev.table === 'order_items' && prev.payload.order_id === orderId));
      const sameAction = Number.isFinite(at) && Math.abs(at - Date.parse(prev.created_at)) <= LEGACY_SAME_ACTION_MS;
      if (!sameOrder || !sameAction) break;
      j--;
    }
    if (j < i) {
      out.splice(i, 1);
      out.splice(j, 0, ev);
    }
  }
  return out;
}

/** Tabelas cujas linhas pertencem a uma comanda e mexem nela no servidor. */
const ORDER_CHILDREN: ReadonlyArray<SyncEvent['table']> = ['order_items', 'payments', 'audit_logs'];

/**
 * Registros que um evento toca, para manter a ordem por registro. Tudo o que pertence
 * a uma comanda conta também como a comanda: itens e pagamentos recalculam os totais
 * dela por gatilho (trg_order_items_recalc, trg_payments_recalc) e o audit_log é a
 * autorização da qual a atualização dela depende. A mesa também conta como a comanda
 * que ela mostra (ou que a liberou). Assim, um recusado da comanda segura tudo o que
 * vem depois dela, inclusive a mesa ficar livre, e o reenvio acontece na mesma ordem
 * em que foi gerado.
 */
export function recordKeys(event: SyncEvent): string[] {
  const keys = [`${event.table}:${event.row_id}`];
  const order = (id: unknown) => {
    if (typeof id === 'string' && !keys.includes(`orders:${id}`)) keys.push(`orders:${id}`);
  };
  if (ORDER_CHILDREN.includes(event.table)) order(event.payload.order_id);
  // Mesa: a situação dela segue a comanda. Ocupada/aguardando conta aponta para a
  // comanda em current_order_id; a liberação no fechamento leva depends_on_order_id.
  if (event.table === 'dining_tables') {
    order(event.payload.current_order_id);
    order(event.depends_on_order_id);
  }
  return keys;
}

/**
 * Envia a fila em ordem até acabar, até um erro de rede/servidor, ou até `limit` envios
 * (eventos segurados não contam).
 * Um evento recusado (4xx) não para o envio: vai para `rejected` e o próximo segue.
 * Eventos posteriores do MESMO registro de um recusado (nesta rodada ou em `held`, os
 * recusados guardados), ou de um registro que um evento segurado também toca, não sobem: ficam na fila até o recusado ser reenviado, para uma
 * versão antiga nunca sobrescrever uma mais nova na nuvem.
 * Não altera o estado: quem chama confirma os enviados (ackSyncedEvents) e tira os
 * recusados da fila (rejectSyncEvents), para não reenviá-los a cada rodada.
 */
export async function flushOutbox(
  events: SyncEvent[],
  cfg: SyncConfig,
  fetchFn: FetchLike,
  limit = 50,
  held: SyncEvent[] = [],
): Promise<FlushResult> {
  const sent: string[] = [];
  const rejected: SyncRejection[] = [];
  const blocked = new Set(held.flatMap(recordKeys));
  const reject = (event: SyncEvent, status: number, message: string) => {
    rejected.push({ eventId: event.id, status, message });
    for (const k of recordKeys(event)) blocked.add(k);
  };
  let attempts = 0;
  for (const event of serverOrder(events)) {
    // Eventos segurados não contam no limite: senão um bloco segurado no começo da fila
    // impediria para sempre que registros sem relação subissem.
    const keys = recordKeys(event);
    if (keys.some((k) => blocked.has(k))) {
      // O segurado também segura o que vem depois dele em QUALQUER registro que ele
      // toca: a liberação da mesa da comanda A, segurada pelo pagamento recusado de A,
      // não pode ser ultrapassada pela ocupação da mesma mesa pela comanda B (senão,
      // ao reenviar A, a liberação antiga sobrescreveria a mesa ocupada na nuvem).
      for (const k of keys) blocked.add(k);
      continue;
    }
    if (attempts >= limit) break;
    attempts++;
    let req: SyncRequest;
    try {
      req = buildSyncRequest(event, cfg);
    } catch (e) {
      reject(event, 0, (e as Error).message);
      continue;
    }
    let res;
    let text: string;
    try {
      res = await fetchFn(req.url, { method: req.method, headers: req.headers, body: req.body });
      text = await res.text().catch(() => '');
      if (res.ok && patchedNothing(req, text)) {
        const fb = req.fallback!;
        res = await fetchFn(fb.url, { method: fb.method, headers: fb.headers, body: fb.body });
        text = await res.text().catch(() => '');
      }
    } catch (e) {
      return { sent, retryLater: `Sem conexão com a nuvem: ${(e as Error).message}`, rejected };
    }
    if (res.ok) {
      // A RPC responde null quando o PIN não confere no servidor (ou está bloqueado):
      // nada foi autorizado, e a atualização da comanda que vem depois seria recusada.
      if (isManagerAuthorization(event) && !isUuidResponse(text)) {
        reject(event, res.status, 'O servidor não confirmou o PIN do gerente (PIN alterado ou bloqueado por tentativas).');
        continue;
      }
      // Equipe e permissões: null = algum PIN (de quem alterou ou do gerente) não conferiu,
      // ou o PIN novo já é de outra pessoa (o servidor não diz qual, de propósito).
      if (isPinCheckedRpc(event) && isNullResponse(text)) {
        reject(event, res.status, 'O servidor não confirmou o PIN de quem alterou ou do gerente, ou recusou o PIN novo (PIN alterado, repetido ou bloqueado por tentativas).');
        continue;
      }
      sent.push(event.id);
      continue;
    }
    if (res.status === 401) return { sent, retryLater: 'Sessão da nuvem expirada. Renovando o acesso.', rejected };
    if (res.status >= 500 || res.status === 408 || res.status === 429) {
      return { sent, retryLater: `Nuvem indisponível (HTTP ${res.status}).`, rejected };
    }
    reject(event, res.status, describeError(text, res.status));
  }
  return { sent, retryLater: null, rejected };
}

function isNullResponse(body: string): boolean {
  const t = body.trim();
  return t === '' || t === 'null';
}

function isUuidResponse(body: string): boolean {
  try {
    const v = JSON.parse(body) as unknown;
    return typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v);
  } catch {
    return false;
  }
}

function describeError(body: string, status: number): string {
  try {
    const j = JSON.parse(body) as { message?: string; details?: string; hint?: string };
    return [j.message, j.details].filter(Boolean).join(' — ') || `HTTP ${status}`;
  } catch {
    return body.slice(0, 200) || `HTTP ${status}`;
  }
}

// ---------------------------------------------------------------------------
// Supabase Auth (conta do aparelho da loja)
// ---------------------------------------------------------------------------
export interface AuthTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  tenant_id: string;
}

/** Lê o tenant_id do JWT (claim de topo, preenchida pelo hook de access token). */
export function tenantFromJwt(jwt: string): string | null {
  const part = jwt.split('.')[1];
  if (!part) return null;
  try {
    const json = JSON.parse(decodeBase64Url(part)) as { tenant_id?: unknown; app_metadata?: { tenant_id?: unknown } };
    const t = json.tenant_id ?? json.app_metadata?.tenant_id;
    return typeof t === 'string' && t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

function decodeBase64Url(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function authRequest(url: string, anonKey: string, grant: 'password' | 'refresh_token', body: Record<string, string>, fetchFn: FetchLike): Promise<AuthTokens> {
  const res = await fetchFn(`${url.replace(/\/+$/, '')}/auth/v1/token?grant_type=${grant}`, {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = JSON.parse(text) as { error_description?: string; msg?: string; message?: string };
      msg = j.error_description ?? j.msg ?? j.message ?? msg;
    } catch {
      /* corpo não é JSON */
    }
    throw new Error(grant === 'password' ? `Login na nuvem recusado: ${msg}` : `Não foi possível renovar a sessão: ${msg}`);
  }
  const j = JSON.parse(text) as { access_token: string; refresh_token: string; expires_at?: number; expires_in?: number };
  const tenant = tenantFromJwt(j.access_token);
  if (!tenant) throw new Error('A conta não está ligada a nenhuma loja (falta tenant_id no app_metadata).');
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: j.expires_at ?? Math.floor(Date.now() / 1000) + (j.expires_in ?? 3600),
    tenant_id: tenant,
  };
}

export function signInDevice(url: string, anonKey: string, email: string, password: string, fetchFn: FetchLike): Promise<AuthTokens> {
  return authRequest(url, anonKey, 'password', { email, password }, fetchFn);
}

export function refreshDevice(url: string, anonKey: string, refreshToken: string, fetchFn: FetchLike): Promise<AuthTokens> {
  return authRequest(url, anonKey, 'refresh_token', { refresh_token: refreshToken }, fetchFn);
}

/** Renovar quando faltar menos de 2 minutos para expirar. */
export function needsRefresh(expiresAt: number, nowMs = Date.now()): boolean {
  return expiresAt * 1000 - nowMs < 120_000;
}
