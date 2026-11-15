// @vitest-environment jsdom
/**
 * Auditoria GPT r10 (PR #49), lado do aparelho:
 *  - P1-02: estorno de pagamento da Point lido do servidor (lista paginada, busca, período, sem limite de dias),
 *    mais os deste aparelho que ainda não subiram; estorno de pagamento que este aparelho não tem;
 *  - P1-01: a conta fechada reabre com o estorno; cobrar de novo ou encerrar como venda devolvida (PIN do gerente);
 *  - a verificar 4: o registro local do estorno leva o registro do servidor e o gerente que autorizou;
 *  - a verificar 3: pagamento por itens, estorno de um deles e cobrança nova não contam o mesmo item duas vezes.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NFCE_ALREADY_ISSUED, useTcheStore } from '../store/useTcheStore';
import { clearReviewHold } from '../lib/payments/reviewHolds';
import { computeItemsShare } from '../lib/money';
import { closeRefundedOrder, listPointPayments, listRefundReopenedOrders, type ServerPointPayment } from '../lib/payments/pointPaymentsServer';
import type { ClaimDeps } from '../lib/payments/paymentClaim';
import { refundPointPayment, type ReconcileDeps } from '../lib/payments/pointReconcile';
import { PointRefunds, RefundReopenedOrders, isRefundReopenedOrder, submitPointRefund, submitRefundedWriteOff } from '../components/PointRefund';
import { currentShiftPeriod, keptSaleCents, reconciliation, shiftKpis, waiterSplit } from '../lib/reports';
import { indexDashboard, salesCents } from '../lib/ownerDashboard';
import type { OrderItem, Payment } from '../types';

const st = () => useTcheStore.getState();
const CFG = { url: 'https://x.supabase.co', anonKey: 'anon', accessToken: 'jwt' };
const MANAGER = '8b0d3a52-4f1e-4c55-9a1e-0c2b7d9e1f00';
const REFUND_AUDIT = '1c3e5a7b-9d2f-4b6a-8c0e-2a4b6c8d0e1f';
const AUTH_AUDIT = '2d4f6a8c-0e2a-4c6e-8a0c-4e6a8c0e2a4c';
const SERVER_WRITE_OFF = '3e5a7c9e-1a3c-4e5a-9c1e-6a8c0e2a4c6e';
const CLOUD = { url: 'https://x.supabase.co', anon_key: 'anon', email: 'a@b', access_token: 'jwt', refresh_token: 'r', expires_at: 9_999_999_999, tenant_id: 't' };

type Reply = { status: number; body: unknown } | 'network';
const NO_CHANGES = { status: 200, body: { items: [], next_seq: 0, safe_seq: 0, has_more: false } };
/** ClaimDeps de PostgREST falso: cada chamada grava função e corpo; `answer` decide a resposta. */
function rpcDeps(answer: (fn: string, body: Record<string, unknown>) => Reply) {
  const calls: { fn: string; body: Record<string, unknown> }[] = [];
  const d: ClaimDeps = {
    config: async () => CFG,
    fetch: (async (url: string, init: { body: string }) => {
      const fn = url.split('/rpc/')[1]!;
      const body = JSON.parse(init.body) as Record<string, unknown>;
      calls.push({ fn, body });
      const a = answer(fn, body);
      if (a === 'network') throw new Error('rede');
      return { ok: a.status < 300, status: a.status, text: async () => (typeof a.body === 'string' ? a.body : JSON.stringify(a.body)) };
    }) as never,
    prepareOrder: async () => ({ ok: true }) as never,
    staff: async () => st().currentUserId,
    timer: () => new Promise<void>(() => undefined),
  };
  return { d, calls };
}

function refundDeps(extra: Record<string, unknown> = {}): ReconcileDeps {
  return {
    config: async () => CFG,
    fetch: (async (_u: string, init: { body: string }) => {
      const key = (JSON.parse(init.body) as { idempotency_key: string }).idempotency_key;
      return { status: 200, text: async () => JSON.stringify({ status: 'DECLINED', code: 'REFUNDED', idempotency_key: key, reason: 'estornada', ...extra }) };
    }) as never,
    timer: () => new Promise(() => undefined),
  } as ReconcileDeps;
}

const row = (id: string, over: Partial<ServerPointPayment> = {}): ServerPointPayment => ({
  payment_id: `p-${id}`, order_id: `o-${id}`, charge_id: `c-${id}`, idempotency_key: `k-${id}`, amount: 50, method: 'CREDIT', nsu: `NSU${id}`,
  authorization_code: 'A1', status: 'APPROVED', created_at: '2026-11-10T15:00:00.000Z', refunded_at: null, refund_audit_id: null, refunded_by_manager_id: null, ...over,
});

function openWithItems(lines: [string, number][] = [['101', 2]]) {
  expect(st().login('1111').ok).toBe(true);
  const r = st().openTable(st().tables.find((t) => t.number === 1)!.id, 2, null);
  if (!r.ok) throw new Error(r.error);
  const orderId = r.data.id;
  for (const [code, q] of lines) {
    const p = st().products.find((x) => x.code === code)!;
    st().addToTray({ order_id: orderId, product_id: p.id, half_product_ids: [], quantity: q, unit_price: p.price, modifiers: [], modifiers_unit_price: 0,
      meat_doneness: p.requires_meat_doneness ? 'Ao Ponto' : null, quick_tags: [], free_notes: '', sector: p.sector });
  }
  st().dispatchTray(orderId);
  return orderId;
}

