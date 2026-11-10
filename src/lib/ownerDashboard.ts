/**
 * Painel do dono: os números do período respondidos como perguntas
 * ("Como está o dia?", "Dependo demais de um canal?", "O que vende e o que encalha?",
 * "Quanto cancelei?", "O cliente volta?"). Funções puras sobre o estado, em centavos.
 *
 * Dia operacional: começa às 05:00 (SHIFT_CUTOFF_HOUR), igual ao Dashboard do turno.
 * O turno da noite que passa da meia-noite conta no dia em que começou.
 */
import type { AuditLog, CashbackLedgerEntry, DiningTable, LoyaltyCustomer, Order, OrderItem, Payment, Product } from '../types';
import { fromCents, toCents } from './money';
import { shiftStart } from './reports';

export type DashboardPeriod = 'today' | 'yesterday' | '7d' | '30d';

export const PERIOD_LABEL: Record<DashboardPeriod, string> = {
  today: 'Hoje',
  yesterday: 'Ontem',
  '7d': '7 dias',
  '30d': '30 dias',
};

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export interface Range {
  from: number;
  /** Exclusivo. */
  to: number;
}

function addDays(d: Date, days: number): Date {
  // setDate respeita o horário de verão (se um dia voltar a existir) melhor que somar ms.
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  return x;
}

/** Período escolhido e o período de comparação (mesmo dia da semana passada, ou a janela anterior). */
export function periodRanges(period: DashboardPeriod, now: Date = new Date()): { current: Range; previous: Range; days: number } {
  const start = shiftStart(now);
  const nowMs = now.getTime();
  switch (period) {
    case 'today':
      // Comparação justa: semana passada, mesmo dia, até a mesma hora.
      return {
        current: { from: start.getTime(), to: nowMs + 1 },
        previous: { from: addDays(start, -7).getTime(), to: addDays(now, -7).getTime() + 1 },
        days: 1,
      };
    case 'yesterday':
      return {
        current: { from: addDays(start, -1).getTime(), to: start.getTime() },
        previous: { from: addDays(start, -8).getTime(), to: addDays(start, -7).getTime() },
        days: 1,
      };
    case '7d':
      return {
        current: { from: addDays(start, -6).getTime(), to: nowMs + 1 },
        previous: { from: addDays(start, -13).getTime(), to: addDays(now, -7).getTime() + 1 },
        days: 7,
      };
    case '30d':
      return {
        current: { from: addDays(start, -29).getTime(), to: nowMs + 1 },
        previous: { from: addDays(start, -59).getTime(), to: addDays(now, -30).getTime() + 1 },
        days: 30,
      };
  }
}

const inRange = (iso: string | null | undefined, r: Range): boolean => {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return t >= r.from && t < r.to;
};

// ---------------------------------------------------------------------------
// Pedidos de apps de delivery (iFood etc.): só o que o painel precisa.
// ---------------------------------------------------------------------------

export interface MarketplaceSale {
  channel: string;
  /** Nome do app para exibir (iFood, 99Food…). */
  label: string;
  created_at: string;
  total_cents: number;
  canceled: boolean;
  /** Status do pedido no app, para o card "Como estão as entregas?". */
  status: string;
}

// ---------------------------------------------------------------------------
// Canais
// ---------------------------------------------------------------------------

export type OwnChannel = 'TABLE' | 'COUNTER' | 'KIOSK' | 'CASHIER';

export const OWN_CHANNEL_LABEL: Record<OwnChannel, string> = {
  TABLE: 'Salão (mesas e QR)',
  COUNTER: 'Ficha Rápida (balcão)',
  KIOSK: 'Totem',
  CASHIER: 'PDV / Caixa',
};

/**
 * Canal da comanda. Pedido com senha (mesa técnica KIOSK) é Totem quando algum item
 * veio do totem; senão foi a atendente no PDV / Caixa.
 */
export function orderChannel(order: Order, tablesById: ReadonlyMap<string, DiningTable>, itemsByOrder: ReadonlyMap<string, OrderItem[]>): OwnChannel {
  const kind = tablesById.get(order.table_id)?.kind ?? 'TABLE';
  if (kind === 'COUNTER') return 'COUNTER';
  if (kind === 'KIOSK') return (itemsByOrder.get(order.id) ?? []).some((i) => i.origin === 'KIOSK') ? 'KIOSK' : 'CASHIER';
  return 'TABLE';
}

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

