// @vitest-environment jsdom
/**
 * Modos de falha de cada RPC da reserva de pagamento e da função point-charge, pela função real do cliente
 * (fetch simulado). Invariantes de dinheiro conferidos em cada caso:
 *  I1. nada vai para a maquininha e nenhum pagamento é liberado/registrado sem confirmação definitiva do servidor;
 *  I2. o segredo da reserva (release_token) não se perde enquanto o servidor pode segurar a reserva
 *      (registro local mantido ou liberação pendente guardada com o segredo);
 *  I3. o segredo nunca aparece em texto devolvido para a tela nem no console;
 *  I4. recusa definitiva termina limpa (sem registro nem liberação pendente sobrando, sem nova chamada);
 *  I5. MANUAL_REVIEW nunca vira APPROVED/DECLINED sem o servidor confirmar.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cloud = vi.hoisted(() => ({
  config: async (): Promise<{ url: string; anonKey: string; accessToken: string } | null> => ({ url: 'https://x.supabase.co', anonKey: 'anon', accessToken: 'jwt-session' }),
  ensure: async (_id: string) => ({ ok: true as const, balance_cents: 1000 }),
}));
vi.mock('../lib/sync/useCloudSync', async (orig) => ({
  ...(await orig<typeof import('../lib/sync/useCloudSync')>()),
  freshCloudConfig: () => cloud.config(),
  ensureOrderSynced: (id: string) => cloud.ensure(id),
}));

const ledgerMod = await import('../lib/payments/claimLedger');
const { beginLocalClaim, detachLocalClaim, localClaim, pendingRelease, resetClaimLedger, settleLocalClaim, settledClaims, addPendingRelease, inFlightClaims } = ledgerMod;
const pc = await import('../lib/payments/paymentClaim');
const { claimPayment, releaseClaimAfterNoCharge, retryPendingClaimReleases, releasePaymentClaimManager, touchPaymentClaim, authorizeClaimRefunded, reclaimPayment } = pc;
const { startPaymentClaim, reclaimForHold, confirmClaimRefunded, checkHoldClaim } = await import('../lib/payments/claimFlow');
const { superviseSettledClaims, resetClaimSupervisor } = await import('../lib/payments/claimSupervisor');
const { readPointChargeStatus, reconcilePointCharge } = await import('../lib/payments/pointReconcile');
const { MercadoPagoPointDriver } = await import('../lib/payments/mercadoPagoPointDriver');
const { setReviewHold, getReviewHoldByKey, clearReviewHold } = await import('../lib/payments/reviewHolds');
const { useTcheStore } = await import('../store/useTcheStore');
type ClaimDeps = import('../lib/payments/paymentClaim').ClaimDeps;
type PointDriverDeps = import('../lib/payments/mercadoPagoPointDriver').PointDriverDeps;
type ChargeRequest = import('../lib/payments/drivers').ChargeRequest;
type PosTerminal = import('../types').PosTerminal;
type Payment = import('../types').Payment;

// ---------------------------------------------------------------- respostas simuladas

type Answer = { status: number; body: string } | 'network' | 'hang';
const json = (status: number, v: unknown): Answer => ({ status, body: JSON.stringify(v) });
const raw = (status: number, body: string): Answer => ({ status, body });
const pg = (status: number, code: string, message: string): Answer => json(status, { code, message, details: null, hint: null });

/** Transporte, gateway e sessão: o pedido pode ter chegado e rodado no servidor (ou não chegou, sem prova). */
const TRANSPORT: Array<[string, Answer]> = [
  ['network error', 'network'],
  ['timeout', 'hang'],
  ['HTTP 500', pg(500, 'XX000', 'internal error')],
  ['502 HTML', raw(502, '<html><body><h1>502 Bad Gateway</h1></body></html>')],
  ['401 JWT expired', pg(401, 'PGRST301', 'JWT expired')],
];
/** 4xx sem SQLSTATE de PostgREST (página de proxy/WAF): não prova que a função não rodou. */
const PROXY_4XX: Array<[string, Answer]> = [['403 HTML (proxy)', raw(403, '<html>Forbidden</html>')]];
/** 403 do PostgREST (sessão/papel sem permissão): a função não rodou. */
const PG_403: Array<[string, Answer]> = [['403 permission denied', pg(403, '42501', 'permission denied for function')]];
const TF_CODES = ['TF001', 'TF002', 'TF003', 'TF004', 'TF005', 'TF006', 'TF007', 'TF008', 'TF009', 'TF010', 'TF011', 'TF012', 'TF013'];
const TF: Array<[string, Answer]> = TF_CODES.map((c) => [`400 ${c}`, pg(400, c, `TCHEFOOD_PAGAMENTO: ${c}`)]);
const GENERIC_200: Array<[string, Answer]> = [
  ['200 {}', raw(200, '{}')],
  ['200 null', raw(200, 'null')],
  ['200 empty body', raw(200, '')],
  ['200 HTML', raw(200, '<html>captive portal</html>')],
];

// ---------------------------------------------------------------- roteador de fetch

const CFG = { url: 'https://x.supabase.co', anonKey: 'anon', accessToken: 'jwt-session' };
type Call = { fn: string; body: Record<string, unknown> };
let calls: Call[] = [];
let routes: Record<string, Answer | ((body: Record<string, unknown>, n: number) => Answer)> = {};
const counts: Record<string, number> = {};
const tokensSeen = new Set<string>();

function fnOf(url: string): string {
  const m = /\/rpc\/([a-z_]+)$/.exec(url);
  if (m) return m[1]!;
  return url.endsWith('/functions/v1/point-charge') ? 'point-charge' : url;
}

