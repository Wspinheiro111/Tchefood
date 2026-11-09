import { beforeEach, describe, expect, it } from 'vitest';
import {
  cancellations,
  channelMix,
  customerReturn,
  dayOverview,
  goalProgress,
  indexDashboard,
  orderChannel,
  periodRanges,
  sellers,
  type DashboardInput,
  type MarketplaceSale,
} from '../lib/ownerDashboard';
import { ownerAlerts, type AlertInput } from '../lib/ownerAlerts';
import { useOwnerSettings } from '../store/useOwnerSettings';
import { useTcheStore } from '../store/useTcheStore';
import type { AuditLog, CashbackLedgerEntry, DiningTable, LoyaltyCustomer, Order, OrderItem, Payment, Product } from '../types';

// Segunda-feira, 9/11/2026, 20:06 no fuso do aparelho (o dia operacional começou às 05:00).
const NOW = new Date(2026, 10, 9, 20, 6);
const at = (daysAgo: number, h: number, m = 0) => new Date(2026, 10, 9 - daysAgo, h, m).toISOString();

const table = (id: string, kind: DiningTable['kind']): DiningTable =>
  ({ id, tenant_id: 't', number: 1, label: id, area: 'x', capacity: 4, status: 'FREE', qr_code_token: null, current_order_id: null, active: true, updated_at: at(0, 6), kind }) as DiningTable;
const order = (id: string, table_id: string, extra: Partial<Order> = {}): Order =>
  ({ id, tenant_id: 't', table_id, status: 'CLOSED', opened_at: at(0, 12), closed_at: at(0, 13), pickup_number: null, paid_amount: 0, total_amount: 0, ...extra }) as Order;
const pay = (order_id: string, amount: number, created_at: string, status: Payment['status'] = 'APPROVED'): Payment =>
  ({ id: `${order_id}-${created_at}-${amount}`, order_id, tenant_id: 't', amount, tip_amount: 0, method: 'CASH', status, acquirer: 'CASH_DESK', created_at }) as Payment;
const item = (order_id: string, product_id: string, qty: number, total: number, created_at: string, extra: Partial<OrderItem> = {}): OrderItem =>
  ({ id: `${order_id}-${product_id}-${created_at}`, order_id, product_id, quantity: qty, total_item_price: total, status: 'DELIVERED', origin: 'WAITER', created_at, canceled_at: null, ...extra }) as OrderItem;
const product = (id: string, name: string, extra: Partial<Product> = {}): Product => ({ id, name, active: true, available: true, price: 10, ...extra }) as Product;

function input(p: Partial<DashboardInput> = {}): DashboardInput {
  return { orders: [], orderItems: [], payments: [], tables: [], products: [], auditLogs: [], loyaltyCustomers: [], cashbackLedger: [], marketplace: [], ...p };
}

describe('períodos do painel', () => {
  it('hoje começa às 05:00 e compara com o mesmo dia da semana passada até a mesma hora', () => {
    const r = periodRanges('today', NOW);
    expect(new Date(r.current.from)).toEqual(new Date(2026, 10, 9, 5, 0));
    expect(new Date(r.previous.from)).toEqual(new Date(2026, 10, 2, 5, 0));
    expect(new Date(r.previous.to - 1)).toEqual(new Date(2026, 10, 2, 20, 6));
  });

  it('de madrugada o dia operacional ainda é o de ontem', () => {
    const r = periodRanges('today', new Date(2026, 10, 10, 2, 30));
    expect(new Date(r.current.from)).toEqual(new Date(2026, 10, 9, 5, 0));
  });
});

