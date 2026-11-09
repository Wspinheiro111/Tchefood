import type { DiningTable, FulfillmentType, Order, OrderItem, Tenant } from '../types';
import { formatBRL } from './money';

// Regras puras do pedido com senha (totem de autoatendimento e pedido no caixa).

export const PICKUP_NUMBER_MAX = 999;

export const FULFILLMENT_LABEL: Record<FulfillmentType, string> = {
  DINE_IN: 'Comer aqui',
  TAKEOUT: 'Para levar',
};

/** Data civil em Brasília (a senha reinicia à meia-noite da loja, não do UTC). */
export function brasiliaDate(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export function kioskTableIds(tables: readonly DiningTable[]): Set<string> {
  return new Set(tables.filter((t) => t.kind === 'KIOSK').map((t) => t.id));
}

/** Próxima senha do dia: 1, 2, 3… até 999 e volta para 1. */
export function nextPickupNumber(orders: readonly Order[], now: Date = new Date()): number {
  const today = brasiliaDate(now);
  let last = 0;
  let lastAt = '';
  for (const o of orders) {
    if (o.pickup_number === null || brasiliaDate(o.opened_at) !== today) continue;
    // A mais recente manda (depois do 999 a contagem recomeça em 1).
    if (o.opened_at > lastAt || (o.opened_at === lastAt && o.pickup_number > last)) {
      last = o.pickup_number;
      lastAt = o.opened_at;
    }
  }
  return last >= PICKUP_NUMBER_MAX ? 1 : last + 1;
}

export function formatPickupNumber(n: number | null): string {
  return n === null ? '---' : n.toString().padStart(3, '0');
}

/** Só letras, espaço, hífen e apóstrofo; até 20 caracteres. Vazio vira null. */
export function sanitizePickupName(raw: string | null | undefined): string | null {
  const clean = (raw ?? '')
    .normalize('NFC')
    .replace(/[^\p{L}\s'-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20)
    .trim();
  return clean.length ? clean : null;
}

/** Itens que passam pela produção (bebida de geladeira / setor NONE é entregue no balcão). */
export function producedItems(items: readonly OrderItem[], orderId: string): OrderItem[] {
  return items.filter((i) => i.order_id === orderId && i.status !== 'CANCELED' && i.sector !== 'NONE');
}

/**
 * Situação do pedido com senha para o cliente e para o painel:
 *  - AWAITING_PAYMENT: criado, ainda não pago (não vai para a cozinha)
 *  - PREPARING: pago e com algum item ainda na produção
 *  - READY: tudo pronto, aguardando retirada
 *  - DELIVERED: entregue (sai do painel)
 *  - CANCELED
 */
export type KioskStage = 'AWAITING_PAYMENT' | 'PREPARING' | 'READY' | 'DELIVERED' | 'CANCELED';

export function kioskStage(order: Order, items: readonly OrderItem[]): KioskStage {
  if (order.status === 'CANCELED') return 'CANCELED';
  if (order.status !== 'CLOSED') return 'AWAITING_PAYMENT';
  const produced = producedItems(items, order.id);
  if (produced.length === 0) return 'READY';
  if (produced.every((i) => i.status === 'DELIVERED')) return 'DELIVERED';
  if (produced.every((i) => i.status === 'READY' || i.status === 'DELIVERED')) return 'READY';
  return 'PREPARING';
}

/** Linhas do comprovante do cliente com a senha (vai para a bobina). */
export function pickupReceipt(params: {
  tenant: Tenant;
  order: Order;
  items: readonly OrderItem[];
  productName: (productId: string) => string;
}): { headline: string; lines: string[]; footer: string[] } {
  const { tenant, order } = params;
  const paid = order.status === 'CLOSED';
  const lines: string[] = [
    tenant.name,
    paid ? 'SUA SENHA' : 'PAGUE NO CAIXA · SENHA',
    order.fulfillment_type ? FULFILLMENT_LABEL[order.fulfillment_type].toUpperCase() : '',
    order.pickup_name ? `Nome: ${order.pickup_name}` : '',
    new Date(order.opened_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
    '--------------------------------',
  ].filter(Boolean);
  for (const i of params.items.filter((x) => x.order_id === order.id && x.status !== 'CANCELED')) {
    lines.push(`${i.quantity}x ${params.productName(i.product_id)}`.slice(0, 32));
    if (i.meat_doneness) lines.push(`   ${i.meat_doneness}`);
    if (i.notes) for (const n of i.notes.split(' · ')) if (n !== i.meat_doneness) lines.push(`   ${n}`.slice(0, 32));
    lines.push(`   ${formatBRL(i.total_item_price)}`);
  }
  lines.push('--------------------------------');
  lines.push(`TOTAL ${formatBRL(order.total_amount)}`);
  lines.push(paid ? 'PAGO' : 'Leve esta senha ao caixa para pagar.');
  return {
    headline: formatPickupNumber(order.pickup_number),
    lines,
    footer: paid ? ['Acompanhe sua senha no painel.', 'Obrigado, tchê!'] : ['O pedido só vai para a cozinha', 'depois do pagamento.'],
  };
}
