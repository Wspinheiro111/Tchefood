// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTcheStore, type PickupLine } from '../store/useTcheStore';
import type { FetchLike } from '../lib/sync/supabaseSync';
import type { Payment } from '../types';

// Acerto com o entregador (rodada 11 do PR #54):
// 1. A nuvem procura o id antes de recusar: recusa na repetição tira a pendente, menos "outro acerto com este id".
// 2. A repetição recebe o que foi planejado na 1ª tentativa; saldo mudado fica na pendência, com o erro.
// 3. Recebimento da entrega não aprovado para o acerto antes da nuvem.
// 4. A repetição não depende do entregador ainda estar no aparelho.

const st = () => useTcheStore.getState();
const line = (): PickupLine => ({ product_id: st().products.find((p) => p.code === '301')!.id, quantity: 1, modifiers: [], meat_doneness: null, half_product_ids: [], quick_tags: [], free_notes: '' });

function cashPayment(orderId: string, amount: number, key: string) {
  const r = st().registerPayment({
    orderId, amount, method: 'CASH', status: 'APPROVED', terminal_id: null, acquirer: 'CASH_DESK',
    acquirer_cnpj: null, card_brand: null, nsu: null, authorization_code: null, terminal_serial: null, idempotency_key: key, item_ids: [],
  });
  if (!r.ok) throw new Error(r.error);
}

function deliveredOrder() {
  const zone = st().deliveryZones.find((z) => z.name === 'Centro')!;
  const r = st().createPickupOrder({
    lines: [line()],
    fulfillment: 'DELIVERY',
    customerName: 'Maria',
    delivery: { customerName: 'Maria Souza', phone: '(55) 99653-8255', address: 'Rua Venâncio Aires, 100', reference: '', zoneId: zone.id, payOnDelivery: true, changeFor: null },
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
    outbox: [],
  }));
}

interface Call { url: string; body: Record<string, unknown> }

function cloudFn(calls: Call[]): FetchLike {
  return async (url, init) => {
    const body = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
    calls.push({ url, body });
    const ids = body.p_delivery_ids as string[];
    const row = {
      id: body.p_id, tenant_id: st().tenant.id, courier_id: body.p_courier, deliveries: ids.length,
      cash_collected: body.p_cash_collected, courier_fees: body.p_courier_fees, cash_movement_id: null,
      delivery_ids: [...ids].sort(), settled_by_user_id: body.p_staff, created_at: '2026-11-15T12:00:00+00:00',
    };
    return { ok: true, status: 200, text: async () => JSON.stringify(row) };
  };
}

const pinRefused: FetchLike = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ error: 'TCHEFOOD_PIN_RECUSADO' }) });
const down: FetchLike = async () => { throw new TypeError('Failed to fetch'); };
const settle = (courierId: string, fetchFn: FetchLike, pendingId?: string) =>
  st().settleCourierOnline(courierId, { payFromDrawer: false, auth: null, fetchFn, ...(pendingId !== undefined ? { pendingId } : {}) });

/** Primeira tentativa sem resposta: fica o acerto pendente. */
async function pendingFor(courierId: string) {
  expect((await settle(courierId, down)).ok).toBe(false);
  const p = st().courierSettlePending ?? [];
  expect(p).toHaveLength(1);
  return p[0]!;
}

beforeEach(() => {
  st().resetDemo();
  expect(st().login('5555').ok).toBe(true);
  expect(st().openCashSession(100).ok).toBe(true);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('1: recusa da nuvem na repetição', () => {
  it('PIN recusado na repetição: a nuvem procura o id antes do PIN, então nada foi gravado e a pendente sai', async () => {
    const a = deliveredOrder();
    connectCloud();
    const p = await pendingFor(a.courier.id);
    const r = await settle(a.courier.id, pinRefused, p.id);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/Nada saiu da gaveta/) });
    expect(st().courierSettlePending).toEqual([]);
  });

  it('"outro acerto com este id" na repetição: o acerto continua pendente', async () => {
    const a = deliveredOrder();
    connectCloud();
    const p = await pendingFor(a.courier.id);
    const other: typeof pinRefused = async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ code: 'P0001', message: 'TCHEFOOD_ENTREGA: já existe outro acerto com este id.' }) });
    const r = await settle(a.courier.id, other, p.id);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/continua pendente/) });
    expect(st().courierSettlePending).toEqual([p]);
  });

  it('a repetição vai em nome de quem fez a primeira tentativa', async () => {
    const a = deliveredOrder();
    connectCloud();
    const p = await pendingFor(a.courier.id);
    expect(p.staff_id).toBeTruthy();
    const bodies: Record<string, unknown>[] = [];
    const spy: typeof pinRefused = async (_u, init) => { bodies.push(JSON.parse(String(init?.body))); return pinRefused(_u, init); };
    await settle(a.courier.id, spy, p.id);
    expect(bodies[0]).toMatchObject({ p_id: p.id, p_staff: p.staff_id });
  });

  it('PIN recusado na primeira tentativa: o acerto não fica pendente', async () => {
    const a = deliveredOrder();
    connectCloud();
    const r = await settle(a.courier.id, pinRefused);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/Nada saiu da gaveta/) });
    expect(st().courierSettlePending).toEqual([]);
  });
});

