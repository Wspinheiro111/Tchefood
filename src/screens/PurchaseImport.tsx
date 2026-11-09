import { useMemo, useRef, useState } from 'react';
import { AlertTriangle, FileUp, PackageCheck, PackagePlus, Ban, Link2 } from 'lucide-react';
import { isManagerRole, selectCurrentUser, useTcheStore } from '../store/useTcheStore';
import { formatBRL, toCents } from '../lib/money';
import { formatAccessKey } from '../lib/nfce';
import { NfeImportError, parsePurchaseNfeXml, unitCostOf } from '../lib/nfeImport';
import { analyzePurchaseInvoice, preciseUnitCost, type MatchVia, type PurchaseAnalysis, type PurchaseItemDecision } from '../lib/purchaseImport';
import { sampleNfeXml } from '../data/sampleNfe';
import { Badge, Btn, toast } from '../components/ui';
import type { PurchaseItemAction, UUID } from '../types';

interface Draft {
  action: PurchaseItemAction;
  product_id: UUID | '';
  factor: string;
  name: string;
  unit: string;
  category_id: UUID;
}

const VIA_LABEL: Record<MatchVia, string> = {
  SUPPLIER_LINK: 'Vínculo do fornecedor',
  BARCODE: 'Pelo código de barras',
  NAME: 'Pelo nome',
};

const qty = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 3 });
const unitCost = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: 4 });
const titleCase = (s: string) => s.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase()).slice(0, 120);
const formatDoc = (d: string) =>
  d.length === 14 ? d.replace(/^(.{2})(.{3})(.{3})(.{4})(.{2})$/, '$1.$2.$3/$4-$5') : d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');

