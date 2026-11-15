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
import { feeCents, MAX_FEE_DAYS, ruleFor, type FeeRule } from './cardFees';
import { fromCents, toCents } from './money';
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

/**
 * Instante do registro em ms, ou null se a data for inválida, sem fuso ou fora de
 * 2000–2100 (ex.: relógio do aparelho zerado em 1970): nesse caso não dá para saber o
 * ano, e o registro é contado como data inválida (nunca some calado).
 */
let RANGE: [number, number] | null = null;
const inRange = (t: number): boolean => {
  RANGE ??= [brasiliaInstant(MIN_YEAR, 0, 1, 0), brasiliaInstant(MAX_YEAR + 1, 0, 1, 0)];
  return t >= RANGE[0] && t < RANGE[1];
};
const at = (iso: string | null | undefined): number | null => {
  const t = parseIsoInstant(iso);
  return t !== null && inRange(t) ? t : null;
};

/**
 * Data de emissão da NF-e: dhEmi (com fuso) ou dEmi (só a data, NF-e antiga). A data
 * sozinha é um dia do calendário de Brasília: vale o começo daquele dia, para que uma
 * nota de hoje entre no relatório do ano em andamento a qualquer hora (com 12:00, de
 * manhã ela ficava "depois do instante do relatório"). Nos dias em que o horário de verão
 * antigo pulava a meia-noite, vale 01:00, que ainda é o mesmo dia.
 */
/**
 * 00:00 do dia (y, m de 0 a 11, d) no calendário de Brasília. Nos dias em que o horário
 * de verão antigo pulava a meia-noite, 01:00 (o primeiro instante daquele dia). Aceita
 * d fora do mês (31/12 + 1 = 01/01), como Date.UTC.
 */
export function brasiliaDayStart(y: number, m: number, d: number): number {
  const day = new Date(Date.UTC(y, m, d));
  const [yy, mm, dd] = [day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()];
  const t = brasiliaInstant(yy, mm, dd, 0);
  const got = brasiliaYmd(t);
  return got.y === yy && got.m === mm && got.d === dd ? t : brasiliaInstant(yy, mm, dd, 1);
}

