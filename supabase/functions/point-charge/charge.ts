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
//  - Estado final gravado (aprovado, recusado, cancelado, expirado) não é reconsultado nem rebaixado:
//    cada gravação só vale se a cobrança ainda estiver no estado lido (ChargeStore.update), e o banco
//    recusa mudar uma cobrança final (gatilho em db/schema_mercado_pago.sql).
//  - Cobrança nova só para conta aberta no servidor e dentro do saldo (RPC tchefood_open_terminal_charge).
//  - "Encerrar tentativa" (cancel) não estorna nada: só pede à maquininha que pare de esperar o cartão.
//    Fica registrado quem pediu, por quê e quando. Sem cobrança gravada, grava um bloqueio da chave
//    (status cancelled, raw_status voided_before_send) para que uma criação atrasada nunca chegue à Point.
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
  /** Primeiro envio da ordem ao Mercado Pago. NULL = nunca saiu daqui. */
  dispatched_at: string | null;
  cancel_reason: CancelReason | null;
  cancel_requested_by: string | null;
  cancel_requested_at: string | null;
  cancel_authorized_by: string | null;
  cancel_audit_id: string | null;
  created_at: string;
}

/** timeout = prazo vencido (o servidor confere); operator = pedido do operador com PIN de gerente; void = chave bloqueada sem cobrança. */
export type CancelReason = 'timeout' | 'operator' | 'void';

export type NewChargeRow = Omit<TerminalChargeRow, 'id' | 'created_at'>;
export type ChargePatch = Partial<Pick<TerminalChargeRow,
  'status' | 'external_order_id' | 'external_payment_id' | 'raw_status' | 'raw_status_detail' | 'paid_amount_cents' | 'card_brand' | 'authorization_code' | 'last_four'
  | 'cancel_reason' | 'cancel_requested_by' | 'cancel_requested_at'>>;

export type ChargeRefusal = 'order_not_found' | 'order_closed' | 'over_balance' | 'invalid_staff' | 'not_found' | 'invalid_reason';

/** Recusa do banco (conta inexistente, fechada, acima do saldo, operador fora da equipe). Nada foi gravado. */
export class ChargeRefusedError extends Error {
  constructor(readonly code: ChargeRefusal, message: string) {
    super(message);
    this.name = 'ChargeRefusedError';
  }
}