describe('Como está o dia?', () => {
  const tables = [table('m1', 'TABLE')];
  const orders = [order('a', 'm1'), order('b', 'm1'), order('lw', 'm1'), order('lw2', 'm1')];
  const payments = [
    pay('a', 100, at(0, 12)),
    pay('a', 50, at(0, 12, 30)), // mesma comanda em dois pagamentos: 1 pedido
    pay('b', 160, at(0, 19, 30)),
    pay('b', 999, at(0, 19, 40), 'DECLINED'),
    pay('lw', 400, at(7, 13)), // segunda passada antes desta hora
    pay('lw2', 200, at(7, 21)), // segunda passada depois desta hora
  ];

  it('soma só aprovados, conta pedidos sem repetir e compara com a semana passada', () => {
    const ov = dayOverview(indexDashboard(input({ tables, orders, payments })), 'today', NOW);
    expect(ov.sales).toBe(310);
    expect(ov.orders).toBe(2);
    expect(ov.averageTicket).toBe(155);
    expect(ov.previousSales).toBe(400);
    expect(ov.changePct).toBe(-22.5);
    expect(ov.lastHour).toBe(160);
    // Projeção: 310 hoje + 200 que a semana passada vendeu depois desta hora.
    expect(ov.projection).toBe(510);
    // Normal: média das semanas com venda naquele dia, até esta hora.
    expect(ov.normalUntilNow).toBe(400);
  });

  it('gráfico por hora começa às 5h e põe cada venda na hora certa', () => {
    const ov = dayOverview(indexDashboard(input({ tables, orders, payments })), 'today', NOW);
    expect(ov.hourly![0]!.hour).toBe(5);
    const noon = ov.hourly!.find((p) => p.hour === 12)!;
    expect(noon.current).toBe(150);
    expect(ov.hourly!.find((p) => p.hour === 13)!.previous).toBe(400);
  });

  it('sem histórico não inventa projeção nem normal', () => {
    const ov = dayOverview(indexDashboard(input({ tables, orders, payments: payments.slice(0, 3) })), 'today', NOW);
    expect(ov.projection).toBeNull();
    expect(ov.normalUntilNow).toBeNull();
    expect(ov.changePct).toBeNull();
  });

  it('pedidos de app entram no vendido e cancelados não', () => {
    const marketplace: MarketplaceSale[] = [
      { channel: 'ifood', label: 'iFood', created_at: at(0, 18), total_cents: 4590, canceled: false, status: 'concluded' },
      { channel: 'ifood', label: 'iFood', created_at: at(0, 18), total_cents: 9999, canceled: true, status: 'cancelled' },
    ];
    const ov = dayOverview(indexDashboard(input({ tables, orders, payments: payments.slice(0, 3), marketplace })), 'today', NOW);
    expect(ov.sales).toBe(355.9);
    expect(ov.orders).toBe(3);
  });

  it('meta do dia', () => {
    expect(goalProgress(310, 500)).toBe(62);
    expect(goalProgress(310, null)).toBeNull();
    expect(goalProgress(0.1, 0.3)).toBe(33.3);
  });
});

describe('Dependo demais de um canal?', () => {
  it('separa salão, ficha, totem, PDV e apps', () => {
    const tables = [table('m1', 'TABLE'), table('c', 'COUNTER'), table('k', 'KIOSK')];
    const orders = [order('mesa', 'm1'), order('ficha', 'c'), order('totem', 'k'), order('caixa', 'k')];
    const orderItems = [item('totem', 'p', 1, 20, at(0, 12), { origin: 'KIOSK' }), item('caixa', 'p', 1, 20, at(0, 12), { origin: 'WAITER' })];
    const payments = [pay('mesa', 100, at(0, 12)), pay('ficha', 20, at(0, 12)), pay('totem', 20, at(0, 12)), pay('caixa', 20, at(0, 12))];
    const marketplace: MarketplaceSale[] = [{ channel: 'ifood', label: 'iFood', created_at: at(0, 18), total_cents: 4000, canceled: false, status: 'concluded' }];
    const ix = indexDashboard(input({ tables, orders, orderItems, payments, marketplace }));
    expect(orderChannel(orders[2]!, ix.tablesById, ix.itemsByOrder)).toBe('KIOSK');
    expect(orderChannel(orders[3]!, ix.tablesById, ix.itemsByOrder)).toBe('CASHIER');
    const mix = channelMix(ix, periodRanges('today', NOW).current);
    expect(mix.map((r) => [r.key, r.sales, r.pct])).toEqual([
      ['TABLE', 100, 50],
      ['app:ifood', 40, 20],
      ['COUNTER', 20, 10],
      ['KIOSK', 20, 10],
      ['CASHIER', 20, 10],
    ]);
    expect(mix.find((r) => r.key === 'app:ifood')!.marketplace).toBe(true);
  });
});

