import { describe, expect, it } from 'vitest';
import { cashbackOrphanCents, cashbackRefundCents, planCashbackRefund } from '../lib/loyalty';
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

  // P0-03 da rodada 8 do GPT: parte sem origem comprovada não herda a validade de outro
  // crédito nem ganha prazo novo; fica retida para conciliação (hold, sem validade).
  it('resgate antigo sem origem: não herda a validade de outro crédito consumido nem ganha 30 dias novos', () => {
    // A vence 20/11, B vence 31/12 (já usado em outra conta). O resgate antigo veio de A, mas
    // a baixa chegou sem o vínculo: a parte sem origem não pode voltar com o vencimento de B.
    const a = entry({ id: 'A', amount: 20, remaining_amount: 0, valid_from: '2026-10-21T03:00:00.000Z', expires_at: '2026-11-20T03:00:00.000Z' });
    const b = entry({ id: 'B', amount: 20, remaining_amount: 0, valid_from: '2026-12-01T03:00:00.000Z', expires_at: '2026-12-31T03:00:00.000Z' });
    const legacy = { ...redeem, amount: 20, redeem_sources: [{ source_id: null, amount: 20 }], created_at: '2026-11-05T12:00:00.000Z' };
    const parts = planCashbackRefund([a, b, legacy], legacy, 20);
    expect(parts).toEqual([{ refund_of_id: null, amount: 20, valid_from: null, expires_at: null, hold: true, reported_source_ids: [] }]);
    // Resgate de antes deste PR (sem redeem_sources): o mesmo.
    const older = { ...legacy, redeem_sources: null };
    expect(planCashbackRefund([a, b, older], older, 5)).toEqual([{ refund_of_id: null, amount: 5, valid_from: null, expires_at: null, hold: true, reported_source_ids: [] }]);
  });

  it('resgate misto: a parte com origem volta com a validade dela; só a sem origem fica retida', () => {
    const mixed = { ...redeem, amount: 40, redeem_sources: [{ source_id: null, amount: 15 }, { source_id: 'e2', amount: 25 }] };
    expect(planCashbackRefund([old, fresh, mixed], mixed, 30)).toEqual([
      { refund_of_id: 'e2', amount: 25, valid_from: fresh.valid_from, expires_at: fresh.expires_at },
      { refund_of_id: null, amount: 5, valid_from: null, expires_at: null, hold: true, reported_source_ids: [] },
    ]);
    // O que já foi retido não é retido de novo (reenvio): conta como devolvido daquela parte.
    const held = entry({ id: 'h', order_id: 'o', entry_type: 'HOLD', amount: 5, refund_of_id: null });
    const back = entry({ id: 'b', order_id: 'o', entry_type: 'REFUND', amount: 25, refund_of_id: 'e2' });
    expect(planCashbackRefund([old, fresh, mixed, held, back], mixed, 10)).toEqual([
      { refund_of_id: null, amount: 10, valid_from: null, expires_at: null, hold: true, reported_source_ids: [] },
    ]);
  });

  // P2-01 da rodada 9 do GPT: o HOLD não aponta para o UUID informado (no banco, a FK
  // recusaria um UUID que não existe); o UUID fica só no registro (reported_source_ids).
  it('crédito de origem que não está no extrato: retido sem vínculo, sem validade inventada', () => {
    const orphan = { ...redeem, amount: 10, redeem_sources: [{ source_id: 'sumiu', amount: 10 }] };
    expect(planCashbackRefund([orphan], orphan, 10)).toEqual([
      { refund_of_id: null, amount: 10, valid_from: null, expires_at: null, hold: true, reported_source_ids: ['sumiu'] },
    ]);
  });

  it('crédito de origem de outra loja: retido sem vínculo cruzado; só o desta loja volta', () => {
    const foreign = entry({ id: 'F', tenant_id: 'outra', amount: 5, valid_from: '2026-11-02T03:00:00.000Z', expires_at: '2027-01-31T03:00:00.000Z' });
    const r = { ...redeem, amount: 20, redeem_sources: [{ source_id: null, amount: 5 }, { source_id: 'sumiu', amount: 5 }, { source_id: 'F', amount: 5 }, { source_id: 'e2', amount: 5 }] };
    const parts = planCashbackRefund([fresh, foreign, r], r, 20);
    expect(parts).toEqual([
      { refund_of_id: 'e2', amount: 5, valid_from: fresh.valid_from, expires_at: fresh.expires_at },
      { refund_of_id: null, amount: 15, valid_from: null, expires_at: null, hold: true, reported_source_ids: ['sumiu', 'F'] },
    ]);
    // Reenvio do mesmo cancelamento: com o REFUND e o HOLD já no extrato, nada mais sai.
    const back = entry({ id: 'b', order_id: 'o', entry_type: 'REFUND', amount: 5, refund_of_id: 'e2' });
    const held = entry({ id: 'h', order_id: 'o', entry_type: 'HOLD', amount: 15, refund_of_id: null });
    expect(planCashbackRefund([fresh, foreign, r, back, held], r, 20)).toEqual([]);
  });
});

