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
//    Fica registrado quem pediu, por quê e quando. Antes do prazo, só com PIN de gerente conferido no banco.
//  - Só vira recusa ("nada foi cobrado") com prova: o Mercado Pago disse recusada/cancelada/expirada, ou a
//    ordem comprovadamente nunca saiu daqui. Envio sem resposta nunca vira recusa por tempo nem por PIN:
//    fica em revisão manual, segurando o saldo da conta.
//  - Um pedido por vez fala com o Mercado Pago: quem manda a ordem tem a posse do envio (com prazo, no
//    banco) e passa pela barreira do banco imediatamente antes da chamada. Consultas no meio só
//    acompanham. Depois do pedido de encerramento ninguém mais manda.
//  - A ordem que o Mercado Pago devolve é ligada à cobrança assim que chega, em qualquer estado não final:
//    resposta válida não se perde por corrida com consulta, encerramento ou revisão manual.
//  - Prazos (posse do envio, espera do cartão) são decididos pelo relógio do banco, nunca pelo do aparelho
//    nem pelo desta função.
//  - Chave sem cobrança gravada: não há o que cancelar. Grava-se o bloqueio da chave (status cancelled,
//    raw_status voided_before_send), com operador ativo e registro, para que uma criação atrasada nunca
//    chegue à Point.
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
  /** Início do primeiro envio da ordem ao Mercado Pago (barreira do banco). NULL = nenhum envio saiu daqui. */
  dispatched_at: string | null;
  /** Posse do envio em andamento (relógio do banco). Enquanto vale, só quem a tem fala com o Mercado Pago. */
  dispatch_lease_until: string | null;
  /** Quantas posses foram dadas. */
  dispatch_attempts: number;
  cancel_reason: CancelReason | null;
  cancel_requested_by: string | null;
  cancel_requested_at: string | null;
  cancel_authorized_by: string | null;
  cancel_audit_id: string | null;
  created_at: string;
}

/** timeout = prazo vencido (o servidor confere); operator = pedido do operador com PIN de gerente; void = chave bloqueada sem cobrança (operador ativo, com registro). */
export type CancelReason = 'timeout' | 'operator' | 'void';

export type NewChargeRow = Omit<TerminalChargeRow, 'id' | 'created_at'>;
export type ChargePatch = Partial<Pick<TerminalChargeRow,
  'status' | 'external_order_id' | 'external_payment_id' | 'raw_status' | 'raw_status_detail' | 'paid_amount_cents' | 'card_brand' | 'authorization_code' | 'last_four'>>;

