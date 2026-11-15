/**
 * Exportação do fechamento anual: CSV para o contador abrir no Excel (separador ";",
 * vírgula decimal, UTF-8 com BOM) e HTML pronto para imprimir / salvar em PDF.
 * Texto vindo do cadastro (nome de produto, fornecedor, motivo de sangria) é escapado:
 * no CSV contra fórmula (=, +, -, @) e no HTML contra marcação.
 */
import type { ExpensesReport, InventoryReport, OpenPositionsReport, RevenueReport, YearPeriod } from './annualClose';
import { brasiliaDate, brasiliaDateTime, METHOD_LABEL, positionCutoff, yearInProgress } from './annualClose';
import { fromCents, toCents } from './money';
import { parseIsoInstant } from './reports';

export type AnnualReportKind = 'inventory' | 'revenue' | 'open' | 'expenses';

export const REPORT_TITLE: Record<AnnualReportKind, string> = {
  inventory: 'Inventário de insumos e mercadorias',
  revenue: 'Fechamento de caixa e formas de pagamento',
  open: 'Contas a pagar e a receber em aberto',
  expenses: 'Despesas operacionais',
};

export const MONTHS = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

/**
 * Uma célula: texto (escapado), número (vírgula decimal) ou código só de dígitos que
 * o Excel não pode transformar em número (NCM 02013000, CNPJ, chave de 44 dígitos).
 */
export type Cell = string | number | null | { code: string };

/** Código (NCM, CNPJ, chave de acesso) que precisa ficar como texto na planilha. */
export const code = (v: string | null | undefined): Cell => ({ code: v ?? '' });

export interface Table {
  title?: string;
  head: string[];
  rows: Cell[][];
  /** Linha de total (opcional). */
  foot?: Cell[];
}

export interface ReportDoc {
  title: string;
  /** "Posição em 31/12/2025" ou "01/01/2025 a 31/12/2025". */
  period: string;
  store: { name: string; legalName: string; cnpj: string; city: string; state: string };
  generatedAt: string;
  notes: string[];
  tables: Table[];
}

// ---------------------------------------------------------------------------
// Montagem dos documentos
// ---------------------------------------------------------------------------

/**
 * Vendas, pagamentos, caixa e estoque ficam no aparelho que os gravou (a nuvem recebe,
 * mas ainda não devolve; src/lib/sync/cloudPull.ts). Todo relatório diz isso.
 */
export const DEVICE_ONLY =
  'SOMENTE os registros gravados NESTE aparelho. Vendas, pagamentos, caixa e entradas de estoque de outro aparelho da loja não estão aqui (a nuvem ainda não devolve esses dados). Com mais de um aparelho, gere o relatório em cada um e some. EXCEÇÃO: as compras por NF-e vêm da nuvem e são as mesmas em todos os aparelhos ligados a ela; NÃO some as compras de aparelhos diferentes (nota que ainda não subiu para a nuvem, ou foi recusada por ela, só está no aparelho que a importou). Se este aparelho foi ligado a outra loja ou zerado no meio do ano, o que havia antes não está aqui.';

/** Aviso de registros que ficaram de fora por data inválida (nunca somem calados). */
const invalid = (n: number, what: string): string[] =>
  n > 0 ? [`ATENÇÃO: ${n} ${what} com data inválida ou fora de 2000–2100, como relógio zerado (não dá para saber o ano), ficaram fora. Se for deste ano, o total está menor: avise o suporte antes de enviar ao contador.`] : [];

/**
 * Aviso de registros do ano com data no instante do relatório ou depois (ano em
 * andamento): lançados depois de a tela abrir, ou relógio do aparelho errado.
 */
export const afterCutoffNote = (n: number, cutoff: number): string[] =>
  n > 0
    ? [`ATENÇÃO: ${n} registro(s) com data a partir de ${brasiliaDateTime(cutoff)} (instante deste relatório) ficaram de fora. Se foram lançados agora, atualize; se não, confira o relógio do aparelho.`]
    : [];

/** Valor em reais para as notas: "R$ 12.345,67" (com milhar, como nas tabelas). */
const BRL_NOTE = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const brl = (v: number): string => `R$ ${Number.isFinite(v) ? BRL_NOTE.format(v) : '—'}`;

const qty = (v: number) => Math.round(v * 1000) / 1000;
const day = (iso: string) => {
  const t = parseIsoInstant(iso);
  return t === null ? '' : brasiliaDate(t);
};

