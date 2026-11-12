import { describe, expect, it } from 'vitest';
import { PaymentTerminalProviderError, type PaymentTerminalChargeRequest, type PaymentTerminalChargeResult, type PaymentTerminalProvider } from '../../../server/shared/paymentTerminal.ts';
import {
  ChargeInputError,
  ChargeRefusedError,
  brandFromMethodId,
  voidCharge,
  cancelCharge,
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

/** Mesmo contrato do banco: cópias (como o PostgREST), gravação só se o estado lido não mudou. */
class MemoryStore implements ChargeStore {
  rows: TerminalChargeRow[] = [];
  refuse: ChargeRefusedError | null = null;
  audits: { key: string; performed_by: string; reason: string }[] = [];
  /** Idade das cobranças novas (o encerramento por prazo confere a hora gravada). */
  createdAgoMs = 10 * 60_000;
  private add(row: NewChargeRow): TerminalChargeRow {
    const r = { ...row, id: `row-${this.rows.length + 1}`, created_at: new Date(Date.now() - this.createdAgoMs).toISOString() };
    this.rows.push(r);
    return { ...r };
  }
  private get(id: string) {
    return this.rows.find((x) => x.id === id)!;
  }
  async findByKey(k: string) {
    const r = this.rows.find((x) => x.idempotency_key === k);
    return r ? { ...r } : null;
  }
  async insert(row: NewChargeRow) {
    const existing = await this.findByKey(row.idempotency_key);
    if (existing) return existing;
    if (this.refuse) throw this.refuse;
    return this.add(row);
  }
  async insertVoid(row: NewChargeRow) {
    const existing = await this.findByKey(row.idempotency_key);
    if (existing) return existing;
    return this.add(row);
  }
  async update(row: TerminalChargeRow, patch: ChargePatch) {
    const r = this.get(row.id);
    if (r.status !== row.status || FINAL_STATES.has(r.status)) return { ...r };
    Object.assign(r, patch);
    return { ...r };
  }
  async claimDispatch(row: TerminalChargeRow) {
    const r = this.get(row.id);
    if (r.status !== 'creating' || r.dispatched_at || r.cancel_requested_at) return null;
    r.dispatched_at = new Date().toISOString();
    return { ...r };
  }
  async voidUndispatched(row: TerminalChargeRow) {
    const r = this.get(row.id);
    if (r.status === 'creating' && !r.dispatched_at) Object.assign(r, { status: 'cancelled', raw_status: 'voided_before_send' });
    return { ...r };
  }
  async listOpenForOrder(orderId: string) {
    return this.rows.filter((r) => r.order_id === orderId && !FINAL_STATES.has(r.status)).map((r) => ({ ...r }));
  }
  async authorizeCancel(input: { idempotency_key: string; performed_by: string; manager_pin: string; reason: string }) {
    if (input.performed_by !== STAFF) throw new ChargeRefusedError('invalid_staff', 'operador não é da equipe ativa desta loja.');
    if (input.manager_pin !== MANAGER_PIN) return null;
    const r = this.rows.find((x) => x.idempotency_key === input.idempotency_key)!;
    this.audits.push({ key: input.idempotency_key, performed_by: input.performed_by, reason: input.reason });
    if (!FINAL_STATES.has(r.status) && (!r.cancel_requested_at || r.cancel_reason === 'timeout')) {
      Object.assign(r, { cancel_reason: 'operator', cancel_requested_by: input.performed_by, cancel_requested_at: new Date().toISOString(), cancel_authorized_by: 'manager', cancel_audit_id: `audit-${this.audits.length}` });
    }
    return `audit-${this.audits.length}`;
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
const input = (over: Record<string, unknown> = {}) => ({ idempotency_key: KEY, order_id: ORDER, amount_cents: 2450, method: 'CREDIT', staff_id: STAFF, ...over });

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

  it('conflito de chave no Mercado Pago não vira recusa: vai para revisão manual', async () => {
    const { ctx } = setup({ create: async () => { throw new PaymentTerminalProviderError('idempotency_conflict', { httpStatus: 409 }); } });
    expect((await startCharge(ctx, terminal, input())).status).toBe('MANUAL_REVIEW');
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
    expect(store.audits).toEqual([{ key: KEY, performed_by: STAFF, reason: 'cliente desistiu' }]);
    expect(store.rows[0]).toMatchObject({ cancel_reason: 'operator', cancel_requested_by: STAFF, cancel_audit_id: 'audit-1' });
    expect(calls.cancel).toEqual([{ id: 'ORD01', key: `${KEY}-cancel` }]);
  });

  it('r2 P1-01: encerramento por prazo é decidido pelo servidor (hora gravada), sem identidade do aparelho', async () => {
    const { ctx, store, calls } = setup();
    store.createdAgoMs = 30_000;
    await startCharge(ctx, terminal, input());
    await expect(cancelCharge(ctx, store.rows[0]!, CANCEL)).rejects.toMatchObject({ code: 'too_early', httpStatus: 409 });
    expect(calls.cancel).toHaveLength(0);
    const later = Date.parse(store.rows[0]!.created_at) + 91_000;
    await cancelCharge(ctx, store.rows[0]!, { ...CANCEL, staff_id: STAFF } as never, later);
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
    store.rows.push({ ...store['add']({ ...input(), tenant_id: TENANT, idempotency_key: KEY, terminal_id: TERMINAL_UUID, provider: 'mercado_pago_point', external_terminal_id: MP_TERMINAL, method: 'CREDIT', amount_cents: 2450, status: 'creating', external_order_id: null, external_payment_id: null, raw_status: null, raw_status_detail: null, paid_amount_cents: null, card_brand: null, authorization_code: null, last_four: null, created_by: STAFF, dispatched_at: null, cancel_reason: null, cancel_requested_by: null, cancel_requested_at: null, cancel_authorized_by: null, cancel_audit_id: null } as never) });
    store.rows.splice(1);
    const reply = await cancelCharge(ctx, store.rows[0]!, CANCEL);
    expect(reply).toMatchObject({ status: 'DECLINED', reason: 'A cobrança não chegou à maquininha (nada foi cobrado).' });
    expect(calls.create).toHaveLength(0);
    expect(calls.cancel).toHaveLength(0);
    // Consulta depois do encerramento também não manda.
    expect((await pollCharge(ctx, store.rows[0]!)).status).toBe('DECLINED');
    expect(calls.create).toHaveLength(0);
  });

  it('r2 P1-02: leitura antiga ("creating" sem envio) depois do encerramento: a consulta não manda a ordem', async () => {
    const { ctx, store, calls } = setup({ create: async () => { throw new PaymentTerminalProviderError('timeout', { outcomeUnknown: true }); } });
    store.refuse = null;
    await startCharge(ctx, terminal, input()); // envio marcado, resultado desconhecido
    expect(store.rows[0]).toMatchObject({ status: 'creating' });
    expect(store.rows[0]!.dispatched_at).not.toBeNull();
    const stale = { ...store.rows[0]! };
    await cancelCharge(ctx, stale, CANCEL); // envio desconhecido: não repete a criação
    expect(calls.create).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ status: 'creating', cancel_reason: 'timeout' });
    await pollCharge(ctx, stale);
    await pollCharge(ctx, store.rows[0]!);
    expect(calls.create).toHaveLength(1);
  });

  it('r2 P1-02: encerramento concorrente com o envio já marcado: a ordem que chega é cancelada na próxima volta', async () => {
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
    expect((await cancelCharge(ctx, store.rows[0]!, CANCEL)).status).toBe('PENDING'); // sem ordem ainda: não manda outra
    release(order());
    await creating;
    expect(store.rows[0]).toMatchObject({ external_order_id: 'ORD01', status: 'at_terminal' });
    expect((await cancelCharge(ctx, store.rows[0]!, CANCEL)).status).toBe('DECLINED');
    expect(calls.create).toHaveLength(1);
    expect(calls.cancel).toHaveLength(1);
  });

  it('envio sem resposta e encerrado: só o gerente libera, e só depois que o envio não pode mais estar a caminho', async () => {
    const { ctx, store, calls } = setup({ create: async () => { throw new PaymentTerminalProviderError('timeout', { outcomeUnknown: true }); } });
    await startCharge(ctx, terminal, input());
    const dispatched = Date.parse(store.rows[0]!.dispatched_at!);
    expect((await cancelCharge(ctx, store.rows[0]!, OPERATOR, dispatched + 10_000)).status).toBe('PENDING');
    expect(store.rows[0]!.status).toBe('creating');
    expect((await cancelCharge(ctx, store.rows[0]!, OPERATOR, dispatched + 121_000))).toMatchObject({ status: 'DECLINED', reason: 'Cobrança encerrada pelo gerente depois de conferir no app do Mercado Pago.' });
    expect(store.rows[0]).toMatchObject({ status: 'cancelled', raw_status: 'manager_released' });
    expect(calls.create).toHaveLength(1);
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

  it('sem cobrança gravada: grava o bloqueio da chave e a criação atrasada não chega à Point', async () => {
    const { ctx, store, calls } = setup();
    const voided = await voidCharge(ctx, terminal, { ...input(), ...CANCEL });
    expect(voided).toMatchObject({ status: 'DECLINED', reason: 'A cobrança não chegou à maquininha (nada foi cobrado).' });
    expect(store.rows[0]).toMatchObject({ status: 'cancelled', raw_status: 'voided_before_send', cancel_reason: 'void', cancel_requested_by: null, created_by: null });
    expect((await startCharge(ctx, terminal, input())).status).toBe('DECLINED');
    expect(calls.create).toHaveLength(0);
    expect((await pollCharge(ctx, store.rows[0]!)).status).toBe('DECLINED');
    expect(calls.create).toHaveLength(0);
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

describe('point-charge: reserva do saldo (auditoria r2 P0-01)', () => {
  it('antes de abrir outra cobrança na conta, reconsulta as abertas que têm ordem (sem mandar nenhuma)', async () => {
    let finished = false;
    const { ctx, store, calls } = setup({ get: async () => (finished ? order({ status: 'expired', rawStatus: 'expired' }) : order()) });
    await startCharge(ctx, terminal, input());
    // Uma segunda, gravada e nunca enviada (outro aparelho caiu no meio):
    store.rows.push({ ...store.rows[0]!, id: 'row-x', idempotency_key: 'outra-sem-envio', status: 'creating', external_order_id: null, dispatched_at: null });
    finished = true;
    await startCharge(ctx, terminal, input({ idempotency_key: 'nova-chave' }));
    expect(store.rows[0]!.status).toBe('expired'); // terminou no Mercado Pago: libera o saldo com prova
    expect(store.rows.find((r) => r.id === 'row-x')).toMatchObject({ status: 'creating', dispatched_at: null });
    expect(calls.create.map((c) => c.idempotencyKey)).toEqual([KEY, 'nova-chave']);
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