export type ChargeRefusal = 'order_not_found' | 'order_closed' | 'over_balance' | 'invalid_staff' | 'not_found' | 'invalid_reason' | 'not_applicable';

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
  /**
   * Bloqueio da chave sem cobrança (nunca vai à Point), pedido por `row.cancel_requested_by`, que o banco
   * confere ser da equipe ativa da loja (ChargeRefusedError se não for) e registra em audit_logs.
   * Chave já gravada: devolve a linha que ficou, sem mexer.
   */
  insertVoid(row: NewChargeRow): Promise<TerminalChargeRow>;
  /**
   * Grava só se a cobrança ainda estiver no estado de `row` (lido antes da consulta externa). Se outra
   * consulta mudou o estado no meio, não grava e devolve a linha atual.
   */
  update(row: TerminalChargeRow, patch: ChargePatch): Promise<TerminalChargeRow>;
  /**
   * Pede a posse do envio por `leaseMs` (relógio do banco, um UPDATE só): só para cobrança "creating", sem
   * ordem, sem pedido de encerramento, sem outra posse em vigor e dentro do limite de posses. Devolve a
   * linha com a posse (dispatch_attempts = número desta posse) ou null se não ganhou. Ainda não marca envio.
   */
  claimDispatch(row: TerminalChargeRow, leaseMs: number): Promise<TerminalChargeRow | null>;
  /**
   * Barreira IMEDIATAMENTE antes da chamada ao Mercado Pago (nada mais pode ficar entre ela e a chamada).
   * Atômica no banco: só passa se a posse ainda for a de `row`, estiver em vigor, a cobrança seguir
   * "creating" sem ordem e sem pedido de encerramento. Marca o primeiro envio e renova a posse por `leaseMs`.
   * Devolve 1 (primeiro envio: nada saiu antes), 2 (repetição de um envio anterior) ou 0 (não mande).
   */
  beginDispatch(row: TerminalChargeRow, leaseMs: number): Promise<0 | 1 | 2>;
  /**
   * Liga a ordem que o Mercado Pago devolveu à cobrança, em qualquer estado não final, se ela ainda não tem
   * ordem. Devolve a linha atual (com esta ordem, ou com o que já estava gravado).
   */
  attachOrder(row: TerminalChargeRow, externalOrderId: string): Promise<TerminalChargeRow>;
  /**
   * Recusa definitiva do PRIMEIRO envio (nada foi criado): só grava se a cobrança seguir "creating", sem
   * ordem e com a posse de `row`. Devolve a linha atual.
   */
  rejectFirstSend(row: TerminalChargeRow, code: string): Promise<TerminalChargeRow>;
  /** Devolve a posse (o Mercado Pago RESPONDEU sem resultado): só se a posse ainda for a de `row`. */
  releaseDispatch(row: TerminalChargeRow): Promise<void>;
  /** Encerra a cobrança de que nenhum envio saiu (status creating, dispatched_at nulo). Devolve a linha atual. */
  voidUndispatched(row: TerminalChargeRow): Promise<TerminalChargeRow>;
  /**
   * Envio que saiu e ficou sem resposta, com encerramento pedido e posse vencida pelo relógio do banco: vai
   * para revisão manual (DISPATCH_UNKNOWN), segurando o saldo. Fora dessas condições não muda nada.
   * Devolve a linha atual.
   */
  settleDispatch(row: TerminalChargeRow): Promise<TerminalChargeRow>;
  /**
   * Encerramento por prazo, decidido pelo relógio do banco contra a hora gravada da cobrança. Devolve null
   * se ainda é cedo (nada gravado); senão a linha atual, com o pedido gravado (por esta ou outra chamada).
   */
  requestTimeoutCancel(row: TerminalChargeRow, waitMs: number): Promise<TerminalChargeRow | null>;
  /** Cobranças da conta ainda não encerradas (para reconsultar antes de abrir outra). */
  listOpenForOrder(orderId: string): Promise<TerminalChargeRow[]>;
  /**
   * Confere o PIN de gerente no banco (tchefood_authorize_point_cancel), grava UM audit_log e o encerramento
   * na cobrança. Devolve o id do audit_log (o da primeira autorização, se repetida), ou null com PIN errado
   * ou bloqueado. Cobrança já em estado final: ChargeRefusedError('not_applicable'), sem audit_log.
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
      return { status: 'DECLINED', idempotency_key: key, reason: 'Cobrança cancelada na maquininha (nada foi cobrado).' };
    case 'expired':
      return { status: 'DECLINED', idempotency_key: key, reason: 'A cobrança expirou na maquininha (nada foi cobrado).' };
    case 'refunded':
      return { status: 'MANUAL_REVIEW', idempotency_key: key, code: 'REFUNDED', reason: 'A cobrança aparece estornada no Mercado Pago. Confira no app antes de cobrar de novo.' };
    case 'manual_review':
      if (row.raw_status_detail === 'DISPATCH_UNKNOWN') {
        return { status: 'MANUAL_REVIEW', idempotency_key: key, code: 'DISPATCH_UNKNOWN', reason: 'A cobrança foi enviada e o Mercado Pago não respondeu. Ela pode ter sido paga: confira no app do Mercado Pago antes de cobrar de novo.' };
      }
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

/** Erros da criação que provam que ESTE pedido não criou ordem no Mercado Pago. */
function definiteCreateFailure(error: unknown): string | null {
  if (!(error instanceof PaymentTerminalProviderError) || error.outcomeUnknown) return null;
  if (error.code === 'idempotency_conflict') return null; // a chave já criou outra ordem: não é recusa
  return error.code;
}

