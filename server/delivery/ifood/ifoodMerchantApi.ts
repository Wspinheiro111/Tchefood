import {
  DeliveryMarketplaceError,
  type DeliveryAddress,
  type DeliveryCancellationReason,
  type DeliveryCourier,
  type DeliveryDispute,
  type DeliveryDisputeDecision,
  type DeliveryEvent,
  type DeliveryEventSignal,
  type DeliveryFulfillment,
  type DeliveryMarketplaceAdapter,
  type DeliveryMarketplaceErrorCode,
  type DeliveryOrder,
  type DeliveryOrderAction,
  type DeliveryOrderItem,
  type DeliveryOrderOption,
  type DeliveryOrderPayment,
  type DeliveryPaymentMethod,
  type DeliveryStoreControl,
  type DeliveryStorePause,
  type DeliveryStoreState,
  type DeliveryStoreStatus,
} from "../marketplace";

// iFood Merchant API (https://developer.ifood.com.br). Fluxo de pedidos:
//  1. Token OAuth2 (client_credentials) de app centralizado (sem refresh token). Reaproveitado até perto de vencer.
//  2. Polling de eventos a cada 30 s com o header x-polling-merchants: o polling mantém a loja ativa no iFood.
//  3. Ack de TODO evento recebido (até os ignorados), só DEPOIS de gravar. Evento sem ack volta no próximo polling.
//  4. Detalhe do pedido consultado uma vez (é imutável); ações confirm/startPreparation/readyToPickup/dispatch
//     respondem 202 e só valem quando o evento correspondente chega no polling.
//
// Conferência com a documentação oficial (14/11/2026): docs/integracoes/delivery/ifood-homologacao.md. As rotas
// abaixo marcadas "a confirmar" existem no portal (página de limites), mas o prefixo de versão ou o corpo não
// puderam ser lidos; todas ficam neste objeto para corrigir num lugar só.
export const IFOOD_PATHS = {
  // a confirmar: prefixo /authentication/v1.0 e nomes grantType/clientId/clientSecret.
  token: "/authentication/v1.0/oauth/token",
  // a confirmar: prefixo /order/v1.0 (a página de limites lista só "/events:polling").
  polling: "/order/v1.0/events:polling",
  acknowledgment: "/order/v1.0/events/acknowledgment",
  order: (orderId: string) => `/order/v1.0/orders/${orderId}`,
  orderAction: (orderId: string, action: string) => `/order/v1.0/orders/${orderId}/${action}`,
  // conferido na página de limites (caminho completo).
  disputeAccept: (disputeId: string) => `/order/v1.0/disputes/${disputeId}/accept`,
  disputeReject: (disputeId: string) => `/order/v1.0/disputes/${disputeId}/reject`,
  disputeAlternative: (disputeId: string, alternativeId: string) => `/order/v1.0/disputes/${disputeId}/alternatives/${alternativeId}`,
  // a confirmar: prefixo /merchant/v1.0 (a página de limites lista só "/merchants/{merchantId}/...").
  merchantStatus: (merchantId: string) => `/merchant/v1.0/merchants/${merchantId}/status`,
  interruptions: (merchantId: string) => `/merchant/v1.0/merchants/${merchantId}/interruptions`,
  interruption: (merchantId: string, interruptionId: string) => `/merchant/v1.0/merchants/${merchantId}/interruptions/${interruptionId}`,
} as const;

export const IFOOD_DEFAULT_BASE_URL = "https://merchant-api.ifood.com.br";
// Documentação oficial (boas práticas): "Execute polling every 30 seconds to keep the merchant active".
export const IFOOD_POLLING_INTERVAL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 15_000;
// Renova o token um pouco antes de vencer para não perder um ciclo de polling.
const TOKEN_EXPIRY_MARGIN_MS = 60_000;
// Ids por chamada de ack (a confirmar no portal; lotes menores não fazem mal).
const MAX_ACK_BATCH = 2_000;
// Ids do iFood são UUIDs; o merchantId também.
const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

