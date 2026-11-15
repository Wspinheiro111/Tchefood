/**
 * Relatórios da Retaguarda Executiva (Fase 4). Funções puras sobre o estado.
 */
import type { AuditLog, DiningTable, Order, OrderItem, Payment, StaffUser } from '../types';
import { allocateCents, fromCents, toCents } from './money';
import type { ListPointPaymentsInput, ListPointPaymentsResult, ListPointRefundsInput, ServerPointPayment } from './payments/pointPaymentsServer';

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

/** Centavos baixados de um registro ORDER_REFUNDED_WRITE_OFF: `metadata.written_off_cents`, senão |amount_impact|. */
export function writeOffCents(l: AuditLog): number {
  const c = (l.metadata as Record<string, unknown> | null)?.written_off_cents;
  if (typeof c === 'number' && Number.isSafeInteger(c) && c >= 0) return c;
  const v = Math.abs(toCents(l.amount_impact));
  return Number.isFinite(v) ? v : 0;
}

/**
 * Conta encerrada pelo gerente como venda devolvida: centavos baixados por conta (ORDER_REFUNDED_WRITE_OFF). O valor
 * baixado foi estornado e não é venda; só o que ficou pago conta. Mais de um registro da mesma conta: vale o maior.
 */
export function writeOffsByOrder(logs: readonly AuditLog[] | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of logs ?? []) {
    if (l.action_type !== 'ORDER_REFUNDED_WRITE_OFF' || !l.order_id) continue;
    out.set(l.order_id, Math.max(out.get(l.order_id) ?? 0, writeOffCents(l)));
  }
  return out;
}

/** Centavos da conta que seguem vendidos depois da baixa (total − baixado, nunca negativo); sem baixa, o total. */
export function keptSaleCents(o: Order, writeOffs: ReadonlyMap<string, number>): { totalCents: number; keptCents: number; writtenOff: boolean } {
  const totalCents = toCents(o.total_amount);
  const w = writeOffs.get(o.id);
  if (w === undefined || w <= 0) return { totalCents, keptCents: totalCents, writtenOff: false };
  return { totalCents, keptCents: Math.max(0, totalCents - w), writtenOff: true };
}

/** `cents` na proporção do que ficou vendido da conta. */
export function scaleToKept(cents: number, kept: { totalCents: number; keptCents: number; writtenOff: boolean }): number {
  if (!kept.writtenOff) return cents;
  if (kept.totalCents <= 0 || kept.keptCents <= 0) return 0;
  return Math.round((cents * kept.keptCents) / kept.totalCents);
}

/**
 * KPIs do turno: faturamento, contas fechadas, ticket médio e 10% contam só o
 * que aconteceu no turno; o saldo em aberto no salão é sempre o atual. Com um
 * `ShiftPeriod`, usa o mesmo filtro [início, fim) da conciliação e do rateio;
 * com um `Date`, conta desde ele (comportamento anterior). Com `logs`, a conta encerrada como venda devolvida
 * (ORDER_REFUNDED_WRITE_OFF) conta só a parte que ficou paga no ticket médio; baixada por inteiro não é conta fechada.
 */
