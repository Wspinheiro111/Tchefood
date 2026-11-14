import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLAIM_ERRORS, CLAIM_OFFLINE_ERROR, CLAIM_REQUIRED_ERROR, claimPayment, releaseClaimAfterNoCharge, releasePaymentClaim, releasePaymentClaimManager,
  requirePaymentClaim, retryPendingClaimReleases, type ClaimDeps,
} from '../lib/payments/paymentClaim';
import { beginLocalClaim, isClaimActiveHere, localClaim, pendingRelease, pendingReleases, resetClaimLedger } from '../lib/payments/claimLedger';
import { flushOutbox } from '../lib/sync/supabaseSync';
import { reconcilePointCharge, type ReconcileDeps } from '../lib/payments/pointReconcile';
import { fetchPointReservation } from '../lib/sync/cloudPull';

const cfg = { url: 'https://x.supabase.co/', anonKey: 'anon', accessToken: 'jwt' };
const INPUT = { orderId: 'o1', key: 'k-1', method: 'CASH' as const, acquirer: 'CASH_DESK' as const, amount: 25.5 };
const OK_BODY = JSON.stringify({ id: 'c1', idempotency_key: 'k-1', status: 'open', amount_cents: 2550 });

type Call = { url: string; body: Record<string, unknown>; headers: Record<string, string> };

function deps(reply: () => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>, over: Partial<ClaimDeps> = {}) {
  const calls: Call[] = [];
  const d: ClaimDeps = {
    config: async () => cfg,
    fetch: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body ?? '{}') as Record<string, unknown>, headers: init.headers });
      return reply();
    },
    prepareOrder: async () => ({ ok: true, balance_cents: 8000 }),
    staff: async () => 'staff-1',
    // Prazo que nunca vence (os testes de prazo trocam por um que vence na hora).
    timer: () => new Promise<void>(() => undefined),
    ...over,
  };
  return { d, calls };
}
const reply = (status: number, body: string) => async () => ({ ok: status >= 200 && status < 300, status, text: async () => body });

beforeEach(() => resetClaimLedger());

describe('requirePaymentClaim', () => {
  it('só loja com maquininha Mercado Pago pede a reserva antes de receber', () => {
    expect(requirePaymentClaim({ terminals: [{ acquirer: 'STONE' }, { acquirer: 'PAGBANK' }] })).toBe(false);
    expect(requirePaymentClaim({ terminals: [] })).toBe(false);
    expect(requirePaymentClaim({ terminals: [{ acquirer: 'STONE' }, { acquirer: 'MERCADO_PAGO' }] })).toBe(true);
  });

  it('falha fechada: ligado à nuvem sem nunca ter lido as maquininhas de lá, pede a reserva', () => {
    const stone = [{ acquirer: 'STONE' as const }];
    expect(requirePaymentClaim({ terminals: stone, cloud: { url: 'x' }, pullStatus: { last_pull_at: null } })).toBe(true);
    expect(requirePaymentClaim({ terminals: stone, cloud: { url: 'x' }, pullStatus: null })).toBe(true);
    expect(requirePaymentClaim({ terminals: stone, cloud: { url: 'x' }, pullStatus: { last_pull_at: '2026-11-14T10:00:00Z' } })).toBe(false);
    expect(requirePaymentClaim({ terminals: stone, cloud: null, pullStatus: { last_pull_at: null } })).toBe(false);
  });
});