describe('2: a repetição recebe o planejado na primeira tentativa', () => {
  it('saldo mudou entre as tentativas: a senha fica na pendência com o valor do acerto', async () => {
    const a = deliveredOrder();
    connectCloud();
    const balance = a.order.remaining_balance;
    const p = await pendingFor(a.courier.id);
    expect(p.planned).toEqual([expect.objectContaining({ delivery_id: a.delivery.id, order_id: a.order.id, amount: balance })]);
    // Outro aparelho recebe parte no balcão.
    cashPayment(a.order.id, 5, 'balcao-1');
    useTcheStore.setState({ outbox: [] });
    const r = await settle(a.courier.id, cloudFn([]), p.id);
    expect(r.ok).toBe(false);
    const follow = st().courierSettleFollowUps!.find((f) => f.delivery_ids.includes(a.delivery.id))!;
    expect(follow.missing_payments).toEqual([expect.objectContaining({ delivery_id: a.delivery.id, amount: balance, error: expect.stringMatching(/saldo/) })]);
    expect(st().payments.some((x) => x.idempotency_key === `entrega-${a.delivery.id}`)).toBe(false);
  });

  it('conta fechada no balcão entre as tentativas: não some calada', async () => {
    const a = deliveredOrder();
    connectCloud();
    const p = await pendingFor(a.courier.id);
    cashPayment(a.order.id, a.order.remaining_balance, 'balcao-2');
    useTcheStore.setState({ outbox: [] });
    const r = await settle(a.courier.id, cloudFn([]), p.id);
    expect(r.ok).toBe(false);
    const follow = st().courierSettleFollowUps!.find((f) => f.delivery_ids.includes(a.delivery.id))!;
    expect(follow.missing_payments.map((m) => m.delivery_id)).toEqual([a.delivery.id]);
  });

  it('pendente antiga (sem plano) com saldo que não bate com o dinheiro: não dá o acerto por terminado', async () => {
    const a = deliveredOrder();
    connectCloud();
    const p = await pendingFor(a.courier.id);
    useTcheStore.setState({ courierSettlePending: [{ ...p, planned: undefined }] });
    cashPayment(a.order.id, 5, 'balcao-3');
    useTcheStore.setState({ outbox: [] });
    const r = await settle(a.courier.id, cloudFn([]), p.id);
    expect(r.ok).toBe(false);
    const follow = st().courierSettleFollowUps!.find((f) => f.delivery_ids.includes(a.delivery.id))!;
    expect(follow.missing_payments).toHaveLength(1);
    expect(follow.missing_payments[0]!.error).toMatch(/não bate/);
    expect(st().payments.some((x) => x.idempotency_key === `entrega-${a.delivery.id}`)).toBe(false);
  });

  it('sem mudança, a repetição termina o acerto', async () => {
    const a = deliveredOrder();
    connectCloud();
    const p = await pendingFor(a.courier.id);
    const r = await settle(a.courier.id, cloudFn([]), p.id);
    if (!r.ok) throw new Error(r.error);
    expect(st().orders.find((o) => o.id === a.order.id)!.status).toBe('CLOSED');
    expect(st().courierSettlePending).toEqual([]);
  });
});

