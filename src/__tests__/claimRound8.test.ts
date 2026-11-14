// @vitest-environment jsdom
/**
 * Segunda revisão independente (r8): pagamento que não entrou no servidor sai da conta (P1-B), troca da reserva
 * para a adquirente que a maquininha usou (P1-C), várias travas por conta (P1/P2-D), TF012 (P2-E) e reserva de
 * resultado desconhecido que "não existe" (P2-F).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedId } from '../data/seed';
import { CLAIM_MISSING_REGISTER_ERROR, CLAIM_TERMS_REGISTER_ERROR, useTcheStore } from '../store/useTcheStore';
import { cashSummary } from '../lib/cashRegister';
import { clearReviewHold, getReviewHold, getReviewHoldByKey, getReviewHolds, setReviewHold } from '../lib/payments/reviewHolds';
import { beginLocalClaim, localClaim, pendingRelease, resetClaimLedger, settleLocalClaim } from '../lib/payments/claimLedger';
import { authorizeClaimRefunded, NOT_FOUND_SPAN_MS, reclaimPayment, releaseClaimAfterNoCharge, retryPendingClaimReleases, type ClaimDeps } from '../lib/payments/paymentClaim';
import { RESERVED_EXCEEDS_BALANCE, rememberServerReservation, reservationExceeds, resetServerReservations, RESERVATION_READ_MAX_AGE_MS } from '../lib/payments/pointReservation';
import { flushOutbox, sanitizePayload } from '../lib/sync/supabaseSync';
import { confirmClaimRefunded, REFUND_NEEDS_MANAGER_RELEASE } from '../lib/payments/claimFlow';
import type { SyncEvent } from '../types';

const st = () => useTcheStore.getState();
const product = (code: string) => st().products.find((p) => p.code === code)!;
const table = (n: number) => st().tables.find((t) => t.number === n)!;
const order = (id: string) => st().orders.find((o) => o.id === id)!;
const cfg = { url: 'https://x.supabase.co/', anonKey: 'anon', accessToken: 'jwt' };
const OLD_TOKEN = 'ab'.repeat(32);
const NEW_TOKEN = 'cd'.repeat(32);

function openTableWith(codes: string[]) {
  expect(st().login('1111').ok).toBe(true);
  const r = st().openTable(table(1).id, 2, null);
  if (!r.ok) throw new Error(r.error);
  for (const code of codes) {
    const p = product(code);
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

const cash = (orderId: string, amount: number, key: string) => st().registerPayment({
  orderId, amount, method: 'CASH', status: 'APPROVED', terminal_id: null, acquirer: 'CASH_DESK', acquirer_cnpj: null, card_brand: null,
  nsu: null, authorization_code: null, terminal_serial: null, idempotency_key: key, item_ids: [],
});

type Call = { url: string; body: Record<string, unknown> };
function rpcDeps(status: number, body: string, over: Partial<ClaimDeps> = {}) {
  const calls: Call[] = [];
  const d: ClaimDeps = {
    config: async () => cfg,
    fetch: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body ?? '{}') as Record<string, unknown> });
      return { ok: status >= 200 && status < 300, status, text: async () => body };
    },
    prepareOrder: async () => ({ ok: true, balance_cents: 8000 }),
    staff: async () => 'staff-1',
    timer: () => new Promise<void>(() => undefined),
    sleep: async () => undefined,
    ...over,
  };
  return { d, calls };
}

beforeEach(() => {
  st().resetDemo();
  for (const o of st().orders) clearReviewHold(o.id);
  resetClaimLedger();
  resetServerReservations();
});

describe('P1-B: pagamento aprovado aqui que o servidor não aceitou sai da conta', () => {
  it('dinheiro: vira não contado com o motivo, o evento sai da fila, a conta e a mesa reabrem e o caixa desconta', () => {
    const id = openTableWith(['101']);
    expect(st().login('5555').ok).toBe(true);
    expect(st().openCashSession(100).ok).toBe(true);
    const total = order(id).remaining_balance;
    const paid = cash(id, total, 'k-cash');
    expect(paid.ok && paid.data.closed).toBe(true);
    const session = st().cashSessions.find((s) => !s.closed_at)!;
    expect(cashSummary(session, st().payments, st().cashMovements).cashSales).toBe(total);
    const payId = st().payments.find((p) => p.idempotency_key === 'k-cash')!.id;
    expect(st().outbox.some((e) => e.table === 'payments' && e.row_id === payId)).toBe(true);

    const r = st().withdrawUnacceptedPayment('k-cash', 'reserva liberada antes de chegar ao servidor');
    expect(r.ok).toBe(true);
    const p = st().payments.find((x) => x.id === payId)!;
    expect(p).toMatchObject({ status: 'REFUNDED', withdrawn_reason: 'reserva liberada antes de chegar ao servidor' });
    expect(st().outbox.some((e) => e.table === 'payments' && e.row_id === payId)).toBe(false);
    // A NFC-e já emitida não some (a trava pede o cancelamento da nota).
    expect(order(id)).toMatchObject({ status: 'PAYING', remaining_balance: total, closed_at: null });
    expect(order(id).nfce_key).toHaveLength(44);
    expect(table(1)).toMatchObject({ status: 'PAYING', current_order_id: id });
    expect(cashSummary(session, st().payments, st().cashMovements).cashSales).toBe(0);
    expect(st().outbox.at(-2)).toMatchObject({ table: 'orders', op: 'UPDATE', row_id: id });
    // Já entrou no servidor (fora da fila e dos recusados): não retira.
    expect(st().withdrawUnacceptedPayment('k-cash', 'x').ok).toBe(false);
  });

  it('recusado pelo servidor (syncRejected): também sai, e sai dos recusados', () => {
    const id = openTableWith(['101']);
    const half = Math.round(order(id).remaining_balance * 50) / 100;
    expect(cash(id, half, 'k-rej').ok).toBe(true);
    const ev = st().outbox.find((e) => e.table === 'payments')!;
    useTcheStore.setState((s) => ({ outbox: s.outbox.filter((e) => e.id !== ev.id), syncRejected: [{ event: ev, status: 400, message: 'recusado', rejected_at: ev.created_at }] }));
    expect(st().withdrawUnacceptedPayment('k-rej', 'pagamento recusado pelo servidor').ok).toBe(true);
    expect(st().syncRejected).toEqual([]);
    expect(order(id).paid_amount).toBe(0);
  });

  it('"Estornei / devolvi" no store: não sobe pela fila; com nuvem exige o id do servidor; só tira a trava da própria chave', () => {
    const id = openTableWith(['101']);
    setReviewHold({ order_id: id, amount: 5, reason: 'x', code: 'CLAIM_RELEASED', refund: 'CASH', idempotency_key: 'k-a' });
    setReviewHold({ order_id: id, amount: 7, reason: 'y', code: 'MANUAL_REVIEW', idempotency_key: 'k-b' });
    const before = st().outbox.length;
    useTcheStore.setState({ cloud: { url: 'https://x.supabase.co' } as never });
    expect(st().resolveRefundedClaimHold(id, { managerPin: '9999', reason: 'Dinheiro devolvido ao cliente' }, 'k-a').ok).toBe(false);
    expect(getReviewHoldByKey('k-a')).not.toBeNull();
    const r = st().resolveRefundedClaimHold(id, { managerPin: '9999', reason: 'Dinheiro devolvido ao cliente' }, 'k-a', { auditId: 'srv-audit-1' });
    expect(r.ok).toBe(true);
    expect(r.ok && r.data.metadata).toMatchObject({ server_audit_id: 'srv-audit-1', refund: 'CASH' });
    expect(st().outbox.length).toBe(before);
    expect(getReviewHoldByKey('k-a')).toBeNull();
    expect(getReviewHolds(id).map((h) => h.code)).toEqual(['MANUAL_REVIEW']);
    // A revisão manual não sai por esse botão.
    expect(st().resolveRefundedClaimHold(id, { managerPin: '9999', reason: 'Dinheiro devolvido ao cliente' }, 'k-b', { auditId: 'srv' }).ok).toBe(false);
  });

  it('authorizeClaimRefunded: manda chave, PIN, motivo e metadata; id = ok; NULL = PIN; TF007/TF005; sem rede', async () => {
    const AUDIT = '11111111-2222-4333-8444-555555555555';
    const meta = { refund_kind: 'cash' as const, payment_local_id: 'pay-1' };
    const ok = rpcDeps(200, JSON.stringify(AUDIT));
    expect(await authorizeClaimRefunded('k-1', '9999', 'Dinheiro devolvido ao cliente', meta, ok.d)).toEqual({ ok: true, auditId: AUDIT });
    expect(ok.calls[0]!.url).toBe('https://x.supabase.co/rest/v1/rpc/tchefood_authorize_claim_refunded');
    expect(ok.calls[0]!.body).toEqual({ p_key: 'k-1', p_staff: 'staff-1', p_manager_pin: '9999', p_reason: 'Dinheiro devolvido ao cliente', p_metadata: meta });
    expect(await authorizeClaimRefunded('k-1', '9999', 'Dinheiro devolvido ao cliente', meta, rpcDeps(200, 'null').d)).toMatchObject({ ok: false, pin: true });
    expect(await authorizeClaimRefunded('k-1', '9999', 'Dinheiro devolvido ao cliente', meta, rpcDeps(400, '{"code":"TF007","message":"aberta"}').d)).toMatchObject({ ok: false, notReleased: true });
    expect(await authorizeClaimRefunded('k-1', '9999', 'Dinheiro devolvido ao cliente', meta, rpcDeps(400, '{"code":"TF005","message":"x"}').d)).toMatchObject({ ok: false, notFound: true });
    expect(await authorizeClaimRefunded('k-1', '9999', 'Dinheiro devolvido ao cliente', meta, rpcDeps(503, '').d)).toMatchObject({ ok: false, offline: true });
    expect(await authorizeClaimRefunded('k-1', '9999', 'Dinheiro devolvido ao cliente', meta, rpcDeps(200, '"não-é-uuid"').d)).toMatchObject({ ok: false });
    const short = rpcDeps(200, JSON.stringify(AUDIT));
    expect((await authorizeClaimRefunded('k-1', '9999', 'curto', meta, short.d)).ok).toBe(false);
    expect(short.calls).toHaveLength(0);
    // payment_local_id acima de 100 caracteres não vai.
    const long = rpcDeps(200, JSON.stringify(AUDIT));
    await authorizeClaimRefunded('k-1', '9999', 'Dinheiro devolvido ao cliente', { refund_kind: 'card', payment_local_id: 'x'.repeat(101) }, long.d);
    expect(long.calls[0]!.body.p_metadata).toEqual({ refund_kind: 'card' });
  });

  it('confirmClaimRefunded: sem resposta a trava fica; PAYMENT_REJECTED aberta libera com o segredo e confirma; sem segredo aponta o gerente', async () => {
    const AUDIT = '11111111-2222-4333-8444-555555555555';
    const id = openTableWith(['101']);
    useTcheStore.setState({ cloud: { url: 'https://x.supabase.co' } as never });
    const auth = { managerPin: '9999', reason: 'Dinheiro devolvido ao cliente' };
    setReviewHold({ order_id: id, amount: 5, reason: 'x', code: 'CLAIM_RELEASED', refund: 'CASH', idempotency_key: 'k-off' });
    expect((await confirmClaimRefunded(getReviewHoldByKey('k-off')!, auth, rpcDeps(503, '').d)).ok).toBe(false);
    expect(getReviewHoldByKey('k-off')).not.toBeNull();
    expect((await confirmClaimRefunded(getReviewHoldByKey('k-off')!, auth, rpcDeps(200, 'null').d)).ok).toBe(false);
    expect(getReviewHoldByKey('k-off')).not.toBeNull();
    beginLocalClaim('k-off', id, OLD_TOKEN);
    settleLocalClaim('k-off');
    expect((await confirmClaimRefunded(getReviewHoldByKey('k-off')!, auth, rpcDeps(200, JSON.stringify(AUDIT)).d)).ok).toBe(true);
    expect(getReviewHoldByKey('k-off')).toBeNull();
    expect(localClaim('k-off')).toBeNull();
    expect(st().auditLogs[0]!.metadata).toMatchObject({ server_audit_id: AUDIT });

    // PAYMENT_REJECTED com a reserva ainda aberta: TF007 → libera com o segredo → confirma.
    setReviewHold({ order_id: id, amount: 5, reason: 'recusado', code: 'PAYMENT_REJECTED', refund: 'TERMINAL', idempotency_key: 'k-rej2' });
    beginLocalClaim('k-rej2', id, NEW_TOKEN);
    settleLocalClaim('k-rej2');
    const seq: Array<[number, string]> = [[400, '{"code":"TF007","message":"aberta"}'], [200, '{}'], [200, JSON.stringify(AUDIT)]];
    const calls: string[] = [];
    const d = rpcDeps(200, '', {
      fetch: async (url, init) => {
        calls.push(`${url.split('/rpc/')[1]}:${String((JSON.parse(init.body ?? '{}') as { p_release_token?: string }).p_release_token === NEW_TOKEN)}`);
        const [status, body] = seq.shift()!;
        return { ok: status < 300, status, text: async () => body };
      },
    }).d;
    expect((await confirmClaimRefunded(getReviewHoldByKey('k-rej2')!, auth, d)).ok).toBe(true);
    expect(calls).toEqual(['tchefood_authorize_claim_refunded:false', 'tchefood_release_payment_claim:true', 'tchefood_authorize_claim_refunded:false']);
    expect(getReviewHoldByKey('k-rej2')).toBeNull();

    // Sem o segredo neste aparelho: não confirma, a trava fica e o caminho é o gerente na lista de reservas.
    setReviewHold({ order_id: id, amount: 5, reason: 'recusado', code: 'PAYMENT_REJECTED', refund: 'TERMINAL', idempotency_key: 'k-rej3' });
    const r = await confirmClaimRefunded(getReviewHoldByKey('k-rej3')!, auth, rpcDeps(400, '{"code":"TF007","message":"aberta"}').d);
    expect(r).toEqual({ ok: false, error: REFUND_NEEDS_MANAGER_RELEASE });
    expect(getReviewHoldByKey('k-rej3')).not.toBeNull();
  });
});

describe('P1-C: comprovante de outra adquirente troca a reserva antes de registrar', () => {
  it('reclaimPayment manda as duas chaves, os dois segredos e confere a resposta', async () => {
    const amountCents = 1250;
    const reply = (n: Record<string, unknown>, o: Record<string, unknown> = { id: 'c1', idempotency_key: 'k-old', status: 'released', release_audit_id: 'a1' }) => JSON.stringify({ old: o, new: n });
    const ok = reply({ id: 'c2', idempotency_key: 'k-new', status: 'open', amount_cents: amountCents });
    const { d, calls } = rpcDeps(200, ok);
    const input = { oldKey: 'k-old', oldToken: OLD_TOKEN, newKey: 'k-new', newToken: NEW_TOKEN, method: 'CREDIT' as const, acquirer: 'PAGBANK' as const, amount: 12.5 };
    expect(await reclaimPayment(input, d)).toEqual({ ok: true, claim: { id: 'c2', idempotency_key: 'k-new', status: 'open', amount_cents: amountCents } });
    expect(calls[0]!.url).toBe('https://x.supabase.co/rest/v1/rpc/tchefood_reclaim_payment');
    expect(calls[0]!.body).toEqual({
      p_old_key: 'k-old', p_old_token: OLD_TOKEN, p_new_key: 'k-new', p_new_token: NEW_TOKEN, p_method: 'CREDIT', p_acquirer: 'PAGBANK', p_amount_cents: amountCents, p_staff: 'staff-1',
    });
    // Fecha em qualquer outra resposta: chave, status ou valor diferentes, sem "new", resposta plana, "old" de outra chave.
    for (const bad of [
      reply({ id: 'c2', idempotency_key: 'k-old', status: 'open', amount_cents: amountCents }),
      reply({ id: 'c2', idempotency_key: 'k-new', status: 'released', amount_cents: amountCents }),
      reply({ id: 'c2', idempotency_key: 'k-new', status: 'open', amount_cents: amountCents + 1 }),
      reply({ id: 'c2', idempotency_key: 'k-new', status: 'open', amount_cents: amountCents }, { id: 'c1', idempotency_key: 'k-x', status: 'released' }),
      JSON.stringify({ id: 'c2', idempotency_key: 'k-new', status: 'open', amount_cents: amountCents }),
      'null',
    ]) expect((await reclaimPayment(input, rpcDeps(200, bad).d)).ok).toBe(false);
    // Sem rede: offline (nova tentativa com a mesma chave e o mesmo segredo).
    expect(await reclaimPayment(input, rpcDeps(503, '').d)).toMatchObject({ ok: false, offline: true });
    // Recusa: código do servidor.
    expect(await reclaimPayment(input, rpcDeps(400, '{"code":"TF004","message":"x"}').d)).toMatchObject({ ok: false, code: 'TF004' });
  });

  it('confirmReviewedCharge com ACQUIRER_MISMATCH: registra com a chave nova; sem chave nova e com nuvem, recusa', () => {
    const id = openTableWith(['101']);
    const amount = order(id).remaining_balance;
    setReviewHold({ order_id: id, amount, reason: 'outra adquirente', code: 'ACQUIRER_MISMATCH', method: 'CREDIT', acquirer: 'PAGBANK', terminal_id: null, terminal_serial: 'S1', idempotency_key: 'k-old' });
    const input = { orderId: id, nsu: '445566', authorization_code: 'AB12CD', card_brand: null, method: 'CREDIT' as const, acquirer: 'PAGBANK' as const, holdKey: 'k-old' };
    const auth = { managerPin: '9999', reason: 'Maquininha aprovou, conferido' };
    useTcheStore.setState({ cloud: { url: 'https://x.supabase.co', anonKey: 'a' } as never });
    expect(st().confirmReviewedCharge(input, auth).ok).toBe(false);
    expect(getReviewHoldByKey('k-old')).not.toBeNull();
    beginLocalClaim('k-new', id, NEW_TOKEN, { method: 'CREDIT', acquirer: 'PAGBANK', amount_cents: Math.round(amount * 100) });
    const r = st().confirmReviewedCharge({ ...input, registerKey: 'k-new' }, auth);
    expect(r.ok).toBe(true);
    expect(st().payments.find((p) => p.order_id === id && p.status === 'APPROVED')).toMatchObject({ idempotency_key: 'k-new', acquirer: 'PAGBANK' });
    expect(getReviewHoldByKey('k-old')).toBeNull();
  });
});

describe('P1-C: reclaimForHold (registro local da chave nova)', () => {
  it('grava chave e segredo novos antes; sem rede guarda para a próxima (mesma chave e segredo); recusa mantém a trava', async () => {
    vi.resetModules();
    const reclaim = vi.fn();
    const touch = vi.fn(async () => ({ ok: false, code: 'TF005', error: 'não existe' }));
    vi.doMock('../lib/payments/paymentClaim', async (orig) => ({
      ...(await orig<typeof import('../lib/payments/paymentClaim')>()),
      reclaimPayment: (...a: unknown[]) => reclaim(...a),
      touchPaymentClaim: (...a: unknown[]) => (touch as (...x: unknown[]) => unknown)(...a),
    }));
    const { reclaimForHold, finishReclaim } = await import('../lib/payments/claimFlow');
    const ledger = await import('../lib/payments/claimLedger');
    const holds = await import('../lib/payments/reviewHolds');
    ledger.resetClaimLedger();
    ledger.beginLocalClaim('k-old', 'o9', OLD_TOKEN);
    ledger.settleLocalClaim('k-old');
    const hold = holds.setReviewHold({ order_id: 'o9', amount: 10, reason: 'r', code: 'ACQUIRER_MISMATCH', idempotency_key: 'k-old' });

    let seen: unknown = null;
    reclaim.mockImplementation(async (input: { newKey: string }) => { seen = ledger.localClaim(input.newKey); return { ok: false, offline: true, error: 'rede' }; });
    expect((await reclaimForHold(hold, 'CREDIT', 'PAGBANK')).ok).toBe(false);
    expect(reclaim).toHaveBeenCalledTimes(2);
    const first = reclaim.mock.calls[0]![0] as { newKey: string; newToken: string; oldToken: string };
    expect(first.oldToken).toBe(OLD_TOKEN);
    expect(first.newToken).toMatch(/^[0-9a-f]{64}$/);
    expect(seen).toMatchObject({ key: first.newKey, release_token: first.newToken });
    expect(holds.getReviewHoldByKey('k-old')?.reclaim_key).toBe(first.newKey);

    // P1-1: TF009 com a reserva nova existindo no servidor (lida com o segredo dela): guarda chave e segredo.
    reclaim.mockReset().mockResolvedValueOnce({ ok: false, code: 'TF009', error: 'chave em uso' });
    touch.mockResolvedValueOnce({ ok: true, status: 'open', activeUntil: null } as never);
    expect((await reclaimForHold(holds.getReviewHoldByKey('k-old')!, 'CREDIT', 'PAGBANK')).ok).toBe(false);
    expect(touch).toHaveBeenLastCalledWith(first.newKey, first.newToken);
    expect(ledger.localClaim(first.newKey)).toMatchObject({ release_token: first.newToken });
    expect(holds.getReviewHoldByKey('k-old')?.reclaim_key).toBe(first.newKey);

    // Recusa e o servidor diz que a chave nova não existe (TF005): só então sai.
    reclaim.mockReset().mockResolvedValueOnce({ ok: false, code: 'TF009', error: 'recusado' });
    expect((await reclaimForHold(holds.getReviewHoldByKey('k-old')!, 'CREDIT', 'PAGBANK')).ok).toBe(false);
    const again = reclaim.mock.calls[0]![0] as { newKey: string; newToken: string };
    expect([again.newKey, again.newToken]).toEqual([first.newKey, first.newToken]);
    expect(ledger.localClaim(first.newKey)).toBeNull();
    expect(holds.getReviewHoldByKey('k-old')).toMatchObject({ code: 'ACQUIRER_MISMATCH' });
    expect(holds.getReviewHoldByKey('k-old')?.reclaim_key).toBeUndefined();

    reclaim.mockReset().mockResolvedValueOnce({ ok: true, claim: { id: 'c', idempotency_key: 'x', status: 'open', amount_cents: 1000 } });
    const ok = await reclaimForHold(holds.getReviewHoldByKey('k-old')!, 'CREDIT', 'PAGBANK');
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    finishReclaim('k-old', ok.key);
    expect(ledger.localClaim('k-old')).toBeNull();
    expect(ledger.localClaim(ok.key)).toMatchObject({ state: 'settled' });
    holds.clearReviewHold('o9');
    vi.doUnmock('../lib/payments/paymentClaim');
    vi.resetModules();
  });
});

describe('P1/P2-D: várias travas por conta', () => {
  it('uma por chave; tirar uma não tira a outra; a principal é a mais antiga', () => {
    setReviewHold({ order_id: 'oD', amount: 1, reason: 'a', code: 'TIMEOUT', idempotency_key: 'k1' });
    setReviewHold({ order_id: 'oD', amount: 2, reason: 'b', code: 'CLAIM_RELEASED', idempotency_key: 'k2' });
    expect(getReviewHolds('oD').map((h) => h.idempotency_key)).toEqual(['k1', 'k2']);
    expect(getReviewHold('oD')?.idempotency_key).toBe('k1');
    clearReviewHold('oD', 'k1');
    expect(getReviewHolds('oD').map((h) => h.idempotency_key)).toEqual(['k2']);
    clearReviewHold('oD');
    expect(getReviewHolds('oD')).toEqual([]);
  });

  it('migra a trava única gravada na versão anterior (v1)', async () => {
    localStorage.setItem('tchefood.paymentReviewHolds.v1', JSON.stringify([{ order_id: 'oV1', amount: 3, reason: 'v1', code: 'WRAPPER_EXCEPTION', created_at: '2026-11-01T10:00:00Z' }]));
    vi.resetModules();
    const fresh = await import('../lib/payments/reviewHolds');
    expect(fresh.getReviewHold('oV1')).toMatchObject({ code: 'WRAPPER_EXCEPTION', amount: 3 });
    expect(localStorage.getItem('tchefood.paymentReviewHolds.v1')).toBeNull();
    expect(JSON.parse(localStorage.getItem('tchefood.paymentReviewHolds.v2')!)).toEqual(expect.arrayContaining([expect.objectContaining({ order_id: 'oV1' })]));
    fresh.clearReviewHold('oV1');
    vi.resetModules();
  });
});

describe('P2-E: TF012 (reservado maior que o saldo)', () => {
  it('a recusa do servidor ao sincronizar mostra a mensagem clara', async () => {
    const ev: SyncEvent = { id: 'e1', table: 'orders', op: 'UPDATE', row_id: 'o1', payload: { id: 'o1', discount_amount: 50 }, created_at: '' };
    const res = await flushOutbox([ev], cfg, async () => ({ ok: false, status: 400, text: async () => '{"code":"TF012","message":"reserved_exceeds_balance"}' }));
    expect(res.rejected[0]!.message).toBe('Há cobrança reservada nesta comanda: conclua ou libere antes de reduzir o total. — reserved_exceeds_balance');
  });

  it('conferência local: última leitura recente; reservas já pagas aqui não contam', () => {
    rememberServerReservation('o1', 9000, [{ idempotencyKey: 'k-a', amountCents: 6000 }, { idempotencyKey: 'k-b', amountCents: 3000 }], 1_000);
    expect(reservationExceeds('o1', 80, new Set(), 1_000)).toBe(RESERVED_EXCEEDS_BALANCE);
    expect(reservationExceeds('o1', 90, new Set(), 1_000)).toBeNull();
    expect(reservationExceeds('o1', 80, new Set(['k-b']), 1_000)).toBeNull();
    expect(reservationExceeds('o1', 10, new Set(), 1_000 + RESERVATION_READ_MAX_AGE_MS + 1)).toBeNull();
    expect(reservationExceeds('o2', 0, new Set(), 1_000)).toBeNull();
  });

  it('desconto, cancelamento de item e taxa de serviço abaixo do reservado são recusados antes de aplicar', () => {
    const id = openTableWith(['101', '311']);
    const before = order(id);
    const auth = { managerPin: '9999', reason: 'Cortesia da casa ao cliente' };
    rememberServerReservation(id, Math.round(before.remaining_balance * 100) - 100, []);
    const big = st().applyDiscount(id, 5, auth);
    expect(big).toEqual({ ok: false, error: RESERVED_EXCEEDS_BALANCE });
    expect(order(id).discount_amount).toBe(before.discount_amount);
    expect(st().applyDiscount(id, 0.5, auth).ok).toBe(true);
    const item = st().orderItems.find((i) => i.order_id === id && i.status !== 'CANCELED')!;
    expect(st().cancelOrderItem(item.id, auth)).toEqual({ ok: false, error: RESERVED_EXCEEDS_BALANCE });
    if (before.charge_service_fee) expect(st().removeServiceFee(id, auth)).toEqual({ ok: false, error: RESERVED_EXCEEDS_BALANCE });
    // Sem leitura do servidor: aplica (o servidor ainda confere com TF012).
    resetServerReservations();
    expect(st().applyDiscount(id, 5, auth).ok).toBe(true);
  });
});

describe('P2-E: cashback abaixo do reservado', () => {
  afterEach(() => vi.useRealTimers());
  it('resgate de cashback que deixaria o saldo abaixo do reservado é recusado antes de aplicar', () => {
    const opt = st().modifierOptions.find((o) => o.id === seedId('mo:tamanho-chopp:500'))!;
    const mod = { group_id: opt.group_id, option_id: opt.id, name: opt.name, additional_price: opt.additional_price };
    const openChopp = (n: number, qty: number) => {
      expect(st().login('1111').ok).toBe(true);
      const opened = st().openTable(table(n).id, 2, null);
      if (!opened.ok) throw new Error(opened.error);
      const p = product('201');
      const tray = st().addToTray({ order_id: opened.data.id, product_id: p.id, half_product_ids: [], quantity: qty, unit_price: p.price, modifiers: [mod], modifiers_unit_price: 0, meat_doneness: null, quick_tags: [], free_notes: '', sector: p.sector });
      if (!tray.ok) throw new Error(tray.error);
      st().dispatchTray(opened.data.id);
      return opened.data.id;
    };
    vi.useFakeTimers({ now: new Date('2026-11-09T21:00:00-03:00'), toFake: ['Date'] });
    const first = openChopp(4, 4);
    expect(cash(first, order(first).remaining_balance, 'k-first').ok).toBe(true);
    expect(st().earnCashback(first, { phone: '55999991234', name: 'Ana', cpf: null, optIn: true }).ok).toBe(true);
    vi.setSystemTime(new Date('2026-11-10T20:00:00-03:00'));
    const id = openChopp(6, 1);
    rememberServerReservation(id, Math.round(order(id).remaining_balance * 100), []);
    expect(st().redeemCashback(id, '55999991234')).toEqual({ ok: false, error: RESERVED_EXCEEDS_BALANCE });
    expect(order(id).discount_amount).toBe(0);
    resetServerReservations();
    expect(st().redeemCashback(id, '55999991234').ok).toBe(true);
  });
});

describe('P2-F: reserva de resultado desconhecido que "não existe" (TF005)', () => {
  it('não encerra na hora: fica pendente e só sai depois de 3 respostas em 2 min ou mais', async () => {
    const tf005 = rpcDeps(400, '{"code":"TF005","message":"x"}');
    beginLocalClaim('k-u', 'o1', OLD_TOKEN);
    const r = await releaseClaimAfterNoCharge('k-u', 'o1', 'Reserva sem resposta do servidor', OLD_TOKEN, tf005.d, { unknownClaim: true, nowMs: 0 });
    expect(r).toEqual({ ok: true, notFound: true });
    expect(pendingRelease('k-u')).toMatchObject({ unknown_claim: true, not_found_count: 1, not_found_first_at: 0, release_token: OLD_TOKEN });
    await retryPendingClaimReleases(tf005.d, 30_000, true);
    expect(pendingRelease('k-u')).toMatchObject({ not_found_count: 2 });
    await retryPendingClaimReleases(tf005.d, 60_000, true);
    expect(pendingRelease('k-u')).toMatchObject({ not_found_count: 3 }); // 3 respostas, mas em menos de 2 min
    expect(await retryPendingClaimReleases(tf005.d, NOT_FOUND_SPAN_MS, true)).toBe(1);
    expect(pendingRelease('k-u')).toBeNull();
  });

  it('o servidor confirma a liberação: encerra na hora; sem rede: continua pendente', async () => {
    beginLocalClaim('k-u2', 'o1', OLD_TOKEN);
    await releaseClaimAfterNoCharge('k-u2', 'o1', 'Reserva sem resposta do servidor', OLD_TOKEN, rpcDeps(400, '{"code":"TF005","message":"x"}').d, { unknownClaim: true, nowMs: 0 });
    await retryPendingClaimReleases(rpcDeps(503, '').d, 30_000, true);
    expect(pendingRelease('k-u2')).toMatchObject({ unknown_claim: true, not_found_count: 1 });
    await retryPendingClaimReleases(rpcDeps(200, '{}').d, 60_000, true);
    expect(pendingRelease('k-u2')).toBeNull();
  });

  it('liberação comum (sem resultado desconhecido): TF005 encerra na hora, como antes', async () => {
    beginLocalClaim('k-c', 'o1', OLD_TOKEN);
    settleLocalClaim('k-c');
    await releaseClaimAfterNoCharge('k-c', 'o1', 'Pagamento não recebido', OLD_TOKEN, rpcDeps(400, '{"code":"TF005","message":"x"}').d);
    expect(pendingRelease('k-c')).toBeNull();
    expect(localClaim('k-c')).toBeNull();
  });
});

describe('P2-4: migração da trava v1 só apaga a antiga depois de gravar a nova', () => {
  it('gravação da v2 falhou: a v1 fica', async () => {
    localStorage.clear();
    localStorage.setItem('tchefood.paymentReviewHolds.v1', JSON.stringify([{ order_id: 'oF', amount: 3, reason: 'v1', code: 'WRAPPER_EXCEPTION', created_at: '2026-11-01T10:00:00Z' }]));
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('cheio'); });
    vi.resetModules();
    const fresh = await import('../lib/payments/reviewHolds');
    expect(fresh.getReviewHold('oF')).toMatchObject({ code: 'WRAPPER_EXCEPTION' });
    spy.mockRestore();
    expect(localStorage.getItem('tchefood.paymentReviewHolds.v1')).not.toBeNull();
    localStorage.clear();
    vi.resetModules();
  });
});

describe('P2-2: estorno de reserva que o servidor não tem (TF005)', () => {
  it('tira a trava com o PIN e o motivo daqui (audit local marcado); PIN errado mantém', async () => {
    const id = openTableWith(['101']);
    useTcheStore.setState({ cloud: { url: 'https://x.supabase.co' } as never });
    setReviewHold({ order_id: id, amount: 5, reason: 'x', code: 'CLAIM_RELEASED', refund: 'TERMINAL', idempotency_key: 'k-miss' });
    const tf005 = rpcDeps(400, '{"code":"TF005","message":"x"}').d;
    expect((await confirmClaimRefunded(getReviewHoldByKey('k-miss')!, { managerPin: '1234', reason: 'Venda estornada na maquininha' }, tf005)).ok).toBe(false);
    expect(getReviewHoldByKey('k-miss')).not.toBeNull();
    const r = await confirmClaimRefunded(getReviewHoldByKey('k-miss')!, { managerPin: '9999', reason: 'Venda estornada na maquininha' }, tf005);
    expect(r.ok).toBe(true);
    expect(r.ok && r.data.metadata).toMatchObject({ server_claim_missing: true, server_audit_id: null });
    expect(getReviewHoldByKey('k-miss')).toBeNull();
  });
});

describe('P1-2: o fechamento causado pelo pagamento retirado sai junto', () => {
  const okFetch = async (_url: string, init: { method: string }) => ({ ok: true, status: 200, text: async () => (init.method === 'PATCH' ? '[{"id":"x"}]' : '') });

  it('repro: pagamento e fechamento recusados seguram a fila; depois da retirada nada fica preso nem volta no reenviar', async () => {
    const id = openTableWith(['101']);
    const total = order(id).remaining_balance;
    expect(cash(id, total, 'k-close').ok).toBe(true);
    expect(order(id).status).toBe('CLOSED');
    const nfce = order(id).nfce_key;
    expect(nfce).toHaveLength(44);
    const payId = st().payments.find((p) => p.idempotency_key === 'k-close')!.id;
    const ins = st().outbox.find((e) => e.table === 'payments' && e.row_id === payId)!;
    const close = st().outbox.find((e) => e.table === 'orders' && e.row_id === id && e.payload.status === 'CLOSED')!;
    expect(close.caused_by_payment_id).toBe(payId);
    st().rejectSyncEvents([{ eventId: ins.id, status: 400, message: 'recusado' }, { eventId: close.id, status: 400, message: 'conta sem pagamento' }]);
    // Antes: a comanda fica segurada pelos recusados.
    const heldBefore = await flushOutbox(st().outbox, cfg, okFetch, 50, st().syncRejected.map((r) => r.event));
    expect(heldBefore.sent.some((sid) => st().outbox.find((e) => e.id === sid)?.row_id === id)).toBe(false);

    const w = st().withdrawUnacceptedPayment('k-close', 'pagamento recusado pelo servidor');
    expect(w.ok && w.data.nfceIssued).toBe(true);
    expect(st().syncRejected).toEqual([]);
    const q = st().outbox;
    expect(q.some((e) => e.table === 'payments' && e.row_id === payId)).toBe(false);
    expect(q.some((e) => e.table === 'orders' && e.row_id === id && e.payload.status === 'CLOSED')).toBe(false);
    expect(q.some((e) => e.table === 'dining_tables' && e.payload.status === 'FREE' && e.depends_on_order_id === id)).toBe(false);
    expect(q.some((e) => e.table === 'order_items' && e.payload.order_id === id && e.payload.is_paid === true)).toBe(false);
    expect(q.at(-1)).toMatchObject({ table: 'dining_tables', payload: expect.objectContaining({ status: 'PAYING', current_order_id: id }) });
    expect(order(id)).toMatchObject({ status: 'PAYING', nfce_key: nfce });
    expect(st().orderItems.filter((i) => i.order_id === id).every((i) => !i.is_paid)).toBe(true);
    // Agora a fila sobe sem nada segurado.
    const res = await flushOutbox(q, cfg, okFetch, 200, st().syncRejected.map((r) => r.event));
    expect(res.rejected).toEqual([]);
    expect(res.sent).toHaveLength(q.length);
  });

  it('fechamento já aceito pelo servidor (fora da fila): sobe a reabertura da comanda e da mesa', () => {
    const id = openTableWith(['101']);
    expect(cash(id, order(id).remaining_balance, 'k-sent').ok).toBe(true);
    const payId = st().payments.find((p) => p.idempotency_key === 'k-sent')!.id;
    const ins = st().outbox.find((e) => e.table === 'payments' && e.row_id === payId)!;
    // O pagamento ficou recusado e as outras mudanças já subiram.
    useTcheStore.setState({ outbox: [], syncRejected: [{ event: ins, status: 400, message: 'recusado', rejected_at: ins.created_at }] });
    expect(st().withdrawUnacceptedPayment('k-sent', 'x').ok).toBe(true);
    const q = st().outbox;
    expect(q.find((e) => e.table === 'orders')).toMatchObject({ row_id: id, payload: expect.objectContaining({ status: 'PAYING', closed_at: null }) });
    expect(q.filter((e) => e.table === 'order_items').every((e) => e.payload.is_paid === false)).toBe(true);
    expect(q.find((e) => e.table === 'dining_tables')).toMatchObject({ payload: expect.objectContaining({ status: 'PAYING', current_order_id: id }) });
  });

  it('divisão por item: os itens do pagamento retirado voltam a "não pago"; os de outro pagamento ficam', () => {
    const id = openTableWith(['101', '311']);
    const items = st().orderItems.filter((i) => i.order_id === id);
    const [a, b] = [items[0]!, items[1]!];
    const card = (key: string, item: typeof a) => st().registerPayment({
      orderId: id, amount: item.unit_price, method: 'CASH', status: 'APPROVED', terminal_id: null, acquirer: 'CASH_DESK', acquirer_cnpj: null,
      card_brand: null, nsu: null, authorization_code: null, terminal_serial: null, idempotency_key: key, item_ids: [item.id],
    });
    expect(card('k-a', a).ok).toBe(true);
    expect(card('k-b', b).ok).toBe(true);
    expect(st().withdrawUnacceptedPayment('k-b', 'x').ok).toBe(true);
    expect(st().orderItems.find((i) => i.id === a.id)!.is_paid).toBe(true);
    expect(st().orderItems.find((i) => i.id === b.id)!.is_paid).toBe(false);
    expect(st().outbox.some((e) => e.table === 'order_items' && e.row_id === b.id && e.payload.is_paid === true)).toBe(false);
    // O que só o aparelho sabe não sobe.
    const pa = st().outbox.find((e) => e.table === 'payments')!;
    expect(sanitizePayload(pa)).not.toHaveProperty('paid_item_ids');
  });
});

describe('TF010: todo pagamento aprovado (fora a Point) precisa da reserva feita aqui', () => {
  const pay = (orderId: string, over: Partial<Parameters<typeof cash>[0] extends never ? never : Record<string, unknown>> = {}) => st().registerPayment({
    orderId, amount: 10, method: 'CASH', status: 'APPROVED', terminal_id: null, acquirer: 'CASH_DESK', acquirer_cnpj: null, card_brand: null,
    nsu: null, authorization_code: null, terminal_serial: null, idempotency_key: 'k-tf010', item_ids: [], ...over,
  } as Parameters<ReturnType<typeof st>['registerPayment']>[0]);

  it('com nuvem: sem reserva recusa; termos diferentes recusam; com a reserva certa registra', () => {
    const id = openTableWith(['101']);
    useTcheStore.setState({ cloud: { url: 'https://x.supabase.co' } as never });
    expect(pay(id)).toEqual({ ok: false, error: CLAIM_MISSING_REGISTER_ERROR });
    beginLocalClaim('k-tf010', id, OLD_TOKEN, { method: 'CASH', acquirer: 'CASH_DESK', amount_cents: 900 });
    expect(pay(id)).toEqual({ ok: false, error: CLAIM_TERMS_REGISTER_ERROR });
    beginLocalClaim('k-tf010', id, OLD_TOKEN, { method: 'CREDIT', acquirer: 'CASH_DESK', amount_cents: 1000 });
    expect(pay(id)).toEqual({ ok: false, error: CLAIM_TERMS_REGISTER_ERROR });
    beginLocalClaim('k-tf010', id, OLD_TOKEN, { method: 'CASH', acquirer: 'CASH_DESK', amount_cents: 1000 });
    expect(pay(id).ok).toBe(true);
  });

  it('exceções: Point (o servidor reserva), dinheiro do entregador (entrega-<id>), recusado, e sem nuvem', () => {
    const id = openTableWith(['101']);
    useTcheStore.setState({ cloud: { url: 'https://x.supabase.co' } as never });
    expect(pay(id, { method: 'CREDIT', acquirer: 'MERCADO_PAGO', idempotency_key: 'k-mp', nsu: '1', authorization_code: 'A', card_brand: 'VISA' }).ok).toBe(true);
    expect(pay(id, { idempotency_key: 'entrega-d1' }).ok).toBe(true);
    expect(pay(id, { status: 'DECLINED', idempotency_key: 'k-dec' }).ok).toBe(true);
    useTcheStore.setState({ cloud: null } as never);
    expect(pay(id, { idempotency_key: 'k-local' }).ok).toBe(true);
  });

  it('Point aprovada nunca vira estorno local (withdraw recusa)', () => {
    const id = openTableWith(['101']);
    expect(pay(id, { method: 'CREDIT', acquirer: 'MERCADO_PAGO', idempotency_key: 'k-mp2', nsu: '1', authorization_code: 'A', card_brand: 'VISA' }).ok).toBe(true);
    expect(st().withdrawUnacceptedPayment('k-mp2', 'x').ok).toBe(false);
    expect(st().payments.find((p) => p.idempotency_key === 'k-mp2')!.status).toBe('APPROVED');
  });

  it('startPaymentClaim grava os termos da reserva no registro local', async () => {
    vi.resetModules();
    vi.doMock('../lib/payments/paymentClaim', async (orig) => ({
      ...(await orig<typeof import('../lib/payments/paymentClaim')>()),
      claimPayment: async (i: { key: string }) => ({ ok: true, claim: { id: 'c', idempotency_key: i.key, status: 'open', amount_cents: 1250 } }),
    }));
    const { startPaymentClaim } = await import('../lib/payments/claimFlow');
    const ledger = await import('../lib/payments/claimLedger');
    ledger.resetClaimLedger();
    const c = await startPaymentClaim(true, { orderId: 'o1', key: 'k-terms', method: 'DEBIT', acquirer: 'PAGBANK', amount: 12.5 });
    expect(c.ok).toBe(true);
    if (c.ok) c.handle.leave();
    expect(ledger.localClaim('k-terms')?.terms).toEqual({ method: 'DEBIT', acquirer: 'PAGBANK', amount_cents: 1250 });
    vi.doUnmock('../lib/payments/paymentClaim');
    vi.resetModules();
  });
});