describe('claimPayment (tchefood_claim_payment)', () => {
  it('sincroniza a conta e reserva com a chave do pagamento e o saldo comprovado', async () => {
    const order: string[] = [];
    const { d, calls } = deps(reply(200, OK_BODY), {
      prepareOrder: async (id) => { order.push(`prepare:${id}`); return { ok: true, balance_cents: 8000 }; },
    });
    const wrapped: ClaimDeps = { ...d, fetch: async (url, init) => { order.push('rpc'); return d.fetch(url, init); } };
    const r = await claimPayment(INPUT, wrapped);
    expect(r).toEqual({ ok: true, claim: { id: 'c1', idempotency_key: 'k-1', status: 'open', amount_cents: 2550 } });
    expect(order).toEqual(['prepare:o1', 'rpc']);
    expect(calls[0]!.url).toBe('https://x.supabase.co/rest/v1/rpc/tchefood_claim_payment');
    expect(calls[0]!.headers).toMatchObject({ apikey: 'anon', Authorization: 'Bearer jwt' });
    expect(calls[0]!.body).toEqual({
      p_key: 'k-1', p_order: 'o1', p_method: 'CASH', p_acquirer: 'CASH_DESK', p_amount_cents: 2550, p_expected_balance_cents: 8000, p_staff: 'staff-1',
    });
  });

  it.each([
    ['TF001', /não encontrou esta conta/],
    ['TF002', /já está fechada/],
    ['TF003', /saldo livre/],
    ['TF004', /equipe ativa/],
    ['TF006', /dados do pagamento inválidos/],
    ['TF008', /saldo desta conta no servidor é diferente/],
    ['TF009', /já está em uso/],
    ['TF010', /^Esta loja tem a Point: o pagamento precisa da reserva no servidor\.$/],
  ])('recusa %s do banco vira mensagem clara e não libera', async (code, text) => {
    const { d } = deps(reply(400, JSON.stringify({ code, message: 'TCHEFOOD_CLAIM: x', details: null, hint: null })));
    const r = await claimPayment(INPUT, d);
    expect(r).toEqual({ ok: false, code, error: CLAIM_ERRORS[code] });
    expect(r.ok === false && r.error).toMatch(text);
  });

  it('recusa sem código conhecido mostra a mensagem do servidor', async () => {
    const { d } = deps(reply(403, JSON.stringify({ code: '42501', message: 'permission denied' })));
    expect(await claimPayment(INPUT, d)).toEqual({ ok: false, code: '42501', error: 'O servidor recusou a reserva: permission denied. Nada foi recebido.' });
  });

  it('sem sessão, sem rede ou erro do servidor: bloqueia com o aviso de sem internet (nunca libera)', async () => {
    const offline = { ok: false, offline: true, error: CLAIM_OFFLINE_ERROR };
    expect(await claimPayment(INPUT, deps(reply(200, OK_BODY), { config: async () => null }).d)).toEqual(offline);
    expect(await claimPayment(INPUT, deps(async () => { throw new TypeError('Failed to fetch'); }).d)).toEqual(offline);
    expect(await claimPayment(INPUT, deps(reply(503, 'upstream')).d)).toEqual(offline);
    expect(await claimPayment(INPUT, deps(reply(401, '{"message":"JWT expired"}')).d)).toEqual(offline);
    expect(CLAIM_OFFLINE_ERROR).toBe('Sem internet: com a Point na loja, só dá para receber com o servidor confirmando. Tente de novo quando voltar a conexão.');
  });

  it('prazo de 10 s: servidor ou sincronização pendurados viram sem internet', async () => {
    const timer = vi.fn(async () => undefined);
    const hung = deps(() => new Promise(() => undefined), { timer });
    expect(await claimPayment(INPUT, hung.d)).toMatchObject({ ok: false, offline: true });
    expect(timer).toHaveBeenCalledWith(10_000);
    const syncHung = deps(reply(200, OK_BODY), { timer: async () => undefined, prepareOrder: () => new Promise(() => undefined) });
    expect(await claimPayment(INPUT, syncHung.d)).toMatchObject({ ok: false, offline: true });
    expect(syncHung.calls).toHaveLength(0);
  });

  it('conta não sincronizada, sem operador ou resposta que não confere: não libera e não chama a RPC', async () => {
    const notSynced = deps(reply(200, OK_BODY), { prepareOrder: async () => ({ ok: false, reason: 'A nuvem recusou uma alteração desta conta.' }) });
    expect(await claimPayment(INPUT, notSynced.d)).toEqual({ ok: false, error: 'A nuvem recusou uma alteração desta conta.' });
    expect(notSynced.calls).toHaveLength(0);
    const noStaff = deps(reply(200, OK_BODY), { staff: async () => null });
    expect((await claimPayment(INPUT, noStaff.d)).ok).toBe(false);
    expect(noStaff.calls).toHaveLength(0);
    for (const body of [
      JSON.stringify({ id: 'c1', idempotency_key: 'outra', status: 'open', amount_cents: 2550 }),
      JSON.stringify({ id: 'c1', idempotency_key: 'k-1', status: 'released', amount_cents: 2550 }),
      JSON.stringify({ id: 'c1', idempotency_key: 'k-1', status: 'open', amount_cents: 100 }),
      'null',
    ]) {
      expect((await claimPayment(INPUT, deps(reply(200, body)).d)).ok).toBe(false);
    }
  });
});