/**
 * Com o ano em andamento, a posição é a de agora e o período vai até o instante do
 * relatório, com a hora (o mesmo corte dos cálculos; sem fingir 31/12).
 */
export function periodLabel(kind: AnnualReportKind, p: YearPeriod, now: Date = new Date()): string {
  const first = `01/01/${p.year}`;
  const partial = yearInProgress(p, now);
  const last = partial ? brasiliaDateTime(positionCutoff(p, now)) : `31/12/${p.year}`;
  if (kind === 'inventory' || kind === 'open') return partial ? `Posição em ${last} (ano em andamento)` : `Posição em ${last}`;
  return partial ? `${first} a ${last} (ano em andamento)` : `${first} a ${last}`;
}

export function inventoryDoc(r: InventoryReport, base: Omit<ReportDoc, 'title' | 'tables' | 'notes'>, extraNotes: string[] = []): ReportDoc {
  return {
    ...base,
    title: REPORT_TITLE.inventory,
    notes: [
      'Saldo = soma das ENTRADAS por NF-e de compra importadas NESTE aparelho até a posição (o livro de estoque do Tchê Food ainda só registra entradas). As vendas não baixam o estoque e o saldo informado direto no cadastro do produto (sem nota) não entra, então o saldo não é o físico. Faça a contagem física em 31/12 e use este relatório como conferência.',
      'Custo unitário = custo médio ponderado das compras (com frete, IPI, ICMS-ST etc. da nota).',
      'A entrada conta pela data em que a nota foi IMPORTADA no app (nota emitida em 30/12 e importada em 03/01 não está neste saldo, mas está nas compras do ano).',
      ...(r.duplicateMovements > 0 ? [`${r.duplicateMovements} entrada(s) de NF-e repetida ficaram fora deste saldo: a nota também foi importada em OUTRO aparelho (a nuvem ficou com a de lá, e as entradas estão no inventário daquele aparelho) ou foi importada mais de uma vez neste aparelho (vale só a primeira importação). Confira se a nota está certa.`] : []),
      ...(r.duplicateUnconfirmed > 0 ? [`ATENÇÃO: ${r.duplicateUnconfirmed} NF-e aparece(m) mais de uma vez neste aparelho (outra cópia com a mesma chave veio da nuvem) sem prova de que é duplicata: as entradas deste aparelho foram MANTIDAS neste saldo. Se outro aparelho também lançou essa nota, a soma dos inventários conta a mercadoria duas vezes. Confira antes de somar.`] : []),
      ...(r.testMovements > 0 ? [`${r.testMovements} entrada(s) por NF-e de homologação (teste) ficaram de fora do saldo e do custo.`] : []),
      ...(r.missingNcm > 0 ? [`${r.missingNcm} produto(s) com saldo estão sem NCM válido (8 dígitos) no cadastro.`] : []),
      ...invalid(r.invalidDates, 'movimento(s) de estoque'),
      ...afterCutoffNote(r.afterCutoff, r.cutoff),
      ...extraNotes,
    ],
    tables: [
      {
        head: ['Código', 'Descrição', 'NCM', 'Unidade', 'Saldo', 'Custo unitário (R$)', 'Custo total (R$)', 'Situação'],
        rows: r.rows.map((x) => [code(x.code), x.name, code(x.ncm), x.unit, qty(x.quantity), x.unitCost, x.total, `${x.name === 'Produto não encontrado no cadastro' ? 'Não encontrado no cadastro' : x.inactive ? 'Desativado' : 'Ativo'}${x.withoutTestInvoices ? ' (sem NF-e de teste)' : ''}`]),
        foot: ['', 'Total', '', '', null, null, r.totalCost, ''],
      },
    ],
  };
}

