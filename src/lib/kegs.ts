/**
 * Monitor de barris de chopp — espelho de tchefood_keg_item_volume() e
 * tchefood_keg_on_item() em db/schema_expansion.sql.
 *
 *  - Cada produto sai de UMA torneira (keg_tap_products.product_id é único).
 *  - O volume por unidade vem da opção de tamanho escolhida (modifier_options
 *    .volume_ml) ou, sem ela, do padrão da torneira (pour_ml).
 *  - Venda soma em billed_volume_ml. Cancelar antes de servir devolve ao barril;
 *    cancelar depois de servir (READY/DELIVERED) vira desperdício registrado.
 *  - Só conta para o barril engatado: item lançado antes do tapped_at é do
 *    barril anterior.
 */
import type { KegTap, KegTapProduct, ModifierOption, OrderItem, SelectedModifier, UUID } from '../types';

/** remaining_volume_ml é coluna gerada no banco: recalculada aqui igual. */
export function withRemaining(tap: KegTap): KegTap {
  return { ...tap, remaining_volume_ml: Math.max(tap.total_capacity_ml - tap.billed_volume_ml - tap.wasted_foam_ml, 0) };
}

/** Volume (ml) que UMA unidade do produto tira do barril, ou null se não sai de torneira. */
export function resolveKegVolume(
  productId: UUID,
  modifiers: ReadonlyArray<Pick<SelectedModifier, 'option_id'>>,
  links: readonly KegTapProduct[],
  options: readonly ModifierOption[],
): number | null {
  const link = links.find((l) => l.product_id === productId);
  if (!link) return null;
  for (const m of modifiers) {
    const opt = options.find((o) => o.id === m.option_id);
    if (opt?.volume_ml) return opt.volume_ml;
  }
  return link.pour_ml;
}

function itemMl(item: Pick<OrderItem, 'quantity' | 'keg_volume_ml'>): number {
  return item.keg_volume_ml ? Math.round(item.quantity * item.keg_volume_ml) : 0;
}

function tapFor(item: Pick<OrderItem, 'product_id' | 'created_at'>, taps: readonly KegTap[], links: readonly KegTapProduct[]): KegTap | null {
  const link = links.find((l) => l.product_id === item.product_id);
  if (!link) return null;
  const tap = taps.find((t) => t.id === link.tap_id);
  if (!tap || !tap.active || item.created_at < tap.tapped_at) return null;
  return tap;
}

/** Venda (INSERT em order_items): baixa no barril. */
export function applyKegSale(taps: readonly KegTap[], links: readonly KegTapProduct[], items: readonly OrderItem[]): KegTap[] {
  let out = [...taps];
  for (const item of items) {
    if (item.status === 'CANCELED') continue;
    const ml = itemMl(item);
    const tap = ml ? tapFor(item, out, links) : null;
    if (!tap) continue;
    out = out.map((t) => (t.id === tap.id ? withRemaining({ ...t, billed_volume_ml: t.billed_volume_ml + ml }) : t));
  }
  return out;
}

/** Cancelamento: `before` é o item antes de virar CANCELED (o status anterior decide). */
export function applyKegCancel(taps: readonly KegTap[], links: readonly KegTapProduct[], before: OrderItem): KegTap[] {
  if (before.status === 'CANCELED') return [...taps];
  const ml = itemMl(before);
  const tap = ml ? tapFor(before, taps, links) : null;
  if (!tap) return [...taps];
  const poured = before.status === 'READY' || before.status === 'DELIVERED';
  return taps.map((t) =>
    t.id === tap.id
      ? withRemaining({ ...t, billed_volume_ml: t.billed_volume_ml - ml, wasted_foam_ml: t.wasted_foam_ml + (poured ? ml : 0) })
      : t,
  );
}

export type KegAlert = 'OK' | 'WARN' | 'CRITICAL';

