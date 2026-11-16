// @vitest-environment jsdom
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DELIVERY_REFUSAL_DROPPED, useTcheStore, type PickupLine } from '../store/useTcheStore';
import type { FetchLike } from '../lib/sync/supabaseSync';
import { COURIER_SETTLE_OFFLINE } from '../lib/sync/courierSettle';
import { ManagerAuthSheet } from '../components/ManagerAuthSheet';
import { OwnDeliveryBoard } from '../screens/OwnDeliveryBoard';

// Acerto com o entregador feito duas vezes (auditoria interna, rodada 8 do PR #54): com as
// entregas descendo para todos os aparelhos, B podia acertar a entrega que A já tinha
// acertado, e o ganho do entregador saía da gaveta duas vezes. Com a loja ligada à nuvem, o
// acerto é gravado pela nuvem primeiro (tchefood_settle_courier) e sem internet não acontece;
// a sangria é uma sangria comum, criada só depois de a nuvem aceitar.

const st = () => useTcheStore.getState();
const MANAGER = { managerPin: '9999', reason: 'Acerto do entregador' };
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

/** A função da nuvem: devolve o acerto gravado como o banco (to_jsonb), ou a recusa. */
function cloudFn(calls: Call[], refuse: string | null = null): FetchLike {
  return async (url, init) => {
    const body = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
    calls.push({ url, body });
    if (refuse) return { ok: false, status: 400, text: async () => JSON.stringify({ message: refuse }) };
    const ids = body.p_delivery_ids as string[];
    const row = {
      id: body.p_id, tenant_id: st().tenant.id, courier_id: body.p_courier, deliveries: ids.length,
      cash_collected: body.p_cash_collected, courier_fees: body.p_courier_fees, cash_movement_id: null,
      delivery_ids: [...ids].sort(), settled_by_user_id: body.p_staff, created_at: '2026-11-14T12:00:00+00:00',
    };
    return { ok: true, status: 200, text: async () => JSON.stringify(row) };
  };
}

const drawerOut = () => st().cashMovements.filter((m) => m.type === 'WITHDRAWAL');

