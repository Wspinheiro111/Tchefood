/**
 * Cobrança da Point Smart em andamento numa conta reserva o valor dela para qualquer
 * forma de pagamento (decisão do Will, 12/11/2026). Quem decide é o banco
 * (db/schema_point_reserva.sql, gatilho em payments); aqui o caixa mostra o aviso e não
 * aceita o valor reservado antes de mandar para o servidor.
 */
import { formatBRL, toCents } from '../money';
import type { ReviewHold } from './reviewHolds';

export interface PointReservation {
  /** Centavos reservados por cobranças da Point ainda não encerradas nesta conta. */
  reservedCents: number;
  openCharges: number;
  manualReview: boolean;
  /** 'cloud' = lido agora do servidor; 'device' = só a cobrança incerta deste aparelho (sem nuvem). */
  source: 'cloud' | 'device';
}

export const POINT_RESERVATION_NOTICE = 'Há uma cobrança na Point em andamento nesta conta';

/**
 * Reserva que vale na tela: a do servidor quando foi lida; sem ela, a cobrança incerta da
 * Point gravada neste aparelho (o servidor também a conta, em revisão manual).
 */
export function effectiveReservation(cloud: Omit<PointReservation, 'source'> | null, hold: ReviewHold | null): PointReservation | null {
  if (cloud) return cloud.reservedCents > 0 ? { ...cloud, source: 'cloud' } : null;
  if (hold && hold.acquirer === 'MERCADO_PAGO' && toCents(hold.amount) > 0) {
    return { reservedCents: toCents(hold.amount), openCharges: 1, manualReview: true, source: 'device' };
  }
  return null;
}

/** Saldo livre para outro pagamento, em centavos (nunca negativo). */
export function freeCents(remaining: number, reservation: PointReservation | null): number {
  return Math.max(toCents(remaining) - (reservation?.reservedCents ?? 0), 0);
}

/** Só reservas de pagamento (dinheiro, Stone, PagBank aguardando o servidor), nenhuma cobrança da Point. */
export const CLAIM_RESERVATION_NOTICE = 'Há um pagamento reservado aguardando envio ao servidor';

/** Partes da reserva lida do servidor (tchefood_point_reservation). */
export interface ReservationParts {
  claimsCents?: number;
  pointCents?: number;
  openCharges?: number;
}

/** A reserva é só de pagamentos reservados (nenhuma cobrança da Point aberta). */
export function onlyClaims(parts: ReservationParts | null | undefined): boolean {
  if (!parts || !(Number(parts.claimsCents) > 0)) return false;
  const point = typeof parts.pointCents === 'number' ? parts.pointCents : 0;
  return point <= 0 && !(Number(parts.openCharges) > 0);
}

/** Título do aviso: cobrança da Point, ou só pagamento reservado aguardando o servidor. */
export function reservationNotice(parts: ReservationParts | null | undefined): string {
  return onlyClaims(parts) ? CLAIM_RESERVATION_NOTICE : POINT_RESERVATION_NOTICE;
}

/** Mensagem de recusa quando o valor passa do saldo livre; null quando cabe. */
export function pointReservationBlock(amount: number, remaining: number, reservation: PointReservation | null, parts?: ReservationParts | null): string | null {
  if (!reservation || reservation.reservedCents <= 0) return null;
  const free = freeCents(remaining, reservation);
  if (toCents(amount) <= free) return null;
  return `${reservationNotice(parts)} (${formatBRL(reservation.reservedCents / 100)} reservado). Livre para este pagamento: ${formatBRL(free / 100)}.`;
}

/** TF012 reserved_exceeds_balance: o servidor não reduz o total abaixo do que está reservado. */
export const RESERVED_EXCEEDS_BALANCE = 'Há cobrança reservada nesta comanda: conclua ou libere antes de reduzir o total.';

/** Última leitura da reserva no servidor por comanda (para conferir antes de reduzir o total aqui). */
const lastRead = new Map<string, { reservedCents: number; claims: Array<{ key: string; cents: number }>; at: number }>();
export const RESERVATION_READ_MAX_AGE_MS = 60_000;

export function rememberServerReservation(orderId: string, reservedCents: number, claims: ReadonlyArray<{ idempotencyKey: string; amountCents: number }> = [], nowMs = Date.now()): void {
  lastRead.set(orderId, { reservedCents, claims: claims.map((c) => ({ key: c.idempotencyKey, cents: c.amountCents })), at: nowMs });
}

/**
 * Reduzir o total para `newRemaining` passaria do que está reservado no servidor? Usa a última leitura (até
 * 60 s); reservas cujo pagamento já está aprovado aqui não contam (o saldo daqui já as descontou).
 * Sem leitura recente: null (o servidor ainda confere, com TF012).
 */
export function reservationExceeds(orderId: string, newRemaining: number, paidKeys: ReadonlySet<string>, nowMs = Date.now()): string | null {
  const r = lastRead.get(orderId);
  if (!r || nowMs - r.at > RESERVATION_READ_MAX_AGE_MS) return null;
  const counted = r.reservedCents - r.claims.filter((c) => paidKeys.has(c.key)).reduce((a, c) => a + c.cents, 0);
  return counted > toCents(newRemaining) ? RESERVED_EXCEEDS_BALANCE : null;
}

/** Só para testes. */
export function resetServerReservations(): void {
  lastRead.clear();
}