// P0-02 da rodada 8 do GPT: o desconto manual não é tratado como cashback no estorno.
describe('estorno com desconto manual anterior ao resgate', () => {
  const c = (v: number) => Math.round(v * 100);
  it('bruto 100, manual 10, resgate 45, cancelamento deixa o bruto em 20: devolve 35', () => {
    expect(cashbackRefundCents(c(45), c(55), c(20))).toBe(c(35));
  });
  it('sem desconto manual, igual à regra anterior', () => {
    expect(cashbackRefundCents(c(45), c(45), c(20))).toBe(c(25));
    expect(cashbackRefundCents(c(45), c(45), c(45))).toBe(0);
  });
  it('reenvio (desconto igual) não devolve de novo; queda em duas etapas soma o mesmo que numa só', () => {
    expect(cashbackRefundCents(c(10), c(20), c(20))).toBe(0);
    const first = cashbackRefundCents(c(45), c(55), c(40)); // 15
    const second = cashbackRefundCents(c(45) - first, c(40), c(20)); // 20
    expect([first, second, first + second]).toEqual([c(15), c(20), c(35)]);
  });
  it('bruto abaixo do desconto manual: o manual cai ao bruto e todo o cashback volta', () => {
    expect(cashbackRefundCents(c(45), c(55), c(5))).toBe(c(45));
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

  // P0-01 da rodada 10 do GPT: baixa da versão anterior que subiu sem o resgate.
  it('crédito baixado sem resgate: mesma conta do servidor (EARN e REFUND baixados menos REDEEM)', () => {
    const earn = entry({ id: 'E', amount: 10, remaining_amount: 7 });
    const refund = entry({ id: 'R', entry_type: 'REFUND', amount: 2, remaining_amount: 2 });
    expect(cashbackOrphanCents([earn, refund], 'c')).toBe(300);
    const redeem = entry({ id: 'D', entry_type: 'REDEEM', amount: 3, order_id: 'o' });
    expect(cashbackOrphanCents([earn, refund, redeem], 'c')).toBe(0);
    expect(cashbackOrphanCents([earn, refund], 'outro')).toBe(0);
  });

  it('baixa conciliada pelo gerente (SETTLE) explica o débito, como tchefood_cashback_orphan', () => {
    const earn = entry({ id: 'E', amount: 10, remaining_amount: 5, valid_from: '2026-11-01T03:00:00.000Z', expires_at: '2026-12-01T03:00:00.000Z' });
    expect(cashbackOrphanCents([earn], 'c')).toBe(500);
    const settle = entry({ id: 'S', entry_type: 'SETTLE', amount: 5 });
    expect(cashbackOrphanCents([earn, settle], 'c')).toBe(0);
    // Liberada ao cliente: o crédito novo (REFUND sem conta) intacto não cria baixa.
    const released = entry({ id: 'L', entry_type: 'REFUND', amount: 5, remaining_amount: 5, valid_from: '2026-11-12T23:00:00.000Z', expires_at: '2026-12-12T23:00:00.000Z' });
    expect(cashbackOrphanCents([earn, settle, released], 'c')).toBe(0);
  });
});
