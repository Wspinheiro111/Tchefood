import { describe, expect, it } from 'vitest';
import { PaymentTerminalProviderError, type PaymentTerminalChargeRequest, type PaymentTerminalChargeResult, type PaymentTerminalProvider } from '../../../server/shared/paymentTerminal.ts';
import {
  ChargeInputError,
  ChargeRefusedError,
  brandFromMethodId,
  voidCharge,
  cancelCharge,
  DISPATCH_START_LIMIT_MS,
  pollCharge,
  reconcileCharge,
  refundCharge,
  startCharge,
  validKey,
  validateCancel,
  type ChargeStatus,
  type ChargeContext,
  type ChargePatch,
  type ChargeStore,
  type NewChargeRow,
  type PointPaymentDetails,
  type TerminalChargeRow,
  type TerminalRecord,
} from '../point-charge/charge.ts';
import { amountToCents, createMercadoPagoPayments, parsePayment } from '../point-charge/mpPayments.ts';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ORDER = '22222222-2222-4222-8222-222222222222';
const TERMINAL_UUID = '33333333-3333-4333-8333-333333333333';
const STAFF = '44444444-4444-4444-8444-444444444444';
const MP_TERMINAL = 'NEWLAND_N950__N950NCB801293324';
const KEY = '55555555-5555-4555-8555-555555555555';

const terminal: TerminalRecord = { id: TERMINAL_UUID, tenant_id: TENANT, serial_number: MP_TERMINAL, acquirer: 'MERCADO_PAGO' };

const FINAL_STATES = new Set(['approved', 'rejected', 'cancelled', 'expired', 'refunded']);

const MANAGER_PIN = '9999';
const MANAGER_ID = '66666666-6666-4666-8666-666666666666';

type StoreMethod = 'findByKey' | 'claimDispatch' | 'beginDispatch' | 'attachOrder' | 'rejectFirstSend' | 'voidUndispatched' | 'settleDispatch' | 'requestTimeoutCancel' | 'update';

/**
 * Mesmo contrato do banco (db/schema_mercado_pago.sql): cópias (como o PostgREST), gravação só se o estado
 * lido não mudou, as mesmas condições das funções de posse/barreira/revisão/prazo e as recusas do gatilho
 * (aqui viram exceção, como no banco). `nowMs` é o relógio do banco.
 */
class MemoryStore implements ChargeStore {
  rows: TerminalChargeRow[] = [];
  refuse: ChargeRefusedError | null = null;
  /** Saldo da conta (como tchefood_open_terminal_charge): cobranças não finais da conta reservam. null = sem conferência. */
  balanceCents: number | null = null;
  /** Saldo da conta no servidor (tchefood_open_terminal_charge confere que é o que o aparelho mandou). null = sem conferência. */
  accountBalanceCents: number | null = null;
  /** Saldos que o aparelho mandou em cada insert. */
  expectedBalances: number[] = [];
  audits: { key: string; action: string; performed_by: string; reason: string }[] = [];
  /** Idade das cobranças novas (o encerramento por prazo confere a hora gravada contra `nowMs`). */
  createdAgoMs = 10 * 60_000;
  /** Relógio do "banco" (os testes adiantam). */
  nowMs = Date.now();
  /** Chamado logo depois de dar a posse (o que acontece entre a posse e a barreira). */
  afterClaim: ((row: TerminalChargeRow) => void | Promise<void>) | null = null;
  /** Chamado logo depois da barreira passar (o que acontece entre a barreira e a chamada ao Mercado Pago). */
  afterBegin: ((row: TerminalChargeRow, kind: 1 | 2) => void | Promise<void>) | null = null;
  /** Quantas vezes cada método foi chamado. */
  count: Partial<Record<StoreMethod | 'insertVoid' | 'insert' | 'authorizeCancel' | 'authorizeReconcile' | 'resolve' | 'refundPayment', number>> = {};
  /** Chaves com pagamento APPROVED do Mercado Pago registrado (tabela payments). */
  registeredPayments = new Set<string>();
  /** Fins verificados gravados (tchefood_resolve_point_charge). */
  resolutions: { key: string; from: ChargeStatus; to: ChargeStatus; patch: ChargePatch; staff: string; reason: string; evidence: Record<string, unknown> }[] = [];
  private failures: Partial<Record<StoreMethod, number>> = {};
  /** Faz a próxima chamada (ou as próximas `times`) do método falhar, como uma queda do banco. */
  failOnce(method: StoreMethod, times = 1) {
    this.failures[method] = times;
  }
  /** Estornos gravados (tchefood_refund_point_payment) e as chaves cujo pagamento virou REFUNDED. */
  refunds: { key: string; patch: ChargePatch; staff: string; reason: string; evidence: Record<string, unknown> }[] = [];
  refundedPayments = new Set<string>();
  /** NSU e valor (centavos) do pagamento registrado com a chave, quando diferem da cobrança (padrão: os da cobrança). */
  registeredPaymentData = new Map<string, { nsu: string | null; amountCents: number }>();
  /** Registro de cada estorno gravado, pelo id da cobrança (o audit_log POINT_PAYMENT_REFUNDED). */
  refundRecords = new Map<string, { refund_audit_id: string; authorization_audit_id: string | null; manager_id: string | null; order_reopened: boolean | null }>();
  /** A conta da cobrança está fechada (o estorno a reabre). */
  orderClosed = false;
  async refundRecord(row: TerminalChargeRow) {
    return this.refundRecords.get(row.id) ?? null;
  }
  /** Recusa que o próximo refundPayment devolve (como o banco), antes de qualquer conferência. */
  refundRefusal: ChargeRefusedError | null = null;
  private enter(method: StoreMethod | 'insertVoid' | 'insert' | 'authorizeCancel' | 'authorizeReconcile' | 'resolve' | 'refundPayment') {
    this.count[method] = (this.count[method] ?? 0) + 1;
    const left = this.failures[method as StoreMethod] ?? 0;
    if (left > 0) {
      this.failures[method as StoreMethod] = left - 1;
      throw new Error(`banco fora do ar (${method})`);
    }
  }
  private iso(ms = this.nowMs) {
    return new Date(ms).toISOString();
  }
  private add(row: NewChargeRow): TerminalChargeRow {
    const r = { ...row, id: `row-${this.rows.length + 1}`, created_at: this.iso(this.nowMs - this.createdAgoMs) };
    this.rows.push(r);
    return { ...r };
  }
  private get(id: string) {
    return this.rows.find((x) => x.id === id)!;
  }
  private leased(r: TerminalChargeRow) {
    return r.dispatch_lease_until !== null && Date.parse(r.dispatch_lease_until) > this.nowMs;
  }
  /** Gatilho tchefood_terminal_charge_guard: grava `next` por cima de `r` ou lança, como o banco. */
  write(r: TerminalChargeRow, patch: Partial<TerminalChargeRow>) {
    const next = { ...r, ...patch };
    const raise = (m: string) => {
      throw new Error(`TCHEFOOD_COBRANCA: ${m}`);
    };
    if (FINAL_STATES.has(r.status)) raise('a cobrança já terminou e não muda mais.');
    // r5: revisão manual só sai pelo fim verificado (resolve), nunca por UPDATE direto.
    if (r.status === 'manual_review' && next.status !== 'manual_review') raise('está em revisão manual e só sai dela com a confirmação do Mercado Pago lida pelo servidor.');
    if (next.created_at !== r.created_at) raise('a hora da cobrança não muda.');
    if (r.dispatched_at !== null && next.dispatched_at !== r.dispatched_at) raise('a cobrança já foi mandada ao Mercado Pago.');
    if (r.cancel_requested_at !== null) {
      if (next.cancel_requested_at === null || next.cancel_reason === null) raise('o encerramento já foi registrado.');
      const upgrade = r.cancel_reason === 'timeout' && next.cancel_reason === 'operator';
      if (!upgrade && (next.cancel_requested_at !== r.cancel_requested_at || next.cancel_reason !== r.cancel_reason || next.cancel_requested_by !== r.cancel_requested_by
        || next.cancel_authorized_by !== r.cancel_authorized_by || next.cancel_audit_id !== r.cancel_audit_id)) raise('o encerramento já foi registrado.');
      if (r.dispatched_at === null && next.dispatched_at !== null) raise('foi encerrada antes de ir à maquininha.');
      const grew = next.dispatch_lease_until !== null && (r.dispatch_lease_until === null || Date.parse(next.dispatch_lease_until) > Date.parse(r.dispatch_lease_until));
      if (next.dispatch_attempts > r.dispatch_attempts || grew) raise('tem encerramento pedido e não é mais enviada.');
    }
    if (next.dispatch_attempts < r.dispatch_attempts) raise('a contagem de envios não volta.');
    // VARCHAR(50) e VARCHAR(80): o banco recusa texto maior.
    if ((next.raw_status ?? '').length > 50 || (next.raw_status_detail ?? '').length > 80) raise('value too long for type character varying');
    if (r.external_order_id !== null && next.external_order_id !== r.external_order_id) raise('já tem ordem no Mercado Pago.');
    if (next.cancel_reason === 'operator' && (!next.cancel_authorized_by || !next.cancel_audit_id || !next.cancel_requested_by)) raise('encerramento pelo operador sem autorização de gerente.');
    if (next.status === 'approved' && (!next.external_payment_id || !next.authorization_code || !next.card_brand || next.paid_amount_cents !== next.amount_cents)) raise('aprovação sem comprovante completo.');
    Object.assign(r, patch);
  }
  async findByKey(k: string) {
    this.enter('findByKey');
    const r = this.rows.find((x) => x.idempotency_key === k);
    return r ? { ...r } : null;
  }
  async insert(row: NewChargeRow, expectedBalanceCents: number) {
    this.enter('insert');
    this.expectedBalances.push(expectedBalanceCents);
    const existing = this.rows.find((x) => x.idempotency_key === row.idempotency_key);
    if (existing) return { ...existing };
    if (this.refuse) throw this.refuse;
    if (this.accountBalanceCents !== null && expectedBalanceCents !== this.accountBalanceCents) {
      throw new ChargeRefusedError('balance_mismatch', 'o saldo desta conta na nuvem é outro.');
    }
    if (this.balanceCents !== null) {
      // Como no banco: reservam as não finais e as aprovadas (aqui não há tabela de pagamentos gravados).
      const reserved = this.rows.filter((x) => x.order_id === row.order_id && (x.status === 'approved' || !FINAL_STATES.has(x.status))).reduce((sum, x) => sum + x.amount_cents, 0);
      if (reserved + row.amount_cents > this.balanceCents) throw new ChargeRefusedError('over_balance', 'passa do saldo');
    }
    return this.add(row);
  }
  async insertVoid(row: NewChargeRow) {
    this.enter('insertVoid');
    if (row.cancel_requested_by !== STAFF) throw new ChargeRefusedError('invalid_staff', 'operador não é da equipe ativa desta loja.');
    const existing = this.rows.find((x) => x.idempotency_key === row.idempotency_key);
    if (existing) return { ...existing };
    this.audits.push({ key: row.idempotency_key, action: 'POINT_KEY_BLOCKED', performed_by: row.cancel_requested_by, reason: 'bloqueio' });
    // Como a função do banco: a hora do bloqueio é a do banco, não a que o chamador mandou.
    return this.add({ ...row, status: 'cancelled', raw_status: 'voided_before_send', cancel_reason: 'void', cancel_requested_at: this.iso() });
  }
  async update(row: TerminalChargeRow, patch: ChargePatch) {
    this.enter('update');
    const r = this.get(row.id);
    if (r.status !== row.status || FINAL_STATES.has(r.status)) return { ...r };
    this.write(r, patch);
    return { ...r };
  }
  async claimDispatch(row: TerminalChargeRow, leaseMs: number) {
    this.enter('claimDispatch');
    const r = this.get(row.id);
    if (r.status !== 'creating' || r.external_order_id || r.cancel_requested_at || this.leased(r) || r.dispatch_attempts >= 8) return null;
    this.write(r, { dispatch_lease_until: this.iso(this.nowMs + leaseMs), dispatch_attempts: r.dispatch_attempts + 1 });
    const claimed = { ...row, dispatch_attempts: r.dispatch_attempts };
    await this.afterClaim?.({ ...r });
    return claimed;
  }
  async beginDispatch(row: TerminalChargeRow, leaseMs: number, allowFirst: boolean): Promise<0 | 1 | 2> {
    this.enter('beginDispatch');
    const r = this.get(row.id);
    if (r.status !== 'creating' || r.external_order_id || r.cancel_requested_at || r.dispatch_attempts !== row.dispatch_attempts || !this.leased(r)) return 0;
    // Como no banco: consulta (allowFirst false) nunca marca o primeiro envio.
    if (!allowFirst && r.dispatched_at === null) return 0;
    const kind = r.dispatched_at === null ? 1 : 2;
    this.write(r, { dispatched_at: r.dispatched_at ?? this.iso(), dispatch_lease_until: this.iso(this.nowMs + leaseMs) });
    await this.afterBegin?.({ ...r }, kind);
    return kind;
  }
  async attachOrder(row: TerminalChargeRow, externalOrderId: string) {
    this.enter('attachOrder');
    const r = this.get(row.id);
    if (r.external_order_id === null && !FINAL_STATES.has(r.status)) this.write(r, { external_order_id: externalOrderId });
    return { ...r };
  }
  async rejectFirstSend(row: TerminalChargeRow, code: string) {
    this.enter('rejectFirstSend');
    const r = this.get(row.id);
    if (r.status === 'creating' && r.dispatch_attempts === row.dispatch_attempts && r.external_order_id === null) {
      this.write(r, { status: 'rejected', raw_status: `create_failed:${code}`, raw_status_detail: null });
    }
    return { ...r };
  }
  async voidUndispatched(row: TerminalChargeRow) {
    this.enter('voidUndispatched');
    const r = this.get(row.id);
    if (r.status === 'creating' && !r.dispatched_at) this.write(r, { status: 'cancelled', raw_status: 'voided_before_send' });
    return { ...r };
  }
  async settleDispatch(row: TerminalChargeRow) {
    this.enter('settleDispatch');
    const r = this.get(row.id);
    if (r.status === 'creating' && r.external_order_id === null && r.cancel_requested_at !== null && r.dispatched_at !== null && !this.leased(r)) {
      this.write(r, { status: 'manual_review', raw_status: 'dispatch_unknown', raw_status_detail: 'DISPATCH_UNKNOWN' });
    }
    return { ...r };
  }
  async requestTimeoutCancel(row: TerminalChargeRow, waitMs: number) {
    this.enter('requestTimeoutCancel');
    if (waitMs < 60_000) throw new Error('TCHEFOOD_COBRANCA: prazo de espera inválido.');
    const r = this.get(row.id);
    if (FINAL_STATES.has(r.status) || r.cancel_requested_at !== null) return { ...r };
    if (this.nowMs < Date.parse(r.created_at) + waitMs) return null;
    this.write(r, { cancel_reason: 'timeout', cancel_requested_by: null, cancel_requested_at: this.iso() });
    return { ...r };
  }
  /** Como tchefood_point_charge_in_wait: relógio do "banco" contra a hora gravada, com ou sem encerramento pedido. */
  async inCardWait(row: TerminalChargeRow) {
    const r = this.get(row.id);
    if (FINAL_STATES.has(r.status)) return false;
    return this.nowMs < Date.parse(r.created_at) + 120_000;
  }
  async listOpenForOrder(orderId: string) {
    return this.rows.filter((r) => r.order_id === orderId && !FINAL_STATES.has(r.status)).map((r) => ({ ...r }));
  }
  async authorizeCancel(input: { idempotency_key: string; performed_by: string; manager_pin: string; reason: string }) {
    this.enter('authorizeCancel');
    const r = this.rows.find((x) => x.idempotency_key === input.idempotency_key)!;
    if (input.performed_by !== STAFF) throw new ChargeRefusedError('invalid_staff', 'operador não é da equipe ativa desta loja.');
    if (FINAL_STATES.has(r.status)) throw new ChargeRefusedError('not_applicable', 'a cobrança já terminou.');
    if (input.manager_pin !== MANAGER_PIN) {
      this.audits.push({ key: input.idempotency_key, action: 'MANAGER_PIN_FAILED', performed_by: input.performed_by, reason: 'PIN de gerente incorreto' });
      return null;
    }
    // Como no banco: a autorização já gravada só volta depois do PIN conferido.
    if (r.cancel_reason === 'operator' && r.cancel_audit_id) return r.cancel_audit_id;
    this.audits.push({ key: input.idempotency_key, action: 'POINT_CHARGE_CANCELED', performed_by: input.performed_by, reason: input.reason });
    const id = `audit-${this.audits.length}`;
    this.write(r, { cancel_reason: 'operator', cancel_requested_by: input.performed_by, cancel_requested_at: this.iso(), cancel_authorized_by: 'manager', cancel_audit_id: id });
    return id;
  }
  /** Como tchefood_authorize_point_reconcile: confere operador, motivo, estado e PIN; grava um registro; não muda a cobrança. */
  async authorizeReconcile(input: { idempotency_key: string; performed_by: string; manager_pin: string; reason: string }) {
    this.enter('authorizeReconcile');
    const r = this.rows.find((x) => x.idempotency_key === input.idempotency_key);
    if (!r) throw new ChargeRefusedError('not_found', 'cobrança não encontrada nesta loja.');
    if (input.performed_by !== STAFF) throw new ChargeRefusedError('invalid_staff', 'operador não é da equipe ativa desta loja.');
    if (input.reason.trim().length < 10) throw new ChargeRefusedError('invalid_reason', 'motivo obrigatório (mínimo 10 caracteres).');
    if (r.status !== 'manual_review' && r.status !== 'approved') throw new ChargeRefusedError('not_applicable', 'nada a conferir.');
    if (input.manager_pin !== MANAGER_PIN) {
      this.audits.push({ key: input.idempotency_key, action: 'MANAGER_PIN_FAILED', performed_by: input.performed_by, reason: 'PIN de gerente incorreto' });
      return null;
    }
    this.audits.push({ key: input.idempotency_key, action: 'POINT_RECONCILE_AUTHORIZED', performed_by: input.performed_by, reason: input.reason });
    return `audit-${this.audits.length}`;
  }
  async hasRegisteredPayment(key: string) {
    return this.registeredPayments.has(key);
  }
  async hasPaymentRecord(key: string) {
    return this.registeredPayments.has(key) || this.refundedPayments.has(key);
  }
  /** Como tchefood_resolve_point_charge + o gatilho com a flag ligada: só as transições aceitas, só do estado lido. */
  async resolve(row: TerminalChargeRow, toStatus: ChargeStatus, patch: ChargePatch, audit: { staff: string; reason: string; evidence: Record<string, unknown> }) {
    this.enter('resolve');
    const r = this.get(row.id);
    if (r.status !== row.status) return { ...r };
    const fromReview = r.status === 'manual_review' && ['approved', 'rejected', 'cancelled', 'expired', 'refunded'].includes(toStatus);
    const refund = r.status === 'approved' && toStatus === 'refunded' && !this.registeredPayments.has(r.idempotency_key);
    if (!fromReview && !refund) throw new Error('TCHEFOOD_COBRANCA: transição não aceita.');
    // Como o banco: aprovada → estornada só com o estorno total lido no Mercado Pago (mp_status, senão payment_status).
    if (refund && ((audit.evidence.mp_status ?? audit.evidence.payment_status) !== 'refunded' || audit.evidence.mp_amount_refunded_cents !== r.amount_cents)) {
      throw new ChargeRefusedError('invalid_reason', 'o estorno lido no Mercado Pago não é total.');
    }
    if ('status' in patch || 'external_order_id' in patch) throw new Error('TCHEFOOD_COBRANCA: o patch não muda estado nem ordem.');
    const next = { ...r, ...patch, status: toStatus };
    if (toStatus === 'approved' && (!next.external_payment_id || !next.authorization_code || !next.card_brand || next.paid_amount_cents !== next.amount_cents)) {
      throw new Error('TCHEFOOD_COBRANCA: aprovação sem comprovante completo.');
    }
    if ((next.raw_status ?? '').length > 50 || (next.raw_status_detail ?? '').length > 80) throw new Error('value too long for type character varying');
    this.resolutions.push({ key: r.idempotency_key, from: r.status, to: toStatus, patch, ...audit });
    this.audits.push({ key: r.idempotency_key, action: 'POINT_CHARGE_RESOLVED', performed_by: audit.staff, reason: audit.reason });
    Object.assign(r, next);
    return { ...r };
  }
  /** Como tchefood_refund_point_payment: as mesmas conferências e recusas (TF004/5/6/7), cobrança e pagamento juntos. */
  async refundPayment(row: TerminalChargeRow, patch: ChargePatch, audit: { staff: string; reason: string; evidence: Record<string, unknown> }) {
    this.enter('refundPayment');
    if (this.refundRefusal) {
      const refusal = this.refundRefusal;
      this.refundRefusal = null;
      throw refusal;
    }
    const e = audit.evidence;
    if (audit.reason.trim().length < 10) throw new ChargeRefusedError('invalid_reason', 'motivo obrigatório.');
    for (const k of ['authorization_audit_id', 'operation_id', 'mp_payment_id', 'mp_amount_cents', 'mp_external_reference', 'mp_status']) {
      if (!(k in e)) throw new ChargeRefusedError('invalid_reason', `falta ${k}.`);
    }
    if (typeof e.mp_payment_id !== 'string' || typeof e.mp_external_reference !== 'string' || typeof e.mp_amount_cents !== 'number' || !['refunded', 'cancelled'].includes(String(e.mp_status))) {
      throw new ChargeRefusedError('invalid_reason', 'o Mercado Pago não mostra o pagamento estornado ou cancelado.');
    }
    if (Object.keys(patch).some((k) => k !== 'raw_status' && k !== 'raw_status_detail')) throw new ChargeRefusedError('invalid_reason', 'campo não muda no estorno.');
    if (audit.staff !== STAFF) throw new ChargeRefusedError('invalid_staff', 'operador não é da equipe ativa desta loja.');
    const r = this.rows.find((x) => x.id === row.id);
    if (!r) throw new ChargeRefusedError('not_found', 'cobrança não encontrada nesta loja.');
    if (r.status === 'refunded') return { ...r };
    if (r.status !== 'approved') throw new ChargeRefusedError('not_applicable', `a cobrança está "${r.status}".`);
    if (!this.registeredPayments.has(r.idempotency_key)) throw new ChargeRefusedError('not_applicable', 'sem pagamento registrado.');
    const auth = /^audit-(\d+)$/.exec(String(e.authorization_audit_id));
    const authorized = auth ? this.audits[Number(auth[1]) - 1] : undefined;
    if (!authorized || authorized.action !== 'POINT_RECONCILE_AUTHORIZED' || authorized.key !== r.idempotency_key) throw new ChargeRefusedError('invalid_reason', 'não autorizado por gerente.');
    if ([...this.resolutions, ...this.refunds].some((x) => x.evidence.authorization_audit_id === e.authorization_audit_id)) throw new ChargeRefusedError('not_applicable', 'a autorização da conferência já foi usada; peça outra.');
    const pay = this.registeredPaymentData.get(r.idempotency_key) ?? { nsu: r.external_payment_id, amountCents: r.amount_cents };
    if (e.mp_amount_refunded_cents !== r.amount_cents) throw new ChargeRefusedError('invalid_reason', 'o valor estornado não é o da cobrança.');
    if (e.mp_payment_id !== r.external_payment_id || pay.nsu !== r.external_payment_id || e.mp_external_reference !== r.idempotency_key || e.mp_amount_cents !== r.amount_cents || pay.amountCents !== r.amount_cents) {
      throw new ChargeRefusedError('invalid_reason', 'o estorno lido no Mercado Pago não confere com a cobrança.');
    }
    this.refunds.push({ key: r.idempotency_key, patch, ...audit });
    this.audits.push({ key: r.idempotency_key, action: 'POINT_PAYMENT_REFUNDED', performed_by: audit.staff, reason: audit.reason });
    // Como o banco: conta fechada reabre (PAYING) com o saldo devolvido, e o registro diz se reabriu.
    this.refundRecords.set(r.id, { refund_audit_id: `audit-${this.audits.length}`, authorization_audit_id: String(e.authorization_audit_id), manager_id: MANAGER_ID, order_reopened: this.orderClosed });
    this.orderClosed = false;
    Object.assign(r, patch, { status: 'refunded' as ChargeStatus });
    this.registeredPayments.delete(r.idempotency_key);
    this.refundedPayments.add(r.idempotency_key);
    return { ...r };
  }
}

function order(over: Partial<PaymentTerminalChargeResult> = {}): PaymentTerminalChargeResult {
  return {
    provider: 'mercado_pago_point',
    externalOrderId: 'ORD01',
    externalPaymentId: null,
    externalTransactionId: 'PAY01',
    externalReference: KEY,
    externalTerminalId: MP_TERMINAL,
    status: 'at_terminal',
    rawStatus: 'at_terminal',
    rawStatusDetail: 'at_terminal',
    amountCents: 2450,
    paidAmountCents: null,
    paymentMethodId: null,
    paymentMethodType: null,
    installments: null,
    ...over,
  };
}

const approvedOrder = (over: Partial<PaymentTerminalChargeResult> = {}) =>
  order({ status: 'approved', rawStatus: 'processed', rawStatusDetail: 'accredited', externalPaymentId: '123456789', paidAmountCents: 2450, paymentMethodId: 'master', paymentMethodType: 'credit_card', installments: 1, ...over });

/** Estorno do Mercado Pago (status refunded) vem com transaction_amount_refunded = valor (estorno total), salvo se o teste disser. */
const approvedPayment = (over: Partial<PointPaymentDetails> = {}): PointPaymentDetails => ({
  id: '123456789', status: 'approved', amountCents: 2450, paymentMethodId: 'master', paymentTypeId: 'credit_card', authorizationCode: 'A1B2C3', lastFour: '4242', installments: 1,
  ...(over.status === 'refunded' ? { amountRefundedCents: 2450 } : {}), ...over,
});

function setup(opts: {
  create?: () => Promise<PaymentTerminalChargeResult>; get?: () => Promise<PaymentTerminalChargeResult>; payment?: (id: string) => Promise<PointPaymentDetails>; cancel?: () => Promise<void>;
  find?: () => Promise<PaymentTerminalChargeResult | null>;
} = {}) {
  const calls: { create: PaymentTerminalChargeRequest[]; get: string[]; cancel: { id: string; key: string }[]; payment: string[]; find: { ref: string; createdAt: string | undefined }[] } = { create: [], get: [], cancel: [], payment: [], find: [] };
  const provider: PaymentTerminalProvider = {
    key: 'mercado_pago_point',
    createRetryPolicy: 'same_key',
    approvalIdentity: 'reference_and_terminal',
    supportedMethods: ['credit', 'debit', 'pix'],
    listTerminals: async () => [],
    createCharge: async (r) => {
      calls.create.push(r);
      return (opts.create ?? (async () => order()))();
    },
    getCharge: async (id) => {
      calls.get.push(id);
      return (opts.get ?? (async () => order()))();
    },
    cancelCharge: async (id, o) => {
      calls.cancel.push({ id, key: o.idempotencyKey });
      await (opts.cancel ?? (async () => undefined))();
      return { outcome: 'cancellation_pending', charge: null };
    },
    findChargeByReference: async (ref, o) => {
      calls.find.push({ ref, createdAt: o?.createdAt });
      return (opts.find ?? (async () => null))();
    },
  };
  const store = new MemoryStore();
  const ctx: ChargeContext = {
    store,
    provider,
    payments: {
      getPayment: async (id) => {
        calls.payment.push(id);
        return (opts.payment ?? (async () => approvedPayment()))(id);
      },
    },
  };
  return { ctx, store, calls };
}

