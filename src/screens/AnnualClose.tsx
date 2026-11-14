/**
 * Retaguarda › Fechamento anual: os quatro relatórios que a contabilidade pede na
 * virada do ano, com o ano escolhido e exportação em Excel (CSV) e PDF (imprimir).
 * Só proprietário e gerente. Nada é inventado: o que o app não registra aparece como
 * "não registrado", e o que é estimativa vem marcado.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { FileSpreadsheet, Printer } from 'lucide-react';
import { Btn, toast } from '../components/ui';
import { isManagerRole, selectCurrentUser, useTcheStore } from '../store/useTcheStore';
import { useOwnerSettings } from '../store/useOwnerSettings';
import { formatBRL } from '../lib/money';
import { refreshDeliveryOrders, useDeliveryOrders } from '../lib/deliveryDemo';
import { DELIVERY_CHANNEL_CATALOG } from '../../server/delivery/marketplace';
import type { MarketplaceSale } from '../lib/ownerDashboard';
import { expensesByCategory, inventoryAt, openPositionsAt, revenueByMethod, validYear, yearInProgress, yearPeriod, yearsWithData } from '../lib/annualClose';
import { expensesDoc, fileName, inventoryDoc, openDoc, periodLabel, REPORT_TITLE, revenueDoc, toCsv, toPrintableHtml, type AnnualReportKind, type ReportDoc } from '../lib/annualCloseExport';

function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Abre o relatório numa janela própria e chama a impressão ("Salvar como PDF"). Sem janela, baixa o HTML. */
function printDoc(doc: ReportDoc, name: string) {
  const html = toPrintableHtml(doc);
  const win = window.open('', '_blank');
  if (!win) {
    download(name, html, 'text/html;charset=utf-8');
    toast.info('O aparelho bloqueou a janela de impressão: baixei o relatório em HTML. Abra e imprima em PDF.');
    return;
  }
  win.opener = null;
  win.document.open();
  win.document.write(html);
  win.document.close();
  win.focus();
  window.setTimeout(() => win.print(), 300);
}