beforeEach(() => {
  st().resetDemo();
  expect(st().login('5555').ok).toBe(true);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('acerto com o entregador sem nuvem (demonstração, loja só neste aparelho)', () => {
  it('fica como era: sangria antes do acerto na fila, sem espera entre eles', async () => {
    expect(st().openCashSession(100).ok).toBe(true);
    const a = deliveredOrder();
    const s = await st().settleCourierOnline(a.courier.id, { payFromDrawer: true, auth: MANAGER, fetchFn: async () => { throw new Error('não chama a nuvem'); } });
    if (!s.ok) throw new Error(s.error);
    expect(s.data.cash_movement_id).not.toBeNull();
    const tables = st().outbox.map((e) => e.table);
    expect(tables.lastIndexOf('cash_movements')).toBeLessThan(tables.indexOf('courier_settlements'));
    expect(tables.indexOf('courier_settlements')).toBeLessThan(tables.lastIndexOf('own_deliveries'));
    // Sem espera entre a sangria e o acerto; só o dinheiro da senha espera a marcação de entregue (PR #49).
    const byId = new Map(st().outbox.map((e) => [e.id, e]));
    for (const e of st().outbox.filter((x) => x.depends_on_event_ids?.length)) {
      expect(e.table).toBe('payments');
      for (const id of e.depends_on_event_ids!) expect(byId.get(id)?.table).toBe('own_deliveries');
    }
  });
});

describe('acerto com o entregador pela nuvem (auditoria interna, rodada 8 do PR #54)', () => {
  it('a nuvem aceita: acerto e entregas como ela gravou, sem subir de novo; depois as senhas e a sangria comum', async () => {
    expect(st().openCashSession(100).ok).toBe(true);
    const a = deliveredOrder();
    const b = deliveredOrder(false);
    connectCloud();
    const calls: Call[] = [];
    const s = await st().settleCourierOnline(a.courier.id, { payFromDrawer: true, auth: MANAGER, fetchFn: cloudFn(calls) });
    if (!s.ok) throw new Error(s.error);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://cloud.test/rest/v1/rpc/tchefood_settle_courier');
    const fees = a.delivery.courier_fee! + b.delivery.courier_fee!;
    expect(calls[0]!.body).toMatchObject({
      p_courier: a.courier.id, p_delivery_ids: [a.delivery.id, b.delivery.id].sort(), p_courier_fees: fees,
      p_cash_collected: a.order.total_amount, p_staff: st().currentUserId,
    });
    expect(s.data).toMatchObject({ id: calls[0]!.body.p_id, cash_movement_id: null, deliveries: 2, courier_fees: fees });
    expect(st().courierSettlements.map((x) => x.id)).toEqual([s.data.id]);
    for (const d of [a.delivery, b.delivery]) expect(st().ownDeliveries.find((x) => x.id === d.id)!.settlement_id).toBe(s.data.id);
    // A nuvem já tem o acerto e as entregas marcadas: nada disso entra na fila.
    expect(st().outbox.some((e) => e.table === 'courier_settlements' || e.table === 'own_deliveries')).toBe(false);
    // A senha paga na entrega é recebida e o ganho sai como sangria comum (sem esperar nada na fila).
    expect(st().orders.find((o) => o.id === a.order.id)!.status).toBe('CLOSED');
    expect(drawerOut().map((m) => m.amount)).toEqual([fees]);
    const tables = st().outbox.map((e) => e.table);
    expect(tables).toContain('payments');
    expect(tables).toContain('cash_movements');
    expect(st().outbox.some((e) => e.depends_on_event_ids?.length)).toBe(false);
    // A autorização da sangria cita o acerto (só para consulta).
    const auth = st().outbox.find((e) => e.table === 'audit_logs' && e.payload.action_type === 'CASH_WITHDRAWAL')!;
    expect(auth.payload.metadata).toMatchObject({ movement_id: drawerOut()[0]!.id, courier_settlement_id: s.data.id });
    // Nada mais a acertar.
    expect((await st().settleCourierOnline(a.courier.id, { payFromDrawer: false, auth: { managerPin: '9999', reason: 'Pago em pix pela loja' }, fetchFn: cloudFn(calls) })).ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('entrega já acertada em outro aparelho: a nuvem recusa e nada sai da gaveta nem é recebido', async () => {
    expect(st().openCashSession(100).ok).toBe(true);
    const a = deliveredOrder();
    connectCloud();
    const auditBefore = st().auditLogs.length;
    const calls: Call[] = [];
    const r = await st().settleCourierOnline(a.courier.id, {
      payFromDrawer: true, auth: MANAGER,
      fetchFn: cloudFn(calls, 'TCHEFOOD_ENTREGA_JA_ACERTADA: a entrega já foi acertada com o entregador (outro aparelho).'),
    });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/A nuvem recusou o acerto.*Nada saiu da gaveta/) });
    expect(calls).toHaveLength(1);
    expect(st().outbox).toEqual([]);
    expect(drawerOut()).toEqual([]);
    expect(st().payments.filter((p) => p.order_id === a.order.id)).toEqual([]);
    expect(st().courierSettlements).toEqual([]);
    expect(st().ownDeliveries.find((d) => d.id === a.delivery.id)!.settlement_id).toBeNull();
    expect(st().auditLogs.filter((l) => l.action_type === 'CASH_WITHDRAWAL')).toHaveLength(0);
    expect(st().auditLogs.length).toBe(auditBefore);
  });

  it('sem internet não acerta: a nuvem nem é chamada e nada sai da gaveta', async () => {
    expect(st().openCashSession(100).ok).toBe(true);
    const a = deliveredOrder();
    connectCloud();
    vi.stubGlobal('navigator', { onLine: false });
    const calls: Call[] = [];
    const r = await st().settleCourierOnline(a.courier.id, { payFromDrawer: true, auth: MANAGER, fetchFn: cloudFn(calls) });
    expect(r).toEqual({ ok: false, error: COURIER_SETTLE_OFFLINE });
    expect(calls).toEqual([]);
    expect(st().outbox).toEqual([]);
    expect(drawerOut()).toEqual([]);
    expect(st().payments.filter((p) => p.order_id === a.order.id)).toEqual([]);
  });

  it('o acerto deste aparelho sem a nuvem é recusado na loja ligada à nuvem', () => {
    expect(st().openCashSession(100).ok).toBe(true);
    const a = deliveredOrder();
    connectCloud();
    expect(st().settleCourier(a.courier.id, { payFromDrawer: true, auth: MANAGER })).toEqual({ ok: false, error: COURIER_SETTLE_OFFLINE });
    expect(st().outbox).toEqual([]);
    expect(drawerOut()).toEqual([]);
  });

  it('rede caiu sem resposta: nada sai da gaveta e a nova tentativa repete o mesmo acerto', async () => {
    expect(st().openCashSession(100).ok).toBe(true);
    const a = deliveredOrder();
    connectCloud();
    const ids: unknown[] = [];
    const down: FetchLike = async (_u, init) => {
      ids.push((JSON.parse(init.body!) as { p_id: string }).p_id);
      throw new Error('Failed to fetch');
    };
    const r1 = await st().settleCourierOnline(a.courier.id, { payFromDrawer: true, auth: MANAGER, fetchFn: down });
    expect(r1).toMatchObject({ ok: false, error: expect.stringMatching(/Nada saiu da gaveta/) });
    expect(drawerOut()).toEqual([]);
    expect(st().outbox).toEqual([]);
    // A leitura trouxe a entrega já com o acerto (a nuvem gravou): a nova tentativa usa o mesmo id.
    useTcheStore.setState((s) => ({ ownDeliveries: s.ownDeliveries.map((d) => (d.id === a.delivery.id ? { ...d, settlement_id: ids[0] as string } : d)) }));
    const calls: Call[] = [];
    const pendingId = (st().courierSettlePending ?? [])[0]!.id;
    const r2 = await st().settleCourierOnline(a.courier.id, { payFromDrawer: true, auth: MANAGER, pendingId, fetchFn: cloudFn(calls) });
    if (!r2.ok) throw new Error(r2.error);
    expect(calls[0]!.body.p_id).toBe(ids[0]);
    expect(r2.data.id).toBe(ids[0]);
    expect(drawerOut()).toHaveLength(1);
  });

  it('entrega que a nuvem ainda não recebeu como entregue: espera a fila, sem chamar a nuvem', async () => {
    expect(st().openCashSession(100).ok).toBe(true);
    const a = deliveredOrder();
    useTcheStore.setState((s) => ({
      cloud: { url: 'http://cloud.test', anon_key: 'anon', email: 'loja@test', access_token: 'jwt', refresh_token: 'r', expires_at: 9e9, tenant_id: s.tenant.id },
    }));
    const calls: Call[] = [];
    const r = await st().settleCourierOnline(a.courier.id, { payFromDrawer: false, auth: { managerPin: '9999', reason: 'Pago em pix pela loja' }, fetchFn: cloudFn(calls) });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/ainda não recebeu/) });
    expect(calls).toEqual([]);
  });

  it('entrega com mudança recusada pela nuvem por outro motivo: não entra no acerto', async () => {
    expect(st().openCashSession(100).ok).toBe(true);
    const a = deliveredOrder();
    const ev = st().outbox.filter((e) => e.table === 'own_deliveries' && e.row_id === a.delivery.id).at(-1)!;
    st().rejectSyncEvents([{ eventId: ev.id, status: 400, message: 'TCHEFOOD_ENTREGA: a entrega anda uma etapa por vez (PREPARING → DELIVERED).' }]);
    expect(st().syncRejected.map((r) => r.event.id)).toEqual([ev.id]);
    connectCloud();
    const calls: Call[] = [];
    const r = await st().settleCourierOnline(a.courier.id, { payFromDrawer: true, auth: MANAGER, fetchFn: cloudFn(calls) });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/recusad/) });
    expect(calls).toEqual([]);
    expect(drawerOut()).toEqual([]);
  });
});

