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
  orders: ['nfce_status', 'nfce_key'],
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
    throw new Error('Autorização de gerente sem PIN para o servidor conferir. Refaça a operação com o PIN do gerente.');
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

export function buildSyncRequest(event: SyncEvent, cfg: SyncConfig): SyncRequest {
  if (isManagerAuthorization(event)) return buildAuthorizeRequest(event, cfg);
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
  return {
    url: `${root}?on_conflict=${conflict}`,
    method: 'POST',
    headers: {
      ...headers,
      Prefer: `${insertOnly ? 'resolution=ignore-duplicates' : 'resolution=merge-duplicates'},return=minimal`,
    },
    body: JSON.stringify(sanitizePayload(event)),
  };
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
 * Ordem de envio para o servidor. Igual à da fila, exceto que um audit_log de pedido
 * sobe antes das atualizações daquele pedido que vieram logo antes dele: as travas do
 * banco (cancelamento, remoção dos 10%, desconto) exigem a autorização já gravada.
 * Cobre filas antigas, gravadas antes de o store enfileirar o audit_log primeiro.
 */
const LEGACY_MAX_MUTATIONS = 2;
const LEGACY_SAME_ACTION_MS = 2_000;

export function serverOrder(events: SyncEvent[]): SyncEvent[] {
  const out = [...events];
  for (let i = 0; i < out.length; i++) {
    const ev = out[i]!;
    const orderId = ev.table === 'audit_logs' ? (ev.payload.order_id as string | null | undefined) : null;
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

/**
 * Envia a fila em ordem até acabar, até um erro de rede/servidor, ou até `limit` eventos.
 * Um evento recusado (4xx) não para o envio: vai para `rejected` e o próximo segue.
 * Não altera o estado: quem chama confirma os enviados (ackSyncedEvents) e tira os
 * recusados da fila (rejectSyncEvents), para não reenviá-los a cada rodada.
 */
export async function flushOutbox(events: SyncEvent[], cfg: SyncConfig, fetchFn: FetchLike, limit = 50): Promise<FlushResult> {
  const sent: string[] = [];
  const rejected: SyncRejection[] = [];
  for (const event of serverOrder(events).slice(0, limit)) {
    let req: SyncRequest;
    try {
      req = buildSyncRequest(event, cfg);
    } catch (e) {
      rejected.push({ eventId: event.id, status: 0, message: (e as Error).message });
      continue;
    }
    let res;
    try {
      res = await fetchFn(req.url, { method: req.method, headers: req.headers, body: req.body });
    } catch (e) {
      return { sent, retryLater: `Sem conexão com a nuvem: ${(e as Error).message}`, rejected };
    }
    const text = await res.text().catch(() => '');
    if (res.ok) {
      // A RPC responde null quando o PIN não confere no servidor (ou está bloqueado):
      // nada foi autorizado, e a atualização da comanda que vem depois seria recusada.
      if (isManagerAuthorization(event) && !isUuidResponse(text)) {
        rejected.push({
          eventId: event.id,
          status: res.status,
          message: 'O servidor não confirmou o PIN do gerente (PIN alterado ou bloqueado por tentativas).',
        });
        continue;
      }
      sent.push(event.id);
      continue;
    }
    if (res.status === 401) return { sent, retryLater: 'Sessão da nuvem expirada. Renovando o acesso.', rejected };
    if (res.status >= 500 || res.status === 408 || res.status === 429) {
      return { sent, retryLater: `Nuvem indisponível (HTTP ${res.status}).`, rejected };
    }
    rejected.push({ eventId: event.id, status: res.status, message: describeError(text, res.status) });
  }
  return { sent, retryLater: null, rejected };
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
