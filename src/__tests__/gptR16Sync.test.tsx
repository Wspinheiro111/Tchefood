// @vitest-environment jsdom
/**
 * Auditoria GPT r16 (PR #49), sincronização dos estornos feitos em outro aparelho:
 *  - P0-01: troca de loja no meio de uma rodada (leitura dos cadastros falha, resposta antiga chega depois): nada da
 *    loja A entra no aparelho da loja B; o aplicador recusa conta, item, pagamento ou registro de outra loja;
 *  - P1-01: evento de outra coisa preso na fila não segura a leitura dos estornos;
 *  - P2-01: leitura parcial (estornos falham, lista de reabertas vem) é mostrada como falha, não como "servidor lido".
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTcheStore } from '../store/useTcheStore';
import { clearReviewHold } from '../lib/payments/reviewHolds';
import { syncOnce } from '../lib/sync/useCloudSync';
import { pullRefundOrders, pullScopeNow, syncOrderFromServer } from '../lib/payments/refundOrdersPull';
import { RefundReopenedOrders, READ_PARTIAL } from '../components/PointRefund';
import { keptSaleCents, writeOffsByOrder } from '../lib/reports';
import type { ClaimDeps } from '../lib/payments/paymentClaim';
import type { FetchLike } from '../lib/sync/supabaseSync';
import type { SyncEvent } from '../types';

const st = () => useTcheStore.getState();
const STORE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MANAGER = '8b0d3a52-4f1e-4c55-9a1e-0c2b7d9e1f00';
const REFUND_AUDIT = '1c3e5a7b-9d2f-4b6a-8c0e-2a4b6c8d0e1f';
const WRITE_OFF = '3e5a7c9e-1a3c-4e5a-9c1e-6a8c0e2a4c6e';
const cloudOf = (tenantId: string, email = 'a@loja') => ({ url: 'https://x.supabase.co', anon_key: 'anon', email, access_token: `jwt-${tenantId}`, refresh_token: 'r', expires_at: 9_999_999_999, tenant_id: tenantId });
const ok = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
const NO_CHANGES = { items: [], next_seq: 0, safe_seq: 0, has_more: false };

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

/** O que o servidor da loja A responde: a conta estornada (reaberta, ainda deve) e o retrato dela. */
function serverOfA(orderId: string, status: 'PAYING' | 'CLOSED' = 'PAYING') {
  const local = st().orders.find((o) => o.id === orderId)!;
  const pay = st().payments.find((p) => p.order_id === orderId)!;
  const now = new Date().toISOString();
  const audits: Record<string, unknown>[] = [{ id: REFUND_AUDIT, order_id: orderId, performed_by_user_id: st().currentUserId, authorized_by_manager_id: MANAGER, action_type: 'POINT_PAYMENT_REFUNDED', amount_impact: 0,
    reason: 'venda estornada na maquininha', metadata: { order_reopened: true, payment_id: pay.id }, created_at: now }];
  const cents = Math.round(local.total_amount * 100);
  if (status === 'CLOSED') {
    audits.push({ id: WRITE_OFF, order_id: orderId, performed_by_user_id: st().currentUserId, authorized_by_manager_id: MANAGER, action_type: 'ORDER_REFUNDED_WRITE_OFF', amount_impact: local.total_amount,
      reason: 'cliente não vai pagar de novo', metadata: { written_off_cents: cents, cumulative_written_off_cents: cents, client_audit_id: 'outro' }, created_at: now });
  }
  const snapshot = {
    order: { ...local, status, closed_at: status === 'CLOSED' ? local.closed_at : null, paid_amount: 0, remaining_balance: local.total_amount },
    items: st().orderItems.filter((i) => i.order_id === orderId).map((i) => ({ ...i, is_paid: false })),
    payments: [{ ...pay, status: 'REFUNDED' }],
    audits,
  };
  const reopened = status === 'PAYING' ? [{ order_id: orderId, table_id: local.table_id, status: 'PAYING', remaining_balance: local.total_amount, total_amount: local.total_amount, refunded_at: now }] : [];
  const changes = { items: [{ order_id: orderId, status, remaining_balance: local.total_amount, last_seq: 9, last_audit_id: status === 'CLOSED' ? WRITE_OFF : REFUND_AUDIT }], next_seq: 9, safe_seq: 9, has_more: false };
  const rpc = (fn: string) => (fn === 'tchefood_list_refund_order_changes' ? ok(changes) : fn === 'tchefood_list_refund_reopened_orders' ? ok({ items: reopened, next_cursor: null }) : ok(snapshot));
  return { snapshot, rpc, local, pay };
}