function answerFor(fn: string, body: Record<string, unknown>): Answer {
  const key = fn === 'point-charge' ? `point:${String(body.action)}` : fn;
  counts[key] = (counts[key] ?? 0) + 1;
  const r = routes[key];
  if (!r) return 'network';
  return typeof r === 'function' ? r(body, counts[key]!) : r;
}

function record(url: string, init: { body?: string }): { fn: string; body: Record<string, unknown> } {
  const body = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
  for (const k of ['p_release_token', 'p_old_token', 'p_new_token']) if (typeof body[k] === 'string') tokensSeen.add(body[k] as string);
  const fn = fnOf(url);
  calls.push({ fn: fn === 'point-charge' ? `point:${String(body.action)}` : fn, body });
  return { fn, body };
}

const routerFetch = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
  const { fn, body } = record(url, init);
  const a = answerFor(fn, body);
  if (a === 'hang') return new Promise<never>(() => undefined);
  if (a === 'network') throw new TypeError('Failed to fetch');
  return { ok: a.status >= 200 && a.status < 300, status: a.status, text: async () => a.body };
};

/** Deps da reserva com fetch roteado; prazo curto (relógio real) para "timeout". */
function deps(over: Partial<ClaimDeps> = {}): ClaimDeps {
  return {
    config: async () => CFG,
    fetch: routerFetch,
    prepareOrder: async () => ({ ok: true, balance_cents: 1000 }),
    staff: async () => 'staff-1',
    timer: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
    sleep: async () => undefined,
    ...over,
  };
}

// ---------------------------------------------------------------- vazamento do segredo

const consoleLines: string[] = [];
const shown: string[] = [];
/** Guarda todo texto devolvido que a tela pode mostrar. */
function show<T>(v: T): T {
  shown.push(JSON.stringify(v) ?? '');
  return v;
}
function expectNoTokenLeak() {
  for (const t of [...tokensSeen, ...inFlightClaims().map((c) => c.release_token ?? '')].filter((x) => x.length === 64)) {
    for (const s of shown) expect(s.includes(t), 'token in returned/rendered text').toBe(false);
    for (const s of consoleLines) expect(s.includes(t), 'token in console').toBe(false);
  }
}

const TOKEN = 'ab'.repeat(32);
const TOKEN2 = 'cd'.repeat(32);
const KEY = '11111111-1111-4111-8111-111111111111';
const ORDER = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  calls = [];
  routes = {};
  for (const k of Object.keys(counts)) delete counts[k];
  tokensSeen.clear();
  tokensSeen.add(TOKEN);
  tokensSeen.add(TOKEN2);
  shown.length = 0;
  consoleLines.length = 0;
  resetClaimLedger();
  resetClaimSupervisor();
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { consoleLines.push(a.map((x) => (x instanceof Error ? `${x.message} ${x.stack}` : typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); });
  }
  vi.stubGlobal('fetch', routerFetch);
  useTcheStore.setState({ currentUserId: 'staff-1' });
});
afterEach(() => {
  expectNoTokenLeak();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ================================================================ tchefood_claim_payment

const CLAIM_OK = { id: 'c1', idempotency_key: KEY, status: 'open', amount_cents: 1000 };
const CLAIM_BAD_200: Array<[string, Answer]> = [
  ...GENERIC_200,
  ['200 array (setof)', json(200, [CLAIM_OK])],
  ['200 wrong types', json(200, { ...CLAIM_OK, id: 1, amount_cents: '1000' })],
  ['200 missing fields', json(200, { id: 'c1', status: 'open' })],
  ['200 wrong key', json(200, { ...CLAIM_OK, idempotency_key: 'other-key' })],
  ['200 wrong amount', json(200, { ...CLAIM_OK, amount_cents: 999 })],
  ['200 extra status', json(200, { ...CLAIM_OK, status: 'released' })],
];
const CLAIM_INPUT = { orderId: ORDER, key: KEY, method: 'CASH' as const, acquirer: 'CASH_DESK' as const, amount: 10 };

describe('tchefood_claim_payment: claimPayment (direto)', () => {
  it('controle: resposta válida libera', async () => {
    routes.tchefood_claim_payment = json(200, CLAIM_OK);
    expect(show(await claimPayment({ ...CLAIM_INPUT, releaseToken: TOKEN }, deps())).ok).toBe(true);
  });
  it.each([...TRANSPORT, ...PROXY_4XX, ...PG_403, ...TF, ...CLAIM_BAD_200])('%s: não libera (I1)', async (_n, a) => {
    routes.tchefood_claim_payment = a;
    const r = show(await claimPayment({ ...CLAIM_INPUT, releaseToken: TOKEN }, deps()));
    expect(r.ok).toBe(false);
  });
  it.each(TRANSPORT)('%s: marcado como sem resposta (offline)', async (_n, a) => {
    routes.tchefood_claim_payment = a;
    expect(show(await claimPayment({ ...CLAIM_INPUT, releaseToken: TOKEN }, deps()))).toMatchObject({ ok: false, offline: true });
  });
});

describe('tchefood_claim_payment: startPaymentClaim (fluxo da tela)', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }));

  async function run() {
    let res: Awaited<ReturnType<typeof startPaymentClaim>> | undefined;
    void startPaymentClaim(true, CLAIM_INPUT).then((r) => (res = r));
    // Passos curtos: os imports tardios do caminho padrão (sessão, operador) terminam antes do prazo de 10 s.
    for (let i = 0; i < 400 && res === undefined; i += 1) {
      await vi.dynamicImportSettled();
      await vi.advanceTimersByTimeAsync(250);
    }
    for (let i = 0; i < 400; i += 1) {
      await vi.dynamicImportSettled();
      await vi.advanceTimersByTimeAsync(250); // liberação em segundo plano e suas novas tentativas
    }
    if (res?.ok) res.handle.leave();
    return show(res);
  }
  const tokenSent = () => calls.find((c) => c.fn === 'tchefood_claim_payment')?.body.p_release_token as string | undefined;
  const tokenKept = (t: string) => localClaim(KEY)?.release_token === t || pendingRelease(KEY)?.release_token === t;

  it.each([...TRANSPORT, ...PROXY_4XX, ...CLAIM_BAD_200])('%s: não recebe e o segredo fica guardado (I1, I2)', async (_n, a) => {
    routes.tchefood_claim_payment = a;
    routes.tchefood_release_payment_claim = 'network';
    const r = await run();
    expect(r?.ok).toBe(false);
    const t = tokenSent();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenKept(t!)).toBe(true);
  });

  it.each([...PG_403, ...TF])('%s: recusa definitiva termina limpa (I4)', async (_n, a) => {
    routes.tchefood_claim_payment = a;
    const r = await run();
    expect(r?.ok).toBe(false);
    expect(localClaim(KEY)).toBeNull();
    expect(pendingRelease(KEY)).toBeNull();
    expect(calls.filter((c) => c.fn === 'tchefood_claim_payment')).toHaveLength(1);
    expect(calls.some((c) => c.fn === 'tchefood_release_payment_claim')).toBe(false);
  });
});

