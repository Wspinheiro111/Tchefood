/**
 * Relatórios da Retaguarda Executiva (Fase 4). Funções puras sobre o estado.
 */
import type { AuditLog, DiningTable, Order, OrderItem, Payment, StaffUser } from '../types';
import { allocateCents, fromCents, toCents } from './money';

export interface ShiftKpis {
  grossRevenue: number;
  closedOrders: number;
  averageTicket: number;
  serviceFeeTotal: number;
  tablesServed: number;
  openBalance: number;
  openOrders: number;
}

/** Hora em que vira o dia operacional (o turno da noite que passa da meia-noite conta no dia anterior). */
export const SHIFT_CUTOFF_HOUR = 5;

/** Início do turno corrente: hoje às 05:00, ou ontem às 05:00 se ainda é madrugada. */
export function shiftStart(now: Date = new Date(), cutoffHour = SHIFT_CUTOFF_HOUR): Date {
  const start = new Date(now);
  start.setHours(cutoffHour, 0, 0, 0);
  if (now < start) start.setDate(start.getDate() - 1);
  return start;
}

/**
 * KPIs do turno: faturamento, contas fechadas, ticket médio e 10% contam só o
 * que aconteceu desde `since`; o saldo em aberto no salão é sempre o atual.
 */
export function shiftKpis(orders: readonly Order[], payments: readonly Payment[], since: Date = shiftStart()): ShiftKpis {
  const from = since.getTime();
  const inShift = (iso: string | null) => iso !== null && new Date(iso).getTime() >= from;
  const approved = payments.filter((p) => p.status === 'APPROVED' && inShift(p.created_at));
  const grossCents = approved.reduce((a, p) => a + toCents(p.amount), 0);
  const closed = orders.filter((o) => o.status === 'CLOSED' && inShift(o.closed_at));
  const closedTotalCents = closed.reduce((a, o) => a + toCents(o.total_amount), 0);
  const feeCents = closed.reduce((a, o) => a + toCents(o.service_fee_amount), 0);
  const open = orders.filter((o) => o.status === 'OPEN' || o.status === 'PAYING');
  return {
    grossRevenue: fromCents(grossCents),
    closedOrders: closed.length,
    averageTicket: closed.length ? fromCents(Math.round(closedTotalCents / closed.length)) : 0,
    serviceFeeTotal: fromCents(feeCents),
    tablesServed: orders.filter((o) => o.status !== 'CANCELED' && (inShift(o.opened_at) || inShift(o.closed_at) || o.status === 'OPEN' || o.status === 'PAYING')).length,
    openBalance: fromCents(open.reduce((a, o) => a + toCents(o.remaining_balance), 0)),
    openOrders: open.length,
  };
}

export type ReconKey = 'STONE' | 'PAGBANK' | 'CASH_DESK';
export type ReconMethod = 'CREDIT' | 'DEBIT' | 'PIX' | 'CASH' | 'VOUCHER';

export interface ReconRow {
  acquirer: ReconKey;
  cnpj: string | null;
  byMethod: Record<ReconMethod, number>;
  total: number;
  count: number;
}

export function reconciliation(payments: readonly Payment[]): ReconRow[] {
  const rows: Record<ReconKey, ReconRow> = {
    STONE: { acquirer: 'STONE', cnpj: '16501555000157', byMethod: { CREDIT: 0, DEBIT: 0, PIX: 0, CASH: 0, VOUCHER: 0 }, total: 0, count: 0 },
    PAGBANK: { acquirer: 'PAGBANK', cnpj: '08561701000101', byMethod: { CREDIT: 0, DEBIT: 0, PIX: 0, CASH: 0, VOUCHER: 0 }, total: 0, count: 0 },
    CASH_DESK: { acquirer: 'CASH_DESK', cnpj: null, byMethod: { CREDIT: 0, DEBIT: 0, PIX: 0, CASH: 0, VOUCHER: 0 }, total: 0, count: 0 },
  };
  const cents: Record<ReconKey, Record<ReconMethod, number>> = {
    STONE: { CREDIT: 0, DEBIT: 0, PIX: 0, CASH: 0, VOUCHER: 0 },
    PAGBANK: { CREDIT: 0, DEBIT: 0, PIX: 0, CASH: 0, VOUCHER: 0 },
    CASH_DESK: { CREDIT: 0, DEBIT: 0, PIX: 0, CASH: 0, VOUCHER: 0 },
  };
  for (const p of payments) {
    if (p.status !== 'APPROVED') continue;
    const key: ReconKey = p.acquirer === 'STONE' || p.acquirer === 'PAGBANK' ? p.acquirer : 'CASH_DESK';
    cents[key][p.method] += toCents(p.amount);
    rows[key].count += 1;
  }
  for (const k of Object.keys(rows) as ReconKey[]) {
    let total = 0;
    for (const m of Object.keys(cents[k]) as ReconMethod[]) {
      rows[k].byMethod[m] = fromCents(cents[k][m]);
      total += cents[k][m];
    }
    rows[k].total = fromCents(total);
  }
  return [rows.STONE, rows.PAGBANK, rows.CASH_DESK];
}

