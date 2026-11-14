// @vitest-environment jsdom
/**
 * r10: pagamento da fila da versão anterior (dinheiro ou Stone sem reserva) reenviado depois da migração e
 * recusado com TF010. A recuperação pede a reserva com a chave e os termos do próprio pagamento e reenvia o
 * mesmo evento; recusa definitiva leva ao gerente (retirada com PIN), nunca some sozinho. E a retirada acha as
 * consequências da fila antiga mesmo um milissegundo depois.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { LEGACY_CONSEQUENCE_WINDOW_MS, useTcheStore } from '../store/useTcheStore';
import { CLAIM_REQUIRED_ERROR } from '../lib/payments/paymentClaim';
import { beginLocalClaim, localClaim, resetClaimLedger } from '../lib/payments/claimLedger';
import { clearReviewHold, getReviewHoldByKey } from '../lib/payments/reviewHolds';
import { isRecoverableRejectedPayment, recoverRejectedPayment, resendRejected, withdrawRejectedPayment, RECOVERY_MANAGER_PATH, type RecoveryDeps } from '../lib/payments/claimRecovery';
import type { SyncEvent } from '../types';

const st = () => useTcheStore.getState();
const order = (id: string) => st().orders.find((o) => o.id === id)!;
const CFG = { url: 'https://x.supabase.co', anonKey: 'anon', accessToken: 'jwt' };
const TF010 = `${CLAIM_REQUIRED_ERROR} — TCHEFOOD_PAGAMENTO: claim_required`;

function openTable(n = 1): string {
  expect(st().login('1111').ok).toBe(true);
  const r = st().openTable(st().tables.find((t) => t.number === n)!.id, 2, null);
  if (!r.ok) throw new Error(r.error);
  for (const code of ['101', '311']) {
    const p = st().products.find((x) => x.code === code)!;
    const t = st().addToTray({
      order_id: r.data.id, product_id: p.id, half_product_ids: [], quantity: 1, unit_price: p.price, modifiers: [], modifiers_unit_price: 0,
      meat_doneness: p.requires_meat_doneness ? 'Ao Ponto' : null, quick_tags: [], free_notes: '', sector: p.sector,
    });
    if (!t.ok) throw new Error(t.error);
  }
  st().dispatchTray(r.data.id);
  expect(st().startCheckout(r.data.id).ok).toBe(true);
  return r.data.id;
}

/** Pagamento da versão anterior (sem reserva) recusado com TF010 ao subir. */
function legacyRejected(orderId: string, amount: number, key: string, over: { method?: 'CASH' | 'CREDIT'; acquirer?: 'CASH_DESK' | 'STONE' } = {}) {
  const method = over.method ?? 'CASH';
  const acquirer = over.acquirer ?? 'CASH_DESK';
  const r = st().registerPayment({
    orderId, amount, method, status: 'APPROVED', terminal_id: null, acquirer, acquirer_cnpj: null, card_brand: null,
    nsu: acquirer === 'STONE' ? '123456' : null, authorization_code: acquirer === 'STONE' ? 'AB12' : null, terminal_serial: null, idempotency_key: key, item_ids: [],
  });
  if (!r.ok) throw new Error(r.error);
  const ev = st().outbox.find((e) => e.table === 'payments' && e.row_id === r.data.payment.id)!;
  st().rejectSyncEvents([{ eventId: ev.id, status: 400, message: TF010 }]);
  return { ev, payment: r.data.payment };
}

