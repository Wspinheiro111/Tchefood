/**
 * Auditoria interna, rodada 8 do PR #54: conta de itens atrasados recusada com mesa ocupada (a
 * mesa mostra quem a ocupa na nuvem e a conta pode ser descartada), conta deixada de lado pela
 * leitura (valor que esta versão não conhece), cashback e cobrança confirmada pelo comprovante
 * com conta segurada, e conta segurada atrás de um recusado de outro registro.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { mergeCloudOrders, pendingOrderKeys, type CloudOrders } from '../lib/sync/orderPull';
import { heldRecordKeys } from '../lib/sync/supabaseSync';
import { clearReviewHold, setReviewHold } from '../lib/payments/reviewHolds';
import { lateOrdersRefusedTableTaken, useTcheStore, type CloudSession } from '../store/useTcheStore';
import type { DiningTable, Order, OrderItem, SyncEvent } from '../types';

const st = () => useTcheStore.getState();
const O1 = '01010101-0101-4101-8101-010101010101';
const O2 = '02020202-0202-4202-8202-020202020202';
const T1 = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
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
const table = (id: string, over: Partial<DiningTable> = {}): DiningTable => ({
  id, tenant_id: 't', number: 1, label: 'Mesa 1', area: 'Salão', capacity: 4, status: 'FREE', qr_code_token: null, current_order_id: null,
  active: true, updated_at: NOW, kind: 'TABLE', ...over,
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
const cashPay = (orderId: string, amount: number) => st().registerPayment({
  orderId, amount, method: 'CASH', status: 'APPROVED', terminal_id: null, acquirer: 'CASH_DESK', acquirer_cnpj: null, card_brand: null,
  nsu: null, authorization_code: null, terminal_serial: null, idempotency_key: `k-${orderId}-${amount}`, item_ids: [],
});
const LATE = 'TCHEFOOD_CONTA_ENCERRADA: a conta já foi encerrada';

beforeEach(() => {
  st().resetDemo();
  for (const o of st().orders) clearReviewHold(o.id);
  clearReviewHold(O1);
});

/**
 * A conta O1 foi encerrada em outro aparelho; a cerveja lançada aqui foi para uma conta nova
 * (itens atrasados), e a abertura dela foi recusada: a nuvem já tem a conta O2 do próximo cliente.
 */
function lateRefused() {
  st().login('1111');
  const free = st().tables.find((t) => t.status === 'FREE' && t.kind === 'TABLE')!;
  const beer = st().products[0]!;
  const late = item('cerveja', O1, { product_id: beer.id, quantity: 2 });
  useTcheStore.setState({
    cloud: session(st().tenant.id),
    orders: [...st().orders, order(O1, free.id, { status: 'CLOSED' })],
    orderItems: [...st().orderItems, late],
    outbox: [],
    syncRejected: [{ event: ev('order_items', late.id, { ...late }, { op: 'INSERT', id: 'e-cerveja' }), status: 400, message: LATE, rejected_at: NOW }],
  });
  const m = st().moveLateItemsToNewOrder('e-cerveja');
  if (!m.ok) throw new Error(m.error);
  const freshId = m.data.newOrderId;
  const insert = st().outbox.find((e) => e.table === 'orders' && e.op === 'INSERT' && e.row_id === freshId)!;
  useTcheStore.setState({
    outbox: st().outbox.filter((e) => e.id !== insert.id),
    syncRejected: [{
      event: insert, status: 409, rejected_at: NOW,
      message: `TCHEFOOD_MESA_OCUPADA: a mesa já tem outra conta aberta — {"table_id": "${free.id}", "holder_order_id": "${O2}"}`,
    }],
  });
  return { free, freshId, insert, beer };
}

