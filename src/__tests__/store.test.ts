import { beforeEach, describe, expect, it } from 'vitest';
import { useTcheStore } from '../store/useTcheStore';
import { computeOrderTotals, computeItemsShare, round2 } from '../lib/money';
import { buildNfce } from '../lib/nfce';

const st = () => useTcheStore.getState();
const product = (code: string) => st().products.find((p) => p.code === code)!;
const table = (n: number) => st().tables.find((t) => t.number === n)!;

function openFreshTable(n = 1) {
  expect(st().login('1111').ok).toBe(true);
  const r = st().openTable(table(n).id, 2, null);
  if (!r.ok) throw new Error(r.error);
  return r.data.id;
}

function launch(orderId: string, code: string, qty = 1, extra: Partial<Parameters<ReturnType<typeof st>['addToTray']>[0]> = {}) {
  const p = product(code);
  const r = st().addToTray({
    order_id: orderId,
    product_id: p.id,
    half_product_ids: [],
    quantity: qty,
    unit_price: p.price,
    modifiers: [],
    modifiers_unit_price: 0,
    meat_doneness: p.requires_meat_doneness ? 'Ao Ponto' : null,
    quick_tags: [],
    free_notes: '',
    sector: p.sector,
    ...extra,
  });
  if (!r.ok) throw new Error(r.error);
}

beforeEach(() => st().resetDemo());

describe('seed', () => {
  it('totais do seed batem com o recálculo', () => {
    for (const o of st().orders) {
      expect(computeOrderTotals(o, st().orderItems, st().payments)).toMatchObject({
        subtotal_items: o.subtotal_items,
        total_amount: o.total_amount,
        remaining_balance: o.remaining_balance,
      });
    }
  });
});

describe('fase 1 — comanda e anti-fraude', () => {
  it('despacho recalcula subtotal, 10% e total', () => {
    const id = openFreshTable();
    launch(id, '101');
    launch(id, '201', 2, {
      modifiers: [{ group_id: st().modifierGroups.find((g) => g.name === 'Tamanho do Chopp')!.id, option_id: st().modifierOptions.find((o) => o.name === '500 ml')!.id, name: '500 ml', additional_price: 6 }],
    });
    expect(st().dispatchTray(id).ok).toBe(true);
    const o = st().orders.find((x) => x.id === id)!;
    expect(o.subtotal_items).toBe(round2(119.9 + 2 * 18.9));
    expect(o.service_fee_amount).toBe(15.77);
    expect(o.total_amount).toBe(173.47);
    expect(st().tray).toHaveLength(0);
  });

  it('ponto da carne é obrigatório e grupo obrigatório é validado', () => {
    const id = openFreshTable();
    expect(() => launch(id, '101', 1, { meat_doneness: null })).toThrow(/Ponto/);
    expect(() => launch(id, '201')).toThrow(/Tamanho/);
  });

  it('cancelar item exige PIN de gerente + motivo e grava audit_log', () => {
    const id = openFreshTable();
    launch(id, '311');
    st().dispatchTray(id);
    const item = st().orderItems.find((i) => i.order_id === id)!;
    expect(st().cancelOrderItem(item.id, { managerPin: '1111', reason: 'Cliente desistiu' }).ok).toBe(false);
    expect(st().cancelOrderItem(item.id, { managerPin: '9999', reason: 'abc' }).ok).toBe(false);
    const r = st().cancelOrderItem(item.id, { managerPin: '9999', reason: 'Cliente desistiu' });
    expect(r.ok).toBe(true);
    const after = st().orderItems.find((i) => i.id === item.id)!;
    expect(after.status).toBe('CANCELED');
    expect(st().orderItems.some((i) => i.id === item.id)).toBe(true); // nunca DELETE
    expect(st().orders.find((o) => o.id === id)!.total_amount).toBe(0);
    const log = st().auditLogs.find((l) => l.action_type === 'ITEM_CANCELED')!;
    expect(log.amount_impact).toBe(-32.89);
    expect(st().auditLogs.some((l) => l.action_type === 'MANAGER_PIN_FAILED')).toBe(true);
  });

  it('bloqueia PIN de gerente após 3 erros', () => {
    const id = openFreshTable();
    for (let i = 0; i < 3; i++) st().removeServiceFee(id, { managerPin: '0000', reason: 'Teste de fraude' });
    expect(st().auditLogs[0]!.action_type).toBe('MANAGER_PIN_LOCKOUT');
    const r = st().removeServiceFee(id, { managerPin: '9999', reason: 'Agora correto' });
    expect(r.ok).toBe(false);
  });

  it('remover 10% e desconto com PIN', () => {
    const id = openFreshTable();
    launch(id, '102');
    st().dispatchTray(id);
    expect(st().removeServiceFee(id, { managerPin: '9999', reason: 'Cliente reclamou' }).ok).toBe(true);
    expect(st().orders.find((o) => o.id === id)!.total_amount).toBe(89.9);
    expect(st().applyDiscount(id, 9.9, { managerPin: '9999', reason: 'Cortesia da casa' }).ok).toBe(true);
    expect(st().orders.find((o) => o.id === id)!.total_amount).toBe(80);
  });
});