export function invoiceDate(iso: string | null | undefined): number | null {
  if (typeof iso === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (m) {
      const y = Number(m[1]);
      const mo = Number(m[2]);
      const d = Number(m[3]);
      if (mo < 1 || mo > 12 || d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return null;
      const t = brasiliaDayStart(y, mo - 1, d);
      return inRange(t) ? t : null;
    }
  }
  return at(iso);
}

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

// Com segundos: o corte do ano em andamento é o instante exato da tela.
const HM = new Intl.DateTimeFormat('pt-BR', { timeZone: SHIFT_TIME_ZONE, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

/** "dd/mm/aaaa hh:mm:ss" no horário de Brasília. */
export function brasiliaDateTime(t: number | Date): string {
  return `${brasiliaDate(t)} ${HM.format(new Date(t))}`;
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
  // Ano sem movimento no meio também tem posição (estoque e contas que vêm de antes):
  // do primeiro ano com dados até o mais novo, sem buracos.
  if (set.size > 0) {
    const max = Math.max(...set);
    for (let y = Math.min(...set); y < max; y += 1) set.add(y);
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

/** O ano está em andamento (já começou e não terminou): a "posição em 31/12" é a posição de agora. */
export function yearInProgress(p: YearPeriod, now: Date = new Date()): boolean {
  const t = now.getTime();
  return t >= p.from && t < p.to;
}

/**
 * Relógio do aparelho antes do início do ano escolhido (ano com dados, mas que pelo
 * relógio nem começou): o relógio está errado. O relatório vale para o ano inteiro e a
 * tela avisa.
 */
export function clockBeforeYear(p: YearPeriod, now: Date = new Date()): boolean {
  return !(now.getTime() >= p.from);
}

/** Até onde vale a "posição": agora, se o ano está em andamento; senão, o fim do ano. */
export function positionCutoff(p: YearPeriod, now: Date = new Date()): number {
  return yearInProgress(p, now) ? now.getTime() : p.to;
}

/**
 * Registro com data no instante do relatório ou depois, inclusive em anos futuros (só
 * acontece com o ano em andamento: lançado depois de a tela abrir, ou relógio do aparelho
 * errado). Fica fora dos números e é contado para o aviso. Ano encerrado: o corte é
 * 01/01 seguinte e nada conta (o que vem depois é de outro ano).
 */
const afterCutoff = (t: number, p: YearPeriod, cutoff: number): boolean => cutoff < p.to && t >= cutoff;

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
  return brasiliaDayStart(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
}

/**
 * Fim do dia do repasse: o começo do dia SEGUINTE no calendário de Brasília (não 24 h
 * depois, porque com o horário de verão antigo o dia teve 23 ou 25 horas).
 */
export function settlementDayEndBrasilia(createdAtMs: number, rule: Pick<FeeRule, 'days' | 'businessDays'>): number {
  const { y, m, d } = brasiliaYmd(settlementDayBrasilia(createdAtMs, rule));
  return brasiliaDayStart(y, m, d + 1);
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
  /** Entradas deste aparelho no livro de estoque até a posição (soma das quantidades). */
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
  /** Entradas de NF-e que a nuvem já tem por outro aparelho (fora, para não somar duas vezes). */
  duplicateMovements: number;
  /** NF-e repetidas cujas entradas ficaram neste inventário sem prova de duplicata (conferir). */
  duplicateUnconfirmed: number;
  /** Instante da posição: fim do ano, ou agora se o ano ainda não terminou. */
  cutoff: number;
  /** Movimentos do ano com data no instante da posição ou depois (ficaram de fora). */
  afterCutoff: number;
}

/**
 * Só os registros da loja deste aparelho. Ligar o aparelho a outra loja (ou zerar) nem
 * sempre apaga tudo o que era da anterior: o que tem tenant_id de outra loja fica fora
 * e é contado para o aviso. Registro sem tenant_id também fica fora (e é contado): todo
 * registro que o app grava leva a loja, então um sem loja tem origem desconhecida e não
 * pode entrar nos números desta loja.
 */
export function ownStore<T extends { tenant_id?: string | null }>(rows: readonly T[], tenantId: string): { rows: T[]; other: number } {
  const out: T[] = [];
  let other = 0;
  for (const r of rows) {
    if (r.tenant_id !== tenantId) other += 1;
    else out.push(r);
  }
  return { rows: out, other };
}

type InvoiceCopy = Pick<PurchaseInvoice, 'id' | 'access_key'> & Partial<Pick<PurchaseInvoice, 'imported_at' | 'environment' | 'issued_at'>>;

/**
 * Ordem única das cópias da mesma NF-e (mesma chave), usada pelo inventário e pelas
 * compras: produção antes de homologação, com data de emissão válida antes de sem data,
 * importada primeiro, e por fim o id (para não depender da ordem da lista).
 */
export function compareInvoiceCopies(a: InvoiceCopy, b: InvoiceCopy): number {
  const prod = (c: InvoiceCopy) => (c.environment === undefined || c.environment === 'PRODUCTION' ? 0 : 1);
  const dated = (c: InvoiceCopy) => (c.issued_at === undefined || invoiceDate(c.issued_at) !== null ? 0 : 1);
  const imp = (c: InvoiceCopy) => at(c.imported_at) ?? Infinity;
  return prod(a) - prod(b) || dated(a) - dated(b) || (imp(a) === imp(b) ? 0 : imp(a) < imp(b) ? -1 : 1) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Ids das NF-e deste aparelho cujo envio à nuvem foi recusado (fila de recusados). */
export function rejectedInvoiceIds(rejected: ReadonlyArray<{ event: { table: string; op: string; row_id: string } }>): Set<string> {
  return new Set(rejected.filter((r) => r.event.table === 'purchase_invoices' && r.event.op === 'INSERT').map((r) => r.event.row_id));
}

export interface DuplicateInvoiceReview {
  /** Entradas que ficam fora do inventário deste aparelho. */
  excluded: Set<string>;
  /** Por NF-e repetida sem prova de duplicata: as entradas deste aparelho que ficaram. */
  unconfirmed: string[][];
}

/**
 * NF-e que está neste aparelho mais de uma vez (mesma chave de acesso). A importação
 * grava nota, itens e entradas de uma vez e recusa chave repetida no aparelho, então a
 * outra cópia só chega pela nuvem (importada em OUTRO aparelho, que tem as entradas
 * dela). As entradas deste aparelho só saem com prova: a nuvem RECUSOU a nota deste
 * aparelho (está na fila de recusados), ou seja, a mercadoria já foi lançada pela cópia
 * aceita. Sem essa prova, as entradas ficam e a nota é avisada para conferir.
 * Se mais de uma cópia não recusada tem entradas aqui, vale a primeira pela mesma ordem
 * das compras (compareInvoiceCopies) e as outras saem. Nunca zero sem prova, nunca em dobro.
 */
export function reviewDuplicateInvoices(
  movements: readonly StockMovement[],
  items: ReadonlyArray<Pick<PurchaseInvoiceItem, 'id' | 'invoice_id'>>,
  invoices: readonly InvoiceCopy[],
  rejectedIds: ReadonlySet<string> = new Set(),
): DuplicateInvoiceReview {
  const byKey = new Map<string, InvoiceCopy[]>();
  for (const i of invoices) {
    const k = (i.access_key ?? '').trim();
    if (k === '') continue;
    const list = byKey.get(k) ?? [];
    list.push(i);
    byKey.set(k, list);
  }
  const excluded = new Set<string>();
  const unconfirmed: string[][] = [];
  if (![...byKey.values()].some((l) => l.length > 1)) return { excluded, unconfirmed };
  const itemInvoice = new Map(items.map((i) => [i.id, i.invoice_id]));
  const movesByInvoice = new Map<string, string[]>();
  for (const m of movements) {
    const inv = m.purchase_invoice_item_id ? itemInvoice.get(m.purchase_invoice_item_id) : undefined;
    if (inv === undefined) continue;
    const list = movesByInvoice.get(inv) ?? [];
    list.push(m.id);
    movesByInvoice.set(inv, list);
  }
  for (const copies of byKey.values()) {
    if (copies.length < 2) continue;
    const withMoves = copies.filter((c) => (movesByInvoice.get(c.id)?.length ?? 0) > 0).sort(compareInvoiceCopies);
    const candidates = withMoves.filter((c) => !rejectedIds.has(c.id));
    const keep = candidates[0]?.id ?? null;
    for (const c of withMoves) {
      if (c.id === keep) continue;
      for (const id of movesByInvoice.get(c.id) ?? []) excluded.add(id);
    }
    // Ficou uma cópia com entradas e há outra cópia sem entradas aqui: sem prova de que
    // a mercadoria já foi lançada em outro aparelho. Mantém e avisa.
    if (keep !== null && copies.some((c) => c.id !== keep && (movesByInvoice.get(c.id)?.length ?? 0) === 0)) unconfirmed.push(movesByInvoice.get(keep) ?? []);
  }
  return { excluded, unconfirmed };
}

/** Só as entradas que ficam fora (veja reviewDuplicateInvoices). */
export function duplicateInvoiceMovementIds(
  movements: readonly StockMovement[],
  items: ReadonlyArray<Pick<PurchaseInvoiceItem, 'id' | 'invoice_id'>>,
  invoices: readonly InvoiceCopy[],
  rejectedIds: ReadonlySet<string> = new Set(),
): Set<string> {
  return reviewDuplicateInvoices(movements, items, invoices, rejectedIds).excluded;
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

/**
 * Posição do estoque no fim do ano: para cada produto, a soma das entradas DESTE
 * aparelho no livro (stock_movements, só INSERT) até a posição, com o custo médio
 * ponderado delas. O app hoje só registra ENTRADA por nota de compra (PURCHASE_IN): as
 * vendas ainda não baixam o estoque, então este saldo é o que entrou, não o que sobrou
 * na prateleira. Entradas de NF-e de homologação ficam fora.
 */
export function inventoryAt(
  products: readonly Product[],
  movements: readonly StockMovement[],
  p: YearPeriod,
  testMovementIds: ReadonlySet<string> = new Set(),
  now: Date = new Date(),
  duplicateMovementIds: ReadonlySet<string> = new Set(),
  /** Grupos de reviewDuplicateInvoices().unconfirmed: o aviso só conta os que entraram no saldo. */
  duplicateUnconfirmed: ReadonlyArray<readonly string[]> = [],
): InventoryReport {
  const cutoff = positionCutoff(p, now);
  const byProduct = new Map<string, Array<{ t: number; m: StockMovement; idx: number }>>();
  let invalidDates = 0;
  let late = 0;
  movements.forEach((m, idx) => {
    const t = at(m.created_at);
    if (t === null) {
      invalidDates += 1;
      return;
    }
    if (afterCutoff(t, p, cutoff)) late += 1;
    if (t >= cutoff) return;
    const list = byProduct.get(m.product_id);
    if (list) list.push({ t, m, idx });
    else byProduct.set(m.product_id, [{ t, m, idx }]);
  });
  const byId = new Map(products.map((x) => [x.id, x]));
  const rows: InventoryRow[] = [];
  let totalC = 0;
  let missingNcm = 0;
  let testMovements = 0;
  const counted = new Set<string>();
  let duplicateMovements = 0;
  for (const [productId, list] of byProduct) {
    // Mesmo instante: vale o que foi gravado depois (ordem do livro).
    list.sort((a, b) => a.t - b.t || a.idx - b.idx);
    const tests = list.filter((x) => testMovementIds.has(x.m.id)).length;
    testMovements += tests;
    duplicateMovements += list.filter((x) => !testMovementIds.has(x.m.id) && duplicateMovementIds.has(x.m.id)).length;
    // Saldo e custo médio refeitos só com as entradas DESTE aparelho (o livro só tem
    // entradas, então a média ponderada é exata). O balance_after gravado parte do
    // estoque do produto que veio da nuvem (o da loja toda): usá-lo faria a soma dos
    // aparelhos contar o mesmo estoque duas vezes.
    let milli = 0;
    let costTimes = 0; // Σ quantidade(milésimos) × custo(décimos de milésimo)
    for (const { m } of list) {
      if (testMovementIds.has(m.id) || duplicateMovementIds.has(m.id)) continue;
      counted.add(m.id);
      const q = Math.round(m.quantity * 1000);
      milli += q;
      costTimes += q * Math.round(m.unit_cost * 10_000);
    }
    const qty = milli / 1000;
    const unitCost = milli > 0 ? Math.round(costTimes / milli) / 10_000 : 0;
    if (qty === 0) continue;
    const prod = byId.get(productId);
    // Total direto da soma exata das entradas (centavos só no fim); o custo médio de 4
    // casas é só para mostrar e não volta para o total.
    const totalCents = Math.round(costTimes / 100_000);
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
  return { rows, totalCost: fromCents(totalC), missingNcm, invalidDates, testMovements, duplicateMovements, duplicateUnconfirmed: duplicateUnconfirmed.filter((g) => g.some((id) => counted.has(id))).length, cutoff, afterCutoff: late };
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
  /**
   * Taxa de serviço das comandas fechadas, na proporção dos pagamentos reais delas que
   * caíram no período: está DENTRO do bruto (veio nos pagamentos). É gorjeta pela Lei 13.419/2017; o contador decide como tratar.
   */
  serviceFee: number;
  /** Bruto por mês (índice 0 = janeiro), por chave de linha. */
  monthly: Record<string, number[]>;
  monthlyTotal: number[];
  closings: CashClosingRow[];
  closingsDifference: number;
  supplies: number;
  withdrawals: number;
  /** Turnos de caixa abertos no ano que ainda não foram fechados. */
  /** Turnos de caixa abertos na posição (abertos antes do corte, de qualquer ano, e fechados só depois ou ainda abertos). */
  openSessions: number;
  /** Pagamentos aprovados e pedidos de app com data inválida (ficaram de fora). */
  invalidDates: number;
  /** Pagamentos do simulador de maquininha (MOCK) no ano: não são dinheiro real, ficam fora. */
  simulatorCount: number;
  simulatorAmount: number;
  /** Dinheiro recebido fora de qualquer turno de caixa (não aparece nos fechamentos). */
  cashOutsideSessions: number;
  cashOutsideSessionsCount: number;
  /** Fim do período: fim do ano, ou agora se o ano ainda não terminou. */
  cutoff: number;
  /** Pagamentos, pedidos de app, turnos e movimentos de caixa do ano com data no fim do período ou depois (ficaram de fora). */
  afterCutoff: number;
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
  /** Comandas (para a taxa de serviço, que vem dentro dos pagamentos). */
  orders?: ReadonlyArray<Pick<Order, 'id' | 'status' | 'service_fee_amount'>>;
}

/**
 * Faturamento do ano por forma: pagamentos APROVADOS (estornado e recusado ficam fora)
 * pela data do pagamento, mais os pedidos dos apps não cancelados pela data do pedido.
 * A taxa da maquininha incide sobre conta + gorjeta (igual à agenda de recebíveis).
 */
export function revenueByMethod(input: RevenueInput, p: YearPeriod, now: Date = new Date()): RevenueReport {
  const cutoff = positionCutoff(p, now);
  let late = 0;
  /** No período: do início do ano até o corte; conta o que caiu depois do corte. */
  const inPeriod = (t: number | null): t is number => {
    if (t === null) return false;
    if (afterCutoff(t, p, cutoff)) late += 1;
    return t >= p.from && t < cutoff;
  };
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
    if (!inPeriod(t)) continue;
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
    if (!inPeriod(t)) continue;
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
    // Turno aberto na posição: aberto antes do corte (de qualquer ano) e ainda aberto,
    // ou fechado só depois do corte (ex.: aberto em 31/12 e fechado em 01/01).
    const opened = at(s.opened_at);
    const closedT = s.status === 'CLOSED' ? at(s.closed_at) : null;
    if (opened !== null && opened < cutoff && (s.status !== 'CLOSED' || (closedT !== null && closedT >= cutoff))) openSessions += 1;
    if (s.status !== 'CLOSED') {
      // Turno aberto depois do instante do relatório: fica de fora e é avisado.
      if (opened !== null && afterCutoff(opened, p, cutoff)) late += 1;
      continue;
    }
    if (closedT === null) invalidDates += 1;
    if (!inPeriod(closedT)) continue;
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
    // Mesmos pagamentos do faturamento (já contados lá se ficaram depois do corte).
    if (t === null || t < p.from || t >= cutoff) continue;
    if (windows.some((w) => t >= w.from && t <= w.to)) continue;
    outsideC += toCents(pay.amount);
    outsideN += 1;
  }
  // Taxa de serviço das comandas fechadas, rateada pelos pagamentos REAIS (sem simulador)
  // que caíram no período: assim ela está mesmo dentro do bruto deste período.
  let serviceFeeC = 0;
  const feeOrders = new Map<string, number>();
  for (const o of input.orders ?? []) {
    if (o.status === 'CLOSED' && o.service_fee_amount > 0) feeOrders.set(o.id, toCents(o.service_fee_amount));
  }
  if (feeOrders.size > 0) {
    const paid = new Map<string, { all: number; inPeriod: number }>();
    for (const pay of input.payments) {
      if (pay.status !== 'APPROVED' || pay.acquirer === 'MOCK' || !feeOrders.has(pay.order_id)) continue;
      const t = at(pay.created_at);
      const c = toCents(pay.amount);
      const row = paid.get(pay.order_id) ?? { all: 0, inPeriod: 0 };
      row.all += c;
      if (t !== null && t >= p.from && t < cutoff) row.inPeriod += c;
      paid.set(pay.order_id, row);
    }
    for (const [id, x] of paid) {
      if (x.all > 0 && x.inPeriod > 0) serviceFeeC += Math.round((feeOrders.get(id)! * x.inPeriod) / x.all);
    }
  }
  let suppliesC = 0;
  let withdrawalsC = 0;
  for (const mv of input.cashMovements) {
    const mt = at(mv.created_at);
    if (mt === null) invalidDates += 1;
    if (!inPeriod(mt)) continue;
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
    serviceFee: fromCents(serviceFeeC),
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
    cutoff,
    afterCutoff: late,
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
  /**
   * Situação de repasse desconhecida: venda na maquininha (Stone/PagBank) até a posição
   * sem taxa cadastrada, de qualquer ano (venda de dezembro do ano anterior pode cair
   * depois da virada). Sem o prazo não dá para saber se já caiu ou ainda está a receber;
   * não entra no A receber. Total, incluindo os anos anteriores.
   */
  cardWithoutRule: number;
  cardWithoutRuleCount: number;
  /** Parte de cardWithoutRule/cardWithoutRuleCount com venda de anos anteriores ao escolhido. */
  cardWithoutRulePriorYears: number;
  cardWithoutRulePriorYearsCount: number;
  /** Entregas feitas até 31/12 e ainda não acertadas com o entregador naquela data. */
  courierPayables: CourierPayableRow[];
  courierPayablesTotal: number;
  /** Instante da posição: fim do ano, ou agora se o ano ainda não terminou. */
  cutoff: number;
  /** Entregas, pagamentos e acertos com data inválida (fora deste relatório e avisados). */
  invalidDates: number;
  /** Pagamentos, entregas e acertos do ano com data no instante da posição ou depois (ficaram de fora). */
  afterCutoff: number;
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
/**
 * Folga, em ms, depois da qual o repasse com certeza já caiu: prazo em dias corridos
 * (dias úteis viram corridos com os fins de semana) mais 2 dias de margem.
 */
const maxSettlementMs = (rule: Pick<FeeRule, 'days' | 'businessDays'>): number =>
  ((rule.businessDays ? Math.ceil((rule.days * 7) / 5) + 4 : rule.days) + 2) * DAY_MS;
/** Nenhuma taxa cadastrável passa de D+MAX_FEE_DAYS (úteis): venda mais antiga que isso já caiu. */
const ANY_RULE_SETTLED_MS = maxSettlementMs({ days: MAX_FEE_DAYS, businessDays: true });

export function openPositionsAt(input: OpenPositionsInput, p: YearPeriod, now: Date = new Date()): OpenPositionsReport {
  const cutoff = positionCutoff(p, now);
  const card = new Map<string, { acquirer: string; method: PaymentMethod; gross: number; fee: number; count: number }>();
  let noRuleC = 0;
  let noRuleCount = 0;
  let noRulePriorC = 0;
  let noRulePriorCount = 0;
  let invalidDates = 0;
  for (const pay of input.payments) {
    if (pay.status !== 'APPROVED' || pay.method === 'CASH') continue;
    const t = at(pay.created_at);
    // Pagamento com data inválida já é contado (e avisado) no relatório de faturamento.
    if (t === null || t >= cutoff) continue;
    const rule = ruleFor(pay, input.feeRules);
    if (!rule) {
      // Simulador (MOCK) e caixa (CASH_DESK) não têm repasse. Venda de anos anteriores
      // também conta: sem o prazo não dá para saber se caiu antes da posição. Só a mais
      // antiga que o maior prazo cadastrável (D+MAX_FEE_DAYS úteis) com certeza já caiu.
      if ((pay.acquirer === 'STONE' || pay.acquirer === 'PAGBANK') && cutoff - t <= ANY_RULE_SETTLED_MS) {
        // Mesmo critério do faturamento: valor da venda, sem a gorjeta.
        const c = toCents(pay.amount);
        noRuleC += c;
        noRuleCount += 1;
        if (t < p.from) {
          noRulePriorC += c;
          noRulePriorCount += 1;
        }
      }
      continue;
    }
    // Já recebido = o dia do repasse (de Brasília) terminou antes da posição. Com a
    // posição em 31/12, repasse em 01/01 ou depois estava a receber; com o ano em
    // andamento, repasse de hoje em diante ainda está a receber.
    // Venda bem mais antiga que o prazo: já caiu (pula o cálculo do dia, que é caro).
    if (cutoff - t > maxSettlementMs(rule)) continue;
    if (settlementDayEndBrasilia(t, rule) <= cutoff) continue;
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
  let late = 0;
  for (const pay of input.payments) {
    // Simulador (MOCK) não é dinheiro: não abate o que o entregador deve.
    if (pay.status !== 'APPROVED' || pay.acquirer === 'MOCK') continue;
    const t = at(pay.created_at);
    // Conta aqui (todos os aprovados) o pagamento depois da posição ou com data inválida,
    // também o de cartão: ficou fora do A receber e da conta do dinheiro com o entregador.
    if (t !== null && afterCutoff(t, p, cutoff)) late += 1;
    if (t === null) invalidDates += 1;
    if (t === null || t >= cutoff) continue;
    paidBefore.set(pay.order_id, (paidBefore.get(pay.order_id) ?? 0) + toCents(pay.amount));
  }
  for (const d of input.ownDeliveries) {
    if (d.status !== 'DELIVERED' || d.courier_fee === null || d.courier_id === null) continue;
    const t = at(d.delivered_at);
    if (t === null) invalidDates += 1;
    if (t !== null && afterCutoff(t, p, cutoff)) late += 1;
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
  // Acerto depois da posição não vale (a entrega continua devida naquele instante): avisa.
  for (const s of settledAt.values()) {
    if (s === null) invalidDates += 1; // acerto com data inválida: a entrega fica como a pagar
    else if (afterCutoff(s, p, cutoff)) late += 1;
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
    cardWithoutRulePriorYears: fromCents(noRulePriorC),
    cardWithoutRulePriorYearsCount: noRulePriorCount,
    courierPayables,
    courierPayablesTotal: fromCents(courierPayables.reduce((a, r) => a + toCents(r.amount), 0)),
    cutoff,
    invalidDates,
    afterCutoff: late,
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
  /** NF-e com data de emissão inválida, contadas pela data da importação. */
  invalidIssueDates: number;
  /** Ano em andamento: NF-e emitidas antes do instante do relatório mas importadas depois (ficaram fora). */
  importedAfterCutoff: number;
  /** NF-e repetidas (mesma chave de acesso) contadas uma vez só. */
  duplicateInvoices: number;
  /** Sangrias do caixa no ano que não são acerto de entregador: sem categoria. */
  withdrawals: WithdrawalRow[];
  withdrawalsTotal: number;
  /** Notas, acertos e sangrias com data inválida (ficaram de fora). */
  invalidDates: number;
  /** Fim do período: fim do ano, ou agora se o ano ainda não terminou. */
  cutoff: number;
  /** Notas, acertos e sangrias do ano com data no fim do período ou depois (ficaram de fora). */
  afterCutoff: number;
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
export function expensesByCategory(input: ExpensesInput, p: YearPeriod, now: Date = new Date()): ExpensesReport {
  const cutoff = positionCutoff(p, now);
  let late = 0;
  const inPeriod = (t: number | null): t is number => {
    if (t === null) return false;
    if (afterCutoff(t, p, cutoff)) late += 1;
    return t >= p.from && t < cutoff;
  };
  const supplierById = new Map(input.suppliers.map((s) => [s.id, s]));
  const purchases: PurchaseRow[] = [];
  let purchasesC = 0;
  let homologation = 0;
  let invalidDates = 0;
  let invalidIssueDates = 0;
  let importedAfterCutoff = 0;
  let duplicateInvoices = 0;
  // A mesma NF-e (mesma chave) importada em dois aparelhos antes de sincronizar fica
  // duas vezes aqui (a da nuvem e a recusada deste aparelho): conta uma vez só. Antes de
  // olhar o período, escolhe a cópia de cada chave pela mesma ordem do inventário
  // (compareInvoiceCopies). Assim a cópia sem data não tira a nota do ano certo.
  // Ano em andamento: a nota importada no instante do relatório ou depois não estava no
  // aparelho quando os números foram fixados (o inventário também não tem as entradas
  // dela). Sai ANTES da escolha da cópia, para não tirar uma cópia que já estava aqui.
  // Ano encerrado: vale só a emissão (nota de dezembro importada em janeiro fica em dezembro).
  const importedLate = (inv: PurchaseInvoice): boolean => {
    const imported = at(inv.imported_at);
    return cutoff < p.to && imported !== null && imported >= cutoff;
  };
  const visible = input.purchaseInvoices.filter((inv) => !importedLate(inv));
  const visibleKeys = new Set(visible.map((inv) => (inv.access_key ?? '').trim()).filter((k) => k !== ''));
  const lateSeen = new Set<string>();
  for (const inv of input.purchaseInvoices) {
    if (!importedLate(inv)) continue;
    const key = (inv.access_key ?? '').trim();
    // Outra cópia já estava aqui (ela conta), ou esta chave já foi avisada.
    if (key !== '' && (visibleKeys.has(key) || lateSeen.has(key))) continue;
    if (key !== '') lateSeen.add(key);
    // Homologação nunca conta: atualizar não a traria, então não avisa.
    if (inv.environment !== 'PRODUCTION') continue;
    const t = invoiceDate(inv.issued_at) ?? at(inv.imported_at);
    if (t === null || t < p.from) continue;
    late += 1;
    if (t < cutoff) importedAfterCutoff += 1;
  }
  const best = new Map<string, PurchaseInvoice>();
  for (const inv of visible) {
    const key = (inv.access_key ?? '').trim();
    if (key === '') continue;
    const cur = best.get(key);
    if (cur === undefined || compareInvoiceCopies(inv, cur) < 0) best.set(key, inv);
  }
  for (const inv of visible) {
    const key = (inv.access_key ?? '').trim();
    if (key !== '') {
      if (best.get(key) !== inv) {
        // Cópia repetida: conta para o aviso só se a nota escolhida for deste período.
        const chosen = best.get(key)!;
        const td = invoiceDate(chosen.issued_at) ?? at(chosen.imported_at);
        if (td !== null && td >= p.from && td < cutoff) duplicateInvoices += 1;
        continue;
      }
    }
    // Emissão (dhEmi ou dEmi); sem ela (ou com ela inválida), a data da importação.
    const issued = invoiceDate(inv.issued_at);
    const t = issued ?? at(inv.imported_at);
    if (t === null) invalidDates += 1;
    if (!inPeriod(t)) continue;
    const when = new Date(t).toISOString();
    if (inv.environment !== 'PRODUCTION') {
      homologation += 1;
      continue;
    }
    if (issued === null && (inv.issued_at ?? '').trim() !== '') invalidIssueDates += 1;
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
    if (!inPeriod(at(s.created_at))) continue;
    courierC += toCents(s.courier_fees);
    courierN += 1;
  }

  const withdrawals: WithdrawalRow[] = [];
  let withdrawalsC = 0;
  for (const mv of input.cashMovements) {
    if (mv.type !== 'WITHDRAWAL' || settlementMovements.has(mv.id)) continue;
    if (at(mv.created_at) === null) invalidDates += 1;
    if (!inPeriod(at(mv.created_at))) continue;
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
  return { rows, total: fromCents(total), purchases, homologationInvoices: homologation, invalidIssueDates, importedAfterCutoff, duplicateInvoices, withdrawals, withdrawalsTotal: fromCents(withdrawalsC), invalidDates, cutoff, afterCutoff: late };
}

const fmt = (cents: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(fromCents(cents));
