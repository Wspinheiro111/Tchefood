import { describe, expect, it } from 'vitest';
import { feeCents, leftover, receivables, ruleFor, settlementDate, validateFeeRule, type FeeRule } from '../lib/cardFees';
import { indexDashboard, type DashboardInput } from '../lib/ownerDashboard';
import { useOwnerSettings } from '../store/useOwnerSettings';
import type { Order, OrderItem, Payment, Product } from '../types';

const rule = (r: Partial<FeeRule>): FeeRule => ({ id: Math.random().toString(), acquirer: 'STONE', method: 'CREDIT', brand: null, pct: 3, fixed: 0, days: 30, businessDays: false, ...r });
const pay = (p: Partial<Payment>): Payment =>
  ({ id: Math.random().toString(), order_id: 'o1', tenant_id: 't', amount: 100, tip_amount: 0, method: 'CREDIT', status: 'APPROVED', acquirer: 'STONE', card_brand: 'VISA', created_at: new Date(2026, 10, 9, 13).toISOString(), ...p }) as Payment;

describe('taxas da maquininha', () => {
  it('a taxa da bandeira vale antes da de todas; dinheiro e simulador não têm taxa', () => {
    const all = rule({ pct: 3 });
    const visa = rule({ brand: 'VISA', pct: 2.5 });
    expect(ruleFor(pay({}), [all, visa])).toBe(visa);
    expect(ruleFor(pay({ card_brand: 'ELO' }), [all, visa])).toBe(all);
    expect(ruleFor(pay({ acquirer: 'PAGBANK' }), [all, visa])).toBeNull();
    expect(ruleFor(pay({ method: 'CASH', acquirer: 'CASH_DESK' }), [all])).toBeNull();
    expect(ruleFor(pay({ acquirer: 'MOCK' }), [all])).toBeNull();
  });

  it('taxa sobre conta + gorjeta, arredondada ao centavo, com tarifa fixa', () => {
    expect(feeCents(pay({ amount: 33.33, tip_amount: 3.33 }), rule({ pct: 1.99, fixed: 0.1 }))).toBe(Math.round(3666 * 0.0199) + 10);
    expect(feeCents(pay({ amount: 0.05 }), rule({ pct: 0, fixed: 1 }))).toBe(5);
  });

  it('prazo em dias úteis pula o fim de semana; corrido não', () => {
    const fri = new Date(2026, 10, 13, 22).toISOString(); // sexta
    expect(settlementDate(fri, { days: 1, businessDays: true }).getDay()).toBe(1);
    expect(settlementDate(fri, { days: 1, businessDays: false }).getDay()).toBe(6);
    const sat = new Date(2026, 10, 14, 12).toISOString();
    expect(settlementDate(sat, { days: 0, businessDays: true }).getDate()).toBe(16);
    expect(settlementDate(sat, { days: 30, businessDays: false }).getDate()).toBe(14);
  });

  it('valida a regra', () => {
    expect(validateFeeRule(rule({ pct: -1 }))).not.toBeNull();
    expect(validateFeeRule(rule({ pct: 31 }))).not.toBeNull();
    expect(validateFeeRule(rule({ days: 1.5 }))).not.toBeNull();
    expect(validateFeeRule(rule({}))).toBeNull();
  });
});

describe('agenda de recebíveis', () => {
  it('agrupa por dia de repasse, só de hoje em diante, e separa o que não tem taxa', () => {
    const now = new Date(2026, 10, 10, 9);
    const rules = [rule({ method: 'DEBIT', pct: 1, days: 1, businessDays: true }), rule({ method: 'CREDIT', pct: 3, days: 30, businessDays: false })];
    const r = receivables(
      [
        pay({ method: 'DEBIT', amount: 100, created_at: new Date(2026, 10, 9, 20).toISOString() }), // cai 10/11 (hoje)
        pay({ method: 'DEBIT', amount: 50, created_at: new Date(2026, 10, 6, 20).toISOString() }), // sex → seg 9/11 (passado)
        pay({ method: 'CREDIT', amount: 200, created_at: new Date(2026, 10, 9, 20).toISOString() }), // 9/12
        pay({ method: 'CREDIT', amount: 80, acquirer: 'PAGBANK' }), // sem taxa
        pay({ method: 'CASH', acquirer: 'CASH_DESK', amount: 500 }),
        pay({ method: 'DEBIT', amount: 70, status: 'DECLINED', created_at: new Date(2026, 10, 9, 20).toISOString() }),
      ],
      rules,
      now,
    );
    expect(r.days.map((d) => [d.date.getDate(), d.gross, d.fee, d.net])).toEqual([[10, 100, 1, 99], [9, 200, 6, 194]]);
    expect(r.totalNet).toBe(293);
    expect(r).toMatchObject({ withoutRule: 80, withoutRuleCount: 1 });
  });
});