export interface DashboardInput {
  orders: readonly Order[];
  orderItems: readonly OrderItem[];
  payments: readonly Payment[];
  tables: readonly DiningTable[];
  products: readonly Product[];
  auditLogs: readonly AuditLog[];
  loyaltyCustomers: readonly LoyaltyCustomer[];
  cashbackLedger: readonly CashbackLedgerEntry[];
  marketplace: readonly MarketplaceSale[];
}

/** Índices montados uma vez por render. */
export interface DashboardIndex {
  input: DashboardInput;
  ordersById: Map<string, Order>;
  tablesById: Map<string, DiningTable>;
  itemsByOrder: Map<string, OrderItem[]>;
  productsById: Map<string, Product>;
  approved: Payment[];
}

export function indexDashboard(input: DashboardInput): DashboardIndex {
  const itemsByOrder = new Map<string, OrderItem[]>();
  for (const i of input.orderItems) {
    const list = itemsByOrder.get(i.order_id);
    if (list) list.push(i);
    else itemsByOrder.set(i.order_id, [i]);
  }
  return {
    input,
    ordersById: new Map(input.orders.map((o) => [o.id, o])),
    tablesById: new Map(input.tables.map((t) => [t.id, t])),
    itemsByOrder,
    productsById: new Map(input.products.map((p) => [p.id, p])),
    approved: input.payments.filter((p) => p.status === 'APPROVED'),
  };
}

// ---------------------------------------------------------------------------
// Vendas do período
// ---------------------------------------------------------------------------

/**
 * Vendido = pagamentos aprovados no período (sem a gorjeta, que é do garçom)
 * + pedidos dos apps de delivery não cancelados. Pagamento estornado (REFUNDED) não conta.
 */
export function salesCents(ix: DashboardIndex, r: Range): number {
  let c = 0;
  for (const p of ix.approved) if (inRange(p.created_at, r)) c += toCents(p.amount);
  for (const m of ix.input.marketplace) if (!m.canceled && inRange(m.created_at, r)) c += m.total_cents;
  return c;
}

/** Pedidos com pagamento no período (conta dividida em vários pagamentos conta uma vez) + pedidos dos apps. */
export function ordersCount(ix: DashboardIndex, r: Range): number {
  const ids = new Set<string>();
  for (const p of ix.approved) if (inRange(p.created_at, r)) ids.add(p.order_id);
  let n = ids.size;
  for (const m of ix.input.marketplace) if (!m.canceled && inRange(m.created_at, r)) n += 1;
  return n;
}

export interface HourPoint {
  /** Hora do relógio (5, 6, … 23, 0, … 4). */
  hour: number;
  current: number;
  previous: number;
}

/** Venda por hora do dia operacional: o dia escolhido e o mesmo dia da semana anterior. */
export function hourlySeries(ix: DashboardIndex, dayStart: number, prevDayStart: number): HourPoint[] {
  const cur = new Array<number>(24).fill(0);
  const prev = new Array<number>(24).fill(0);
  const bucket = (iso: string, cents: number) => {
    const t = new Date(iso).getTime();
    const a = Math.floor((t - dayStart) / HOUR_MS);
    if (a >= 0 && a < 24) cur[a]! += cents;
    const b = Math.floor((t - prevDayStart) / HOUR_MS);
    if (b >= 0 && b < 24) prev[b]! += cents;
  };
  for (const p of ix.approved) bucket(p.created_at, toCents(p.amount));
  for (const m of ix.input.marketplace) if (!m.canceled) bucket(m.created_at, m.total_cents);
  const startHour = new Date(dayStart).getHours();
  return cur.map((c, i) => ({ hour: (startHour + i) % 24, current: fromCents(c), previous: fromCents(prev[i]!) }));
}

export interface DayOverview {
  sales: number;
  orders: number;
  averageTicket: number;
  /** Vendido na última hora (só "Hoje"). */
  lastHour: number | null;
  previousSales: number;
  /** Variação contra o período de comparação; null quando o período anterior é zero. */
  changePct: number | null;
  /** Hoje: vendido + o que a semana passada ainda vendeu dali até o fim do dia. Null sem histórico. */
  projection: number | null;
  /** Média do mesmo dia da semana nas 4 semanas anteriores, até a mesma hora. Null sem histórico. */
  normalUntilNow: number | null;
  /** Só "Hoje" e "Ontem". */
  hourly: HourPoint[] | null;
}

