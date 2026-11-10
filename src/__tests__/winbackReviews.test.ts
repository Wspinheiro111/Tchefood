import { beforeEach, describe, expect, it } from 'vitest';
import { migratePersisted, useTcheStore } from '../store/useTcheStore';
import { useOwnerSettings } from '../store/useOwnerSettings';
import { lapsedCustomers, normalizeCouponCode, validateCampaign, winbackMessage, winbackResults, winbackUrl, DEFAULT_WINBACK_TEMPLATE } from '../lib/winback';
import { reviewSummary } from '../lib/reviews';
import type { CashbackLedgerEntry, LoyaltyCustomer, Review } from '../types';

const st = () => useTcheStore.getState();
const NOW = new Date('2026-11-10T15:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const cust = (id: string, last: number | null, extra: Partial<LoyaltyCustomer> = {}) =>
  ({ id, tenant_id: 't', name: `Cliente ${id}`, phone_whatsapp: '5555999990000', cpf: null, whatsapp_opt_in: true, opt_in_at: null, cashback_balance: 0, total_spent: 0, visits_count: 0, last_visit_at: last === null ? null : daysAgo(last), created_at: daysAgo(200), ...extra }) as LoyaltyCustomer;
const earn = (customer: string, d: number, base = 100) => ({ id: `${customer}-${d}`, customer_id: customer, entry_type: 'EARN', base_amount: base, created_at: daysAgo(d) }) as CashbackLedgerEntry;

beforeEach(() => st().resetDemo());

describe('cliente sumido', () => {
  it('lista quem não compra há 30+ dias, pela última compra (cadastro ou cashback), quem gastou mais primeiro', () => {
    const customers = [cust('a', 40), cust('b', 45), cust('c', 10), cust('d', null), cust('e', 60)];
    const ledger = [earn('a', 40, 300), earn('a', 80, 200), earn('b', 45, 50), earn('e', 5, 999)];
    const r = lapsedCustomers(customers, ledger, NOW);
    expect(r.map((x) => x.customer.id)).toEqual(['a', 'b']); // e comprou há 5 dias (cashback); d nunca comprou
    expect(r[0]).toMatchObject({ daysAway: 40, visits: 2, spent: 500 });
    expect(lapsedCustomers(customers, ledger, NOW, 44).map((x) => x.customer.id)).toEqual(['b']);
  });

  it('mensagem com nome, loja, oferta e cupom; link do WhatsApp', () => {
    const c = { template: DEFAULT_WINBACK_TEMPLATE, offer: '10% de desconto', coupon: ' volta10 ' };
    const text = winbackMessage(c, 'Maria da Silva', 'Galpão');
    expect(text).toBe('Oi, Maria! Sentimos sua falta no Galpão. Volte esta semana e ganhe 10% de desconto com o cupom VOLTA10. Te esperamos!');
    expect(winbackUrl('5555999990000', 'oi tudo')).toBe('https://wa.me/5555999990000?text=oi%20tudo');
    expect(normalizeCouponCode('a bc')).toBe('ABC');
    expect(normalizeCouponCode('x!')).toBeNull();
    expect(validateCampaign({ ...c, template: 'sem cupom' })).toMatch(/cupom/);
    expect(validateCampaign(c)).toBeNull();
  });

  it('mede quem voltou depois da mensagem', () => {
    const contacts = [
      { customer_id: 'a', coupon: 'X', contacted_at: daysAgo(10) },
      { customer_id: 'a', coupon: 'X', contacted_at: daysAgo(2) },
      { customer_id: 'b', coupon: 'X', contacted_at: daysAgo(10) },
    ];
    const r = winbackResults(contacts, [earn('a', 5, 120), earn('a', 20, 999), earn('b', 12, 50)]);
    expect(r).toEqual({ contacted: 2, returned: 1, returnedPct: 50, revenue: 120 });
  });

  it('a demonstração já traz clientes sumidos e a campanha grava quem foi chamado', () => {
    const lapsed = lapsedCustomers(st().loyaltyCustomers, st().cashbackLedger, new Date());
    expect(lapsed.length).toBe(3);
    useOwnerSettings.setState({ winbackContacts: [] });
    useOwnerSettings.getState().markWinbackSent(lapsed[0]!.customer.id);
    expect(useOwnerSettings.getState().winbackContacts[0]).toMatchObject({ customer_id: lapsed[0]!.customer.id, coupon: 'VOLTA10' });
    expect(useOwnerSettings.getState().saveWinbackCampaign({ template: 'Oi {nome}, cupom {cupom}', offer: 'sobremesa grátis', coupon: 'doce' })).toBeNull();
    expect(useOwnerSettings.getState().winbackCampaign.coupon).toBe('DOCE');
  });
});

describe('avaliações', () => {
  const closedOrder = () => {
    expect(st().login('1111').ok).toBe(true);
    const table = st().tables.find((t) => t.number === 1)!;
    const o = st().openTable(table.id, 2, null);
    if (!o.ok) throw new Error(o.error);
    const p = st().products.find((x) => x.code === '311')!;
    st().addToTray({ order_id: o.data.id, product_id: p.id, half_product_ids: [], quantity: 1, unit_price: p.price, modifiers: [], modifiers_unit_price: 0, meat_doneness: null, quick_tags: [], free_notes: '', sector: p.sector });
    st().dispatchTray(o.data.id);
    st().startCheckout(o.data.id);
    const amount = st().orders.find((x) => x.id === o.data.id)!.remaining_balance;
    const r = st().registerPayment({ orderId: o.data.id, amount, method: 'CASH', status: 'APPROVED', terminal_id: null, acquirer: 'CASH_DESK', acquirer_cnpj: null, card_brand: null, nsu: null, authorization_code: null, terminal_serial: null, idempotency_key: `r-${Math.random()}`, item_ids: [] });
    if (!r.ok) throw new Error(r.error);
    return o.data.id;
  };

  it('nota de 1 a 5, uma por conta, só depois de pagar; sobe na fila', () => {
    const id = closedOrder();
    expect(st().addReview(id, 0, '', 'TABLE').ok).toBe(false);
    expect(st().addReview(id, 6, '', 'TABLE').ok).toBe(false);
    const r = st().addReview(id, 2, '  Demorou muito  ', 'TABLE');
    expect(r.ok && r.data).toMatchObject({ score: 2, comment: 'Demorou muito', source: 'TABLE' });
    expect(st().addReview(id, 5, '', 'TABLE').ok).toBe(false);
    expect(st().outbox.at(-1)).toMatchObject({ table: 'reviews', op: 'INSERT' });
    const open = st().orders.find((o) => o.status === 'OPEN')!;
    expect(st().addReview(open.id, 5, '', 'TABLE').ok).toBe(false);
  });

  it('resumo: média, distribuição, % de satisfeitos e reclamações recentes', () => {
    const rev = (score: number, d: number, comment: string | null = null) => ({ id: `${score}-${d}`, score, comment, created_at: daysAgo(d) }) as Review;
    const s = reviewSummary([rev(5, 1), rev(4, 1), rev(2, 1, 'Frio'), rev(1, 2, 'Demorou'), rev(3, 1), rev(5, 40)], { from: NOW.getTime() - 7 * 86_400_000, to: NOW.getTime() });
    expect(s).toMatchObject({ count: 5, average: 3, distribution: [1, 1, 1, 1, 1], happyPct: 40 });
    expect(s.complaints.map((c) => c.comment)).toEqual(['Frio', 'Demorou']);
    expect(reviewSummary([], { from: 0, to: 1 }).average).toBeNull();
  });

  it('migração da versão 10 cria a lista de avaliações', () => {
    expect((migratePersisted({ orders: [] }, 10) as Record<string, unknown>).reviews).toEqual([]);
  });
});
