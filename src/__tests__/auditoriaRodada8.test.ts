/**
 * Auditoria interna, rodada 8 do PR #54: conta com evento recusado pela nuvem não é cobrada
 * neste aparelho, itens atrasados levam a taxa da conta encerrada e a mudança da mesa que
 * estava na fila, e a troca de loja zera o que era da loja anterior.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useTcheStore, type CloudSession } from '../store/useTcheStore';
import type { Order, OrderItem, SyncEvent } from '../types';

const st = () => useTcheStore.getState();
const O1 = '01010101-0101-4101-8101-010101010101';
const O2 = '02020202-0202-4202-8202-020202020202';
const NOW = '2026-11-14T20:00:00.000Z';

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
const LATE = 'TCHEFOOD_CONTA_ENCERRADA: a conta já foi encerrada';
const cashPay = (orderId: string, amount: number) => st().registerPayment({
  orderId, amount, method: 'CASH', status: 'APPROVED', terminal_id: null, acquirer: 'CASH_DESK', acquirer_cnpj: null, card_brand: null,
  nsu: null, authorization_code: null, terminal_serial: null, idempotency_key: `k-${orderId}-${amount}`, item_ids: [],
});

describe('cobrança de conta com evento recusado pela nuvem (auditoria interna, rodada 8 do PR #54)', () => {
  beforeEach(() => st().resetDemo());

  /** B fechou a conta em outro aparelho; a cerveja lançada aqui depois foi recusada. */
  function setup() {
    st().login('1111');
    const free = st().tables.find((t) => t.status === 'FREE' && t.kind === 'TABLE')!;
    const beer = item('cerveja', O1);
    useTcheStore.setState({
      orders: [...st().orders, order(O1, free.id)],
      orderItems: [...st().orderItems, beer],
      outbox: [],
      syncRejected: [{ event: ev('order_items', beer.id, { ...beer }, { op: 'INSERT', id: 'e-cerveja' }), status: 400, message: LATE, rejected_at: NOW }],
    });
    return { free };
  }

  it('não cobra, não abre a maquininha, não vai para a cobrança e não encerra a conta zerada', () => {
    const { free } = setup();
    const blocked = { ok: false, error: expect.stringMatching(/Retaguarda › Nuvem › recusados/) };
    expect(cashPay(O1, 110)).toMatchObject(blocked);
    expect(st().beginTerminalCharge(O1, 'req-1', 110)).toMatchObject(blocked);
    expect(st().startCheckout(O1)).toMatchObject(blocked);
    expect(st().payments.some((p) => p.order_id === O1)).toBe(false);
    expect(st().pendingCharges).toHaveLength(0);
    // Conta zerada com o mesmo recusado: também não encerra.
    useTcheStore.setState({ orders: st().orders.map((o) => (o.id === O1 ? { ...o, subtotal_items: 0, service_fee_amount: 0, total_amount: 0, remaining_balance: 0 } : o)) });
    expect(st().closeZeroOrder(O1)).toMatchObject(blocked);
    expect(st().orders.find((o) => o.id === O1)!.status).toBe('OPEN');
    expect(free.id).toBeTruthy();
  });

  it('recusado de outra conta não segura esta', () => {
    setup();
    useTcheStore.setState({ syncRejected: st().syncRejected.map((r) => ({ ...r, event: { ...r.event, payload: { ...r.event.payload, order_id: O2 } } })) });
    const r = cashPay(O1, 110);
    if (!r.ok) expect(r.error).not.toMatch(/recusados/);
  });

  it('a recuperação (itens para conta nova) continua liberada e a conta nova é cobrável', () => {
    setup();
    useTcheStore.setState({ orders: st().orders.map((o) => (o.id === O1 ? { ...o, status: 'CLOSED' } : o)) });
    const m = st().moveLateItemsToNewOrder('e-cerveja');
    if (!m.ok) throw new Error(m.error);
    expect(st().syncRejected).toHaveLength(0);
    const r = st().startCheckout(m.data.newOrderId);
    if (!r.ok) expect(r.error).not.toMatch(/recusados/);
  });
});

