/**
 * Faixa de avisos do Painel do dono: o que precisa de alguém agora, com o atalho
 * para resolver. Função pura: a tela junta o estado e chama ownerAlerts().
 */
import { formatBRL } from './money';
import type { DiningTable, KegTap, Order, Product } from '../types';
import { kegStatus } from './kegs';
import type { ChannelRow, MarketplaceSale } from './ownerDashboard';
import { CHANNEL_DEPENDENCE_PCT } from './ownerDashboard';

export type AlertTone = 'critical' | 'warning' | 'info';

/** Para onde o botão do aviso leva (aba da Retaguarda ou tela do menu). */
export type AlertTarget = 'delivery' | 'pickup' | 'map' | 'caixa' | 'chopp' | 'cloud' | 'menu' | 'audit' | 'fees';

export interface OwnerAlert {
  id: string;
  tone: AlertTone;
  title: string;
  detail: string;
  action?: { label: string; target: AlertTarget };
}

/** Conta de mesa aberta há mais que isso vira aviso (esquecida aberta ou cliente que saiu sem pagar). */
export const OPEN_ORDER_ALERT_MIN = 180;
/** Pedido de app sem aceite há mais que isso: o app pode cancelar sozinho. */
export const MARKETPLACE_ACCEPT_ALERT_MIN = 5;
/** Senha do totem esperando pagamento no caixa há mais que isso. */
export const PICKUP_UNPAID_ALERT_MIN = 10;

export interface AlertInput {
  now: Date;
  orders: readonly Order[];
  tables: readonly DiningTable[];
  products: readonly Product[];
  kegTaps: readonly KegTap[];
  /** Comandas com cobrança incerta na maquininha esperando conferência. */
  reviewHoldOrderIds: readonly string[];
  /** Último erro do ciclo dos apps de delivery, por app (null = funcionando). */
  marketplaceErrors: ReadonlyArray<{ label: string; error: string }>;
  marketplace: readonly MarketplaceSale[];
  /** Fila da nuvem: conectado, eventos recusados e há quanto tempo não sobe nada. */
  cloud: { connected: boolean; rejected: number; pending: number; lastSuccessAt: string | null; lastError: string | null };
  channels: readonly ChannelRow[];
  /** Dinheiro recebido hoje sem caixa aberto (não entra em nenhum fechamento). */
  cashOutside?: { amount: number; count: number };
}

const minutesSince = (iso: string, now: Date) => (now.getTime() - new Date(iso).getTime()) / 60_000;

