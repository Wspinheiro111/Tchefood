import { describe, expect, it } from 'vitest';
import { defaultYear, expensesByCategory, invoiceDate, inventoryAt, openPositionsAt, revenueByMethod, settlementDayBrasilia, testInvoiceMovementIds, validYear, yearInProgress, yearPeriod, yearsWithData } from '../lib/annualClose';
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
    expect(yearsWithData(['2024-12-31T23:30:00-03:00', '2025-01-01T01:00:00Z', 'lixo', null, '2031-01-01T00:00:00Z'], now)).toEqual([2026, 2025, 2024]);
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
    // Nenhuma tela registra VR/VA hoje: a linha sai como "não registrado", não R$ 0,00.
    expect(by.VOUCHER).toMatchObject({ gross: 0, notTracked: true });
    expect(by.PIX!.notTracked).toBe(false);
    // Dinheiro de 31/12 23:00 sem turno de caixa aberto.
    expect([r.cashOutsideSessions, r.cashOutsideSessionsCount]).toEqual([30, 1]);
    const csv = toCsv(revenueDoc(r, { period: 'x', store: { name: 'L', legalName: '', cnpj: '1', city: 'C', state: 'RS' }, generatedAt: 'g' }));
    expect(csv).toContain('Vale-refeição / alimentação;;não registrado;não registrado;não registrado;');
    expect(csv).toContain('Estorno feito na maquininha');
    expect(csv).toContain('sem turno de caixa aberto');
    expect(csv).toContain('Obs.: SOMENTE os registros gravados NESTE aparelho');
    // Compras por NF-e descem da nuvem: o aviso manda não somar entre aparelhos.
    expect(csv).toContain('NÃO some as compras de aparelhos diferentes');
    expect(toPrintableHtml(revenueDoc(r, { period: 'x', store: { name: 'L', legalName: '', cnpj: '1', city: 'C', state: 'RS' }, generatedAt: 'g' }))).toContain('NESTE aparelho');
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
    const inside = revenueByMethod({ ...emptyRevenueInput, cashSessions: [session({})], payments: [pay({ method: 'CASH', acquirer: 'CASH_DESK', created_at: '2025-05-01T20:00:00-03:00' })] }, P);
    expect(inside.cashOutsideSessionsCount).toBe(0);
    expect(r.closingsDifference).toBe(-7.5);
    expect(r.openSessions).toBe(1);
    // Fechamento com data inválida não some calado.
    expect(revenueByMethod({ ...emptyRevenueInput, cashSessions: [session({ closed_at: 'ontem' })] }, P).invalidDates).toBe(1);
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
        orders: [],
      },
      P,
      new Date('2026-11-14T12:00:00-03:00'),
    );
    expect(r.cardReceivables).toEqual([{ acquirer: 'STONE', method: 'CREDIT', gross: 100, fee: 3, net: 97, count: 1 }]);
    expect(r.cardWithoutRule).toBe(70);
    expect(r.cutoff).toBe(P.to);
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

