// @vitest-environment jsdom
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTcheStore, type PickupLine } from '../store/useTcheStore';
import { buildSyncRequest, flushOutbox, isCourierFollowUpAudit, type FetchLike, type SyncConfig } from '../lib/sync/supabaseSync';
import { OwnDeliveryBoard } from '../screens/OwnDeliveryBoard';

// Acerto com o entregador (GPT, rodada 10 do PR #54):
// P2-01: a repetição do acerto sem resposta da nuvem não acerta sem uma das entregas dele.
// P2-03: "pago por fora" pede PIN de gerente e motivo e deixa registro na auditoria.

const st = () => useTcheStore.getState();
const MANAGER = { managerPin: '9999', reason: 'Pago em pix pelo dono' };
const line = (): PickupLine => ({ product_id: st().products.find((p) => p.code === '301')!.id, quantity: 1, modifiers: [], meat_doneness: null, half_product_ids: [], quick_tags: [], free_notes: '' });

function deliveredOrder(payOnDelivery = true) {
  const zone = st().deliveryZones.find((z) => z.name === 'Centro')!;
  const r = st().createPickupOrder({
    lines: [line()],
    fulfillment: 'DELIVERY',
    customerName: 'Maria',
    delivery: { customerName: 'Maria Souza', phone: '(55) 99653-8255', address: 'Rua Venâncio Aires, 100', reference: '', zoneId: zone.id, payOnDelivery, changeFor: null },
  });
  if (!r.ok) throw new Error(r.error);
  if (!payOnDelivery) {
    const paid = st().registerPayment({
      orderId: r.data.id, amount: r.data.remaining_balance, method: 'CASH', status: 'APPROVED', terminal_id: null, acquirer: 'CASH_DESK',
      acquirer_cnpj: null, card_brand: null, nsu: null, authorization_code: null, terminal_serial: null, idempotency_key: `k-${r.data.id}`, item_ids: [],
    });
    if (!paid.ok) throw new Error(paid.error);
  }
  const d = st().ownDeliveries.find((x) => x.order_id === r.data.id)!;
  const courier = st().couriers[0]!;
  expect(st().setOwnDeliveryStatus(d.id, 'READY').ok).toBe(true);
  expect(st().dispatchOwnDeliveries([d.id], courier.id).ok).toBe(true);
  expect(st().setOwnDeliveryStatus(d.id, 'DELIVERED').ok).toBe(true);
  return { order: r.data, delivery: st().ownDeliveries.find((x) => x.id === d.id)!, courier };
}

/** Liga a loja à nuvem e dá a fila por enviada (a nuvem já tem as entregas como entregues). */
function connectCloud() {
  useTcheStore.setState((s) => ({
    cloud: { url: 'http://cloud.test', anon_key: 'anon', email: 'loja@test', access_token: 'jwt', refresh_token: 'r', expires_at: 9e9, tenant_id: s.tenant.id },
    outbox: [],
  }));
}

interface Call { url: string; body: Record<string, unknown> }

/** A função da nuvem: devolve o acerto gravado como o banco (to_jsonb). */
function cloudFn(calls: Call[]): FetchLike {
  return async (url, init) => {
    const body = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
    calls.push({ url, body });
    const ids = body.p_delivery_ids as string[];
    const row = {
      id: body.p_id, tenant_id: st().tenant.id, courier_id: body.p_courier, deliveries: ids.length,
      cash_collected: body.p_cash_collected, courier_fees: body.p_courier_fees, cash_movement_id: null,
      delivery_ids: [...ids].sort(), settled_by_user_id: body.p_staff, created_at: '2026-11-14T12:00:00+00:00',
    };
    return { ok: true, status: 200, text: async () => JSON.stringify(row) };
  };
}

/** Faz a nuvem responder e, antes da resposta, muda o aparelho (o que der errado depois dela). */
function afterCloud(inner: FetchLike, change: () => void): FetchLike {
  return async (url, init) => {
    const res = await inner(url, init);
    change();
    return res;
  };
}

