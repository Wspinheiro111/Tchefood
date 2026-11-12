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
  startCharge,
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
  count: Partial<Record<StoreMethod | 'insertVoid' | 'insert' | 'authorizeCancel', number>> = {};
  private failures: Partial<Record<StoreMethod, number>> = {};
  /** Faz a próxima chamada (ou as próximas `times`) do método falhar, como uma queda do banco. */
  failOnce(method: StoreMethod, times = 1) {
    this.failures[method] = times;
  }
  private enter(method: StoreMethod | 'insertVoid' | 'insert' | 'authorizeCancel') {
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
  async listOpenForOrder(orderId: string) {
    return this.rows.filter((r) => r.order_id === orderId && !FINAL_STATES.has(r.status)).map((r) => ({ ...r }));
  }
  async authorizeCancel(input: { idempotency_key: string; performed_by: string; manager_pin: string; reason: string }) {
    this.enter('authorizeCancel');
    const r = this.rows.find((x) => x.idempotency_key === input.idempotency_key)!;
    if (input.performed_by !== STAFF) throw new ChargeRefusedError('invalid_staff', 'operador não é da equipe ativa desta loja.');
    if (FINAL_STATES.has(r.status)) throw new ChargeRefusedError('not_applicable', 'a cobrança já terminou.');
    if (r.cancel_reason === 'operator' && r.cancel_audit_id) return r.cancel_audit_id;
    if (input.manager_pin !== MANAGER_PIN) {
      this.audits.push({ key: input.idempotency_key, action: 'MANAGER_PIN_FAILED', performed_by: input.performed_by, reason: 'PIN de gerente incorreto' });
      return null;
    }
    this.audits.push({ key: input.idempotency_key, action: 'POINT_CHARGE_CANCELED', performed_by: input.performed_by, reason: input.reason });
    const id = `audit-${this.audits.length}`;
    this.write(r, { cancel_reason: 'operator', cancel_requested_by: input.performed_by, cancel_requested_at: this.iso(), cancel_authorized_by: 'manager', cancel_audit_id: id });
    return id;
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

const approvedPayment = (over: Partial<PointPaymentDetails> = {}): PointPaymentDetails => ({
  id: '123456789', status: 'approved', amountCents: 2450, paymentMethodId: 'master', paymentTypeId: 'credit_card', authorizationCode: 'A1B2C3', lastFour: '4242', installments: 1, ...over,
});

function setup(opts: { create?: () => Promise<PaymentTerminalChargeResult>; get?: () => Promise<PaymentTerminalChargeResult>; payment?: () => Promise<PointPaymentDetails>; cancel?: () => Promise<void> } = {}) {
  const calls: { create: PaymentTerminalChargeRequest[]; get: string[]; cancel: { id: string; key: string }[]; payment: string[] } = { create: [], get: [], cancel: [], payment: [] };
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
  };
  const store = new MemoryStore();
  const ctx: ChargeContext = {
    store,
    provider,
    payments: {
      getPayment: async (id) => {
        calls.payment.push(id);
        return (opts.payment ?? (async () => approvedPayment()))();
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

  it('débito aprovado com debvisa', async () => {
    const { reply } = await approveWith({ paymentMethodType: 'debit_card', paymentMethodId: 'debvisa' }, { paymentTypeId: 'debit_card', paymentMethodId: 'debvisa' }, 'DEBIT');
    expect(reply).toMatchObject({ status: 'APPROVED', card_brand: 'VISA', method: 'DEBIT' });
  });

  it.each([
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
  ] as const)('%o %o → revisão manual %s', async (o, p, code) => {
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

    it('a resposta que chega depois da revisão manual ainda grava a aprovação (o pagamento não se perde)', async () => {
      let release: (o: PaymentTerminalChargeResult) => void = () => undefined;
      const { ctx, store } = setup({ create: () => new Promise((resolve) => { release = resolve; }) });
      const creating = startCharge(ctx, terminal, input());
      await new Promise((r) => setTimeout(r, 0));
      // A posse venceu sem resposta e o gerente pediu o encerramento: revisão manual.
      store.nowMs += 121_000;
      expect(await cancelCharge(ctx, store.rows[0]!, OPERATOR)).toMatchObject({ status: 'MANUAL_REVIEW', code: 'DISPATCH_UNKNOWN' });
      expect(store.rows[0]).toMatchObject({ status: 'manual_review', external_order_id: null });
      release(approvedOrder());
      expect((await creating).status).toBe('APPROVED');
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
    it('o mesmo pedido autorizado dez vezes grava um registro só e pede o cancelamento sem conferir o PIN de novo', async () => {
      const { ctx, store, calls } = setup();
      await startCharge(ctx, terminal, input());
      for (let i = 0; i < 10; i += 1) await cancelCharge(ctx, store.rows[0]!, OPERATOR);
      expect(store.audits.filter((a) => a.action === 'POINT_CHARGE_CANCELED')).toHaveLength(1);
      expect(store.rows[0]!.cancel_audit_id).toBe('audit-1');
      expect(calls.cancel).toHaveLength(10); // cada volta repete o pedido à maquininha, com a mesma chave de cancelamento
      expect(new Set(calls.cancel.map((c) => c.key))).toEqual(new Set([`${KEY}-cancel`]));
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
      '%s: espera enquanto a posse vale; vencida, revisão manual (nunca recusa); a resposta atrasada ainda aprova',
      async (_n, body, reason) => {
        let release: (o: PaymentTerminalChargeResult) => void = () => undefined;
        const { ctx, store, calls } = setup({ create: () => new Promise((resolve) => { release = resolve; }) });
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
        expect((await creating).status).toBe('APPROVED');
        expect(store.rows[0]).toMatchObject({ status: 'approved', external_order_id: 'ORD01', external_payment_id: '123456789', cancel_reason: reason });
        expect(store.count.attachOrder).toBe(1);
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
      expect((await creating).status).toBe('DECLINED');
      expect(calls.cancel).toEqual([{ id: 'ORD01', key: `${KEY}-cancel` }]);
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
    expect(amountToCents('24.50')).toBeNull();
    expect(amountToCents(0)).toBeNull();
    expect(amountToCents(-1)).toBeNull();
  });

  it('parse do GET /v1/payments/{id}', () => {
    expect(parsePayment({ id: 123, status: 'approved', transaction_amount: 24.5, payment_method_id: 'master', payment_type_id: 'credit_card', authorization_code: '301299', card: { last_four_digits: '4242' }, installments: 1 }))
      .toEqual({ id: '123', status: 'approved', amountCents: 2450, paymentMethodId: 'master', paymentTypeId: 'credit_card', authorizationCode: '301299', lastFour: '4242', installments: 1 });
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