const CANCEL = { reason: 'timeout', order_id: ORDER, amount_cents: 2450, method: 'CREDIT' };
const OPERATOR = { ...CANCEL, reason: 'operator', staff_id: STAFF, manager_pin: MANAGER_PIN, reason_text: 'cliente desistiu' };
const input = (over: Record<string, unknown> = {}) => ({ idempotency_key: KEY, order_id: ORDER, amount_cents: 2450, method: 'CREDIT', staff_id: STAFF, expected_balance_cents: 2450, ...over });

describe('point-charge: criação', () => {
  it('grava a cobrança antes de enviar e manda chave, referência, maquininha, valor e crédito à vista', async () => {
    const { ctx, store, calls } = setup();
    const reply = await startCharge(ctx, terminal, input());
    expect(reply).toEqual({ status: 'PENDING', idempotency_key: KEY, detail: 'Aguardando o cartão na maquininha.' });
    expect(calls.create).toEqual([{ externalTerminalId: MP_TERMINAL, amountCents: 2450, idempotencyKey: KEY, externalReference: KEY, method: 'credit', installments: 1, description: 'Tchê Food' }]);
    expect(store.rows[0]).toMatchObject({ tenant_id: TENANT, order_id: ORDER, terminal_id: TERMINAL_UUID, external_terminal_id: MP_TERMINAL, status: 'at_terminal', external_order_id: 'ORD01', created_by: STAFF });
  });

  it('recusa entrada inválida sem tocar no Mercado Pago', async () => {
    for (const bad of [
      { idempotency_key: 'tem espaço' },
      { idempotency_key: 'x'.repeat(51) },
      { order_id: 'nao-uuid' },
      { amount_cents: 0 },
      { amount_cents: 12.5 },
      { amount_cents: '2450' },
      { amount_cents: 10_000_001 },
      { method: 'PIX' },
      { method: 'VOUCHER' },
      { staff_id: 'x' },
    ]) {
      const { ctx, calls } = setup();
      await expect(startCharge(ctx, terminal, input(bad))).rejects.toBeInstanceOf(ChargeInputError);
      expect(calls.create).toHaveLength(0);
    }
  });

  it('maquininha que não é Mercado Pago ou sem terminal_id não cobra', async () => {
    const { ctx, calls } = setup();
    await expect(startCharge(ctx, { ...terminal, acquirer: 'STONE' }, input())).rejects.toMatchObject({ code: 'not_mercado_pago' });
    await expect(startCharge(ctx, { ...terminal, serial_number: '  ' }, input())).rejects.toMatchObject({ code: 'terminal_without_id' });
    expect(calls.create).toHaveLength(0);
  });

  it('mesma chave com pedido diferente é recusada (409) e não cria outra ordem', async () => {
    const { ctx, calls } = setup();
    await startCharge(ctx, terminal, input());
    for (const over of [{ amount_cents: 2451 }, { method: 'DEBIT' }, { order_id: '66666666-6666-4666-8666-666666666666' }]) {
      await expect(startCharge(ctx, terminal, input(over))).rejects.toMatchObject({ code: 'idempotency_conflict', httpStatus: 409 });
    }
    await expect(startCharge(ctx, { ...terminal, id: '77777777-7777-4777-8777-777777777777' }, input())).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect(calls.create).toHaveLength(1);
  });

  it('reenvio da mesma cobrança só reconsulta (não cria outra ordem)', async () => {
    const { ctx, calls } = setup();
    await startCharge(ctx, terminal, input());
    await startCharge(ctx, terminal, input());
    expect(calls.create).toHaveLength(1);
    expect(calls.get).toEqual(['ORD01']);
  });

  it('criação com resultado desconhecido fica "creating" e a consulta repete com a MESMA chave', async () => {
    let n = 0;
    const { ctx, store, calls } = setup({
      create: async () => {
        n += 1;
        if (n === 1) throw new PaymentTerminalProviderError('timeout', { outcomeUnknown: true });
        return order();
      },
    });
    expect((await startCharge(ctx, terminal, input())).status).toBe('PENDING');
    expect(store.rows[0]!.status).toBe('creating');
    // Sem resposta do Mercado Pago: o pedido pode estar sendo processado lá. Ninguém manda outro por cima
    // enquanto a posse do envio vale; vencida, a consulta repete com a MESMA chave.
    expect((await pollCharge(ctx, store.rows[0]!)).status).toBe('PENDING');
    expect(calls.create).toHaveLength(1);
    store.nowMs += 31_000;
    expect((await pollCharge(ctx, store.rows[0]!)).status).toBe('PENDING');
    expect(calls.create.map((c) => c.idempotencyKey)).toEqual([KEY, KEY]);
    expect(calls.create[0]).toEqual(calls.create[1]);
    expect(store.rows[0]!.external_order_id).toBe('ORD01');
  });

  it('recusa definitiva na criação vira DECLINED com o motivo, e não é reenviada', async () => {
    for (const [code, text] of [['terminal_busy', 'outra cobrança na fila'], ['not_found', 'Maquininha não encontrada'], ['unauthorized', 'Token do Mercado Pago recusado'], ['invalid_request', 'recusou o pedido']] as const) {
      const { ctx, store, calls } = setup({ create: async () => { throw new PaymentTerminalProviderError(code, { httpStatus: 409 }); } });
      const reply = await startCharge(ctx, terminal, input());
      expect(reply.status).toBe('DECLINED');
      expect(reply.status === 'DECLINED' && reply.reason).toContain(text);
      await pollCharge(ctx, store.rows[0]!);
      expect(calls.create).toHaveLength(1);
    }
  });

  it('conflito de chave no Mercado Pago não vira recusa nem aprovação: resultado desconhecido, e o encerramento leva à revisão manual', async () => {
    const { ctx, store, calls } = setup({ create: async () => { throw new PaymentTerminalProviderError('idempotency_conflict', { httpStatus: 409 }); } });
    expect((await startCharge(ctx, terminal, input())).status).toBe('PENDING');
    expect(store.rows[0]).toMatchObject({ status: 'creating', external_order_id: null });
    expect(store.count.rejectFirstSend).toBeUndefined();
    store.nowMs += 31_000;
    expect(await cancelCharge(ctx, store.rows[0]!, CANCEL)).toMatchObject({ status: 'MANUAL_REVIEW', code: 'DISPATCH_UNKNOWN' });
    expect(calls.create).toHaveLength(1);
  });
});

/** Toda conferência da aprovação, com o código da revisão manual. A conferência da revisão (r5) usa a mesma tabela. */
const APPROVAL_MISMATCHES = [
  [{ externalReference: 'outra' }, {}, 'REFERENCE_MISMATCH'],
  [{ externalReference: null }, {}, 'APPROVED_WITHOUT_REFERENCE'],
  [{ externalTerminalId: 'OUTRA' }, {}, 'TERMINAL_MISMATCH'],
  [{ externalTerminalId: null }, {}, 'APPROVED_WITHOUT_TERMINAL'],
  [{ amountCents: 2400 }, {}, 'AMOUNT_MISMATCH'],
  [{ paidAmountCents: 2400 }, {}, 'PAID_AMOUNT_MISMATCH'],
  [{ paidAmountCents: null }, {}, 'PAID_AMOUNT_MISMATCH'],
  [{ paymentMethodType: 'debit_card' }, {}, 'METHOD_MISMATCH'],
  [{ paymentMethodType: null }, {}, 'METHOD_MISMATCH'],
  [{ installments: 3 }, {}, 'INSTALLMENTS_MISMATCH'],
  [{ externalPaymentId: null }, {}, 'APPROVED_WITHOUT_NSU'],
  [{}, { id: '999' }, 'PAYMENT_ID_MISMATCH'],
  [{}, { status: 'in_process' }, 'PAYMENT_NOT_APPROVED'],
  [{}, { amountCents: 2449 }, 'PAYMENT_AMOUNT_MISMATCH'],
  [{}, { amountCents: null }, 'PAYMENT_AMOUNT_MISMATCH'],
  [{}, { paymentTypeId: 'account_money' }, 'PAYMENT_METHOD_MISMATCH'],
  [{}, { installments: 2 }, 'PAYMENT_INSTALLMENTS_MISMATCH'],
  [{}, { authorizationCode: null }, 'APPROVED_WITHOUT_AUTHORIZATION'],
  [{}, { authorizationCode: '12 34' }, 'APPROVED_WITHOUT_AUTHORIZATION'],
  [{}, { paymentMethodId: 'amex' }, 'UNSUPPORTED_BRAND'],
  [{}, { installments: null }, 'PAYMENT_INSTALLMENTS_MISMATCH'],
  [{ installments: null }, { installments: null }, 'PAYMENT_INSTALLMENTS_MISMATCH'],
  [{}, { paymentMethodId: null }, 'UNSUPPORTED_BRAND'],
  [{ paymentMethodId: 'visa' }, {}, 'BRAND_MISMATCH'],
  // r6 P2: mesmo valor e comprovante completo, mas o pagamento diz ser de outra cobrança ou de outra ordem.
  [{}, { externalReference: 'outra-chave' }, 'PAYMENT_REFERENCE_MISMATCH'],
  [{}, { orderId: 'ORD99' }, 'PAYMENT_ORDER_MISMATCH'],
  [{}, { externalReference: KEY, orderId: 'ORD99' }, 'PAYMENT_ORDER_MISMATCH'],
] as const;

describe('point-charge: aprovação só com tudo conferido', () => {
  async function approveWith(orderOver: Partial<PaymentTerminalChargeResult> = {}, paymentOver: Partial<PointPaymentDetails> = {}, method: 'CREDIT' | 'DEBIT' = 'CREDIT') {
    const { ctx, store } = setup({ get: async () => approvedOrder(orderOver), payment: async () => approvedPayment(paymentOver) });
    await startCharge(ctx, terminal, input({ method }));
    return { reply: await pollCharge(ctx, store.rows[0]!), row: store.rows[0]! };
  }

  it('aprovado: NSU = ID do pagamento, autorização e bandeira do pagamento, maquininha do Mercado Pago', async () => {
    const { reply, row } = await approveWith();
    expect(reply).toEqual({
      status: 'APPROVED', idempotency_key: KEY, nsu: '123456789', authorization_code: 'A1B2C3', card_brand: 'MASTERCARD', last_four: '4242',
      terminal_serial: MP_TERMINAL, amount_cents: 2450, method: 'CREDIT',
    });
    expect(row).toMatchObject({ status: 'approved', external_payment_id: '123456789', paid_amount_cents: 2450, authorization_code: 'A1B2C3', card_brand: 'MASTERCARD' });
  });

  it('r6 P2: pagamento com a referência e a ordem desta cobrança aprova; sem as duas, vale a conferência de antes', async () => {
    for (const p of [{ externalReference: KEY, orderId: 'ORD01' }, { externalReference: KEY }, { orderId: 'ORD01' }, { externalReference: null, orderId: null }]) {
      const { reply, row } = await approveWith({}, p);
      expect(reply, JSON.stringify(p)).toMatchObject({ status: 'APPROVED', nsu: '123456789' });
      expect(row.status).toBe('approved');
    }
  });

  it('F1: pagamento real com order = merchant_order ({ id: número, type: "mercadopago" }) aprova', async () => {
    const parsed = parsePayment({
      id: 123456789, status: 'approved', transaction_amount: 24.5, payment_method_id: 'master', payment_type_id: 'credit_card',
      authorization_code: 'A1B2C3', card: { last_four_digits: '4242' }, installments: 1, external_reference: KEY,
      order: { id: 31234567890, type: 'mercadopago' },
    });
    expect(parsed.orderId).toBeNull();
    const { ctx, store } = setup({ get: async () => approvedOrder(), payment: async () => parsed });
    await startCharge(ctx, terminal, input());
    expect(await pollCharge(ctx, store.rows[0]!)).toMatchObject({ status: 'APPROVED', nsu: '123456789' });
    // Mesmo que chegue como texto numérico, não é id da Orders API e não se compara.
    const { reply } = await approveWith({}, { orderId: '31234567890' });
    expect(reply).toMatchObject({ status: 'APPROVED' });
    // Id da Orders API de outra ordem continua recusado.
    expect(parsePayment({ id: 1, order: { id: 'ORD99' } }).orderId).toBe('ORD99');
    expect((await approveWith({}, { orderId: 'ORD99' })).reply).toMatchObject({ status: 'MANUAL_REVIEW', code: 'PAYMENT_ORDER_MISMATCH' });
  });

  it('F3: consulta normal com ordem recusada sem referência ecoada vai para revisão, não libera', async () => {
    const { ctx, store } = setup({ get: async () => order({ status: 'rejected', rawStatus: 'failed', externalReference: null }) });
    await startCharge(ctx, terminal, input());
    expect(await pollCharge(ctx, store.rows[0]!)).toMatchObject({ status: 'MANUAL_REVIEW', code: 'FINAL_WITHOUT_REFERENCE' });
    expect(store.rows[0]!.status).toBe('manual_review');
  });

  it('débito aprovado com debvisa', async () => {
    const { reply } = await approveWith({ paymentMethodType: 'debit_card', paymentMethodId: 'debvisa' }, { paymentTypeId: 'debit_card', paymentMethodId: 'debvisa' }, 'DEBIT');
    expect(reply).toMatchObject({ status: 'APPROVED', card_brand: 'VISA', method: 'DEBIT' });
  });

  it.each(APPROVAL_MISMATCHES)('%o %o → revisão manual %s', async (o, p, code) => {
    const { reply, row } = await approveWith(o, p);
    expect(reply).toMatchObject({ status: 'MANUAL_REVIEW', code });
    expect(row.status).toBe('manual_review');
    expect(row.authorization_code).toBeNull();
  });

  it('status incerto do Mercado Pago vira revisão manual', async () => {
    const { ctx, store } = setup({ get: async () => order({ status: 'manual_review', rawStatus: 'action_required' }) });
    await startCharge(ctx, terminal, input());
    expect((await pollCharge(ctx, store.rows[0]!)).status).toBe('MANUAL_REVIEW');
  });

  it('falha ao ler o pagamento não aprova: continua pendente e tenta de novo', async () => {
    let fail = true;
    const { ctx, store, calls } = setup({ get: async () => approvedOrder(), payment: async () => { if (fail) throw new Error('rede'); return approvedPayment(); } });
    await startCharge(ctx, terminal, input());
    expect((await pollCharge(ctx, store.rows[0]!)).status).toBe('PENDING');
    expect(store.rows[0]!.status).toBe('at_terminal');
    fail = false;
    expect((await pollCharge(ctx, store.rows[0]!)).status).toBe('APPROVED');
    expect(calls.payment).toHaveLength(2);
  });

  it('erro na consulta da ordem não muda nada', async () => {
    const { ctx, store } = setup({ get: async () => { throw new PaymentTerminalProviderError('unavailable'); } });
    await startCharge(ctx, terminal, input());
    expect((await pollCharge(ctx, store.rows[0]!)).status).toBe('PENDING');
    expect(store.rows[0]!.status).toBe('at_terminal');
  });

  it('ordem trocada de ID vira revisão manual', async () => {
    const { ctx, store } = setup({ get: async () => order({ externalOrderId: 'ORD99' }) });
    await startCharge(ctx, terminal, input());
    expect((await pollCharge(ctx, store.rows[0]!)).status).toBe('MANUAL_REVIEW');
  });

  it('aprovado gravado não é reconsultado nem rebaixado', async () => {
    let refunded = false;
    const { ctx, store, calls } = setup({ get: async () => (refunded ? order({ status: 'refunded', rawStatus: 'refunded', rawStatusDetail: 'refunded' }) : approvedOrder()) });
    await startCharge(ctx, terminal, input());
    await pollCharge(ctx, store.rows[0]!);
    refunded = true;
    const before = calls.get.length;
    expect((await pollCharge(ctx, store.rows[0]!)).status).toBe('APPROVED');
    expect(calls.get.length).toBe(before);
  });

  it('recusado, cancelado e expirado viram DECLINED', async () => {
    for (const status of ['rejected', 'cancelled', 'expired'] as const) {
      const { ctx, store } = setup({ get: async () => order({ status, rawStatus: status, rawStatusDetail: 'x' }) });
      await startCharge(ctx, terminal, input());
      expect((await pollCharge(ctx, store.rows[0]!)).status).toBe('DECLINED');
    }
  });
});

describe('point-charge: cancelamento', () => {
  it('pede o cancelamento com chave própria e só recusa quando o Mercado Pago confirma', async () => {
    let cancelled = false;
    const { ctx, store, calls } = setup({
      get: async () => (cancelled ? order({ status: 'cancelled', rawStatus: 'canceled', rawStatusDetail: 'canceled' }) : order()),
      cancel: async () => { cancelled = true; },
    });
    await startCharge(ctx, terminal, input());
    expect((await cancelCharge(ctx, store.rows[0]!, CANCEL)).status).toBe('DECLINED');
    expect(calls.cancel).toEqual([{ id: 'ORD01', key: `${KEY}-cancel` }]);
  });

  it('cancelamento não confirmado continua pendente', async () => {
    const { ctx, store } = setup({ cancel: async () => { throw new PaymentTerminalProviderError('not_cancellable'); } });
    await startCharge(ctx, terminal, input());
    expect((await cancelCharge(ctx, store.rows[0]!, CANCEL)).status).toBe('PENDING');
  });

  it('cancelar depois de pago devolve a aprovação (nunca recusa um pagamento feito)', async () => {
    const { ctx, store } = setup({ get: async () => approvedOrder(), cancel: async () => { throw new PaymentTerminalProviderError('not_cancellable'); } });
    await startCharge(ctx, terminal, input());
    expect((await cancelCharge(ctx, store.rows[0]!, CANCEL)).status).toBe('APPROVED');
  });

});

describe('point-charge: concorrência (auditoria r1 P0-02)', () => {
  it('duas consultas ao mesmo tempo, respostas fora de ordem: a atrasada não rebaixa a aprovação', async () => {
    const gates: ((o: PaymentTerminalChargeResult) => void)[] = [];
    const { ctx, store } = setup({ get: () => new Promise((resolve) => gates.push(resolve)) });
    await startCharge(ctx, terminal, input());
    const snapshot = { ...store.rows[0]! };
    expect(snapshot.status).toBe('at_terminal');
    const first = pollCharge(ctx, snapshot);
    const second = pollCharge(ctx, snapshot);
    await new Promise((r) => setTimeout(r, 0));
    expect(gates).toHaveLength(2);
    gates[0]!(approvedOrder());
    expect((await first).status).toBe('APPROVED');
    gates[1]!(order()); // resposta antiga: at_terminal
    expect((await second).status).toBe('APPROVED');
    expect(store.rows[0]).toMatchObject({ status: 'approved', external_payment_id: '123456789', authorization_code: 'A1B2C3', card_brand: 'MASTERCARD', paid_amount_cents: 2450 });
  });

  it('cancelamento com leitura antiga depois da aprovação devolve a aprovação e não mexe nela', async () => {
    let approved = false;
    const { ctx, store, calls } = setup({ get: async () => (approved ? approvedOrder() : order()) });
    await startCharge(ctx, terminal, input());
    const stale = { ...store.rows[0]! };
    approved = true;
    expect((await pollCharge(ctx, stale)).status).toBe('APPROVED');
    expect((await cancelCharge(ctx, stale, CANCEL)).status).toBe('APPROVED');
    expect(store.rows[0]).toMatchObject({ status: 'approved', cancel_requested_at: null });
    expect(calls.cancel).toHaveLength(0);
  });
});

describe('point-charge: conta e saldo no servidor (auditoria r1 P1-02)', () => {
  it.each([
    ['order_not_found', 'a conta ainda não está no servidor'],
    ['order_closed', 'a conta já está fechada'],
    ['over_balance', 'passa do saldo'],
  ] as const)('banco recusa (%s): 409 e nada vai ao Mercado Pago', async (code, message) => {
    const { ctx, store, calls } = setup();
    store.refuse = new ChargeRefusedError(code, message);
    await expect(startCharge(ctx, terminal, input())).rejects.toMatchObject({ code, httpStatus: 409, message });
    expect(calls.create).toHaveLength(0);
    expect(store.rows).toHaveLength(0);
  });
});

describe('point-charge: encerrar tentativa (auditoria r1 P0-01 / r2 P1-01 e P1-02)', () => {
  it('r2 P1-01: pedido do operador sem PIN de gerente válido é recusado e nada vai ao Mercado Pago', async () => {
    const { ctx, store, calls } = setup();
    await startCharge(ctx, terminal, input());
    for (const bad of [
      { ...OPERATOR, manager_pin: undefined },
      { ...OPERATOR, manager_pin: '0000' },
      { ...OPERATOR, reason_text: 'x' },
      { ...OPERATOR, staff_id: undefined },
      { ...OPERATOR, staff_id: '66666666-6666-4666-8666-666666666666' }, // UUID válido, mas fora da equipe
      { ...CANCEL, reason: 'qualquer' },
    ]) {
      await expect(cancelCharge(ctx, store.rows[0]!, bad as never)).rejects.toBeInstanceOf(ChargeInputError);
    }
    expect(calls.cancel).toHaveLength(0);
    expect(store.rows[0]).toMatchObject({ cancel_requested_at: null, status: 'at_terminal' });
  });

  it('r2 P1-01: com PIN de gerente, grava o registro auditável e só então pede o cancelamento', async () => {
    const { ctx, store, calls } = setup();
    await startCharge(ctx, terminal, input());
    await cancelCharge(ctx, store.rows[0]!, OPERATOR);
    expect(store.audits).toEqual([{ key: KEY, action: 'POINT_CHARGE_CANCELED', performed_by: STAFF, reason: 'cliente desistiu' }]);
    expect(store.rows[0]).toMatchObject({ cancel_reason: 'operator', cancel_requested_by: STAFF, cancel_audit_id: 'audit-1' });
    expect(calls.cancel).toEqual([{ id: 'ORD01', key: `${KEY}-cancel` }]);
  });

  it('r2 P1-01: encerramento por prazo é decidido pelo servidor (hora gravada), sem identidade do aparelho', async () => {
    const { ctx, store, calls } = setup();
    store.createdAgoMs = 30_000;
    await startCharge(ctx, terminal, input());
    await expect(cancelCharge(ctx, store.rows[0]!, CANCEL)).rejects.toMatchObject({ code: 'too_early', httpStatus: 409 });
    expect(calls.cancel).toHaveLength(0);
    // r3 P1-01: o prazo do servidor é o mesmo do app (2 min). Aos 91 s ainda é cedo.
    // O relógio é o do banco (store.nowMs), contra a hora gravada da cobrança.
    const created = Date.parse(store.rows[0]!.created_at);
    store.nowMs = created + 91_000;
    await expect(cancelCharge(ctx, store.rows[0]!, CANCEL)).rejects.toMatchObject({ code: 'too_early', httpStatus: 409 });
    store.nowMs = created + 119_999;
    await expect(cancelCharge(ctx, store.rows[0]!, CANCEL)).rejects.toMatchObject({ code: 'too_early' });
    expect(store.rows[0]!.cancel_requested_at).toBeNull();
    expect(calls.cancel).toHaveLength(0);
    store.nowMs = created + 120_000;
    await cancelCharge(ctx, store.rows[0]!, { ...CANCEL, staff_id: STAFF } as never);
    expect(store.rows[0]).toMatchObject({ cancel_reason: 'timeout', cancel_requested_by: null });
    expect(calls.cancel).toHaveLength(1);
  });

  it('r2 P1-01: encerramento com conta, valor ou forma diferentes da cobrança é recusado', async () => {
    const { ctx, store, calls } = setup();
    await startCharge(ctx, terminal, input());
    for (const over of [{ amount_cents: 1 }, { method: 'DEBIT' }, { order_id: '66666666-6666-4666-8666-666666666666' }]) {
      await expect(cancelCharge(ctx, store.rows[0]!, { ...CANCEL, ...over })).rejects.toMatchObject({ code: 'idempotency_conflict' });
    }
    expect(calls.cancel).toHaveLength(0);
  });

  it('r2 P1-02: cobrança gravada e ainda não enviada: encerrar não manda nada ao Mercado Pago', async () => {
    const { ctx, store, calls } = setup();
    store.rows.push({ ...store['add']({ ...input(), tenant_id: TENANT, idempotency_key: KEY, terminal_id: TERMINAL_UUID, provider: 'mercado_pago_point', external_terminal_id: MP_TERMINAL, method: 'CREDIT', amount_cents: 2450, status: 'creating', external_order_id: null, external_payment_id: null, raw_status: null, raw_status_detail: null, paid_amount_cents: null, card_brand: null, authorization_code: null, last_four: null, created_by: STAFF, dispatched_at: null, dispatch_lease_until: null, dispatch_attempts: 0, cancel_reason: null, cancel_requested_by: null, cancel_requested_at: null, cancel_authorized_by: null, cancel_audit_id: null } as never) });
    store.rows.splice(1);
    const reply = await cancelCharge(ctx, store.rows[0]!, CANCEL);
    expect(reply).toMatchObject({ status: 'DECLINED', reason: 'A cobrança não chegou à maquininha (nada foi cobrado).' });
    expect(calls.create).toHaveLength(0);
    expect(calls.cancel).toHaveLength(0);
    // Consulta depois do encerramento também não manda.
    expect((await pollCharge(ctx, store.rows[0]!)).status).toBe('DECLINED');
    expect(calls.create).toHaveLength(0);
  });

  it('r2 P1-02: leitura antiga ("creating", envio sem resposta) depois do encerramento: a consulta não manda a ordem', async () => {
    const { ctx, store, calls } = setup({ create: async () => { throw new PaymentTerminalProviderError('timeout', { outcomeUnknown: true }); } });
    await startCharge(ctx, terminal, input()); // enviada, resultado desconhecido
    expect(store.rows[0]).toMatchObject({ status: 'creating', dispatch_attempts: 1 });
    expect(store.rows[0]!.dispatched_at).not.toBeNull();
    const stale = { ...store.rows[0]! };
    await cancelCharge(ctx, stale, CANCEL); // não repete a criação
    expect(calls.create).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ cancel_reason: 'timeout', dispatch_attempts: 1 });
    await pollCharge(ctx, stale);
    await pollCharge(ctx, store.rows[0]!);
    expect(calls.create).toHaveLength(1);
    expect(store.rows[0]!.dispatch_attempts).toBe(1);
  });

  it('r2 P1-02: encerramento concorrente com o envio em andamento: espera, e a ordem que chega é cancelada na hora', async () => {
    let release: (o: PaymentTerminalChargeResult) => void = () => undefined;
    let cancelled = false;
    const { ctx, store, calls } = setup({
      create: () => new Promise((resolve) => { release = resolve; }),
      get: async () => (cancelled ? order({ status: 'cancelled', rawStatus: 'canceled' }) : order()),
      cancel: async () => { cancelled = true; },
    });
    const creating = startCharge(ctx, terminal, input());
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.create).toHaveLength(1); // envio em andamento
    store.nowMs += 1_000;
    expect((await cancelCharge(ctx, store.rows[0]!, CANCEL)).status).toBe('PENDING'); // sem ordem ainda: não manda outra, não desiste
    expect(store.rows[0]).toMatchObject({ status: 'creating', cancel_reason: 'timeout' });
    release(order());
    // Quem tinha a posse grava a ordem e, vendo o encerramento pedido, cancela no Mercado Pago na mesma chamada.
    expect((await creating).status).toBe('DECLINED');
    expect(store.rows[0]).toMatchObject({ external_order_id: 'ORD01', status: 'cancelled' });
    expect(calls.create).toHaveLength(1);
    expect(calls.cancel).toEqual([{ id: 'ORD01', key: `${KEY}-cancel` }]);
  });

  it('repetição da criação com recusa "definitiva" não vira recusa (o envio anterior pode ter criado a ordem)', async () => {
    let n = 0;
    const { ctx, store } = setup({
      create: async () => {
        n += 1;
        if (n === 1) throw new PaymentTerminalProviderError('timeout', { outcomeUnknown: true });
        throw new PaymentTerminalProviderError('terminal_busy', { httpStatus: 409 });
      },
    });
    await startCharge(ctx, terminal, input());
    expect((await pollCharge(ctx, store.rows[0]!)).status).toBe('PENDING');
    expect(store.rows[0]!.status).toBe('creating');
  });

  it('sem cobrança gravada: grava o bloqueio preventivo da chave (com operador e registro) e a criação atrasada não chega à Point', async () => {
    const { ctx, store, calls } = setup();
    const voided = await voidCharge(ctx, terminal, { ...input(), ...CANCEL });
    expect(voided).toMatchObject({ status: 'DECLINED', reason: 'A cobrança não chegou à maquininha (nada foi cobrado).' });
    expect(store.rows[0]).toMatchObject({ status: 'cancelled', raw_status: 'voided_before_send', cancel_reason: 'void', cancel_requested_by: STAFF, created_by: null });
    expect(store.audits).toEqual([{ key: KEY, action: 'POINT_KEY_BLOCKED', performed_by: STAFF, reason: 'bloqueio' }]);
    expect((await startCharge(ctx, terminal, input())).status).toBe('DECLINED');
    expect(calls.create).toHaveLength(0);
    expect((await pollCharge(ctx, store.rows[0]!)).status).toBe('DECLINED');
    expect(calls.create).toHaveLength(0);
    // Repetir o bloqueio não grava outro registro.
    await voidCharge(ctx, terminal, { ...input(), ...CANCEL });
    expect(store.audits).toHaveLength(1);
  });

  it('a criação gravou primeiro: o encerramento vira cancelamento da cobrança que ficou', async () => {
    let cancelled = false;
    const { ctx, store, calls } = setup({
      get: async () => (cancelled ? order({ status: 'cancelled', rawStatus: 'canceled' }) : order()),
      cancel: async () => { cancelled = true; },
    });
    await startCharge(ctx, terminal, input());
    expect((await voidCharge(ctx, terminal, { ...input(), ...CANCEL })).status).toBe('DECLINED');
    expect(calls.cancel).toEqual([{ id: 'ORD01', key: `${KEY}-cancel` }]);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]!.raw_status).not.toBe('voided_before_send');
  });

  it('a criação gravou primeiro há pouco: encerramento por prazo é cedo demais (o aparelho segue consultando)', async () => {
    const { ctx, store } = setup();
    store.createdAgoMs = 5_000;
    await startCharge(ctx, terminal, input());
    await expect(voidCharge(ctx, terminal, { ...input(), ...CANCEL })).rejects.toMatchObject({ code: 'too_early' });
  });

  it('a criação gravou primeiro e já foi paga: o encerramento devolve a aprovação', async () => {
    const { ctx } = setup({ get: async () => approvedOrder() });
    await startCharge(ctx, terminal, input());
    expect((await voidCharge(ctx, terminal, { ...input(), ...CANCEL })).status).toBe('APPROVED');
  });

  it('bloqueio com outro pedido na mesma chave é conflito', async () => {
    const { ctx } = setup();
    await voidCharge(ctx, terminal, { ...input(), ...CANCEL });
    await expect(voidCharge(ctx, terminal, { ...input({ amount_cents: 999 }), ...CANCEL, amount_cents: 999 })).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });
});

