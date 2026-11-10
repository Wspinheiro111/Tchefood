/**
 * Entrega própria (motoboy da casa): validação do endereço, rota no mapa e acerto
 * com o entregador. Funções puras, em centavos.
 */
import type { Courier, DeliveryZone, Order, OwnDelivery, Tenant } from '../types';
import { fromCents, toCents } from './money';

export const MAX_DELIVERY_FEE = 200;
export const MAX_COURIER_FEE = 200;
/** Paradas por rota no link do Google Maps (o app aceita até 9 paradas intermediárias). */
export const MAX_ROUTE_STOPS = 10;

export const OWN_DELIVERY_STATUS_LABEL: Record<OwnDelivery['status'], string> = {
  PREPARING: 'Em preparo',
  READY: 'Pronto para sair',
  OUT: 'Saiu para entrega',
  DELIVERED: 'Entregue',
  CANCELED: 'Cancelado',
};

/** Telefone só com dígitos (DDD + número, 10 ou 11 dígitos); null se inválido. */
export function normalizePhone(raw: string): string | null {
  let d = raw.replace(/\D/g, '');
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) d = d.slice(2);
  return d.length === 10 || d.length === 11 ? d : null;
}

export interface DeliveryAddressInput {
  customerName: string;
  phone: string;
  address: string;
  reference: string;
  zoneId: string;
  payOnDelivery: boolean;
  /** Troco para (só dinheiro na entrega); vazio = sem troco. */
  changeFor: number | null;
}

/** Erro do endereço da entrega, ou null. `total` é o total do pedido já com a taxa. */
export function validateDeliveryInput(d: DeliveryAddressInput, zones: readonly DeliveryZone[], total: number): string | null {
  if (d.customerName.trim().length < 2) return 'Informe o nome do cliente.';
  if (!normalizePhone(d.phone)) return 'Informe o telefone com DDD.';
  if (d.address.trim().length < 5) return 'Informe o endereço (rua e número).';
  const zone = zones.find((z) => z.id === d.zoneId);
  if (!zone || !zone.active) return 'Escolha o bairro da entrega.';
  if (d.changeFor !== null) {
    if (!d.payOnDelivery) return 'Troco só no pagamento em dinheiro na entrega.';
    if (!Number.isFinite(d.changeFor) || toCents(d.changeFor) < toCents(total)) return 'O troco precisa ser para um valor maior que o total.';
  }
  return null;
}

/** Link do Google Maps com a loja de saída e as paradas na ordem escolhida. */
export function routeUrl(tenant: Pick<Tenant, 'city' | 'state'>, deliveries: ReadonlyArray<Pick<OwnDelivery, 'address' | 'zone_name'>>): string | null {
  const stops = deliveries.slice(0, MAX_ROUTE_STOPS).map((d) => `${d.address}, ${d.zone_name}, ${tenant.city} - ${tenant.state}`);
  if (stops.length === 0) return null;
  const params = new URLSearchParams({ api: '1', travelmode: 'driving', destination: stops[stops.length - 1]! });
  if (stops.length > 1) params.set('waypoints', stops.slice(0, -1).join('|'));
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

/** Link do WhatsApp para avisar o cliente que o pedido saiu. */
export function outForDeliveryMessageUrl(d: Pick<OwnDelivery, 'customer_phone' | 'customer_name'>, storeName: string, pickupLabel: string): string {
  const text = `Olá, ${d.customer_name.split(' ')[0]}! Seu pedido ${pickupLabel} do ${storeName} saiu para entrega.`;
  return `https://wa.me/55${d.customer_phone}?text=${encodeURIComponent(text)}`;
}

export interface SettlementPreview {
  deliveries: OwnDelivery[];
  /** Dinheiro que o entregador recebeu dos clientes (contas ainda abertas, pagas na entrega). */
  cashToCollect: number;
  cashOrders: number;
  /** O que o entregador ganhou nessas entregas. */
  courierFees: number;
  /** Dinheiro que o entregador entrega no caixa se receber dele mesmo (dinheiro − ganho). */
  netFromCourier: number;
}

/** Entregas concluídas e ainda não acertadas do entregador. */
export function settlementPreview(courierId: string, deliveries: readonly OwnDelivery[], orders: readonly Order[]): SettlementPreview {
  const own = deliveries.filter((d) => d.courier_id === courierId && d.status === 'DELIVERED' && d.settlement_id === null);
  let cash = 0;
  let cashOrders = 0;
  let fees = 0;
  for (const d of own) {
    fees += toCents(d.courier_fee ?? 0);
    if (!d.pay_on_delivery) continue;
    const o = orders.find((x) => x.id === d.order_id);
    if (o && o.status === 'PAYING' && o.remaining_balance > 0) {
      cash += toCents(o.remaining_balance);
      cashOrders += 1;
    }
  }
  return { deliveries: own, cashToCollect: fromCents(cash), cashOrders, courierFees: fromCents(fees), netFromCourier: fromCents(cash - fees) };
}

export function validateZone(z: Pick<DeliveryZone, 'name' | 'fee' | 'eta_minutes'>): string | null {
  if (z.name.trim().length < 2) return 'Informe o nome do bairro.';
  if (!Number.isFinite(z.fee) || z.fee < 0 || z.fee > MAX_DELIVERY_FEE) return `Taxa entre R$ 0,00 e R$ ${MAX_DELIVERY_FEE},00.`;
  if (!Number.isInteger(z.eta_minutes) || z.eta_minutes < 5 || z.eta_minutes > 240) return 'Tempo de entrega entre 5 e 240 minutos.';
  return null;
}

export function validateCourier(c: Pick<Courier, 'name' | 'phone' | 'fee_per_delivery'>): string | null {
  if (c.name.trim().length < 2) return 'Informe o nome do entregador.';
  if (c.phone !== null && c.phone !== '' && !normalizePhone(c.phone)) return 'Telefone com DDD (ou deixe em branco).';
  if (!Number.isFinite(c.fee_per_delivery) || c.fee_per_delivery < 0 || c.fee_per_delivery > MAX_COURIER_FEE) return `Valor por entrega entre R$ 0,00 e R$ ${MAX_COURIER_FEE},00.`;
  return null;
}
