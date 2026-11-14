import { DeliveryConcurrencyError, DeliveryInbox, DeliverySentNotSavedError, type DeliveryCycleReport, type DeliveryOrderRecord } from "../deliveryInbox";
import {
  DeliveryMarketplaceError,
  type DeliveryDisputeDecision,
  type DeliveryOrderAction,
} from "../marketplace";
import { DeliveryRepositoryError, fetchWithDeadline, type RestFetch } from "../supabaseDeliveryRepository";
import { IFOOD_POLLING_INTERVAL_MS, IfoodMerchantApi, isValidIfoodMerchantId } from "./ifoodMerchantApi";

// Servidor do iFood: um processo só, sempre ligado.
//  - Polling a cada 30 s das lojas com integração ativa (é o polling que mantém a loja aberta no iFood). Um ciclo
//    nunca começa antes do anterior terminar.
//  - API para o app: ações do pedido (confirmar, preparar, pronto, despachar), cancelamento com motivo do iFood,
//    resposta a negociação e pausa da loja. O app manda o JWT da sessão; o servidor só age em pedido/loja que o
//    RLS do Supabase mostra para esse JWT (a mesma prova de loja da emissão de NFC-e).
//  - Cancelar, responder negociação, pausar e retomar a loja exigem PIN de gerente e motivo, conferidos no banco
//    (tchefood_delivery_authorize, com o mesmo bloqueio de 3 erros em 60 s do PIN de gerente) ANTES de chamar o
//    iFood. A autorização e o resultado ficam em audit_logs.
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
  // Integrações ativas com merchantId inválido, deixadas fora do polling no último ciclo.
  invalidMerchants: number;
};

export class IfoodPoller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private current: Promise<void> | null = null;
  private readonly status: IfoodPollerStatus = {
    running: false,
    merchants: 0,
    lastCycleAt: null,
    lastReport: null,
    lastError: null,
    invalidMerchants: 0,
  };

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
      // merchantId mal cadastrado (espaço no fim, colado errado) fica fora do polling, com log; as outras lojas
      // seguem. Sem isso setMerchantIds lançaria e nenhuma loja receberia pedido.
      const valid: string[] = [];
      const invalid: string[] = [];
      for (const { merchantExternalId } of merchants) {
        (isValidIfoodMerchantId(merchantExternalId) ? valid : invalid).push(merchantExternalId);
      }
      for (const id of invalid) log(`[ifood] integração ativa com merchantId inválido, fora do polling: ${JSON.stringify(id)}`);
      const invalidError = invalid.length > 0 ? `${invalid.length} integração(ões) ativa(s) com merchantId inválido fora do polling.` : null;
      this.status.merchants = valid.length;
      this.status.invalidMerchants = invalid.length;
      // Sem loja ligada não há polling: sem o header x-polling-merchants o iFood mandaria eventos de lojas que
      // ninguém grava, e eles voltariam para sempre.
      if (valid.length === 0) {
        this.status.lastError = invalidError;
        return null;
      }
      this.options.api.setMerchantIds(valid);
      const report = await this.options.inbox.runChannel(this.options.api);
      this.status.lastReport = report;
      this.status.lastError = report.error ?? invalidError;
      if (report.received > 0 || report.error) {
        log(`[ifood] recebidos=${report.received} novos=${report.newOrders.length} ack=${report.acknowledged} adiados=${report.deferred}${report.error ? ` erro=${report.error}` : ""}`);
      }
      // Evento sem pedido que não deu para ler: confirmado (senão volta para sempre), mas fica registrado aqui.
      if (report.discarded.length > 0) log(`[ifood] eventos ilegíveis sem pedido confirmados: ${report.discarded.join(", ")}`);
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

// Prazo das consultas ao Supabase feitas durante uma requisição do app.
const SUPABASE_TIMEOUT_MS = 8_000;

