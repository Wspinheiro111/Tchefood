/**
 * Motor financeiro do Tchê Food.
 *
 * Toda a aritmética é feita em CENTAVOS inteiros para eliminar erros de
 * ponto flutuante (0.1 + 0.2). O arredondamento replica o round() do
 * PostgreSQL para NUMERIC: meio para longe do zero (half away from zero).
 *
 * As mesmas fórmulas estão na função PL/pgSQL tchefood_recalc_order()
 * em db/schema.sql — qualquer mudança aqui deve ser espelhada lá.
 */
import type { Order, OrderItem, Payment } from '../types';

/** round(x, 2) do PostgreSQL, devolvendo centavos inteiros. */
export function toCents(value: number): number {
  // Number.EPSILON corrige representações como 1.005 -> 1.00499999...
  const scaled = Math.abs(value) * 100;
  const rounded = Math.round(scaled + Number.EPSILON * scaled);
  return value < 0 ? -rounded : rounded;
}

export function fromCents(cents: number): number {
  return cents / 100;
}

/** Arredonda para 2 casas com a mesma regra do PostgreSQL. */
export function round2(value: number): number {
  return fromCents(toCents(value));
}

/** Quantidade é NUMERIC(10,3). */
export function round3(value: number): number {
  const scaled = Math.abs(value) * 1000;
  const rounded = Math.round(scaled + Number.EPSILON * scaled);
  return (value < 0 ? -rounded : rounded) / 1000;
}

/**
 * total_item_price = round(quantity * (unit_price + modifiers_unit_price), 2)
 */
export function computeItemTotal(
  quantity: number,
  unitPrice: number,
  modifiersUnitPrice: number,
): number {
  const unitCents = toCents(unitPrice) + toCents(modifiersUnitPrice);
  // quantidade pode ser fracionada (ex.: 0.5 kg); multiplica em milésimos.
  const qtyMillis = Math.round(round3(quantity) * 1000);
  const raw = (unitCents * qtyMillis) / 1000; // ainda em centavos, pode ter fração
  return fromCents(Math.sign(raw) * Math.round(Math.abs(raw)));
}

/** Taxa de serviço: round(subtotal * pct / 100, 2). */
export function computeServiceFee(subtotal: number, pct: number): number {
  const subtotalCents = toCents(subtotal);
  // pct é NUMERIC(5,2) -> trabalha em centésimos de ponto percentual
  const pctHundredths = Math.round(pct * 100);
  const raw = (subtotalCents * pctHundredths) / 10000;
  return fromCents(Math.round(raw));
}

export interface OrderTotals {
  subtotal_items: number;
  service_fee_amount: number;
  discount_amount: number;
  total_amount: number;
  paid_amount: number;
  remaining_balance: number;
}

/**
 * Recalcula TODOS os campos financeiros de uma comanda de uma só vez.
 *
 *  subtotal_items     = Σ total_item_price dos itens com status <> 'CANCELED'
 *  service_fee_amount = charge_service_fee ? round(subtotal * pct / 100, 2) : 0
 *  discount_amount    = min(discount_amount, subtotal + taxa)   (nunca negativo)
 *  total_amount       = subtotal + taxa - desconto
 *  paid_amount        = Σ amount dos pagamentos com status = 'APPROVED'
 *                       (gorjeta tip_amount NÃO abate saldo)
 *  remaining_balance  = max(total - pago, 0)
 */
export function computeOrderTotals(
  order: Pick<Order, 'id' | 'charge_service_fee' | 'service_fee_pct' | 'discount_amount'>,
  items: readonly OrderItem[],
  payments: readonly Payment[],
): OrderTotals {
  const subtotalCents = items
    .filter((i) => i.order_id === order.id && i.status !== 'CANCELED')
    .reduce((acc, i) => acc + toCents(i.total_item_price), 0);

  const feeCents = order.charge_service_fee
    ? toCents(computeServiceFee(fromCents(subtotalCents), order.service_fee_pct))
    : 0;

  const grossCents = subtotalCents + feeCents;
  const discountCents = Math.min(Math.max(toCents(order.discount_amount), 0), grossCents);
  const totalCents = grossCents - discountCents;

  const paidCents = payments
    .filter((p) => p.order_id === order.id && p.status === 'APPROVED')
    .reduce((acc, p) => acc + toCents(p.amount), 0);

  const remainingCents = Math.max(totalCents - paidCents, 0);

  return {
    subtotal_items: fromCents(subtotalCents),
    service_fee_amount: fromCents(feeCents),
    discount_amount: fromCents(discountCents),
    total_amount: fromCents(totalCents),
    paid_amount: fromCents(paidCents),
    remaining_balance: fromCents(remainingCents),
  };
}

