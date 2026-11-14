/**
 * Fechamento anual para a contabilidade (Retaguarda › Fechamento anual).
 *
 * Quatro relatórios, todos sobre o que o app REALMENTE registra. O que o app ainda
 * não guarda (contas a pagar de fornecedor, fiado/convênio, folha, aluguel, repasse
 * dos apps) aparece como "não registrado no Tchê Food" e nunca vira número inventado.
 * Valores estimados (taxa da maquininha e comissão dos apps, calculadas pela taxa que
 * o dono cadastrou) vêm marcados como estimativa.
 *
 * Ano = calendário de Brasília: de 01/01 00:00 até 01/01 do ano seguinte 00:00
 * (America/Sao_Paulo), o mesmo dia da NFC-e. Não usa a virada das 05:00 do turno.
 * Tudo em centavos.
 */
import type { CashMovement, CashSession, CourierSettlement, Order, OwnDelivery, Payment, PaymentMethod, Product, PurchaseInvoice, PurchaseInvoiceItem, StaffUser, StockMovement, Supplier } from '../types';
import { feeCents, ruleFor, type FeeRule } from './cardFees';
import { fromCents, round3, toCents } from './money';
import type { MarketplaceSale } from './ownerDashboard';
import { brasiliaInstant, parseIsoInstant, SHIFT_TIME_ZONE } from './reports';

export interface YearPeriod {
  year: number;
  /** 01/01 00:00 de Brasília, em ms (entra). */
  from: number;
  /** 01/01 do ano seguinte 00:00 de Brasília, em ms (fica de fora). */
  to: number;
}

const DAY_MS = 24 * 3600_000;
export const MIN_YEAR = 2000;
export const MAX_YEAR = 2100;

/** Ano válido para o fechamento (inteiro entre 2000 e 2100). */
export function validYear(year: unknown): year is number {
  return typeof year === 'number' && Number.isInteger(year) && year >= MIN_YEAR && year <= MAX_YEAR;
}

export function yearPeriod(year: number): YearPeriod {
  if (!validYear(year)) throw new RangeError(`Ano inválido: ${String(year)}`);
  return { year, from: brasiliaInstant(year, 0, 1, 0), to: brasiliaInstant(year + 1, 0, 1, 0) };
}

/** Instante do registro em ms, ou null se a data for inválida ou sem fuso. */
const at = (iso: string | null | undefined): number | null => parseIsoInstant(iso);
const inYear = (iso: string | null | undefined, p: YearPeriod): boolean => {
  const t = at(iso);
  return t !== null && t >= p.from && t < p.to;
};

