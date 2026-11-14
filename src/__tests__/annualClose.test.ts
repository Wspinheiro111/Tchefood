import { describe, expect, it } from 'vitest';
import { expensesByCategory, inventoryAt, openPositionsAt, revenueByMethod, validYear, yearInProgress, yearPeriod, yearsWithData } from '../lib/annualClose';
import { br, code, escapeHtml, expensesDoc, fileName, inventoryDoc, periodLabel, revenueDoc, toCsv, toPrintableHtml, type ReportDoc } from '../lib/annualCloseExport';
import type { FeeRule } from '../lib/cardFees';
import type { CashMovement, CashSession, CourierSettlement, OwnDelivery, Payment, Product, PurchaseInvoice, StockMovement, Supplier } from '../types';

const P = yearPeriod(2025);
const product = (p: Partial<Product>): Product => ({ id: 'p1', code: '001', name: 'Coca-Cola lata', ncm: '22021000', unit: 'UN', active: true, cost_price: 0, stock_quantity: 0, ...p }) as Product;
const mov = (m: Partial<StockMovement>): StockMovement =>
  ({ id: Math.random().toString(), tenant_id: 't', product_id: 'p1', type: 'PURCHASE_IN', quantity: 1, unit_cost: 1, balance_after: 1, avg_cost_after: 1, purchase_invoice_item_id: null, performed_by_user_id: 'u', created_at: '2025-06-01T12:00:00-03:00', ...m }) as StockMovement;
const pay = (p: Partial<Payment>): Payment =>
  ({ id: Math.random().toString(), order_id: 'o', tenant_id: 't', waiter_id: 'w', terminal_id: null, amount: 100, tip_amount: 0, method: 'CREDIT', status: 'APPROVED', acquirer: 'STONE', acquirer_cnpj: null, card_brand: 'VISA', nsu: null, authorization_code: null, terminal_serial: null, idempotency_key: null, created_at: '2025-03-10T20:00:00-03:00', ...p }) as Payment;
const rule = (r: Partial<FeeRule>): FeeRule => ({ id: Math.random().toString(), acquirer: 'STONE', method: 'CREDIT', brand: null, pct: 3, fixed: 0, days: 30, businessDays: false, ...r });
const emptyRevenueInput = { payments: [] as Payment[], marketplace: [], feeRules: [] as FeeRule[], appCommissionPct: {}, cashSessions: [] as CashSession[], cashMovements: [] as CashMovement[], staff: [] };

describe('ano do fechamento', () => {
  it('vai de 01/01 00:00 a 01/01 seguinte 00:00 de Brasília', () => {
    expect(new Date(P.from).toISOString()).toBe('2025-01-01T03:00:00.000Z');
    expect(new Date(P.to).toISOString()).toBe('2026-01-01T03:00:00.000Z');
    // Ano com horário de verão em janeiro (2018): UTC-2.
    expect(new Date(yearPeriod(2018).from).toISOString()).toBe('2018-01-01T02:00:00.000Z');
  });

  it('recusa ano inválido e lista os anos com dados sem ano futuro', () => {
    expect(validYear(1999)).toBe(false);
    expect(validYear(2025.5)).toBe(false);
    expect(() => yearPeriod(3000)).toThrow();
    const now = new Date('2026-11-14T15:00:00-03:00');
    expect(yearsWithData(['2024-12-31T23:30:00-03:00', '2025-01-01T01:00:00Z', 'lixo', null, '2031-01-01T00:00:00Z'], now)).toEqual([2026, 2024]);
    expect(yearInProgress(yearPeriod(2026), now)).toBe(true);
    expect(yearInProgress(yearPeriod(2025), now)).toBe(false);
  });
});