describe('mudança da entrega recusada por estar na versão final na nuvem (auditoria interna, rodada 8 do PR #54)', () => {
  it.each([
    'TCHEFOOD_ENTREGA: entrega já acertada com o entregador não muda.',
    'TCHEFOOD_ENTREGA: entrega cancelada não muda.',
  ])('"%s": sai da lista de recusados (a leitura traz a entrega da nuvem) e o aviso fica no estado da sincronização', (message) => {
    const a = deliveredOrder();
    const ev = st().outbox.filter((e) => e.table === 'own_deliveries' && e.row_id === a.delivery.id).at(-1)!;
    st().rejectSyncEvents([{ eventId: ev.id, status: 400, message }]);
    expect(st().outbox.some((e) => e.id === ev.id)).toBe(false);
    expect(st().syncRejected).toEqual([]);
    expect(st().syncStatus.last_error).toContain(DELIVERY_REFUSAL_DROPPED);
    expect(st().syncStatus.last_error).toContain(message);
  });
});

// ---------------------------------------------------------------------------------------------
// Revisão final do acerto pela nuvem (auditoria interna, rodada 8 do PR #54).
// ---------------------------------------------------------------------------------------------

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const count = (text: string, part: string) => text.split(part).length - 1;

/**
 * A função da nuvem como o banco: grava o acerto e marca as entregas; a mesma chamada devolve o
 * acerto gravado; entrega já marcada por outro acerto é recusada com o acerto em DETAIL.
 * `lose`: quantas respostas se perdem depois de gravar (a rede cai na volta).
 */
function cloudDb(calls: Call[], opts: { lose?: number } = {}) {
  const recorded = new Map<string, Record<string, unknown>>();
  const taken = new Map<string, string>();
  let lose = opts.lose ?? 0;
  const refuse = (message: string, details: string | null = null) =>
    ({ ok: false, status: 400, text: async () => JSON.stringify({ code: 'P0001', message, details, hint: null }) });
  const fn: FetchLike = async (url, init) => {
    const body = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
    calls.push({ url, body });
    const id = body.p_id as string;
    const ids = [...(body.p_delivery_ids as string[])].sort();
    let row = recorded.get(id);
    if (row) {
      if (JSON.stringify(row.delivery_ids) !== JSON.stringify(ids) || row.courier_fees !== body.p_courier_fees || row.cash_collected !== body.p_cash_collected) {
        return refuse('TCHEFOOD_ENTREGA: já existe outro acerto com este id.');
      }
    } else {
      const t = ids.find((x) => taken.has(x));
      if (t) {
        return refuse(
          `TCHEFOOD_ENTREGA_JA_ACERTADA: a entrega ${t} já foi acertada com o entregador (outro aparelho). Nada sai da gaveta por este acerto.`,
          JSON.stringify({ delivery_id: t, settlement_id: taken.get(t) }),
        );
      }
      row = {
        id, tenant_id: st().tenant.id, courier_id: body.p_courier, deliveries: ids.length, cash_collected: body.p_cash_collected,
        courier_fees: body.p_courier_fees, cash_movement_id: null, delivery_ids: ids, settled_by_user_id: body.p_staff, created_at: '2026-11-14T12:00:00+00:00',
      };
      recorded.set(id, row);
      for (const x of ids) taken.set(x, id);
    }
    if (lose > 0) {
      lose -= 1;
      throw new TypeError('Failed to fetch');
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(row) };
  };
  return { fn, recorded, taken };
}

/** Faz a nuvem responder e, antes da resposta, muda o aparelho (o que der errado depois dela). */
function afterCloud(inner: FetchLike, change: () => void): FetchLike {
  return async (url, init) => {
    const res = await inner(url, init);
    change();
    return res;
  };
}