// Código do evento -> sinal comum (lista oficial: /pt-BR/docs/guides/order/events). Código ausente desta tabela
// (entregador, troca de endereço, alteração de itens etc.) vira "unknown": o evento é registrado e confirmado,
// mas não mexe no pedido. SPS/SPE são só do iFood Mercado; ficam como "preparando" por segurança.
const IFOOD_EVENT_SIGNALS: Readonly<Record<string, DeliveryEventSignal>> = {
  PLC: "placed",
  CFM: "confirmed",
  PRS: "preparing",
  SPS: "preparing",
  RTP: "ready_for_pickup",
  DSP: "dispatched",
  CON: "concluded",
  CAN: "cancelled",
  CAR: "cancellation_requested",
  CARF: "cancellation_denied",
  CCR: "customer_cancellation_requested",
  CCA: "customer_cancellation_accepted",
  CCD: "customer_cancellation_denied",
  HSD: "dispute_opened",
  HSS: "dispute_settled",
};

export function mapIfoodEventCode(code: string): DeliveryEventSignal {
  return IFOOD_EVENT_SIGNALS[code] ?? "unknown";
}

const ACTION_PATHS: Readonly<Record<DeliveryOrderAction, string>> = {
  confirm: "confirm",
  start_preparation: "startPreparation",
  ready_for_pickup: "readyToPickup",
  dispatch: "dispatch",
};

export type IfoodCredentials = {
  clientId: string;
  clientSecret: string;
};