// ================================================================ tchefood_touch_payment_claim

const TOUCH_OK = { id: 'c1', idempotency_key: KEY, status: 'open', active_until: '2026-11-14T12:00:00Z' };
const TOUCH_BAD_200: Array<[string, Answer]> = [
  ...GENERIC_200,
  ['200 wrong types', json(200, { status: 1 })],
  ['200 missing fields', json(200, { active_until: 'x' })],
  ['200 wrong key', json(200, { ...TOUCH_OK, idempotency_key: 'other-key' })],
  ['200 extra status', json(200, { ...TOUCH_OK, status: 'expired' })],
];

describe('tchefood_touch_payment_claim: beforeRegister (aprovação da maquininha)', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }));

  async function started() {
    routes.tchefood_claim_payment = json(200, CLAIM_OK);
    routes.tchefood_touch_payment_claim = json(200, TOUCH_OK);
    let res: Awaited<ReturnType<typeof startPaymentClaim>> | undefined;
    void startPaymentClaim(true, { ...CLAIM_INPUT, method: 'CREDIT', acquirer: 'STONE' }).then((r) => (res = r));
    await vi.advanceTimersByTimeAsync(0);
    if (!res?.ok) throw new Error('claim did not start');
    return res.handle;
  }
  async function before(h: Awaited<ReturnType<typeof started>>) {
    let out: Awaited<ReturnType<typeof h.beforeRegister>> | undefined;
    void h.beforeRegister('STONE').then((r) => (out = r));
    for (let i = 0; i < 3 && out === undefined; i += 1) await vi.advanceTimersByTimeAsync(10_000);
    return show(out);
  }

  it('controle: reserva aberta confirmada registra; liberada não registra', async () => {
    const h = await started();
    expect(await before(h)).toEqual({ ok: true });
    routes.tchefood_touch_payment_claim = json(200, { ...TOUCH_OK, status: 'released' });
    expect(await before(h)).toMatchObject({ ok: false, code: 'CLAIM_RELEASED' });
    h.leave();
  });

  it.each([...TRANSPORT, ...PROXY_4XX, ...PG_403, ...TF, ...TOUCH_BAD_200])('%s por mais que o prazo (90 s): não registra (I1)', async (_n, a) => {
    const h = await started();
    routes.tchefood_touch_payment_claim = a;
    await vi.advanceTimersByTimeAsync(95_000);
    const r = await before(h);
    h.leave();
    expect(r?.ok).toBe(false);
  });

  it.each(TF.filter(([n]) => /TF00[456]/.test(n)))('%s logo depois de aprovar: recusa definitiva não registra (I1)', async (_n, a) => {
    const h = await started();
    routes.tchefood_touch_payment_claim = a;
    const r = await before(h);
    h.leave();
    expect(r?.ok).toBe(false);
  });

  it('200 wrong key: touchPaymentClaim não aceita a resposta de outra reserva (I1)', async () => {
    vi.useRealTimers();
    routes.tchefood_touch_payment_claim = json(200, { ...TOUCH_OK, idempotency_key: 'other-key' });
    expect(show(await touchPaymentClaim(KEY, TOKEN, deps())).ok).toBe(false);
  });
});

