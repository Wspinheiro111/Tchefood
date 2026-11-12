// supabase/functions/point-charge/charge.ts
//
// Cobrança na Point Smart (Mercado Pago) pela nuvem, sem Deno: a Edge Function (index.ts) só liga
// banco, token e HTTP. Tudo o que decide se uma cobrança está aprovada fica aqui e é testado.
//
// Regras:
//  - A cobrança nasce em terminal_charges ANTES de ir ao Mercado Pago, com a chave de idempotência do
//    pagamento. A ordem no Mercado Pago usa a mesma chave (X-Idempotency-Key) e a mesma referência,
//    então repetir a criação depois de queda ou timeout devolve a ordem original, nunca outra.
//  - Aprovado só quando a ordem E o pagamento do Mercado Pago confirmam tudo: referência, maquininha,
//    valor cobrado, valor pago, forma (crédito/débito à vista), ID do pagamento, código de autorização
//    e bandeira conhecida. Qualquer dado faltando ou diferente vira revisão manual, nunca aprovação.
//  - Nada é inventado: NSU = ID do pagamento no Mercado Pago (o "ID da operação" do comprovante) e a
//    autorização vem do próprio pagamento.
//  - Estado final gravado (aprovado, recusado, cancelado, expirado) não é reconsultado nem rebaixado.
import {
  PaymentTerminalProviderError,
  isValidExternalReference,
  type PaymentTerminalChargeResult,
  type PaymentTerminalProvider,
} from '../../../server/shared/paymentTerminal.ts';

export type PointMethod = 'CREDIT' | 'DEBIT';
export type PointCardBrand = 'VISA' | 'MASTERCARD' | 'ELO';

export type ChargeStatus =
  | 'creating'
  | 'pending'
  | 'at_terminal'
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'expired'
  | 'refunded'
  | 'manual_review';

export interface TerminalChargeRow {
  id: string;
  tenant_id: string;
  idempotency_key: string;
  order_id: string;
  terminal_id: string;
  provider: 'mercado_pago_point';
  external_terminal_id: string;
  method: PointMethod;
  amount_cents: number;
  status: ChargeStatus;
  external_order_id: string | null;
  external_payment_id: string | null;
  raw_status: string | null;
  raw_status_detail: string | null;
  paid_amount_cents: number | null;
  card_brand: PointCardBrand | null;
  authorization_code: string | null;
  last_four: string | null;
  created_by: string | null;
}

export type NewChargeRow = Omit<TerminalChargeRow, 'id'>;
export type ChargePatch = Partial<Pick<TerminalChargeRow,
  'status' | 'external_order_id' | 'external_payment_id' | 'raw_status' | 'raw_status_detail' | 'paid_amount_cents' | 'card_brand' | 'authorization_code' | 'last_four'>>;

export interface ChargeStore {
  findByKey(idempotencyKey: string): Promise<TerminalChargeRow | null>;
  /** Insere; se a chave já existe (corrida entre dois envios), devolve a linha que ficou. */
  insert(row: NewChargeRow): Promise<TerminalChargeRow>;
  update(id: string, patch: ChargePatch): Promise<TerminalChargeRow>;
}

/** Pagamento do Mercado Pago (GET /v1/payments/{id}), só os campos conferidos. */
export interface PointPaymentDetails {
  id: string;
  status: string | null;
  amountCents: number | null;
  paymentMethodId: string | null;
  paymentTypeId: string | null;
  authorizationCode: string | null;
  lastFour: string | null;
  installments: number | null;
}

export interface PaymentDetailsSource {
  getPayment(paymentId: string): Promise<PointPaymentDetails>;
}

/** Maquininha lida pelo JWT do aparelho (RLS): só aparece se for da loja dele. */
export interface TerminalRecord {
  id: string;
  tenant_id: string;
  serial_number: string;
  acquirer: string;
}

export interface ChargeContext {
  store: ChargeStore;
  provider: PaymentTerminalProvider;
  payments: PaymentDetailsSource;
}