describe('3: recebimento da entrega não aprovado', () => {
  it('para antes da nuvem, com a senha', async () => {
    const a = deliveredOrder();
    connectCloud();
    const approved = st().payments[0];
    const fake: Payment = {
      ...(approved ?? ({} as Payment)),
      id: 'pg-pendente', order_id: a.order.id, tenant_id: st().tenant.id, waiter_id: st().currentUserId ?? 'u', terminal_id: null,
      amount: a.order.remaining_balance, tip_amount: 0, method: 'CASH', status: 'PENDING', acquirer: 'CASH_DESK', acquirer_cnpj: null,
      card_brand: null, nsu: null, authorization_code: null, terminal_serial: null, idempotency_key: `entrega-${a.delivery.id}`, created_at: new Date().toISOString(),
    };
    useTcheStore.setState((s) => ({ payments: [...s.payments, fake] }));
    const fn = vi.fn(cloudFn([]));
    const r = await settle(a.courier.id, fn);
    expect(r).toMatchObject({ ok: false, error: `A senha ${a.order.pickup_number} tem um recebimento na entrega não aprovado. Resolva no caixa antes do acerto.` });
    expect(fn).not.toHaveBeenCalled();
    expect(st().courierSettlePending).toEqual([]);
  });

  it('na repetição não para antes da nuvem (o acerto pode estar gravado): a senha fica na pendência', async () => {
    const a = deliveredOrder();
    connectCloud();
    const p = await pendingFor(a.courier.id);
    const approved = st().payments[0];
    const fake: Payment = {
      ...(approved ?? ({} as Payment)),
      id: 'pg-pendente-2', order_id: a.order.id, tenant_id: st().tenant.id, waiter_id: st().currentUserId ?? 'u', terminal_id: null,
      amount: a.order.remaining_balance, tip_amount: 0, method: 'CASH', status: 'PENDING', acquirer: 'CASH_DESK', acquirer_cnpj: null,
      card_brand: null, nsu: null, authorization_code: null, terminal_serial: null, idempotency_key: `entrega-${a.delivery.id}`, created_at: new Date().toISOString(),
    };
    useTcheStore.setState((s) => ({ payments: [...s.payments, fake] }));
    const fn = vi.fn(cloudFn([]));
    const r = await settle(a.courier.id, fn, p.id);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(false);
    expect(st().courierSettlePending).toEqual([]);
    const follow = st().courierSettleFollowUps!.find((f) => f.settlement_id === p.id)!;
    expect(follow.missing_payments.map((m) => m.delivery_id)).toEqual([a.delivery.id]);
  });
});

describe('4: repetição sem o entregador no aparelho', () => {
  it('repete com o nome guardado no acerto pendente', async () => {
    const a = deliveredOrder();
    connectCloud();
    const p = await pendingFor(a.courier.id);
    useTcheStore.setState((s) => ({ couriers: s.couriers.filter((c) => c.id !== a.courier.id) }));
    const calls: Call[] = [];
    const r = await settle(a.courier.id, cloudFn(calls), p.id);
    if (!r.ok) throw new Error(r.error);
    expect(calls).toHaveLength(1);
    expect(st().courierSettlePending).toEqual([]);
  });

  it('acerto novo ainda pede o entregador', async () => {
    const a = deliveredOrder();
    connectCloud();
    useTcheStore.setState((s) => ({ couriers: s.couriers.filter((c) => c.id !== a.courier.id) }));
    expect(await settle(a.courier.id, cloudFn([]))).toMatchObject({ ok: false, error: 'Entregador não encontrado.' });
  });
});

describe('5: acerto incerto e desconectar da nuvem (Codex, rodada 11)', () => {
  it('não desconecta com acerto sem resposta; sem nuvem, a repetição é recusada e o acerto local não pega as entregas dele', async () => {
    const a = deliveredOrder();
    connectCloud();
    const p = await pendingFor(a.courier.id);
    const r = st().setCloudSession(null);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/desconectar da nuvem/) });
    expect(st().cloud).not.toBeNull();
    // Mesmo sem nuvem (estado antigo), nada repete fora dela nem acerta as mesmas entregas.
    useTcheStore.setState({ cloud: null });
    expect(await settle(a.courier.id, cloudFn([]), p.id)).toMatchObject({ ok: false, error: expect.stringMatching(/conecte de novo/) });
    expect(st().settleCourier(a.courier.id, { payFromDrawer: false, auth: null })).toMatchObject({ ok: false, error: 'Nenhuma entrega para acertar.' });
    expect(st().courierSettlements).toEqual([]);
  });
});
