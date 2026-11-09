import { useMemo, useRef, useState } from 'react';
import { Beer, CupSoda, Drumstick, Flame, IceCreamCone, Martini, Pizza, Scale, Utensils, UtensilsCrossed, type LucideIcon } from 'lucide-react';
import { ArrowLeft, ChevronDown, ChevronUp, Minus, Plus, Search, Send, SlidersHorizontal, Trash2 } from 'lucide-react';
import { useSalePrice } from '../lib/useSalePrice';
import { useTcheStore } from '../store/useTcheStore';
import type { Product, ProductionSector } from '../types';
import { computeItemTotal, formatBRL, formatQty } from '../lib/money';
import { playDispatchChime, vibrate } from '../lib/sound';
import { ProductSheet, type ProductDraft } from '../components/ProductSheet';
import { Badge, Btn, toast } from '../components/ui';
import { StatementPanel } from './StatementPanel';
import { printDispatchedItems } from '../components/PrintSimulator';
import { ScaleSheet } from '../components/ScaleSheet';

export const SECTOR_LABEL: Record<ProductionSector, string> = {
  GRILL: '🔥 Parrilla',
  KITCHEN: '🍳 Cozinha',
  BAR: '🍺 Bar',
  DESSERT: '🍮 Sobremesa',
  NONE: 'Sem preparo',
};

const CATEGORY_ICONS: Record<string, LucideIcon> = { Flame, UtensilsCrossed, Drumstick, Pizza, Beer, Martini, CupSoda, IceCreamCone, Scale };

export function CategoryIcon({ name, className }: { name: string | null; className?: string }) {
  const Cmp = (name && CATEGORY_ICONS[name]) || Utensils;
  return <Cmp className={className} />;
}

export function OrderScreen({ orderId, onBack, onCheckout }: { orderId: string; onBack: () => void; onCheckout: (orderId: string) => void }) {
  const order = useTcheStore((s) => s.orders.find((o) => o.id === orderId));
  const table = useTcheStore((s) => s.tables.find((t) => t.id === order?.table_id));
  const [tab, setTab] = useState<'menu' | 'statement'>('menu');

  if (!order || !table) {
    return (
      <div className="p-6 text-center">
        <p className="mb-4">Comanda não encontrada ou já encerrada.</p>
        <Btn onClick={onBack}>Voltar ao mapa</Btn>
      </div>
    );
  }

  const closed = order.status === 'CLOSED' || order.status === 'CANCELED';

  return (
    <div className="mx-auto flex min-h-full max-w-5xl flex-col">
      <div className="sticky top-[56px] z-20 border-b border-slate-800 bg-base/95 px-3 py-2 backdrop-blur">
        <div className="flex items-center gap-2">
          <button aria-label="Voltar" onClick={onBack} className="grid h-12 w-12 place-items-center rounded-xl bg-surface active:bg-slate-700">
            <ArrowLeft className="h-6 w-6" />
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xl font-black">{table.label}</div>
            <div className="text-xs text-slate-400">
              {table.area} · {order.customer_count} pessoa(s) · {closed ? 'Encerrada' : table.status === 'WAITING_BILL' ? 'Pediu a conta' : table.status === 'PAYING' ? 'Em pagamento' : 'Aberta'}
            </div>
          </div>
          <div className="text-right">
            <div className="text-xs text-slate-400">{order.paid_amount > 0 ? 'Saldo' : 'Total'}</div>
            <div className="text-xl font-black tabular-nums text-ouro">{formatBRL(order.paid_amount > 0 ? order.remaining_balance : order.total_amount)}</div>
          </div>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <button onClick={() => setTab('menu')} disabled={closed} className={`min-h-touch rounded-xl font-bold disabled:opacity-40 ${tab === 'menu' ? 'bg-brasa text-white' : 'bg-surface text-slate-300'}`}>Lançar</button>
          <button onClick={() => setTab('statement')} className={`min-h-touch rounded-xl font-bold ${tab === 'statement' || closed ? 'bg-brasa text-white' : 'bg-surface text-slate-300'}`}>Extrato da mesa</button>
        </div>
      </div>

      {tab === 'menu' && !closed ? <MenuPanel orderId={orderId} /> : <StatementPanel orderId={orderId} onCheckout={() => onCheckout(orderId)} />}
    </div>
  );
}