export interface ChargeStore {
  findByKey(idempotencyKey: string): Promise<TerminalChargeRow | null>;
  /**
   * Abre a cobrança ("creating") com a conta travada no banco: só conta aberta da loja e valor dentro do
   * saldo menos as outras cobranças em andamento. Chave já gravada: devolve a linha que ficou.
   * Lança ChargeRefusedError quando o banco recusa.
   */
  insert(row: NewChargeRow): Promise<TerminalChargeRow>;
  /** Bloqueio da chave sem cobrança (nunca vai à Point). Chave já gravada: devolve a linha que ficou. */
  insertVoid(row: NewChargeRow): Promise<TerminalChargeRow>;
  /**
   * Grava só se a cobrança ainda estiver no estado de `row` (lido antes da consulta externa). Se outra
   * consulta mudou o estado no meio, não grava e devolve a linha atual.
   */
  update(row: TerminalChargeRow, patch: ChargePatch): Promise<TerminalChargeRow>;
  /**
   * Marca o primeiro envio ao Mercado Pago, só se a cobrança ainda estiver "creating", nunca enviada e sem
   * pedido de encerramento. null = não marcou (outro envio marcou antes ou o encerramento chegou).
   */
  claimDispatch(row: TerminalChargeRow): Promise<TerminalChargeRow | null>;
  /** Encerra a cobrança que nunca foi enviada (status creating, sem envio). Devolve a linha atual. */
  voidUndispatched(row: TerminalChargeRow): Promise<TerminalChargeRow>;
  /** Cobranças da conta ainda não encerradas (para reconsultar antes de abrir outra). */
  listOpenForOrder(orderId: string): Promise<TerminalChargeRow[]>;
  /**
   * Confere o PIN de gerente no banco (tchefood_authorize_point_cancel), grava o audit_log e o encerramento
   * na cobrança. Devolve o id do audit_log, ou null com PIN errado ou bloqueado.
   */
  authorizeCancel(input: { idempotency_key: string; performed_by: string; manager_pin: string; reason: string }): Promise<string | null>;
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
      if (row.raw_status === 'voided_before_send') return { status: 'DECLINED', idempotency_key: key, reason: 'A cobrança não chegou à maquininha (nada foi cobrado).' };
      if (row.raw_status === 'manager_released') return { status: 'DECLINED', idempotency_key: key, reason: 'Cobrança encerrada pelo gerente depois de conferir no app do Mercado Pago.' };
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

/**
 * Manda (ou repete, com a mesma chave) a ordem ao Mercado Pago. Só para cobrança "creating":
 *  - nunca enviada e com pedido de encerramento: encerra sem mandar nada;
 *  - nunca enviada: marca o envio no banco antes (dois pedidos juntos: só um manda);
 *  - já enviada com resultado desconhecido: repete com a mesma chave, menos se o encerramento já foi
 *    pedido (a repetição podia virar uma ordem nova na Point).
 */
async function sendCreate(ctx: ChargeContext, row: TerminalChargeRow): Promise<TerminalChargeRow> {
  if (row.status !== 'creating') return row;
  let current = row;
  let firstDispatch = false;
  if (!current.dispatched_at) {
    if (current.cancel_requested_at) return ctx.store.voidUndispatched(current);
    const claimed = await ctx.store.claimDispatch(current);
    if (!claimed) {
      const fresh = await ctx.store.findByKey(current.idempotency_key);
      if (!fresh) throw new Error('Cobrança sumiu durante o envio.');
      if (fresh.status === 'creating' && !fresh.dispatched_at && fresh.cancel_requested_at) return ctx.store.voidUndispatched(fresh);
      return fresh; // outro pedido mandou: a próxima consulta acompanha
    }
    current = claimed;
    firstDispatch = true;
  } else {
    // Repetição: confere o estado gravado agora (a linha na mão pode ser anterior ao encerramento).
    const fresh = await ctx.store.findByKey(current.idempotency_key);
    if (!fresh || fresh.status !== 'creating' || fresh.cancel_requested_at || fresh.external_order_id) return fresh ?? current;
    current = fresh;
  }
  try {
    const order = await ctx.provider.createCharge({
      externalTerminalId: current.external_terminal_id,
      amountCents: current.amount_cents,
      idempotencyKey: current.idempotency_key,
      externalReference: current.idempotency_key,
      method: current.method === 'CREDIT' ? 'credit' : 'debit',
      installments: 1,
      description: 'Tchê Food',
    });
    return await applyOrder(ctx, current, order);
  } catch (error) {
    const failure = definiteCreateFailure(error);
    // Recusa definitiva só prova "nada foi criado" no primeiro envio: numa repetição, o envio anterior
    // pode ter criado a ordem. Aí continua como resultado desconhecido.
    if (failure && firstDispatch) return ctx.store.update(current, { status: 'rejected', raw_status: `create_failed:${failure}`, raw_status_detail: null });
    if (error instanceof PaymentTerminalProviderError && error.code === 'idempotency_conflict') {
      return ctx.store.update(current, { status: 'manual_review', raw_status: 'create_conflict', raw_status_detail: 'IDEMPOTENCY_CONFLICT' });
    }
    // Resultado desconhecido (queda, timeout, 5xx, resposta ilegível): continua "creating" e a próxima consulta repete
    // a criação com a MESMA chave e o MESMO pedido, que o Mercado Pago deduplica.
    return current;
  }
}

async function applyOrder(ctx: ChargeContext, row: TerminalChargeRow, order: PaymentTerminalChargeResult): Promise<TerminalChargeRow> {
  if (row.external_order_id && order.externalOrderId !== row.external_order_id) {
    return ctx.store.update(row, { status: 'manual_review', raw_status: order.rawStatus, raw_status_detail: 'ORDER_ID_CHANGED' });
  }
  const base: ChargePatch = {
    external_order_id: order.externalOrderId,
    raw_status: order.rawStatus,
    raw_status_detail: order.rawStatusDetail,
    paid_amount_cents: order.paidAmountCents,
    external_payment_id: order.externalPaymentId,
  };
  const mismatch = (code: string): Promise<TerminalChargeRow> => ctx.store.update(row, { ...base, status: 'manual_review', raw_status_detail: code });

  // A ordem precisa ser esta cobrança mesmo quando ainda não terminou.
  if (order.externalReference !== null && order.externalReference !== row.idempotency_key) return mismatch('REFERENCE_MISMATCH');
  if (order.externalTerminalId !== null && order.externalTerminalId !== row.external_terminal_id) return mismatch('TERMINAL_MISMATCH');
  if (order.amountCents !== row.amount_cents) return mismatch('AMOUNT_MISMATCH');

  switch (order.status) {
    case 'pending':
      return ctx.store.update(row, { ...base, status: 'pending' });
    case 'at_terminal':
      return ctx.store.update(row, { ...base, status: 'at_terminal' });
    case 'rejected':
    case 'cancelled':
    case 'expired':
    case 'refunded':
      return ctx.store.update(row, { ...base, status: order.status });
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
  if (order.installments !== null && order.installments !== 1) return mismatch('INSTALLMENTS_MISMATCH');  // o pagamento confirma abaixo
  if (!order.externalPaymentId) return mismatch('APPROVED_WITHOUT_NSU');

  let payment: PointPaymentDetails;
  try {
    payment = await ctx.payments.getPayment(order.externalPaymentId);
  } catch {
    // Sem a confirmação do pagamento ainda: fica como estava (a próxima consulta tenta de novo).
    return ctx.store.update(row, { ...base, status: row.status === 'creating' ? 'pending' : row.status === 'manual_review' ? 'manual_review' : 'at_terminal' });
  }
  if (payment.id !== order.externalPaymentId) return mismatch('PAYMENT_ID_MISMATCH');
  if (payment.status !== 'approved') return mismatch('PAYMENT_NOT_APPROVED');
  if (payment.amountCents !== row.amount_cents) return mismatch('PAYMENT_AMOUNT_MISMATCH');
  if (payment.paymentTypeId !== expectedType(row.method)) return mismatch('PAYMENT_METHOD_MISMATCH');
  // À vista confirmado pelo próprio pagamento: parcelas ausentes não contam como 1.
  if (payment.installments !== 1) return mismatch('PAYMENT_INSTALLMENTS_MISMATCH');
  const authorization = (payment.authorizationCode ?? '').trim();
  if (!/^[A-Za-z0-9]{1,20}$/.test(authorization)) return mismatch('APPROVED_WITHOUT_AUTHORIZATION');
  // Bandeira só pelo pagamento (a ordem não basta). Ordem com outra bandeira também vira revisão.
  const brand = brandFromMethodId(payment.paymentMethodId);
  if (!brand) return mismatch('UNSUPPORTED_BRAND');
  if (order.paymentMethodId !== null && brandFromMethodId(order.paymentMethodId) !== brand) return mismatch('BRAND_MISMATCH');
  const lastFour = payment.lastFour && /^\d{4}$/.test(payment.lastFour) ? payment.lastFour : null;
  return ctx.store.update(row, { ...base, status: 'approved', authorization_code: authorization, card_brand: brand, last_four: lastFour });
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
  const fresh = {
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
    dispatched_at: null,
    cancel_reason: null,
    cancel_requested_by: null,
    cancel_requested_at: null,
    cancel_authorized_by: null,
    cancel_audit_id: null,
  } satisfies NewChargeRow;
  // Outras cobranças desta conta ainda abertas reservam o saldo no banco. Antes de abrir esta, reconsulta as
  // que já têm ordem no Mercado Pago: as que terminaram lá liberam o saldo com prova. Nunca manda nenhuma.
  for (const other of await ctx.store.listOpenForOrder(req.order_id)) {
    if (other.idempotency_key !== req.idempotency_key) await refreshCharge(ctx, other).catch(() => undefined);
  }
  let inserted: TerminalChargeRow;
  try {
    inserted = await ctx.store.insert(fresh);
  } catch (error) {
    if (error instanceof ChargeRefusedError) throw new ChargeInputError(error.code, error.message, 409);
    throw error;
  }
  // Corrida: outro envio com a mesma chave gravou primeiro.
  if (!sameRequest(inserted, req, terminal)) throw new ChargeInputError('idempotency_conflict', 'Esta chave já foi usada em outra cobrança.', 409);
  if (inserted.status !== 'creating' || inserted.external_order_id) return pollCharge(ctx, inserted);
  return replyFor(await sendCreate(ctx, inserted));
}

/** Reconsulta a cobrança no Mercado Pago (estado final gravado não é reconsultado). */
export async function pollCharge(ctx: ChargeContext, row: TerminalChargeRow): Promise<ChargeReply> {
  if (FINAL.has(row.status)) return replyFor(row);
  if (!row.external_order_id) return replyFor(await sendCreate(ctx, row));
  return replyFor(await refreshCharge(ctx, row));
}

/** Só reconsulta a ordem que já existe no Mercado Pago; nunca manda ordem. */
async function refreshCharge(ctx: ChargeContext, row: TerminalChargeRow): Promise<TerminalChargeRow> {
  if (FINAL.has(row.status) || !row.external_order_id) return row;
  let order: PaymentTerminalChargeResult;
  try {
    order = await ctx.provider.getCharge(row.external_order_id);
  } catch {
    return row;
  }
  return applyOrder(ctx, row, order);
}

/** Prazo mínimo, contado pelo servidor desde a gravação, para encerrar por "timeout" sem gerente. */
export const SERVER_TIMEOUT_MS = 90_000;
/** Envio sem resposta há mais que isto não está mais a caminho (o cliente do Mercado Pago desiste antes). */
export const DISPATCH_SETTLED_MS = 120_000;

export interface CancelInput {
  reason: unknown;
  staff_id?: unknown;
  manager_pin?: unknown;
  reason_text?: unknown;
  order_id?: unknown;
  amount_cents?: unknown;
  method?: unknown;
}

export type CancelRequest =
  | { reason: 'timeout' }
  | { reason: 'operator'; staff_id: string; manager_pin: string; reason_text: string };

/**
 * "timeout": o servidor confere o prazo pela hora gravada; não aceita identidade do aparelho.
 * "operator": exige o operador, o PIN de gerente e o motivo (conferidos no banco).
 */
export function validateCancel(input: CancelInput): CancelRequest {
  if (input.reason === 'timeout') return { reason: 'timeout' };
  if (input.reason !== 'operator') throw new ChargeInputError('invalid_reason', 'Motivo do encerramento inválido.');
  if (typeof input.staff_id !== 'string' || !UUID.test(input.staff_id)) throw new ChargeInputError('invalid_staff', 'Informe quem está encerrando a cobrança.');
  if (typeof input.manager_pin !== 'string' || !/^\d{4,8}$/.test(input.manager_pin)) throw new ChargeInputError('manager_required', 'Encerrar a cobrança exige o PIN do gerente.', 403);
  if (typeof input.reason_text !== 'string' || input.reason_text.trim().length < 5) throw new ChargeInputError('invalid_reason', 'Informe o motivo (mínimo 5 caracteres).');
  return { reason: 'operator', staff_id: input.staff_id, manager_pin: input.manager_pin, reason_text: input.reason_text.trim() };
}

function matchesRow(row: TerminalChargeRow, input: CancelInput): boolean {
  return row.order_id === input.order_id && row.amount_cents === input.amount_cents && row.method === input.method;
}

/**
 * Encerra a tentativa: pede à maquininha que pare de esperar o cartão e devolve o estado reconsultado.
 * Não estorna: cobrança já paga continua paga (o Mercado Pago recusa cancelar ordem processada e a
 * reconsulta devolve a aprovação). Só vira recusa quando o Mercado Pago confirma cancelada/expirada, quando
 * a ordem nunca saiu daqui, ou quando o gerente encerra (com PIN) um envio que nunca teve resposta.
 */
export async function cancelCharge(ctx: ChargeContext, row: TerminalChargeRow, input: CancelInput, nowMs = Date.now()): Promise<ChargeReply> {
  const req = validateCancel(input);
  if (!matchesRow(row, input)) throw new ChargeInputError('idempotency_conflict', 'O encerramento não confere com a cobrança (conta, valor ou forma).', 409);
  if (FINAL.has(row.status)) return replyFor(row);
  let current = row;
  if (req.reason === 'operator') {
    let audit: string | null;
    try {
      audit = await ctx.store.authorizeCancel({ idempotency_key: row.idempotency_key, performed_by: req.staff_id, manager_pin: req.manager_pin, reason: req.reason_text });
    } catch (error) {
      if (error instanceof ChargeRefusedError) throw new ChargeInputError(error.code, error.message, 403);
      throw error;
    }
    if (!audit) throw new ChargeInputError('manager_denied', 'PIN de gerente incorreto ou bloqueado. Nada foi cancelado.', 403);
    current = (await ctx.store.findByKey(row.idempotency_key)) ?? row;
  } else {
    const created = Date.parse(row.created_at);
    if (!Number.isFinite(created) || nowMs - created < SERVER_TIMEOUT_MS) {
      throw new ChargeInputError('too_early', 'A cobrança ainda está no prazo de espera do cartão.', 409);
    }
    if (!current.cancel_requested_at) {
      current = await ctx.store.update(current, { cancel_reason: 'timeout', cancel_requested_by: null, cancel_requested_at: new Date(nowMs).toISOString() });
    }
  }
  if (FINAL.has(current.status)) return replyFor(current);
  if (!current.external_order_id) {
    if (!current.dispatched_at) return replyFor(await ctx.store.voidUndispatched(current));
    // Enviada sem resposta: não repete a criação. Só o gerente encerra, e só quando o envio não pode mais
    // estar a caminho (senão a ordem chegaria depois sem registro). Senão espera a ordem aparecer.
    const settled = nowMs - Date.parse(current.dispatched_at) >= DISPATCH_SETTLED_MS;
    if (current.cancel_reason === 'operator' && current.cancel_audit_id && settled) {
      return replyFor(await ctx.store.update(current, { status: 'cancelled', raw_status: 'manager_released', raw_status_detail: 'DISPATCH_UNKNOWN' }));
    }
    return replyFor(current);
  }
  try {
    await ctx.provider.cancelCharge(current.external_order_id, { idempotencyKey: `${current.idempotency_key}-cancel` });
  } catch {
    // Não cancelável (já pago, já cancelado) ou erro: a reconsulta abaixo diz o que vale.
  }
  return pollCharge(ctx, current);
}

/**
 * Encerrar sem cobrança gravada (a criação nunca chegou ou ainda está a caminho): grava o bloqueio da
 * chave. A partir daí uma criação atrasada com a mesma chave encontra a cobrança encerrada e não vai à
 * Point. Se a criação gravou primeiro, segue o encerramento normal da cobrança que ficou.
 */
export async function voidCharge(ctx: ChargeContext, terminal: TerminalRecord, input: CreateInput & CancelInput, nowMs = Date.now()): Promise<ChargeReply> {
  const req = validateCreate(input);
  validateCancel(input);
  if (terminal.acquirer !== 'MERCADO_PAGO') throw new ChargeInputError('not_mercado_pago', 'Esta maquininha não é Mercado Pago Point.');
  const existing = await ctx.store.findByKey(req.idempotency_key);
  const row = existing ?? await ctx.store.insertVoid({
    tenant_id: terminal.tenant_id,
    idempotency_key: req.idempotency_key,
    order_id: req.order_id,
    terminal_id: terminal.id,
    provider: 'mercado_pago_point',
    external_terminal_id: terminal.serial_number,
    method: req.method,
    amount_cents: req.amount_cents,
    status: 'cancelled',
    external_order_id: null,
    external_payment_id: null,
    raw_status: 'voided_before_send',
    raw_status_detail: null,
    paid_amount_cents: null,
    card_brand: null,
    authorization_code: null,
    last_four: null,
    // Sem identidade do aparelho: o bloqueio não manda nada à maquininha e não credita ninguém.
    created_by: null,
    dispatched_at: null,
    cancel_reason: 'void',
    cancel_requested_by: null,
    cancel_requested_at: new Date(nowMs).toISOString(),
    cancel_authorized_by: null,
    cancel_audit_id: null,
  });
  if (!sameRequest(row, req, terminal)) throw new ChargeInputError('idempotency_conflict', 'Esta chave já foi usada em outra cobrança.', 409);
  if (row.raw_status === 'voided_before_send') return { status: 'DECLINED', idempotency_key: row.idempotency_key, reason: 'A cobrança não chegou à maquininha (nada foi cobrado).' };
  return cancelCharge(ctx, row, input, nowMs);
}
