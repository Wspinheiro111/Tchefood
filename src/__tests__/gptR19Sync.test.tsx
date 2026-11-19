// @vitest-environment jsdom
/**
 * Auditoria GPT r19 (PR #49), P2-01 e P2-02: conta que só este aparelho ainda vê como reaberta (quitada ou encerrada em outro
 * aparelho, fora da lista de reabertas do servidor) e que não consegue ser atualizada (retrato com erro, alteração
 * desta conta na fila ou recusada) não pode aparecer como "Servidor lido" nem manter "Cobrar de novo" e "Encerrar como
 * venda devolvida" sobre o saldo antigo.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useTcheStore } from '../store/useTcheStore';
import { clearReviewHold } from '../lib/payments/reviewHolds';
import { pullRefundOrders } from '../lib/payments/refundOrdersPull';
import { RefundReopenedOrders } from '../components/PointRefund';
import type { ClaimDeps } from '../lib/payments/paymentClaim';
import type { SyncEvent } from '../types';

const st = () => useTcheStore.getState();
const MANAGER = '8b0d3a52-4f1e-4c55-9a1e-0c2b7d9e1f00';
const REFUND_AUDIT = '1c3e5a7b-9d2f-4b6a-8c0e-2a4b6c8d0e1f';
const PAID_AUDIT = '5a7c9e1b-3d5f-4a7c-8e9a-0c2e4a6c8e0f';
const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwt = (tenant: string) => `h.${b64({ tenant_id: tenant })}.s`;
const ok = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
const cloudOf = (tenantId: string) => ({ url: 'https://x.supabase.co', anon_key: 'anon', email: 'a@loja', access_token: jwt(tenantId), refresh_token: 'r', expires_at: 9_999_999_999, tenant_id: tenantId });

beforeEach(() => {
  localStorage.clear();
  st().resetDemo();
  for (const o of st().orders) clearReviewHold(o.id);
});
afterEach(() => cleanup());

/** Este aparelho: conta paga na Point, estornada e reaberta (PAYING com saldo) por estorno feito em outro aparelho. */
function reopenedHere(key: string) {
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
  const local = st().orders.find((o) => o.id === orderId)!;
  const pay = st().payments.find((x) => x.order_id === orderId)!;
  const now = new Date().toISOString();
  const refundAudit = { id: REFUND_AUDIT, order_id: orderId, performed_by_user_id: st().currentUserId, authorized_by_manager_id: MANAGER, action_type: 'POINT_PAYMENT_REFUNDED', amount_impact: 0,
    reason: 'venda estornada na maquininha', metadata: { order_reopened: true, payment_id: pay.id }, created_at: now };
  const items = st().orderItems.filter((i) => i.order_id === orderId);
  const reopened = {
    order: { ...local, status: 'PAYING', closed_at: null, paid_amount: 0, remaining_balance: local.total_amount },
    items: items.map((i) => ({ ...i, is_paid: false })), payments: [{ ...pay, status: 'REFUNDED' }], audits: [refundAudit],
  };
  useTcheStore.setState({ outbox: [], cloud: cloudOf(st().tenant.id) });
  const applied = st().applyServerOrderSnapshot(reopened as never);
  expect(applied.ok && applied.data.kind).toBe('applied');
  // O servidor agora: outro aparelho cobrou o saldo e fechou a conta (nada a pagar).
  const payNew = { ...pay, id: crypto.randomUUID(), method: 'CASH', acquirer: 'CASH_DESK', status: 'APPROVED', idempotency_key: `${key}-b`, nsu: null, card_brand: null };
  const closedOnServer = {
    order: { ...local, status: 'CLOSED', paid_amount: local.total_amount, remaining_balance: 0, closed_at: now },
    items: items.map((i) => ({ ...i, is_paid: true })), payments: [{ ...pay, status: 'REFUNDED' }, payNew],
    audits: [refundAudit, { ...refundAudit, id: PAID_AUDIT, action_type: 'ORDER_CLOSED', metadata: {} }],
  };
  return { orderId, closedOnServer };
}

function depsOf(rpc: (fn: string) => unknown): ClaimDeps {
  const tenant = st().tenant.id;
  return {
    config: async () => ({ url: 'https://x.supabase.co', anonKey: 'anon', accessToken: jwt(tenant) }),
    fetch: (async (url: string) => rpc(url.split('/rpc/')[1]!)) as never,
    prepareOrder: async () => ({ ok: true }) as never, staff: async () => st().currentUserId, timer: () => new Promise<void>(() => undefined),
  };
}
const empty = (fn: string) => (fn === 'tchefood_list_refund_order_changes' ? ok({ items: [], next_seq: 0, safe_seq: 0, has_more: false })
  : fn === 'tchefood_list_refund_reopened_orders' ? ok({ items: [], next_cursor: null }) : null);