const drawerOut = () => st().cashMovements.filter((m) => m.type === 'WITHDRAWAL');
const CFG: SyncConfig = { url: 'http://cloud.test', anonKey: 'anon', accessToken: 'jwt' };

beforeEach(() => {
  st().resetDemo();
  expect(st().login('5555').ok).toBe(true);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('P2-01: acerto sem resposta com entrega que sumiu do aparelho (GPT, rodada 10 do PR #54)', () => {
  it('recusa antes da nuvem e guarda a pendente; com a entrega de volta, repete', async () => {
    expect(st().openCashSession(100).ok).toBe(true);
    const a = deliveredOrder();
    const b = deliveredOrder();
    const c = deliveredOrder();
    connectCloud();
    const down: FetchLike = async () => { throw new TypeError('Failed to fetch'); };
    expect((await st().settleCourierOnline(a.courier.id, { payFromDrawer: false, auth: { managerPin: '9999', reason: 'Pago em pix pela loja' }, fetchFn: down })).ok).toBe(false);
    const pending = st().courierSettlePending ?? [];
    expect(pending).toHaveLength(1);
    expect([...pending[0]!.delivery_ids].sort()).toEqual([a.delivery.id, b.delivery.id, c.delivery.id].sort());

    // Uma das entregas sai deste aparelho (leitura da nuvem, troca de aparelho...).
    const removed = st().ownDeliveries.find((d) => d.id === b.delivery.id)!;
    useTcheStore.setState((s) => ({ ownDeliveries: s.ownDeliveries.filter((d) => d.id !== removed.id) }));
    const calls: Call[] = [];
    const fn = vi.fn(cloudFn(calls));
    const r = await st().settleCourierOnline(a.courier.id, { payFromDrawer: false, auth: { managerPin: '9999', reason: 'Pago em pix pela loja' }, pendingId: pending[0]!.id, fetchFn: fn });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/não está mais neste aparelho/) });
    expect(fn).not.toHaveBeenCalled();
    expect(st().courierSettlePending).toEqual(pending);
    expect(st().courierSettlements).toEqual([]);
    expect(st().orders.find((o) => o.id === b.order.id)!.status).not.toBe('CLOSED');

    // A entrega volta (sincronizou): a repetição segue, com as três.
    useTcheStore.setState((s) => ({ ownDeliveries: [...s.ownDeliveries, removed] }));
    const r2 = await st().settleCourierOnline(a.courier.id, { payFromDrawer: false, auth: { managerPin: '9999', reason: 'Pago em pix pela loja' }, pendingId: pending[0]!.id, fetchFn: fn });
    if (!r2.ok) throw new Error(r2.error);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(calls[0]!.body).toMatchObject({ p_id: pending[0]!.id });
    expect(st().courierSettlePending).toEqual([]);
    for (const x of [a, b, c]) expect(st().orders.find((o) => o.id === x.order.id)!.status).toBe('CLOSED');
  });
});

