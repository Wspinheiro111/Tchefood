/**
 * Relatórios da Retaguarda Executiva (Fase 4). Funções puras sobre o estado.
 */
import type { AuditLog, DiningTable, Order, OrderItem, Payment, StaffUser } from '../types';
import { allocateCents, fromCents, toCents } from './money';

export interface ShiftKpis {
  grossRevenue: number;
  closedOrders: number;
  averageTicket: number;
  serviceFeeTotal: number;
  tablesServed: number;
  openBalance: number;
  openOrders: number;
}

/** Hora em que vira o dia operacional (o turno da noite que passa da meia-noite conta no dia anterior). */
export const SHIFT_CUTOFF_HOUR = 5;

/** Início do turno corrente: hoje às 05:00, ou ontem às 05:00 se ainda é madrugada. */
export function shiftStart(now: Date = new Date(), cutoffHour = SHIFT_CUTOFF_HOUR): Date {
  const start = new Date(now);
  start.setHours(cutoffHour, 0, 0, 0);
  if (now < start) start.setDate(start.getDate() - 1);
  return start;
}

/** Fuso da loja: o turno vira às 05:00 de Brasília, não do relógio do aparelho. */
export const SHIFT_TIME_ZONE = 'America/Sao_Paulo';

/** Período de relatório [start, end): `start` entra, `end` fica de fora. */
export interface ShiftPeriod {
  start: Date;
  end: Date;
}

const SHIFT_CLOCK = new Intl.DateTimeFormat('en-US', {
  timeZone: SHIFT_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

/** Relógio de parede de Brasília no instante `ms`, como se fosse UTC (para calcular a diferença de fuso). */
function wallClockAsUtc(ms: number): number {
  const p = Object.fromEntries(SHIFT_CLOCK.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
}

/** Instante em que o relógio de Brasília marca `y-m-d hh:00`. */
function brasiliaInstant(y: number, m: number, d: number, hour: number): number {
  const guess = Date.UTC(y, m, d, hour);
  let at = guess - (wallClockAsUtc(guess) - guess);
  at = guess - (wallClockAsUtc(at) - at);
  return at;
}

/**
 * Início do turno corrente no horário de Brasília (America/Sao_Paulo): hoje às
 * 05:00, ou ontem às 05:00 se ainda é madrugada. Não depende do fuso do aparelho.
 */
export function shiftStartBrasilia(now: Date = new Date(), cutoffHour = SHIFT_CUTOFF_HOUR): Date {
  const p = Object.fromEntries(SHIFT_CLOCK.formatToParts(now).map((x) => [x.type, x.value]));
  const y = Number(p.year);
  const m = Number(p.month) - 1;
  const d = Number(p.day);
  const today = brasiliaInstant(y, m, d, cutoffHour);
  if (now.getTime() >= today) return new Date(today);
  return new Date(brasiliaInstant(y, m, d - 1, cutoffHour));
}

/** Início do turno seguinte ao que começou em `start` (05:00 do dia seguinte em Brasília). */
export function nextShiftStart(start: Date, cutoffHour = SHIFT_CUTOFF_HOUR): Date {
  return shiftStartBrasilia(new Date(start.getTime() + 36 * 3600_000), cutoffHour);
}

/**
 * Início do dia operacional `days` dias depois do que começou em `start` (negativo
 * = antes), às 05:00 de Brasília. Conta em dias do calendário de Brasília, não em
 * blocos de 24 h nem no fuso do aparelho.
 */
export function shiftStartDaysFrom(start: Date | number, days: number, cutoffHour = SHIFT_CUTOFF_HOUR): Date {
  const t = typeof start === 'number' ? start : start.getTime();
  // Meio do dia operacional pedido: longe das duas viradas mesmo com horário de verão.
  return shiftStartBrasilia(new Date(t + days * 24 * 3600_000 + 12 * 3600_000), cutoffHour);
}

/** Dia da semana (0 = domingo) do instante `at` no calendário de Brasília. */
export function brasiliaWeekday(at: Date): number {
  const p = Object.fromEntries(SHIFT_CLOCK.formatToParts(at).map((x) => [x.type, x.value]));
  return new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day))).getUTCDay();
}