describe('tchefood_touch_payment_claim: claimSupervisor (reserva terminada, pagamento ainda na fila)', () => {
  const PAID = { id: 'p1', idempotency_key: KEY, status: 'APPROVED', amount: 10, method: 'CREDIT', acquirer: 'STONE', terminal_id: null, terminal_serial: null } as unknown as Payment;
  function supDeps() {
    const withdraw = vi.fn(() => ({ nfceIssued: false }));
    const setHold = vi.fn();
    return {
      withdraw, setHold,
      d: {
        touch: (k: string, t: string) => touchPaymentClaim(k, t, deps()),
        payments: () => [PAID], unpushed: () => true, rejected: () => null, withdraw, hold: () => null, setHold,
        alert: (s: string) => void show(s), openClaimKeys: async () => null,
      },
    };
  }
  it.each([...TRANSPORT, ...PROXY_4XX, ...PG_403, ...TF, ...TOUCH_BAD_200])('%s: segredo fica, pagamento não sai da conta (I2)', async (_n, a) => {
    beginLocalClaim(KEY, ORDER, TOKEN);
    settleLocalClaim(KEY);
    routes.tchefood_touch_payment_claim = a;
    const s = supDeps();
    await superviseSettledClaims(s.d, Date.now(), true);
    expect(settledClaims().find((c) => c.key === KEY)?.release_token).toBe(TOKEN);
    expect(s.withdraw).not.toHaveBeenCalled();
  });
  it('controle: liberada pelo gerente com o pagamento na fila → retira e trava', async () => {
    beginLocalClaim(KEY, ORDER, TOKEN);
    settleLocalClaim(KEY);
    routes.tchefood_touch_payment_claim = json(200, { ...TOUCH_OK, status: 'released' });
    const s = supDeps();
    await superviseSettledClaims(s.d, Date.now(), true);
    expect(s.withdraw).toHaveBeenCalled();
  });
});

describe('tchefood_touch_payment_claim: checkHoldClaim (registrar pelo comprovante)', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }));
  it.each([...TRANSPORT, ...PROXY_4XX, ...PG_403, ...TF.filter(([n]) => !n.includes('TF005')), ...TOUCH_BAD_200.filter(([n]) => n !== '200 wrong key')])('%s: não libera o registro (I1)', async (_n, a) => {
    beginLocalClaim(KEY, ORDER, TOKEN);
    settleLocalClaim(KEY);
    routes.tchefood_touch_payment_claim = a;
    let r: Awaited<ReturnType<typeof checkHoldClaim>> | undefined;
    void checkHoldClaim(KEY).then((x) => (r = x));
    for (let i = 0; i < 3 && r === undefined; i += 1) await vi.advanceTimersByTimeAsync(10_000);
    expect(show(r)?.ok).toBe(false);
    expect(localClaim(KEY)?.release_token).toBe(TOKEN);
  });
});

// ================================================================ tchefood_release_payment_claim

const RELEASE_OK = { id: 'c1', idempotency_key: KEY, status: 'released', amount_cents: 1000, released_at: 'x', release_audit_id: 'a1' };
const RELEASE_BAD_200: Array<[string, Answer]> = [
  ...GENERIC_200,
  ['200 wrong types', json(200, { status: true })],
  ['200 missing fields', json(200, { id: 'c1' })],
  ['200 wrong key', json(200, { ...RELEASE_OK, idempotency_key: 'other-key' })],
  ['200 extra status', json(200, { ...RELEASE_OK, status: 'open' })],
];

describe('tchefood_release_payment_claim: releaseClaimAfterNoCharge / retryPendingClaimReleases', () => {
  it('controle: liberada → sem pendência', async () => {
    beginLocalClaim(KEY, ORDER, TOKEN);
    routes.tchefood_release_payment_claim = json(200, RELEASE_OK);
    expect(show(await releaseClaimAfterNoCharge(KEY, ORDER, 'nada cobrado', TOKEN, deps())).ok).toBe(true);
    expect(pendingRelease(KEY)).toBeNull();
  });

  it.each([...TRANSPORT, ...PROXY_4XX, ...PG_403, ...TF.filter(([n]) => !/TF00[57]/.test(n)), ...RELEASE_BAD_200])('%s: segredo fica na liberação pendente (I2)', async (_n, a) => {
    beginLocalClaim(KEY, ORDER, TOKEN);
    routes.tchefood_release_payment_claim = a;
    show(await releaseClaimAfterNoCharge(KEY, ORDER, 'nada cobrado', TOKEN, deps()));
    expect(pendingRelease(KEY)?.release_token).toBe(TOKEN);
  });

  it.each(TRANSPORT)('%s: pendência continua tentando sozinha (não final)', async (_n, a) => {
    beginLocalClaim(KEY, ORDER, TOKEN);
    routes.tchefood_release_payment_claim = a;
    await releaseClaimAfterNoCharge(KEY, ORDER, 'nada cobrado', TOKEN, deps());
    expect(pendingRelease(KEY)?.final).toBe(false);
  });

  it.each(TF.filter(([n]) => /TF00[57]/.test(n)))('%s: definitivo (não existe / já virou pagamento) termina limpo (I4)', async (_n, a) => {
    beginLocalClaim(KEY, ORDER, TOKEN);
    routes.tchefood_release_payment_claim = a;
    expect(show(await releaseClaimAfterNoCharge(KEY, ORDER, 'nada cobrado', TOKEN, deps())).ok).toBe(true);
    expect(pendingRelease(KEY)).toBeNull();
    expect(localClaim(KEY)).toBeNull();
  });

  it.each([...TRANSPORT, ...PROXY_4XX, ...RELEASE_BAD_200])('retry %s: pendência com o segredo continua (I2)', async (_n, a) => {
    addPendingRelease({ key: KEY, order_id: ORDER, reason: 'nada cobrado', release_token: TOKEN });
    routes.tchefood_release_payment_claim = a;
    await retryPendingClaimReleases(deps(), Date.now(), true);
    expect(pendingRelease(KEY)?.release_token).toBe(TOKEN);
  });
});

// ================================================================ tchefood_release_payment_claim_manager

const MGR_OK = { ...RELEASE_OK };
const MGR_BAD_200: Array<[string, Answer]> = [
  ...GENERIC_200,
  ['200 wrong types', json(200, { status: 1 })],
  ['200 missing fields', json(200, { id: 'c1' })],
  ['200 wrong key', json(200, { ...MGR_OK, idempotency_key: 'other-key' })],
  ['200 extra status', json(200, { ...MGR_OK, status: 'open' })],
];