describe('rodada 1 de revisão', () => {
  const NOW = new Date('2026-11-14T12:00:00-03:00');
  const openInput = { payments: [] as Payment[], feeRules: [rule({ days: 1 })], ownDeliveries: [] as OwnDelivery[], courierSettlements: [] as CourierSettlement[], couriers: [{ id: 'c1', name: 'Beto' }], orders: [] as { id: string; total_amount: number }[] };

  it('o dia do repasse é o do calendário de Brasília, em qualquer fuso do aparelho', () => {
    // 31/12/2025 10:00 BRT, D+1 corrido → 01/01/2026 00:00 BRT (= fim do ano).
    expect(settlementDayBrasilia(Date.parse('2025-12-31T10:00:00-03:00'), { days: 1, businessDays: false })).toBe(P.to);
    // 31/12/2025 22:30 BRT já é 01/01 em UTC: continua contando de 31/12.
    expect(settlementDayBrasilia(Date.parse('2025-12-31T22:30:00-03:00'), { days: 0, businessDays: false })).toBe(P.to - 24 * 3600_000);
    // Sexta 26/12/2025, D+1 útil → segunda 29/12; D+0 no sábado 27/12 → segunda 29/12.
    expect(settlementDayBrasilia(Date.parse('2025-12-26T20:00:00-03:00'), { days: 1, businessDays: true })).toBe(Date.parse('2025-12-29T00:00:00-03:00'));
    expect(settlementDayBrasilia(Date.parse('2025-12-27T20:00:00-03:00'), { days: 0, businessDays: true })).toBe(Date.parse('2025-12-29T00:00:00-03:00'));
    const r = openPositionsAt({ ...openInput, payments: [pay({ created_at: '2025-12-31T10:00:00-03:00' }), pay({ created_at: '2025-12-30T10:00:00-03:00' })] }, P, NOW);
    expect(r.cardReceivables.map((x) => x.count)).toEqual([1]);
  });

  it('ano em andamento: a posição é a de agora (repasse de hoje em diante ainda está a receber)', () => {
    const P26 = yearPeriod(2026);
    const r = openPositionsAt(
      {
        ...openInput,
        feeRules: [rule({ days: 30 })],
        payments: [pay({ created_at: '2026-11-10T20:00:00-03:00' }), pay({ created_at: '2026-09-01T20:00:00-03:00' }), pay({ created_at: '2026-11-20T20:00:00-03:00' })],
      },
      P26,
      NOW,
    );
    expect(r.cutoff).toBe(NOW.getTime());
    expect(r.cardReceivables.map((x) => x.count)).toEqual([1]);
  });

  it('dinheiro com o entregador: entrega paga na entrega sem acerto na posição', () => {
    const d = (x: Partial<OwnDelivery>): OwnDelivery => ({ id: Math.random().toString(), order_id: 'o9', status: 'DELIVERED', courier_id: 'c1', courier_fee: 7, pay_on_delivery: true, delivered_at: '2025-12-31T21:00:00-03:00', settlement_id: 's1', ...x }) as OwnDelivery;
    const r = openPositionsAt(
      {
        ...openInput,
        ownDeliveries: [d({}), d({ order_id: 'o10', pay_on_delivery: false })],
        courierSettlements: [{ id: 's1', created_at: '2026-01-02T10:00:00-03:00' } as CourierSettlement],
        // O pagamento em dinheiro só nasce no acerto (02/01): na virada estava com o entregador.
        payments: [pay({ order_id: 'o9', method: 'CASH', acquirer: 'CASH_DESK', amount: 55, created_at: '2026-01-02T10:00:00-03:00' })],
        orders: [{ id: 'o9', total_amount: 55 }, { id: 'o10', total_amount: 40 }],
      },
      P,
      NOW,
    );
    expect(r.courierCash).toEqual([{ courier: 'Beto', deliveries: 1, amount: 55 }]);
    expect(r.courierPayablesTotal).toBe(14);
  });

  it('simulador de maquininha fica fora; Pix direto sem taxa não vira "sem taxa cadastrada"', () => {
    const r = revenueByMethod({ ...emptyRevenueInput, payments: [pay({ acquirer: 'MOCK', amount: 99 }), pay({ method: 'PIX', acquirer: 'CASH_DESK', amount: 10 }), pay({ created_at: '2025-06-01 10:00:00' })] }, P);
    expect(r.totalGross).toBe(10);
    expect(r.totalWithoutRule).toBe(0);
    expect([r.simulatorCount, r.simulatorAmount]).toEqual([1, 99]);
    expect(r.invalidDates).toBe(1);
    const csv = toCsv(revenueDoc(r, { period: 'x', store: { name: 'L', legalName: '', cnpj: '', city: 'C', state: 'RS' }, generatedAt: 'g' }));
    expect(csv).toContain('simulador');
    expect(csv).toContain('ATENÇÃO: 1 pagamento(s)');
    expect(csv).toContain('CNPJ não cadastrado');
  });

  it('sem pedidos de app, a comissão dos apps é "não registrado", não R$ 0,00', () => {
    const r = expensesByCategory({ purchaseInvoices: [], suppliers: [], courierSettlements: [], cashMovements: [], revenue: revenueByMethod(emptyRevenueInput, P) }, P);
    expect(r.rows.find((x) => x.key === 'APP_FEES')).toMatchObject({ amount: null, source: 'NOT_TRACKED' });
  });

  it('inventário: entrada de NF-e de homologação sai do saldo e do custo; total em centavos exatos', () => {
    const movs = [
      mov({ id: 'real', quantity: 10, unit_cost: 2, balance_after: 10, avg_cost_after: 2, purchase_invoice_item_id: 'i1' }),
      mov({ id: 'teste', quantity: 5, unit_cost: 8, balance_after: 15, avg_cost_after: 4, purchase_invoice_item_id: 'i2', created_at: '2025-07-01T12:00:00-03:00' }),
      mov({ id: 'real2', quantity: 10, unit_cost: 3, balance_after: 25, avg_cost_after: 3.6, purchase_invoice_item_id: 'i3', created_at: '2025-08-01T12:00:00-03:00' }),
      mov({ id: 'centavo', product_id: 'p2', balance_after: 3, avg_cost_after: 1.005 }),
    ];
    const ids = testInvoiceMovementIds(movs, [{ id: 'i1', invoice_id: 'nf1' }, { id: 'i2', invoice_id: 'nf2' }, { id: 'i3', invoice_id: 'nf1' }], [{ id: 'nf1', environment: 'PRODUCTION' }, { id: 'nf2', environment: 'HOMOLOGATION' }]);
    expect([...ids]).toEqual(['teste']);
    const r = inventoryAt([product({}), product({ id: 'p2', code: '002', name: 'Água' })], movs, P, ids);
    expect(r.rows.map((x) => [x.code, x.quantity, x.unitCost, x.total, x.withoutTestInvoices])).toEqual([
      ['002', 3, 1.005, 3.02, false],
      ['001', 20, 2.5, 50, true],
    ]);
    expect(r.testMovements).toBe(1);
  });

  it('ano padrão: de janeiro a abril abre o ano que terminou; relógio errado não quebra', () => {
    expect(defaultYear([2027, 2026], new Date('2027-01-05T10:00:00-03:00'))).toBe(2026);
    expect(defaultYear([2027], new Date('2027-01-05T10:00:00-03:00'))).toBe(2027);
    expect(defaultYear([2026, 2025], new Date('2026-11-14T10:00:00-03:00'))).toBe(2026);
    expect(defaultYear([], new Date())).toBeNull();
    // Relógio em 1970: não vira ano do seletor, mas os anos dos dados continuam.
    expect(yearsWithData(['2025-03-01T10:00:00-03:00'], new Date(0))).toEqual([2025]);
  });

  it('CSV: CR sozinho, espaço ou aspas antes de = + - @ não viram fórmula', () => {
    const doc = { period: 'p', store: { name: 'L', legalName: '', cnpj: '1', city: 'C', state: 'RS' }, generatedAt: 'g', title: 'T', notes: [], tables: [{ head: ['A'], rows: [['ACME\r=HYPERLINK("x")'], [' =1+1'], ['"@SUM(A1)'], ['\t-2'], ['+5'], [NaN]] }] } as ReportDoc;
    const lines = toCsv(doc).split('\r\n');
    expect(lines).toContain('"ACME =HYPERLINK(""x"")"');
    expect(lines).toContain("' =1+1");
    expect(lines).toContain(`"'""@SUM(A1)"`);
    expect(lines).toContain(`"'\t-2"`);
    expect(lines).toContain("'+5");
    expect(toPrintableHtml(doc)).not.toContain('NaN');
    expect(lines.every((l) => !/^[=+\-@]/.test(l))).toBe(true);
  });
});

