/** Fechamento anual, rodada interna 3: atalho do prazo do repasse e taxa de serviço. */
import { describe, expect, it } from 'vitest';
import { openPositionsAt, revenueByMethod, settlementDayBrasilia, yearPeriod } from '../lib/annualClose';
import type { FeeRule } from '../lib/cardFees';
import type { CashMovement, CashSession, Payment } from '../types';

const P = yearPeriod(2025);
const P26 = yearPeriod(2026);
const NOW = new Date('2026-11-14T10:00:00-03:00');
const pay = (p: Partial<Payment>): Payment =>
  ({ id: Math.random().toString(), order_id: 'o', tenant_id: 't', amount: 100, tip_amount: 0, method: 'CREDIT', status: 'APPROVED', acquirer: 'STONE', card_brand: 'VISA', created_at: '2025-03-10T20:00:00-03:00', ...p }) as Payment;
const rule = (r: Partial<FeeRule>): FeeRule => ({ id: Math.random().toString(), acquirer: 'STONE', method: 'CREDIT', brand: null, pct: 3, fixed: 0, days: 30, businessDays: false, ...r });
const open = (payments: Payment[], feeRules: FeeRule[], p = P) => openPositionsAt({ payments, feeRules, ownDeliveries: [], courierSettlements: [], couriers: [], orders: [] }, p, NOW);
const emptyRevenueInput = { payments: [] as Payment[], marketplace: [], feeRules: [] as FeeRule[], appCommissionPct: {}, cashSessions: [] as CashSession[], cashMovements: [] as CashMovement[], staff: [] };

describe('atalho do prazo não pode pular venda ainda a receber', () => {
  it('D+4 úteis vendida na sexta 26/12 cai na quinta 01/01: a receber', () => {
    const t = Date.parse('2025-12-26T20:00:00-03:00');
    expect(settlementDayBrasilia(t, { days: 4, businessDays: true })).toBe(P.to);
    expect(open([pay({ created_at: '2025-12-26T20:00:00-03:00' })], [rule({ days: 4, businessDays: true })]).cardReceivables.map((x) => x.count)).toEqual([1]);
  });
  it('D+14 úteis vendida em 12/12 cai em 01/01: a receber', () => {
    expect(settlementDayBrasilia(Date.parse('2025-12-12T20:00:00-03:00'), { days: 14, businessDays: true })).toBe(P.to);
    expect(open([pay({ created_at: '2025-12-12T20:00:00-03:00' })], [rule({ days: 14, businessDays: true })]).cardReceivables.map((x) => x.count)).toEqual([1]);
  });
  it('ano em andamento, D+30 corrido vendida 30 dias e 1 min antes do corte: repasse hoje, a receber', () => {
    expect(open([pay({ created_at: '2026-10-15T09:59:00-03:00' })], [rule({ days: 30 })], P26).cardReceivables.map((x) => x.count)).toEqual([1]);
  });
});

describe('taxa de serviço: só comanda fechada e só pagamentos antes do corte', () => {
  it('comanda aberta ou cancelada não conta; pagamento depois do corte não conta', () => {
    const cx = (order_id: string, created_at: string) => pay({ order_id, amount: 11, method: 'PIX', acquirer: 'CASH_DESK', created_at });
    const r = revenueByMethod({ ...emptyRevenueInput, payments: [cx('a', '2025-05-01T21:00:00-03:00'), cx('b', '2025-05-01T21:00:00-03:00'), cx('c', '2025-05-01T21:00:00-03:00'), cx('d', '2024-12-31T21:00:00-03:00')], orders: [
      { id: 'a', status: 'CANCELED', service_fee_amount: 5 },
      { id: 'b', status: 'OPEN', service_fee_amount: 6 },
      { id: 'c', status: 'CLOSED', service_fee_amount: 1 },
      { id: 'd', status: 'CLOSED', service_fee_amount: 7 },
    ] }, P, NOW);
    expect(r.serviceFee).toBe(1);
    const r26 = revenueByMethod({ ...emptyRevenueInput, payments: [cx('e', '2026-11-14T09:00:00-03:00'), cx('f', '2026-11-14T11:00:00-03:00')], orders: [
      { id: 'e', status: 'CLOSED', service_fee_amount: 1 },
      { id: 'f', status: 'CLOSED', service_fee_amount: 1 },
    ] }, P26, NOW);
    expect(r26.serviceFee).toBe(1);
  });
});