/** Troca a loja deste aparelho para a B (o que joinCloudStore faz: outra loja, outra sessão, sem as contas da A). */
function switchToStoreB() {
  useTcheStore.setState((s) => ({ tenant: { ...s.tenant, id: STORE_B }, cloud: cloudOf(STORE_B, 'b@loja'), orders: [], orderItems: [], payments: [], auditLogs: [], outbox: [], syncRejected: [], pullStatus: { last_pull_at: null, last_error: null, cloud_staff_unknown: 0 } }));
}
const nothingOfA = (orderId: string) => {
  expect(st().orders.some((o) => o.id === orderId)).toBe(false);
  expect(st().payments.some((p) => p.order_id === orderId)).toBe(false);
  expect(st().orderItems.some((i) => i.order_id === orderId)).toBe(false);
  expect(st().auditLogs.some((l) => l.order_id === orderId)).toBe(false);
  expect(st().pullStatus.refund_seq ?? 0).toBe(0);
};

beforeEach(() => {
  localStorage.clear();
  st().resetDemo();
  for (const o of st().orders) clearReviewHold(o.id);
});
afterEach(() => cleanup());

describe('GPT r16 P0-01: troca de loja durante a rodada de sincronização', () => {
  it('rodada começa na loja A, a leitura dos cadastros falha depois de o aparelho trocar para a loja B: nada da A é lido com a sessão antiga nem entra na B', async () => {
    const orderId = closedPointOrder('k-p0a');
    const tenantA = st().tenant.id;
    useTcheStore.setState({ cloud: cloudOf(tenantA) });
    const a = serverOfA(orderId);
    const hold = gate();
    const rpcCalls: string[] = [];
    const fetchFn: FetchLike = (async (url: string) => {
      if (url.includes('/rpc/')) {
        rpcCalls.push(url.split('/rpc/')[1]!);
        return a.rpc(url.split('/rpc/')[1]!);
      }
      // Leitura dos cadastros da loja A: fica no ar e depois falha.
      await hold.wait;
      throw new TypeError('Failed to fetch');
    }) as never;
    const round = syncOnce(fetchFn, { forcePull: true });
    await new Promise((r) => setTimeout(r, 20));
    switchToStoreB();
    hold.open();
    await round;
    expect(rpcCalls).toEqual([]);
    nothingOfA(orderId);
    expect(st().tenant.id).toBe(STORE_B);
  });

  it('resposta antiga da loja A chega depois da troca para a B (lista, alterações e retrato da conta): tudo descartado', async () => {
    const orderId = closedPointOrder('k-p0b');
    const tenantA = st().tenant.id;
    useTcheStore.setState({ cloud: cloudOf(tenantA) });
    const a = serverOfA(orderId);
    for (const lateOn of ['tchefood_list_refund_order_changes', 'tchefood_list_refund_reopened_orders', 'tchefood_order_snapshot']) {
      st().resetDemo();
      useTcheStore.setState({ cloud: cloudOf(tenantA), orders: [], orderItems: [], payments: [], auditLogs: [], outbox: [] });
      const hold = gate();
      const deps: ClaimDeps = {
        config: async () => ({ url: 'https://x.supabase.co', anonKey: 'anon', accessToken: `jwt-${tenantA}` }),
        fetch: (async (url: string) => {
          const fn = url.split('/rpc/')[1]!;
          if (fn === lateOn) await hold.wait;
          return a.rpc(fn);
        }) as never,
        prepareOrder: async () => ({ ok: true }) as never, staff: async () => st().currentUserId, timer: () => new Promise<void>(() => undefined),
      };
      const pull = pullRefundOrders(deps);
      await new Promise((r) => setTimeout(r, 20));
      switchToStoreB();
      hold.open();
      const out = await pull;
      expect(out, lateOn).toMatchObject({ ok: false, reopened: null });
      nothingOfA(orderId);
    }
    // Sem a troca, a mesma leitura traz a conta (o teste acima não passa por acaso).
    st().resetDemo();
    useTcheStore.setState({ cloud: cloudOf(tenantA), orders: [], orderItems: [], payments: [], auditLogs: [], outbox: [] });
    const deps: ClaimDeps = {
      config: async () => ({ url: 'https://x.supabase.co', anonKey: 'anon', accessToken: `jwt-${tenantA}` }), fetch: (async (url: string) => a.rpc(url.split('/rpc/')[1]!)) as never,
      prepareOrder: async () => ({ ok: true }) as never, staff: async () => st().currentUserId, timer: () => new Promise<void>(() => undefined),
    };
    localStorage.clear();
    expect((await pullRefundOrders(deps)).ok).toBe(true);
    expect(st().orders.find((o) => o.id === orderId)).toMatchObject({ status: 'PAYING' });
  });

  it('o aplicador recusa conta de outra loja, e item, pagamento ou registro de outra conta ou de outra loja; token de outra loja não lê nada', async () => {
    const orderId = closedPointOrder('k-p0c');
    const tenantA = st().tenant.id;
    const a = serverOfA(orderId);
    const before = { orders: st().orders, payments: st().payments, items: st().orderItems, logs: st().auditLogs };
    const same = () => {
      expect(st().orders).toBe(before.orders);
      expect(st().payments).toBe(before.payments);
      expect(st().orderItems).toBe(before.items);
      expect(st().auditLogs).toBe(before.logs);
    };
    const other = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const bad = [
      { ...a.snapshot, order: { ...a.snapshot.order, tenant_id: STORE_B } },
      { ...a.snapshot, order: { ...a.snapshot.order, tenant_id: undefined } },
      { ...a.snapshot, payments: [{ ...a.snapshot.payments[0]!, tenant_id: STORE_B }] },
      { ...a.snapshot, payments: [{ ...a.snapshot.payments[0]!, order_id: other }] },
      { ...a.snapshot, items: [{ ...a.snapshot.items[0]!, order_id: other }] },
      { ...a.snapshot, audits: [{ ...a.snapshot.audits[0]!, order_id: other }] },
    ];
    for (const snap of bad) {
      expect(st().applyServerOrderSnapshot(snap as never).ok).toBe(false);
      same();
    }
    // Sessão desta loja com token (JWT) de outra loja: nenhuma leitura.
    const jwt = (tenant: string) => `x.${btoa(JSON.stringify({ tenant_id: tenant })).replace(/=+$/, '')}.y`;
    useTcheStore.setState({ cloud: cloudOf(tenantA) });
    const calls: string[] = [];
    const deps = (token: string): ClaimDeps => ({
      config: async () => ({ url: 'https://x.supabase.co', anonKey: 'anon', accessToken: token }), fetch: (async (url: string) => { calls.push(url); return a.rpc(url.split('/rpc/')[1]!); }) as never,
      prepareOrder: async () => ({ ok: true }) as never, staff: async () => st().currentUserId, timer: () => new Promise<void>(() => undefined),
    });
    expect(await pullRefundOrders(deps(jwt(STORE_B)))).toMatchObject({ ok: false, reopened: null });
    expect(calls).toEqual([]);
    expect((await pullRefundOrders(deps(jwt(tenantA)))).ok).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
    // Retrato pedido numa loja e respondido depois da troca: nada aplicado.
    const hold = gate();
    const scope = pullScopeNow();
    const late = syncOrderFromServer(orderId, { ...deps(jwt(tenantA)), fetch: (async () => { await hold.wait; return ok(a.snapshot); }) as never }, scope);
    switchToStoreB();
    hold.open();
    expect(await late).toBe('failed');
    nothingOfA(orderId);
  });
});