describe('1. inventário em 31/12', () => {
  it('usa o último movimento até o fim do dia 31/12 de Brasília', () => {
    const r = inventoryAt(
      [product({}), product({ id: 'p2', code: '002', name: 'Alcatra', ncm: '2013000', unit: 'KG', active: false })],
      [
        mov({ balance_after: 10, avg_cost_after: 2.5, created_at: '2025-06-01T12:00:00-03:00' }),
        mov({ balance_after: 22, avg_cost_after: 2.7273, created_at: '2025-12-31T23:59:00-03:00' }),
        mov({ balance_after: 40, avg_cost_after: 3, created_at: '2026-01-01T00:00:00-03:00' }), // já é 2026
        mov({ product_id: 'p2', balance_after: 3.5, avg_cost_after: 39.9, created_at: '2025-11-01T10:00:00-03:00' }),
        mov({ product_id: 'p3', balance_after: 0, created_at: '2025-11-01T10:00:00-03:00' }),
        mov({ created_at: 'sem-data' }),
      ],
      P,
    );
    expect(r.rows.map((x) => [x.code, x.quantity, x.unitCost, x.total, x.inactive])).toEqual([
      ['002', 3.5, 39.9, 139.65, true],
      ['001', 22, 2.7273, 60, false],
    ]);
    expect(r.totalCost).toBe(199.65);
    expect(r.missingNcm).toBe(1);
    expect(r.invalidDates).toBe(1);
  });
});

describe('2. faturamento por forma', () => {
  it('separa por forma, desconta a taxa cadastrada e deixa fora estornado, recusado e outro ano', () => {
    const r = revenueByMethod(
      {
        ...emptyRevenueInput,
        payments: [
          pay({ amount: 100, tip_amount: 10 }), // crédito com taxa 3% sobre 110 = 3,30
          pay({ method: 'DEBIT', amount: 50, acquirer: 'PAGBANK' }), // sem taxa cadastrada
          pay({ method: 'CASH', acquirer: 'CASH_DESK', amount: 30, created_at: '2025-12-31T23:00:00-03:00' }),
          pay({ method: 'PIX', amount: 20, status: 'REFUNDED' }),
          pay({ method: 'PIX', amount: 20, status: 'DECLINED' }),
          pay({ method: 'VOUCHER', amount: 40, created_at: '2026-01-01T00:30:00-03:00' }),
        ],
        feeRules: [rule({})],
        marketplace: [
          { channel: 'ifood', label: 'iFood', created_at: '2025-07-01T20:00:00-03:00', total_cents: 8000, canceled: false, status: 'concluded' },
          { channel: 'ifood', label: 'iFood', created_at: '2025-07-01T21:00:00-03:00', total_cents: 5000, canceled: true, status: 'cancelled' },
        ],
        appCommissionPct: { ifood: 12 },
      },
      P,
    );
    const by = Object.fromEntries(r.rows.map((x) => [x.key, x]));
    expect(by.CREDIT).toMatchObject({ gross: 100, fee: 3.3, net: 96.7, count: 1 });
    expect(by.DEBIT).toMatchObject({ gross: 50, fee: 0, withoutRule: 50 });
    expect(by.CASH).toMatchObject({ gross: 30, fee: 0, withoutRule: 0 });
    expect(by.PIX).toMatchObject({ gross: 0, count: 0 });
    expect(by.VOUCHER).toMatchObject({ gross: 0 });
    expect(by['APP:ifood']).toMatchObject({ gross: 80, fee: 9.6, count: 1, marketplace: true });
    expect(r.totalGross).toBe(260);
    expect(r.totalFee).toBe(12.9);
    expect(r.tips).toBe(10);
    expect(r.monthly.CASH![11]).toBe(30);
    expect(r.monthly.CREDIT![2]).toBe(100);
    expect(r.monthlyTotal.reduce((a, b) => a + b, 0)).toBe(260);
  });

  it('lista os fechamentos de caixa do ano e soma sangrias e suprimentos', () => {
    const session = (s: Partial<CashSession>): CashSession =>
      ({ id: Math.random().toString(), tenant_id: 't', opened_by_user_id: 'u1', opened_at: '2025-05-01T10:00:00-03:00', opening_float: 100, status: 'CLOSED', closed_by_user_id: 'u1', closed_at: '2025-05-01T23:00:00-03:00', counted_cash: 290, expected_cash: 300, difference: -10, closing_notes: null, closing_authorized_by_manager_id: null, ...s }) as CashSession;
    const r = revenueByMethod(
      {
        ...emptyRevenueInput,
        staff: [{ id: 'u1', name: 'Ana' } as never],
        cashSessions: [session({}), session({ difference: 2.5, closed_at: '2025-02-01T23:00:00-03:00' }), session({ closed_at: '2026-01-02T01:00:00-03:00' }), session({ status: 'OPEN', closed_at: null })],
        cashMovements: [
          { id: 'm1', type: 'SUPPLY', amount: 50, created_at: '2025-05-01T12:00:00-03:00' } as CashMovement,
          { id: 'm2', type: 'WITHDRAWAL', amount: 70.5, created_at: '2025-05-01T13:00:00-03:00' } as CashMovement,
        ],
      },
      P,
    );
    expect(r.closings.map((c) => [c.openedBy, c.difference])).toEqual([['Ana', 2.5], ['Ana', -10]]);
    expect(r.closingsDifference).toBe(-7.5);
    expect(r.openSessions).toBe(1);
    expect([r.supplies, r.withdrawals]).toEqual([50, 70.5]);
  });
});

