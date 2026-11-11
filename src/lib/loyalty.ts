/**
 * CRM de fidelidade e cashback — espelho das funções tchefood_cashback_* de
 * db/schema_expansion.sql.
 *
 * Regras do programa:
 *  - Crédito de 5% sobre o consumo (sem os 10% do garçom, já com desconto),
 *    só de conta encerrada, um crédito por conta.
 *  - Vale a partir do dia seguinte (próxima visita) por 30 dias.
 *  - Resgate só de terça a quinta-feira (horário de Brasília), para encher o
 *    salão nos dias fracos, limitado a 50% da conta. Consome os créditos que
 *    vencem primeiro (FIFO).
 *  - WhatsApp só com opt-in registrado (LGPD / política do WhatsApp Business).
 */
import type { CashbackLedgerEntry, CashbackRedeemSource, LoyaltyCustomer, Order, UUID } from '../types';
import { formatBRL, fromCents, toCents } from './money';

export const CASHBACK_PCT = 5;
export const CASHBACK_VALIDITY_DAYS = 30;
export const CASHBACK_MAX_USAGE_PCT = 50;
/** getDay(): 2 = terça, 3 = quarta, 4 = quinta. */
export const CASHBACK_DAYS = [2, 3, 4] as const;
export const CASHBACK_DAYS_LABEL = 'terça a quinta';

const TZ = 'America/Sao_Paulo';

/** Dia da semana em Brasília (0 = domingo), independente do fuso do aparelho. */
export function weekdayInBrasilia(at: Date): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(at);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(name);
}

export function isCashbackDay(at: Date): boolean {
  return (CASHBACK_DAYS as readonly number[]).includes(weekdayInBrasilia(at));
}

/** 55 + DDD + número (10 ou 11 dígitos), só dígitos; null se inválido. */
export function normalizeWhatsapp(raw: string): string | null {
  let d = raw.replace(/\D/g, '');
  if (d.startsWith('0')) d = d.replace(/^0+/, '');
  if (d.length === 10 || d.length === 11) d = `55${d}`;
  if (!/^55[1-9][0-9][0-9]{8,9}$/.test(d)) return null;
  // Celular tem 9 dígitos começando por 9.
  const local = d.slice(4);
  if (local.length === 9 && !local.startsWith('9')) return null;
  return d;
}

export function formatWhatsapp(phone: string): string {
  const m = phone.match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : phone;
}

/** Base do cashback: consumo sem a taxa de serviço, já com desconto. */
export function cashbackBase(order: Pick<Order, 'total_amount' | 'service_fee_amount'>): number {
  return fromCents(Math.max(toCents(order.total_amount) - toCents(order.service_fee_amount), 0));
}

/** round(base * 5 / 100, 2) — igual ao PostgreSQL. */
export function cashbackEarnAmount(order: Pick<Order, 'total_amount' | 'service_fee_amount'>): number {
  return fromCents(Math.round((toCents(cashbackBase(order)) * CASHBACK_PCT) / 100));
}

/** Brasília é UTC−3 fixo desde 2019 (sem horário de verão). */
const BRASILIA_OFFSET = '-03:00';
const DAY_MS = 86_400_000;

/**
 * Validade: começa à meia-noite (Brasília) do dia seguinte à visita e dura
 * 30 dias. Independe do fuso configurado no aparelho.
 */
export function cashbackValidity(earnedAt: Date): { valid_from: string; expires_at: string } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(earnedAt);
  const midnightToday = new Date(`${parts}T00:00:00${BRASILIA_OFFSET}`);
  const from = new Date(midnightToday.getTime() + DAY_MS);
  const until = new Date(from.getTime() + CASHBACK_VALIDITY_DAYS * DAY_MS);
  return { valid_from: from.toISOString(), expires_at: until.toISOString() };
}

/** Lançamento que é crédito do cliente: o ganho (EARN) e a devolução de um resgate (REFUND). */
export function isCashbackCredit(e: CashbackLedgerEntry): boolean {
  return e.entry_type === 'EARN' || e.entry_type === 'REFUND';
}

/**
 * Parte de um resgate que já saiu da conta: devolvida ao cliente (REFUND) ou retida para
 * conciliação por não ter origem comprovada (HOLD, sem saldo e sem validade).
 */
export function isCashbackRefund(e: CashbackLedgerEntry): boolean {
  return e.entry_type === 'REFUND' || e.entry_type === 'HOLD';
}