export function ownerAlerts(a: AlertInput): OwnerAlert[] {
  const out: OwnerAlert[] = [];

  for (const m of a.marketplaceErrors) {
    out.push({
      id: `app-error-${m.label}`,
      tone: 'critical',
      title: `${m.label} desconectado`,
      detail: `A integração está fora do ar e pedidos novos não chegam ao Tchê Food. Último erro: ${m.error}`,
      action: { label: `Abrir Delivery`, target: 'delivery' },
    });
  }

  const waitingAccept = a.marketplace.filter((m) => !m.canceled && m.status === 'placed' && minutesSince(m.created_at, a.now) >= MARKETPLACE_ACCEPT_ALERT_MIN);
  if (waitingAccept.length) {
    out.push({
      id: 'app-accept',
      tone: 'critical',
      title: `${waitingAccept.length} pedido(s) de app sem aceite`,
      detail: `Esperando há mais de ${MARKETPLACE_ACCEPT_ALERT_MIN} min. O app pode cancelar sozinho.`,
      action: { label: 'Aceitar pedidos', target: 'delivery' },
    });
  }

  if (a.reviewHoldOrderIds.length) {
    out.push({
      id: 'review-holds',
      tone: 'critical',
      title: `${a.reviewHoldOrderIds.length} cobrança(s) da maquininha para conferir`,
      detail: 'A maquininha não confirmou o resultado. A conta fica travada até alguém conferir o comprovante.',
      action: { label: 'Ver mesas', target: 'map' },
    });
  }

  for (const t of a.kegTaps) {
    if (!t.active) continue;
    const s = kegStatus(t);
    if (s.alert === 'CRITICAL') {
      out.push({ id: `keg-${t.id}`, tone: 'critical', title: `Chopp torneira ${t.tap_number}: ${t.beer_name}`, detail: s.message, action: { label: 'Ver barris', target: 'chopp' } });
    } else if (s.low) {
      out.push({ id: `keg-low-${t.id}`, tone: 'warning', title: `Barril acabando na torneira ${t.tap_number}`, detail: s.message, action: { label: 'Ver barris', target: 'chopp' } });
    }
  }

  if (a.cloud.connected && a.cloud.rejected > 0) {
    out.push({
      id: 'cloud-rejected',
      tone: 'critical',
      title: `${a.cloud.rejected} registro(s) recusado(s) pela nuvem`,
      detail: 'Ficaram só neste aparelho até alguém revisar na aba Nuvem.',
      action: { label: 'Abrir Nuvem', target: 'cloud' },
    });
  } else if (a.cloud.connected && a.cloud.pending > 0 && a.cloud.lastError) {
    const since = a.cloud.lastSuccessAt ? Math.floor(minutesSince(a.cloud.lastSuccessAt, a.now)) : null;
    if (since === null || since >= 15) {
      out.push({
        id: 'cloud-stuck',
        tone: 'warning',
        title: `Nuvem sem sincronizar${since === null ? '' : ` há ${since} min`}`,
        detail: `${a.cloud.pending} registro(s) esperando na fila. Último erro: ${a.cloud.lastError}`,
        action: { label: 'Abrir Nuvem', target: 'cloud' },
      });
    }
  }

  const tableKind = new Map(a.tables.map((t) => [t.id, t.kind]));
  const longOpen = a.orders.filter(
    (o) => (o.status === 'OPEN' || o.status === 'PAYING') && (tableKind.get(o.table_id) ?? 'TABLE') === 'TABLE' && minutesSince(o.opened_at, a.now) >= OPEN_ORDER_ALERT_MIN,
  );
  if (longOpen.length) {
    out.push({
      id: 'long-open',
      tone: 'warning',
      title: `${longOpen.length} conta(s) aberta(s) há mais de ${OPEN_ORDER_ALERT_MIN / 60} h`,
      detail: 'Confira se o cliente ainda está na mesa ou se a conta ficou esquecida.',
      action: { label: 'Ver mesas', target: 'map' },
    });
  }

  const unpaidPickup = a.orders.filter(
    (o) => o.pickup_number !== null && o.status === 'PAYING' && o.paid_amount === 0 && minutesSince(o.opened_at, a.now) >= PICKUP_UNPAID_ALERT_MIN,
  );
  if (unpaidPickup.length) {
    out.push({
      id: 'pickup-unpaid',
      tone: 'warning',
      title: `${unpaidPickup.length} senha(s) esperando pagamento no caixa`,
      detail: `Há mais de ${PICKUP_UNPAID_ALERT_MIN} min. O pedido só vai para a cozinha depois de pago.`,
      action: { label: 'Abrir PDV / Caixa', target: 'pickup' },
    });
  }

  if (a.cashOutside && a.cashOutside.count > 0) {
    out.push({
      id: 'cash-outside',
      tone: 'warning',
      title: `${formatBRL(a.cashOutside.amount)} em dinheiro recebido com o caixa fechado`,
      detail: `${a.cashOutside.count} pagamento(s) em dinheiro hoje fora de um caixa aberto: não entram em nenhum fechamento.`,
      action: { label: 'Abrir o Caixa', target: 'caixa' },
    });
  }

  const dependent = a.channels.find((c) => c.marketplace && c.pct >= CHANNEL_DEPENDENCE_PCT);
  if (dependent) {
    out.push({
      id: 'channel-dependence',
      tone: 'warning',
      title: `${dependent.pct.toLocaleString('pt-BR')}% das vendas vieram do ${dependent.label}`,
      detail: 'Cada venda no app paga comissão. Vale levar o cliente para o cardápio próprio.',
    });
  }

  const soldOut = a.products.filter((p) => p.active && !p.available);
  if (soldOut.length) {
    out.push({
      id: 'sold-out',
      tone: 'info',
      title: `${soldOut.length} produto(s) marcado(s) como esgotado`,
      detail: soldOut.slice(0, 4).map((p) => p.name).join(', ') + (soldOut.length > 4 ? '…' : ''),
      action: { label: 'Abrir Cardápio', target: 'menu' },
    });
  }

  const order: Record<AlertTone, number> = { critical: 0, warning: 1, info: 2 };
  return out.sort((x, y) => order[x.tone] - order[y.tone]);
}
