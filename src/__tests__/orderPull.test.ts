/**
 * Contas e mesas que descem da nuvem (src/lib/sync/orderPull.ts): a nuvem manda no dinheiro, a
 * conta com mudança deste aparelho ainda pendente fica como está, e a leitura inválida não
 * aplica nada.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { mergeCloudOrders, missingCatalog, missingHalves, missingModifiers, parseCloudOrders, pendingOrderKeys, skippedMessage, type CloudOrders } from '../lib/sync/orderPull';
import { REJECTED_ORDER_ONLY_CPF, useTcheStore, type CloudSession } from '../store/useTcheStore';
import type { DiningTable, Order, OrderItem, OwnDelivery, Payment, SyncEvent } from '../types';

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
const cloud = (over: Partial<CloudOrders> = {}): CloudOrders => ({ tenant_id: TEN, server_now: NOW, orders: [], orderItems: [], payments: [], ownDeliveries: [], tables: [], cashSessions: [], skippedOrderIds: [], ...over });
const delivery = (id: string, orderId: string, over: Partial<OwnDelivery> = {}): OwnDelivery => ({
  id, tenant_id: TEN, order_id: orderId, customer_name: 'Ana', customer_phone: '55999999999', address: 'Rua A, 1', reference: null,
  zone_id: 'z1', zone_name: 'Centro', delivery_fee: 5, pay_on_delivery: true, change_for: null, status: 'PREPARING', courier_id: null,
  courier_fee: null, out_at: null, delivered_at: null, settlement_id: null, created_at: NOW, ...over,
});
const ev = (table: SyncEvent['table'], rowId: string, payload: Record<string, unknown> = {}, over: Partial<SyncEvent> = {}): SyncEvent => ({
  id: `e-${table}-${rowId}`, table, op: 'UPDATE', row_id: rowId, payload: { id: rowId, ...payload }, created_at: NOW, ...over,
});
const none = pendingOrderKeys([]);

describe('mergeCloudOrders', () => {
  it('conta sem nada pendente fica igual à da nuvem: totais, itens e pagamentos do banco', () => {
    const local = { orders: [order(O1)], orderItems: [item('i1', O1)], payments: [], ownDeliveries: [], tables: [table(T1, { status: 'OCCUPIED', current_order_id: O1 })] };
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

  it('entrega da conta desce da nuvem; a com mudança daqui pendente fica como está', () => {
    const local = { orders: [], orderItems: [], payments: [], ownDeliveries: [delivery('d2', O2, { status: 'OUT', courier_id: 'c1', courier_fee: 4, out_at: NOW })], tables: [] };
    const c = cloud({ orders: [order(O1), order(O2, { table_id: T2 })], ownDeliveries: [delivery('d1', O1), delivery('d2', O2)] });
    const fresh = mergeCloudOrders(local, c, none);
    expect(fresh.ownDeliveries.map((d) => `${d.id}:${d.status}`).sort()).toEqual(['d1:PREPARING', 'd2:PREPARING']);
    const held = mergeCloudOrders(local, c, pendingOrderKeys([ev('own_deliveries', 'd2', { order_id: O2 })]));
    expect(held.ownDeliveries.map((d) => `${d.id}:${d.status}`).sort()).toEqual(['d1:PREPARING', 'd2:OUT']);
  });

  it('item ou pagamento só deste aparelho numa conta sem nada pendente sai (o banco não o tem)', () => {
    const local = { orders: [order(O1)], orderItems: [item('i1', O1), item('fantasma', O1)], payments: [payment('pgx', O1, 10)], ownDeliveries: [], tables: [] };
    const r = mergeCloudOrders(local, cloud({ orders: [order(O1)], orderItems: [item('i1', O1)] }), none);
    expect(r.orderItems.map((i) => i.id)).toEqual(['i1']);
    expect(r.payments).toEqual([]);
  });

  it('conta com evento na fila ou recusado fica inteira como está aqui (conta, itens, pagamentos e mesa)', () => {
    const local = {
      orders: [order(O1, { customer_count: 5 })],
      orderItems: [item('i1', O1)],
      payments: [payment('pg1', O1, 10)],
      ownDeliveries: [],
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
    const local = { orders: [order(O1)], orderItems: [], payments: [], ownDeliveries: [], tables: [] };
    const r = mergeCloudOrders(local, cloud({ orders: [order(O1, { status: 'CLOSED' })] }), pendingOrderKeys([], [O1]));
    expect(r.orders[0]!.status).toBe('OPEN');
  });

  it('mesa com mudança daqui pendente fica como está; sem pendência, a ocupação vem da nuvem', () => {
    const local = { orders: [], orderItems: [], payments: [], ownDeliveries: [], tables: [table(T1, { status: 'WAITING_BILL', current_order_id: O2 }), table(T2)] };
    const c = cloud({ orders: [order(O2, { table_id: T1 }), order(O1, { table_id: T2 })], tables: [{ id: T1, status: 'OCCUPIED', current_order_id: O2, updated_at: NOW }, { id: T2, status: 'OCCUPIED', current_order_id: O1, updated_at: NOW }] });
    const r = mergeCloudOrders(local, c, pendingOrderKeys([ev('dining_tables', T1, { current_order_id: O2 })]));
    expect(r.tables[0]).toMatchObject({ status: 'WAITING_BILL', current_order_id: O2 });
    expect(r.tables[1]).toMatchObject({ status: 'OCCUPIED', current_order_id: O1, label: 'Mesa 1', active: true });
    expect(r.orders.map((o) => o.id)).toEqual([O1]); // O2 está pendente (pela mesa) e não existe aqui: não entra pela metade
  });

  it('conta aberta daqui que a nuvem não mandou continua no mapa (não some a conta)', () => {
    const local = { orders: [order(O1)], orderItems: [item('i1', O1)], payments: [], ownDeliveries: [], tables: [table(T1, { status: 'OCCUPIED', current_order_id: O1 })] };
    const r = mergeCloudOrders(local, cloud({ tables: [{ id: T1, status: 'FREE', current_order_id: null, updated_at: NOW }] }), none);
    expect(r.orders).toHaveLength(1);
    expect(r.orderItems).toHaveLength(1);
    expect(r.tables[0]).toMatchObject({ status: 'OCCUPIED', current_order_id: O1 });
  });

  it('conta encerrada há mais de 24 h (fora da leitura) fica como histórico deste aparelho', () => {
    const old = order(O1, { status: 'CLOSED', closed_at: '2026-11-10T20:00:00.000Z', remaining_balance: 0, paid_amount: 55 });
    const r = mergeCloudOrders({ orders: [old], orderItems: [item('i1', O1)], payments: [payment('pg1', O1, 55)], ownDeliveries: [], tables: [] }, cloud(), none);
    expect(r.orders).toEqual([old]);
    expect(r.payments).toHaveLength(1);
  });

  it('NFC-e: vale a do servidor quando ele tem uma; sem ela, fica a daqui', () => {
    const local = { orders: [order(O1, { status: 'CLOSED', nfce_status: 'AUTORIZADA', nfce_key: 'K-LOCAL' })], orderItems: [], payments: [], ownDeliveries: [], tables: [] };
    expect(mergeCloudOrders(local, cloud({ orders: [order(O1, { status: 'CLOSED' })] }), none).orders[0]).toMatchObject({ nfce_status: 'AUTORIZADA', nfce_key: 'K-LOCAL' });
    expect(mergeCloudOrders(local, cloud({ orders: [order(O1, { status: 'CLOSED', nfce_status: 'AUTHORIZED', nfce_key: 'K-SEFAZ' })] }), none).orders[0])
      .toMatchObject({ nfce_status: 'AUTHORIZED', nfce_key: 'K-SEFAZ' });
  });

  it('conta nova de outro aparelho entra com itens e pagamentos', () => {
    const c = cloud({ orders: [order(O2, { table_id: T2 })], orderItems: [item('i5', O2)], payments: [payment('pg5', O2, 5)] });
    const r = mergeCloudOrders({ orders: [order(O1)], orderItems: [], payments: [], ownDeliveries: [], tables: [] }, c, none);
    expect(r.orders.map((o) => o.id)).toEqual([O1, O2]);
    expect(r.orderItems.map((i) => i.id)).toEqual(['i5']);
    expect(r.payments.map((p) => p.id)).toEqual(['pg5']);
  });

  it('missingCatalog: produto ou mesa que este aparelho não tem', () => {
    const c = cloud({ orders: [order(O1)], orderItems: [item('i1', O1)] });
    expect(missingCatalog(c, { productIds: ['p1'], tableIds: [T1] })).toBe(false);
    expect(missingCatalog(c, { productIds: [], tableIds: [T1] })).toBe(true);
    expect(missingCatalog(c, { productIds: ['p1'], tableIds: [] })).toBe(true);
    // Meio a meio: o sabor da outra metade não tem chave estrangeira (pode ter sido apagado ou
    // aceito com PIN de gerente) e é conferido à parte por missingHalves, que lembra o que a
    // leitura dos cadastros já confirmou que não existe (auditoria interna, rodada 8 do PR #54).
    const half = cloud({ orders: [order(O1)], orderItems: [item('i1', O1, { half_product_ids: ['p1', 'p2'] })] });
    expect(missingCatalog(half, { productIds: ['p1'], tableIds: [T1] })).toBe(false);
    expect(missingHalves(half, new Set(['p1']))).toEqual(['p2']);
    expect(missingHalves(half, new Set(['p1', 'p2']))).toEqual([]);
    expect(missingHalves(half, new Set(['p1']), new Set(['p2']))).toEqual([]);
  });

  it('missingModifiers: adicional que este aparelho não tem (GPT, rodada 6 do PR #54)', () => {
    const c = cloud({ orders: [order(O1)], orderItems: [item('i1', O1, { modifier_option_ids: ['m1', 'm2'] })] });
    expect(missingModifiers(c, ['m1'])).toEqual(['m2']);
    expect(missingModifiers(c, ['m1', 'm2'])).toEqual([]);
    expect(missingModifiers(cloud({ orders: [order(O1)], orderItems: [item('i1', O1)] }), [])).toEqual([]);
    // Já conferido numa leitura dos cadastros feita depois de a conta chegar (apagado, ou aceito
    // pelo banco com PIN sem estar no cadastro): não pede a leitura de novo. Sem horário nenhum.
    expect(missingModifiers(c, ['m1'], new Set(['m2']))).toEqual([]);
  });
});

describe('parseCloudOrders', () => {
  const body = () => ({
    tenant_id: TEN,
    server_now: '2026-11-14 20:00:00.123+00',
    orders: [{ ...order(O1), total_amount: '55.00', opened_at: '2026-11-14 19:00:00+00' }],
    order_items: [{ ...item('i1', O1), quantity: '1.000', half_product_ids: [] }],
    payments: [{ ...payment('pg1', O1, 10), amount: '10.00' }],
    own_deliveries: [{ ...delivery('d1', O1), delivery_fee: '5.00', change_for: null }],
    tables: [{ id: T1, status: 'OCCUPIED', current_order_id: O1, updated_at: '2026-11-14 19:00:00+00' }],
    cash_sessions: [
      { id: 'c1', tenant_id: TEN, status: 'CLOSED', opened_at: '2026-11-14 08:00:00+00', closed_at: '2026-11-14 12:00:00+00' },
      { id: 'c2', tenant_id: TEN, status: 'OPEN', opened_at: '2026-11-14 12:30:00+00', closed_at: null },
    ],
  });

  it('converte números e datas do banco para o formato do aparelho', () => {
    const r = parseCloudOrders(body(), TEN);
    expect(r.orders[0]).toMatchObject({ total_amount: 55, opened_at: '2026-11-14T19:00:00.000Z' });
    expect(r.orderItems[0]).toMatchObject({ quantity: 1, half_product_ids: [] });
    expect(r.payments[0]!.amount).toBe(10);
    expect(r.ownDeliveries[0]).toMatchObject({ order_id: O1, delivery_fee: 5, pay_on_delivery: true });
    expect(r.orderItems[0]).toMatchObject({ status: 'PENDING', sector: 'KITCHEN', origin: 'WAITER', weight_source: null });
    expect(r.payments[0]).toMatchObject({ method: 'CREDIT', status: 'APPROVED', acquirer: 'STONE' });
    const all = parseCloudOrders({ ...body(), orders: [{ ...body().orders[0], fulfillment_type: 'DELIVERY' }],
      order_items: [{ ...body().order_items[0], status: 'DELIVERED', sector: 'NONE', origin: 'KIOSK', weight_source: 'SCALE' }],
      payments: [{ ...body().payments[0], method: 'CASH', status: 'REFUNDED', acquirer: 'CASH_DESK' }] }, TEN);
    expect(all.orders[0]!.fulfillment_type).toBe('DELIVERY');
    expect(all.orderItems[0]).toMatchObject({ status: 'DELIVERED', sector: 'NONE', origin: 'KIOSK', weight_source: 'SCALE' });
    expect(r.server_now).toBe('2026-11-14T20:00:00.123Z');
    expect(r.cashSessions).toEqual([
      { id: 'c1', tenant_id: TEN, status: 'CLOSED', opened_at: '2026-11-14T08:00:00.000Z', closed_at: '2026-11-14T12:00:00.000Z' },
      { id: 'c2', tenant_id: TEN, status: 'OPEN', opened_at: '2026-11-14T12:30:00.000Z', closed_at: null },
    ]);
  });

  it('recusa a leitura inteira quando algo está fora do lugar', () => {
    const cases: Array<[string, (b: ReturnType<typeof body>) => unknown]> = [
      ['outra loja', (b) => ({ ...b, tenant_id: 'outra' })],
      ['conta de outra loja', (b) => ({ ...b, orders: [{ ...b.orders[0], tenant_id: 'outra' }] })],
      ['item sem conta', (b) => ({ ...b, order_items: [{ ...b.order_items[0], order_id: O2 }] })],
      ['pagamento sem conta', (b) => ({ ...b, payments: [{ ...b.payments[0], order_id: O2 }] })],
      ['item repetido', (b) => ({ ...b, order_items: [b.order_items[0], b.order_items[0]] })],
      ['número inválido', (b) => ({ ...b, orders: [{ ...b.orders[0], remaining_balance: 'abc' }] })],
      ['resposta incompleta', (b) => ({ ...b, payments: undefined })],
      ['sem entregas', (b) => ({ ...b, own_deliveries: undefined })],
      ['entrega sem conta', (b) => ({ ...b, own_deliveries: [{ ...b.own_deliveries[0], order_id: O2 }] })],
      ['entrega de outra loja', (b) => ({ ...b, own_deliveries: [{ ...b.own_deliveries[0], tenant_id: 'outra' }] })],
      ['duas entregas na conta', (b) => ({ ...b, own_deliveries: [b.own_deliveries[0], { ...b.own_deliveries[0], id: 'd2' }] })],
      // Valor de lista fechada desconhecido deixa só a conta de lado (auditoria interna, rodada 8 do PR #54):
      // os casos estão no describe da rodada 8 abaixo.
      ['valor que não é texto', (b) => ({ ...b, payments: [{ ...b.payments[0], method: 1 }] })],
      ['sem caixas', (b) => ({ ...b, cash_sessions: undefined })],
      ['caixa de outra loja', (b) => ({ ...b, cash_sessions: [{ ...b.cash_sessions[0], tenant_id: 'outra' }] })],
      ['caixa com situação desconhecida', (b) => ({ ...b, cash_sessions: [{ ...b.cash_sessions[0], status: 'PAUSED' }] })],
      ['caixa com data inválida', (b) => ({ ...b, cash_sessions: [{ ...b.cash_sessions[0], opened_at: 'ontem' }] })],
      ['caixa fechado sem fechamento', (b) => ({ ...b, cash_sessions: [{ ...b.cash_sessions[0], closed_at: null }] })],
      ['caixa aberto com fechamento', (b) => ({ ...b, cash_sessions: [{ ...b.cash_sessions[1], closed_at: '2026-11-14 13:00:00+00' }] })],
      ['caixa fechado antes de abrir', (b) => ({ ...b, cash_sessions: [{ ...b.cash_sessions[0], closed_at: '2026-11-14 07:00:00+00' }] })],
      ['caixa repetido', (b) => ({ ...b, cash_sessions: [b.cash_sessions[0], b.cash_sessions[0]] })],
      ['dois caixas abertos', (b) => ({ ...b, cash_sessions: [b.cash_sessions[1], { ...b.cash_sessions[1], id: 'c3' }] })],
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

  it('guarda os horários dos caixas da nuvem à parte, sem mexer nos caixas deste aparelho', () => {
    const tenantId = st().tenant.id;
    useTcheStore.setState({ cloud: session(tenantId), outbox: [], syncRejected: [] });
    const before = st().cashSessions;
    const c = cloud({ tenant_id: tenantId, cashSessions: [{ id: 'cA', tenant_id: tenantId, status: 'OPEN', opened_at: NOW, closed_at: null }] });
    expect(st().applyCloudOrders(c).ok).toBe(true);
    expect(st().cloudCashRanges).toEqual([{ id: 'cA', opened_at: NOW, closed_at: null }]);
    expect(st().cashSessions).toBe(before);
    // A leitura seguinte substitui a lista inteira (caixa que saiu da janela de 24 h some).
    expect(st().applyCloudOrders(cloud({ tenant_id: tenantId })).ok).toBe(true);
    expect(st().cloudCashRanges).toEqual([]);
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

  it('a leitura das contas que dá certo limpa só o erro dela, não o dos cadastros (GPT, rodada 1 do PR #54)', () => {
    const tenantId = st().tenant.id;
    useTcheStore.setState({ cloud: session(tenantId), outbox: [], syncRejected: [] });
    st().setPullError('Não foi possível ler as contas da nuvem: HTTP 500', 'orders');
    expect(st().applyCloudOrders(cloud({ tenant_id: tenantId })).ok).toBe(true);
    expect(st().pullStatus).toMatchObject({ last_error: null, last_error_source: null });
    st().setPullError('Cadastros: HTTP 500', 'catalog');
    expect(st().applyCloudOrders(cloud({ tenant_id: tenantId })).ok).toBe(true);
    expect(st().pullStatus).toMatchObject({ last_error: 'Cadastros: HTTP 500', last_error_source: 'catalog' });
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
      syncRejected: [{ event: insert, status: 400, message: busy(free.id, O2), rejected_at: NOW }],
    });
    return { y, x, insert, free };
  }
  // Como a recusa fica guardada: mensagem — detalhe do banco (quem ocupava a mesa).
  const busy = (tableId: string, holder: string) =>
    `TCHEFOOD_MESA_OCUPADA: Mesa já está com outra conta aberta — {"table_id": "${tableId}", "holder_order_id": "${holder}"}`;

  it('a conta da mesa agora não é a que ocupava na hora da recusa: não move nada (GPT, rodada 6 do PR #54)', () => {
    const { y, insert, free } = setup();
    // X (a que ocupava) foi encerrada; Z, de outro cliente, abriu a mesa depois.
    const X = '03030303-0303-4303-8303-030303030303';
    useTcheStore.setState({ syncRejected: [{ event: insert, status: 400, message: busy(free.id, X), rejected_at: NOW }] });
    const before = st().orderItems.filter((i) => i.order_id === y.id).length;
    const r = st().moveRejectedOrderToTableOrder(insert.id);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/não está mais aberta/) });
    expect(st().orders.some((o) => o.id === y.id)).toBe(true);
    expect(st().orderItems.filter((i) => i.order_id === y.id)).toHaveLength(before);
    expect(st().orderItems.some((i) => i.order_id === O2)).toBe(false);
    expect(st().syncRejected).toHaveLength(1);
    // X encerrada e já neste aparelho, mesa ainda sem a conta nova: diz que X não está aberta.
    useTcheStore.setState((s) => ({ orders: [...s.orders.filter((o) => o.id !== O2), order(X, { tenant_id: s.tenant.id, table_id: free.id, status: 'CLOSED' })] }));
    expect(st().moveRejectedOrderToTableOrder(insert.id)).toMatchObject({ ok: false, error: expect.stringMatching(/não está mais aberta/) });
    // Recusa sem o detalhe de quem ocupava: também não move.
    useTcheStore.setState({ syncRejected: [{ event: insert, status: 400, message: 'TCHEFOOD_MESA_OCUPADA: Mesa já está com outra conta aberta', rejected_at: NOW }] });
    expect(st().moveRejectedOrderToTableOrder(insert.id)).toMatchObject({ ok: false, error: expect.stringMatching(/não diz qual conta/) });
  });

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

  it('CPF diferente nas duas contas: não junta, nem com dropCpf (GPT, rodada 1 do PR #54)', () => {
    const { y, insert } = setup();
    useTcheStore.setState((s) => ({ orders: s.orders.map((o) => (o.id === y.id ? { ...o, customer_cpf: '52998224725' } : o.id === O2 ? { ...o, customer_cpf: '11144477735' } : o)) }));
    const r = st().moveRejectedOrderToTableOrder(insert.id);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/CPF diferente/) });
    expect(st().moveRejectedOrderToTableOrder(insert.id, { dropCpf: true })).toMatchObject({ ok: false, error: expect.stringMatching(/CPF diferente/) });
    expect(st().orders.some((o) => o.id === y.id)).toBe(true);
    // Mesmo CPF nas duas: junta.
    useTcheStore.setState((s) => ({ orders: s.orders.map((o) => (o.id === O2 ? { ...o, customer_cpf: '52998224725' } : o)) }));
    expect(st().moveRejectedOrderToTableOrder(insert.id).ok).toBe(true);
  });

  it('só a conta recusada tem CPF: não junta sem a decisão do operador; com dropCpf, junta sem o CPF (GPT, rodada 7 do PR #54)', () => {
    const { y, insert } = setup();
    useTcheStore.setState((s) => ({ orders: s.orders.map((o) => (o.id === y.id ? { ...o, customer_cpf: '52998224725' } : o.id === O2 ? { ...o, customer_cpf: null } : o)) }));
    const pick = () => {
      const s = st();
      return { orders: s.orders, orderItems: s.orderItems, outbox: s.outbox, syncRejected: s.syncRejected, tables: s.tables, tray: s.tray };
    };
    const before = structuredClone(pick());
    const r = st().moveRejectedOrderToTableOrder(insert.id);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.startsWith(REJECTED_ORDER_ONLY_CPF)).toBe(true);
    // O CPF aparece mascarado, nunca inteiro.
    expect(r.error).toContain('***.***.***-25');
    expect(r.error).not.toContain('52998224725');
    expect(r.error).not.toContain('529.982.247-25');
    expect(pick()).toEqual(before);
    // dropCpf: false é o mesmo que não decidir.
    expect(st().moveRejectedOrderToTableOrder(insert.id, { dropCpf: false }).ok).toBe(false);
    expect(pick()).toEqual(before);
    // O operador confirmou passar os itens sem o CPF: a conta da mesa continua sem CPF.
    const ok = st().moveRejectedOrderToTableOrder(insert.id, { dropCpf: true });
    expect(ok).toMatchObject({ ok: true, data: { targetOrderId: O2 } });
    expect(st().orders.some((o) => o.id === y.id)).toBe(false);
    expect(st().orders.find((o) => o.id === O2)!.customer_cpf).toBeNull();
    expect(st().outbox.some((e) => e.payload.customer_cpf === '52998224725')).toBe(false);
  });

  it('sem CPF nas duas contas: junta como antes', () => {
    const { y, insert } = setup();
    useTcheStore.setState((s) => ({ orders: s.orders.map((o) => (o.id === y.id || o.id === O2 ? { ...o, customer_cpf: null } : o)) }));
    expect(st().moveRejectedOrderToTableOrder(insert.id).ok).toBe(true);
  });

  it('a mudança da mesa que estava na fila continua, sem voltar atrás a ocupação da nuvem (GPT, rodada 1, e auditoria interna, rodada 8, do PR #54)', () => {
    const { insert, free } = setup();
    const tableEvent = st().outbox.find((e) => e.table === 'dining_tables' && e.row_id === free.id)!;
    useTcheStore.setState((s) => ({ outbox: s.outbox.map((e) => (e.id === tableEvent.id ? { ...e, payload: { ...e.payload, label: 'Mesa da varanda' } } : e)) }));
    expect(st().moveRejectedOrderToTableOrder(insert.id).ok).toBe(true);
    const kept = st().outbox.find((e) => e.id === tableEvent.id)!;
    expect(kept.payload).toMatchObject({ label: 'Mesa da varanda' });
    // A mesa na nuvem pode estar aguardando conta ou pagando com a conta que ficou: o PATCH não
    // leva a situação da hora da abertura.
    expect('status' in kept.payload).toBe(false);
    expect('current_order_id' in kept.payload).toBe(false);
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
    // A atualização da mesa continua na fila, sem a ocupação: a conta que ficou já ocupa a mesa na
    // nuvem, e a situação da hora da abertura voltaria atrás a mesa aguardando conta ou pagando.
    const tableEv = st().outbox.find((e) => e.table === 'dining_tables' && e.row_id === free.id)!;
    expect(tableEv).toBeDefined();
    expect('status' in tableEv.payload).toBe(false);
    expect('current_order_id' in tableEv.payload).toBe(false);
    expect(st().outbox.filter((e) => e.table === 'order_items' && e.op === 'INSERT' && e.payload.order_id === O2)).toHaveLength(moved.length);
    expect(st().syncRejected).toHaveLength(0);
    expect(st().tables.find((t) => t.id === free.id)!.current_order_id).toBe(O2);
  });
});


describe('moveLateItemsToNewOrder (item atrasado de conta encerrada)', () => {
  beforeEach(() => st().resetDemo());

  function setup(parentUnsent: boolean) {
    st().login('1111');
    const free = st().tables.find((t) => t.status === 'FREE' && t.kind === 'TABLE')!;
    const closed = order(O1, { tenant_id: st().tenant.id, table_id: free.id, status: 'CLOSED' });
    const parent = item('combo-pai', O1, { unit_price: 30, total_item_price: 30 });
    const child = item('combo-filho', O1, { unit_price: 0, total_item_price: 0, combo_parent_item_id: parent.id });
    const childEv = ev('order_items', child.id, { ...child }, { op: 'INSERT', id: 'e-filho' });
    useTcheStore.setState({
      orders: [...st().orders, closed],
      orderItems: [...st().orderItems, parent, child],
      outbox: parentUnsent ? [ev('order_items', parent.id, { ...parent }, { op: 'INSERT', id: 'e-pai' })] : [],
      syncRejected: [{ event: childEv, status: 400, message: 'TCHEFOOD_CONTA_ENCERRADA: a conta já foi encerrada', rejected_at: NOW }],
    });
    return { childEv };
  }

  it('componente de combo cujo combo já subiu na conta encerrada: não move nada (GPT, rodada 7 do PR #54)', () => {
    const { childEv } = setup(false);
    const before = { orders: st().orders.length, outbox: st().outbox.length };
    const r = st().moveLateItemsToNewOrder(childEv.id);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/Item de combo/) });
    expect(st().orders).toHaveLength(before.orders);
    expect(st().outbox).toHaveLength(before.outbox);
    expect(st().syncRejected).toHaveLength(1);
    expect(st().orderItems.find((i) => i.id === 'combo-filho')!.order_id).toBe(O1);
  });

  it('combo e componente que não subiram passam juntos, com o componente apontando para o combo novo', () => {
    const { childEv } = setup(true);
    const r = st().moveLateItemsToNewOrder(childEv.id);
    if (!r.ok) throw new Error(r.error);
    const moved = st().orderItems.filter((i) => i.order_id === r.data.newOrderId);
    expect(moved).toHaveLength(2);
    const newParent = moved.find((i) => !i.combo_parent_item_id)!;
    expect(moved.find((i) => i.combo_parent_item_id)!.combo_parent_item_id).toBe(newParent.id);
  });
  it('mesa já com a conta de outro cliente: os itens atrasados não saem (auditoria interna, rodada 8 do PR #54)', () => {
    const { childEv } = setup(true);
    const tableId = st().orders.find((o) => o.id === O1)!.table_id;
    const z = order(O2, { tenant_id: st().tenant.id, table_id: tableId, status: 'OPEN' });
    useTcheStore.setState({
      orders: [...st().orders, z],
      tables: st().tables.map((t) => (t.id === tableId ? { ...t, status: 'OCCUPIED', current_order_id: O2 } : t)),
    });
    const before = { orders: st().orders.length, outbox: st().outbox.length };
    const r = st().moveLateItemsToNewOrder(childEv.id);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/outra conta aberta/) });
    expect(st().orders).toHaveLength(before.orders);
    expect(st().outbox).toHaveLength(before.outbox);
    expect(st().orderItems.filter((i) => i.order_id === O2)).toHaveLength(0);
  });

  it('conta nova dos itens atrasados recusada com mesa ocupada: não junta na conta do próximo cliente', () => {
    const { childEv } = setup(true);
    const r = st().moveLateItemsToNewOrder(childEv.id);
    if (!r.ok) throw new Error(r.error);
    const freshId = r.data.newOrderId;
    const tableId = st().orders.find((o) => o.id === freshId)!.table_id;
    // A nuvem já tinha a conta Z do próximo cliente nesta mesa; ela chega no aparelho.
    const z = order(O2, { tenant_id: st().tenant.id, table_id: tableId, status: 'OPEN' });
    const insert = st().outbox.find((e) => e.table === 'orders' && e.op === 'INSERT' && e.row_id === freshId)!;
    useTcheStore.setState({
      orders: [...st().orders, z],
      outbox: st().outbox.filter((e) => e.id !== insert.id),
      syncRejected: [{
        event: insert, status: 409, rejected_at: NOW,
        message: `TCHEFOOD_MESA_OCUPADA: a mesa já tem outra conta aberta — {"table_id": "${tableId}", "holder_order_id": "${O2}"}`,
      }],
    });
    const m = st().moveRejectedOrderToTableOrder(insert.id);
    expect(m).toMatchObject({ ok: false, error: expect.stringMatching(/itens atrasados/) });
    expect(st().orderItems.filter((i) => i.order_id === O2)).toHaveLength(0);
    expect(st().orders.some((o) => o.id === freshId)).toBe(true);
  });

  it('balcão: a conta nova dos itens atrasados não cobra os 10%', () => {
    const { childEv } = setup(true);
    const counter = st().tables.find((t) => t.kind === 'COUNTER')!;
    useTcheStore.setState({ orders: st().orders.map((o) => (o.id === O1 ? { ...o, table_id: counter.id } : o)) });
    const r = st().moveLateItemsToNewOrder(childEv.id);
    if (!r.ok) throw new Error(r.error);
    expect(st().orders.find((o) => o.id === r.data.newOrderId)!.charge_service_fee).toBe(false);
  });
});

describe('parseCloudOrders: valor que esta versão não conhece e tipos estritos (auditoria interna, rodada 8 do PR #54)', () => {
  // Duas contas: O1 (mesa T1) e O2 (mesa T2), cada uma com item, pagamento e entrega, no formato
  // que o banco manda (to_jsonb: numeric como número, timestamptz com "T" e "+00:00").
  const TS = '2026-11-14T19:00:00.123456+00:00';
  const body = () => ({
    tenant_id: TEN,
    server_now: '2026-11-14T20:00:00.5+00:00',
    orders: [{ ...order(O1), opened_at: TS }, { ...order(O2, { table_id: T2 }), opened_at: TS }],
    order_items: [{ ...item('i1', O1), created_at: TS, priced_at: TS }, { ...item('i2', O2), created_at: TS, priced_at: TS }],
    payments: [{ ...payment('pg1', O1, 10), created_at: TS }, { ...payment('pg2', O2, 10), created_at: TS }],
    own_deliveries: [{ ...delivery('d1', O1), created_at: TS }, { ...delivery('d2', O2), created_at: TS }],
    tables: [{ id: T1, status: 'OCCUPIED', current_order_id: O1, updated_at: TS }, { id: T2, status: 'OCCUPIED', current_order_id: O2, updated_at: TS }],
    cash_sessions: [],
  });
  type B = ReturnType<typeof body>;
  const onO2 = <K extends 'orders' | 'order_items' | 'payments' | 'own_deliveries'>(b: B, k: K, over: Record<string, unknown>): B =>
    ({ ...b, [k]: [b[k][0], { ...b[k][1], ...over }] });

  const expectO2Skipped = (b: unknown, name: string) => {
    const r = parseCloudOrders(b, TEN);
    expect(r.skippedOrderIds, name).toEqual([O2]);
    expect(r.orders.map((o) => o.id), name).toEqual([O1]);
    expect(r.orderItems.map((i) => i.id), name).toEqual(['i1']);
    expect(r.payments.map((p) => p.id), name).toEqual(['pg1']);
    expect(r.ownDeliveries.map((d) => d.id), name).toEqual(['d1']);
    // A mesa da conta deixada de lado continua na foto (ocupação da nuvem).
    expect(r.tables.map((t) => t.id), name).toEqual([T1, T2]);
    expect(skippedMessage(r), name).toBe('Uma conta da nuvem tem um valor que esta versão do app não conhece: atualize o app.');
  };

  it('leitura sem valor desconhecido: nada fica de lado e não há aviso', () => {
    const r = parseCloudOrders(body(), TEN);
    expect(r.skippedOrderIds).toEqual([]);
    expect(r.orders).toHaveLength(2);
    expect(skippedMessage(r)).toBeNull();
    expect(r.orders[0]!.opened_at).toBe('2026-11-14T19:00:00.123Z');
  });

  it('adquirente nova (ex.: MERCADO_PAGO do PR #49): só aquela conta fica de lado; as outras são aplicadas', () => {
    expectO2Skipped(onO2(body(), 'payments', { acquirer: 'MERCADO_PAGO' }), 'adquirente');
  });

  it('origem de item nova (VARCHAR sem CHECK no banco): só aquela conta fica de lado', () => {
    expectO2Skipped(onO2(body(), 'order_items', { origin: 'WHATSAPP' }), 'origem');
  });

  it('qualquer outro valor de lista fechada desconhecido deixa só a conta dele de lado', () => {
    const cases: Array<[string, (b: B) => B]> = [
      ['situação da conta', (b) => onO2(b, 'orders', { status: 'REOPENED' })],
      ['tipo de pedido', (b) => onO2(b, 'orders', { fulfillment_type: 'DRONE' })],
      ['situação do item', (b) => onO2(b, 'order_items', { status: 'UNKNOWN' })],
      ['setor', (b) => onO2(b, 'order_items', { sector: 'PIZZA' })],
      ['pesagem', (b) => onO2(b, 'order_items', { weight_source: 'OLHO' })],
      ['forma de pagamento', (b) => onO2(b, 'payments', { method: 'CHEQUE' })],
      ['situação do pagamento', (b) => onO2(b, 'payments', { status: 'CHARGEBACK' })],
      ['situação da entrega', (b) => onO2(b, 'own_deliveries', { status: 'LOST' })],
    ];
    for (const [name, f] of cases) expectO2Skipped(f(body()), name);
  });

  it('tipo errado, número ou data inválidos e outra loja continuam recusando a leitura inteira', () => {
    const cases: Array<[string, (b: B) => unknown]> = [
      ['valor que não é texto', (b) => onO2(b, 'payments', { method: 1 })],
      ['valor desconhecido junto de número inválido na mesma conta', (b) => onO2(b, 'payments', { acquirer: 'MERCADO_PAGO', amount: 'abc' })],
      ['valor desconhecido num item de conta que não veio', (b) => ({ ...b, order_items: [b.order_items[0], { ...b.order_items[1], order_id: 'outra', origin: 'WHATSAPP' }] })],
      ['valor desconhecido em conta de outra loja', (b) => onO2(b, 'orders', { tenant_id: 'outra', status: 'REOPENED' })],
      ['mesa com situação desconhecida', (b) => ({ ...b, tables: [{ ...b.tables[0], status: 'RESERVED' }] })],
    ];
    for (const [name, f] of cases) expect(() => parseCloudOrders(f(body()), TEN), name).toThrow(/Não foi possível ler as contas da nuvem/);
  });

  it('verdadeiro/falso só como booleano: "true" em texto recusa a leitura', () => {
    const cases: Array<[string, (b: B) => unknown]> = [
      ['charge_service_fee', (b) => onO2(b, 'orders', { charge_service_fee: 'true' })],
      ['charge_service_fee nulo', (b) => onO2(b, 'orders', { charge_service_fee: null })],
      ['is_paid', (b) => onO2(b, 'order_items', { is_paid: 'true' })],
      ['is_paid 1', (b) => onO2(b, 'order_items', { is_paid: 1 })],
      ['pay_on_delivery', (b) => onO2(b, 'own_deliveries', { pay_on_delivery: 'true' })],
    ];
    for (const [name, f] of cases) expect(() => parseCloudOrders(f(body()), TEN), name).toThrow(/Não foi possível ler as contas da nuvem/);
    const r = parseCloudOrders(onO2(body(), 'orders', { charge_service_fee: false }), TEN);
    expect(r.orders[1]!.charge_service_fee).toBe(false);
  });

  it('texto opcional, listas de ids, números e datas no formato do banco; o resto recusa a leitura', () => {
    const cases: Array<[string, (b: B) => unknown]> = [
      ['texto opcional que é número', (b) => onO2(b, 'order_items', { notes: 5 })],
      ['texto opcional que é objeto', (b) => onO2(b, 'orders', { customer_cpf: {} })],
      ['lista de ids que não é lista', (b) => onO2(b, 'order_items', { modifier_option_ids: 'm1' })],
      ['lista de ids nula', (b) => onO2(b, 'order_items', { half_product_ids: null })],
      ['lista de ids com número', (b) => onO2(b, 'order_items', { modifier_option_ids: ['m1', 2] })],
      ['número em notação científica', (b) => onO2(b, 'orders', { total_amount: '1e3' })],
      ['número hexadecimal', (b) => onO2(b, 'orders', { total_amount: '0x10' })],
      ['número com espaços', (b) => onO2(b, 'orders', { total_amount: ' 55 ' })],
      ['número infinito', (b) => onO2(b, 'orders', { total_amount: 'Infinity' })],
      ['número booleano', (b) => onO2(b, 'orders', { total_amount: true })],
      ['data só com o ano', (b) => onO2(b, 'orders', { opened_at: '2026' })],
      ['data sem hora', (b) => onO2(b, 'orders', { opened_at: '2026-11-14' })],
      ['data sem fuso', (b) => onO2(b, 'orders', { opened_at: '2026-11-14T19:00:00' })],
      ['data por extenso', (b) => onO2(b, 'orders', { opened_at: 'Sat Nov 14 2026 19:00:00 GMT+0000' })],
      ['data em número', (b) => onO2(b, 'orders', { opened_at: 1794682800000 })],
      ['relógio do servidor inválido', (b) => ({ ...b, server_now: '2026' })],
    ];
    for (const [name, f] of cases) expect(() => parseCloudOrders(f(body()), TEN), name).toThrow(/Não foi possível ler as contas da nuvem/);
    const ok = parseCloudOrders(
      onO2(body(), 'orders', { total_amount: '55.00', discount_amount: '-0.5', opened_at: '2026-11-14 03:41:59.12+00', closed_at: '2026-11-14T04:00:00Z' }),
      TEN,
    );
    expect(ok.orders[1]).toMatchObject({ total_amount: 55, discount_amount: -0.5, opened_at: '2026-11-14T03:41:59.120Z', closed_at: '2026-11-14T04:00:00.000Z' });
  });

  it('nome da zona vazio na entrega (NOT NULL sem CHECK de tamanho no banco) é aceito', () => {
    const r = parseCloudOrders(onO2(body(), 'own_deliveries', { zone_name: '' }), TEN);
    expect(r.skippedOrderIds).toEqual([]);
    expect(r.ownDeliveries[1]!.zone_name).toBe('');
    expect(() => parseCloudOrders(onO2(body(), 'own_deliveries', { zone_name: null }), TEN)).toThrow(/Não foi possível ler as contas da nuvem/);
  });

  it('conta deixada de lado fica como está neste aparelho no merge; a mesa dela segue a nuvem', () => {
    const r = parseCloudOrders(onO2(body(), 'payments', { acquirer: 'MERCADO_PAGO' }), TEN);
    const localO2 = order(O2, { table_id: T2, customer_count: 7 });
    const local = {
      orders: [order(O1, { customer_count: 9 }), localO2],
      orderItems: [item('i2', O2, { notes: 'daqui' })],
      payments: [],
      ownDeliveries: [],
      tables: [table(T1), table(T2, { status: 'OCCUPIED', current_order_id: O2 })],
    };
    const m = mergeCloudOrders(local, r, none);
    expect(m.orders.find((o) => o.id === O1)!.customer_count).toBe(2); // O1 veio da nuvem
    expect(m.orders.find((o) => o.id === O2)).toEqual(localO2); // O2 fica como está aqui
    expect(m.orderItems.map((i) => `${i.id}:${i.notes}`)).toEqual(['i2:daqui', 'i1:null']);
    expect(m.tables[1]).toMatchObject({ status: 'OCCUPIED', current_order_id: O2 });
    // Aparelho que nunca teve O2: a mesa mostra a conta da nuvem que ele não tem (ocupada lá).
    const fresh = mergeCloudOrders({ orders: [], orderItems: [], payments: [], ownDeliveries: [], tables: [table(T2)] }, r, none);
    expect(fresh.orders.map((o) => o.id)).toEqual([O1]);
    expect(fresh.tables[0]).toMatchObject({ status: 'OCCUPIED', current_order_id: O2 });
  });
});