export interface WaiterRow {
  waiter: StaffUser;
  itemsSold: number;
  sales: number;
  commission: number;
}

/**
 * Rateio de garçons: para cada comanda FECHADA, a taxa de serviço efetivamente
 * cobrada é distribuída entre os garçons proporcionalmente ao valor que cada
 * um lançou (maiores restos → Σ comissões == Σ taxas, sem perder centavo).
 */
export function waiterSplit(orders: readonly Order[], items: readonly OrderItem[], staff: readonly StaffUser[]): WaiterRow[] {
  const sales = new Map<string, { cents: number; qty: number; commission: number }>();
  const bump = (id: string) => {
    if (!sales.has(id)) sales.set(id, { cents: 0, qty: 0, commission: 0 });
    return sales.get(id)!;
  };
  for (const o of orders) {
    if (o.status !== 'CLOSED') continue;
    const valid = items.filter((i) => i.order_id === o.id && i.status !== 'CANCELED');
    const perWaiter = new Map<string, number>();
    for (const i of valid) {
      perWaiter.set(i.waiter_id, (perWaiter.get(i.waiter_id) ?? 0) + toCents(i.total_item_price));
      const row = bump(i.waiter_id);
      row.cents += toCents(i.total_item_price);
      row.qty += i.quantity;
    }
    const ids = [...perWaiter.keys()];
    const shares = allocateCents(toCents(o.service_fee_amount), ids.map((id) => perWaiter.get(id)!));
    ids.forEach((id, idx) => {
      bump(id).commission += shares[idx]!;
    });
  }
  return [...sales.entries()]
    .map(([id, v]) => ({
      waiter: staff.find((s) => s.id === id) ?? ({ id, name: 'Desconhecido' } as StaffUser),
      itemsSold: v.qty,
      sales: fromCents(v.cents),
      commission: fromCents(v.commission),
    }))
    .sort((a, b) => b.sales - a.sales);
}

export const AUDIT_LABEL: Record<AuditLog['action_type'], string> = {
  ITEM_CANCELED: 'Cancelamento de item',
  SERVICE_FEE_REMOVED: 'Remoção dos 10%',
  SERVICE_FEE_RESTORED: 'Reativação dos 10%',
  DISCOUNT_APPLIED: 'Desconto aplicado',
  MANAGER_PIN_FAILED: 'PIN de gerente incorreto',
  MANAGER_PIN_LOCKOUT: 'PIN bloqueado (3 erros)',
  KEG_CHANGED: 'Troca de barril de chopp',
  CASHBACK_REDEEMED: 'Cashback resgatado',
  KIOSK_EXIT: 'Totem fechado',
  CHARGE_CONFIRMED_MANUALLY: 'Cobrança incerta registrada pelo comprovante',
  PRODUCT_PRICE_CHANGED: 'Preço alterado no cadastro',
  STAFF_CREATED: 'Pessoa cadastrada na equipe',
  STAFF_PIN_CHANGED: 'PIN trocado',
  STAFF_ROLE_CHANGED: 'Perfil alterado',
  STAFF_DEACTIVATED: 'Acesso desativado',
  STAFF_REACTIVATED: 'Acesso reativado',
  PERMISSION_CHANGED: 'Permissão alterada',
  STORE_RESET: 'Loja nova iniciada no aparelho',
};

/** Texto do alerta enviado ao WhatsApp do proprietário. */
export function whatsappAlertText(log: AuditLog, staff: readonly StaffUser[], tables: readonly DiningTable[], orders: readonly Order[]): string {
  const waiter = staff.find((s) => s.id === log.performed_by_user_id)?.name ?? '?';
  const manager = log.authorized_by_manager_id ? staff.find((s) => s.id === log.authorized_by_manager_id)?.name ?? '?' : '— (sem autorização)';
  const order = orders.find((o) => o.id === log.order_id);
  const table = (log.metadata?.table as string | undefined) ?? tables.find((t) => t.id === order?.table_id)?.label ?? '?';
  const impact = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(log.amount_impact);
  const hour = new Date(log.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const product = log.metadata?.product_name ? `\n🍖 Item: ${String(log.metadata.quantity ?? '')}x ${String(log.metadata.product_name)}` : '';
  const receipt = log.metadata?.nsu ? `\n🧾 NSU ${String(log.metadata.nsu)} · AUT ${String(log.metadata.authorization_code ?? '')}` : '';
  return `🚨 *Tchê Food — Alerta Anti-Fraude*\n⏰ ${hour} · 🪑 ${table}\n📌 ${AUDIT_LABEL[log.action_type]}${product}${receipt}\n🙋 Garçom: ${waiter}\n🔐 Autorizado por: ${manager}\n💰 Impacto: ${impact}\n📝 Motivo: "${log.reason}"`;
}
