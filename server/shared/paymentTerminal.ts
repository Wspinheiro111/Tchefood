// Contrato neutro de pagamento presencial (TEF/POS e Pix). A venda conhece o domínio comum;
// cada adquirente (Mercado Pago Point, Vero Cliente PDV, Cielo Smart, PagBank SmartPOS, Connect Stone, Pix Banrisul) fica atrás de um provider
// e declara explicitamente se opera por ordem remota (cloud -> terminal ou QR Code na tela) ou por SDK embarcado no próprio SmartPOS.

export const PAYMENT_TERMINAL_PROVIDERS = ["mercado_pago_point", "vero_cliente_pdv", "cielo_smart", "pagbank_smartpos", "stone_connect", "banrisul_pix"] as const;
export type PaymentTerminalProviderKey = (typeof PAYMENT_TERMINAL_PROVIDERS)[number];

// Nome da operadora para o lojista (telas, observação da venda, avisos).
export const PAYMENT_TERMINAL_LABELS: Readonly<Record<PaymentTerminalProviderKey, string>> = {
  mercado_pago_point: "Mercado Pago Point",
  vero_cliente_pdv: "Vero (Banrisul)",
  cielo_smart: "Cielo Smart",
  pagbank_smartpos: "PagBank SmartPOS",
  stone_connect: "Stone",
  banrisul_pix: "Pix Banrisul",
};

export const PAYMENT_TERMINAL_METHODS = ["credit", "debit", "pix"] as const;
export type PaymentTerminalMethod = (typeof PAYMENT_TERMINAL_METHODS)[number];
// Ordem remota cobra as mesmas formas do SDK embarcado; cada provider declara em supportedMethods as que o adquirente aceita.
export type RemotePaymentTerminalMethod = PaymentTerminalMethod;

// Forma de pagamento normalizada que o provider informa na consulta. Null = o adquirente não disse (ou disse algo que não reconhecemos).
export type PaymentTerminalPaymentMethodType = "credit_card" | "debit_card" | "pix";

export function expectedPaymentMethodType(method: PaymentTerminalMethod): PaymentTerminalPaymentMethodType {
  return method === "credit" ? "credit_card" : method === "debit" ? "debit_card" : "pix";
}

export type PaymentTerminalIntegrationMode = "remote_order" | "embedded_sdk";

export function getPaymentTerminalIntegrationMode(provider: PaymentTerminalProviderKey): PaymentTerminalIntegrationMode {
  return provider === "pagbank_smartpos" ? "embedded_sdk" : "remote_order";
}

export type PaymentTerminalOperatingMode = "pdv" | "standalone" | "unknown";

export type PaymentTerminalInfo = {
  provider: PaymentTerminalProviderKey;
  externalTerminalId: string;
  operatingMode: PaymentTerminalOperatingMode;
  externalStoreId: string | null;
  externalPosId: string | null;
};

// "approved" é o único estado que autoriza concluir a venda. Qualquer valor desconhecido ou
// inconsistente vira "manual_review"; nunca é tratado como aprovado.
export type PaymentTerminalTransactionStatus =
  | "pending"
  | "at_terminal"
  | "approved"
  | "rejected"
  | "cancelled"
  | "expired"
  | "refunded"
  | "manual_review";

export type PaymentTerminalChargeRequest = {
  externalTerminalId: string;
  amountCents: number;
  // Mesma chave => mesma cobrança lógica. Só o provider com createRetryPolicy "same_key" a repassa ao adquirente;
  // nos demais ela identifica a cobrança no registro durável do chamador, e o adquirente não a conhece.
  idempotencyKey: string;
  // Até 64 caracteres: letras, números, hífen e sublinhado.
  externalReference: string;
  description?: string;
  // Cartão nos providers de maquininha; "pix" no provider de Pix (QR Code na tela) e nos que o declaram em supportedMethods.
  // Um provider que recebe uma forma que não opera recusa com invalid_request, nunca troca por outra.
  method?: RemotePaymentTerminalMethod;
  installments?: number;
  installmentsCost?: "seller" | "buyer";
};

