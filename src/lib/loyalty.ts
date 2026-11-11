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

/** Uma parte do estorno: valor e a validade do crédito de onde saiu. */
export interface CashbackRefundPart {
  refund_of_id: UUID | null;
  amount: number;
  valid_from: string;
  expires_at: string;
}

/**
 * Como o estorno de um resgate volta ao cliente (decisão do Will, 10/11/2026: o cashback
 * vale 30 dias de quando foi gerado, com ou sem cancelamento). Mesma regra de
 * tchefood_orders_cashback_refund (db/schema_cashback_servidor.sql): cada parte volta com
 * a validade do crédito de onde saiu, primeiro o que vence por último; parte de crédito
 * vencido volta vencida. Resgate sem origem registrada vence com o crédito consumido do
 * cliente que vence por último (sem nenhum, conta do resgate).
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
  const refunds = ledger.filter((e) => e.order_id === redeem.order_id && e.entry_type === 'REFUND');
  let left = toCents(amount);
  const parts: CashbackRefundPart[] = [];
  for (const { src, credit } of sources) {
    if (left <= 0) break;
    const back = refunds.filter((r) => (r.refund_of_id ?? null) === src.source_id).reduce((sum, r) => sum + toCents(r.amount), 0);
    const take = Math.min(toCents(src.amount) - back, left);
    if (take <= 0) continue;
    let validity: { valid_from: string; expires_at: string } | null =
      credit?.valid_from && credit.expires_at ? { valid_from: credit.valid_from, expires_at: credit.expires_at } : null;
    if (!validity && src.source_id === null) {
      const consumed = ledger
        .filter((e) => e.customer_id === redeem.customer_id && isCashbackCredit(e) && e.amount > e.remaining_amount
          && e.created_at <= redeem.created_at && e.valid_from && e.expires_at)
        .sort((a, b) => (a.expires_at! > b.expires_at! ? -1 : 1))[0];
      validity = consumed ? { valid_from: consumed.valid_from!, expires_at: consumed.expires_at! } : null;
    }
    validity ??= {
      valid_from: redeem.created_at,
      expires_at: new Date(new Date(redeem.created_at).getTime() + CASHBACK_VALIDITY_DAYS * DAY_MS).toISOString(),
    };
    parts.push({ refund_of_id: src.source_id, amount: fromCents(take), ...validity });
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