describe('3. contas em aberto na virada', () => {
  it('a receber = venda até 31/12 com repasse em 01/01 ou depois; entregador sem acerto = a pagar', () => {
    const delivery = (d: Partial<OwnDelivery>): OwnDelivery => ({ id: Math.random().toString(), status: 'DELIVERED', courier_id: 'c1', courier_fee: 8, delivered_at: '2025-12-30T21:00:00-03:00', settlement_id: null, ...d }) as OwnDelivery;
    const r = openPositionsAt(
      {
        payments: [
          pay({ amount: 100, created_at: '2025-12-20T20:00:00-03:00' }), // D+30 → janeiro: a receber
          pay({ amount: 100, created_at: '2025-11-01T20:00:00-03:00' }), // caiu em dezembro
          pay({ amount: 100, created_at: '2026-01-05T20:00:00-03:00' }), // venda de 2026
          pay({ amount: 70, acquirer: 'PAGBANK', created_at: '2025-12-20T20:00:00-03:00' }), // sem taxa
          pay({ method: 'CASH', acquirer: 'CASH_DESK', amount: 50, created_at: '2025-12-31T20:00:00-03:00' }),
        ],
        feeRules: [rule({})],
        ownDeliveries: [
          delivery({}),
          delivery({ settlement_id: 's-dez' }),
          delivery({ settlement_id: 's-jan' }),
          delivery({ delivered_at: '2026-01-01T10:00:00-03:00' }),
          delivery({ status: 'CANCELED' }),
        ],
        courierSettlements: [{ id: 's-dez', created_at: '2025-12-31T23:00:00-03:00' } as CourierSettlement, { id: 's-jan', created_at: '2026-01-02T10:00:00-03:00' } as CourierSettlement],
        couriers: [{ id: 'c1', name: 'Beto' }],
      },
      P,
    );
    expect(r.cardReceivables).toEqual([{ acquirer: 'STONE', method: 'CREDIT', gross: 100, fee: 3, net: 97, count: 1 }]);
    expect(r.cardWithoutRule).toBe(70);
    expect(r.courierPayables).toEqual([{ courier: 'Beto', deliveries: 2, amount: 16 }]);
  });
});

