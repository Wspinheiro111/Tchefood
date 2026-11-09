import { beforeEach, describe, expect, it } from 'vitest';
import { migrateToKiosk, useTcheStore, type PickupLine } from '../store/useTcheStore';
import { brasiliaDate, formatPickupNumber, kioskStage, nextPickupNumber, pickupReceipt, sanitizePickupName } from '../lib/kiosk';
import { buildBoard, pickupBoardEntries } from '../lib/orderBoard';
import { chargePickupOrder } from '../lib/pickupCharge';
import { KIOSK_TABLE_ID } from '../data/seed';
import { clearReviewHold, setReviewHold } from '../lib/payments/reviewHolds';
import type { Order } from '../types';

const st = () => useTcheStore.getState();
const product = (code: string) => st().products.find((p) => p.code === code)!;
const MANAGER = { managerPin: '9999', reason: 'Teste automatizado' };

function line(code: string, quantity = 1, extra: Partial<PickupLine> = {}): PickupLine {
  return { product_id: product(code).id, quantity, modifiers: [], meat_doneness: null, half_product_ids: [], quick_tags: [], free_notes: '', ...extra };
}

function kioskOrder(lines: PickupLine[] = [line('301'), line('222', 2)], name: string | null = 'Ana Paula') {
  expect(st().login('4444').ok).toBe(true);
  const r = st().createPickupOrder({ lines, fulfillment: 'TAKEOUT', customerName: name });
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

function payCash(orderId: string) {
  const o = st().orders.find((x) => x.id === orderId)!;
  const r = st().registerPayment({
    orderId, amount: o.remaining_balance, method: 'CASH', status: 'APPROVED', terminal_id: null, acquirer: 'CASH_DESK',
    acquirer_cnpj: null, card_brand: null, nsu: null, authorization_code: null, terminal_serial: null, idempotency_key: `k-${Math.random()}`, item_ids: [],
  });
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

const board = () => buildBoard(pickupBoardEntries(st().orders, st().orderItems, st().tables));

beforeEach(() => st().resetDemo());

describe('senha do dia', () => {
  const at = (iso: string, n: number) => ({ opened_at: iso, pickup_number: n }) as Order;

  it('conta 1, 2, 3 e reinicia à meia-noite de Brasília (não do UTC)', () => {
    expect(nextPickupNumber([])).toBe(1);
    const orders = [at('2026-11-09T12:00:00Z', 1), at('2026-11-09T12:05:00Z', 2)];
    expect(nextPickupNumber(orders, new Date('2026-11-09T13:00:00Z'))).toBe(3);
    // 02:30 UTC do dia 10 ainda é 23:30 do dia 9 em Brasília.
    expect(brasiliaDate('2026-11-10T02:30:00Z')).toBe('2026-11-09');
    expect(nextPickupNumber(orders, new Date('2026-11-10T02:30:00Z'))).toBe(3);
    expect(nextPickupNumber(orders, new Date('2026-11-10T03:30:00Z'))).toBe(1);
  });

  it('depois do 999 volta para 1 e segue a mais recente', () => {
    const orders = [at('2026-11-09T12:00:00Z', 999)];
    expect(nextPickupNumber(orders, new Date('2026-11-09T13:00:00Z'))).toBe(1);
    expect(nextPickupNumber([...orders, at('2026-11-09T12:10:00Z', 1)], new Date('2026-11-09T13:00:00Z'))).toBe(2);
    expect(formatPickupNumber(7)).toBe('007');
  });

  it('nome só com letras, até 20 caracteres', () => {
    expect(sanitizePickupName('  João  da   Silva ')).toBe('João da Silva');
    expect(sanitizePickupName('Zé<script>123')).toBe('Zéscript');
    expect(sanitizePickupName('1234')).toBeNull();
    expect(sanitizePickupName('Maximiliano Bartolomeu Silva')!.length).toBeLessThanOrEqual(20);
  });
});

describe('pedido com senha no totem', () => {
  it('nasce aguardando pagamento, sem 10%, com senha, nome e preço do cadastro', () => {
    const o = kioskOrder();
    expect(o.table_id).toBe(KIOSK_TABLE_ID);
    expect(o.status).toBe('PAYING');
    expect(o.charge_service_fee).toBe(false);
    expect(o.service_fee_amount).toBe(0);
    expect(o.pickup_number).toBe(1);
    expect(o.pickup_name).toBe('Ana Paula');
    expect(o.fulfillment_type).toBe('TAKEOUT');
    expect(o.total_amount).toBe(58.7);
    const items = st().orderItems.filter((i) => i.order_id === o.id);
    expect(items.every((i) => i.origin === 'KIOSK' && i.status === 'PENDING' && !i.is_paid)).toBe(true);
    expect(kioskOrder().pickup_number).toBe(2);
  });

  it('não confia no preço do aparelho e valida ponto, adicionais e buffet', () => {
    expect(st().login('4444').ok).toBe(true);
    const create = (lines: PickupLine[]) => st().createPickupOrder({ lines, fulfillment: 'DINE_IN', customerName: null });
    expect(create([line('101')]).ok).toBe(false); // picanha sem ponto
    expect(create([line('901')]).ok).toBe(false); // buffet a quilo
    expect(create([line('107')]).ok).toBe(false); // em falta
    expect(create([line('301', 1.5)]).ok).toBe(false);
    expect(create([]).ok).toBe(false);
    const fake = { group_id: 'x', option_id: 'y', name: 'Grátis', additional_price: -50 };
    expect(create([line('301', 1, { modifiers: [fake] })]).ok).toBe(false);
    const r = create([line('101', 1, { meat_doneness: 'Ao Ponto', free_notes: 'sem sal' })]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const item = st().orderItems.find((i) => i.order_id === r.data.id)!;
    expect(item.unit_price).toBe(119.9);
    expect(item.notes).toContain('sem sal');
  });

  it('perfil de cozinha não lança pedido com senha', () => {
    expect(st().login('7777').ok).toBe(true);
    expect(st().createPickupOrder({ lines: [line('301')], fulfillment: 'DINE_IN', customerName: null }).ok).toBe(false);
  });

  it('só vai para a cozinha e para o painel depois de pago; sai do painel quando entregue', () => {
    const o = kioskOrder();
    expect(kioskStage(st().orders.find((x) => x.id === o.id)!, st().orderItems)).toBe('AWAITING_PAYMENT');
    expect(board().preparing).toHaveLength(0);

    const paid = payCash(o.id);
    expect(paid.closed).toBe(true);
    const order = st().orders.find((x) => x.id === o.id)!;
    expect(order.status).toBe('CLOSED');
    expect(order.nfce_status).toBe('AUTORIZADA');
    expect(kioskStage(order, st().orderItems)).toBe('PREPARING');
    expect(board().preparing.map((e) => e.number)).toEqual(['001']);
    expect(board().preparing[0]!.subtitle).toBe('Ana');

    const ids = st().orderItems.filter((i) => i.order_id === o.id).map((i) => i.id);
    st().advanceItems(ids);
    st().advanceItems(ids);
    expect(kioskStage(st().orders.find((x) => x.id === o.id)!, st().orderItems)).toBe('READY');
    expect(board().ready.map((e) => e.number)).toEqual(['001']);
    expect(board().preparing).toHaveLength(0);

    st().advanceItems(ids);
    expect(kioskStage(st().orders.find((x) => x.id === o.id)!, st().orderItems)).toBe('DELIVERED');
    expect(board().ready).toHaveLength(0);
  });

  it('pagar no caixa: a atendente recebe a senha do totem em dinheiro', async () => {
    const o = kioskOrder();
    st().logout();
    expect(st().login('5555').ok).toBe(true);
    const r = await chargePickupOrder({ orderId: o.id, method: 'CASH', chassis: 'STONE', cashGiven: 100, kitchenPreview: false });
    expect(r).toEqual({ status: 'APPROVED', change: 41.3 });
    const pay = st().payments.find((p) => p.order_id === o.id)!;
    expect(pay.waiter_id).toBe(st().staff.find((u) => u.pin_code === '5555')!.id);
    expect(st().orders.find((x) => x.id === o.id)!.status).toBe('CLOSED');
    expect((await chargePickupOrder({ orderId: o.id, method: 'CASH', chassis: 'STONE' })).status).toBe('ERROR');
  });

  it('cobrança incerta na maquininha trava também o dinheiro até conferir o extrato', async () => {
    const o = kioskOrder();
    setReviewHold({ order_id: o.id, amount: o.remaining_balance, reason: 'Sem NSU', code: 'NO_NSU' });
    try {
      st().logout();
      expect(st().login('5555').ok).toBe(true);
      const r = await chargePickupOrder({ orderId: o.id, method: 'CASH', chassis: 'STONE', cashGiven: 100 });
      expect(r.status).toBe('MANUAL_REVIEW');
      expect(st().payments.some((p) => p.order_id === o.id)).toBe(false);
      expect(st().orders.find((x) => x.id === o.id)!.status).toBe('PAYING');
      clearReviewHold(o.id);
      expect((await chargePickupOrder({ orderId: o.id, method: 'CASH', chassis: 'STONE' })).status).toBe('APPROVED');
    } finally {
      clearReviewHold(o.id);
    }
  });

  it('dinheiro a menos que o total é recusado', async () => {
    const o = kioskOrder();
    const r = await chargePickupOrder({ orderId: o.id, method: 'CASH', chassis: 'STONE', cashGiven: 10 });
    expect(r.status).toBe('ERROR');
    expect(st().orders.find((x) => x.id === o.id)!.status).toBe('PAYING');
  });

  it('cancelar senha sem pagamento exige gerente e não serve para ficha de balcão', () => {
    const o = kioskOrder();
    st().logout();
    expect(st().login('5555').ok).toBe(true);
    expect(st().voidPickupOrder(o.id, { managerPin: '0000', reason: 'Cliente desistiu' }).ok).toBe(false);
    expect(st().voidCounterSale(o.id, MANAGER).ok).toBe(false);
    const r = st().voidPickupOrder(o.id, MANAGER);
    expect(r.ok).toBe(true);
    expect(st().orders.find((x) => x.id === o.id)!.status).toBe('CANCELED');
    const logs = st().auditLogs.filter((l) => l.order_id === o.id && l.action_type === 'ITEM_CANCELED');
    expect(logs).toHaveLength(2);
    expect(logs.every((l) => l.metadata?.kiosk_order_voided === true && l.authorized_by_manager_id)).toBe(true);

    const counter = st().createCounterSale([{ product_id: product('222').id, quantity: 1, modifiers: [], meat_doneness: null }]);
    if (!counter.ok) throw new Error(counter.error);
    expect(st().voidPickupOrder(counter.data.id, MANAGER).ok).toBe(false);
    expect(st().voidCounterSale(counter.data.id, MANAGER).ok).toBe(true);
  });

  it('senha com cobrança incerta não pode ser cancelada antes da conferência', () => {
    const o = kioskOrder();
    setReviewHold({ order_id: o.id, amount: o.remaining_balance, reason: 'Sem NSU', code: 'NO_NSU' });
    try {
      st().logout();
      expect(st().login('5555').ok).toBe(true);
      expect(st().voidPickupOrder(o.id, MANAGER).ok).toBe(false);
      expect(st().orders.find((x) => x.id === o.id)!.status).toBe('PAYING');
    } finally {
      clearReviewHold(o.id);
    }
    expect(st().voidPickupOrder(o.id, MANAGER).ok).toBe(true);
  });

  it('senha paga não pode ser cancelada pelo caixa', () => {
    const o = kioskOrder();
    payCash(o.id);
    expect(st().voidPickupOrder(o.id, MANAGER).ok).toBe(false);
  });

  it('comprovante da senha diz se está pago', () => {
    const o = kioskOrder();
    const receipt = () =>
      pickupReceipt({ tenant: st().tenant, order: st().orders.find((x) => x.id === o.id)!, items: st().orderItems, productName: (id) => st().products.find((p) => p.id === id)!.name });
    expect(receipt().headline).toBe('001');
    expect(receipt().lines).toContain('PAGUE NO CAIXA · SENHA');
    payCash(o.id);
    expect(receipt().lines).toContain('SUA SENHA');
    expect(receipt().lines).toContain('PAGO');
  });
});

describe('modo totem', () => {
  it('sair do totem exige PIN de gerente e fica no audit_log', () => {
    expect(st().login('4444').ok).toBe(true);
    expect(st().exitKioskMode({ managerPin: '1111', reason: 'Fim do expediente' }).ok).toBe(false);
    expect(st().currentUserId).not.toBeNull();
    expect(st().exitKioskMode(MANAGER).ok).toBe(true);
    expect(st().currentUserId).toBeNull();
    expect(st().auditLogs[0]!.action_type).toBe('KIOSK_EXIT');
    expect(st().outbox.at(-1)).toMatchObject({ table: 'audit_logs', row_id: st().auditLogs[0]!.id, manager_pin: MANAGER.managerPin });
  });

  it('só o aparelho do totem usa a saída do totem', () => {
    expect(st().login('5555').ok).toBe(true);
    expect(st().exitKioskMode(MANAGER).ok).toBe(false);
  });

  it('migração v2 → v3 mantém o movimento e cria a mesa e o usuário do totem', () => {
    const s = st();
    const legacyOrders = s.orders.map(({ pickup_number: _a, pickup_name: _b, fulfillment_type: _c, ...rest }) => rest) as unknown as Order[];
    const migrated = migrateToKiosk({ ...s, orders: legacyOrders, tables: s.tables.filter((t) => t.kind !== 'KIOSK'), staff: s.staff.filter((u) => u.role !== 'KIOSK') });
    expect(migrated.orders).toHaveLength(s.orders.length);
    expect(migrated.orders!.every((o) => o.pickup_number === null && o.fulfillment_type === null)).toBe(true);
    expect(migrated.tables!.filter((t) => t.kind === 'KIOSK')).toHaveLength(1);
    expect(migrated.staff!.some((u) => u.role === 'KIOSK')).toBe(true);
    // Rodar de novo não duplica.
    const again = migrateToKiosk(migrated);
    expect(again.tables!.filter((t) => t.kind === 'KIOSK')).toHaveLength(1);
    expect(again.staff!.filter((u) => u.role === 'KIOSK')).toHaveLength(1);
  });
});
