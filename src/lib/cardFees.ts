/**
 * Taxas da maquininha, "quanto sobrou" e agenda de recebíveis.
 *
 * O proprietário cadastra a taxa do contrato dele (maquininha × forma × bandeira):
 * percentual, tarifa fixa por transação e prazo de repasse. Nada é inventado: pagamento
 * sem taxa cadastrada aparece como "sem taxa cadastrada" e fica fora da agenda.
 * Tudo em centavos. Feriados não entram no prazo (só fim de semana).
 */
import type { Payment } from '../types';
import { fromCents, toCents } from './money';
import type { DashboardIndex, Range } from './ownerDashboard';

export type FeeAcquirer = 'STONE' | 'PAGBANK';
export type FeeMethod = 'CREDIT' | 'DEBIT' | 'PIX' | 'VOUCHER';

export const FEE_ACQUIRER_LABEL: Record<FeeAcquirer, string> = { STONE: 'Stone', PAGBANK: 'PagBank' };
export const FEE_METHOD_LABEL: Record<FeeMethod, string> = { CREDIT: 'Crédito à vista', DEBIT: 'Débito', PIX: 'Pix', VOUCHER: 'Voucher / VR' };
/** Bandeiras que a maquininha devolve. Null na regra = todas as bandeiras daquela forma. */
export const FEE_BRANDS = ['VISA', 'MASTERCARD', 'ELO'] as const;

export interface FeeRule {
  id: string;
  acquirer: FeeAcquirer;
  method: FeeMethod;
  /** Null = vale para qualquer bandeira (a regra da bandeira, se existir, ganha). */
  brand: string | null;
  /** Percentual sobre o valor passado na maquininha (ex.: 1.99). */
  pct: number;
  /** Tarifa fixa por transação em reais (ex.: 0.00). */
  fixed: number;
  /** Prazo de repasse (D+n). */
  days: number;
  /** Prazo em dias úteis (pula sábado e domingo) ou corridos. */
  businessDays: boolean;
}

export const MAX_FEE_PCT = 30;
export const MAX_FEE_DAYS = 400;

/** Erro do cadastro de uma regra, ou null se estiver certa. */
export function validateFeeRule(r: Omit<FeeRule, 'id'>): string | null {
  if (!(r.acquirer in FEE_ACQUIRER_LABEL)) return 'Escolha a maquininha.';
  if (!(r.method in FEE_METHOD_LABEL)) return 'Escolha a forma de pagamento.';
  if (!Number.isFinite(r.pct) || r.pct < 0 || r.pct > MAX_FEE_PCT) return `Taxa entre 0% e ${MAX_FEE_PCT}%.`;
  if (!Number.isFinite(r.fixed) || r.fixed < 0 || r.fixed > 50) return 'Tarifa fixa entre R$ 0,00 e R$ 50,00.';
  if (!Number.isInteger(r.days) || r.days < 0 || r.days > MAX_FEE_DAYS) return `Prazo entre D+0 e D+${MAX_FEE_DAYS}.`;
  return null;
}

/** Regra que vale para o pagamento: a da bandeira, senão a de "todas". Dinheiro e simulador não têm taxa. */
export function ruleFor(p: Pick<Payment, 'acquirer' | 'method' | 'card_brand'>, rules: readonly FeeRule[]): FeeRule | null {
  if (p.method === 'CASH' || (p.acquirer !== 'STONE' && p.acquirer !== 'PAGBANK')) return null;
  const same = rules.filter((r) => r.acquirer === p.acquirer && r.method === p.method);
  const brand = p.card_brand?.toUpperCase() ?? null;
  return same.find((r) => r.brand !== null && r.brand.toUpperCase() === brand) ?? same.find((r) => r.brand === null) ?? null;
}

/** Valor passado na maquininha: conta + gorjeta (a taxa incide sobre tudo). */
const chargedCents = (p: Pick<Payment, 'amount' | 'tip_amount'>) => toCents(p.amount) + toCents(p.tip_amount ?? 0);

/** Taxa em centavos (arredondada ao centavo, nunca maior que o valor). */
export function feeCents(p: Pick<Payment, 'amount' | 'tip_amount'>, rule: FeeRule): number {
  const gross = chargedCents(p);
  return Math.min(gross, Math.round((gross * rule.pct) / 100) + toCents(rule.fixed));
}

/** Data (meia-noite local) em que o dinheiro cai na conta. */
export function settlementDate(createdAt: string, rule: Pick<FeeRule, 'days' | 'businessDays'>): Date {
  const d = new Date(createdAt);
  d.setHours(0, 0, 0, 0);
  if (!rule.businessDays) {
    d.setDate(d.getDate() + rule.days);
    return d;
  }
  let left = rule.days;
  while (left > 0) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) left -= 1;
  }
  // D+0 em dia útil vendido no fim de semana cai na segunda.
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d;
}

const cardLike = (p: Payment) => p.status === 'APPROVED' && p.method !== 'CASH';

// ---------------------------------------------------------------------------
// Quanto sobrou?
// ---------------------------------------------------------------------------

export interface LeftoverReport {
  sales: number;
  cardFees: number;
  /** Vendido na maquininha sem taxa cadastrada (a taxa dele não foi descontada). */
  cardWithoutRule: number;
  appCommission: number;
  /** Vendido em apps sem comissão cadastrada. */
  appWithoutCommission: number;
  productCost: number;
  /** Produtos vendidos no período sem custo no cadastro (o custo deles não foi descontado). */
  productsWithoutCost: number;
  leftover: number;
  /** Sobrou ÷ vendido, em % (null sem venda). */
  leftoverPct: number | null;
}

