// @vitest-environment jsdom
/**
 * Auditoria GPT r17 (PR #49), "a verificar" da leitura dos estornos feitos em outro aparelho:
 *  - duas abas do mesmo navegador: o ponto de leitura mora no mesmo estado que a conta (não no localStorage, que as
 *    abas dividem): uma aba não faz a outra pular um estorno que ela ainda não aplicou;
 *  - renovação da sessão: a resposta antiga de uma renovação não ressuscita uma sessão desconectada nem troca uma
 *    sessão nova (outro login da mesma loja);
 *  - pedido pendurado: um envio que nunca responde não segura a rodada, nem a leitura dos estornos, para sempre.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTcheStore } from '../store/useTcheStore';
import { clearReviewHold } from '../lib/payments/reviewHolds';
import { REQUEST_TIMEOUT_MS, freshCloudConfig, syncOnce } from '../lib/sync/useCloudSync';
import { pullRefundOrders } from '../lib/payments/refundOrdersPull';
import type { ClaimDeps } from '../lib/payments/paymentClaim';
import type { FetchLike } from '../lib/sync/supabaseSync';
import type { SyncEvent } from '../types';

const st = () => useTcheStore.getState();
const MANAGER = '8b0d3a52-4f1e-4c55-9a1e-0c2b7d9e1f00';
const WRITE_OFF = '3e5a7c9e-1a3c-4e5a-9c1e-6a8c0e2a4c6e';
const REFUND_AUDIT = '1c3e5a7b-9d2f-4b6a-8c0e-2a4b6c8d0e1f';
const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwt = (tenant: string, n = 0) => `h.${b64({ tenant_id: tenant, n })}.s`;
const NOW_S = () => Math.floor(Date.now() / 1000);
const cloudOf = (tenantId: string, over: Record<string, unknown> = {}) => ({ url: 'https://x.supabase.co', anon_key: 'anon', email: 'a@loja', access_token: jwt(tenantId), refresh_token: 'r1', expires_at: 9_999_999_999, tenant_id: tenantId, ...over });
const ok = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

function gate() {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((r) => { open = r; });
  return { wait, open };
}

/** Conta da loja atual, paga na Point e fechada (pagamento já no servidor). */
function closedPointOrder(key: string) {
  expect(st().login('1111').ok).toBe(true);
  const r = st().openTable(st().tables.find((t) => t.number === 1)!.id, 2, null);
  if (!r.ok) throw new Error(r.error);
  const orderId = r.data.id;
  const p = st().products.find((x) => x.code === '101')!;
  st().addToTray({ order_id: orderId, product_id: p.id, half_product_ids: [], quantity: 2, unit_price: p.price, modifiers: [], modifiers_unit_price: 0,
    meat_doneness: p.requires_meat_doneness ? 'Ao Ponto' : null, quick_tags: [], free_notes: '', sector: p.sector });
  st().dispatchTray(orderId);
  const order = st().orders.find((o) => o.id === orderId)!;
  const paid = st().registerPayment({
    orderId, amount: order.remaining_balance, method: 'CREDIT', status: 'APPROVED', terminal_id: null, acquirer: 'MERCADO_PAGO', acquirer_cnpj: '10573521000191',
    card_brand: 'VISA', nsu: `nsu-${key}`, authorization_code: 'A1', terminal_serial: 'N1', idempotency_key: key, item_ids: [],
  });
  if (!paid.ok) throw new Error(paid.error);
  useTcheStore.setState({ outbox: [] });
  return orderId;
}

/** O servidor: conta estornada e encerrada como venda devolvida em outro aparelho (alteração de sequência 9). */
function serverClosed(orderId: string) {
  const local = st().orders.find((o) => o.id === orderId)!;
  const pay = st().payments.find((p) => p.order_id === orderId)!;
  const now = new Date().toISOString();
  const cents = Math.round(local.total_amount * 100);
  const snapshot = {
    order: { ...local, status: 'CLOSED', paid_amount: 0, remaining_balance: local.total_amount },
    items: st().orderItems.filter((i) => i.order_id === orderId).map((i) => ({ ...i, is_paid: false })),
    payments: [{ ...pay, status: 'REFUNDED' }],
    audits: [
      { id: REFUND_AUDIT, order_id: orderId, performed_by_user_id: st().currentUserId, authorized_by_manager_id: MANAGER, action_type: 'POINT_PAYMENT_REFUNDED', amount_impact: 0,
        reason: 'venda estornada na maquininha', metadata: { order_reopened: true, payment_id: pay.id }, created_at: now },
      { id: WRITE_OFF, order_id: orderId, performed_by_user_id: st().currentUserId, authorized_by_manager_id: MANAGER, action_type: 'ORDER_REFUNDED_WRITE_OFF', amount_impact: local.total_amount,
        reason: 'cliente não vai pagar de novo', metadata: { written_off_cents: cents, cumulative_written_off_cents: cents, client_audit_id: 'outro' }, created_at: now },
    ],
  };
  const change = { order_id: orderId, status: 'CLOSED', remaining_balance: local.total_amount, last_seq: 9, last_audit_id: WRITE_OFF };
  /** Responde como o servidor: só as alterações depois do ponto pedido. */
  const rpc = (fn: string, body: string | undefined) => {
    if (fn === 'tchefood_list_refund_order_changes') {
      const after = Number((JSON.parse(body ?? '{}') as { p_after_seq?: number }).p_after_seq ?? 0);
      return ok(after >= 9 ? { items: [], next_seq: after, safe_seq: after, has_more: false } : { items: [change], next_seq: 9, safe_seq: 9, has_more: false });
    }
    if (fn === 'tchefood_list_refund_reopened_orders') return ok({ items: [], next_cursor: null });
    return ok(snapshot);
  };
  return { rpc, local, pay };
}