describe('acerto gravado na nuvem com pendência neste aparelho (auditoria interna, rodada 8 do PR #54)', () => {
  it('senha não recebida e sangria não feita depois da nuvem: fica a pendência (persistida), com o erro, e dá para terminar depois', async () => {
    expect(st().openCashSession(100).ok).toBe(true);
    const a = deliveredOrder();
    connectCloud();
    const calls: Call[] = [];
    const fn = afterCloud(cloudFn(calls), () => useTcheStore.setState({ cloudSkippedOrderIds: [a.order.id], managerPinLockedUntil: Date.now() + 60_000 }));
    const r = await st().settleCourierOnline(a.courier.id, { payFromDrawer: true, auth: MANAGER, fetchFn: fn });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/Acerto gravado na nuvem/) });
    const settlementId = calls[0]!.body.p_id as string;
    expect(st().courierSettlements.map((x) => x.id)).toEqual([settlementId]);
    const follow = st().courierSettleFollowUps ?? [];
    expect(follow).toHaveLength(1);
    expect(follow[0]).toMatchObject({
      settlement_id: settlementId, courier_id: a.courier.id,
      missing_payments: [expect.objectContaining({ delivery_id: a.delivery.id, order_id: a.order.id })],
      missing_withdrawal: expect.objectContaining({ amount: a.delivery.courier_fee }),
    });
    expect(drawerOut()).toEqual([]);

    // Corrigido o motivo: recebe a senha e depois faz a sangria com o PIN, pela pendência.
    useTcheStore.setState({ cloudSkippedOrderIds: [], managerPinLockedUntil: null });
    const p = st().finishCourierSettleFollowUp(settlementId, { kind: 'payments' });
    if (!p.ok) throw new Error(p.error);
    expect(st().orders.find((o) => o.id === a.order.id)!.status).toBe('CLOSED');
    expect(st().courierSettleFollowUps![0]!.missing_payments).toEqual([]);
    const w = st().finishCourierSettleFollowUp(settlementId, { kind: 'withdrawal', auth: MANAGER });
    if (!w.ok) throw new Error(w.error);
    expect(drawerOut().map((m) => m.amount)).toEqual([a.delivery.courier_fee]);
    const auth = st().outbox.find((e) => e.table === 'audit_logs' && e.payload.action_type === 'CASH_WITHDRAWAL')!;
    expect(auth.payload.metadata).toMatchObject({ courier_settlement_id: settlementId });
    expect(st().courierSettleFollowUps).toEqual([]);
  });

  it('sangria paga por fora: a pendência sai sem tirar dinheiro da gaveta', async () => {
    expect(st().openCashSession(100).ok).toBe(true);
    const a = deliveredOrder(false);
    connectCloud();
    const calls: Call[] = [];
    const fn = afterCloud(cloudFn(calls), () => useTcheStore.setState({ managerPinLockedUntil: Date.now() + 60_000 }));
    const r = await st().settleCourierOnline(a.courier.id, { payFromDrawer: true, auth: MANAGER, fetchFn: fn });
    expect(r.ok).toBe(false);
    const id = calls[0]!.body.p_id as string;
    expect(st().courierSettleFollowUps![0]).toMatchObject({ settlement_id: id, missing_payments: [], missing_withdrawal: expect.anything() });
    // "Pago por fora" pede PIN de gerente (GPT, rodada 10 do PR #54): o bloqueio já passou.
    useTcheStore.setState({ managerPinLockedUntil: null });
    const o = st().finishCourierSettleFollowUp(id, { kind: 'paid_outside', auth: MANAGER });
    if (!o.ok) throw new Error(o.error);
    expect(st().courierSettleFollowUps).toEqual([]);
    expect(drawerOut()).toEqual([]);
  });

  it('uma senha falha: as outras são recebidas, a sangria é feita, e o erro cita só a que faltou', async () => {
    expect(st().openCashSession(100).ok).toBe(true);
    const a = deliveredOrder();
    const c = deliveredOrder();
    connectCloud();
    const calls: Call[] = [];
    const first = [a, c].sort((x, y) => x.delivery.id.localeCompare(y.delivery.id))[0]!;
    const other = first === a ? c : a;
    const fn = afterCloud(cloudFn(calls), () => useTcheStore.setState({ cloudSkippedOrderIds: [first.order.id] }));
    const r = await st().settleCourierOnline(a.courier.id, { payFromDrawer: true, auth: MANAGER, fetchFn: fn });
    expect(r.ok).toBe(false);
    expect(st().orders.find((o) => o.id === other.order.id)!.status).toBe('CLOSED');
    expect(st().orders.find((o) => o.id === first.order.id)!.status).toBe('PAYING');
    expect(drawerOut()).toHaveLength(1);
    const follow = st().courierSettleFollowUps![0]!;
    expect(follow.missing_payments.map((x) => x.order_id)).toEqual([first.order.id]);
    expect(follow.missing_withdrawal).toBeNull();
  });

  it('a pendência é deste aparelho e da loja: sai na troca de loja (resetDemo)', async () => {
    useTcheStore.setState({
      courierSettleFollowUps: [{ settlement_id: 's', courier_id: 'c', courier_name: 'X', delivery_ids: [], cash_collected: 0, courier_fees: 0, missing_payments: [], missing_withdrawal: null, created_at: '' }],
      courierSettlePending: [{ id: 'p', courier_id: 'c', courier_name: 'X', delivery_ids: [], cash_collected: 0, courier_fees: 0, terms: '', created_at: '' }],
      courierSettledRecently: [{ settlement_id: 's', delivery_ids: [], at: Date.now() }],
    });
    st().resetDemo();
    expect(st().courierSettleFollowUps).toEqual([]);
    expect(st().courierSettlePending).toEqual([]);
    expect(st().courierSettledRecently).toEqual([]);
  });
});

