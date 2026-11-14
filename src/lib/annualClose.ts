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
import type { CashMovement, CashSession, CourierSettlement, OwnDelivery, Payment, PaymentMethod, Product, PurchaseInvoice, StaffUser, StockMovement, Supplier } from '../types';
import { feeCents, ruleFor, settlementDate, type FeeRule } from './cardFees';
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

/** Ano de Brasília do instante. */
export function brasiliaYear(iso: string | null | undefined): number | null {
  const t = at(iso);
  if (t === null) return null;
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: SHIFT_TIME_ZONE, year: 'numeric' }).format(new Date(t)));
}

/** Mês (1 a 12) de Brasília do instante. */
function brasiliaMonth(t: number): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: SHIFT_TIME_ZONE, month: 'numeric' }).format(new Date(t)));
}

/** "dd/mm/aaaa" no calendário de Brasília. */
export function brasiliaDate(t: number | Date): string {
  return new Date(t).toLocaleDateString('pt-BR', { timeZone: SHIFT_TIME_ZONE, day: '2-digit', month: '2-digit', year: 'numeric' });
}

/** Anos com algum registro, mais o ano corrente, do mais novo para o mais antigo. */
export function yearsWithData(dates: Iterable<string | null | undefined>, now: Date = new Date()): number[] {
  const set = new Set<number>();
  const current = brasiliaYear(now.toISOString());
  if (current !== null) set.add(current);
  for (const d of dates) {
    const y = brasiliaYear(d);
    if (y !== null && validYear(y) && (current === null || y <= current)) set.add(y);
  }
  return [...set].sort((a, b) => b - a);
}

/** O ano ainda não terminou: a "posição em 31/12" é a posição de agora. */
export function yearInProgress(p: YearPeriod, now: Date = new Date()): boolean {
  return now.getTime() < p.to;
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
}

export interface InventoryReport {
  rows: InventoryRow[];
  totalCost: number;
  /** Produtos com saldo e sem NCM válido (8 dígitos). */
  missingNcm: number;
  /** Movimentos com data inválida (ficaram de fora). */
  invalidDates: number;
}

/**
 * Posição do estoque no fim do ano: para cada produto, o último movimento do livro
 * (stock_movements, só INSERT) com data até 31/12 23:59:59 de Brasília. O app hoje só
 * registra ENTRADA por nota de compra (PURCHASE_IN): as vendas ainda não baixam o
 * estoque, então este saldo é o que entrou, não o que sobrou na prateleira.
 */