describe('releasePaymentClaim (tchefood_release_payment_claim)', () => {
  it('libera com a chave, o operador e o motivo', async () => {
    const { d, calls } = deps(reply(200, '{"status":"released"}'));
    expect(await releasePaymentClaim('k-1', 'Maquininha recusou: saldo insuficiente', d)).toEqual({ ok: true });
    expect(calls[0]!.url).toBe('https://x.supabase.co/rest/v1/rpc/tchefood_release_payment_claim');
    expect(calls[0]!.body).toEqual({ p_key: 'k-1', p_staff: 'staff-1', p_reason: 'Maquininha recusou: saldo insuficiente' });
  });

  it('melhor esforço: falha de rede, prazo ou recusa devolvem erro sem lançar', async () => {
    expect((await releasePaymentClaim('k-1', 'x', deps(async () => { throw new Error('rede'); }).d)).ok).toBe(false);
    expect((await releasePaymentClaim('k-1', 'motivo', deps(() => new Promise(() => undefined), { timer: async () => undefined }).d)).ok).toBe(false);
    const refused = await releasePaymentClaim('k-1', 'motivo', deps(reply(400, '{"code":"TF004","message":"só quem criou libera"}')).d);
    expect(refused).toEqual({ ok: false, transient: false, error: 'O servidor não liberou a reserva: só quem criou libera' });
    // Não existe (TF005) ou já virou pagamento (TF007): nada a liberar.
    expect(await releasePaymentClaim('k-1', 'motivo', deps(reply(400, '{"code":"TF005","message":"x"}')).d)).toEqual({ ok: true });
    expect(await releasePaymentClaim('k-1', 'motivo', deps(reply(400, '{"code":"TF007","message":"x"}')).d)).toEqual({ ok: true });
    // Motivo curto demais para o banco (≥ 3) vai com o texto padrão.
    const short = deps(reply(200, '{}'));
    await releasePaymentClaim('k-1', 'x', short.d);
    expect(short.calls[0]!.body.p_reason).toBe('Pagamento não recebido');
  });
});

describe('reconcilePointCharge (ação reconcile da point-charge)', () => {
  const RC = { idempotency_key: 'pk-1', staff_id: 'staff-1', manager_pin: '9999', reason_text: 'Cliente diz que pagou na Point' };
  function rdeps(status: number, body: string) {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const d: ReconcileDeps = {
      config: async () => cfg,
      fetch: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> }); return { status, text: async () => body }; },
      timer: () => new Promise<void>(() => undefined),
    };
    return { d, calls };
  }

  it('manda a ação reconcile para a point-charge com o ID da operação quando digitado', async () => {
    const { d, calls } = rdeps(200, JSON.stringify({ status: 'DECLINED', reason: 'cancelada no MP' }));
    expect(await reconcilePointCharge({ ...RC, operation_id: ' 123456 ' }, d)).toEqual({ kind: 'reply', reply: { status: 'DECLINED', reason: 'cancelada no MP' } });
    expect(calls[0]!.url).toBe('https://x.supabase.co/functions/v1/point-charge');
    expect(calls[0]!.body).toEqual({ action: 'reconcile', ...RC, operation_id: '123456' });
    const noOp = rdeps(200, JSON.stringify({ status: 'MANUAL_REVIEW', code: 'NOT_FOUND_YET', reason: 'não achou' }));
    expect(await reconcilePointCharge(RC, noOp.d)).toEqual({ kind: 'reply', reply: { status: 'MANUAL_REVIEW', code: 'NOT_FOUND_YET', reason: 'não achou' } });
    expect('operation_id' in noOp.calls[0]!.body).toBe(false);
  });

  it('403 é PIN recusado; 409, 400, 5xx e PENDING não decidem nada', async () => {
    expect(await reconcilePointCharge(RC, rdeps(403, '{"error":"manager_denied","message":"PIN de gerente incorreto ou bloqueado."}').d)).toEqual({ kind: 'pin', error: 'PIN de gerente incorreto ou bloqueado.' });
    expect((await reconcilePointCharge(RC, rdeps(409, '{"error":"not_applicable"}').d)).kind).toBe('error');
    expect((await reconcilePointCharge(RC, rdeps(400, '{"error":"invalid_reason","message":"Motivo curto."}').d))).toEqual({ kind: 'error', error: 'Motivo curto.' });
    expect((await reconcilePointCharge(RC, rdeps(502, 'bad gateway').d)).kind).toBe('error');
    expect((await reconcilePointCharge(RC, rdeps(200, '{"status":"PENDING"}').d)).kind).toBe('error');
    // Motivo curto não sai do aparelho.
    const short = rdeps(200, '{}');
    expect((await reconcilePointCharge({ ...RC, reason_text: 'curto' }, short.d)).kind).toBe('error');
    expect(short.calls).toHaveLength(0);
  });

  it('APPROVED traz os dados do Mercado Pago validados', async () => {
    const body = { status: 'APPROVED', nsu: '998877', authorization_code: 'A1B2C3', card_brand: 'VISA', last_four: '1234', terminal_serial: 'MP-1', amount_cents: 3000, method: 'CREDIT' };
    expect(await reconcilePointCharge(RC, rdeps(200, JSON.stringify(body)).d)).toEqual({ kind: 'reply', reply: body });
    expect((await reconcilePointCharge(RC, rdeps(200, JSON.stringify({ ...body, nsu: 1 })).d)).kind).toBe('error');
  });
});

