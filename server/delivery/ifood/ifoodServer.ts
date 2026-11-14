import { DeliveryConcurrencyError, DeliveryInbox, type DeliveryCycleReport, type DeliveryOrderRecord } from "../deliveryInbox";
import {
  DeliveryMarketplaceError,
  type DeliveryDisputeDecision,
  type DeliveryOrderAction,
} from "../marketplace";
import type { RestFetch } from "../supabaseDeliveryRepository";
import { IFOOD_POLLING_INTERVAL_MS, IfoodMerchantApi } from "./ifoodMerchantApi";

// Servidor do iFood: um processo só, sempre ligado.
//  - Polling a cada 30 s das lojas com integração ativa (é o polling que mantém a loja aberta no iFood). Um ciclo
//    nunca começa antes do anterior terminar.
//  - API para o app: ações do pedido (confirmar, preparar, pronto, despachar), cancelamento com motivo do iFood,
//    resposta a negociação e pausa da loja. O app manda o JWT da sessão; o servidor só age em pedido/loja que o
//    RLS do Supabase mostra para esse JWT (a mesma prova de loja da emissão de NFC-e).
// Segredos (IFOOD_CLIENT_SECRET, SUPABASE_SERVICE_ROLE_KEY) ficam nas variáveis de ambiente deste processo.

export type MerchantSource = { activeMerchants(): Promise<Array<{ merchantExternalId: string }>> };

export type IfoodPollerOptions = {
  api: IfoodMerchantApi;
  inbox: DeliveryInbox;
  merchants: MerchantSource;
  intervalMs?: number;
  log?: (line: string) => void;
  now?: () => number;
};

export type IfoodPollerStatus = {
  running: boolean;
  merchants: number;
  lastCycleAt: string | null;
  lastReport: DeliveryCycleReport | null;
  lastError: string | null;
};

export class IfoodPoller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private current: Promise<void> | null = null;
  private readonly status: IfoodPollerStatus = { running: false, merchants: 0, lastCycleAt: null, lastReport: null, lastError: null };

  constructor(private readonly options: IfoodPollerOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.status.running = true;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.status.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.current;
  }

  snapshot(): IfoodPollerStatus {
    return structuredClone(this.status);
  }

  // Um ciclo: relê as lojas ativas, busca os eventos, grava e confirma. Nunca lança.
  async runOnce(): Promise<DeliveryCycleReport | null> {
    const log = this.options.log ?? (() => undefined);
    const now = this.options.now ?? Date.now;
    try {
      const merchants = await this.options.merchants.activeMerchants();
      this.status.merchants = merchants.length;
      // Sem loja ligada não há polling: sem o header x-polling-merchants o iFood mandaria eventos de lojas que
      // ninguém grava, e eles voltariam para sempre.
      if (merchants.length === 0) {
        this.status.lastError = null;
        return null;
      }
      this.options.api.setMerchantIds(merchants.map((merchant) => merchant.merchantExternalId));
      const report = await this.options.inbox.runChannel(this.options.api);
      this.status.lastReport = report;
      this.status.lastError = report.error;
      if (report.received > 0 || report.error) {
        log(`[ifood] recebidos=${report.received} novos=${report.newOrders.length} ack=${report.acknowledged} adiados=${report.deferred}${report.error ? ` erro=${report.error}` : ""}`);
      }
      return report;
    } catch (error) {
      this.status.lastError = error instanceof Error ? error.message : String(error);
      log(`[ifood] ciclo falhou: ${this.status.lastError}`);
      return null;
    } finally {
      this.status.lastCycleAt = new Date(now()).toISOString();
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      const started = (this.options.now ?? Date.now)();
      this.current = this.runOnce().then(() => {
        this.current = null;
        const elapsed = (this.options.now ?? Date.now)() - started;
        this.schedule(Math.max(0, (this.options.intervalMs ?? IFOOD_POLLING_INTERVAL_MS) - elapsed));
      });
    }, delayMs);
  }
}

// ---------------------------------------------------------------------------
// Prova de loja: o JWT do app só "vê" pedido/loja do próprio tenant (RLS).
// ---------------------------------------------------------------------------

export interface TenantAuthorizer {
  canAccessOrder(accessToken: string, externalOrderId: string): Promise<boolean>;
  canAccessMerchant(accessToken: string, merchantExternalId: string): Promise<boolean>;
}