/** Hora (0 a 23) do instante `at` no relógio de Brasília. */
export function brasiliaHour(at: Date): number {
  const p = Object.fromEntries(SHIFT_CLOCK.formatToParts(at).map((x) => [x.type, x.value]));
  return Number(p.hour);
}

/**
 * Período do turno corrente: de `start` até agora (inclusive), nunca além do
 * início do turno seguinte. Registro com data no futuro não entra.
 */
export function currentShiftPeriod(start: Date = shiftStartBrasilia(), now: Date = new Date()): ShiftPeriod {
  return { start, end: new Date(Math.min(nextShiftStart(start).getTime(), now.getTime() + 1)) };
}

/**
 * Instante ISO 8601 com fuso explícito (Z ou ±hh:mm), validado no calendário:
 * 31/11, 30/02, 25h etc. são recusados em vez de normalizados. Sem fuso também é
 * recusado, porque seria lido no fuso do aparelho. Devolve ms ou null.
 */
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|([+-])(\d{2}):?(\d{2}))$/;
export function parseIsoInstant(iso: unknown): number | null {
  if (typeof iso !== 'string') return null;
  const m = ISO_INSTANT.exec(iso);
  if (!m) return null;
  const [y, mo, d, h, mi] = [m[1], m[2], m[3], m[4], m[5]].map(Number) as [number, number, number, number, number];
  const sec = m[6] === undefined ? 0 : Number(m[6]);
  const ms = m[7] === undefined ? 0 : Number(m[7].slice(0, 3).padEnd(3, '0'));
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || sec > 59) return null;
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (d > daysInMonth) return null;
  let offsetMin = 0;
  if (m[8] !== 'Z') {
    const oh = Number(m[10]);
    const om = Number(m[11]);
    if (oh > 23 || om > 59) return null;
    offsetMin = (m[9] === '-' ? -1 : 1) * (oh * 60 + om);
  }
  const t = Date.UTC(y, mo - 1, d, h, mi, sec, ms) - offsetMin * 60_000;
  return Number.isFinite(t) ? t : null;
}

/** true se a data é válida e cai em [start, end). Data inválida, impossível, sem fuso, vazia ou null fica de fora. */
export function inShiftPeriod(iso: string | null | undefined, period: ShiftPeriod): boolean {
  const t = parseIsoInstant(iso);
  return t !== null && t >= period.start.getTime() && t < period.end.getTime();
}