describe('fetchPointReservation (rodada 6)', () => {
  it('lê claims_cents, point_cents e as cobranças que reservam', async () => {
    const body = {
      reserved_cents: 5000, open_charges: 1, manual_review: true, claims_cents: 2000, point_cents: 3000,
      charges: [{ idempotency_key: 'pk-1', status: 'manual_review', amount_cents: 3000, raw_status_detail: 'DISPATCH_UNKNOWN', has_payment: false }],
    };
    const r = await fetchPointReservation(cfg, async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) }), 'o1');
    expect(r).toEqual({
      reservedCents: 5000, openCharges: 1, manualReview: true, claimsCents: 2000, pointCents: 3000,
      charges: [{ idempotencyKey: 'pk-1', status: 'manual_review', amountCents: 3000, rawStatusDetail: 'DISPATCH_UNKNOWN', hasPayment: false }],
    });
    await expect(fetchPointReservation(cfg, async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ...body, charges: [{ status: 'x' }] }) }), 'o1')).rejects.toThrow(/resposta incompleta/);
  });
});

describe('liberação depois de nada cobrado (releaseClaimAfterNoCharge)', () => {
  it('sem rede: tenta de novo com espera; ainda falhando, guarda a pendência e encerra o registro local', async () => {
    beginLocalClaim('k-1', 'o1');
    const sleeps: number[] = [];
    const { d, calls } = deps(async () => { throw new Error('rede'); }, { sleep: async (ms) => { sleeps.push(ms); } });
    const out = await releaseClaimAfterNoCharge('k-1', 'o1', 'Maquininha recusou: saldo', d);
    expect(out.ok).toBe(false);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([1_000, 3_000]);
    expect(pendingRelease('k-1')).toMatchObject({ key: 'k-1', order_id: 'o1', reason: 'Maquininha recusou: saldo' });
    expect(localClaim('k-1')).toBeNull();
    expect(isClaimActiveHere('k-1')).toBe(false);
  });

  it('a segunda tentativa libera: sem pendência; recusa do servidor não repete', async () => {
    let n = 0;
    const flaky = deps(async () => { n += 1; if (n === 1) throw new Error('rede'); return { ok: true, status: 200, text: async () => '{}' }; }, { sleep: async () => undefined });
    expect(await releaseClaimAfterNoCharge('k-2', 'o1', 'recusou', flaky.d)).toEqual({ ok: true });
    expect(pendingReleases()).toEqual([]);
    const refused = deps(reply(400, '{"code":"TF004","message":"x"}'), { sleep: async () => undefined });
    await releaseClaimAfterNoCharge('k-3', 'o1', 'recusou', refused.d);
    expect(refused.calls).toHaveLength(1);
    expect(pendingRelease('k-3')).not.toBeNull();
  });

  it('a sincronização tenta as pendências de novo (no máximo a cada 30 s) e tira as que liberou', async () => {
    const offline = deps(async () => { throw new Error('rede'); }, { sleep: async () => undefined });
    await releaseClaimAfterNoCharge('k-4', 'o1', 'recusou', offline.d);
    expect(pendingRelease('k-4')).not.toBeNull();
    const ok = deps(reply(200, '{}'));
    expect(await retryPendingClaimReleases(ok.d, 1_000_000, true)).toBe(1);
    expect(ok.calls[0]!.body).toEqual({ p_key: 'k-4', p_staff: 'staff-1', p_reason: 'recusou' });
    expect(pendingReleases()).toEqual([]);
    await releaseClaimAfterNoCharge('k-5', 'o1', 'recusou', offline.d);
    expect(await retryPendingClaimReleases(ok.d, 1_010_000)).toBe(0);
    expect(await retryPendingClaimReleases(ok.d, 1_031_000)).toBe(1);
  });
});