describe('P2-03: "pago por fora" com PIN de gerente e registro na auditoria (GPT, rodada 10 do PR #54)', () => {
  /** Acerto gravado na nuvem com a sangria do ganho pendente (PIN bloqueado na hora). */
  async function withdrawalPending() {
    expect(st().openCashSession(100).ok).toBe(true);
    const a = deliveredOrder(false);
    connectCloud();
    const calls: Call[] = [];
    const fn = afterCloud(cloudFn(calls), () => useTcheStore.setState({ managerPinLockedUntil: Date.now() + 60_000 }));
    expect((await st().settleCourierOnline(a.courier.id, { payFromDrawer: true, auth: { managerPin: '9999', reason: 'Acerto do entregador' }, fetchFn: fn })).ok).toBe(false);
    useTcheStore.setState({ managerPinLockedUntil: null, managerPinFailures: 0 });
    const id = calls[0]!.body.p_id as string;
    const follow = st().courierSettleFollowUps!.find((f) => f.settlement_id === id)!;
    expect(follow.missing_withdrawal).not.toBeNull();
    return { a, id, follow };
  }
  const paidOutsideLogs = () => st().auditLogs.filter((l) => l.action_type === 'COURIER_PAID_OUTSIDE');

  it('sem PIN ou com PIN errado: a pendência fica e não há registro de "pago por fora"', async () => {
    const { id, follow } = await withdrawalPending();
    const none = st().finishCourierSettleFollowUp(id, { kind: 'paid_outside', auth: { managerPin: '', reason: MANAGER.reason } });
    expect(none.ok).toBe(false);
    const wrong = st().finishCourierSettleFollowUp(id, { kind: 'paid_outside', auth: { managerPin: '0000', reason: MANAGER.reason } });
    expect(wrong).toMatchObject({ ok: false, error: expect.stringMatching(/PIN de gerente inválido/) });
    expect(st().courierSettleFollowUps!.find((f) => f.settlement_id === id)!.missing_withdrawal).toEqual(follow.missing_withdrawal);
    expect(paidOutsideLogs()).toEqual([]);
    expect(st().outbox.some((e) => e.table === 'audit_logs' && e.payload.action_type === 'COURIER_PAID_OUTSIDE')).toBe(false);
    expect(drawerOut()).toEqual([]);
  });

  it('com PIN de gerente: a pendência sai, um registro na auditoria e o INSERT na fila, na mesma gravação', async () => {
    const { a, id, follow } = await withdrawalPending();
    const writes: Array<{ follow: boolean; logs: number; outbox: number }> = [];
    const unsub = useTcheStore.subscribe((s) => {
      writes.push({
        follow: (s.courierSettleFollowUps ?? []).some((f) => f.settlement_id === id),
        logs: s.auditLogs.filter((l) => l.action_type === 'COURIER_PAID_OUTSIDE').length,
        outbox: s.outbox.filter((e) => e.table === 'audit_logs' && e.payload.action_type === 'COURIER_PAID_OUTSIDE').length,
      });
    });
    const r = st().finishCourierSettleFollowUp(id, { kind: 'paid_outside', auth: MANAGER });
    unsub();
    if (!r.ok) throw new Error(r.error);
    expect(r.data).toBeNull();
    expect(st().courierSettleFollowUps).toEqual([]);
    expect(drawerOut()).toEqual([]);

    const logs = paidOutsideLogs();
    expect(logs).toHaveLength(1);
    const manager = st().staff.find((s) => s.pin_code === '9999')!;
    expect(logs[0]).toMatchObject({
      order_id: null,
      performed_by_user_id: st().currentUserId,
      amount_impact: 0,
      reason: MANAGER.reason,
      metadata: {
        courier_settlement_id: id, courier_id: a.courier.id, courier_name: a.courier.name,
        amount: follow.missing_withdrawal!.amount, paid_outside: true, manager_id: manager.id, manager_name: manager.name,
      },
    });
    // O gerente fica no registro; a nuvem confere o PIN de novo (tchefood_courier_followup_audit).
    expect(logs[0]!.authorized_by_manager_id).toBe(manager.id);
    expect(logs[0]!.whatsapp_alert_sent).toBe(false);
    const ev = st().outbox.filter((e) => e.table === 'audit_logs' && e.payload.action_type === 'COURIER_PAID_OUTSIDE');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ op: 'INSERT', row_id: logs[0]!.id, manager_pin: '9999' });
    expect(isCourierFollowUpAudit(ev[0]!)).toBe(true);
    const req = buildSyncRequest(ev[0]!, CFG);
    expect(req.url).toBe('http://cloud.test/rest/v1/rpc/tchefood_courier_followup_audit');
    expect(JSON.parse(req.body!)).toEqual({
      p_audit_id: logs[0]!.id, p_action: 'COURIER_PAID_OUTSIDE', p_settlement_id: id, p_performed_by: st().currentUserId, p_manager_pin: '9999',
      p_reason: MANAGER.reason, p_metadata: logs[0]!.metadata,
    });
    // Uma gravação só: a pendência sai junto com o registro e a fila.
    const changed = writes.filter((w) => !w.follow || w.logs > 0 || w.outbox > 0);
    expect(changed[0]).toEqual({ follow: false, logs: 1, outbox: 1 });
  });

  it('a fila sobe pela função da nuvem: id = aceito; null (PIN não conferiu) ou sem PIN = recusado', async () => {
    const { id } = await withdrawalPending();
    expect(st().finishCourierSettleFollowUp(id, { kind: 'paid_outside', auth: MANAGER }).ok).toBe(true);
    const ev = st().outbox.find((e) => e.table === 'audit_logs' && e.payload.action_type === 'COURIER_PAID_OUTSIDE')!;
    const reply = (text: string): FetchLike => async () => ({ ok: true, status: 200, text: async () => text });

    const ok = await flushOutbox([ev], CFG, reply(JSON.stringify(ev.row_id)));
    expect(ok.sent).toEqual([ev.id]);
    expect(ok.rejected).toEqual([]);

    const pinRefused = await flushOutbox([ev], CFG, reply('null'));
    expect(pinRefused.sent).toEqual([]);
    expect(pinRefused.rejected).toEqual([{ eventId: ev.id, status: 200, message: expect.stringMatching(/não confirmou o PIN do gerente/) }]);

    const calls: string[] = [];
    const noPin = await flushOutbox([{ ...ev, manager_pin: undefined }], CFG, async (url) => { calls.push(url); return { ok: true, status: 200, text: async () => '""' }; });
    expect(calls).toEqual([]);
    expect(noPin.rejected).toEqual([{ eventId: ev.id, status: 0, message: expect.stringMatching(/sem PIN/) }]);
  });

  it('o quadro: "Pago por fora" abre o PIN do gerente e não resolve na hora', async () => {
    const { id } = await withdrawalPending();
    render(createElement(OwnDeliveryBoard));
    fireEvent.click(screen.getByRole('button', { name: /Pago por fora/ }));
    expect(st().courierSettleFollowUps!.some((f) => f.settlement_id === id)).toBe(true);
    expect(screen.getByText(/Ganho do entregador pago por fora/)).toBeTruthy();
    expect(paidOutsideLogs()).toEqual([]);
    await act(async () => {});
  });
});