export type PaymentTerminalChargeResult = {
  provider: PaymentTerminalProviderKey;
  externalOrderId: string;
  // Identificador do pagamento processado no adquirente (Payments API); null enquanto não existir.
  externalPaymentId: string | null;
  // Identificador da transação dentro da ordem (ex.: PAY...), distinto do pagamento.
  externalTransactionId: string | null;
  externalReference: string | null;
  externalTerminalId: string | null;
  status: PaymentTerminalTransactionStatus;
  rawStatus: string | null;
  rawStatusDetail: string | null;
  amountCents: number;
  paidAmountCents: number | null;
  paymentMethodId: string | null;
  paymentMethodType: PaymentTerminalPaymentMethodType | null;
  installments: number | null;
  // Dados do comprovante para a NFC-e integrada (tBand, cAut, NSU, credenciadora). Só os providers que
  // os recebem do adquirente preenchem; ausentes = não informados.
  cardBrand?: string | null;
  maskedPan?: string | null;
  authorizationCode?: string | null;
  nsu?: string | null;
  acquirerCnpj?: string | null;
  // Crédito parcelado informado pelo adquirente: "seller" (loja paga os juros) ou "buyer" (cliente paga). Ausente = não informado.
  installmentsCost?: "seller" | "buyer" | null;
  merchantReceipt?: string | null;
  customerReceipt?: string | null;
  // Pix: conteúdo do QR Code (Pix Copia e Cola) enquanto a cobrança aceita pagamento, e quando ela deixa de aceitar.
  qrPayload?: string | null;
  expiresAt?: number | null;
};

export type PaymentTerminalCancelResult = {
  // "cancellation_pending": o terminal já recebeu a ordem; o cancelamento só vale após a confirmação do provider.
  outcome: "cancelled" | "cancellation_pending";
  charge: PaymentTerminalChargeResult | null;
};

export type PaymentTerminalErrorCode =
  | "unauthorized"
  | "terminal_busy"
  | "idempotency_conflict"
  | "invalid_request"
  | "not_found"
  | "not_cancellable"
  | "timeout"
  | "unavailable"
  | "malformed_response";

export class PaymentTerminalProviderError extends Error {
  readonly code: PaymentTerminalErrorCode;
  readonly httpStatus: number | null;
  // true quando a chamada pode ter chegado ao provider (timeout/queda após enviar): o chamador nunca assume
  // falha definitiva e reconsulta. Repetir a operação, sempre com a MESMA chave de idempotência, só vale onde o
  // adquirente deduplica; na criação da cobrança isso é o createRetryPolicy do provider. Com "never", uma criação
  // desconhecida vai para reconciliação/revisão manual e nunca dispara outro createCharge.
  readonly outcomeUnknown: boolean;
  // Quem respondeu, para a mensagem ao operador nomear o adquirente certo. Ausente nos providers antigos (Mercado Pago).
  readonly provider: PaymentTerminalProviderKey | null;
  // Motivo curto e sem dados sensíveis para diagnóstico (ex.: "tls_rede", "invalid_scope"). Nunca vai para o cliente final sem filtro.
  readonly detail: string | null;

  constructor(code: PaymentTerminalErrorCode, options: { httpStatus?: number | null; outcomeUnknown?: boolean; provider?: PaymentTerminalProviderKey; detail?: string | null } = {}) {
    super(`payment_terminal_${code}`);
    this.name = "PaymentTerminalProviderError";
    this.code = code;
    this.httpStatus = options.httpStatus ?? null;
    this.outcomeUnknown = options.outcomeUnknown ?? false;
    this.provider = options.provider ?? null;
    this.detail = options.detail ?? null;
  }
}