function MenuPanel({ orderId }: { orderId: string }) {
  const categories = useTcheStore((s) => s.categories);
  const products = useTcheStore((s) => s.products);
  const links = useTcheStore((s) => s.productModifierGroups);
  const addToTray = useTcheStore((s) => s.addToTray);
  const priceOf = useSalePrice();
  const [cat, setCat] = useState<string>(categories.find((c) => c.active)?.id ?? '');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Product | null>(null);
  const [scaleOpen, setScaleOpen] = useState(false);
  const hasWeighable = products.some((p) => p.sold_by_weight && p.available);
  const inputRef = useRef<HTMLInputElement>(null);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    const live = products.filter((p) => p.active && categories.some((c) => c.id === p.category_id && c.active));
    if (q) return live.filter((p) => p.code.toLowerCase().startsWith(q) || p.name.toLowerCase().includes(q));
    return live.filter((p) => p.category_id === cat);
  }, [products, categories, cat, query]);

  const needsSheet = (p: Product) => p.requires_meat_doneness || p.allows_half_and_half || links.some((l) => l.product_id === p.id);

  const add = (draft: ProductDraft) => {
    const r = addToTray({ ...draft, order_id: orderId });
    if (!r.ok) return toast.error(r.error);
    vibrate(20);
    toast.info(`+ ${draft.quantity}x ${products.find((p) => p.id === draft.product_id)?.name} na bandeja`);
    setSelected(null);
  };

  const tapProduct = (p: Product, forceSheet = false) => {
    if (!p.available) return toast.error(`${p.name} em falta hoje.`);
    if (p.sold_by_weight) return setScaleOpen(true);
    if (forceSheet || needsSheet(p)) return setSelected(p);
    add({ product_id: p.id, half_product_ids: [], quantity: 1, unit_price: priceOf(p), modifiers: [], modifiers_unit_price: 0, meat_doneness: null, quick_tags: [], free_notes: '', sector: p.sector });
  };

  const submitCode = () => {
    const exact = list.find((p) => p.code === query.trim());
    if (exact) {
      tapProduct(exact);
      setQuery('');
      inputRef.current?.focus();
    }
  };

  return (
    <div className="flex-1 px-3 pb-40 pt-3">
      <div className="relative mb-3">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-500" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submitCode()}
          inputMode="search"
          placeholder="Código rápido (ex.: 101) ou nome…"
          className="min-h-touch-lg w-full rounded-xl border border-slate-700 bg-surface pl-11 pr-3 text-lg outline-none focus:border-ouro"
        />
      </div>
      {hasWeighable && (
        <Btn block size="lg" variant="gold" className="mb-3" onClick={() => setScaleOpen(true)}>
          <Scale className="h-5 w-5" /> ⚖️ Lançar Buffet a Quilo (Balança)
        </Btn>
      )}
      {!query && (
        <div className="scroll-thin -mx-3 mb-3 flex gap-2 overflow-x-auto px-3 pb-1">
          {categories.filter((c) => c.active).sort((a, b) => a.sort_order - b.sort_order).map((c) => (
            <button
              key={c.id}
              onClick={() => setCat(c.id)}
              className={`flex min-h-touch shrink-0 items-center gap-2 rounded-full px-4 font-semibold ${cat === c.id ? 'bg-ouro text-slate-950' : 'bg-surface text-slate-300'}`}
            >
              <CategoryIcon name={c.icon_name} className="h-4 w-4" /> {c.name}
            </button>
          ))}
        </div>
      )}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {list.map((p) => (
          <div key={p.id} className={`flex items-stretch overflow-hidden rounded-xl border border-slate-700 bg-surface ${!p.available ? 'opacity-40' : ''}`}>
            <button onClick={() => tapProduct(p)} className="flex min-h-[64px] flex-1 items-center gap-3 px-3 text-left active:bg-slate-700">
              <span className="rounded bg-base px-2 py-1 font-mono text-sm font-bold text-ouro">{p.code}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold">{p.name}</span>
                <span className="flex flex-wrap gap-1 text-xs text-slate-400">
                  {SECTOR_LABEL[p.sector]}
                  {p.requires_meat_doneness && <Badge className="bg-rose-900/60 text-rose-200">Ponto</Badge>}
                  {p.allows_half_and_half && <Badge className="bg-amber-900/60 text-amber-200">½ a ½</Badge>}
                  {p.sold_by_weight && <Badge className="bg-emerald-900/60 text-emerald-200">por kg</Badge>}
                  {!p.available && <Badge className="bg-slate-700">Em falta</Badge>}
                </span>
              </span>
              <span className="font-bold tabular-nums">{formatBRL(priceOf(p))}{p.sold_by_weight ? '/kg' : ''}</span>
            </button>
            {!needsSheet(p) && !p.sold_by_weight && p.available && (
              <button aria-label="Opções" onClick={() => tapProduct(p, true)} className="grid w-12 place-items-center border-l border-slate-700 text-slate-400 active:bg-slate-700">
                <SlidersHorizontal className="h-5 w-5" />
              </button>
            )}
          </div>
        ))}
        {list.length === 0 && <p className="py-8 text-center text-slate-500">Nenhum produto encontrado.</p>}
      </div>

      <ProductSheet product={selected} onClose={() => setSelected(null)} onConfirm={add} />
      <ScaleSheet orderId={orderId} open={scaleOpen} onClose={() => setScaleOpen(false)} />
      <DispatchTray orderId={orderId} />
    </div>
  );
}