function payPoint(orderId: string, amount: number, key: string, itemIds: string[] = []) {
  const r = st().registerPayment({
    orderId, amount, method: 'CREDIT', status: 'APPROVED', terminal_id: null, acquirer: 'MERCADO_PAGO', acquirer_cnpj: '10573521000191',
    card_brand: 'VISA', nsu: `nsu-${key}`, authorization_code: 'A1', terminal_serial: 'N1', idempotency_key: key, item_ids: itemIds,
  });
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

/** Conta fechada com um pagamento da Point (já no servidor), estornada e reaberta. */
async function reopenedOrder() {
  const orderId = openWithItems();
  const order = st().orders.find((o) => o.id === orderId)!;
  payPoint(orderId, order.remaining_balance, 'k-closed');
  useTcheStore.setState({ outbox: [] });
  expect(st().orders.find((o) => o.id === orderId)!.status).toBe('CLOSED');
  const r = await submitPointRefund(st().payments.find((p) => p.idempotency_key === 'k-closed')!, '9999', 'venda estornada na maquininha', refundDeps({ payment_registered: true }));
  expect(r.ok).toBe(true);
  return orderId;
}

beforeEach(() => {
  st().resetDemo();
  for (const o of st().orders) clearReviewHold(o.id);
});
afterEach(() => cleanup());

describe('P1-02: listPointPayments (tchefood_list_point_payments)', () => {
  it('manda período, busca, cursor e página; devolve as linhas e o próximo cursor', async () => {
    const { d, calls } = rpcDeps(() => ({ status: 200, body: { items: [row('a')], next_cursor: '2026-11-10T15:00:00Z|p-a' } }));
    const out = await listPointPayments({ from: '2026-11-01T03:00:00.000Z', to: null, search: ' 12,50 ', cursor: 'c1' }, d);
    expect(out).toEqual({ kind: 'ok', items: [row('a')], nextCursor: '2026-11-10T15:00:00Z|p-a' });
    expect(calls).toEqual([{ fn: 'tchefood_list_point_payments', body: { p_from: '2026-11-01T03:00:00.000Z', p_to: null, p_search: '12,50', p_cursor: 'c1', p_limit: 50 } }]);
  });

  it('linha sem chave ou valor, resposta sem items, recusa ou sem rede: erro (nunca uma lista pela metade)', async () => {
    for (const reply of [
      { status: 200, body: { items: [row('a'), { ...row('b'), idempotency_key: null }], next_cursor: null } },
      { status: 200, body: { items: [{ ...row('b'), amount: 'x' }], next_cursor: null } },
      { status: 200, body: { next_cursor: null } },
      { status: 400, body: { code: 'TF006', message: 'cursor inválido' } },
    ] as Reply[]) {
      expect((await listPointPayments({ from: null, to: null, search: null, cursor: null }, rpcDeps(() => reply).d)).kind).toBe('error');
    }
    expect((await listPointPayments({ from: null, to: null, search: null, cursor: null }, rpcDeps(() => 'network').d)).kind).toBe('error');
  });
});

describe('P1-02: PointRefunds com a nuvem', () => {
  const localPayment = (id: string, over: Partial<Payment> = {}): Payment => ({
    id, order_id: 'o-local', amount: 30, method: 'CREDIT', status: 'APPROVED', terminal_id: null, acquirer: 'MERCADO_PAGO', acquirer_cnpj: '10573521000191',
    card_brand: 'VISA', nsu: `NSU${id}`, authorization_code: 'A1', terminal_serial: 'N1', idempotency_key: `k-${id}`, item_ids: [],
    created_at: '2026-11-14T15:00:00.000Z', ...over,
  } as Payment);

  it('lista do servidor (sem limite de dias), "Carregar mais", busca e período vão ao servidor; os não enviados daqui aparecem com "ainda não subiu"', async () => {
    const pages: Record<string, unknown> = {
      first: { items: [row('novo', { created_at: '2026-11-12T15:00:00.000Z' }), row('estornado', { status: 'REFUNDED', refunded_at: '2026-11-13T12:00:00.000Z' })], next_cursor: 'cur-2' },
      second: { items: [row('meses', { created_at: '2026-06-01T15:00:00.000Z' })], next_cursor: null },
      search: { items: [row('achado')], next_cursor: null },
    };
    const { d, calls } = rpcDeps((_fn, body) => ({ status: 200, body: body.p_search ? pages.search : body.p_cursor ? pages.second : pages.first }));
    // Um pagamento daqui ainda na fila (não subiu) e outro já enviado (vem do servidor: não aparece em dobro).
    const pending = localPayment('fila');
    const uploaded = localPayment('subiu', { idempotency_key: 'k-novo' });
    useTcheStore.setState({ cloud: CLOUD, outbox: [{ id: 'e1', table: 'payments', op: 'INSERT', row_id: 'fila', payload: {}, created_at: '2026-11-14T15:00:00.000Z' } as never] });
    // Já enviado e fora desta página do servidor: vem do servidor quando a busca o achar, nunca como "ainda não subiu".
    const uploadedOld = localPayment('antigo');
    render(<PointRefunds payments={[pending, uploaded, uploadedOld]} listDeps={d} />);
    await screen.findByText(/NSUnovo/);
    expect(screen.queryByText(/NSUantigo/)).toBeNull();
    expect(screen.getByText(/NSUfila/).textContent).toMatch(/ainda não subiu/);
    expect(screen.queryByText(/NSUsubiu/)).toBeNull();
    // Estornado no servidor: sem botão, com a hora do estorno.
    const refundedRow = screen.getByText(/NSUestornado/).closest('div')!;
    expect(within(refundedRow).queryByRole('button', { name: 'Registrar estorno' })).toBeNull();
    expect(refundedRow.textContent).toMatch(/estornado em/);
    expect(screen.getAllByRole('button', { name: 'Registrar estorno' })).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }));
    await screen.findByText(/NSUmeses/);
    expect(screen.getByText(/NSUnovo/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Carregar mais' })).toBeNull();
    expect(calls[1]!.body).toMatchObject({ p_cursor: 'cur-2', p_from: null, p_to: null });

    fireEvent.change(screen.getByLabelText(/^De$/), { target: { value: '2026-11-01' } });
    fireEvent.change(screen.getByLabelText(/^Até$/), { target: { value: '2026-11-15' } });
    fireEvent.change(screen.getByLabelText(/Buscar/), { target: { value: 'achado' } });
    fireEvent.click(screen.getByRole('button', { name: 'Buscar' }));
    await screen.findByText(/NSUachado/);
    expect(calls[2]!.body).toEqual({ p_from: '2026-11-01T03:00:00.000Z', p_to: '2026-11-16T03:00:00.000Z', p_search: 'achado', p_cursor: null, p_limit: 50 });
    expect(screen.queryByText(/NSUmeses/)).toBeNull();
  });

  it('erro do servidor aparece; os não enviados daqui seguem na lista', async () => {
    const { d } = rpcDeps(() => 'network');
    useTcheStore.setState({ cloud: CLOUD, outbox: [{ id: 'e1', table: 'payments', op: 'INSERT', row_id: 'fila', payload: {}, created_at: '2026-11-14T15:00:00.000Z' } as never] });
    render(<PointRefunds payments={[localPayment('fila')]} listDeps={d} />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/servidor/);
    expect(screen.getByText(/NSUfila/).textContent).toMatch(/ainda não subiu/);
  });
});