// Depois de uma criação com resultado desconhecido, o chamador pode repetir createCharge com a mesma chave?
// "same_key": o adquirente deduplica pela chave, que o provider repassa; a repetição usa a mesma chave E o mesmo
// pedido (chave igual com pedido diferente é recusada pelo adquirente). "never": o adquirente não tem chave de
// idempotência e cada chamada cria outra cobrança.
export type PaymentTerminalCreateRetryPolicy = "same_key" | "never";

// Como a consulta prova que um pagamento aprovado é desta cobrança:
// "reference_and_terminal": o adquirente devolve a nossa referência e a maquininha que cobrou, e as duas são conferidas;
// "order_id": a consulta não ecoa referência nem maquininha, mas o identificador da ordem é emitido pelo adquirente para esta
// criação e a cobrança nasce presa àquela maquininha (Vero: token da maquininha em "group"). Aí basta a ordem conferir.
export type PaymentTerminalApprovalIdentity = "reference_and_terminal" | "order_id";

// Provider controlado pelo backend: cria uma ordem no adquirente e a envia para um terminal remoto.
// Mantido compatível com o contrato original do Mercado Pago; o modo pode ser consultado por
// getPaymentTerminalIntegrationMode(provider.key).
export interface PaymentTerminalProvider {
  readonly key: PaymentTerminalProviderKey;
  readonly createRetryPolicy: PaymentTerminalCreateRetryPolicy;
  readonly approvalIdentity: PaymentTerminalApprovalIdentity;
  // Formas que este adquirente cobra por ordem remota. A cobrança de outra forma nem começa.
  readonly supportedMethods: readonly PaymentTerminalMethod[];
  listTerminals(): Promise<PaymentTerminalInfo[]>;
  createCharge(request: PaymentTerminalChargeRequest): Promise<PaymentTerminalChargeResult>;
  getCharge(externalOrderId: string): Promise<PaymentTerminalChargeResult>;
  cancelCharge(externalOrderId: string, options: { idempotencyKey: string }): Promise<PaymentTerminalCancelResult>;
  // Opcional: encerra no adquirente a ordem já paga e conferida. Só o Connect Stone precisa (pedido pago aberto ocupa a
  // fila da maquininha); deve poder ser repetido sem efeito no pagamento.
  closeApprovedOrder?(externalOrderId: string): Promise<void>;
  // Opcional, para quem não deduplica a criação (createRetryPolicy "never"): procura a ordem de uma criação com resultado
  // desconhecido pela referência enviada. null = não achou AGORA (não prova que não existe).
  // Erro (inclusive mais de uma ordem com a mesma referência) também não prova nada: quem chama trata como "não achou".
  // `createdAt` (ISO 8601) é a hora em que a cobrança foi gravada: quem procura por janela de datas (Mercado Pago Point)
  // precisa dela e recusa (invalid_request) sem ela; quem não precisa ignora.
  findChargeByReference?(externalReference: string, options?: { createdAt?: string }): Promise<PaymentTerminalChargeResult | null>;
}

export type EmbeddedTerminalPaymentStatus = "approved" | "rejected" | "cancelled" | "failed" | "manual_review";

export type EmbeddedTerminalPaymentExpectation = {
  requestId: string;
  amountCents: number;
  method: PaymentTerminalMethod;
  installments: number;
};

export type EmbeddedTerminalPaymentReport = EmbeddedTerminalPaymentExpectation & {
  status: EmbeddedTerminalPaymentStatus;
  providerReference: string | null;
  failureCode?: string | null;
};

export type EmbeddedTerminalPaymentValidation = {
  provider: PaymentTerminalProviderKey;
  integrationMode: "embedded_sdk";
  requestId: string;
  status: "approved" | "rejected" | "cancelled" | "manual_review";
  providerReference: string | null;
  failureCode: string | null;
};