export type IfoodMerchantApiOptions = {
  credentials: IfoodCredentials;
  // Lojas (merchantId) cujos eventos esta instância busca. Vazio = todas as lojas autorizadas no app.
  merchantIds?: readonly string[];
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

type CachedToken = { value: string; expiresAt: number };

export class IfoodMerchantApi implements DeliveryMarketplaceAdapter, DeliveryStoreControl {
  readonly channel = "ifood" as const;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private merchantIds: readonly string[];
  private token: CachedToken | null = null;
  private tokenRequest: Promise<string> | null = null;

  constructor(private readonly options: IfoodMerchantApiOptions) {
    const { clientId, clientSecret } = options.credentials;
    if (!clientId.trim() || !clientSecret.trim()) {
      throw new DeliveryMarketplaceError("ifood", "invalid_request", "Informe o client_id e o client_secret do app iFood.");
    }
    for (const id of options.merchantIds ?? []) {
      if (!ID_PATTERN.test(id)) throw new DeliveryMarketplaceError("ifood", "invalid_request", `merchantId inválido: ${id}`);
    }
    this.baseUrl = (options.baseUrl ?? IFOOD_DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.merchantIds = options.merchantIds ?? [];
  }

  // Lojas buscadas no polling (o servidor relê as integrações ativas a cada ciclo).
  setMerchantIds(merchantIds: readonly string[]): void {
    for (const id of merchantIds) {
      if (!ID_PATTERN.test(id)) throw new DeliveryMarketplaceError("ifood", "invalid_request", `merchantId inválido: ${id}`);
    }
    this.merchantIds = [...merchantIds];
  }

  async pollEvents(): Promise<DeliveryEvent[]> {
    const headers: Record<string, string> = {};
    if (this.merchantIds.length > 0) headers["x-polling-merchants"] = this.merchantIds.join(",");
    const body = await this.request("GET", IFOOD_PATHS.polling, { headers });
    // 204 = nenhum evento novo.
    if (body === null) return [];
    if (!Array.isArray(body)) throw this.invalid("Resposta do polling não é uma lista.");
    // Um evento estranho não pode travar os outros: o que tem id é confirmado (ack) mesmo sem dar para usar;
    // sem id não há como confirmar, e ele só é descartado.
    const events: DeliveryEvent[] = [];
    for (const raw of body) {
      const event = parseIfoodEventLenient(raw);
      if (event) events.push(event);
    }
    return events;
  }

  async acknowledge(events: readonly DeliveryEvent[]): Promise<void> {
    const ids = [...new Set(events.map((event) => event.externalEventId))];
    for (let start = 0; start < ids.length; start += MAX_ACK_BATCH) {
      const batch = ids.slice(start, start + MAX_ACK_BATCH).map((id) => ({ id }));
      await this.request("POST", IFOOD_PATHS.acknowledgment, { json: batch });
    }
  }

  async getOrder(externalOrderId: string): Promise<DeliveryOrder> {
    const body = await this.request("GET", IFOOD_PATHS.order(this.orderId(externalOrderId)));
    if (body === null) throw new DeliveryMarketplaceError("ifood", "not_found", `Pedido ${externalOrderId} sem detalhes no iFood.`);
    return mapIfoodOrder(body);
  }

  async performAction(externalOrderId: string, action: DeliveryOrderAction): Promise<void> {
    await this.request("POST", IFOOD_PATHS.orderAction(this.orderId(externalOrderId), ACTION_PATHS[action]));
  }

  async listCancellationReasons(externalOrderId: string): Promise<DeliveryCancellationReason[]> {
    const body = await this.request("GET", IFOOD_PATHS.orderAction(this.orderId(externalOrderId), "cancellationReasons"));
    if (body === null) return [];
    if (!Array.isArray(body)) throw this.invalid("Lista de motivos de cancelamento inválida.");
    return body.map((raw) => {
      const reason = asRecord(raw);
      const code = optionalString(reason?.cancelCodeId);
      const description = optionalString(reason?.description);
      if (!code || !description) throw this.invalid("Motivo de cancelamento sem código ou descrição.");
      return { code, description };
    });
  }

  async requestCancellation(externalOrderId: string, reason: DeliveryCancellationReason, details?: string): Promise<void> {
    if (!reason.code.trim()) throw new DeliveryMarketplaceError("ifood", "invalid_request", "Escolha um motivo de cancelamento do iFood.");
    await this.request("POST", IFOOD_PATHS.orderAction(this.orderId(externalOrderId), "requestCancellation"), {
      json: { reason: (details?.trim() || reason.description).slice(0, 250), cancellationCode: reason.code },
    });
  }

  async respondToDispute(disputeId: string, decision: DeliveryDisputeDecision): Promise<void> {
    const id = this.safeId(disputeId, "negociação");
    // Corpo das respostas a confirmar no portal: a recusa leva o motivo, o resto vai sem corpo.
    if (decision.kind === "accept") {
      await this.request("POST", IFOOD_PATHS.disputeAccept(id));
    } else if (decision.kind === "reject") {
      const reason = decision.reason.trim();
      if (!reason) throw new DeliveryMarketplaceError("ifood", "invalid_request", "Informe o motivo da recusa.");
      await this.request("POST", IFOOD_PATHS.disputeReject(id), { json: { reason: reason.slice(0, 250) } });
    } else {
      await this.request("POST", IFOOD_PATHS.disputeAlternative(id, this.safeId(decision.alternativeId, "proposta")));
    }
  }

  async getStoreStatus(merchantExternalId: string): Promise<DeliveryStoreStatus> {
    const body = await this.request("GET", IFOOD_PATHS.merchantStatus(this.safeId(merchantExternalId, "loja")));
    return mapIfoodStoreStatus(body);
  }

  async listPauses(merchantExternalId: string): Promise<DeliveryStorePause[]> {
    const body = await this.request("GET", IFOOD_PATHS.interruptions(this.safeId(merchantExternalId, "loja")));
    if (body === null) return [];
    if (!Array.isArray(body)) throw this.invalid("Lista de pausas inválida.");
    return body.map(mapIfoodInterruption);
  }

  async pauseStore(merchantExternalId: string, pause: { description: string; start: string; end: string }): Promise<DeliveryStorePause> {
    const description = pause.description.trim();
    const start = Date.parse(pause.start);
    const end = Date.parse(pause.end);
    if (!description) throw new DeliveryMarketplaceError("ifood", "invalid_request", "Informe o motivo da pausa.");
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      throw new DeliveryMarketplaceError("ifood", "invalid_request", "Pausa com início/fim inválidos.");
    }
    // O id da interrupção é escolhido por quem cria (a confirmar no portal); um UUID novo evita colisão.
    const id = crypto.randomUUID();
    const json = { id, description: description.slice(0, 200), start: new Date(start).toISOString(), end: new Date(end).toISOString() };
    const body = await this.request("POST", IFOOD_PATHS.interruptions(this.safeId(merchantExternalId, "loja")), { json });
    return body === null ? json : mapIfoodInterruption(body);
  }

  async resumeStore(merchantExternalId: string, pauseId: string): Promise<void> {
    await this.request("DELETE", IFOOD_PATHS.interruption(this.safeId(merchantExternalId, "loja"), this.safeId(pauseId, "pausa")));
  }

  // -------------------------------------------------------------------------

  private orderId(externalOrderId: string): string {
    return this.safeId(externalOrderId, "pedido");
  }

  private safeId(value: string, label: string): string {
    if (!ID_PATTERN.test(value)) {
      throw new DeliveryMarketplaceError("ifood", "invalid_request", `Id de ${label} iFood inválido: ${value}`);
    }
    return encodeURIComponent(value);
  }

  private invalid(message: string): DeliveryMarketplaceError {
    return new DeliveryMarketplaceError("ifood", "invalid_response", message);
  }

  private async accessToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.token && this.token.expiresAt - TOKEN_EXPIRY_MARGIN_MS > this.now()) return this.token.value;
    // Um único pedido de token por vez, mesmo com várias chamadas simultâneas.
    if (!this.tokenRequest) {
      this.tokenRequest = this.fetchToken().finally(() => {
        this.tokenRequest = null;
      });
    }
    return this.tokenRequest;
  }

  private async fetchToken(): Promise<string> {
    const form = new URLSearchParams({
      grantType: "client_credentials",
      clientId: this.options.credentials.clientId,
      clientSecret: this.options.credentials.clientSecret,
    });
    const response = await this.send(IFOOD_PATHS.token, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: form.toString(),
    });
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      throw new DeliveryMarketplaceError("ifood", "auth_failed", "O iFood recusou as credenciais do app.", response.status);
    }
    const body = this.readBody(response);
    const record = asRecord(body);
    const value = optionalString(record?.accessToken);
    const expiresIn = typeof record?.expiresIn === "number" ? record.expiresIn : null;
    if (!value || expiresIn === null || expiresIn <= 0) throw this.invalid("Token do iFood sem accessToken/expiresIn.");
    this.token = { value, expiresAt: this.now() + expiresIn * 1000 };
    return value;
  }

  private async request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    init: { headers?: Record<string, string>; json?: unknown } = {},
  ): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await this.accessToken(attempt > 0);
      const headers: Record<string, string> = { accept: "application/json", authorization: `Bearer ${token}`, ...init.headers };
      if (init.json !== undefined) headers["content-type"] = "application/json";
      const response = await this.send(path, {
        method,
        headers,
        body: init.json === undefined ? undefined : JSON.stringify(init.json),
      });
      // Token revogado/expirado antes da hora: renova uma vez e repete.
      if (response.status === 401 && attempt === 0) continue;
      return this.readBody(response);
    }
    throw new DeliveryMarketplaceError("ifood", "auth_failed", "O iFood recusou o token renovado.", 401);
  }

  // Faz a chamada E lê o corpo inteiro dentro do mesmo prazo: um iFood que manda o cabeçalho e trava no corpo
  // não pode prender o polling para sempre.
  private async send(path: string, init: RequestInit): Promise<RawResponse> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new DeliveryMarketplaceError("ifood", "unavailable", "iFood indisponível (tempo esgotado)."));
      }, this.timeoutMs);
    });
    const exchange = (async (): Promise<RawResponse> => {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, signal: controller.signal });
      const text = response.status === 204 ? "" : await response.text();
      return { status: response.status, ok: response.ok, text };
    })();
    try {
      return await Promise.race([exchange, deadline]);
    } catch (error) {
      if (error instanceof DeliveryMarketplaceError) throw error;
      const reason = error instanceof Error && error.name === "AbortError" ? "tempo esgotado" : "falha de rede";
      throw new DeliveryMarketplaceError("ifood", "unavailable", `iFood indisponível (${reason}).`);
    } finally {
      clearTimeout(timer);
      // A corrida perdida não pode virar "unhandled rejection".
      exchange.catch(() => undefined);
    }
  }

  private readBody(response: RawResponse): unknown {
    if (response.status === 204) return null;
    if (!response.ok) {
      throw new DeliveryMarketplaceError("ifood", errorCodeForStatus(response.status), describeIfoodError(response.status, response.text), response.status);
    }
    if (!response.text.trim()) return null;
    try {
      return JSON.parse(response.text) as unknown;
    } catch {
      throw this.invalid("O iFood respondeu algo que não é JSON.");
    }
  }
}

