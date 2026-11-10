/**
 * Caixa: fundo de troco, vendas em dinheiro, suprimento, sangria e fechamento cego.
 * Funções puras, em centavos. Mesma conta de tchefood_cash_expected() (db/schema_caixa.sql).
 */
import type { CashMovement, CashSession, Payment, StaffUser, Tenant } from '../types';
import { formatBRL, fromCents, toCents } from './money';
import { center, COLS, leftRight } from './receipts';

/** Maior fundo de troco, suprimento ou sangria aceitos de uma vez (evita digitar centavos como reais). */
export const CASH_MAX_AMOUNT = 100_000;

export interface CashSummary {
  openingFloat: number;
  /** Pagamentos em dinheiro aprovados desde a abertura (o valor aplicado na conta, sem o troco). */
  cashSales: number;
  cashSalesCount: number;
  supplies: number;
  withdrawals: number;
  /** Fundo + vendas em dinheiro + suprimentos − sangrias. */
  expected: number;
}

/** Pagamento em dinheiro que conta para o caixa: aprovado, dentro do horário do caixa. */
function cashPaymentsIn(payments: readonly Payment[], from: number, until: number): Payment[] {
  return payments.filter((p) => {
    if (p.method !== 'CASH' || p.status !== 'APPROVED') return false;
    const t = new Date(p.created_at).getTime();
    return t >= from && t <= until;
  });
}

export function cashSummary(session: CashSession, payments: readonly Payment[], movements: readonly CashMovement[], until: Date = new Date()): CashSummary {
  const from = new Date(session.opened_at).getTime();
  const end = session.closed_at ? Math.min(new Date(session.closed_at).getTime(), until.getTime()) : until.getTime();
  const sales = cashPaymentsIn(payments, from, end);
  const salesCents = sales.reduce((a, p) => a + toCents(p.amount), 0);
  let supCents = 0;
  let wdCents = 0;
  for (const m of movements) {
    if (m.session_id !== session.id || new Date(m.created_at).getTime() > end) continue;
    if (m.type === 'SUPPLY') supCents += toCents(m.amount);
    else wdCents += toCents(m.amount);
  }
  const floatCents = toCents(session.opening_float);
  return {
    openingFloat: session.opening_float,
    cashSales: fromCents(salesCents),
    cashSalesCount: sales.length,
    supplies: fromCents(supCents),
    withdrawals: fromCents(wdCents),
    expected: fromCents(floatCents + salesCents + supCents - wdCents),
  };
}

/** Diferença do fechamento: contado − esperado (negativo = faltou dinheiro). */
export function closingDifference(counted: number, expected: number): number {
  return fromCents(toCents(counted) - toCents(expected));
}

/**
 * Dinheiro recebido sem caixa aberto desde `since`: não entra em nenhum fechamento,
 * então aparece para o gerente (aviso no Painel do dono e na tela do Caixa).
 */
export function cashOutsideSessions(payments: readonly Payment[], sessions: readonly CashSession[], since: Date, now: Date = new Date()): { amount: number; count: number } {
  const ranges = sessions.map((s) => [new Date(s.opened_at).getTime(), s.closed_at ? new Date(s.closed_at).getTime() : now.getTime()] as const);
  const outside = cashPaymentsIn(payments, since.getTime(), now.getTime()).filter((p) => {
    const t = new Date(p.created_at).getTime();
    return !ranges.some(([a, b]) => t >= a && t <= b);
  });
  return { amount: fromCents(outside.reduce((a, p) => a + toCents(p.amount), 0)), count: outside.length };
}

/** Valor digitado na tela ("1.234,56" ou "1234.56") em reais; NaN se não for número. */
export function parseMoneyInput(raw: string): number {
  const t = raw.trim().replace(/\s|R\$/g, '');
  if (t === '') return NaN;
  const normalized = t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t;
  return /^\d+(\.\d{1,2})?$/.test(normalized) ? Number(normalized) : NaN;
}

export function validCashAmount(v: number, allowZero = false): boolean {
  return Number.isFinite(v) && (allowZero ? v >= 0 : v > 0) && v <= CASH_MAX_AMOUNT && toCents(v) === Math.round(v * 100);
}

const fmt = (iso: string) => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const money = (v: number) => formatBRL(v).replace(/ /g, ' ');

/** Cupom de fechamento de caixa (bobina 58 mm, 32 colunas). */
export function closingReceiptLines(params: { tenant: Tenant; session: CashSession; summary: CashSummary; movements: readonly CashMovement[]; staff: readonly StaffUser[] }): string[] {
  const { tenant, session, summary, movements, staff } = params;
  const name = (id: string | null) => (id ? staff.find((u) => u.id === id)?.name ?? '?' : '-');
  const line = '-'.repeat(COLS);
  const own = movements.filter((m) => m.session_id === session.id);
  const out = [
    center(tenant.name.toUpperCase()),
    center('FECHAMENTO DE CAIXA'),
    line,
    leftRight('Abertura', fmt(session.opened_at)),
    leftRight('Por', name(session.opened_by_user_id)),
    leftRight('Fechamento', session.closed_at ? fmt(session.closed_at) : 'EM ABERTO'),
    leftRight('Por', name(session.closed_by_user_id)),
    line,
    leftRight('Fundo de troco', money(summary.openingFloat)),
    leftRight(`Vendas dinheiro (${summary.cashSalesCount})`, money(summary.cashSales)),
    leftRight('Suprimentos', money(summary.supplies)),
    leftRight('Sangrias', `-${money(summary.withdrawals)}`),
    line,
    leftRight('ESPERADO NA GAVETA', money(session.expected_cash ?? summary.expected)),
  ];
  if (session.counted_cash !== null) {
    out.push(leftRight('CONTADO', money(session.counted_cash)));
    const diff = session.difference ?? closingDifference(session.counted_cash, summary.expected);
    out.push(leftRight(diff < 0 ? 'FALTOU' : diff > 0 ? 'SOBROU' : 'DIFERENCA', money(Math.abs(diff))));
    if (diff !== 0) out.push(leftRight('Autorizado por', name(session.closing_authorized_by_manager_id)));
  }
  if (own.length) {
    out.push(line, 'MOVIMENTOS');
    for (const m of own) {
      out.push(leftRight(`${new Date(m.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} ${m.type === 'SUPPLY' ? 'Suprimento' : 'Sangria'}`, `${m.type === 'SUPPLY' ? '' : '-'}${money(m.amount)}`));
      out.push(`  ${m.reason}`.slice(0, COLS));
    }
  }
  if (session.closing_notes) out.push(line, 'Obs.: ' + session.closing_notes);
  out.push(line, '', center('Assinatura do operador'), '', center('______________________'));
  return out;
}