// Formatadores criados uma vez: criar um Intl.DateTimeFormat por registro trava a tela
// com um ano de vendas (200 mil pagamentos ≈ 10 s).
const YMD = new Intl.DateTimeFormat('en-US', { timeZone: SHIFT_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

/** Y/M/D de Brasília do instante (m de 0 a 11). */
function brasiliaYmd(t: number): { y: number; m: number; d: number } {
  const parts = Object.fromEntries(YMD.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { y: Number(parts.year), m: Number(parts.month) - 1, d: Number(parts.day) };
}

/** Ano de Brasília do instante. */
export function brasiliaYear(iso: string | null | undefined): number | null {
  const t = at(iso);
  if (t === null) return null;
  return brasiliaYmd(t).y;
}

/** Mês (1 a 12) de Brasília do instante. */
function brasiliaMonth(t: number): number {
  return brasiliaYmd(t).m + 1;
}

const DMY = new Intl.DateTimeFormat('pt-BR', { timeZone: SHIFT_TIME_ZONE, day: '2-digit', month: '2-digit', year: 'numeric' });

/** "dd/mm/aaaa" no calendário de Brasília. */
export function brasiliaDate(t: number | Date): string {
  return DMY.format(new Date(t));
}

/** Anos com algum registro, mais o ano corrente, do mais novo para o mais antigo. */
export function yearsWithData(dates: Iterable<string | null | undefined>, now: Date = new Date()): number[] {
  const set = new Set<number>();
  const raw = Number.isFinite(now.getTime()) ? brasiliaYear(now.toISOString()) : null;
  // Relógio do aparelho fora de 2000–2100 (POS sem hora certa): não vira ano do seletor.
  const current = raw !== null && validYear(raw) ? raw : null;
  if (current !== null) set.add(current);
  for (const d of dates) {
    const y = brasiliaYear(d);
    if (y !== null && validYear(y) && (current === null || y <= current)) set.add(y);
  }
  return [...set].sort((a, b) => b - a);
}

/**
 * Ano que a tela abre: de janeiro a abril (época do fechamento), o ano que acabou de
 * terminar, se ele tiver dados; senão o mais novo da lista. Null se a lista está vazia.
 */
export function defaultYear(years: readonly number[], now: Date = new Date()): number | null {
  if (years.length === 0) return null;
  const current = Number.isFinite(now.getTime()) ? brasiliaYear(now.toISOString()) : null;
  const month = Number.isFinite(now.getTime()) ? brasiliaMonth(now.getTime()) : 12;
  if (current !== null && month <= 4 && years.includes(current - 1)) return current - 1;
  return years[0]!;
}

/** O ano ainda não terminou: a "posição em 31/12" é a posição de agora. */
export function yearInProgress(p: YearPeriod, now: Date = new Date()): boolean {
  return now.getTime() < p.to;
}

/** Até onde vale a "posição": fim do ano, ou agora se o ano ainda não terminou. */
export function positionCutoff(p: YearPeriod, now: Date = new Date()): number {
  return Math.min(p.to, now.getTime());
}

/**
 * Dia do repasse no calendário de Brasília (00:00 de Brasília, em ms), com a mesma regra
 * de cardFees.settlementDate (D+n corrido, ou em dias úteis pulando sábado e domingo;
 * D+0 vendido no fim de semana cai na segunda) mas sem depender do fuso do aparelho.
 */
export function settlementDayBrasilia(createdAtMs: number, rule: Pick<FeeRule, 'days' | 'businessDays'>): number {
  const { y, m, d } = brasiliaYmd(createdAtMs);
  // Aritmética de calendário em UTC (sem fuso); o dia da semana é o do calendário de Brasília.
  const day = new Date(Date.UTC(y, m, d));
  const weekend = () => day.getUTCDay() === 0 || day.getUTCDay() === 6;
  if (!rule.businessDays) {
    day.setUTCDate(day.getUTCDate() + rule.days);
  } else {
    let left = rule.days;
    while (left > 0) {
      day.setUTCDate(day.getUTCDate() + 1);
      if (!weekend()) left -= 1;
    }
    while (weekend()) day.setUTCDate(day.getUTCDate() + 1);
  }
  return brasiliaInstant(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 0);
}

// ---------------------------------------------------------------------------
// 1. Inventário em 31/12
// ---------------------------------------------------------------------------

export interface InventoryRow {
  product_id: string;
  code: string;
  name: string;
  ncm: string;
  unit: string;
  /** Saldo do livro de estoque no fim do dia 31/12 (último movimento até lá). */
  quantity: number;
  /** Custo médio ponderado no fim do dia 31/12 (4 casas, do livro de estoque). */
  unitCost: number;
  total: number;
  /** Produto desativado no cadastro (ainda tem saldo no livro). */
  inactive: boolean;
  /** Teve entrada por NF-e de homologação (teste): saldo e custo recalculados sem ela. */
  withoutTestInvoices: boolean;
}

export interface InventoryReport {
  rows: InventoryRow[];
  totalCost: number;
  /** Produtos com saldo e sem NCM válido (8 dígitos). */
  missingNcm: number;
  /** Movimentos com data inválida (ficaram de fora). */
  invalidDates: number;
  /** Entradas por NF-e de homologação (teste) que ficaram de fora. */
  testMovements: number;
}

/** Movimentos de estoque que vieram de NF-e de homologação (teste): não são mercadoria real. */
export function testInvoiceMovementIds(
  movements: readonly StockMovement[],
  items: ReadonlyArray<Pick<PurchaseInvoiceItem, 'id' | 'invoice_id'>>,
  invoices: ReadonlyArray<Pick<PurchaseInvoice, 'id' | 'environment'>>,
): Set<string> {
  const test = new Set(invoices.filter((i) => i.environment !== 'PRODUCTION').map((i) => i.id));
  const itemInvoice = new Map(items.map((i) => [i.id, i.invoice_id]));
  const out = new Set<string>();
  for (const m of movements) {
    const inv = m.purchase_invoice_item_id ? itemInvoice.get(m.purchase_invoice_item_id) : undefined;
    if (inv !== undefined && test.has(inv)) out.add(m.id);
  }
  return out;
}

/** quantidade (3 casas) × custo (4 casas) em centavos, só com inteiros. */
const qtyTimesCostCents = (qty: number, cost: number): number => Math.round((Math.round(qty * 1000) * Math.round(cost * 10_000)) / 100_000);

/**
 * Posição do estoque no fim do ano: para cada produto, o último movimento do livro
 * (stock_movements, só INSERT) com data até 31/12 23:59:59 de Brasília. O app hoje só
 * registra ENTRADA por nota de compra (PURCHASE_IN): as vendas ainda não baixam o
 * estoque, então este saldo é o que entrou, não o que sobrou na prateleira.
 * Produto com entrada de NF-e de homologação tem saldo e custo médio refeitos só com
 * as entradas reais (como o livro só tem entradas, a média ponderada delas é exata).
 */
export function inventoryAt(products: readonly Product[], movements: readonly StockMovement[], p: YearPeriod, testMovementIds: ReadonlySet<string> = new Set()): InventoryReport {
  const byProduct = new Map<string, Array<{ t: number; m: StockMovement; idx: number }>>();
  let invalidDates = 0;
  movements.forEach((m, idx) => {
    const t = at(m.created_at);
    if (t === null) {
      invalidDates += 1;
      return;
    }
    if (t >= p.to) return;
    const list = byProduct.get(m.product_id);
    if (list) list.push({ t, m, idx });
    else byProduct.set(m.product_id, [{ t, m, idx }]);
  });
  const byId = new Map(products.map((x) => [x.id, x]));
  const rows: InventoryRow[] = [];
  let totalC = 0;
  let missingNcm = 0;
  let testMovements = 0;
  for (const [productId, list] of byProduct) {
    // Mesmo instante: vale o que foi gravado depois (ordem do livro).
    list.sort((a, b) => a.t - b.t || a.idx - b.idx);
    const tests = list.filter((x) => testMovementIds.has(x.m.id)).length;
    testMovements += tests;
    let qty: number;
    let unitCost: number;
    if (tests === 0) {
      const lastMov = list[list.length - 1]!.m;
      qty = round3(lastMov.balance_after);
      unitCost = Math.round(lastMov.avg_cost_after * 10_000) / 10_000;
    } else {
      let milli = 0;
      let costTimes = 0; // Σ quantidade(milésimos) × custo(décimos de milésimo)
      for (const { m } of list) {
        if (testMovementIds.has(m.id)) continue;
        const q = Math.round(m.quantity * 1000);
        milli += q;
        costTimes += q * Math.round(m.unit_cost * 10_000);
      }
      qty = milli / 1000;
      unitCost = milli > 0 ? Math.round(costTimes / milli) / 10_000 : 0;
    }
    if (qty === 0) continue;
    const prod = byId.get(productId);
    const totalCents = qtyTimesCostCents(qty, unitCost);
    totalC += totalCents;
    const ncm = prod?.ncm ?? '';
    if (!/^\d{8}$/.test(ncm)) missingNcm += 1;
    rows.push({
      product_id: productId,
      code: prod?.code ?? '',
      name: prod?.name ?? 'Produto não encontrado no cadastro',
      ncm,
      unit: prod?.unit ?? '',
      quantity: qty,
      unitCost,
      total: fromCents(totalCents),
      inactive: prod ? !prod.active : true,
      withoutTestInvoices: tests > 0,
    });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  return { rows, totalCost: fromCents(totalC), missingNcm, invalidDates, testMovements };
}

// ---------------------------------------------------------------------------
// 2. Faturamento por forma de recebimento + fechamentos de caixa
// ---------------------------------------------------------------------------

export const METHOD_LABEL: Record<PaymentMethod, string> = {
  CASH: 'Dinheiro',
  PIX: 'Pix',
  CREDIT: 'Cartão de crédito',
  DEBIT: 'Cartão de débito',
  VOUCHER: 'Vale-refeição / alimentação',
};
const METHOD_ORDER: PaymentMethod[] = ['CASH', 'PIX', 'CREDIT', 'DEBIT', 'VOUCHER'];

export interface RevenueRow {
  key: string;
  label: string;
  /** Recebido (sem a gorjeta). */
  gross: number;
  count: number;
  /** Taxa estimada pela taxa cadastrada (maquininha) ou comissão cadastrada (app). */
  fee: number;
  net: number;
  /** Parte do bruto sem taxa/comissão cadastrada (a taxa dela NÃO foi descontada). */
  withoutRule: number;
  marketplace: boolean;
  /**
   * Forma que o app não tem como registrar hoje (vale-refeição/alimentação: o caixa
   * escolhe crédito ou débito na maquininha). Sai como "não registrado", não como R$ 0,00.
   */
  notTracked: boolean;
}

export interface CashClosingRow {
  id: string;
  openedAt: string;
  closedAt: string;
  openedBy: string;
  closedBy: string;
  openingFloat: number;
  expected: number | null;
  counted: number | null;
  difference: number | null;
}

export interface RevenueReport {
  rows: RevenueRow[];
  totalGross: number;
  totalFee: number;
  totalNet: number;
  totalWithoutRule: number;
  /** Gorjetas passadas junto (não são faturamento da casa). */
  tips: number;
  /** Bruto por mês (índice 0 = janeiro), por chave de linha. */
  monthly: Record<string, number[]>;
  monthlyTotal: number[];
  closings: CashClosingRow[];
  closingsDifference: number;
  supplies: number;
  withdrawals: number;
  /** Turnos de caixa abertos no ano que ainda não foram fechados. */
  openSessions: number;
  /** Pagamentos aprovados e pedidos de app com data inválida (ficaram de fora). */
  invalidDates: number;
  /** Pagamentos do simulador de maquininha (MOCK) no ano: não são dinheiro real, ficam fora. */
  simulatorCount: number;
  simulatorAmount: number;
  /** Dinheiro recebido fora de qualquer turno de caixa (não aparece nos fechamentos). */
  cashOutsideSessions: number;
  cashOutsideSessionsCount: number;
}

const zeros = () => Array.from({ length: 12 }, () => 0);

export interface RevenueInput {
  payments: readonly Payment[];
  marketplace: readonly MarketplaceSale[];
  feeRules: readonly FeeRule[];
  appCommissionPct: Readonly<Record<string, number | null>>;
  cashSessions: readonly CashSession[];
  cashMovements: readonly CashMovement[];
  staff: readonly StaffUser[];
}

/**
 * Faturamento do ano por forma: pagamentos APROVADOS (estornado e recusado ficam fora)
 * pela data do pagamento, mais os pedidos dos apps não cancelados pela data do pedido.
 * A taxa da maquininha incide sobre conta + gorjeta (igual à agenda de recebíveis).
 */
export function revenueByMethod(input: RevenueInput, p: YearPeriod): RevenueReport {
  const acc = new Map<string, { label: string; gross: number; count: number; fee: number; noRule: number; marketplace: boolean; monthly: number[] }>();
  const bump = (key: string, label: string, marketplace: boolean) => {
    let r = acc.get(key);
    if (!r) {
      r = { label, gross: 0, count: 0, fee: 0, noRule: 0, marketplace, monthly: zeros() };
      acc.set(key, r);
    }
    return r;
  };
  for (const m of METHOD_ORDER) bump(m, METHOD_LABEL[m], false);
  let tipsC = 0;
  let invalidDates = 0;
  let simCount = 0;
  let simC = 0;
  for (const pay of input.payments) {
    if (pay.status !== 'APPROVED') continue;
    const t = at(pay.created_at);
    if (t === null) invalidDates += 1;
    if (t === null || t < p.from || t >= p.to) continue;
    // Simulador da maquininha (demonstração/treino): não entrou dinheiro de verdade.
    if (pay.acquirer === 'MOCK') {
      simCount += 1;
      simC += toCents(pay.amount);
      continue;
    }
    const row = bump(pay.method, METHOD_LABEL[pay.method] ?? pay.method, false);
    const amountC = toCents(pay.amount);
    row.gross += amountC;
    row.count += 1;
    row.monthly[brasiliaMonth(t) - 1]! += amountC;
    tipsC += toCents(pay.tip_amount ?? 0);
    if (pay.method === 'CASH') continue;
    const rule = ruleFor(pay, input.feeRules);
    if (rule) row.fee += feeCents(pay, rule);
    // Sem taxa a descontar só conta para maquininha (Pix direto no caixa não tem taxa).
    else if (pay.acquirer === 'STONE' || pay.acquirer === 'PAGBANK') row.noRule += amountC;
  }
  for (const sale of input.marketplace) {
    if (sale.canceled) continue;
    const t = at(sale.created_at);
    if (t === null) invalidDates += 1;
    if (t === null || t < p.from || t >= p.to) continue;
    const row = bump(`APP:${sale.channel}`, `App: ${sale.label}`, true);
    row.gross += sale.total_cents;
    row.count += 1;
    row.monthly[brasiliaMonth(t) - 1]! += sale.total_cents;
    const pct = input.appCommissionPct[sale.channel];
    if (pct === null || pct === undefined) row.noRule += sale.total_cents;
    else row.fee += Math.round((sale.total_cents * pct) / 100);
  }
  const rows: RevenueRow[] = [...acc.entries()].map(([key, r]) => ({
    notTracked: key === 'VOUCHER' && r.count === 0,
    key,
    label: r.label,
    gross: fromCents(r.gross),
    count: r.count,
    fee: fromCents(r.fee),
    net: fromCents(r.gross - r.fee),
    withoutRule: fromCents(r.noRule),
    marketplace: r.marketplace,
  }));
  const sum = (f: (r: { gross: number; fee: number; noRule: number }) => number) => [...acc.values()].reduce((a, r) => a + f(r), 0);
  const monthly: Record<string, number[]> = {};
  const monthlyTotalC = zeros();
  for (const [key, r] of acc) {
    monthly[key] = r.monthly.map(fromCents);
    r.monthly.forEach((c, i) => (monthlyTotalC[i]! += c));
  }

  const name = (id: string | null) => (id ? input.staff.find((s) => s.id === id)?.name ?? '?' : '');
  const closings: CashClosingRow[] = [];
  let diffC = 0;
  let openSessions = 0;
  const sessionIds = new Set<string>();
  for (const s of input.cashSessions) {
    if (s.status !== 'CLOSED') {
      if (inYear(s.opened_at, p)) openSessions += 1;
      continue;
    }
    if (!inYear(s.closed_at, p)) continue;
    sessionIds.add(s.id);
    if (s.difference !== null) diffC += toCents(s.difference);
    closings.push({
      id: s.id,
      openedAt: s.opened_at,
      closedAt: s.closed_at ?? '',
      openedBy: name(s.opened_by_user_id),
      closedBy: name(s.closed_by_user_id),
      openingFloat: s.opening_float,
      expected: s.expected_cash,
      counted: s.counted_cash,
      difference: s.difference,
    });
  }
  closings.sort((a, b) => (at(a.closedAt) ?? 0) - (at(b.closedAt) ?? 0));
  // Dinheiro fora de turno: pagamento em dinheiro sem nenhum turno de caixa aberto naquela hora.
  const windows = input.cashSessions
    .map((s) => ({ from: at(s.opened_at), to: s.status === 'CLOSED' ? at(s.closed_at) : Number.POSITIVE_INFINITY }))
    .filter((w): w is { from: number; to: number } => w.from !== null && w.to !== null);
  let outsideC = 0;
  let outsideN = 0;
  for (const pay of input.payments) {
    if (pay.status !== 'APPROVED' || pay.method !== 'CASH' || pay.acquirer === 'MOCK') continue;
    const t = at(pay.created_at);
    if (t === null || t < p.from || t >= p.to) continue;
    if (windows.some((w) => t >= w.from && t <= w.to)) continue;
    outsideC += toCents(pay.amount);
    outsideN += 1;
  }
  let suppliesC = 0;
  let withdrawalsC = 0;
  for (const mv of input.cashMovements) {
    if (!inYear(mv.created_at, p)) continue;
    if (mv.type === 'SUPPLY') suppliesC += toCents(mv.amount);
    else if (mv.type === 'WITHDRAWAL') withdrawalsC += toCents(mv.amount);
  }
  const grossC = sum((r) => r.gross);
  const feeC = sum((r) => r.fee);
  return {
    rows,
    totalGross: fromCents(grossC),
    totalFee: fromCents(feeC),
    totalNet: fromCents(grossC - feeC),
    totalWithoutRule: fromCents(sum((r) => r.noRule)),
    tips: fromCents(tipsC),
    monthly,
    monthlyTotal: monthlyTotalC.map(fromCents),
    closings,
    closingsDifference: fromCents(diffC),
    supplies: fromCents(suppliesC),
    withdrawals: fromCents(withdrawalsC),
    openSessions,
    invalidDates,
    simulatorCount: simCount,
    simulatorAmount: fromCents(simC),
    cashOutsideSessions: fromCents(outsideC),
    cashOutsideSessionsCount: outsideN,
  };
}

// ---------------------------------------------------------------------------
// 3. Contas a pagar e a receber em aberto na virada do ano
// ---------------------------------------------------------------------------

export interface CardReceivableRow {
  acquirer: string;
  method: PaymentMethod;
  gross: number;
  fee: number;
  net: number;
  count: number;
}

export interface CourierPayableRow {
  courier: string;
  deliveries: number;
  amount: number;
}

export interface CourierCashRow {
  courier: string;
  deliveries: number;
  amount: number;
}

export interface OpenPositionsReport {
  /** Dinheiro de entregas pagas na entrega feitas até a posição e ainda não acertadas (está com o entregador). */
  courierCash: CourierCashRow[];
  courierCashTotal: number;
  /** Vendas na maquininha até 31/12 com repasse previsto para depois (pela taxa cadastrada). */
  cardReceivables: CardReceivableRow[];
  cardReceivablesNet: number;
  /** Vendido na maquininha sem taxa cadastrada: não dá para saber quando cai. */
  cardWithoutRule: number;
  cardWithoutRuleCount: number;
  /** Entregas feitas até 31/12 e ainda não acertadas com o entregador naquela data. */
  courierPayables: CourierPayableRow[];
  courierPayablesTotal: number;
  /** Instante da posição: fim do ano, ou agora se o ano ainda não terminou. */
  cutoff: number;
  /** Pagamentos e entregas com data inválida (ficaram de fora). */
  invalidDates: number;
}

export interface OpenPositionsInput {
  payments: readonly Payment[];
  feeRules: readonly FeeRule[];
  ownDeliveries: readonly OwnDelivery[];
  courierSettlements: readonly CourierSettlement[];
  couriers: ReadonlyArray<{ id: string; name: string }>;
  orders: ReadonlyArray<Pick<Order, 'id' | 'total_amount'>>;
}

/**
 * Posição na virada do ano (ou agora, se o ano ainda não terminou): o que estava a
 * receber da maquininha e o que estava a pagar aos entregadores naquele instante.
 */
export function openPositionsAt(input: OpenPositionsInput, p: YearPeriod, now: Date = new Date()): OpenPositionsReport {
  const cutoff = positionCutoff(p, now);
  const card = new Map<string, { acquirer: string; method: PaymentMethod; gross: number; fee: number; count: number }>();
  let noRuleC = 0;
  let noRuleCount = 0;
  let invalidDates = 0;
  for (const pay of input.payments) {
    if (pay.status !== 'APPROVED' || pay.method === 'CASH') continue;
    const t = at(pay.created_at);
    if (t === null) invalidDates += 1;
    if (t === null || t >= cutoff) continue;
    const rule = ruleFor(pay, input.feeRules);
    if (!rule) {
      if ((pay.acquirer === 'STONE' || pay.acquirer === 'PAGBANK') && t >= p.from) {
        noRuleC += toCents(pay.amount) + toCents(pay.tip_amount ?? 0);
        noRuleCount += 1;
      }
      continue;
    }
    // Já recebido = o dia do repasse (de Brasília) terminou antes da posição. Com a
    // posição em 31/12, repasse em 01/01 ou depois estava a receber; com o ano em
    // andamento, repasse de hoje em diante ainda está a receber.
    if (settlementDayBrasilia(t, rule) + DAY_MS <= cutoff) continue;
    const key = `${pay.acquirer}|${pay.method}`;
    const row = card.get(key) ?? { acquirer: pay.acquirer, method: pay.method, gross: 0, fee: 0, count: 0 };
    const g = toCents(pay.amount) + toCents(pay.tip_amount ?? 0);
    row.gross += g;
    row.fee += feeCents(pay, rule);
    row.count += 1;
    card.set(key, row);
  }
  const cardReceivables = [...card.values()]
    .sort((a, b) => `${a.acquirer}${a.method}`.localeCompare(`${b.acquirer}${b.method}`))
    .map((r) => ({ acquirer: r.acquirer, method: r.method, gross: fromCents(r.gross), fee: fromCents(r.fee), net: fromCents(r.gross - r.fee), count: r.count }));

  const settledAt = new Map(input.courierSettlements.map((s) => [s.id, at(s.created_at)]));
  const courier = new Map<string, { deliveries: number; cents: number }>();
  const cash = new Map<string, { deliveries: number; cents: number }>();
  const orderTotal = new Map(input.orders.map((o) => [o.id, toCents(o.total_amount)]));
  // Pago da senha até a posição (o dinheiro da entrega só vira pagamento no acerto).
  const paidBefore = new Map<string, number>();
  for (const pay of input.payments) {
    if (pay.status !== 'APPROVED') continue;
    const t = at(pay.created_at);
    if (t === null || t >= cutoff) continue;
    paidBefore.set(pay.order_id, (paidBefore.get(pay.order_id) ?? 0) + toCents(pay.amount));
  }
  for (const d of input.ownDeliveries) {
    if (d.status !== 'DELIVERED' || d.courier_fee === null || d.courier_id === null) continue;
    const t = at(d.delivered_at);
    if (t === null) invalidDates += 1;
    if (t === null || t >= cutoff) continue;
    const s = d.settlement_id ? settledAt.get(d.settlement_id) : undefined;
    // Acertada antes da posição: já não devia nada naquele instante.
    if (s !== undefined && s !== null && s < cutoff) continue;
    const row = courier.get(d.courier_id) ?? { deliveries: 0, cents: 0 };
    row.deliveries += 1;
    row.cents += toCents(d.courier_fee);
    courier.set(d.courier_id, row);
    if (d.pay_on_delivery) {
      const owed = (orderTotal.get(d.order_id) ?? 0) - (paidBefore.get(d.order_id) ?? 0);
      if (owed > 0) {
        const c = cash.get(d.courier_id) ?? { deliveries: 0, cents: 0 };
        c.deliveries += 1;
        c.cents += owed;
        cash.set(d.courier_id, c);
      }
    }
  }
  const courierName = (id: string) => input.couriers.find((c) => c.id === id)?.name ?? 'Entregador removido';
  const courierCash = [...cash.entries()]
    .map(([id, r]) => ({ courier: courierName(id), deliveries: r.deliveries, amount: fromCents(r.cents) }))
    .sort((a, b) => a.courier.localeCompare(b.courier, 'pt-BR'));
  const courierPayables = [...courier.entries()]
    .map(([id, r]) => ({ courier: courierName(id), deliveries: r.deliveries, amount: fromCents(r.cents) }))
    .sort((a, b) => a.courier.localeCompare(b.courier, 'pt-BR'));
  return {
    courierCash,
    courierCashTotal: fromCents(courierCash.reduce((a, r) => a + toCents(r.amount), 0)),
    cardReceivables,
    cardReceivablesNet: fromCents(cardReceivables.reduce((a, r) => a + toCents(r.net), 0)),
    cardWithoutRule: fromCents(noRuleC),
    cardWithoutRuleCount: noRuleCount,
    courierPayables,
    courierPayablesTotal: fromCents(courierPayables.reduce((a, r) => a + toCents(r.amount), 0)),
    cutoff,
    invalidDates,
  };
}

// ---------------------------------------------------------------------------
// 4. Despesas operacionais por categoria
// ---------------------------------------------------------------------------

export type ExpenseSource = 'REGISTERED' | 'ESTIMATED' | 'NOT_TRACKED';

export interface ExpenseRow {
  key: string;
  label: string;
  /** null = o app não registra esta categoria. */
  amount: number | null;
  count: number;
  source: ExpenseSource;
  note: string;
}

export interface PurchaseRow {
  date: string;
  supplier: string;
  document: string;
  number: string;
  series: string;
  accessKey: string;
  amount: number;
}

export interface WithdrawalRow {
  date: string;
  amount: number;
  reason: string;
}

export interface ExpensesReport {
  rows: ExpenseRow[];
  /** Soma só do que está registrado ou estimado (as categorias não registradas ficam fora). */
  total: number;
  purchases: PurchaseRow[];
  /** Notas de homologação (teste) no ano: não entram. */
  homologationInvoices: number;
  /** Sangrias do caixa no ano que não são acerto de entregador: sem categoria. */
  withdrawals: WithdrawalRow[];
  withdrawalsTotal: number;
  /** Notas, acertos e sangrias com data inválida (ficaram de fora). */
  invalidDates: number;
}

export interface ExpensesInput {
  purchaseInvoices: readonly PurchaseInvoice[];
  suppliers: readonly Supplier[];
  courierSettlements: readonly CourierSettlement[];
  cashMovements: readonly CashMovement[];
  revenue: RevenueReport;
}

const NOT_TRACKED = 'Não registrado no Tchê Food. Informe pelo seu controle (folha, contrato, extrato).';

/**
 * Compras de insumos = NF-e de compra importadas (produção), pela data de emissão
 * (ou da importação, se a nota não trouxer). Taxas de entrega = acertos com os
 * entregadores próprios. Taxa da maquininha e comissão dos apps = estimativa pela
 * taxa cadastrada (confira com o extrato). Folha, aluguel e outras: não registradas.
 */
export function expensesByCategory(input: ExpensesInput, p: YearPeriod): ExpensesReport {
  const supplierById = new Map(input.suppliers.map((s) => [s.id, s]));
  const purchases: PurchaseRow[] = [];
  let purchasesC = 0;
  let homologation = 0;
  let invalidDates = 0;
  for (const inv of input.purchaseInvoices) {
    const when = at(inv.issued_at) !== null ? inv.issued_at! : inv.imported_at;
    if (at(when) === null) invalidDates += 1;
    if (!inYear(when, p)) continue;
    if (inv.environment !== 'PRODUCTION') {
      homologation += 1;
      continue;
    }
    const sup = supplierById.get(inv.supplier_id);
    purchasesC += toCents(inv.invoice_amount);
    purchases.push({
      date: when,
      supplier: sup ? sup.trade_name || sup.legal_name : 'Fornecedor não encontrado',
      document: sup?.document ?? '',
      number: inv.number,
      series: inv.series,
      accessKey: inv.access_key,
      amount: inv.invoice_amount,
    });
  }
  purchases.sort((a, b) => (at(a.date) ?? 0) - (at(b.date) ?? 0));

  let courierC = 0;
  let courierN = 0;
  const settlementMovements = new Set<string>();
  for (const s of input.courierSettlements) {
    if (s.cash_movement_id) settlementMovements.add(s.cash_movement_id);
    if (at(s.created_at) === null) invalidDates += 1;
    if (!inYear(s.created_at, p)) continue;
    courierC += toCents(s.courier_fees);
    courierN += 1;
  }

  const withdrawals: WithdrawalRow[] = [];
  let withdrawalsC = 0;
  for (const mv of input.cashMovements) {
    if (mv.type !== 'WITHDRAWAL' || settlementMovements.has(mv.id)) continue;
    if (at(mv.created_at) === null) invalidDates += 1;
    if (!inYear(mv.created_at, p)) continue;
    withdrawalsC += toCents(mv.amount);
    withdrawals.push({ date: mv.created_at, amount: mv.amount, reason: mv.reason });
  }
  withdrawals.sort((a, b) => (at(a.date) ?? 0) - (at(b.date) ?? 0));

  const cardRows = input.revenue.rows.filter((r) => !r.marketplace);
  const appRows = input.revenue.rows.filter((r) => r.marketplace);
  const cardFeeC = cardRows.reduce((a, r) => a + toCents(r.fee), 0);
  const appFeeC = appRows.reduce((a, r) => a + toCents(r.fee), 0);
  const cardNoRuleC = cardRows.reduce((a, r) => a + toCents(r.withoutRule), 0);
  const appNoRuleC = appRows.reduce((a, r) => a + toCents(r.withoutRule), 0);

  const rows: ExpenseRow[] = [
    { key: 'PURCHASES', label: 'Compras de insumos e mercadorias', amount: fromCents(purchasesC), count: purchases.length, source: 'REGISTERED', note: 'NF-e de compra importadas em Compras / Estoque (valor total da nota). Compra sem nota importada não aparece.' },
    { key: 'DELIVERY', label: 'Taxas de entrega (entregadores próprios)', amount: fromCents(courierC), count: courierN, source: 'REGISTERED', note: 'Acertos com os entregadores feitos no app.' },
    {
      key: 'CARD_FEES',
      label: 'Taxas da maquininha',
      amount: fromCents(cardFeeC),
      count: 0,
      source: 'ESTIMATED',
      note: `Estimativa pela taxa cadastrada em Taxas e recebíveis; confira com o extrato da adquirente.${cardNoRuleC > 0 ? ` ${fmt(cardNoRuleC)} em vendas sem taxa cadastrada ficaram de fora.` : ''}`,
    },
    appRows.length === 0
      ? { key: 'APP_FEES', label: 'Comissão dos apps de delivery', amount: null, count: 0, source: 'NOT_TRACKED', note: 'Os pedidos dos apps (iFood etc.) ainda não chegam ao Tchê Food. Informe pelo extrato do app.' }
      : {
          key: 'APP_FEES',
          label: 'Comissão dos apps de delivery',
          amount: fromCents(appFeeC),
          count: 0,
          source: 'ESTIMATED',
          note: `Estimativa pelo % cadastrado; confira com o extrato do app.${appNoRuleC > 0 ? ` ${fmt(appNoRuleC)} em pedidos sem comissão cadastrada ficaram de fora.` : ''}`,
        },
    { key: 'PAYROLL', label: 'Folha de pagamento', amount: null, count: 0, source: 'NOT_TRACKED', note: NOT_TRACKED },
    { key: 'RENT', label: 'Aluguel', amount: null, count: 0, source: 'NOT_TRACKED', note: NOT_TRACKED },
    { key: 'OTHER', label: 'Outras despesas (luz, água, gás, internet, impostos)', amount: null, count: 0, source: 'NOT_TRACKED', note: NOT_TRACKED },
  ];
  const total = rows.reduce((a, r) => a + (r.amount === null ? 0 : toCents(r.amount)), 0);
  return { rows, total: fromCents(total), purchases, homologationInvoices: homologation, withdrawals, withdrawalsTotal: fromCents(withdrawalsC), invalidDates };
}

const fmt = (cents: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(fromCents(cents));