export function PurchaseImport() {
  const user = useTcheStore(selectCurrentUser);
  const state = useTcheStore();
  const importPurchaseInvoice = useTcheStore((s) => s.importPurchaseInvoice);
  const fileRef = useRef<HTMLInputElement>(null);
  const [xml, setXml] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [analysis, setAnalysis] = useState<PurchaseAnalysis | null>(null);
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const [error, setError] = useState<string | null>(null);

  const canImport = isManagerRole(user?.role);
  const products = useMemo(() => [...state.products].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')), [state.products]);

  const load = (content: string, name: string) => {
    setError(null);
    setAnalysis(null);
    try {
      const nfe = parsePurchaseNfeXml(content);
      const a = analyzePurchaseInvoice(state, nfe);
      const next: Record<number, Draft> = {};
      for (const it of a.items) {
        const counted = it.factor > 1;
        next[it.item.n_item] = {
          action: it.suggestion ? 'LINK' : 'CREATE',
          product_id: it.suggestion?.product_id ?? '',
          factor: String(it.factor),
          name: titleCase(it.item.description),
          unit: counted ? 'UN' : it.item.commercial_unit,
          category_id: state.categories[0]?.id ?? '',
        };
      }
      setXml(content);
      setFileName(name);
      setAnalysis(a);
      setDrafts(next);
    } catch (e) {
      setXml(null);
      setError(e instanceof NfeImportError || e instanceof Error ? e.message : 'Falha ao ler o XML.');
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    load(await file.text(), file.name);
    if (fileRef.current) fileRef.current.value = '';
  };

  const patch = (n: number, p: Partial<Draft>) => setDrafts((d) => ({ ...d, [n]: { ...d[n]!, ...p } }));

  const confirm = () => {
    if (!xml || !analysis) return;
    const decisions: PurchaseItemDecision[] = analysis.items.map(({ item }) => {
      const d = drafts[item.n_item]!;
      const factor = Number(d.factor.replace(',', '.'));
      if (d.action === 'IGNORE') return { n_item: item.n_item, action: 'IGNORE' };
      if (d.action === 'LINK') return { n_item: item.n_item, action: 'LINK', product_id: d.product_id, packaging_factor: factor };
      return { n_item: item.n_item, action: 'CREATE', packaging_factor: factor, name: d.name, unit: d.unit, category_id: d.category_id };
    });
    const missingLink = decisions.find((d) => d.action === 'LINK' && !d.product_id);
    if (missingLink) return toast.error(`Escolha o produto do item ${missingLink.n_item}.`);
    const r = importPurchaseInvoice(xml, decisions);
    if (!r.ok) return toast.error(r.error);
    toast.success(`NF-e ${r.data.invoice.number} lançada: ${r.data.movements.length} entrada(s) no estoque${r.data.createdProducts.length ? `, ${r.data.createdProducts.length} produto(s) novo(s)` : ''}.`);
    setXml(null);
    setAnalysis(null);
    setDrafts({});
  };

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-slate-700 bg-surface p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="mr-auto">
            <h2 className="text-lg font-black">Entrada de nota de compra (XML)</h2>
            <p className="text-sm text-slate-400">Envie o XML da NF-e do fornecedor. Os itens viram estoque e o custo vai para o CMV.</p>
          </div>
          <input ref={fileRef} type="file" accept=".xml,text/xml,application/xml" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
          <Btn variant="gold" disabled={!canImport} onClick={() => fileRef.current?.click()}><FileUp className="h-5 w-5" /> Enviar XML</Btn>
          <Btn variant="secondary" disabled={!canImport} onClick={() => load(sampleNfeXml(), 'exemplo.xml')}>XML de exemplo</Btn>
        </div>
        {!canImport && <p className="mt-3 text-sm text-ouro">Só gerente ou proprietário pode dar entrada em nota de compra.</p>}
        {error && <p className="mt-3 flex items-start gap-2 rounded-xl bg-brasa/15 p-3 text-sm text-rose-200"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {error}</p>}
      </div>

      {analysis && (
        <Review
          analysis={analysis}
          fileName={fileName}
          drafts={drafts}
          patch={patch}
          products={products}
          categories={state.categories}
          onCancel={() => { setAnalysis(null); setXml(null); }}
          onConfirm={confirm}
        />
      )}

      <History />
      <StockList />
    </div>
  );
}

function Review({ analysis, fileName, drafts, patch, products, categories, onCancel, onConfirm }: {
  analysis: PurchaseAnalysis;
  fileName: string;
  drafts: Record<number, Draft>;
  patch: (n: number, p: Partial<Draft>) => void;
  products: ReturnType<typeof useTcheStore.getState>['products'];
  categories: ReturnType<typeof useTcheStore.getState>['categories'];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { nfe } = analysis;
  const blocked = analysis.blocker ?? (analysis.duplicate ? `Esta NF-e já foi importada em ${new Date(analysis.duplicate.imported_at).toLocaleString('pt-BR')}.` : null);
  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-slate-700 bg-surface p-4 text-sm">
        <div className="flex flex-wrap items-start gap-3">
          <div className="mr-auto">
            <div className="text-xs uppercase tracking-wide text-slate-400">Fornecedor {analysis.supplier ? '' : '(novo)'}</div>
            <div className="text-lg font-bold">{nfe.supplier.trade_name ?? nfe.supplier.legal_name}</div>
            <div className="text-slate-400">{nfe.supplier.legal_name} · {formatDoc(nfe.supplier.document)}{nfe.supplier.city ? ` · ${nfe.supplier.city}/${nfe.supplier.state ?? ''}` : ''}</div>
          </div>
          <div className="text-right">
            <div className="text-xs uppercase tracking-wide text-slate-400">NF-e nº {nfe.number} · série {nfe.series}</div>
            <div className="text-2xl font-black tabular-nums">{formatBRL(nfe.totals.invoice_amount)}</div>
            <div className="text-slate-400">{nfe.issued_at ? new Date(nfe.issued_at).toLocaleDateString('pt-BR') : 'sem data'} · {fileName}</div>
          </div>
        </div>
        <div className="mt-2 font-mono text-xs text-slate-400">{formatAccessKey(nfe.access_key)}</div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-300">
          <span>Produtos {formatBRL(nfe.totals.products_amount)}</span>
          {nfe.totals.discount_amount > 0 && <span>Desconto −{formatBRL(nfe.totals.discount_amount)}</span>}
          {nfe.totals.freight_amount > 0 && <span>Frete {formatBRL(nfe.totals.freight_amount)}</span>}
          {nfe.totals.icms_st_amount > 0 && <span>ICMS-ST {formatBRL(nfe.totals.icms_st_amount)}</span>}
          {nfe.totals.ipi_amount > 0 && <span>IPI {formatBRL(nfe.totals.ipi_amount)}</span>}
          {nfe.authorization_protocol && <span>Protocolo {nfe.authorization_protocol}</span>}
        </div>
        {nfe.warnings.map((w) => (
          <p key={w} className="mt-2 flex items-start gap-2 rounded-xl bg-ouro/15 p-2 text-ouro"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {w}</p>
        ))}
        {blocked && <p className="mt-2 flex items-start gap-2 rounded-xl bg-brasa/15 p-3 font-bold text-rose-200"><Ban className="mt-0.5 h-4 w-4 shrink-0" /> {blocked}</p>}
      </div>

      {!blocked && analysis.items.map(({ item, suggestion, factor_source }) => {
        const d = drafts[item.n_item]!;
        const f = Number(d.factor.replace(',', '.'));
        const stockQty = f > 0 ? Math.round(item.commercial_quantity * f * 1000) / 1000 : 0;
        const linked = products.find((p) => p.id === d.product_id);
        const stockUnit = d.action === 'LINK' ? linked?.unit ?? '' : d.unit;
        return (
          <div key={item.n_item} className={`rounded-2xl border bg-surface p-4 text-sm ${d.action === 'IGNORE' ? 'border-dashed border-slate-700 opacity-70' : 'border-slate-700'}`}>
            <div className="flex flex-wrap items-start gap-2">
              <div className="mr-auto min-w-0">
                <div className="font-bold">{item.n_item}. {item.description}</div>
                <div className="text-xs text-slate-400">
                  Cód. {item.supplier_code || '—'}{item.barcode ? ` · EAN ${item.barcode}` : ''}{item.ncm ? ` · NCM ${item.ncm}` : ''}{item.cfop ? ` · CFOP ${item.cfop}` : ''}
                </div>
              </div>
              <div className="text-right tabular-nums">
                <div>{qty(item.commercial_quantity)} {item.commercial_unit} × {unitCost(item.commercial_unit_price)}</div>
                <div className="font-bold">Custo {formatBRL(item.landed_amount)}</div>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-3 gap-2">
              {([
                ['LINK', 'Vincular', Link2],
                ['CREATE', 'Criar produto', PackagePlus],
                ['IGNORE', 'Ignorar', Ban],
              ] as const).map(([key, label, Icon]) => (
                <button key={key} onClick={() => patch(item.n_item, { action: key })} className={`flex min-h-touch items-center justify-center gap-1 rounded-xl text-xs font-bold sm:text-sm ${d.action === key ? 'bg-ouro text-slate-950' : 'bg-base text-slate-300'}`}>
                  <Icon className="h-4 w-4" /> {label}
                </button>
              ))}
            </div>

            {d.action === 'LINK' && (
              <div className="mt-3">
                <select value={d.product_id} onChange={(e) => patch(item.n_item, { product_id: e.target.value })} className="min-h-touch w-full rounded-xl border border-slate-600 bg-base px-3">
                  <option value="">Escolha o produto…</option>
                  {products.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.unit}) · saldo {qty(p.stock_quantity)}</option>)}
                </select>
                {suggestion && suggestion.product_id === d.product_id && <Badge className="mt-2 bg-stone/20 text-stone">{VIA_LABEL[suggestion.via]}</Badge>}
              </div>
            )}

            {d.action === 'CREATE' && (
              <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_6rem_12rem]">
                <input value={d.name} onChange={(e) => patch(item.n_item, { name: e.target.value })} placeholder="Nome do produto" className="min-h-touch rounded-xl border border-slate-600 bg-base px-3" />
                <input value={d.unit} onChange={(e) => patch(item.n_item, { unit: e.target.value.toUpperCase() })} placeholder="UN" aria-label="Unidade de estoque" className="min-h-touch rounded-xl border border-slate-600 bg-base px-3" />
                <select value={d.category_id} onChange={(e) => patch(item.n_item, { category_id: e.target.value })} aria-label="Categoria" className="min-h-touch rounded-xl border border-slate-600 bg-base px-3">
                  {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <p className="text-xs text-slate-400 sm:col-span-3">Entra sem preço e fora da venda. Defina o preço e libere quando for vender.</p>
              </div>
            )}

            {d.action !== 'IGNORE' && (
              <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
                <label className="flex items-center gap-2">
                  1 {item.commercial_unit} =
                  <input value={d.factor} onChange={(e) => patch(item.n_item, { factor: e.target.value })} inputMode="decimal" aria-label="Fator de embalagem" className="min-h-touch w-24 rounded-xl border border-slate-600 bg-base px-3 text-right tabular-nums" />
                  {stockUnit || 'un. de estoque'}
                </label>
                {factor_source === 'INVOICE' && <Badge className="bg-slate-700">fator pela nota</Badge>}
                {factor_source === 'SUPPLIER_LINK' && <Badge className="bg-slate-700">fator da última compra</Badge>}
                <span className="ml-auto tabular-nums text-slate-300">
                  Entra <b className="text-white">{qty(stockQty)} {stockUnit}</b> a <b className="text-white">{unitCost(unitCostOf(item.landed_amount, stockQty))}</b>
                </span>
              </div>
            )}
          </div>
        );
      })}

      <div className="flex flex-wrap justify-end gap-2">
        <Btn variant="ghost" onClick={onCancel}>Cancelar</Btn>
        {!blocked && <Btn variant="success" size="lg" onClick={onConfirm}><PackageCheck className="h-5 w-5" /> Dar entrada no estoque</Btn>}
      </div>
    </div>
  );
}