type RawResponse = { status: number; ok: boolean; text: string };

function errorCodeForStatus(status: number): DeliveryMarketplaceErrorCode {
  if (status === 401 || status === 403) return "auth_failed";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "unavailable";
  return "invalid_request";
}

function describeIfoodError(status: number, text: string): string {
  let detail = "";
  try {
    const record = asRecord(JSON.parse(text));
    const error = asRecord(record?.error) ?? record;
    detail = optionalString(error?.message) ?? optionalString(error?.code) ?? "";
  } catch {
    detail = "";
  }
  return `iFood respondeu HTTP ${status}${detail ? `: ${detail.slice(0, 200)}` : ""}.`;
}

// ---------------------------------------------------------------------------
// Tradução do JSON do iFood para o formato comum (funções puras, testadas sem rede)
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function optionalString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function requiredString(value: unknown, field: string): string {
  const parsed = optionalString(value);
  if (!parsed) throw new DeliveryMarketplaceError("ifood", "invalid_response", `Campo obrigatório ausente no iFood: ${field}.`);
  return parsed;
}

// O iFood manda reais com casas decimais (ex.: 25.9). Tudo vira centavos inteiros aqui.
function cents(value: unknown, field: string, required = false): number {
  if (value === undefined || value === null) {
    if (required) throw new DeliveryMarketplaceError("ifood", "invalid_response", `Valor ausente no iFood: ${field}.`);
    return 0;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new DeliveryMarketplaceError("ifood", "invalid_response", `Valor inválido no iFood: ${field}.`);
  }
  return Math.round(value * 100);
}