/** Posse do envio: maior que o prazo de uma chamada ao Mercado Pago (15 s), para nunca haver duas juntas. */
export const DISPATCH_LEASE_MS = 30_000;

/**
 * Cobrança "creating", sem ordem e com encerramento pedido: daqui não sai mais envio. Se nenhum envio saiu,
 * encerra com prova ("voided_before_send"). Se saiu, o resultado é desconhecido: revisão manual assim que a
 * posse vencer (relógio do banco); enquanto ela vale, quem a tem ainda pode gravar a ordem. Nunca recusa.
 */
async function closeUnsent(ctx: ChargeContext, row: TerminalChargeRow): Promise<TerminalChargeRow> {
  if (row.status !== 'creating' || row.external_order_id || !row.cancel_requested_at) return row;
  return row.dispatched_at ? ctx.store.settleDispatch(row) : ctx.store.voidUndispatched(row);
}

async function reread(ctx: ChargeContext, row: TerminalChargeRow): Promise<TerminalChargeRow> {
  const fresh = await ctx.store.findByKey(row.idempotency_key);
  if (!fresh) throw new Error('Cobrança sumiu durante o envio.');
  return fresh;
}

/**
 * Manda (ou repete, com a mesma chave) a ordem ao Mercado Pago. Só para cobrança "creating" sem ordem:
 *  1. pede a posse do envio (claimDispatch): outra chamada com a posse em vigor = esta só acompanha;
 *  2. passa pela barreira do banco (beginDispatch) e, sem nenhuma outra espera, chama o Mercado Pago. A
 *     barreira confere de novo, numa operação só, posse, prazo e pedido de encerramento;
 *  3. liga a ordem devolvida à cobrança (attachOrder) antes de qualquer outra coisa, e só então confere o
 *     resultado. Encerramento pedido com a ordem a caminho: cancela no Mercado Pago e grava o que ele disser.
 * Recusa definitiva só vira "nada foi cobrado" no primeiro envio (a barreira diz se é). Numa repetição o
 * envio anterior pode ter criado a ordem: fica como resultado desconhecido.
 */
