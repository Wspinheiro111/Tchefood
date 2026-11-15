// @vitest-environment jsdom
/**
 * Conta encerrada como venda devolvida (ORDER_REFUNDED_WRITE_OFF): o valor baixado não é venda. Rateio dos 10%, KPIs
 * do turno e produtos vendidos contam só a parte que ficou paga.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { useTcheStore } from '../store/useTcheStore';
import { currentShiftPeriod, shiftKpis, waiterSplit } from '../lib/reports';
import { indexDashboard, productSales } from '../lib/ownerDashboard';
import { clearReviewHold } from '../lib/payments/reviewHolds';

const st = () => useTcheStore.getState();
const initial = useTcheStore.getState();
afterEach(() => {
  useTcheStore.setState(initial, true);
});

function openWithItems() {
  expect(st().login('1111').ok).toBe(true);
  const r = st().openTable(st().tables.find((t) => t.number === 1)!.id, 2, null);
  if (!r.ok) throw new Error(r.error);
  const orderId = r.data.id;
  const p = st().products.find((x) => x.code === '101') ?? st().products[1]!;
  st().addToTray({ order_id: orderId, product_id: p.id, half_product_ids: [], quantity: 2, unit_price: p.price, modifiers: [], modifiers_unit_price: 0,
    meat_doneness: p.requires_meat_doneness ? 'Ao Ponto' : null, quick_tags: [], free_notes: '', sector: p.sector });
  st().dispatchTray(orderId);
  return { orderId, productId: p.id };
}

function pay(orderId: string, amount: number, point: boolean, key: string) {
  const r = st().registerPayment({
    orderId, amount, method: point ? 'CREDIT' : 'CASH', status: 'APPROVED', terminal_id: null,
    acquirer: point ? 'MERCADO_PAGO' : 'CASH_DESK', acquirer_cnpj: point ? '10573521000191' : null,
    card_brand: point ? 'VISA' : null, nsu: point ? `nsu-${key}` : null, authorization_code: point ? 'A1' : null, terminal_serial: point ? 'N1' : null,
    idempotency_key: key, item_ids: [],
  });
  if (!r.ok) throw new Error(r.error);
}

/** Pago (parte em dinheiro opcional, resto na Point) → fechada → estorno da Point → encerrada como venda devolvida. */
function refundedAndWrittenOff(cashPart: number) {
  const { orderId, productId } = openWithItems();
  const total = st().orders.find((o) => o.id === orderId)!.remaining_balance;
  if (cashPart > 0) pay(orderId, cashPart, false, 'k-cash');
  pay(orderId, Math.round((total - cashPart) * 100) / 100, true, 'k-point');
  expect(st().orders.find((o) => o.id === orderId)!.status).toBe('CLOSED');
  const m = st().mirrorServerPointRefund('k-point', 'venda estornada', { paymentRegistered: true });
  expect(m.ok).toBe(true);
  clearReviewHold(orderId);
  const order = st().orders.find((o) => o.id === orderId)!;
  const writtenOffCents = Math.round(order.remaining_balance * 100) || Math.round((total - cashPart) * 100);
  if (order.status !== 'CLOSED') {
    const w = st().mirrorRefundedOrderWriteOff(orderId, { auditId: 'wo-1', managerId: null, writtenOffCents }, 'cliente desistiu da compra');
    expect(w.ok).toBe(true);
  } else {
    // Conta seguiu fechada: o registro do servidor é o mesmo.
    useTcheStore.setState((s) => ({ auditLogs: [{ id: 'wo-1', tenant_id: 't', order_id: orderId, performed_by_user_id: 'u', authorized_by_manager_id: null, action_type: 'ORDER_REFUNDED_WRITE_OFF', amount_impact: writtenOffCents / 100, reason: 'x', whatsapp_alert_sent: false, metadata: { written_off_cents: writtenOffCents }, created_at: new Date().toISOString() }, ...s.auditLogs] }));
  }
  expect(st().orders.find((o) => o.id === orderId)!.status).toBe('CLOSED');
  return { orderId, productId, total };
}