function quantity(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new DeliveryMarketplaceError("ifood", "invalid_response", `Quantidade inválida no iFood: ${field}.`);
  }
  return value;
}

// Horário do evento sempre em ISO UTC ("...Z"): a caixa de entrada compara horários como texto, e o iFood pode
// mandar com fuso ("-03:00") ou sem milissegundos. Horário ausente ou ilegível vira o mais antigo possível, para
// nunca passar na frente de um evento com horário de verdade.
function isoInstant(value: unknown): string {
  const text = optionalString(value);
  const parsed = text ? Date.parse(text) : Number.NaN;
  return new Date(Number.isFinite(parsed) ? parsed : 0).toISOString();
}

export function parseIfoodEvent(raw: unknown): DeliveryEvent {
  const record = asRecord(raw);
  if (!record) throw new DeliveryMarketplaceError("ifood", "invalid_response", "Evento do iFood inválido.");
  const rawCode = requiredString(record.code, "event.code");
  const signal = mapIfoodEventCode(rawCode);
  return {
    channel: "ifood",
    externalEventId: requiredString(record.id, "event.id"),
    externalOrderId: requiredString(record.orderId, "event.orderId"),
    merchantExternalId: optionalString(record.merchantId) ?? "",
    rawCode,
    signal,
    createdAt: isoInstant(record.createdAt),
    dispute: signal === "dispute_opened" ? parseIfoodDispute(record.metadata) : null,
  };
}

// Versão do polling: evento com id mas incompleto vira "unknown" com malformed = true, mantendo o pedido quando
// ele veio (vai para o histórico do pedido e vira pendência); evento sem id volta null (não há o que confirmar).
// Nunca lança.
export function parseIfoodEventLenient(raw: unknown): DeliveryEvent | null {
  try {
    return parseIfoodEvent(raw);
  } catch {
    const record = asRecord(raw);
    const id = optionalString(record?.id);
    if (!id) return null;
    // O pedido do evento é mantido sempre que vier num formato aceitável: o evento vai para o histórico do pedido
    // (e busca o detalhe, se o pedido for novo) em vez de ser confirmado e esquecido.
    const orderId = optionalString(record?.orderId);
    return {
      channel: "ifood",
      externalEventId: id,
      externalOrderId: orderId && ID_PATTERN.test(orderId) ? orderId : "",
      merchantExternalId: optionalString(record?.merchantId) ?? "",
      rawCode: optionalString(record?.code) ?? "?",
      signal: "unknown",
      createdAt: isoInstant(record?.createdAt),
      dispute: null,
      malformed: true,
    };
  }
}

