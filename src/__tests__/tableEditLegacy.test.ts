/**
 * Mudança da mesa gravada na fila por uma versão anterior (sem table_edit_fields): na recuperação
 * de conta recusada, de itens atrasados, no descarte e na leitura que libera a mesa, o nome, a
 * área e os lugares mudados aqui continuam subindo, sem a ocupação velha (GPT, rodada 10 do PR #54).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { CloudOrders } from '../lib/sync/orderPull';
import { useTcheStore, type CloudSession } from '../store/useTcheStore';
import type { DiningTable, Order, OrderItem, SyncEvent } from '../types';

const st = () => useTcheStore.getState();
const O1 = '01010101-0101-4101-8101-010101010101';
const O2 = '02020202-0202-4202-8202-020202020202';
const NOW = '2026-11-14T20:00:00.000Z';
const LATE = 'TCHEFOOD_CONTA_ENCERRADA: a conta já foi encerrada';
const busy = (tableId: string, holder: string) =>
  `TCHEFOOD_MESA_OCUPADA: Mesa já está com outra conta aberta — {"table_id": "${tableId}", "holder_order_id": "${holder}"}`;

const order = (id: string, tableId: string, over: Partial<Order> = {}): Order => ({
  id, tenant_id: st().tenant.id, table_id: tableId, opened_by_user_id: 'u', status: 'OPEN', customer_count: 2, customer_cpf: null, subtotal_items: 100,
  charge_service_fee: true, service_fee_pct: 10, service_fee_amount: 10, discount_amount: 0, total_amount: 110, paid_amount: 0, remaining_balance: 110,
  nfce_status: 'PENDING', nfce_key: null, opened_at: NOW, closed_at: null, pickup_number: null, pickup_name: null, fulfillment_type: null, ...over,
});
const item = (id: string, orderId: string, over: Partial<OrderItem> = {}): OrderItem => ({
  id, order_id: orderId, product_id: 'p1', waiter_id: 'u', quantity: 1, unit_price: 10, modifiers_unit_price: 0, total_item_price: 10,
  meat_doneness: null, notes: null, sector: 'BAR', status: 'PENDING', is_paid: false, origin: 'WAITER', created_at: NOW, prepared_at: null,
  canceled_at: null, canceled_by_user_id: null, cancel_reason: null, weight_gross_grams: null, weight_tare_grams: null, weight_source: null,
  keg_volume_ml: null, combo_parent_item_id: null, priced_at: NOW, half_product_ids: [], modifier_option_ids: [], ...over,
});
const ev = (table: SyncEvent['table'], rowId: string, payload: Record<string, unknown>, over: Partial<SyncEvent> = {}): SyncEvent => ({
  id: `e-${table}-${rowId}`, table, op: 'UPDATE', row_id: rowId, payload: { id: rowId, ...payload }, created_at: NOW, ...over,
});
const cloud = (over: Partial<CloudOrders> = {}): CloudOrders => ({
  tenant_id: st().tenant.id, server_now: NOW, orders: [], orderItems: [], payments: [], ownDeliveries: [], tables: [], cashSessions: [], skippedOrderIds: [], ...over,
});
const session = (tenantId: string): CloudSession => ({
  url: 'https://x.supabase.co', anon_key: 'anon', email: 'a@b', access_token: 'jwt', refresh_token: 'r', expires_at: 9e9, tenant_id: tenantId,
});

/** Evento da versão anterior: a linha inteira da mesa, com nome e lugares mudados aqui e a ocupação da hora. */
const legacy = (t: DiningTable, orderId: string): SyncEvent =>
  ev('dining_tables', t.id, { ...t, label: 'Varanda 1', capacity: 8, status: 'OCCUPIED', current_order_id: orderId }, { id: 'e-legado' });

const CADASTRO = ['active', 'area', 'capacity', 'id', 'label', 'number', 'tenant_id', 'updated_at'];

/** O evento legado continua na fila só com o cadastro da mesa, sem a ocupação velha. */
function expectCadastroOnly(e: SyncEvent | undefined) {
  expect(e).toBeDefined();
  expect(e!.payload).toMatchObject({ label: 'Varanda 1', capacity: 8 });
  expect(e!.payload).not.toHaveProperty('status');
  expect(e!.payload).not.toHaveProperty('current_order_id');
  expect(Object.keys(e!.payload).sort()).toEqual(CADASTRO);
  expect(e!.table_edit_fields).toEqual(['number', 'label', 'area', 'capacity', 'active']);
}

beforeEach(() => st().resetDemo());

/** Conta O1 encerrada em outro aparelho; a cerveja lançada aqui foi recusada. */
function lateSetup(outbox: (free: DiningTable) => SyncEvent[]) {
  st().login('1111');
  const free = st().tables.find((t) => t.status === 'FREE' && t.kind === 'TABLE')!;
  const beer = item('cerveja', O1, { product_id: st().products[0]!.id });
  useTcheStore.setState({
    cloud: session(st().tenant.id),
    orders: [...st().orders, order(O1, free.id, { status: 'CLOSED' })],
    orderItems: [...st().orderItems, beer],
    outbox: outbox(free),
    syncRejected: [{ event: ev('order_items', beer.id, { ...beer }, { op: 'INSERT', id: 'e-cerveja' }), status: 400, message: LATE, rejected_at: NOW }],
  });
  return { free };
}