export function shiftKpis(orders: readonly Order[], payments: readonly Payment[], since: Date | ShiftPeriod = shiftStart(), logs?: readonly AuditLog[]): ShiftKpis {
  const inShift =
    since instanceof Date
      ? (iso: string | null) => iso !== null && new Date(iso).getTime() >= since.getTime()
      : (iso: string | null) => inShiftPeriod(iso, since);
  const approved = payments.filter((p) => p.status === 'APPROVED' && inShift(p.created_at));
  const grossCents = approved.reduce((a, p) => a + toCents(p.amount), 0);
  // Venda devolvida encerrada pelo gerente: só o que ficou pago; baixada por inteiro não é conta fechada. Os 10%
  // seguem a mesma regra do rateio (GPT r11 P2-04): baixa integral não soma taxa; parcial, na proporção do que ficou pago.
  const writeOffs = writeOffsByOrder(logs);
  const closedAll = orders
    .filter((o) => o.status === 'CLOSED' && inShift(o.closed_at))
    .map((o) => ({ o, kept: keptSaleCents(o, writeOffs) }));
  const feeCents = closedAll.reduce((a, { o, kept }) => a + scaleToKept(toCents(o.service_fee_amount), kept), 0);
  const closed = closedAll.filter(({ kept }) => !kept.writtenOff || kept.keptCents > 0);
  const closedTotalCents = closed.reduce((a, { kept }) => a + kept.keptCents, 0);
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

export type ReconKey = 'STONE' | 'PAGBANK' | 'MERCADO_PAGO' | 'CASH_DESK';
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
    MERCADO_PAGO: { acquirer: 'MERCADO_PAGO', cnpj: '10573521000191', byMethod: { CREDIT: 0, DEBIT: 0, PIX: 0, CASH: 0, VOUCHER: 0 }, total: 0, count: 0 },
    CASH_DESK: { acquirer: 'CASH_DESK', cnpj: null, byMethod: { CREDIT: 0, DEBIT: 0, PIX: 0, CASH: 0, VOUCHER: 0 }, total: 0, count: 0 },
  };
  const cents: Record<ReconKey, Record<ReconMethod, number>> = {
    STONE: { CREDIT: 0, DEBIT: 0, PIX: 0, CASH: 0, VOUCHER: 0 },
    PAGBANK: { CREDIT: 0, DEBIT: 0, PIX: 0, CASH: 0, VOUCHER: 0 },
    MERCADO_PAGO: { CREDIT: 0, DEBIT: 0, PIX: 0, CASH: 0, VOUCHER: 0 },
    CASH_DESK: { CREDIT: 0, DEBIT: 0, PIX: 0, CASH: 0, VOUCHER: 0 },
  };
  for (const p of payments) {
    if (p.status !== 'APPROVED' || !inShiftPeriod(p.created_at, period)) continue;
    const key: ReconKey = p.acquirer === 'STONE' || p.acquirer === 'PAGBANK' || p.acquirer === 'MERCADO_PAGO' ? p.acquirer : 'CASH_DESK';
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
  // Linha do Mercado Pago só quando houve venda na Point (lojas sem Point veem o mesmo de antes).
  return rows.MERCADO_PAGO.count > 0 ? [rows.STONE, rows.PAGBANK, rows.MERCADO_PAGO, rows.CASH_DESK] : [rows.STONE, rows.PAGBANK, rows.CASH_DESK];
}

/**
 * @deprecated A tela de conciliação usa `reconciliationMovements` (auditoria GPT r10, P2-02: a hora do registro
 * local e a hora da venda não são a data do estorno). Fica só para quem ainda chama.
 *
 * Estornos do Mercado Pago no turno (auditoria interna 2, P2-E): pagamentos da Point estornados, pela hora do registro
 * do estorno neste aparelho (audit_logs POINT_PAYMENT_REFUNDED) ou, sem ele, pela hora da venda. O extrato do Mercado
 * Pago mostra a venda e o estorno; a linha "Mercado Pago" da conciliação já não conta o estornado.
 */
export function pointRefundsInShift(payments: readonly Payment[], logs: readonly AuditLog[], period: ShiftPeriod = currentShiftPeriod()): { total: number; count: number } {
  const refundedAt = new Map<string, string>();
  for (const l of logs) {
    const id = l.action_type === 'POINT_PAYMENT_REFUNDED' ? (l.metadata as Record<string, unknown> | null)?.payment_id : null;
    if (typeof id === 'string' && !refundedAt.has(id)) refundedAt.set(id, l.created_at);
  }
  let cents = 0;
  let count = 0;
  for (const p of payments) {
    if (p.acquirer !== 'MERCADO_PAGO' || p.status !== 'REFUNDED') continue;
    if (!inShiftPeriod(refundedAt.get(p.id) ?? p.created_at, period)) continue;
    cents += toCents(p.amount);
    count += 1;
  }
  return { total: fromCents(cents), count };
}

/** Bruto (vendas), estornos e líquido de uma célula da conciliação. */
export interface MovementCell {
  gross: number;
  refunds: number;
  net: number;
}

export interface MovementRow {
  acquirer: ReconKey;
  cnpj: string | null;
  byMethod: Record<ReconMethod, MovementCell>;
  gross: number;
  refunds: number;
  net: number;
  salesCount: number;
  refundsCount: number;
}

/** Pagamento com estorno sem data confirmada (deste aparelho ou só do servidor). */
export interface UndatedRefund {
  id: string;
  created_at: string;
  acquirer: ReconKey;
  nsu: string | null;
  amount: number;
}