export class SupabaseCallerAuthorizer implements TenantAuthorizer {
  private readonly base: string;
  private readonly fetchImpl: RestFetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: { url: string; anonKey: string; fetchImpl?: RestFetch; timeoutMs?: number }) {
    this.base = options.url.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? SUPABASE_TIMEOUT_MS;
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

  // Sem resposta no prazo: lança (a API responde 503 sem chamar o iFood); nunca libera.
  private async visible(query: string, accessToken: string): Promise<boolean> {
    const response = await fetchWithDeadline(
      this.fetchImpl,
      `${this.base}/rest/v1/${query}`,
      { method: "GET", headers: { apikey: this.options.anonKey, authorization: `Bearer ${accessToken}`, accept: "application/json" } },
      this.timeoutMs,
      "prova de loja",
    );
    // JWT inválido/vencido: o PostgREST responde 401/403. Qualquer outra falha também não libera nada.
    if (!response.ok) return false;
    try {
      const rows = JSON.parse(response.text) as unknown;
      return Array.isArray(rows) && rows.length > 0;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Alçada de gerente: PIN, motivo e registro em audit_logs
// ---------------------------------------------------------------------------

export type ManagerAction = "DELIVERY_CANCEL" | "DELIVERY_DISPUTE" | "DELIVERY_PAUSE" | "DELIVERY_RESUME";

export type ManagerRequest = {
  action: ManagerAction;
  externalOrderId: string | null;
  merchantExternalId: string | null;
  managerPin: string;
  performedBy: string;
  reason: string;
  // Gerado pelo app por tentativa: o reenvio da mesma autorização não grava outra.
  requestId: string;
  // O que o gerente aprovou, montado pelo servidor a partir do corpo já validado (gravado na autorização; o
  // reenvio com outro conteúdo é conflito): cancelamento {code}, negociação {kind, alternativeId?}, pausa
  // {minutes, description}, retomada {pauseId}.
  details: Record<string, unknown>;
};

export type ManagerDecision =
  // repeated: o banco já tinha esta tentativa (reenvio): a ação já foi mandada, ou está sendo, por outra requisição.
  | { status: "OK"; auditId: string; repeated?: boolean }
  | { status: "PIN_FAILED" | "PIN_LOCKED" | "CONFLICT" | "DENIED"; message: string };

export type ManagerOutcome = "sent" | "failed" | "uncertain";

export interface ManagerApproval {
  authorize(accessToken: string, request: ManagerRequest): Promise<ManagerDecision>;
  // Resultado da chamada ao iFood, gravado como outro registro em audit_logs (que é só de inserção).
  recordResult(auditId: string, outcome: ManagerOutcome, detail: string): Promise<void>;
}

export class SupabaseManagerApproval implements ManagerApproval {
  private readonly base: string;
  private readonly fetchImpl: RestFetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: { url: string; anonKey: string; serviceRoleKey: string; fetchImpl?: RestFetch; timeoutMs?: number }) {
    this.base = options.url.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? SUPABASE_TIMEOUT_MS;
  }

  // Com o JWT do app: a loja da sessão é a do banco (tchefood_tenant), nunca uma informada pelo app.
  async authorize(accessToken: string, request: ManagerRequest): Promise<ManagerDecision> {
    const response = await fetchWithDeadline(
      this.fetchImpl,
      `${this.base}/rest/v1/rpc/tchefood_delivery_authorize`,
      {
        method: "POST",
        headers: { apikey: this.options.anonKey, authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          p_channel: "ifood",
          p_action: request.action,
          p_external_order_id: request.externalOrderId,
          p_merchant_external_id: request.merchantExternalId,
          p_manager_pin: request.managerPin,
          p_performed_by: request.performedBy,
          p_reason: request.reason,
          p_request_id: request.requestId,
          p_details: request.details,
        }),
      },
      this.timeoutMs,
      "autorização de gerente",
    );
    if (!response.ok) {
      if (response.status >= 500) throw new DeliveryRepositoryError(`Supabase recusou a autorização (HTTP ${response.status}).`, response.status);
      return { status: "DENIED", message: postgrestMessage(response.text) ?? "Autorização recusada." };
    }
    let body: unknown;
    try {
      body = JSON.parse(response.text);
    } catch {
      throw new DeliveryRepositoryError("Resposta da autorização não é JSON.");
    }
    const record = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    if (record.status === "OK" && typeof record.auditId === "string") return { status: "OK", auditId: record.auditId, repeated: record.repeated === true };
    if (record.status === "PIN_FAILED") return { status: "PIN_FAILED", message: "PIN de gerente incorreto." };
    if (record.status === "PIN_LOCKED") return { status: "PIN_LOCKED", message: "PIN de gerente bloqueado por 1 minuto (3 erros)." };
    if (record.status === "CONFLICT") return { status: "CONFLICT", message: "Esta autorização já foi usada para outra ação." };
    throw new DeliveryRepositoryError("Resposta da autorização inválida.");
  }

  async recordResult(auditId: string, outcome: ManagerOutcome, detail: string): Promise<void> {
    const response = await fetchWithDeadline(
      this.fetchImpl,
      `${this.base}/rest/v1/rpc/tchefood_delivery_audit_result`,
      {
        method: "POST",
        headers: {
          apikey: this.options.serviceRoleKey,
          authorization: `Bearer ${this.options.serviceRoleKey}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ p_audit_id: auditId, p_outcome: outcome, p_detail: detail.slice(0, 500) }),
      },
      this.timeoutMs,
      "resultado da autorização",
    );
    if (!response.ok) throw new DeliveryRepositoryError(`Supabase recusou o resultado da autorização (HTTP ${response.status}).`, response.status);
  }
}

function postgrestMessage(raw: string): string | null {
  try {
    const body = JSON.parse(raw) as { message?: unknown };
    return typeof body.message === "string" ? body.message.replace(/^TCHEFOOD_[A-Z_]+:\s*/, "").slice(0, 200) : null;
  } catch {
    return null;
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
  approval: ManagerApproval;
  poller?: IfoodPoller;
  now?: () => Date;
  log?: (line: string) => void;
};

export function createIfoodApiHandler(options: IfoodApiOptions): (request: ApiRequest) => Promise<ApiResponse> {
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => undefined);

  // PIN de gerente conferido no banco antes de qualquer chamada ao iFood; o resultado da chamada também fica no
  // audit_logs. Falha ao gravar o resultado não muda a resposta (a autorização já está gravada), mas vai para o log.
  const withManager = async (token: string, request: ManagerRequest, run: () => Promise<ApiResponse>): Promise<ApiResponse> => {
    const decision = await options.approval.authorize(token, request);
    if (decision.status !== "OK") {
      return { status: decision.status === "CONFLICT" ? 409 : 403, body: { error: decision.message, code: decision.status } };
    }
    // Reenvio da mesma tentativa (resposta perdida, toque duplo): a primeira requisição já chamou (ou está chamando)
    // o iFood. Chamar de novo mandaria um segundo cancelamento ou criaria outra pausa.
    if (decision.repeated) {
      return { status: 409, body: { error: "Esta tentativa já foi enviada ao iFood; confira o pedido ou a loja antes de repetir.", code: "ALREADY_SUBMITTED" } };
    }
    const record = (outcome: ManagerOutcome, detail: string) =>
      options.approval.recordResult(decision.auditId, outcome, detail).catch((error: unknown) => {
        log(`[ifood] resultado da autorização ${decision.auditId} não gravado (${outcome}): ${error instanceof Error ? error.message : String(error)}`);
      });
    try {
      const response = await run();
      await record("sent", `HTTP ${response.status}`);
      return response;
    } catch (error) {
      const definite = error instanceof DeliveryMarketplaceError && ["invalid_request", "not_found", "conflict", "auth_failed", "rate_limited"].includes(error.code);
      // O iFood aceitou e só a gravação local falhou: para a auditoria, foi enviado.
      const outcome: ManagerOutcome = error instanceof DeliverySentNotSavedError ? "sent" : definite ? "failed" : "uncertain";
      await record(outcome, error instanceof Error ? error.message : String(error));
      throw error;
    }
  };

  return async (request) => {
    const path = request.path.split("?")[0] ?? "";
    try {
      if (request.method === "GET" && path === "/health") {
        // Rota pública: só o estado geral. O texto do erro (pode ter merchantId e resposta do iFood) fica no log.
        const status = options.poller?.snapshot() ?? null;
        return {
          status: 200,
          body: {
            ok: true,
            poller: status && { running: status.running, merchants: status.merchants, lastCycleAt: status.lastCycleAt, hasError: status.lastError !== null },
          },
        };
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
          const manager = parseManager(body.authorization);
          if (!manager) return { status: 400, body: { error: MANAGER_FIELDS_ERROR } };
          // O motivo tem que ser um dos que o iFood oferece agora para este pedido (conferido antes do PIN).
          const reasons = await options.inbox.listCancellationReasons("ifood", orderId);
          const reason = reasons.find((candidate) => candidate.code === code);
          if (!reason) return { status: 400, body: { error: "Motivo não está entre os aceitos pelo iFood para este pedido." } };
          const cancel = { ...manager, action: "DELIVERY_CANCEL" as const, externalOrderId: orderId, merchantExternalId: null, details: { code: reason.code } };
          return await withManager(token, cancel, async () => ({
            status: 200,
            body: publicRecord(await options.inbox.requestCancellation("ifood", orderId, reason, text(body.details, 250) ?? undefined)),
          }));
        }
        if (request.method === "POST" && route === "dispute") {
          const body = parseBody(request.body);
          const decision = parseDecision(body);
          if (!decision) return { status: 400, body: { error: "Resposta da negociação inválida." } };
          const manager = parseManager(body.authorization);
          if (!manager) return { status: 400, body: { error: MANAGER_FIELDS_ERROR } };
          // Motivo do aceite, valor e prazo da proposta conferidos contra a negociação gravada antes do PIN.
          await options.inbox.checkDisputeDecision("ifood", orderId, decision);
          // O registro do gerente leva a resposta inteira (aceite com motivo, recusa, valor ou prazo da proposta).
          const details = JSON.parse(JSON.stringify(decision)) as Record<string, unknown>;
          return await withManager(token, { ...manager, action: "DELIVERY_DISPUTE", externalOrderId: orderId, merchantExternalId: null, details }, async () => ({
            status: 200,
            body: publicRecord(await options.inbox.respondToDispute("ifood", orderId, decision)),
          }));
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
          const manager = parseManager(body.authorization);
          if (!manager) return { status: 400, body: { error: MANAGER_FIELDS_ERROR } };
          const pause = { ...manager, action: "DELIVERY_PAUSE" as const, externalOrderId: null, merchantExternalId: merchantId, details: { minutes, description } };
          return await withManager(token, pause, async () => {
            // Início e fim pelo relógio do servidor, nunca pelo do aparelho (contados depois da autorização).
            const start = now();
            const end = new Date(start.getTime() + minutes * 60_000);
            // O id da interrupção é o id da tentativa: a mesma tentativa nunca cria duas pausas no iFood.
            const created = await options.api.pauseStore(merchantId, { id: manager.requestId, description, start: start.toISOString(), end: end.toISOString() });
            return { status: 201, body: created };
          });
        }
        if (request.method === "DELETE" && merchant[2] === "pauses" && merchant[3]) {
          const pauseId = merchant[3];
          const manager = parseManager(parseBody(request.body).authorization);
          if (!manager) return { status: 400, body: { error: MANAGER_FIELDS_ERROR } };
          return await withManager(token, { ...manager, action: "DELIVERY_RESUME", externalOrderId: null, merchantExternalId: merchantId, details: { pauseId } }, async () => {
            await options.api.resumeStore(merchantId, pauseId);
            return { status: 204, body: null };
          });
        }
        return { status: 405, body: { error: "Método não permitido." } };
      }

      return { status: 404, body: { error: "Rota não encontrada." } };
    } catch (error) {
      const response = errorResponse(error);
      if (response.status >= 500) log(`[ifood] ${request.method} ${path}: ${error instanceof Error ? error.message : String(error)}`);
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

const MANAGER_FIELDS_ERROR = "Ação de gerente: informe o PIN de gerente, o operador, o motivo (5 caracteres ou mais) e o id da tentativa.";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseManager(raw: unknown): Omit<ManagerRequest, "action" | "externalOrderId" | "merchantExternalId" | "details"> | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  const managerPin = typeof body.managerPin === "string" && /^\d{4,8}$/.test(body.managerPin) ? body.managerPin : null;
  const performedBy = typeof body.performedBy === "string" && UUID_PATTERN.test(body.performedBy) ? body.performedBy : null;
  const requestId = typeof body.requestId === "string" && UUID_PATTERN.test(body.requestId) ? body.requestId : null;
  const reason = text(body.reason, 250);
  if (!managerPin || !performedBy || !requestId || !reason || reason.length < 5) return null;
  return { managerPin, performedBy, requestId, reason };
}

// Corpo da rota /dispute:
//   aceite      {kind: "accept", reason?, detailReason?}  reason = código da lista do iFood (obrigatório se houver lista)
//   recusa      {kind: "reject", reason}
//   proposta    {kind: "alternative", alternativeId, amountCents?}                                (REFUND/BENEFIT)
//               {kind: "alternative", alternativeId, additionalTimeInMinutes?, additionalTimeReason?} (ADDITIONAL_TIME)
// Aqui só se confere o formato; os limites da negociação são conferidos pela caixa de entrada.
function parseDecision(body: Record<string, unknown>): DeliveryDisputeDecision | null {
  const code = (value: unknown) => {
    const parsed = text(value, 80);
    return parsed && /^[A-Z0-9_]+$/.test(parsed) ? parsed : null;
  };
  const positiveInteger = (value: unknown) => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null);
  if (body.kind === "accept") {
    if (body.reason !== undefined && !code(body.reason)) return null;
    const reason = code(body.reason);
    const detailReason = text(body.detailReason, 250);
    return { kind: "accept", ...(reason ? { reason } : {}), ...(detailReason ? { detailReason } : {}) };
  }
  if (body.kind === "reject") {
    const reason = text(body.reason, 250);
    return reason ? { kind: "reject", reason } : null;
  }
  if (body.kind === "alternative") {
    const alternativeId = text(body.alternativeId, 64);
    if (!alternativeId || !/^[A-Za-z0-9-]+$/.test(alternativeId)) return null;
    const amountCents = positiveInteger(body.amountCents);
    const additionalTimeInMinutes = positiveInteger(body.additionalTimeInMinutes);
    const additionalTimeReason = code(body.additionalTimeReason);
    if (body.amountCents !== undefined && amountCents === null) return null;
    if (body.additionalTimeInMinutes !== undefined && additionalTimeInMinutes === null) return null;
    if (body.additionalTimeReason !== undefined && additionalTimeReason === null) return null;
    return {
      kind: "alternative",
      alternativeId,
      ...(amountCents !== null ? { amountCents } : {}),
      ...(additionalTimeInMinutes !== null ? { additionalTimeInMinutes } : {}),
      ...(additionalTimeReason !== null ? { additionalTimeReason } : {}),
    };
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
  // O iFood aceitou e a gravação no banco falhou depois: repetir às cegas mandaria a ação de novo.
  if (error instanceof DeliverySentNotSavedError) {
    return { status: 503, body: { error: "Enviado ao iFood, mas não deu para gravar; confira o pedido antes de repetir.", code: "sent_not_saved" } };
  }
  // Supabase fora do ar ou lento antes da chamada ao iFood (prova de loja, autorização, reserva): nada foi feito lá.
  if (error instanceof DeliveryRepositoryError) return { status: 503, body: { error: "Banco indisponível; tente de novo.", code: "unavailable" } };
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