describe('fase 2 — rachadinha e fechamento', () => {
  it('por item consumido marca is_paid e soma 10% proporcional', () => {
    const id = openFreshTable();
    launch(id, '101');
    launch(id, '311');
    st().dispatchTray(id);
    st().startCheckout(id);
    const order = st().orders.find((o) => o.id === id)!;
    const picanha = st().orderItems.find((i) => i.order_id === id && i.product_id === product('101').id)!;
    const share = computeItemsShare(order, [picanha], st().orderItems);
    expect(share.share).toBe(131.89);
    const r = st().registerPayment({
      orderId: id, amount: share.share, method: 'CREDIT', status: 'APPROVED', terminal_id: null, acquirer: 'STONE',
      acquirer_cnpj: '16501555000157', card_brand: 'VISA', nsu: '123456', authorization_code: 'ABC123', terminal_serial: 'STONE-01',
      idempotency_key: 'k1', item_ids: [picanha.id],
    });
    expect(r.ok && r.data.closed).toBe(false);
    expect(st().orderItems.find((i) => i.id === picanha.id)!.is_paid).toBe(true);
    const o2 = st().orders.find((o) => o.id === id)!;
    expect(o2.remaining_balance).toBe(32.89);
    expect(table(1).status).toBe('PAYING');
    // segundo pagamento zera e fecha
    const r2 = st().registerPayment({
      orderId: id, amount: 32.89, method: 'PIX', status: 'APPROVED', terminal_id: null, acquirer: 'PAGBANK',
      acquirer_cnpj: '08561701000101', card_brand: 'PIX', nsu: '654321', authorization_code: 'PIX999', terminal_serial: 'PAGBANK-01',
      idempotency_key: 'k2', item_ids: [],
    });
    expect(r2.ok && r2.data.closed).toBe(true);
    const closed = st().orders.find((o) => o.id === id)!;
    expect(closed.status).toBe('CLOSED');
    expect(closed.nfce_key).toHaveLength(44);
    expect(table(1).status).toBe('FREE');

    const doc = buildNfce({ tenant: st().tenant, order: closed, items: st().orderItems, payments: st().payments, products: st().products, tableLabel: 'Mesa 1' })!;
    const sumPag = doc.payload.formas_pagamento.reduce((a, p) => a + Math.round(p.valor_pagamento * 100), 0);
    expect(sumPag).toBe(Math.round(doc.payload.valor_total * 100));
    const sumItems = doc.payload.items.reduce((a, i) => a + Math.round((i.valor_bruto + (i.valor_outras_despesas ?? 0) - (i.valor_desconto ?? 0)) * 100), 0);
    expect(sumItems).toBe(Math.round(doc.payload.valor_total * 100));
    expect(doc.payload.formas_pagamento[0]).toMatchObject({ forma_pagamento: '03', tipo_integracao: 1, bandeira_operadora: '01', numero_autorizacao: 'ABC123' });
    expect(doc.payload.formas_pagamento[1]).toMatchObject({ forma_pagamento: '17', bandeira_operadora: '99' });
  });

  it('não aceita pagamento acima do saldo nem idempotency duplicada', () => {
    const id = openFreshTable();
    launch(id, '311');
    st().dispatchTray(id);
    const base = { orderId: id, method: 'CASH' as const, status: 'APPROVED' as const, terminal_id: null, acquirer: 'CASH_DESK' as const, acquirer_cnpj: null, card_brand: null, nsu: null, authorization_code: null, terminal_serial: null, item_ids: [] };
    expect(st().registerPayment({ ...base, amount: 999, idempotency_key: 'x' }).ok).toBe(false);
    expect(st().registerPayment({ ...base, amount: 10, idempotency_key: 'y' }).ok).toBe(true);
    expect(st().registerPayment({ ...base, amount: 10, idempotency_key: 'y' }).ok).toBe(false);
  });
});

describe('fase 3 — KDS e QR Code', () => {
  it('QR Code abre mesa, grava origin QRCODE_TABLE e pede a conta', () => {
    const t = table(4);
    const p = product('311');
    const r = st().qrPlaceOrder(t.id, [{ product_id: p.id, half_product_ids: [], quantity: 1, unit_price: p.price, modifiers: [], modifiers_unit_price: 0, meat_doneness: null, quick_tags: [], free_notes: '', sector: p.sector }]);
    expect(r.ok).toBe(true);
    const item = st().orderItems.find((i) => i.origin === 'QRCODE_TABLE')!;
    expect(item).toBeTruthy();
    expect(table(4).status).toBe('OCCUPIED');
    expect(st().advanceItemStatus(item.id).ok && st().orderItems.find((i) => i.id === item.id)!.status).toBe('PREPARING');
    st().advanceItemStatus(item.id);
    expect(st().orderItems.find((i) => i.id === item.id)!.prepared_at).not.toBeNull();
    expect(st().qrRequestBill(t.id).ok).toBe(true);
    expect(table(4).status).toBe('WAITING_BILL');
  });
});