describe('point-charge: auditoria r3', () => {
  const unknown = () => { throw new PaymentTerminalProviderError('timeout', { outcomeUnknown: true }); };

  describe('P0-01: envio sem resposta nunca vira recusa nem libera o saldo, com ou sem PIN', () => {
    it('criação sem resposta, paga no Mercado Pago; gerente autoriza aos 121 s: revisão manual, nunca "nada foi cobrado"', async () => {
      const { ctx, store, calls } = setup({ create: async () => unknown() });
      await startCharge(ctx, terminal, input());
      expect(store.rows[0]).toMatchObject({ status: 'creating', external_order_id: null });
      store.nowMs += 121_000;
      const reply = await cancelCharge(ctx, store.rows[0]!, OPERATOR);
      expect(reply).toMatchObject({ status: 'MANUAL_REVIEW', code: 'DISPATCH_UNKNOWN' });
      expect((reply as { reason: string }).reason).toContain('pode ter sido paga');
      expect(store.rows[0]).toMatchObject({ status: 'manual_review', raw_status: 'dispatch_unknown', cancel_reason: 'operator' });
      // Não é estado final: segue na lista das que reservam o saldo da conta.
      expect((await store.listOpenForOrder(ORDER)).map((r) => r.idempotency_key)).toEqual([KEY]);
      // Repetir o pedido, consultar e tentar de novo com a mesma chave: continua revisão manual, nada é mandado.
      store.nowMs += 600_000;
      expect((await cancelCharge(ctx, store.rows[0]!, OPERATOR)).status).toBe('MANUAL_REVIEW');
      expect((await pollCharge(ctx, store.rows[0]!)).status).toBe('MANUAL_REVIEW');
      expect((await startCharge(ctx, terminal, input())).status).toBe('MANUAL_REVIEW');
      expect(calls.create).toHaveLength(1);
      expect(calls.cancel).toHaveLength(0);
      expect(store.audits.filter((a) => a.action === 'POINT_CHARGE_CANCELED')).toHaveLength(1);
    });

    it('por prazo é igual: sem ordem conhecida vai para revisão manual, não para recusa', async () => {
      const { ctx, store } = setup({ create: async () => unknown() });
      await startCharge(ctx, terminal, input());
      store.nowMs += 121_000;
      const reply = await cancelCharge(ctx, store.rows[0]!, CANCEL);
      expect(reply).toMatchObject({ status: 'MANUAL_REVIEW', code: 'DISPATCH_UNKNOWN' });
      expect(store.rows[0]!.status).toBe('manual_review');
    });

    it('a resposta que chega depois da revisão manual liga a ordem (o pagamento não se perde); a aprovação sai só pela conferência (r5)', async () => {
      let release: (o: PaymentTerminalChargeResult) => void = () => undefined;
      const { ctx, store } = setup({ create: () => new Promise((resolve) => { release = resolve; }), get: async () => approvedOrder() });
      const creating = startCharge(ctx, terminal, input());
      await new Promise((r) => setTimeout(r, 0));
      // A posse venceu sem resposta e o gerente pediu o encerramento: revisão manual.
      store.nowMs += 121_000;
      expect(await cancelCharge(ctx, store.rows[0]!, OPERATOR)).toMatchObject({ status: 'MANUAL_REVIEW', code: 'DISPATCH_UNKNOWN' });
      expect(store.rows[0]).toMatchObject({ status: 'manual_review', external_order_id: null });
      release(approvedOrder());
      expect(await creating).toMatchObject({ status: 'MANUAL_REVIEW', code: 'DISPATCH_UNKNOWN' });
      expect(store.rows[0]).toMatchObject({ status: 'manual_review', external_order_id: 'ORD01' });
      // A consulta também não tira da revisão; a conferência do gerente lê o Mercado Pago e aprova.
      expect((await pollCharge(ctx, store.rows[0]!)).status).toBe('MANUAL_REVIEW');
      expect(await reconcileCharge(ctx, { idempotency_key: KEY, staff_id: STAFF, manager_pin: MANAGER_PIN, reason_text: 'conferido no app do Mercado Pago' })).toMatchObject({ status: 'APPROVED' });
      expect(store.rows[0]).toMatchObject({ status: 'approved', external_payment_id: '123456789', authorization_code: 'A1B2C3' });
    });
  });

  describe('P1-01: sem cobrança gravada não há cancelamento sem conferência', () => {
    it('pedido "pelo operador" com PIN errado (ou certo) sem cobrança gravada é recusado e nada é gravado', async () => {
      const { ctx, store } = setup();
      for (const pin of ['0000', MANAGER_PIN]) {
        await expect(voidCharge(ctx, terminal, { ...input(), ...OPERATOR, manager_pin: pin })).rejects.toMatchObject({ code: 'not_found', httpStatus: 404 });
      }
      expect(store.rows).toHaveLength(0);
      expect(store.audits).toHaveLength(0);
      // A criação que chega depois segue normalmente.
      expect((await startCharge(ctx, terminal, input())).status).toBe('PENDING');
    });

    it('o bloqueio preventivo exige operador da equipe ativa da loja', async () => {
      const { ctx, store } = setup();
      await expect(voidCharge(ctx, terminal, { ...input({ staff_id: undefined }), ...CANCEL })).rejects.toMatchObject({ code: 'invalid_staff', httpStatus: 403 });
      await expect(voidCharge(ctx, terminal, { ...input({ staff_id: '66666666-6666-4666-8666-666666666666' }), ...CANCEL })).rejects.toMatchObject({ code: 'invalid_staff', httpStatus: 403 });
      expect(store.rows).toHaveLength(0);
    });

    it('corrida: a criação gravou enquanto o bloqueio era pedido; valem as regras do encerramento (PIN errado não encerra)', async () => {
      const { ctx, store, calls } = setup();
      store.createdAgoMs = 1_000;
      await startCharge(ctx, terminal, input());
      await expect(voidCharge(ctx, terminal, { ...input(), ...OPERATOR, manager_pin: '0000' })).rejects.toMatchObject({ code: 'manager_denied', httpStatus: 403 });
      await expect(voidCharge(ctx, terminal, { ...input(), ...CANCEL })).rejects.toMatchObject({ code: 'too_early' });
      expect(store.rows[0]).toMatchObject({ status: 'at_terminal', cancel_requested_at: null });
      expect(calls.cancel).toHaveLength(0);
    });
  });

  describe('P1-02: um envio por vez (posse do envio)', () => {
    it('consulta com a primeira criação em andamento não chama o Mercado Pago; a aprovação da primeira fica gravada', async () => {
      let release: (o: PaymentTerminalChargeResult) => void = () => undefined;
      const { ctx, store, calls } = setup({ create: () => new Promise((resolve) => { release = resolve; }) });
      const first = startCharge(ctx, terminal, input());
      await new Promise((r) => setTimeout(r, 0));
      expect(calls.create).toHaveLength(1);
      // Duas consultas e um reenvio da criação no meio: só acompanham.
      expect((await pollCharge(ctx, store.rows[0]!)).status).toBe('PENDING');
      expect((await pollCharge(ctx, { ...store.rows[0]! })).status).toBe('PENDING');
      expect((await startCharge(ctx, terminal, input())).status).toBe('PENDING');
      expect(calls.create).toHaveLength(1);
      expect(store.rows[0]!.dispatch_attempts).toBe(1);
      release(approvedOrder());
      expect((await first).status).toBe('APPROVED');
      expect(store.rows[0]!.status).toBe('approved');
    });

    it('posse vencida sem resposta: a consulta repete com a mesma chave, uma vez só por posse', async () => {
      let n = 0;
      const { ctx, store, calls } = setup({ create: () => { n += 1; return n === 1 ? new Promise(() => undefined) : Promise.resolve(order()); } });
      void startCharge(ctx, terminal, input()); // a primeira chamada nunca volta (a função morreu no meio)
      await new Promise((r) => setTimeout(r, 0));
      store.nowMs += 29_000;
      expect((await pollCharge(ctx, store.rows[0]!)).status).toBe('PENDING');
      expect(calls.create).toHaveLength(1);
      store.nowMs += 2_000; // 31 s: posse vencida
      expect((await pollCharge(ctx, store.rows[0]!)).status).toBe('PENDING');
      expect(calls.create.map((c) => c.idempotencyKey)).toEqual([KEY, KEY]);
      expect(store.rows[0]).toMatchObject({ status: 'at_terminal', external_order_id: 'ORD01', dispatch_attempts: 2 });
    });

    it('o Mercado Pago respondeu sem resultado (5xx): a posse fica até vencer e só então a consulta repete com a mesma chave', async () => {
      let n = 0;
      const { ctx, store, calls } = setup({ create: async () => { n += 1; if (n === 1) throw new PaymentTerminalProviderError('unavailable', { httpStatus: 502, outcomeUnknown: true }); return order(); } });
      await startCharge(ctx, terminal, input());
      expect(store.rows[0]).toMatchObject({ status: 'creating', dispatch_attempts: 1 });
      // O 502 pode ter vindo de um intermediário com o pedido ainda sendo processado: nada por cima dele.
      expect((await pollCharge(ctx, store.rows[0]!)).status).toBe('PENDING');
      expect(calls.create).toHaveLength(1);
      store.nowMs += 31_000;
      expect((await pollCharge(ctx, store.rows[0]!)).status).toBe('PENDING');
      expect(calls.create.map((c) => c.idempotencyKey)).toEqual([KEY, KEY]);
      expect(store.rows[0]).toMatchObject({ external_order_id: 'ORD01', dispatch_attempts: 2 });
    });

    it('conflito de chave na repetição e depois a resposta válida da primeira: segue aguardando e termina aprovada, não em revisão manual', async () => {
      let release: (o: PaymentTerminalChargeResult) => void = () => undefined;
      let n = 0;
      const { ctx, store } = setup({
        create: () => {
          n += 1;
          if (n === 1) return new Promise((resolve) => { release = resolve; });
          return Promise.reject(new PaymentTerminalProviderError('idempotency_conflict', { httpStatus: 409 }));
        },
      });
      const first = startCharge(ctx, terminal, input());
      await new Promise((r) => setTimeout(r, 0));
      store.nowMs += 31_000; // a posse da primeira venceu com ela ainda pendurada
      expect((await pollCharge(ctx, store.rows[0]!)).status).toBe('PENDING');
      expect(store.rows[0]).toMatchObject({ status: 'creating', dispatch_attempts: 2, external_order_id: null });
      release(approvedOrder());
      expect((await first).status).toBe('APPROVED');
      expect(store.rows[0]).toMatchObject({ status: 'approved', external_order_id: 'ORD01' });
    });
  });

  describe('P1-03: encerramento registrado entre a posse e o envio', () => {
    it('primeiro envio: o encerramento chega depois da posse e antes do HTTP; nada é mandado e a cobrança encerra com prova', async () => {
      const { ctx, store, calls } = setup();
      store.afterClaim = (claimed) => {
        // Outra requisição registra o encerramento (por prazo) neste intervalo.
        store.write(store.rows.find((r) => r.id === claimed.id)!, { cancel_reason: 'timeout', cancel_requested_at: new Date(store.nowMs).toISOString() });
      };
      const reply = await startCharge(ctx, terminal, input());
      expect(store.count.beginDispatch).toBe(1); // a barreira foi consultada e barrou
      expect(calls.create).toHaveLength(0);
      expect(reply).toMatchObject({ status: 'DECLINED', reason: 'A cobrança não chegou à maquininha (nada foi cobrado).' });
      expect(store.rows[0]).toMatchObject({ status: 'cancelled', raw_status: 'voided_before_send', external_order_id: null });
    });

    it('o mesmo com o encerramento autorizado pelo gerente, pela função de verdade', async () => {
      const { ctx, store, calls } = setup();
      let during: Promise<unknown> = Promise.resolve();
      store.afterClaim = async (claimed) => {
        store.afterClaim = null;
        during = cancelCharge(ctx, claimed, OPERATOR);
        await during;
      };
      const reply = await startCharge(ctx, terminal, input());
      // Havia posse dada, mas nenhum envio tinha passado da barreira: o encerramento encerra com prova, e
      // quem tinha a posse é barrado e não manda nada.
      expect(await during).toMatchObject({ status: 'DECLINED', reason: 'A cobrança não chegou à maquininha (nada foi cobrado).' });
      expect(store.rows[0]!.dispatched_at).toBeNull();
      expect(calls.create).toHaveLength(0);
      expect(calls.cancel).toHaveLength(0);
      expect(reply.status).toBe('DECLINED');
      expect(store.rows[0]).toMatchObject({ status: 'cancelled', raw_status: 'voided_before_send', cancel_reason: 'operator' });
    });

    it('repetição: encerramento depois da posse; não manda de novo e o envio anterior continua desconhecido (revisão manual)', async () => {
      const { ctx, store, calls } = setup({ create: () => new Promise(() => undefined) });
      void startCharge(ctx, terminal, input()); // primeiro envio pendurado
      await new Promise((r) => setTimeout(r, 0));
      store.nowMs += 31_000;
      store.afterClaim = (claimed) => {
        store.write(store.rows.find((r) => r.id === claimed.id)!, { cancel_reason: 'timeout', cancel_requested_at: new Date(store.nowMs).toISOString() });
      };
      expect((await pollCharge(ctx, store.rows[0]!)).status).toBe('PENDING');
      expect(calls.create).toHaveLength(1);
      expect(store.rows[0]).toMatchObject({ status: 'creating', dispatch_attempts: 2 });
      store.afterClaim = null;
      // Encerramento com a segunda posse vencida: revisão manual, nunca recusa.
      store.nowMs += 31_000;
      expect(await cancelCharge(ctx, store.rows[0]!, CANCEL)).toMatchObject({ status: 'MANUAL_REVIEW', code: 'DISPATCH_UNKNOWN' });
      expect(calls.create).toHaveLength(1);
    });

    it('depois do pedido de encerramento ninguém ganha a posse', async () => {
      const { ctx, store, calls } = setup({ create: async () => unknown() });
      await startCharge(ctx, terminal, input());
      expect((await cancelCharge(ctx, store.rows[0]!, CANCEL)).status).toBe('PENDING'); // a posse do envio ainda vale
      store.nowMs += 600_000;
      expect(await store.claimDispatch(store.rows[0]!, 30_000)).toBeNull();
      expect(await store.beginDispatch(store.rows[0]!, 30_000, true)).toBe(0);
      expect((await pollCharge(ctx, store.rows[0]!)).status).toBe('MANUAL_REVIEW');
      expect(calls.create).toHaveLength(1);
    });
  });

  describe('P2-01: autorização do gerente idempotente', () => {
    it('o mesmo pedido autorizado dez vezes (PIN certo) grava um registro só e repete o pedido de cancelamento', async () => {
      const { ctx, store, calls } = setup();
      await startCharge(ctx, terminal, input());
      for (let i = 0; i < 10; i += 1) await cancelCharge(ctx, store.rows[0]!, OPERATOR);
      expect(store.audits.filter((a) => a.action === 'POINT_CHARGE_CANCELED')).toHaveLength(1);
      expect(store.rows[0]!.cancel_audit_id).toBe('audit-1');
      expect(calls.cancel).toHaveLength(10); // cada volta repete o pedido à maquininha, com a mesma chave de cancelamento
      expect(new Set(calls.cancel.map((c) => c.key))).toEqual(new Set([`${KEY}-cancel`]));
    });

    it('auditoria interna 2: já autorizado, o reenvio com PIN errado é 403 e não pede de novo o cancelamento ao Mercado Pago', async () => {
      const { ctx, store, calls } = setup();
      await startCharge(ctx, terminal, input());
      await cancelCharge(ctx, store.rows[0]!, OPERATOR);
      expect(calls.cancel).toHaveLength(1);
      await expect(cancelCharge(ctx, store.rows[0]!, { ...OPERATOR, manager_pin: '0000' })).rejects.toMatchObject({ code: 'manager_denied', httpStatus: 403 });
      expect(calls.cancel).toHaveLength(1);
      expect(store.audits.filter((a) => a.action === 'MANAGER_PIN_FAILED')).toHaveLength(1);
      expect(store.audits.filter((a) => a.action === 'POINT_CHARGE_CANCELED')).toHaveLength(1);
      expect(store.rows[0]!.cancel_audit_id).toBe('audit-1');
    });

    it('cobrança que vira aprovada antes da autorização: nenhum registro de encerramento, devolve a aprovação', async () => {
      const { ctx, store } = setup({ get: async () => approvedOrder() });
      await startCharge(ctx, terminal, input());
      const stale = { ...store.rows[0]! }; // lida "na maquininha"
      await pollCharge(ctx, store.rows[0]!); // outra consulta aprova
      expect(store.rows[0]!.status).toBe('approved');
      expect((await cancelCharge(ctx, stale, OPERATOR)).status).toBe('APPROVED');
      expect(store.audits).toHaveLength(0);
      expect(store.rows[0]).toMatchObject({ status: 'approved', cancel_reason: null });
    });
  });
});