type Call = { url: string; body: Record<string, unknown>; ledgerToken: string | null | undefined };
function deps(reply: (body: Record<string, unknown>) => { status: number; body: unknown } | 'offline', balanceCents = 5000): { d: RecoveryDeps; calls: Call[] } {
  const calls: Call[] = [];
  const d: RecoveryDeps = {
    config: async () => CFG,
    staff: async () => 'staff-1',
    timer: () => new Promise<void>(() => undefined),
    prepareOrder: async () => { throw new Error('a recuperação não sobe a fila da conta'); },
    balance: async () => ({ balanceCents, status: 'PAYING' }),
    fetch: async (url, init) => {
      const body = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
      calls.push({ url, body, ledgerToken: localClaim(String(body.p_key))?.release_token });
      const r = reply(body);
      if (r === 'offline') throw new Error('rede');
      return { ok: r.status < 300, status: r.status, text: async () => JSON.stringify(r.body) };
    },
  };
  return { d, calls };
}
const opened = (b: Record<string, unknown>) => ({ status: 200, body: { id: 'c-1', idempotency_key: b.p_key, status: 'open', amount_cents: b.p_amount_cents } });

beforeEach(() => {
  st().resetDemo();
  for (const o of st().orders) clearReviewHold(o.id);
  resetClaimLedger();
});

describe('recuperação do pagamento recusado sem reserva', () => {
  it('pede a reserva com a chave e os termos do pagamento, segredo gravado antes; o mesmo evento volta para a fila', async () => {
    const id = openTable();
    const { ev, payment } = legacyRejected(id, 20, 'k-velha', { method: 'CREDIT', acquirer: 'STONE' });
    expect(isRecoverableRejectedPayment(st().syncRejected[0]!)).toBe(true);
    const { d, calls } = deps(opened, 7300);
    expect(await recoverRejectedPayment(ev.id, d)).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://x.supabase.co/rest/v1/rpc/tchefood_claim_payment');
    expect(calls[0]!.body).toMatchObject({
      p_key: 'k-velha', p_order: id, p_method: 'CREDIT', p_acquirer: 'STONE', p_amount_cents: 2000, p_expected_balance_cents: 7300, p_staff: 'staff-1',
    });
    expect(calls[0]!.body.p_release_token).toMatch(/^[0-9a-f]{64}$/);
    // Gravado antes da chamada, com o mesmo segredo.
    expect(calls[0]!.ledgerToken).toBe(calls[0]!.body.p_release_token);
    expect(localClaim('k-velha')).toMatchObject({ state: 'settled', release_token: calls[0]!.body.p_release_token, terms: { recovery: true, amount_cents: 2000 } });
    expect(st().syncRejected).toEqual([]);
    expect(st().outbox[0]!.id).toBe(ev.id);
    expect(st().payments.find((p) => p.id === payment.id)!.status).toBe('APPROVED');
  });

  it('TF003 (outro aparelho já recebeu esse valor): fica nos recusados com o caminho do gerente; nada sai da conta', async () => {
    const id = openTable();
    const { ev, payment } = legacyRejected(id, 20, 'k-dup');
    const paidBefore = order(id).paid_amount;
    const out = await recoverRejectedPayment(ev.id, deps(() => ({ status: 400, body: { code: 'TF003', message: 'sem saldo' } })).d);
    expect(out).toMatchObject({ ok: false, transient: false, code: 'TF003' });
    if (out.ok) throw new Error('ok');
    expect(out.error).toMatch(/saldo livre/);
    expect(out.error).toContain(RECOVERY_MANAGER_PATH);
    expect(out.error).not.toMatch(/Nada foi recebido/);
    expect(st().syncRejected.map((r) => r.event.id)).toEqual([ev.id]);
    expect(localClaim('k-dup')).toBeNull();
    expect(st().payments.find((p) => p.id === payment.id)!.status).toBe('APPROVED');
    expect(order(id).paid_amount).toBe(paidBefore);
  });

  it('sem resposta: o registro (com o segredo) fica; a nova tentativa usa o mesmo segredo', async () => {
    const id = openTable();
    const { ev } = legacyRejected(id, 20, 'k-net');
    const first = deps(() => 'offline');
    expect(await recoverRejectedPayment(ev.id, first.d)).toMatchObject({ ok: false, transient: true });
    const token = first.calls[0]!.body.p_release_token;
    expect(localClaim('k-net')?.release_token).toBe(token);
    expect(isRecoverableRejectedPayment(st().syncRejected[0]!)).toBe(true);
    const second = deps(opened);
    expect(await recoverRejectedPayment(ev.id, second.d)).toEqual({ ok: true });
    expect(second.calls[0]!.body.p_release_token).toBe(token);
  });

  it('não é recuperável: reserva do fluxo normal aqui, Point, recusa da maquininha ou outro motivo', () => {
    const id = openTable();
    const { ev } = legacyRejected(id, 10, 'k-own');
    beginLocalClaim('k-own', id, 'ab'.repeat(32), { method: 'CASH', acquirer: 'CASH_DESK', amount_cents: 1000 });
    const r = st().syncRejected[0]!;
    expect(isRecoverableRejectedPayment(r)).toBe(false);
    resetClaimLedger();
    expect(isRecoverableRejectedPayment(r)).toBe(true);
    expect(isRecoverableRejectedPayment({ ...r, message: 'HTTP 400' })).toBe(false);
    expect(isRecoverableRejectedPayment({ ...r, event: { ...ev, payload: { ...ev.payload, acquirer: 'MERCADO_PAGO' } } })).toBe(false);
    expect(isRecoverableRejectedPayment({ ...r, event: { ...ev, payload: { ...ev.payload, status: 'DECLINED' } } })).toBe(false);
  });

  it('"Reenviar recusados": o recuperado volta; o que não deu fica; os demais recusados voltam para a fila', async () => {
    const id = openTable();
    const a = legacyRejected(id, 10, 'k-a');
    const b = legacyRejected(id, 10, 'k-b');
    const other: SyncEvent = { id: 'e-other', table: 'products', op: 'UPDATE', row_id: 'p1', payload: { id: 'p1' }, created_at: '2026-11-14T10:00:00Z' };
    useTcheStore.setState((s) => ({ syncRejected: [...s.syncRejected, { event: other, status: 403, message: 'permissão', rejected_at: '' }] }));
    const { d } = deps((body) => (body.p_key === 'k-a' ? opened(body) : { status: 400, body: { code: 'TF003', message: 'x' } }));
    const results = await resendRejected(d);
    expect(results.get(a.ev.id)).toEqual({ ok: true });
    expect(results.get(b.ev.id)).toMatchObject({ ok: false, transient: false });
    expect(st().syncRejected.map((r) => r.event.id)).toEqual([b.ev.id]);
    expect(st().outbox.map((e) => e.id)).toEqual(expect.arrayContaining([a.ev.id, other.id]));
  });
});