describe('tchefood_release_payment_claim_manager: releasePaymentClaimManager', () => {
  it('controle: liberada tira a pendência', async () => {
    addPendingRelease({ key: KEY, order_id: ORDER, reason: 'r', release_token: TOKEN });
    routes.tchefood_release_payment_claim_manager = json(200, MGR_OK);
    expect(show(await releasePaymentClaimManager(KEY, '1234', 'motivo do gerente', deps())).ok).toBe(true);
    expect(pendingRelease(KEY)).toBeNull();
  });
  it.each([...TRANSPORT, ...PROXY_4XX, ...PG_403, ...TF.filter(([n]) => !n.includes('TF005')), ...MGR_BAD_200])('%s: não conta como liberada; pendência com segredo fica (I1, I2)', async (_n, a) => {
    addPendingRelease({ key: KEY, order_id: ORDER, reason: 'r', release_token: TOKEN });
    beginLocalClaim(KEY, ORDER, TOKEN);
    routes.tchefood_release_payment_claim_manager = a;
    const r = show(await releasePaymentClaimManager(KEY, '1234', 'motivo do gerente', deps()));
    expect(r.ok).toBe(false);
    expect(pendingRelease(KEY)?.release_token).toBe(TOKEN);
    expect(localClaim(KEY)?.release_token).toBe(TOKEN);
  });
  it.each([['200 HTML', raw(200, '<html>x</html>')], ['200 empty body', raw(200, '')]] as Array<[string, Answer]>)('%s: não é lido como "PIN errado"', async (_n, a) => {
    routes.tchefood_release_payment_claim_manager = a;
    const r = show(await releasePaymentClaimManager(KEY, '1234', 'motivo do gerente', deps()));
    expect(r).not.toMatchObject({ pin: true });
  });
});

// ================================================================ tchefood_reclaim_payment

const OLD_KEY = KEY;
const NEW_KEY = '33333333-3333-4333-8333-333333333333';
const RECLAIM_OK = {
  old: { id: 'c1', idempotency_key: OLD_KEY, status: 'released', release_audit_id: 'a' },
  new: { id: 'c2', idempotency_key: NEW_KEY, status: 'open', amount_cents: 1000 },
};
const RECLAIM_BAD_200: Array<[string, Answer]> = [
  ...GENERIC_200,
  ['200 wrong types', json(200, { ...RECLAIM_OK, new: { ...RECLAIM_OK.new, id: 5, amount_cents: 'x' } })],
  ['200 missing fields', json(200, { new: RECLAIM_OK.new })],
  ['200 wrong key', json(200, { ...RECLAIM_OK, new: { ...RECLAIM_OK.new, idempotency_key: 'other-key' } })],
  ['200 wrong amount', json(200, { ...RECLAIM_OK, new: { ...RECLAIM_OK.new, amount_cents: 999 } })],
  ['200 extra status', json(200, { ...RECLAIM_OK, new: { ...RECLAIM_OK.new, status: 'consumed' } })],
];

describe('tchefood_reclaim_payment: reclaimPayment + reclaimForHold', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }));
  const hold = () => ({ order_id: ORDER, amount: 10, reason: 'outra adquirente', code: 'ACQUIRER_MISMATCH', idempotency_key: OLD_KEY, reclaim_key: NEW_KEY, created_at: new Date().toISOString() });

  async function runReclaim() {
    beginLocalClaim(OLD_KEY, ORDER, TOKEN);
    settleLocalClaim(OLD_KEY);
    beginLocalClaim(NEW_KEY, ORDER, TOKEN2);
    detachLocalClaim(NEW_KEY);
    setReviewHold(hold());
    let r: Awaited<ReturnType<typeof reclaimForHold>> | undefined;
    void reclaimForHold(hold(), 'CREDIT', 'PAGBANK').then((x) => (r = x));
    for (let i = 0; i < 6 && r === undefined; i += 1) await vi.advanceTimersByTimeAsync(10_000);
    clearReviewHold(ORDER);
    return show(r);
  }

  it.each([...TRANSPORT, ...PROXY_4XX, ...PG_403, ...TF, ...RECLAIM_BAD_200])('%s: não registra; segredos antigo e novo ficam (I1, I2)', async (_n, a) => {
    routes.tchefood_reclaim_payment = a;
    routes.tchefood_touch_payment_claim = 'network';
    const r = await runReclaim();
    expect(r?.ok).toBe(false);
    expect(localClaim(OLD_KEY)?.release_token).toBe(TOKEN);
    expect(localClaim(NEW_KEY)?.release_token).toBe(TOKEN2);
  });

  it.each([...PG_403, ...TF])('%s + servidor confirma que a chave nova não existe (TF005): termina limpo (I4)', async (_n, a) => {
    routes.tchefood_reclaim_payment = a;
    routes.tchefood_touch_payment_claim = pg(400, 'TF005', 'não encontrada');
    const r = await runReclaim();
    expect(r?.ok).toBe(false);
    expect(localClaim(NEW_KEY)).toBeNull();
    expect(localClaim(OLD_KEY)?.release_token).toBe(TOKEN);
  });

  it('controle: troca confirmada', async () => {
    routes.tchefood_reclaim_payment = json(200, RECLAIM_OK);
    expect(show(await reclaimPayment({ oldKey: OLD_KEY, oldToken: TOKEN, newKey: NEW_KEY, newToken: TOKEN2, method: 'CREDIT', acquirer: 'PAGBANK', amount: 10 }, deps())).ok).toBe(true);
  });
});

// ================================================================ tchefood_authorize_claim_refunded