export function revenueDoc(r: RevenueReport, base: Omit<ReportDoc, 'title' | 'tables' | 'notes'>, extraNotes: string[] = []): ReportDoc {
  return {
    ...base,
    title: REPORT_TITLE.revenue,
    notes: [
      'Pagamentos aprovados pela data do pagamento (recusados ficam fora). Dinheiro devolvido ao cliente por sangria NÃO abate daqui: está na lista de sangrias do relatório de despesas. Gorjeta não entra no faturamento.',
      'Entrega própria paga em dinheiro conta na data do acerto com o entregador (é quando o dinheiro entra no caixa).',
      'Taxa = estimativa pela taxa da maquininha cadastrada em Taxas e recebíveis, sobre conta + gorjeta (como a maquininha cobra). Confira com os extratos. O Líquido não tem a gorjeta: o que a maquininha deposita é Líquido + gorjeta de cartão.',
      ...(r.serviceFee > 0 ? [`Taxa de serviço das comandas fechadas (na proporção dos pagamentos do período): ${brl(r.serviceFee)}. Ela está DENTRO do Bruto (veio nos pagamentos); pela Lei 13.419/2017 é gorjeta. Decida com o contador se sai da receita.`] : []),
      'Sangrias aqui = todas as retiradas do caixa, inclusive o pagamento de entregador pela gaveta (que no relatório de despesas está em Taxas de entrega, não em sangrias sem categoria).',
      'Estorno feito na maquininha NÃO chega ao Tchê Food: abata pelo extrato da adquirente.',
      ...(r.rows.some((x) => x.key === 'VOUCHER' && x.notTracked) ? ['Vale-refeição/alimentação: o app ainda não registra esta forma; o que foi passado como VR/VA na maquininha está dentro de crédito/débito (com a taxa de crédito/débito). Separe pelo extrato da adquirente.'] : []),
      ...(r.cashOutsideSessionsCount > 0 ? [`${r.cashOutsideSessionsCount} recebimento(s) em dinheiro (${brl(r.cashOutsideSessions)}) foram feitos sem turno de caixa aberto: estão no Dinheiro, mas não aparecem nos fechamentos.`] : []),
      ...(r.simulatorCount > 0 ? [`${r.simulatorCount} pagamento(s) no simulador de maquininha (${brl(r.simulatorAmount)}) ficaram de fora: não são dinheiro real.`] : []),
      ...(r.totalWithoutRule > 0 ? [`${brl(r.totalWithoutRule)} foram recebidos sem taxa cadastrada: a taxa deles NÃO foi descontada.`] : []),
      `Gorjetas no ano: ${brl(r.tips)}.`,
      ...(r.openSessions > 0 ? [`${r.openSessions} turno(s) de caixa estavam abertos no fim do período (abertos antes e fechados depois, ou ainda abertos): o fechamento deles não está na lista abaixo.`] : []),
      ...invalid(r.invalidDates, 'pagamento(s), fechamento(s) ou movimento(s) de caixa'),
      ...afterCutoffNote(r.afterCutoff, r.cutoff),
      ...extraNotes,
    ],
    tables: [
      {
        title: 'Faturamento por forma de recebimento',
        head: ['Forma de recebimento', 'Qtde', 'Bruto (R$)', 'Taxa estimada (R$)', 'Líquido (R$)', 'Sem taxa cadastrada (R$)'],
        rows: r.rows.map((x) => (x.notTracked ? [x.label, '', 'não registrado', 'não registrado', 'não registrado', ''] : [x.label, String(x.count), x.gross, x.fee, x.net, x.withoutRule])),
        foot: ['Total', String(r.rows.reduce((a, x) => a + x.count, 0)), r.totalGross, r.totalFee, r.totalNet, r.totalWithoutRule],
      },
      {
        title: 'Bruto por mês (R$)',
        head: ['Forma', ...MONTHS, 'Total'],
        rows: r.rows.map((x) => (x.notTracked ? [x.label, ...MONTHS.map(() => ''), 'não registrado'] : [x.label, ...(r.monthly[x.key] ?? []), x.gross])),
        foot: ['Total', ...r.monthlyTotal, r.totalGross],
      },
      {
        title: 'Fechamentos de caixa',
        head: ['Abertura', 'Fechamento', 'Aberto por', 'Fechado por', 'Fundo (R$)', 'Esperado (R$)', 'Contado (R$)', 'Diferença (R$)'],
        rows: r.closings.map((c) => [day(c.openedAt), day(c.closedAt), c.openedBy, c.closedBy, c.openingFloat, c.expected, c.counted, c.difference]),
        foot: [`${r.closings.length} fechamento(s)`, '', '', '', null, null, null, r.closingsDifference],
      },
      {
        title: 'Movimentos de caixa',
        head: ['Tipo', 'Total (R$)'],
        rows: [
          ['Suprimentos (entrada de troco)', r.supplies],
          ['Sangrias (retiradas)', r.withdrawals],
        ],
      },
    ],
  };
}

