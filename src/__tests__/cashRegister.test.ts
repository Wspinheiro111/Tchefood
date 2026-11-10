import { beforeEach, describe, expect, it } from 'vitest';
import { useTcheStore } from '../store/useTcheStore';
import { cashOutsideSessions, cashSummary, closingDifference, closingReceiptLines, parseMoneyInput, validCashAmount } from '../lib/cashRegister';
import { migratePersisted } from '../store/useTcheStore';
import type { CashSession, Payment } from '../types';

const st = () => useTcheStore.getState();

function payCash(amount: number) {
  expect(st().login('1111').ok).toBe(true);
  const table = st().tables.find((t) => t.number === 1)!;
  const o = st().openTable(table.id, 2, null);
  if (!o.ok) throw new Error(o.error);
  const p = st().products.find((x) => x.code === '311')!;
  st().addToTray({ order_id: o.data.id, product_id: p.id, half_product_ids: [], quantity: 1, unit_price: p.price, modifiers: [], modifiers_unit_price: 0, meat_doneness: null, quick_tags: [], free_notes: '', sector: p.sector });
  st().dispatchTray(o.data.id);
  st().startCheckout(o.data.id);
  const r = st().registerPayment({ orderId: o.data.id, amount, method: 'CASH', status: 'APPROVED', terminal_id: null, acquirer: 'CASH_DESK', acquirer_cnpj: null, card_brand: null, nsu: null, authorization_code: null, terminal_serial: null, idempotency_key: `cash-${amount}-${Math.random()}`, item_ids: [] });
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

const asCashier = () => expect(st().login('5555').ok).toBe(true);

beforeEach(() => st().resetDemo());

describe('caixa — funções puras', () => {
  const session: CashSession = {
    id: 's1', tenant_id: 't', opened_by_user_id: 'u', opened_at: '2026-11-10T12:00:00.000Z', opening_float: 100, status: 'OPEN',
    closed_by_user_id: null, closed_at: null, counted_cash: null, expected_cash: null, difference: null, closing_notes: null, closing_authorized_by_manager_id: null,
  };
  const pay = (amount: number, at: string, method: Payment['method'] = 'CASH', status: Payment['status'] = 'APPROVED') => ({ id: at + amount, amount, created_at: at, method, status }) as Payment;

  it('esperado = fundo + dinheiro aprovado + suprimentos − sangrias, sem centavo perdido', () => {
    const payments = [pay(10.1, '2026-11-10T12:10:00Z'), pay(20.2, '2026-11-10T12:20:00Z'), pay(50, '2026-11-10T12:30:00Z', 'PIX'), pay(5, '2026-11-10T12:40:00Z', 'CASH', 'DECLINED'), pay(7, '2026-11-10T11:00:00Z')];
    const movements = [
      { id: 'm1', tenant_id: 't', session_id: 's1', type: 'SUPPLY' as const, amount: 0.3, reason: 'Troco do banco', performed_by_user_id: 'u', authorized_by_manager_id: null, created_at: '2026-11-10T12:15:00Z' },
      { id: 'm2', tenant_id: 't', session_id: 's1', type: 'WITHDRAWAL' as const, amount: 30, reason: 'Depósito', performed_by_user_id: 'u', authorized_by_manager_id: 'g', created_at: '2026-11-10T12:50:00Z' },
      { id: 'm3', tenant_id: 't', session_id: 'outro', type: 'SUPPLY' as const, amount: 999, reason: 'Outro caixa', performed_by_user_id: 'u', authorized_by_manager_id: null, created_at: '2026-11-10T12:50:00Z' },
    ];
    const s = cashSummary(session, payments, movements, new Date('2026-11-10T13:00:00Z'));
    expect(s).toEqual({ openingFloat: 100, cashSales: 30.3, cashSalesCount: 2, supplies: 0.3, withdrawals: 30, expected: 100.6 });
    expect(closingDifference(100.5, s.expected)).toBe(-0.1);
    expect(closingDifference(100.6, s.expected)).toBe(0);
  });

  it('dinheiro fora de caixa aberto aparece separado', () => {
    const closed = { ...session, status: 'CLOSED' as const, closed_at: '2026-11-10T14:00:00Z' };
    const r = cashOutsideSessions([pay(10, '2026-11-10T13:00:00Z'), pay(25, '2026-11-10T15:00:00Z'), pay(3, '2026-11-10T09:00:00Z')], [closed], new Date('2026-11-10T08:00:00Z'), new Date('2026-11-10T16:00:00Z'));
    expect(r).toEqual({ amount: 28, count: 2 });
  });

  it('lê valor digitado em reais', () => {
    expect(parseMoneyInput('1.234,56')).toBe(1234.56);
    expect(parseMoneyInput('R$ 50')).toBe(50);
    expect(parseMoneyInput('12.5')).toBe(12.5);
    expect(parseMoneyInput('1,234')).toBeNaN();
    expect(parseMoneyInput('abc')).toBeNaN();
    expect(validCashAmount(0)).toBe(false);
    expect(validCashAmount(0, true)).toBe(true);
    expect(validCashAmount(-1, true)).toBe(false);
    expect(validCashAmount(100_001)).toBe(false);
  });
});

describe('caixa — store', () => {
  it('abre um caixa só, com fundo de troco, e manda para a fila', () => {
    asCashier();
    const r = st().openCashSession(150);
    expect(r.ok).toBe(true);
    expect(st().openCashSession(10).ok).toBe(false);
    expect(st().outbox.at(-1)).toMatchObject({ table: 'cash_sessions', op: 'INSERT' });
  });

  it('garçom não mexe no caixa', () => {
    expect(st().login('1111').ok).toBe(true);
    expect(st().openCashSession(0).ok).toBe(false);
  });

  it('suprimento exige caixa aberto e motivo', () => {
    asCashier();
    expect(st().addCashSupply(10, 'Troco do banco').ok).toBe(false);
    st().openCashSession(0);
    expect(st().addCashSupply(10, 'oi').ok).toBe(false);
    const r = st().addCashSupply(10, 'Troco do banco');
    expect(r.ok && r.data.authorized_by_manager_id).toBe(null);
    expect(st().outbox.at(-1)).toMatchObject({ table: 'cash_movements', op: 'INSERT' });
  });

  it('sangria pede PIN de gerente, nunca passa do que há na gaveta e registra auditoria', () => {
    asCashier();
    st().openCashSession(100);
    expect(st().addCashWithdrawal(150, { managerPin: '9999', reason: 'Depósito no banco' }).ok).toBe(false);
    expect(st().addCashWithdrawal(50, { managerPin: '5555', reason: 'Depósito no banco' }).ok).toBe(false);
    const r = st().addCashWithdrawal(60, { managerPin: '9999', reason: 'Depósito no banco' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const log = st().auditLogs.find((l) => l.action_type === 'CASH_WITHDRAWAL')!;
    expect(log.amount_impact).toBe(-60);
    expect(log.metadata).toMatchObject({ movement_id: r.data.id, session_id: r.data.session_id });
    const tail = st().outbox.slice(-2);
    // A autorização sobe antes do movimento (o banco confere a autorização).
    expect(tail[0]!.payload).toMatchObject({ action_type: 'CASH_WITHDRAWAL' });
    expect(tail[1]).toMatchObject({ table: 'cash_movements', op: 'INSERT' });
    const open = st().cashSessions.find((c) => c.status === 'OPEN')!;
    expect(cashSummary(open, st().payments, st().cashMovements).expected).toBe(40);
  });

  it('fechamento cego: sem diferença fecha direto; com diferença só com gerente', () => {
    asCashier();
    st().openCashSession(100);
    payCash(18.9);
    asCashier();
    const blocked = st().closeCashSession(110, null, null);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error).toContain('Faltou R$');
    expect(st().cashSessions[0]!.status).toBe('OPEN');
    const r = st().closeCashSession(110, 'nota rasgada', { managerPin: '9999', reason: 'Troco dado errado' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toMatchObject({ status: 'CLOSED', expected_cash: 118.9, counted_cash: 110, difference: -8.9 });
    const log = st().auditLogs.find((l) => l.action_type === 'CASH_CLOSE_DIFFERENCE')!;
    expect(log).toMatchObject({ amount_impact: -8.9, whatsapp_alert_sent: true });
    expect(st().outbox.at(-1)).toMatchObject({ table: 'cash_sessions', op: 'UPDATE' });
    expect(st().closeCashSession(0, null, null).ok).toBe(false);
    // Novo caixa pode abrir depois do fechamento.
    expect(st().openCashSession(0).ok).toBe(true);
    expect(st().closeCashSession(0, null, null).ok).toBe(true);
  });

  it('cupom de fechamento cabe na bobina', () => {
    asCashier();
    st().openCashSession(100);
    st().addCashSupply(20, 'Troco trazido pelo gerente com um motivo bem comprido');
    const closed = st().closeCashSession(120, null, null);
    expect(closed.ok).toBe(true);
    if (!closed.ok) return;
    const lines = closingReceiptLines({ tenant: st().tenant, session: closed.data, summary: cashSummary(closed.data, st().payments, st().cashMovements), movements: st().cashMovements, staff: st().staff });
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(32);
    expect(lines.join('\n')).toContain('ESPERADO NA GAVETA');
  });

  it('migração v5 → v6 cria as listas do caixa', () => {
    const out = migratePersisted({ orders: [] }, 5) as Record<string, unknown>;
    expect(out.cashSessions).toEqual([]);
    expect(out.cashMovements).toEqual([]);
  });
});