function History() {
  const invoices = useTcheStore((s) => s.purchaseInvoices);
  const suppliers = useTcheStore((s) => s.suppliers);
  if (!invoices.length) return null;
  return (
    <div className="scroll-thin overflow-x-auto rounded-2xl border border-slate-700 bg-surface">
      <div className="px-4 pt-3 text-xs font-semibold uppercase tracking-wide text-slate-400">Notas lançadas</div>
      <table className="w-full min-w-[560px] text-sm">
        <thead className="text-left text-slate-400"><tr><th className="p-3">Lançada em</th><th className="p-3">Fornecedor</th><th className="p-3">NF-e</th><th className="p-3 text-right">Itens</th><th className="p-3 text-right">Valor</th><th className="p-3 text-right">No estoque</th></tr></thead>
        <tbody>
          {invoices.map((i) => {
            const s = suppliers.find((x) => x.id === i.supplier_id);
            return (
              <tr key={i.id} className="border-t border-slate-700">
                <td className="p-3">{new Date(i.imported_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
                <td className="p-3">{s?.trade_name ?? s?.legal_name ?? '?'}</td>
                <td className="p-3">{i.number}/{i.series}</td>
                <td className="p-3 text-right tabular-nums">{i.items_count}</td>
                <td className="p-3 text-right tabular-nums">{formatBRL(i.invoice_amount)}</td>
                <td className="p-3 text-right tabular-nums">{formatBRL(i.stocked_amount)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function StockList() {
  const products = useTcheStore((s) => s.products);
  const movements = useTcheStore((s) => s.stockMovements);
  const rows = products.filter((p) => p.stock_quantity !== 0).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  if (!rows.length) return null;
  // Valor com o custo de 4 casas (o cost_price de 2 casas perderia centavos: 24 × 3,73 ≠ 89,60).
  const totalCents = rows.reduce((acc, p) => acc + toCents(Math.max(0, p.stock_quantity) * preciseUnitCost(p, movements)), 0);
  const total = totalCents / 100;
  return (
    <div className="scroll-thin overflow-x-auto rounded-2xl border border-slate-700 bg-surface">
      <div className="flex justify-between px-4 pt-3 text-xs font-semibold uppercase tracking-wide text-slate-400"><span>Estoque e custo médio</span><span>Valor em estoque {formatBRL(total)}</span></div>
      <table className="w-full min-w-[480px] text-sm">
        <thead className="text-left text-slate-400"><tr><th className="p-3">Produto</th><th className="p-3 text-right">Saldo</th><th className="p-3 text-right">Custo médio</th><th className="p-3 text-right">Preço de venda</th></tr></thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id} className="border-t border-slate-700">
              <td className="p-3">{p.name}{!p.available && <Badge className="ml-2 bg-slate-700">fora da venda</Badge>}</td>
              <td className="p-3 text-right tabular-nums">{qty(p.stock_quantity)} {p.unit}</td>
              <td className="p-3 text-right tabular-nums">{unitCost(preciseUnitCost(p, movements))}</td>
              <td className="p-3 text-right tabular-nums">{p.price > 0 ? formatBRL(p.price) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