// Metadados da negociação (HSD). Os nomes dos campos vêm do exemplo da página de eventos e ficam a confirmar;
// sem id a negociação não pode ser respondida e o pedido vai para conferência humana.
export function parseIfoodDispute(raw: unknown): DeliveryDispute | null {
  const metadata = asRecord(raw);
  const id = optionalString(metadata?.disputeId) ?? optionalString(metadata?.id);
  if (!metadata || !id || !ID_PATTERN.test(id)) return null;
  const alternatives = Array.isArray(metadata.alternatives)
    ? metadata.alternatives.flatMap((entry) => {
        const alternative = asRecord(entry);
        const alternativeId = optionalString(alternative?.id);
        if (!alternative || !alternativeId || !ID_PATTERN.test(alternativeId)) return [];
        return [{ id: alternativeId, type: optionalString(alternative.type), description: optionalString(alternative.description) }];
      })
    : [];
  return {
    id,
    action: optionalString(metadata.action) ?? optionalString(metadata.handshakeType),
    message: optionalString(metadata.message),
    expiresAt: optionalString(metadata.expiresAt) ?? optionalString(metadata.timeoutAt),
    alternatives,
  };
}

const STORE_STATES: Readonly<Record<string, DeliveryStoreState>> = {
  OK: "open",
  WARNING: "warning",
  CLOSED: "closed",
  ERROR: "error",
};

// Status da loja: o iFood devolve uma lista por operação (entrega, retirada...). A loja está aberta se alguma
// operação estiver OK; fechada se todas estiverem fechadas. Campos a confirmar no portal.
export function mapIfoodStoreStatus(raw: unknown): DeliveryStoreStatus {
  const list = Array.isArray(raw) ? raw : raw === null ? [] : [raw];
  const operations = list.flatMap((entry) => {
    const record = asRecord(entry);
    if (!record) return [];
    const message = asRecord(record.message);
    return [{
      operation: optionalString(record.operation) ?? "DELIVERY",
      state: STORE_STATES[optionalString(record.state) ?? ""] ?? ("unknown" as DeliveryStoreState),
      available: typeof record.available === "boolean" ? record.available : null,
      message: optionalString(message?.title) ?? optionalString(message?.subtitle) ?? optionalString(record.message),
    }];
  });
  const states = operations.map((operation) => operation.state);
  const state: DeliveryStoreState = states.length === 0
    ? "unknown"
    : states.includes("open")
      ? "open"
      : states.includes("warning")
        ? "warning"
        : states.includes("error")
          ? "error"
          : states.every((value) => value === "closed")
            ? "closed"
            : "unknown";
  return { state, message: operations.find((operation) => operation.message)?.message ?? null, operations };
}

export function mapIfoodInterruption(raw: unknown): DeliveryStorePause {
  const record = asRecord(raw);
  if (!record) throw new DeliveryMarketplaceError("ifood", "invalid_response", "Pausa do iFood inválida.");
  return {
    id: requiredString(record.id, "interruption.id"),
    description: optionalString(record.description) ?? "",
    start: requiredString(record.start, "interruption.start"),
    end: requiredString(record.end, "interruption.end"),
  };
}

const PAYMENT_METHODS: Readonly<Record<string, DeliveryPaymentMethod>> = {
  CREDIT: "credit",
  DEBIT: "debit",
  PIX: "pix",
  CASH: "cash",
  MEAL_VOUCHER: "meal_voucher",
  FOOD_VOUCHER: "meal_voucher",
  GIFT_CARD: "voucher",
  DIGITAL_WALLET: "other",
  OTHER: "other",
};

function mapFulfillment(orderType: string | null): DeliveryFulfillment {
  if (orderType === "TAKEOUT") return "takeout";
  if (orderType === "INDOOR" || orderType === "DINE_IN") return "indoor";
  return "delivery";
}

function mapCourier(deliveredBy: string | null): DeliveryCourier {
  if (deliveredBy === "IFOOD") return "marketplace";
  if (deliveredBy === "MERCHANT") return "merchant";
  return "unknown";
}

