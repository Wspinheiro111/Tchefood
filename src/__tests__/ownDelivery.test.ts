import { beforeEach, describe, expect, it } from 'vitest';
import { DELIVERY_FEE_CODE, migratePersisted, useTcheStore, type PickupLine } from '../store/useTcheStore';
import { normalizePhone, routeUrl, settlementPreview, validateDeliveryInput, type DeliveryAddressInput } from '../lib/ownDelivery';
import { cashSummary } from '../lib/cashRegister';
import { stableUuid } from '../lib/ids';
import type { DeliveryZone } from '../types';

const st = () => useTcheStore.getState();
const product = (code: string) => st().products.find((p) => p.code === code)!;
const MANAGER = { managerPin: '9999', reason: 'Acerto do entregador' };
const line = (code: string, quantity = 1): PickupLine => ({ product_id: product(code).id, quantity, modifiers: [], meat_doneness: null, half_product_ids: [], quick_tags: [], free_notes: '' });
const zone = (name = 'Centro') => st().deliveryZones.find((z) => z.name === name)!;

function address(extra: Partial<DeliveryAddressInput> = {}): DeliveryAddressInput {
  return { customerName: 'Maria Souza', phone: '(55) 99653-8255', address: 'Rua Venâncio Aires, 100', reference: 'Perto da praça', zoneId: zone().id, payOnDelivery: true, changeFor: null, ...extra };
}