describe('4. despesas por categoria', () => {
  it('compras pela NF-e de produção, entregadores pelos acertos e sangria do entregador não conta duas vezes', () => {
    const inv = (i: Partial<PurchaseInvoice>): PurchaseInvoice => ({ id: Math.random().toString(), supplier_id: 's1', access_key: '4325'.padEnd(44, '0'), number: '123', series: '1', issued_at: '2025-04-10T10:00:00-03:00', environment: 'PRODUCTION', invoice_amount: 1234.56, imported_at: '2025-04-11T10:00:00-03:00', ...i }) as PurchaseInvoice;
    const revenue = revenueByMethod({ ...emptyRevenueInput, payments: [pay({ amount: 100 })], feeRules: [rule({})] }, P);
    const r = expensesByCategory(
      {
        purchaseInvoices: [inv({}), inv({ environment: 'HOMOLOGATION' }), inv({ issued_at: null, imported_at: '2025-12-31T22:00:00-03:00', invoice_amount: 100 }), inv({ issued_at: '2024-12-31T10:00:00-03:00' })],
        suppliers: [{ id: 's1', document: '01234567000189', legal_name: 'Distribuidora X', trade_name: null } as Supplier],
        courierSettlements: [{ id: 'cs', courier_fees: 40, cash_movement_id: 'mv-courier', created_at: '2025-08-01T23:00:00-03:00' } as CourierSettlement],
        cashMovements: [
          { id: 'mv-courier', type: 'WITHDRAWAL', amount: 40, reason: 'Acerto entregador', created_at: '2025-08-01T23:00:00-03:00' } as CashMovement,
          { id: 'mv-2', type: 'WITHDRAWAL', amount: 25, reason: '=HYPERLINK("x")', created_at: '2025-08-02T23:00:00-03:00' } as CashMovement,
        ],
        revenue,
      },
      P,
    );
    const by = Object.fromEntries(r.rows.map((x) => [x.key, x]));
    expect(by.PURCHASES).toMatchObject({ amount: 1334.56, count: 2, source: 'REGISTERED' });
    expect(by.DELIVERY).toMatchObject({ amount: 40, count: 1 });
    expect(by.CARD_FEES).toMatchObject({ amount: 3, source: 'ESTIMATED' });
    expect(by.PAYROLL).toMatchObject({ amount: null, source: 'NOT_TRACKED' });
    expect(by.RENT!.amount).toBeNull();
    expect(r.total).toBe(1377.56);
    expect(r.homologationInvoices).toBe(1);
    expect(r.withdrawals.map((w) => w.amount)).toEqual([25]);

    const base = { period: periodLabel('expenses', P), store: { name: 'Loja', legalName: 'Loja LTDA', cnpj: '12345678000199', city: 'Santo Ângelo', state: 'RS' }, generatedAt: 'agora' };
    const csv = toCsv(expensesDoc(r, base));
    expect(csv.startsWith('﻿Despesas operacionais')).toBe(true);
    expect(csv).toContain(`="${'4325'.padEnd(44, '0')}"`);
    expect(csv).toContain('="01234567000189"');
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain('Folha de pagamento;;Não registrado;');
    expect(csv).toContain('Total;1377,56;;');
  });
});

describe('exportação', () => {
  const base = { period: periodLabel('inventory', P), store: { name: 'Loja', legalName: '', cnpj: '1', city: 'C', state: 'RS' }, generatedAt: 'agora' };

  it('número com vírgula, código com zero à esquerda e nome de arquivo sem acento', () => {
    expect([br(1234.5), br(-10), br(2.7273), br(3.5), br(0.125)]).toEqual(['1234,50', '-10,00', '2,7273', '3,50', '0,125']);
    const csv = toCsv(inventoryDoc(inventoryAt([product({ ncm: '02013000', name: 'Picanha; "premium"' })], [mov({ balance_after: 2, avg_cost_after: 50 })], P), base));
    expect(csv).toContain('="001";"Picanha; ""premium""";="02013000";UN;2,00;50,00;100,00;Ativo');
    expect(csv).toContain('Posição em 31/12/2025');
    expect(fileName('revenue', 2025, 'csv')).toBe('fechamento-2025-faturamento-caixa.csv');
    expect(periodLabel('revenue', P)).toBe('01/01/2025 a 31/12/2025');
    expect(toCsv({ ...base, title: 'T', notes: [], tables: [{ head: ['A'], rows: [[code('12a=')]] }] } as ReportDoc)).toContain('\r\n12a=\r\n');
  });

  it('HTML escapa o que vem do cadastro', () => {
    expect(escapeHtml(`<img src=x onerror="a">'&`)).toBe('&lt;img src=x onerror=&quot;a&quot;&gt;&#39;&amp;');
    const html = toPrintableHtml(revenueDoc(revenueByMethod({ ...emptyRevenueInput, payments: [pay({})] }, P), { ...base, store: { ...base.store, name: '<script>x</script>' } }));
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Cartão de crédito');
  });
});