describe('moveLateItemsToNewOrder: taxa e mudança da mesa (auditoria interna, rodada 8 do PR #54)', () => {
  beforeEach(() => st().resetDemo());

  function setup(tableEvents: SyncEvent[]) {
    st().login('1111');
    const free = st().tables.find((t) => t.status === 'FREE' && t.kind === 'TABLE')!;
    const beer = item('cerveja', O1);
    useTcheStore.setState({
      orders: [...st().orders, order(O1, free.id, { status: 'CLOSED', service_fee_pct: 12 })],
      orderItems: [...st().orderItems, beer],
      outbox: tableEvents,
      syncRejected: [{ event: ev('order_items', beer.id, { ...beer }, { op: 'INSERT', id: 'e-cerveja' }), status: 400, message: LATE, rejected_at: NOW }],
    });
    return { free };
  }

  it('a conta nova leva a porcentagem da taxa da conta encerrada', () => {
    setup([]);
    useTcheStore.setState({ tenant: { ...st().tenant, default_service_fee_pct: 10 } });
    const r = st().moveLateItemsToNewOrder('e-cerveja');
    if (!r.ok) throw new Error(r.error);
    expect(st().orders.find((o) => o.id === r.data.newOrderId)).toMatchObject({ service_fee_pct: 12, charge_service_fee: true });
  });

  it('o nome da mesa mudado aqui com a conta aberta continua subindo, sem a ocupação velha', () => {
    const { free } = setup([]);
    const rename = ev('dining_tables', free.id, { ...free, label: 'Varanda 1', status: 'OCCUPIED', current_order_id: O1 }, { id: 'e-mesa', table_edit_fields: ['label'] });
    useTcheStore.setState({ outbox: [rename] });
    const r = st().moveLateItemsToNewOrder('e-cerveja');
    if (!r.ok) throw new Error(r.error);
    const kept = st().outbox.find((e) => e.id === 'e-mesa');
    expect(kept).toBeDefined();
    expect(kept!.payload).toMatchObject({ label: 'Varanda 1' });
    expect(kept!.payload).not.toHaveProperty('status');
    expect(kept!.payload).not.toHaveProperty('current_order_id');
    // Lugares, área e número eram cópia: não sobem, para não regravar o que outro aparelho mudou
    // depois (GPT, rodada 8 do PR #54).
    for (const k of ['capacity', 'area', 'number', 'active']) expect(kept!.payload).not.toHaveProperty(k);
  });

  it('evento da mesa só de ocupação (nada do cadastro mudado aqui) sai da fila (GPT, rodada 8 do PR #54)', () => {
    const { free } = setup([]);
    const occupy = ev('dining_tables', free.id, { ...free, status: 'OCCUPIED', current_order_id: O1 }, { id: 'e-ocupa', table_edit_fields: [] });
    useTcheStore.setState({ outbox: [occupy] });
    const r = st().moveLateItemsToNewOrder('e-cerveja');
    if (!r.ok) throw new Error(r.error);
    expect(st().outbox.some((e) => e.id === 'e-ocupa')).toBe(false);
  });

  it('o cadastro da mesa manda só os campos mudados (GPT, rodada 8 do PR #54)', () => {
    st().login('9999');
    const t = st().tables.find((x) => x.kind === 'TABLE')!;
    const r = st().saveTable({ id: t.id, number: t.number, label: 'Varanda 9', area: t.area, capacity: t.capacity, active: t.active });
    if (!r.ok) throw new Error(r.error);
    expect(st().outbox.at(-1)).toMatchObject({ table: 'dining_tables', op: 'UPDATE', table_edit_fields: ['label'] });
  });
});

describe('troca de loja zera os caixas da nuvem e as contas de itens atrasados (auditoria interna, rodada 8 do PR #54)', () => {
  beforeEach(() => st().resetDemo());
  const session = (tenantId: string): CloudSession => ({
    url: 'https://x.supabase.co', anon_key: 'anon', email: 'a@b', access_token: 'jwt', refresh_token: 'r', expires_at: 9e9, tenant_id: tenantId,
  });

  it('resetDemo e startNewStore', () => {
    useTcheStore.setState({ cloudCashRanges: [{ id: 'c', opened_at: NOW, closed_at: null }], lateItemsOrderIds: [O1] });
    st().resetDemo();
    expect(st().cloudCashRanges ?? []).toEqual([]);
    expect(st().lateItemsOrderIds ?? []).toEqual([]);
    st().login('1111');
    const owner = st().staff.find((u) => u.role === 'OWNER')!;
    st().logout();
    st().login(owner.pin_code);
    useTcheStore.setState({ orders: st().orders.filter((o) => o.status !== 'OPEN' && o.status !== 'PAYING'), cloudCashRanges: [{ id: 'c', opened_at: NOW, closed_at: null }], lateItemsOrderIds: [O1] });
    const r = st().startNewStore(
      {
        tenant: { name: 'Bar do Zé', legal_name: 'Zé Comércio de Alimentos Ltda', cnpj: '11.222.333/0001-81', state_registration: null, city: 'Pelotas', state: 'rs', default_service_fee_pct: 10 },
        owner_name: 'Zé', owner_pin: '4826',
      },
      { managerPin: owner.pin_code, reason: 'Começar loja nova' },
    );
    if (!r.ok) throw new Error(r.error);
    expect(st().cloudCashRanges).toEqual([]);
    expect(st().lateItemsOrderIds).toEqual([]);
  });

  it('joinCloudStore', () => {
    const owner = st().staff.find((u) => u.role === 'OWNER')!;
    st().login(owner.pin_code);
    useTcheStore.setState({ orders: st().orders.filter((o) => o.status !== 'OPEN' && o.status !== 'PAYING'), cloudCashRanges: [{ id: 'c', opened_at: NOW, closed_at: null }], lateItemsOrderIds: [O1] });
    const s = st();
    const tenantId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const boss = { ...owner, tenant_id: tenantId };
    const snapshot = {
      tenant: { ...s.tenant, id: tenantId }, staff: [boss], terminals: [], categories: [], products: [], modifierGroups: [], modifierOptions: [],
      productModifierGroups: [], priceSchedules: [], tables: [], rolePermissions: [], suppliers: [], supplierProductLinks: [], purchaseInvoices: [],
      deliveryZones: [], couriers: [], loyaltyCustomers: [], cashbackLedger: [],
    };
    const r = st().joinCloudStore({ session: session(tenantId), snapshot: snapshot as never, staff: [boss], userId: boss.id });
    if (!r.ok) throw new Error(r.error);
    expect(st().cloudCashRanges).toEqual([]);
    expect(st().lateItemsOrderIds).toEqual([]);
  });
});
