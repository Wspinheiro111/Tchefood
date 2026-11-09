/**
 * Combos.
 *
 * O combo é um produto (is_combo) com o preço do combo. As escolhas dele usam os
 * grupos de adicionais do próprio produto: cada opção que aponta para um produto
 * (component_product_id) coloca esse produto no pedido. Um grupo com uma opção só
 * é um item fixo do combo; um grupo com várias é a escolha do cliente, e o
 * additional_price da opção é o acréscimo da troca (ex.: suco +R$ 4).
 *
 * No pedido:
 *  - o item do combo leva o preço (unit_price do combo + acréscimos) e é a linha da
 *    NFC-e e do cupom. Não vai para a produção (setor NONE, já entregue);
 *  - cada componente vira um item de preço zero, no setor do produto dele, ligado
 *    ao combo por combo_parent_item_id: aparece no KDS, baixa o barril do chopp e
 *    gera a ficha no balcão, sem mexer no total da conta.
 *  - cancelar o combo cancela os componentes junto; componente sozinho não é cancelado.
 * O banco confere o vínculo (db/schema_combos.sql).
 */
import type { KegTapProduct, ModifierOption, OrderItem, Product, SelectedModifier, UUID } from '../types';
import { resolveKegVolume } from './kegs';
import { uuid } from './ids';

export const COMBO_COMPONENT_MAX_QTY = 20;

export interface ComboContext {
  products: Product[];
  modifierOptions: ModifierOption[];
  kegTapProducts: KegTapProduct[];
}

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

/** Produtos que as opções escolhidas colocam no combo, na ordem da escolha. */
export function comboComponents(
  combo: Product,
  modifiers: ReadonlyArray<Pick<SelectedModifier, 'option_id'>>,
  ctx: Pick<ComboContext, 'products' | 'modifierOptions'>,
): Result<Array<{ product: Product; quantity: number; option: ModifierOption }>> {
  if (!combo.is_combo) return { ok: true, data: [] };
  const out: Array<{ product: Product; quantity: number; option: ModifierOption }> = [];
  for (const m of modifiers) {
    const option = ctx.modifierOptions.find((o) => o.id === m.option_id);
    if (!option?.component_product_id) continue;
    const product = ctx.products.find((p) => p.id === option.component_product_id);
    if (!product || !product.active) return { ok: false, error: `${option.name} saiu do cardápio. Atualize o combo ${combo.name}.` };
    if (!product.available) return { ok: false, error: `${product.name} está em falta (combo ${combo.name}).` };
    if (product.is_combo || product.sold_by_weight) return { ok: false, error: `${option.name} não pode fazer parte de um combo.` };
    out.push({ product, quantity: option.component_quantity, option });
  }
  if (out.length === 0) return { ok: false, error: `O combo ${combo.name} está sem itens. Confira os grupos do combo no cadastro.` };
  return { ok: true, data: out };
}

/** Algum componente escolhido pede o ponto da carne. */
export function comboNeedsDoneness(
  combo: Product,
  modifiers: ReadonlyArray<Pick<SelectedModifier, 'option_id'>>,
  ctx: Pick<ComboContext, 'products' | 'modifierOptions'>,
): boolean {
  if (!combo.is_combo) return false;
  return modifiers.some((m) => {
    const option = ctx.modifierOptions.find((o) => o.id === m.option_id);
    const product = option?.component_product_id ? ctx.products.find((p) => p.id === option.component_product_id) : undefined;
    return Boolean(product?.requires_meat_doneness);
  });
}

/**
 * Itens do pedido para um combo: o próprio combo (fora da produção) e um item de
 * preço zero por componente. Itens comuns voltam sozinhos, sem mudança.
 */
export function expandComboItem(
  item: OrderItem,
  product: Product,
  modifiers: ReadonlyArray<Pick<SelectedModifier, 'option_id'>>,
  ctx: ComboContext,
): Result<OrderItem[]> {
  if (!product.is_combo) return { ok: true, data: [item] };
  const comps = comboComponents(product, modifiers, ctx);
  if (!comps.ok) return comps;
  const parent: OrderItem = { ...item, sector: 'NONE', status: 'DELIVERED', keg_volume_ml: null, combo_parent_item_id: null };
  const label = `Combo ${product.name}${item.notes ? ` · ${item.notes}` : ''}`;
  const children = comps.data.map(({ product: comp, quantity }): OrderItem => ({
    ...item,
    id: uuid(),
    product_id: comp.id,
    quantity: Math.round(item.quantity * quantity * 1000) / 1000,
    unit_price: 0,
    modifiers_unit_price: 0,
    total_item_price: 0,
    meat_doneness: comp.requires_meat_doneness ? item.meat_doneness : null,
    notes: label,
    sector: comp.sector,
    keg_volume_ml: resolveKegVolume(comp.id, [], ctx.kegTapProducts, ctx.modifierOptions),
    combo_parent_item_id: parent.id,
  }));
  return { ok: true, data: [parent, ...children] };
}

/** Componentes (de preço zero) de um combo lançado. */
export function comboChildrenOf(itemId: UUID, items: ReadonlyArray<OrderItem>): OrderItem[] {
  return items.filter((i) => i.combo_parent_item_id === itemId);
}

/** Item que aparece na conta, no cupom e na NFC-e (o componente do combo não aparece: o combo leva o preço). */
export function isBillableItem(item: Pick<OrderItem, 'combo_parent_item_id'>): boolean {
  return item.combo_parent_item_id == null;
}