async function sendCreate(ctx: ChargeContext, row: TerminalChargeRow): Promise<TerminalChargeRow> {
  if (row.status !== 'creating' || row.external_order_id) return row;
  if (row.cancel_requested_at) return closeUnsent(ctx, row);
  const claimed = await ctx.store.claimDispatch(row, DISPATCH_LEASE_MS);
  // Sem posse: envio em andamento em outra chamada, encerramento pedido, limite de envios ou estado mudou.
  if (!claimed) return closeUnsent(ctx, await reread(ctx, row));
  const begun = await ctx.store.beginDispatch(claimed, DISPATCH_LEASE_MS);
  if (begun === 0) return closeUnsent(ctx, await reread(ctx, row));
  // Entre a barreira e esta chamada não há nenhuma outra espera.
  let order: PaymentTerminalChargeResult;
  try {
    order = await ctx.provider.createCharge({
      externalTerminalId: claimed.external_terminal_id,
      amountCents: claimed.amount_cents,
      idempotencyKey: claimed.idempotency_key,
      externalReference: claimed.idempotency_key,
      method: claimed.method === 'CREDIT' ? 'credit' : 'debit',
      installments: 1,
      description: 'Tchê Food',
    });
  } catch (error) {
    const failure = definiteCreateFailure(error);
    if (failure && begun === 1) return ctx.store.rejectFirstSend(claimed, failure);
    // Daqui para baixo o resultado é desconhecido e a cobrança segue "creating":
    //  - recusa definitiva numa repetição, ou conflito de idempotência: o envio anterior pode ter criado a
    //    ordem. Não devolve a posse: a próxima tentativa só depois do prazo dela;
    //  - o Mercado Pago respondeu sem resultado (5xx, resposta ilegível): a chamada acabou, devolve a posse
    //    e a próxima consulta repete com a MESMA chave e o MESMO pedido;
    //  - sem resposta (queda, prazo estourado): o pedido pode ainda estar sendo processado lá. A posse fica
    //    até vencer, para ninguém mandar outro por cima.
    const answered = error instanceof PaymentTerminalProviderError && error.httpStatus !== null;
    const conflict = error instanceof PaymentTerminalProviderError && error.code === 'idempotency_conflict';
    if (answered && !failure && !conflict) await ctx.store.releaseDispatch(claimed).catch(() => undefined);
    return closeUnsent(ctx, await reread(ctx, row));
  }
  // A ordem existe: liga à cobrança já, em qualquer estado não final (uma segunda tentativa cobre falha
  // passageira do banco; se as duas falharem, a posse vence e a repetição com a mesma chave devolve a ordem).
  let current: TerminalChargeRow;
  try {
    current = await ctx.store.attachOrder(claimed, order.externalOrderId);
  } catch {
    try {
      current = await ctx.store.attachOrder(claimed, order.externalOrderId);
    } catch (error) {
      // O banco não gravou a ordem e ela está viva na maquininha, conhecida só aqui. Ordem sem registro não
      // pode ser paga: pede o cancelamento no Mercado Pago. A repetição com a mesma chave devolve esta mesma
      // ordem, cancelada (nada foi cobrado) ou, se o cartão passou antes, paga (aí a cobrança é aprovada).
      await ctx.provider.cancelCharge(order.externalOrderId, { idempotencyKey: `${claimed.idempotency_key}-cancel` }).catch(() => undefined);
      throw error;
    }
  }
  if (FINAL.has(current.status)) {
    if (current.status !== 'approved' && current.external_order_id !== order.externalOrderId) {
      // A cobrança terminou sem esta ordem: ela não pode ficar esperando cartão na maquininha.
      await ctx.provider.cancelCharge(order.externalOrderId, { idempotencyKey: `${claimed.idempotency_key}-cancel` }).catch(() => undefined);
    }
    return current;
  }
  const applied = await applyOrder(ctx, current, order);
  if (applied.cancel_requested_at && !FINAL.has(applied.status) && applied.external_order_id) {
    // Encerramento pedido com a ordem a caminho: pede à maquininha que pare e grava o que o Mercado Pago disser.
    try {
      await ctx.provider.cancelCharge(applied.external_order_id, { idempotencyKey: `${applied.idempotency_key}-cancel` });
    } catch {
      // Não cancelável (já pago) ou erro: a reconsulta diz o que vale.
    }
    return refreshCharge(ctx, applied);
  }
  return applied;
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
    dispatch_lease_until: null,
    dispatch_attempts: 0,
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

/**
 * Prazo de espera do cartão, igual ao do app (POINT_WAIT_MS): encerrar por "timeout", sem gerente, só depois
 * dele, contado pelo relógio do banco desde a hora gravada da cobrança.
 */
export const SERVER_TIMEOUT_MS = 120_000;

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
 * reconsulta devolve a aprovação). Só vira recusa quando o Mercado Pago confirma cancelada/expirada ou
 * quando a ordem comprovadamente nunca saiu daqui. Envio sem resposta (sem ordem conhecida) NUNCA vira
 * recusa: enquanto o envio pode estar a caminho, espera; depois vai para revisão manual e segue segurando
 * o saldo, com ou sem PIN de gerente.
 */
