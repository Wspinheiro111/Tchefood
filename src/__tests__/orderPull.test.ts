/**
 * Contas e mesas que descem da nuvem (src/lib/sync/orderPull.ts): a nuvem manda no dinheiro, a
 * conta com mudança deste aparelho ainda pendente fica como está, e a leitura inválida não
 * aplica nada.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { mergeCloudOrders, missingCatalog, parseCloudOrders, pendingOrderKeys, type CloudOrders } from '../lib/sync/orderPull';
import { useTcheStore, type CloudSession } from '../store/useTcheStore';
import type { DiningTable, Order, OrderItem, Payment, SyncEvent } from '../types';

const st = () => useTcheStore.getState();
const TEN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const O1 = '01010101-0101-4101-8101-010101010101';
const O2 = '02020202-0202-4202-8202-020202020202';
const T1 = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
const T2 = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';
const NOW = '2026-11-14T20:00:00.000Z';

const order = (id: string, over: Partial<Order> = {}): Order => ({
  id, tenant_id: TEN, table_id: T1, opened_by_user_id: 'u', status: 'OPEN', customer_count: 2, customer_cpf: null, subtotal_items: 50,
  charge_service_fee: true, service_fee_pct: 10, service_fee_amount: 5, discount_amount: 0, total_amount: 55, paid_amount: 0, remaining_balance: 55,
  nfce_status: 'PENDING', nfce_key: null, opened_at: NOW, closed_at: null, pickup_number: null, pickup_name: null, fulfillment_type: null, ...over,
});
const item = (id: string, orderId: string, over: Partial<OrderItem> = {}): OrderItem => ({
  id, order_id: orderId, product_id: 'p1', waiter_id: 'u', quantity: 1, unit_price: 50, modifiers_unit_price: 0, total_item_price: 50,
  meat_doneness: null, notes: null, sector: 'KITCHEN', status: 'PENDING', is_paid: false, origin: 'WAITER', created_at: NOW, prepared_at: null,
  canceled_at: null, canceled_by_user_id: null, cancel_reason: null, weight_gross_grams: null, weight_tare_grams: null, weight_source: null,
  keg_volume_ml: null, combo_parent_item_id: null, priced_at: NOW, half_product_ids: [], modifier_option_ids: [], ...over,
});
const payment = (id: string, orderId: string, amount: number): Payment => ({
  id, order_id: orderId, tenant_id: TEN, waiter_id: 'u', terminal_id: null, amount, tip_amount: 0, method: 'CREDIT', status: 'APPROVED', acquirer: 'STONE',
  acquirer_cnpj: null, card_brand: 'VISA', nsu: '1', authorization_code: 'A', terminal_serial: 'S', idempotency_key: id, created_at: NOW,
});
const table = (id: string, over: Partial<DiningTable> = {}): DiningTable => ({
  id, tenant_id: TEN, number: 1, label: 'Mesa 1', area: 'Salão', capacity: 4, status: 'FREE', qr_code_token: null, current_order_id: null,
  active: true, updated_at: NOW, kind: 'TABLE', ...over,
});
const cloud = (over: Partial<CloudOrders> = {}): CloudOrders => ({ tenant_id: TEN, server_now: NOW, orders: [], orderItems: [], payments: [], tables: [], ...over });
const ev = (table: SyncEvent['table'], rowId: string, payload: Record<string, unknown> = {}, over: Partial<SyncEvent> = {}): SyncEvent => ({
  id: `e-${table}-${rowId}`, table, op: 'UPDATE', row_id: rowId, payload: { id: rowId, ...payload }, created_at: NOW, ...over,
});
const none = pendingOrderKeys([]);

describe('mergeCloudOrders', () => {
  it('conta sem nada pendente fica igual à da nuvem: totais, itens e pagamentos do banco', () => {
    const local = { orders: [order(O1)], orderItems: [item('i1', O1)], payments: [], tables: [table(T1, { status: 'OCCUPIED', current_order_id: O1 })] };
    const c = cloud({
      orders: [order(O1, { subtotal_items: 80, service_fee_amount: 8, total_amount: 88, paid_amount: 40, remaining_balance: 48, status: 'PAYING' })],
      orderItems: [item('i1', O1, { status: 'READY' }), item('i2', O1, { unit_price: 30, total_item_price: 30 })],
      payments: [payment('pg1', O1, 40)],
      tables: [{ id: T1, status: 'PAYING', current_order_id: O1, updated_at: NOW }],
    });
    const r = mergeCloudOrders(local, c, none);
    expect(r.orders[0]).toMatchObject({ total_amount: 88, paid_amount: 40, remaining_balance: 48, status: 'PAYING' });
    expect(r.orderItems.map((i) => `${i.id}:${i.status}`)).toEqual(['i1:READY', 'i2:PENDING']);
    expect(r.payments.map((p) => p.amount)).toEqual([40]);
    expect(r.tables[0]).toMatchObject({ status: 'PAYING', current_order_id: O1 });
  });

  it('item ou pagamento só deste aparelho numa conta sem nada pendente sai (o banco não o tem)', () => {
    const local = { orders: [order(O1)], orderItems: [item('i1', O1), item('fantasma', O1)], payments: [payment('pgx', O1, 10)], tables: [] };
    const r = mergeCloudOrders(local, cloud({ orders: [order(O1)], orderItems: [item('i1', O1)] }), none);
    expect(r.orderItems.map((i) => i.id)).toEqual(['i1']);
    expect(r.payments).toEqual([]);
  });

  it('conta com evento na fila ou recusado fica inteira como está aqui (conta, itens, pagamentos e mesa)', () => {
    const local = {
      orders: [order(O1, { customer_count: 5 })],
      orderItems: [item('i1', O1)],
      payments: [payment('pg1', O1, 10)],
      tables: [table(T1, { status: 'OCCUPIED', current_order_id: O1 })],
    };
    const c = cloud({ orders: [order(O1, { status: 'CLOSED', remaining_balance: 0 })], orderItems: [item('i9', O1)], tables: [{ id: T1, status: 'FREE', current_order_id: null, updated_at: NOW }] });
    for (const pending of [
      [ev('orders', O1)],
      [ev('order_items', 'i1', { order_id: O1 }, { op: 'INSERT' })],
      [ev('payments', 'pg1', { order_id: O1 }, { op: 'INSERT' })],
      [ev('audit_logs', 'a1', { order_id: O1 }, { op: 'INSERT' })],
      [ev('cashback_ledger', 'c1', {}, { op: 'INSERT', depends_on_order_id: O1 })],
    ]) {
      const r = mergeCloudOrders(local, c, pendingOrderKeys(pending));
      expect(r.orders[0]!.customer_count, pending[0]!.table).toBe(5);
      expect(r.orders[0]!.status).toBe('OPEN');
      expect(r.orderItems.map((i) => i.id)).toEqual(['i1']);
      expect(r.payments.map((p) => p.id)).toEqual(['pg1']);
      expect(r.tables[0]).toMatchObject({ status: 'OCCUPIED', current_order_id: O1 });
    }
  });

  it('cobrança em andamento na maquininha deste aparelho segura a conta', () => {
    const local = { orders: [order(O1)], orderItems: [], payments: [], tables: [] };
    const r = mergeCloudOrders(local, cloud({ orders: [order(O1, { status: 'CLOSED' })] }), pendingOrderKeys([], [O1]));
    expect(r.orders[0]!.status).toBe('OPEN');
  });

  it('mesa com mudança daqui pendente fica como está; sem pendência, a ocupação vem da nuvem', () => {
    const local = { orders: [], orderItems: [], payments: [], tables: [table(T1, { status: 'WAITING_BILL', current_order_id: O2 }), table(T2)] };
    const c = cloud({ orders: [order(O2, { table_id: T1 }), order(O1, { table_id: T2 })], tables: [{ id: T1, status: 'OCCUPIED', current_order_id: O2, updated_at: NOW }, { id: T2, status: 'OCCUPIED', current_order_id: O1, updated_at: NOW }] });
    const r = mergeCloudOrders(local, c, pendingOrderKeys([ev('dining_tables', T1, { current_order_id: O2 })]));
    expect(r.tables[0]).toMatchObject({ status: 'WAITING_BILL', current_order_id: O2 });
    expect(r.tables[1]).toMatchObject({ status: 'OCCUPIED', current_order_id: O1, label: 'Mesa 1', active: true });
    expect(r.orders.map((o) => o.id)).toEqual([O1]); // O2 está pendente (pela mesa) e não existe aqui: não entra pela metade
  });

  it('conta aberta daqui que a nuvem não mandou continua no mapa (não some a conta)', () => {
    const local = { orders: [order(O1)], orderItems: [item('i1', O1)], payments: [], tables: [table(T1, { status: 'OCCUPIED', current_order_id: O1 })] };
    const r = mergeCloudOrders(local, cloud({ tables: [{ id: T1, status: 'FREE', current_order_id: null, updated_at: NOW }] }), none);
    expect(r.orders).toHaveLength(1);
    expect(r.orderItems).toHaveLength(1);
    expect(r.tables[0]).toMatchObject({ status: 'OCCUPIED', current_order_id: O1 });
  });

  it('conta encerrada há mais de 24 h (fora da leitura) fica como histórico deste aparelho', () => {
    const old = order(O1, { status: 'CLOSED', closed_at: '2026-11-10T20:00:00.000Z', remaining_balance: 0, paid_amount: 55 });
    const r = mergeCloudOrders({ orders: [old], orderItems: [item('i1', O1)], payments: [payment('pg1', O1, 55)], tables: [] }, cloud(), none);
    expect(r.orders).toEqual([old]);
    expect(r.payments).toHaveLength(1);
  });

  it('NFC-e: vale a do servidor quando ele tem uma; sem ela, fica a daqui', () => {
    const local = { orders: [order(O1, { status: 'CLOSED', nfce_status: 'AUTORIZADA', nfce_key: 'K-LOCAL' })], orderItems: [], payments: [], tables: [] };
    expect(mergeCloudOrders(local, cloud({ orders: [order(O1, { status: 'CLOSED' })] }), none).orders[0]).toMatchObject({ nfce_status: 'AUTORIZADA', nfce_key: 'K-LOCAL' });
    expect(mergeCloudOrders(local, cloud({ orders: [order(O1, { status: 'CLOSED', nfce_status: 'AUTHORIZED', nfce_key: 'K-SEFAZ' })] }), none).orders[0])
      .toMatchObject({ nfce_status: 'AUTHORIZED', nfce_key: 'K-SEFAZ' });
  });

  it('conta nova de outro aparelho entra com itens e pagamentos', () => {
    const c = cloud({ orders: [order(O2, { table_id: T2 })], orderItems: [item('i5', O2)], payments: [payment('pg5', O2, 5)] });
    const r = mergeCloudOrders({ orders: [order(O1)], orderItems: [], payments: [], tables: [] }, c, none);
    expect(r.orders.map((o) => o.id)).toEqual([O1, O2]);
    expect(r.orderItems.map((i) => i.id)).toEqual(['i5']);
    expect(r.payments.map((p) => p.id)).toEqual(['pg5']);
  });

  it('missingCatalog: produto ou mesa que este aparelho não tem', () => {
    const c = cloud({ orders: [order(O1)], orderItems: [item('i1', O1)] });
    expect(missingCatalog(c, { productIds: ['p1'], tableIds: [T1] })).toBe(false);
    expect(missingCatalog(c, { productIds: [], tableIds: [T1] })).toBe(true);
    expect(missingCatalog(c, { productIds: ['p1'], tableIds: [] })).toBe(true);
  });
});

describe('parseCloudOrders', () => {
  const body = () => ({
    tenant_id: TEN,
    server_now: '2026-11-14 20:00:00.123+00',
    orders: [{ ...order(O1), total_amount: '55.00', opened_at: '2026-11-14 19:00:00+00' }],
    order_items: [{ ...item('i1', O1), quantity: '1.000', half_product_ids: null }],
    payments: [{ ...payment('pg1', O1, 10), amount: '10.00' }],
    tables: [{ id: T1, status: 'OCCUPIED', current_order_id: O1, updated_at: '2026-11-14 19:00:00+00' }],
  });

  it('converte números e datas do banco para o formato do aparelho', () => {
    const r = parseCloudOrders(body(), TEN);
    expect(r.orders[0]).toMatchObject({ total_amount: 55, opened_at: '2026-11-14T19:00:00.000Z' });
    expect(r.orderItems[0]).toMatchObject({ quantity: 1, half_product_ids: [] });
    expect(r.payments[0]!.amount).toBe(10);
    expect(r.server_now).toBe('2026-11-14T20:00:00.123Z');
  });

  it('recusa a leitura inteira quando algo está fora do lugar', () => {
    const cases: Array<[string, (b: ReturnType<typeof body>) => unknown]> = [
      ['outra loja', (b) => ({ ...b, tenant_id: 'outra' })],
      ['conta de outra loja', (b) => ({ ...b, orders: [{ ...b.orders[0], tenant_id: 'outra' }] })],
      ['item sem conta', (b) => ({ ...b, order_items: [{ ...b.order_items[0], order_id: O2 }] })],
      ['pagamento sem conta', (b) => ({ ...b, payments: [{ ...b.payments[0], order_id: O2 }] })],
      ['item repetido', (b) => ({ ...b, order_items: [b.order_items[0], b.order_items[0]] })],
      ['número inválido', (b) => ({ ...b, orders: [{ ...b.orders[0], remaining_balance: 'abc' }] })],
      ['situação desconhecida', (b) => ({ ...b, orders: [{ ...b.orders[0], status: 'REOPENED' }] })],
      ['resposta incompleta', (b) => ({ ...b, payments: undefined })],
    ];
    for (const [name, f] of cases) expect(() => parseCloudOrders(f(body()), TEN), name).toThrow(/Não foi possível ler as contas da nuvem/);
  });
});

describe('applyCloudOrders no store', () => {
  const session = (tenantId: string): CloudSession => ({
    url: 'https://x.supabase.co', anon_key: 'anon', email: 'a@b', access_token: 'jwt', refresh_token: 'r', expires_at: 9e9, tenant_id: tenantId,
  });
  beforeEach(() => st().resetDemo());

  it('só aplica a leitura da loja deste aparelho conectada à nuvem', () => {
    const tenantId = st().tenant.id;
    expect(st().applyCloudOrders(cloud({ tenant_id: tenantId })).ok).toBe(false); // sem nuvem
    useTcheStore.setState({ cloud: session(tenantId), outbox: [], syncRejected: [] });
    expect(st().applyCloudOrders(cloud({ tenant_id: 'outra' })).ok).toBe(false);
    const r = st().applyCloudOrders(cloud({ tenant_id: tenantId }));
    expect(r.ok).toBe(true);
    expect(st().pullStatus.last_orders_pull_at).not.toBeNull();
  });

  it('a conta com mudança na fila (aberta agora, ainda não subiu) não some', () => {
    const tenantId = st().tenant.id;
    useTcheStore.setState({ cloud: session(tenantId), outbox: [], syncRejected: [] });
    st().login('1111');
    const free = st().tables.find((t) => t.status === 'FREE' && t.kind === 'TABLE')!;
    const opened = st().openTable(free.id, 2, null);
    if (!opened.ok) throw new Error(opened.error);
    const r = st().applyCloudOrders(cloud({ tenant_id: tenantId, tables: [{ id: free.id, status: 'FREE', current_order_id: null, updated_at: NOW }] }));
    expect(r.ok).toBe(true);
    expect(st().orders.some((o) => o.id === opened.data.id)).toBe(true);
    expect(st().tables.find((t) => t.id === free.id)).toMatchObject({ status: 'OCCUPIED', current_order_id: opened.data.id });
  });
});

describe('moveRejectedOrderToTableOrder (mesa ocupada por outra conta)', () => {
  beforeEach(() => st().resetDemo());

  function setup() {
    st().login('1111');
    const free = st().tables.find((t) => t.status === 'FREE' && t.kind === 'TABLE')!;
    const opened = st().openTable(free.id, 2, null);
    if (!opened.ok) throw new Error(opened.error);
    const y = opened.data;
    const insert = st().outbox.find((e) => e.table === 'orders' && e.row_id === y.id)!;
    // A conta que ficou na mesa, vinda da nuvem.
    const x = order(O2, { tenant_id: st().tenant.id, table_id: free.id });
    useTcheStore.setState({
      orders: [...st().orders, x],
      outbox: st().outbox.filter((e) => e.id !== insert.id),
      syncRejected: [{ event: insert, status: 400, message: 'TCHEFOOD_MESA_OCUPADA: Mesa já está com outra conta aberta', rejected_at: NOW }],
    });
    return { y, x, insert, free };
  }

  it('recusa que não é de mesa ocupada não move nada', () => {
    const { insert } = setup();
    useTcheStore.setState({ syncRejected: [{ event: insert, status: 400, message: 'outra coisa', rejected_at: NOW }] });
    expect(st().moveRejectedOrderToTableOrder(insert.id).ok).toBe(false);
  });

  it('conta com pagamento, desconto ou cashback na fila não é juntada sozinha', () => {
    const { y, insert } = setup();
    useTcheStore.setState({ outbox: [...st().outbox, ev('payments', 'pg1', { order_id: y.id }, { op: 'INSERT' })] });
    const r = st().moveRejectedOrderToTableOrder(insert.id);
    expect(r.ok).toBe(false);
    expect(st().orders.some((o) => o.id === y.id)).toBe(true);
    expect(st().syncRejected).toHaveLength(1);
  });

  it('sem a conta da mesa vinda da nuvem neste aparelho: pede para sincronizar', () => {
    const { insert } = setup();
    useTcheStore.setState({ orders: st().orders.filter((o) => o.id !== O2) });
    const r = st().moveRejectedOrderToTableOrder(insert.id);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/Sincronizar agora/) });
  });

  it('passa os itens (com ids novos) para a conta da mesa e tira a conta recusada e os eventos dela', () => {
    const { y, insert, free } = setup();
    const p = st().products.find((x) => x.active && !x.is_combo && !x.sold_by_weight && x.available && !x.requires_meat_doneness && !x.allows_half_and_half)!;
    const added = st().addToTray({ order_id: y.id, product_id: p.id, half_product_ids: [], quantity: 1, unit_price: p.price, modifiers: [], modifiers_unit_price: 0, meat_doneness: null, quick_tags: [], free_notes: '', sector: p.sector });
    if (!added.ok) throw new Error(added.error);
    const sent = st().dispatchTray(y.id);
    if (!sent.ok) throw new Error(sent.error);
    const oldIds = st().orderItems.filter((i) => i.order_id === y.id).map((i) => i.id);
    const r = st().moveRejectedOrderToTableOrder(insert.id);
    expect(r).toMatchObject({ ok: true, data: { targetOrderId: O2 } });
    expect(st().orders.some((o) => o.id === y.id)).toBe(false);
    const moved = st().orderItems.filter((i) => i.order_id === O2);
    expect(moved.length).toBe(oldIds.length);
    expect(moved.some((i) => oldIds.includes(i.id))).toBe(false);
    expect(st().outbox.every((e) => e.row_id !== y.id && e.payload.order_id !== y.id && e.payload.current_order_id !== y.id)).toBe(true);
    expect(st().outbox.filter((e) => e.table === 'order_items' && e.op === 'INSERT' && e.payload.order_id === O2)).toHaveLength(moved.length);
    expect(st().syncRejected).toHaveLength(0);
    expect(st().tables.find((t) => t.id === free.id)!.current_order_id).toBe(O2);
  });
});

describe('onlyHeldLeft (contas descem com a fila só segurada atrás de recusa)', () => {
  it('só eventos de registro recusado: segurados; um evento livre: não', async () => {
    const { onlyHeldLeft } = await import('../lib/sync/supabaseSync');
    const rejected = ev('orders', O1, {}, { op: 'INSERT' });
    const child = ev('order_items', 'i1', { order_id: O1 }, { op: 'INSERT' });
    const table = ev('dining_tables', T1, { current_order_id: O1 });
    expect(onlyHeldLeft([child, table], [rejected])).toBe(true);
    expect(onlyHeldLeft([child, ev('orders', O2)], [rejected])).toBe(false);
    expect(onlyHeldLeft([child], [])).toBe(false);
    expect(onlyHeldLeft([], [])).toBe(true);
  });
});