describe('caminho do gerente: retirar o pagamento não aceito pela nuvem', () => {
  it('PIN errado não muda nada; com PIN, o pagamento sai, os recusados limpam e a trava diz para devolver', () => {
    const id = openTable();
    const total = order(id).remaining_balance;
    const { ev, payment } = legacyRejected(id, total, 'k-w');
    expect(order(id).status).toBe('CLOSED');
    const bad = withdrawRejectedPayment(ev.id, { managerPin: '0000', reason: 'Conferido com o cliente' });
    expect(bad.ok).toBe(false);
    expect(st().payments.find((p) => p.id === payment.id)!.status).toBe('APPROVED');
    expect(st().syncRejected).toHaveLength(1);
    const ok = withdrawRejectedPayment(ev.id, { managerPin: '9999', reason: 'Conferido com o cliente' });
    expect(ok.ok).toBe(true);
    expect(st().payments.find((p) => p.id === payment.id)).toMatchObject({ status: 'REFUNDED', withdrawn_reason: 'não aceito pela nuvem: Conferido com o cliente' });
    expect(st().syncRejected).toEqual([]);
    expect(order(id)).toMatchObject({ status: 'PAYING', remaining_balance: total });
    expect(getReviewHoldByKey('k-w')).toMatchObject({ code: 'PAYMENT_REJECTED', refund: 'CASH', amount: total, reason: expect.stringMatching(/Devolva o dinheiro/) });
    expect(st().outbox.some((e) => e.table === 'orders' && e.payload.status === 'CLOSED')).toBe(false);
  });
});

