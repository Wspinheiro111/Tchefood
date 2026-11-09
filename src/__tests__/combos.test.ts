import { beforeEach, describe, expect, it } from 'vitest';
import { useTcheStore } from '../store/useTcheStore';
import { seedId } from '../data/seed';
import { buildNfce } from '../lib/nfce';
import { conferenceLines } from '../lib/receipts';
import { validateModifierOption, validateProduct } from '../lib/catalog';
import type { PickupLine } from '../store/useTcheStore';
import type { OrderItem, SelectedModifier } from '../types';

const st = () => useTcheStore.getState();
const product = (code: string) => st().products.find((p) => p.code === code)!;
const table = (n: number) => st().tables.find((t) => t.number === n)!;
const MANAGER = { managerPin: '9999', reason: 'Teste automatizado' };

function pick(group: string, code: string): SelectedModifier {
  const opt = st().modifierOptions.find((o) => o.id === seedId(`mo:${group}:${code}`))!;
  return { group_id: opt.group_id, option_id: opt.id, name: opt.name, additional_price: opt.additional_price };
}

const CHOICES = () => [pick('combo-prato', '301'), pick('combo-bebida', '201'), pick('combo-sobremesa', '601')];

function openTable(n = 1) {
  expect(st().login('1111').ok).toBe(true);
  const r = st().openTable(table(n).id, 2, null);
  if (!r.ok) throw new Error(r.error);
  return r.data.id;
}

function addCombo(orderId: string, modifiers: SelectedModifier[], quantity = 1) {
  const p = product('501');
  return st().addToTray({
    order_id: orderId, product_id: p.id, half_product_ids: [], quantity, unit_price: p.price, modifiers,
    modifiers_unit_price: 0, meat_doneness: null, quick_tags: [], free_notes: '', sector: p.sector,
  });
}

function launchCombo(orderId: string, quantity = 1) {
  const r = addCombo(orderId, CHOICES(), quantity);
  if (!r.ok) throw new Error(r.error);
  const d = st().dispatchTray(orderId);
  if (!d.ok) throw new Error(d.error);
  return d.data.items;
}

beforeEach(() => st().resetDemo());