export function inventoryAt(products: readonly Product[], movements: readonly StockMovement[], p: YearPeriod): InventoryReport {
  const last = new Map<string, { t: number; m: StockMovement; idx: number }>();
  let invalidDates = 0;
  movements.forEach((m, idx) => {
    const t = at(m.created_at);
    if (t === null) {
      invalidDates += 1;
      return;
    }
    if (t >= p.to) return;
    const prev = last.get(m.product_id);
    // Mesmo instante: vale o que foi gravado depois (ordem do livro).
    if (!prev || t > prev.t || (t === prev.t && idx > prev.idx)) last.set(m.product_id, { t, m, idx });
  });
  const byId = new Map(products.map((x) => [x.id, x]));
  const rows: InventoryRow[] = [];
  let totalC = 0;
  let missingNcm = 0;
  for (const [productId, { m }] of last) {
    const qty = round3(m.balance_after);
    if (qty === 0) continue;
    const prod = byId.get(productId);
    const unitCost = Math.round(m.avg_cost_after * 10_000) / 10_000;
    const totalCents = Math.round(qty * unitCost * 100);
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
    });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  return { rows, totalCost: fromCents(totalC), missingNcm, invalidDates };
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
  for (const pay of input.payments) {
    if (pay.status !== 'APPROVED') continue;
    const t = at(pay.created_at);
    if (t === null || t < p.from || t >= p.to) continue;
    const row = bump(pay.method, METHOD_LABEL[pay.method] ?? pay.method, false);
    const amountC = toCents(pay.amount);
    row.gross += amountC;
    row.count += 1;
    row.monthly[brasiliaMonth(t) - 1]! += amountC;
    tipsC += toCents(pay.tip_amount ?? 0);
    if (pay.method === 'CASH') continue;
    const rule = ruleFor(pay, input.feeRules);
    if (rule) row.fee += feeCents(pay, rule);
    else row.noRule += amountC;
  }
  for (const sale of input.marketplace) {
    if (sale.canceled) continue;
    const t = at(sale.created_at);
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

export interface OpenPositionsReport {
  /** Vendas na maquininha até 31/12 com repasse previsto para depois (pela taxa cadastrada). */
  cardReceivables: CardReceivableRow[];
  cardReceivablesNet: number;
  /** Vendido na maquininha sem taxa cadastrada: não dá para saber quando cai. */
  cardWithoutRule: number;
  cardWithoutRuleCount: number;
  /** Entregas feitas até 31/12 e ainda não acertadas com o entregador naquela data. */
  courierPayables: CourierPayableRow[];
  courierPayablesTotal: number;
}

export interface OpenPositionsInput {
  payments: readonly Payment[];
  feeRules: readonly FeeRule[];
  ownDeliveries: readonly OwnDelivery[];
  courierSettlements: readonly CourierSettlement[];
  couriers: ReadonlyArray<{ id: string; name: string }>;
}

export function openPositionsAt(input: OpenPositionsInput, p: YearPeriod): OpenPositionsReport {
  const card = new Map<string, { acquirer: string; method: PaymentMethod; gross: number; fee: number; count: number }>();
  let noRuleC = 0;
  let noRuleCount = 0;
  for (const pay of input.payments) {
    if (pay.status !== 'APPROVED' || pay.method === 'CASH') continue;
    const t = at(pay.created_at);
    if (t === null || t >= p.to) continue;
    const rule = ruleFor(pay, input.feeRules);
    if (!rule) {
      if ((pay.acquirer === 'STONE' || pay.acquirer === 'PAGBANK') && t >= p.from) {
        noRuleC += toCents(pay.amount) + toCents(pay.tip_amount ?? 0);
        noRuleCount += 1;
      }
      continue;
    }
    // Repasse previsto a partir de 01/01: ainda estava a receber na virada do ano.
    if (settlementDate(pay.created_at, rule).getTime() < p.to) continue;
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
  for (const d of input.ownDeliveries) {
    if (d.status !== 'DELIVERED' || d.courier_fee === null || d.courier_id === null) continue;
    const t = at(d.delivered_at);
    if (t === null || t >= p.to) continue;
    const s = d.settlement_id ? settledAt.get(d.settlement_id) : undefined;
    // Acertada antes da virada: já não devia nada em 31/12.
    if (s !== undefined && s !== null && s < p.to) continue;
    const row = courier.get(d.courier_id) ?? { deliveries: 0, cents: 0 };
    row.deliveries += 1;
    row.cents += toCents(d.courier_fee);
    courier.set(d.courier_id, row);
  }
  const courierPayables = [...courier.entries()]
    .map(([id, r]) => ({ courier: input.couriers.find((c) => c.id === id)?.name ?? 'Entregador removido', deliveries: r.deliveries, amount: fromCents(r.cents) }))
    .sort((a, b) => a.courier.localeCompare(b.courier, 'pt-BR'));
  return {
    cardReceivables,
    cardReceivablesNet: fromCents(cardReceivables.reduce((a, r) => a + toCents(r.net), 0)),
    cardWithoutRule: fromCents(noRuleC),
    cardWithoutRuleCount: noRuleCount,
    courierPayables,
    courierPayablesTotal: fromCents(courierPayables.reduce((a, r) => a + toCents(r.amount), 0)),
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
  for (const inv of input.purchaseInvoices) {
    const when = at(inv.issued_at) !== null ? inv.issued_at! : inv.imported_at;
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
    if (!inYear(s.created_at, p)) continue;
    courierC += toCents(s.courier_fees);
    courierN += 1;
  }

  const withdrawals: WithdrawalRow[] = [];
  let withdrawalsC = 0;
  for (const mv of input.cashMovements) {
    if (mv.type !== 'WITHDRAWAL' || settlementMovements.has(mv.id) || !inYear(mv.created_at, p)) continue;
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
    {
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
  return { rows, total: fromCents(total), purchases, homologationInvoices: homologation, withdrawals, withdrawalsTotal: fromCents(withdrawalsC) };
}

const fmt = (cents: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(fromCents(cents));