/** Aviso das vendas sem taxa cadastrada: situação de repasse desconhecida, não um a receber. */
function noRuleNote(r: OpenPositionsReport): string[] {
  if (r.cardWithoutRuleCount <= 0) return [];
  const thisYearCount = r.cardWithoutRuleCount - r.cardWithoutRulePriorYearsCount;
  const thisYear = fromCents(toCents(r.cardWithoutRule) - toCents(r.cardWithoutRulePriorYears));
  const split =
    r.cardWithoutRulePriorYearsCount > 0
      ? ` (${thisYearCount} deste ano, ${brl(thisYear)}; ${r.cardWithoutRulePriorYearsCount} de anos anteriores, ${brl(r.cardWithoutRulePriorYears)})`
      : ' (todas deste ano)';
  return [
    `SITUAÇÃO DE REPASSE DESCONHECIDA: ${r.cardWithoutRuleCount} venda(s) na maquininha sem taxa cadastrada nos ~18 meses até a posição (as mais antigas já caíram em qualquer prazo cadastrável, até D+400 úteis), ${brl(r.cardWithoutRule)}${split}. Sem o prazo não dá para saber se o repasse já caiu ou ainda está a receber: o valor pode já ter sido recebido e NÃO está somado no A receber. Confira com a agenda da adquirente ou cadastre a taxa.`,
  ];
}

export function openDoc(r: OpenPositionsReport, base: Omit<ReportDoc, 'title' | 'tables' | 'notes'>, extraNotes: string[] = []): ReportDoc {
  return {
    ...base,
    title: REPORT_TITLE.open,
    notes: [
      'A RECEBER de maquininha: vendas até a posição com repasse previsto para o dia da posição ou depois, pelo prazo e taxa cadastrados (estimativa; feriado não conta; confira com a agenda da adquirente).',
      'Estorno feito na maquininha NÃO chega ao Tchê Food: venda estornada ainda aparece aqui como a receber. Confira com a agenda da adquirente.',
      'A RECEBER de entregador: dinheiro de entregas pagas na entrega feitas até a posição e ainda não acertadas. O valor usa o total ATUAL do pedido menos o que foi pago até a posição: se o pedido foi alterado depois (desconto, item cancelado), o valor daquela data pode ser outro.',
      ...noRuleNote(r),
      'NÃO registrados no Tchê Food (informe pelo seu controle): contas a pagar de fornecedores (boletos/duplicatas), fiado e convênios de clientes, repasses pendentes dos apps de delivery, gorjetas e taxa de serviço ainda devidas à equipe.',
      'Bases: o A receber de maquininha é sobre conta + gorjeta (o que a maquininha repassa); a situação de repasse desconhecida é só o valor da conta, sem a gorjeta.',
      ...invalid(r.invalidDates, 'entrega(s), pagamento(s) ou acerto(s)'),
      ...afterCutoffNote(r.afterCutoff, r.cutoff),
      ...extraNotes,
    ],
    tables: [
      {
        title: 'A receber: repasses de cartão/Pix pendentes na posição',
        head: ['Maquininha', 'Forma', 'Qtde', 'Valor passado (R$)', 'Taxa estimada (R$)', 'Líquido a receber (R$)'],
        rows: r.cardReceivables.map((x) => [x.acquirer, METHOD_LABEL[x.method], String(x.count), x.gross, x.fee, x.net]),
        foot: ['Total', '', String(r.cardReceivables.reduce((a, x) => a + x.count, 0)), null, null, r.cardReceivablesNet],
      },
      {
        title: 'A receber: dinheiro com entregadores (entregas pagas na entrega sem acerto)',
        head: ['Entregador', 'Entregas', 'A receber (R$)'],
        rows: r.courierCash.map((x) => [x.courier, String(x.deliveries), x.amount]),
        foot: ['Total', String(r.courierCash.reduce((a, x) => a + x.deliveries, 0)), r.courierCashTotal],
      },
      {
        title: 'A pagar: entregadores próprios ainda não acertados',
        head: ['Entregador', 'Entregas', 'A pagar (R$)'],
        rows: r.courierPayables.map((x) => [x.courier, String(x.deliveries), x.amount]),
        foot: ['Total', String(r.courierPayables.reduce((a, x) => a + x.deliveries, 0)), r.courierPayablesTotal],
      },
    ],
  };
}