describe('conta de itens atrasados recusada com mesa ocupada (auditoria interna, rodada 8 do PR #54)', () => {
  it('merge: a mesa que mostra a conta recusada passa a mostrar quem ocupa a mesa na nuvem', () => {
    const local = { orders: [], orderItems: [], payments: [], ownDeliveries: [], tables: [table(T1, { status: 'OCCUPIED', current_order_id: O1 })] };
    const events = [ev('orders', O1, { table_id: T1 }, { op: 'INSERT' }), ev('dining_tables', T1, { current_order_id: O1, status: 'OCCUPIED' })];
    const taken = cloud({ tables: [{ id: T1, status: 'WAITING_BILL', current_order_id: O2, updated_at: NOW }] });
    // Sem a marca: a conta pendente segura a mesa (como antes).
    expect(mergeCloudOrders(local, taken, pendingOrderKeys(events)).tables[0]).toMatchObject({ current_order_id: O1 });
    const marked = pendingOrderKeys(events, [], [O1]);
    expect(mergeCloudOrders(local, taken, marked).tables[0]).toMatchObject({ status: 'WAITING_BILL', current_order_id: O2 });
    // Mesa livre na nuvem: fica como está aqui, o reenvio da conta sobe.
    const free = cloud({ tables: [{ id: T1, status: 'FREE', current_order_id: null, updated_at: NOW }] });
    expect(mergeCloudOrders(local, free, marked).tables[0]).toMatchObject({ current_order_id: O1 });
  });

  it('store: a leitura da nuvem tira a mesa da conta recusada; a conta continua aqui', () => {
    const { free, freshId } = lateRefused();
    expect(lateOrdersRefusedTableTaken(st())).toEqual([freshId]);
    expect(st().tables.find((t) => t.id === free.id)!.current_order_id).toBe(freshId);
    const r = st().applyCloudOrders(cloud({
      orders: [order(O2, free.id)],
      tables: [{ id: free.id, status: 'OCCUPIED', current_order_id: O2, updated_at: NOW }],
    }));
    expect(r.ok).toBe(true);
    expect(st().tables.find((t) => t.id === free.id)).toMatchObject({ status: 'OCCUPIED', current_order_id: O2 });
    expect(st().orders.some((o) => o.id === freshId)).toBe(true);
  });

  it('descartar: a prévia lista os itens sem mudar nada; o descarte tira a conta e os eventos dela', () => {
    const { free, freshId, insert, beer } = lateRefused();
    const rename = ev('dining_tables', free.id, { ...free, label: 'Varanda 1', status: 'OCCUPIED', current_order_id: freshId }, { id: 'e-mesa', table_edit_fields: ['label'] });
    useTcheStore.setState({ outbox: [...st().outbox, rename] });
    // Só quem cuida da nuvem (SYNC_MANAGE, a permissão da tela Retaguarda › Nuvem): o garçom não descarta.
    expect(st().discardLateItemsOrder(insert.id, { preview: true })).toMatchObject({ ok: false, error: expect.stringMatching(/Conectar o aparelho à nuvem/) });
    st().login('9999');
    const before = { orders: st().orders.length, outbox: st().outbox.length };
    const preview = st().discardLateItemsOrder(insert.id, { preview: true });
    if (!preview.ok) throw new Error(preview.error);
    expect(preview.data.items).toEqual([{ name: beer.name, quantity: 2 }]);
    expect(st().orders).toHaveLength(before.orders);
    expect(st().outbox).toHaveLength(before.outbox);

    const r = st().discardLateItemsOrder(insert.id);
    if (!r.ok) throw new Error(r.error);
    expect(r.data).toEqual({ orderId: freshId, items: [{ name: beer.name, quantity: 2 }] });
    expect(st().orders.some((o) => o.id === freshId)).toBe(false);
    expect(st().orderItems.some((i) => i.order_id === freshId)).toBe(false);
    expect(st().syncRejected).toHaveLength(0);
    expect(st().lateItemsOrderIds).not.toContain(freshId);
    // Só a mudança da mesa continua, sem a ocupação pela conta descartada, e o registro do descarte.
    expect(st().outbox.map((e) => e.table)).toEqual(['dining_tables', 'audit_logs']);
    expect(st().outbox[0]!.id).toBe('e-mesa');
    expect(st().outbox[0]!.payload).not.toHaveProperty('current_order_id');
    const log = st().auditLogs[0]!;
    expect(log).toMatchObject({
      action_type: 'LATE_ITEMS_DISCARDED', order_id: null, authorized_by_manager_id: null, whatsapp_alert_sent: false,
      performed_by_user_id: st().currentUserId, amount_impact: -10,
    });
    expect(log.metadata).toMatchObject({ discarded_order_id: freshId, table_id: free.id, items: [expect.objectContaining({ name: beer.name, quantity: 2 })] });
    expect(log.reason).toContain(`${beer.name} × 2`);
    expect(st().outbox[1]!.payload).toMatchObject({ id: log.id, action_type: 'LATE_ITEMS_DISCARDED', order_id: null });
    expect(st().tables.find((t) => t.id === free.id)).toMatchObject({ status: 'FREE', current_order_id: null });
  });

  it('descartar: recusa com pagamento ou com conta que não é de itens atrasados', () => {
    const { freshId, insert } = lateRefused();
    const pay = { ...st().payments[0]!, id: 'pg-x', order_id: freshId };
    useTcheStore.setState({ payments: [...st().payments, pay] });
    st().login('9999');
    expect(st().discardLateItemsOrder(insert.id)).toMatchObject({ ok: false, error: expect.stringMatching(/pagamento/) });
    expect(st().orders.some((o) => o.id === freshId)).toBe(true);
    useTcheStore.setState({ payments: st().payments.filter((p) => p.id !== 'pg-x'), lateItemsOrderIds: [] });
    expect(st().discardLateItemsOrder(insert.id)).toMatchObject({ ok: false, error: expect.stringMatching(/não é de itens atrasados/) });
    expect(st().orders.some((o) => o.id === freshId)).toBe(true);
  });

  it('a leitura que dá a mesa à conta da nuvem tira a ocupação por L do evento da mesa na fila', () => {
    const { free, freshId } = lateRefused();
    // "Pagando" na mesa com a conta L (startCheckout feito antes da recusa) e a mudança de nome.
    const paying = ev('dining_tables', free.id, { label: 'Varanda 1', status: 'PAYING', current_order_id: freshId }, { id: 'e-pagando', table_edit_fields: ['label'] });
    useTcheStore.setState({ outbox: [...st().outbox, paying] });
    const held = () => heldRecordKeys(st().outbox, (st().syncRejected ?? []).map((r) => r.event));
    expect(held().has(`dining_tables:${free.id}`)).toBe(true);
    expect(st().applyCloudOrders(cloud({
      orders: [order(O2, free.id)],
      tables: [{ id: free.id, status: 'OCCUPIED', current_order_id: O2, updated_at: NOW }],
    })).ok).toBe(true);
    const kept = st().outbox.find((e) => e.id === 'e-pagando')!;
    expect(kept.payload).toEqual({ id: free.id, label: 'Varanda 1' });
    // A mesa e a conta da nuvem não ficam mais seguradas atrás da recusa de L.
    const next = ev('dining_tables', free.id, { status: 'PAYING', current_order_id: O2 }, { id: 'e-o2' });
    useTcheStore.setState({ outbox: [...st().outbox, next] });
    expect(held().has(`dining_tables:${free.id}`)).toBe(false);
    expect(held().has(`orders:${O2}`)).toBe(false);
  });

  it('a leitura com a mesa livre na nuvem não mexe no evento da mesa (o reenvio de L sobe)', () => {
    const { free, freshId } = lateRefused();
    const occupy = ev('dining_tables', free.id, { status: 'OCCUPIED', current_order_id: freshId }, { id: 'e-ocupa' });
    useTcheStore.setState({ outbox: [...st().outbox, occupy] });
    expect(st().applyCloudOrders(cloud({ tables: [{ id: free.id, status: 'FREE', current_order_id: null, updated_at: NOW }] })).ok).toBe(true);
    expect(st().outbox.find((e) => e.id === 'e-ocupa')!.payload).toMatchObject({ current_order_id: freshId, status: 'OCCUPIED' });
  });

  it('descartar chopp devolve o volume ao barril neste aparelho', () => {
    const { freshId, insert } = lateRefused();
    const link = st().kegTapProducts[0]!;
    const tap = st().kegTaps.find((t) => t.id === link.tap_id)!;
    // O item da conta L vira chopp de 500 ml (a venda já baixou o barril aqui).
    useTcheStore.setState({
      orderItems: st().orderItems.map((i) => (i.order_id === freshId ? { ...i, product_id: link.product_id, keg_volume_ml: 500, created_at: new Date(Date.parse(tap.tapped_at) + 1000).toISOString() } : i)),
      kegTaps: st().kegTaps.map((t) => (t.id === tap.id ? { ...t, billed_volume_ml: t.billed_volume_ml + 1000 } : t)),
    });
    const billed = st().kegTaps.find((t) => t.id === tap.id)!.billed_volume_ml;
    const foam = st().kegTaps.find((t) => t.id === tap.id)!.wasted_foam_ml;
    st().login('9999');
    const r = st().discardLateItemsOrder(insert.id);
    if (!r.ok) throw new Error(r.error);
    const after = st().kegTaps.find((t) => t.id === tap.id)!;
    expect(after.billed_volume_ml).toBe(billed - 1000);
    expect(after.wasted_foam_ml).toBe(foam);
    expect(st().outbox.some((e) => e.table === 'keg_taps')).toBe(false);
  });
});