export interface CreateInput {
  idempotency_key: unknown;
  order_id: unknown;
  amount_cents: unknown;
  method: unknown;
  staff_id?: unknown;
}

export type ChargeReply =
  | { status: 'PENDING'; idempotency_key: string; detail: string }
  | {
      status: 'APPROVED';
      idempotency_key: string;
      nsu: string;
      authorization_code: string;
      card_brand: PointCardBrand;
      last_four: string | null;
      terminal_serial: string;
      amount_cents: number;
      method: PointMethod;
    }
  | { status: 'DECLINED'; idempotency_key: string; reason: string }
  | { status: 'MANUAL_REVIEW'; idempotency_key: string; reason: string; code: string };

export class ChargeInputError extends Error {
  constructor(readonly code: string, message: string, readonly httpStatus = 400) {
    super(message);
    this.name = 'ChargeInputError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9_-]{1,50}$/;
const FINAL: ReadonlySet<ChargeStatus> = new Set(['approved', 'rejected', 'cancelled', 'expired', 'refunded']);
/** Valor máximo de uma cobrança (R$ 100.000,00): protege contra digitação em centavos trocada. */
export const MAX_AMOUNT_CENTS = 10_000_000;

export function validKey(value: unknown): value is string {
  return typeof value === 'string' && KEY.test(value) && isValidExternalReference(value);
}

/** Bandeira pelo payment_method_id do Mercado Pago. Outra bandeira não tem código no app: revisão manual. */
export function brandFromMethodId(id: string | null): PointCardBrand | null {
  switch ((id ?? '').toLowerCase()) {
    case 'visa':
    case 'debvisa':
      return 'VISA';
    case 'master':
    case 'debmaster':
      return 'MASTERCARD';
    case 'elo':
    case 'debelo':
      return 'ELO';
    default:
      return null;
  }
}

function expectedType(method: PointMethod): 'credit_card' | 'debit_card' {
  return method === 'CREDIT' ? 'credit_card' : 'debit_card';
}

export function validateCreate(input: CreateInput): { idempotency_key: string; order_id: string; amount_cents: number; method: PointMethod; staff_id: string | null } {
  if (!validKey(input.idempotency_key)) throw new ChargeInputError('invalid_key', 'Chave da cobrança inválida (até 50 letras, números, - ou _).');
  if (typeof input.order_id !== 'string' || !UUID.test(input.order_id)) throw new ChargeInputError('invalid_order', 'Conta inválida.');
  const cents = input.amount_cents;
  if (typeof cents !== 'number' || !Number.isSafeInteger(cents) || cents <= 0 || cents > MAX_AMOUNT_CENTS) {
    throw new ChargeInputError('invalid_amount', 'Valor inválido.');
  }
  if (input.method !== 'CREDIT' && input.method !== 'DEBIT') {
    throw new ChargeInputError('invalid_method', 'Pela Point Smart esta versão cobra só crédito à vista e débito.');
  }
  const staff = input.staff_id;
  if (staff !== undefined && staff !== null && (typeof staff !== 'string' || !UUID.test(staff))) throw new ChargeInputError('invalid_staff', 'Operador inválido.');
  return { idempotency_key: input.idempotency_key, order_id: input.order_id, amount_cents: cents, method: input.method, staff_id: (staff as string | null | undefined) ?? null };
}

function sameRequest(row: TerminalChargeRow, req: { order_id: string; amount_cents: number; method: PointMethod }, terminal: TerminalRecord): boolean {
  return row.tenant_id === terminal.tenant_id && row.order_id === req.order_id && row.terminal_id === terminal.id
    && row.amount_cents === req.amount_cents && row.method === req.method && row.external_terminal_id === terminal.serial_number;
}

/** Resposta ao aparelho a partir da linha gravada. */
export function replyFor(row: TerminalChargeRow): ChargeReply {
  const key = row.idempotency_key;
  switch (row.status) {
    case 'approved':
      if (!row.external_payment_id || !row.authorization_code || !row.card_brand) {
        return { status: 'MANUAL_REVIEW', idempotency_key: key, code: 'APPROVED_ROW_INCOMPLETE', reason: 'Aprovação gravada sem comprovante completo. Confira no app do Mercado Pago.' };
      }
      return {
        status: 'APPROVED', idempotency_key: key, nsu: row.external_payment_id, authorization_code: row.authorization_code,
        card_brand: row.card_brand, last_four: row.last_four, terminal_serial: row.external_terminal_id, amount_cents: row.amount_cents, method: row.method,
      };
    case 'rejected':
      return { status: 'DECLINED', idempotency_key: key, reason: declineReason(row) };
    case 'cancelled':
      return { status: 'DECLINED', idempotency_key: key, reason: 'Cobrança cancelada na maquininha (nada foi cobrado).' };
    case 'expired':
      return { status: 'DECLINED', idempotency_key: key, reason: 'A cobrança expirou na maquininha (nada foi cobrado).' };
    case 'refunded':
      return { status: 'MANUAL_REVIEW', idempotency_key: key, code: 'REFUNDED', reason: 'A cobrança aparece estornada no Mercado Pago. Confira no app antes de cobrar de novo.' };
    case 'manual_review':
      return { status: 'MANUAL_REVIEW', idempotency_key: key, code: row.raw_status_detail ?? 'MANUAL_REVIEW', reason: 'O Mercado Pago não confirmou a cobrança por completo. Confira no app do Mercado Pago antes de cobrar de novo.' };
    default:
      return { status: 'PENDING', idempotency_key: key, detail: row.status === 'at_terminal' ? 'Aguardando o cartão na maquininha.' : 'Enviando para a maquininha.' };
  }
}

function declineReason(row: TerminalChargeRow): string {
  const raw = row.raw_status ?? '';
  if (raw.startsWith('create_failed:')) {
    const code = raw.slice('create_failed:'.length);
    if (code === 'terminal_busy') return 'A maquininha já tem outra cobrança na fila. Finalize ou cancele nela e tente de novo.';
    if (code === 'not_found') return 'Maquininha não encontrada nesta conta Mercado Pago (confira o terminal_id e o modo PDV).';
    if (code === 'unauthorized') return 'Token do Mercado Pago recusado. Confira o Access Token da loja.';
    return 'O Mercado Pago recusou o pedido de cobrança (nada foi cobrado).';
  }
  return `Transação recusada${row.raw_status_detail ? ` (${row.raw_status_detail})` : ''}.`;
}

/** Erros da criação que provam que a ordem não existe no Mercado Pago (nada foi cobrado). */
function definiteCreateFailure(error: unknown): string | null {
  if (!(error instanceof PaymentTerminalProviderError) || error.outcomeUnknown) return null;
  if (error.code === 'idempotency_conflict') return null; // a chave já criou outra ordem: não é recusa
  return error.code;
}

async function sendCreate(ctx: ChargeContext, row: TerminalChargeRow): Promise<TerminalChargeRow> {
  try {
    const order = await ctx.provider.createCharge({
      externalTerminalId: row.external_terminal_id,
      amountCents: row.amount_cents,
      idempotencyKey: row.idempotency_key,
      externalReference: row.idempotency_key,
      method: row.method === 'CREDIT' ? 'credit' : 'debit',
      installments: 1,
      description: 'Tchê Food',
    });
    return await applyOrder(ctx, row, order);
  } catch (error) {
    const failure = definiteCreateFailure(error);
    if (failure) return ctx.store.update(row.id, { status: 'rejected', raw_status: `create_failed:${failure}`, raw_status_detail: null });
    if (error instanceof PaymentTerminalProviderError && error.code === 'idempotency_conflict') {
      return ctx.store.update(row.id, { status: 'manual_review', raw_status: 'create_conflict', raw_status_detail: 'IDEMPOTENCY_CONFLICT' });
    }
    // Resultado desconhecido (queda, timeout, 5xx, resposta ilegível): continua "creating" e a próxima consulta repete
    // a criação com a MESMA chave e o MESMO pedido, que o Mercado Pago deduplica.
    return row;
  }
}

async function applyOrder(ctx: ChargeContext, row: TerminalChargeRow, order: PaymentTerminalChargeResult): Promise<TerminalChargeRow> {
  if (row.external_order_id && order.externalOrderId !== row.external_order_id) {
    return ctx.store.update(row.id, { status: 'manual_review', raw_status: order.rawStatus, raw_status_detail: 'ORDER_ID_CHANGED' });
  }
  const base: ChargePatch = {
    external_order_id: order.externalOrderId,
    raw_status: order.rawStatus,
    raw_status_detail: order.rawStatusDetail,
    paid_amount_cents: order.paidAmountCents,
    external_payment_id: order.externalPaymentId,
  };
  const mismatch = (code: string): Promise<TerminalChargeRow> => ctx.store.update(row.id, { ...base, status: 'manual_review', raw_status_detail: code });

  // A ordem precisa ser esta cobrança mesmo quando ainda não terminou.
  if (order.externalReference !== null && order.externalReference !== row.idempotency_key) return mismatch('REFERENCE_MISMATCH');
  if (order.externalTerminalId !== null && order.externalTerminalId !== row.external_terminal_id) return mismatch('TERMINAL_MISMATCH');
  if (order.amountCents !== row.amount_cents) return mismatch('AMOUNT_MISMATCH');

  switch (order.status) {
    case 'pending':
      return ctx.store.update(row.id, { ...base, status: 'pending' });
    case 'at_terminal':
      return ctx.store.update(row.id, { ...base, status: 'at_terminal' });
    case 'rejected':
    case 'cancelled':
    case 'expired':
    case 'refunded':
      return ctx.store.update(row.id, { ...base, status: order.status });
    case 'manual_review':
      return mismatch('PROVIDER_STATUS_UNCERTAIN');
    case 'approved':
      break;
  }

  // Aprovação: a ordem só conta com referência e maquininha ecoadas, valor pago igual e forma certa.
  if (order.externalReference === null) return mismatch('APPROVED_WITHOUT_REFERENCE');
  if (order.externalTerminalId === null) return mismatch('APPROVED_WITHOUT_TERMINAL');
  if (order.paidAmountCents !== row.amount_cents) return mismatch('PAID_AMOUNT_MISMATCH');
  if (order.paymentMethodType !== expectedType(row.method)) return mismatch('METHOD_MISMATCH');
  if (order.installments !== null && order.installments !== 1) return mismatch('INSTALLMENTS_MISMATCH');
  if (!order.externalPaymentId) return mismatch('APPROVED_WITHOUT_NSU');

  let payment: PointPaymentDetails;
  try {
    payment = await ctx.payments.getPayment(order.externalPaymentId);
  } catch {
    // Sem a confirmação do pagamento ainda: fica como estava (a próxima consulta tenta de novo).
    return ctx.store.update(row.id, { ...base, status: row.status === 'creating' ? 'pending' : row.status === 'manual_review' ? 'manual_review' : 'at_terminal' });
  }
  if (payment.id !== order.externalPaymentId) return mismatch('PAYMENT_ID_MISMATCH');
  if (payment.status !== 'approved') return mismatch('PAYMENT_NOT_APPROVED');
  if (payment.amountCents !== row.amount_cents) return mismatch('PAYMENT_AMOUNT_MISMATCH');
  if (payment.paymentTypeId !== expectedType(row.method)) return mismatch('PAYMENT_METHOD_MISMATCH');
  if (payment.installments !== null && payment.installments !== 1) return mismatch('PAYMENT_INSTALLMENTS_MISMATCH');
  const authorization = (payment.authorizationCode ?? '').trim();
  if (!/^[A-Za-z0-9]{1,20}$/.test(authorization)) return mismatch('APPROVED_WITHOUT_AUTHORIZATION');
  const brand = brandFromMethodId(payment.paymentMethodId ?? order.paymentMethodId);
  if (!brand) return mismatch('UNSUPPORTED_BRAND');
  const lastFour = payment.lastFour && /^\d{4}$/.test(payment.lastFour) ? payment.lastFour : null;
  return ctx.store.update(row.id, { ...base, status: 'approved', authorization_code: authorization, card_brand: brand, last_four: lastFour });
}

/** Cria (ou retoma, com a mesma chave) a cobrança e devolve o estado atual. */
export async function startCharge(ctx: ChargeContext, terminal: TerminalRecord, input: CreateInput): Promise<ChargeReply> {
  const req = validateCreate(input);
  if (terminal.acquirer !== 'MERCADO_PAGO') throw new ChargeInputError('not_mercado_pago', 'Esta maquininha não é Mercado Pago Point.');
  if (!terminal.serial_number.trim()) throw new ChargeInputError('terminal_without_id', 'Maquininha sem o terminal_id do Mercado Pago.');
  const existing = await ctx.store.findByKey(req.idempotency_key);
  if (existing) {
    if (!sameRequest(existing, req, terminal)) throw new ChargeInputError('idempotency_conflict', 'Esta chave já foi usada em outra cobrança.', 409);
    return pollCharge(ctx, existing);
  }
  const inserted = await ctx.store.insert({
    tenant_id: terminal.tenant_id,
    idempotency_key: req.idempotency_key,
    order_id: req.order_id,
    terminal_id: terminal.id,
    provider: 'mercado_pago_point',
    external_terminal_id: terminal.serial_number,
    method: req.method,
    amount_cents: req.amount_cents,
    status: 'creating',
    external_order_id: null,
    external_payment_id: null,
    raw_status: null,
    raw_status_detail: null,
    paid_amount_cents: null,
    card_brand: null,
    authorization_code: null,
    last_four: null,
    created_by: req.staff_id,
  });
  // Corrida: outro envio com a mesma chave gravou primeiro.
  if (!sameRequest(inserted, req, terminal)) throw new ChargeInputError('idempotency_conflict', 'Esta chave já foi usada em outra cobrança.', 409);
  if (inserted.status !== 'creating' || inserted.external_order_id) return pollCharge(ctx, inserted);
  return replyFor(await sendCreate(ctx, inserted));
}

/** Reconsulta a cobrança no Mercado Pago (estado final gravado não é reconsultado). */
export async function pollCharge(ctx: ChargeContext, row: TerminalChargeRow): Promise<ChargeReply> {
  if (FINAL.has(row.status)) return replyFor(row);
  if (!row.external_order_id) return replyFor(await sendCreate(ctx, row));
  let order: PaymentTerminalChargeResult;
  try {
    order = await ctx.provider.getCharge(row.external_order_id);
  } catch {
    return replyFor(row);
  }
  return replyFor(await applyOrder(ctx, row, order));
}

/**
 * Pede o cancelamento na maquininha e devolve o estado reconsultado. Só vira recusa quando o
 * Mercado Pago confirma cancelada/expirada; senão continua pendente ou vai para revisão manual.
 */
export async function cancelCharge(ctx: ChargeContext, row: TerminalChargeRow): Promise<ChargeReply> {
  if (FINAL.has(row.status)) return replyFor(row);
  let current = row;
  if (!current.external_order_id) {
    current = await sendCreate(ctx, current);
    if (FINAL.has(current.status) || !current.external_order_id) return replyFor(current);
  }
  try {
    await ctx.provider.cancelCharge(current.external_order_id!, { idempotencyKey: `${current.idempotency_key}-cancel` });
  } catch {
    // Não cancelável (já pago, já cancelado) ou erro: a reconsulta abaixo diz o que vale.
  }
  return pollCharge(ctx, current);
}
