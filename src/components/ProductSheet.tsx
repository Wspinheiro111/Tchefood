import { useEffect, useMemo, useState } from 'react';
import { Check } from 'lucide-react';
import { useSalePrice } from '../lib/useSalePrice';
import { useTcheStore } from '../store/useTcheStore';
import type { ModifierGroup, Product, SelectedModifier, TrayItem } from '../types';
import { computeItemTotal, formatBRL, halfAndHalfPrice } from '../lib/money';
import { MEAT_DONENESS_OPTIONS, QUICK_TAGS } from '../data/seed';
import { Btn, Sheet, Stepper } from './ui';

export type ProductDraft = Omit<TrayItem, 'tray_id' | 'added_at' | 'order_id'>;

interface Props {
  product: Product | null;
  onClose: () => void;
  onConfirm: (draft: ProductDraft) => void;
  confirmLabel?: string;
  /** Cliente via QR não vê tags de cozinha internas como "Prioridade". */
  audience?: 'waiter' | 'customer';
}

const DONENESS_COLOR: Record<string, string> = {
  'Mal Passada': 'bg-rose-700',
  'Ao Ponto Menos': 'bg-rose-500',
  'Ao Ponto': 'bg-orange-500',
  'Bem Passada': 'bg-amber-800',
};

/** Modal de lançamento: Ponto da Carne, adicionais, meio-a-meio e tags de 1 toque. */
export function ProductSheet({ product, onClose, onConfirm, confirmLabel = 'Adicionar à bandeja', audience = 'waiter' }: Props) {
  const products = useTcheStore((s) => s.products);
  const links = useTcheStore((s) => s.productModifierGroups);
  const groupsAll = useTcheStore((s) => s.modifierGroups);
  const optionsAll = useTcheStore((s) => s.modifierOptions);
  const pricingRule = useTcheStore((s) => s.halfAndHalfPricing);
  const priceOf = useSalePrice();

  const [qty, setQty] = useState(1);
  const [doneness, setDoneness] = useState<string | null>(null);
  const [mods, setMods] = useState<SelectedModifier[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [notes, setNotes] = useState('');
  const [half, setHalf] = useState<string | null>(null);

  useEffect(() => {
    setQty(1);
    setDoneness(null);
    setMods([]);
    setTags([]);
    setNotes('');
    setHalf(null);
  }, [product?.id]);

  const groups = useMemo<ModifierGroup[]>(() => {
    if (!product) return [];
    return links
      .filter((l) => l.product_id === product.id)
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((l) => groupsAll.find((g) => g.id === l.group_id))
      .filter((g): g is ModifierGroup => Boolean(g));
  }, [product, links, groupsAll]);

  if (!product) return null;

  const halfOptions = product.allows_half_and_half
    ? products.filter((p) => p.allows_half_and_half && p.active && p.available && p.id !== product.id && p.category_id === product.category_id)
    : [];
  const halfProduct = half ? products.find((p) => p.id === half) : undefined;
  const unitPrice = halfProduct ? halfAndHalfPrice([priceOf(product), priceOf(halfProduct)], pricingRule) : priceOf(product);
  const modsPrice = mods.reduce((a, m) => a + m.additional_price, 0);
  const total = computeItemTotal(qty, unitPrice, modsPrice);

  const toggleOption = (g: ModifierGroup, optionId: string) => {
    const opt = optionsAll.find((o) => o.id === optionId)!;
    setMods((cur) => {
      const inGroup = cur.filter((m) => m.group_id === g.id);
      const exists = inGroup.some((m) => m.option_id === optionId);
      if (exists) return cur.filter((m) => m.option_id !== optionId);
      const entry: SelectedModifier = { group_id: g.id, option_id: opt.id, name: opt.name, additional_price: opt.additional_price };
      if (g.max_selection === 1) return [...cur.filter((m) => m.group_id !== g.id), entry];
      if (inGroup.length >= g.max_selection) return cur;
      return [...cur, entry];
    });
  };

  const missing: string[] = [];
  if (product.requires_meat_doneness && !doneness) missing.push('Ponto da carne');
  for (const g of groups) {
    const n = mods.filter((m) => m.group_id === g.id).length;
    const min = g.required ? Math.max(1, g.min_selection) : g.min_selection;
    if (n < min) missing.push(g.name);
  }

  const tagList = QUICK_TAGS[product.sector].filter((t) => audience === 'waiter' || t !== 'Prioridade');

  const confirm = () => {
    if (missing.length) return;
    onConfirm({
      product_id: product.id,
      half_product_ids: halfProduct ? [halfProduct.id] : [],
      quantity: qty,
      unit_price: unitPrice,
      modifiers: mods,
      modifiers_unit_price: modsPrice,
      meat_doneness: doneness,
      quick_tags: tags,
      free_notes: notes,
      sector: product.sector,
    });
  };

  return (
    <Sheet
      open
      onClose={onClose}
      title={
        <span>
          <span className="mr-2 rounded bg-slate-200 px-1.5 py-0.5 font-mono text-sm text-brasa">{product.code}</span>
          {product.name}
        </span>
      }
      footer={
        <div className="flex items-center gap-3">
          <Stepper value={qty} onChange={setQty} />
          <Btn block size="lg" disabled={missing.length > 0} onClick={confirm}>
            {missing.length ? `Falta: ${missing[0]}` : `${confirmLabel} · ${formatBRL(total)}`}
          </Btn>
        </div>
      }
    >
      {product.description && <p className="mb-3 text-sm text-slate-500">{product.description}</p>}

      {product.requires_meat_doneness && (
        <section className="mb-4">
          <h3 className="mb-2 flex items-center gap-2 font-bold">
            Ponto da Carne <span className="rounded bg-brasa px-1.5 text-[10px] font-black uppercase">Obrigatório</span>
          </h3>
          <div className="grid grid-cols-2 gap-2">
            {MEAT_DONENESS_OPTIONS.map((d) => (
              <button
                key={d}
                onClick={() => setDoneness(d)}
                className={`flex min-h-touch-lg items-center justify-center gap-2 rounded-xl border-2 text-base font-bold ${
                  doneness === d ? 'border-ouro bg-ouro/20 text-slate-900' : 'border-slate-300 bg-base text-slate-700'
                }`}
              >
                <span className={`h-4 w-4 rounded-full ${DONENESS_COLOR[d]}`} />
                {d}
              </button>
            ))}
          </div>
        </section>
      )}

      {halfOptions.length > 0 && (
        <section className="mb-4">
          <h3 className="mb-1 font-bold">Meio-a-meio <span className="text-xs font-normal text-slate-500">(cobra pelo {pricingRule === 'HIGHEST' ? 'maior valor' : 'valor médio'})</span></h3>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => setHalf(null)} className={`min-h-touch rounded-xl px-3 text-sm font-semibold ${!half ? 'bg-ouro text-slate-950' : 'bg-slate-200'}`}>Inteira</button>
            {halfOptions.map((p) => (
              <button key={p.id} onClick={() => setHalf(p.id)} className={`min-h-touch rounded-xl px-3 text-sm font-semibold ${half === p.id ? 'bg-ouro text-slate-950' : 'bg-slate-200'}`}>
                ½ {p.name.replace('Pizza ', '')} · {formatBRL(priceOf(p))}
              </button>
            ))}
          </div>
        </section>
      )}

      {groups.map((g) => {
        const opts = optionsAll.filter((o) => o.group_id === g.id);
        const selected = mods.filter((m) => m.group_id === g.id);
        return (
          <section key={g.id} className="mb-4">
            <h3 className="mb-2 flex items-center gap-2 font-bold">
              {g.name}
              {g.required ? (
                <span className="rounded bg-brasa px-1.5 text-[10px] font-black uppercase">Obrigatório</span>
              ) : (
                <span className="text-xs font-normal text-slate-500">até {g.max_selection}</span>
              )}
            </h3>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {opts.map((o) => {
                const on = selected.some((m) => m.option_id === o.id);
                return (
                  <button
                    key={o.id}
                    onClick={() => toggleOption(g, o.id)}
                    className={`flex min-h-touch items-center justify-between rounded-xl border-2 px-3 text-left ${on ? 'border-stone bg-stone/15' : 'border-slate-300 bg-base'}`}
                  >
                    <span className="flex items-center gap-2 font-semibold">
                      <span className={`grid h-6 w-6 place-items-center rounded-md border-2 ${on ? 'border-stone bg-stone text-white' : 'border-slate-300'}`}>{on && <Check className="h-4 w-4" />}</span>
                      {o.name}
                    </span>
                    <span className="text-sm text-slate-700">{o.additional_price > 0 ? `+ ${formatBRL(o.additional_price)}` : 'grátis'}</span>
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}

      <section className="mb-4">
        <h3 className="mb-2 font-bold">Observações rápidas</h3>
        <div className="flex flex-wrap gap-2">
          {tagList.map((t) => {
            const on = tags.includes(t);
            return (
              <button
                key={t}
                onClick={() => setTags((cur) => (on ? cur.filter((x) => x !== t) : [...cur, t]))}
                className={`min-h-touch rounded-full px-4 text-sm font-semibold ${on ? 'bg-sky-500 text-white' : 'bg-slate-200 text-slate-800'}`}
              >
                {t}
              </button>
            );
          })}
        </div>
        <input
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Outra observação…"
          className="mt-2 min-h-touch w-full rounded-xl border border-slate-300 bg-base px-3 outline-none focus:border-ouro"
        />
      </section>
    </Sheet>
  );
}