describe('GPT r16 P1-01: evento de outra coisa preso na fila não segura a leitura dos estornos', () => {
  it('alteração de produto na fila com erro temporário: a conta estornada e encerrada no outro aparelho chega aqui e o evento continua na fila', async () => {
    const orderId = closedPointOrder('k-p1');
    const tenantA = st().tenant.id;
    const a = serverOfA(orderId, 'CLOSED');
    const product = st().products[0]!;
    const stuck: SyncEvent = { id: crypto.randomUUID(), table: 'products', op: 'UPDATE', row_id: product.id, payload: { ...product } as never, created_at: new Date().toISOString() } as SyncEvent;
    useTcheStore.setState({ cloud: cloudOf(tenantA), outbox: [stuck], pullStatus: { last_pull_at: new Date(Date.now() + 61_000).toISOString(), last_error: null, cloud_staff_unknown: 0 } });
    const total = Math.round(a.local.total_amount * 100);
    expect(keptSaleCents(st().orders.find((o) => o.id === orderId)!, writeOffsByOrder(st().auditLogs)).keptCents).toBe(total);
    const seen: string[] = [];
    const fetchFn: FetchLike = (async (url: string) => {
      if (url.includes('/rpc/')) {
        seen.push(url.split('/rpc/')[1]!);
        return a.rpc(url.split('/rpc/')[1]!);
      }
      seen.push('rest');
      // O envio do produto: erro temporário do servidor.
      return { ok: false, status: 503, text: async () => 'indisponível' };
    }) as never;
    // Rodada normal do laço (sem forçar), com a leitura dos cadastros fora de hora e a dos estornos na hora.
    const real = Date.now;
    const later = vi.spyOn(Date, 'now').mockImplementation(() => real() + 61_000);
    try {
      await syncOnce(fetchFn);
    } finally {
      later.mockRestore();
    }
    expect(st().outbox.map((e) => e.id)).toEqual([stuck.id]);
    expect(seen).toContain('tchefood_list_refund_order_changes');
    const after = st().orders.find((o) => o.id === orderId)!;
    expect(after).toMatchObject({ status: 'CLOSED', paid_amount: 0, remaining_balance: a.local.total_amount });
    expect(st().payments.find((p) => p.id === a.pay.id)!.status).toBe('REFUNDED');
    expect(keptSaleCents(after, writeOffsByOrder(st().auditLogs))).toMatchObject({ keptCents: 0, writtenOff: true });
    // A conta com alteração DELA na fila continua protegida: não é sobrescrita.
    const mine: SyncEvent = { id: crypto.randomUUID(), table: 'orders', op: 'UPDATE', row_id: orderId, payload: { id: orderId } as never, created_at: new Date().toISOString() } as SyncEvent;
    useTcheStore.setState((s) => ({ outbox: [stuck, mine], orders: s.orders.map((o) => (o.id === orderId ? { ...o, remaining_balance: 1 } : o)) }));
    localStorage.clear();
    await syncOnce(fetchFn, { forcePull: true });
    expect(st().orders.find((o) => o.id === orderId)!.remaining_balance).toBe(1);
  });
});

