// @vitest-environment jsdom
/**
 * Auditoria interna 1 (P1-B, P2-D): o espelho do estorno da Point (mirrorServerPointRefund) corrige a inclusão do
 * pagamento que ainda está na fila ou nos recusados (sobe estornada, que o servidor aceita com a cobrança estornada)
 * e não repete nada quando chamado de novo.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useTcheStore } from '../store/useTcheStore';
import { clearReviewHold, getReviewHoldByKey, setReviewHold } from '../lib/payments/reviewHolds';
import { applyOrderTotals } from '../lib/money';
import type { Payment, SyncEvent } from '../types';

const st = () => useTcheStore.getState();
const KEY = 'point-key-m';

function seed(where: 'outbox' | 'rejected'): { payment: Payment; ev: SyncEvent; orderId: string } {
  expect(st().login('1111').ok).toBe(true);
  const r = st().openTable(st().tables.find((t) => t.number === 1)!.id, 2, null);
  if (!r.ok) throw new Error(r.error);
  const orderId = r.data.id;
  const p = st().products.find((x) => x.code === '101')!;
  st().addToTray({ order_id: orderId, product_id: p.id, half_product_ids: [], quantity: 2, unit_price: p.price, modifiers: [], modifiers_unit_price: 0,
    meat_doneness: p.requires_meat_doneness ? 'Ao Ponto' : null, quick_tags: [], free_notes: '', sector: p.sector });
  st().dispatchTray(orderId);
  const order = st().orders.find((o) => o.id === orderId)!;
  const payment = {
    id: 'pay-m', order_id: orderId, tenant_id: order.tenant_id, waiter_id: st().currentUserId!, terminal_id: null, amount: 20, tip_amount: 0,
    method: 'CREDIT', status: 'APPROVED', acquirer: 'MERCADO_PAGO', acquirer_cnpj: '10573521000191', card_brand: 'MASTERCARD', nsu: '1',
    authorization_code: 'A', terminal_serial: 'N', idempotency_key: KEY, created_at: new Date().toISOString(),
  } as Payment;
  const payments = [...st().payments, payment];
  const orders = st().orders.map((o) => (o.id === orderId ? applyOrderTotals(o, st().orderItems, payments) : o));
  const ev: SyncEvent = { id: 'ev-m', table: 'payments', op: 'INSERT', row_id: payment.id, payload: { ...payment }, created_at: payment.created_at };
  useTcheStore.setState(where === 'outbox'
    ? { payments, orders, outbox: [ev], syncRejected: [] }
    : { payments, orders, outbox: [], syncRejected: [{ event: ev, status: 400, message: 'TCHEFOOD_PAGAMENTO: a cobrança está "refunded"', rejected_at: '' }] });
  return { payment, ev, orderId };
}

beforeEach(() => {
  st().resetDemo();
  for (const o of st().orders) clearReviewHold(o.id);
});

describe('mirrorServerPointRefund e a fila', () => {
  it.each(['outbox', 'rejected'] as const)('inclusão APROVADA (%s) passa a estornada, na fila e fora dos recusados', (where) => {
    const { payment, ev } = seed(where);
    expect(st().mirrorServerPointRefund(KEY, 'venda estornada na maquininha').ok).toBe(true);
    expect(st().payments.find((p) => p.id === payment.id)!.status).toBe('REFUNDED');
    expect(st().syncRejected).toEqual([]);
    const queued = st().outbox.filter((e) => e.id === ev.id);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.payload.status).toBe('REFUNDED');
    // "Reenviar recusados" não traz de volta a versão aprovada.
    st().retryRejectedSync();
    expect(st().outbox.filter((e) => e.row_id === payment.id).map((e) => e.payload.status)).toEqual(['REFUNDED']);
  });

  it('P2-D: repetido não grava outro registro nem mexe na trava; sem pagamento aqui não grava registro', () => {
    const { orderId } = seed('outbox');
    const n = st().auditLogs.length;
    st().mirrorServerPointRefund(KEY, 'venda estornada na maquininha');
    expect(st().auditLogs.length).toBe(n + 1);
    setReviewHold({ order_id: orderId, amount: 20, reason: 'outra', code: 'MANUAL_REVIEW', acquirer: 'MERCADO_PAGO', idempotency_key: KEY });
    st().mirrorServerPointRefund(KEY, 'venda estornada na maquininha');
    expect(st().auditLogs.length).toBe(n + 1);
    expect(getReviewHoldByKey(KEY)).not.toBeNull();
    const m = st().auditLogs.length;
    setReviewHold({ order_id: orderId, amount: 5, reason: 'x', code: 'MANUAL_REVIEW', acquirer: 'MERCADO_PAGO', idempotency_key: 'sem-pagamento' });
    expect(st().mirrorServerPointRefund('sem-pagamento', 'venda estornada na maquininha').ok).toBe(true);
    expect(st().auditLogs.length).toBe(m);
    expect(getReviewHoldByKey('sem-pagamento')).toBeNull();
  });
});
