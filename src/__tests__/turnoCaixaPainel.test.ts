/**
 * Caixa e Painel do dono contam o dia operacional pelas 05:00 de Brasília, não
 * pelo fuso do aparelho (seguimento do PR #43). Cada caso roda com o aparelho em
 * vários fusos e usa instantes absolutos.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { brasiliaHour, brasiliaWeekday, declinedInShift, shiftStartBrasilia, shiftStartDaysFrom, currentShiftPeriod } from '../lib/reports';
import { dayOverview, indexDashboard, periodRanges, type DashboardInput } from '../lib/ownerDashboard';
import { cashOutsideSessions } from '../lib/cashRegister';
import type { CashSession, DiningTable, Order, Payment } from '../types';

// Brasília = UTC-3 (sem horário de verão desde 2019).
const BRT = (iso: string) => new Date(`${iso}-03:00`);
const iso = (s: string) => BRT(s).toISOString();

const TZS = ['UTC', 'America/Sao_Paulo', 'Asia/Tokyo', 'America/Los_Angeles'];
const ORIGINAL_TZ = process.env.TZ;
afterEach(() => {
  process.env.TZ = ORIGINAL_TZ;
});

const table = { id: 'm1', kind: 'TABLE' } as unknown as DiningTable;
const order = (id: string) => ({ id, table_id: 'm1', status: 'CLOSED', opened_at: iso('2026-11-09T12:00:00'), closed_at: iso('2026-11-09T13:00:00') }) as unknown as Order;
const pay = (id: string, amount: number, at: string, status: Payment['status'] = 'APPROVED', method: Payment['method'] = 'CASH') =>
  ({ id, order_id: 'a', amount, tip_amount: 0, method, status, acquirer: 'CASH_DESK', created_at: iso(at) }) as unknown as Payment;
const input = (p: Partial<DashboardInput>): DashboardInput =>
  ({ orders: [], orderItems: [], payments: [], tables: [table], products: [], auditLogs: [], loyaltyCustomers: [], cashbackLedger: [], marketplace: [], ...p });

describe.each(TZS)('aparelho em %s', (tz) => {
  it('Painel "Hoje": começa às 05:00 de Brasília e compara com a semana passada até a mesma hora', () => {
    process.env.TZ = tz;
    const r = periodRanges('today', BRT('2026-11-09T20:06:00'));
    expect(new Date(r.current.from).toISOString()).toBe(iso('2026-11-09T05:00:00'));
    expect(new Date(r.previous.from).toISOString()).toBe(iso('2026-11-02T05:00:00'));
    expect(new Date(r.previous.to - 1).toISOString()).toBe(iso('2026-11-02T20:06:00'));
  });

  it('Painel de madrugada (02:30 de Brasília): o dia ainda é o de ontem', () => {
    process.env.TZ = tz;
    const r = periodRanges('today', BRT('2026-11-10T02:30:00'));
    expect(new Date(r.current.from).toISOString()).toBe(iso('2026-11-09T05:00:00'));
  });

  it('Painel "Ontem", "7 dias" e "30 dias": dias inteiros de Brasília', () => {
    process.env.TZ = tz;
    const now = BRT('2026-11-09T20:06:00');
    const y = periodRanges('yesterday', now);
    expect(new Date(y.current.from).toISOString()).toBe(iso('2026-11-08T05:00:00'));
    expect(new Date(y.current.to).toISOString()).toBe(iso('2026-11-09T05:00:00'));
    expect(new Date(y.previous.from).toISOString()).toBe(iso('2026-11-01T05:00:00'));
    expect(new Date(y.previous.to).toISOString()).toBe(iso('2026-11-02T05:00:00'));
    const w = periodRanges('7d', now);
    expect(new Date(w.current.from).toISOString()).toBe(iso('2026-11-03T05:00:00'));
    expect(new Date(w.previous.from).toISOString()).toBe(iso('2026-10-27T05:00:00'));
    const m = periodRanges('30d', now);
    expect(new Date(m.current.from).toISOString()).toBe(iso('2026-10-11T05:00:00'));
    expect(new Date(m.previous.to - 1).toISOString()).toBe(iso('2026-10-10T20:06:00'));
  });

  it('Painel: gráfico por hora começa às 5h de Brasília e a venda das 12:00 cai na hora 12', () => {
    process.env.TZ = tz;
    const ix = indexDashboard(input({ orders: [order('a')], payments: [pay('p1', 150, '2026-11-09T12:00:00')] }));
    const ov = dayOverview(ix, 'today', BRT('2026-11-09T20:06:00'));
    expect(ov.hourly![0]!.hour).toBe(5);
    expect(ov.hourly!.find((p) => p.hour === 12)!.current).toBe(150);
    expect(ov.sales).toBe(150);
  });

  it('Meta do dia: às 02:30 de terça (Brasília) ainda vale a meta de segunda', () => {
    process.env.TZ = tz;
    expect(brasiliaWeekday(shiftStartBrasilia(BRT('2026-11-10T02:30:00')))).toBe(1);
    expect(brasiliaWeekday(shiftStartBrasilia(BRT('2026-11-09T23:30:00')))).toBe(1);
    expect(brasiliaWeekday(shiftStartBrasilia(BRT('2026-11-10T05:00:00')))).toBe(2);
  });

  it('Caixa: dinheiro fora do caixa conta desde as 05:00 de Brasília (03:00 é do turno anterior)', () => {
    process.env.TZ = tz;
    const now = BRT('2026-11-10T10:00:00');
    const session = { id: 's1', status: 'OPEN', opened_at: iso('2026-11-10T09:00:00'), closed_at: null } as unknown as CashSession;
    const payments = [pay('p1', 30, '2026-11-10T03:00:00'), pay('p2', 20, '2026-11-10T06:00:00'), pay('p3', 99, '2026-11-10T09:30:00')];
    const r = cashOutsideSessions(payments, [session], shiftStartBrasilia(now), now);
    expect(r).toEqual({ amount: 20, count: 1 });
  });

  it('Conciliação: recusadas só do turno [05:00, agora]', () => {
    process.env.TZ = tz;
    const now = BRT('2026-11-10T10:00:00');
    const period = currentShiftPeriod(shiftStartBrasilia(now), now);
    const payments = [
      pay('ontem', 10, '2026-11-09T22:00:00', 'DECLINED', 'CREDIT'),
      pay('madrugada', 11, '2026-11-10T04:59:00', 'DECLINED', 'CREDIT'),
      pay('turno', 12, '2026-11-10T05:00:00', 'DECLINED', 'CREDIT'),
      pay('aprovada', 13, '2026-11-10T06:00:00', 'APPROVED', 'CREDIT'),
      pay('futuro', 14, '2026-11-10T10:01:00', 'DECLINED', 'CREDIT'),
      { ...pay('invalida', 15, '2026-11-10T06:00:00', 'DECLINED', 'CREDIT'), created_at: 'x' } as Payment,
    ];
    expect(declinedInShift(payments, period).map((p) => p.id)).toEqual(['turno']);
  });
});

describe('dias do calendário de Brasília', () => {
  it('shiftStartDaysFrom anda em dias de Brasília para frente e para trás', () => {
    const start = BRT('2026-11-09T05:00:00');
    expect(shiftStartDaysFrom(start, -1).toISOString()).toBe(iso('2026-11-08T05:00:00'));
    expect(shiftStartDaysFrom(start, 1).toISOString()).toBe(iso('2026-11-10T05:00:00'));
    expect(shiftStartDaysFrom(start, -59).toISOString()).toBe(iso('2026-09-11T05:00:00'));
    expect(shiftStartDaysFrom(start.getTime(), 0).toISOString()).toBe(start.toISOString());
  });

  it('brasiliaHour lê a hora de Brasília, não a do aparelho', () => {
    process.env.TZ = 'Asia/Tokyo';
    expect(brasiliaHour(BRT('2026-11-09T05:00:00'))).toBe(5);
    expect(brasiliaHour(BRT('2026-11-09T23:59:00'))).toBe(23);
    expect(brasiliaHour(BRT('2026-11-10T00:00:00'))).toBe(0);
  });
});
