/**
 * Cliente sumido e campanha de volta pelo WhatsApp (wa.me, sem API paga):
 * quem tem cadastro no cashback e não compra há 30+ dias, a mensagem com o cupom e
 * quantos voltaram depois de receber. Funções puras.
 */
import type { CashbackLedgerEntry, LoyaltyCustomer } from '../types';
import { fromCents, toCents } from './money';

export const LAPSED_DAYS_DEFAULT = 30;
const DAY_MS = 86_400_000;

export interface LapsedCustomer {
  customer: LoyaltyCustomer;
  /** Última compra identificada (crédito de cashback ou last_visit_at). */
  lastVisit: string;
  daysAway: number;
  visits: number;
  spent: number;
}

/** Último registro de compra: a maior data entre last_visit_at e os créditos do cashback. */
function lastVisitOf(c: LoyaltyCustomer, earns: ReadonlyMap<string, string>): string | null {
  const e = earns.get(c.id) ?? null;
  if (!c.last_visit_at) return e;
  if (!e) return c.last_visit_at;
  return e > c.last_visit_at ? e : c.last_visit_at;
}

/** Clientes que não compram há `days` dias ou mais, do sumido há mais tempo para o mais recente entre os de maior gasto. */
export function lapsedCustomers(customers: readonly LoyaltyCustomer[], ledger: readonly CashbackLedgerEntry[], now: Date, days = LAPSED_DAYS_DEFAULT): LapsedCustomer[] {
  const lastEarn = new Map<string, string>();
  const visits = new Map<string, number>();
  const spent = new Map<string, number>();
  for (const e of ledger) {
    if (e.entry_type !== 'EARN') continue;
    const prev = lastEarn.get(e.customer_id);
    if (!prev || e.created_at > prev) lastEarn.set(e.customer_id, e.created_at);
    visits.set(e.customer_id, (visits.get(e.customer_id) ?? 0) + 1);
    spent.set(e.customer_id, (spent.get(e.customer_id) ?? 0) + toCents(e.base_amount ?? 0));
  }
  const cutoff = now.getTime() - days * DAY_MS;
  const out: LapsedCustomer[] = [];
  for (const c of customers) {
    const last = lastVisitOf(c, lastEarn);
    if (!last || new Date(last).getTime() > cutoff) continue;
    out.push({
      customer: c,
      lastVisit: last,
      daysAway: Math.floor((now.getTime() - new Date(last).getTime()) / DAY_MS),
      visits: Math.max(c.visits_count ?? 0, visits.get(c.id) ?? 0),
      spent: Math.max(c.total_spent ?? 0, fromCents(spent.get(c.id) ?? 0)),
    });
  }
  // Quem gastou mais primeiro: é o cliente que mais vale trazer de volta.
  return out.sort((a, b) => b.spent - a.spent || a.daysAway - b.daysAway);
}

export const DEFAULT_WINBACK_TEMPLATE =
  'Oi, {nome}! Sentimos sua falta no {loja}. Volte esta semana e ganhe {oferta} com o cupom {cupom}. Te esperamos!';

/** Código do cupom: letras e números, 3 a 15 caracteres. */
export function normalizeCouponCode(raw: string): string | null {
  const c = raw.trim().toUpperCase().replace(/\s+/g, '');
  return /^[A-Z0-9]{3,15}$/.test(c) ? c : null;
}

export interface WinbackCampaign {
  template: string;
  offer: string;
  coupon: string;
}

export function validateCampaign(c: WinbackCampaign): string | null {
  if (!normalizeCouponCode(c.coupon)) return 'Cupom com 3 a 15 letras ou números, sem espaço.';
  if (c.offer.trim().length < 3) return 'Descreva a oferta (ex.: 10% de desconto).';
  if (!c.template.includes('{cupom}')) return 'A mensagem precisa ter {cupom}.';
  if (c.template.length > 500) return 'Mensagem com até 500 caracteres.';
  return null;
}

/** Texto da mensagem para um cliente. */
export function winbackMessage(c: WinbackCampaign, customerName: string | null, storeName: string): string {
  const first = (customerName ?? '').trim().split(/\s+/)[0] || 'tudo bem';
  return c.template
    .split('{nome}').join(first)
    .split('{loja}').join(storeName)
    .split('{oferta}').join(c.offer.trim())
    .split('{cupom}').join(normalizeCouponCode(c.coupon) ?? c.coupon.trim());
}

/** Link do WhatsApp com a mensagem pronta (o número do cadastro já tem o 55). */
export function winbackUrl(phoneWhatsapp: string, text: string): string {
  return `https://wa.me/${phoneWhatsapp}?text=${encodeURIComponent(text)}`;
}

export interface WinbackContact {
  customer_id: string;
  coupon: string;
  contacted_at: string;
}

export interface WinbackResult {
  contacted: number;
  /** Contatados que compraram (crédito de cashback) depois da mensagem. */
  returned: number;
  returnedPct: number | null;
  /** Quanto os que voltaram compraram depois da mensagem (base do cashback). */
  revenue: number;
}

export function winbackResults(contacts: readonly WinbackContact[], ledger: readonly CashbackLedgerEntry[]): WinbackResult {
  const lastContact = new Map<string, string>();
  for (const c of contacts) {
    const prev = lastContact.get(c.customer_id);
    // Conta a partir do primeiro contato: quem voltou depois de qualquer mensagem voltou.
    if (!prev || c.contacted_at < prev) lastContact.set(c.customer_id, c.contacted_at);
  }
  const back = new Set<string>();
  let cents = 0;
  for (const e of ledger) {
    if (e.entry_type !== 'EARN') continue;
    const since = lastContact.get(e.customer_id);
    if (!since || e.created_at <= since) continue;
    back.add(e.customer_id);
    cents += toCents(e.base_amount ?? 0);
  }
  const contacted = lastContact.size;
  return { contacted, returned: back.size, returnedPct: contacted ? Math.round((back.size / contacted) * 1000) / 10 : null, revenue: fromCents(cents) };
}