describe('combo na mesa', () => {
  it('o combo leva o preço e cada escolha vai para a praça dela com preço zero', () => {
    const orderId = openTable();
    const tapBefore = st().kegTaps.find((k) => k.tap_number === 1)!.billed_volume_ml;
    const items = launchCombo(orderId);
    expect(items).toHaveLength(4);
    const [parent, ...children] = items as [OrderItem, ...OrderItem[]];
    expect(parent.product_id).toBe(product('501').id);
    expect(parent.sector).toBe('NONE');
    expect(parent.status).toBe('DELIVERED');
    expect(parent.total_item_price).toBe(67.9); // 64,90 + chopp 3,00
    expect(parent.combo_parent_item_id).toBeNull();
    expect(children.map((c) => [product('301').id, product('201').id, product('601').id].indexOf(c.product_id))).toEqual([0, 1, 2]);
    expect(children.map((c) => c.sector)).toEqual(['KITCHEN', 'BAR', 'DESSERT']);
    for (const c of children) {
      expect(c.total_item_price).toBe(0);
      expect(c.unit_price).toBe(0);
      expect(c.combo_parent_item_id).toBe(parent.id);
      expect(c.status).toBe('PENDING');
      expect(c.notes).toContain('Combo Combo Campeiro');
    }
    expect(st().orders.find((o) => o.id === orderId)!.subtotal_items).toBe(67.9);
    // O chopp do combo baixa o barril.
    expect(children[1]!.keg_volume_ml).toBeGreaterThan(0);
    expect(st().kegTaps.find((k) => k.tap_number === 1)!.billed_volume_ml).toBe(tapBefore + children[1]!.keg_volume_ml!);
    // Os 4 itens sobem para a nuvem.
    const inserts = st().outbox.filter((e) => e.table === 'order_items' && e.op === 'INSERT');
    expect(inserts.map((e) => e.row_id)).toEqual(items.map((i) => i.id));
  });

  it('duas unidades do combo: cada componente sai em dobro', () => {
    const orderId = openTable();
    const [parent, ...children] = launchCombo(orderId, 2) as [OrderItem, ...OrderItem[]];
    expect(parent.total_item_price).toBe(135.8);
    expect(children.map((c) => c.quantity)).toEqual([2, 2, 2]);
  });

  it('sem escolher a bebida o combo não entra na bandeja', () => {
    const orderId = openTable();
    const r = addCombo(orderId, [pick('combo-prato', '301'), pick('combo-sobremesa', '601')]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('Bebida do combo');
  });

  it('componente em falta barra o combo', () => {
    const orderId = openTable();
    useTcheStore.setState((s) => ({ products: s.products.map((p) => (p.code === '601' ? { ...p, available: false } : p)) }));
    const r = addCombo(orderId, CHOICES());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('Sagu com Creme está em falta');
  });

  it('componente não se cancela sozinho; cancelar o combo cancela tudo e devolve o chopp', () => {
    const orderId = openTable();
    const tapBefore = st().kegTaps.find((k) => k.tap_number === 1)!.billed_volume_ml;
    const [parent, ...children] = launchCombo(orderId) as [OrderItem, ...OrderItem[]];
    const child = st().cancelOrderItem(children[0]!.id, MANAGER);
    expect(child.ok).toBe(false);
    if (!child.ok) expect(child.error).toContain('Cancele o combo inteiro');

    const before = st().outbox.length;
    const r = st().cancelOrderItem(parent.id, MANAGER);
    if (!r.ok) throw new Error(r.error);
    const all = st().orderItems.filter((i) => i.order_id === orderId);
    expect(all.every((i) => i.status === 'CANCELED')).toBe(true);
    expect(st().orders.find((o) => o.id === orderId)!.total_amount).toBe(0);
    expect(st().kegTaps.find((k) => k.tap_number === 1)!.billed_volume_ml).toBe(tapBefore);
    // Um audit_log por item cancelado: o banco confere cada cancelamento.
    const logs = st().auditLogs.filter((l) => l.order_id === orderId && l.action_type === 'ITEM_CANCELED');
    expect(logs).toHaveLength(4);
    expect(logs.map((l) => l.amount_impact).sort((a, b) => a - b)).toEqual([-74.69, 0, 0, 0]) // combo + 10%;
    const authEvents = st().outbox.slice(before).filter((e) => e.table === 'audit_logs');
    expect(authEvents).toHaveLength(4);
    expect(authEvents.every((e) => e.manager_pin === '9999')).toBe(true);
  });

  it('NFC-e e cupom: o combo é a linha com preço, os componentes aparecem embaixo sem valor', () => {
    const orderId = openTable();
    launchCombo(orderId);
    const order = st().orders.find((o) => o.id === orderId)!;
    const lines = conferenceLines({
      tenant: st().tenant, table: table(1), order, items: st().orderItems, products: st().products, waiter: null,
    }).join('\n');
    expect(lines).toContain('Combo Campeiro');
    expect(lines).toContain('Arroz Carreteiro');
    expect(lines).toContain('Chopp Pilsen');

    const r = st().registerPayment({
      orderId, amount: order.remaining_balance, method: 'CASH', status: 'APPROVED', terminal_id: null, acquirer: 'CASH_DESK',
      acquirer_cnpj: null, card_brand: null, nsu: null, authorization_code: null, terminal_serial: null, idempotency_key: 'combo-pay', item_ids: [],
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.data.closed).toBe(true);
    const closed = st().orders.find((o) => o.id === orderId)!;
    const doc = buildNfce({
      tenant: st().tenant, order: closed, items: st().orderItems, payments: st().payments, products: st().products, tableLabel: 'Mesa 1',
    });
    expect(doc).not.toBeNull();
    expect(doc!.payload.items).toHaveLength(1);
    expect(doc!.payload.items[0]!.descricao).toBe('COMBO CAMPEIRO');
  });
});

describe('combo no balcão e no totem', () => {
  it('ficha rápida: uma ficha por componente, nenhuma para o combo', () => {
    expect(st().login('5555').ok).toBe(true);
    const r = st().createCounterSale([{ product_id: product('501').id, quantity: 1, modifiers: CHOICES(), meat_doneness: null }]);
    if (!r.ok) throw new Error(r.error);
    const order = r.data;
    expect(order.total_amount).toBe(67.9);
    const pay = st().registerPayment({
      orderId: order.id, amount: 67.9, method: 'CASH', status: 'APPROVED', terminal_id: null, acquirer: 'CASH_DESK',
      acquirer_cnpj: null, card_brand: null, nsu: null, authorization_code: null, terminal_serial: null, idempotency_key: 'combo-ficha', item_ids: [],
    });
    if (!pay.ok) throw new Error(pay.error);
    const t = st().issueEventTickets(order.id);
    if (!t.ok) throw new Error(t.error);
    const ticketProducts = t.data.map((x) => st().orderItems.find((i) => i.id === x.order_item_id)!.product_id);
    expect(ticketProducts.sort()).toEqual([product('301').id, product('201').id, product('601').id].sort());
  });

  it('totem: o combo se abre nos componentes', () => {
    expect(st().login('4444').ok).toBe(true);
    const line: PickupLine = {
      product_id: product('501').id, quantity: 1, modifiers: CHOICES(), meat_doneness: null, half_product_ids: [], quick_tags: [], free_notes: '',
    };
    const r = st().createPickupOrder({ lines: [line], fulfillment: 'TAKEOUT', customerName: 'Ana' });
    if (!r.ok) throw new Error(r.error);
    const items = st().orderItems.filter((i) => i.order_id === r.data.id);
    expect(items).toHaveLength(4);
    expect(items.filter((i) => i.combo_parent_item_id).every((i) => i.total_item_price === 0)).toBe(true);
    expect(r.data.total_amount).toBe(67.9);
  });
});

describe('cadastro de combo', () => {
  it('combo não é vendido por peso nem meio a meio', () => {
    const p = product('501');
    expect(validateProduct({ ...p, sold_by_weight: true }, st().products, st().categories)).toMatchObject({ ok: false });
    expect(validateProduct({ ...p, allows_half_and_half: true }, st().products, st().categories)).toMatchObject({ ok: false });
  });

  it('opção de combo não aponta para outro combo nem quantidade fora de 1 a 20', () => {
    const base = st().modifierOptions.find((o) => o.id === seedId('mo:combo-prato:301'))!;
    const args = [st().modifierGroups, st().modifierOptions, st().products] as const;
    expect(validateModifierOption(base, ...args)).toEqual({ ok: true });
    expect(validateModifierOption({ ...base, component_product_id: product('501').id }, ...args)).toMatchObject({ ok: false });
    expect(validateModifierOption({ ...base, component_quantity: 0 }, ...args)).toMatchObject({ ok: false });
    expect(validateModifierOption({ ...base, component_quantity: 21 }, ...args)).toMatchObject({ ok: false });
    expect(validateModifierOption({ ...base, component_quantity: 1.5 }, ...args)).toMatchObject({ ok: false });
  });
});
