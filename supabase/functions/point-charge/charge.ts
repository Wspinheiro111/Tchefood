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
//  - Cobrança nova só para conta aberta no servidor, dentro do saldo e com o saldo que o aparelho mostra
//    igual ao do servidor (RPC tchefood_open_terminal_charge): o operador cobra a conta que o servidor conhece.
//  - Só o pedido de criação (create) pode mandar a ordem pela primeira vez. A consulta (status) só repete,
//    com a mesma chave, um envio que comprovadamente já saiu (dispatched_at gravado), para recuperar a ordem.
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

export type ChargeRefusal = 'order_not_found' | 'order_closed' | 'over_balance' | 'invalid_staff' | 'not_found' | 'invalid_reason' | 'not_applicable' | 'balance_mismatch' | 'key_in_use';

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
   * saldo menos as outras cobranças em andamento, e com o saldo da conta no servidor igual a
   * `expectedBalanceCents` (o que o aparelho mostra). Chave já gravada: devolve a linha que ficou.
   * Lança ChargeRefusedError quando o banco recusa.
   */
  insert(row: NewChargeRow, expectedBalanceCents: number): Promise<TerminalChargeRow>;
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
   * Com `allowFirst` false (consulta), nunca marca o primeiro envio: sem envio anterior devolve 0 sem mudar nada.
   */
  beginDispatch(row: TerminalChargeRow, leaseMs: number, allowFirst: boolean): Promise<0 | 1 | 2>;
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
  /**
   * Confere o PIN de gerente no banco para a conferência no Mercado Pago (tchefood_authorize_point_reconcile), com o
   * mesmo bloqueio por tentativas, e grava UM audit_log. Só pede a conferência: não muda a cobrança. Devolve o id do
   * audit_log, ou null com PIN errado ou bloqueado. Operador fora da equipe, motivo curto ou cobrança que não está em
   * revisão manual nem aprovada: ChargeRefusedError.
   */
  authorizeReconcile(input: { idempotency_key: string; performed_by: string; manager_pin: string; reason: string }): Promise<string | null>;
  /** Há pagamento APPROVED do Mercado Pago gravado com a chave desta cobrança (o aparelho já registrou)? */
  hasRegisteredPayment(idempotencyKey: string): Promise<boolean>;
  /**
   * Fim verificado (tchefood_resolve_point_charge, só service role): grava `toStatus` e `patch` só se a cobrança ainda
   * estiver em `row.status`, com UM audit_log (quem, motivo, o que foi lido no Mercado Pago). Devolve a linha atual:
   * com `toStatus` se gravou, ou como estava se outra chamada passou na frente (nada gravado).
   */
  resolve(row: TerminalChargeRow, toStatus: ChargeStatus, patch: ChargePatch, audit: { staff: string; reason: string; evidence: Record<string, unknown> }): Promise<TerminalChargeRow>;
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
  /** external_reference do pagamento (a chave da cobrança, quando veio da ordem da Point). */
  externalReference?: string | null;
  /** order.id do pagamento, se o Mercado Pago informar. */
  orderId?: string | null;
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
  /** Relógio monotônico local (ms), só para medir quanto a barreira demorou a responder. Padrão: performance.now(). */
  monotonicMs?: () => number;
}

export interface CreateInput {
  idempotency_key: unknown;
  order_id: unknown;
  amount_cents: unknown;
  method: unknown;
  staff_id?: unknown;
  /** Saldo da conta no aparelho, em centavos, depois da sincronização: o servidor confere que é o mesmo. */
  expected_balance_cents?: unknown;
}

export type ChargeReply =
  /**
   * awaiting_send: cobrança gravada de que nenhum envio saiu ainda (a criação parou antes da barreira). A
   * consulta não manda: o aparelho repete o pedido de criação, com a mesma chave, se ainda estiver no prazo.
   */
  | { status: 'PENDING'; idempotency_key: string; detail: string; awaiting_send?: true }
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

/** Conta, chave, valor, forma e operador do pedido (criação e bloqueio da chave). */
export function validateCharge(input: CreateInput): { idempotency_key: string; order_id: string; amount_cents: number; method: PointMethod; staff_id: string | null } {
  const { expected_balance_cents: _b, ...req } = validateCreate({ ...input, expected_balance_cents: 0 });
  return req;
}