describe('point-charge: auditoria r3, segunda revisão', () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const hang = <T,>() => new Promise<T>(() => undefined);
  /** Sem resposta: queda ou prazo estourado (o pedido pode estar sendo processado no Mercado Pago). */
  const netDown = () => new PaymentTerminalProviderError('timeout', { outcomeUnknown: true });
  /** O Mercado Pago respondeu, sem resultado. */
  const http5xx = () => new PaymentTerminalProviderError('unavailable', { httpStatus: 502, outcomeUnknown: true });
  const busy = () => new PaymentTerminalProviderError('terminal_busy', { httpStatus: 409 });

  describe('A. encerramento gravado entre a posse e a barreira', () => {
    it.each([['por prazo', CANCEL], ['pelo gerente', OPERATOR]])('%s: nenhuma chamada de criação; a cobrança encerra como nunca enviada', async (_n, body) => {
      const { ctx, store, calls } = setup();
      let during: unknown;
      store.afterClaim = async (claimed) => {
        store.afterClaim = null;
        during = await cancelCharge(ctx, claimed, body);
      };
      const reply = await startCharge(ctx, terminal, input());
      expect(during).toMatchObject({ status: 'DECLINED', reason: 'A cobrança não chegou à maquininha (nada foi cobrado).' });
      expect(reply).toMatchObject({ status: 'DECLINED', reason: 'A cobrança não chegou à maquininha (nada foi cobrado).' });
      expect(store.count.beginDispatch).toBe(1);
      expect(calls.create).toHaveLength(0);
      expect(calls.cancel).toHaveLength(0);
      expect(store.rows[0]).toMatchObject({ status: 'cancelled', raw_status: 'voided_before_send', dispatched_at: null, external_order_id: null });
    });

    it('a barreira é a última coisa antes da chamada: nenhuma leitura ou gravação no banco entre ela e o HTTP', async () => {
      const { ctx, store, calls } = setup({
        create: async () => {
          seenAtCreate = { ...store.count };
          return order();
        },
      });
      let seenAtBegin: typeof store.count = {};
      let seenAtCreate: typeof store.count = {};
      store.afterBegin = () => { seenAtBegin = { ...store.count }; };
      await startCharge(ctx, terminal, input());
      expect(calls.create).toHaveLength(1);
      expect(seenAtCreate).toEqual(seenAtBegin);
    });
  });

  describe('B. encerramento gravado depois da barreira, com a ordem a caminho', () => {
    it('a ordem que chega é ligada à cobrança, cancelada no Mercado Pago e o resultado vem da reconsulta', async () => {
      let cancelled = false;
      const { ctx, store, calls } = setup({
        get: async () => (cancelled ? order({ status: 'cancelled', rawStatus: 'canceled' }) : order()),
        cancel: async () => { cancelled = true; },
      });
      let during: unknown;
      store.afterBegin = async (row) => {
        store.afterBegin = null;
        during = await cancelCharge(ctx, row, CANCEL);
      };
      const reply = await startCharge(ctx, terminal, input());
      expect(during).toMatchObject({ status: 'PENDING' }); // envio em andamento: o encerramento só espera
      expect(calls.create).toHaveLength(1);
      expect(calls.cancel).toEqual([{ id: 'ORD01', key: `${KEY}-cancel` }]);
      expect(calls.get).toEqual(['ORD01']);
      expect(reply.status).toBe('DECLINED');
      expect(store.rows[0]).toMatchObject({ status: 'cancelled', external_order_id: 'ORD01', cancel_reason: 'timeout' });
    });

    it('se o Mercado Pago diz que foi paga, fica aprovada (o encerramento não desfaz pagamento)', async () => {
      const { ctx, store, calls } = setup({
        get: async () => approvedOrder(),
        cancel: async () => { throw new PaymentTerminalProviderError('not_cancellable', { httpStatus: 409 }); },
      });
      store.afterBegin = async (row) => {
        store.afterBegin = null;
        await cancelCharge(ctx, row, OPERATOR);
      };
      const reply = await startCharge(ctx, terminal, input());
      expect(calls.cancel).toHaveLength(1);
      expect(reply).toMatchObject({ status: 'APPROVED', nsu: '123456789' });
      expect(store.rows[0]).toMatchObject({ status: 'approved', external_order_id: 'ORD01', cancel_reason: 'operator' });
    });
  });

  describe('C. envio em andamento sem resposta e encerramento pedido', () => {
    it.each([['por prazo', CANCEL, 'timeout'], ['pelo gerente (PIN certo)', OPERATOR, 'operator']])(
      '%s: espera enquanto a posse vale; vencida, revisão manual (nunca recusa); a resposta atrasada liga a ordem e a conferência aprova',
      async (_n, body, reason) => {
        let release: (o: PaymentTerminalChargeResult) => void = () => undefined;
        const { ctx, store, calls } = setup({ create: () => new Promise((resolve) => { release = resolve; }), get: async () => approvedOrder() });
        const creating = startCharge(ctx, terminal, input());
        await tick();
        expect(calls.create).toHaveLength(1);
        store.nowMs += 29_000;
        expect((await cancelCharge(ctx, store.rows[0]!, body)).status).toBe('PENDING');
        expect(store.rows[0]).toMatchObject({ status: 'creating', cancel_reason: reason });
        expect((await pollCharge(ctx, store.rows[0]!)).status).toBe('PENDING');
        store.nowMs += 2_000; // 31 s depois da barreira: posse vencida pelo relógio do banco
        const settled = await cancelCharge(ctx, store.rows[0]!, body);
        expect(settled).toMatchObject({ status: 'MANUAL_REVIEW', code: 'DISPATCH_UNKNOWN' });
        expect(store.rows[0]).toMatchObject({ status: 'manual_review', raw_status_detail: 'DISPATCH_UNKNOWN', external_order_id: null });
        // Não é final: segue reservando o saldo da conta. E nada mais é mandado.
        expect((await store.listOpenForOrder(ORDER)).map((r) => r.idempotency_key)).toEqual([KEY]);
        expect((await pollCharge(ctx, store.rows[0]!)).status).toBe('MANUAL_REVIEW');
        expect(calls.create).toHaveLength(1);
        // A resposta válida do primeiro envio chega depois: a ordem é ligada à cobrança em revisão manual.
        release(approvedOrder());
        expect((await creating).status).toBe('MANUAL_REVIEW');
        expect(store.rows[0]).toMatchObject({ status: 'manual_review', external_order_id: 'ORD01', cancel_reason: reason });
        expect(store.count.attachOrder).toBe(1);
        // r5: só a conferência do gerente, lendo o Mercado Pago, tira da revisão.
        expect(await reconcileCharge(ctx, { idempotency_key: KEY, staff_id: STAFF, manager_pin: MANAGER_PIN, reason_text: 'conferido no app do Mercado Pago' })).toMatchObject({ status: 'APPROVED' });
        expect(store.rows[0]).toMatchObject({ status: 'approved', external_order_id: 'ORD01', external_payment_id: '123456789', cancel_reason: reason });
      },
    );

    it('resposta atrasada ainda "na maquininha": a ordem é ligada e cancelada no Mercado Pago, sem ficar esperando cartão', async () => {
      let release: (o: PaymentTerminalChargeResult) => void = () => undefined;
      let cancelled = false;
      const { ctx, store, calls } = setup({
        create: () => new Promise((resolve) => { release = resolve; }),
        get: async () => (cancelled ? order({ status: 'cancelled', rawStatus: 'canceled' }) : order()),
        cancel: async () => { cancelled = true; },
      });
      const creating = startCharge(ctx, terminal, input());
      await tick();
      store.nowMs += 31_000;
      expect((await cancelCharge(ctx, store.rows[0]!, CANCEL)).status).toBe('MANUAL_REVIEW');
      release(order());
      expect((await creating).status).toBe('MANUAL_REVIEW');
      expect(calls.cancel).toEqual([{ id: 'ORD01', key: `${KEY}-cancel` }]);
      expect(store.rows[0]).toMatchObject({ status: 'manual_review', external_order_id: 'ORD01' });
      // r5: o cancelamento confirmado no Mercado Pago libera só pela conferência.
      expect(await reconcileCharge(ctx, { idempotency_key: KEY, staff_id: STAFF, manager_pin: MANAGER_PIN, reason_text: 'conferido no app do Mercado Pago' })).toMatchObject({ status: 'DECLINED' });
      expect(store.rows[0]).toMatchObject({ status: 'cancelled', external_order_id: 'ORD01' });
    });

    it('consulta de status (sem novo pedido de encerramento) também leva à revisão manual, sem criar nada', async () => {
      const { ctx, store, calls } = setup({ create: async () => { throw netDown(); } });
      await startCharge(ctx, terminal, input());
      expect((await cancelCharge(ctx, store.rows[0]!, CANCEL)).status).toBe('PENDING');
      expect((await pollCharge(ctx, store.rows[0]!)).status).toBe('PENDING');
      store.nowMs += 31_000;
      expect(await pollCharge(ctx, store.rows[0]!)).toMatchObject({ status: 'MANUAL_REVIEW', code: 'DISPATCH_UNKNOWN' });
      expect(calls.create).toHaveLength(1);
      expect(store.count.claimDispatch).toBe(1); // depois do pedido de encerramento nem se pede a posse
    });
  });

  describe('D. consultas simultâneas e repetição', () => {
    it('duas consultas ao mesmo tempo: exatamente uma criação; a outra só acompanha', async () => {
      let n = 0;
      const { ctx, store, calls } = setup({ create: async () => { n += 1; if (n === 1) throw http5xx(); await tick(); return order(); } });
      await startCharge(ctx, terminal, input()); // respondeu 5xx: resultado desconhecido, a posse fica
      store.nowMs += 31_000; // posse vencida: as três chegam juntas e só uma repete
      const stale = { ...store.rows[0]! };
      const replies = await Promise.all([pollCharge(ctx, { ...stale }), pollCharge(ctx, { ...stale }), startCharge(ctx, terminal, input())]);
      expect(calls.create).toHaveLength(2);
      expect(replies.map((r) => r.status)).toEqual(['PENDING', 'PENDING', 'PENDING']);
      expect(store.rows[0]).toMatchObject({ status: 'at_terminal', external_order_id: 'ORD01', dispatch_attempts: 2 });
    });

    it('a repetição passa pela barreira como repetição (2) e manda o MESMO pedido com a MESMA chave', async () => {
      let n = 0;
      const kinds: number[] = [];
      const { ctx, store, calls } = setup({ create: () => { n += 1; return n === 1 ? hang() : Promise.resolve(order()); } });
      store.afterBegin = (_r, kind) => { kinds.push(kind); };
      void startCharge(ctx, terminal, input());
      await tick();
      const firstDispatch = store.rows[0]!.dispatched_at;
      store.nowMs += 31_000;
      await pollCharge(ctx, store.rows[0]!);
      expect(kinds).toEqual([1, 2]);
      expect(calls.create[1]).toEqual(calls.create[0]);
      expect(store.rows[0]!.dispatched_at).toBe(firstDispatch); // a hora do primeiro envio não muda
    });

    it('F5: 409 desconhecido no primeiro envio (outcomeUnknown) não vira recusa: segue creating, nada liberado', async () => {
      const { ctx, store } = setup({ create: async () => { throw new PaymentTerminalProviderError('invalid_request', { httpStatus: 409, outcomeUnknown: true, detail: 'unknown_conflict' }); } });
      const reply = await startCharge(ctx, terminal, input());
      expect(reply.status).not.toBe('DECLINED');
      expect(store.rows[0]).toMatchObject({ status: 'creating' });
      expect(store.rows[0]!.dispatched_at).not.toBeNull();
    });

    it('recusa "definitiva" na repetição: não vira recusa, não devolve a posse, e a consulta seguinte não manda nada', async () => {
      let n = 0;
      const { ctx, store, calls } = setup({ create: async () => { n += 1; if (n === 1) throw netDown(); throw busy(); } });
      await startCharge(ctx, terminal, input());
      store.nowMs += 31_000;
      expect((await pollCharge(ctx, store.rows[0]!)).status).toBe('PENDING');
      expect(calls.create).toHaveLength(2);
      expect(store.rows[0]).toMatchObject({ status: 'creating', dispatch_attempts: 2, raw_status: null });
      expect(store.count.rejectFirstSend).toBeUndefined();
      store.nowMs += 2_000;
      expect((await pollCharge(ctx, store.rows[0]!)).status).toBe('PENDING');
      expect(calls.create).toHaveLength(2); // posse da repetição ainda em vigor: nenhum POST a cada consulta
      store.nowMs += 29_000;
      await pollCharge(ctx, store.rows[0]!);
      expect(calls.create).toHaveLength(3);
    });

    it('recusa definitiva no PRIMEIRO envio: recusada com o motivo, sem nova tentativa', async () => {
      const { ctx, store, calls } = setup({ create: async () => { throw busy(); } });
      const reply = await startCharge(ctx, terminal, input());
      expect(reply.status).toBe('DECLINED');
      expect(store.rows[0]).toMatchObject({ status: 'rejected', raw_status: 'create_failed:terminal_busy', dispatch_attempts: 1 });
      store.nowMs += 600_000;
      expect((await pollCharge(ctx, store.rows[0]!)).status).toBe('DECLINED');
      expect(calls.create).toHaveLength(1);
    });

    it('recusa definitiva do primeiro envio que perdeu a posse no meio não grava recusa', async () => {
      // A chamada demorou mais que a posse e outra consulta já repetiu: a recusa deste pedido não prova mais nada.
      let fail: (e: unknown) => void = () => undefined;
      let n = 0;
      const { ctx, store } = setup({ create: () => { n += 1; return n === 1 ? new Promise((_r, reject) => { fail = reject; }) : hang(); } });
      const first = startCharge(ctx, terminal, input());
      await tick();
      store.nowMs += 31_000;
      void pollCharge(ctx, store.rows[0]!); // repetição em andamento (posse 2)
      await tick();
      fail(busy());
      expect((await first).status).toBe('PENDING');
      expect(store.rows[0]).toMatchObject({ status: 'creating', dispatch_attempts: 2 });
    });
  });

  describe('E. resultado desconhecido', () => {
    it('sem resposta (queda/prazo): a posse fica; nenhuma chamada até ela vencer', async () => {
      const { ctx, store, calls } = setup({ create: async () => { throw netDown(); } });
      await startCharge(ctx, terminal, input());
      for (const step of [1_000, 10_000, 18_000]) {
        store.nowMs += step;
        expect((await pollCharge(ctx, store.rows[0]!)).status).toBe('PENDING');
        expect(calls.create).toHaveLength(1);
      }
      store.nowMs += 2_000; // 31 s
      await pollCharge(ctx, store.rows[0]!);
      expect(calls.create.map((c) => c.idempotencyKey)).toEqual([KEY, KEY]);
    });

    it.each([
      ['502', () => http5xx()],
      ['408', () => new PaymentTerminalProviderError('timeout', { httpStatus: 408, outcomeUnknown: true })],
      ['429', () => new PaymentTerminalProviderError('unavailable', { httpStatus: 429, outcomeUnknown: true })],
    ] as const)('auditoria r3, terceira revisão: resposta %s sem resultado não devolve a posse nem gasta tentativas; repete só depois que ela vence', async (_label, fail) => {
      const { ctx, store, calls } = setup({ create: async () => { throw fail(); } });
      await startCharge(ctx, terminal, input());
      const lease = store.rows[0]!.dispatch_lease_until;
      // 20 consultas em 29 s (o app consulta a cada 2 s; aqui com folga): nenhuma chamada, nenhuma posse nova.
      for (let i = 0; i < 20; i += 1) {
        store.nowMs += 1_450;
        expect((await pollCharge(ctx, store.rows[0]!)).status).toBe('PENDING');
      }
      expect(calls.create).toHaveLength(1);
      expect(store.rows[0]).toMatchObject({ status: 'creating', dispatch_attempts: 1, dispatch_lease_until: lease });
      store.nowMs += 2_000; // 31 s
      await pollCharge(ctx, store.rows[0]!);
      expect(calls.create.map((c) => c.idempotencyKey)).toEqual([KEY, KEY]);
      expect(calls.create[1]).toEqual(calls.create[0]);
      expect(store.rows[0]!.dispatch_attempts).toBe(2);
    });

    it('conflito de idempotência: segue "creating", sem revisão manual, sem recusa e sem devolver a posse', async () => {
      const { ctx, store, calls } = setup({ create: async () => { throw new PaymentTerminalProviderError('idempotency_conflict', { httpStatus: 409 }); } });
      expect((await startCharge(ctx, terminal, input())).status).toBe('PENDING');
      expect(store.rows[0]).toMatchObject({ status: 'creating', raw_status: null, raw_status_detail: null });
      expect(store.count.rejectFirstSend).toBeUndefined();
      expect((await pollCharge(ctx, store.rows[0]!)).status).toBe('PENDING');
      expect(calls.create).toHaveLength(1);
    });

    it('erro que não é do provedor (exceção qualquer) também não vira recusa nem devolve a posse', async () => {
      const { ctx, store, calls } = setup({ create: async () => { throw new TypeError('fetch failed'); } });
      expect((await startCharge(ctx, terminal, input())).status).toBe('PENDING');
      expect(store.rows[0]!.status).toBe('creating');
      await pollCharge(ctx, store.rows[0]!);
      expect(calls.create).toHaveLength(1);
    });
  });

  describe('F. limite de envios', () => {
    it('depois de 8 posses nada mais é mandado; o encerramento por prazo leva à revisão manual', async () => {
      const { ctx, store, calls } = setup({ create: async () => { throw netDown(); } });
      await startCharge(ctx, terminal, input());
      for (let i = 0; i < 12; i += 1) {
        store.nowMs += 31_000;
        expect((await pollCharge(ctx, store.rows[0]!)).status).toBe('PENDING');
      }
      expect(calls.create).toHaveLength(8);
      expect(new Set(calls.create.map((c) => c.idempotencyKey))).toEqual(new Set([KEY]));
      expect(store.rows[0]).toMatchObject({ status: 'creating', dispatch_attempts: 8 });
      store.nowMs += 31_000;
      expect(await cancelCharge(ctx, store.rows[0]!, CANCEL)).toMatchObject({ status: 'MANUAL_REVIEW', code: 'DISPATCH_UNKNOWN' });
      expect(calls.create).toHaveLength(8);
    });
  });

  describe('G. falha do banco depois da resposta do Mercado Pago', () => {
    it('ligar a ordem falha uma vez: tenta de novo e a ordem não se perde', async () => {
      const { ctx, store, calls } = setup();
      store.failOnce('attachOrder');
      expect((await startCharge(ctx, terminal, input())).status).toBe('PENDING');
      expect(store.count.attachOrder).toBe(2);
      expect(store.rows[0]).toMatchObject({ status: 'at_terminal', external_order_id: 'ORD01' });
      expect(calls.create).toHaveLength(1);
    });

    it('ligar a ordem falha duas vezes: erro interno, a posse fica e a repetição com a mesma chave recupera a ordem', async () => {
      const { ctx, store, calls } = setup();
      store.failOnce('attachOrder', 2);
      await expect(startCharge(ctx, terminal, input())).rejects.toThrow('banco fora do ar');
      expect(store.rows[0]).toMatchObject({ status: 'creating', external_order_id: null, dispatch_attempts: 1 });
      // A ordem ficou viva na maquininha sem registro: o cancelamento foi pedido ao Mercado Pago.
      expect(calls.cancel).toEqual([{ id: 'ORD01', key: `${KEY}-cancel` }]);
      expect((await pollCharge(ctx, store.rows[0]!)).status).toBe('PENDING');
      expect(calls.create).toHaveLength(1); // posse em vigor
      store.nowMs += 31_000;
      expect((await pollCharge(ctx, store.rows[0]!)).status).toBe('PENDING');
      expect(calls.create.map((c) => c.idempotencyKey)).toEqual([KEY, KEY]);
      expect(store.rows[0]).toMatchObject({ status: 'at_terminal', external_order_id: 'ORD01' });
    });

    it('a barreira falha (banco fora): nenhuma chamada ao Mercado Pago', async () => {
      const { ctx, store, calls } = setup();
      store.failOnce('beginDispatch');
      await expect(startCharge(ctx, terminal, input())).rejects.toThrow('banco fora do ar');
      expect(calls.create).toHaveLength(0);
      expect(store.rows[0]).toMatchObject({ status: 'creating', dispatched_at: null });
    });

    it('a ordem já ligada não é trocada por outra: ID diferente vira revisão manual', async () => {
      let n = 0;
      let release: (o: PaymentTerminalChargeResult) => void = () => undefined;
      const { ctx, store } = setup({ create: () => { n += 1; return n === 1 ? new Promise((resolve) => { release = resolve; }) : Promise.resolve(order({ externalOrderId: 'ORD02' })); } });
      const first = startCharge(ctx, terminal, input());
      await tick();
      store.nowMs += 31_000;
      await pollCharge(ctx, store.rows[0]!); // a repetição ligou ORD02
      expect(store.rows[0]!.external_order_id).toBe('ORD02');
      release(order());
      expect((await first).status).toBe('MANUAL_REVIEW');
      expect(store.rows[0]).toMatchObject({ status: 'manual_review', external_order_id: 'ORD02', raw_status_detail: 'ORDER_ID_CHANGED' });
    });

    it('auditoria r3, terceira revisão: segunda ordem para a mesma chave é cancelada no Mercado Pago e a revisão manual não é desfeita por consulta', async () => {
      let n = 0;
      let release: (o: PaymentTerminalChargeResult) => void = () => undefined;
      const { ctx, store, calls } = setup({
        create: () => { n += 1; return n === 1 ? new Promise((resolve) => { release = resolve; }) : Promise.resolve(order({ externalOrderId: 'ORD02' })); },
        // O Mercado Pago diz que a ORD02 foi paga: mesmo assim, com duas ordens, alguém tem de conferir.
        get: async () => approvedOrder({ externalOrderId: 'ORD02' }),
      });
      const first = startCharge(ctx, terminal, input());
      await tick();
      store.nowMs += 31_000;
      await pollCharge(ctx, store.rows[0]!); // a repetição ligou ORD02
      release(order()); // a resposta atrasada traz ORD01
      expect((await first).status).toBe('MANUAL_REVIEW');
      expect(calls.cancel).toEqual([{ id: 'ORD01', key: `${KEY}-cancel-2` }]);
      expect(store.rows[0]).toMatchObject({ status: 'manual_review', external_order_id: 'ORD02', raw_status: 'second_order:ORD01', raw_status_detail: 'ORDER_ID_CHANGED' });
      for (let i = 0; i < 3; i += 1) {
        expect(await pollCharge(ctx, store.rows[0]!)).toMatchObject({ status: 'MANUAL_REVIEW', code: 'ORDER_ID_CHANGED' });
      }
      expect(await startCharge(ctx, terminal, input())).toMatchObject({ status: 'MANUAL_REVIEW', code: 'ORDER_ID_CHANGED' });
      expect(store.rows[0]).toMatchObject({ status: 'manual_review', raw_status: 'second_order:ORD01', raw_status_detail: 'ORDER_ID_CHANGED', external_payment_id: null });
      // O cancelamento da ordem solta falhar não muda o resultado.
    });

    it('auditoria r3, terceira revisão: falha ao cancelar a segunda ordem não derruba a resposta (segue revisão manual)', async () => {
      let n = 0;
      let release: (o: PaymentTerminalChargeResult) => void = () => undefined;
      const { ctx, store } = setup({
        create: () => { n += 1; return n === 1 ? new Promise((resolve) => { release = resolve; }) : Promise.resolve(order({ externalOrderId: 'ORD02' })); },
        cancel: async () => { throw new PaymentTerminalProviderError('not_cancellable', { httpStatus: 409 }); },
      });
      const first = startCharge(ctx, terminal, input());
      await tick();
      store.nowMs += 31_000;
      await pollCharge(ctx, store.rows[0]!);
      release(order());
      expect(await first).toMatchObject({ status: 'MANUAL_REVIEW', code: 'ORDER_ID_CHANGED' });
    });
  });

  describe('H. encerramento por prazo pelo relógio do banco', () => {
    it('cedo demais (409) até 120 s da hora gravada; nada é gravado nem pedido ao Mercado Pago', async () => {
      const { ctx, store, calls } = setup();
      store.createdAgoMs = 0;
      await startCharge(ctx, terminal, input());
      for (const at of [0, 60_000, 119_999]) {
        store.nowMs = Date.parse(store.rows[0]!.created_at) + at;
        await expect(cancelCharge(ctx, store.rows[0]!, CANCEL)).rejects.toMatchObject({ code: 'too_early', httpStatus: 409 });
      }
      expect(store.rows[0]).toMatchObject({ cancel_requested_at: null, cancel_reason: null });
      expect(calls.cancel).toHaveLength(0);
      store.nowMs += 1;
      expect((await cancelCharge(ctx, store.rows[0]!, CANCEL)).status).toBe('PENDING');
      expect(store.rows[0]!.cancel_requested_at).toBe(new Date(store.nowMs).toISOString());
    });

    it('dois encerramentos por prazo ao mesmo tempo: os dois respondem, um pedido só fica gravado', async () => {
      let cancelled = false;
      const { ctx, store, calls } = setup({
        get: async () => (cancelled ? order({ status: 'cancelled', rawStatus: 'canceled' }) : order()),
        cancel: async () => { await tick(); cancelled = true; },
      });
      await startCharge(ctx, terminal, input());
      const stale = { ...store.rows[0]! };
      const replies = await Promise.all([cancelCharge(ctx, { ...stale }, CANCEL), cancelCharge(ctx, { ...stale }, CANCEL)]);
      expect(replies.map((r) => r.status)).toEqual(['DECLINED', 'DECLINED']);
      expect(store.rows[0]).toMatchObject({ status: 'cancelled', cancel_reason: 'timeout' });
      expect(calls.create).toHaveLength(1);
    });

    it('dois encerramentos ao mesmo tempo com o envio em andamento: os dois esperam, sem erro e sem criar', async () => {
      const { ctx, store, calls } = setup({ create: () => hang() });
      void startCharge(ctx, terminal, input());
      await tick();
      const stale = { ...store.rows[0]! };
      const replies = await Promise.all([cancelCharge(ctx, { ...stale }, CANCEL), cancelCharge(ctx, { ...stale }, OPERATOR), cancelCharge(ctx, { ...stale }, CANCEL)]);
      expect(replies.map((r) => r.status)).toEqual(['PENDING', 'PENDING', 'PENDING']);
      expect(calls.create).toHaveLength(1);
      expect(store.rows[0]).toMatchObject({ status: 'creating', cancel_reason: 'operator' });
    });

    it('encerrar nunca manda criação, em nenhum estado sem ordem', async () => {
      const { ctx, store, calls } = setup({ create: async () => { throw http5xx(); } });
      await startCharge(ctx, terminal, input()); // posse devolvida: uma consulta repetiria
      store.nowMs += 600_000;
      expect((await cancelCharge(ctx, store.rows[0]!, CANCEL)).status).toBe('MANUAL_REVIEW');
      await cancelCharge(ctx, store.rows[0]!, OPERATOR);
      await voidCharge(ctx, terminal, { ...input(), ...CANCEL });
      expect(calls.create).toHaveLength(1);
    });
  });

  describe('I. bloqueio preventivo: quem responde por ele', () => {
    it('sem operador: 403 e a função do bloqueio nem é chamada', async () => {
      const { ctx, store } = setup();
      for (const staff of [undefined, null]) {
        await expect(voidCharge(ctx, terminal, { ...input({ staff_id: staff }), ...CANCEL })).rejects.toMatchObject({ code: 'invalid_staff', httpStatus: 403 });
      }
      expect(store.count.insertVoid).toBeUndefined();
      expect(store.rows).toHaveLength(0);
      expect(store.audits).toHaveLength(0);
    });

    it('pedido "pelo operador" sem cobrança gravada: 404 e a função do bloqueio não é chamada', async () => {
      const { ctx, store } = setup();
      await expect(voidCharge(ctx, terminal, { ...input(), ...OPERATOR })).rejects.toMatchObject({ code: 'not_found', httpStatus: 404 });
      expect(store.count.insertVoid).toBeUndefined();
      expect(store.count.authorizeCancel).toBeUndefined();
      expect(store.rows).toHaveLength(0);
    });

    it('com operador da loja: a função é chamada uma vez e grava o bloqueio com a hora do banco', async () => {
      const { ctx, store } = setup();
      await voidCharge(ctx, terminal, { ...input(), ...CANCEL });
      expect(store.count.insertVoid).toBe(1);
      expect(store.rows[0]).toMatchObject({ status: 'cancelled', raw_status: 'voided_before_send', cancel_reason: 'void', cancel_requested_at: new Date(store.nowMs).toISOString() });
    });
  });

  describe('J. cobrança que terminou sem a ordem que chegou depois', () => {
    it('a ordem atrasada é cancelada no Mercado Pago (não fica esperando cartão) e a cobrança não muda', async () => {
      const { ctx, store, calls } = setup();
      store.afterBegin = (row) => {
        // Estado que as regras não deixam acontecer; se acontecer, a ordem não pode ficar solta na maquininha.
        Object.assign(store.rows.find((r) => r.id === row.id)!, { status: 'cancelled', raw_status: 'voided_before_send' });
      };
      const reply = await startCharge(ctx, terminal, input());
      expect(reply.status).toBe('DECLINED');
      expect(calls.cancel).toEqual([{ id: 'ORD01', key: `${KEY}-cancel` }]);
      expect(store.rows[0]).toMatchObject({ status: 'cancelled', raw_status: 'voided_before_send', external_order_id: null });
      expect(calls.get).toHaveLength(0);
    });

    it('cobrança já aprovada com a mesma ordem: nada é cancelado', async () => {
      const { ctx, store, calls } = setup({ create: async () => approvedOrder() });
      store.afterBegin = (row) => {
        Object.assign(store.rows.find((r) => r.id === row.id)!, { status: 'approved', external_order_id: 'ORD01', external_payment_id: '123456789', authorization_code: 'A1B2C3', card_brand: 'MASTERCARD', paid_amount_cents: 2450 });
      };
      expect((await startCharge(ctx, terminal, input())).status).toBe('APPROVED');
      expect(calls.cancel).toHaveLength(0);
    });
  });

  describe('auditoria r3, terceira revisão: a barreira demorou a responder', () => {
    /** Relógio local de mentira: cada leitura devolve o próximo valor da lista (o último se repete). */
    const clock = (...values: number[]) => {
      let i = 0;
      return () => values[Math.min(i++, values.length - 1)]!;
    };

    it('resposta da barreira além do limite: nenhuma chamada ao Mercado Pago, segue PENDING', async () => {
      const { ctx, store, calls } = setup();
      ctx.monotonicMs = clock(1_000, 1_000 + DISPATCH_START_LIMIT_MS + 1);
      expect((await startCharge(ctx, terminal, input())).status).toBe('PENDING');
      expect(calls.create).toHaveLength(0);
      // A barreira passou (o envio conta como iniciado), então a cobrança é resultado desconhecido.
      expect(store.rows[0]).toMatchObject({ status: 'creating', dispatch_attempts: 1, external_order_id: null });
      expect(store.rows[0]!.dispatched_at).not.toBeNull();
      // Com a posse em vigor ninguém manda.
      ctx.monotonicMs = clock(0, 0);
      expect((await pollCharge(ctx, store.rows[0]!)).status).toBe('PENDING');
      expect(calls.create).toHaveLength(0);
    });

    it('depois dela, a repetição que recebe recusa "definitiva" não vira recusa; com encerramento, revisão manual', async () => {
      const { ctx, store, calls } = setup({ create: async () => { throw new PaymentTerminalProviderError('terminal_busy', { httpStatus: 409 }); } });
      ctx.monotonicMs = clock(0, DISPATCH_START_LIMIT_MS + 5_000);
      expect((await startCharge(ctx, terminal, input())).status).toBe('PENDING');
      expect(calls.create).toHaveLength(0);
      ctx.monotonicMs = clock(0, 0);
      store.nowMs += 31_000;
      expect((await pollCharge(ctx, store.rows[0]!)).status).toBe('PENDING');
      expect(calls.create).toHaveLength(1);
      expect(store.rows[0]).toMatchObject({ status: 'creating', dispatch_attempts: 2 });
      expect(store.count.rejectFirstSend).toBeUndefined();
      store.nowMs += 31_000;
      expect(await cancelCharge(ctx, store.rows[0]!, CANCEL)).toMatchObject({ status: 'MANUAL_REVIEW', code: 'DISPATCH_UNKNOWN' });
    });

    it('encerramento pedido enquanto a barreira demorava: nada é mandado e, vencida a posse, revisão manual (nunca recusa)', async () => {
      const { ctx, store, calls } = setup();
      ctx.monotonicMs = clock(0, DISPATCH_START_LIMIT_MS + 1);
      store.afterBegin = async () => { await store.authorizeCancel({ idempotency_key: KEY, performed_by: STAFF, manager_pin: MANAGER_PIN, reason: 'cliente desistiu' }); };
      expect((await startCharge(ctx, terminal, input())).status).toBe('PENDING');
      store.nowMs += 31_000;
      expect(await pollCharge(ctx, store.rows[0]!)).toMatchObject({ status: 'MANUAL_REVIEW', code: 'DISPATCH_UNKNOWN' });
      expect(calls.create).toHaveLength(0);
    });

    it('dentro do limite (exatamente nele): manda normalmente', async () => {
      const { ctx, store, calls } = setup();
      ctx.monotonicMs = clock(500, 500 + DISPATCH_START_LIMIT_MS);
      expect((await startCharge(ctx, terminal, input())).status).toBe('PENDING');
      expect(calls.create).toHaveLength(1);
      expect(store.rows[0]).toMatchObject({ status: 'at_terminal', external_order_id: 'ORD01' });
    });

    it('sem relógio injetado usa o do ambiente e manda', async () => {
      const { ctx, calls } = setup();
      await startCharge(ctx, terminal, input());
      expect(calls.create).toHaveLength(1);
    });
  });

  describe('auditoria r3, terceira revisão: texto do Mercado Pago maior que a coluna', () => {
    const long = (n: number) => 'x'.repeat(n);

    it('raw_status e raw_status_detail são cortados em 50 e 80; a criação e as consultas não quebram', async () => {
      const { ctx, store } = setup({
        create: async () => order({ rawStatus: long(51), rawStatusDetail: long(200) }),
        get: async () => order({ status: 'expired', rawStatus: long(300), rawStatusDetail: long(81) }),
      });
      expect((await startCharge(ctx, terminal, input())).status).toBe('PENDING');
      expect(store.rows[0]).toMatchObject({ status: 'at_terminal', raw_status: long(50), raw_status_detail: long(80) });
      expect((await pollCharge(ctx, store.rows[0]!)).status).toBe('DECLINED');
      expect(store.rows[0]).toMatchObject({ status: 'expired', raw_status: long(50), raw_status_detail: long(80) });
    });

    it('no limite exato (50 e 80) nada é cortado; nulo segue nulo', async () => {
      const { ctx, store } = setup({ create: async () => order({ rawStatus: long(50), rawStatusDetail: long(80) }), get: async () => order({ rawStatus: 'at_terminal', rawStatusDetail: null }) });
      await startCharge(ctx, terminal, input());
      expect(store.rows[0]).toMatchObject({ raw_status: long(50), raw_status_detail: long(80) });
      await pollCharge(ctx, store.rows[0]!);
      expect(store.rows[0]).toMatchObject({ raw_status: 'at_terminal', raw_status_detail: null });
    });

    it('ID de ordem com outra, comprido: a revisão manual grava cortado e não quebra', async () => {
      const { ctx, store } = setup({ get: async () => order({ externalOrderId: 'ORD02', rawStatus: long(120) }) });
      await startCharge(ctx, terminal, input());
      expect(await pollCharge(ctx, store.rows[0]!)).toMatchObject({ status: 'MANUAL_REVIEW', code: 'ORDER_ID_CHANGED' });
      expect(store.rows[0]!.raw_status).toBe(long(50));
    });

    it('o banco de mentira recusa texto maior que a coluna, como o VARCHAR', async () => {
      const { ctx, store } = setup();
      await startCharge(ctx, terminal, input());
      expect(() => store.write(store.rows[0]!, { raw_status: long(51) })).toThrow('too long');
      expect(() => store.write(store.rows[0]!, { raw_status_detail: long(81) })).toThrow('too long');
    });
  });

  describe('auditoria r3, terceira revisão: cobrança antiga largada na mesma conta', () => {
    const NEW = 'nova-chave';
    const cancelled = () => order({ status: 'cancelled', rawStatus: 'canceled', rawStatusDetail: 'canceled' });

    it('na maquininha há mais de 2 min: o servidor pede o cancelamento; confirmado, o saldo libera e a nova abre', async () => {
      let stopped = false;
      let n = 0;
      const { ctx, store, calls } = setup({
        create: async () => { n += 1; return n === 1 ? order() : order({ externalOrderId: 'ORD-NEW', externalReference: NEW }); },
        cancel: async () => { stopped = true; },
        get: async () => (stopped ? cancelled() : order()),
      });
      store.createdAgoMs = 0;
      store.balanceCents = 2450;
      await startCharge(ctx, terminal, input());
      store.nowMs += 121_000;
      expect((await startCharge(ctx, terminal, input({ idempotency_key: NEW }))).status).toBe('PENDING');
      expect(store.rows[1]!.status).toBe('at_terminal');
      expect(calls.cancel).toEqual([{ id: 'ORD01', key: `${KEY}-cancel` }]);
      expect(store.rows[0]).toMatchObject({ status: 'cancelled', cancel_reason: 'timeout', cancel_requested_by: null });
      expect(store.rows[1]).toMatchObject({ idempotency_key: NEW, external_order_id: 'ORD-NEW' });
      expect(calls.create.map((c) => c.idempotencyKey)).toEqual([KEY, NEW]);
    });

    it('antiga que na verdade foi paga: o cancelamento não desfaz, ela fica aprovada e segue reservando', async () => {
      const { ctx, store, calls } = setup({ cancel: async () => { throw new PaymentTerminalProviderError('not_cancellable', { httpStatus: 409 }); }, get: async () => approvedOrder() });
      store.createdAgoMs = 0;
      store.balanceCents = 2450;
      await startCharge(ctx, terminal, input());
      store.nowMs += 121_000;
      await expect(startCharge(ctx, terminal, input({ idempotency_key: NEW }))).rejects.toMatchObject({ code: 'over_balance', httpStatus: 409 });
      expect(store.rows[0]).toMatchObject({ status: 'approved', external_payment_id: '123456789' });
      expect(calls.create).toHaveLength(1);
    });

    it('enviada e sem resposta há mais de 2 min: revisão manual (DISPATCH_UNKNOWN), segue reservando e a nova é recusada por saldo', async () => {
      let n = 0;
      const { ctx, store, calls } = setup({ create: async () => { n += 1; if (n === 1) throw netDown(); return order(); } });
      store.createdAgoMs = 0;
      store.balanceCents = 2450;
      await startCharge(ctx, terminal, input());
      store.nowMs += 121_000;
      await expect(startCharge(ctx, terminal, input({ idempotency_key: NEW }))).rejects.toMatchObject({ code: 'over_balance', httpStatus: 409 });
      expect(store.rows).toHaveLength(1);
      expect(store.rows[0]).toMatchObject({ status: 'manual_review', raw_status_detail: 'DISPATCH_UNKNOWN', cancel_reason: 'timeout', external_order_id: null });
      expect(calls.create).toHaveLength(1); // a antiga não é mandada de novo
      expect(calls.cancel).toHaveLength(0);
    });

    it('gravada e nunca enviada há mais de 2 min: encerrada com prova (nada saiu), o saldo libera e a nova abre', async () => {
      const { ctx, store, calls } = setup();
      store.createdAgoMs = 0;
      store.balanceCents = 2450;
      store.failOnce('claimDispatch'); // o aparelho gravou a cobrança e a função caiu antes de mandar
      await expect(startCharge(ctx, terminal, input())).rejects.toThrow('banco fora do ar');
      expect(store.rows[0]).toMatchObject({ status: 'creating', dispatched_at: null });
      store.nowMs += 121_000;
      await startCharge(ctx, terminal, input({ idempotency_key: NEW }));
      expect(store.rows[1]).toMatchObject({ idempotency_key: NEW, external_order_id: 'ORD01' });
      expect(store.rows[0]).toMatchObject({ status: 'cancelled', raw_status: 'voided_before_send', cancel_reason: 'timeout' });
      expect(calls.create.map((c) => c.idempotencyKey)).toEqual([NEW]);
    });

    it('antiga ainda no prazo (menos de 2 min): só reconsulta; nenhum encerramento, nenhum cancelamento, e ela segue reservando', async () => {
      const { ctx, store, calls } = setup();
      store.createdAgoMs = 0;
      store.balanceCents = 2450;
      await startCharge(ctx, terminal, input());
      store.nowMs += 119_000;
      await expect(startCharge(ctx, terminal, input({ idempotency_key: NEW }))).rejects.toMatchObject({ code: 'over_balance' });
      expect(calls.get).toEqual(['ORD01']);
      expect(calls.cancel).toHaveLength(0);
      expect(store.rows[0]).toMatchObject({ status: 'at_terminal', cancel_requested_at: null, cancel_reason: null });
    });

    it('antiga com encerramento já pedido e sem ordem: fecha pelo mesmo caminho, sem pedir outro prazo', async () => {
      const { ctx, store } = setup({ create: async () => { throw netDown(); } });
      store.createdAgoMs = 0;
      await startCharge(ctx, terminal, input());
      await store.authorizeCancel({ idempotency_key: KEY, performed_by: STAFF, manager_pin: MANAGER_PIN, reason: 'cliente desistiu' });
      store.nowMs += 31_000; // posse vencida, mas a cobrança ainda tem menos de 2 min
      await startCharge(ctx, terminal, input({ idempotency_key: NEW })).catch(() => undefined);
      expect(store.count.requestTimeoutCancel).toBeUndefined();
      expect(store.rows[0]).toMatchObject({ status: 'manual_review', raw_status_detail: 'DISPATCH_UNKNOWN', cancel_reason: 'operator' });
    });

    it('falha ao encerrar a antiga não impede a cobrança nova de seguir o caminho normal', async () => {
      const { ctx, store, calls } = setup();
      store.createdAgoMs = 0;
      await startCharge(ctx, terminal, input());
      store.nowMs += 121_000;
      store.failOnce('requestTimeoutCancel');
      await startCharge(ctx, terminal, input({ idempotency_key: NEW }));
      expect(store.rows[0]).toMatchObject({ status: 'at_terminal', cancel_requested_at: null });
      expect(store.rows[1]).toMatchObject({ idempotency_key: NEW, external_order_id: 'ORD01' });
      expect(calls.create.map((c) => c.idempotencyKey)).toEqual([KEY, NEW]);
    });

    it('a própria chave reenviada não encerra a si mesma', async () => {
      const { ctx, store, calls } = setup();
      store.createdAgoMs = 0;
      await startCharge(ctx, terminal, input());
      store.nowMs += 300_000;
      expect((await startCharge(ctx, terminal, input())).status).toBe('PENDING');
      expect(calls.cancel).toHaveLength(0);
      expect(store.rows[0]!.cancel_requested_at).toBeNull();
    });
  });

  describe('o banco de mentira segue as regras do gatilho', () => {
    it('recusa mudar cobrança final, trocar a ordem, apagar o encerramento e mandar depois dele', async () => {
      const { ctx, store } = setup();
      await startCharge(ctx, terminal, input());
      const r = store.rows[0]!;
      expect(() => store.write(r, { external_order_id: 'ORD02' })).toThrow('já tem ordem');
      expect(() => store.write(r, { created_at: new Date(0).toISOString() })).toThrow('hora da cobrança');
      expect(() => store.write(r, { dispatch_attempts: 0 })).toThrow('não volta');
      await cancelCharge(ctx, r, CANCEL);
      expect(() => store.write(r, { cancel_requested_at: null })).toThrow('já foi registrado');
      expect(() => store.write(r, { cancel_reason: 'void' })).toThrow('já foi registrado');
      expect(() => store.write(r, { dispatch_attempts: r.dispatch_attempts + 1 })).toThrow('não é mais enviada');
      expect(() => store.write(r, { dispatch_lease_until: new Date(store.nowMs + 600_000).toISOString() })).toThrow('não é mais enviada');
      Object.assign(r, { status: 'cancelled' });
      expect(() => store.write(r, { raw_status: 'x' })).toThrow('não muda mais');
    });
  });
});

