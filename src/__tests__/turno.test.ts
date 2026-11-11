import { describe, expect, it } from 'vitest';
import { reconciliation, shiftStart, waiterSplit } from '../lib/reports';
import type { Order, OrderItem, Payment, StaffUser } from '../types';

const now = new Date(2026, 10, 9, 23, 0);
const since = shiftStart(now);
const ontem = new Date(2026, 10, 8, 22, 0).toISOString();
const hoje = new Date(2026, 10, 9, 21, 0).toISOString();

describe('Conciliação e rateio só do turno (desde 05:00)', () => {
  it('conciliação ignora pagamentos aprovados de turnos anteriores', () => {
    const pay = (amount: number, created_at: string) =>
      ({ amount, status: 'APPROVED', acquirer: 'STONE', method: 'CREDIT', created_at }) as Payment;
    const [stone] = reconciliation([pay(300, ontem), pay(110, hoje)], since);
    expect(stone!.total).toBe(110);
    expect(stone!.count).toBe(1);
    expect(stone!.byMethod.CREDIT).toBe(110);
  });

  it('rateio dos 10% considera só contas fechadas no turno', () => {
    const staff = [{ id: 'w1', name: 'Tião' }] as StaffUser[];
    const ord = (id: string, closed_at: string) =>
      ({ id, status: 'CLOSED', closed_at, service_fee_amount: 10 }) as Order;
    const item = (order_id: string) =>
      ({ order_id, waiter_id: 'w1', status: 'DELIVERED', total_item_price: 100, quantity: 1 }) as OrderItem;
    const rows = waiterSplit([ord('o1', ontem), ord('o2', hoje)], [item('o1'), item('o2')], staff, since);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.commission).toBe(10);
    expect(rows[0]!.sales).toBe(100);
    expect(rows[0]!.itemsSold).toBe(1);
  });
});