const AUDIT_ID = '"44444444-4444-4444-8444-444444444444"';
const REFUND_BAD_200: Array<[string, Answer]> = [
  ['200 {}', raw(200, '{}')],
  ['200 empty body', raw(200, '')],
  ['200 HTML', raw(200, '<html>x</html>')],
  ['200 wrong types', raw(200, '123')],
  ['200 wrong key (not a uuid)', raw(200, '"not-a-uuid"')],
];

describe('tchefood_authorize_claim_refunded: authorizeClaimRefunded + confirmClaimRefunded', () => {
  it('controle: id do audit libera', async () => {
    routes.tchefood_authorize_claim_refunded = raw(200, AUDIT_ID);
    expect(show(await authorizeClaimRefunded(KEY, '1234', 'estornei na maquininha', { refund_kind: 'card' }, deps())).ok).toBe(true);
  });
  it('200 null: PIN recusado (semântica do servidor)', async () => {
    routes.tchefood_authorize_claim_refunded = raw(200, 'null');
    expect(show(await authorizeClaimRefunded(KEY, '1234', 'estornei na maquininha', { refund_kind: 'card' }, deps()))).toMatchObject({ ok: false, pin: true });
  });
  it.each([...TRANSPORT, ...PROXY_4XX, ...PG_403, ...TF.filter(([n]) => !n.includes('TF005')), ...REFUND_BAD_200])('%s: trava e segredo ficam (I1, I2)', async (_n, a) => {
    useTcheStore.setState({ cloud: { tenant_id: 't' } as never });
    beginLocalClaim(KEY, ORDER, TOKEN);
    settleLocalClaim(KEY);
    setReviewHold({ order_id: ORDER, amount: 10, reason: 'liberada', code: 'CLAIM_RELEASED', idempotency_key: KEY, refund: 'TERMINAL' });
    routes.tchefood_authorize_claim_refunded = a;
    const r = show(await confirmClaimRefunded(getReviewHoldByKey(KEY)!, { managerPin: '1234', reason: 'estornei na maquininha' }, deps()));
    expect(r.ok).toBe(false);
    expect(getReviewHoldByKey(KEY)).not.toBeNull();
    expect(localClaim(KEY)?.release_token).toBe(TOKEN);
    clearReviewHold(ORDER);
    useTcheStore.setState({ cloud: null });
  });
  it.each(REFUND_BAD_200.filter(([n]) => n === '200 empty body' || n === '200 HTML'))('%s: não é lido como "PIN errado"', async (_n, a) => {
    routes.tchefood_authorize_claim_refunded = a;
    expect(show(await authorizeClaimRefunded(KEY, '1234', 'estornei na maquininha', { refund_kind: 'card' }, deps()))).not.toMatchObject({ pin: true });
  });
});

// ================================================================ tchefood_point_reservation (claimSupervisor, leitura sem renovar)

const RES_OK = { reserved_cents: 0, open_charges: 0, manual_review: false, claims_cents: 0, point_cents: 0, charges: [], claims: [] };
const RES_BAD_200: Array<[string, Answer]> = [
  ...GENERIC_200,
  ['200 wrong types', json(200, { ...RES_OK, reserved_cents: 'abc' })],
  ['200 wrong types (claims entry)', json(200, { ...RES_OK, claims: [{ idempotency_key: 5, amount_cents: 'x' }] })],
  ['200 missing fields (no claims)', json(200, { reserved_cents: 1000, open_charges: 0, manual_review: false })],
  ['200 missing fields (claims null)', json(200, { ...RES_OK, reserved_cents: 1000, claims: null })],
  ['200 extra status (claims not array)', json(200, { ...RES_OK, claims: 'open' })],
];

describe('tchefood_point_reservation: superviseSettledClaims (cobrança que caiu no meio)', () => {
  async function threeReads() {
    beginLocalClaim(KEY, ORDER, TOKEN);
    detachLocalClaim(KEY);
    const t0 = Date.now();
    for (let i = 0; i < 3; i += 1) await superviseSettledClaims(undefined, t0 + i * 61_000, true);
  }
  it('controle: 3 leituras válidas sem a reserva, espaçadas por 2 min → sai do registro', async () => {
    routes.tchefood_point_reservation = json(200, RES_OK);
    await threeReads();
    expect(localClaim(KEY)).toBeNull();
  });
  it.each([...TRANSPORT.filter(([n]) => n !== 'timeout'), ...PROXY_4XX, ...PG_403, ...TF, ...RES_BAD_200])('%s: sem prova de ausência o segredo fica (I2)', async (_n, a) => {
    routes.tchefood_point_reservation = a;
    await threeReads();
    expect(localClaim(KEY)?.release_token).toBe(TOKEN);
  });
  it('timeout: leitura pendurada não trava o supervisor para sempre (batimento das reservas terminadas)', async () => {
    routes.tchefood_point_reservation = 'hang';
    beginLocalClaim(KEY, ORDER, TOKEN);
    detachLocalClaim(KEY);
    void superviseSettledClaims(undefined, Date.now(), true);
    await new Promise((r) => setTimeout(r, 20));
    // Próxima volta, minutos depois: a reserva terminada de outra cobrança precisa ser renovada.
    const SETTLED = '55555555-5555-4555-8555-555555555555';
    beginLocalClaim(SETTLED, ORDER, TOKEN2);
    settleLocalClaim(SETTLED);
    useTcheStore.setState({ payments: [{ id: 'p9', idempotency_key: SETTLED, status: 'APPROVED', amount: 10, method: 'CASH', acquirer: 'CASH_DESK' } as unknown as Payment] });
    routes.tchefood_touch_payment_claim = json(200, { ...TOUCH_OK, idempotency_key: SETTLED });
    const p = superviseSettledClaims(undefined, Date.now() + 300_000, true);
    await Promise.race([p, new Promise((r) => setTimeout(r, 200))]);
    useTcheStore.setState({ payments: [] });
    expect(calls.some((c) => c.fn === 'tchefood_touch_payment_claim'), 'supervisor still blocked by the hung read').toBe(true);
  });
});