export function expensesDoc(r: ExpensesReport, base: Omit<ReportDoc, 'title' | 'tables' | 'notes'>, extraNotes: string[] = []): ReportDoc {
  return {
    ...base,
    title: REPORT_TITLE.expenses,
    notes: [
      'Total = só o que o app registra ou estima. Folha, aluguel e outras despesas não são registradas no Tchê Food e ficam de fora.',
      'Compras de insumos entram no custo da mercadoria (CMV = estoque inicial + compras − estoque final), não como despesa operacional: separe na DRE.',
      'Taxas da maquininha e comissões dos apps são as MESMAS já abatidas no Líquido do relatório de faturamento: se lançar a receita pelo Líquido, não lance estas taxas de novo.',
      'Regime de caixa: taxas de entrega contam na data do acerto com o entregador. O que estava a pagar aos entregadores em 31/12 está no relatório de contas em aberto e entra aqui no ano do acerto.',
      ...(r.homologationInvoices > 0 ? [`${r.homologationInvoices} NF-e de homologação (teste) no ano ficou(aram) de fora.`] : []),
      ...(r.duplicateInvoices > 0 ? [`${r.duplicateInvoices} NF-e importada(s) também em outro aparelho (mesma chave de acesso, aparece duas vezes aqui) foi(ram) contada(s) uma vez só.`] : []),
      ...(r.importedAfterCutoff > 0 ? [`${r.importedAfterCutoff} NF-e emitida(s) antes do instante deste relatório, mas importada(s) neste aparelho depois dele, ficou(aram) de fora (também estão no aviso de registros fora do instante). Atualize o relatório para incluí-la(s).`] : []),
      ...(r.invalidIssueDates > 0 ? [`${r.invalidIssueDates} NF-e com data de emissão inválida foi(ram) contada(s) pela data da importação: confira o ano dessa(s) nota(s).`] : []),
      ...invalid(r.invalidDates, 'nota(s), acerto(s) ou sangria(s)'),
      ...afterCutoffNote(r.afterCutoff, r.cutoff),
      ...(r.withdrawals.length > 0 ? [`Sangrias do caixa sem categoria (${brl(r.withdrawalsTotal)}) estão listadas à parte e NÃO entram no total: classifique com o contador.`] : []),
      ...extraNotes,
    ],
    tables: [
      {
        title: 'Despesas por categoria',
        head: ['Categoria', 'Valor (R$)', 'Origem', 'Observação'],
        rows: r.rows.map((x) => [x.label, x.amount, x.source === 'REGISTERED' ? 'Registrado' : x.source === 'ESTIMATED' ? 'Estimado' : 'Não registrado', x.note]),
        foot: ['Total', r.total, '', ''],
      },
      {
        title: 'Compras de insumos (NF-e importadas)',
        head: ['Data', 'Fornecedor', 'CNPJ/CPF', 'Número', 'Série', 'Chave de acesso', 'Valor (R$)'],
        rows: r.purchases.map((x) => [day(x.date), x.supplier, code(x.document), code(x.number), code(x.series), code(x.accessKey), x.amount]),
      },
      {
        title: 'Sangrias do caixa sem categoria (fora do total)',
        head: ['Data', 'Motivo', 'Valor (R$)'],
        rows: r.withdrawals.map((x) => [day(x.date), x.reason, x.amount]),
        foot: ['Total', '', r.withdrawalsTotal],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** Número com vírgula decimal (sem separador de milhar, para o Excel ler como número). */
export function br(v: number): string {
  if (!Number.isFinite(v)) return '';
  // Dinheiro em 2 casas; custo médio e quantidade com até 4 (sem zeros sobrando além da 2ª).
  const fixed = Math.abs(v * 100 - Math.round(v * 100)) < 1e-6 ? v.toFixed(2) : v.toFixed(4).replace(/0+$/, '');
  return fixed.replace('.', ',');
}

function csvCell(c: Cell): string {
  if (c === null) return '';
  if (typeof c === 'number') return br(c);
  if (typeof c === 'object') {
    // ="0201..." é o jeito que o Excel aceita para manter zero à esquerda e os 44 dígitos.
    // Só para código feito de dígitos; qualquer outra coisa vira texto comum (escapado).
    return /^\d+$/.test(c.code) ? `="${c.code}"` : csvCell(c.code);
  }
  // Quebra de linha (inclusive CR sozinho) dentro do texto quebraria a linha do CSV.
  let s = c.replace(/[\r\n]+/g, ' ');
  // Planilha executa célula que começa com = + - @ (mesmo depois de espaço, tab ou aspas):
  // vira texto com apóstrofo na frente.
  if (/^[\s"']*[=+\-@]/.test(s)) s = `'${s}`;
  // Entre aspas também com vírgula: quem abrir o CSV separando por vírgula não parte a
  // célula (nem cria uma célula nova começando com = + - @).
  return /[;,"\t]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

const line = (cells: Cell[]) => cells.map(csvCell).join(';');

export function toCsv(doc: ReportDoc): string {
  const out: string[] = [];
  out.push(line([doc.title]));
  out.push(line([doc.period]));
  out.push(line([`${doc.store.legalName || doc.store.name} · CNPJ ${doc.store.cnpj || 'não cadastrado'} · ${doc.store.city}/${doc.store.state}`]));
  out.push(line([`Gerado em ${doc.generatedAt}`]));
  out.push(line([`Obs.: ${DEVICE_ONLY}`]));
  for (const n of doc.notes) out.push(line([`Obs.: ${n}`]));
  for (const t of doc.tables) {
    out.push('');
    if (t.title) out.push(line([t.title]));
    out.push(line(t.head));
    if (t.rows.length === 0) out.push(line(['Sem registros no período.']));
    for (const r of t.rows) out.push(line(r));
    if (t.foot && t.rows.length > 0) out.push(line(t.foot));
  }
  // BOM: o Excel em português abre UTF-8 com acentos certos.
  return `﻿${out.join('\r\n')}\r\n`;
}

// ---------------------------------------------------------------------------
// HTML para imprimir / salvar em PDF
// ---------------------------------------------------------------------------

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

const money = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
function htmlCell(c: Cell, tag: 'td' | 'th'): string {
  if (c === null) return `<${tag}></${tag}>`;
  if (typeof c === 'number') return `<${tag} class="n">${Number.isFinite(c) ? escapeHtml(money.format(c)) : ''}</${tag}>`;
  if (typeof c === 'object') return `<${tag}>${escapeHtml(c.code)}</${tag}>`;
  return `<${tag}>${escapeHtml(c)}</${tag}>`;
}

export function toPrintableHtml(doc: ReportDoc): string {
  const tables = doc.tables
    .map((t) => {
      const head = `<tr>${t.head.map((h) => htmlCell(h, 'th')).join('')}</tr>`;
      const body = t.rows.length === 0 ? `<tr><td colspan="${t.head.length}" class="empty">Sem registros no período.</td></tr>` : t.rows.map((r) => `<tr>${r.map((c) => htmlCell(c, 'td')).join('')}</tr>`).join('');
      const foot = t.foot && t.rows.length > 0 ? `<tfoot><tr>${t.foot.map((c) => htmlCell(c, 'th')).join('')}</tr></tfoot>` : '';
      return `${t.title ? `<h2>${escapeHtml(t.title)}</h2>` : ''}<table><thead>${head}</thead><tbody>${body}</tbody>${foot}</table>`;
    })
    .join('');
  const notes = doc.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join('');
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${escapeHtml(`${doc.title} - ${doc.period}`)}</title>
<style>
  body{font-family:Arial,Helvetica,sans-serif;color:#111;margin:24px;font-size:11px;background:#fff}
  h1{font-size:16px;margin:0}h2{font-size:13px;margin:18px 0 6px}
  .meta{color:#444;margin:4px 0 12px}
  table{border-collapse:collapse;width:100%;margin-bottom:8px}
  th,td{border:1px solid #bbb;padding:4px 6px;text-align:left;vertical-align:top}
  thead th{background:#f1f1f1}tfoot th{background:#fafafa}
  .n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
  .empty{color:#666;font-style:italic}
  ul{padding-left:18px;color:#333}
  @media print{body{margin:10mm}h2{break-after:avoid}tr{break-inside:avoid}}
</style></head><body>
<h1>${escapeHtml(doc.title)}</h1>
<div class="meta"><strong>${escapeHtml(doc.period)}</strong> · ${escapeHtml(doc.store.legalName || doc.store.name)} · CNPJ ${escapeHtml(doc.store.cnpj || 'não cadastrado')} · ${escapeHtml(`${doc.store.city}/${doc.store.state}`)}<br>Gerado em ${escapeHtml(doc.generatedAt)} pelo Tchê Food</div>
<ul><li><strong>${escapeHtml(DEVICE_ONLY)}</strong></li>${notes}</ul>
${tables}
</body></html>`;
}

/** Nome de arquivo sem acento nem espaço: "fechamento-2025-inventario.csv". */
export function fileName(kind: AnnualReportKind, year: number, ext: 'csv' | 'html'): string {
  const slug: Record<AnnualReportKind, string> = { inventory: 'inventario', revenue: 'faturamento-caixa', open: 'contas-em-aberto', expenses: 'despesas' };
  return `fechamento-${year}-${slug[kind]}.${ext}`;
}