/** Aplica os totais recalculados sobre a comanda (imutável). */
export function applyOrderTotals(
  order: Order,
  items: readonly OrderItem[],
  payments: readonly Payment[],
): Order {
  return { ...order, ...computeOrderTotals(order, items, payments) };
}

/** "2x" para unidades; "0,365 kg" para itens pesados (unit = KG). */
export function formatQty(quantity: number, unit: string | null | undefined): string {
  if (unit === 'KG') return `${round3(quantity).toLocaleString('pt-BR', { minimumFractionDigits: 3, maximumFractionDigits: 3 })} kg`;
  return `${quantity}x`;
}

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

export function formatBRL(value: number): string {
  return brl.format(round2(value));
}

/** Preço de pizza meio-a-meio: maior valor ou média dos sabores. */
export function halfAndHalfPrice(prices: readonly number[], rule: 'HIGHEST' | 'AVERAGE'): number {
  if (prices.length === 0) return 0;
  if (rule === 'HIGHEST') return Math.max(...prices.map(round2));
  const sumCents = prices.reduce((acc, p) => acc + toCents(p), 0);
  return fromCents(Math.round(sumCents / prices.length));
}

/**
 * Valor a cobrar no modo "Pagamento por Item Consumido".
 *
 *  itens     = Σ total_item_price dos itens selecionados
 *  taxa      = charge_service_fee ? round(itens * pct / 100, 2) : 0   (10% proporcional)
 *  desconto  = round(discount_amount * itens / subtotal_items, 2)     (rateio proporcional)
 *  cota      = min(itens + taxa - desconto, remaining_balance)
 *
 * Quando a seleção cobre TODOS os itens ainda não pagos, a cota é exatamente o
 * remaining_balance (absorve centavos de arredondamento das cotas anteriores).
 */
export function computeItemsShare(
  order: Pick<Order, 'id' | 'charge_service_fee' | 'service_fee_pct' | 'discount_amount' | 'subtotal_items' | 'remaining_balance'>,
  selected: readonly OrderItem[],
  allItems: readonly OrderItem[],
): { items: number; fee: number; discount: number; share: number; coversAll: boolean } {
  const valid = selected.filter((i) => i.order_id === order.id && i.status !== 'CANCELED' && !i.is_paid);
  const itemsCents = valid.reduce((acc, i) => acc + toCents(i.total_item_price), 0);
  const feeCents = order.charge_service_fee ? toCents(computeServiceFee(fromCents(itemsCents), order.service_fee_pct)) : 0;
  const subtotalCents = toCents(order.subtotal_items);
  const discountCents = subtotalCents > 0 ? Math.round((toCents(order.discount_amount) * itemsCents) / subtotalCents) : 0;
  const remainingCents = toCents(order.remaining_balance);
  const unpaid = allItems.filter((i) => i.order_id === order.id && i.status !== 'CANCELED' && !i.is_paid);
  const coversAll = unpaid.length > 0 && unpaid.every((u) => valid.some((v) => v.id === u.id));
  const raw = itemsCents + feeCents - discountCents;
  const shareCents = coversAll ? remainingCents : Math.min(Math.max(raw, 0), remainingCents);
  return {
    items: fromCents(itemsCents),
    fee: fromCents(feeCents),
    discount: fromCents(discountCents),
    share: fromCents(shareCents),
    coversAll,
  };
}

/**
 * Cota da divisão igualitária: saldo restante / pessoas que ainda vão pagar,
 * arredondada PARA CIMA no centavo (o último pagante paga o resto exato).
 */
export function computeEqualShare(remaining: number, peopleLeft: number): number {
  const cents = toCents(remaining);
  const n = Math.max(1, Math.floor(peopleLeft));
  if (n === 1) return fromCents(cents);
  return fromCents(Math.ceil(cents / n));
}

/**
 * Rateio exato de um valor em centavos proporcional a pesos (maiores restos).
 * Garante Σ partes == total, sem perder nenhum centavo.
 */
export function allocateCents(totalCents: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0 || totalCents === 0) return weights.map(() => 0);
  const raw = weights.map((w) => (totalCents * w) / sum);
  const floors = raw.map((r) => Math.floor(r));
  let rest = totalCents - floors.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac);
  for (let k = 0; rest > 0 && k < order.length; k++, rest--) floors[order[k]!.i]! += 1;
  return floors;
}
