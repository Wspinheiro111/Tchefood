import {
  PaymentTerminalProviderError,
  isValidExternalReference,
  type PaymentTerminalCancelResult,
  type PaymentTerminalChargeRequest,
  type PaymentTerminalChargeResult,
  type PaymentTerminalInfo,
  type PaymentTerminalPaymentMethodType,
  type PaymentTerminalProvider,
  type PaymentTerminalTransactionStatus,
} from "../shared/paymentTerminal";

// Connect Stone 2.0 (docs/integracoes/stone): o servidor cria um pedido na API v5 do Pagar.me dirigido ao número
// de série da maquininha ("pedido direto") e o App de Pagamento da Stone abre a cobrança sozinho. Cada pagamento
// feito na maquininha vira uma charge dentro do pedido. Não há sandbox de ponta a ponta: pedido criado em sandbox
// não chega à maquininha, então tudo o que depende do terminal só se prova em produção com valor simbólico.

const DEFAULT_BASE_URL = "https://api.pagar.me";
const DEFAULT_TIMEOUT_MS = 15_000;
// CNPJ da credenciadora Stone Instituição de Pagamento S.A., usado no grupo de pagamento da NFC-e.
export const STONE_ACQUIRER_CNPJ = "16501555000157";

// sk_ (produção) ou sk_test_ (sandbox do Pagar.me): a chave é da Account (loja), nunca do parceiro.
const SECRET_KEY_PATTERN = /^sk_(?:test_)?[A-Za-z0-9]{8,128}$/;
const SERVICE_REFERER_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
// Número de série da maquininha como impresso na etiqueta (ex.: "6N021234", "a98765-4321").
const SERIAL_PATTERN = /^[A-Za-z0-9-]{4,40}$/;
const ORDER_ID_PATTERN = /^or_[A-Za-z0-9]{8,40}$/;
const CHARGE_ID_PATTERN = /^ch_[A-Za-z0-9]{8,40}$/;
// O "code" do pedido no Pagar.me aceita até 52 caracteres; a referência da venda vai nele.
const MAX_ORDER_CODE = 52;
const MAX_INSTALLMENTS = 18;
// Cartões tentados num mesmo pedido que ainda se avaliam sozinhos; acima disso, conferência humana.
const MAX_CHARGES = 5;
const MAX_DISPLAY_NAME = 30;
const MAX_PRINT_HEIGHT = 1_500;
const MAX_PRINT_WIDTH = 388;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type StoneConnectProviderOptions = {
  // Secret Key da Account Pagar.me da loja (Basic Auth: chave como usuário, senha vazia).
  secretKey: string;
  // Identificador do parceiro recebido no Partner Hub; sem ele a Stone pode recusar ou desviar a chamada.
  serviceRefererName: string;
  // Nome exibido no pedido/cliente do Pagar.me; o campo customer.name é obrigatório.
  customerName?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export type StoneConnectPrintRequest = {
  externalOrderId: string;
  type: "NFE" | "CUPOM" | "RECEIPT";
  // Imagem PNG ou JPEG em base64, já na largura da bobina.
  imageBase64: string;
  widthPx: number;
  heightPx: number;
};

export type StoneConnectWebhookHint = {
  eventId: string;
  type: string;
  externalOrderId: string;
  chargeId: string | null;
  // "code" do pedido citado no aviso: a referência da venda, que acha a cobrança cuja criação ficou incerta.
  externalReference: string | null;
};

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asCents(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

type ErrorOptions = { httpStatus?: number | null; outcomeUnknown?: boolean };

// Todo erro sai marcado como da Stone, para a mensagem ao operador nomear o adquirente certo.
function stoneError(code: ConstructorParameters<typeof PaymentTerminalProviderError>[0], options: ErrorOptions = {}) {
  return new PaymentTerminalProviderError(code, { ...options, provider: "stone_connect" });
}

function malformed(outcomeUnknown = false, httpStatus: number | null = null): PaymentTerminalProviderError {
  return stoneError("malformed_response", { httpStatus, outcomeUnknown });
}

function invalid(): PaymentTerminalProviderError {
  return stoneError("invalid_request");
}

// O metadata da charge vem em snake_case no webhook e em camelCase na tabela da documentação: aceita os dois.
function metaString(meta: JsonObject | null, snake: string, camel: string): string | null {
  if (!meta) return null;
  return asString(meta[snake]) ?? asString(meta[camel]);
}

function isPrintableImageBase64(value: string): "png" | "jpeg" | null {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) return null;
  if (bytes.length >= PNG_SIGNATURE.length && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  return null;
}

// Estado de UMA charge do Pagar.me feita na maquininha. Charge só nasce quando o cartão passa no terminal,
// então "canceled" é estorno de um pagamento que existiu (cancelamento feito no App de Cancelamento ou no portal).
// "failed" (cartão negado) só vale como recusa olhando a charge sozinha: o pedido segue aberto e o cliente pode
// tentar outro cartão nele. Quem decide o estado do pedido é evaluateOrder, que olha todas as charges juntas.
const CHARGE_STATUS_MAP: Record<string, PaymentTerminalTransactionStatus> = {
  paid: "approved",
  pending: "at_terminal",
  processing: "at_terminal",
  failed: "rejected",
  canceled: "refunded",
};

export function isStoneConnectSecretKey(value: string) {
  return SECRET_KEY_PATTERN.test(value);
}

// Número de série como a Stone devolve no metadata da charge (maiúsculas), para a conferência da maquininha bater.
export function normalizeStoneConnectSerial(value: string): string | null {
  const serial = value.trim().toUpperCase();
  return SERIAL_PATTERN.test(serial) ? serial : null;
}

export function normalizeStoneConnectChargeStatus(rawStatus: string | null | undefined): PaymentTerminalTransactionStatus {
  return CHARGE_STATUS_MAP[(rawStatus ?? "").trim().toLowerCase()] ?? "manual_review";
}

// Forma de pagamento da charge no vocabulário que o checkout confere (o mesmo do Mercado Pago Point).
function paymentMethodType(fundingSource: string | null): PaymentTerminalPaymentMethodType | null {
  switch ((fundingSource ?? "").toLowerCase()) {
    case "credit":
      return "credit_card";
    case "debit":
      return "debit_card";
    // Cartão pré-pago só passa como débito: conta como débito na conferência (e no tPag da NFC-e).
    case "prepaid":
      return "debit_card";
    default:
      return null;
  }
}

// O webhook do Pagar.me não é assinado: serve só para saber QUAL pedido reconsultar. Nunca conclui venda pelo corpo
// recebido; quem decide é getCharge, que busca o pedido na API com a chave da loja.
export function parseStoneConnectWebhook(body: unknown): StoneConnectWebhookHint | null {
  const root = asObject(body);
  const data = asObject(root?.data);
  const eventId = asString(root?.id);
  const type = asString(root?.type);
  if (!root || !data || !eventId || !type) return null;
  const order = asObject(data.order);
  const orderId = asString(order?.id) ?? (type.startsWith("order.") ? asString(data.id) : null);
  if (!orderId || !ORDER_ID_PATTERN.test(orderId)) return null;
  const chargeId = type.startsWith("charge.") ? asString(data.id) : null;
  const code = asString(order?.code) ?? (type.startsWith("order.") ? asString(data.code) : null);
  return {
    eventId,
    type,
    externalOrderId: orderId,
    chargeId: chargeId && CHARGE_ID_PATTERN.test(chargeId) ? chargeId : null,
    externalReference: code && isValidExternalReference(code) && code.length <= MAX_ORDER_CODE ? code : null,
  };
}

export class StoneConnectProvider implements PaymentTerminalProvider {
  readonly key = "stone_connect" as const;
  // A documentação do Connect não garante chave de idempotência na criação do pedido: repetir o POST cria outro
  // pedido na maquininha. Criação com resultado desconhecido vai para reconciliação/revisão, nunca para nova tentativa.
  readonly createRetryPolicy = "never" as const;
  // A consulta devolve o code do pedido (a nossa referência) e o número de série da maquininha que cobrou.
  readonly approvalIdentity = "reference_and_terminal" as const;
  // Pix pelo Connect não está integrado: a ordem daqui só cobra cartão.
  readonly supportedMethods = ["credit", "debit"] as const;
  private readonly authorization: string;
  private readonly serviceRefererName: string;
  private readonly customerName: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: StoneConnectProviderOptions) {
    if (!SECRET_KEY_PATTERN.test(options.secretKey ?? "")) throw new Error("stone_connect_secret_key_invalid");
    if (!SERVICE_REFERER_PATTERN.test(options.serviceRefererName ?? "")) throw new Error("stone_connect_service_referer_required");
    const customerName = (options.customerName ?? "Consumidor").trim();
    if (!customerName || customerName.length > 64) throw new Error("stone_connect_customer_name_invalid");
    this.authorization = `Basic ${Buffer.from(`${options.secretKey}:`).toString("base64")}`;
    this.serviceRefererName = options.serviceRefererName;
    this.customerName = customerName;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  // O Connect não tem rota para listar maquininhas: o número de série é informado pela loja (etiqueta do terminal)
  // e só se comprova com o primeiro pedido chegando na tela "Aguardando Pagamentos".
  async listTerminals(): Promise<PaymentTerminalInfo[]> {
    return [];
  }

  async createCharge(request: PaymentTerminalChargeRequest): Promise<PaymentTerminalChargeResult> {
    if (!SERIAL_PATTERN.test(request.externalTerminalId ?? "")) throw invalid();
    if (!request.idempotencyKey) throw invalid();
    if (!isValidExternalReference(request.externalReference) || request.externalReference.length > MAX_ORDER_CODE) throw invalid();
    if (!Number.isSafeInteger(request.amountCents) || request.amountCents <= 0) throw invalid();
    const installments = request.installments ?? 1;
    if (!Number.isInteger(installments) || installments < 1 || installments > MAX_INSTALLMENTS) throw invalid();

    let paymentSetup: JsonObject | null;
    if (request.method === undefined) {
      // Sem forma definida: o operador escolhe na maquininha.
      if (installments > 1) throw invalid();
      paymentSetup = null;
    } else if (request.method === "debit") {
      if (installments > 1) throw invalid();
      paymentSetup = { type: "debit", installments: 1 };
    } else if (request.method !== "credit") {
      // Fora de crédito e débito (ex.: "pix" chegando em runtime) não vira crédito à vista.
      throw invalid();
    } else if (installments === 1) {
      paymentSetup = { type: "credit", installments: 1, installment_type: "merchant" };
    } else if (request.installmentsCost === "seller") {
      paymentSetup = { type: "credit", installments, installment_type: "merchant" };
    } else if (request.installmentsCost === "buyer") {
      paymentSetup = { type: "credit", installments, installment_type: "issuer" };
    } else {
      throw invalid();
    }

    const description = (request.description ?? "").trim() || "Venda";
    const payload: JsonObject = {
      // A referência da venda vai no code do pedido: é por ela que se reconcilia um pedido de criação incerta.
      code: request.externalReference,
      customer: { name: this.customerName },
      items: [{ amount: request.amountCents, description: description.slice(0, 256), quantity: 1, code: request.externalReference }],
      closed: false,
      poi_payment_settings: {
        visible: true,
        display_name: description.slice(0, MAX_DISPLAY_NAME),
        print_order_receipt: false,
        devices_serial_number: [request.externalTerminalId],
        ...(paymentSetup ? { payment_setup: paymentSetup } : {}),
      },
    };
    const body = asObject(await this.request("POST", "/core/v5/orders", payload, true));
    const orderId = asString(body?.id);
    // 2xx sem um pedido legível: ele pode ter sido criado e já estar na maquininha.
    if (!body || !orderId || !ORDER_ID_PATTERN.test(orderId)) throw malformed(true);
    if (asCents(body.amount) !== request.amountCents) throw malformed(true);
    const code = asString(body.code);
    if (code !== null && code !== request.externalReference) throw malformed(true);
    return {
      provider: this.key,
      externalOrderId: orderId,
      externalPaymentId: null,
      externalTransactionId: null,
      externalReference: request.externalReference,
      externalTerminalId: request.externalTerminalId,
      status: "pending",
      rawStatus: asString(body.status),
      rawStatusDetail: null,
      amountCents: request.amountCents,
      paidAmountCents: null,
      paymentMethodId: request.method ?? null,
      paymentMethodType: null,
      installments: request.method === "credit" ? installments : null,
      acquirerCnpj: STONE_ACQUIRER_CNPJ,
    };
  }

  // A fonte da verdade é o pedido no Pagar.me, não o webhook. Só um pedido com UMA charge paga (as demais negadas), no
  // valor do pedido, com NSU, autorização e número de série da maquininha conta como aprovado.
  async getCharge(externalOrderId: string): Promise<PaymentTerminalChargeResult> {
    if (!ORDER_ID_PATTERN.test(externalOrderId ?? "")) throw invalid();
    return (await this.evaluateOrder(await this.loadOrder(externalOrderId))).result;
  }

  // Pedido de criação incerta (queda ou timeout no POST), procurado pela referência da venda gravada no "code".
  // Só um pedido com exatamente esse code conta; nenhum devolve null (não prova que não existe: pode não ter
  // aparecido ainda na listagem); dois ou mais é resposta que não se resolve sozinha.
  async findChargeByReference(externalReference: string): Promise<PaymentTerminalChargeResult | null> {
    if (!isValidExternalReference(externalReference) || externalReference.length > MAX_ORDER_CODE) throw invalid();
    const body = asObject(await this.request("GET", `/core/v5/orders?code=${encodeURIComponent(externalReference)}&page=1&size=10`, null, false));
    const data = body?.data;
    if (!Array.isArray(data)) throw malformed();
    // Confere o code de cada item: se a API ignorar o filtro, pedidos de outras vendas não podem ser confundidos com este.
    const matches = data.map(asObject).filter((order): order is JsonObject => order !== null && asString(order.code) === externalReference);
    if (matches.length === 0) return null;
    if (matches.length > 1) throw malformed();
    const orderId = asString(matches[0].id);
    if (!orderId || !ORDER_ID_PATTERN.test(orderId)) throw malformed();
    return this.getCharge(orderId);
  }

  // Fecha como "canceled" um pedido sem pagamento feito nem em andamento (cartões negados não contam). A maquininha só
  // larga o pedido na próxima atualização (até ~1 minuto) ou quando o operador toca no X; até lá o cliente ainda pode
  // pagar. Por isso o resultado é "cancellation_pending" e o chamador reconsulta: uma charge que apareça depois vence.
  async cancelCharge(externalOrderId: string, options: { idempotencyKey: string }): Promise<PaymentTerminalCancelResult> {
    if (!ORDER_ID_PATTERN.test(externalOrderId ?? "") || !options.idempotencyKey) throw invalid();
    const { result, cancellable } = await this.evaluateOrder(await this.loadOrder(externalOrderId));
    if (result.status === "cancelled") return { outcome: "cancelled", charge: result };
    // Pagamento feito, estornado ou em andamento: fechar o pedido não devolve dinheiro. Estorno é na maquininha.
    if (!cancellable) throw stoneError("not_cancellable");
    const body = asObject(await this.request("PATCH", `/core/v5/orders/${externalOrderId}/closed`, { status: "canceled" }, true));
    if (!body || asString(body.id) !== externalOrderId) throw malformed(true);
    return { outcome: "cancellation_pending", charge: null };
  }

  // Obrigatório depois do pagamento confirmado: pedido pago que fica aberto ocupa a fila (limite de 30 abertos) e a
  // maquininha pode parar de receber pedidos novos. Fechar não muda o dinheiro, só tira o pedido do terminal.
  async closeApprovedOrder(externalOrderId: string): Promise<void> {
    if (!ORDER_ID_PATTERN.test(externalOrderId ?? "")) throw invalid();
    const body = asObject(await this.request("PATCH", `/core/v5/orders/${externalOrderId}/closed`, { status: "paid" }, true));
    if (!body || asString(body.id) !== externalOrderId || body.closed !== true) throw malformed(true);
  }

  // Imprime NF-e/cupom na maquininha que pagou o pedido. A imagem tem até 388 px de largura e 1.500 px de altura.
  async print(request: StoneConnectPrintRequest): Promise<void> {
    if (!ORDER_ID_PATTERN.test(request.externalOrderId ?? "")) throw invalid();
    if (!["NFE", "CUPOM", "RECEIPT"].includes(request.type)) throw invalid();
    if (!Number.isInteger(request.widthPx) || request.widthPx < 1 || request.widthPx > MAX_PRINT_WIDTH) throw invalid();
    if (!Number.isInteger(request.heightPx) || request.heightPx < 1 || request.heightPx > MAX_PRINT_HEIGHT) throw invalid();
    const format = isPrintableImageBase64(request.imageBase64 ?? "");
    if (!format) throw invalid();
    await this.request("POST", `/posconnect/v1/orders/${request.externalOrderId}/prints`, {
      type: request.type,
      size_v: request.heightPx,
      size_h: request.widthPx,
      format,
      content: request.imageBase64,
    }, true);
  }

  private async loadOrder(externalOrderId: string): Promise<JsonObject> {
    const order = asObject(await this.request("GET", `/core/v5/orders/${externalOrderId}`, null, false));
    if (!order || asString(order.id) !== externalOrderId) throw malformed();
    return order;
  }

  private async loadCharge(chargeId: string): Promise<JsonObject> {
    const charge = asObject(await this.request("GET", `/core/v5/charges/${chargeId}`, null, false));
    if (!charge || asString(charge.id) !== chargeId) throw malformed();
    return charge;
  }

  /**
   * Estado do pedido olhando todas as charges dele:
   * - nenhuma charge, ou só cartões negados: pedido aberto aguarda (o cliente pode tentar outro cartão), fechado como
   *   canceled está cancelado, qualquer outro fechamento não se sabe;
   * - uma charge em andamento (pending/processing): aguardando, e não dá para cancelar;
   * - uma charge paga ou estornada (com ou sem negadas antes): ela decide;
   * - duas ou mais que não sejam negadas (pagamento dividido, cobrança dupla) ou mais de MAX_CHARGES: conferência humana.
   * `cancellable` diz se fechar o pedido agora não apaga nenhum pagamento feito ou em andamento.
   */
  private async evaluateOrder(order: JsonObject): Promise<{ result: PaymentTerminalChargeResult; cancellable: boolean }> {
    const externalOrderId = asString(order.id) as string;
    const amountCents = asCents(order.amount);
    if (amountCents === null || amountCents <= 0) throw malformed();
    const orderStatus = (asString(order.status) ?? "").toLowerCase();
    const open = order.closed !== true;
    const serials = asObject(order.poi_payment_settings)?.devices_serial_number;
    const orderSerial = Array.isArray(serials) && serials.length === 1 ? asString(serials[0])?.toUpperCase() ?? null : null;
    const rawCharges = order.charges ?? [];
    if (!Array.isArray(rawCharges)) throw malformed();

    const base: PaymentTerminalChargeResult = {
      provider: this.key,
      externalOrderId,
      externalPaymentId: null,
      externalTransactionId: null,
      externalReference: asString(order.code),
      externalTerminalId: null,
      status: "manual_review",
      rawStatus: orderStatus || null,
      rawStatusDetail: open ? null : "closed",
      amountCents,
      paidAmountCents: null,
      paymentMethodId: null,
      paymentMethodType: null,
      installments: null,
      acquirerCnpj: STONE_ACQUIRER_CNPJ,
    };
    if (rawCharges.length > MAX_CHARGES) return { result: { ...base, rawStatusDetail: `charges:${rawCharges.length}` }, cancellable: false };

    const charges: Array<{ id: string; status: string; full: JsonObject | null }> = [];
    for (const raw of rawCharges) {
      const embedded = asObject(raw);
      const id = asString(embedded?.id);
      if (!id || !CHARGE_ID_PATTERN.test(id)) throw malformed();
      const status = (asString(embedded?.status) ?? "").toLowerCase();
      // Sem o estado embutido, a consulta da charge diz qual é: nunca se presume negada.
      const full = status ? null : await this.loadCharge(id);
      charges.push({ id, status: status || (asString(full?.status) ?? "").toLowerCase(), full });
    }
    const declined = charges.filter(charge => charge.status === "failed");
    const others = charges.filter(charge => charge.status !== "failed");

    if (others.length === 0) {
      // Aberto e sem pagamento: "pending", ou "failed" quando o Pagar.me marca o pedido pelo último cartão negado.
      if (open && (orderStatus === "pending" || (orderStatus === "failed" && declined.length > 0))) {
        // Cartão negado não encerra a cobrança: o pedido continua na maquininha para o cliente tentar outro cartão.
        const status: PaymentTerminalTransactionStatus = declined.length > 0 ? "at_terminal" : "pending";
        return {
          result: { ...base, status, rawStatus: declined.length > 0 ? "failed" : base.rawStatus, rawStatusDetail: declined.length > 0 ? `declined:${declined.length}` : null, externalTerminalId: orderSerial },
          cancellable: true,
        };
      }
      if (!open && orderStatus === "canceled") return { result: { ...base, status: "cancelled" }, cancellable: false };
      // Fechado como "paid" sem charge paga, "failed" ou qualquer outro valor: não sabemos o que houve.
      return { result: base, cancellable: false };
    }
    if (others.length > 1) return { result: { ...base, rawStatusDetail: `charges:${charges.length}` }, cancellable: false };

    const [only] = others;
    if (only.status === "pending" || only.status === "processing") {
      return { result: { ...base, status: "at_terminal", rawStatus: only.status, externalTerminalId: orderSerial }, cancellable: false };
    }
    // A charge embutida no pedido pode vir sem o metadata da maquininha; a consulta da charge traz tudo.
    return { result: this.parseCharge(base, only.full ?? await this.loadCharge(only.id)), cancellable: false };
  }

  private parseCharge(base: PaymentTerminalChargeResult, charge: JsonObject): PaymentTerminalChargeResult {
    const rawStatus = asString(charge.status);
    let status = normalizeStoneConnectChargeStatus(rawStatus);
    const meta = asObject(charge.metadata);
    const nsu = asString(charge.code);
    const authorizationCode = metaString(meta, "authorization_code", "authorizationCode");
    // Comparado em maiúsculas com o número de série gravado na configuração da loja.
    const serial = metaString(meta, "terminal_serial_number", "terminalSerialNumber")?.toUpperCase() ?? null;
    const fundingSource = metaString(meta, "account_funding_source", "accountFundingSource");
    const methodType = paymentMethodType(fundingSource);
    const paidAmount = asCents(charge.paid_amount);
    const installmentsRaw = metaString(meta, "installment_quantity", "installmentQuantity");
    // Tipo do parcelado: lojista financia (sem juros) ou emissor (juros na fatura do cliente).
    const installmentType = (metaString(meta, "installment_type", "installmentType") ?? "").toLowerCase();
    const installmentsCost = installmentType === "merchantfinanced" ? "seller" as const : installmentType === "issuerfinanced" ? "buyer" as const : null;
    // O campo de parcelas só vem no crédito parcelado: ausente no crédito é à vista.
    const installments = installmentsRaw && /^\d{1,2}$/.test(installmentsRaw)
      ? Number(installmentsRaw)
      : methodType === "credit_card" || methodType === "debit_card" ? 1 : null;
    if (status === "approved") {
      // "paid" sem NSU, autorização, maquininha ou com valor pago diferente do pedido não conclui a venda.
      // Pago a menos que o pedido (charge parcial) também não conclui: o pedido inteiro precisa estar pago.
      if (!nsu || !authorizationCode || !serial || paidAmount === null || paidAmount !== asCents(charge.amount) || paidAmount !== base.amountCents) status = "manual_review";
    }
    return {
      ...base,
      externalPaymentId: asString(charge.id),
      externalTransactionId: metaString(meta, "initiator_transaction_key", "initiatorTransactionKey"),
      externalTerminalId: serial,
      status,
      rawStatus,
      rawStatusDetail: fundingSource,
      paidAmountCents: status === "approved" ? paidAmount : null,
      paymentMethodId: asString(charge.payment_method),
      paymentMethodType: methodType,
      installments,
      installmentsCost,
      cardBrand: metaString(meta, "scheme_name", "schemeName"),
      authorizationCode,
      nsu,
    };
  }

  private async request(method: "GET" | "POST" | "PATCH", path: string, payload: JsonObject | null, mutating: boolean): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    let text: string;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: this.authorization,
          ServiceRefererName: this.serviceRefererName,
          Accept: "application/json",
          ...(payload ? { "Content-Type": "application/json" } : {}),
        },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
        signal: controller.signal,
      });
      text = await response.text();
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      throw stoneError(aborted ? "timeout" : "unavailable", { outcomeUnknown: mutating });
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

    const httpStatus = response.status;
    if (httpStatus >= 200 && httpStatus < 300) return body;
    if (httpStatus === 401 || httpStatus === 403) throw stoneError("unauthorized", { httpStatus });
    // O id vai na URL: na consulta, 404 é "não existe nesta conta". Em operação que muda algo, pode ser caminho/proxy.
    if (httpStatus === 404) {
      if (!mutating) throw stoneError("not_found", { httpStatus });
      throw stoneError("unavailable", { httpStatus, outcomeUnknown: true });
    }
    // 408, 425 e 429 são timeout ou recusa temporária no caminho, sem prova de que o Pagar.me não processou.
    if (httpStatus === 408) throw stoneError("timeout", { httpStatus, outcomeUnknown: mutating });
    if (httpStatus === 425 || httpStatus === 429) throw stoneError("unavailable", { httpStatus, outcomeUnknown: mutating });
    // 400/422: validação recusada antes de criar ou mudar algo.
    if (httpStatus >= 400 && httpStatus < 500) throw stoneError("invalid_request", { httpStatus });
    throw stoneError("unavailable", { httpStatus, outcomeUnknown: mutating });
  }
}
