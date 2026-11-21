/**
 * GPT r30 (P2-01 do PR #54): as proteções financeiras do estado do armazenamento precisam de teste próprio.
 * Com o aparelho sem permissão de gravar (readonly: outra janela escreve) ou com a hidratação provisória
 * (blocked), nenhuma rotina que age sobre a nuvem pode agir:
 *   - startRound (por ensureOrderSynced, que não passa por syncOnce): não sobe a fila;
 *   - superviseSettledClaims: não renova nem retira reserva, nem mexe no pagamento;
 *   - retryPendingClaimReleases: não chama a RPC e mantém a pendência.
 * Cada teste tem o controle "armazenamento ok" que prova que, sem a proteção, a rotina agiria: tirar a
 * proteção do código faz o teste do estado bloqueado falhar.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const refundPull = vi.hoisted(() => vi.fn(async () => ({ changesOk: true, reopened: true })));
vi.mock('../lib/payments/refundOrdersPull', async (orig) => {
  const actual = await orig<typeof import('../lib/payments/refundOrdersPull')>();
  return { ...actual, sameScope: () => true, pullRefundOrders: refundPull };
});

const mockStatus = vi.hoisted(() => ({ value: 'ok' as 'ok' | 'readonly' | 'blocked' }));
vi.mock('../lib/idbStorage', async (orig) => {
  const actual = await orig<typeof import('../lib/idbStorage')>();
  return { ...actual, getStorageStatus: () => mockStatus.value };
});

import { beginLocalClaim, localClaim, pendingRelease, pendingReleases, resetClaimLedger, settleLocalClaim } from '../lib/payments/claimLedger';
import { resetClaimSupervisor, superviseSettledClaims, type SupervisorDeps } from '../lib/payments/claimSupervisor';
import { releaseClaimAfterNoCharge, retryPendingClaimReleases, type ClaimDeps } from '../lib/payments/paymentClaim';
import { ensureOrderSynced, syncOnce } from '../lib/sync/useCloudSync';
import { useTcheStore, type CloudSession } from '../store/useTcheStore';
import type { FetchLike } from '../lib/sync/supabaseSync';
import type { Order, Payment, SyncEvent } from '../types';

const st = () => useTcheStore.getState();
const BLOCKED = ['readonly', 'blocked'] as const;
const ORDER_ID = '7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a';
const TOKEN = 'cd'.repeat(32);

beforeEach(() => {
  mockStatus.value = 'ok';
  refundPull.mockClear();
  resetClaimLedger();
  resetClaimSupervisor();
});

describe('startRound (por ensureOrderSynced): sem permissão de gravar, não sobe a fila', () => {
  const session = (): CloudSession => ({
    url: 'https://x.supabase.co', anon_key: 'anon', email: 'a@b', access_token: 'jwt', refresh_token: 'r', expires_at: 9e9, tenant_id: st().tenant.id,
  });
  const event = (): SyncEvent => ({ id: 'e1', table: 'orders', op: 'UPDATE', row_id: ORDER_ID, payload: { id: ORDER_ID, remaining_balance: 80 }, created_at: new Date().toISOString() });
  function setup() {
    st().resetDemo();
    const base = (st().orders[0] ?? {}) as Order;
    const order = { ...base, id: ORDER_ID, tenant_id: st().tenant.id, status: 'OPEN', remaining_balance: 80 } as Order;
    useTcheStore.setState({ cloud: session(), outbox: [event()], syncRejected: [], orders: [order, ...st().orders], pullStatus: { last_pull_at: new Date().toISOString() } as never });
    const calls: string[] = [];
    const fetchFn: FetchLike = async (url, init) => {
      calls.push(`${init.method} ${url}`);
      return { ok: true, status: 200, text: async () => '[{"id":"x"}]' };
    };
    return { calls, fetchFn };
  }

  it('controle: com o armazenamento ok, a conta com evento na fila sobe', async () => {
    const { calls, fetchFn } = setup();
    expect(await ensureOrderSynced(ORDER_ID, fetchFn)).toMatchObject({ ok: true });
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(st().outbox).toHaveLength(0);
  });

  it.each(BLOCKED)('%s: nenhuma chamada à nuvem, a fila continua e a cobrança não é liberada', async (status) => {
    const { calls, fetchFn } = setup();
    mockStatus.value = status;
    const r = await ensureOrderSynced(ORDER_ID, fetchFn);
    expect(r.ok).toBe(false);
    expect(calls).toEqual([]);
    expect(st().outbox).toHaveLength(1);
  });
});

describe('superviseSettledClaims: sem permissão de gravar, não renova nem retira', () => {
  const pay = (key: string): Payment => ({
    id: `p-${key}`, idempotency_key: key, status: 'APPROVED', amount: 12, method: 'CREDIT', acquirer: 'STONE', terminal_id: null, terminal_serial: 'S1',
  } as unknown as Payment);
  function deps() {
    const withdrawn: Array<[string, string]> = [];
    const alerts: string[] = [];
    const d: SupervisorDeps = {
      touch: vi.fn(async () => ({ ok: true as const, status: 'open' as const, activeUntil: null })),
      payments: () => [pay('k-1')],
      unpushed: () => true,
      rejected: () => 'recusado pelo servidor',
      withdraw: (k, r) => { withdrawn.push([k, r]); return { nfceIssued: false }; },
      hold: () => null,
      setHold: vi.fn(),
      alert: (t) => void alerts.push(t),
      openClaimKeys: vi.fn(async () => new Set<string>()),
    };
    return { d, withdrawn, alerts };
  }
  const settled = () => {
    beginLocalClaim('k-1', 'o1', TOKEN);
    settleLocalClaim('k-1');
  };

  it('controle: com o armazenamento ok, o pagamento recusado pelo servidor é retirado', async () => {
    settled();
    const { d, withdrawn } = deps();
    await superviseSettledClaims(d, 1_000_000);
    expect(withdrawn).toHaveLength(1);
  });

  it.each(BLOCKED)('%s: não chama touch, não retira pagamento, não alerta e o registro fica', async (status) => {
    settled();
    mockStatus.value = status;
    const { d, withdrawn, alerts } = deps();
    expect(await superviseSettledClaims(d, 1_000_000, true)).toBe(0);
    expect(d.touch).not.toHaveBeenCalled();
    expect(d.openClaimKeys).not.toHaveBeenCalled();
    expect(withdrawn).toEqual([]);
    expect(alerts).toEqual([]);
    expect(localClaim('k-1')).not.toBeNull();
  });
});

describe('retryPendingClaimReleases: sem permissão de gravar, não chama a RPC e mantém a pendência', () => {
  const cfg = { url: 'https://x.supabase.co/', anonKey: 'anon', accessToken: 'jwt' };
  function deps(fail: boolean) {
    const calls: string[] = [];
    const d: ClaimDeps = {
      config: async () => cfg,
      fetch: async (url, init) => {
        calls.push(url);
        if (fail) throw new Error('rede');
        return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'released', idempotency_key: (JSON.parse(init.body ?? '{}') as { p_key?: string }).p_key }) };
      },
      prepareOrder: async () => ({ ok: true, balance_cents: 8000 }),
      staff: async () => 'staff-1',
      timer: () => new Promise<void>(() => undefined),
      sleep: async () => undefined,
    };
    return { d, calls };
  }
  async function pending() {
    await releaseClaimAfterNoCharge('k-9', 'o1', 'recusou', 'tok-9', deps(true).d);
    expect(pendingRelease('k-9')).not.toBeNull();
  }

  it('controle: com o armazenamento ok, a pendência é liberada pela RPC', async () => {
    await pending();
    const ok = deps(false);
    expect(await retryPendingClaimReleases(ok.d, 3_000_000, true)).toBe(1);
    expect(ok.calls.length).toBeGreaterThanOrEqual(1);
    expect(pendingReleases()).toEqual([]);
  });

  it.each(BLOCKED)('%s: não chama a RPC e a pendência continua', async (status) => {
    await pending();
    mockStatus.value = status;
    const ok = deps(false);
    expect(await retryPendingClaimReleases(ok.d, 3_000_000, true)).toBe(0);
    expect(ok.calls).toEqual([]);
    expect(pendingReleases()).toHaveLength(1);
    expect(pendingRelease('k-9')).toMatchObject({ release_token: 'tok-9' });
  });
});

describe('rodada já em andamento quando o armazenamento passa a bloqueado (a verificar 3 da GPT r30)', () => {
  const session = (): CloudSession => ({
    url: 'https://x.supabase.co', anon_key: 'anon', email: 'a@b', access_token: 'jwt', refresh_token: 'r', expires_at: 9e9, tenant_id: st().tenant.id,
  });
  const event = (): SyncEvent => ({ id: 'e1', table: 'orders', op: 'UPDATE', row_id: ORDER_ID, payload: { id: ORDER_ID, remaining_balance: 80 }, created_at: new Date().toISOString() });

  /** O primeiro envio fica preso até `release()`: o estado do armazenamento muda com a rodada no meio da chamada. */
  async function roundWithStatusChange(after: 'ok' | 'readonly' | 'blocked') {
    st().resetDemo();
    const base = (st().orders[0] ?? {}) as Order;
    useTcheStore.setState({
      cloud: session(), outbox: [event()], syncRejected: [], orders: [{ ...base, id: ORDER_ID, tenant_id: st().tenant.id, status: 'OPEN', remaining_balance: 80 } as Order, ...st().orders],
    });
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => { release = r; });
    let first = true;
    const calls: string[] = [];
    const fetchFn: FetchLike = async (url, init) => {
      calls.push(`${init.method} ${url}`);
      if (first) {
        first = false;
        await held;
      }
      return { ok: true, status: 200, text: async () => '[{"id":"x"}]' };
    };
    const round = syncOnce(fetchFn, { forcePull: true });
    await vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(1));
    mockStatus.value = after;
    release();
    await round;
    return calls;
  }

  it('controle: com o armazenamento ok até o fim, a rodada segue e lê os estornos', async () => {
    await roundWithStatusChange('ok');
    expect(refundPull).toHaveBeenCalled();
  });

  it.each(BLOCKED)('%s no meio da chamada de envio: a rodada para antes das próximas etapas (estornos, NFC-e)', async (status) => {
    const calls = await roundWithStatusChange(status);
    expect(calls.length).toBeGreaterThanOrEqual(1); // o envio que já estava no ar terminou (idempotente pelo id do evento)
    expect(refundPull).not.toHaveBeenCalled();
  });
});
