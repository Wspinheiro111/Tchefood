// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cloudLinkedStore, useTcheStore, type PickupLine } from '../store/useTcheStore';
import type { FetchLike } from '../lib/sync/supabaseSync';

// Acerto com o entregador (GPT, rodada 11 do PR #54):
// P0-01 o recebimento de cada senha vai no pedido do acerto (a nuvem grava junto) e o aparelho usa o mesmo id.
// P0-02 aparelho de versão anterior ligado à nuvem, sem o vínculo gravado, não acerta sem a nuvem.
// P1-01 gravação da pendente que falhou: o pedido não sai.
// P1-03 ganho pago por fora no próprio acerto exige PIN de gerente e fica na auditoria.

const st = () => useTcheStore.getState();
const OUTSIDE = { managerPin: '9999', reason: 'Pago em pix pela loja' };
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
  const d = st().ownDeliveries.find((x) => x.order_id === r.data.id)!;
  const courier = st().couriers[0]!;
  expect(st().setOwnDeliveryStatus(d.id, 'READY').ok).toBe(true);
  expect(st().dispatchOwnDeliveries([d.id], courier.id).ok).toBe(true);
  expect(st().setOwnDeliveryStatus(d.id, 'DELIVERED').ok).toBe(true);
  return { order: st().orders.find((o) => o.id === r.data.id)!, delivery: st().ownDeliveries.find((x) => x.id === d.id)!, courier };
}

function connectCloud() {
  useTcheStore.setState((s) => ({
    cloud: { url: 'http://cloud.test', anon_key: 'anon', email: 'loja@test', access_token: 'jwt', refresh_token: 'r', expires_at: 9e9, tenant_id: s.tenant.id },
    cloudLinkedTenantId: s.tenant.id,
    outbox: [],
  }));
}

function cloudFn(bodies: Record<string, unknown>[]): FetchLike {
  return async (_url, init) => {
    const body = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
    bodies.push(body);
    const ids = body.p_delivery_ids as string[];
    const row = {
      id: body.p_id, tenant_id: st().tenant.id, courier_id: body.p_courier, deliveries: ids.length,
      cash_collected: body.p_cash_collected, courier_fees: body.p_courier_fees, cash_movement_id: null,
      delivery_ids: [...ids].sort(), settled_by_user_id: body.p_staff, created_at: '2026-11-15T12:00:00+00:00',
    };
    return { ok: true, status: 200, text: async () => JSON.stringify(row) };
  };
}

const originalStorage = useTcheStore.persist.getOptions().storage;
/** Gravação recusada; a do persist (que não espera) não vira erro solto no teste. */
function refused(err: Error): Promise<void> {
  const p = Promise.reject(err);
  p.catch(() => undefined);
  return p;
}

beforeEach(() => {
  st().resetDemo();
  expect(st().login('5555').ok).toBe(true);
  expect(st().openCashSession(100).ok).toBe(true);
});
afterEach(() => {
  useTcheStore.persist.setOptions({ storage: originalStorage });
});