export function dayOverview(ix: DashboardIndex, period: DashboardPeriod, now: Date = new Date()): DayOverview {
  const { current, previous } = periodRanges(period, now);
  const sales = salesCents(ix, current);
  const orders = ordersCount(ix, current);
  const prev = salesCents(ix, previous);
  const nowMs = now.getTime();
  let projection: number | null = null;
  let normal: number | null = null;
  let lastHour: number | null = null;
  if (period === 'today') {
    lastHour = fromCents(salesCents(ix, { from: nowMs - HOUR_MS, to: nowMs + 1 }));
    const lwStart = current.from - 7 * DAY_MS;
    const lwFull = salesCents(ix, { from: lwStart, to: addDays(new Date(current.from), -6).getTime() });
    if (lwFull > 0) projection = fromCents(sales + Math.max(0, lwFull - prev));
    // "Normal para este dia": média das semanas que tiveram venda naquele dia inteiro.
    const weeks: number[] = [];
    for (let w = 1; w <= 4; w++) {
      const dayFrom = addDays(new Date(current.from), -7 * w).getTime();
      const dayTo = addDays(new Date(current.from), -7 * w + 1).getTime();
      if (salesCents(ix, { from: dayFrom, to: dayTo }) === 0) continue;
      weeks.push(salesCents(ix, { from: dayFrom, to: addDays(now, -7 * w).getTime() + 1 }));
    }
    if (weeks.length) normal = fromCents(Math.round(weeks.reduce((a, b) => a + b, 0) / weeks.length));
  }
  const hourly =
    period === 'today' || period === 'yesterday' ? hourlySeries(ix, current.from, previous.from) : null;
  return {
    sales: fromCents(sales),
    orders,
    averageTicket: orders ? fromCents(Math.round(sales / orders)) : 0,
    lastHour,
    previousSales: fromCents(prev),
    changePct: prev > 0 ? Math.round(((sales - prev) / prev) * 1000) / 10 : null,
    projection,
    normalUntilNow: normal,
    hourly,
  };
}

/** Progresso da meta (0–100+, uma casa). Null sem meta. */
export function goalProgress(sales: number, goal: number | null | undefined): number | null {
  if (!goal || goal <= 0) return null;
  return Math.round((toCents(sales) / toCents(goal)) * 1000) / 10;
}

// ---------------------------------------------------------------------------
// Canais: "Dependo demais de um canal?"
// ---------------------------------------------------------------------------

export interface ChannelRow {
  key: string;
  label: string;
  sales: number;
  orders: number;
  /** Participação no vendido (uma casa). */
  pct: number;
  /** Canal de app de delivery: paga comissão. */
  marketplace: boolean;
}

export function channelMix(ix: DashboardIndex, r: Range): ChannelRow[] {
  const acc = new Map<string, { label: string; cents: number; orders: Set<string> | number; marketplace: boolean }>();
  for (const p of ix.approved) {
    if (!inRange(p.created_at, r)) continue;
    const order = ix.ordersById.get(p.order_id);
    const ch: OwnChannel = order ? orderChannel(order, ix.tablesById, ix.itemsByOrder) : 'TABLE';
    const row = acc.get(ch) ?? { label: OWN_CHANNEL_LABEL[ch], cents: 0, orders: new Set<string>(), marketplace: false };
    row.cents += toCents(p.amount);
    (row.orders as Set<string>).add(p.order_id);
    acc.set(ch, row);
  }
  for (const m of ix.input.marketplace) {
    if (m.canceled || !inRange(m.created_at, r)) continue;
    const key = `app:${m.channel}`;
    const row = acc.get(key) ?? { label: m.label, cents: 0, orders: 0, marketplace: true };
    row.cents += m.total_cents;
    row.orders = (row.orders as number) + 1;
    acc.set(key, row);
  }
  const total = [...acc.values()].reduce((a, r2) => a + r2.cents, 0);
  return [...acc.entries()]
    .map(([key, v]) => ({
      key,
      label: v.label,
      sales: fromCents(v.cents),
      orders: typeof v.orders === 'number' ? v.orders : v.orders.size,
      pct: total ? Math.round((v.cents / total) * 1000) / 10 : 0,
      marketplace: v.marketplace,
    }))
    .sort((a, b) => b.sales - a.sales);
}