describe('GPT r19: conta reaberta só aqui que o servidor não confirma', () => {
  it('P2-01: retrato null (conta não encontrada): bloqueada, sem ações, leitura incompleta e hora da última leitura completa preservada', async () => {
    const { orderId } = reopenedHere('k-r19a');
    const d = depsOf((fn) => empty(fn) ?? ok(null));
    const out = await pullRefundOrders(d);
    expect(out).toMatchObject({ ok: false, changesOk: false });
    expect(out.blocked[orderId]).toBe('missing');
    render(<RefundReopenedOrders deps={d} />);
    await waitFor(() => expect(screen.getByTestId(`reopened-blocked-${orderId}`)).toBeTruthy());
    expect(screen.getByTestId('reopened-read-failed')).toBeTruthy();
    expect(screen.queryByTestId('reopened-read-ok')).toBeNull();
    expect(screen.getByTestId(`reopened-blocked-${orderId}`).textContent).toMatch(/não foi encontrada no servidor/);
    expect(screen.queryByText('Cobrar de novo')).toBeNull();
    expect(screen.queryByText(/Encerrar como venda devolvida/)).toBeNull();
    expect(st().orders.find((o) => o.id === orderId)).toMatchObject({ status: 'PAYING' });
  });

  it('P2-02: evento pendente ou recusado: leitura incompleta (changesOk falso), nunca "Servidor lido"; resolvido, volta a ser completa', async () => {
    const { orderId, closedOnServer } = reopenedHere('k-r19b');
    const mine: SyncEvent = { id: crypto.randomUUID(), table: 'orders', op: 'UPDATE', row_id: orderId, payload: { id: orderId } as never, created_at: new Date().toISOString() } as SyncEvent;
    const d = depsOf((fn) => empty(fn) ?? ok(closedOnServer));
    for (const where of ['outbox', 'rejected'] as const) {
      useTcheStore.setState(where === 'outbox' ? { outbox: [mine], syncRejected: [] } : { outbox: [], syncRejected: [{ event: mine, status: 409, message: 'recusado', rejected_at: new Date().toISOString() }] as never });
      const out = await pullRefundOrders(d);
      expect(out, where).toMatchObject({ ok: false, changesOk: false });
      expect(out.blocked[orderId], where).toBe(where === 'outbox' ? 'pending' : 'rejected');
      render(<RefundReopenedOrders deps={d} />);
      await waitFor(() => expect(screen.getByTestId('reopened-read-failed')).toBeTruthy());
      expect(screen.queryByTestId('reopened-read-ok'), where).toBeNull();
      expect(screen.queryByText('Cobrar de novo'), where).toBeNull();
      expect(screen.queryByText(/Encerrar como venda devolvida/), where).toBeNull();
      cleanup();
    }
    useTcheStore.setState({ outbox: [], syncRejected: [] });
    const out = await pullRefundOrders(d);
    expect(out).toMatchObject({ ok: true, changesOk: true, blocked: {} });
  });

  it('vizinho (lista de alterações): conta da lista de alterações com evento na fila deixa a leitura incompleta, sem avançar o ponto', async () => {
    const { orderId, closedOnServer } = reopenedHere('k-r19c');
    const mine: SyncEvent = { id: crypto.randomUUID(), table: 'orders', op: 'UPDATE', row_id: orderId, payload: { id: orderId } as never, created_at: new Date().toISOString() } as SyncEvent;
    useTcheStore.setState({ outbox: [mine] });
    const change = { order_id: orderId, status: 'CLOSED', remaining_balance: 0, last_audit_id: PAID_AUDIT, last_seq: 7 };
    const d = depsOf((fn) => (fn === 'tchefood_list_refund_order_changes' ? ok({ items: [change], next_seq: 7, safe_seq: 7, has_more: false })
      : fn === 'tchefood_list_refund_reopened_orders' ? ok({ items: [], next_cursor: null }) : ok(closedOnServer)));
    const out = await pullRefundOrders(d);
    expect(out.changesOk).toBe(false);
    expect(st().pullStatus?.refund_seq ?? 0).toBeLessThan(7);
  });
});
