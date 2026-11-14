// @vitest-environment jsdom
/**
 * Auditoria GPT r9 (P1-01): estorno de pagamento da Point já registrado. O aparelho pede (ação `refund`), o servidor
 * só grava com o Mercado Pago provando, e só a resposta REFUNDED do servidor muda alguma coisa aqui.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useTcheStore } from '../store/useTcheStore';
import { clearReviewHold, getReviewHoldByKey, setReviewHold } from '../lib/payments/reviewHolds';
import { RECONCILE_TIMEOUT_MS, refundPointPayment, type ReconcileDeps } from '../lib/payments/pointReconcile';
import { submitPointRefund } from '../components/PointRefund';
import { AUDIT_LABEL } from '../lib/reports';
import { applyOrderTotals } from '../lib/money';
import type { Payment } from '../types';

const st = () => useTcheStore.getState();
const KEY = 'point-key-1';
const OTHER = 'point-key-2';
const CFG = { url: 'https://x.supabase.co', anonKey: 'anon', accessToken: 'jwt' };
const INPUT = { idempotency_key: KEY, staff_id: 'staff-1', manager_pin: '1234', reason_text: 'venda estornada na maquininha' };

type Answer = { status: number; body: unknown } | 'network' | 'hang';
function deps(answer: Answer, over: Partial<ReconcileDeps> = {}) {
  const calls: Record<string, unknown>[] = [];
  let fire: (() => void) | null = null;
  const d: ReconcileDeps = {
    config: async () => CFG,
    fetch: async (_url, init) => {
      calls.push(JSON.parse(init.body) as Record<string, unknown>);
      if (answer === 'network') throw new Error('rede');
      if (answer === 'hang') {
        fire?.();
        return new Promise(() => undefined);
      }
      const body = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body);
      return { status: answer.status, text: async () => body };
    },
    timer: (ms) => new Promise<void>((r) => {
      expect(ms).toBe(RECONCILE_TIMEOUT_MS);
      fire = () => setTimeout(r, 0);
    }),
    ...over,
  };
  return { d, calls };
}

const REFUNDED = { status: 200, body: { status: 'DECLINED', idempotency_key: KEY, code: 'REFUNDED', reason: 'O Mercado Pago confirmou o estorno.' } };

describe('refundPointPayment', () => {
  it('manda a ação refund com PIN, motivo e operador (sem nada do Mercado Pago)', async () => {
    const { d, calls } = deps(REFUNDED);
    expect(await refundPointPayment(INPUT, d)).toEqual({ kind: 'refunded' });
    expect(calls).toEqual([{ action: 'refund', idempotency_key: KEY, staff_id: 'staff-1', manager_pin: '1234', reason_text: 'venda estornada na maquininha' }]);
  });

  it('MANUAL_REVIEW: not_proven com o código e o texto do servidor', async () => {
    const { d } = deps({ status: 200, body: { status: 'MANUAL_REVIEW', idempotency_key: KEY, code: 'CHARGEBACK', reason: 'contestação não prova estorno' } });
    expect(await refundPointPayment(INPUT, d)).toEqual({ kind: 'not_proven', code: 'CHARGEBACK', error: 'contestação não prova estorno' });
  });

  it('403: PIN; 409/400/404 da função: recusado com a mensagem dela', async () => {
    expect(await refundPointPayment(INPUT, deps({ status: 403, body: { error: 'manager_denied', message: 'PIN errado' } }).d)).toEqual({ kind: 'pin', error: 'PIN errado' });
    for (const status of [400, 404, 409]) {
      expect(await refundPointPayment(INPUT, deps({ status, body: { error: 'not_applicable', message: `recusa ${status}` } }).d)).toEqual({ kind: 'refused', error: `recusa ${status}` });
    }
  });

  it.each<[string, Answer]>([
    ['rede', 'network'],
    ['prazo', 'hang'],
    ['500', { status: 500, body: { error: 'internal', message: 'falha' } }],
    ['502 HTML', { status: 502, body: '<html>502</html>' }],
    ['409 sem corpo da função (proxy)', { status: 409, body: '<html>conflict</html>' }],
    ['200 de outra cobrança', { status: 200, body: { ...REFUNDED.body, idempotency_key: OTHER } }],
    ['200 APPROVED', { status: 200, body: { status: 'APPROVED', idempotency_key: KEY } }],
    ['200 DECLINED sem REFUNDED', { status: 200, body: { status: 'DECLINED', idempotency_key: KEY, reason: 'recusada' } }],
    ['200 ilegível', { status: 200, body: 'ok' }],
  ])('%s: unknown (o estorno pode ter sido gravado; repetir é seguro), nunca refunded', async (_n, a) => {
    const r = await refundPointPayment(INPUT, deps(a).d);
    expect(r.kind).toBe('unknown');
  });

  it('sem sessão da nuvem: recusado sem enviar nada; PIN e motivo inválidos não enviam', async () => {
    const none = deps(REFUNDED, { config: async () => null });
    expect((await refundPointPayment(INPUT, none.d)).kind).toBe('refused');
    expect(none.calls).toHaveLength(0);
    const bad = deps(REFUNDED);
    expect((await refundPointPayment({ ...INPUT, manager_pin: '12' }, bad.d)).kind).toBe('pin');
    expect((await refundPointPayment({ ...INPUT, reason_text: 'curto' }, bad.d)).kind).toBe('refused');
    expect(bad.calls).toHaveLength(0);
  });
});

describe('espelho do estorno gravado no servidor', () => {
  let orderId: string;

  /** Conta aberta com um pagamento da Point de R$ 20,00 registrado (já no servidor). */
  function seedPointPayment(): Payment {
    expect(st().login('1111').ok).toBe(true);
    const table = st().tables.find((t) => t.number === 1)!;
    const r = st().openTable(table.id, 2, null);
    if (!r.ok) throw new Error(r.error);
    orderId = r.data.id;
    const p = st().products.find((x) => x.code === '101')!;
    st().addToTray({
      order_id: orderId, product_id: p.id, half_product_ids: [], quantity: 2, unit_price: p.price, modifiers: [], modifiers_unit_price: 0,
      meat_doneness: p.requires_meat_doneness ? 'Ao Ponto' : null, quick_tags: [], free_notes: '', sector: p.sector,
    });
    st().dispatchTray(orderId);
    expect(st().startCheckout(orderId).ok).toBe(true);
    const order = st().orders.find((o) => o.id === orderId)!;
    const payment: Payment = {
      id: 'pay-point-1', order_id: orderId, tenant_id: order.tenant_id, waiter_id: st().currentUserId!, terminal_id: null, amount: 20, tip_amount: 0,
      method: 'CREDIT', status: 'APPROVED', acquirer: 'MERCADO_PAGO', acquirer_cnpj: '10573521000191', card_brand: 'MASTERCARD', nsu: '123456789',
      authorization_code: 'A1B2C3', terminal_serial: 'NEWLAND', idempotency_key: KEY, created_at: new Date().toISOString(),
    } as Payment;
    const payments = [...st().payments, payment];
    const orders = st().orders.map((o) => (o.id === orderId ? applyOrderTotals(o, st().orderItems, payments) : o));
    useTcheStore.setState({ payments, orders, outbox: [] });
    return payment;
  }

  beforeEach(() => {
    st().resetDemo();
    for (const o of st().orders) clearReviewHold(o.id);
  });

  it('REFUNDED do servidor: pagamento REFUNDED, saldo volta, trava da chave sai, registro só local (nada na fila)', async () => {
    const payment = seedPointPayment();
    const before = st().orders.find((o) => o.id === orderId)!;
    setReviewHold({ order_id: orderId, amount: 20, reason: 'trava', code: 'CLAIM_UNCONFIRMED', idempotency_key: KEY, acquirer: 'MERCADO_PAGO' });
    setReviewHold({ order_id: orderId, amount: 5, reason: 'outra', code: 'CLAIM_UNCONFIRMED', idempotency_key: OTHER, acquirer: 'MERCADO_PAGO' });
    const { d } = deps(REFUNDED);
    const r = await submitPointRefund(payment, '1234', 'venda estornada na maquininha', d);
    expect(r).toEqual({ ok: true, data: { nfceIssued: false } });
    expect(st().payments.find((p) => p.id === payment.id)!.status).toBe('REFUNDED');
    const after = st().orders.find((o) => o.id === orderId)!;
    expect(after.remaining_balance).toBeCloseTo(before.remaining_balance + 20, 2);
    expect(after.status).toBe(before.status);
    expect(getReviewHoldByKey(KEY)).toBeNull();
    expect(getReviewHoldByKey(OTHER)).not.toBeNull();
    expect(st().outbox).toHaveLength(0);
    expect(st().auditLogs[0]).toMatchObject({ action_type: 'POINT_PAYMENT_REFUNDED', order_id: orderId, reason: 'venda estornada na maquininha', metadata: { idempotency_key: KEY, server_verified: true } });
    expect(AUDIT_LABEL.POINT_PAYMENT_REFUNDED).toMatch(/estornado/);
  });

  it('saldo: o pagamento estornado deixa de abater a conta', async () => {
    const payment = seedPointPayment();
    const withPayment = st().orders.find((o) => o.id === orderId)!.remaining_balance;
    await submitPointRefund(payment, '1234', 'venda estornada na maquininha', deps(REFUNDED).d);
    const after = st().orders.find((o) => o.id === orderId)!;
    expect(after.remaining_balance).toBeCloseTo(withPayment + 20, 2);
  });

  it('conta fechada segue fechada (como no servidor)', async () => {
    const payment = seedPointPayment();
    useTcheStore.setState({ orders: st().orders.map((o) => (o.id === orderId ? { ...o, status: 'CLOSED', closed_at: '2026-11-14T12:00:00.000Z' } : o)) });
    await submitPointRefund(payment, '1234', 'venda estornada na maquininha', deps(REFUNDED).d);
    expect(st().orders.find((o) => o.id === orderId)).toMatchObject({ status: 'CLOSED', closed_at: '2026-11-14T12:00:00.000Z' });
    expect(st().payments.find((p) => p.id === payment.id)!.status).toBe('REFUNDED');
  });

  it.each<[string, Answer]>([
    ['not_proven', { status: 200, body: { status: 'MANUAL_REVIEW', idempotency_key: KEY, code: 'NOT_REFUNDED', reason: 'não mostra estorno' } }],
    ['PIN', { status: 403, body: { error: 'manager_denied', message: 'PIN errado' } }],
    ['recusa', { status: 409, body: { error: 'refund_refused', message: 'não confere' } }],
    ['sem resposta', 'network'],
  ])('%s: nada muda aqui (pagamento, saldo, trava)', async (_n, a) => {
    const payment = seedPointPayment();
    setReviewHold({ order_id: orderId, amount: 20, reason: 'trava', code: 'CLAIM_UNCONFIRMED', idempotency_key: KEY, acquirer: 'MERCADO_PAGO' });
    const before = { payments: st().payments, orders: st().orders, logs: st().auditLogs.length };
    const r = await submitPointRefund(payment, '1234', 'venda estornada na maquininha', deps(a).d);
    expect(r.ok).toBe(false);
    expect(st().payments).toBe(before.payments);
    expect(st().orders).toBe(before.orders);
    expect(st().auditLogs).toHaveLength(before.logs);
    expect(getReviewHoldByKey(KEY)).not.toBeNull();
  });

  it('pagamento que não é da Point: recusado sem chamar o servidor', async () => {
    const payment = seedPointPayment();
    const { d, calls } = deps(REFUNDED);
    expect((await submitPointRefund({ ...payment, acquirer: 'STONE' }, '1234', 'venda estornada', d)).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