/** Só a conta do teste (a loja de demonstração já vem com contas e pagamentos). */
const views = (orderId: string) => {
  const all = st();
  const s = {
    ...all,
    orders: all.orders.filter((o) => o.id === orderId),
    orderItems: all.orderItems.filter((i) => i.order_id === orderId),
    payments: all.payments.filter((p) => p.order_id === orderId),
    auditLogs: all.auditLogs.filter((l) => l.order_id === orderId),
  };
  const period = currentShiftPeriod();
  const ix = indexDashboard({ orders: s.orders, orderItems: s.orderItems, payments: s.payments, tables: s.tables, products: s.products, auditLogs: s.auditLogs, loyaltyCustomers: [], cashbackLedger: [], marketplace: [] });
  const range = { from: period.start.getTime() - 86_400_000, to: Date.now() + 60_000 };
  return {
    kpis: shiftKpis(s.orders, s.payments, period, s.auditLogs),
    split: waiterSplit(s.orders, s.orderItems, s.staff, period, s.auditLogs),
    products: productSales(ix, range),
  };
};

describe('venda devolvida não é venda', () => {
  it('Point → fechada → estorno → encerrada: 0 de venda, sem comissão, não é conta fechada, produto não vendido', () => {
    const { orderId, productId } = refundedAndWrittenOff(0);
    const v = views(orderId);
    expect(v.kpis.grossRevenue).toBe(0);
    expect(v.kpis.closedOrders).toBe(0);
    expect(v.kpis.averageTicket).toBe(0);
    // GPT r11 P2-04: baixa integral não soma os 10% no indicador do turno.
    expect(st().orders.find((o) => o.id === orderId)!.service_fee_amount).toBeGreaterThan(0);
    expect(v.kpis.serviceFeeTotal).toBe(0);
    expect(v.split.reduce((a, r) => a + r.sales + r.commission + r.itemsSold, 0)).toBe(0);
    expect(v.products.find((p) => p.product_id === productId)?.sales ?? 0).toBe(0);
    expect(v.products.find((p) => p.product_id === productId)?.quantity ?? 0).toBe(0);
  });

  it('parcial: dinheiro pago e parte da Point estornada e baixada: só o dinheiro conta', () => {
    const { orderId, productId, total } = refundedAndWrittenOff(10);
    const v = views(orderId);
    const share = 10 / total;
    expect(v.kpis.grossRevenue).toBe(10);
    expect(v.kpis.closedOrders).toBe(1);
    expect(v.kpis.averageTicket).toBe(10);
    const fee = st().orders.find((o) => o.id === orderId)!.service_fee_amount;
    // GPT r11 P2-04: indicador e rateio na mesma proporção, centavo por centavo.
    const commission = v.split.reduce((a, r) => a + Math.round(r.commission * 100), 0);
    expect(Math.round(v.kpis.serviceFeeTotal * 100)).toBe(commission);
    expect(v.kpis.serviceFeeTotal).toBeCloseTo(fee * share, 2);
    expect(v.split.reduce((a, r) => a + r.commission, 0)).toBeCloseTo(fee * share, 2);
    const items = st().orderItems.filter((i) => i.order_id === orderId).reduce((a, i) => a + i.total_item_price, 0);
    expect(v.split.reduce((a, r) => a + r.sales, 0)).toBeCloseTo(items * share, 2);
    expect(v.products.find((p) => p.product_id === productId)!.sales).toBeCloseTo(items * share, 2);
  });

  it('conta sem baixa: tudo como antes', () => {
    const { orderId } = openWithItems();
    const total = st().orders.find((o) => o.id === orderId)!.remaining_balance;
    pay(orderId, total, true, 'k-ok');
    const v = views(orderId);
    expect(v.kpis).toMatchObject({ grossRevenue: total, closedOrders: 1, averageTicket: total });
    expect(v.split.reduce((a, r) => a + r.commission, 0)).toBeCloseTo(st().orders.find((o) => o.id === orderId)!.service_fee_amount, 2);
    expect(v.products.reduce((a, p) => a + p.sales, 0)).toBeGreaterThan(0);
  });
});