describe('conta deixada de lado pela leitura da nuvem (auditoria interna, rodada 8 do PR #54)', () => {
  it('guarda as contas deixadas de lado e não cobra nenhuma delas', () => {
    st().login('1111');
    const free = st().tables.find((t) => t.status === 'FREE' && t.kind === 'TABLE')!;
    useTcheStore.setState({ cloud: session(st().tenant.id), orders: [...st().orders, order(O1, free.id)], outbox: [], syncRejected: [] });
    expect(st().applyCloudOrders(cloud({ skippedOrderIds: [O1] })).ok).toBe(true);
    expect(st().cloudSkippedOrderIds).toEqual([O1]);
    expect(cashPay(O1, 110)).toMatchObject({ ok: false, error: 'Esta conta tem um valor que esta versão do app não conhece: atualize o app antes de cobrar.' });
    expect(st().startCheckout(O1)).toMatchObject({ ok: false, error: expect.stringMatching(/atualize o app/) });
    // A leitura seguinte sem ela libera.
    expect(st().applyCloudOrders(cloud()).ok).toBe(true);
    expect(st().cloudSkippedOrderIds).toEqual([]);
    const r = cashPay(O1, 110);
    if (!r.ok) expect(r.error).not.toMatch(/atualize o app/);
  });

  it('merge: a mesa que mostra aqui uma conta deixada de lado segue a nuvem quando lá ela está livre ou com outra conta', () => {
    const local = { orders: [order(O1, T1)], orderItems: [], payments: [], ownDeliveries: [], tables: [table(T1, { status: 'OCCUPIED', current_order_id: O1 })] };
    const free = { id: T1, status: 'FREE' as const, current_order_id: null, updated_at: NOW };
    // Sem a marca: a conta aberta aqui que a nuvem não mandou segura a mesa (como antes).
    expect(mergeCloudOrders(local, cloud({ tables: [free] }), pendingOrderKeys([])).tables[0]).toMatchObject({ current_order_id: O1 });
    // Deixada de lado: a nuvem a tem, e lá a mesa está livre (a conta foi encerrada lá).
    const r = mergeCloudOrders(local, cloud({ skippedOrderIds: [O1], tables: [free] }), pendingOrderKeys([]));
    expect(r.tables[0]).toMatchObject({ status: 'FREE', current_order_id: null });
    // A conta fica aqui como está.
    expect(r.orders).toEqual([local.orders[0]]);
    // Com outra conta na mesa lá: a mesa mostra a outra.
    const other = mergeCloudOrders(local, cloud({ skippedOrderIds: [O1], tables: [{ id: T1, status: 'OCCUPIED', current_order_id: O2, updated_at: NOW }] }), pendingOrderKeys([]));
    expect(other.tables[0]).toMatchObject({ current_order_id: O2 });
    // Conta deixada de lado com mudança pendente aqui: a mesa fica como está.
    const queued = [ev('orders', O1, { status: 'PAYING' })];
    expect(mergeCloudOrders(local, cloud({ skippedOrderIds: [O1], tables: [free] }), pendingOrderKeys(queued)).tables[0]).toMatchObject({ current_order_id: O1 });
  });

  it('mesa ocupada na nuvem por conta que este aparelho não conhece: fica ocupada, e abrir pede para atualizar o app', () => {
    st().login('1111');
    const free = st().tables.find((t) => t.status === 'FREE' && t.kind === 'TABLE')!;
    useTcheStore.setState({ cloud: session(st().tenant.id), outbox: [], syncRejected: [] });
    expect(st().applyCloudOrders(cloud({ skippedOrderIds: [O2], tables: [{ id: free.id, status: 'OCCUPIED', current_order_id: O2, updated_at: NOW }] })).ok).toBe(true);
    expect(st().tables.find((t) => t.id === free.id)).toMatchObject({ status: 'OCCUPIED', current_order_id: O2 });
    expect(st().openTable(free.id, 2, null)).toMatchObject({ ok: false, error: expect.stringMatching(/esta versão do app não conhece: atualize o app/) });
  });

  it('a troca de loja zera a lista', () => {
    useTcheStore.setState({ cloudSkippedOrderIds: [O1] });
    st().resetDemo();
    expect(st().cloudSkippedOrderIds ?? []).toEqual([]);
  });
});

