import { beforeEach, describe, expect, it } from 'vitest';
import { useTcheStore } from '../store/useTcheStore';
import { MAX_CARDS_PER_BATCH, validateCardRange, validateTable } from '../lib/catalog';

const st = () => useTcheStore.getState();
const asOwner = () => expect(st().login('8888').ok).toBe(true);
const asWaiter = () => expect(st().login('1111').ok).toBe(true);
const cards = () => st().tables.filter((t) => t.kind === 'CARD');

function launchAndPay(orderId: string) {
  const p = st().products.find((x) => x.code === '311')!;
  st().addToTray({ order_id: orderId, product_id: p.id, half_product_ids: [], quantity: 1, unit_price: p.price, modifiers: [], modifiers_unit_price: 0, meat_doneness: null, quick_tags: [], free_notes: '', sector: p.sector });
  expect(st().dispatchTray(orderId).ok).toBe(true);
  expect(st().login('5555').ok).toBe(true);
  expect(st().startCheckout(orderId).ok).toBe(true);
  const total = st().orders.find((o) => o.id === orderId)!.remaining_balance;
  const r = st().registerPayment({ orderId, amount: total, method: 'CASH', status: 'APPROVED', terminal_id: null, acquirer: 'CASH_DESK', acquirer_cnpj: null, card_brand: null, nsu: null, authorization_code: null, terminal_serial: null, idempotency_key: `cash-${orderId}`, item_ids: [] });
  if (!r.ok) throw new Error(r.error);
}

beforeEach(() => st().resetDemo());

describe('cartão de comanda — faixa de números', () => {
  it('valida a faixa', () => {
    expect(validateCardRange(1, 100).ok).toBe(true);
    expect(validateCardRange(0, 10).ok).toBe(false);
    expect(validateCardRange(10, 5).ok).toBe(false);
    expect(validateCardRange(1, MAX_CARDS_PER_BATCH + 1).ok).toBe(false);
    expect(validateCardRange(1.5, 3).ok).toBe(false);
  });

  it('a numeração dos cartões não bate com a das mesas', () => {
    asOwner();
    expect(st().createCards(1, 3).ok).toBe(true);
    const mesa1 = st().tables.find((t) => t.kind === 'TABLE' && t.number === 1)!;
    // Editar a Mesa 1 continua valendo com o Cartão 1 cadastrado.
    expect(validateTable({ ...mesa1 }, st().tables).ok).toBe(true);
  });
});

describe('cartão de comanda — loja', () => {
  it('só quem cuida do salão cadastra; números repetidos são pulados', () => {
    asWaiter();
    expect(st().createCards(1, 5).ok).toBe(false);
    asOwner();
    const first = st().createCards(1, 5);
    expect(first.ok && first.data.map((c) => c.label)).toEqual(['Cartão 1', 'Cartão 2', 'Cartão 3', 'Cartão 4', 'Cartão 5']);
    const again = st().createCards(4, 7);
    expect(again.ok && again.data.map((c) => c.number)).toEqual([6, 7]);
    expect(st().createCards(1, 7).ok).toBe(false);
    expect(cards()).toHaveLength(7);
    expect(cards().every((c) => c.qr_code_token === null && c.area === 'Cartões' && c.capacity === 1)).toBe(true);
    expect(st().outbox.filter((e) => e.table === 'dining_tables' && (e.payload as { kind?: string }).kind === 'CARD')).toHaveLength(7);
  });

  it('abre pelo número, reabre a mesma conta e volta livre depois de paga', () => {
    asOwner();
    st().createCards(1, 10);
    asWaiter();
    expect(st().openCard(99).ok).toBe(false);
    const opened = st().openCard(7);
    if (!opened.ok) throw new Error(opened.error);
    const card = cards().find((c) => c.number === 7)!;
    expect(card.status).toBe('OCCUPIED');
    expect(opened.data.table_id).toBe(card.id);
    expect(opened.data.customer_count).toBe(1);
    // Segunda vez no mesmo cartão: a conta que já está aberta, sem abrir outra.
    const again = st().openCard(7);
    expect(again.ok && again.data.id).toBe(opened.data.id);
    expect(st().orders.filter((o) => o.table_id === card.id)).toHaveLength(1);

    launchAndPay(opened.data.id);
    expect(st().orders.find((o) => o.id === opened.data.id)!.status).toBe('CLOSED');
    const after = cards().find((c) => c.number === 7)!;
    expect(after.status).toBe('FREE');
    expect(after.current_order_id).toBeNull();
    // Cartão livre de novo: abre uma conta nova.
    asWaiter();
    const next = st().openCard(7);
    expect(next.ok && next.data.id).not.toBe(opened.data.id);
  });

  it('cartão perdido é desativado (só livre) e não abre conta', () => {
    asOwner();
    st().createCards(1, 2);
    const c1 = cards().find((c) => c.number === 1)!;
    expect(st().openCard(1).ok).toBe(true);
    expect(st().setCardActive(c1.id, false).ok).toBe(false);
    const c2 = cards().find((c) => c.number === 2)!;
    expect(st().setCardActive(c2.id, false).ok).toBe(true);
    expect(st().openCard(2).ok).toBe(false);
    expect(st().setCardActive(c2.id, true).ok).toBe(true);
    expect(st().openCard(2).ok).toBe(true);
    asWaiter();
    expect(st().setCardActive(c2.id, false).ok).toBe(false);
  });
});