/** Acima desta participação um único canal vira alerta de dependência. */
export const CHANNEL_DEPENDENCE_PCT = 70;

// ---------------------------------------------------------------------------
// "O que vende e o que encalha?"
// ---------------------------------------------------------------------------

export interface ProductSalesRow {
  product_id: string;
  name: string;
  quantity: number;
  sales: number;
}

/** Itens vendidos (não cancelados) lançados no período. Peso conta em kg; combos e partes como lançados. */
export function productSales(ix: DashboardIndex, r: Range): ProductSalesRow[] {
  const acc = new Map<string, { qty: number; cents: number }>();
  for (const i of ix.input.orderItems) {
    if (i.status === 'CANCELED' || !inRange(i.created_at, r)) continue;
    const order = ix.ordersById.get(i.order_id);
    if (!order || order.status === 'CANCELED') continue;
    const row = acc.get(i.product_id) ?? { qty: 0, cents: 0 };
    row.qty += i.quantity;
    row.cents += toCents(i.total_item_price);
    acc.set(i.product_id, row);
  }
  return [...acc.entries()].map(([id, v]) => ({
    product_id: id,
    name: ix.productsById.get(id)?.name ?? 'Produto removido',
    quantity: Math.round(v.qty * 1000) / 1000,
    sales: fromCents(v.cents),
  }));
}

export interface SellersReport {
  top: ProductSalesRow[];
  /** Produtos à venda que menos venderam (zero primeiro). */
  stalled: ProductSalesRow[];
}

export function sellers(ix: DashboardIndex, r: Range, limit = 5): SellersReport {
  const rows = productSales(ix, r);
  const top = [...rows].sort((a, b) => b.sales - a.sales || b.quantity - a.quantity).slice(0, limit);
  const sold = new Map(rows.map((x) => [x.product_id, x]));
  // Encalhado = produto ativo e disponível no cardápio (o esgotado não conta: não tinha como vender).
  const stalled = ix.input.products
    .filter((p) => p.active && p.available && p.price > 0)
    .map((p) => sold.get(p.id) ?? { product_id: p.id, name: p.name, quantity: 0, sales: 0 })
    .sort((a, b) => a.quantity - b.quantity || a.sales - b.sales || a.name.localeCompare(b.name, 'pt-BR'))
    .slice(0, limit);
  return { top, stalled };
}

// ---------------------------------------------------------------------------
// "Quanto cancelei?"
// ---------------------------------------------------------------------------

export interface CancellationReport {
  itemsCanceled: number;
  itemsValue: number;
  ordersCanceled: number;
  discounts: number;
  discountsValue: number;
  serviceFeeRemoved: number;
  /** % do vendido que foi cancelado em itens (uma casa); null sem vendas. */
  pctOfSales: number | null;
  /** Quem mais cancelou (autorizador no audit_log). */
  byManager: Array<{ manager_id: string; count: number; value: number }>;
}

export function cancellations(ix: DashboardIndex, r: Range): CancellationReport {
  let items = 0;
  let itemsCents = 0;
  for (const i of ix.input.orderItems) {
    if (i.status !== 'CANCELED' || !inRange(i.canceled_at, r)) continue;
    items += 1;
    itemsCents += toCents(i.total_item_price);
  }
  const ordersCanceled = ix.input.orders.filter((o) => o.status === 'CANCELED' && inRange(o.closed_at, r)).length;
  let discounts = 0;
  let discountsCents = 0;
  let feeRemoved = 0;
  const byManager = new Map<string, { count: number; cents: number }>();
  for (const l of ix.input.auditLogs) {
    if (!inRange(l.created_at, r)) continue;
    if (l.action_type === 'DISCOUNT_APPLIED') {
      discounts += 1;
      // amount_impact = total novo − total antigo: desconto que diminui volta positivo e
      // abate o anterior (R$ 20 corrigido para R$ 10 = R$ 10 de desconto, não R$ 30).
      discountsCents -= toCents(l.amount_impact);
    }
    if (l.action_type === 'SERVICE_FEE_REMOVED') feeRemoved += 1;
    if ((l.action_type === 'ITEM_CANCELED' || l.action_type === 'DISCOUNT_APPLIED') && l.authorized_by_manager_id) {
      const m = byManager.get(l.authorized_by_manager_id) ?? { count: 0, cents: 0 };
      m.count += 1;
      m.cents -= toCents(l.amount_impact);
      byManager.set(l.authorized_by_manager_id, m);
    }
  }
  const sales = salesCents(ix, r);
  return {
    itemsCanceled: items,
    itemsValue: fromCents(itemsCents),
    ordersCanceled,
    discounts,
    discountsValue: fromCents(Math.max(0, discountsCents)),
    serviceFeeRemoved: feeRemoved,
    pctOfSales: sales > 0 ? Math.round((itemsCents / sales) * 1000) / 10 : null,
    byManager: [...byManager.entries()]
      .map(([manager_id, v]) => ({ manager_id, count: v.count, value: fromCents(Math.max(0, v.cents)) }))
      .sort((a, b) => b.value - a.value),
  };
}