describe('quanto sobrou', () => {
  it('vendido − custo − taxas − comissão, avisando o que falta cadastrar', () => {
    const range = { from: new Date(2026, 10, 9, 5).getTime(), to: new Date(2026, 10, 10, 5).getTime() };
    const at = new Date(2026, 10, 9, 13).toISOString();
    const input: DashboardInput = {
      orders: [{ id: 'o1', status: 'CLOSED', closed_at: at } as Order, { id: 'o2', status: 'OPEN', closed_at: null } as Order],
      orderItems: [
        { id: 'i1', order_id: 'o1', product_id: 'p1', quantity: 2, total_item_price: 100, status: 'DELIVERED', created_at: at } as OrderItem,
        { id: 'i2', order_id: 'o1', product_id: 'p2', quantity: 1, total_item_price: 50, status: 'DELIVERED', created_at: at } as OrderItem,
        // Mesa ainda aberta: o custo não entra até a conta fechar.
        { id: 'i3', order_id: 'o2', product_id: 'p1', quantity: 5, total_item_price: 250, status: 'DELIVERED', created_at: at } as OrderItem,
      ],
      payments: [pay({ amount: 100, created_at: at }), pay({ amount: 50, method: 'CASH', acquirer: 'CASH_DESK', created_at: at }), pay({ amount: 10, acquirer: 'PAGBANK', created_at: at })],
      tables: [],
      products: [{ id: 'p1', name: 'Picanha', cost_price: 20 } as Product, { id: 'p2', name: 'Suco', cost_price: 0 } as Product],
      auditLogs: [],
      loyaltyCustomers: [],
      cashbackLedger: [],
      marketplace: [
        { channel: 'ifood', label: 'iFood', created_at: at, total_cents: 10000, canceled: false, status: 'concluded' },
        { channel: 'keeta', label: 'Keeta', created_at: at, total_cents: 2000, canceled: false, status: 'concluded' },
      ],
    };
    const r = leftover(indexDashboard(input), range, [rule({ pct: 3 })], { ifood: 12 });
    expect(r).toEqual({
      sales: 280,
      cardFees: 3,
      cardWithoutRule: 10,
      appCommission: 12,
      appWithoutCommission: 20,
      productCost: 40,
      productsWithoutCost: 1,
      leftover: 225,
      leftoverPct: 80.4,
    });
  });
});

describe('cadastro das taxas no aparelho', () => {
  it('não deixa duas taxas iguais e normaliza o Pix sem bandeira', () => {
    useOwnerSettings.setState({ feeRules: [], appCommissionPct: {} });
    const s = () => useOwnerSettings.getState();
    expect(s().saveFeeRule({ acquirer: 'STONE', method: 'PIX', brand: 'VISA', pct: 0.99, fixed: 0, days: 0, businessDays: false })).toBeNull();
    expect(s().feeRules[0]!.brand).toBeNull();
    expect(s().saveFeeRule({ acquirer: 'STONE', method: 'PIX', brand: null, pct: 1, fixed: 0, days: 0, businessDays: false })).toMatch(/Já existe/);
    expect(s().saveFeeRule({ id: s().feeRules[0]!.id, acquirer: 'STONE', method: 'PIX', brand: null, pct: 1.2, fixed: 0, days: 0, businessDays: false })).toBeNull();
    expect(s().feeRules).toHaveLength(1);
    expect(s().feeRules[0]!.pct).toBe(1.2);
    expect(s().saveFeeRule({ acquirer: 'STONE', method: 'DEBIT', brand: null, pct: NaN, fixed: 0, days: 1, businessDays: true })).not.toBeNull();
    expect(s().setAppCommission('ifood', 60)).not.toBeNull();
    expect(s().setAppCommission('ifood', 12.5)).toBeNull();
    expect(s().appCommissionPct.ifood).toBe(12.5);
  });
});