export async function cancelCharge(ctx: ChargeContext, row: TerminalChargeRow, input: CancelInput): Promise<ChargeReply> {
  const req = validateCancel(input);
  if (!matchesRow(row, input)) throw new ChargeInputError('idempotency_conflict', 'O encerramento não confere com a cobrança (conta, valor ou forma).', 409);
  if (FINAL.has(row.status)) return replyFor(row);
  let current: TerminalChargeRow;
  if (req.reason === 'operator') {
    let audit: string | null;
    try {
      audit = await ctx.store.authorizeCancel({ idempotency_key: row.idempotency_key, performed_by: req.staff_id, manager_pin: req.manager_pin, reason: req.reason_text });
    } catch (error) {
      if (error instanceof ChargeRefusedError && error.code === 'not_applicable') {
        // Terminou no meio do pedido: não há o que encerrar (nenhum registro de encerramento foi gravado).
        return replyFor((await ctx.store.findByKey(row.idempotency_key)) ?? row);
      }
      if (error instanceof ChargeRefusedError) throw new ChargeInputError(error.code, error.message, 403);
      throw error;
    }
    if (!audit) throw new ChargeInputError('manager_denied', 'PIN de gerente incorreto ou bloqueado. Nada foi cancelado.', 403);
    current = (await ctx.store.findByKey(row.idempotency_key)) ?? row;
  } else {
    const requested = await ctx.store.requestTimeoutCancel(row, SERVER_TIMEOUT_MS);
    if (!requested) throw new ChargeInputError('too_early', 'A cobrança ainda está no prazo de espera do cartão.', 409);
    current = requested;
  }
  if (FINAL.has(current.status)) return replyFor(current);
  // O pedido de encerramento só conta gravado: sem ele a posse do envio ainda pode ser dada.
  if (!current.cancel_requested_at) return replyFor(current);
  // Sem ordem conhecida: não repete a criação. Nenhum envio saiu = encerra com prova; envio sem resposta =
  // espera a posse vencer e vai para revisão manual, sem liberar o saldo (com ou sem PIN de gerente).
  if (!current.external_order_id) return replyFor(await closeUnsent(ctx, current));
  try {
    await ctx.provider.cancelCharge(current.external_order_id, { idempotencyKey: `${current.idempotency_key}-cancel` });
  } catch {
    // Não cancelável (já pago, já cancelado) ou erro: a reconsulta abaixo diz o que vale.
  }
  return pollCharge(ctx, current);
}

/**
 * Sem cobrança gravada (a criação nunca chegou ou ainda está a caminho) não há o que cancelar nem prazo a
 * conferir. O que existe é o bloqueio preventivo da chave: a partir dele, uma criação atrasada com a mesma
 * chave encontra a cobrança encerrada e não vai à Point. Não é cancelamento voluntário:
 *  - pedido "operator" (com PIN) sem cobrança gravada é recusado: não há cobrança para o gerente encerrar;
 *  - o bloqueio exige operador da equipe ativa da loja (conferido no banco) e fica em audit_logs.
 * Se a criação gravou primeiro, valem as regras normais do encerramento (prazo no servidor ou PIN).
 */
export async function voidCharge(ctx: ChargeContext, terminal: TerminalRecord, input: CreateInput & CancelInput): Promise<ChargeReply> {
  const req = validateCreate(input);
  const cancel = validateCancel(input);
  if (terminal.acquirer !== 'MERCADO_PAGO') throw new ChargeInputError('not_mercado_pago', 'Esta maquininha não é Mercado Pago Point.');
  const existing = await ctx.store.findByKey(req.idempotency_key);
  if (existing) {
    if (!sameRequest(existing, req, terminal)) throw new ChargeInputError('idempotency_conflict', 'Esta chave já foi usada em outra cobrança.', 409);
    return cancelCharge(ctx, existing, input);
  }
  if (cancel.reason === 'operator') {
    throw new ChargeInputError('not_found', 'Cobrança ainda não gravada nesta loja: não há o que encerrar. Nada foi cancelado.', 404);
  }
  if (!req.staff_id) throw new ChargeInputError('invalid_staff', 'Informe quem está bloqueando a cobrança.', 403);
  let row: TerminalChargeRow;
  try {
    row = await ctx.store.insertVoid({
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
      created_by: null,
      dispatched_at: null,
      dispatch_lease_until: null,
      dispatch_attempts: 0,
      cancel_reason: 'void',
      cancel_requested_by: req.staff_id,
      cancel_requested_at: null, // a hora é a do banco, gravada pela função do bloqueio
      cancel_authorized_by: null,
      cancel_audit_id: null,
    });
  } catch (error) {
    if (error instanceof ChargeRefusedError) throw new ChargeInputError(error.code, error.message, 403);
    throw error;
  }
  if (!sameRequest(row, req, terminal)) throw new ChargeInputError('idempotency_conflict', 'Esta chave já foi usada em outra cobrança.', 409);
  if (row.status === 'cancelled' && row.raw_status === 'voided_before_send') return replyFor(row);
  // A criação gravou primeiro: encerramento normal da cobrança que ficou.
  return cancelCharge(ctx, row, input);
}
