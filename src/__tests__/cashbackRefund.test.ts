import { describe, expect, it } from 'vitest';
import { planCashbackRefund } from '../lib/loyalty';
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