export function AnnualClose() {
  const user = useTcheStore(selectCurrentUser);
  const tenant = useTcheStore((s) => s.tenant);
  const staff = useTcheStore((s) => s.staff);
  const products = useTcheStore((s) => s.products);
  const stockMovements = useTcheStore((s) => s.stockMovements);
  const payments = useTcheStore((s) => s.payments);
  const cashSessions = useTcheStore((s) => s.cashSessions);
  const cashMovements = useTcheStore((s) => s.cashMovements);
  const purchaseInvoices = useTcheStore((s) => s.purchaseInvoices);
  const suppliers = useTcheStore((s) => s.suppliers);
  const ownDeliveries = useTcheStore((s) => s.ownDeliveries);
  const courierSettlements = useTcheStore((s) => s.courierSettlements);
  const couriers = useTcheStore((s) => s.couriers);
  const feeRules = useOwnerSettings((s) => s.feeRules);
  const appCommissionPct = useOwnerSettings((s) => s.appCommissionPct);
  const deliveryRecords = useDeliveryOrders((s) => s.orders);

  useEffect(() => {
    void refreshDeliveryOrders().catch(() => undefined);
  }, []);

  const marketplace = useMemo<MarketplaceSale[]>(
    () =>
      deliveryRecords.map((r) => ({
        channel: r.order.channel,
        label: DELIVERY_CHANNEL_CATALOG[r.order.channel]?.label ?? r.order.channel,
        created_at: r.order.createdAt,
        total_cents: r.order.totals.orderCents,
        canceled: r.order.status === 'cancelled',
        status: r.order.status,
      })),
    [deliveryRecords],
  );

  const years = useMemo(
    () =>
      yearsWithData([
        ...payments.map((p) => p.created_at),
        ...stockMovements.map((m) => m.created_at),
        ...purchaseInvoices.map((i) => i.issued_at ?? i.imported_at),
        ...cashSessions.map((s) => s.closed_at ?? s.opened_at),
        ...courierSettlements.map((s) => s.created_at),
        ...marketplace.map((m) => m.created_at),
      ]),
    [payments, stockMovements, purchaseInvoices, cashSessions, courierSettlements, marketplace],
  );
  const [picked, setPicked] = useState<number | null>(null);
  const year = picked !== null && validYear(picked) ? picked : years[0]!;
  const period = useMemo(() => yearPeriod(year), [year]);
  const partial = yearInProgress(period);

  const inventory = useMemo(() => inventoryAt(products, stockMovements, period), [products, stockMovements, period]);
  const revenue = useMemo(
    () => revenueByMethod({ payments, marketplace, feeRules, appCommissionPct, cashSessions, cashMovements, staff }, period),
    [payments, marketplace, feeRules, appCommissionPct, cashSessions, cashMovements, staff, period],
  );
  const open = useMemo(() => openPositionsAt({ payments, feeRules, ownDeliveries, courierSettlements, couriers }, period), [payments, feeRules, ownDeliveries, courierSettlements, couriers, period]);
  const expenses = useMemo(() => expensesByCategory({ purchaseInvoices, suppliers, courierSettlements, cashMovements, revenue }, period), [purchaseInvoices, suppliers, courierSettlements, cashMovements, revenue, period]);

  if (!isManagerRole(user?.role)) return <p className="p-6">Só o proprietário e o gerente veem o fechamento anual.</p>;

  const partialNote = partial ? [`O ano de ${year} ainda não terminou: os números vão até agora, não até 31/12.`] : [];
  const appNote = 'Pedidos dos apps de delivery: só os que estão neste aparelho (a integração com o iFood ainda está em homologação).';

  const build = (kind: AnnualReportKind): ReportDoc => {
    const base = {
      period: periodLabel(kind, period),
      store: { name: tenant.name, legalName: tenant.legal_name, cnpj: tenant.cnpj, city: tenant.city, state: tenant.state },
      generatedAt: new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
    };
    switch (kind) {
      case 'inventory':
        return inventoryDoc(inventory, base, partialNote);
      case 'revenue':
        return revenueDoc(revenue, base, [...partialNote, appNote]);
      case 'open':
        return openDoc(open, base, partialNote);
      case 'expenses':
        return expensesDoc(expenses, base, [...partialNote, appNote]);
    }
  };

  const actions = (kind: AnnualReportKind) => (
    <div className="flex flex-wrap gap-2">
      <Btn variant="secondary" onClick={() => download(fileName(kind, year, 'csv'), toCsv(build(kind)), 'text/csv;charset=utf-8')}>
        <FileSpreadsheet className="h-4 w-4" /> Excel (CSV)
      </Btn>
      <Btn variant="secondary" onClick={() => printDoc(build(kind), fileName(kind, year, 'html'))}>
        <Printer className="h-4 w-4" /> PDF / imprimir
      </Btn>
    </div>
  );

  const card = (kind: AnnualReportKind, summary: ReactNode) => (
    <section className="rounded-2xl border border-slate-200 bg-base p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-black">{REPORT_TITLE[kind]}</h3>
          <p className="text-sm text-slate-500">{periodLabel(kind, period)}</p>
        </div>
        {actions(kind)}
      </div>
      {summary}
    </section>
  );

  const line = (label: string, value: string, hint?: string) => (
    <div className="flex items-baseline justify-between gap-3 border-b border-slate-100 py-1 text-sm last:border-0">
      <span>
        {label}
        {hint && <span className="ml-1 text-xs text-slate-500">{hint}</span>}
      </span>
      <span className="font-bold tabular-nums">{value}</span>
    </div>
  );

  return (
    <div className="space-y-4">
      <section className="flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200 bg-surface p-4">
        <label className="font-bold" htmlFor="annual-year">
          Ano do fechamento
        </label>
        <select id="annual-year" className="min-h-touch rounded-xl border border-slate-300 bg-base px-3 font-bold" value={year} onChange={(e) => setPicked(Number(e.target.value))}>
          {years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
        <span className="text-sm text-slate-500">01/01/{year} a 31/12/{year}, horário de Brasília.</span>
        {partial && (
          <p role="status" className="w-full rounded-xl bg-amarelo/15 p-3 text-sm">
            {year} ainda não terminou: os números vão até agora. Gere de novo depois de 31/12.
          </p>
        )}
      </section>

      {card(
        'inventory',
        <>
          <p className="mb-2 rounded-xl bg-amarelo/15 p-3 text-sm">
            O Tchê Food ainda não baixa o estoque nas vendas: o saldo é só o que entrou por NF-e de compra. Faça a contagem física em 31/12 e use este relatório para conferir.
          </p>
          {line('Itens com saldo', String(inventory.rows.length))}
          {line('Custo total do estoque', formatBRL(inventory.totalCost))}
          {inventory.missingNcm > 0 && line('Sem NCM válido no cadastro', String(inventory.missingNcm))}
        </>,
      )}

      {card(
        'revenue',
        <>
          {revenue.rows.map((r) => line(r.label, formatBRL(r.gross), r.fee > 0 ? `taxa estimada ${formatBRL(r.fee)}` : undefined))}
          {line('Total recebido', formatBRL(revenue.totalGross))}
          {line('Líquido estimado (sem as taxas cadastradas)', formatBRL(revenue.totalNet))}
          {revenue.totalWithoutRule > 0 && line('Recebido sem taxa cadastrada', formatBRL(revenue.totalWithoutRule), '(taxa não descontada)')}
          {line('Fechamentos de caixa', String(revenue.closings.length), revenue.closings.length > 0 ? `diferença somada ${formatBRL(revenue.closingsDifference)}` : undefined)}
        </>,
      )}

      {card(
        'open',
        <>
          {line('A receber de maquininha (repasse depois de 31/12)', formatBRL(open.cardReceivablesNet), '(estimado)')}
          {open.cardWithoutRuleCount > 0 && line('Vendas na maquininha sem taxa cadastrada', formatBRL(open.cardWithoutRule), '(não dá para saber se caíram)')}
          {line('A pagar a entregadores próprios', formatBRL(open.courierPayablesTotal))}
          <p className="mt-2 text-sm text-slate-500">Não registrados no Tchê Food: boletos de fornecedores, fiado/convênio de clientes e repasses pendentes dos apps.</p>
        </>,
      )}

      {card(
        'expenses',
        <>
          {expenses.rows.map((r) => line(r.label, r.amount === null ? 'não registrado' : formatBRL(r.amount), r.source === 'ESTIMATED' ? '(estimado)' : undefined))}
          {line('Total (só o registrado e o estimado)', formatBRL(expenses.total))}
          {expenses.withdrawals.length > 0 && line('Sangrias sem categoria (fora do total)', formatBRL(expenses.withdrawalsTotal))}
        </>,
      )}
    </div>
  );
}