// ---------------------------------------------------------------------------
// "O cliente volta?" (clientes identificados pelo WhatsApp do cashback)
// ---------------------------------------------------------------------------

export const LAPSED_DAYS = 30;

export interface ReturnReport {
  /** Clientes identificados com compra no período. */
  customers: number;
  /** Desses, quantos já tinham comprado antes do período. */
  returning: number;
  newCustomers: number;
  /** % das compras identificadas no período feitas por quem já era cliente (uma casa). */
  returningPct: number | null;
  /** Clientes cadastrados sem comprar há LAPSED_DAYS dias ou mais (hoje). */
  lapsed: number;
}

export function customerReturn(ix: DashboardIndex, r: Range, now: Date = new Date()): ReturnReport {
  // Cada crédito de cashback (EARN) é uma compra identificada.
  const earnsInRange = ix.input.cashbackLedger.filter((e) => e.entry_type === 'EARN' && inRange(e.created_at, r));
  const firstPurchase = new Map<string, number>();
  for (const e of ix.input.cashbackLedger) {
    if (e.entry_type !== 'EARN') continue;
    const t = new Date(e.created_at).getTime();
    const prev = firstPurchase.get(e.customer_id);
    if (prev === undefined || t < prev) firstPurchase.set(e.customer_id, t);
  }
  const customers = new Set(earnsInRange.map((e) => e.customer_id));
  let returning = 0;
  for (const id of customers) if ((firstPurchase.get(id) ?? Infinity) < r.from) returning += 1;
  let purchasesByReturning = 0;
  for (const e of earnsInRange) if ((firstPurchase.get(e.customer_id) ?? Infinity) < new Date(e.created_at).getTime()) purchasesByReturning += 1;
  const cutoff = now.getTime() - LAPSED_DAYS * DAY_MS;
  const lapsed = ix.input.loyaltyCustomers.filter((c) => c.last_visit_at !== null && new Date(c.last_visit_at).getTime() < cutoff).length;
  return {
    customers: customers.size,
    returning,
    newCustomers: customers.size - returning,
    returningPct: earnsInRange.length ? Math.round((purchasesByReturning / earnsInRange.length) * 1000) / 10 : null,
    lapsed,
  };
}

// ---------------------------------------------------------------------------
// "Como estão as entregas?" (apps de delivery)
// ---------------------------------------------------------------------------

export interface DeliveryStatusReport {
  open: number;
  preparing: number;
  ready: number;
  onTheWay: number;
  done: number;
  canceled: number;
}

export function deliveryStatus(marketplace: readonly MarketplaceSale[], r: Range): DeliveryStatusReport {
  const out: DeliveryStatusReport = { open: 0, preparing: 0, ready: 0, onTheWay: 0, done: 0, canceled: 0 };
  for (const m of marketplace) {
    if (!inRange(m.created_at, r)) continue;
    if (m.canceled || m.status === 'cancelled') out.canceled += 1;
    else if (m.status === 'placed' || m.status === 'confirmed') out.open += 1;
    else if (m.status === 'preparing') out.preparing += 1;
    else if (m.status === 'ready_for_pickup') out.ready += 1;
    else if (m.status === 'dispatched') out.onTheWay += 1;
    else if (m.status === 'concluded') out.done += 1;
    else out.open += 1;
  }
  return out;
}