function mapOption(raw: unknown, index: number): DeliveryOrderOption {
  const record = asRecord(raw);
  if (!record) throw new DeliveryMarketplaceError("ifood", "invalid_response", `Complemento ${index} inválido.`);
  const qty = quantity(record.quantity, `options[${index}].quantity`);
  const unit = cents(record.unitPrice, `options[${index}].unitPrice`);
  return {
    name: requiredString(record.name, `options[${index}].name`),
    externalCode: optionalString(record.externalCode),
    quantity: qty,
    unitPriceCents: unit,
    totalPriceCents: record.price === undefined ? Math.round(unit * qty) : cents(record.price, `options[${index}].price`),
  };
}

function mapItem(raw: unknown, index: number): DeliveryOrderItem {
  const record = asRecord(raw);
  if (!record) throw new DeliveryMarketplaceError("ifood", "invalid_response", `Item ${index} inválido.`);
  const options = Array.isArray(record.options) ? record.options.map(mapOption) : [];
  return {
    externalId: requiredString(record.uniqueId ?? record.id, `items[${index}].id`),
    externalCode: optionalString(record.externalCode),
    name: requiredString(record.name, `items[${index}].name`),
    quantity: quantity(record.quantity, `items[${index}].quantity`),
    unitPriceCents: cents(record.unitPrice, `items[${index}].unitPrice`, true),
    optionsPriceCents: cents(record.optionsPrice, `items[${index}].optionsPrice`),
    totalPriceCents: cents(record.totalPrice, `items[${index}].totalPrice`, true),
    notes: optionalString(record.observations),
    options,
  };
}

function mapAddress(raw: unknown): DeliveryAddress | null {
  const record = asRecord(raw);
  if (!record) return null;
  return {
    street: optionalString(record.streetName) ?? optionalString(record.formattedAddress) ?? "",
    number: optionalString(record.streetNumber) ?? "S/N",
    complement: optionalString(record.complement),
    neighborhood: optionalString(record.neighborhood) ?? "",
    city: optionalString(record.city) ?? "",
    state: optionalString(record.state) ?? "",
    postalCode: optionalString(record.postalCode) ?? "",
    reference: optionalString(record.reference),
  };
}

function mapPayment(raw: unknown, index: number): DeliveryOrderPayment {
  const record = asRecord(raw);
  if (!record) throw new DeliveryMarketplaceError("ifood", "invalid_response", `Pagamento ${index} inválido.`);
  const method = PAYMENT_METHODS[optionalString(record.method) ?? ""] ?? "other";
  const card = asRecord(record.card);
  const cash = asRecord(record.cash);
  return {
    method,
    prepaid: optionalString(record.type) === "ONLINE",
    amountCents: cents(record.value, `payments.methods[${index}].value`, true),
    cardBrand: optionalString(card?.brand),
    changeForCents: method === "cash" && cash?.changeFor !== undefined ? cents(cash.changeFor, "cash.changeFor") : null,
  };
}

// Parte dos descontos que o iFood (ou um parceiro) paga: patrocínio IFOOD/EXTERNAL conta como pagamento para a
// loja; MERCHANT/CHAIN é desconto da própria loja (página oficial de detalhes do pedido).
const MARKETPLACE_SPONSORS = new Set(["IFOOD", "EXTERNAL"]);

function sponsoredByMarketplace(raw: unknown): number {
  if (!Array.isArray(raw)) return 0;
  let total = 0;
  raw.forEach((entry, index) => {
    const benefit = asRecord(entry);
    const sponsorships = Array.isArray(benefit?.sponsorshipValues) ? benefit.sponsorshipValues : [];
    sponsorships.forEach((value, sponsorIndex) => {
      const sponsorship = asRecord(value);
      if (MARKETPLACE_SPONSORS.has(optionalString(sponsorship?.name) ?? "")) {
        total += cents(sponsorship?.value, `benefits[${index}].sponsorshipValues[${sponsorIndex}].value`);
      }
    });
  });
  return total;
}