describe('aparelho interrompido depois de a nuvem gravar o acerto (GPT, rodada 8 do PR #54)', () => {
  const KEYS = ['orders', 'payments', 'cashMovements', 'auditLogs', 'outbox', 'courierSettleFollowUps', 'courierSettlePending', 'courierSettlements', 'ownDeliveries'] as const;
  type Saved = Pick<ReturnType<typeof st>, (typeof KEYS)[number]>;
  const save = (): Saved => Object.fromEntries(KEYS.map((k) => [k, st()[k]])) as Saved;

  it('em qualquer ponto depois da resposta da nuvem há pendência para terminar, e terminar não recebe nem sangra em dobro', async () => {
    expect(st().openCashSession(100).ok).toBe(true);
    const a = deliveredOrder();
    const c = deliveredOrder();
    connectCloud();
    const calls: Call[] = [];
    // Cada gravação no aparelho é um ponto em que o app pode fechar (o estado salvo é o da última).
    const saved: Saved[] = [save()];
    const unsub = useTcheStore.subscribe(() => saved.push(save()));
    const r = await st().settleCourierOnline(a.courier.id, { payFromDrawer: true, auth: MANAGER, fetchFn: cloudFn(calls) });
    unsub();
    if (!r.ok) throw new Error(r.error);
    const settlementId = calls[0]!.body.p_id as string;
    const keys = [a, c].map((x) => `entrega-${x.delivery.id}`);
    const done = (x: Saved) =>
      keys.every((k) => x.payments.some((p) => p.idempotency_key === k))
      && x.auditLogs.some((l) => l.action_type === 'CASH_WITHDRAWAL' && (l.metadata as Record<string, unknown>).courier_settlement_id === settlementId);
    // Depois da resposta da nuvem: o acerto pendente sai na mesma gravação que cria a pendência.
    const after = saved.filter((x) => x.courierSettlements.some((y) => y.id === settlementId));
    expect(after.length).toBeGreaterThan(2);
    for (const x of saved) {
      const pendingGone = !(x.courierSettlePending ?? []).some((p) => p.id === settlementId);
      const settled = x.courierSettlements.some((y) => y.id === settlementId);
      if (settled || pendingGone) {
        if (saved.indexOf(x) === 0) continue;
        expect(settled && pendingGone).toBe(true);
        expect(done(x) || (x.courierSettleFollowUps ?? []).some((f) => f.settlement_id === settlementId)).toBe(true);
      }
    }
    // Reinício em cada ponto: termina pela pendência; nada sai em dobro.
    for (const x of after) {
      useTcheStore.setState({ ...x });
      const f = (st().courierSettleFollowUps ?? []).find((y) => y.settlement_id === settlementId);
      if (f && f.missing_payments.length > 0) st().finishCourierSettleFollowUp(settlementId, { kind: 'payments' });
      if (f && f.missing_withdrawal) st().finishCourierSettleFollowUp(settlementId, { kind: 'withdrawal', auth: MANAGER });
      for (const k of keys) expect(st().payments.filter((p) => p.idempotency_key === k)).toHaveLength(1);
      expect(drawerOut()).toHaveLength(1);
      expect(st().courierSettleFollowUps ?? []).toEqual([]);
    }
  });

  it('o app fecha logo depois da sangria, antes de tirá-la da pendência: terminar não sangra de novo', async () => {
    expect(st().openCashSession(100).ok).toBe(true);
    const a = deliveredOrder(false);
    connectCloud();
    const calls: Call[] = [];
    const r = await st().settleCourierOnline(a.courier.id, { payFromDrawer: true, auth: MANAGER, fetchFn: cloudFn(calls) });
    if (!r.ok) throw new Error(r.error);
    const id = calls[0]!.body.p_id as string;
    // A pendência como estava antes da sangria (a gravação que a tiraria não chegou ao disco).
    useTcheStore.setState({ courierSettleFollowUps: [{
      settlement_id: id, courier_id: a.courier.id, courier_name: a.courier.name, delivery_ids: [a.delivery.id], cash_collected: 0,
      courier_fees: a.delivery.courier_fee ?? 0, missing_payments: [], missing_withdrawal: { amount: a.delivery.courier_fee ?? 0, error: 'Acerto interrompido antes deste passo.' }, created_at: '2026-11-14T12:00:00Z',
    }] });
    const w = st().finishCourierSettleFollowUp(id, { kind: 'withdrawal', auth: MANAGER });
    if (!w.ok) throw new Error(w.error);
    expect(drawerOut()).toHaveLength(1);
    expect(st().courierSettleFollowUps).toEqual([]);
  });

  it('sangria já registrada e o operador escolhe "pago por fora": avisa, sem apagar nem repetir a sangria', async () => {
    expect(st().openCashSession(100).ok).toBe(true);
    const a = deliveredOrder(false);
    connectCloud();
    const calls: Call[] = [];
    const r = await st().settleCourierOnline(a.courier.id, { payFromDrawer: true, auth: MANAGER, fetchFn: cloudFn(calls) });
    if (!r.ok) throw new Error(r.error);
    const id = calls[0]!.body.p_id as string;
    useTcheStore.setState({ courierSettleFollowUps: [{
      settlement_id: id, courier_id: a.courier.id, courier_name: a.courier.name, delivery_ids: [a.delivery.id], cash_collected: 0,
      courier_fees: a.delivery.courier_fee ?? 0, missing_payments: [], missing_withdrawal: { amount: a.delivery.courier_fee ?? 0, error: 'Acerto interrompido antes deste passo.' }, created_at: '2026-11-14T12:00:00Z',
    }] });
    expect(st().finishCourierSettleFollowUp(id, { kind: 'paid_outside', auth: MANAGER })).toMatchObject({ ok: false, error: expect.stringMatching(/já está registrada no caixa/) });
    expect(drawerOut()).toHaveLength(1);
    expect(st().courierSettleFollowUps).toEqual([]);
  });
});