describe('O que vende e o que encalha?', () => {
  it('mais vendidos por valor e encalhados entre os produtos à venda (esgotado não conta)', () => {
    const products = [product('p1', 'Picanha'), product('p2', 'Chopp'), product('p3', 'Pudim'), product('p4', 'Costela', { available: false }), product('p5', 'Velho', { active: false })];
    const orders = [order('a', 'm1'), order('x', 'm1', { status: 'CANCELED' })];
    const orderItems = [
      item('a', 'p1', 2, 180, at(0, 12)),
      item('a', 'p2', 6, 72, at(0, 12)),
      item('a', 'p3', 1, 15, at(0, 12), { status: 'CANCELED', canceled_at: at(0, 12, 5) }),
      item('x', 'p3', 3, 45, at(0, 12)),
    ];
    const r = sellers(indexDashboard(input({ products, orders, orderItems })), periodRanges('today', NOW).current);
    expect(r.top.map((x) => x.name)).toEqual(['Picanha', 'Chopp']);
    expect(r.stalled.map((x) => [x.name, x.quantity])).toEqual([['Pudim', 0], ['Picanha', 2], ['Chopp', 6]]);
  });
});

describe('Quanto cancelei?', () => {
  it('itens cancelados no período, descontos e quem autorizou', () => {
    const orderItems = [item('a', 'p1', 1, 30, at(0, 12), { status: 'CANCELED', canceled_at: at(0, 13) }), item('a', 'p1', 1, 99, at(1, 12), { status: 'CANCELED', canceled_at: at(1, 13) })];
    const auditLogs = [
      { action_type: 'ITEM_CANCELED', amount_impact: -30, authorized_by_manager_id: 'g1', created_at: at(0, 13) },
      { action_type: 'DISCOUNT_APPLIED', amount_impact: -12.5, authorized_by_manager_id: 'g1', created_at: at(0, 14) },
      { action_type: 'SERVICE_FEE_REMOVED', amount_impact: -9, authorized_by_manager_id: 'g2', created_at: at(0, 15) },
    ] as AuditLog[];
    const payments = [pay('a', 300, at(0, 12))];
    const c = cancellations(indexDashboard(input({ orderItems, auditLogs, payments, orders: [order('a', 'm1')] })), periodRanges('today', NOW).current);
    expect(c.itemsCanceled).toBe(1);
    expect(c.itemsValue).toBe(30);
    expect(c.pctOfSales).toBe(10);
    expect(c.discounts).toBe(1);
    expect(c.discountsValue).toBe(12.5);
    expect(c.serviceFeeRemoved).toBe(1);
    expect(c.byManager).toEqual([{ manager_id: 'g1', count: 2, value: 42.5 }]);
  });
});

describe('O cliente volta?', () => {
  it('novos, de volta e sumidos há 30 dias', () => {
    const earn = (customer_id: string, created_at: string) => ({ customer_id, entry_type: 'EARN', created_at }) as CashbackLedgerEntry;
    const cashbackLedger = [earn('ana', at(20, 12)), earn('ana', at(0, 12)), earn('bia', at(0, 13)), earn('bia', at(0, 19))];
    const loyaltyCustomers = [
      { id: 'ana', last_visit_at: at(0, 12) },
      { id: 'bia', last_visit_at: at(0, 19) },
      { id: 'caio', last_visit_at: at(45, 12) },
      { id: 'dani', last_visit_at: null },
    ] as LoyaltyCustomer[];
    const r = customerReturn(indexDashboard(input({ cashbackLedger, loyaltyCustomers })), periodRanges('today', NOW).current, NOW);
    expect(r.customers).toBe(2);
    expect(r.returning).toBe(1);
    expect(r.newCustomers).toBe(1);
    // 3 compras hoje (ana, bia 2x); de quem já tinha comprado antes: a da ana e a 2ª da bia = 2/3.
    expect(r.returningPct).toBe(66.7);
    expect(r.lapsed).toBe(1);
  });
});

