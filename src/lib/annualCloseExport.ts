/**
 * Exportação do fechamento anual: CSV para o contador abrir no Excel (separador ";",
 * vírgula decimal, UTF-8 com BOM) e HTML pronto para imprimir / salvar em PDF.
 * Texto vindo do cadastro (nome de produto, fornecedor, motivo de sangria) é escapado:
 * no CSV contra fórmula (=, +, -, @) e no HTML contra marcação.
 */
import type { ExpensesReport, InventoryReport, OpenPositionsReport, RevenueReport, YearPeriod } from './annualClose';
import { brasiliaDate, METHOD_LABEL } from './annualClose';
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

const qty = (v: number) => Math.round(v * 1000) / 1000;
const day = (iso: string) => {
  const t = parseIsoInstant(iso);
  return t === null ? '' : brasiliaDate(t);
};

export function periodLabel(kind: AnnualReportKind, p: YearPeriod): string {
  const first = `01/01/${p.year}`;
  const last = `31/12/${p.year}`;
  return kind === 'inventory' || kind === 'open' ? `Posição em ${last}` : `${first} a ${last}`;
}

export function inventoryDoc(r: InventoryReport, base: Omit<ReportDoc, 'title' | 'tables' | 'notes'>, extraNotes: string[] = []): ReportDoc {
  return {
    ...base,
    title: REPORT_TITLE.inventory,
    notes: [
      'Saldo pelo livro de estoque do Tchê Food: hoje ele registra só as ENTRADAS por NF-e de compra. As vendas ainda não baixam o estoque, então o saldo não é o físico. Faça a contagem física em 31/12 e use este relatório como conferência.',
      'Custo unitário = custo médio ponderado das compras (com frete, IPI, ICMS-ST etc. da nota).',
      ...(r.missingNcm > 0 ? [`${r.missingNcm} produto(s) com saldo estão sem NCM válido (8 dígitos) no cadastro.`] : []),
      ...(r.invalidDates > 0 ? [`${r.invalidDates} movimento(s) com data inválida ficaram de fora.`] : []),
      ...extraNotes,
    ],
    tables: [
      {
        head: ['Código', 'Descrição', 'NCM', 'Unidade', 'Saldo', 'Custo unitário (R$)', 'Custo total (R$)', 'Situação'],
        rows: r.rows.map((x) => [code(x.code), x.name, code(x.ncm), x.unit, qty(x.quantity), x.unitCost, x.total, x.inactive ? 'Desativado' : 'Ativo']),
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
      'Pagamentos aprovados pela data do pagamento (estornados e recusados ficam fora). Gorjeta não entra no faturamento.',
      'Taxa = estimativa pela taxa da maquininha e pela comissão dos apps cadastradas em Taxas e recebíveis. Confira com os extratos.',
      ...(r.totalWithoutRule > 0 ? [`R$ ${br(r.totalWithoutRule)} foram recebidos sem taxa cadastrada: a taxa deles NÃO foi descontada.`] : []),
      `Gorjetas no ano: R$ ${br(r.tips)}.`,
      ...(r.openSessions > 0 ? [`${r.openSessions} turno(s) de caixa aberto(s) no ano ainda não foram fechados.`] : []),
      ...extraNotes,
    ],
    tables: [
      {
        title: 'Faturamento por forma de recebimento',
        head: ['Forma de recebimento', 'Qtde', 'Bruto (R$)', 'Taxa estimada (R$)', 'Líquido (R$)', 'Sem taxa cadastrada (R$)'],
        rows: r.rows.map((x) => [x.label, String(x.count), x.gross, x.fee, x.net, x.withoutRule]),
        foot: ['Total', String(r.rows.reduce((a, x) => a + x.count, 0)), r.totalGross, r.totalFee, r.totalNet, r.totalWithoutRule],
      },
      {
        title: 'Bruto por mês (R$)',
        head: ['Forma', ...MONTHS, 'Total'],
        rows: r.rows.map((x) => [x.label, ...(r.monthly[x.key] ?? []), x.gross]),
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

export function openDoc(r: OpenPositionsReport, base: Omit<ReportDoc, 'title' | 'tables' | 'notes'>, extraNotes: string[] = []): ReportDoc {
  return {
    ...base,
    title: REPORT_TITLE.open,
    notes: [
      'A RECEBER de maquininha: vendas até 31/12 com repasse previsto para 01/01 ou depois, pelo prazo e taxa cadastrados (estimativa; confira com a agenda da adquirente).',
      ...(r.cardWithoutRuleCount > 0 ? [`${r.cardWithoutRuleCount} venda(s) no ano na maquininha (R$ ${br(r.cardWithoutRule)}) sem taxa cadastrada: não dá para saber se já caíram.`] : []),
      'NÃO registrados no Tchê Food (informe pelo seu controle): contas a pagar de fornecedores (boletos/duplicatas), fiado e convênios de clientes, repasses pendentes dos apps de delivery.',
      ...extraNotes,
    ],
    tables: [
      {
        title: 'A receber: repasses de cartão/Pix pendentes na virada do ano',
        head: ['Maquininha', 'Forma', 'Qtde', 'Valor passado (R$)', 'Taxa estimada (R$)', 'Líquido a receber (R$)'],
        rows: r.cardReceivables.map((x) => [x.acquirer, METHOD_LABEL[x.method], String(x.count), x.gross, x.fee, x.net]),
        foot: ['Total', '', String(r.cardReceivables.reduce((a, x) => a + x.count, 0)), null, null, r.cardReceivablesNet],
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
      ...(r.homologationInvoices > 0 ? [`${r.homologationInvoices} NF-e de homologação (teste) no ano ficaram de fora.`] : []),
      ...(r.withdrawals.length > 0 ? [`Sangrias do caixa sem categoria (R$ ${br(r.withdrawalsTotal)}) estão listadas à parte e NÃO entram no total: classifique com o contador.`] : []),
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
  let s = c.replace(/\r?\n/g, ' ');
  // Planilha executa célula que começa com = + - @ (ou tab/CR): vira texto com apóstrofo.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[;"\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

const line = (cells: Cell[]) => cells.map(csvCell).join(';');

export function toCsv(doc: ReportDoc): string {
  const out: string[] = [];
  out.push(line([doc.title]));
  out.push(line([doc.period]));
  out.push(line([`${doc.store.legalName || doc.store.name} · CNPJ ${doc.store.cnpj} · ${doc.store.city}/${doc.store.state}`]));
  out.push(line([`Gerado em ${doc.generatedAt}`]));
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
  if (typeof c === 'number') return `<${tag} class="n">${escapeHtml(money.format(c))}</${tag}>`;
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
<div class="meta"><strong>${escapeHtml(doc.period)}</strong> · ${escapeHtml(doc.store.legalName || doc.store.name)} · CNPJ ${escapeHtml(doc.store.cnpj)} · ${escapeHtml(`${doc.store.city}/${doc.store.state}`)}<br>Gerado em ${escapeHtml(doc.generatedAt)} pelo Tchê Food</div>
${notes ? `<ul>${notes}</ul>` : ''}
${tables}
</body></html>`;
}

/** Nome de arquivo sem acento nem espaço: "fechamento-2025-inventario.csv". */
export function fileName(kind: AnnualReportKind, year: number, ext: 'csv' | 'html'): string {
  const slug: Record<AnnualReportKind, string> = { inventory: 'inventario', revenue: 'faturamento-caixa', open: 'contas-em-aberto', expenses: 'despesas' };
  return `fechamento-${year}-${slug[kind]}.${ext}`;
}