function deliveryOrder(extra: Partial<DeliveryAddressInput> = {}, lines = [line('301')]) {
  const r = st().createPickupOrder({ lines, fulfillment: 'DELIVERY', customerName: 'Maria', delivery: address(extra) });
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

const deliveryOf = (orderId: string) => st().ownDeliveries.find((d) => d.order_id === orderId)!;
const asCashier = () => expect(st().login('5555').ok).toBe(true);

beforeEach(() => st().resetDemo());

describe('entrega própria — funções puras', () => {
  const zones: DeliveryZone[] = [{ id: 'z', tenant_id: 't', name: 'Centro', fee: 5, eta_minutes: 30, active: true }];
  const base: DeliveryAddressInput = { customerName: 'Ana', phone: '55996538255', address: 'Rua A, 1', reference: '', zoneId: 'z', payOnDelivery: true, changeFor: null };

  it('telefone só com DDD e número', () => {
    expect(normalizePhone('(55) 99653-8255')).toBe('55996538255');
    expect(normalizePhone('+55 55 99653-8255')).toBe('55996538255');
    expect(normalizePhone('5532221111')).toBe('5532221111');
    expect(normalizePhone('99653-8255')).toBeNull();
  });

  it('valida endereço, bairro e troco', () => {
    expect(validateDeliveryInput(base, zones, 40)).toBeNull();
    expect(validateDeliveryInput({ ...base, phone: '123' }, zones, 40)).toMatch(/telefone/);
    expect(validateDeliveryInput({ ...base, address: 'Rua' }, zones, 40)).toMatch(/endereço/);
    expect(validateDeliveryInput({ ...base, zoneId: 'x' }, zones, 40)).toMatch(/bairro/);
    expect(validateDeliveryInput({ ...base, zoneId: 'z' }, [{ ...zones[0]!, active: false }], 40)).toMatch(/bairro/);
    expect(validateDeliveryInput({ ...base, changeFor: 30 }, zones, 40)).toMatch(/troco/);
    expect(validateDeliveryInput({ ...base, changeFor: 50 }, zones, 40)).toBeNull();
    expect(validateDeliveryInput({ ...base, payOnDelivery: false, changeFor: 50 }, zones, 40)).toMatch(/Troco só/);
  });

  it('rota no Google Maps com as paradas na ordem', () => {
    const url = routeUrl({ city: 'Santa Maria', state: 'RS' }, [
      { address: 'Rua A, 1', zone_name: 'Centro' },
      { address: 'Rua B, 2', zone_name: 'Pippi' },
    ])!;
    const q = new URL(url).searchParams;
    expect(q.get('destination')).toBe('Rua B, 2, Pippi, Santa Maria - RS');
    expect(q.get('waypoints')).toBe('Rua A, 1, Centro, Santa Maria - RS');
    expect(routeUrl({ city: 'X', state: 'RS' }, [])).toBeNull();
  });

  it('id fixo por texto', () => {
    expect(stableUuid('a')).toBe(stableUuid('a'));
    expect(stableUuid('a')).not.toBe(stableUuid('b'));
    expect(stableUuid('a')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('entrega própria — fluxo', () => {
  it('lança a entrega com a taxa do bairro como item da conta, fora da cozinha', () => {
    asCashier();
    const o = deliveryOrder();
    const items = st().orderItems.filter((i) => i.order_id === o.id);
    const fee = items.find((i) => i.product_id === product(DELIVERY_FEE_CODE).id)!;
    expect(fee.unit_price).toBe(zone().fee);
    expect(fee.sector).toBe('NONE');
    expect(fee.status).toBe('DELIVERED');
    expect(product(DELIVERY_FEE_CODE).active).toBe(false);
    expect(o.total_amount).toBe(product('301').price + zone().fee);
    expect(o.fulfillment_type).toBe('DELIVERY');
    const d = deliveryOf(o.id);
    expect(d).toMatchObject({ status: 'PREPARING', customer_phone: '55996538255', zone_name: 'Centro', delivery_fee: zone().fee, pay_on_delivery: true });
    const tables = st().outbox.map((e) => e.table);
    expect(tables.indexOf('products')).toBeLessThan(tables.indexOf('orders'));
    expect(tables.indexOf('orders')).toBeLessThan(tables.indexOf('own_deliveries'));
    // A segunda entrega reaproveita o produto da taxa.
    deliveryOrder();
    expect(st().products.filter((p) => p.code === DELIVERY_FEE_CODE)).toHaveLength(1);
  });

  it('recusa entrega sem endereço e totem não lança entrega', () => {
    asCashier();
    expect(st().createPickupOrder({ lines: [line('301')], fulfillment: 'DELIVERY', customerName: 'Maria' }).ok).toBe(false);
    expect(st().createPickupOrder({ lines: [line('301')], fulfillment: 'DELIVERY', customerName: 'Maria', delivery: address({ phone: '1' }) }).ok).toBe(false);
    expect(st().login('4444').ok).toBe(true);
    expect(st().createPickupOrder({ lines: [line('301')], fulfillment: 'DELIVERY', customerName: 'Maria', delivery: address() }).ok).toBe(false);
  });

  it('pago antes só fica pronto depois de pago', () => {
    asCashier();
    const o = deliveryOrder({ payOnDelivery: false });
    const d = deliveryOf(o.id);
    expect(st().setOwnDeliveryStatus(d.id, 'READY').ok).toBe(false);
    const r = st().registerPayment({
      orderId: o.id, amount: o.remaining_balance, method: 'PIX', status: 'APPROVED', terminal_id: null, acquirer: 'CASH_DESK',
      acquirer_cnpj: null, card_brand: null, nsu: null, authorization_code: null, terminal_serial: null, idempotency_key: 'pix-1', item_ids: [],
    });
    expect(r.ok).toBe(true);
    expect(st().setOwnDeliveryStatus(d.id, 'READY').ok).toBe(true);
  });

  it('pronto → saiu com o entregador → entregue → acerto: o dinheiro entra no caixa e o ganho sai em sangria', () => {
    asCashier();
    expect(st().openCashSession(100).ok).toBe(true);
    const o1 = deliveryOrder();
    const o2 = deliveryOrder({ zoneId: zone('Pippi').id, changeFor: 100 });
    const [d1, d2] = [deliveryOf(o1.id), deliveryOf(o2.id)];
    const courier = st().couriers[0]!;
    expect(st().dispatchOwnDeliveries([d1.id], courier.id).ok).toBe(false); // ainda em preparo
    expect(st().setOwnDeliveryStatus(d1.id, 'READY').ok).toBe(true);
    expect(st().setOwnDeliveryStatus(d2.id, 'READY').ok).toBe(true);
    expect(st().setOwnDeliveryStatus(d1.id, 'DELIVERED').ok).toBe(false); // não saiu
    const out = st().dispatchOwnDeliveries([d1.id, d2.id, d1.id], courier.id);
    expect(out.ok && out.data.map((d) => d.courier_fee)).toEqual([courier.fee_per_delivery, courier.fee_per_delivery]);
    expect(st().setOwnDeliveryStatus(d1.id, 'DELIVERED').ok).toBe(true);
    expect(st().setOwnDeliveryStatus(d2.id, 'DELIVERED').ok).toBe(true);

    const preview = settlementPreview(courier.id, st().ownDeliveries, st().orders);
    expect(preview.cashOrders).toBe(2);
    expect(preview.cashToCollect).toBe(o1.total_amount + o2.total_amount);
    expect(preview.courierFees).toBe(2 * courier.fee_per_delivery);

    expect(st().settleCourier(courier.id, { payFromDrawer: true, auth: null }).ok).toBe(false);
    expect(st().orders.find((o) => o.id === o1.id)!.status).toBe('PAYING'); // nada recebido sem PIN
    const s = st().settleCourier(courier.id, { payFromDrawer: true, auth: MANAGER });
    if (!s.ok) throw new Error(s.error);
    expect(s.data).toMatchObject({ deliveries: 2, cash_collected: preview.cashToCollect, courier_fees: preview.courierFees });
    expect(s.data.cash_movement_id).not.toBeNull();
    expect(st().orders.filter((o) => [o1.id, o2.id].includes(o.id)).every((o) => o.status === 'CLOSED')).toBe(true);
    expect(st().ownDeliveries.filter((d) => d.settlement_id === s.data.id)).toHaveLength(2);

    const session = st().cashSessions.find((c) => c.status === 'OPEN')!;
    const sum = cashSummary(session, st().payments, st().cashMovements);
    expect(sum.cashSales).toBe(preview.cashToCollect);
    expect(sum.withdrawals).toBe(preview.courierFees);
    expect(sum.expected).toBe(100 + preview.netFromCourier);
    // Nada mais a acertar.
    expect(st().settleCourier(courier.id, { payFromDrawer: false, auth: null }).ok).toBe(false);
    const tables = st().outbox.map((e) => e.table);
    expect(tables.lastIndexOf('cash_movements')).toBeLessThan(tables.indexOf('courier_settlements'));
    expect(tables.indexOf('courier_settlements')).toBeLessThan(tables.lastIndexOf('own_deliveries'));
  });

  it('acerto sem a gaveta só recebe o dinheiro', () => {
    asCashier();
    const o = deliveryOrder();
    const d = deliveryOf(o.id);
    const courier = st().couriers[0]!;
    st().setOwnDeliveryStatus(d.id, 'READY');
    st().dispatchOwnDeliveries([d.id], courier.id);
    st().setOwnDeliveryStatus(d.id, 'DELIVERED');
    expect(st().settleCourier(courier.id, { payFromDrawer: true, auth: MANAGER }).ok).toBe(false); // caixa fechado
    const s = st().settleCourier(courier.id, { payFromDrawer: false, auth: null });
    expect(s.ok && s.data.cash_movement_id).toBeNull();
    expect(st().cashMovements).toHaveLength(0);
  });

  it('cancelar pede PIN de gerente e desfaz a senha', () => {
    asCashier();
    const o = deliveryOrder();
    const d = deliveryOf(o.id);
    expect(st().cancelOwnDelivery(d.id, { managerPin: '0000', reason: 'Cliente desistiu' }).ok).toBe(false);
    expect(st().cancelOwnDelivery(d.id, { managerPin: '9999', reason: 'Cliente desistiu' }).ok).toBe(true);
    expect(deliveryOf(o.id).status).toBe('CANCELED');
    expect(st().orders.find((x) => x.id === o.id)!.status).toBe('CANCELED');
  });

  it('PIN errado na sangria do acerto não recebe nenhuma conta; o acerto certo depois leva o dinheiro todo', () => {
    asCashier();
    expect(st().openCashSession(100).ok).toBe(true);
    const o = deliveryOrder();
    const d = deliveryOf(o.id);
    const courier = st().couriers[0]!;
    st().setOwnDeliveryStatus(d.id, 'READY');
    st().dispatchOwnDeliveries([d.id], courier.id);
    st().setOwnDeliveryStatus(d.id, 'DELIVERED');
    expect(st().settleCourier(courier.id, { payFromDrawer: true, auth: { managerPin: '0000', reason: 'Acerto do entregador' } }).ok).toBe(false);
    expect(st().orders.find((x) => x.id === o.id)!.status).toBe('PAYING');
    expect(st().payments.filter((p) => p.order_id === o.id)).toHaveLength(0);
    const s = st().settleCourier(courier.id, { payFromDrawer: true, auth: MANAGER });
    expect(s.ok && s.data.cash_collected).toBe(o.total_amount);
  });

  it('acerto que parou no meio: na nova tentativa o dinheiro já recebido continua no acerto', () => {
    asCashier();
    const o = deliveryOrder();
    const d = deliveryOf(o.id);
    const courier = st().couriers[0]!;
    st().setOwnDeliveryStatus(d.id, 'READY');
    st().dispatchOwnDeliveries([d.id], courier.id);
    st().setOwnDeliveryStatus(d.id, 'DELIVERED');
    // A senha foi recebida (chave da entrega) mas o acerto não foi gravado.
    const r = st().registerPayment({
      orderId: o.id, amount: o.remaining_balance, method: 'CASH', status: 'APPROVED', terminal_id: null, acquirer: 'CASH_DESK',
      acquirer_cnpj: null, card_brand: null, nsu: null, authorization_code: null, terminal_serial: null, idempotency_key: `entrega-${d.id}`, item_ids: [],
    });
    expect(r.ok).toBe(true);
    const s = st().settleCourier(courier.id, { payFromDrawer: false, auth: null });
    expect(s.ok && s.data.cash_collected).toBe(o.total_amount);
  });

  it('desfazer a senha no caixa tira a entrega do quadro; entrega já paga sai com PIN de gerente', () => {
    asCashier();
    const unpaid = deliveryOrder({ payOnDelivery: false });
    expect(st().voidPickupOrder(unpaid.id, MANAGER).ok).toBe(true);
    expect(deliveryOf(unpaid.id).status).toBe('CANCELED');
    expect(st().outbox.at(-1)).toMatchObject({ table: 'own_deliveries', op: 'UPDATE' });

    const paid = deliveryOrder({ payOnDelivery: false });
    st().registerPayment({
      orderId: paid.id, amount: paid.remaining_balance, method: 'PIX', status: 'APPROVED', terminal_id: null, acquirer: 'CASH_DESK',
      acquirer_cnpj: null, card_brand: null, nsu: null, authorization_code: null, terminal_serial: null, idempotency_key: 'pix-paid', item_ids: [],
    });
    const d = deliveryOf(paid.id);
    expect(st().cancelOwnDelivery(d.id, { managerPin: '0000', reason: 'Cliente desistiu' }).ok).toBe(false);
    expect(st().cancelOwnDelivery(d.id, { managerPin: '9999', reason: 'Cliente desistiu' }).ok).toBe(true);
    expect(deliveryOf(paid.id).status).toBe('CANCELED');
    expect(st().orders.find((x) => x.id === paid.id)!.status).toBe('CLOSED');
  });

  it('cadastro de bairro e entregador só para gerente', () => {
    asCashier();
    expect(st().saveDeliveryZone({ name: 'Camobi', fee: 10, eta_minutes: 50, active: true }).ok).toBe(false);
    expect(st().login('9999').ok).toBe(true);
    expect(st().saveDeliveryZone({ name: 'Camobi', fee: 10, eta_minutes: 50, active: true }).ok).toBe(true);
    expect(st().saveDeliveryZone({ name: 'camobi', fee: 10, eta_minutes: 50, active: true }).ok).toBe(false);
    expect(st().saveDeliveryZone({ name: 'Tancredo', fee: 500, eta_minutes: 50, active: true }).ok).toBe(false);
    const c = st().saveCourier({ name: 'Pedro', phone: '(55) 98888-7777', fee_per_delivery: 7, active: true });
    expect(c.ok && c.data.phone).toBe('55988887777');
  });

  it('migração da versão 8 cria as listas da entrega', () => {
    const out = migratePersisted({ orders: [] }, 8) as Record<string, unknown>;
    expect(out.deliveryZones).toEqual([]);
    expect(out.couriers).toEqual([]);
    expect(out.ownDeliveries).toEqual([]);
    expect(out.courierSettlements).toEqual([]);
  });
});