describe('point-charge: reserva do saldo (auditoria r2 P0-01)', () => {
  it('antes de abrir outra cobrança na conta, reconsulta as abertas que têm ordem (sem mandar nenhuma)', async () => {
    let finished = false;
    const { ctx, store, calls } = setup({ get: async () => (finished ? order({ status: 'expired', rawStatus: 'expired' }) : order()) });
    store.createdAgoMs = 0; // cobranças recentes, ainda no prazo de espera do cartão: só reconsulta
    await startCharge(ctx, terminal, input());
    // Uma segunda, gravada e nunca enviada (outro aparelho caiu no meio):
    store.rows.push({ ...store.rows[0]!, id: 'row-x', idempotency_key: 'outra-sem-envio', status: 'creating', external_order_id: null, dispatched_at: null });
    finished = true;
    await startCharge(ctx, terminal, input({ idempotency_key: 'nova-chave' }));
    expect(store.rows[0]!.status).toBe('expired'); // terminou no Mercado Pago: libera o saldo com prova
    expect(store.rows.find((r) => r.id === 'row-x')).toMatchObject({ status: 'creating', dispatched_at: null, cancel_requested_at: null });
    expect(calls.create.map((c) => c.idempotencyKey)).toEqual([KEY, 'nova-chave']);
    expect(calls.cancel).toHaveLength(0); // no prazo: nenhum encerramento
  });
});

describe('point-charge: leitura do pagamento', () => {
  it('bandeiras conhecidas; outras ficam sem bandeira', () => {
    expect(['visa', 'debvisa', 'master', 'debmaster', 'elo', 'debelo', 'amex', 'hipercard', null].map(brandFromMethodId)).toEqual(['VISA', 'VISA', 'MASTERCARD', 'MASTERCARD', 'ELO', 'ELO', null, null, null]);
  });

  it('valor só com até 2 casas exatas', () => {
    expect(amountToCents(24.5)).toBe(2450);
    expect(amountToCents(0.1 + 0.2)).toBe(30);
    expect(amountToCents(10.005)).toBeNull();
    expect(amountToCents('24.50')).toBe(2450);
    expect(amountToCents('24.5')).toBe(2450);
    expect(amountToCents('24')).toBe(2400);
    for (const bad of ['24.505', '-1', '1e3', ' 24.50', '24,50', '', '0', '0.00', '.5', '24.']) expect(amountToCents(bad)).toBeNull();
    expect(amountToCents(0)).toBeNull();
    expect(amountToCents(-1)).toBeNull();
    expect(amountToCents(1e-9)).toBeNull();
  });

  it('parse do GET /v1/payments/{id}', () => {
    expect(parsePayment({ id: 123, status: 'approved', transaction_amount: 24.5, payment_method_id: 'master', payment_type_id: 'credit_card', authorization_code: '301299', card: { last_four_digits: '4242' }, installments: 1 }))
      .toEqual({ id: '123', status: 'approved', amountCents: 2450, paymentMethodId: 'master', paymentTypeId: 'credit_card', authorizationCode: '301299', lastFour: '4242', installments: 1, externalReference: null, orderId: null, statusDetail: null, amountRefundedCents: null });
    expect(parsePayment({ id: 8, status: 'charged_back', status_detail: 'reimbursed' })).toMatchObject({ status: 'charged_back', statusDetail: 'reimbursed' });
    // Auditoria interna 1: valor estornado com a mesma regra estrita de transaction_amount.
    expect(parsePayment({ id: 9, status: 'refunded', transaction_amount: 24.5, transaction_amount_refunded: 24.5 }).amountRefundedCents).toBe(2450);
    expect(parsePayment({ id: 9, status: 'refunded', transaction_amount_refunded: '24.50' }).amountRefundedCents).toBe(amountToCents('24.50'));
    for (const bad of [24.555, -1, 'x', null, undefined, 0]) expect(parsePayment({ id: 9, transaction_amount_refunded: bad }).amountRefundedCents).toBeNull();
    // r5: referência e ordem do pagamento são lidas (para conferir contra a cobrança, nunca usadas sem conferência).
    expect(parsePayment({ id: 7, status: 'approved', external_reference: KEY, order: { id: 'ORD01', type: 'mercadopago' } })).toMatchObject({ externalReference: KEY, orderId: 'ORD01' });
    expect(parsePayment({ id: 7, external_reference: '', order: 'x' })).toMatchObject({ externalReference: null, orderId: null });
    expect(() => parsePayment({ status: 'approved' })).toThrow();
    expect(() => parsePayment(null)).toThrow();
  });

  it('cliente HTTP: token no cabeçalho, ID só numérico, erro HTTP não vira pagamento', async () => {
    const seen: { url: string; auth: string }[] = [];
    let status = 200;
    const client = createMercadoPagoPayments({
      accessToken: 'TOKEN',
      fetchImpl: async (url, init) => {
        seen.push({ url, auth: init.headers.Authorization! });
        return { status, text: async () => JSON.stringify({ id: 1, status: 'approved', transaction_amount: 1 }) };
      },
    });
    expect((await client.getPayment('1')).amountCents).toBe(100);
    expect(seen).toEqual([{ url: 'https://api.mercadopago.com/v1/payments/1', auth: 'Bearer TOKEN' }]);
    await expect(client.getPayment('1/../x')).rejects.toThrow();
    status = 404;
    await expect(client.getPayment('1')).rejects.toThrow('mercado_pago_payment_http_404');
  });
});