describe('cashback e cobrança confirmada com conta segurada (auditoria interna, rodada 8 do PR #54)', () => {
  function heldOrder() {
    st().login('1111');
    const free = st().tables.find((t) => t.status === 'FREE' && t.kind === 'TABLE')!;
    const beer = item('cerveja', O1);
    useTcheStore.setState({
      orders: [...st().orders, order(O1, free.id)],
      orderItems: [...st().orderItems, beer],
      outbox: [],
      syncRejected: [{ event: ev('order_items', beer.id, { ...beer }, { op: 'INSERT', id: 'e-cerveja' }), status: 400, message: LATE, rejected_at: NOW }],
    });
  }

  it('redeemCashback não abate cashback na conta com evento recusado', () => {
    heldOrder();
    const ledger = st().cashbackLedger.length;
    const r = st().redeemCashback(O1, '53999999999');
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/Retaguarda › Nuvem › recusados/) });
    expect(st().cashbackLedger).toHaveLength(ledger);
  });

  it('confirmReviewedCharge registra a cobrança que a maquininha fez, mesmo com a conta segurada', () => {
    heldOrder();
    expect(cashPay(O1, 50)).toMatchObject({ ok: false, error: expect.stringMatching(/recusados/) });
    setReviewHold({
      order_id: O1, amount: 110, reason: 'Queda no meio da cobrança', code: 'WRAPPER_EXCEPTION',
      method: 'CREDIT', acquirer: 'STONE', terminal_id: null, terminal_serial: 'STONE-01', idempotency_key: `hold-${O1}`,
    });
    const r = st().confirmReviewedCharge(
      { orderId: O1, nsu: '004512', authorization_code: 'a1b2c3', card_brand: 'VISA' },
      { managerPin: '9999', reason: 'Maquininha aprovou, conferido no comprovante' },
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.data.payment).toMatchObject({ order_id: O1, amount: 110, nsu: '004512', status: 'APPROVED' });
    // A exceção vale só para essa chamada: o pagamento comum continua barrado.
    useTcheStore.setState({ orders: st().orders.map((o) => (o.id === O1 ? { ...o, status: 'OPEN', remaining_balance: 10 } : o)) });
    expect(cashPay(O1, 10)).toMatchObject({ ok: false, error: expect.stringMatching(/recusados/) });
  });
});

