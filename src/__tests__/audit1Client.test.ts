// @vitest-environment jsdom
/**
 * Auditoria interna 1 (revisor do cliente e revisor de contrato): duas abas no mesmo registro, liberação pendente
 * gravada antes da primeira tentativa, chave em toda resposta da Point, leitura de reservas com prazo, chamada
 * cancelada no prazo, recusa sem SQLSTATE, recusa da maquininha com TF010 e TF007 claim_consumed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaimDeps } from '../lib/payments/paymentClaim';
import type { SupervisorDeps } from '../lib/payments/claimSupervisor';
import type { PosTerminal, SyncEvent } from '../types';
import type { ChargeRequest } from '../lib/payments/drivers';

const TOKEN_A = 'aa'.repeat(32);
const TOKEN_B = 'bb'.repeat(32);
const CFG = { url: 'https://x.supabase.co', anonKey: 'anon', accessToken: 'jwt' };

/** Um módulo novo do registro = outra aba (mesmo localStorage, memória própria). */
async function freshTab() {
  vi.resetModules();
  return import('../lib/payments/claimLedger');
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('P1: duas abas no mesmo registro de reservas', () => {
  it('a aba que leu antes não apaga, ao gravar, o segredo que a outra gravou depois', async () => {
    const tabB = await freshTab();
    // B lê o registro (vazio) antes de A gravar: é a cópia antiga de B.
    expect(tabB.inFlightClaims()).toEqual([]);
    const tabA = await freshTab();
    tabA.beginLocalClaim('K-A', 'o1', TOKEN_A);
    // B grava outra reserva a partir do que leu antes; a de A continua com o segredo.
    tabB.beginLocalClaim('K-B', 'o2', TOKEN_B);
    expect(tabA.localClaim('K-A')?.release_token).toBe(TOKEN_A);
    expect(tabB.localClaim('K-A')?.release_token).toBe(TOKEN_A);
    expect(tabA.localClaim('K-B')?.release_token).toBe(TOKEN_B);
    // Mudança de uma entrada só mexe nela.
    tabB.settleLocalClaim('K-B');
    tabA.endLocalClaim('K-A');
    const after = await freshTab();
    expect(after.localClaim('K-A')).toBeNull();
    expect(after.localClaim('K-B')).toMatchObject({ state: 'settled', release_token: TOKEN_B });
  });

  it('liberações pendentes: cada aba muda só a sua entrada', async () => {
    const tabB = await freshTab();
    expect(tabB.pendingReleases()).toEqual([]);
    const tabA = await freshTab();
    tabA.addPendingRelease({ key: 'K-A', order_id: 'o1', reason: 'r', release_token: TOKEN_A });
    tabB.addPendingRelease({ key: 'K-B', order_id: 'o2', reason: 'r', release_token: TOKEN_B });
    tabB.removePendingRelease('K-B');
    expect(tabA.pendingRelease('K-A')?.release_token).toBe(TOKEN_A);
    expect(tabB.pendingRelease('K-A')?.release_token).toBe(TOKEN_A);
    expect(tabA.pendingRelease('K-B')).toBeNull();
  });

  it('travas de revisão: a aba com a lista antiga não apaga a trava gravada pela outra', async () => {
    vi.resetModules();
    const holdsB = await import('../lib/payments/reviewHolds');
    expect(holdsB.getReviewHolds('o1')).toEqual([]);
    vi.resetModules();
    const holdsA = await import('../lib/payments/reviewHolds');
    holdsA.setReviewHold({ order_id: 'o1', amount: 5, reason: 'r', code: 'REGISTER_FAILED', refund: 'TERMINAL', idempotency_key: 'H-A' });
    holdsB.setReviewHold({ order_id: 'o1', amount: 7, reason: 'r', code: 'REGISTER_FAILED', refund: 'TERMINAL', idempotency_key: 'H-B' });
    expect(holdsA.getReviewHoldByKey('H-A')).not.toBeNull();
    expect(holdsA.getReviewHoldByKey('H-B')).not.toBeNull();
    holdsA.clearReviewHold('o1', 'H-A');
    expect(holdsB.getReviewHoldByKey('H-A')).toBeNull();
    expect(holdsB.getReviewHoldByKey('H-B')).not.toBeNull();
  });
});

function hangingDeps(over: Partial<ClaimDeps> = {}): ClaimDeps {
  return {
    config: async () => CFG,
    fetch: () => new Promise<never>(() => undefined),
    prepareOrder: async () => ({ ok: true, balance_cents: 1000 }),
    staff: async () => 'staff-1',
    timer: () => new Promise<void>(() => undefined),
    ...over,
  };
}

describe('P2-1: a liberação pendente é gravada antes da primeira tentativa', () => {
  it('liberação pendurada e o app recarregado: a pendência (com o segredo) está lá', async () => {
    const ledger = await freshTab();
    const { releaseClaimAfterNoCharge } = await import('../lib/payments/paymentClaim');
    ledger.beginLocalClaim('K-U', 'o1', TOKEN_A);
    void releaseClaimAfterNoCharge('K-U', 'o1', 'Reserva sem resposta do servidor', TOKEN_A, hangingDeps(), { unknownClaim: true });
    await Promise.resolve();
    // "Recarrega": outro módulo, só o que foi gravado.
    const reloaded = await freshTab();
    expect(reloaded.pendingRelease('K-U')).toMatchObject({ release_token: TOKEN_A, unknown_claim: true, final: false });
  });

  it('reserva em andamento de outra aba (registro "charging" sem pendência) não é liberada sozinha', async () => {
    const ledger = await freshTab();
    const sup = await import('../lib/payments/claimSupervisor');
    ledger.beginLocalClaim('K-C', 'o1', TOKEN_A);
    ledger.detachLocalClaim('K-C');
    const touch = vi.fn();
    const d: SupervisorDeps = {
      touch, payments: () => [], unpushed: () => false, rejected: () => null, withdraw: () => null, hold: () => null, setHold: () => undefined,
      alert: () => undefined, openClaimKeys: async () => new Set(['K-C']),
    };
    await sup.superviseSettledClaims(d, Date.now(), true);
    expect(touch).not.toHaveBeenCalled();
    expect(ledger.pendingReleases()).toEqual([]);
    expect(ledger.localClaim('K-C')?.release_token).toBe(TOKEN_A);
  });
});

describe('P3-2: a leitura das reservas abertas tem prazo como um todo', () => {
  it('sessão pendurada: a leitura vence no prazo e a próxima volta lê de novo', async () => {
    const ledger = await freshTab();
    const sup = await import('../lib/payments/claimSupervisor');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    ledger.beginLocalClaim('K-S', 'o1', TOKEN_A);
    ledger.detachLocalClaim('K-S');
    const openClaimKeys = vi.fn(() => new Promise<ReadonlySet<string> | null>(() => undefined));
    const d: SupervisorDeps = {
      touch: vi.fn(), payments: () => [], unpushed: () => false, rejected: () => null, withdraw: () => null, hold: () => null, setHold: () => undefined,
      alert: () => undefined, openClaimKeys,
    };
    const first = sup.superviseSettledClaims(d, 0, true);
    await vi.advanceTimersByTimeAsync(sup.STALE_READ_TIMEOUT_MS - 1);
    await sup.superviseSettledClaims(d, 1, true);
    expect(openClaimKeys).toHaveBeenCalledTimes(1); // a primeira ainda no prazo: pula
    await vi.advanceTimersByTimeAsync(2);
    await first;
    void sup.superviseSettledClaims(d, 2, true);
    await Promise.resolve();
    expect(openClaimKeys).toHaveBeenCalledTimes(2);
    expect(ledger.localClaim('K-S')?.release_token).toBe(TOKEN_A); // sem leitura não conta ausência
  });
});

describe('P3 callRpc: prazo vencido cancela o pedido', () => {
  it('o sinal do fetch é abortado quando o prazo vence', async () => {
    const { touchPaymentClaim } = await import('../lib/payments/paymentClaim');
    let signal: AbortSignal | undefined;
    const r = await touchPaymentClaim('K', TOKEN_A, hangingDeps({
      fetch: (_url, init) => {
        signal = init.signal;
        return new Promise<never>(() => undefined);
      },
      timer: () => Promise.resolve(),
    }));
    expect(r).toMatchObject({ ok: false, offline: true });
    expect(signal?.aborted).toBe(true);
  });
});

const reply = (status: number, body: string) => async () => ({ ok: status >= 200 && status < 300, status, text: async () => body });
function rpcDeps(answer: (url: string) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>, calls: string[] = []): ClaimDeps {
  return hangingDeps({
    fetch: (url) => {
      calls.push(url.split('/rpc/')[1] ?? url);
      return answer(url);
    },
    timer: () => new Promise<void>(() => undefined),
    sleep: async () => undefined,
  });
}

describe('P3-5: liberação recusada sem SQLSTATE (portal, proxy) não é final', () => {
  it('fica pendente, com o segredo, e continua tentando', async () => {
    const ledger = await freshTab();
    const { releaseClaimAfterNoCharge } = await import('../lib/payments/paymentClaim');
    ledger.beginLocalClaim('K-P', 'o1', TOKEN_A);
    const calls: string[] = [];
    const out = await releaseClaimAfterNoCharge('K-P', 'o1', 'recusou', TOKEN_A, rpcDeps(reply(403, '<html>portal</html>'), calls));
    expect(out).toMatchObject({ ok: false, transient: true });
    expect(calls).toHaveLength(3); // tentou de novo
    expect(ledger.pendingRelease('K-P')).toMatchObject({ release_token: TOKEN_A, final: false });
  });
  it('recusa com SQLSTATE (TF004) continua final', async () => {
    const ledger = await freshTab();
    const { releaseClaimAfterNoCharge } = await import('../lib/payments/paymentClaim');
    ledger.beginLocalClaim('K-Q', 'o1', TOKEN_A);
    await releaseClaimAfterNoCharge('K-Q', 'o1', 'recusou', TOKEN_A, rpcDeps(reply(400, '{"code":"TF004","message":"x"}')));
    expect(ledger.pendingRelease('K-Q')).toMatchObject({ final: true });
  });
});

describe('P3-7: TF007 claim_consumed no "Estornei / devolvi"', () => {
  it('authorizeClaimRefunded: claim_consumed é consumed; claim_open e sem DETAIL seguem notReleased', async () => {
    const { authorizeClaimRefunded, CLAIM_CONSUMED_NO_REFUND } = await import('../lib/payments/paymentClaim');
    const auth = ['K', '1234', 'conferido com o gerente', { refund_kind: 'card' as const }] as const;
    expect(await authorizeClaimRefunded(...auth, rpcDeps(reply(400, '{"code":"TF007","message":"x","details":"claim_consumed"}')))).toEqual({ ok: false, consumed: true, error: CLAIM_CONSUMED_NO_REFUND });
    expect(await authorizeClaimRefunded(...auth, rpcDeps(reply(400, '{"code":"TF007","message":"x","details":"claim_open"}')))).toMatchObject({ ok: false, notReleased: true });
    expect(await authorizeClaimRefunded(...auth, rpcDeps(reply(400, '{"code":"TF007","message":"x"}')))).toMatchObject({ ok: false, notReleased: true });
  });
  it('confirmClaimRefunded: com claim_consumed não libera nem tenta de novo; a trava fica', async () => {
    const ledger = await freshTab();
    const holds = await import('../lib/payments/reviewHolds');
    const { confirmClaimRefunded } = await import('../lib/payments/claimFlow');
    const { CLAIM_CONSUMED_NO_REFUND } = await import('../lib/payments/paymentClaim');
    const { useTcheStore } = await import('../store/useTcheStore');
    useTcheStore.setState({ cloud: { url: 'x' } } as never);
    ledger.beginLocalClaim('K-R', 'o1', TOKEN_A);
    ledger.settleLocalClaim('K-R');
    const hold = holds.setReviewHold({ order_id: 'o1', amount: 5, reason: 'recusado', code: 'PAYMENT_REJECTED', refund: 'TERMINAL', idempotency_key: 'K-R' });
    const calls: string[] = [];
    const r = await confirmClaimRefunded(hold, { managerPin: '1234', reason: 'conferido com o gerente' }, rpcDeps(reply(400, '{"code":"TF007","message":"x","details":"claim_consumed"}'), calls));
    expect(r).toEqual({ ok: false, error: CLAIM_CONSUMED_NO_REFUND });
    expect(calls).toEqual(['tchefood_authorize_claim_refunded']);
    expect(holds.getReviewHoldByKey('K-R')).not.toBeNull();
  });
});

describe('P3-1 (contrato): recusa da maquininha recusada com TF010 não para a conta', () => {
  const ORDER = '11111111-1111-4111-8111-111111111111';
  const ev = (id: string, table: SyncEvent['table'], op: SyncEvent['op'], payload: Record<string, unknown>): SyncEvent =>
    ({ id, table, op, row_id: `${id}-row`, payload: { order_id: ORDER, ...payload }, created_at: `2026-11-14T10:00:0${id.length % 10}Z` }) as SyncEvent;

  async function flush(events: SyncEvent[], code: string) {
    const { flushOutbox } = await import('../lib/sync/supabaseSync');
    const seen: string[] = [];
    const out = await flushOutbox(events, CFG, async (url, init) => {
      const body = String(init.body ?? '');
      seen.push(url);
      const refused = url.includes('register_payment') && body.includes('"status":"');
      return refused
        ? { ok: false, status: 400, text: async () => JSON.stringify({ code, message: 'não é da reserva' }) }
        : { ok: true, status: 201, text: async () => '[]' };
    });
    return { out, seen };
  }

  it('DECLINED fora do Mercado Pago com TF010: sai da fila e o evento seguinte da conta sobe', async () => {
    const declined = ev('e1', 'payments', 'INSERT', { status: 'DECLINED', acquirer: 'STONE', method: 'CREDIT', amount: 5 });
    const later = ev('e2', 'orders', 'UPDATE', { status: 'OPEN' });
    later.row_id = ORDER;
    const { out } = await flush([declined, later], 'TF010');
    expect(out.dropped?.map((d) => d.eventId)).toEqual(['e1']);
    expect(out.rejected).toEqual([]);
    expect(out.sent).toContain('e2');
  });

  it('APPROVED com TF010, ou DECLINED com outro código, continuam recusados e seguram a conta', async () => {
    const approved = ev('e3', 'payments', 'INSERT', { status: 'APPROVED', acquirer: 'STONE', method: 'CREDIT', amount: 5 });
    const later = ev('e4', 'orders', 'UPDATE', { status: 'OPEN' });
    later.row_id = ORDER;
    const a = await flush([approved, later], 'TF010');
    expect(a.out.rejected.map((r) => r.eventId)).toEqual(['e3']);
    expect(a.out.dropped).toBeUndefined();
    expect(a.out.sent).not.toContain('e4');
    const declined = ev('e5', 'payments', 'INSERT', { status: 'DECLINED', acquirer: 'STONE', method: 'CREDIT', amount: 5 });
    const b = await flush([declined], 'TF009');
    expect(b.out.rejected.map((r) => r.eventId)).toEqual(['e5']);
    const mp = ev('e6', 'payments', 'INSERT', { status: 'DECLINED', acquirer: 'MERCADO_PAGO', method: 'CREDIT', amount: 5 });
    const c = await flush([mp], 'TF010');
    expect(c.out.rejected.map((r) => r.eventId)).toEqual(['e6']);
  });
});

describe('P3-1 (cliente): resposta da Point sobre outra chave nunca decide esta cobrança', () => {
  const TERMINAL: PosTerminal = {
    id: '66666666-6666-4666-8666-666666666666', tenant_id: 't', name: 'Point', serial_number: 'SERIAL-1',
    acquirer: 'MERCADO_PAGO', mode: 'TEF_POS_WIRELESS', online: true, battery_level: null,
  };
  const REQ: ChargeRequest = { request_id: 'req-1', idempotency_key: 'MY-KEY', amount: 24.5, method: 'CREDIT', table_label: 'Mesa 1', order_id: 'o1', description: '' };

  it.each([
    ['DECLINED', { status: 'DECLINED', idempotency_key: 'OTHER', reason: 'cancelada' }],
    ['MANUAL_REVIEW', { status: 'MANUAL_REVIEW', idempotency_key: 'OTHER', reason: 'confira', code: 'X' }],
    ['PENDING', { status: 'PENDING', idempotency_key: 'OTHER' }],
  ])('%s de outra chave: revisão manual KEY_MISMATCH', async (_n, body) => {
    const { MercadoPagoPointDriver } = await import('../lib/payments/mercadoPagoPointDriver');
    let clock = 0;
    const driver = new MercadoPagoPointDriver('TEF_POS_WIRELESS', TERMINAL, {
      config: async () => CFG,
      fetch: async () => ({ status: 200, text: async () => JSON.stringify(body) }),
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
      timer: () => new Promise((r) => setTimeout(r, 0)),
      operator: async () => 'staff-1',
      prepareOrder: async () => ({ ok: true, balance_cents: 2450 }),
    });
    expect(await driver.charge(REQ)).toMatchObject({ status: 'MANUAL_REVIEW', failure_code: 'KEY_MISMATCH' });
  });

  it('resposta sem a chave não prova nada (parseChargeReply devolve null)', async () => {
    const { parseChargeReply } = await import('../lib/payments/mercadoPagoPointDriver');
    expect(parseChargeReply(JSON.stringify({ status: 'DECLINED', reason: 'x' }))).toBeNull();
    expect(parseChargeReply(JSON.stringify({ status: 'DECLINED', idempotency_key: 'K', reason: 'x' }))).toEqual({ status: 'DECLINED', idempotency_key: 'K', reason: 'x' });
  });
});
