/**
 * Retaguarda › Fechamento anual: os quatro relatórios que a contabilidade pede na
 * virada do ano, com o ano escolhido e exportação em Excel (CSV) e PDF (imprimir).
 * Só proprietário e gerente. Nada é inventado: o que o app não registra aparece como
 * "não registrado", e o que é estimativa vem marcado.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { FileSpreadsheet, Printer, RefreshCw } from 'lucide-react';
import { Btn, toast } from '../components/ui';
import { isManagerRole, selectCurrentUser, useTcheStore } from '../store/useTcheStore';
import { useOwnerSettings } from '../store/useOwnerSettings';
import { formatBRL } from '../lib/money';
import type { MarketplaceSale } from '../lib/ownerDashboard';
import { brasiliaDateTime, brasiliaYear, clockBeforeYear, defaultYear, ownStore, rejectedInvoiceIds, reviewDuplicateInvoices, expensesByCategory, invoiceDate, inventoryAt, openPositionsAt, positionCutoff, revenueByMethod, testInvoiceMovementIds, validYear, yearInProgress, yearPeriod, yearsWithData } from '../lib/annualClose';
import { DEVICE_ONLY, expensesDoc, fileName, inventoryDoc, openDoc, periodLabel, REPORT_TITLE, revenueDoc, toCsv, toPrintableHtml, type AnnualReportKind, type ReportDoc } from '../lib/annualCloseExport';

/**
 * Pedidos dos apps: a tela de Delivery do aparelho ainda é o simulador (o servidor do
 * iFood está em homologação), então nenhum pedido de app entra no fechamento.
 */
const NO_MARKETPLACE: MarketplaceSale[] = [];
/**
 * O instante real em que a tela abriu (ou foi atualizada), sem arredondar: é o corte
 * dos números, e a tela mostra até os segundos.
 */
const captureNow = (): Date => new Date();
/** Hora em que o arquivo foi gerado (pode ser depois do instante dos números, dito no período). */
const generatedAtLabel = (): string => new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

/**
 * No app Android (Smart POS / tablet) o WebView não salva arquivo nem imprime página:
 * a exportação fica no navegador. Detecta pela ponte nativa que o APK instala.
 */
const inAndroidApp = (): boolean => typeof window !== 'undefined' && 'SmartPosNative' in window;

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
    toast.info('O navegador bloqueou a janela de impressão. Se o arquivo HTML baixou, abra e imprima em PDF; se não, libere pop-ups para o Tchê Food.');
    return;
  }
  win.opener = null;
  win.document.open();
  win.document.write(html);
  win.document.close();
  win.focus();
  window.setTimeout(() => win.print(), 300);
}

/** Dados do aparelho que entram nos relatórios (a loja inclusive). */
const SNAPSHOT_KEYS = [
  'tenant', 'staff', 'products', 'stockMovements', 'payments', 'cashSessions', 'cashMovements', 'purchaseInvoices',
  'suppliers', 'ownDeliveries', 'courierSettlements', 'couriers', 'orders', 'purchaseInvoiceItems', 'syncRejected',
] as const;
const FEE_KEYS = ['feeRules', 'appCommissionPct', 'feeTenantId'] as const;
type TcheData = Pick<ReturnType<typeof useTcheStore.getState>, (typeof SNAPSHOT_KEYS)[number]>;
type FeeData = Pick<ReturnType<typeof useOwnerSettings.getState>, (typeof FEE_KEYS)[number]>;
interface Snapshot extends TcheData, FeeData {
  now: Date;
}

/**
 * Foto do aparelho num instante: o relógio E os dados. O relatório parcial é a posição
 * nesse instante com os dados que o aparelho tinha nele; o que chega depois (sincronização,
 * venda nova, recusa da nuvem) só entra quando a pessoa toca em Atualizar, que tira uma
 * foto nova (com novo instante, mostrado no relatório).
 */
function captureSnapshot(): Snapshot {
  const s = useTcheStore.getState();
  const o = useOwnerSettings.getState();
  const out = { now: captureNow() } as Record<string, unknown>;
  for (const k of SNAPSHOT_KEYS) out[k] = s[k];
  for (const k of FEE_KEYS) out[k] = o[k];
  return out as unknown as Snapshot;
}

/**
 * Mesmo conteúdo? A busca da nuvem recria as listas a cada minuto mesmo sem mudança, então
 * compara pelo conteúdo (calculado uma vez por lista nova).
 */
