// @vitest-environment jsdom
/**
 * Teste de componente da Retaguarda com relógio controlado: os arrays do
 * Zustand ficam iguais e só o tempo anda. Cobre a virada das 05:00 e o registro
 * que deixa de estar no futuro (P1-01 da rodada 1 e P2-02 da rodada 3).
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dashboard, Reconciliation, WaiterSplit } from '../screens/BackOffice';
import { useTcheStore } from '../store/useTcheStore';
import type { Order, OrderItem, Payment, StaffUser } from '../types';

const BRT = (iso: string) => new Date(`${iso}-03:00`);
const pay = (id: string, amount: number, at: string) =>
  ({ id, amount, status: 'APPROVED', acquirer: 'STONE', method: 'CREDIT', created_at: BRT(at).toISOString(), terminal_serial: 'T1' }) as unknown as Payment;
const ord = (id: string, at: string, fee: number) =>
  ({ id, status: 'CLOSED', closed_at: BRT(at).toISOString(), opened_at: BRT(at).toISOString(), service_fee_amount: fee, total_amount: fee * 11, remaining_balance: 0 }) as unknown as Order;
const item = (order_id: string, price: number) =>
  ({ id: `i-${order_id}`, order_id, waiter_id: 'w1', status: 'DELIVERED', total_item_price: price, quantity: 1 }) as unknown as OrderItem;
const staff = [{ id: 'w1', name: 'Tião' }] as StaffUser[];

function seed(orders: Order[], payments: Payment[], items: OrderItem[]) {
  act(() => {
    useTcheStore.setState({ orders, payments, orderItems: items, staff, tables: [] } as never);
  });
}

/** Valor da linha do garçom (comissão) e total da conciliação, lidos da tela. */
const brl = (v: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
const has = (text: string) => screen.queryAllByText((_, el) => el?.textContent === text).length > 0;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Retaguarda: relógio reativo sem mudar os arrays', () => {
  it('Rateio 10%: 04:59 mostra o turno de ontem, 05:01 zera e a legenda vira 11/11', () => {
    vi.setSystemTime(BRT('2026-11-11T04:59:00'));
    seed([ord('o1', '2026-11-11T02:00:00', 80)], [], [item('o1', 800)]);
    render(<WaiterSplit />);
    expect(has(brl(80))).toBe(true);
    expect(screen.getByText(/desde 10\/11, 05:00/)).toBeTruthy();
    act(() => { vi.advanceTimersByTime(2 * 60_000); });
    expect(has(brl(80))).toBe(false);
    expect(screen.getByText(/desde 11\/11, 05:00/)).toBeTruthy();
  });

  it('Conciliação: pagamento das 10:01 não aparece às 10:00 e aparece às 10:02', () => {
    vi.setSystemTime(BRT('2026-11-11T10:00:00'));
    seed([], [pay('p1', 70, '2026-11-11T10:01:00')], []);
    render(<Reconciliation />);
    expect(has(brl(70))).toBe(false);
    act(() => { vi.advanceTimersByTime(2 * 60_000); });
    expect(has(brl(70))).toBe(true);
  });

  it('Rateio: conta fechada às 10:01 entra às 10:02', () => {
    vi.setSystemTime(BRT('2026-11-11T10:00:00'));
    seed([ord('o2', '2026-11-11T10:01:00', 9)], [], [item('o2', 90)]);
    render(<WaiterSplit />);
    expect(has(brl(9))).toBe(false);
    act(() => { vi.advanceTimersByTime(2 * 60_000); });
    expect(has(brl(9))).toBe(true);
  });

  it('volta do app no mesmo turno (timer perdido) atualiza o fim do período', () => {
    vi.setSystemTime(BRT('2026-11-11T10:00:00'));
    seed([], [pay('p1', 70, '2026-11-11T10:01:00')], []);
    render(<Reconciliation />);
    // Aparelho dormindo: o relógio anda, mas o timer não dispara.
    vi.setSystemTime(BRT('2026-11-11T10:00:30').getTime() + 2 * 60_000);
    expect(has(brl(70))).toBe(false);
    act(() => { document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('visibilitychange')); });
    expect(has(brl(70))).toBe(true);
  });

  it('Dashboard: KPI e conciliação usam o mesmo período (pagamento futuro fora dos dois)', () => {
    vi.setSystemTime(BRT('2026-11-11T10:00:00'));
    seed([ord('f', '2026-11-11T10:05:00', 10)], [pay('a', 50, '2026-11-11T09:00:00'), pay('b', 110, '2026-11-11T10:05:00')], []);
    render(<Dashboard />);
    // Faturamento bruto e Stone mostram R$ 50,00; nada de R$ 160,00 nem de R$ 110,00.
    expect(screen.getAllByText((_, el) => el?.textContent === brl(50)).length).toBeGreaterThanOrEqual(2);
    expect(has(brl(160))).toBe(false);
    expect(has(brl(110))).toBe(false);
    expect(screen.getByText(/aprovados desde 11\/11, 05:00/)).toBeTruthy();
  });

  it('venda nova entra na hora, sem esperar o próximo minuto', () => {
    vi.setSystemTime(BRT('2026-11-11T10:00:00'));
    seed([], [], []);
    render(<Reconciliation />);
    vi.setSystemTime(BRT('2026-11-11T10:00:40'));
    seed([], [pay('n', 33, '2026-11-11T10:00:40')], []);
    expect(has(brl(33))).toBe(true);
  });
});