describe('acerto sem resposta da nuvem (auditoria interna, rodada 8 do PR #54)', () => {
  it('fica guardado (persistido) e é repetido com as mesmas entregas e valores, à parte das entregas novas', async () => {
    expect(st().openCashSession(100).ok).toBe(true);
    const a = deliveredOrder();
    connectCloud();
    const calls: Call[] = [];
    const db = cloudDb(calls, { lose: 1 });
    const r1 = await st().settleCourierOnline(a.courier.id, { payFromDrawer: false, auth: { managerPin: '9999', reason: 'Pago em pix pela loja' }, fetchFn: db.fn });
    expect(r1.ok).toBe(false);
    const pending = st().courierSettlePending ?? [];
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ id: calls[0]!.body.p_id, courier_id: a.courier.id, delivery_ids: [a.delivery.id], cash_collected: a.order.total_amount });

    // A leitura traz a entrega com o acerto (a nuvem gravou), e o entregador fez outra entrega.
    useTcheStore.setState((s) => ({ ownDeliveries: s.ownDeliveries.map((d) => (d.id === a.delivery.id ? { ...d, settlement_id: pending[0]!.id } : d)) }));
    const b = deliveredOrder();
    connectCloud();

    // Sem dizer qual: não mistura a pendente com a nova; acerta só a nova.
    const rNew = await st().settleCourierOnline(a.courier.id, { payFromDrawer: false, auth: { managerPin: '9999', reason: 'Pago em pix pela loja' }, fetchFn: db.fn });
    if (!rNew.ok) throw new Error(rNew.error);
    expect(calls[1]!.body.p_delivery_ids).toEqual([b.delivery.id]);
    expect(calls[1]!.body.p_id).not.toBe(pending[0]!.id);

    // A pendente, pela ação dela: o mesmo id e os mesmos valores.
    const r2 = await st().settleCourierOnline(a.courier.id, { payFromDrawer: false, auth: { managerPin: '9999', reason: 'Pago em pix pela loja' }, pendingId: pending[0]!.id, fetchFn: db.fn });
    if (!r2.ok) throw new Error(r2.error);
    expect(calls[2]!.body).toMatchObject({ p_id: pending[0]!.id, p_delivery_ids: [a.delivery.id], p_cash_collected: a.order.total_amount });
    expect(st().courierSettlePending).toEqual([]);
    expect(st().orders.find((o) => o.id === a.order.id)!.status).toBe('CLOSED');
  });

  it('os valores mudaram entre a tentativa sem resposta e a nova: repete o mesmo id e os mesmos termos (a nuvem devolve o acerto)', async () => {
    expect(st().openCashSession(100).ok).toBe(true);
    const a = deliveredOrder();
    connectCloud();
    const calls: Call[] = [];
    const db = cloudDb(calls, { lose: 1 });
    expect((await st().settleCourierOnline(a.courier.id, { payFromDrawer: false, auth: { managerPin: '9999', reason: 'Pago em pix pela loja' }, fetchFn: db.fn })).ok).toBe(false);
    const pendingId = calls[0]!.body.p_id as string;
    // Muda o que o aparelho calcularia agora (o saldo da conta).
    useTcheStore.setState((s) => ({ orders: s.orders.map((o) => (o.id === a.order.id ? { ...o, remaining_balance: o.remaining_balance - 1 } : o)) }));
    const r = await st().settleCourierOnline(a.courier.id, { payFromDrawer: false, auth: { managerPin: '9999', reason: 'Pago em pix pela loja' }, pendingId, fetchFn: db.fn });
    expect(calls[1]!.body).toMatchObject({ p_id: pendingId, p_cash_collected: calls[0]!.body.p_cash_collected });
    // O saldo mudou desde o acerto gravado: a senha fica na pendência, não é recebida calada (rodada 11).
    expect(r.ok).toBe(false);
    expect(st().courierSettleFollowUps!.find((f) => f.settlement_id === pendingId)!.missing_payments).toHaveLength(1);
  });

  it('o quadro mostra a pendente e a pendência, com os valores delas', () => {
    useTcheStore.setState({
      courierSettlePending: [{ id: 'p1', courier_id: st().couriers[0]!.id, courier_name: 'Zé', delivery_ids: ['d1', 'd2'], cash_collected: 42, courier_fees: 14, terms: '', created_at: '' }],
      courierSettleFollowUps: [{
        settlement_id: 's1', courier_id: st().couriers[0]!.id, courier_name: 'Zé', delivery_ids: ['d3'], cash_collected: 30, courier_fees: 7,
        missing_payments: [{ delivery_id: 'd3', order_id: 'o3', pickup_number: 12, amount: 30, error: 'x' }], missing_withdrawal: { amount: 7, error: 'y' }, created_at: '',
      }],
    });
    render(createElement(OwnDeliveryBoard));
    expect(screen.getByText(/Acerto sem resposta da nuvem/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Tentar de novo/ })).toBeTruthy();
    expect(screen.getByText(/Acerto gravado na nuvem com pendência/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Receber as senhas/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Pago por fora/ })).toBeTruthy();
  });
});

describe('leitura velha logo depois do acerto (auditoria interna, rodada 8 do PR #54)', () => {
  it('a foto lida antes do acerto não devolve a entrega para "sem acerto"; depois de 2 min vale a da nuvem', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    expect(st().openCashSession(100).ok).toBe(true);
    const a = deliveredOrder(false);
    connectCloud();
    const s = await st().settleCourierOnline(a.courier.id, { payFromDrawer: false, auth: { managerPin: '9999', reason: 'Pago em pix pela loja' }, fetchFn: cloudFn([]) });
    if (!s.ok) throw new Error(s.error);
    const snapshot = () => ({
      tenant_id: st().tenant.id, server_now: new Date().toISOString(), orders: [...st().orders], orderItems: [...st().orderItems], payments: [...st().payments],
      ownDeliveries: st().ownDeliveries.map((d) => ({ ...d, settlement_id: null })), tables: [], cashSessions: [], skippedOrderIds: [],
    });
    expect(st().applyCloudOrders(snapshot()).ok).toBe(true);
    expect(st().ownDeliveries.find((d) => d.id === a.delivery.id)!.settlement_id).toBe(s.data.id);
    vi.setSystemTime(Date.now() + 3 * 60_000);
    expect(st().applyCloudOrders(snapshot()).ok).toBe(true);
    expect(st().ownDeliveries.find((d) => d.id === a.delivery.id)!.settlement_id).toBeNull();
  });
});