describe('avisos do painel', () => {
  const base = (p: Partial<AlertInput> = {}): AlertInput => ({
    now: NOW,
    orders: [],
    tables: [],
    products: [],
    kegTaps: [],
    reviewHoldOrderIds: [],
    marketplaceErrors: [],
    marketplace: [],
    cloud: { connected: false, rejected: 0, pending: 0, lastSuccessAt: null, lastError: null },
    channels: [],
    ...p,
  });

  it('sem nada fora do normal, sem aviso', () => {
    expect(ownerAlerts(base())).toEqual([]);
  });

  it('app fora do ar, pedido sem aceite e maquininha para conferir vêm primeiro', () => {
    const alerts = ownerAlerts(
      base({
        products: [product('p', 'Costela', { available: false })],
        marketplaceErrors: [{ label: 'iFood', error: 'HTTP 401' }],
        marketplace: [{ channel: 'ifood', label: 'iFood', created_at: new Date(NOW.getTime() - 6 * 60_000).toISOString(), total_cents: 100, canceled: false, status: 'placed' }],
        reviewHoldOrderIds: ['o1'],
      }),
    );
    expect(alerts.map((a) => a.id)).toEqual(['app-error-iFood', 'app-accept', 'review-holds', 'sold-out']);
    expect(alerts[0]!.action?.target).toBe('delivery');
  });

  it('conta de mesa aberta há mais de 3 h e senha sem pagar há 10 min', () => {
    const tables = [table('m1', 'TABLE'), table('k', 'KIOSK')];
    const orders = [
      order('velha', 'm1', { status: 'OPEN', opened_at: at(0, 16) }),
      order('nova', 'm1', { status: 'OPEN', opened_at: at(0, 19) }),
      order('senha', 'k', { status: 'PAYING', pickup_number: 12, paid_amount: 0, opened_at: at(0, 19, 50) }),
    ];
    expect(ownerAlerts(base({ tables, orders })).map((a) => a.id)).toEqual(['long-open', 'pickup-unpaid']);
  });

  it('nuvem: recusado é crítico; fila parada só depois de 15 min com erro', () => {
    const cloud = { connected: true, rejected: 0, pending: 3, lastSuccessAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(), lastError: 'rede' };
    expect(ownerAlerts(base({ cloud }))).toEqual([]);
    expect(ownerAlerts(base({ cloud: { ...cloud, lastSuccessAt: new Date(NOW.getTime() - 20 * 60_000).toISOString() } }))[0]!.id).toBe('cloud-stuck');
    expect(ownerAlerts(base({ cloud: { ...cloud, rejected: 2 } }))[0]!.tone).toBe('critical');
  });

  it('dependência de app acima de 70%', () => {
    const channels = [{ key: 'app:ifood', label: 'iFood', sales: 80, orders: 4, pct: 80, marketplace: true }];
    expect(ownerAlerts(base({ channels }))[0]!.id).toBe('channel-dependence');
  });
});

describe('meta por dia da semana', () => {
  beforeEach(() => useOwnerSettings.setState({ dailyGoals: { 0: null, 1: null, 2: null, 3: null, 4: null, 5: null, 6: null } }));
  it('aceita valor positivo, recusa zero e limpa com null', () => {
    const set = useOwnerSettings.getState().setDailyGoal;
    expect(set(1, 500.456)).toBeNull();
    expect(useOwnerSettings.getState().dailyGoals[1]).toBe(500.46);
    expect(set(1, 0)).not.toBeNull();
    expect(set(7, 10)).not.toBeNull();
    expect(set(1, null)).toBeNull();
    expect(useOwnerSettings.getState().dailyGoals[1]).toBeNull();
  });
});

describe('painel com os dados da demonstração', () => {
  it('não quebra com o estado real do app', () => {
    useTcheStore.getState().resetDemo();
    const s = useTcheStore.getState();
    const ix = indexDashboard({ ...s, marketplace: [] });
    for (const p of ['today', 'yesterday', '7d', '30d'] as const) {
      const ov = dayOverview(ix, p, new Date());
      expect(ov.sales).toBeGreaterThanOrEqual(0);
      sellers(ix, periodRanges(p).current);
    }
  });
});
