import { describe, expect, it } from 'vitest';
import { clearReviewHold, getReviewHold, setReviewHold } from '../lib/payments/reviewHolds';

describe('trava de cobrança incerta', () => {
  it('fica gravada por comanda até conferência explícita', () => {
    expect(getReviewHold('o1')).toBeNull();
    setReviewHold({ order_id: 'o1', amount: 50, reason: 'x', code: 'WRAPPER_EXCEPTION' });
    expect(getReviewHold('o1')).toMatchObject({ amount: 50, code: 'WRAPPER_EXCEPTION' });
    expect(getReviewHold('o2')).toBeNull();
    clearReviewHold('o1');
    expect(getReviewHold('o1')).toBeNull();
  });
});