describe('GPT r16 P2-01: leitura parcial dos estornos não aparece como servidor lido', () => {
  it('alterações com HTTP 500 e lista de reabertas vazia: a tela avisa a falha e não mostra a hora de leitura', async () => {
    const tenantA = st().tenant.id;
    useTcheStore.setState({ cloud: cloudOf(tenantA) });
    let changesFail = true;
    const deps: ClaimDeps = {
      config: async () => ({ url: 'https://x.supabase.co', anonKey: 'anon', accessToken: 'jwt' }),
      fetch: (async (url: string) => {
        const fn = url.split('/rpc/')[1]!;
        if (fn === 'tchefood_list_refund_order_changes') return changesFail ? { ok: false, status: 500, text: async () => 'erro' } : ok(NO_CHANGES);
        return ok({ items: [], next_cursor: null });
      }) as never,
      prepareOrder: async () => ({ ok: true }) as never, staff: async () => st().currentUserId, timer: () => new Promise<void>(() => undefined),
    };
    expect(await pullRefundOrders(deps)).toMatchObject({ ok: false, changesOk: false, reopened: [] });
    // No laço da nuvem a mesma falha fica registrada no estado da nuvem.
    await syncOnce(deps.fetch as never, { forcePull: true });
    expect(st().pullStatus?.last_error ?? '').toMatch(/estornos e encerramentos/);
    render(<RefundReopenedOrders deps={deps} />);
    const note = await screen.findByTestId('reopened-read-failed');
    expect(note.textContent).toContain(READ_PARTIAL);
    expect(screen.queryByText(/Servidor lido às/)).toBeNull();
    // Com as duas leituras funcionando e nada pendente, não há aviso.
    cleanup();
    changesFail = false;
    render(<RefundReopenedOrders deps={deps} />);
    await waitFor(() => expect(screen.queryByTestId('reopened-read-failed')).toBeNull());
  });

  it('com conta reaberta na lista e as alterações falhando: a conta aparece, com o aviso de leitura parcial no lugar de "Servidor lido"', async () => {
    const orderId = closedPointOrder('k-p2');
    const tenantA = st().tenant.id;
    const a = serverOfA(orderId);
    useTcheStore.setState({ cloud: cloudOf(tenantA) });
    const deps: ClaimDeps = {
      config: async () => ({ url: 'https://x.supabase.co', anonKey: 'anon', accessToken: 'jwt' }),
      fetch: (async (url: string) => {
        const fn = url.split('/rpc/')[1]!;
        return fn === 'tchefood_list_refund_order_changes' ? { ok: false, status: 500, text: async () => 'erro' } : a.rpc(fn);
      }) as never,
      prepareOrder: async () => ({ ok: true }) as never, staff: async () => st().currentUserId, timer: () => new Promise<void>(() => undefined),
    };
    render(<RefundReopenedOrders deps={deps} />);
    await screen.findByRole('button', { name: 'Encerrar como venda devolvida' });
    expect((await screen.findByTestId('reopened-read-failed')).textContent).toContain(READ_PARTIAL);
    expect(screen.queryByText(/Servidor lido às/)).toBeNull();
  });
});