describe('point-charge: auditoria r4', () => {
  /** Cobrança gravada pelo create, que parou antes de pedir a posse (função interrompida). */
  const abandoned = (store: MemoryStore): TerminalChargeRow => {
    store.rows.push({
      id: 'row-1', tenant_id: TENANT, idempotency_key: KEY, order_id: ORDER, terminal_id: TERMINAL_UUID, provider: 'mercado_pago_point',
      external_terminal_id: MP_TERMINAL, method: 'CREDIT', amount_cents: 2450, status: 'creating', external_order_id: null, external_payment_id: null,
      raw_status: null, raw_status_detail: null, paid_amount_cents: null, card_brand: null, authorization_code: null, last_four: null, created_by: STAFF,
      dispatched_at: null, dispatch_lease_until: null, dispatch_attempts: 0, cancel_reason: null, cancel_requested_by: null, cancel_requested_at: null,
      cancel_authorized_by: null, cancel_audit_id: null, created_at: new Date(store.nowMs).toISOString(),
    });
    return { ...store.rows[0]! };
  };

  describe('P1-02: a consulta nunca inicia o primeiro envio', () => {
    it('cobrança "creating" sem envio, sem posse e sem ordem: status não manda nada nem pega a posse; o create manda', async () => {
      const { ctx, store, calls } = setup();
      const row = abandoned(store);
      for (let i = 0; i < 3; i += 1) {
        expect(await pollCharge(ctx, store.rows[0]!)).toMatchObject({ status: 'PENDING' });
      }
      expect(calls.create).toHaveLength(0);
      expect(store.count.claimDispatch ?? 0).toBe(0);
      expect(store.count.beginDispatch ?? 0).toBe(0);
      // Nada mudou: a posse não foi gasta (o create logo depois não espera nada).
      expect(store.rows[0]).toEqual(row);
      expect(await startCharge(ctx, terminal, input())).toMatchObject({ status: 'PENDING' });
      expect(calls.create).toHaveLength(1);
      expect(calls.create[0]!.idempotencyKey).toBe(KEY);
      expect(store.rows[0]).toMatchObject({ status: 'at_terminal', external_order_id: 'ORD01' });
      expect(store.rows[0]!.dispatched_at).not.toBeNull();
    });

    it('status só repete, com a mesma chave, um envio que comprovadamente saiu (para recuperar a ordem)', async () => {
      let first = true;
      const { ctx, store, calls } = setup({
        create: async () => {
          if (first) {
            first = false;
            throw new Error('queda depois de mandar');
          }
          return order();
        },
      });
      await startCharge(ctx, terminal, input());
      expect(store.rows[0]).toMatchObject({ status: 'creating', external_order_id: null });
      expect(store.rows[0]!.dispatched_at).not.toBeNull();
      store.nowMs += 31_000; // posse do primeiro envio vencida
      expect(await pollCharge(ctx, store.rows[0]!)).toMatchObject({ status: 'PENDING' });
      expect(calls.create.map((c) => c.idempotencyKey)).toEqual([KEY, KEY]);
      expect(store.rows[0]).toMatchObject({ status: 'at_terminal', external_order_id: 'ORD01' });
    });

    it('a barreira do banco também barra: consulta nunca marca o primeiro envio', async () => {
      const { store } = setup();
      abandoned(store);
      const claimed = await store.claimDispatch(store.rows[0]!, 30_000);
      expect(claimed).not.toBeNull();
      expect(await store.beginDispatch(claimed!, 30_000, false)).toBe(0);
      expect(store.rows[0]!.dispatched_at).toBeNull();
      expect(await store.beginDispatch(claimed!, 30_000, true)).toBe(1);
    });

    it('consulta e create juntos numa cobrança largada: um envio só, pelo create', async () => {
      const { ctx, store, calls } = setup();
      abandoned(store);
      const [a, b, c] = await Promise.all([pollCharge(ctx, store.rows[0]!), startCharge(ctx, terminal, input()), pollCharge(ctx, store.rows[0]!)]);
      expect([a.status, b.status, c.status].every((s) => s === 'PENDING')).toBe(true);
      expect(calls.create).toHaveLength(1);
    });

    it('cobrança largada sem envio: o encerramento por prazo encerra com prova (nada foi cobrado)', async () => {
      const { ctx, store, calls } = setup();
      const row = abandoned(store);
      store.rows[0]!.created_at = new Date(store.nowMs - 10 * 60_000).toISOString();
      expect(await cancelCharge(ctx, { ...row, created_at: store.rows[0]!.created_at }, CANCEL)).toMatchObject({ status: 'DECLINED' });
      expect(store.rows[0]).toMatchObject({ status: 'cancelled', raw_status: 'voided_before_send' });
      expect(calls.create).toHaveLength(0);
    });
    it('consulta de cobrança largada sem envio avisa o aparelho (awaiting_send) para repetir o create; com envio, não', async () => {
      const { ctx, store } = setup({ create: async () => { throw new Error('queda'); } });
      abandoned(store);
      expect(await pollCharge(ctx, store.rows[0]!)).toEqual({ status: 'PENDING', idempotency_key: KEY, detail: 'Enviando para a maquininha.', awaiting_send: true });
      await startCharge(ctx, terminal, input()); // o envio sai e cai: agora há envio anterior
      expect(store.rows[0]!.dispatched_at).not.toBeNull();
      expect(await pollCharge(ctx, store.rows[0]!)).not.toHaveProperty('awaiting_send');
    });

    it('bloqueio da chave com o corpo que o aparelho manda no encerramento (sem saldo da conta) funciona', async () => {
      const { ctx, store, calls } = setup();
      // Exatamente o corpo de encerramento por prazo do driver (mercadoPagoPointDriver.ts: timeoutBody).
      const body = { action: 'cancel', terminal_id: TERMINAL_UUID, idempotency_key: KEY, order_id: ORDER, amount_cents: 2450, method: 'CREDIT', reason: 'timeout', staff_id: STAFF };
      expect(await voidCharge(ctx, terminal, body)).toMatchObject({ status: 'DECLINED' });
      expect(store.rows[0]).toMatchObject({ status: 'cancelled', raw_status: 'voided_before_send', cancel_reason: 'void' });
      // A criação atrasada encontra a chave bloqueada e não manda.
      expect((await startCharge(ctx, terminal, input())).status).toBe('DECLINED');
      expect(calls.create).toHaveLength(0);
    });
  });

  describe('P1-02: segunda proteção se a barreira responder "primeiro envio" a uma consulta', () => {
    it('consulta com envio anterior e barreira com defeito (devolve 1): não manda e não grava recusa', async () => {
      for (const failure of [null, new PaymentTerminalProviderError('invalid_request', { httpStatus: 400 })]) {
        const { ctx, store, calls } = setup({ create: async () => { if (failure) throw failure; return order(); } });
        abandoned(store);
        store.rows[0]!.dispatched_at = new Date(store.nowMs - 60_000).toISOString();
        store.rows[0]!.dispatch_attempts = 1;
        store.rows[0]!.dispatch_lease_until = new Date(store.nowMs - 1_000).toISOString();
        const real = store.beginDispatch.bind(store);
        store.beginDispatch = async (row, lease, allowFirst) => { await real(row, lease, allowFirst); return 1; };
        const reply = await pollCharge(ctx, store.rows[0]!);
        expect(calls.create).toHaveLength(0);
        expect(store.count.rejectFirstSend ?? 0).toBe(0);
        expect(reply.status).not.toBe('DECLINED');
        expect(store.rows[0]!.status).toBe('creating');
      }
    });
  });

  describe('P1-01: o saldo da conta no aparelho é conferido no servidor', () => {
    it('o saldo que o aparelho manda vai para a abertura da cobrança', async () => {
      const { ctx, store } = setup();
      await startCharge(ctx, terminal, input({ expected_balance_cents: 9000 }));
      expect(store.expectedBalances).toEqual([9000]);
    });

    it('sem saldo, ou saldo inválido: recusa sem gravar nem mandar', async () => {
      for (const bad of [undefined, null, -1, 12.5, '2450', Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
        const { ctx, store, calls } = setup();
        await expect(startCharge(ctx, terminal, input({ expected_balance_cents: bad }))).rejects.toMatchObject({ code: 'invalid_balance', httpStatus: 400 });
        expect(store.rows).toHaveLength(0);
        expect(calls.create).toHaveLength(0);
      }
    });

    it('saldo diferente do servidor: recusa (409) sem gravar nem mandar', async () => {
      const { ctx, store, calls } = setup();
      store.accountBalanceCents = 10_000; // o servidor ainda não recebeu a alteração que baixou a conta para R$ 80,00
      await expect(startCharge(ctx, terminal, input({ expected_balance_cents: 8000 }))).rejects.toMatchObject({ code: 'balance_mismatch', httpStatus: 409 });
      expect(store.rows).toHaveLength(0);
      expect(calls.create).toHaveLength(0);
      expect(await startCharge(ctx, terminal, input({ expected_balance_cents: 10_000 }))).toMatchObject({ status: 'PENDING' });
      expect(calls.create).toHaveLength(1);
    });
  });
});

describe('point-charge: auditoria r5', () => {
  const RECONCILE = { idempotency_key: KEY, staff_id: STAFF, manager_pin: MANAGER_PIN, reason_text: 'conferido no app do Mercado Pago' };
  const CREATED_AT = '2026-11-14T12:00:00.000Z';

  /** Cobrança gravada no estado pedido (revisão manual com ordem, por padrão). */
  const seed = (store: MemoryStore, over: Partial<TerminalChargeRow> = {}): TerminalChargeRow => {
    store.rows.push({
      id: 'row-1', tenant_id: TENANT, idempotency_key: KEY, order_id: ORDER, terminal_id: TERMINAL_UUID, provider: 'mercado_pago_point',
      external_terminal_id: MP_TERMINAL, method: 'CREDIT', amount_cents: 2450, status: 'manual_review', external_order_id: 'ORD01', external_payment_id: null,
      raw_status: 'processed', raw_status_detail: 'PAYMENT_NOT_APPROVED', paid_amount_cents: null, card_brand: null, authorization_code: null, last_four: null, created_by: STAFF,
      dispatched_at: CREATED_AT, dispatch_lease_until: null, dispatch_attempts: 1, cancel_reason: null, cancel_requested_by: null, cancel_requested_at: null,
      cancel_authorized_by: null, cancel_audit_id: null, created_at: CREATED_AT, ...over,
    });
    return { ...store.rows[0]! };
  };
  /** Envio sem resposta (DISPATCH_UNKNOWN): sem ordem ligada. */
  const unknownDispatch = { external_order_id: null, raw_status: 'dispatch_unknown', raw_status_detail: 'DISPATCH_UNKNOWN' } as const;
  /** Aprovada e conferida, sem pagamento registrado pelo aparelho. */
  const approvedRow = {
    status: 'approved', raw_status: 'processed', raw_status_detail: 'accredited', external_payment_id: '123456789', paid_amount_cents: 2450,
    authorization_code: 'A1B2C3', card_brand: 'MASTERCARD', last_four: '4242',
  } as const;
  const APPROVED_REPLY = {
    status: 'APPROVED', idempotency_key: KEY, nsu: '123456789', authorization_code: 'A1B2C3', card_brand: 'MASTERCARD', last_four: '4242',
    terminal_serial: MP_TERMINAL, amount_cents: 2450, method: 'CREDIT',
  };
  const unchanged = (store: MemoryStore, before: TerminalChargeRow) => {
    expect(store.rows[0]).toEqual(before);
    expect(store.resolutions).toHaveLength(0);
  };

  describe('entrada e PIN de gerente', () => {
    it.each([
      [{ idempotency_key: 'chave inválida' }, 'invalid_key', 400],
      [{ staff_id: 'x' }, 'invalid_staff', 400],
      [{ staff_id: undefined }, 'invalid_staff', 400],
      [{ manager_pin: undefined }, 'manager_required', 403],
      [{ manager_pin: '12' }, 'manager_required', 403],
      [{ reason_text: 'curto' }, 'invalid_reason', 400],
      [{ reason_text: '   123456789   ' }, 'invalid_reason', 400],
      [{ reason_text: undefined }, 'invalid_reason', 400],
      [{ operation_id: '12a' }, 'invalid_operation', 400],
      [{ operation_id: 123 }, 'invalid_operation', 400],
      [{ operation_id: '1'.repeat(21) }, 'invalid_operation', 400],
    ] as const)('%o → %s (%d), sem PIN nem Mercado Pago', async (over, code, http) => {
      const { ctx, store, calls } = setup();
      const before = seed(store);
      await expect(reconcileCharge(ctx, { ...RECONCILE, ...over })).rejects.toMatchObject({ code, httpStatus: http });
      expect(store.count.authorizeReconcile ?? 0).toBe(0);
      expect(calls.get).toHaveLength(0);
      unchanged(store, before);
    });

    it('PIN errado: 403, registra a falha e não lê nem libera nada', async () => {
      const { ctx, store, calls } = setup();
      const before = seed(store);
      await expect(reconcileCharge(ctx, { ...RECONCILE, manager_pin: '0000' })).rejects.toMatchObject({ code: 'manager_denied', httpStatus: 403 });
      expect(store.audits.map((a) => a.action)).toEqual(['MANAGER_PIN_FAILED']);
      expect(calls.get).toHaveLength(0);
      expect(calls.find).toHaveLength(0);
      expect(calls.payment).toHaveLength(0);
      unchanged(store, before);
    });

    it('recusas do banco: operador fora da equipe 403, motivo 400', async () => {
      const { ctx, store } = setup();
      seed(store);
      await expect(reconcileCharge(ctx, { ...RECONCILE, staff_id: '66666666-6666-4666-8666-666666666666' })).rejects.toMatchObject({ code: 'invalid_staff', httpStatus: 403 });
      store.authorizeReconcile = async () => { throw new ChargeRefusedError('invalid_reason', 'motivo curto'); };
      await expect(reconcileCharge(ctx, RECONCILE)).rejects.toMatchObject({ code: 'invalid_reason', httpStatus: 400 });
      expect(store.resolutions).toHaveLength(0);
    });

    it('cobrança inexistente: 404', async () => {
      const { ctx } = setup();
      await expect(reconcileCharge(ctx, RECONCILE)).rejects.toMatchObject({ code: 'not_found', httpStatus: 404 });
    });

    // Revisão PR #49: creating/pending/at_terminal seguem no Mercado Pago e estornada confere o estorno (bloco abaixo).
    it.each(['rejected', 'cancelled', 'expired'] as const)('cobrança "%s": 409 not_applicable, sem gastar PIN', async (status) => {
      const { ctx, store, calls } = setup();
      const before = seed(store, { status });
      await expect(reconcileCharge(ctx, RECONCILE)).rejects.toMatchObject({ code: 'not_applicable', httpStatus: 409 });
      expect(store.count.authorizeReconcile ?? 0).toBe(0);
      expect(calls.get).toHaveLength(0);
      unchanged(store, before);
    });

    it('aprovada com pagamento já registrado: 409 not_applicable', async () => {
      const { ctx, store, calls } = setup();
      const before = seed(store, approvedRow);
      store.registeredPayments.add(KEY);
      await expect(reconcileCharge(ctx, RECONCILE)).rejects.toMatchObject({ code: 'not_applicable', httpStatus: 409 });
      expect(store.count.authorizeReconcile ?? 0).toBe(0);
      expect(calls.get).toHaveLength(0);
      unchanged(store, before);
    });
  });

  describe('revisão manual com ordem: as mesmas conferências da aprovação', () => {
    it('Mercado Pago confirma tudo: aprovada com os dados lidos, UM registro do fim verificado', async () => {
      const { ctx, store, calls } = setup({ get: async () => approvedOrder(), payment: async () => approvedPayment() });
      seed(store);
      expect(await reconcileCharge(ctx, RECONCILE)).toEqual(APPROVED_REPLY);
      expect(store.rows[0]).toMatchObject({ status: 'approved', external_order_id: 'ORD01', external_payment_id: '123456789', paid_amount_cents: 2450, authorization_code: 'A1B2C3', card_brand: 'MASTERCARD', last_four: '4242', raw_status_detail: 'accredited' });
      expect(calls.get).toEqual(['ORD01']);
      expect(calls.payment).toEqual(['123456789']);
      expect(store.resolutions).toHaveLength(1);
      expect(store.resolutions[0]).toMatchObject({ from: 'manual_review', to: 'approved', staff: STAFF, reason: 'conferido no app do Mercado Pago' });
      expect(store.resolutions[0]!.patch).not.toHaveProperty('external_order_id');
      expect(store.resolutions[0]!.evidence).toMatchObject({
        source: 'mercado_pago_order', external_order_id: 'ORD01', order_status: 'processed', external_payment_id: '123456789', payment_status: 'approved', authorization_audit_id: 'audit-1', operation_id: null,
      });
      expect(store.audits.map((a) => a.action)).toEqual(['POINT_RECONCILE_AUTHORIZED', 'POINT_CHARGE_RESOLVED']);
    });

    it.each(APPROVAL_MISMATCHES)('%o %o → continua em revisão (%s), nada gravado', async (o, p, code) => {
      const { ctx, store } = setup({ get: async () => approvedOrder(o), payment: async () => approvedPayment(p) });
      const before = seed(store);
      expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'MANUAL_REVIEW', code });
      unchanged(store, before);
    });

    it.each([
      ['rejected', 'failed', 'rejected_by_issuer'],
      ['cancelled', 'canceled', 'canceled'],
      ['expired', 'expired', 'expired'],
    ] as const)('Mercado Pago mostra "%s": libera com a leitura gravada (DECLINED)', async (status, rawStatus, rawStatusDetail) => {
      const { ctx, store } = setup({ get: async () => order({ status, rawStatus, rawStatusDetail }) });
      seed(store);
      expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'DECLINED' });
      expect(store.rows[0]).toMatchObject({ status, raw_status: rawStatus, raw_status_detail: rawStatusDetail });
      expect(store.resolutions).toEqual([expect.objectContaining({ from: 'manual_review', to: status })]);
    });

    const refundedOrder = (over: Partial<PaymentTerminalChargeResult> = {}) => order({ status: 'refunded', rawStatus: 'refunded', rawStatusDetail: 'refunded', externalPaymentId: '123456789', ...over });

    it('ordem estornada no Mercado Pago: refunded, uma vez só', async () => {
      const { ctx, store } = setup({ get: async () => refundedOrder(), payment: async () => approvedPayment({ status: 'refunded' }) });
      seed(store);
      expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'DECLINED', reason: expect.stringContaining('estorno') });
      expect(store.rows[0]!.status).toBe('refunded');
      // Revisão PR #49 (P2): a segunda conferência só lê o pagamento (estorno provado), sem gravar de novo.
      expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'DECLINED', reason: expect.stringContaining('estorno') });
      expect(store.resolutions).toHaveLength(1);
    });

    it('revisão F3: ordem estornada só sai da revisão com o pagamento dela mostrando o estorno', async () => {
      const cases: [Partial<PaymentTerminalChargeResult>, (() => Promise<PointPaymentDetails>) | undefined, string][] = [
        [{ externalPaymentId: null }, undefined, 'REFUND_WITHOUT_PAYMENT'],
        [{}, async () => approvedPayment(), 'REFUND_NOT_PROVEN'],
        [{}, async () => approvedPayment({ status: 'refunded', amountCents: 100 }), 'REFUND_NOT_PROVEN'],
        [{}, async () => approvedPayment({ status: 'refunded', externalReference: 'outra' }), 'REFUND_NOT_PROVEN'],
        [{}, async () => approvedPayment({ status: 'refunded', orderId: 'ORD99' }), 'REFUND_NOT_PROVEN'],
        [{}, async () => { throw new Error('mercado_pago_payment_http_500'); }, 'MP_UNAVAILABLE'],
      ];
      for (const [over, payment, code] of cases) {
        const { ctx, store } = setup({ get: async () => refundedOrder(over), payment });
        const before = seed(store);
        expect(await reconcileCharge(ctx, RECONCILE), code).toMatchObject({ status: 'MANUAL_REVIEW', code });
        unchanged(store, before);
      }
      // merchant_order no pagamento (número) não é a ordem da Orders API: não atrapalha a prova do estorno.
      const { ctx, store } = setup({ get: async () => refundedOrder(), payment: async () => approvedPayment({ status: 'refunded', orderId: '31234567890' }) });
      seed(store);
      expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'DECLINED' });
      expect(store.rows[0]!.status).toBe('refunded');
    });

    it.each([
      ['rejected', { externalReference: null }, 'FINAL_WITHOUT_REFERENCE'],
      ['cancelled', { externalReference: null }, 'FINAL_WITHOUT_REFERENCE'],
      ['expired', { externalTerminalId: null }, 'FINAL_WITHOUT_TERMINAL'],
      ['refunded', { externalReference: null }, 'FINAL_WITHOUT_REFERENCE'],
      ['refunded', { externalTerminalId: null }, 'FINAL_WITHOUT_TERMINAL'],
    ] as const)('revisão F3: ordem %s com %o não libera (%s)', async (status, over, code) => {
      const { ctx, store } = setup({ get: async () => order({ status, rawStatus: status, externalPaymentId: '123456789', ...over }), payment: async () => approvedPayment({ status: 'refunded' }) });
      const before = seed(store);
      expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'MANUAL_REVIEW', code });
      unchanged(store, before);
    });

    it('revisão F3: ordem recusada com referência e maquininha ecoadas libera como antes', async () => {
      const { ctx, store } = setup({ get: async () => order({ status: 'rejected', rawStatus: 'failed' }) });
      seed(store);
      expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'DECLINED' });
      expect(store.rows[0]!.status).toBe('rejected');
    });

    it('auditoria interna 1: revisão (nunca aprovada) com o pagamento "cancelled" segue valendo: refunded', async () => {
      const { ctx, store } = setup({ get: async () => approvedOrder(), payment: async () => approvedPayment({ status: 'cancelled' }) });
      seed(store);
      expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'DECLINED' });
      expect(store.rows[0]!.status).toBe('refunded');
    });

    it.each([
      ['ordem processada', () => approvedOrder()],
      ['ordem estornada', () => refundedOrder()],
    ] as const)('auditoria interna 1: revisão com estorno parcial (%s): PARTIAL_REFUND, nada gravado', async (_n, get) => {
      for (const over of [{ status: 'partially_refunded', amountRefundedCents: 1000 }, { status: 'refunded', amountRefundedCents: 1000 }]) {
        const { ctx, store } = setup({ get: async () => get(), payment: async () => approvedPayment(over) });
        const before = seed(store);
        expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'MANUAL_REVIEW', code: 'PARTIAL_REFUND' });
        unchanged(store, before);
      }
    });

    it('auditoria interna 1: revisão com "refunded" sem valor estornado: não prova (nada gravado)', async () => {
      const { ctx, store } = setup({ get: async () => refundedOrder(), payment: async () => approvedPayment({ status: 'refunded', amountRefundedCents: null }) });
      const before = seed(store);
      expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'MANUAL_REVIEW', code: 'REFUND_NOT_PROVEN' });
      unchanged(store, before);
    });

    it.each([
      [{ status: 'refunded', amountRefundedCents: null }, 'REFUNDED'],
      [{ status: 'refunded', amountRefundedCents: 1000 }, 'PARTIAL_REFUND'],
      [{ status: 'partially_refunded', amountRefundedCents: 1000 }, 'PARTIAL_REFUND'],
      [{ status: 'cancelled' }, 'CANCELLED_AFTER_APPROVAL'],
    ] as const)('auditoria interna 1: estornada já gravada, pagamento %o: a trava fica (%s), nada gravado', async (over, code) => {
      const { ctx, store } = setup({ payment: async () => approvedPayment(over) });
      const before = seed(store, { ...approvedRow, status: 'refunded' });
      expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'MANUAL_REVIEW', code });
      unchanged(store, before);
      // Estorno total provado: libera.
      const ok = setup({ payment: async () => approvedPayment({ status: 'refunded' }) });
      seed(ok.store, { ...approvedRow, status: 'refunded' });
      expect(await reconcileCharge(ok.ctx, RECONCILE)).toMatchObject({ status: 'DECLINED', code: 'REFUNDED' });
    });

    it('ordem processada com o pagamento estornado: refunded', async () => {
      const { ctx, store } = setup({ get: async () => approvedOrder(), payment: async () => approvedPayment({ status: 'refunded' }) });
      seed(store);
      expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'DECLINED' });
      expect(store.rows[0]).toMatchObject({ status: 'refunded', raw_status: 'payment_refunded', raw_status_detail: 'PAYMENT_REFUNDED' });
    });

    // Decisão do Will (auditoria interna 3): contestação nunca prova estorno, com PIN, em nenhum status_detail.
    it.each(['settled', 'reimbursed', 'in_process', null])('revisão manual com o pagamento em contestação (charged_back, %s): continua em revisão', async (detail) => {
      const { ctx, store } = setup({ get: async () => approvedOrder(), payment: async () => approvedPayment({ status: 'charged_back', statusDetail: detail }) });
      const before = seed(store);
      expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'MANUAL_REVIEW' });
      unchanged(store, before);
    });

    it('pagamento estornado de OUTRO valor não prova estorno desta cobrança', async () => {
      const { ctx, store } = setup({ get: async () => approvedOrder(), payment: async () => approvedPayment({ status: 'refunded', amountCents: 100 }) });
      const before = seed(store);
      expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'MANUAL_REVIEW', code: 'PAYMENT_NOT_APPROVED' });
      unchanged(store, before);
    });

    it('ordem ainda aberta no Mercado Pago: continua em revisão (MP_PENDING)', async () => {
      for (const o of [order(), order({ status: 'pending', rawStatus: 'created' })]) {
        const { ctx, store } = setup({ get: async () => o });
        const before = seed(store);
        expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'MANUAL_REVIEW', code: 'MP_PENDING' });
        unchanged(store, before);
      }
    });

    it('status incerto do Mercado Pago: continua em revisão', async () => {
      const { ctx, store } = setup({ get: async () => order({ status: 'manual_review', rawStatus: 'action_required' }) });
      const before = seed(store);
      expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'MANUAL_REVIEW', code: 'PROVIDER_STATUS_UNCERTAIN' });
      unchanged(store, before);
    });

    it('Mercado Pago fora do ar (ordem ou pagamento): continua em revisão (MP_UNAVAILABLE), nada liberado', async () => {
      for (const opts of [
        { get: async () => { throw new PaymentTerminalProviderError('unavailable'); } },
        { get: async () => approvedOrder(), payment: async () => { throw new Error('rede'); } },
      ]) {
        const { ctx, store } = setup(opts);
        const before = seed(store);
        expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'MANUAL_REVIEW', code: 'MP_UNAVAILABLE' });
        unchanged(store, before);
      }
    });

    it('a consulta devolve outra ordem: MISMATCH', async () => {
      const { ctx, store } = setup({ get: async () => approvedOrder({ externalOrderId: 'ORD02' }) });
      const before = seed(store);
      expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'MANUAL_REVIEW', code: 'MISMATCH' });
      unchanged(store, before);
    });

    it('duas ordens para a mesma chave (ORDER_ID_CHANGED): continua em revisão sem ler nada', async () => {
      const { ctx, store, calls } = setup({ get: async () => approvedOrder() });
      const before = seed(store, { raw_status_detail: 'ORDER_ID_CHANGED' });
      expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'MANUAL_REVIEW', code: 'ORDER_ID_CHANGED' });
      expect(calls.get).toHaveLength(0);
      unchanged(store, before);
    });

    it('segunda conferência depois de liberada: 409, sem gravar de novo', async () => {
      const { ctx, store } = setup({ get: async () => order({ status: 'cancelled', rawStatus: 'canceled', rawStatusDetail: 'canceled' }) });
      seed(store);
      expect((await reconcileCharge(ctx, RECONCILE)).status).toBe('DECLINED');
      await expect(reconcileCharge(ctx, RECONCILE)).rejects.toMatchObject({ code: 'not_applicable', httpStatus: 409 });
      expect(store.resolutions).toHaveLength(1);
      expect(store.count.authorizeReconcile).toBe(1);
    });

    it('segunda conferência depois de aprovada (sem pagamento registrado): devolve a aprovação, sem gravar de novo', async () => {
      const { ctx, store } = setup({ get: async () => approvedOrder() });
      seed(store);
      expect(await reconcileCharge(ctx, RECONCILE)).toEqual(APPROVED_REPLY);
      expect(await reconcileCharge(ctx, RECONCILE)).toEqual(APPROVED_REPLY);
      expect(store.resolutions).toHaveLength(1);
    });

    it('outra chamada liberou no meio: o fim verificado não grava e vale o que está gravado', async () => {
      const { ctx, store } = setup({ get: async () => order({ status: 'cancelled', rawStatus: 'canceled', rawStatusDetail: 'canceled' }) });
      seed(store);
      const real = store.resolve.bind(store);
      store.resolve = async (row, to, patch, audit) => {
        Object.assign(store.rows[0]!, { status: 'expired', raw_status: 'expired' }); // a consulta normal terminou antes
        return real(row, to, patch, audit);
      };
      expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'DECLINED', reason: expect.stringContaining('expirou') });
      expect(store.resolutions).toHaveLength(0);
    });

    it('a consulta normal terminou a cobrança entre o PIN e a leitura: devolve o estado gravado', async () => {
      const { ctx, store, calls } = setup({ get: async () => approvedOrder() });
      seed(store);
      const real = store.authorizeReconcile.bind(store);
      store.authorizeReconcile = async (i) => {
        const id = await real(i);
        Object.assign(store.rows[0]!, { status: 'rejected', raw_status: 'failed', raw_status_detail: 'failed' });
        return id;
      };
      expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'DECLINED' });
      expect(calls.get).toHaveLength(0);
      expect(store.resolutions).toHaveLength(0);
    });
  });

  describe('revisão manual sem ordem (envio sem resposta)', () => {
    it('procura pela referência com a hora gravada; uma ordem: liga e confere como na aprovação', async () => {
      const { ctx, store, calls } = setup({ find: async () => approvedOrder(), get: async () => approvedOrder() });
      seed(store, unknownDispatch);
      expect(await reconcileCharge(ctx, RECONCILE)).toEqual(APPROVED_REPLY);
      expect(calls.find).toEqual([{ ref: KEY, createdAt: CREATED_AT }]);
      expect(calls.get).toEqual(['ORD01']);
      expect(store.rows[0]).toMatchObject({ status: 'approved', external_order_id: 'ORD01' });
      expect(store.resolutions[0]!.evidence).toMatchObject({ found_by: 'search' });
    });

    it('ordem achada e ainda aberta: fica ligada, a cobrança segue em revisão', async () => {
      const { ctx, store } = setup({ find: async () => order(), get: async () => order() });
      seed(store, unknownDispatch);
      expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'MANUAL_REVIEW', code: 'MP_PENDING' });
      expect(store.rows[0]).toMatchObject({ status: 'manual_review', external_order_id: 'ORD01' });
      expect(store.resolutions).toHaveLength(0);
    });

    it('ordem achada com conferência falhando: continua em revisão com o código da aprovação', async () => {
      const { ctx, store } = setup({ find: async () => approvedOrder(), get: async () => approvedOrder({ externalTerminalId: 'OUTRA' }) });
      seed(store, unknownDispatch);
      expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'MANUAL_REVIEW', code: 'TERMINAL_MISMATCH' });
      expect(store.rows[0]!.status).toBe('manual_review');
      expect(store.resolutions).toHaveLength(0);
    });

    it('nenhuma ordem e sem ID da operação: NOT_FOUND_YET, nada liberado', async () => {
      const { ctx, store, calls } = setup({ find: async () => null });
      const before = seed(store, unknownDispatch);
      expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'MANUAL_REVIEW', code: 'NOT_FOUND_YET' });
      expect(calls.payment).toHaveLength(0);
      unchanged(store, before);
    });

    it('mais de uma ordem com a referência: MISMATCH, nem com ID da operação libera', async () => {
      const { ctx, store, calls } = setup({ find: async () => { throw new PaymentTerminalProviderError('malformed_response', { detail: 'multiple_orders' }); } });
      const before = seed(store, unknownDispatch);
      expect(await reconcileCharge(ctx, { ...RECONCILE, operation_id: '123456789' })).toMatchObject({ status: 'MANUAL_REVIEW', code: 'MISMATCH' });
      expect(calls.payment).toHaveLength(0);
      unchanged(store, before);
    });

    it('busca fora do ar: MP_UNAVAILABLE, nem com ID da operação libera', async () => {
      const { ctx, store, calls } = setup({ find: async () => { throw new PaymentTerminalProviderError('unavailable'); } });
      const before = seed(store, unknownDispatch);
      expect(await reconcileCharge(ctx, { ...RECONCILE, operation_id: '123456789' })).toMatchObject({ status: 'MANUAL_REVIEW', code: 'MP_UNAVAILABLE' });
      expect(calls.payment).toHaveLength(0);
      unchanged(store, before);
    });

    it('F2: busca recusada pelo Mercado Pago (400): MP_SEARCH_REFUSED, pede o número da operação', async () => {
      const refused = () => new PaymentTerminalProviderError('invalid_request', { httpStatus: 400, detail: 'search_refused' });
      const { ctx, store, calls } = setup({ find: async () => { throw refused(); } });
      const before = seed(store, unknownDispatch);
      expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'MANUAL_REVIEW', code: 'MP_SEARCH_REFUSED', reason: expect.stringContaining('número da operação') });
      expect(calls.payment).toHaveLength(0);
      unchanged(store, before);
      // Com o número da operação, confere pelo pagamento como quando a busca não acha nada.
      const op = setup({ find: async () => { throw refused(); }, payment: async () => approvedPayment({ externalReference: KEY }) });
      seed(op.store, unknownDispatch);
      expect(await reconcileCharge(op.ctx, { ...RECONCILE, operation_id: '123456789' })).toEqual(APPROVED_REPLY);
      expect(op.store.rows[0]).toMatchObject({ status: 'approved', raw_status_detail: 'OPERATION_ID_CONFIRMED' });
    });

    it('busca devolve ordem de outra referência: MISMATCH, não liga', async () => {
      const { ctx, store, calls } = setup({ find: async () => approvedOrder({ externalReference: 'outra' }) });
      const before = seed(store, unknownDispatch);
      expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'MANUAL_REVIEW', code: 'MISMATCH' });
      expect(store.count.attachOrder ?? 0).toBe(0);
      expect(calls.get).toHaveLength(0);
      unchanged(store, before);
    });

    it('provider sem busca por referência: NOT_FOUND_YET', async () => {
      const { ctx, store } = setup();
      delete (ctx.provider as { findChargeByReference?: unknown }).findChargeByReference;
      seed(store, unknownDispatch);
      expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'MANUAL_REVIEW', code: 'NOT_FOUND_YET' });
    });

    const paid = (over: Partial<PointPaymentDetails> = {}) => approvedPayment({ externalReference: KEY, ...over });

    it('nenhuma ordem, ID da operação digitado e pagamento desta cobrança aprovado: aprovada com o pagamento lido', async () => {
      const { ctx, store, calls } = setup({ find: async () => null, payment: async () => paid() });
      seed(store, unknownDispatch);
      expect(await reconcileCharge(ctx, { ...RECONCILE, operation_id: ' 123456789 ' })).toEqual(APPROVED_REPLY);
      expect(calls.payment).toEqual(['123456789']);
      expect(store.rows[0]).toMatchObject({ status: 'approved', external_order_id: null, external_payment_id: '123456789', paid_amount_cents: 2450, raw_status_detail: 'OPERATION_ID_CONFIRMED' });
      expect(store.resolutions[0]!.evidence).toMatchObject({ source: 'mercado_pago_payment', found_by: 'operation_id', operation_id: '123456789', external_reference: KEY, payment_status: 'approved' });
    });

    it.each([
      [{ amountCents: 2400 }],
      [{ externalReference: 'outra-cobranca' }],
      [{ externalReference: null }],
      [{ status: 'rejected' }],
      [{ status: 'in_process' }],
      [{ status: 'refunded' }],
      [{ id: '999' }],
      [{ paymentTypeId: 'debit_card' }],
      [{ installments: 3 }],
      [{ authorizationCode: null }],
      [{ paymentMethodId: 'amex' }],
    ] as const)('ID da operação com pagamento %o: MISMATCH, nada liberado', async (over) => {
      const { ctx, store } = setup({ find: async () => null, payment: async () => paid(over as Partial<PointPaymentDetails>) });
      const before = seed(store, unknownDispatch);
      expect(await reconcileCharge(ctx, { ...RECONCILE, operation_id: '123456789' })).toMatchObject({ status: 'MANUAL_REVIEW', code: 'MISMATCH' });
      unchanged(store, before);
    });

    it('ID da operação com o Mercado Pago fora do ar: MP_UNAVAILABLE', async () => {
      const { ctx, store } = setup({ find: async () => null, payment: async () => { throw new Error('mercado_pago_payment_http_500'); } });
      const before = seed(store, unknownDispatch);
      expect(await reconcileCharge(ctx, { ...RECONCILE, operation_id: '123456789' })).toMatchObject({ status: 'MANUAL_REVIEW', code: 'MP_UNAVAILABLE' });
      unchanged(store, before);
    });

    it('ordem achada: o ID da operação não é usado (vale a ordem)', async () => {
      const { ctx, store, calls } = setup({ find: async () => order(), get: async () => order(), payment: async () => paid() });
      seed(store, unknownDispatch);
      expect(await reconcileCharge(ctx, { ...RECONCILE, operation_id: '123456789' })).toMatchObject({ status: 'MANUAL_REVIEW', code: 'MP_PENDING' });
      expect(calls.payment).toHaveLength(0);
    });
  });

  describe('aprovada sem pagamento registrado', () => {
    it('continua aprovada no Mercado Pago: devolve APPROVED com os dados, sem gravar', async () => {
      const { ctx, store } = setup({ get: async () => approvedOrder() });
      const before = seed(store, approvedRow);
      expect(await reconcileCharge(ctx, RECONCILE)).toEqual(APPROVED_REPLY);
      unchanged(store, before);
    });

    it('ordem estornada no Mercado Pago: lê o pagamento dela; estorno total = refunded uma vez, com mp_status e o valor estornado na prova', async () => {
      const refundedOrd = () => order({ status: 'refunded', rawStatus: 'refunded', rawStatusDetail: 'refunded', externalPaymentId: '123456789', paidAmountCents: 2450 });
      const { ctx, store, calls } = setup({ get: async () => refundedOrd(), payment: async () => approvedPayment({ status: 'refunded' }) });
      seed(store, approvedRow);
      expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'DECLINED', reason: expect.stringContaining('estorno') });
      expect(calls.payment).toEqual(['123456789']);
      expect(store.rows[0]).toMatchObject({ status: 'refunded', raw_status: 'refunded', raw_status_detail: 'ORDER_REFUNDED', external_payment_id: '123456789', authorization_code: 'A1B2C3' });
      expect(store.resolutions).toEqual([expect.objectContaining({ from: 'approved', to: 'refunded' })]);
      expect(store.resolutions[0]!.evidence).toMatchObject({ mp_status: 'refunded', mp_amount_refunded_cents: 2450 });
      // Revisão PR #49 (P2): a segunda conferência só lê o pagamento (estorno provado), sem gravar de novo.
      expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'DECLINED', code: 'REFUNDED' });
      expect(store.resolutions).toHaveLength(1);
    });

    it.each([
      ['pagamento aprovado', { status: 'approved' }, 'REFUND_NOT_PROVEN'],
      ['estorno sem valor', { status: 'refunded', amountRefundedCents: null }, 'REFUND_NOT_PROVEN'],
      ['estorno parcial', { status: 'partially_refunded', amountRefundedCents: 1000 }, 'PARTIAL_REFUND'],
      ['cancelado', { status: 'cancelled' }, 'CANCELLED_AFTER_APPROVAL'],
    ] as const)('alinhamento com o banco: aprovada, ordem estornada e %s: %s, nada gravado', async (_n, over, code) => {
      const { ctx, store } = setup({ get: async () => order({ status: 'refunded', rawStatus: 'refunded', externalPaymentId: '123456789', paidAmountCents: 2450 }), payment: async () => approvedPayment(over) });
      const before = seed(store, approvedRow);
      expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'MANUAL_REVIEW', code });
      unchanged(store, before);
    });

    it('alinhamento com o banco: aprovada, ordem estornada sem pagamento listado: lê o pagamento da aprovação', async () => {
      const { ctx, store, calls } = setup({ get: async () => order({ status: 'refunded', rawStatus: 'refunded', externalPaymentId: null }), payment: async () => approvedPayment({ status: 'refunded' }) });
      seed(store, approvedRow);
      expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'DECLINED' });
      expect(calls.payment).toEqual(['123456789']);
      expect(store.rows[0]!.status).toBe('refunded');
    });

    it('alinhamento com o banco: aprovada, ordem estornada listando OUTRO pagamento: MISMATCH, nada gravado', async () => {
      const { ctx, store } = setup({ get: async () => order({ status: 'refunded', rawStatus: 'refunded', externalPaymentId: '555' }), payment: async (id) => approvedPayment({ id, status: 'refunded' }) });
      const before = seed(store, approvedRow);
      expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'MANUAL_REVIEW', code: 'MISMATCH' });
      unchanged(store, before);
    });

    it('alinhamento com o banco: aprovada sem ID de pagamento e ordem estornada sem pagamento: REFUND_WITHOUT_PAYMENT, nada gravado', async () => {
      const { ctx, store, calls } = setup({ get: async () => order({ status: 'refunded', rawStatus: 'refunded', externalPaymentId: null }) });
      const before = seed(store, { ...approvedRow, external_payment_id: null });
      expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'MANUAL_REVIEW', code: 'REFUND_WITHOUT_PAYMENT' });
      expect(calls.payment).toHaveLength(0);
      unchanged(store, before);
    });

    it('alinhamento com o banco: revisão que vira estorno leva mp_status na prova', async () => {
      const { ctx, store } = setup({ get: async () => approvedOrder(), payment: async () => approvedPayment({ status: 'refunded' }) });
      seed(store);
      await reconcileCharge(ctx, RECONCILE);
      expect(store.resolutions[0]!.evidence).toMatchObject({ mp_status: 'refunded', mp_amount_refunded_cents: 2450 });
    });

    it('ordem estornada sem a referência ecoada não basta (precisa do pagamento mostrar)', async () => {
      const { ctx, store } = setup({ get: async () => order({ status: 'refunded', rawStatus: 'refunded', rawStatusDetail: 'refunded', externalReference: null }), payment: async () => approvedPayment() });
      const before = seed(store, approvedRow);
      expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'MANUAL_REVIEW', code: 'MISMATCH' });
      unchanged(store, before);
    });

    it('pagamento "refunded" (estorno total) no Mercado Pago: refunded, com o valor estornado na prova', async () => {
      const { ctx, store } = setup({ get: async () => approvedOrder(), payment: async () => approvedPayment({ status: 'refunded' }) });
      seed(store, approvedRow);
      expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'DECLINED' });
      expect(store.rows[0]).toMatchObject({ status: 'refunded', raw_status: 'payment_refunded', raw_status_detail: 'PAYMENT_REFUNDED' });
      expect(store.resolutions[0]!.evidence.mp_amount_refunded_cents).toBe(2450);
    });

    it('auditoria interna 1: aprovada com o pagamento "cancelled" é contradição: CANCELLED_AFTER_APPROVAL, nada gravado', async () => {
      const { ctx, store } = setup({ get: async () => approvedOrder(), payment: async () => approvedPayment({ status: 'cancelled' }) });
      const before = seed(store, approvedRow);
      expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'MANUAL_REVIEW', code: 'CANCELLED_AFTER_APPROVAL' });
      unchanged(store, before);
    });

    it.each([
      ['partially_refunded', { status: 'partially_refunded', amountRefundedCents: 1000 }],
      ['refunded com valor menor', { status: 'refunded', amountRefundedCents: 1000 }],
    ] as const)('auditoria interna 1: aprovada com estorno parcial (%s): PARTIAL_REFUND, nada gravado', async (_n, over) => {
      for (const withOrder of [true, false]) {
        const { ctx, store } = setup({ get: async () => approvedOrder(), payment: async () => approvedPayment({ externalReference: KEY, ...over }) });
        const before = seed(store, withOrder ? approvedRow : { ...approvedRow, external_order_id: null });
        expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'MANUAL_REVIEW', code: 'PARTIAL_REFUND' });
        unchanged(store, before);
      }
    });

    it('auditoria interna 1: aprovada com "refunded" sem valor estornado não prova (nada gravado)', async () => {
      const { ctx, store } = setup({ get: async () => approvedOrder(), payment: async () => approvedPayment({ status: 'refunded', amountRefundedCents: null }) });
      const before = seed(store, approvedRow);
      expect((await reconcileCharge(ctx, RECONCILE)).status).toBe('MANUAL_REVIEW');
      unchanged(store, before);
    });

    it.each(['settled', 'reimbursed', 'in_process', null])('contestação charged_back (%s) não prova estorno na conferência com PIN: nada gravado', async (detail) => {
      const { ctx, store } = setup({ get: async () => approvedOrder(), payment: async () => approvedPayment({ status: 'charged_back', statusDetail: detail }) });
      const before = seed(store, approvedRow);
      expect((await reconcileCharge(ctx, RECONCILE)).status).toBe('MANUAL_REVIEW');
      unchanged(store, before);
    });

    it('ordem cancelada mas pagamento aprovado: MISMATCH, continua aprovada', async () => {
      const { ctx, store } = setup({ get: async () => order({ status: 'cancelled', rawStatus: 'canceled', rawStatusDetail: 'canceled' }), payment: async () => approvedPayment() });
      const before = seed(store, approvedRow);
      expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'MANUAL_REVIEW', code: 'MISMATCH' });
      unchanged(store, before);
    });

    it('Mercado Pago fora do ar: MP_UNAVAILABLE, nada muda (o aparelho não registra)', async () => {
      for (const opts of [
        { get: async () => { throw new PaymentTerminalProviderError('unavailable'); } },
        { get: async () => approvedOrder(), payment: async () => { throw new Error('rede'); } },
      ]) {
        const { ctx, store } = setup(opts);
        const before = seed(store, approvedRow);
        expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'MANUAL_REVIEW', code: 'MP_UNAVAILABLE' });
        unchanged(store, before);
      }
    });

    it('o Mercado Pago mostra outro pagamento aprovado na ordem: MISMATCH', async () => {
      const { ctx, store } = setup({ get: async () => approvedOrder({ externalPaymentId: '555' }), payment: async () => approvedPayment({ id: '555' }) });
      const before = seed(store, approvedRow);
      expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'MANUAL_REVIEW', code: 'MISMATCH' });
      unchanged(store, before);
    });

    it('pagamento registrado entre o PIN e o estorno: 409, nada gravado', async () => {
      const { ctx, store } = setup({ get: async () => approvedOrder(), payment: async () => approvedPayment({ status: 'refunded' }) });
      const before = seed(store, approvedRow);
      let n = 0;
      store.hasRegisteredPayment = async () => (n++ >= 2); // o aparelho registra depois da segunda conferência
      await expect(reconcileCharge(ctx, RECONCILE)).rejects.toMatchObject({ code: 'not_applicable', httpStatus: 409 });
      unchanged(store, before);
    });

    it('aprovada pelo ID da operação (sem ordem): o estorno é lido no pagamento', async () => {
      const { ctx, store, calls } = setup({ payment: async () => approvedPayment({ status: 'refunded', externalReference: KEY }) });
      seed(store, { ...approvedRow, external_order_id: null });
      expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'DECLINED' });
      expect(calls.get).toHaveLength(0);
      expect(store.rows[0]!.status).toBe('refunded');
    });

    it('aprovada pelo ID da operação e ainda aprovada: APPROVED', async () => {
      const { ctx, store } = setup({ payment: async () => approvedPayment({ externalReference: KEY }) });
      const before = seed(store, { ...approvedRow, external_order_id: null });
      expect(await reconcileCharge(ctx, RECONCILE)).toEqual(APPROVED_REPLY);
      unchanged(store, before);
    });
  });

  it('consulta, criação repetida e encerramento nunca tiram da revisão manual com ordem (nem aprovação, nem recusa, nem "na maquininha")', async () => {
    for (const o of [approvedOrder(), order({ status: 'cancelled', rawStatus: 'canceled', rawStatusDetail: 'canceled' }), order(), order({ status: 'pending', rawStatus: 'created' })]) {
      const { ctx, store } = setup({ get: async () => o });
      const before = seed(store);
      expect((await pollCharge(ctx, store.rows[0]!)).status).toBe('MANUAL_REVIEW');
      expect((await startCharge(ctx, terminal, input())).status).toBe('MANUAL_REVIEW');
      expect((await cancelCharge(ctx, store.rows[0]!, OPERATOR)).status).toBe('MANUAL_REVIEW');
      expect(store.count.update ?? 0).toBe(0);
      expect(store.rows[0]!.status).toBe('manual_review');
      expect({ ...store.rows[0]!, cancel_reason: null, cancel_requested_by: null, cancel_requested_at: null, cancel_authorized_by: null, cancel_audit_id: null }).toEqual(before);
    }
  });

  it('o banco de mentira recusa sair da revisão manual por UPDATE direto', () => {
    const { store } = setup();
    seed(store);
    for (const status of ['creating', 'pending', 'at_terminal', 'approved', 'rejected', 'cancelled'] as const) {
      expect(() => store.write(store.rows[0]!, { status })).toThrow('revisão manual');
    }
    expect(() => store.write(store.rows[0]!, { raw_status: 'x' })).not.toThrow();
  });

  it('autorização do gerente já usada (TF007 no fim verificado): 409, nada gravado', async () => {
    const { ctx, store } = setup({ get: async () => approvedOrder() });
    const before = seed(store);
    store.resolve = async () => { throw new ChargeRefusedError('not_applicable', 'a autorização da conferência já foi usada'); };
    await expect(reconcileCharge(ctx, RECONCILE)).rejects.toMatchObject({ code: 'not_applicable', httpStatus: 409 });
    expect(store.rows[0]).toEqual(before);
  });

  it('fim verificado só recebe os campos aceitos pelo banco (estorno da aprovada: só raw_status e raw_status_detail)', async () => {
    const { ctx, store } = setup({ get: async () => approvedOrder(), payment: async () => approvedPayment({ status: 'refunded' }) });
    seed(store, approvedRow);
    await reconcileCharge(ctx, RECONCILE);
    expect(Object.keys(store.resolutions[0]!.patch).sort()).toEqual(['raw_status', 'raw_status_detail']);
    const review = setup({ get: async () => approvedOrder() });
    seed(review.store);
    await reconcileCharge(review.ctx, RECONCILE);
    const allowed = ['external_payment_id', 'raw_status', 'raw_status_detail', 'paid_amount_cents', 'card_brand', 'authorization_code', 'last_four'];
    expect(Object.keys(review.store.resolutions[0]!.patch).every((k) => allowed.includes(k))).toBe(true);
    expect(review.store.resolutions[0]!.evidence).toHaveProperty('authorization_audit_id');
    expect(review.store.resolutions[0]!.evidence).toHaveProperty('operation_id');
  });

  it('revisão de segurança (a): chave terminada em -cancel / -cancel-N é recusada (é a chave de cancelamento de outra cobrança)', async () => {
    for (const key of [`${KEY}-cancel`, `${KEY}-cancel-2`, `${KEY}-CANCEL`, 'abc-cancel-10', '-cancel']) {
      expect(validKey(key), key).toBe(false);
      const { ctx, store, calls } = setup();
      await expect(startCharge(ctx, terminal, input({ idempotency_key: key }))).rejects.toMatchObject({ code: 'invalid_key', httpStatus: 400 });
      await expect(voidCharge(ctx, terminal, { ...input({ idempotency_key: key }), ...CANCEL })).rejects.toMatchObject({ code: 'invalid_key' });
      await expect(reconcileCharge(ctx, { idempotency_key: key, staff_id: STAFF, manager_pin: MANAGER_PIN, reason_text: 'conferido no app do Mercado Pago' })).rejects.toMatchObject({ code: 'invalid_key' });
      expect(store.rows).toHaveLength(0);
      expect(calls.create).toHaveLength(0);
    }
    // Só o sufixo exato: "cancel" no meio, "-canceled" ou "-cancel-x" continuam valendo; a chave uuid do aparelho também.
    for (const key of [KEY, 'cancel-abc', 'abc-canceled', 'abc-cancel-x', 'abc_cancel']) expect(validKey(key), key).toBe(true);
  });

  it('revisão de segurança (b): motivo do encerramento com mais de 500 caracteres → 400, sem PIN', async () => {
    const { ctx, store } = setup();
    await startCharge(ctx, terminal, input());
    await expect(cancelCharge(ctx, store.rows[0]!, { ...input(), ...OPERATOR, reason_text: 'x'.repeat(501) })).rejects.toMatchObject({ code: 'invalid_reason', httpStatus: 400 });
    expect(store.count.authorizeCancel ?? 0).toBe(0);
    expect(() => validateCancel({ ...input(), ...OPERATOR, reason_text: 'x'.repeat(500) } as never)).not.toThrow();
  });

  it('TF009 (chave de outro pagamento) no bloqueio da chave: 409 key_in_use', async () => {
    const { ctx, store } = setup();
    store.insertVoid = async () => { throw new ChargeRefusedError('key_in_use', 'a chave já é de outro pagamento'); };
    await expect(voidCharge(ctx, terminal, { ...input(), ...CANCEL })).rejects.toMatchObject({ code: 'key_in_use', httpStatus: 409 });
    store.insert = async () => { throw new ChargeRefusedError('key_in_use', 'a chave já é de outro pagamento'); };
    await expect(startCharge(ctx, terminal, input())).rejects.toMatchObject({ code: 'key_in_use', httpStatus: 409 });
  });

  it('a consulta normal (status) continua igual: revisão manual não é liberada por ela', async () => {
    const { ctx, store } = setup({ get: async () => approvedOrder() });
    const before = seed(store, unknownDispatch);
    expect(await pollCharge(ctx, store.rows[0]!)).toMatchObject({ status: 'MANUAL_REVIEW', code: 'DISPATCH_UNKNOWN' });
    unchanged(store, before);
  });

  describe('revisão PR #49: cobrança largada antes do fim e trava que não sai', () => {
    const START = Date.parse(CREATED_AT);
    /** Relógio do "banco" `ms` depois da hora gravada da cobrança. */
    const at = (store: MemoryStore, ms: number) => { store.nowMs = START + ms; };
    const atTerminal = { status: 'at_terminal', raw_status: 'at_terminal', raw_status_detail: 'at_terminal', paid_amount_cents: null } as const;
    const cancelledOrder = () => order({ status: 'cancelled', rawStatus: 'canceled', rawStatusDetail: 'canceled' });

    it('A: Point sem rede, ordem ainda na maquininha depois do prazo: pede o cancelamento, continua reservando (MP_PENDING), sem PIN', async () => {
      const { ctx, store, calls } = setup({ get: async () => order() });
      seed(store, atTerminal);
      at(store, 10 * 60_000);
      expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'MANUAL_REVIEW', idempotency_key: KEY, code: 'MP_PENDING' });
      expect(calls.cancel).toEqual([{ id: 'ORD01', key: `${KEY}-cancel` }]);
      expect(calls.get).toEqual(['ORD01']);
      expect(store.rows[0]).toMatchObject({ status: 'at_terminal', cancel_reason: 'timeout' });
      expect(store.count.authorizeReconcile ?? 0).toBe(0);
      expect(store.resolutions).toHaveLength(0);
    });

    it('A: depois do pedido de cancelamento o Mercado Pago mostra a ordem cancelada (eco da referência e da maquininha): DECLINED', async () => {
      const { ctx, store } = setup({ get: async () => cancelledOrder() });
      seed(store, atTerminal);
      at(store, 10 * 60_000);
      expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'DECLINED', idempotency_key: KEY });
      expect(store.rows[0]!.status).toBe('cancelled');
    });

    it('A: cancelada sem o eco da referência não libera: vai para revisão e segue para a conferência com PIN', async () => {
      const { ctx, store } = setup({ get: async () => order({ status: 'cancelled', rawStatus: 'canceled', externalReference: null }) });
      seed(store, atTerminal);
      at(store, 10 * 60_000);
      expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'MANUAL_REVIEW', code: 'FINAL_WITHOUT_REFERENCE' });
      expect(store.rows[0]!.status).toBe('manual_review');
      expect(store.count.authorizeReconcile).toBe(1);
      expect(store.resolutions).toHaveLength(0);
    });

    it('A: caiu em revisão e o PIN está errado: 403, nada é liberado', async () => {
      const { ctx, store } = setup({ get: async () => order({ status: 'cancelled', rawStatus: 'canceled', externalTerminalId: null }) });
      seed(store, atTerminal);
      at(store, 10 * 60_000);
      await expect(reconcileCharge(ctx, { ...RECONCILE, manager_pin: '0000' })).rejects.toMatchObject({ code: 'manager_denied', httpStatus: 403 });
      expect(store.rows[0]!.status).toBe('manual_review');
      expect(store.resolutions).toHaveLength(0);
    });

    it('A: Mercado Pago fora do ar: nada muda além do pedido de encerramento, continua reservando', async () => {
      const { ctx, store } = setup({ get: async () => { throw new Error('rede'); } });
      seed(store, atTerminal);
      at(store, 10 * 60_000);
      expect((await reconcileCharge(ctx, RECONCILE)).status).toBe('MANUAL_REVIEW');
      expect(store.rows[0]!.status).toBe('at_terminal');
      expect(store.resolutions).toHaveLength(0);
    });

    // Auditoria interna 3 (P1-02): no prazo a cobrança pode estar sendo feita em outro aparelho. Nada é lido nem gravado
    // e nunca sai um fim, mesmo com o Mercado Pago já aprovado (quem cobra registra; dois registros = duas NFC-e).
    it.each([
      ['aberta na maquininha', async () => order()],
      ['já aprovada no Mercado Pago', async () => approvedOrder()],
      ['já cancelada no Mercado Pago', async () => order({ status: 'cancelled', rawStatus: 'canceled' })],
    ] as const)('ainda no prazo de espera do cartão (%s): WAITING_CARD, sem consultar nem gravar', async (_n, get) => {
      const { ctx, store, calls } = setup({ get, payment: async () => approvedPayment() });
      const before = seed(store, atTerminal);
      at(store, 30_000);
      expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'MANUAL_REVIEW', code: 'WAITING_CARD', reason: expect.stringContaining('outro aparelho') });
      expect(calls.cancel).toHaveLength(0);
      expect(calls.get).toHaveLength(0);
      expect(calls.payment).toHaveLength(0);
      expect(calls.create).toHaveLength(0);
      expect(store.count.authorizeReconcile ?? 0).toBe(0);
      unchanged(store, before);
    });

    it('ainda no prazo com encerramento pedido pelo gerente (aparelho que cobra no meio do encerramento): WAITING_CARD, nada lido nem gravado', async () => {
      const { ctx, store, calls } = setup({ get: async () => approvedOrder(), payment: async () => approvedPayment() });
      const before = seed(store, { ...atTerminal, cancel_reason: 'operator', cancel_requested_by: STAFF, cancel_requested_at: CREATED_AT, cancel_authorized_by: 'manager', cancel_audit_id: 'audit-x' });
      at(store, 30_000);
      expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'MANUAL_REVIEW', code: 'WAITING_CARD' });
      expect(calls.get).toHaveLength(0);
      expect(calls.cancel).toHaveLength(0);
      unchanged(store, before);
    });

    it('o mesmo encerramento do gerente depois do prazo: segue o Mercado Pago (aprovada com todas as conferências)', async () => {
      const { ctx, store } = setup({ get: async () => approvedOrder(), payment: async () => approvedPayment() });
      seed(store, { ...atTerminal, cancel_reason: 'operator', cancel_requested_by: STAFF, cancel_requested_at: CREATED_AT, cancel_authorized_by: 'manager', cancel_audit_id: 'audit-x' });
      at(store, 10 * 60_000);
      expect(await reconcileCharge(ctx, RECONCILE)).toEqual(APPROVED_REPLY);
    });

    it('sem a resposta do banco sobre o prazo: WAITING_CARD (lado seguro), nada lido nem gravado', async () => {
      const { ctx, store, calls } = setup({ get: async () => approvedOrder() });
      const before = seed(store, atTerminal);
      at(store, 10 * 60_000);
      store.inCardWait = async () => { throw new Error('banco fora do ar'); };
      expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'MANUAL_REVIEW', code: 'WAITING_CARD' });
      expect(calls.get).toHaveLength(0);
      unchanged(store, before);
    });

    it('ainda no prazo, creating com envio sem resposta: a conferência não repete o envio (WAITING_CARD)', async () => {
      const { ctx, store, calls } = setup();
      const before = seed(store, { status: 'creating', external_order_id: null, raw_status: null, raw_status_detail: null, dispatch_lease_until: CREATED_AT });
      at(store, 30_000);
      expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'MANUAL_REVIEW', code: 'WAITING_CARD' });
      expect(calls.create).toHaveLength(0);
      unchanged(store, before);
    });

    it('terminou aprovada pela consulta do outro aparelho no meio desta chamada: APPROVED_ELSEWHERE, nunca APPROVED', async () => {
      const { ctx, store, calls } = setup();
      seed(store, atTerminal);
      at(store, 10 * 60_000);
      const real = store.requestTimeoutCancel.bind(store);
      store.requestTimeoutCancel = async (row, waitMs) => {
        // O aparelho que cobra gravou a aprovação entre a leitura desta conferência e o pedido de encerramento.
        Object.assign(store.rows[0]!, { status: 'approved', external_payment_id: '123456789', paid_amount_cents: 2450, authorization_code: 'A1B2C3', card_brand: 'MASTERCARD', last_four: '4242' });
        return real(row, waitMs);
      };
      expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'MANUAL_REVIEW', code: 'APPROVED_ELSEWHERE' });
      expect(calls.get).toHaveLength(0);
    });

    it.each([['depois do prazo', 10 * 60_000]] as const)('B: app fechado depois de a maquininha aprovar (%s): APPROVED com todas as conferências', async (_n, ms) => {
      const { ctx, store, calls } = setup({ get: async () => approvedOrder(), payment: async () => approvedPayment() });
      seed(store, atTerminal);
      at(store, ms);
      expect(await reconcileCharge(ctx, RECONCILE)).toEqual(APPROVED_REPLY);
      expect(store.rows[0]).toMatchObject({ status: 'approved', external_payment_id: '123456789', authorization_code: 'A1B2C3', card_brand: 'MASTERCARD' });
      expect(calls.payment).toEqual(['123456789']);
      expect(store.count.authorizeReconcile ?? 0).toBe(0);
    });

    it('B: aprovada no Mercado Pago com um dado que não confere: revisão, e a conferência com PIN não aprova', async () => {
      const { ctx, store } = setup({ get: async () => approvedOrder({ paidAmountCents: 100 }) });
      seed(store, { ...atTerminal, status: 'pending' });
      at(store, 10 * 60_000);
      expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'MANUAL_REVIEW', code: 'PAID_AMOUNT_MISMATCH' });
      expect(store.rows[0]!.status).toBe('manual_review');
      expect(store.resolutions).toHaveLength(0);
    });

    it('nunca enviada (creating sem envio) depois do prazo: cancelada com prova, sem Mercado Pago', async () => {
      const { ctx, store, calls } = setup();
      seed(store, { status: 'creating', external_order_id: null, dispatched_at: null, dispatch_attempts: 0, raw_status: null, raw_status_detail: null });
      at(store, 10 * 60_000);
      expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'DECLINED', reason: expect.stringContaining('não chegou à maquininha') });
      expect(store.rows[0]).toMatchObject({ status: 'cancelled', raw_status: 'voided_before_send' });
      expect(calls.create).toHaveLength(0);
      expect(calls.get).toHaveLength(0);
    });

    it('nunca enviada, ainda no prazo: a conferência não manda a ordem (WAITING_CARD)', async () => {
      const { ctx, store, calls } = setup();
      seed(store, { status: 'creating', external_order_id: null, dispatched_at: null, dispatch_attempts: 0, raw_status: null, raw_status_detail: null });
      at(store, 30_000);
      expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'MANUAL_REVIEW', code: 'WAITING_CARD' });
      expect(calls.create).toHaveLength(0);
      expect(store.rows[0]!.status).toBe('creating');
    });

    it('enviada sem resposta, depois do prazo: revisão (DISPATCH_UNKNOWN) e a conferência com PIN acha a ordem pela referência', async () => {
      const { ctx, store, calls } = setup({ find: async () => approvedOrder(), get: async () => approvedOrder() });
      seed(store, { status: 'creating', external_order_id: null, raw_status: null, raw_status_detail: null, dispatch_lease_until: CREATED_AT });
      at(store, 10 * 60_000);
      expect(await reconcileCharge(ctx, RECONCILE)).toEqual(APPROVED_REPLY);
      expect(calls.create).toHaveLength(0);
      expect(store.count.authorizeReconcile).toBe(1);
      expect(store.resolutions).toEqual([expect.objectContaining({ from: 'manual_review', to: 'approved' })]);
    });

    it('enviada sem resposta, posse do envio ainda valendo: espera (DISPATCH_PENDING), sem PIN', async () => {
      const { ctx, store } = setup();
      seed(store, { status: 'creating', external_order_id: null, raw_status: null, raw_status_detail: null, dispatch_lease_until: new Date(START + 10 * 60_000 + 20_000).toISOString() });
      at(store, 10 * 60_000);
      expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'MANUAL_REVIEW', code: 'DISPATCH_PENDING' });
      expect(store.rows[0]!.status).toBe('creating');
      expect(store.count.authorizeReconcile ?? 0).toBe(0);
    });

    describe('P2: estornada', () => {
      const refundedRow = { ...approvedRow, status: 'refunded', raw_status: 'refunded', raw_status_detail: 'refunded' } as const;

      it('pagamento mostra o estorno: DECLINED, só leitura (nada gravado, PIN não usado)', async () => {
        const { ctx, store, calls } = setup({ payment: async () => approvedPayment({ status: 'refunded' }) });
        const before = seed(store, refundedRow);
        expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'DECLINED', idempotency_key: KEY, reason: expect.stringContaining('estorno') });
        expect(calls.payment).toEqual(['123456789']);
        expect(store.count.authorizeReconcile ?? 0).toBe(0);
        unchanged(store, before);
      });

      it.each([
        ['pagamento ainda aprovado', async () => approvedPayment()],
        ['outro valor', async () => approvedPayment({ status: 'refunded', amountCents: 100 })],
        ['outra referência', async () => approvedPayment({ status: 'refunded', externalReference: 'outra' })],
      ] as const)('%s: a resposta de sempre (MANUAL_REVIEW REFUNDED), a trava fica', async (_n, payment) => {
        const { ctx, store } = setup({ payment });
        const before = seed(store, refundedRow);
        expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'MANUAL_REVIEW', code: 'REFUNDED' });
        unchanged(store, before);
      });

      it('pagamento ilegível agora: MP_UNAVAILABLE; sem ID do pagamento nem ordem: REFUNDED, sem ler', async () => {
        const down = setup({ payment: async () => { throw new Error('rede'); } });
        seed(down.store, refundedRow);
        expect(await reconcileCharge(down.ctx, RECONCILE)).toMatchObject({ status: 'MANUAL_REVIEW', code: 'MP_UNAVAILABLE' });
        const none = setup();
        seed(none.store, { ...refundedRow, external_payment_id: null, external_order_id: null });
        expect(await reconcileCharge(none.ctx, RECONCILE)).toMatchObject({ status: 'MANUAL_REVIEW', code: 'REFUNDED' });
        expect(none.calls.payment).toHaveLength(0);
        expect(none.calls.get).toHaveLength(0);
      });

      it('o estorno provado responde DECLINED com code REFUNDED (não "nada foi cobrado")', async () => {
        const { ctx, store } = setup({ payment: async () => approvedPayment({ status: 'refunded' }) });
        seed(store, refundedRow);
        expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'DECLINED', code: 'REFUNDED' });
      });

      it.each(['settled', 'reimbursed', 'in_process', null])('contestação (charged_back, %s) não prova estorno sem PIN: REFUNDED, a trava fica', async (detail) => {
        const { ctx, store } = setup({ payment: async () => approvedPayment({ status: 'charged_back', statusDetail: detail }) });
        const before = seed(store, refundedRow);
        expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'MANUAL_REVIEW', code: 'REFUNDED' });
        unchanged(store, before);
      });

      describe('sem ID do pagamento: a própria ordem, com o eco completo', () => {
        const noPayment = { ...refundedRow, external_payment_id: null } as const;
        const refundedOrder = (over: Partial<PaymentTerminalChargeResult> = {}) => order({ status: 'refunded', rawStatus: 'refunded', ...over });

        it('alinhamento com o banco: ordem estornada sem pagamento nenhum não mostra o valor estornado: REFUND_WITHOUT_PAYMENT, a trava fica', async () => {
          const { ctx, store, calls } = setup({ get: async () => refundedOrder() });
          const before = seed(store, noPayment);
          expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'MANUAL_REVIEW', code: 'REFUND_WITHOUT_PAYMENT' });
          expect(calls.get).toEqual(['ORD01']);
          expect(calls.payment).toHaveLength(0);
          expect(store.count.authorizeReconcile ?? 0).toBe(0);
          unchanged(store, before);
        });

        it.each([
          ['outra ordem', { externalOrderId: 'ORD99' }],
          ['ordem não estornada', { status: 'approved' as const }],
          ['sem referência', { externalReference: null }],
          ['outra referência', { externalReference: 'outra' }],
          ['sem maquininha', { externalTerminalId: null }],
          ['outra maquininha', { externalTerminalId: 'OUTRA' }],
          ['outro valor', { amountCents: 100 }],
        ] as const)('%s: REFUNDED, a trava fica', async (_n, over) => {
          const { ctx, store } = setup({ get: async () => refundedOrder(over as Partial<PaymentTerminalChargeResult>) });
          const before = seed(store, noPayment);
          expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'MANUAL_REVIEW', code: 'REFUNDED' });
          unchanged(store, before);
        });

        it('a ordem agora informa o pagamento: vale o pagamento (precisa provar o estorno)', async () => {
          const ok = setup({ get: async () => refundedOrder({ externalPaymentId: '123456789' }), payment: async () => approvedPayment({ status: 'refunded' }) });
          seed(ok.store, noPayment);
          expect(await reconcileCharge(ok.ctx, RECONCILE)).toMatchObject({ status: 'DECLINED', code: 'REFUNDED' });
          const no = setup({ get: async () => refundedOrder({ externalPaymentId: '123456789' }), payment: async () => approvedPayment() });
          seed(no.store, noPayment);
          expect(await reconcileCharge(no.ctx, RECONCILE)).toMatchObject({ status: 'MANUAL_REVIEW', code: 'REFUNDED' });
        });

        it('ordem ilegível: MP_UNAVAILABLE', async () => {
          const { ctx, store } = setup({ get: async () => { throw new Error('rede'); } });
          seed(store, noPayment);
          expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'MANUAL_REVIEW', code: 'MP_UNAVAILABLE' });
        });
      });

      it('a consulta moveu a cobrança aberta para estornada: a conferência já confere o estorno', async () => {
        const { ctx, store } = setup({ get: async () => order({ status: 'refunded', rawStatus: 'refunded', externalPaymentId: '123456789' }), payment: async () => approvedPayment({ status: 'refunded' }) });
        seed(store, atTerminal);
        at(store, 10 * 60_000);
        expect(await reconcileCharge(ctx, RECONCILE)).toMatchObject({ status: 'DECLINED' });
        expect(store.rows[0]!.status).toBe('refunded');
      });
    });
  });

  describe('auditoria GPT r9 (P1-01): estorno da aprovada com pagamento registrado', () => {
    const REFUND = RECONCILE;
    const refundedPayment = (over: Partial<PointPaymentDetails> = {}) => approvedPayment({ status: 'refunded', externalReference: KEY, amountRefundedCents: 2450, ...over });
    const registered = (store: MemoryStore, over: Partial<TerminalChargeRow> = {}) => {
      const row = seed(store, { ...approvedRow, ...over });
      store.registeredPayments.add(KEY);
      return row;
    };
    const nothingWritten = (store: MemoryStore, before: TerminalChargeRow) => {
      expect(store.rows[0]).toEqual(before);
      expect(store.count.refundPayment ?? 0).toBe(0);
      expect(store.refunds).toHaveLength(0);
      expect(store.registeredPayments.has(KEY)).toBe(true);
    };

    it('o Mercado Pago mostra o pagamento estornado: grava cobrança refunded + pagamento REFUNDED com a prova lida', async () => {
      const { ctx, store, calls } = setup({ payment: async () => refundedPayment({ statusDetail: 'refunded', orderId: 'ORD01' }) });
      registered(store);
      expect(await refundCharge(ctx, REFUND)).toEqual({ status: 'DECLINED', idempotency_key: KEY, code: 'REFUNDED', reason: 'O Mercado Pago confirmou o estorno: nada fica cobrado nesta cobrança.', payment_registered: true,
        authorization_audit_id: 'audit-1', refund_audit_id: 'audit-2', manager_id: MANAGER_ID, order_reopened: false });
      expect(calls.payment).toEqual(['123456789']);
      expect(calls.get).toHaveLength(0);
      expect(store.rows[0]).toMatchObject({ status: 'refunded', raw_status: 'payment_refunded', raw_status_detail: 'PAYMENT_REFUNDED', external_payment_id: '123456789', authorization_code: 'A1B2C3' });
      expect(store.refundedPayments.has(KEY)).toBe(true);
      expect(store.audits.map((a) => a.action)).toEqual(['POINT_RECONCILE_AUTHORIZED', 'POINT_PAYMENT_REFUNDED']);
      expect(store.refunds).toEqual([{
        key: KEY, patch: { raw_status: 'payment_refunded', raw_status_detail: 'PAYMENT_REFUNDED' }, staff: STAFF, reason: 'conferido no app do Mercado Pago',
        evidence: {
          source: 'mercado_pago_payment', authorization_audit_id: 'audit-1', operation_id: '123456789', mp_payment_id: '123456789', mp_amount_cents: 2450, mp_amount_refunded_cents: 2450,
          mp_external_reference: KEY, mp_status: 'refunded', mp_status_detail: 'refunded', mp_order_id: 'ORD01',
        },
      }]);
      expect(store.resolutions).toHaveLength(0);
    });

    it('auditoria interna 1 (2): cancelled num pagamento aprovado e registrado é contradição: CANCELLED_AFTER_APPROVAL, nada gravado', async () => {
      const { ctx, store } = setup({ payment: async () => refundedPayment({ status: 'cancelled' }) });
      const before = registered(store);
      expect(await refundCharge(ctx, REFUND)).toMatchObject({ status: 'MANUAL_REVIEW', code: 'CANCELLED_AFTER_APPROVAL' });
      nothingWritten(store, before);
    });

    it.each([
      ['partially_refunded', { status: 'partially_refunded', amountRefundedCents: 1000 }],
      ['approved com parte estornada', { status: 'approved', amountRefundedCents: 1000 }],
      ['refunded com valor estornado menor', { status: 'refunded', amountRefundedCents: 1000 }],
    ] as const)('auditoria interna 1 (1): estorno parcial (%s): PARTIAL_REFUND com o texto próprio, nada gravado', async (_n, over) => {
      const { ctx, store } = setup({ payment: async () => refundedPayment(over) });
      const before = registered(store);
      expect(await refundCharge(ctx, REFUND)).toEqual({
        status: 'MANUAL_REVIEW', idempotency_key: KEY, code: 'PARTIAL_REFUND',
        reason: 'O Mercado Pago mostra estorno parcial; o sistema só registra estorno total. Registre a diferença com o gerente fora do sistema.',
      });
      nothingWritten(store, before);
    });

    it.each([
      ['sem valor estornado', { amountRefundedCents: null }],
      ['valor estornado maior', { amountRefundedCents: 2451 }],
    ] as const)('auditoria interna 1 (1): refunded %s: MISMATCH, nada gravado', async (_n, over) => {
      const { ctx, store } = setup({ payment: async () => refundedPayment(over) });
      const before = registered(store);
      expect(await refundCharge(ctx, REFUND)).toMatchObject({ status: 'MANUAL_REVIEW', code: 'MISMATCH' });
      nothingWritten(store, before);
    });

    it('auditoria interna 1 (1): a prova leva o valor estornado lido no Mercado Pago', async () => {
      const { ctx, store } = setup({ payment: async () => refundedPayment() });
      registered(store);
      await refundCharge(ctx, REFUND);
      expect(store.refunds[0]!.evidence.mp_amount_refunded_cents).toBe(2450);
    });

    it('auditoria interna 1 (4): operation_id é ignorado no estorno (qualquer valor ou ausente)', async () => {
      for (const operation_id of ['abc', 123, '', null, undefined, '1'.repeat(30)]) {
        const { ctx, store } = setup({ payment: async () => refundedPayment() });
        registered(store);
        expect(await refundCharge(ctx, { ...REFUND, operation_id })).toMatchObject({ status: 'DECLINED', code: 'REFUNDED' });
      }
    });

    it('auditoria interna 1 (4): motivo com mais de 500 caracteres → 400 na conferência e no estorno, sem PIN', async () => {
      const { ctx, store, calls } = setup({ payment: async () => refundedPayment() });
      const before = registered(store);
      for (const run of [reconcileCharge, refundCharge]) {
        await expect(run(ctx, { ...REFUND, reason_text: 'x'.repeat(501) })).rejects.toMatchObject({ code: 'invalid_reason', httpStatus: 400 });
      }
      expect(store.count.authorizeReconcile ?? 0).toBe(0);
      expect(calls.payment).toHaveLength(0);
      nothingWritten(store, before);
      expect(await refundCharge(ctx, { ...REFUND, reason_text: 'x'.repeat(500) })).toMatchObject({ status: 'DECLINED' });
    });

    it('auditoria interna 1 (5): estorno gravado e repetição dizem se há pagamento no servidor (payment_registered)', async () => {
      const { ctx, store } = setup({ payment: async () => refundedPayment() });
      registered(store);
      expect(await refundCharge(ctx, REFUND)).toMatchObject({ status: 'DECLINED', code: 'REFUNDED', payment_registered: true });
      expect(await refundCharge(ctx, REFUND)).toMatchObject({ status: 'DECLINED', code: 'REFUNDED', payment_registered: true });
    });

    it('r11: o estorno gravado devolve a autorização, o registro do estorno, o gerente e se a conta reabriu (também na repetição)', async () => {
      const { ctx, store } = setup({ payment: async () => refundedPayment() });
      registered(store);
      store.orderClosed = true;
      const first = await refundCharge(ctx, REFUND);
      expect(first).toEqual({
        status: 'DECLINED', idempotency_key: KEY, code: 'REFUNDED', reason: 'O Mercado Pago confirmou o estorno: nada fica cobrado nesta cobrança.',
        payment_registered: true, authorization_audit_id: 'audit-1', refund_audit_id: 'audit-2', manager_id: MANAGER_ID, order_reopened: true,
      });
      expect(store.refunds[0]!.evidence.authorization_audit_id).toBe('audit-1');
      // Repetição (outro aparelho, sem nada local): os mesmos dados do estorno gravado.
      expect(await refundCharge(ctx, REFUND)).toEqual(first);
    });

    it('r11: conta aberta: order_reopened false', async () => {
      const { ctx, store } = setup({ payment: async () => refundedPayment() });
      registered(store);
      expect(await refundCharge(ctx, REFUND)).toMatchObject({ order_reopened: false, refund_audit_id: 'audit-2' });
    });

    it('r11: estornada sem registro de estorno (pela conferência) ou registro ilegível: os campos vêm null, o estorno continua confirmado', async () => {
      const { ctx, store } = setup({ payment: async () => refundedPayment() });
      seed(store, { ...approvedRow, status: 'refunded' });
      expect(await refundCharge(ctx, REFUND)).toMatchObject({ status: 'DECLINED', code: 'REFUNDED', authorization_audit_id: null, refund_audit_id: null, manager_id: null, order_reopened: null });
      const broken = setup({ payment: async () => refundedPayment() });
      registered(broken.store);
      broken.store.refundRecord = async () => { throw new Error('banco fora do ar'); };
      expect(await refundCharge(broken.ctx, REFUND)).toMatchObject({ status: 'DECLINED', code: 'REFUNDED', refund_audit_id: null, order_reopened: null });
      expect(broken.store.rows[0]!.status).toBe('refunded');
    });

    it('r11: o pedido só precisa do que a lista do servidor dá (chave, operador, PIN, motivo): nada do aparelho', async () => {
      const { ctx, store } = setup({ payment: async () => refundedPayment() });
      registered(store);
      expect(await refundCharge(ctx, { idempotency_key: KEY, staff_id: STAFF, manager_pin: MANAGER_PIN, reason_text: 'estornado no app do Mercado Pago' })).toMatchObject({ status: 'DECLINED', code: 'REFUNDED' });
    });

    it('auditoria interna 1 (5): estornada sem pagamento no servidor (estorno pela conferência): payment_registered false', async () => {
      const { ctx, store } = setup({ payment: async () => refundedPayment() });
      seed(store, { ...approvedRow, status: 'refunded' });
      expect(await refundCharge(ctx, REFUND)).toMatchObject({ status: 'DECLINED', code: 'REFUNDED', payment_registered: false });
    });

    it('prova só do Mercado Pago: operation_id do aparelho não entra na prova', async () => {
      const { ctx, store } = setup({ payment: async () => refundedPayment() });
      registered(store);
      await refundCharge(ctx, { ...REFUND, operation_id: '999' });
      expect(store.refunds[0]!.evidence).toMatchObject({ operation_id: '123456789', mp_payment_id: '123456789' });
    });

    it.each([
      ['aprovado', { status: 'approved' }, 'NOT_REFUNDED'],
      ['em processamento', { status: 'in_process' }, 'NOT_REFUNDED'],
      ['sem status', { status: null }, 'NOT_REFUNDED'],
      ['contestação (settled)', { status: 'charged_back', statusDetail: 'settled' }, 'CHARGEBACK'],
      ['contestação (reimbursed)', { status: 'charged_back', statusDetail: 'reimbursed' }, 'CHARGEBACK'],
      ['outro ID', { id: '987654321' }, 'MISMATCH'],
      ['outro valor', { amountCents: 2400 }, 'MISMATCH'],
      ['outra referência', { externalReference: 'outra-chave' }, 'MISMATCH'],
      ['sem referência', { externalReference: null }, 'MISMATCH'],
      ['outra ordem', { orderId: 'ORD99' }, 'MISMATCH'],
    ] as const)('pagamento %s: MANUAL_REVIEW %s e nada é gravado', async (_name, over, code) => {
      const { ctx, store } = setup({ payment: async () => refundedPayment(over as Partial<PointPaymentDetails>) });
      const before = registered(store);
      const reply = await refundCharge(ctx, REFUND);
      expect(reply).toMatchObject({ status: 'MANUAL_REVIEW', code });
      expect((reply as { reason: string }).reason).toContain('Nada foi alterado');
      nothingWritten(store, before);
    });

    it('Mercado Pago fora do ar: MP_UNAVAILABLE e nada é gravado', async () => {
      const { ctx, store } = setup({ payment: async () => { throw new Error('rede'); } });
      const before = registered(store);
      expect(await refundCharge(ctx, REFUND)).toMatchObject({ status: 'MANUAL_REVIEW', code: 'MP_UNAVAILABLE' });
      nothingWritten(store, before);
    });

    it('aprovação sem ID do pagamento: NO_PAYMENT_ID antes do PIN, sem ler nem gravar', async () => {
      const { ctx, store, calls } = setup({ payment: async () => refundedPayment() });
      const before = registered(store, { external_payment_id: null });
      expect(await refundCharge(ctx, REFUND)).toMatchObject({ status: 'MANUAL_REVIEW', code: 'NO_PAYMENT_ID' });
      expect(store.count.authorizeReconcile ?? 0).toBe(0);
      expect(calls.payment).toHaveLength(0);
      nothingWritten(store, before);
    });

    it.each([
      ['aprovada sem pagamento registrado', { ...approvedRow }, false],
      ['em revisão manual', {}, true],
      ['recusada', { status: 'rejected' }, true],
      ['na maquininha', { status: 'at_terminal' }, true],
    ] as const)('%s: 409 not_applicable antes do PIN, sem Mercado Pago', async (_name, over, withPayment) => {
      const { ctx, store, calls } = setup({ payment: async () => refundedPayment() });
      const before = seed(store, over as Partial<TerminalChargeRow>);
      if (withPayment) store.registeredPayments.add(KEY);
      await expect(refundCharge(ctx, REFUND)).rejects.toMatchObject({ code: 'not_applicable', httpStatus: 409 });
      expect(store.count.authorizeReconcile ?? 0).toBe(0);
      expect(calls.payment).toHaveLength(0);
      expect(calls.get).toHaveLength(0);
      expect(store.rows[0]).toEqual(before);
      expect(store.refunds).toHaveLength(0);
    });

    it('cobrança de outra loja / inexistente: 404', async () => {
      const { ctx } = setup();
      await expect(refundCharge(ctx, REFUND)).rejects.toMatchObject({ code: 'not_found', httpStatus: 404 });
    });

    it('PIN errado: 403, registra a falha e não lê nem grava', async () => {
      const { ctx, store, calls } = setup({ payment: async () => refundedPayment() });
      const before = registered(store);
      await expect(refundCharge(ctx, { ...REFUND, manager_pin: '0000' })).rejects.toMatchObject({ code: 'manager_denied', httpStatus: 403 });
      expect(store.audits.map((a) => a.action)).toEqual(['MANAGER_PIN_FAILED']);
      expect(calls.payment).toHaveLength(0);
      nothingWritten(store, before);
    });

    it.each([
      [{ manager_pin: undefined }, 'manager_required', 403],
      [{ reason_text: 'curto' }, 'invalid_reason', 400],
      [{ staff_id: 'x' }, 'invalid_staff', 400],
    ] as const)('entrada %o → %s, sem PIN nem Mercado Pago', async (over, code, http) => {
      const { ctx, store, calls } = setup({ payment: async () => refundedPayment() });
      const before = registered(store);
      await expect(refundCharge(ctx, { ...REFUND, ...over })).rejects.toMatchObject({ code, httpStatus: http });
      expect(store.count.authorizeReconcile ?? 0).toBe(0);
      expect(calls.payment).toHaveLength(0);
      nothingWritten(store, before);
    });

    it.each([
      [new ChargeRefusedError('not_applicable', 'a autorização da conferência já foi usada; peça outra.'), 'not_applicable', 409, 'a autorização da conferência já foi usada; peça outra. Nada foi alterado.'],
      [new ChargeRefusedError('invalid_reason', 'o estorno lido no Mercado Pago não confere com a cobrança.'), 'refund_refused', 409, 'O servidor recusou o registro do estorno (prova ou autorização). Nada foi alterado. Consulte de novo.'],
      [new ChargeRefusedError('invalid_staff', 'operador não é da equipe ativa desta loja.'), 'invalid_staff', 403, 'operador não é da equipe ativa desta loja.'],
      [new ChargeRefusedError('not_found', 'cobrança não encontrada nesta loja.'), 'not_found', 404, 'cobrança não encontrada nesta loja.'],
    ] as const)('recusa do banco %s → %s (%d), nada gravado', async (refusal, code, http, message) => {
      const { ctx, store } = setup({ payment: async () => refundedPayment() });
      const before = registered(store);
      store.refundRefusal = refusal;
      await expect(refundCharge(ctx, REFUND)).rejects.toMatchObject({ code, httpStatus: http, message });
      expect(store.rows[0]).toEqual(before);
      expect(store.refunds).toHaveLength(0);
      expect(store.registeredPayments.has(KEY)).toBe(true);
    });

    it('banco confere a prova de novo: pagamento registrado com outro NSU é recusado (refund_refused)', async () => {
      const { ctx, store } = setup({ payment: async () => refundedPayment() });
      const before = registered(store);
      store.registeredPaymentData.set(KEY, { nsu: '111', amountCents: 2450 });
      await expect(refundCharge(ctx, REFUND)).rejects.toMatchObject({ code: 'refund_refused', httpStatus: 409 });
      expect(store.rows[0]).toEqual(before);
    });

    it('repetição: já estornada, confere o estorno no Mercado Pago sem PIN e sem gravar de novo', async () => {
      const { ctx, store, calls } = setup({ payment: async () => refundedPayment() });
      registered(store);
      await refundCharge(ctx, REFUND);
      const after = { ...store.rows[0]! };
      const audits = store.audits.length;
      expect(await refundCharge(ctx, { ...REFUND, manager_pin: '0000' })).toMatchObject({ status: 'DECLINED', code: 'REFUNDED' });
      expect(store.rows[0]).toEqual(after);
      expect(store.audits).toHaveLength(audits);
      expect(store.count.refundPayment).toBe(1);
      expect(store.count.authorizeReconcile).toBe(1);
      expect(calls.payment).toEqual(['123456789', '123456789']);
    });

    it('repetição com o Mercado Pago já não provando: a trava fica (MANUAL_REVIEW), nada gravado', async () => {
      let status = 'refunded';
      const { ctx, store } = setup({ payment: async () => refundedPayment({ status }) });
      registered(store);
      await refundCharge(ctx, REFUND);
      status = 'charged_back';
      expect(await refundCharge(ctx, REFUND)).toMatchObject({ status: 'MANUAL_REVIEW', code: 'REFUNDED' });
      expect(store.count.refundPayment).toBe(1);
    });

    it('outro aparelho registrou o estorno durante o PIN: não grava de novo', async () => {
      const { ctx, store } = setup({ payment: async () => refundedPayment() });
      registered(store);
      const authorize = store.authorizeReconcile.bind(store);
      store.authorizeReconcile = async (i) => {
        const id = await authorize(i);
        store.rows[0]!.status = 'refunded';
        return id;
      };
      expect(await refundCharge(ctx, REFUND)).toMatchObject({ status: 'DECLINED', code: 'REFUNDED' });
      expect(store.count.refundPayment ?? 0).toBe(0);
    });

    it('a conferência continua recusando a aprovada com pagamento registrado (o estorno é pela ação refund)', async () => {
      const { ctx, store } = setup({ payment: async () => refundedPayment() });
      const before = registered(store);
      await expect(reconcileCharge(ctx, RECONCILE)).rejects.toMatchObject({ code: 'not_applicable', httpStatus: 409 });
      nothingWritten(store, before);
    });
  });
});