// ================================================================ point-charge (create / status / cancel)

const TERMINAL: PosTerminal = {
  id: '66666666-6666-4666-8666-666666666666', tenant_id: 't', name: 'Point Smart', serial_number: 'SERIAL-1',
  acquirer: 'MERCADO_PAGO', mode: 'TEF_POS_WIRELESS', online: true, battery_level: null,
};
const REQ: ChargeRequest = { request_id: 'req-1', idempotency_key: KEY, amount: 24.5, method: 'CREDIT', table_label: 'Mesa 1', order_id: ORDER, description: '' };
const APPROVED = { status: 'APPROVED', idempotency_key: KEY, nsu: '123456789', authorization_code: 'A1B2C3', card_brand: 'MASTERCARD', last_four: '4242', terminal_serial: TERMINAL.serial_number, amount_cents: 2450, method: 'CREDIT' };
const PENDING = json(200, { status: 'PENDING', idempotency_key: KEY });
const DECLINED_OK = json(200, { status: 'DECLINED', idempotency_key: KEY, reason: 'cancelada na maquininha' });
const fnErr = (status: number, error: string): Answer => json(status, { error, message: `function said ${error}` });
const POINT_FN_4XX: Array<[string, Answer]> = [
  ['400 invalid_key', fnErr(400, 'invalid_key')],
  ['401 auth (session expired)', fnErr(401, 'auth')],
  ['403 manager_denied', fnErr(403, 'manager_denied')],
  ['404 not_found', fnErr(404, 'not_found')],
  ['409 idempotency_conflict', fnErr(409, 'idempotency_conflict')],
  ['409 TF003 relayed', fnErr(409, 'TF003')],
  ['412 not_configured', fnErr(412, 'not_configured')],
];
const POINT_BAD_200: Array<[string, Answer]> = [
  ...GENERIC_200,
  ['200 wrong types', json(200, { ...APPROVED, amount_cents: '2450' })],
  ['200 missing fields', json(200, { ...APPROVED, nsu: undefined })],
  ['200 extra status', json(200, { status: 'AUTHORIZED' })],
];
const POINT_APPROVED_WRONG: Array<[string, Answer]> = [
  ['200 APPROVED wrong amount', json(200, { ...APPROVED, amount_cents: 2400 })],
  ['200 APPROVED wrong method', json(200, { ...APPROVED, method: 'DEBIT' })],
  ['200 APPROVED other terminal', json(200, { ...APPROVED, terminal_serial: 'OTHER' })],
  ['200 APPROVED wrong key', json(200, { ...APPROVED, idempotency_key: 'other-key' })],
];