describe('P1-02: estorno de pagamento que este aparelho não tem', () => {
  it('com a chave da linha do servidor: o pedido vai ao servidor e nada muda aqui', async () => {
    expect(st().login('1111').ok).toBe(true);
    const sent: unknown[] = [];
    const deps = refundDeps({ refund_audit_id: REFUND_AUDIT, manager_id: MANAGER });
    const realFetch = deps.fetch;
    deps.fetch = (async (u: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body));
      return realFetch(u, init as never);
    }) as never;
    const before = { payments: st().payments, orders: st().orders, logs: st().auditLogs, outbox: st().outbox };
    const r = await submitPointRefund({ idempotency_key: 'k-remote', order_id: 'o-remote', amount: 50 }, '9999', 'venda estornada no app do MP', deps);
    expect(r).toEqual({ ok: true, data: { nfceIssued: false, itemsStayPaid: false, reopened: false, mirrored: false } });
    expect(sent).toEqual([expect.objectContaining({ action: 'refund', idempotency_key: 'k-remote' })]);
    expect(st().payments).toBe(before.payments);
    expect(st().orders).toBe(before.orders);
    expect(st().auditLogs).toBe(before.logs);
    expect(st().outbox).toBe(before.outbox);
  });
});

describe('GPT a verificar 4: o registro local do estorno leva o do servidor e o gerente', () => {
  it('refundPointPayment lê refund_audit_id, authorization_audit_id, manager_id e order_reopened (UUID e booleano; outro valor é ignorado)', async () => {
    const input = { idempotency_key: 'k1', staff_id: 's', manager_pin: '9999', reason_text: 'venda estornada na maquininha' };
    expect(await refundPointPayment(input, refundDeps({ refund_audit_id: REFUND_AUDIT, authorization_audit_id: AUTH_AUDIT, manager_id: MANAGER, order_reopened: true })))
      .toEqual({ kind: 'refunded', serverAuditId: REFUND_AUDIT, authorizationAuditId: AUTH_AUDIT, managerId: MANAGER, orderReopened: true });
    expect(await refundPointPayment(input, refundDeps({ refund_audit_id: 'x', authorization_audit_id: 3, manager_id: '', order_reopened: 'sim' }))).toEqual({ kind: 'refunded' });
  });

  it('POINT_PAYMENT_REFUNDED local: mesmo id do registro do servidor, gerente que autorizou e o registro da autorização', async () => {
    const orderId = openWithItems();
    payPoint(orderId, 10, 'k-log');
    const r = await submitPointRefund(st().payments.find((p) => p.idempotency_key === 'k-log')!, '9999', 'venda estornada na maquininha',
      refundDeps({ payment_registered: true, refund_audit_id: REFUND_AUDIT, authorization_audit_id: AUTH_AUDIT, manager_id: MANAGER }));
    expect(r.ok).toBe(true);
    const log = st().auditLogs.find((l) => l.action_type === 'POINT_PAYMENT_REFUNDED')!;
    expect(log).toMatchObject({ id: REFUND_AUDIT, authorized_by_manager_id: MANAGER, metadata: { server_audit_id: REFUND_AUDIT, authorization_audit_id: AUTH_AUDIT } });
  });
});