export interface ReconMovements {
  rows: MovementRow[];
  totals: { gross: number; refunds: number; net: number; salesCount: number; refundsCount: number };
  /** Estornos sem data confirmada pelo servidor: não entram em turno nenhum (nem no da venda). */
  undatedRefunds: { total: number; count: number; payments: UndatedRefund[] };
  /** LOADED: datas de estorno do servidor lidas para o período; NOT_LOADED: sem leitura (fora da nuvem, erro, prazo). */
  cloudRefunds: 'LOADED' | 'NOT_LOADED';
  /** Vendas devolvidas encerradas pelo gerente (ORDER_REFUNDED_WRITE_OFF) no período: o saldo baixado. */
  writeOffs: { total: number; count: number };
}

const ACQUIRER_CNPJ: Record<ReconKey, string | null> = { STONE: '16501555000157', PAGBANK: '08561701000101', MERCADO_PAGO: '10573521000191', CASH_DESK: null };
const reconKey = (p: Payment): ReconKey => (p.acquirer === 'STONE' || p.acquirer === 'PAGBANK' || p.acquirer === 'MERCADO_PAGO' ? p.acquirer : 'CASH_DESK');

/**
 * Conciliação por movimento (auditoria GPT r10 P2-01/P2-02 e r11 P2-01/P2-03). Venda e estorno são movimentos
 * separados, cada um com a sua data, como no extrato da adquirente:
 *  - venda: pagamento APROVADO ou ESTORNADO, no período da venda (created_at), qualquer que seja o status de hoje.
 *    Pagamento retirado pelo gerente ("não aceito pela nuvem", `withdrawn_reason`) nunca foi recebido: fica de fora;
 *  - estorno: no período da data do estorno no servidor (`refunded_at`), qualquer que seja a idade da venda.
 * `serverPayments` (de loadServerPointPayments) traz, do servidor, TODOS os pagamentos da Point feitos no período e
 * TODOS os estornos da Point feitos no período. Pagamento que só o servidor tem (feito ou estornado em outro aparelho)
 * entra também, uma vez só (mesmo id do pagamento em todos os aparelhos).
 * Estorno sem data confirmada (`undatedRefunds`, nunca no período da venda nem na hora do registro deste aparelho):
 *  - sem leitura da nuvem: todo estornado deste aparelho com venda anterior ao fim do período;
 *  - com leitura: o servidor diz estornado sem data válida, ou o estornado daqui com venda no período não está no
 *    servidor (ainda não subiu). Estornado daqui com venda antiga e fora da lista do servidor foi estornado em outro
 *    período (a lista de estornos do período o traria): não entra.
 */