export function mapIfoodOrder(raw: unknown): DeliveryOrder {
  const record = asRecord(raw);
  if (!record) throw new DeliveryMarketplaceError("ifood", "invalid_response", "Pedido do iFood inválido.");
  const merchant = asRecord(record.merchant);
  const customer = asRecord(record.customer);
  const phone = asRecord(customer?.phone);
  const delivery = asRecord(record.delivery);
  const total = asRecord(record.total);
  const paymentsRecord = asRecord(record.payments);
  const schedule = asRecord(record.schedule);
  const fulfillment = mapFulfillment(optionalString(record.orderType));
  const scheduled = optionalString(record.orderTiming) === "SCHEDULED";

  const items = Array.isArray(record.items) ? record.items.map(mapItem) : [];
  if (items.length === 0) throw new DeliveryMarketplaceError("ifood", "invalid_response", "Pedido do iFood sem itens.");
  const payments = Array.isArray(paymentsRecord?.methods) ? paymentsRecord.methods.map(mapPayment) : [];

  const totals = {
    itemsCents: cents(total?.subTotal, "total.subTotal", true),
    deliveryFeeCents: cents(total?.deliveryFee, "total.deliveryFee"),
    additionalFeesCents: cents(total?.additionalFees, "total.additionalFees"),
    benefitsCents: cents(total?.benefits, "total.benefits"),
    benefitsSponsoredByMarketplaceCents: sponsoredByMarketplace(record.benefits),
    orderCents: cents(total?.orderAmount, "total.orderAmount", true),
  };

  // O pedido nunca é recusado por divergência: entra com aviso para o lojista conferir.
  const warnings: string[] = [];
  if (scheduled && !optionalString(schedule?.deliveryDateTimeStart)) {
    warnings.push("Pedido agendado sem horário de entrega informado pelo iFood.");
  }
  for (const item of items) {
    if (!item.externalCode) warnings.push(`"${item.name}" está sem código PDV no iFood; vincule ao produto do cardápio.`);
  }
  const itemsSum = items.reduce((sum, item) => sum + item.totalPriceCents, 0);
  if (itemsSum !== totals.itemsCents) {
    warnings.push(`Soma dos itens (${itemsSum}) difere do subtotal informado pelo iFood (${totals.itemsCents}).`);
  }
  const expected = totals.itemsCents + totals.deliveryFeeCents + totals.additionalFeesCents - totals.benefitsCents;
  if (expected !== totals.orderCents) {
    warnings.push(`Total do pedido (${totals.orderCents}) não fecha com itens + taxas − descontos (${expected}).`);
  }
  if (totals.benefitsSponsoredByMarketplaceCents > totals.benefitsCents) {
    warnings.push(`Patrocínio do iFood nos descontos (${totals.benefitsSponsoredByMarketplaceCents}) maior que o total de descontos (${totals.benefitsCents}).`);
  }
  const paidSum = payments.reduce((sum, payment) => sum + payment.amountCents, 0);
  if (payments.length > 0 && paidSum !== totals.orderCents) {
    warnings.push(`Pagamentos (${paidSum}) não batem com o total do pedido (${totals.orderCents}).`);
  }
  const pendingCents = paymentsRecord?.pending === undefined
    ? payments.filter((payment) => !payment.prepaid).reduce((sum, payment) => sum + payment.amountCents, 0)
    : cents(paymentsRecord.pending, "payments.pending");

  return {
    channel: "ifood",
    externalId: requiredString(record.id, "id"),
    displayId: optionalString(record.displayId) ?? requiredString(record.id, "id").slice(0, 8),
    merchantExternalId: optionalString(merchant?.id) ?? "",
    // O detalhe do pedido não traz status confiável: quem manda no status são os eventos.
    status: "placed",
    fulfillment,
    courier: fulfillment === "delivery" ? mapCourier(optionalString(delivery?.deliveredBy)) : "unknown",
    scheduledFor: scheduled ? optionalString(schedule?.deliveryDateTimeStart) : null,
    scheduledUntil: scheduled ? optionalString(schedule?.deliveryDateTimeEnd) : null,
    preparationStartAt: optionalString(record.preparationStartDateTime),
    pickupCode: optionalString(delivery?.pickupCode),
    isTest: record.isTest === true,
    createdAt: requiredString(record.createdAt, "createdAt"),
    customer: {
      name: optionalString(customer?.name) ?? "Cliente iFood",
      phone: optionalString(phone?.number),
      phoneLocalizer: optionalString(phone?.localizer),
      document: optionalString(customer?.documentNumber),
    },
    address: fulfillment === "delivery" ? mapAddress(delivery?.deliveryAddress) : null,
    items,
    totals,
    payments,
    pendingCents,
    notes: optionalString(record.extraInfo),
    warnings,
  };
}