function pointDriver(over: Partial<PointDriverDeps> = {}) {
  let clock = 0;
  const d: PointDriverDeps = {
    config: async () => CFG,
    fetch: async (url, init) => {
      const r = await routerFetch(url, init);
      return { status: r.status, text: r.text };
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    timer: () => new Promise((r) => setTimeout(r, 0)),
    operator: async () => 'staff-1',
    prepareOrder: async () => ({ ok: true, balance_cents: 2450 }),
    ...over,
  };
  return new MercadoPagoPointDriver('TEF_POS_WIRELESS', TERMINAL, d);
}
const serverConfirmed = (r: { status: string }) => (r as { server_confirmed?: boolean }).server_confirmed === true;

describe('point-charge create', () => {
  it.each([...TRANSPORT, ...PROXY_4XX, ...POINT_BAD_200])('%s: nunca aprova; recusa só confirmada pelo encerramento no servidor (I1, I5)', async (_n, a) => {
    routes['point:create'] = a;
    routes['point:status'] = PENDING;
    routes['point:cancel'] = DECLINED_OK;
    const r = show(await pointDriver().charge(REQ));
    expect(r.status).not.toBe('APPROVED');
    if (r.status === 'DECLINED') expect(serverConfirmed(r)).toBe(true);
  });
  it.each(POINT_FN_4XX.filter(([n]) => !n.startsWith('401')))('%s na primeira criação: recusa da função, uma criação só (I4)', async (_n, a) => {
    routes['point:create'] = a;
    const r = show(await pointDriver().charge(REQ));
    expect(r.status).toBe('DECLINED');
    expect(calls.filter((c) => c.fn === 'point:create')).toHaveLength(1);
    expect(calls.some((c) => c.fn !== 'point:create')).toBe(false);
  });
  it.each(POINT_FN_4XX)('%s depois de uma criação incerta: só o encerramento decide (I1)', async (_n, a) => {
    routes['point:create'] = (_b, n) => (n === 1 ? 'network' : a);
    routes['point:status'] = PENDING;
    routes['point:cancel'] = json(409, { error: 'too_early', message: 'cedo' });
    const r = show(await pointDriver().charge(REQ));
    expect(r.status).toBe('MANUAL_REVIEW');
  });
  it('sem sessão: nada sai daqui', async () => {
    const r = show(await pointDriver({ config: async () => null }).charge(REQ));
    expect(r.status).toBe('DECLINED');
    expect(calls).toHaveLength(0);
  });
  it.each(POINT_APPROVED_WRONG)('%s: não aprova (I1)', async (_n, a) => {
    routes['point:create'] = a;
    const r = show(await pointDriver().charge(REQ));
    expect(r.status).not.toBe('APPROVED');
  });
});

describe('point-charge status', () => {
  it.each([...TRANSPORT, ...PROXY_4XX, ...POINT_BAD_200, ...POINT_FN_4XX])('%s: nunca aprova; recusa só do servidor (I1, I5)', async (_n, a) => {
    routes['point:create'] = PENDING;
    routes['point:status'] = a;
    routes['point:cancel'] = DECLINED_OK;
    const r = show(await pointDriver().charge(REQ));
    expect(r.status).not.toBe('APPROVED');
    if (r.status === 'DECLINED') expect(serverConfirmed(r)).toBe(true);
  });
  it.each(POINT_APPROVED_WRONG)('%s: não aprova (I1)', async (_n, a) => {
    routes['point:create'] = PENDING;
    routes['point:status'] = a;
    routes['point:cancel'] = DECLINED_OK;
    expect(show(await pointDriver().charge(REQ)).status).not.toBe('APPROVED');
  });
  it('MANUAL_REVIEW do servidor: fica em revisão, sem nova chamada que o mude (I5)', async () => {
    routes['point:create'] = PENDING;
    routes['point:status'] = json(200, { status: 'MANUAL_REVIEW', idempotency_key: KEY, reason: 'confira', code: 'X' });
    routes['point:cancel'] = DECLINED_OK;
    const r = show(await pointDriver().charge(REQ));
    expect(r.status).toBe('MANUAL_REVIEW');
    expect(calls.some((c) => c.fn === 'point:cancel')).toBe(false);
  });
});

describe('point-charge cancel', () => {
  it.each([...TRANSPORT, ...PROXY_4XX, ...POINT_BAD_200, ...POINT_FN_4XX])('%s: sem confirmação → revisão manual, nunca recusa (I1, I5)', async (_n, a) => {
    routes['point:create'] = PENDING;
    routes['point:status'] = PENDING;
    routes['point:cancel'] = a;
    const r = show(await pointDriver().charge(REQ));
    expect(r.status).toBe('MANUAL_REVIEW');
  });
  it.each(POINT_APPROVED_WRONG)('%s no encerramento: não aprova (I1)', async (_n, a) => {
    routes['point:create'] = PENDING;
    routes['point:status'] = PENDING;
    routes['point:cancel'] = a;
    expect(show(await pointDriver().charge(REQ)).status).not.toBe('APPROVED');
  });
});

// ================================================================ point-charge reconcile

describe('point-charge reconcile: reconcilePointCharge', () => {
  const input = { idempotency_key: KEY, staff_id: 'staff-1', manager_pin: '1234', reason_text: 'conferi no app do MP' };
  const rdeps = () => ({ config: async () => CFG, fetch: async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
    const r = await routerFetch(url, init);
    return { status: r.status, text: r.text };
  }, timer: () => new Promise<void>((r) => setTimeout(r, 0)) });

  it.each([...TRANSPORT, ...PROXY_4XX, ...POINT_BAD_200, ...POINT_FN_4XX, ['200 PENDING', PENDING] as [string, Answer]])('%s: continua em revisão (I5)', async (_n, a) => {
    routes['point:reconcile'] = a;
    const r = show(await reconcilePointCharge(input, rdeps()));
    expect(r.kind).not.toBe('reply');
  });
  it('MANUAL_REVIEW do servidor continua MANUAL_REVIEW (I5)', async () => {
    routes['point:reconcile'] = json(200, { status: 'MANUAL_REVIEW', idempotency_key: KEY, reason: 'ainda', code: 'X' });
    const r = show(await reconcilePointCharge(input, rdeps()));
    expect(r).toMatchObject({ kind: 'reply', reply: { status: 'MANUAL_REVIEW' } });
  });
  it('409 not_applicable: marca notApplicable (a tela lê o estado gravado antes de mexer na trava)', async () => {
    routes['point:reconcile'] = json(409, { error: 'not_applicable', message: 'nada a conferir' });
    expect(show(await reconcilePointCharge(input, rdeps()))).toEqual({ kind: 'error', error: 'nada a conferir', notApplicable: true });
    routes['point:reconcile'] = json(409, { error: 'idempotency_conflict', message: 'outra' });
    expect(show(await reconcilePointCharge(input, rdeps()))).toEqual({ kind: 'error', error: 'outra' });
  });
  it.each([...TRANSPORT, ...PROXY_4XX, ...POINT_BAD_200, ...POINT_FN_4XX])('readPointChargeStatus, %s: erro (a trava fica)', async (_n, a) => {
    routes['point:status'] = a;
    expect(show(await readPointChargeStatus(KEY, rdeps())).kind).toBe('error');
  });
  it('readPointChargeStatus: devolve a resposta do servidor sobre a chave', async () => {
    routes['point:status'] = json(200, { status: 'DECLINED', idempotency_key: KEY, reason: 'cancelada' });
    expect(show(await readPointChargeStatus(KEY, rdeps()))).toEqual({ kind: 'reply', reply: { status: 'DECLINED', idempotency_key: KEY, reason: 'cancelada' } });
  });
  it.each(POINT_APPROVED_WRONG)('%s: a biblioteca devolve a aprovação crua (a tela confere valor/forma)', async (_n, a) => {
    routes['point:reconcile'] = a;
    const r = show(await reconcilePointCharge(input, rdeps()));
    // Documenta: a conferência de valor/forma fica em PointReviewSheet.tsx (não aqui).
    expect(r.kind).toBe('reply');
  });
});