export class SupabaseCallerAuthorizer implements TenantAuthorizer {
  private readonly base: string;
  private readonly fetchImpl: RestFetch;

  constructor(private readonly options: { url: string; anonKey: string; fetchImpl?: RestFetch }) {
    this.base = options.url.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  }

  canAccessOrder(accessToken: string, externalOrderId: string): Promise<boolean> {
    return this.visible(`delivery_orders?channel=eq.ifood&external_id=eq.${encodeURIComponent(externalOrderId)}&select=tenant_id`, accessToken);
  }

  canAccessMerchant(accessToken: string, merchantExternalId: string): Promise<boolean> {
    return this.visible(
      `delivery_integrations?channel=eq.ifood&active=eq.true&merchant_external_id=eq.${encodeURIComponent(merchantExternalId)}&select=tenant_id`,
      accessToken,
    );
  }

  private async visible(query: string, accessToken: string): Promise<boolean> {
    const response = await this.fetchImpl(`${this.base}/rest/v1/${query}`, {
      method: "GET",
      headers: { apikey: this.options.anonKey, authorization: `Bearer ${accessToken}`, accept: "application/json" },
    });
    // JWT inválido/vencido: o PostgREST responde 401/403. Qualquer outra falha também não libera nada.
    if (!response.ok) return false;
    try {
      const rows = JSON.parse(await response.text()) as unknown;
      return Array.isArray(rows) && rows.length > 0;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// API HTTP (independente do node:http, para testar sem abrir porta)
// ---------------------------------------------------------------------------

export type ApiRequest = { method: string; path: string; headers: Record<string, string | undefined>; body: string };
export type ApiResponse = { status: number; body: unknown };

const ACTIONS: Readonly<Record<string, DeliveryOrderAction>> = {
  confirm: "confirm",
  start_preparation: "start_preparation",
  ready_for_pickup: "ready_for_pickup",
  dispatch: "dispatch",
};

// Pausa: até 24 h por vez (pausa mais longa é fechar a loja no Portal do Parceiro).
const MAX_PAUSE_MINUTES = 24 * 60;

export type IfoodApiOptions = {
  inbox: DeliveryInbox;
  api: IfoodMerchantApi;
  authorizer: TenantAuthorizer;
  poller?: IfoodPoller;
  now?: () => Date;
  log?: (line: string) => void;
};

export function createIfoodApiHandler(options: IfoodApiOptions): (request: ApiRequest) => Promise<ApiResponse> {
  const now = options.now ?? (() => new Date());
  return async (request) => {
    const path = request.path.split("?")[0] ?? "";
    try {
      if (request.method === "GET" && path === "/health") {
        const status = options.poller?.snapshot() ?? null;
        return { status: 200, body: { ok: true, poller: status && { running: status.running, merchants: status.merchants, lastCycleAt: status.lastCycleAt, lastError: status.lastError } } };
      }

      const token = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? "")?.[1];
      if (!token) return { status: 401, body: { error: "Sessão ausente." } };

      const order = /^\/ifood\/orders\/([A-Za-z0-9-]{1,64})\/(actions\/([a-z_]+)|cancellation-reasons|cancellation|dispute)$/.exec(path);
      if (order) {
        const orderId = order[1]!;
        if (!(await options.authorizer.canAccessOrder(token, orderId))) return { status: 404, body: { error: "Pedido não encontrado." } };
        const route = order[2]!;
        if (request.method === "POST" && order[3]) {
          const action = ACTIONS[order[3]];
          if (!action) return { status: 404, body: { error: "Ação desconhecida." } };
          return { status: 200, body: publicRecord(await options.inbox.performAction("ifood", orderId, action)) };
        }
        if (request.method === "GET" && route === "cancellation-reasons") {
          return { status: 200, body: await options.inbox.listCancellationReasons("ifood", orderId) };
        }
        if (request.method === "POST" && route === "cancellation") {
          const body = parseBody(request.body);
          const code = text(body.code, 32);
          const description = text(body.description, 250);
          if (!code || !description) return { status: 400, body: { error: "Escolha um motivo de cancelamento do iFood." } };
          // O motivo tem que ser um dos que o iFood oferece agora para este pedido.
          const reasons = await options.inbox.listCancellationReasons("ifood", orderId);
          const reason = reasons.find((candidate) => candidate.code === code);
          if (!reason) return { status: 400, body: { error: "Motivo não está entre os aceitos pelo iFood para este pedido." } };
          const record = await options.inbox.requestCancellation("ifood", orderId, reason, text(body.details, 250) ?? undefined);
          return { status: 200, body: publicRecord(record) };
        }
        if (request.method === "POST" && route === "dispute") {
          const decision = parseDecision(parseBody(request.body));
          if (!decision) return { status: 400, body: { error: "Resposta da negociação inválida." } };
          return { status: 200, body: publicRecord(await options.inbox.respondToDispute("ifood", orderId, decision)) };
        }
        return { status: 405, body: { error: "Método não permitido." } };
      }

      const merchant = /^\/ifood\/merchants\/([A-Za-z0-9-]{1,64})\/(status|pauses)(?:\/([A-Za-z0-9-]{1,64}))?$/.exec(path);
      if (merchant) {
        const merchantId = merchant[1]!;
        if (!(await options.authorizer.canAccessMerchant(token, merchantId))) return { status: 404, body: { error: "Loja não encontrada." } };
        if (request.method === "GET" && merchant[2] === "status" && !merchant[3]) {
          return { status: 200, body: await options.api.getStoreStatus(merchantId) };
        }
        if (request.method === "GET" && merchant[2] === "pauses" && !merchant[3]) {
          return { status: 200, body: await options.api.listPauses(merchantId) };
        }
        if (request.method === "POST" && merchant[2] === "pauses" && !merchant[3]) {
          const body = parseBody(request.body);
          const description = text(body.description, 200);
          const minutes = body.minutes;
          if (!description) return { status: 400, body: { error: "Informe o motivo da pausa." } };
          if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 1 || minutes > MAX_PAUSE_MINUTES) {
            return { status: 400, body: { error: `Pausa de 1 a ${MAX_PAUSE_MINUTES} minutos.` } };
          }
          // Início e fim pelo relógio do servidor, nunca pelo do aparelho.
          const start = now();
          const end = new Date(start.getTime() + minutes * 60_000);
          return { status: 201, body: await options.api.pauseStore(merchantId, { description, start: start.toISOString(), end: end.toISOString() }) };
        }
        if (request.method === "DELETE" && merchant[2] === "pauses" && merchant[3]) {
          await options.api.resumeStore(merchantId, merchant[3]);
          return { status: 204, body: null };
        }
        return { status: 405, body: { error: "Método não permitido." } };
      }

      return { status: 404, body: { error: "Rota não encontrada." } };
    } catch (error) {
      const response = errorResponse(error);
      if (response.status >= 500) (options.log ?? (() => undefined))(`[ifood] ${request.method} ${path}: ${error instanceof Error ? error.message : String(error)}`);
      return response;
    }
  };
}

class BadRequest extends Error {}

function parseBody(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // cai no erro abaixo
  }
  throw new BadRequest("JSON inválido.");
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function parseDecision(body: Record<string, unknown>): DeliveryDisputeDecision | null {
  if (body.kind === "accept") return { kind: "accept" };
  if (body.kind === "reject") {
    const reason = text(body.reason, 250);
    return reason ? { kind: "reject", reason } : null;
  }
  if (body.kind === "alternative") {
    const alternativeId = text(body.alternativeId, 64);
    return alternativeId && /^[A-Za-z0-9-]+$/.test(alternativeId) ? { kind: "alternative", alternativeId } : null;
  }
  return null;
}

// O que volta para o app: o pedido e o estado, sem a versão interna.
function publicRecord(record: DeliveryOrderRecord): Omit<DeliveryOrderRecord, "version"> {
  const { version: _version, ...rest } = record;
  return rest;
}

function errorResponse(error: unknown): ApiResponse {
  if (error instanceof BadRequest) return { status: 400, body: { error: error.message } };
  if (error instanceof DeliveryConcurrencyError) return { status: 409, body: { error: error.message, code: "conflict" } };
  if (error instanceof DeliveryMarketplaceError) {
    const status = {
      invalid_request: 400,
      not_found: 404,
      conflict: 409,
      rate_limited: 429,
      unavailable: 503,
      // Credencial do app ou resposta estranha do iFood: problema do servidor, não do aparelho.
      auth_failed: 502,
      invalid_response: 502,
    }[error.code];
    return { status, body: { error: error.message, code: error.code } };
  }
  // Erro interno (banco, bug): mensagem genérica; o detalhe fica no log do servidor.
  return { status: 500, body: { error: "Erro interno do servidor de delivery." } };
}