beforeEach(() => {
  localStorage.clear();
  st().resetDemo();
  for (const o of st().orders) clearReviewHold(o.id);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('GPT r17 (a verificar): duas abas do mesmo navegador dividem o localStorage, não a memória', () => {
  it('a aba A aplica o estorno e avança o ponto de leitura; a aba B (ainda sem a alteração) lê a mesma alteração e a aplica', async () => {
    const orderId = closedPointOrder('k-tabs');
    const tenant = st().tenant.id;
    useTcheStore.setState({ cloud: cloudOf(tenant) });
    const srv = serverClosed(orderId);
    const deps: ClaimDeps = {
      config: async () => ({ url: 'https://x.supabase.co', anonKey: 'anon', accessToken: jwt(tenant) }),
      fetch: (async (url: string, init: { body?: string }) => srv.rpc(url.split('/rpc/')[1]!, init.body)) as never,
      prepareOrder: async () => ({ ok: true }) as never, staff: async () => st().currentUserId, timer: () => new Promise<void>(() => undefined),
    };
    // A memória da aba B: o estado de antes de qualquer leitura.
    const tabB = st();
    const stateOfB = { orders: tabB.orders, payments: tabB.payments, auditLogs: tabB.auditLogs, orderItems: tabB.orderItems, pullStatus: tabB.pullStatus };
    // Aba A lê e aplica.
    expect((await pullRefundOrders(deps)).ok).toBe(true);
    expect(st().orders.find((o) => o.id === orderId)).toMatchObject({ status: 'CLOSED', paid_amount: 0 });
    // Aba B: outra memória (o estado antigo), o mesmo localStorage.
    useTcheStore.setState(stateOfB);
    expect(st().orders.find((o) => o.id === orderId)).toMatchObject({ status: 'CLOSED', paid_amount: srv.local.paid_amount });
    expect(st().payments.find((p) => p.id === srv.pay.id)!.status).not.toBe('REFUNDED');
    expect((await pullRefundOrders(deps)).ok).toBe(true);
    expect(st().payments.find((p) => p.id === srv.pay.id)!.status).toBe('REFUNDED');
    expect(st().auditLogs.some((l) => l.id === WRITE_OFF || l.metadata?.server_audit_id === WRITE_OFF)).toBe(true);
    // O ponto de leitura acompanha o estado: depois de aplicado, a próxima leitura não pede de novo.
    expect(st().pullStatus.refund_seq).toBe(9);
  });
});

describe('GPT r17 (a verificar): renovação da sessão e troca de sessão no meio', () => {
  const expiring = (tenant: string, over: Record<string, unknown> = {}) => cloudOf(tenant, { expires_at: NOW_S() + 30, ...over });
  const tokenReply = (tenant: string, n: number) => ok({ access_token: jwt(tenant, n), refresh_token: `r${n}`, expires_in: 3600 });

  it('desconectou durante a renovação: a resposta antiga não ressuscita a sessão (freshCloudConfig e a rodada do laço)', async () => {
    const tenant = st().tenant.id;
    for (const via of ['freshCloudConfig', 'syncOnce'] as const) {
      useTcheStore.setState({ cloud: expiring(tenant), outbox: [] });
      const hold = gate();
      const calls: string[] = [];
      const fetchFn: FetchLike = (async (url: string) => {
        calls.push(url);
        if (url.includes('/auth/v1/token')) {
          await hold.wait;
          return tokenReply(tenant, 2);
        }
        return ok([]);
      }) as never;
      const run = via === 'freshCloudConfig' ? freshCloudConfig(fetchFn) : syncOnce(fetchFn, { forcePull: true });
      await new Promise((r) => setTimeout(r, 10));
      useTcheStore.setState({ cloud: null });
      hold.open();
      const out = await run;
      expect(st().cloud, via).toBeNull();
      if (via === 'freshCloudConfig') expect(out, via).toBeNull();
      expect(calls.filter((u) => !u.includes('/auth/v1/token')), via).toEqual([]);
    }
  });

  it('outro login da mesma loja durante a renovação: a sessão nova fica como está e a rodada antiga não usa o token velho', async () => {
    const tenant = st().tenant.id;
    useTcheStore.setState({ cloud: expiring(tenant), outbox: [] });
    const hold = gate();
    const calls: string[] = [];
    const fetchFn: FetchLike = (async (url: string) => {
      calls.push(url);
      if (url.includes('/auth/v1/token')) {
        await hold.wait;
        return tokenReply(tenant, 2);
      }
      return ok([]);
    }) as never;
    const run = freshCloudConfig(fetchFn);
    await new Promise((r) => setTimeout(r, 10));
    const fresh = cloudOf(tenant, { email: 'outro@loja', access_token: jwt(tenant, 7), refresh_token: 'r7' });
    useTcheStore.setState({ cloud: fresh });
    hold.open();
    expect(await run).toBeNull();
    expect(st().cloud).toEqual(fresh);
  });

  it('o laço e a cobrança renovando juntos (mesmo refresh token): uma renovação só e as duas seguem com o token novo', async () => {
    const tenant = st().tenant.id;
    useTcheStore.setState({ cloud: expiring(tenant), outbox: [] });
    let renewals = 0;
    const fetchFn: FetchLike = (async (url: string) => {
      if (url.includes('/auth/v1/token')) {
        renewals += 1;
        await new Promise((r) => setTimeout(r, 10));
        return tokenReply(tenant, 2);
      }
      return ok([]);
    }) as never;
    const [a, b] = await Promise.all([freshCloudConfig(fetchFn), freshCloudConfig(fetchFn)]);
    expect(renewals).toBe(1);
    expect(a?.accessToken).toBe(jwt(tenant, 2));
    expect(b?.accessToken).toBe(jwt(tenant, 2));
    expect(st().cloud?.refresh_token).toBe('r2');
  });
});

describe('GPT r17 (a verificar): pedido pendurado não segura a rodada nem a leitura dos estornos para sempre', () => {
  it('o envio de um evento nunca responde: passado o prazo a rodada segue, lê os estornos e a próxima rodada pode começar', async () => {
    const orderId = closedPointOrder('k-hang');
    const tenant = st().tenant.id;
    const srv = serverClosed(orderId);
    const product = st().products[0]!;
    const stuck: SyncEvent = { id: crypto.randomUUID(), table: 'products', op: 'UPDATE', row_id: product.id, payload: { ...product } as never, created_at: new Date().toISOString() } as SyncEvent;
    useTcheStore.setState({ cloud: cloudOf(tenant), outbox: [stuck] });
    const seen: string[] = [];
    const fetchFn: FetchLike = (async (url: string, init: { body?: string }) => {
      if (url.includes('/rpc/')) {
        seen.push(url.split('/rpc/')[1]!);
        return srv.rpc(url.split('/rpc/')[1]!, init.body);
      }
      seen.push('envio');
      return new Promise(() => undefined); // nunca responde
    }) as never;
    const real = Date.now;
    vi.spyOn(Date, 'now').mockImplementation(() => real() + 61_000);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const round = syncOnce(fetchFn);
    await vi.advanceTimersByTimeAsync(10);
    expect(seen).toEqual(['envio']);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 10);
    await round;
    expect(seen).toContain('tchefood_list_refund_order_changes');
    expect(st().orders.find((o) => o.id === orderId)).toMatchObject({ status: 'CLOSED', paid_amount: 0 });
    // O evento continua na fila (tenta de novo) e a rodada seguinte não ficou presa.
    expect(st().outbox.map((e) => e.id)).toEqual([stuck.id]);
    expect(st().syncStatus.last_error).toMatch(/Sem conexão com a nuvem/);
    const again = syncOnce(fetchFn);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 10);
    await again;
    expect(seen.filter((s) => s === 'envio').length).toBe(2);
  });

  it('a renovação do token nunca responde: passado o prazo a rodada termina com erro e não fica presa', async () => {
    const tenant = st().tenant.id;
    useTcheStore.setState({ cloud: cloudOf(tenant, { expires_at: NOW_S() + 30 }), outbox: [] });
    let tries = 0;
    const fetchFn: FetchLike = (async (url: string) => {
      if (url.includes('/auth/v1/token')) {
        tries += 1;
        return new Promise(() => undefined);
      }
      return ok([]);
    }) as never;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const round = syncOnce(fetchFn, { forcePull: true });
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 10);
    await round;
    expect(tries).toBe(1);
    expect(st().syncStatus.last_error).toBeTruthy();
    const again = syncOnce(fetchFn, { forcePull: true });
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 10);
    await again;
    expect(tries).toBe(2);
  });
});