describe('revisão do Codex', () => {
  it('ano sem movimento entre dois anos com dados também aparece no seletor', () => {
    expect(yearsWithData(['2024-03-01T10:00:00-03:00'], new Date('2026-11-14T10:00:00-03:00'))).toEqual([2026, 2025, 2024]);
  });

  it('NF-e com dEmi (só a data) conta no ano da emissão, não no da importação', () => {
    expect(invoiceDate('2025-12-31')).toBe(Date.parse('2025-12-31T12:00:00-03:00'));
    expect(invoiceDate('2025-02-30')).toBeNull();
    const inv = { id: 'n', supplier_id: 's', access_key: '1', number: '1', series: '1', issued_at: '2025-12-31', environment: 'PRODUCTION', invoice_amount: 80, imported_at: '2026-01-03T10:00:00-03:00' } as PurchaseInvoice;
    const base = { suppliers: [], courierSettlements: [], cashMovements: [], revenue: revenueByMethod(emptyRevenueInput, P) };
    expect(expensesByCategory({ ...base, purchaseInvoices: [inv] }, P).rows[0]!.amount).toBe(80);
    expect(expensesByCategory({ ...base, purchaseInvoices: [inv] }, yearPeriod(2026)).rows[0]!.amount).toBe(0);
    expect(expensesByCategory({ ...base, purchaseInvoices: [inv] }, P).purchases[0]!.date).toBe('2025-12-31T15:00:00.000Z');
  });
});