describe('mudança da mesa da versão anterior (sem table_edit_fields) (GPT, rodada 10 do PR #54)', () => {
  it('itens atrasados para conta nova: o cadastro continua subindo, sem a ocupação', () => {
    lateSetup((free) => [legacy(free, O1)]);
    const r = st().moveLateItemsToNewOrder('e-cerveja');
    if (!r.ok) throw new Error(r.error);
    expectCadastroOnly(st().outbox.find((e) => e.id === 'e-legado'));
  });

  it('conta recusada juntada à conta da mesa: o cadastro continua subindo, sem a ocupação', () => {
    st().login('1111');
    const free = st().tables.find((t) => t.status === 'FREE' && t.kind === 'TABLE')!;
    const opened = st().openTable(free.id, 2, null);
    if (!opened.ok) throw new Error(opened.error);
    const y = opened.data;
    const insert = st().outbox.find((e) => e.table === 'orders' && e.row_id === y.id)!;
    useTcheStore.setState({
      orders: [...st().orders, order(O2, free.id)],
      // Fila da versão anterior: a ocupação da abertura não tem table_edit_fields.
      outbox: [...st().outbox.filter((e) => e.id !== insert.id && e.table !== 'dining_tables'), legacy(free, y.id)],
      syncRejected: [{ event: insert, status: 400, message: busy(free.id, O2), rejected_at: NOW }],
    });
    const r = st().moveRejectedOrderToTableOrder(insert.id);
    if (!r.ok) throw new Error(r.error);
    expectCadastroOnly(st().outbox.find((e) => e.id === 'e-legado'));
  });

  it('descarte da conta de itens atrasados: o cadastro continua subindo, sem a ocupação', () => {
    const { free } = lateSetup(() => []);
    const m = st().moveLateItemsToNewOrder('e-cerveja');
    if (!m.ok) throw new Error(m.error);
    const freshId = m.data.newOrderId;
    const insert = st().outbox.find((e) => e.table === 'orders' && e.op === 'INSERT' && e.row_id === freshId)!;
    useTcheStore.setState({
      outbox: [...st().outbox.filter((e) => e.id !== insert.id), legacy(free, freshId)],
      syncRejected: [{ event: insert, status: 409, rejected_at: NOW, message: busy(free.id, O2) }],
    });
    st().login('9999');
    const r = st().discardLateItemsOrder(insert.id);
    if (!r.ok) throw new Error(r.error);
    expectCadastroOnly(st().outbox.find((e) => e.id === 'e-legado'));
  });

  it('leitura da nuvem que dá a mesa a outra conta: o cadastro continua subindo, sem a ocupação', () => {
    const { free } = lateSetup(() => []);
    const m = st().moveLateItemsToNewOrder('e-cerveja');
    if (!m.ok) throw new Error(m.error);
    const freshId = m.data.newOrderId;
    const insert = st().outbox.find((e) => e.table === 'orders' && e.op === 'INSERT' && e.row_id === freshId)!;
    useTcheStore.setState({
      outbox: [...st().outbox.filter((e) => e.id !== insert.id), legacy(free, freshId)],
      syncRejected: [{ event: insert, status: 409, rejected_at: NOW, message: busy(free.id, O2) }],
    });
    const r = st().applyCloudOrders(cloud({
      orders: [order(O2, free.id)],
      tables: [{ id: free.id, status: 'OCCUPIED', current_order_id: O2, updated_at: NOW }],
    }));
    expect(r.ok).toBe(true);
    expectCadastroOnly(st().outbox.find((e) => e.id === 'e-legado'));
  });
});

describe('formato novo continua como antes (GPT, rodada 10 do PR #54)', () => {
  it('a ocupação gravada por esta versão leva table_edit_fields vazio e sai da fila na recuperação', () => {
    st().login('1111');
    const free = st().tables.find((t) => t.status === 'FREE' && t.kind === 'TABLE')!;
    const opened = st().openTable(free.id, 2, null);
    if (!opened.ok) throw new Error(opened.error);
    const y = opened.data;
    const occupy = st().outbox.find((e) => e.table === 'dining_tables' && e.row_id === free.id)!;
    expect(occupy.table_edit_fields).toEqual([]);
    const insert = st().outbox.find((e) => e.table === 'orders' && e.row_id === y.id)!;
    useTcheStore.setState({
      orders: [...st().orders, order(O2, free.id)],
      outbox: st().outbox.filter((e) => e.id !== insert.id),
      syncRejected: [{ event: insert, status: 400, message: busy(free.id, O2), rejected_at: NOW }],
    });
    expect(st().moveRejectedOrderToTableOrder(insert.id).ok).toBe(true);
    expect(st().outbox.some((e) => e.id === occupy.id)).toBe(false);
  });

  it('mudança do cadastro desta versão: só os campos listados sobem', () => {
    lateSetup((free) => [ev('dining_tables', free.id, { ...free, label: 'Varanda 1', capacity: 8, status: 'OCCUPIED', current_order_id: O1 }, { id: 'e-novo', table_edit_fields: ['label'] })]);
    const r = st().moveLateItemsToNewOrder('e-cerveja');
    if (!r.ok) throw new Error(r.error);
    const kept = st().outbox.find((e) => e.id === 'e-novo')!;
    expect(Object.keys(kept.payload).sort()).toEqual(['id', 'label', 'tenant_id', 'updated_at']);
  });
});