/**
 * Quanto do cashback volta quando o desconto da conta cai (P0-02 da rodada 8 do GPT; mesma
 * conta de tchefood_orders_cashback_refund). O desconto é o manual mais o cashback ainda
 * aplicado; o desconto manual fica (até o novo desconto) e o cashback absorve a queda.
 * Bruto 100, manual 10, resgate 45 (desconto 55), cancelamento deixa o bruto em 20:
 * manual 10, cashback 10, volta 35. Tudo em centavos.
 */
export function cashbackRefundCents(appliedCents: number, discountBeforeCents: number, discountAfterCents: number): number {
  const applied = Math.max(appliedCents, 0);
  const manualBefore = Math.max(discountBeforeCents - applied, 0);
  const manualAfter = Math.min(manualBefore, Math.max(discountAfterCents, 0));
  return Math.max(applied - (discountAfterCents - manualAfter), 0);
}

function isUsableEarn(e: CashbackLedgerEntry, customerId: UUID, at: Date): boolean {
  return (
    e.customer_id === customerId &&
    isCashbackCredit(e) &&
    e.remaining_amount > 0 &&
    e.valid_from !== null &&
    e.expires_at !== null &&
    new Date(e.valid_from) <= at &&
    new Date(e.expires_at) > at
  );
}

/** Saldo que pode ser usado agora (já liberado e não vencido). */
export function availableCashback(ledger: readonly CashbackLedgerEntry[], customerId: UUID, at: Date): number {
  return fromCents(ledger.filter((e) => isUsableEarn(e, customerId, at)).reduce((a, e) => a + toCents(e.remaining_amount), 0));
}

/** Saldo total não vencido (inclui crédito que só libera amanhã) = cashback_balance. */
export function balanceCashback(ledger: readonly CashbackLedgerEntry[], customerId: UUID, at: Date): number {
  return fromCents(
    ledger
      .filter((e) => e.customer_id === customerId && isCashbackCredit(e) && e.expires_at !== null && new Date(e.expires_at) > at)
      .reduce((a, e) => a + toCents(e.remaining_amount), 0),
  );
}

/** Quanto do cashback pode abater desta conta. */
export function cashbackUsable(available: number, order: Pick<Order, 'total_amount' | 'remaining_balance'>): number {
  const capCents = Math.round((toCents(order.total_amount) * CASHBACK_MAX_USAGE_PCT) / 100);
  return fromCents(Math.max(Math.min(toCents(available), capCents, toCents(order.remaining_balance)), 0));
}

/**
 * De quais créditos sai um resgate (FIFO: vence antes, sai antes), na ordem da baixa.
 * O resgate guarda essa lista (redeem_sources) para o estorno herdar a validade.
 */
export function cashbackFifoSources(
  ledger: readonly CashbackLedgerEntry[],
  customerId: UUID,
  amount: number,
  at: Date,
): CashbackRedeemSource[] {
  let left = toCents(amount);
  const usable = ledger
    .filter((e) => isUsableEarn(e, customerId, at))
    .sort((a, b) => (a.expires_at! < b.expires_at! ? -1 : a.expires_at! > b.expires_at! ? 1 : a.created_at < b.created_at ? -1 : 1));
  const sources: CashbackRedeemSource[] = [];
  for (const e of usable) {
    if (left <= 0) break;
    const t = Math.min(toCents(e.remaining_amount), left);
    sources.push({ source_id: e.id, amount: fromCents(t) });
    left -= t;
  }
  if (left > 0) throw new Error('Saldo de cashback insuficiente.');
  return sources;
}

/**
 * Uma parte do estorno: valor e a validade do crédito de onde saiu. Parte sem origem
 * comprovada (hold) não tem validade: fica retida para conciliação, fora do saldo.
 */
export type CashbackRefundPart =
  | { refund_of_id: UUID; amount: number; valid_from: string; expires_at: string; hold?: undefined }
  | { refund_of_id: UUID | null; amount: number; valid_from: null; expires_at: null; hold: true };

/**
 * Como o estorno de um resgate volta ao cliente (decisão do Will, 10/11/2026: o cashback
 * vale 30 dias de quando foi gerado, com ou sem cancelamento). Mesma regra de
 * tchefood_orders_cashback_refund (db/schema_cashback_servidor.sql): cada parte volta com
 * a validade do crédito de onde saiu, primeiro o que vence por último; parte de crédito
 * vencido volta vencida. Parte sem origem comprovada (resgate da versão anterior com
 * source_id nulo, ou crédito de origem que não está no extrato) não ganha validade de outro
 * crédito nem prazo novo (P0-03 da rodada 8 do GPT): sai como hold, para conciliação.
 */