describe('releasePaymentClaimManager (tchefood_release_payment_claim_manager)', () => {
  it('libera com PIN de gerente e motivo; NULL é PIN recusado', async () => {
    const { d, calls } = deps(reply(200, JSON.stringify({ id: 'c1', idempotency_key: 'k-1', status: 'released', amount_cents: 100 })));
    expect(await releasePaymentClaimManager('k-1', '9999', 'Maquininha não mostra a venda', d)).toEqual({ ok: true });
    expect(calls[0]!.url).toBe('https://x.supabase.co/rest/v1/rpc/tchefood_release_payment_claim_manager');
    expect(calls[0]!.body).toEqual({ p_key: 'k-1', p_staff: 'staff-1', p_manager_pin: '9999', p_reason: 'Maquininha não mostra a venda' });
    expect(await releasePaymentClaimManager('k-1', '1234', 'Maquininha não mostra a venda', deps(reply(200, 'null')).d)).toEqual({
      ok: false, pin: true, error: 'PIN de gerente incorreto ou bloqueado. Nada foi liberado.',
    });
  });

  it('motivo curto não sai do aparelho; não existe conta como liberada; já paga e sem rede não liberam', async () => {
    const short = deps(reply(200, '{}'));
    expect((await releasePaymentClaimManager('k-1', '9999', 'curto', short.d)).ok).toBe(false);
    expect(short.calls).toHaveLength(0);
    expect(await releasePaymentClaimManager('k-1', '9999', 'Não houve cobrança', deps(reply(400, '{"code":"TF005","message":"x"}')).d)).toEqual({ ok: true });
    expect((await releasePaymentClaimManager('k-1', '9999', 'Não houve cobrança', deps(reply(400, '{"code":"TF007","message":"x"}')).d)).ok).toBe(false);
    expect(await releasePaymentClaimManager('k-1', '9999', 'Não houve cobrança', deps(async () => { throw new Error('rede'); }).d)).toEqual({ ok: false, error: CLAIM_OFFLINE_ERROR });
  });
});

describe('TF010 na fila de sincronização', () => {
  it('pagamento recusado por falta de reserva aparece com a mensagem clara', async () => {
    const ev = { id: 'e1', table: 'payments', op: 'INSERT', row_id: 'p1', payload: { id: 'p1', order_id: 'o1' }, created_at: '2026-11-14T10:00:00Z', attempts: 0 } as never;
    const res = await flushOutbox([ev], cfg, async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ code: 'TF010', message: 'TCHEFOOD_PAGAMENTO: claim_required' }) }));
    expect(res.rejected[0]!.message).toBe(`${CLAIM_REQUIRED_ERROR} — TCHEFOOD_PAGAMENTO: claim_required`);
  });
});

describe('fetchPointReservation: reservas abertas (claims)', () => {
  it('lê a lista com quem criou', async () => {
    const body = {
      reserved_cents: 2000, open_charges: 0, manual_review: false, claims_cents: 2000, point_cents: 0, charges: [],
      claims: [{ idempotency_key: 'k-9', amount_cents: 2000, method: 'CASH', acquirer: 'CASH_DESK', created_at: '2026-11-14T10:00:00Z', created_by: 's1', created_by_name: 'Tião' }],
    };
    const r = await fetchPointReservation(cfg, async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) }), 'o1');
    expect(r.claims).toEqual([{ idempotencyKey: 'k-9', amountCents: 2000, method: 'CASH', acquirer: 'CASH_DESK', createdAt: '2026-11-14T10:00:00Z', createdBy: 's1', createdByName: 'Tião' }]);
  });
});