describe('conta segurada atrás de um recusado de outro registro (auditoria interna, rodada 8 do PR #54)', () => {
  it('heldRecordKeys: o evento da mesa segurado leva junto a conta que ele mostra', () => {
    const refused = ev('dining_tables', T1, { label: 'Varanda' }, { id: 'e-recusado' });
    const occupy = ev('dining_tables', T1, { current_order_id: O1, status: 'OCCUPIED' }, { id: 'e-ocupa' });
    const other = ev('orders', O2, {}, { id: 'e-outra' });
    const keys = heldRecordKeys([occupy, other], [refused]);
    expect(keys.has(`orders:${O1}`)).toBe(true);
    expect(keys.has(`orders:${O2}`)).toBe(false);
    expect(heldRecordKeys([occupy], []).size).toBe(0);
  });

  it('chargeBlock: não cobra a conta com evento segurado atrás do recusado da mesa', () => {
    st().login('1111');
    const free = st().tables.find((t) => t.status === 'FREE' && t.kind === 'TABLE')!;
    const refused = ev('dining_tables', free.id, { label: 'Varanda' }, { id: 'e-recusado' });
    const occupy = ev('dining_tables', free.id, { current_order_id: O1, status: 'OCCUPIED' }, { id: 'e-ocupa' });
    useTcheStore.setState({
      orders: [...st().orders, order(O1, free.id), order(O2, free.id)],
      outbox: [occupy],
      syncRejected: [{ event: refused, status: 400, message: 'recusado', rejected_at: NOW }],
    });
    expect(cashPay(O1, 110)).toMatchObject({ ok: false, error: expect.stringMatching(/esperando na fila atrás de outra que a nuvem recusou/) });
    expect(st().startCheckout(O1)).toMatchObject({ ok: false, error: expect.stringMatching(/esperando na fila/) });
    const r = st().startCheckout(O2);
    if (!r.ok) expect(r.error).not.toMatch(/esperando na fila|recusados/);
  });
});