describe('P1-01: conta reaberta pelo estorno: cobrar de novo ou encerrar como venda devolvida', () => {
  const closedReply = (body: Record<string, unknown>) => ({ status: 200, body: { audit_id: SERVER_WRITE_OFF, status: 'CLOSED', written_off_cents: 0, ...body } });

  it('a conta fechada reabre (PAYING, sem closed_at), aparece em "Contas reabertas" e "Cobrar de novo" abre o caixa', async () => {
    const orderId = await reopenedOrder();
    const order = st().orders.find((o) => o.id === orderId)!;
    expect(order).toMatchObject({ status: 'PAYING', closed_at: null });
    expect(isRefundReopenedOrder(order, st().payments, st().auditLogs)).toBe(true);
    const opened: string[] = [];
    render(<RefundReopenedOrders onOpenCheckout={(id) => opened.push(id)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cobrar de novo' }));
    expect(opened).toEqual([orderId]);
    expect(screen.getByRole('button', { name: 'Encerrar como venda devolvida' })).toBeTruthy();
  });

  it('encerrar: manda p_order, p_staff, PIN, motivo e o id do aparelho; com a resposta, a conta fecha aqui com o valor baixado do servidor', async () => {
    const orderId = await reopenedOrder();
    const balance = st().orders.find((o) => o.id === orderId)!.remaining_balance;
    const cents = Math.round(balance * 100);
    const { d, calls } = rpcDeps((_fn, b) => closedReply({ order_id: b.p_order, written_off_cents: cents }));
    // A mesa ainda presa a esta conta: o servidor libera; aqui também.
    const tableId = st().orders.find((o) => o.id === orderId)!.table_id;
    useTcheStore.setState({ tables: st().tables.map((t) => (t.id === tableId ? { ...t, status: 'OCCUPIED', current_order_id: orderId } : t)) });
    const outboxBefore = st().outbox.length;
    const r = await submitRefundedWriteOff(orderId, '9999', 'cliente não vai pagar de novo', d, 'client-1');
    expect(r).toEqual({ ok: true, data: { writtenOff: balance } });
    expect(calls).toEqual([{ fn: 'tchefood_close_refunded_order', body: { p_order: orderId, p_staff: st().currentUserId, p_manager_pin: '9999', p_reason: 'cliente não vai pagar de novo', p_client_audit_id: 'client-1' } }]);
    const order = st().orders.find((o) => o.id === orderId)!;
    expect(order.status).toBe('CLOSED');
    expect(order.closed_at).toBeTruthy();
    expect(st().tables.find((t) => t.id === order.table_id)).toMatchObject({ status: 'FREE', current_order_id: null });
    expect(st().auditLogs.find((l) => l.action_type === 'ORDER_REFUNDED_WRITE_OFF')).toMatchObject({ id: SERVER_WRITE_OFF, amount_impact: balance, metadata: { written_off_cents: cents } });
    // Nada na fila: o servidor já encerrou.
    expect(st().outbox).toHaveLength(outboxBefore);
  });

  it.each<[string, Reply]>([
    ['PIN errado (null)', { status: 200, body: 'null' }],
    ['recusa (saldo não é do estorno)', { status: 400, body: { code: 'TF007', message: 'balance_not_refunded' } }],
    ['sem rede', 'network'],
    ['500', { status: 500, body: 'erro' }],
    ['resposta de outra conta', { status: 200, body: { audit_id: SERVER_WRITE_OFF, status: 'CLOSED', order_id: 'outra', written_off_cents: 1 } }],
    ['status não CLOSED', { status: 200, body: { audit_id: SERVER_WRITE_OFF, status: 'PAYING', written_off_cents: 1 } }],
    ['sem audit_id', { status: 200, body: { status: 'CLOSED', written_off_cents: 1 } }],
  ])('%s: nada muda aqui', async (_n, reply) => {
    const orderId = await reopenedOrder();
    const { d } = rpcDeps((_fn, b) => (typeof reply === 'object' && typeof reply.body === 'object' && reply.body && !('order_id' in reply.body)
      ? { ...reply, body: { ...(reply.body as object), order_id: b.p_order } } : reply));
    const before = { orders: st().orders, tables: st().tables, logs: st().auditLogs, outbox: st().outbox };
    const r = await submitRefundedWriteOff(orderId, '9999', 'cliente não vai pagar de novo', d);
    expect(r.ok).toBe(false);
    expect(st().orders).toBe(before.orders);
    expect(st().tables).toBe(before.tables);
    expect(st().auditLogs).toBe(before.logs);
    expect(st().outbox).toBe(before.outbox);
  });

  it('closeRefundedOrder: PIN e motivo inválidos não enviam', async () => {
    const { d, calls } = rpcDeps(() => ({ status: 200, body: {} }));
    expect((await closeRefundedOrder({ orderId: 'o', staffId: 's', managerPin: '1', reason: 'cliente não vai pagar', clientAuditId: 'c' }, d)).kind).toBe('pin');
    expect((await closeRefundedOrder({ orderId: 'o', staffId: 's', managerPin: '9999', reason: 'curto', clientAuditId: 'c' }, d)).kind).toBe('refused');
    expect(calls).toHaveLength(0);
    // PIN errado ou bloqueado: o banco devolve null.
    expect((await closeRefundedOrder({ orderId: 'o', staffId: 's', managerPin: '9999', reason: 'cliente não vai pagar', clientAuditId: 'c' }, rpcDeps(() => ({ status: 200, body: 'null' })).d)).kind).toBe('pin');
  });

  it('pela tela: PIN do gerente, encerra e mostra o valor baixado', async () => {
    const orderId = await reopenedOrder();
    const balance = st().orders.find((o) => o.id === orderId)!.remaining_balance;
    const { d } = rpcDeps((_fn, b) => closedReply({ order_id: b.p_order, written_off_cents: Math.round(balance * 100) }));
    render(<RefundReopenedOrders deps={d} />);
    fireEvent.click(screen.getByRole('button', { name: 'Encerrar como venda devolvida' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Venda estornada, cliente não vai pagar' }));
    for (const k of ['9', '9', '9', '9']) fireEvent.click(within(dialog).getByRole('button', { name: k }));
    await waitFor(() => expect(st().orders.find((o) => o.id === orderId)!.status).toBe('CLOSED'));
    const { useToast } = await import('../components/ui');
    expect(useToast.getState().toasts.map((t: { text: string }) => t.text).join(' ')).toMatch(/venda devolvida.*baixado/);
  });
});

describe('GPT a verificar 3: pagamento por itens, estorno de um deles e cobrança nova', () => {
  it('o item pago, estornado e cobrado de novo conta uma vez só (conta, caixa/conciliação, garçom, painel)', async () => {
    const orderId = openWithItems([['101', 1], ['102', 1]]);
    const itemsOf = () => st().orderItems.filter((i) => i.order_id === orderId && i.status !== 'CANCELED');
    const orderOf = () => st().orders.find((o) => o.id === orderId)!;
    const [a, b] = itemsOf() as [OrderItem, OrderItem];
    const total = orderOf().total_amount;
    payPoint(orderId, computeItemsShare(orderOf(), [a], itemsOf()).share, 'k-a', [a.id]);
    const r = await submitPointRefund(st().payments.find((p) => p.idempotency_key === 'k-a')!, '9999', 'venda estornada na maquininha', refundDeps({ payment_registered: true }));
    // O item A volta a não pago (como no servidor) e o saldo volta inteiro: "por item" cobra o A de novo, depois o B.
    expect(r.ok && r.data.itemsStayPaid).toBe(false);
    const fresh = (id: string) => itemsOf().find((i) => i.id === id)!;
    expect(fresh(a.id).is_paid).toBe(false);
    expect(orderOf()).toMatchObject({ paid_amount: 0, remaining_balance: total });
    const shareA2 = computeItemsShare(orderOf(), [fresh(a.id)], itemsOf());
    expect(shareA2.share).toBeGreaterThan(0);
    payPoint(orderId, shareA2.share, 'k-a2', [a.id]);
    expect(fresh(a.id).is_paid).toBe(true);
    const shareB = computeItemsShare(orderOf(), [fresh(b.id)], itemsOf());
    expect(shareB.coversAll).toBe(true);
    expect(shareA2.share + shareB.share).toBeCloseTo(total, 2);
    payPoint(orderId, shareB.share, 'k-b', [b.id]);
    expect(orderOf()).toMatchObject({ status: 'CLOSED', paid_amount: total, remaining_balance: 0 });

    const payments = st().payments.filter((p) => p.order_id === orderId);
    const period = currentShiftPeriod();
    // Caixa / conciliação: só o aprovado; o estornado não entra.
    expect(reconciliation(payments, period).find((x) => x.acquirer === 'MERCADO_PAGO')).toMatchObject({ total, count: 2 });
    expect(shiftKpis([orderOf()], payments, period).grossRevenue).toBe(total);
    // Garçom: cada item uma vez.
    const ws = waiterSplit([orderOf()], itemsOf(), st().staff, period);
    expect(ws.reduce((s, w) => s + w.itemsSold, 0)).toBe(2);
    expect(ws.reduce((s, w) => s + w.sales, 0)).toBeCloseTo(a.total_item_price + b.total_item_price, 2);
    // Painel (mesa/canal): o valor da conta uma vez.
    const ix = indexDashboard({ orders: [orderOf()], orderItems: itemsOf(), payments, tables: st().tables, products: st().products, marketplace: [] } as never);
    expect(salesCents(ix, { from: 0, to: Date.now() + 60_000 } as never)).toBe(Math.round(total * 100));
  });
});

describe('NFC-e da conta reaberta pelo estorno: nunca uma segunda nota para a mesma venda', () => {
  it('cobrada de novo: fecha com a NFC-e original (sem nota nova), registra na conta e o registro sobe', async () => {
    const orderId = await reopenedOrder();
    const before = st().orders.find((o) => o.id === orderId)!;
    expect(before.nfce_key).toBeTruthy();
    const seq = st().nfceSeq;
    payPoint(orderId, before.remaining_balance, 'k-recharge');
    const after = st().orders.find((o) => o.id === orderId)!;
    expect(after).toMatchObject({ status: 'CLOSED', nfce_key: before.nfce_key, nfce_status: 'AUTORIZADA' });
    expect(st().nfceSeq).toBe(seq);
    const log = st().auditLogs.find((l) => l.order_id === orderId && l.action_type === 'NFCE_ALREADY_ISSUED')!;
    expect(log).toMatchObject({ reason: NFCE_ALREADY_ISSUED, metadata: { nfce_key: before.nfce_key } });
    expect(st().outbox.some((e) => e.table === 'audit_logs' && e.op === 'INSERT' && e.row_id === log.id)).toBe(true);
  });

  it('primeiro fechamento: emite a NFC-e como sempre, sem o registro', () => {
    const orderId = openWithItems();
    const seq = st().nfceSeq;
    payPoint(orderId, st().orders.find((o) => o.id === orderId)!.remaining_balance, 'k-first');
    expect(st().orders.find((o) => o.id === orderId)!.nfce_key).toBeTruthy();
    expect(st().nfceSeq).toBe(seq + 1);
    expect(st().auditLogs.some((l) => l.action_type === 'NFCE_ALREADY_ISSUED')).toBe(false);
  });

  it('pela tela: cobrar de novo em dinheiro mostra o aviso da NFC-e já emitida', async () => {
    const orderId = await reopenedOrder();
    const { CheckoutScreen } = await import('../screens/CheckoutScreen');
    const { useToast } = await import('../components/ui');
    useToast.setState({ toasts: [] } as never);
    render(<CheckoutScreen orderId={orderId} onBack={() => undefined} onClosed={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /Dinheiro/ }));
    fireEvent.click(screen.getByRole('button', { name: /Valor livre/ }));
    fireEvent.change(screen.getByPlaceholderText('0,00'), { target: { value: st().orders.find((o) => o.id === orderId)!.remaining_balance.toFixed(2).replace('.', ',') } });
    const charge = () => screen.getByRole('button', { name: /^(Enviar para maquininha|Cobrar na SmartPOS|Receber) R\$/ }) as HTMLButtonElement;
    await waitFor(() => expect(charge().disabled).toBe(false));
    await act(async () => { fireEvent.click(charge()); });
    await waitFor(() => expect(st().orders.find((o) => o.id === orderId)!.status, useToast.getState().toasts.map((t: { text: string }) => t.text).join(' | ')).toBe('CLOSED'));
    expect(useToast.getState().toasts.map((t: { text: string }) => t.text)).toContain(NFCE_ALREADY_ISSUED);
  });

  it('encerrar como venda devolvida: nenhuma NFC-e nova', async () => {
    const orderId = await reopenedOrder();
    const before = st().orders.find((o) => o.id === orderId)!;
    const seq = st().nfceSeq;
    const { d } = rpcDeps((_fn, b) => ({ status: 200, body: { audit_id: SERVER_WRITE_OFF, order_id: b.p_order, status: 'CLOSED', written_off_cents: Math.round(before.remaining_balance * 100) } }));
    expect((await submitRefundedWriteOff(orderId, '9999', 'cliente não vai pagar de novo', d)).ok).toBe(true);
    expect(st().orders.find((o) => o.id === orderId)).toMatchObject({ status: 'CLOSED', nfce_key: before.nfce_key });
    expect(st().nfceSeq).toBe(seq);
    expect(st().auditLogs.some((l) => l.action_type === 'NFCE_ALREADY_ISSUED')).toBe(false);
  });
});

describe('itens do pagamento estornado: o PATCH sobe; conta paga por valor segue com os itens pagos', () => {
  it('itens desmarcados pelo estorno vão para a fila como UPDATE de order_items (is_paid=false)', async () => {
    const orderId = openWithItems([['101', 1], ['102', 1]]);
    const items = st().orderItems.filter((i) => i.order_id === orderId);
    payPoint(orderId, computeItemsShare(st().orders.find((o) => o.id === orderId)!, [items[0]!], items).share, 'k-patch', [items[0]!.id]);
    useTcheStore.setState({ outbox: [] }); // já no servidor
    expect((await submitPointRefund(st().payments.find((p) => p.idempotency_key === 'k-patch')!, '9999', 'venda estornada na maquininha', refundDeps({ payment_registered: true }))).ok).toBe(true);
    expect(st().outbox.filter((e) => e.table === 'order_items')).toEqual([expect.objectContaining({ op: 'UPDATE', row_id: items[0]!.id, payload: expect.objectContaining({ is_paid: false }) })]);
  });

  it('conta paga por valor, fechada e reaberta: os itens seguem pagos (nada sobe), o cancelamento de item segue bloqueado e o saldo inteiro pode ser cobrado por valor', async () => {
    const orderId = await reopenedOrder();
    expect(st().outbox.filter((e) => e.table === 'order_items')).toEqual([]);
    const items = st().orderItems.filter((i) => i.order_id === orderId && i.status !== 'CANCELED');
    expect(items.every((i) => i.is_paid)).toBe(true);
    expect(st().cancelOrderItem(items[0]!.id, { managerPin: '9999', reason: 'cliente desistiu do prato' } as never)).toMatchObject({ ok: false, error: expect.stringMatching(/já pago/) });
    const balance = st().orders.find((o) => o.id === orderId)!.remaining_balance;
    expect(balance).toBeGreaterThan(0);
    payPoint(orderId, balance, 'k-by-value');
    expect(st().orders.find((o) => o.id === orderId)).toMatchObject({ status: 'CLOSED', remaining_balance: 0 });
  });

  it('ajuste que fecha a conta reaberta (desconto no saldo): também sem NFC-e nova, com o registro na fila', async () => {
    const orderId = openWithItems();
    const total = st().orders.find((o) => o.id === orderId)!.remaining_balance;
    const half = Math.round(total * 50) / 100;
    payPoint(orderId, half, 'k-half');
    payPoint(orderId, st().orders.find((o) => o.id === orderId)!.remaining_balance, 'k-rest');
    useTcheStore.setState({ outbox: [] });
    expect((await submitPointRefund(st().payments.find((p) => p.idempotency_key === 'k-rest')!, '9999', 'venda estornada na maquininha', refundDeps({ payment_registered: true }))).ok).toBe(true);
    const reopened = st().orders.find((o) => o.id === orderId)!;
    expect(reopened.status).toBe('PAYING');
    const seq = st().nfceSeq;
    const r = st().applyDiscount(orderId, reopened.remaining_balance, { managerPin: '9999', reason: 'cortesia da casa ao cliente' } as never);
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    expect(st().orders.find((o) => o.id === orderId)).toMatchObject({ status: 'CLOSED', nfce_key: reopened.nfce_key });
    expect(st().nfceSeq).toBe(seq);
    const log = st().auditLogs.find((l) => l.order_id === orderId && l.action_type === 'NFCE_ALREADY_ISSUED')!;
    expect(st().outbox.some((e) => e.table === 'audit_logs' && e.row_id === log.id)).toBe(true);
  });
});

describe('GPT r12 P1-01: conta sem NFC-e, fechada na Point e estornada', () => {
  it('aparece em "Contas reabertas" com "Cobrar de novo" e "Encerrar como venda devolvida"; a NFC-e não decide nada', async () => {
    const orderId = openWithItems();
    const order = st().orders.find((o) => o.id === orderId)!;
    payPoint(orderId, order.remaining_balance, 'k-sem-nota');
    // Conta encerrada sem NFC-e emitida.
    useTcheStore.setState({ outbox: [], orders: st().orders.map((o) => (o.id === orderId ? { ...o, nfce_key: null, nfce_status: null } : o)) });
    expect(st().orders.find((o) => o.id === orderId)).toMatchObject({ status: 'CLOSED', nfce_key: null });
    const r = await submitPointRefund(st().payments.find((p) => p.idempotency_key === 'k-sem-nota')!, '9999', 'venda estornada na maquininha', refundDeps({ payment_registered: true }));
    expect(r).toMatchObject({ ok: true, data: { reopened: true, nfceIssued: false } });
    const reopened = st().orders.find((o) => o.id === orderId)!;
    expect(reopened).toMatchObject({ status: 'PAYING', nfce_key: null });
    expect(isRefundReopenedOrder(reopened, st().payments, st().auditLogs)).toBe(true);
    const opened: string[] = [];
    render(<RefundReopenedOrders onOpenCheckout={(id) => opened.push(id)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cobrar de novo' }));
    expect(opened).toEqual([orderId]);
    expect(screen.getByRole('button', { name: 'Encerrar como venda devolvida' })).toBeTruthy();
    // E com NFC-e, mas sem o registro do estorno que reabriu: não é conta reaberta (a nota não basta).
    const withNote = { ...reopened, nfce_key: '4326' };
    expect(isRefundReopenedOrder(withNote, st().payments, [])).toBe(false);
  });
});

describe('GPT r14 P1-01: conta reaberta no servidor com evento desta conta pendente ou recusado aqui', () => {
  it('aparelho com a conta CLOSED e evento recusado: a tela mostra a conta do servidor e o motivo; resolvido o evento, traz a conta e mostra as ações', async () => {
    const orderId = openWithItems();
    const order = st().orders.find((o) => o.id === orderId)!;
    payPoint(orderId, order.remaining_balance, 'k-outro');
    const local = st().orders.find((o) => o.id === orderId)!;
    expect(local.status).toBe('CLOSED');
    const pay = st().payments.find((p) => p.idempotency_key === 'k-outro')!;
    // Um evento desta conta recusado pela nuvem neste aparelho.
    const ev = st().outbox.find((e) => e.table === 'orders' && e.row_id === orderId)!;
    useTcheStore.setState({ outbox: [], syncRejected: [{ event: ev, message: 'recusado', rejected_at: new Date().toISOString() } as never], cloud: CLOUD });
    // No servidor: o outro aparelho estornou; a conta está PAYING com o saldo.
    const serverOrder = { ...local, status: 'PAYING', closed_at: null, paid_amount: 0, remaining_balance: local.total_amount };
    const snapshot = {
      order: serverOrder, items: st().orderItems.filter((i) => i.order_id === orderId).map((i) => ({ ...i, is_paid: false })),
      payments: [{ ...pay, status: 'REFUNDED' }],
      audits: [{ id: REFUND_AUDIT, order_id: orderId, performed_by_user_id: st().currentUserId, authorized_by_manager_id: MANAGER, action_type: 'POINT_PAYMENT_REFUNDED', amount_impact: 0,
        reason: 'venda estornada na maquininha', metadata: { order_reopened: true, payment_id: pay.id }, created_at: new Date().toISOString() }],
    };
    const { d, calls } = rpcDeps((fn) => (fn === 'tchefood_list_refund_order_changes' ? NO_CHANGES : fn === 'tchefood_list_refund_reopened_orders'
      ? { status: 200, body: { items: [{ order_id: orderId, table_id: local.table_id, status: 'PAYING', remaining_balance: local.total_amount, total_amount: local.total_amount, refunded_at: new Date().toISOString() }], next_cursor: null } }
      : { status: 200, body: snapshot }));
    render(<RefundReopenedOrders onOpenCheckout={() => undefined} deps={d} />);
    const row = await screen.findByTestId(`reopened-blocked-${orderId}`);
    expect(row.textContent).toMatch(/recusada pela nuvem/);
    expect(screen.queryByRole('button', { name: 'Encerrar como venda devolvida' })).toBeNull();
    expect(st().orders.find((o) => o.id === orderId)!.status).toBe('CLOSED');
    // Resolvido o recusado (descartado em Nuvem › recusados): lê de novo, traz a conta e as ações aparecem.
    const before = calls.length;
    act(() => useTcheStore.setState({ syncRejected: [] }));
    await waitFor(() => expect(st().orders.find((o) => o.id === orderId)!.status).toBe('PAYING'));
    expect(calls.length).toBeGreaterThan(before);
    await screen.findByRole('button', { name: 'Encerrar como venda devolvida' });
    expect(screen.getByRole('button', { name: 'Cobrar de novo' })).toBeTruthy();
    expect(screen.queryByTestId(`reopened-blocked-${orderId}`)).toBeNull();
    expect(st().payments.find((p) => p.id === pay.id)!.status).toBe('REFUNDED');
  });

  it('com o evento ainda na fila: mostra a conta e "aguarde a sincronização"', async () => {
    const orderId = openWithItems();
    const order = st().orders.find((o) => o.id === orderId)!;
    payPoint(orderId, order.remaining_balance, 'k-fila');
    const local = st().orders.find((o) => o.id === orderId)!;
    useTcheStore.setState({ cloud: CLOUD });
    const { d } = rpcDeps((fn) => (fn === 'tchefood_list_refund_order_changes' ? NO_CHANGES : fn === 'tchefood_list_refund_reopened_orders'
      ? { status: 200, body: { items: [{ order_id: orderId, table_id: local.table_id, status: 'PAYING', remaining_balance: local.total_amount, total_amount: local.total_amount, refunded_at: new Date().toISOString() }], next_cursor: null } }
      : { status: 200, body: { order: { ...local, status: 'PAYING', closed_at: null }, items: [], payments: [], audits: [] } }));
    render(<RefundReopenedOrders deps={d} />);
    expect((await screen.findByTestId(`reopened-blocked-${orderId}`)).textContent).toMatch(/aguarde a sincronização/);
    expect(st().orders.find((o) => o.id === orderId)!.status).toBe('CLOSED');
  });
});

/** Corpo da lista de contas reabertas do servidor (r16: página com cursor). */
const reopenedBody = (items: unknown[], next: string | null = null): unknown => ({ items, next_cursor: next });

describe('GPT r15 P1-01: venda estornada e encerrada como devolvida em outro aparelho entre duas leituras deste', () => {
  it('a conta daqui (fechada, paga) fica com o estornado, a baixa e os relatórios do servidor; o ponto de leitura só anda com tudo aplicado', async () => {
    localStorage.clear();
    const orderId = openWithItems();
    const order = st().orders.find((o) => o.id === orderId)!;
    payPoint(orderId, order.remaining_balance, 'k-r15');
    const local = st().orders.find((o) => o.id === orderId)!;
    expect(local.status).toBe('CLOSED');
    const pay = st().payments.find((p) => p.idempotency_key === 'k-r15')!;
    const total = Math.round(local.total_amount * 100);
    const logsOf = () => new Map([[orderId, st().auditLogs.filter((l) => l.order_id === orderId && l.action_type === 'ORDER_REFUNDED_WRITE_OFF').reduce((n, l) => n + Number(l.metadata?.written_off_cents), 0)]].filter(([, n]) => n !== 0) as [string, number][]);
    // Este aparelho vê a venda inteira como recebida.
    expect(keptSaleCents(local, logsOf())).toMatchObject({ keptCents: total, writtenOff: false });
    // No servidor (outro aparelho): estornou, reabriu e o gerente já encerrou como venda devolvida. Fechada de novo.
    const now = new Date().toISOString();
    const snapshot = {
      order: { ...local, status: 'CLOSED', paid_amount: 0, remaining_balance: local.total_amount },
      items: st().orderItems.filter((i) => i.order_id === orderId).map((i) => ({ ...i, is_paid: false })),
      payments: [{ ...pay, status: 'REFUNDED' }],
      audits: [
        { id: REFUND_AUDIT, order_id: orderId, performed_by_user_id: st().currentUserId, authorized_by_manager_id: MANAGER, action_type: 'POINT_PAYMENT_REFUNDED', amount_impact: 0,
          reason: 'venda estornada na maquininha', metadata: { order_reopened: true, payment_id: pay.id }, created_at: now },
        { id: SERVER_WRITE_OFF, order_id: orderId, performed_by_user_id: st().currentUserId, authorized_by_manager_id: MANAGER, action_type: 'ORDER_REFUNDED_WRITE_OFF', amount_impact: local.total_amount,
          reason: 'cliente não vai pagar de novo', metadata: { written_off_cents: total, cumulative_written_off_cents: total, client_audit_id: 'outro' }, created_at: now },
      ],
    };
    const ev = st().outbox.find((e) => e.table === 'orders' && e.row_id === orderId)!;
    useTcheStore.setState({ outbox: [], syncRejected: [{ event: ev, message: 'recusado', rejected_at: now } as never], cloud: CLOUD });
    const { d, calls } = rpcDeps((fn) => (fn === 'tchefood_list_refund_order_changes'
      ? { status: 200, body: { items: [{ order_id: orderId, status: 'CLOSED', remaining_balance: local.total_amount, last_seq: 42, last_audit_id: SERVER_WRITE_OFF }], next_seq: 42, safe_seq: 42, has_more: false } }
      : fn === 'tchefood_list_refund_reopened_orders' ? { status: 200, body: reopenedBody([]) } : { status: 200, body: snapshot }));
    // Com alteração desta conta recusada aqui: nada muda e o ponto de leitura não anda (volta na próxima).
    render(<RefundReopenedOrders deps={d} />);
    await waitFor(() => expect(calls.some((c) => c.fn === 'tchefood_order_snapshot')).toBe(true));
    expect(st().payments.find((p) => p.id === pay.id)!.status).toBe('APPROVED');
    expect(st().pullStatus.refund_seq).toBe(41);
    cleanup();
    // Resolvido: a próxima leitura traz a conta.
    useTcheStore.setState({ syncRejected: [] });
    render(<RefundReopenedOrders deps={d} />);
    await waitFor(() => expect(st().payments.find((p) => p.id === pay.id)!.status).toBe('REFUNDED'));
    const after = st().orders.find((o) => o.id === orderId)!;
    expect(after).toMatchObject({ status: 'CLOSED', paid_amount: 0, remaining_balance: local.total_amount });
    expect(st().auditLogs.filter((l) => l.order_id === orderId).map((l) => l.action_type).sort()).toEqual(expect.arrayContaining(['ORDER_REFUNDED_WRITE_OFF', 'POINT_PAYMENT_REFUNDED']));
    // Relatórios: a venda devolvida não fica como recebida.
    expect(keptSaleCents(after, logsOf())).toMatchObject({ keptCents: 0, writtenOff: true });
    await waitFor(() => expect(st().pullStatus.refund_seq).toBe(42));
    // Já aplicado: outra leitura com o mesmo registro não busca a conta de novo.
    cleanup();
    useTcheStore.setState((s) => ({ pullStatus: { ...s.pullStatus, refund_seq: 0 } }));
    const before = calls.filter((c) => c.fn === 'tchefood_order_snapshot').length;
    render(<RefundReopenedOrders deps={d} />);
    await waitFor(() => expect(st().pullStatus.refund_seq).toBe(42));
    expect(calls.filter((c) => c.fn === 'tchefood_order_snapshot').length).toBe(before);
  });
});

describe('GPT r15 P2-01: a lista de contas reabertas lê todas as páginas', () => {
  it('201 contas em duas páginas: todas, sem repetir; cursor da página anterior; página ruim = falha (não esconde)', async () => {
    const row = (n: number) => ({ order_id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, table_id: null, status: 'PAYING', remaining_balance: 10, total_amount: 10, refunded_at: '2026-11-15T10:00:00Z' });
    const all = Array.from({ length: 201 }, (_x, i) => row(i + 1));
    const { d, calls } = rpcDeps((_fn, b) => (b.p_cursor === null
      ? { status: 200, body: reopenedBody(all.slice(0, 200), 'c1') }
      : { status: 200, body: reopenedBody([all[199], all[200]]) }));
    const out = await listRefundReopenedOrders(d);
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.items.map((i) => i.order_id)).toEqual(all.map((r) => r.order_id));
    expect(calls.map((c) => c.body)).toEqual([{ p_cursor: null, p_limit: 200 }, { p_cursor: 'c1', p_limit: 200 }]);
    // Segunda página falha: nada de lista pela metade.
    expect((await listRefundReopenedOrders(rpcDeps((_fn, b) => (b.p_cursor === null ? { status: 200, body: reopenedBody(all.slice(0, 200), 'c1') } : { status: 500, body: 'erro' })).d)).kind).toBe('error');
    // Cursor que não anda: falha em vez de laço.
    expect((await listRefundReopenedOrders(rpcDeps(() => ({ status: 200, body: reopenedBody([], 'c1') })).d)).kind).toBe('error');
  });
});

describe('GPT r15 P2-02: encerramento recusado porque a conta já fechou', () => {
  const snapOf = (orderId: string, over: Record<string, unknown>, audits: unknown[] = []) => {
    const o = st().orders.find((x) => x.id === orderId)!;
    return { order: { ...o, status: 'CLOSED', closed_at: new Date().toISOString(), ...over }, items: [], payments: [], audits };
  };
  const refused: Reply = { status: 400, body: { code: 'TF007', message: 'TCHEFOOD_PAGAMENTO: a conta já está fechada.', details: 'order_not_open' } };

  it('quitada por pagamento em outro aparelho: não é venda devolvida; diz que foi quitada e atualiza a conta', async () => {
    const orderId = await reopenedOrder();
    const o = st().orders.find((x) => x.id === orderId)!;
    const { d } = rpcDeps((fn) => (fn === 'tchefood_close_refunded_order' ? refused : { status: 200, body: snapOf(orderId, { paid_amount: o.total_amount, remaining_balance: 0 }) }));
    const r = await submitRefundedWriteOff(orderId, '9999', 'cliente não vai pagar de novo', d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/quitada por pagamento/);
    expect(st().orders.find((x) => x.id === orderId)).toMatchObject({ status: 'CLOSED', remaining_balance: 0 });
    expect(st().auditLogs.some((l) => l.order_id === orderId && l.action_type === 'ORDER_REFUNDED_WRITE_OFF')).toBe(false);
  });

  it('encerrada como venda devolvida por outro aparelho (registro da baixa com o total igual ao saldo): sucesso com o total do servidor', async () => {
    const orderId = await reopenedOrder();
    const o = st().orders.find((x) => x.id === orderId)!;
    const cents = Math.round(o.remaining_balance * 100);
    const audit = { id: SERVER_WRITE_OFF, order_id: orderId, performed_by_user_id: st().currentUserId, authorized_by_manager_id: MANAGER, action_type: 'ORDER_REFUNDED_WRITE_OFF', amount_impact: o.remaining_balance,
      reason: 'cliente não vai pagar de novo', metadata: { written_off_cents: cents, cumulative_written_off_cents: cents, client_audit_id: 'outro' }, created_at: new Date().toISOString() };
    const { d } = rpcDeps((fn) => (fn === 'tchefood_close_refunded_order' ? refused : { status: 200, body: snapOf(orderId, {}, [audit]) }));
    expect(await submitRefundedWriteOff(orderId, '9999', 'cliente não vai pagar de novo', d)).toEqual({ ok: true, data: { writtenOff: o.remaining_balance } });
  });

  it('fechada com saldo e sem registro de baixa que confira: não afirma nada', async () => {
    const orderId = await reopenedOrder();
    const { d } = rpcDeps((fn) => (fn === 'tchefood_close_refunded_order' ? refused : { status: 200, body: snapOf(orderId, {}) }));
    const r = await submitRefundedWriteOff(orderId, '9999', 'cliente não vai pagar de novo', d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/sem o registro desta baixa/);
  });

  it('id de tentativa já usado num encerramento anterior (conta reaberta por outro estorno): o id gasto sai e a tentativa é refeita com id novo', async () => {
    localStorage.clear();
    const orderId = await reopenedOrder();
    const o = st().orders.find((x) => x.id === orderId)!;
    const cents = Math.round(o.remaining_balance * 100);
    localStorage.setItem(`tchefood.writeOffAttempt.v1:${orderId}`, 'id-antigo');
    const old = { id: AUTH_AUDIT, order_id: orderId, performed_by_user_id: st().currentUserId, authorized_by_manager_id: MANAGER, action_type: 'ORDER_REFUNDED_WRITE_OFF', amount_impact: o.remaining_balance,
      reason: 'cliente não vai pagar de novo', metadata: { written_off_cents: cents, cumulative_written_off_cents: cents, client_audit_id: 'id-antigo' }, created_at: new Date().toISOString() };
    const { d, calls } = rpcDeps((fn, b) => (fn === 'tchefood_order_snapshot'
      ? { status: 200, body: { order: { ...o }, items: [], payments: [], audits: [old] } }
      : b.p_client_audit_id === 'id-antigo'
        // Reenvio: o servidor devolve o encerramento antigo, com o status de agora (reaberta).
        ? { status: 200, body: { audit_id: AUTH_AUDIT, order_id: orderId, status: 'PAYING', written_off_cents: cents, cumulative_written_off_cents: cents } }
        : { status: 200, body: { audit_id: SERVER_WRITE_OFF, status: 'CLOSED', order_id: b.p_order, written_off_cents: 0, cumulative_written_off_cents: cents } }));
    const r = await submitRefundedWriteOff(orderId, '9999', 'cliente não vai pagar de novo', d);
    expect(r).toEqual({ ok: true, data: { writtenOff: o.remaining_balance } });
    const ids = calls.filter((c) => c.fn === 'tchefood_close_refunded_order').map((c) => c.body.p_client_audit_id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe('id-antigo');
    expect(ids[1]).not.toBe('id-antigo');
    expect(st().orders.find((x) => x.id === orderId)!.status).toBe('CLOSED');
    expect(localStorage.getItem(`tchefood.writeOffAttempt.v1:${orderId}`)).toBeNull();
  });
});