/**
 * Vendido − custo dos produtos (das contas fechadas no período) − taxas da maquininha − comissão dos apps.
 * Não desconta aluguel, salários e outras despesas fixas: é a margem das vendas.
 */
export function leftover(ix: DashboardIndex, r: Range, rules: readonly FeeRule[], appCommissionPct: Readonly<Record<string, number | null>>): LeftoverReport {
  let salesC = 0;
  let feeC = 0;
  let noRuleC = 0;
  for (const p of ix.approved) {
    const t = new Date(p.created_at).getTime();
    if (t < r.from || t >= r.to) continue;
    salesC += toCents(p.amount);
    if (!cardLike(p)) continue;
    const rule = ruleFor(p, rules);
    if (rule) feeC += feeCents(p, rule);
    else noRuleC += chargedCents(p);
  }
  let appC = 0;
  let appNoC = 0;
  for (const m of ix.input.marketplace) {
    const t = new Date(m.created_at).getTime();
    if (m.canceled || t < r.from || t >= r.to) continue;
    salesC += m.total_cents;
    const pct = appCommissionPct[m.channel];
    if (pct === null || pct === undefined) appNoC += m.total_cents;
    else appC += Math.round((m.total_cents * pct) / 100);
  }
  // Custo só das contas fechadas no período: item lançado em mesa ainda aberta não foi
  // vendido ainda (o pagamento dele entra quando a conta fechar).
  let costC = 0;
  const noCostIds = new Set<string>();
  for (const i of ix.input.orderItems) {
    if (i.status === 'CANCELED') continue;
    const order = ix.ordersById.get(i.order_id);
    if (!order || order.status !== 'CLOSED' || !order.closed_at) continue;
    const t = new Date(order.closed_at).getTime();
    if (t < r.from || t >= r.to) continue;
    const prod = ix.productsById.get(i.product_id);
    if (!prod || !(prod.cost_price > 0)) {
      noCostIds.add(i.product_id);
      continue;
    }
    costC += Math.round(toCents(prod.cost_price) * i.quantity);
  }
  const noCost = noCostIds.size;
  const left = salesC - feeC - appC - costC;
  return {
    sales: fromCents(salesC),
    cardFees: fromCents(feeC),
    cardWithoutRule: fromCents(noRuleC),
    appCommission: fromCents(appC),
    appWithoutCommission: fromCents(appNoC),
    productCost: fromCents(costC),
    productsWithoutCost: noCost,
    leftover: fromCents(left),
    leftoverPct: salesC > 0 ? Math.round((left / salesC) * 1000) / 10 : null,
  };
}

// ---------------------------------------------------------------------------
// Agenda de recebíveis
// ---------------------------------------------------------------------------

export interface ReceivableDay {
  /** Meia-noite local do dia do repasse. */
  date: Date;
  gross: number;
  fee: number;
  net: number;
  count: number;
  byAcquirer: Partial<Record<FeeAcquirer, number>>;
}

export interface ReceivablesReport {
  days: ReceivableDay[];
  /** Soma líquida a receber de hoje em diante. */
  totalNet: number;
  /** Passado na maquininha nos últimos `lookbackDays` sem taxa cadastrada (fora da agenda). */
  withoutRule: number;
  withoutRuleCount: number;
}

/**
 * O que cai na conta de hoje até `horizonDays` dias. Olha as vendas dos últimos
 * `lookbackDays` (crédito em D+30 vendido mês passado ainda vai cair).
 */
export function receivables(payments: readonly Payment[], rules: readonly FeeRule[], now: Date = new Date(), horizonDays = 35, lookbackDays = 400): ReceivablesReport {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const end = new Date(today);
  end.setDate(end.getDate() + horizonDays);
  const since = now.getTime() - lookbackDays * 86_400_000;
  const byDay = new Map<number, { gross: number; fee: number; count: number; byAcq: Partial<Record<FeeAcquirer, number>> }>();
  let noRule = 0;
  let noRuleCount = 0;
  for (const p of payments) {
    if (!cardLike(p) || new Date(p.created_at).getTime() < since) continue;
    const rule = ruleFor(p, rules);
    if (!rule) {
      if (p.acquirer === 'STONE' || p.acquirer === 'PAGBANK') {
        noRule += chargedCents(p);
        noRuleCount += 1;
      }
      continue;
    }
    const day = settlementDate(p.created_at, rule);
    if (day < today || day >= end) continue;
    const key = day.getTime();
    const row = byDay.get(key) ?? { gross: 0, fee: 0, count: 0, byAcq: {} };
    const g = chargedCents(p);
    const f = feeCents(p, rule);
    row.gross += g;
    row.fee += f;
    row.count += 1;
    const acq = p.acquirer as FeeAcquirer;
    row.byAcq[acq] = (row.byAcq[acq] ?? 0) + g - f;
    byDay.set(key, row);
  }
  const days = [...byDay.entries()]
    .sort(([a], [b]) => a - b)
    .map(([k, v]) => ({
      date: new Date(k),
      gross: fromCents(v.gross),
      fee: fromCents(v.fee),
      net: fromCents(v.gross - v.fee),
      count: v.count,
      byAcquirer: Object.fromEntries(Object.entries(v.byAcq).map(([a, c]) => [a, fromCents(c)])) as Partial<Record<FeeAcquirer, number>>,
    }));
  return {
    days,
    totalNet: fromCents(days.reduce((a, d) => a + toCents(d.net), 0)),
    withoutRule: fromCents(noRule),
    withoutRuleCount: noRuleCount,
  };
}