describe('P0-01: recebimento das senhas vai junto com o acerto', () => {
  it('o pedido leva o id e o valor de cada senha; o pagamento daqui usa o mesmo id', async () => {
    const a = deliveredOrder();
    connectCloud();
    const bodies: Record<string, unknown>[] = [];
    const r = await st().settleCourierOnline(a.courier.id, { payFromDrawer: false, auth: OUTSIDE, fetchFn: cloudFn(bodies) });
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    const sent = bodies[0]!.p_payments as { delivery_id: string; payment_id: string; amount: number }[];
    expect(sent).toEqual([{ delivery_id: a.delivery.id, payment_id: expect.any(String), amount: a.order.remaining_balance }]);
    const local = st().payments.find((p) => p.idempotency_key === `entrega-${a.delivery.id}`)!;
    expect(local.id).toBe(sent[0]!.payment_id);
    expect(local.amount).toBe(a.order.remaining_balance);
    expect(st().outbox.find((e) => e.table === 'payments' && e.row_id === local.id)).toBeDefined();
  });

  it('a repetição sem resposta manda os mesmos ids', async () => {
    const a = deliveredOrder();
    connectCloud();
    const down: FetchLike = async () => { throw new TypeError('Failed to fetch'); };
    expect((await st().settleCourierOnline(a.courier.id, { payFromDrawer: false, auth: OUTSIDE, fetchFn: down })).ok).toBe(false);
    const p = st().courierSettlePending![0]!;
    const planned = p.planned![0]!.payment_id;
    expect(planned).toBeTruthy();
    const bodies: Record<string, unknown>[] = [];
    const r = await st().settleCourierOnline(a.courier.id, { payFromDrawer: false, auth: OUTSIDE, fetchFn: cloudFn(bodies), pendingId: p.id });
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    expect((bodies[0]!.p_payments as { payment_id: string }[])[0]!.payment_id).toBe(planned);
    expect(st().payments.find((x) => x.idempotency_key === `entrega-${a.delivery.id}`)!.id).toBe(planned);
  });

  it('pendente de versão anterior sem os ids: ganha os ids, gravados antes do pedido', async () => {
    const a = deliveredOrder();
    connectCloud();
    const down: FetchLike = async () => { throw new TypeError('Failed to fetch'); };
    expect((await st().settleCourierOnline(a.courier.id, { payFromDrawer: false, auth: OUTSIDE, fetchFn: down })).ok).toBe(false);
    useTcheStore.setState((s) => ({
      courierSettlePending: s.courierSettlePending!.map((p) => ({ ...p, planned: p.planned!.map(({ payment_id: _x, ...m }) => m) })),
    }));
    let seenInPending: string | undefined;
    const fn: FetchLike = async (url, init) => {
      seenInPending = st().courierSettlePending![0]!.planned![0]!.payment_id;
      return cloudFn([])(url, init);
    };
    const p = st().courierSettlePending![0]!;
    const r = await st().settleCourierOnline(a.courier.id, { payFromDrawer: false, auth: OUTSIDE, fetchFn: fn, pendingId: p.id });
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    expect(seenInPending).toBeTruthy();
    expect(st().payments.find((x) => x.idempotency_key === `entrega-${a.delivery.id}`)!.id).toBe(seenInPending);
  });
});

describe('P0-02: loja de versão anterior ligada à nuvem', () => {
  it('ligada à nuvem sem o vínculo gravado: desconectar guarda o vínculo e o acerto sem nuvem é recusado', async () => {
    const a = deliveredOrder();
    useTcheStore.setState((s) => ({
      cloud: { url: 'http://cloud.test', anon_key: 'anon', email: 'loja@test', access_token: 'jwt', refresh_token: 'r', expires_at: 9e9, tenant_id: s.tenant.id },
      cloudLinkedTenantId: undefined,
      outbox: [],
    }));
    expect(st().setCloudSession(null).ok).toBe(true);
    expect(st().cloudLinkedTenantId).toBe(st().tenant.id);
    const r = await st().settleCourierOnline(a.courier.id, { payFromDrawer: false, auth: OUTSIDE });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/conecte de novo à nuvem/) });
    expect(st().courierSettlements).toHaveLength(0);
  });

  it('já desconectada, sem o vínculo, mas já sincronizou com a nuvem: recusado', async () => {
    const a = deliveredOrder();
    useTcheStore.setState((s) => ({
      cloud: null, cloudLinkedTenantId: undefined, outbox: [],
      syncStatus: { ...s.syncStatus, last_success_at: '2026-11-10T12:00:00Z' },
    }));
    expect(cloudLinkedStore(st())).toBe(true);
    const r = st().settleCourier(a.courier.id, { payFromDrawer: false, auth: null });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/conecte de novo à nuvem/) });
  });

  it('loja só do aparelho (nunca falou com a nuvem) continua acertando aqui', () => {
    const a = deliveredOrder();
    useTcheStore.setState({ cloud: null, cloudLinkedTenantId: undefined });
    expect(cloudLinkedStore(st())).toBe(false);
    const r = st().settleCourier(a.courier.id, { payFromDrawer: false, auth: null });
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
  });
});