export function reconciliationMovements(
  payments: readonly Payment[],
  period: ShiftPeriod = currentShiftPeriod(),
  opts: { serverPayments?: readonly ServerPointPayment[] | null; logs?: readonly AuditLog[] } = {},
): ReconMovements {
  const keys: ReconKey[] = ['STONE', 'PAGBANK', 'MERCADO_PAGO', 'CASH_DESK'];
  const methods: ReconMethod[] = ['CREDIT', 'DEBIT', 'PIX', 'CASH', 'VOUCHER'];
  const zero = () => Object.fromEntries(methods.map((m) => [m, 0])) as Record<ReconMethod, number>;
  const sales = Object.fromEntries(keys.map((k) => [k, zero()])) as Record<ReconKey, Record<ReconMethod, number>>;
  const refunds = Object.fromEntries(keys.map((k) => [k, zero()])) as Record<ReconKey, Record<ReconMethod, number>>;
  const counts = Object.fromEntries(keys.map((k) => [k, { sales: 0, refunds: 0 }])) as Record<ReconKey, { sales: number; refunds: number }>;
  const server = new Map<string, ServerPointPayment>();
  for (const r of opts.serverPayments ?? []) {
    const prev = server.get(r.payment_id);
    // A mesma linha pode vir das duas leituras (venda do período estornada no período): fica a que tem a data do estorno.
    if (!prev || (prev.refunded_at === null && r.refunded_at !== null)) server.set(r.payment_id, r);
  }
  const loaded = opts.serverPayments !== null && opts.serverPayments !== undefined;
  const startMs = period.start.getTime();
  const endMs = period.end.getTime();
  const undated: UndatedRefund[] = [];
  let undatedCents = 0;
  const visit = (m: { id: string; acquirer: ReconKey; method: ReconMethod; cents: number; createdAt: string; nsu: string | null; amount: number; refundedHere: boolean }) => {
    const k = m.acquirer;
    if (inShiftPeriod(m.createdAt, period)) {
      sales[k][m.method] += m.cents;
      counts[k].sales += 1;
    }
    const s = server.get(m.id);
    const refunded = m.refundedHere || s?.status === 'REFUNDED' || (s?.refunded_at ?? null) !== null;
    if (!refunded) return;
    const refundedAt = parseIsoInstant(s?.refunded_at ?? null);
    if (refundedAt !== null) {
      if (refundedAt >= startMs && refundedAt < endMs) {
        refunds[k][m.method] += m.cents;
        counts[k].refunds += 1;
      }
      return;
    }
    const sold = parseIsoInstant(m.createdAt);
    if (sold === null || sold >= endMs) return;
    // Com a leitura da nuvem, estornado daqui de venda antiga que o servidor não listou: estorno de outro período.
    if (loaded && !s && sold < startMs) return;
    undated.push({ id: m.id, created_at: m.createdAt, acquirer: k, nsu: m.nsu, amount: m.amount });
    undatedCents += m.cents;
  };
  const here = new Set<string>();
  for (const p of payments) {
    here.add(p.id);
    if (p.withdrawn_reason !== undefined) continue;
    if (p.status !== 'APPROVED' && p.status !== 'REFUNDED') continue;
    visit({ id: p.id, acquirer: reconKey(p), method: p.method, cents: toCents(p.amount), createdAt: p.created_at, nsu: p.nsu, amount: p.amount, refundedHere: p.status === 'REFUNDED' });
  }
  // Pagamento da Point que só o servidor tem (outro aparelho): entra uma vez, pelo id.
  for (const r of server.values()) {
    if (here.has(r.payment_id)) continue;
    if (r.status !== 'APPROVED' && r.status !== 'REFUNDED') continue;
    if (!(methods as string[]).includes(r.method)) continue;
    visit({ id: r.payment_id, acquirer: 'MERCADO_PAGO', method: r.method as ReconMethod, cents: toCents(r.amount), createdAt: r.created_at, nsu: r.nsu, amount: r.amount, refundedHere: false });
  }
  const rows: Record<ReconKey, MovementRow> = {} as Record<ReconKey, MovementRow>;
  const tot = { gross: 0, refunds: 0, salesCount: 0, refundsCount: 0 };
  for (const k of keys) {
    let g = 0;
    let r = 0;
    const byMethod = {} as Record<ReconMethod, MovementCell>;
    for (const m of methods) {
      byMethod[m] = { gross: fromCents(sales[k][m]), refunds: fromCents(refunds[k][m]), net: fromCents(sales[k][m] - refunds[k][m]) };
      g += sales[k][m];
      r += refunds[k][m];
    }
    rows[k] = { acquirer: k, cnpj: ACQUIRER_CNPJ[k], byMethod, gross: fromCents(g), refunds: fromCents(r), net: fromCents(g - r), salesCount: counts[k].sales, refundsCount: counts[k].refunds };
    tot.gross += g;
    tot.refunds += r;
    tot.salesCount += counts[k].sales;
    tot.refundsCount += counts[k].refunds;
  }
  let woCents = 0;
  let woCount = 0;
  for (const l of opts.logs ?? []) {
    if (l.action_type !== 'ORDER_REFUNDED_WRITE_OFF' || !inShiftPeriod(l.created_at, period)) continue;
    woCents += writeOffCents(l);
    woCount += 1;
  }
  // Linha do Mercado Pago só quando houve venda ou estorno na Point no período.
  const mp = rows.MERCADO_PAGO.salesCount + rows.MERCADO_PAGO.refundsCount > 0;
  return {
    rows: mp ? [rows.STONE, rows.PAGBANK, rows.MERCADO_PAGO, rows.CASH_DESK] : [rows.STONE, rows.PAGBANK, rows.CASH_DESK],
    totals: { gross: fromCents(tot.gross), refunds: fromCents(tot.refunds), net: fromCents(tot.gross - tot.refunds), salesCount: tot.salesCount, refundsCount: tot.refundsCount },
    undatedRefunds: { total: fromCents(undatedCents), count: undated.length, payments: undated },
    cloudRefunds: loaded ? 'LOADED' : 'NOT_LOADED',
    writeOffs: { total: fromCents(woCents), count: woCount },
  };
}