describe('mensagens do acerto (auditoria interna, rodada 8 do PR #54)', () => {
  it('recusa: sem o código TCHEFOOD_, sem o id da entrega e sem "Nada saiu da gaveta" repetido', async () => {
    expect(st().openCashSession(100).ok).toBe(true);
    const a = deliveredOrder();
    connectCloud();
    const db = cloudDb([]);
    db.taken.set(a.delivery.id, 'outro-acerto');
    const r = await st().settleCourierOnline(a.courier.id, { payFromDrawer: false, auth: { managerPin: '9999', reason: 'Pago em pix pela loja' }, fetchFn: db.fn });
    if (r.ok) throw new Error('devia recusar');
    expect(r.error).not.toMatch(/TCHEFOOD_/);
    expect(r.error).not.toMatch(UUID_RE);
    expect(count(r.error, 'Nada sai')).toBe(1);
    expect(r.error).toMatch(/já foi acertada/);
  });

  it('sem resposta: sem o texto do navegador', async () => {
    expect(st().openCashSession(100).ok).toBe(true);
    const a = deliveredOrder();
    connectCloud();
    const r = await st().settleCourierOnline(a.courier.id, { payFromDrawer: false, auth: { managerPin: '9999', reason: 'Pago em pix pela loja' }, fetchFn: async () => { throw new TypeError('Failed to fetch'); } });
    if (r.ok) throw new Error('devia falhar');
    expect(r.error).not.toMatch(/Failed to fetch/);
    expect(r.error).toMatch(/Sem resposta da nuvem/);
    expect(count(r.error, 'Nada saiu da gaveta')).toBe(1);
  });

  it('conta paga na entrega com itens ainda na fila: espera a fila, sem chamar a nuvem', async () => {
    expect(st().openCashSession(100).ok).toBe(true);
    const a = deliveredOrder();
    const itemEvent = st().outbox.find((e) => e.table === 'order_items' && e.payload.order_id === a.order.id)!;
    expect(itemEvent).toBeTruthy();
    connectCloud();
    useTcheStore.setState({ outbox: [itemEvent] });
    const calls: Call[] = [];
    const r = await st().settleCourierOnline(a.courier.id, { payFromDrawer: false, auth: { managerPin: '9999', reason: 'Pago em pix pela loja' }, fetchFn: cloudFn(calls) });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/contas pagas na entrega.*Espere a fila/) });
    expect(calls).toEqual([]);
  });
});

