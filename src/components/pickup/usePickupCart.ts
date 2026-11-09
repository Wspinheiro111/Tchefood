import { useCallback, useMemo, useState } from 'react';
import { useTcheStore, type PickupLine } from '../../store/useTcheStore';
import type { Product } from '../../types';
import { computeItemTotal, formatBRL, halfAndHalfPrice, round2 } from '../../lib/money';
import type { ProductDraft } from '../ProductSheet';

/** Linha do carrinho do pedido com senha. O preço aqui é só prévia: o store recalcula pelo cadastro. */
export interface PickupCartLine extends PickupLine {
  key: string;
  label: string;
  details: string[];
  unitTotal: number;
}

export function lineKey(d: Pick<PickupLine, 'product_id' | 'meat_doneness' | 'modifiers' | 'half_product_ids' | 'quick_tags' | 'free_notes'>): string {
  return [
    d.product_id,
    d.meat_doneness ?? '',
    d.modifiers.map((m) => m.option_id).sort().join(','),
    [...d.half_product_ids].sort().join(','),
    [...d.quick_tags].sort().join(','),
    d.free_notes.trim(),
  ].join('|');
}

export function usePickupCart() {
  const products = useTcheStore((s) => s.products);
  const links = useTcheStore((s) => s.productModifierGroups);
  const pricing = useTcheStore((s) => s.halfAndHalfPricing);
  const [lines, setLines] = useState<PickupCartLine[]>([]);

  /** Produto que precisa de escolha (ponto, adicionais obrigatórios, meio a meio) abre a ficha de opções. */
  const needsOptions = (p: Product) => p.requires_meat_doneness || p.allows_half_and_half || links.some((l) => l.product_id === p.id);

  const add = (d: Omit<PickupLine, 'quantity'> & { quantity: number }) => {
    const product = products.find((p) => p.id === d.product_id);
    if (!product) return;
    const halves = d.half_product_ids.map((id) => products.find((p) => p.id === id)).filter((p): p is Product => Boolean(p));
    const base = halves.length ? halfAndHalfPrice([product.price, ...halves.map((h) => h.price)], pricing) : product.price;
    const mods = round2(d.modifiers.reduce((a, m) => a + m.additional_price, 0));
    const details = [
      ...(halves.length ? [`1/2 ${product.name} + ${halves.map((h) => `1/2 ${h.name}`).join(' + ')}`] : []),
      ...(d.meat_doneness ? [d.meat_doneness] : []),
      ...d.modifiers.map((m) => `+ ${m.name}${m.additional_price ? ` (${formatBRL(m.additional_price)})` : ''}`),
      ...d.quick_tags,
      ...(d.free_notes.trim() ? [d.free_notes.trim()] : []),
    ];
    const key = lineKey(d);
    const quantity = Math.max(1, Math.round(d.quantity));
    setLines((c) => {
      const found = c.find((l) => l.key === key);
      if (found) return c.map((l) => (l.key === key ? { ...l, quantity: Math.min(l.quantity + quantity, 99) } : l));
      return [...c, { ...d, quantity, key, label: product.name, details, unitTotal: round2(base + mods) }];
    });
  };

  const addSimple = (p: Product) =>
    add({ product_id: p.id, quantity: 1, modifiers: [], meat_doneness: null, half_product_ids: [], quick_tags: [], free_notes: '' });

  const addDraft = (d: ProductDraft) =>
    add({
      product_id: d.product_id,
      quantity: d.quantity,
      modifiers: d.modifiers,
      meat_doneness: d.meat_doneness,
      half_product_ids: d.half_product_ids,
      quick_tags: d.quick_tags,
      free_notes: d.free_notes,
    });

  const setQty = (key: string, q: number) =>
    setLines((c) => (q <= 0 ? c.filter((l) => l.key !== key) : c.map((l) => (l.key === key ? { ...l, quantity: Math.min(q, 99) } : l))));

  const clear = useCallback(() => setLines([]), []);

  const total = useMemo(() => round2(lines.reduce((a, l) => a + computeItemTotal(l.quantity, l.unitTotal, 0), 0)), [lines]);
  const count = lines.reduce((a, l) => a + l.quantity, 0);

  const toInput = (): PickupLine[] =>
    lines.map(({ product_id, quantity, modifiers, meat_doneness, half_product_ids, quick_tags, free_notes }) => ({
      product_id,
      quantity,
      modifiers,
      meat_doneness,
      half_product_ids,
      quick_tags,
      free_notes,
    }));

  return { lines, add, addSimple, addDraft, setQty, clear, total, count, needsOptions, toInput };
}

/** Cardápio vendável no pedido com senha (sem buffet a quilo). */
export function usePickupMenu() {
  const categories = useTcheStore((s) => s.categories);
  const products = useTcheStore((s) => s.products);
  return useMemo(() => {
    const sellable = products.filter((p) => !p.sold_by_weight);
    const cats = categories
      .filter((c) => c.active && sellable.some((p) => p.category_id === c.id))
      .sort((a, b) => a.sort_order - b.sort_order);
    return { cats, sellable };
  }, [categories, products]);
}