const SERVER_REFUND_MAX_PAGES = 50;

async function allPages(
  load: (cursor: string | null) => Promise<ListPointPaymentsResult>,
  what: string,
): Promise<ServerPointPayment[]> {
  const out: ServerPointPayment[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < SERVER_REFUND_MAX_PAGES; page += 1) {
    const r = await load(cursor);
    if (r.kind !== 'ok') throw new Error(r.error);
    out.push(...r.items);
    if (r.nextCursor === null) return out;
    cursor = r.nextCursor;
  }
  throw new Error(`${what} do servidor: mais de ${SERVER_REFUND_MAX_PAGES} páginas no período.`);
}

/**
 * Movimentos da Point no servidor para o período, todas as páginas (auditoria GPT r11 P2-01):
 *  - vendas: tchefood_list_point_payments com a venda (created_at) no período;
 *  - estornos: tchefood_list_point_refunds com o estorno (hora do servidor) no período, qualquer que seja a idade da venda.
 * Qualquer página com erro (rede, prazo, resposta estranha) lança: a conciliação mostra "estornos da nuvem não
 * carregados" em vez de uma lista pela metade.
 */
export async function loadServerPointPayments(
  period: ShiftPeriod,
  list: (input: ListPointPaymentsInput) => Promise<ListPointPaymentsResult>,
  listRefunds: (input: ListPointRefundsInput) => Promise<ListPointPaymentsResult>,
): Promise<ServerPointPayment[]> {
  const from = period.start.toISOString();
  const to = period.end.toISOString();
  const [sold, refunded] = await Promise.all([
    allPages((cursor) => list({ from, to, search: null, cursor, limit: 200 }), 'Pagamentos da Point'),
    allPages((cursor) => listRefunds({ from, to, cursor, limit: 200 }), 'Estornos da Point'),
  ]);
  return [...sold, ...refunded];
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
export function waiterSplit(orders: readonly Order[], items: readonly OrderItem[], staff: readonly StaffUser[], period: ShiftPeriod = currentShiftPeriod(), logs?: readonly AuditLog[]): WaiterRow[] {
  const sales = new Map<string, { cents: number; qty: number; commission: number }>();
  const bump = (id: string) => {
    if (!sales.has(id)) sales.set(id, { cents: 0, qty: 0, commission: 0 });
    return sales.get(id)!;
  };
  const writeOffs = writeOffsByOrder(logs);
  for (const o of orders) {
    // Só contas fechadas dentro do turno [start, end) entram no rateio.
    if (o.status !== 'CLOSED' || o.closed_at === null || !inShiftPeriod(o.closed_at, period)) continue;
    // Venda devolvida encerrada pelo gerente: baixada por inteiro não entra; em parte, só a proporção que ficou paga.
    const kept = keptSaleCents(o, writeOffs);
    if (kept.writtenOff && kept.keptCents <= 0) continue;
    const valid = items.filter((i) => i.order_id === o.id && i.status !== 'CANCELED');
    const perWaiter = new Map<string, number>();
    for (const i of valid) {
      perWaiter.set(i.waiter_id, (perWaiter.get(i.waiter_id) ?? 0) + toCents(i.total_item_price));
      bump(i.waiter_id).qty += i.quantity;
    }
    const ids = [...perWaiter.keys()];
    const weights = ids.map((id) => perWaiter.get(id)!);
    const soldShares = kept.writtenOff ? allocateCents(scaleToKept(weights.reduce((a, b) => a + b, 0), kept), weights) : weights;
    const shares = allocateCents(scaleToKept(toCents(o.service_fee_amount), kept), weights);
    ids.forEach((id, idx) => {
      const row = bump(id);
      row.cents += soldShares[idx]!;
      row.commission += shares[idx]!;
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
  CLAIM_RELEASED_REFUNDED: 'Reserva liberada com a maquininha aprovada: estornado na maquininha',
  POINT_PAYMENT_REFUNDED: 'Pagamento da Point estornado (confirmado no Mercado Pago)',
  ORDER_REFUNDED_WRITE_OFF: 'Conta encerrada como venda devolvida (saldo baixado)',
  NFCE_ALREADY_ISSUED: 'NFC-e já emitida para esta venda (pagamento mudou)',
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