describe('retirada: consequências da fila antiga (sem caused_by_payment_id) um milissegundo depois', () => {
  const legacyQueue = (shiftMs: number) => {
    const payId = st().payments.at(-1)!.id;
    useTcheStore.setState((s) => {
      const ins = s.outbox.find((e) => e.table === 'payments' && e.row_id === payId)!;
      const t0 = Date.parse(ins.created_at);
      return {
        outbox: s.outbox.map((e) => {
          if (e.caused_by_payment_id !== payId) return e;
          const { caused_by_payment_id: _drop, ...rest } = e;
          return { ...rest, created_at: new Date(t0 + shiftMs).toISOString() };
        }),
      };
    });
  };

  it.each([1, LEGACY_CONSEQUENCE_WINDOW_MS - 1])('fechamento %i ms depois do pagamento sai junto', (shift) => {
    const id = openTable();
    expect(st().registerPayment({
      orderId: id, amount: order(id).remaining_balance, method: 'CASH', status: 'APPROVED', terminal_id: null, acquirer: 'CASH_DESK', acquirer_cnpj: null,
      card_brand: null, nsu: null, authorization_code: null, terminal_serial: null, idempotency_key: 'k-l', item_ids: [],
    }).ok).toBe(true);
    legacyQueue(shift);
    expect(st().outbox.some((e) => e.table === 'orders' && e.payload.status === 'CLOSED' && !e.caused_by_payment_id)).toBe(true);
    expect(st().withdrawUnacceptedPayment('k-l', 'x').ok).toBe(true);
    expect(st().outbox.some((e) => e.table === 'orders' && e.payload.status === 'CLOSED')).toBe(false);
    expect(st().outbox.some((e) => e.table === 'dining_tables' && e.payload.status === 'FREE' && e.depends_on_order_id === id)).toBe(false);
  });

  it('fora da janela, ou depois do próximo pagamento da conta: não é deste pagamento', () => {
    const id = openTable();
    const half = Math.round(order(id).remaining_balance * 50) / 100;
    const pay = (key: string, amount: number) => st().registerPayment({
      orderId: id, amount, method: 'CASH', status: 'APPROVED', terminal_id: null, acquirer: 'CASH_DESK', acquirer_cnpj: null,
      card_brand: null, nsu: null, authorization_code: null, terminal_serial: null, idempotency_key: key, item_ids: [],
    });
    expect(pay('k-1', half).ok).toBe(true);
    const ins1 = st().outbox.find((e) => e.table === 'payments' && e.payload.idempotency_key === 'k-1')!;
    const t0 = Date.parse(ins1.created_at);
    const at = (ms: number) => new Date(t0 + ms).toISOString();
    // Mudança da conta bem depois (outra ação) e o segundo pagamento com o fechamento dele, todos sem a marca.
    const later: SyncEvent = { id: 'e-later', table: 'orders', op: 'UPDATE', row_id: id, payload: { id, note: 'depois' }, created_at: at(LEGACY_CONSEQUENCE_WINDOW_MS + 5_000) };
    expect(pay('k-2', order(id).remaining_balance).ok).toBe(true);
    useTcheStore.setState((s) => ({
      outbox: [...s.outbox.map((e) => {
        if (!e.caused_by_payment_id) {
          if (e.table === 'payments' && e.payload.idempotency_key === 'k-2') return { ...e, created_at: at(2) };
          return e;
        }
        const { caused_by_payment_id: by, ...rest } = e;
        const second = by !== ins1.row_id;
        return { ...rest, created_at: at(second ? 3 : 1) };
      }), later],
    }));
    const secondClose = st().outbox.find((e) => e.table === 'orders' && e.payload.status === 'CLOSED')!;
    expect(st().withdrawUnacceptedPayment('k-1', 'x').ok).toBe(true);
    const ids = new Set(st().outbox.map((e) => e.id));
    expect(ids.has('e-later')).toBe(true);
    expect(ids.has(secondClose.id)).toBe(true);
  });
});
