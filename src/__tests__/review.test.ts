import { afterEach, describe, expect, it } from 'vitest';
import { shiftKpis, shiftStart } from '../lib/reports';
import { StonePosDriver } from '../lib/payments/drivers';
import type { Order, Payment } from '../types';

const g = globalThis as unknown as { window?: Record<string, unknown> };
afterEach(() => { delete g.window; });

describe('KPIs do turno', () => {
  it('turno vira às 05:00 e ignora pagamentos e contas de turnos anteriores', () => {
    const now = new Date(2026, 10, 9, 23, 0);
    expect(shiftStart(now).getHours()).toBe(5);
    expect(shiftStart(new Date(2026, 10, 10, 2, 0)).getDate()).toBe(9);
    const since = shiftStart(now);
    const yesterday = new Date(2026, 10, 8, 22, 0).toISOString();
    const today = new Date(2026, 10, 9, 21, 0).toISOString();
    const pay = (amount: number, created_at: string) => ({ amount, status: 'APPROVED', created_at }) as Payment;
    const ord = (closed_at: string, total: number) => ({ status: 'CLOSED', closed_at, opened_at: closed_at, total_amount: total, service_fee_amount: 10, remaining_balance: 0 }) as Order;
    const k = shiftKpis([ord(yesterday, 300), ord(today, 110)], [pay(300, yesterday), pay(110, today)], since);
    expect(k.grossRevenue).toBe(110);
    expect(k.closedOrders).toBe(1);
    expect(k.averageTicket).toBe(110);
    expect(k.serviceFeeTotal).toBe(10);
  });
});

describe('Stone nativa', () => {
  it('entrega cada resultado à cobrança de origem e recusa uma segunda em paralelo', async () => {
    const sent: Array<{ request_id: string }> = [];
    g.window = { StoneBridge: { pay: (json: string) => sent.push(JSON.parse(json)) } };
    const d = new StonePosDriver('SMARTPOS_EMBEDDED', null);
    const base = { idempotency_key: 'k', method: 'CREDIT' as const, table_label: 'Mesa 1', description: 'x' };
    const p1 = d.charge({ ...base, request_id: 'r1', amount: 10, order_id: 'o1' });
    const p2 = await d.charge({ ...base, request_id: 'r2', amount: 20, order_id: 'o2' });
    expect(p2.status).toBe('DECLINED');
    expect(sent).toHaveLength(1);
    const cb = g.window.onStoneResult as (r: unknown) => void;
    cb({ request_id: 'outra', status: 'APPROVED' }); // resultado sem cobrança correspondente é ignorado
    cb({ request_id: 'r1', status: 'APPROVED', acquirer: 'STONE', nsu: '123456' });
    await expect(p1).resolves.toMatchObject({ status: 'APPROVED', nsu: '123456' });
  });
});