describe('senha presa na pendência do acerto: saída com PIN de gerente e registro (GPT, rodada 10 do PR #54)', () => {
  const SID = '00000000-0000-4000-8000-0000000000a1';
  const D1 = '00000000-0000-4000-8000-0000000000d1';
  const D2 = '00000000-0000-4000-8000-0000000000d2';
  /** Pendência com duas senhas presas (conta que sumiu, saldo que mudou) e, se pedido, a sangria. */
  function stuck(withdrawal: boolean) {
    useTcheStore.setState({ courierSettleFollowUps: [{
      settlement_id: SID, courier_id: st().couriers[0]!.id, courier_name: st().couriers[0]!.name, delivery_ids: [D1, D2], cash_collected: 50, courier_fees: 14,
      missing_payments: [
        { delivery_id: D1, order_id: 'o-1', pickup_number: 12, amount: 30, error: 'A conta da senha 12 não está neste aparelho: sincronize e tente de novo.' },
        { delivery_id: D2, order_id: 'o-2', pickup_number: 13, amount: 20, error: 'O saldo da senha 13 mudou desde o acerto.' },
      ],
      missing_withdrawal: withdrawal ? { amount: 14, error: 'x' } : null,
      created_at: '2026-11-14T12:00:00Z',
    }] });
  }
  const resolvedLogs = () => st().auditLogs.filter((l) => l.action_type === 'COURIER_PAYMENT_RESOLVED');
  const resolveAuth = { managerPin: '9999', reason: 'Recebido no caixa por outro meio' };

  it('sem PIN, PIN errado ou senha que não é da pendência: nada muda e não há registro', () => {
    stuck(false);
    const before = st().courierSettleFollowUps;
    expect(st().finishCourierSettleFollowUp(SID, { kind: 'payment_resolved', delivery_id: D1, auth: { managerPin: '', reason: resolveAuth.reason } }).ok).toBe(false);
    expect(st().finishCourierSettleFollowUp(SID, { kind: 'payment_resolved', delivery_id: D1, auth: { managerPin: '0000', reason: resolveAuth.reason } }))
      .toMatchObject({ ok: false, error: expect.stringMatching(/PIN de gerente inválido/) });
    expect(st().finishCourierSettleFollowUp(SID, { kind: 'payment_resolved', delivery_id: 'outra', auth: resolveAuth }).ok).toBe(false);
    expect(st().courierSettleFollowUps).toEqual(before);
    expect(resolvedLogs()).toEqual([]);
  });

  it('com PIN de gerente: só aquela senha sai, com um registro e o INSERT na fila (com o PIN) na mesma gravação', () => {
    stuck(true);
    const writes: Array<{ pending: number; logs: number; outbox: number }> = [];
    const unsub = useTcheStore.subscribe((s) => writes.push({
      pending: (s.courierSettleFollowUps ?? []).find((f) => f.settlement_id === SID)?.missing_payments.length ?? 0,
      logs: s.auditLogs.filter((l) => l.action_type === 'COURIER_PAYMENT_RESOLVED').length,
      outbox: s.outbox.filter((e) => e.payload.action_type === 'COURIER_PAYMENT_RESOLVED').length,
    }));
    const r = st().finishCourierSettleFollowUp(SID, { kind: 'payment_resolved', delivery_id: D1, auth: resolveAuth });
    unsub();
    if (!r.ok) throw new Error(r.error);
    expect(r.data!.missing_payments.map((m) => m.delivery_id)).toEqual([D2]);
    expect(r.data!.missing_withdrawal).not.toBeNull();
    const manager = st().staff.find((s) => s.pin_code === '9999')!;
    const logs = resolvedLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      order_id: null, performed_by_user_id: st().currentUserId, authorized_by_manager_id: manager.id, amount_impact: 0,
      reason: resolveAuth.reason, whatsapp_alert_sent: false,
      metadata: {
        courier_settlement_id: SID, delivery_id: D1, order_id: 'o-1', pickup_number: 12, amount: 30,
        last_error: 'A conta da senha 12 não está neste aparelho: sincronize e tente de novo.', manager_name: manager.name,
      },
    });
    const ev = st().outbox.filter((e) => e.payload.action_type === 'COURIER_PAYMENT_RESOLVED');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ table: 'audit_logs', op: 'INSERT', row_id: logs[0]!.id, manager_pin: '9999' });
    expect(writes.filter((w) => w.pending !== 2 || w.logs > 0 || w.outbox > 0)[0]).toEqual({ pending: 1, logs: 1, outbox: 1 });
    // A fila sobe pela função da nuvem, com a ação e o PIN.
    const req = buildSyncRequest(ev[0]!, CFG);
    expect(req.url).toBe('http://cloud.test/rest/v1/rpc/tchefood_courier_followup_audit');
    expect(JSON.parse(req.body!)).toMatchObject({ p_audit_id: logs[0]!.id, p_action: 'COURIER_PAYMENT_RESOLVED', p_settlement_id: SID, p_manager_pin: '9999' });
  });

  it('a última senha resolvida termina a pendência (e a troca de loja deixa de esperar por ela)', () => {
    stuck(false);
    expect(st().finishCourierSettleFollowUp(SID, { kind: 'payment_resolved', delivery_id: D1, auth: resolveAuth }).ok).toBe(true);
    const r = st().finishCourierSettleFollowUp(SID, { kind: 'payment_resolved', delivery_id: D2, auth: resolveAuth });
    expect(r).toEqual({ ok: true, data: null });
    expect(st().courierSettleFollowUps).toEqual([]);
    expect(resolvedLogs()).toHaveLength(2);
  });

  it('o quadro: cada senha presa tem "Resolver com gerente", que abre o PIN do gerente', async () => {
    stuck(false);
    render(createElement(OwnDeliveryBoard));
    const buttons = screen.getAllByRole('button', { name: /Resolver com gerente/ });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]!);
    expect(screen.getByText(/Senha resolvida com o gerente/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Recebido no caixa por outro meio/ })).toBeTruthy();
    expect(resolvedLogs()).toEqual([]);
    await act(async () => {});
  });
});