/** Pedido de criação: tudo de validateCharge e mais o saldo da conta no aparelho (obrigatório). */
export function validateCreate(input: CreateInput): {
  idempotency_key: string; order_id: string; amount_cents: number; method: PointMethod; staff_id: string | null; expected_balance_cents: number;
} {
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
  // Obrigatório: sem o saldo que o aparelho mostra, o servidor não tem como provar que é a mesma conta.
  const balance = input.expected_balance_cents;
  if (typeof balance !== 'number' || !Number.isSafeInteger(balance) || balance < 0) {
    throw new ChargeInputError('invalid_balance', 'Saldo da conta não informado. Sincronize e tente de novo.');
  }
  return {
    idempotency_key: input.idempotency_key, order_id: input.order_id, amount_cents: cents, method: input.method,
    staff_id: (staff as string | null | undefined) ?? null, expected_balance_cents: balance,
  };
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
      if (row.status === 'creating' && !row.dispatched_at && !row.cancel_requested_at && !row.external_order_id) {
        return { status: 'PENDING', idempotency_key: key, detail: 'Enviando para a maquininha.', awaiting_send: true };
      }
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
 * Tempo máximo entre pedir a barreira e chamar o Mercado Pago. A posse vale 30 s desde a barreira e a
 * chamada dura até 15 s: se a resposta da barreira demorou mais que isto, a chamada poderia passar do fim
 * da posse. Aí não manda.
 */
export const DISPATCH_START_LIMIT_MS = 10_000;

/** raw_status (50) e raw_status_detail (80) têm tamanho fixo no banco: texto maior do Mercado Pago é cortado. */
function clip(value: string | null, max: number): string | null {
  return value !== null && value.length > max ? value.slice(0, max) : value;
}

function monotonic(ctx: ChargeContext): number {
  return ctx.monotonicMs ? ctx.monotonicMs() : performance.now();
}

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
async function sendCreate(ctx: ChargeContext, row: TerminalChargeRow, allowFirst: boolean): Promise<TerminalChargeRow> {
  if (row.status !== 'creating' || row.external_order_id) return row;
  if (row.cancel_requested_at) return closeUnsent(ctx, row);
  // Consulta não inicia cobrança: sem envio anterior gravado, só o pedido de criação manda. A barreira do banco
  // confere de novo (allowFirst false nunca marca o primeiro envio).
  if (!allowFirst && !row.dispatched_at) return row;
  const claimed = await ctx.store.claimDispatch(row, DISPATCH_LEASE_MS);
  // Sem posse: envio em andamento em outra chamada, encerramento pedido, limite de envios ou estado mudou.
  if (!claimed) return closeUnsent(ctx, await reread(ctx, row));
  const asked = monotonic(ctx);
  const begun = await ctx.store.beginDispatch(claimed, DISPATCH_LEASE_MS, allowFirst);
  if (begun === 0) return closeUnsent(ctx, await reread(ctx, row));
  // Nunca acontece com o banco (allowFirst false não marca o primeiro envio); se acontecer, não manda.
  if (begun === 1 && !allowFirst) return closeUnsent(ctx, await reread(ctx, row));
  // A barreira passou, mas a resposta dela demorou demais: a chamada poderia passar do fim da posse (e outra
  // consulta mandaria por cima, ou um encerramento já teria levado a cobrança à revisão manual). Não manda.
  // O envio fica marcado como iniciado, então a cobrança é tratada como resultado desconhecido, nunca recusa.
  // Efeito conhecido (revisão independente, F4): o primeiro POST de verdade pode sair depois de uma consulta
  // (allowFirst false, begun 2) quando a posse vencer. Ele conta como repetição: recusa ali não vira "nada foi
  // cobrado", fica desconhecida e segue para revisão. Lado seguro; o código fica como está.
  if (monotonic(ctx) - asked > DISPATCH_START_LIMIT_MS) return closeUnsent(ctx, await reread(ctx, row));
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
    // Daqui para baixo o resultado é desconhecido e a cobrança segue "creating": recusa definitiva numa
    // repetição, conflito de idempotência, erro 5xx/408/429, resposta ilegível, queda ou prazo estourado. Em
    // todos o pedido (este ou o anterior) pode ter criado a ordem ou ainda estar sendo processado lá. A posse
    // NUNCA é devolvida antes da hora: a próxima tentativa, com a MESMA chave e o MESMO pedido, só depois que
    // ela vencer, para ninguém mandar outro por cima.
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
      console.error('[point-charge] ordem sem registro', claimed.idempotency_key, order.externalOrderId);
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
  if (current.external_order_id !== order.externalOrderId) {
    // A cobrança já tem OUTRA ordem (o Mercado Pago devolveu duas para a mesma chave). Esta não pode ficar
    // esperando cartão sem registro: cancela no Mercado Pago, e a cobrança fica em revisão manual com o
    // número dela anotado. Essa revisão não é desfeita por consulta.
    await ctx.provider.cancelCharge(order.externalOrderId, { idempotencyKey: `${claimed.idempotency_key}-cancel-2` }).catch(() => undefined);
    console.error('[point-charge] segunda ordem para a mesma chave', claimed.idempotency_key, current.external_order_id, order.externalOrderId);
    return ctx.store.update(current, { status: 'manual_review', raw_status: clip(`second_order:${order.externalOrderId}`, 50), raw_status_detail: 'ORDER_ID_CHANGED' });
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

/**
 * Veredito sobre a ordem do Mercado Pago para esta cobrança, sem gravar nada. É a ÚNICA conferência de aprovação:
 * a consulta normal (applyOrder) e a conferência da revisão manual (reconcileCharge) usam esta mesma função.
 *  - status: o Mercado Pago provou este estado (pending/at_terminal/final), com `patch` completo para gravar;
 *  - mismatch: algum dado faltou ou não confere (`code`), com o que foi lido em `patch`;
 *  - payment_unavailable: a ordem diz aprovada, mas o pagamento não pôde ser lido agora.
 * `payment` é o pagamento lido (quando chegou a ler), para quem precisa reconhecer estorno.
 */
type OrderVerdict =
  | { kind: 'status'; status: Exclude<ChargeStatus, 'creating' | 'manual_review'>; patch: ChargePatch; payment: PointPaymentDetails | null }
  | { kind: 'mismatch'; code: string; patch: ChargePatch; payment: PointPaymentDetails | null }
  | { kind: 'payment_unavailable'; patch: ChargePatch };

async function judgeOrder(ctx: ChargeContext, row: TerminalChargeRow, order: PaymentTerminalChargeResult): Promise<OrderVerdict> {
  const base: ChargePatch = {
    external_order_id: order.externalOrderId,
    raw_status: clip(order.rawStatus, 50),
    raw_status_detail: clip(order.rawStatusDetail, 80),
    paid_amount_cents: order.paidAmountCents,
    external_payment_id: order.externalPaymentId,
  };
  const mismatch = (code: string, payment: PointPaymentDetails | null = null): OrderVerdict => ({ kind: 'mismatch', code, patch: { ...base, raw_status_detail: code }, payment });

  // A ordem precisa ser esta cobrança mesmo quando ainda não terminou.
  if (order.externalReference !== null && order.externalReference !== row.idempotency_key) return mismatch('REFERENCE_MISMATCH');
  if (order.externalTerminalId !== null && order.externalTerminalId !== row.external_terminal_id) return mismatch('TERMINAL_MISMATCH');
  if (order.amountCents !== row.amount_cents) return mismatch('AMOUNT_MISMATCH');

  switch (order.status) {
    case 'pending':
    case 'at_terminal':
      return { kind: 'status', status: order.status, patch: base, payment: null };
    case 'rejected':
    case 'cancelled':
    case 'expired':
    case 'refunded':
      // Fim que libera a reserva: como na aprovação, a ordem precisa ecoar a referência e a maquininha desta
      // cobrança (não basta faltarem). Sem isso, revisão.
      if (order.externalReference === null) return mismatch('FINAL_WITHOUT_REFERENCE');
      if (order.externalTerminalId === null) return mismatch('FINAL_WITHOUT_TERMINAL');
      return { kind: 'status', status: order.status, patch: base, payment: null };
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
    return { kind: 'payment_unavailable', patch: base };
  }
  if (payment.id !== order.externalPaymentId) return mismatch('PAYMENT_ID_MISMATCH');
  const approval = checkPayment(row, payment, order.externalOrderId);
  if (approval.kind === 'mismatch') return mismatch(approval.code, payment);
  if (order.paymentMethodId !== null && brandFromMethodId(order.paymentMethodId) !== approval.brand) return mismatch('BRAND_MISMATCH', payment);
  return {
    kind: 'status', status: 'approved', payment,
    patch: { ...base, authorization_code: approval.authorization, card_brand: approval.brand, last_four: approval.lastFour },
  };
}

/**
 * Conferências do pagamento lido (GET /v1/payments/{id}) para aprovar esta cobrança. `orderId` é a ordem do Mercado
 * Pago que está sendo conferida (ou a ligada à cobrança), quando há uma.
 * Auditoria r6 (P2): a referência (external_reference) e a ordem (order.id) que o pagamento informar precisam ser
 * desta cobrança; ausentes, valem as outras conferências como antes.
 */
// Só um id da Orders API (ORD…) se compara com a ordem da cobrança; o order.id do pagamento costuma ser a
// merchant_order (número), que não diz nada sobre esta ordem e conta como ausente.
function isOrdersApiId(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.startsWith('ORD');
}

function checkPayment(row: TerminalChargeRow, payment: PointPaymentDetails, orderId: string | null):
  | { kind: 'ok'; authorization: string; brand: PointCardBrand; lastFour: string | null }
  | { kind: 'mismatch'; code: string } {
  if (payment.externalReference != null && payment.externalReference !== row.idempotency_key) return { kind: 'mismatch', code: 'PAYMENT_REFERENCE_MISMATCH' };
  if (isOrdersApiId(payment.orderId) && orderId != null && payment.orderId !== orderId) return { kind: 'mismatch', code: 'PAYMENT_ORDER_MISMATCH' };
  if (payment.status !== 'approved') return { kind: 'mismatch', code: 'PAYMENT_NOT_APPROVED' };
  if (payment.amountCents !== row.amount_cents) return { kind: 'mismatch', code: 'PAYMENT_AMOUNT_MISMATCH' };
  if (payment.paymentTypeId !== expectedType(row.method)) return { kind: 'mismatch', code: 'PAYMENT_METHOD_MISMATCH' };
  // À vista confirmado pelo próprio pagamento: parcelas ausentes não contam como 1.
  if (payment.installments !== 1) return { kind: 'mismatch', code: 'PAYMENT_INSTALLMENTS_MISMATCH' };
  const authorization = (payment.authorizationCode ?? '').trim();
  if (!/^[A-Za-z0-9]{1,20}$/.test(authorization)) return { kind: 'mismatch', code: 'APPROVED_WITHOUT_AUTHORIZATION' };
  // Bandeira só pelo pagamento (a ordem não basta). Ordem com outra bandeira também vira revisão.
  const brand = brandFromMethodId(payment.paymentMethodId);
  if (!brand) return { kind: 'mismatch', code: 'UNSUPPORTED_BRAND' };
  const lastFour = payment.lastFour && /^\d{4}$/.test(payment.lastFour) ? payment.lastFour : null;
  return { kind: 'ok', authorization, brand, lastFour };
}

async function applyOrder(ctx: ChargeContext, row: TerminalChargeRow, order: PaymentTerminalChargeResult): Promise<TerminalChargeRow> {
  // Auditoria r5 P1-01: revisão manual só sai pela conferência do gerente (reconcileCharge → fim verificado no
  // banco). A consulta, a criação e o encerramento não gravam nada nela, nem uma aprovação que chegou atrasada:
  // devolvem a revisão como está (o gatilho do banco também recusa a saída por UPDATE direto).
  if (row.status === 'manual_review') return row;
  if (row.external_order_id && order.externalOrderId !== row.external_order_id) {
    return ctx.store.update(row, { status: 'manual_review', raw_status: clip(order.rawStatus, 50), raw_status_detail: 'ORDER_ID_CHANGED' });
  }
  const verdict = await judgeOrder(ctx, row, order);
  switch (verdict.kind) {
    case 'mismatch':
      return ctx.store.update(row, { ...verdict.patch, status: 'manual_review' });
    case 'payment_unavailable':
      // Sem a confirmação do pagamento ainda: fica como estava (a próxima consulta tenta de novo).
      return ctx.store.update(row, { ...verdict.patch, status: row.status === 'creating' ? 'pending' : 'at_terminal' });
    case 'status':
      return ctx.store.update(row, { ...verdict.patch, status: verdict.status });
  }
}

/** Cria (ou retoma, com a mesma chave) a cobrança e devolve o estado atual. */
export async function startCharge(ctx: ChargeContext, terminal: TerminalRecord, input: CreateInput): Promise<ChargeReply> {
  const req = validateCreate(input);
  if (terminal.acquirer !== 'MERCADO_PAGO') throw new ChargeInputError('not_mercado_pago', 'Esta maquininha não é Mercado Pago Point.');
  if (!terminal.serial_number.trim()) throw new ChargeInputError('terminal_without_id', 'Maquininha sem o terminal_id do Mercado Pago.');
  const existing = await ctx.store.findByKey(req.idempotency_key);
  if (existing) {
    if (!sameRequest(existing, req, terminal)) throw new ChargeInputError('idempotency_conflict', 'Esta chave já foi usada em outra cobrança.', 409);
    // Repetição do pedido de criação (resposta anterior perdida): este pode mandar o primeiro envio.
    return replyFor(await resume(ctx, existing, true));
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
  // Cobrança antiga largada pelo aparelho (app fechado no meio, pedido de encerramento que não chegou): passado
  // o prazo de espera do cartão pelo relógio do banco, o servidor mesmo a encerra, com as regras de sempre
  // (cancelada só com a confirmação do Mercado Pago; envio sem resposta vai para revisão manual e segue
  // reservando).
  for (const other of await ctx.store.listOpenForOrder(req.order_id)) {
    if (other.idempotency_key !== req.idempotency_key) await settleSibling(ctx, other).catch(() => undefined);
  }
  let inserted: TerminalChargeRow;
  try {
    inserted = await ctx.store.insert(fresh, req.expected_balance_cents);
  } catch (error) {
    if (error instanceof ChargeRefusedError) throw new ChargeInputError(error.code, error.message, 409);
    throw error;
  }
  // Corrida: outro envio com a mesma chave gravou primeiro.
  if (!sameRequest(inserted, req, terminal)) throw new ChargeInputError('idempotency_conflict', 'Esta chave já foi usada em outra cobrança.', 409);
  return replyFor(await resume(ctx, inserted, true));
}

async function settleSibling(ctx: ChargeContext, row: TerminalChargeRow): Promise<void> {
  if (FINAL.has(row.status)) return;
  const current = row.cancel_requested_at ? row : await ctx.store.requestTimeoutCancel(row, SERVER_TIMEOUT_MS);
  if (!current || FINAL.has(current.status) || !current.cancel_requested_at) {
    await refreshCharge(ctx, current ?? row); // ainda no prazo: só reconsulta
    return;
  }
  if (!current.external_order_id) {
    await closeUnsent(ctx, current);
    return;
  }
  await ctx.provider.cancelCharge(current.external_order_id, { idempotencyKey: `${current.idempotency_key}-cancel` }).catch(() => undefined);
  await refreshCharge(ctx, current);
}

/**
 * Consulta (action status): reconsulta a cobrança no Mercado Pago (estado final gravado não é reconsultado).
 * Nunca inicia a cobrança: sem ordem ligada, só repete um envio que já saiu (para recuperar a ordem).
 */
export async function pollCharge(ctx: ChargeContext, row: TerminalChargeRow): Promise<ChargeReply> {
  return replyFor(await resume(ctx, row, false));
}

/** Segue a cobrança gravada. `allowFirst`: só o pedido de criação pode mandar a ordem pela primeira vez. */
async function resume(ctx: ChargeContext, row: TerminalChargeRow, allowFirst: boolean): Promise<TerminalChargeRow> {
  if (FINAL.has(row.status)) return row;
  if (!row.external_order_id) return sendCreate(ctx, row, allowFirst);
  return refreshCharge(ctx, row);
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
  // O encerramento não manda o saldo da conta (não abre cobrança): só a conta, a chave, o valor e a forma.
  const req = validateCharge(input);
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
    if (error instanceof ChargeRefusedError) throw new ChargeInputError(error.code, error.message, error.code === 'key_in_use' ? 409 : 403);
    throw error;
  }
  if (!sameRequest(row, req, terminal)) throw new ChargeInputError('idempotency_conflict', 'Esta chave já foi usada em outra cobrança.', 409);
  if (row.status === 'cancelled' && row.raw_status === 'voided_before_send') return replyFor(row);
  // A criação gravou primeiro: encerramento normal da cobrança que ficou.
  return cancelCharge(ctx, row, input);
}

// -----------------------------------------------------------------------------------------------------------------
// Conferência no Mercado Pago (action reconcile, auditoria r5 P1-01)
// -----------------------------------------------------------------------------------------------------------------
// Cobrança em revisão manual, ou aprovada sem pagamento registrado, segura o saldo da conta. Ela só sai disso com a
// leitura do Mercado Pago feita AQUI: o PIN de gerente e o motivo só pedem a conferência (e ficam registrados), nunca
// liberam sozinhos, e nada é liberado por tempo. Leitura inconclusiva ou erro: continua como está.
//  - revisão manual com ordem: a ordem e o pagamento passam pelas MESMAS conferências da consulta normal (judgeOrder);
//  - revisão manual sem ordem (envio sem resposta): procura a ordem pela referência; achou uma só, liga e segue como
//    acima. Não achou: só com o ID da operação digitado, e só se o pagamento lido for desta cobrança e aprovado;
//  - aprovada sem pagamento registrado: estorno só com o Mercado Pago mostrando estorno/cancelamento; continua aprovada
//    = devolve a aprovação para o aparelho registrar o pagamento (sem cobrar de novo).

export interface ReconcileInput {
  idempotency_key: unknown;
  staff_id?: unknown;
  manager_pin?: unknown;
  reason_text?: unknown;
  /** ID da operação do comprovante / app do Mercado Pago (= ID do pagamento). Só dígitos. */
  operation_id?: unknown;
}

export interface ReconcileRequest {
  idempotency_key: string;
  staff_id: string;
  manager_pin: string;
  reason_text: string;
  operation_id: string | null;
}

/** Motivo mínimo da conferência (o banco confere de novo). */
export const RECONCILE_REASON_MIN = 10;

export function validateReconcile(input: ReconcileInput): ReconcileRequest {
  if (!validKey(input.idempotency_key)) throw new ChargeInputError('invalid_key', 'Chave da cobrança inválida.');
  if (typeof input.staff_id !== 'string' || !UUID.test(input.staff_id)) throw new ChargeInputError('invalid_staff', 'Informe quem está conferindo a cobrança.');
  if (typeof input.manager_pin !== 'string' || !/^\d{4,8}$/.test(input.manager_pin)) throw new ChargeInputError('manager_required', 'Conferir a cobrança exige o PIN do gerente.', 403);
  if (typeof input.reason_text !== 'string' || input.reason_text.trim().length < RECONCILE_REASON_MIN) {
    throw new ChargeInputError('invalid_reason', `Informe o motivo (mínimo ${RECONCILE_REASON_MIN} caracteres).`);
  }
  let operation: string | null = null;
  if (input.operation_id !== undefined && input.operation_id !== null && input.operation_id !== '') {
    if (typeof input.operation_id !== 'string' || !/^\d{1,20}$/.test(input.operation_id.trim())) {
      throw new ChargeInputError('invalid_operation', 'ID da operação inválido (só números).');
    }
    operation = input.operation_id.trim();
  }
  return { idempotency_key: input.idempotency_key, staff_id: input.staff_id, manager_pin: input.manager_pin, reason_text: input.reason_text.trim(), operation_id: operation };
}

/** Status do pagamento do Mercado Pago que provam que o dinheiro voltou (ou nunca ficou). */
const REFUND_PAYMENT_STATUSES: ReadonlySet<string> = new Set(['refunded', 'charged_back', 'cancelled']);

type ReconcileAuth = { staff: string; reason: string; audit_id: string; operation_id: string | null };

function stillInReview(row: TerminalChargeRow, code: string, reason: string): ChargeReply {
  return { status: 'MANUAL_REVIEW', idempotency_key: row.idempotency_key, code, reason };
}

const REVIEW_TEXT = {
  NOT_FOUND_YET: 'O Mercado Pago ainda não mostra cobrança com esta referência. Confira no app do Mercado Pago: se houver a operação, digite o ID dela; se não houver, tente de novo mais tarde. O valor segue reservado na conta.',
  MP_SEARCH_REFUSED: 'O Mercado Pago recusou a busca por esta cobrança; use o número da operação. Confira no app do Mercado Pago e digite o ID dela. O valor segue reservado na conta.',
  MP_UNAVAILABLE: 'Não foi possível ler o Mercado Pago agora. Tente de novo em instantes. Nada foi liberado e o valor segue reservado na conta.',
  MP_PENDING: 'A cobrança ainda está aberta no Mercado Pago (não terminou). Finalize ou cancele na maquininha e confira de novo. O valor segue reservado na conta.',
} as const;

function mismatchReview(row: TerminalChargeRow, detail: string): ChargeReply {
  return stillInReview(row, 'MISMATCH', `Os dados do Mercado Pago não conferem com esta cobrança (${detail}). Confira no app do Mercado Pago. Nada foi liberado e o valor segue reservado na conta.`);
}

function verdictReview(row: TerminalChargeRow, code: string): ChargeReply {
  return stillInReview(row, code, `O Mercado Pago não confirmou a cobrança por completo (${code}). Confira no app do Mercado Pago. Nada foi liberado e o valor segue reservado na conta.`);
}

/** Resposta da conferência: estorno confirmado libera (DECLINED); o resto é a resposta de sempre. */
function reconcileReply(row: TerminalChargeRow): ChargeReply {
  if (row.status === 'refunded') {
    return { status: 'DECLINED', idempotency_key: row.idempotency_key, reason: 'O Mercado Pago confirmou o estorno: nada fica cobrado nesta cobrança.' };
  }
  return replyFor(row);
}

/** Revisão manual, ou aprovada sem pagamento do Mercado Pago registrado com a chave. */
async function reconcilable(ctx: ChargeContext, row: TerminalChargeRow): Promise<boolean> {
  if (row.status === 'manual_review') return true;
  if (row.status === 'approved') return !(await ctx.store.hasRegisteredPayment(row.idempotency_key));
  return false;
}

function notApplicable(): ChargeInputError {
  return new ChargeInputError('not_applicable', 'Esta cobrança não está em revisão manual nem aprovada sem pagamento registrado: não há o que conferir.', 409);
}

/**
 * Campos que o fim verificado aceita (tchefood_resolve_point_charge; outro campo é TF006): saindo da revisão manual,
 * só o que o Mercado Pago informa (nunca estado nem ordem); no estorno da aprovada, só raw_status e raw_status_detail
 * (o comprovante fica).
 */
const RESOLVE_FIELDS_FROM_REVIEW = ['external_payment_id', 'raw_status', 'raw_status_detail', 'paid_amount_cents', 'card_brand', 'authorization_code', 'last_four'] as const;
const RESOLVE_FIELDS_FROM_APPROVED = ['raw_status', 'raw_status_detail'] as const;

function resolvePatch(row: TerminalChargeRow, patch: ChargePatch): ChargePatch {
  const fields: readonly (keyof ChargePatch)[] = row.status === 'approved' ? RESOLVE_FIELDS_FROM_APPROVED : RESOLVE_FIELDS_FROM_REVIEW;
  const out: Record<string, unknown> = {};
  for (const f of fields) if (patch[f] !== undefined) out[f] = patch[f];
  return out as ChargePatch;
}

async function resolveTo(ctx: ChargeContext, row: TerminalChargeRow, to: ChargeStatus, patch: ChargePatch, auth: ReconcileAuth, evidence: Record<string, unknown>): Promise<ChargeReply> {
  let current: TerminalChargeRow;
  try {
    current = await ctx.store.resolve(row, to, resolvePatch(row, patch), {
      staff: auth.staff,
      reason: auth.reason,
      evidence: { ...evidence, authorization_audit_id: auth.audit_id, operation_id: auth.operation_id },
    });
  } catch (error) {
    // TF007: já virou pagamento, ou esta autorização de gerente já foi usada. Nada foi gravado.
    if (error instanceof ChargeRefusedError && error.code === 'not_applicable') throw notApplicable();
    if (error instanceof ChargeRefusedError && error.code === 'invalid_staff') throw new ChargeInputError(error.code, error.message, 403);
    throw error;
  }
  // Outra chamada passou na frente: vale o que está gravado (nada foi gravado por esta).
  return reconcileReply(current);
}

/**
 * Pagamento desta cobrança (ID já conhecido) mostra o dinheiro devolvido? Só com o pagamento lido agora, com o mesmo
 * ID, o mesmo valor e, se informada, a mesma referência.
 */
function provesRefund(row: TerminalChargeRow, payment: PointPaymentDetails | null, paymentId: string | null): boolean {
  if (!payment || !paymentId || payment.id !== paymentId) return false;
  if (payment.amountCents !== row.amount_cents) return false;
  if (payment.externalReference != null && payment.externalReference !== row.idempotency_key) return false;
  if (isOrdersApiId(payment.orderId) && row.external_order_id != null && payment.orderId !== row.external_order_id) return false;
  return payment.status !== null && REFUND_PAYMENT_STATUSES.has(payment.status);
}

function orderEvidence(order: PaymentTerminalChargeResult, payment: PointPaymentDetails | null, foundBy: string): Record<string, unknown> {
  return {
    source: 'mercado_pago_order', found_by: foundBy, external_order_id: order.externalOrderId, order_status: order.rawStatus, order_status_detail: order.rawStatusDetail,
    external_reference: order.externalReference, external_terminal_id: order.externalTerminalId, amount_cents: order.amountCents, paid_amount_cents: order.paidAmountCents,
    external_payment_id: order.externalPaymentId, payment_status: payment?.status ?? null, payment_amount_cents: payment?.amountCents ?? null,
  };
}

function paymentEvidence(payment: PointPaymentDetails, foundBy: string): Record<string, unknown> {
  return {
    source: 'mercado_pago_payment', found_by: foundBy, external_payment_id: payment.id, payment_status: payment.status, payment_amount_cents: payment.amountCents,
    payment_type_id: payment.paymentTypeId, external_reference: payment.externalReference ?? null, payment_order_id: payment.orderId ?? null,
  };
}

async function readPayment(ctx: ChargeContext, id: string): Promise<PointPaymentDetails | null> {
  try {
    return await ctx.payments.getPayment(id);
  } catch {
    return null;
  }
}

/**
 * Conferência pedida pelo gerente (PIN e motivo conferidos no banco). Ver o bloco acima. Erros de entrada e de
 * aplicabilidade são ChargeInputError (400/403/404/409); o resultado é sempre o ChargeReply de sempre.
 */
export async function reconcileCharge(ctx: ChargeContext, input: ReconcileInput): Promise<ChargeReply> {
  const req = validateReconcile(input);
  const row = await ctx.store.findByKey(req.idempotency_key);
  if (!row) throw new ChargeInputError('not_found', 'Cobrança não encontrada nesta loja.', 404);
  // Antes do PIN: cobrança que não tem o que conferir não gasta tentativa de PIN nem grava registro.
  if (!(await reconcilable(ctx, row))) throw notApplicable();
  let audit: string | null;
  try {
    audit = await ctx.store.authorizeReconcile({ idempotency_key: row.idempotency_key, performed_by: req.staff_id, manager_pin: req.manager_pin, reason: req.reason_text });
  } catch (error) {
    if (error instanceof ChargeRefusedError) {
      if (error.code === 'not_applicable') throw notApplicable();
      if (error.code === 'not_found') throw new ChargeInputError('not_found', error.message, 404);
      if (error.code === 'invalid_reason') throw new ChargeInputError('invalid_reason', error.message, 400);
      throw new ChargeInputError(error.code, error.message, 403);
    }
    throw error;
  }
  if (!audit) throw new ChargeInputError('manager_denied', 'PIN de gerente incorreto ou bloqueado. Nada foi conferido nem liberado.', 403);
  const auth: ReconcileAuth = { staff: req.staff_id, reason: req.reason_text, audit_id: audit, operation_id: req.operation_id };
  // Relê depois do PIN: uma consulta pode ter terminado a cobrança no meio.
  const current = (await ctx.store.findByKey(row.idempotency_key)) ?? row;
  if (current.status === 'manual_review') return reconcileReview(ctx, current, auth);
  if (current.status === 'approved') {
    if (await ctx.store.hasRegisteredPayment(current.idempotency_key)) throw notApplicable();
    return reconcileApproved(ctx, current, auth);
  }
  return replyFor(current);
}

async function reconcileReview(ctx: ChargeContext, row: TerminalChargeRow, auth: ReconcileAuth): Promise<ChargeReply> {
  // Duas ordens para a mesma chave: a outra pode ter sido paga. Nenhuma leitura de uma só ordem prova o desfecho.
  if (row.raw_status_detail === 'ORDER_ID_CHANGED') {
    return stillInReview(row, 'ORDER_ID_CHANGED', 'O Mercado Pago devolveu duas ordens para esta cobrança. Confira as duas no app do Mercado Pago. Nada foi liberado e o valor segue reservado na conta.');
  }
  let current = row;
  let foundBy = 'charge';
  if (!current.external_order_id) {
    let found: PaymentTerminalChargeResult | null;
    try {
      found = ctx.provider.findChargeByReference ? await ctx.provider.findChargeByReference(current.idempotency_key, { createdAt: current.created_at }) : null;
    } catch (error) {
      if (error instanceof PaymentTerminalProviderError && error.detail === 'multiple_orders') return mismatchReview(current, 'mais de uma ordem com esta referência');
      if (error instanceof PaymentTerminalProviderError && error.detail === 'search_refused') {
        // Busca recusada (400) não diz que a ordem não existe: com o número da operação, confere pelo pagamento.
        if (auth.operation_id) return reconcileByOperation(ctx, current, auth);
        return stillInReview(current, 'MP_SEARCH_REFUSED', REVIEW_TEXT.MP_SEARCH_REFUSED);
      }
      return stillInReview(current, 'MP_UNAVAILABLE', REVIEW_TEXT.MP_UNAVAILABLE);
    }
    if (!found) {
      if (!auth.operation_id) return stillInReview(current, 'NOT_FOUND_YET', REVIEW_TEXT.NOT_FOUND_YET);
      return reconcileByOperation(ctx, current, auth);
    }
    if (found.externalReference !== current.idempotency_key) return mismatchReview(current, 'referência da ordem');
    current = await ctx.store.attachOrder(current, found.externalOrderId);
    if (current.status !== 'manual_review') return reconcileReply(current);
    if (current.external_order_id !== found.externalOrderId) return mismatchReview(current, 'outra ordem já ligada à cobrança');
    foundBy = 'search';
  }
  const orderId = current.external_order_id!;
  let order: PaymentTerminalChargeResult;
  try {
    order = await ctx.provider.getCharge(orderId);
  } catch {
    return stillInReview(current, 'MP_UNAVAILABLE', REVIEW_TEXT.MP_UNAVAILABLE);
  }
  if (order.externalOrderId !== orderId) return mismatchReview(current, 'ID da ordem');
  const verdict = await judgeOrder(ctx, current, order);
  switch (verdict.kind) {
    case 'payment_unavailable':
      return stillInReview(current, 'MP_UNAVAILABLE', REVIEW_TEXT.MP_UNAVAILABLE);
    case 'mismatch':
      // Pago e devolvido: só com o próprio pagamento da ordem mostrando o estorno.
      if (verdict.code === 'PAYMENT_NOT_APPROVED' && provesRefund(current, verdict.payment, order.externalPaymentId)) {
        return resolveTo(ctx, current, 'refunded', { raw_status: clip(`payment_${verdict.payment!.status}`, 50), raw_status_detail: 'PAYMENT_REFUNDED' }, auth, orderEvidence(order, verdict.payment, foundBy));
      }
      return verdictReview(current, verdict.code);
    case 'status':
      if (verdict.status === 'pending' || verdict.status === 'at_terminal') return stillInReview(current, 'MP_PENDING', REVIEW_TEXT.MP_PENDING);
      if (verdict.status === 'refunded') {
        // Estorno da ordem tira a cobrança da revisão só com o próprio pagamento da ordem mostrando o dinheiro devolvido.
        if (!order.externalPaymentId) return verdictReview(current, 'REFUND_WITHOUT_PAYMENT');
        const payment = await readPayment(ctx, order.externalPaymentId);
        if (!payment) return stillInReview(current, 'MP_UNAVAILABLE', REVIEW_TEXT.MP_UNAVAILABLE);
        if (!provesRefund(current, payment, order.externalPaymentId)) return verdictReview(current, 'REFUND_NOT_PROVEN');
        return resolveTo(ctx, current, 'refunded', verdict.patch, auth, orderEvidence(order, payment, foundBy));
      }
      return resolveTo(ctx, current, verdict.status, verdict.patch, auth, orderEvidence(order, verdict.payment, foundBy));
  }
}

/**
 * Revisão manual sem ordem achada: o gerente digitou o ID da operação. Só aprova com o pagamento lido agora sendo
 * desta cobrança (referência = chave) e passando nas mesmas conferências do pagamento da aprovação normal. Pagamento
 * recusado/estornado aqui não libera nada: sem a ordem, outro pagamento da mesma cobrança não pode ser descartado.
 */
async function reconcileByOperation(ctx: ChargeContext, row: TerminalChargeRow, auth: ReconcileAuth): Promise<ChargeReply> {
  const operation = auth.operation_id!;
  let payment: PointPaymentDetails;
  try {
    payment = await ctx.payments.getPayment(operation);
  } catch {
    return stillInReview(row, 'MP_UNAVAILABLE', REVIEW_TEXT.MP_UNAVAILABLE);
  }
  if (payment.id !== operation) return mismatchReview(row, 'ID da operação');
  if (payment.externalReference !== row.idempotency_key) return mismatchReview(row, 'a operação é de outra cobrança');
  const check = checkPayment(row, payment, row.external_order_id);
  if (check.kind === 'mismatch') return mismatchReview(row, check.code);
  return resolveTo(ctx, row, 'approved', {
    external_payment_id: payment.id,
    paid_amount_cents: payment.amountCents,
    authorization_code: check.authorization,
    card_brand: check.brand,
    last_four: check.lastFour,
    raw_status: 'payment_approved',
    raw_status_detail: 'OPERATION_ID_CONFIRMED',
  }, auth, paymentEvidence(payment, 'operation_id'));
}

/** Aprovada sem pagamento registrado: estorno só com o Mercado Pago mostrando; continua aprovada = devolve a aprovação. */
async function reconcileApproved(ctx: ChargeContext, row: TerminalChargeRow, auth: ReconcileAuth): Promise<ChargeReply> {
  const refund = async (payment: PointPaymentDetails | null, order: PaymentTerminalChargeResult | null): Promise<ChargeReply> => {
    // O banco confere de novo (approved → refunded só sem pagamento APPROVED do Mercado Pago com a chave).
    if (await ctx.store.hasRegisteredPayment(row.idempotency_key)) throw notApplicable();
    const status = order?.status === 'refunded' ? order.rawStatus : payment ? `payment_${payment.status}` : null;
    const evidence = order ? orderEvidence(order, payment, 'charge') : paymentEvidence(payment!, 'charge');
    return resolveTo(ctx, row, 'refunded', { raw_status: clip(status, 50), raw_status_detail: order?.status === 'refunded' ? 'ORDER_REFUNDED' : 'PAYMENT_REFUNDED' }, auth, evidence);
  };

  if (!row.external_order_id) {
    // Aprovada pelo ID da operação: só o pagamento existe.
    if (!row.external_payment_id) return mismatchReview(row, 'aprovação sem ID do pagamento');
    const payment = await readPayment(ctx, row.external_payment_id);
    if (!payment) return stillInReview(row, 'MP_UNAVAILABLE', REVIEW_TEXT.MP_UNAVAILABLE);
    if (provesRefund(row, payment, row.external_payment_id)) return refund(payment, null);
    if (payment.id === row.external_payment_id && checkPayment(row, payment, row.external_order_id).kind === 'ok' && payment.externalReference === row.idempotency_key) return replyFor(row);
    return mismatchReview(row, 'pagamento');
  }

  let order: PaymentTerminalChargeResult;
  try {
    order = await ctx.provider.getCharge(row.external_order_id);
  } catch {
    return stillInReview(row, 'MP_UNAVAILABLE', REVIEW_TEXT.MP_UNAVAILABLE);
  }
  if (order.externalOrderId !== row.external_order_id) return mismatchReview(row, 'ID da ordem');
  const verdict = await judgeOrder(ctx, row, order);
  if (verdict.kind === 'payment_unavailable') return stillInReview(row, 'MP_UNAVAILABLE', REVIEW_TEXT.MP_UNAVAILABLE);
  if (verdict.kind === 'status' && verdict.status === 'approved') {
    // Continua aprovada no Mercado Pago, com o mesmo pagamento: o aparelho registra (sem cobrar de novo).
    if (verdict.patch.external_payment_id !== row.external_payment_id) return mismatchReview(row, 'ID do pagamento');
    return replyFor(row);
  }
  // Estorno da ordem: a referência precisa vir ecoada (não basta faltar).
  if (verdict.kind === 'status' && verdict.status === 'refunded' && order.externalReference === row.idempotency_key) return refund(null, order);
  // Ordem em qualquer outro estado: só o próprio pagamento desta aprovação mostrando o estorno prova algo.
  const payment = verdict.kind === 'mismatch' && verdict.payment ? verdict.payment : row.external_payment_id ? await readPayment(ctx, row.external_payment_id) : null;
  if (provesRefund(row, payment, row.external_payment_id)) return refund(payment, order);
  if (!payment && row.external_payment_id && verdict.kind !== 'mismatch') return stillInReview(row, 'MP_UNAVAILABLE', REVIEW_TEXT.MP_UNAVAILABLE);
  return mismatchReview(row, verdict.kind === 'mismatch' ? verdict.code : `ordem ${order.rawStatus ?? 'sem status'}`);
}
