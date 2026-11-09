import type { DeliveryOrderRecord } from '../../server/delivery/deliveryInbox';
import { DELIVERY_CHANNEL_CATALOG } from '../../server/delivery/marketplace';
import type { DiningTable, OrderItem } from '../types';

// Regras do painel de senhas (TV estilo fast-food). Só número e primeiro nome: nada de telefone, endereço ou valor.

export type BoardStage = 'preparing' | 'ready';

export type BoardEntry = {
  key: string;
  stage: BoardStage;
  // O que aparece grande na TV: número do pedido do app ou a mesa do pedido pelo QR.
  number: string;
  subtitle: string;
  // Pronto para o entregador do app (não para o cliente).
  courierLabel: string | null;
  // Quando entrou no estágio atual, para ordenar (mais antigo primeiro em "Preparando").
  since: string;
};

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? '';
}

export function deliveryBoardEntries(records: readonly DeliveryOrderRecord[]): BoardEntry[] {
  const entries: BoardEntry[] = [];
  for (const record of records) {
    const { order } = record;
    // Pedido com cancelamento pendente não é chamado no painel.
    if (record.cancellationPending) continue;
    const stage: BoardStage | null =
      order.status === 'confirmed' || order.status === 'preparing' ? 'preparing' : order.status === 'ready_for_pickup' ? 'ready' : null;
    if (!stage) continue;
    const label = DELIVERY_CHANNEL_CATALOG[order.channel].label;
    entries.push({
      key: `delivery:${order.channel}:${order.externalId}`,
      stage,
      number: order.displayId,
      subtitle: firstName(order.customer.name) || label,
      courierLabel: order.fulfillment === 'delivery' ? `Entregador ${label}` : null,
      since: record.lastEventAt,
    });
  }
  return entries;
}

// Pedidos feitos pelo cliente no QR da mesa: "Preparando" enquanto algum item ainda está na cozinha,
// "Pronto" quando todos os itens pendentes ficaram prontos e ainda não foram levados à mesa.
export function qrBoardEntries(items: readonly OrderItem[], tables: readonly DiningTable[]): BoardEntry[] {
  const byOrder = new Map<string, OrderItem[]>();
  for (const item of items) {
    if (item.origin !== 'QRCODE_TABLE' || item.status === 'CANCELED' || item.status === 'DELIVERED' || item.sector === 'NONE') continue;
    const list = byOrder.get(item.order_id) ?? [];
    list.push(item);
    byOrder.set(item.order_id, list);
  }
  const entries: BoardEntry[] = [];
  for (const [orderId, list] of byOrder) {
    const table = tables.find((candidate) => candidate.current_order_id === orderId);
    const allReady = list.every((item) => item.status === 'READY');
    const since = allReady
      ? list.reduce((latest, item) => ((item.prepared_at ?? '') > latest ? item.prepared_at ?? '' : latest), '')
      : list.reduce((oldest, item) => (item.created_at < oldest ? item.created_at : oldest), list[0]?.created_at ?? '');
    entries.push({
      key: `qr:${orderId}`,
      stage: allReady ? 'ready' : 'preparing',
      number: table ? `Mesa ${table.number}` : 'Mesa',
      subtitle: 'Pedido pelo QR',
      courierLabel: null,
      since,
    });
  }
  return entries;
}

export function buildBoard(entries: readonly BoardEntry[]): { preparing: BoardEntry[]; ready: BoardEntry[] } {
  const preparing = entries.filter((entry) => entry.stage === 'preparing').sort((a, b) => a.since.localeCompare(b.since));
  const ready = entries.filter((entry) => entry.stage === 'ready').sort((a, b) => b.since.localeCompare(a.since));
  return { preparing, ready };
}