// Provider executado no próprio SmartPOS. Ele NÃO implementa createCharge/getCharge porque o backend
// não consegue comandar o SDK local. O adapter recebe o resultado do SDK e valida contra a expectativa
// calculada pelo servidor antes de permitir qualquer efeito de venda.
export interface EmbeddedPaymentTerminalProvider {
  readonly key: PaymentTerminalProviderKey;
  readonly integrationMode: "embedded_sdk";
  validateReport(
    expected: EmbeddedTerminalPaymentExpectation,
    report: EmbeddedTerminalPaymentReport,
  ): EmbeddedTerminalPaymentValidation;
}

const EXTERNAL_REFERENCE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidExternalReference(value: string) {
  return EXTERNAL_REFERENCE_PATTERN.test(value);
}

export function centsToDecimalString(cents: number) {
  if (!Number.isSafeInteger(cents) || cents <= 0) throw new Error("payment_terminal_invalid_amount");
  const whole = Math.floor(cents / 100);
  const fraction = String(cents % 100).padStart(2, "0");
  return `${whole}.${fraction}`;
}

// Converte "24.50" / "24" para centavos. Qualquer outro formato (vírgula, notação científica,
// mais de 2 casas, sinal) é recusado em vez de arredondado.
export function decimalStringToCents(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const fraction = (match[2] ?? "").padEnd(2, "0");
  return Number(match[1]) * 100 + Number(fraction);
}

type NormalizedStatus = { status: PaymentTerminalTransactionStatus };

// Mapeia o par status/status_detail do Mercado Pago Point (ordem e transação) para o estado interno.
// A transação (pagamento) manda; o status da ordem só vale quando não há transação.
export function normalizePaymentTerminalStatus(
  provider: PaymentTerminalProviderKey,
  rawStatus: string | null | undefined,
  rawStatusDetail: string | null | undefined,
  // De onde veio o par: "transaction" (pagamento) exige "accredited"; "order" também aceita "processed".
  source: "order" | "transaction",
): NormalizedStatus {
  if (provider !== "mercado_pago_point") return { status: "manual_review" };
  const status = (rawStatus ?? "").toLowerCase();
  const detail = (rawStatusDetail ?? "").toLowerCase();
  // Estados definitivos (aprovação, recusa, cancelamento, expiração, estorno) só são aceitos para pares
  // status/detail documentados pelo Mercado Pago, por origem. Qualquer detail novo, ausente ou fora da
  // lista vai para revisão manual: nunca vira um estado forte só porque a string não está vazia.
  const allowed = (details: readonly string[], value: PaymentTerminalTransactionStatus): NormalizedStatus => ({
    status: details.includes(detail) ? value : "manual_review",
  });
  const tx = source === "transaction";
  switch (status) {
    case "created":
      return { status: "pending" };
    case "at_terminal":
      return { status: "at_terminal" };
    case "processed":
      // Aprovação: só transação processed/accredited. Ordem processed/processed nunca aprova sozinha
      // (o provider ainda exige valor pago igual ao cobrado).
      return allowed(tx ? ["accredited"] : ["processed"], "approved");
    case "action_required":
      return { status: "manual_review" };
    case "failed":
      // "in_review" tem desfecho desconhecido e fica de fora da lista de recusa definitiva.
      return allowed(tx ? TRANSACTION_FAILED_DETAILS : ["failed"], "rejected");
    case "canceled":
      // Ordem cancelada é sempre canceled/canceled; os details por API/terminal existem só na transação.
      return allowed(tx ? ["canceled", "canceled_by_api", "canceled_on_terminal"] : ["canceled"], "cancelled");
    case "expired":
      return allowed(["expired"], "expired");
    case "refunded":
      return allowed(["refunded"], "refunded");
    default:
      return { status: "manual_review" };
  }
}

const TRANSACTION_FAILED_DETAILS = [
  "failed",
  "bad_filled_card_data",
  "high_risk",
  "rejected_by_issuer",
  "required_call_for_authorize",
  "max_attempts_exceeded",
  "card_disabled",
  "insufficient_amount",
  "amount_limit_exceeded",
  "processing_error",
  "invalid_installments",
] as const;