const contentCache = new WeakMap<object, string>();
function content(v: unknown): string {
  if (typeof v !== 'object' || v === null) return JSON.stringify(v ?? null);
  let c = contentCache.get(v);
  if (c === undefined) {
    c = JSON.stringify(v);
    contentCache.set(v, c);
  }
  return c;
}
const same = (a: unknown, b: unknown): boolean => a === b || content(a) === content(b);

export function AnnualClose() {
  const user = useTcheStore(selectCurrentUser);
  const [snap, setSnap] = useState(captureSnapshot);
  const refresh = () => setSnap(captureSnapshot());
  // Chegou dado novo depois da foto: avisa e oferece Atualizar (os números não mudam sozinhos).
  const tcheChanged = useTcheStore((s) => SNAPSHOT_KEYS.some((k) => !same(s[k], snap[k])));
  const feesChanged = useOwnerSettings((s) => FEE_KEYS.some((k) => !same(s[k], snap[k])));
  // As taxas ainda não tinham carregado do aparelho quando a tela abriu: tira a foto de novo
  // assim que carregarem (antes disso a tela não mostrou taxa nenhuma de verdade).
  useEffect(() => {
    if (useOwnerSettings.persist.hasHydrated()) return;
    return useOwnerSettings.persist.onFinishHydration(() => setSnap(captureSnapshot()));
  }, []);
  const dataChanged = tcheChanged || feesChanged;
  const now = snap.now;
  const {
    tenant,
    staff,
    products: allProducts,
    stockMovements: allStockMovements,
    payments: allPayments,
    cashSessions: allCashSessions,
    cashMovements: allCashMovements,
    purchaseInvoices: allPurchaseInvoices,
    suppliers,
    ownDeliveries: allOwnDeliveries,
    courierSettlements: allCourierSettlements,
    couriers,
    orders: allOrders,
    purchaseInvoiceItems,
    syncRejected,
  } = snap;
  // Taxas e comissões só valem se foram gravadas (ou confirmadas) nesta loja: as de outra
  // loja que ficaram no aparelho, ou de antes de o app registrar a loja, contam como NÃO
  // cadastradas (o repasse fica "situação desconhecida"), nunca como as desta loja.
  const feesOwned = snap.feeTenantId === tenant.id;
  const hasFees = snap.feeRules.length > 0 || Object.values(snap.appCommissionPct).some((v) => v !== null && v !== undefined);
  const feesForeign = hasFees && !feesOwned;
  const feeRules = useMemo(() => (feesOwned ? snap.feeRules : []), [feesOwned, snap.feeRules]);
  const appCommissionPct = useMemo(() => (feesOwned ? snap.appCommissionPct : {}), [feesOwned, snap.appCommissionPct]);
  // Só a loja deste aparelho (o que sobrou de outra loja fica fora e é avisado).
  const ownProducts = useMemo(() => ownStore(allProducts, tenant.id), [allProducts, tenant.id]);
  const products = ownProducts.rows;
  const ownStockMovements = useMemo(() => ownStore(allStockMovements, tenant.id), [allStockMovements, tenant.id]);
  const stockMovements = ownStockMovements.rows;
  const ownPayments = useMemo(() => ownStore(allPayments, tenant.id), [allPayments, tenant.id]);
  const payments = ownPayments.rows;
  const ownCashSessions = useMemo(() => ownStore(allCashSessions, tenant.id), [allCashSessions, tenant.id]);
  const cashSessions = ownCashSessions.rows;
  const ownCashMovements = useMemo(() => ownStore(allCashMovements, tenant.id), [allCashMovements, tenant.id]);
  const cashMovements = ownCashMovements.rows;
  const ownPurchaseInvoices = useMemo(() => ownStore(allPurchaseInvoices, tenant.id), [allPurchaseInvoices, tenant.id]);
  const purchaseInvoices = ownPurchaseInvoices.rows;
  const ownOwnDeliveries = useMemo(() => ownStore(allOwnDeliveries, tenant.id), [allOwnDeliveries, tenant.id]);
  const ownDeliveries = ownOwnDeliveries.rows;
  const ownCourierSettlements = useMemo(() => ownStore(allCourierSettlements, tenant.id), [allCourierSettlements, tenant.id]);
  const courierSettlements = ownCourierSettlements.rows;
  const ownOrders = useMemo(() => ownStore(allOrders, tenant.id), [allOrders, tenant.id]);
  const orders = ownOrders.rows;
  const otherStore = ownProducts.other + ownStockMovements.other + ownPayments.other + ownCashSessions.other + ownCashMovements.other + ownPurchaseInvoices.other + ownOwnDeliveries.other + ownCourierSettlements.other + ownOrders.other;
  const marketplace = NO_MARKETPLACE;
  const androidApp = inAndroidApp();

  // "Agora" fixo enquanto a tela está aberta (o instante real, mostrado com segundos):
  // os quatro relatórios, a lista de anos, o título e as notas usam o
  // mesmo instante. "Atualizar" e a troca de ano pegam um novo.
  // A lista de anos só depende do ANO de agora (não refaz a cada Atualizar).
  const nowYear = brasiliaYear(now.toISOString());
  const yearAnchor = useMemo(() => new Date(Date.UTC(nowYear ?? 1970, 6, 1)), [nowYear]);
  const years = useMemo(
    () =>
      yearsWithData([
        ...payments.map((p) => p.created_at),
        ...stockMovements.map((m) => m.created_at),
        ...purchaseInvoices.map((i) => {
          const t = invoiceDate(i.issued_at);
          return t !== null ? new Date(t).toISOString() : i.imported_at;
        }),
        ...cashSessions.map((s) => s.closed_at ?? s.opened_at),
        ...courierSettlements.map((s) => s.created_at),
        ...cashMovements.map((m) => m.created_at),
        ...ownDeliveries.map((d) => d.delivered_at ?? d.created_at),
      ], yearAnchor),
    [payments, stockMovements, purchaseInvoices, cashSessions, courierSettlements, cashMovements, ownDeliveries, yearAnchor],
  );
  const [picked, setPicked] = useState<number | null>(null);
  // Relógio do aparelho fora de 2000–2100 deixa a lista sem o ano corrente; sem nenhum ano, usa 2000.
  const year = picked !== null && validYear(picked) && years.includes(picked) ? picked : defaultYear(years, now) ?? 2000;
  // Ano escolhido que sumiu da lista (sincronização): volta ao padrão e não pula de volta depois.
  useEffect(() => {
    if (picked !== null && !years.includes(picked)) setPicked(null);
  }, [picked, years]);
  const period = useMemo(() => yearPeriod(year), [year]);
  const partial = yearInProgress(period, now);
  const clockWrong = clockBeforeYear(period, now);

  const testMovements = useMemo(() => testInvoiceMovementIds(stockMovements, purchaseInvoiceItems, purchaseInvoices), [stockMovements, purchaseInvoiceItems, purchaseInvoices]);
  // Prova de duplicata: a nuvem recusou a NF-e deste aparelho (fila de recusados).
  const rejectedInvoices = useMemo(() => rejectedInvoiceIds(syncRejected ?? []), [syncRejected]);
  const duplicateReview = useMemo(() => reviewDuplicateInvoices(stockMovements, purchaseInvoiceItems, purchaseInvoices, rejectedInvoices, positionCutoff(period, now)), [stockMovements, purchaseInvoiceItems, purchaseInvoices, rejectedInvoices, period, now]);
  const inventory = useMemo(
    () => inventoryAt(products, stockMovements, period, testMovements, now, duplicateReview.excluded, duplicateReview.unconfirmed),
    [products, stockMovements, period, testMovements, now, duplicateReview],
  );
  const revenue = useMemo(
    () => revenueByMethod({ payments, marketplace, feeRules, appCommissionPct, cashSessions, cashMovements, staff, orders }, period, now),
    [payments, marketplace, feeRules, appCommissionPct, cashSessions, cashMovements, staff, orders, period, now],
  );
  const open = useMemo(
    () => openPositionsAt({ payments, feeRules, ownDeliveries, courierSettlements, couriers, orders }, period, now),
    [payments, feeRules, ownDeliveries, courierSettlements, couriers, orders, period, now],
  );
  const expenses = useMemo(
    () => expensesByCategory({ purchaseInvoices, suppliers, courierSettlements, cashMovements, revenue }, period, now),
    [purchaseInvoices, suppliers, courierSettlements, cashMovements, revenue, period, now],
  );

  if (!isManagerRole(user?.role)) return <p className="p-6">Só o proprietário e o gerente veem o fechamento anual.</p>;

  const cutoffLabel = brasiliaDateTime(positionCutoff(period, now));
  const clockNote = `ATENÇÃO: o relógio deste aparelho estava em ${brasiliaDateTime(now.getTime())}, antes de ${year} começar, quando este relatório foi gerado. Os números são do ano inteiro, mas confira a data e a hora do aparelho.`;
  const otherNote = `${otherStore} registro(s) de outra loja ou sem loja identificada que ficaram neste aparelho (de antes de ligá-lo a esta loja) foram deixados de fora dos totais.`;
  // Notas que vão em todos os relatórios exportados (as mesmas que a tela mostra no topo).
  const feesNote = 'As taxas da maquininha e as comissões dos apps gravadas neste aparelho não estão confirmadas como desta loja (são de outra loja ou de antes desta versão): foram tratadas como NÃO cadastradas (repasse com situação desconhecida, taxa estimada zero). Se forem desta loja, toque em "As taxas são desta loja" no topo do Fechamento anual.';
  const partialNote = [
    ...(feesForeign ? [feesNote] : []),
    ...(partial ? [`O ano de ${year} ainda não terminou: os números vão até ${cutoffLabel} (horário de Brasília), não até 31/12.`] : []),
    ...(clockWrong ? [clockNote] : []),
    ...(otherStore > 0 ? [otherNote] : []),
  ];
  // Registros do ano datados depois do corte (lançados depois de abrir a tela, ou relógio
  // errado): cada relatório conta as suas fontes, então a tela mostra por relatório.
  const late = (
    [
      ['inventory', inventory.afterCutoff],
      ['revenue', revenue.afterCutoff],
      ['open', open.afterCutoff],
      ['expenses', expenses.afterCutoff],
    ] as Array<[AnnualReportKind, number]>
  ).filter(([, n]) => n > 0);
  // Datas inválidas por relatório (cada relatório conta as suas fontes: uma sangria
  // inválida aparece no faturamento e nas despesas).
  const invalid = (
    [
      ['inventory', inventory.invalidDates],
      ['revenue', revenue.invalidDates],
      ['open', open.invalidDates],
      ['expenses', expenses.invalidDates],
    ] as Array<[AnnualReportKind, number]>
  ).filter(([, n]) => n > 0);
  const appNote = 'Pedidos dos apps de delivery (iFood etc.) NÃO estão neste relatório: a integração ainda está em homologação. Informe o faturamento e as comissões pelo extrato do app.';

  const build = (kind: AnnualReportKind): ReportDoc => {
    const base = {
      period: periodLabel(kind, period, now),
      store: { name: tenant.name, legalName: tenant.legal_name, cnpj: tenant.cnpj, city: tenant.city, state: tenant.state },
      generatedAt: `${generatedAtLabel()} (dados do aparelho em ${brasiliaDateTime(now.getTime())})`,
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

  // O ano terminou com a tela aberta: o relatório "em andamento" ficaria velho. Atualiza e
  // pede para exportar de novo, em vez de gerar um arquivo que se contradiz.
  const fresh = (): boolean => {
    if (!partial || Date.now() < period.to) return true;
    refresh();
    window.alert(`O ano de ${year} terminou com a tela aberta: os números foram atualizados até 31/12. Exporte de novo.`);
    return false;
  };

  const actions = (kind: AnnualReportKind) => androidApp ? null : (
    <div className="flex flex-wrap gap-2">
      <Btn variant="secondary" aria-label={`${REPORT_TITLE[kind]}: baixar Excel (CSV)`} onClick={() => fresh() && download(fileName(kind, year, 'csv'), toCsv(build(kind)), 'text/csv;charset=utf-8')}>
        <FileSpreadsheet className="h-4 w-4" /> Excel (CSV)
      </Btn>
      <Btn variant="secondary" aria-label={`${REPORT_TITLE[kind]}: PDF ou imprimir`} onClick={() => fresh() && printDoc(build(kind), fileName(kind, year, 'html'))}>
        <Printer className="h-4 w-4" /> PDF / imprimir
      </Btn>
    </div>
  );

  const card = (kind: AnnualReportKind, summary: ReactNode) => (
    <section className="rounded-2xl border border-slate-200 bg-base p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-black">{REPORT_TITLE[kind]}</h3>
          <p className="text-sm text-slate-500">{periodLabel(kind, period, now)}</p>
        </div>
        {actions(kind)}
      </div>
      {summary}
      {/* As mesmas observações que vão no CSV/PDF: quem só vê a tela (app Android) lê tudo. */}
      <details open className="mt-3 rounded-xl bg-surface p-3 text-sm">
        <summary className="cursor-pointer font-bold">Observações deste relatório</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-slate-600">
          {build(kind).notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      </details>
    </section>
  );

  const line = (label: string, value: string, hint?: string) => (
    <div key={label} className="flex items-baseline justify-between gap-3 border-b border-slate-100 py-1 text-sm last:border-0">
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
        <select
          id="annual-year"
          className="min-h-touch rounded-xl border border-slate-300 bg-base px-3 font-bold"
          value={year}
          onChange={(e) => {
            setPicked(Number(e.target.value));
            refresh();
          }}
        >
          {years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
        <span className="text-sm text-slate-500">{periodLabel('revenue', period, now)}, horário de Brasília.</span>
        {androidApp && (
          <p role="status" className="w-full rounded-xl bg-amarelo/15 p-3 text-sm">
            O app Tchê Food para Android ainda não salva planilha nem PDF: confira os números aqui na tela. Exportar por outro aparelho não resolve, porque as vendas deste aparelho ficam nele.
          </p>
        )}
        <p role="note" className="w-full rounded-xl bg-amarelo/15 p-3 text-sm font-semibold">
          {DEVICE_ONLY}
        </p>
        {dataChanged && (
          <div role="status" className="flex w-full flex-wrap items-center justify-between gap-2 rounded-xl bg-amarelo/15 p-3 text-sm font-semibold">
            <span>Chegaram dados novos neste aparelho depois de {brasiliaDateTime(now.getTime())}. Os números abaixo (e o que exportar) continuam sendo os daquele instante; toque em Atualizar para gerar uma posição nova.</span>
            <Btn variant="secondary" aria-label="Atualizar com os dados novos" onClick={refresh}>
              <RefreshCw className="h-4 w-4" /> Atualizar
            </Btn>
          </div>
        )}
        {feesForeign && (
          <div role="alert" className="flex w-full flex-wrap items-center justify-between gap-2 rounded-xl bg-amarelo/15 p-3 text-sm">
            <span>{feesNote}</span>
            <Btn
              variant="secondary"
              aria-label="As taxas são desta loja"
              onClick={() => {
                useOwnerSettings.getState().confirmFeesTenant(tenant.id);
                refresh();
              }}
            >
              As taxas são desta loja
            </Btn>
          </div>
        )}
        {partial && (
          <div role="status" className="flex w-full flex-wrap items-center justify-between gap-2 rounded-xl bg-amarelo/15 p-3 text-sm">
            <span>
              {year} ainda não terminou: os números vão até {cutoffLabel} (horário de Brasília), quando a tela foi aberta ou atualizada. Gere de novo depois de 31/12.
            </span>
            <Btn variant="secondary" aria-label="Atualizar os números até agora" onClick={() => refresh()}>
              <RefreshCw className="h-4 w-4" /> Atualizar
            </Btn>
          </div>
        )}
        {late.length > 0 && (
          <p role="alert" className="w-full rounded-xl bg-rose-100 p-3 text-sm">
            Atenção: registros com data a partir de {cutoffLabel} (instante deste relatório) ficaram de fora ({late.map(([k, n]) => `${REPORT_TITLE[k]}: ${n}`).join('; ')}). Se foram lançados agora, toque em Atualizar; se não, confira o relógio do aparelho.
          </p>
        )}
        {clockWrong && (
          <p role="alert" className="w-full rounded-xl bg-rose-100 p-3 text-sm">
            Atenção: o relógio deste aparelho está em {brasiliaDateTime(now.getTime())}, antes de {year} começar. Os relatórios mostram o ano inteiro, mas acerte a data e a hora do aparelho antes de enviar ao contador.
          </p>
        )}
        {otherStore > 0 && (
          <p role="status" className="w-full rounded-xl bg-amarelo/15 p-3 text-sm">
            {otherNote}
          </p>
        )}
        {invalid.length > 0 && (
          <p role="alert" className="w-full rounded-xl bg-rose-100 p-3 text-sm">
            Atenção: registros com data inválida ficaram fora dos relatórios ({invalid.map(([k, n]) => `${REPORT_TITLE[k]}: ${n}`).join('; ')}). Se forem deste ano, os totais estão menores: avise o suporte antes de enviar ao contador.
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
          {revenue.rows.map((r) => line(r.label, r.notTracked ? 'não registrado' : formatBRL(r.gross), r.notTracked ? '(VR/VA está dentro de crédito/débito)' : r.fee > 0 ? `taxa estimada ${formatBRL(r.fee)}` : undefined))}
          {line('Total recebido (bruto)', formatBRL(revenue.totalGross))}
          {line('Líquido estimado (já descontadas as taxas cadastradas)', formatBRL(revenue.totalNet))}
          {line('Gorjetas (fora do total)', formatBRL(revenue.tips))}
          {revenue.serviceFee > 0 && line('Taxa de serviço dentro do total', formatBRL(revenue.serviceFee), '(é gorjeta pela Lei 13.419/2017: veja com o contador)')}
          {revenue.totalWithoutRule > 0 && line('Recebido sem taxa cadastrada', formatBRL(revenue.totalWithoutRule), '(taxa não descontada)')}
          {revenue.simulatorCount > 0 && line('Simulador de maquininha (fora do total)', formatBRL(revenue.simulatorAmount))}
          {line('Fechamentos de caixa', String(revenue.closings.length), revenue.closings.length > 0 ? `diferença somada ${formatBRL(revenue.closingsDifference)}` : undefined)}
          {revenue.openSessions > 0 && line('Turnos de caixa abertos no fim do período', String(revenue.openSessions), '(fechamento fora deste relatório)')}
          {revenue.cashUndeterminedSessionCount > 0 && line('Dinheiro com situação de caixa indeterminada', formatBRL(revenue.cashUndeterminedSession), '(turno com data inválida)')}
          {revenue.cashOutsideSessionsCount > 0 && line('Dinheiro recebido sem caixa aberto', formatBRL(revenue.cashOutsideSessions), '(está no Dinheiro, fora dos fechamentos)')}
          <p className="mt-2 text-sm text-slate-500">Fora deste relatório: pedidos dos apps de delivery (informe pelo extrato do app) e estornos feitos na maquininha (abata pelo extrato da adquirente).</p>
        </>,
      )}

      {card(
        'open',
        <>
          {line(partial ? 'A receber de maquininha (repasse de hoje em diante)' : `A receber de maquininha (repasse depois de 31/12/${year})`, formatBRL(open.cardReceivablesNet), '(estimado)')}
          {open.cardWithoutRuleCount > 0 && line('Situação de repasse desconhecida (sem taxa cadastrada)', formatBRL(open.cardWithoutRule), `(${open.cardWithoutRuleCount} venda(s); pode já ter caído; fora do A receber${open.cardWithoutRulePriorYearsCount > 0 ? `; inclui ${open.cardWithoutRulePriorYearsCount} venda(s) de anos anteriores, ${formatBRL(open.cardWithoutRulePriorYears)}` : ''})`)}
          {line('A receber: dinheiro com entregadores', formatBRL(open.courierCashTotal))}
          {line('A pagar a entregadores próprios', formatBRL(open.courierPayablesTotal))}
          <p className="mt-2 text-sm text-slate-500">Não registrados no Tchê Food (informe pelo seu controle): boletos de fornecedores, fiado/convênio de clientes, repasses pendentes dos apps e gorjetas/taxa de serviço devidas à equipe.</p>
        </>,
      )}

      {card(
        'expenses',
        <>
          {expenses.rows.map((r) => line(r.label, r.amount === null ? 'não registrado' : formatBRL(r.amount), r.source === 'ESTIMATED' ? '(estimado)' : undefined))}
          {line('Total (só o registrado e o estimado)', formatBRL(expenses.total))}
          {expenses.withdrawals.length > 0 && line('Sangrias sem categoria (fora do total)', formatBRL(expenses.withdrawalsTotal))}
          {expenses.duplicateInvoices > 0 && line('NF-e repetidas contadas uma vez', String(expenses.duplicateInvoices))}
          {expenses.invalidIssueDates > 0 && line('NF-e com data de emissão inválida', String(expenses.invalidIssueDates), '(contadas pela data da importação: confira o ano)')}
        </>,
      )}
    </div>
  );
}
