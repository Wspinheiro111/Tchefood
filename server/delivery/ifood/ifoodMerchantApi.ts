import {
  DeliveryMarketplaceError,
  type DeliveryAddress,
  type DeliveryCancellationReason,
  type DeliveryCourier,
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
} from "../marketplace";

// iFood Merchant API (https://developer.ifood.com.br). Fluxo de pedidos:
//  1. Token OAuth2 (client_credentials) em /authentication/v1.0/oauth/token.
//  2. Polling de eventos a cada 30s em /order/v1.0/events:polling (o iFood considera a loja aberta enquanto
//     o polling estiver ativo). Evento sem ack volta no próximo polling.
//  3. Ack em /order/v1.0/events/acknowledgment — só DEPOIS de gravar o evento (senão o pedido some).
//  4. Detalhes em /order/v1.0/orders/{id} e ações confirm/startPreparation/readyToPickup/dispatch.
// Os caminhos e códigos seguem a versão 1.0 da API; conferir na homologação, antes da primeira loja real.

export const IFOOD_DEFAULT_BASE_URL = "https://merchant-api.ifood.com.br";
export const IFOOD_POLLING_INTERVAL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 15_000;
// Renova o token um pouco antes de vencer para não perder um ciclo de polling.
const TOKEN_EXPIRY_MARGIN_MS = 60_000;
// O iFood recebe no máximo esta quantidade de ids por chamada de ack.
const MAX_ACK_BATCH = 2_000;
// Ids do iFood são UUIDs; o merchantId também.
const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

// Código do evento -> sinal comum. Código ausente desta tabela (handshake, disputa, entrega etc.) vira
// "unknown": o evento é registrado e confirmado, mas não mexe no status do pedido.
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

export class IfoodMerchantApi implements DeliveryMarketplaceAdapter {
  readonly channel = "ifood" as const;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly merchantIds: readonly string[];
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

  async pollEvents(): Promise<DeliveryEvent[]> {
    const headers: Record<string, string> = {};
    if (this.merchantIds.length > 0) headers["x-polling-merchants"] = this.merchantIds.join(",");
    const body = await this.request("GET", "/order/v1.0/events:polling", { headers });
    // 204 = nenhum evento novo.
    if (body === null) return [];
    if (!Array.isArray(body)) throw this.invalid("Resposta do polling não é uma lista.");
    return body.map((raw) => parseIfoodEvent(raw));
  }

  async acknowledge(events: readonly DeliveryEvent[]): Promise<void> {
    const ids = [...new Set(events.map((event) => event.externalEventId))];
    for (let start = 0; start < ids.length; start += MAX_ACK_BATCH) {
      const batch = ids.slice(start, start + MAX_ACK_BATCH).map((id) => ({ id }));
      await this.request("POST", "/order/v1.0/events/acknowledgment", { json: batch });
    }
  }

  async getOrder(externalOrderId: string): Promise<DeliveryOrder> {
    const body = await this.request("GET", `/order/v1.0/orders/${this.orderId(externalOrderId)}`);
    if (body === null) throw new DeliveryMarketplaceError("ifood", "not_found", `Pedido ${externalOrderId} sem detalhes no iFood.`);
    return mapIfoodOrder(body);
  }

  async performAction(externalOrderId: string, action: DeliveryOrderAction): Promise<void> {
    await this.request("POST", `/order/v1.0/orders/${this.orderId(externalOrderId)}/${ACTION_PATHS[action]}`);
  }

  async listCancellationReasons(externalOrderId: string): Promise<DeliveryCancellationReason[]> {
    const body = await this.request("GET", `/order/v1.0/orders/${this.orderId(externalOrderId)}/cancellationReasons`);
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
    await this.request("POST", `/order/v1.0/orders/${this.orderId(externalOrderId)}/requestCancellation`, {
      json: { reason: (details?.trim() || reason.description).slice(0, 250), cancellationCode: reason.code },
    });
  }

  // -------------------------------------------------------------------------

  private orderId(externalOrderId: string): string {
    if (!ID_PATTERN.test(externalOrderId)) {
      throw new DeliveryMarketplaceError("ifood", "invalid_request", `Id de pedido iFood inválido: ${externalOrderId}`);
    }
    return encodeURIComponent(externalOrderId);
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
    const response = await this.send("/authentication/v1.0/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: form.toString(),
    });
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      throw new DeliveryMarketplaceError("ifood", "auth_failed", "O iFood recusou as credenciais do app.", response.status);
    }
    const body = await this.readBody(response);
    const record = asRecord(body);
    const value = optionalString(record?.accessToken);
    const expiresIn = typeof record?.expiresIn === "number" ? record.expiresIn : null;
    if (!value || expiresIn === null || expiresIn <= 0) throw this.invalid("Token do iFood sem accessToken/expiresIn.");
    this.token = { value, expiresAt: this.now() + expiresIn * 1000 };
    return value;
  }

  private async request(
    method: "GET" | "POST",
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

  private async send(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, signal: controller.signal });
    } catch (error) {
      const reason = error instanceof Error && error.name === "AbortError" ? "tempo esgotado" : "falha de rede";
      throw new DeliveryMarketplaceError("ifood", "unavailable", `iFood indisponível (${reason}).`);
    } finally {
      clearTimeout(timer);
    }
  }

  private async readBody(response: Response): Promise<unknown> {
    if (response.status === 204) return null;
    const text = await response.text();
    if (!response.ok) {
      throw new DeliveryMarketplaceError("ifood", errorCodeForStatus(response.status), describeIfoodError(response.status, text), response.status);
    }
    if (!text.trim()) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw this.invalid("O iFood respondeu algo que não é JSON.");
    }
  }
}

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

export function parseIfoodEvent(raw: unknown): DeliveryEvent {
  const record = asRecord(raw);
  if (!record) throw new DeliveryMarketplaceError("ifood", "invalid_response", "Evento do iFood inválido.");
  const rawCode = requiredString(record.code, "event.code");
  return {
    channel: "ifood",
    externalEventId: requiredString(record.id, "event.id"),
    externalOrderId: requiredString(record.orderId, "event.orderId"),
    merchantExternalId: optionalString(record.merchantId) ?? "",
    rawCode,
    signal: mapIfoodEventCode(rawCode),
    createdAt: optionalString(record.createdAt) ?? new Date(0).toISOString(),
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

  const items = Array.isArray(record.items) ? record.items.map(mapItem) : [];
  if (items.length === 0) throw new DeliveryMarketplaceError("ifood", "invalid_response", "Pedido do iFood sem itens.");
  const payments = Array.isArray(paymentsRecord?.methods) ? paymentsRecord.methods.map(mapPayment) : [];

  const totals = {
    itemsCents: cents(total?.subTotal, "total.subTotal", true),
    deliveryFeeCents: cents(total?.deliveryFee, "total.deliveryFee"),
    additionalFeesCents: cents(total?.additionalFees, "total.additionalFees"),
    benefitsCents: cents(total?.benefits, "total.benefits"),
    orderCents: cents(total?.orderAmount, "total.orderAmount", true),
  };

  // O pedido nunca é recusado por divergência: entra com aviso para o lojista conferir.
  const warnings: string[] = [];
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
    scheduledFor: optionalString(record.orderTiming) === "SCHEDULED" ? optionalString(schedule?.deliveryDateTimeStart) : null,
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