/** Legenda "dd/mm, hh:mm" do início do turno, sempre no horário de Brasília. */
export function formatShiftStart(start: Date): string {
  return start.toLocaleString('pt-BR', { timeZone: SHIFT_TIME_ZONE, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/**
 * KPIs do turno: faturamento, contas fechadas, ticket médio e 10% contam só o
 * que aconteceu no turno; o saldo em aberto no salão é sempre o atual. Com um
 * `ShiftPeriod`, usa o mesmo filtro [início, fim) da conciliação e do rateio;
 * com um `Date`, conta desde ele (comportamento anterior).
 */
export function shiftKpis(orders: readonly Order[], payments: readonly Payment[], since: Date | ShiftPeriod = shiftStart()): ShiftKpis {
  const inShift =
    since instanceof Date
      ? (iso: string | null) => iso !== null && new Date(iso).getTime() >= since.getTime()
      : (iso: string | null) => inShiftPeriod(iso, since);
  const approved = payments.filter((p) => p.status === 'APPROVED' && inShift(p.created_at));
  const grossCents = approved.reduce((a, p) => a + toCents(p.amount), 0);
  const closed = orders.filter((o) => o.status === 'CLOSED' && inShift(o.closed_at));
  const closedTotalCents = closed.reduce((a, o) => a + toCents(o.total_amount), 0);
  const feeCents = closed.reduce((a, o) => a + toCents(o.service_fee_amount), 0);
  const open = orders.filter((o) => o.status === 'OPEN' || o.status === 'PAYING');
  return {
    grossRevenue: fromCents(grossCents),
    closedOrders: closed.length,
    averageTicket: closed.length ? fromCents(Math.round(closedTotalCents / closed.length)) : 0,
    serviceFeeTotal: fromCents(feeCents),
    tablesServed: orders.filter((o) => o.status !== 'CANCELED' && (inShift(o.opened_at) || inShift(o.closed_at) || o.status === 'OPEN' || o.status === 'PAYING')).length,
    openBalance: fromCents(open.reduce((a, o) => a + toCents(o.remaining_balance), 0)),
    openOrders: open.length,
  };
}

export type ReconKey = 'STONE' | 'PAGBANK' | 'CASH_DESK';
export type ReconMethod = 'CREDIT' | 'DEBIT' | 'PIX' | 'CASH' | 'VOUCHER';

export interface ReconRow {
  acquirer: ReconKey;
  cnpj: string | null;
  byMethod: Record<ReconMethod, number>;
  total: number;
  count: number;
}

/** Conciliação por adquirente: só pagamentos aprovados dentro do período do turno [start, end). */
export function reconciliation(payments: readonly Payment[], period: ShiftPeriod = currentShiftPeriod()): ReconRow[] {
  const rows: Record<ReconKey, ReconRow> = {
    STONE: { acquirer: 'STONE', cnpj: '16501555000157', byMethod: { CREDIT: 0, DEBIT: 0, PIX: 0, CASH: 0, VOUCHER: 0 }, total: 0, count: 0 },
    PAGBANK: { acquirer: 'PAGBANK', cnpj: '08561701000101', byMethod: { CREDIT: 0, DEBIT: 0, PIX: 0, CASH: 0, VOUCHER: 0 }, total: 0, count: 0 },
    CASH_DESK: { acquirer: 'CASH_DESK', cnpj: null, byMethod: { CREDIT: 0, DEBIT: 0, PIX: 0, CASH: 0, VOUCHER: 0 }, total: 0, count: 0 },
  };
  const cents: Record<ReconKey, Record<ReconMethod, number>> = {
    STONE: { CREDIT: 0, DEBIT: 0, PIX: 0, CASH: 0, VOUCHER: 0 },
    PAGBANK: { CREDIT: 0, DEBIT: 0, PIX: 0, CASH: 0, VOUCHER: 0 },
    CASH_DESK: { CREDIT: 0, DEBIT: 0, PIX: 0, CASH: 0, VOUCHER: 0 },
  };
  for (const p of payments) {
    if (p.status !== 'APPROVED' || !inShiftPeriod(p.created_at, period)) continue;
    const key: ReconKey = p.acquirer === 'STONE' || p.acquirer === 'PAGBANK' ? p.acquirer : 'CASH_DESK';
    cents[key][p.method] += toCents(p.amount);
    rows[key].count += 1;
  }
  for (const k of Object.keys(rows) as ReconKey[]) {
    let total = 0;
    for (const m of Object.keys(cents[k]) as ReconMethod[]) {
      rows[k].byMethod[m] = fromCents(cents[k][m]);
      total += cents[k][m];
    }
    rows[k].total = fromCents(total);
  }
  return [rows.STONE, rows.PAGBANK, rows.CASH_DESK];
}

/** Transações recusadas dentro do período do turno [start, end), mesmo filtro da conciliação. */
export function declinedInShift(payments: readonly Payment[], period: ShiftPeriod = currentShiftPeriod()): Payment[] {
  return payments.filter((p) => p.status === 'DECLINED' && inShiftPeriod(p.created_at, period));
}

export interface WaiterRow {
  waiter: StaffUser;
  itemsSold: number;
  sales: number;
  commission: number;
}

/**
 * Rateio de garçons: para cada comanda FECHADA, a taxa de serviço efetivamente
 * cobrada é distribuída entre os garçons proporcionalmente ao valor que cada
 * um lançou (maiores restos → Σ comissões == Σ taxas, sem perder centavo).
 */
export function waiterSplit(orders: readonly Order[], items: readonly OrderItem[], staff: readonly StaffUser[], period: ShiftPeriod = currentShiftPeriod()): WaiterRow[] {
  const sales = new Map<string, { cents: number; qty: number; commission: number }>();
  const bump = (id: string) => {
    if (!sales.has(id)) sales.set(id, { cents: 0, qty: 0, commission: 0 });
    return sales.get(id)!;
  };
  for (const o of orders) {
    // Só contas fechadas dentro do turno [start, end) entram no rateio.
    if (o.status !== 'CLOSED' || o.closed_at === null || !inShiftPeriod(o.closed_at, period)) continue;
    const valid = items.filter((i) => i.order_id === o.id && i.status !== 'CANCELED');
    const perWaiter = new Map<string, number>();
    for (const i of valid) {
      perWaiter.set(i.waiter_id, (perWaiter.get(i.waiter_id) ?? 0) + toCents(i.total_item_price));
      const row = bump(i.waiter_id);
      row.cents += toCents(i.total_item_price);
      row.qty += i.quantity;
    }
    const ids = [...perWaiter.keys()];
    const shares = allocateCents(toCents(o.service_fee_amount), ids.map((id) => perWaiter.get(id)!));
    ids.forEach((id, idx) => {
      bump(id).commission += shares[idx]!;
    });
  }
  return [...sales.entries()]
    .map(([id, v]) => ({
      waiter: staff.find((s) => s.id === id) ?? ({ id, name: 'Desconhecido' } as StaffUser),
      itemsSold: v.qty,
      sales: fromCents(v.cents),
      commission: fromCents(v.commission),
    }))
    .sort((a, b) => b.sales - a.sales);
}

export const AUDIT_LABEL: Record<AuditLog['action_type'], string> = {
  ITEM_CANCELED: 'Cancelamento de item',
  SERVICE_FEE_REMOVED: 'Remoção dos 10%',
  SERVICE_FEE_RESTORED: 'Reativação dos 10%',
  DISCOUNT_APPLIED: 'Desconto aplicado',
  MANAGER_PIN_FAILED: 'PIN de gerente incorreto',
  MANAGER_PIN_LOCKOUT: 'PIN bloqueado (3 erros)',
  KEG_CHANGED: 'Troca de barril de chopp',
  CASHBACK_REDEEMED: 'Cashback resgatado',
  CASHBACK_REFUNDED: 'Cashback devolvido ao cliente',
  CASHBACK_REFUND_HELD: 'Cashback a devolver retido para conciliação (origem não comprovada)',
  KIOSK_EXIT: 'Totem fechado',
  CHARGE_CONFIRMED_MANUALLY: 'Cobrança incerta registrada pelo comprovante',
  PRODUCT_PRICE_CHANGED: 'Preço alterado no cadastro',
  STAFF_CREATED: 'Pessoa cadastrada na equipe',
  STAFF_PIN_CHANGED: 'PIN trocado',
  STAFF_ROLE_CHANGED: 'Perfil alterado',
  STAFF_DEACTIVATED: 'Acesso desativado',
  STAFF_REACTIVATED: 'Acesso reativado',
  PERMISSION_CHANGED: 'Permissão alterada',
  STORE_RESET: 'Loja nova iniciada no aparelho',
  CASH_WITHDRAWAL: 'Sangria do caixa',
  CASH_CLOSE_DIFFERENCE: 'Caixa fechado com diferença',
  PRICE_OVERRIDE: 'Preço diferente do cadastro aceito pelo gerente',
};

/** Texto do alerta enviado ao WhatsApp do proprietário. */
export function whatsappAlertText(log: AuditLog, staff: readonly StaffUser[], tables: readonly DiningTable[], orders: readonly Order[]): string {
  const waiter = staff.find((s) => s.id === log.performed_by_user_id)?.name ?? '?';
  const manager = log.authorized_by_manager_id ? staff.find((s) => s.id === log.authorized_by_manager_id)?.name ?? '?' : '— (sem autorização)';
  const order = orders.find((o) => o.id === log.order_id);
  const table = (log.metadata?.table as string | undefined) ?? tables.find((t) => t.id === order?.table_id)?.label ?? '?';
  const impact = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(log.amount_impact);
  const hour = new Date(log.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const product = log.metadata?.product_name ? `\n🍖 Item: ${String(log.metadata.quantity ?? '')}x ${String(log.metadata.product_name)}` : '';
  const receipt = log.metadata?.nsu ? `\n🧾 NSU ${String(log.metadata.nsu)} · AUT ${String(log.metadata.authorization_code ?? '')}` : '';
  return `🚨 *Tchê Food — Alerta Anti-Fraude*\n⏰ ${hour} · 🪑 ${table}\n📌 ${AUDIT_LABEL[log.action_type]}${product}${receipt}\n🙋 Garçom: ${waiter}\n🔐 Autorizado por: ${manager}\n💰 Impacto: ${impact}\n📝 Motivo: "${log.reason}"`;
}