/** Bandeja de despacho: itens ainda não enviados à produção (podem ser removidos livremente). */
function DispatchTray({ orderId }: { orderId: string }) {
  const allTray = useTcheStore((s) => s.tray);
  const tray = useMemo(() => allTray.filter((t) => t.order_id === orderId), [allTray, orderId]);
  const products = useTcheStore((s) => s.products);
  const updateQty = useTcheStore((s) => s.updateTrayQty);
  const remove = useTcheStore((s) => s.removeFromTray);
  const dispatch = useTcheStore((s) => s.dispatchTray);
  const sound = useTcheStore((s) => s.soundEnabled);
  const [expanded, setExpanded] = useState(false);

  if (tray.length === 0) return null;
  const total = tray.reduce((a, t) => a + computeItemTotal(t.quantity, t.unit_price, t.modifiers_unit_price), 0);
  const count = tray.reduce((a, t) => a + (t.weight ? 1 : t.quantity), 0);

  const send = () => {
    const r = dispatch(orderId);
    if (!r.ok) return toast.error(r.error);
    if (sound) playDispatchChime();
    vibrate([40, 30, 40]);
    // Prato pesado já foi servido no buffet: não vai para a produção.
    printDispatchedItems(r.data.items.filter((i) => i.weight_gross_grams === null));
    toast.success(`✅ ${r.data.count} item(ns) enviados: ${r.data.sectors.map((s) => SECTOR_LABEL[s]).join(' · ')}`);
    setExpanded(false);
  };

  return (
    <div className="fixed inset-x-0 bottom-0 z-30 mx-auto max-w-5xl border-t-2 border-ouro bg-surface shadow-2xl shadow-black">
      <button onClick={() => setExpanded((e) => !e)} className="flex w-full items-center justify-between px-4 py-2 text-left">
        <span className="font-bold">Bandeja de despacho · {count} item(ns)</span>
        <span className="flex items-center gap-2 font-bold text-ouro">{formatBRL(total)} {expanded ? <ChevronDown className="h-5 w-5" /> : <ChevronUp className="h-5 w-5" />}</span>
      </button>
      {expanded && (
        <ul className="scroll-thin max-h-[45vh] space-y-2 overflow-y-auto px-3 pb-2">
          {tray.map((t) => {
            const p = products.find((x) => x.id === t.product_id);
            const half = t.half_product_ids.map((id) => products.find((x) => x.id === id)?.name).filter(Boolean);
            const extras = [t.meat_doneness, ...(half.length ? [`½ ${half.join(', ½ ')}`] : []), ...t.modifiers.map((m) => `+${m.name}`), ...t.quick_tags, t.free_notes].filter(Boolean);
            return (
              <li key={t.tray_id} className="flex items-center gap-2 rounded-xl bg-base p-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold">{p?.name}</div>
                  {extras.length > 0 && <div className="truncate text-xs text-sky-300">{extras.join(' · ')}</div>}
                  <div className="text-xs text-slate-400">{SECTOR_LABEL[t.sector]} · {formatBRL(computeItemTotal(t.quantity, t.unit_price, t.modifiers_unit_price))}</div>
                </div>
                {t.weight ? (
                  <span className="rounded-lg bg-emerald-900/60 px-2 py-1 text-sm font-bold tabular-nums text-emerald-200">⚖️ {formatQty(t.quantity, 'KG')}{t.weight.source === 'MANUAL' ? ' · digitado' : ''}</span>
                ) : (
                  <>
                    <button aria-label="Menos" onClick={() => updateQty(t.tray_id, t.quantity - 1)} className="grid h-11 w-11 place-items-center rounded-lg bg-slate-700"><Minus className="h-5 w-5" /></button>
                    <span className="w-6 text-center font-bold">{t.quantity}</span>
                    <button aria-label="Mais" onClick={() => updateQty(t.tray_id, t.quantity + 1)} className="grid h-11 w-11 place-items-center rounded-lg bg-slate-700"><Plus className="h-5 w-5" /></button>
                  </>
                )}
                <button aria-label="Remover" onClick={() => remove(t.tray_id)} className="grid h-11 w-11 place-items-center rounded-lg text-rose-300"><Trash2 className="h-5 w-5" /></button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="px-3 pb-3">
        <Btn block size="lg" variant="success" onClick={send}>
          <Send className="h-5 w-5" /> Enviar para produção
        </Btn>
      </div>
    </div>
  );
}