describe('PIN do gerente com confirmação assíncrona (auditoria interna, rodada 8 do PR #54)', () => {
  it('toque duplo no último dígito não manda o acerto duas vezes', () => {
    const onSubmit = vi.fn(() => new Promise<{ ok: true; data: null }>(() => {}));
    render(createElement(ManagerAuthSheet<null>, {
      open: true, onClose: () => {}, title: 'Pagar', summary: 'x', confirmLabel: 'Autorizar', quickReasons: ['Acerto do entregador'],
      onSubmit, onSuccess: () => {},
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Acerto do entregador' }));
    for (const d of ['1', '2', '3']) fireEvent.click(screen.getByRole('button', { name: d }));
    const nine = screen.getByRole('button', { name: '9' });
    act(() => {
      nine.click();
      nine.click();
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

describe('troca de loja com acerto do entregador em andamento (Codex, PR #54)', () => {
  const newStore = () => {
    const owner = st().staff.find((u) => u.role === 'OWNER')!;
    st().logout();
    expect(st().login(owner.pin_code).ok).toBe(true);
    useTcheStore.setState({ orders: st().orders.filter((o) => o.status !== 'OPEN' && o.status !== 'PAYING') });
    return st().startNewStore(
      {
        tenant: { name: 'Bar do Zé', legal_name: 'Zé Comércio de Alimentos Ltda', cnpj: '11.222.333/0001-81', state_registration: null, city: 'Pelotas', state: 'rs', default_service_fee_pct: 10 },
        owner_name: 'Zé', owner_pin: '4826',
      },
      { managerPin: owner.pin_code, reason: 'Começar loja nova' },
    );
  };

  it('esperando a resposta da nuvem: a troca de loja espera; com pendência a terminar, também', async () => {
    expect(st().openCashSession(100).ok).toBe(true);
    const a = deliveredOrder(false);
    connectCloud();
    const calls: Call[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const inner = cloudFn(calls);
    const slow: FetchLike = async (url, init) => { await gate; return inner(url, init); };
    const running = st().settleCourierOnline(a.courier.id, { payFromDrawer: false, auth: { managerPin: '9999', reason: 'Pago em pix pela loja' }, fetchFn: slow });
    await Promise.resolve();
    const tenant = st().tenant.id;
    expect(newStore()).toMatchObject({ ok: false, error: expect.stringMatching(/esperando a resposta da nuvem/) });
    expect(st().tenant.id).toBe(tenant);
    release();
    expect((await running).ok).toBe(true);
    // O "pago por fora" do acerto entrou na fila (registro do gerente); aqui só conta a pendência.
    expect(st().outbox.some((e) => e.table === 'audit_logs' && e.payload.action_type === 'COURIER_PAID_OUTSIDE')).toBe(true);

    useTcheStore.setState({ outbox: [], courierSettleFollowUps: [{
      settlement_id: 's1', courier_id: a.courier.id, courier_name: a.courier.name, delivery_ids: [a.delivery.id], cash_collected: 0,
      courier_fees: 7, missing_payments: [], missing_withdrawal: { amount: 7, error: 'x' }, created_at: '2026-11-14T12:00:00Z',
    }] });
    expect(newStore()).toMatchObject({ ok: false, error: expect.stringMatching(/acerto com o entregador para terminar/) });
    useTcheStore.setState({ courierSettleFollowUps: [], outbox: [] });
    expect(newStore().ok).toBe(true);
  });
});

describe('terminar a pendência recebe só o valor do acerto e não perde senha (GPT, rodada 10 do PR #54)', () => {
  /** Acerto gravado na nuvem com a senha ainda por receber (o recebimento falhou logo depois da nuvem). */
  async function stuck() {
    expect(st().openCashSession(100).ok).toBe(true);
    const a = deliveredOrder();
    connectCloud();
    const calls: Call[] = [];
    const fn = afterCloud(cloudFn(calls), () => useTcheStore.setState({ cloudSkippedOrderIds: [a.order.id] }));
    const r = await st().settleCourierOnline(a.courier.id, { payFromDrawer: false, auth: { managerPin: '9999', reason: 'Pago em pix pela loja' }, fetchFn: fn });
    expect(r.ok).toBe(false);
    useTcheStore.setState({ cloudSkippedOrderIds: [] });
    const settlementId = calls[0]!.body.p_id as string;
    const planned = st().courierSettleFollowUps![0]!.missing_payments[0]!.amount;
    expect(planned).toBe(a.order.total_amount);
    return { a, settlementId, planned, calls };
  }
  const setOrder = (id: string, patch: Record<string, unknown>) =>
    useTcheStore.setState((s) => ({ orders: s.orders.map((o) => (o.id === id ? { ...o, ...patch } : o)) }));
  const entrega = (deliveryId: string) => st().payments.filter((p) => p.idempotency_key === `entrega-${deliveryId}`);
  const missing = () => st().courierSettleFollowUps?.[0]?.missing_payments ?? [];

  it('o saldo mudou entre a nuvem e o recebimento: não recebe outro valor; com o saldo de volta, recebe o do acerto uma vez', async () => {
    expect(st().openCashSession(100).ok).toBe(true);
    const a = deliveredOrder();
    connectCloud();
    const calls: Call[] = [];
    const planned = a.order.total_amount;
    const changed = planned - 20;
    // A nuvem grava o acerto com o valor planejado; antes de receber, o saldo da conta muda.
    const fn = afterCloud(cloudFn(calls), () => setOrder(a.order.id, { remaining_balance: changed }));
    const r = await st().settleCourierOnline(a.courier.id, { payFromDrawer: false, auth: { managerPin: '9999', reason: 'Pago em pix pela loja' }, fetchFn: fn });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/O saldo da senha \d+ mudou desde o acerto \(acerto: R\$\s[\d,]+, saldo agora: R\$\s[\d,]+\)/) });
    expect(calls[0]!.body.p_cash_collected).toBe(planned);
    expect(entrega(a.delivery.id)).toEqual([]);
    expect(missing()).toEqual([expect.objectContaining({ delivery_id: a.delivery.id, amount: planned, error: expect.stringMatching(/mudou desde o acerto/) })]);
    const id = calls[0]!.body.p_id as string;
    const again = st().finishCourierSettleFollowUp(id, { kind: 'payments' });
    expect(again).toMatchObject({ ok: false, error: expect.stringMatching(/Confira no caixa antes de receber/) });
    expect(entrega(a.delivery.id)).toEqual([]);

    setOrder(a.order.id, { remaining_balance: planned });
    const ok = st().finishCourierSettleFollowUp(id, { kind: 'payments' });
    if (!ok.ok) throw new Error(ok.error);
    expect(entrega(a.delivery.id).map((p) => p.amount)).toEqual([planned]);
    expect(st().courierSettleFollowUps).toEqual([]);
    expect(st().finishCourierSettleFollowUp(id, { kind: 'payments' }).ok).toBe(false);
    expect(entrega(a.delivery.id)).toHaveLength(1);
  });

  it('a conta da senha não está no aparelho: a senha fica na pendência', async () => {
    const { a, settlementId } = await stuck();
    useTcheStore.setState((s) => ({ orders: s.orders.filter((o) => o.id !== a.order.id) }));
    const r = st().finishCourierSettleFollowUp(settlementId, { kind: 'payments' });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/não está neste aparelho/) });
    expect(missing()).toEqual([expect.objectContaining({ delivery_id: a.delivery.id, error: expect.stringMatching(/sincronize e tente de novo/) })]);
  });

  it.each([
    ['aberta (OPEN)', { status: 'OPEN' }],
    ['fechada (CLOSED)', { status: 'CLOSED', remaining_balance: 0 }],
    ['cancelada (CANCELED)', { status: 'CANCELED' }],
    ['em pagamento com saldo zero', { status: 'PAYING', remaining_balance: 0 }],
  ])('conta %s sem o recebimento da entrega: a senha fica na pendência', async (_label, patch) => {
    const { a, settlementId } = await stuck();
    setOrder(a.order.id, patch);
    const r = st().finishCourierSettleFollowUp(settlementId, { kind: 'payments' });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/confira no caixa/i) });
    expect(entrega(a.delivery.id)).toEqual([]);
    expect(missing()).toEqual([expect.objectContaining({ delivery_id: a.delivery.id })]);
  });

  it('recebimento da entrega já aprovado com o valor do acerto: o passo termina, sem pagamento novo', async () => {
    const { a, settlementId, planned } = await stuck();
    const paid = st().registerPayment({
      orderId: a.order.id, amount: planned, method: 'CASH', status: 'APPROVED', terminal_id: null, acquirer: 'CASH_DESK',
      acquirer_cnpj: null, card_brand: null, nsu: null, authorization_code: null, terminal_serial: null, idempotency_key: `entrega-${a.delivery.id}`, item_ids: [],
    });
    if (!paid.ok) throw new Error(paid.error);
    const before = st().payments.length;
    const r = st().finishCourierSettleFollowUp(settlementId, { kind: 'payments' });
    if (!r.ok) throw new Error(r.error);
    expect(st().payments).toHaveLength(before);
    expect(st().courierSettleFollowUps).toEqual([]);
  });

  it('recebimento da entrega aprovado com outro valor: fica na pendência, sem pagamento novo', async () => {
    const { a, settlementId, planned } = await stuck();
    const paid = st().registerPayment({
      orderId: a.order.id, amount: planned - 5, method: 'CASH', status: 'APPROVED', terminal_id: null, acquirer: 'CASH_DESK',
      acquirer_cnpj: null, card_brand: null, nsu: null, authorization_code: null, terminal_serial: null, idempotency_key: `entrega-${a.delivery.id}`, item_ids: [],
    });
    if (!paid.ok) throw new Error(paid.error);
    const before = st().payments.length;
    const r = st().finishCourierSettleFollowUp(settlementId, { kind: 'payments' });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/outro valor/) });
    expect(st().payments).toHaveLength(before);
    expect(missing()).toEqual([expect.objectContaining({ delivery_id: a.delivery.id, amount: planned })]);
  });
});
