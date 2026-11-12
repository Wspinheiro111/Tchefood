import {
  PaymentTerminalProviderError,
  centsToDecimalString,
  decimalStringToCents,
  isValidExternalReference,
  normalizePaymentTerminalStatus,
  type PaymentTerminalCancelResult,
  type PaymentTerminalChargeRequest,
  type PaymentTerminalChargeResult,
  type PaymentTerminalInfo,
  type PaymentTerminalOperatingMode,
  type PaymentTerminalPaymentMethodType,
  type PaymentTerminalProvider,
} from "../shared/paymentTerminal.ts";

const DEFAULT_BASE_URL = "https://api.mercadopago.com";
const DEFAULT_TIMEOUT_MS = 15_000;
const TERMINALS_PAGE_SIZE = 50;
const MAX_TERMINAL_PAGES = 20;

export type MercadoPagoPointProviderOptions = {
  accessToken: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function mapOperatingMode(value: unknown): PaymentTerminalOperatingMode {
  const mode = typeof value === "string" ? value.toUpperCase() : "";
  if (mode === "PDV") return "pdv";
  if (mode === "STANDALONE") return "standalone";
  return "unknown";
}

// Só os tipos que esta integração cobra; qualquer outro valor fica sem tipo e a aprovação não confere.
// Pix: a cobrança "qr" da Point aceita QR de Pix e de saldo Mercado Pago. A documentação da Point não mostra como o pagamento
// QR volta; vale o par da API de pagamentos do Mercado Pago (tipo bank_transfer, id pix). Saldo em conta (account_money) não é
// Pix para a NFC-e: fica sem tipo e vai para conferência.
function mapPaymentMethodType(type: unknown, id: unknown): PaymentTerminalPaymentMethodType | null {
  if (type === "credit_card" || type === "debit_card") return type;
  if (type === "bank_transfer" && id === "pix") return "pix";
  return null;
}

function malformed(httpStatus: number | null = null): PaymentTerminalProviderError {
  return new PaymentTerminalProviderError("malformed_response", { httpStatus });
}

export class MercadoPagoPointProvider implements PaymentTerminalProvider {
  readonly key = "mercado_pago_point" as const;
  // A Orders API deduplica pelo X-Idempotency-Key, que leva a idempotencyKey da cobrança: a mesma chave com o
  // mesmo corpo devolve a ordem original sem criar outra. Por isso uma criação com outcomeUnknown (queda, timeout,
  // 408/425/429/5xx) pode ser repetida com segurança, desde que com a MESMA chave e o MESMO pedido (terminal, valor,
  // referência, método e parcelas); chave igual com corpo diferente volta 409 idempotency_key_already_used.
  readonly createRetryPolicy = "same_key" as const;
  readonly approvalIdentity = "reference_and_terminal" as const;
  // Pix vai como ordem "qr" (a maquininha mostra o QR Code).
  readonly supportedMethods = ["credit", "debit", "pix"] as const;
  private readonly accessToken: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MercadoPagoPointProviderOptions) {
    if (!options.accessToken) throw new Error("mercado_pago_point_access_token_required");
    this.accessToken = options.accessToken;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async listTerminals(): Promise<PaymentTerminalInfo[]> {
    const result: PaymentTerminalInfo[] = [];
    let offset = 0;
    for (let page = 0; page < MAX_TERMINAL_PAGES; page += 1) {
      const { body } = await this.request("GET", `/terminals/v1/list?limit=${TERMINALS_PAGE_SIZE}&offset=${offset}`, { mutating: false });
      const terminals = asObject(asObject(body)?.data)?.terminals;
      const total = asObject(asObject(body)?.paging)?.total;
      // Sem total numérico a lista não pode ser provada completa: falha em vez de devolver parcial.
      if (!Array.isArray(terminals) || typeof total !== "number" || !Number.isInteger(total) || total < 0) throw malformed();
      for (const raw of terminals) {
        const item = asObject(raw);
        const id = asString(item?.id);
        if (!item || !id) throw malformed();
        result.push({
          provider: this.key,
          externalTerminalId: id,
          operatingMode: mapOperatingMode(item.operating_mode),
          externalStoreId: asString(item.store_id),
          externalPosId: item.pos_id == null ? null : String(item.pos_id),
        });
      }
      offset += terminals.length;
      if (offset >= total) return result;
      // Página vazia com itens ainda faltando: resposta inconsistente.
      if (terminals.length === 0) throw malformed();
    }
    // Mais páginas que o limite de segurança: melhor falhar do que devolver lista truncada.
    throw malformed();
  }

  async createCharge(request: PaymentTerminalChargeRequest): Promise<PaymentTerminalChargeResult> {
    if (!request.externalTerminalId) throw new PaymentTerminalProviderError("invalid_request");
    if (!request.idempotencyKey) throw new PaymentTerminalProviderError("invalid_request");
    if (!isValidExternalReference(request.externalReference)) throw new PaymentTerminalProviderError("invalid_request");
    if (request.method !== undefined && request.method !== "credit" && request.method !== "debit" && request.method !== "pix") throw new PaymentTerminalProviderError("invalid_request");
    let amount: string;
    try {
      amount = centsToDecimalString(request.amountCents);
    } catch {
      throw new PaymentTerminalProviderError("invalid_request");
    }

    // A maquininha Point só cobra cartão aqui: Pix chegando em runtime não vira débito.
    if (request.method !== undefined && !this.supportedMethods.includes(request.method)) throw new PaymentTerminalProviderError("invalid_request");
    const installments = request.installments ?? 1;
    if (!Number.isInteger(installments) || installments < 1) throw new PaymentTerminalProviderError("invalid_request");
    if (installments > 1 && (request.method !== "credit" || !request.installmentsCost)) {
      // O Mercado Pago recusa parcelado sem o responsável pelo custo (missing_installments_cost).
      throw new PaymentTerminalProviderError("invalid_request");
    }

    const paymentMethod: JsonObject = {};
    if (request.method === "pix" && installments > 1) throw new PaymentTerminalProviderError("invalid_request");
    if (request.method) paymentMethod.default_type = request.method === "credit" ? "credit_card" : request.method === "debit" ? "debit_card" : "qr";
    // Crédito sempre com o número de parcelas explícito: sem ele o terminal pode oferecer parcelas ao cliente.
    // Custo de parcelamento só existe com mais de uma parcela (o Mercado Pago recusa custo em parcela única).
    if (request.method === "credit") {
      paymentMethod.default_installments = installments;
      if (installments > 1) paymentMethod.installments_cost = request.installmentsCost;
    }

    const payload: JsonObject = {
      type: "point",
      external_reference: request.externalReference,
      transactions: { payments: [{ amount }] },
      config: {
        point: { terminal_id: request.externalTerminalId, print_on_terminal: "no_ticket" },
        ...(Object.keys(paymentMethod).length > 0 ? { payment_method: paymentMethod } : {}),
      },
      ...(request.description ? { description: request.description.slice(0, 150) } : {}),
    };

    const { body } = await this.request("POST", "/v1/orders", {
      mutating: true,
      idempotencyKey: request.idempotencyKey,
      payload,
    });
    return this.parseMutatingOrder(body);
  }

  async getCharge(externalOrderId: string): Promise<PaymentTerminalChargeResult> {
    const { body } = await this.request("GET", `/v1/orders/${encodeURIComponent(externalOrderId)}`, { mutating: false });
    return this.parseOrder(body);
  }

  async cancelCharge(externalOrderId: string, options: { idempotencyKey: string }): Promise<PaymentTerminalCancelResult> {
    if (!options.idempotencyKey) throw new PaymentTerminalProviderError("invalid_request");
    const { status, body } = await this.request("POST", `/v1/orders/${encodeURIComponent(externalOrderId)}/cancel`, {
      mutating: true,
      idempotencyKey: options.idempotencyKey,
      headers: { "x-allow-cancelable-status": "at_terminal" },
    });
    // 202: o pedido de cancelamento foi aceito, mas só vale depois da confirmação do provider. O corpo
    // documentado é parcial (sem valores), então não é interpretado: o chamador reconsulta com getCharge.
    if (status === 202) return { outcome: "cancellation_pending", charge: null };
    const charge = asObject(body) && asString(asObject(body)?.id) ? this.parseMutatingOrder(body) : null;
    return { outcome: charge?.status === "cancelled" ? "cancelled" : "cancellation_pending", charge };
  }

  // Resposta 2xx de escrita ilegível: a ação pode ter sido aplicada, então o resultado é desconhecido.
  private parseMutatingOrder(body: unknown): PaymentTerminalChargeResult {
    try {
      return this.parseOrder(body);
    } catch (error) {
      if (error instanceof PaymentTerminalProviderError && error.code === "malformed_response") {
        throw new PaymentTerminalProviderError("malformed_response", { httpStatus: error.httpStatus, outcomeUnknown: true });
      }
      throw error;
    }
  }

  private parseOrder(body: unknown): PaymentTerminalChargeResult {
    const order = asObject(body);
    const orderId = asString(order?.id);
    if (!order || !orderId) throw malformed();

    const payments = asObject(order.transactions)?.payments;
    const payment = Array.isArray(payments) ? asObject(payments[0]) : null;
    if (Array.isArray(payments) && payments.length > 1) throw malformed();

    // A transação (pagamento) manda quando existe; sem ela vale o status da ordem.
    // O par status/detail nunca é misturado entre transação e ordem: com transação, só vale o par dela.
    const rawStatus = payment ? asString(payment.status) : asString(order.status);
    const rawStatusDetail = payment ? asString(payment.status_detail) : asString(order.status_detail);
    let status = normalizePaymentTerminalStatus(this.key, rawStatus, rawStatusDetail, payment ? "transaction" : "order").status;

    const amountCents = decimalStringToCents(payment?.amount ?? order.total_amount);
    if (amountCents === null) throw malformed();
    const paidAmountCents = payment?.paid_amount == null ? null : decimalStringToCents(payment.paid_amount);
    if (payment?.paid_amount != null && paidAmountCents === null) throw malformed();
    // Aprovado sem valor pago confirmado nunca vale. Valor pago diferente segue como aprovado: a conferência do serviço trata (PAID_AMOUNT_MISMATCH).
    if (status === "approved" && paidAmountCents === null) status = "manual_review";

    const method = asObject(payment?.payment_method);
    const rawInstallments = method?.installments;
    const parsedInstallments = typeof rawInstallments === "string" && /^\d{1,3}$/.test(rawInstallments) ? Number(rawInstallments) : rawInstallments;
    const installments = typeof parsedInstallments === "number" && Number.isInteger(parsedInstallments) && parsedInstallments >= 1 ? parsedInstallments : null;

    return {
      provider: this.key,
      externalOrderId: orderId,
      // reference_id é o ID do pagamento processado; o id da transação (PAY...) vai em campo separado.
      externalPaymentId: payment?.reference_id == null ? null : String(payment.reference_id),
      externalTransactionId: asString(payment?.id),
      externalReference: asString(order.external_reference),
      externalTerminalId: asString(asObject(asObject(order.config)?.point)?.terminal_id),
      status,
      rawStatus,
      rawStatusDetail,
      amountCents,
      paidAmountCents,
      paymentMethodId: asString(method?.id),
      paymentMethodType: mapPaymentMethodType(method?.type, method?.id),
      installments,
    };
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    options: { mutating: boolean; idempotencyKey?: string; payload?: JsonObject; headers?: Record<string, string> },
  ): Promise<{ status: number; body: unknown }> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.accessToken}`,
      Accept: "application/json",
      ...options.headers,
    };
    if (options.payload) headers["Content-Type"] = "application/json";
    if (options.idempotencyKey) headers["X-Idempotency-Key"] = options.idempotencyKey;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    let text: string;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: options.payload ? JSON.stringify(options.payload) : undefined,
        signal: controller.signal,
      });
      // O timeout continua valendo enquanto o corpo é lido; corpo travado ou conexão derrubada
      // depois dos headers em escrita também deixa o resultado desconhecido.
      text = await response.text();
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      throw new PaymentTerminalProviderError(aborted ? "timeout" : "unavailable", { outcomeUnknown: options.mutating });
    } finally {
      clearTimeout(timer);
    }

    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }

    if (response.status >= 200 && response.status < 300) return { status: response.status, body };

    const httpStatus = response.status;
    const errors = asObject(body)?.errors;
    const errorCode = Array.isArray(errors) ? asString(asObject(errors[0])?.code) : null;
    // Terminal de outra conta ou desatualizado: o token é válido, o problema é a atribuição do terminal.
    if (httpStatus === 403 && errorCode === "forbidden_checking_terminal_owner") throw new PaymentTerminalProviderError("not_found", { httpStatus });
    if (httpStatus === 401 || httpStatus === 403) throw new PaymentTerminalProviderError("unauthorized", { httpStatus });
    if (httpStatus === 404) throw new PaymentTerminalProviderError("not_found", { httpStatus });
    if (httpStatus === 409) {
      const code = errorCode;
      if (code === "idempotency_key_already_used") throw new PaymentTerminalProviderError("idempotency_conflict", { httpStatus });
      if (code === "already_queued_order_for_terminal" || code === "already_queued_order_on_terminal") throw new PaymentTerminalProviderError("terminal_busy", { httpStatus });
      if (code === "cannot_cancel_order" || code === "order_already_canceled") throw new PaymentTerminalProviderError("not_cancellable", { httpStatus });
      throw new PaymentTerminalProviderError("invalid_request", { httpStatus });
    }
    if (httpStatus === 400 || httpStatus === 422) throw new PaymentTerminalProviderError("invalid_request", { httpStatus });
    // 408, 425 e 429 são timeout ou recusa temporária no caminho, sem prova de que o Mercado Pago não processou:
    // em escrita o resultado fica desconhecido; em leitura nada foi alterado.
    if (httpStatus === 408) throw new PaymentTerminalProviderError("timeout", { httpStatus, outcomeUnknown: options.mutating });
    if (httpStatus === 425 || httpStatus === 429) {
      throw new PaymentTerminalProviderError("unavailable", { httpStatus, outcomeUnknown: options.mutating });
    }
    throw new PaymentTerminalProviderError("unavailable", { httpStatus, outcomeUnknown: options.mutating && httpStatus >= 500 });
  }
}