describe('fichas da venda de balcão paga em outro aparelho (Codex, PR #54)', () => {
  beforeEach(() => {
    st().resetDemo();
    useTcheStore.setState({ cloud: session(st().tenant.id), outbox: [], syncRejected: [] });
  });
  const counter = () => st().tables.find((t) => t.kind === 'COUNTER')!;
  const product = () => st().products.find((p) => p.active && !p.is_combo)!;
  const paidCounterSale = (id: string): CloudOrders => {
    const p = product();
    const o = order(id, counter().id, {
      status: 'CLOSED', charge_service_fee: false, service_fee_pct: 0, service_fee_amount: 0, subtotal_items: p.price, total_amount: p.price,
      paid_amount: p.price, remaining_balance: 0, closed_at: NOW,
    });
    return cloud({ orders: [o], orderItems: [item(`i-${id}`, id, { product_id: p.id, unit_price: p.price, total_item_price: p.price, is_paid: true })] });
  };

  it('venda que chegou paga pela leitura: este aparelho não imprime outro jogo de fichas', () => {
    expect(st().applyCloudOrders(paidCounterSale(O2)).ok).toBe(true);
    expect(st().orders.find((o) => o.id === O2)!.status).toBe('CLOSED');
    expect(st().issueEventTickets(O2)).toMatchObject({ ok: false, error: expect.stringMatching(/paga em outro aparelho/) });
    expect(st().eventTickets.some((t) => t.order_id === O2)).toBe(false);
    // A leitura seguinte não "esquece" a venda (continua fechada lá).
    expect(st().applyCloudOrders(paidCounterSale(O2)).ok).toBe(true);
    expect(st().issueEventTickets(O2).ok).toBe(false);
  });

  it('venda paga aqui e confirmada pela leitura: as fichas saem normalmente', () => {
    const local = paidCounterSale(O2);
    useTcheStore.setState({ orders: [...st().orders, ...local.orders], orderItems: [...st().orderItems, ...local.orderItems] });
    expect(st().applyCloudOrders(paidCounterSale(O2)).ok).toBe(true);
    const t = st().issueEventTickets(O2);
    if (!t.ok) throw new Error(t.error);
    expect(t.data.length).toBeGreaterThan(0);
  });
});