/** Tolerância de perda não explicada sobre o volume que realmente saiu do barril. */
export const KEG_LOSS_WARN_PCT = 3;
export const KEG_LOSS_CRITICAL_PCT = 6;
/** Barril quase vazio: avisa para trocar antes de faltar no meio do baile. */
export const KEG_LOW_PCT = 15;

export interface KegStatus {
  tap: KegTap;
  /** Estimado pelo caixa (faturado + desperdício registrado). */
  estimatedRemainingMl: number;
  levelPct: number;
  /** Volume real que saiu do barril (só com leitura). */
  realConsumedMl: number | null;
  /** Saiu do barril e não foi faturado nem registrado como desperdício. */
  unexplainedLossMl: number | null;
  unexplainedLossPct: number | null;
  /** Faturado ÷ realmente consumido (100% = nenhuma perda). */
  efficiencyPct: number | null;
  /** Prejuízo da perda não explicada pelo custo do barril. */
  lossValue: number | null;
  /** Faturado + desperdício passou da capacidade do barril. */
  oversold: boolean;
  low: boolean;
  alert: KegAlert;
  message: string;
}

export function kegStatus(tap: KegTap): KegStatus {
  const cap = tap.total_capacity_ml;
  const estimated = Math.max(cap - tap.billed_volume_ml - tap.wasted_foam_ml, 0);
  const oversold = tap.billed_volume_ml + tap.wasted_foam_ml > cap;
  const measured = tap.measured_remaining_ml;
  const remainingForLevel = measured ?? estimated;
  const levelPct = Math.max(0, Math.min(100, Math.round((remainingForLevel / cap) * 100)));
  const low = levelPct <= KEG_LOW_PCT;

  let realConsumedMl: number | null = null;
  let unexplainedLossMl: number | null = null;
  let unexplainedLossPct: number | null = null;
  let efficiencyPct: number | null = null;
  let lossValue: number | null = null;
  let alert: KegAlert = 'OK';
  let message = measured === null ? 'Sem leitura real: nível estimado pelo caixa.' : 'Volume real bate com o faturado.';

  if (measured !== null) {
    realConsumedMl = Math.max(cap - measured, 0);
    unexplainedLossMl = realConsumedMl - tap.billed_volume_ml - tap.wasted_foam_ml;
    unexplainedLossPct = realConsumedMl > 0 ? Math.round((unexplainedLossMl / realConsumedMl) * 1000) / 10 : 0;
    efficiencyPct = realConsumedMl > 0 ? Math.round((tap.billed_volume_ml / realConsumedMl) * 1000) / 10 : 100;
    lossValue = Math.round(((Math.max(unexplainedLossMl, 0) * tap.keg_cost) / cap) * 100) / 100;
    if (unexplainedLossPct > KEG_LOSS_CRITICAL_PCT) {
      alert = 'CRITICAL';
      message = `${(unexplainedLossMl / 1000).toFixed(1)} L saíram do barril sem faturar nem registrar desperdício.`;
    } else if (unexplainedLossPct > KEG_LOSS_WARN_PCT) {
      alert = 'WARN';
      message = `Perda acima de ${KEG_LOSS_WARN_PCT}%: confira sangria e espuma.`;
    } else if (unexplainedLossMl < -Math.max(500, cap * 0.02)) {
      alert = 'WARN';
      message = 'Faturado acima do que saiu do barril: confira a leitura ou chopp lançado e não servido.';
    }
  }
  if (oversold) {
    alert = 'CRITICAL';
    message = 'Faturado + desperdício passou da capacidade do barril: confira o cadastro do barril.';
  } else if (low && alert === 'OK') {
    alert = 'WARN';
    message = 'Barril no fim: prepare a troca.';
  }
  return { tap, estimatedRemainingMl: estimated, levelPct, realConsumedMl, unexplainedLossMl, unexplainedLossPct, efficiencyPct, lossValue, oversold, low, alert, message };
}

export function formatLiters(ml: number): string {
  return `${(ml / 1000).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} L`;
}
