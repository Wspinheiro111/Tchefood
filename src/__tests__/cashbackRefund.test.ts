import { describe, expect, it } from 'vitest';
import { planCashbackRefund } from '../lib/loyalty';
import { mergeCashback } from '../lib/sync/cloudPull';
import type { CashbackLedgerEntry } from '../types';

// Decisão do Will (10/11/2026): o cashback vale 30 dias de quando foi gerado, com ou sem
// cancelamento. O estorno herda a validade do crédito de onde saiu.
const entry = (over: Partial<CashbackLedgerEntry>): CashbackLedgerEntry => ({
  id: 'x', tenant_id: 't', customer_id: 'c', order_id: null, entry_type: 'EARN', amount: 0, remaining_amount: 0,
  base_amount: null, pct: null, valid_from: null, expires_at: null, created_by_user_id: null, created_at: '2026-10-01T12:00:00.000Z',
  ...over,
});

describe('estorno do cashback', () => {
  const old = entry({ id: 'e1', amount: 30, remaining_amount: 0, valid_from: '2026-10-02T03:00:00.000Z', expires_at: '2026-11-01T03:00:00.000Z' });
  const fresh = entry({ id: 'e2', amount: 30, remaining_amount: 10, valid_from: '2026-11-02T03:00:00.000Z', expires_at: '2026-12-02T03:00:00.000Z', created_at: '2026-11-01T12:00:00.000Z' });
  const redeem = entry({
    id: 'r', order_id: 'o', entry_type: 'REDEEM', amount: 50, created_at: '2026-10-31T12:00:00.000Z',
    redeem_sources: [{ source_id: 'e1', amount: 30 }, { source_id: 'e2', amount: 20 }],
  });

  it('volta primeiro o crédito que vence por último, com a validade dele; crédito vencido volta vencido', () => {
    expect(planCashbackRefund([old, fresh, redeem], redeem, 30)).toEqual([
      { refund_of_id: 'e2', amount: 20, valid_from: fresh.valid_from, expires_at: fresh.expires_at },
      { refund_of_id: 'e1', amount: 10, valid_from: old.valid_from, expires_at: old.expires_at },
    ]);
  });

  it('o que já voltou de um crédito não volta de novo', () => {
    const back = entry({ id: 'b', order_id: 'o', entry_type: 'REFUND', amount: 20, refund_of_id: 'e2' });
    expect(planCashbackRefund([old, fresh, redeem, back], redeem, 5)).toEqual([
      { refund_of_id: 'e1', amount: 5, valid_from: old.valid_from, expires_at: old.expires_at },
    ]);
  });

  it('resgate sem origem registrada vence com o crédito consumido que vence por último', () => {
    const legacy = { ...redeem, redeem_sources: null, created_at: '2026-11-05T12:00:00.000Z' };
    expect(planCashbackRefund([old, fresh, legacy], legacy, 10)).toEqual([
      { refund_of_id: null, amount: 10, valid_from: fresh.valid_from, expires_at: fresh.expires_at },
    ]);
  });
});

describe('cashback vindo da nuvem', () => {
  const earn = entry({ id: 'e1', customer_id: 'c1', amount: 10, remaining_amount: 10, valid_from: '2026-11-01T03:00:00.000Z', expires_at: '2026-12-01T03:00:00.000Z' });
  const customer = { id: 'c1', tenant_id: 't', name: null, phone_whatsapp: '5555999990000', cpf: null, whatsapp_opt_in: false, opt_in_at: null, cashback_balance: 10, total_spent: 0, visits_count: 0, last_visit_at: null, created_at: '2026-11-01T00:00:00.000Z' };

  it('a nuvem substitui o extrato e o estorno local (espelho) sai', () => {
    const mirror = entry({ id: 'm', customer_id: 'c1', order_id: 'o', entry_type: 'REFUND', amount: 3, remaining_amount: 3 });
    const cloudRefund = { ...mirror, id: 'r-cloud' };
    const out = mergeCashback(
      { loyaltyCustomers: [customer], cashbackLedger: [{ ...earn, remaining_amount: 0 }, mirror] },
      { loyaltyCustomers: [{ ...customer, cashback_balance: 13 }], cashbackLedger: [earn, cloudRefund] },
      [],
    );
    expect(out.cashbackLedger.map((e) => [e.id, e.remaining_amount])).toEqual([['e1', 10], ['r-cloud', 3]]);
    expect(out.loyaltyCustomers[0]!.cashback_balance).toBe(13);
  });

  it('cliente com resgate ou conta com cashback ainda não aceitos fica como está aqui', () => {
    const redeem = entry({ id: 'r', customer_id: 'c1', order_id: 'o', entry_type: 'REDEEM', amount: 10 });
    const local = { loyaltyCustomers: [{ ...customer, cashback_balance: 0 }], cashbackLedger: [{ ...earn, remaining_amount: 0 }, redeem] };
    const cloud = { loyaltyCustomers: [customer], cashbackLedger: [earn] };
    for (const pending of [
      [{ table: 'cashback_ledger' as const, row_id: 'r', payload: { customer_id: 'c1' } }],
      [{ table: 'orders' as const, row_id: 'o', payload: {} }],
    ]) {
      const out = mergeCashback(local, cloud, pending);
      expect(out.cashbackLedger.map((e) => [e.id, e.remaining_amount])).toEqual([['e1', 0], ['r', 0]]);
      expect(out.loyaltyCustomers[0]!.cashback_balance).toBe(0);
    }
  });

  // P2-01 da rodada 7 do GPT: o que só existe aqui e não está na fila nem recusado sai.
  it('crédito ou resgate que só existe aqui, sem nada na fila, sai do extrato', () => {
    const none = { loyaltyCustomers: [{ ...customer, cashback_balance: 0 }], cashbackLedger: [] as CashbackLedgerEntry[] };
    const orphanEarn = mergeCashback({ loyaltyCustomers: [customer], cashbackLedger: [earn] }, none, []);
    expect(orphanEarn.cashbackLedger).toEqual([]);
    expect(orphanEarn.loyaltyCustomers[0]!.cashback_balance).toBe(0);
    const redeem = entry({ id: 'r', customer_id: 'c1', order_id: 'o', entry_type: 'REDEEM', amount: 10 });
    const orphanRedeem = mergeCashback({ loyaltyCustomers: [customer], cashbackLedger: [{ ...earn, remaining_amount: 0 }, redeem] }, { ...none, cashbackLedger: [earn] }, []);
    expect(orphanRedeem.cashbackLedger.map((e) => [e.id, e.remaining_amount])).toEqual([['e1', 10]]);
    // Crédito ainda na fila continua aqui.
    const pending = mergeCashback({ loyaltyCustomers: [customer], cashbackLedger: [earn] }, none, [{ table: 'cashback_ledger', row_id: 'e1', payload: { customer_id: 'c1' } }]);
    expect(pending.cashbackLedger.map((e) => e.id)).toEqual(['e1']);
    expect(pending.loyaltyCustomers[0]!.cashback_balance).toBe(10);
  });
});