describe('P1-01: gravação da pendente que falhou', () => {
  it('o pedido não sai, a pendente não fica e nada sai da gaveta', async () => {
    const a = deliveredOrder();
    connectCloud();
    useTcheStore.persist.setOptions({
      storage: { getItem: () => null, setItem: () => refused(new DOMException('cheio', 'QuotaExceededError')), removeItem: () => undefined },
    });
    const bodies: Record<string, unknown>[] = [];
    const r = await st().settleCourierOnline(a.courier.id, { payFromDrawer: false, auth: OUTSIDE, fetchFn: cloudFn(bodies) });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/Não foi possível gravar o acerto neste aparelho/) });
    expect(bodies).toHaveLength(0);
    expect(st().courierSettlePending ?? []).toEqual([]);
    expect(st().payments.some((p) => p.idempotency_key === `entrega-${a.delivery.id}`)).toBe(false);
  });

  it('na repetição, a pendente fica (a primeira tentativa pode ter chegado)', async () => {
    const a = deliveredOrder();
    connectCloud();
    const down: FetchLike = async () => { throw new TypeError('Failed to fetch'); };
    expect((await st().settleCourierOnline(a.courier.id, { payFromDrawer: false, auth: OUTSIDE, fetchFn: down })).ok).toBe(false);
    const p = st().courierSettlePending![0]!;
    useTcheStore.persist.setOptions({
      storage: { getItem: () => null, setItem: () => refused(new Error('indisponível')), removeItem: () => undefined },
    });
    const bodies: Record<string, unknown>[] = [];
    const r = await st().settleCourierOnline(a.courier.id, { payFromDrawer: false, auth: OUTSIDE, fetchFn: cloudFn(bodies), pendingId: p.id });
    expect(r.ok).toBe(false);
    expect(bodies).toHaveLength(0);
    expect(st().courierSettlePending).toEqual([p]);
  });
});

describe('P1-03: ganho pago por fora no próprio acerto', () => {
  it('sem PIN de gerente: recusado antes da nuvem', async () => {
    const a = deliveredOrder();
    connectCloud();
    const bodies: Record<string, unknown>[] = [];
    const r = await st().settleCourierOnline(a.courier.id, { payFromDrawer: false, auth: null, fetchFn: cloudFn(bodies) });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/pago por fora: precisa do PIN do gerente/) });
    expect(bodies).toHaveLength(0);
  });

  it('PIN de gerente errado: recusado antes da nuvem', async () => {
    const a = deliveredOrder();
    connectCloud();
    const bodies: Record<string, unknown>[] = [];
    const r = await st().settleCourierOnline(a.courier.id, { payFromDrawer: false, auth: { managerPin: '0000', reason: 'Pago em pix pela loja' }, fetchFn: cloudFn(bodies) });
    expect(r.ok).toBe(false);
    expect(bodies).toHaveLength(0);
  });

  it('com PIN: o acerto termina com o registro "pago por fora" na auditoria, que a nuvem confere', async () => {
    const a = deliveredOrder();
    connectCloud();
    const r = await st().settleCourierOnline(a.courier.id, { payFromDrawer: false, auth: OUTSIDE, fetchFn: cloudFn([]) });
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    const settlementId = r.ok ? r.data.id : '';
    const log = st().auditLogs.find((l) => l.action_type === 'COURIER_PAID_OUTSIDE')!;
    expect(log.metadata).toMatchObject({ courier_settlement_id: settlementId, amount: a.delivery.courier_fee });
    expect(st().outbox.some((e) => e.table === 'audit_logs' && e.row_id === log.id)).toBe(true);
    expect(st().courierSettleFollowUps ?? []).toEqual([]);
  });

  it('ganho zero: não pede PIN', async () => {
    const a = deliveredOrder();
    useTcheStore.setState((s) => ({ ownDeliveries: s.ownDeliveries.map((d) => (d.id === a.delivery.id ? { ...d, courier_fee: 0 } : d)) }));
    connectCloud();
    const r = await st().settleCourierOnline(a.courier.id, { payFromDrawer: false, auth: null, fetchFn: cloudFn([]) });
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    expect(st().auditLogs.some((l) => l.action_type === 'COURIER_PAID_OUTSIDE')).toBe(false);
  });
});