export function planCashbackRefund(
  ledger: readonly CashbackLedgerEntry[],
  redeem: CashbackLedgerEntry,
  amount: number,
): CashbackRefundPart[] {
  const byId = new Map(ledger.map((e) => [e.id, e]));
  const sources = (redeem.redeem_sources ?? [{ source_id: null, amount: redeem.amount }])
    .map((src) => ({ src, credit: src.source_id ? byId.get(src.source_id) ?? null : null }))
    .sort((a, b) => {
      const ea = a.credit?.expires_at ?? null;
      const eb = b.credit?.expires_at ?? null;
      if (ea === eb) return (b.credit?.created_at ?? '') < (a.credit?.created_at ?? '') ? -1 : 1;
      if (ea === null) return 1;
      if (eb === null) return -1;
      return ea > eb ? -1 : 1;
    });
  const refunds = ledger.filter((e) => e.order_id === redeem.order_id && isCashbackRefund(e));
  let left = toCents(amount);
  const parts: CashbackRefundPart[] = [];
  for (const { src, credit } of sources) {
    if (left <= 0) break;
    const back = refunds.filter((r) => (r.refund_of_id ?? null) === src.source_id).reduce((sum, r) => sum + toCents(r.amount), 0);
    const take = Math.min(toCents(src.amount) - back, left);
    if (take <= 0) continue;
    if (src.source_id !== null && credit?.valid_from && credit.expires_at) {
      parts.push({ refund_of_id: src.source_id, amount: fromCents(take), valid_from: credit.valid_from, expires_at: credit.expires_at });
    } else {
      parts.push({ refund_of_id: src.source_id, amount: fromCents(take), valid_from: null, expires_at: null, hold: true });
    }
    left -= take;
  }
  return parts;
}

/** Consome créditos FIFO (vence antes, sai antes). Devolve o extrato atualizado. */
export function consumeCashbackFifo(
  ledger: readonly CashbackLedgerEntry[],
  customerId: UUID,
  amount: number,
  at: Date,
): CashbackLedgerEntry[] {
  let left = toCents(amount);
  const usable = ledger
    .filter((e) => isUsableEarn(e, customerId, at))
    .sort((a, b) => (a.expires_at! < b.expires_at! ? -1 : a.expires_at! > b.expires_at! ? 1 : a.created_at < b.created_at ? -1 : 1));
  const take = new Map<UUID, number>();
  for (const e of usable) {
    if (left <= 0) break;
    const t = Math.min(toCents(e.remaining_amount), left);
    take.set(e.id, t);
    left -= t;
  }
  if (left > 0) throw new Error('Saldo de cashback insuficiente.');
  return ledger.map((e) => (take.has(e.id) ? { ...e, remaining_amount: fromCents(toCents(e.remaining_amount) - take.get(e.id)!) } : e));
}

/** Próxima data (a partir de amanhã) em que o cashback pode ser usado. */
export function nextCashbackDate(from: Date): Date {
  const d = new Date(from);
  d.setHours(12, 0, 0, 0);
  for (let i = 1; i <= 7; i++) {
    d.setDate(d.getDate() + 1);
    if (isCashbackDay(d)) return d;
  }
  return d;
}

export function buildCashbackMessage(params: {
  tenantName: string;
  customer: Pick<LoyaltyCustomer, 'name'>;
  earned: number;
  balance: number;
  expiresAt: string;
  nfceUrl: string | null;
  now: Date;
}): string {
  const first = params.customer.name?.trim().split(/\s+/)[0];
  const next = nextCashbackDate(params.now).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit' });
  const until = new Date(params.expiresAt).toLocaleDateString('pt-BR');
  return [
    `Bah${first ? `, ${first}` : ''}! Obrigado pela visita no ${params.tenantName} 🔥`,
    ``,
    `Você ganhou *${formatBRL(params.earned)} de cashback* (${CASHBACK_PCT}% da sua conta).`,
    `Saldo para a próxima visita: *${formatBRL(params.balance)}*.`,
    `Use de ${CASHBACK_DAYS_LABEL} (a partir de ${next}), até ${until}, em até ${CASHBACK_MAX_USAGE_PCT}% da conta. É só informar este WhatsApp no caixa.`,
    ...(params.nfceUrl ? [``, `Seu cupom fiscal (NFC-e): ${params.nfceUrl}`] : []),
    ``,
    `Para não receber mais mensagens, responda SAIR.`,
  ].join('\n');
}

/** Link click-to-chat oficial do WhatsApp (funciona sem API, abre a conversa pronta). */
export function whatsappLink(phone: string, text: string): string {
  return `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
}
