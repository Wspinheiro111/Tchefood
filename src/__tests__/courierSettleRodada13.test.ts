// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COURIER_WITHDRAWAL_DUPLICATE_NOTICE, useTcheStore, type PickupLine } from '../store/useTcheStore';
import { ownerCashOutside } from '../lib/cashRegister';
import type { FetchLike } from '../lib/sync/supabaseSync';
import type { CashSession, Payment } from '../types';

// Sangria do acerto com o entregador (GPT, rodada 12 do PR #54):
// P1-01 sangria de outro valor citando o acerto não resolve a pendência.
// P1-02 sangria do acerto recusada pela nuvem volta à pendência, sem movimento duplicado.
// P2-01 painel do dono confere o dinheiro fora do caixa com os caixas da nuvem.

const st = () => useTcheStore.getState();
const MANAGER = { managerPin: '9999', reason: 'Acerto do entregador' };
const line = (): PickupLine => ({ product_id: st().products.find((p) => p.code === '301')!.id, quantity: 1, modifiers: [], meat_doneness: null, half_product_ids: [], quick_tags: [], free_notes: '' });

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
  return { courier };
}

function connectCloud() {
  useTcheStore.setState((s) => ({
    cloud: { url: 'http://cloud.test', anon_key: 'anon', email: 'loja@test', access_token: 'jwt', refresh_token: 'r', expires_at: 9e9, tenant_id: s.tenant.id },
    cloudLinkedTenantId: s.tenant.id,
    outbox: [],
  }));
}

const cloudFn: FetchLike = async (_url, init) => {
  const body = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
  const ids = body.p_delivery_ids as string[];
  const row = {
    id: body.p_id, tenant_id: st().tenant.id, courier_id: body.p_courier, deliveries: ids.length,
    cash_collected: body.p_cash_collected, courier_fees: body.p_courier_fees, cash_movement_id: null,
    delivery_ids: [...ids].sort(), settled_by_user_id: body.p_staff, created_at: '2026-11-15T12:00:00+00:00',
  };
  return { ok: true, status: 200, text: async () => JSON.stringify(row) };
};

/** Acerto pela nuvem com a sangria do ganho na gaveta; devolve o acerto e o evento da autorização. */
async function settledWithWithdrawal() {
  const a = deliveredOrder();
  connectCloud();
  const r = await st().settleCourierOnline(a.courier.id, { payFromDrawer: true, auth: MANAGER, fetchFn: cloudFn });
  expect(r.ok, r.ok ? '' : r.error).toBe(true);
  const settlement = st().courierSettlements[0]!;
  expect(settlement.courier_fees).toBeGreaterThan(0);
  const auth = st().outbox.find((e) => e.table === 'audit_logs' && e.payload.action_type === 'CASH_WITHDRAWAL')!;
  expect((auth.payload.metadata as Record<string, unknown>).courier_settlement_id).toBe(settlement.id);
  const movementId = (auth.payload.metadata as Record<string, unknown>).movement_id as string;
  expect(st().cashMovements.filter((m) => m.id === movementId)).toHaveLength(1);
  expect(st().courierSettleFollowUps ?? []).toHaveLength(0);
  return { settlement, auth, movementId };
}

beforeEach(() => {
  st().resetDemo();
  expect(st().login('5555').ok).toBe(true);
  expect(st().openCashSession(100).ok).toBe(true);
});
afterEach(() => {
  useTcheStore.setState({ cloud: null });
});

describe('P1-02: sangria do acerto recusada pela nuvem', () => {
  it('volta à pendência com o motivo; a autorização e o movimento saem daqui; refazer cria uma sangria só', async () => {
    const { settlement, auth, movementId } = await settledWithWithdrawal();
    const withdrawn = st().cashMovements.filter((m) => m.type === 'WITHDRAWAL').length;
    st().rejectSyncEvents([{ eventId: auth.id, status: 400, message: 'TCHEFOOD_ANTIFRAUDE: PIN de gerente bloqueado.' }]);
    const f = st().courierSettleFollowUps!.find((x) => x.settlement_id === settlement.id)!;
    expect(f.missing_withdrawal).toMatchObject({ amount: settlement.courier_fees, error: expect.stringMatching(/recusou a sangria do acerto: .*PIN de gerente bloqueado/) });
    expect(st().cashMovements.some((m) => m.id === movementId)).toBe(false);
    expect(st().auditLogs.some((l) => l.id === auth.row_id)).toBe(false);
    expect(st().outbox.some((e) => e.table === 'cash_movements' && e.row_id === movementId)).toBe(false);
    expect((st().syncRejected ?? []).some((r) => r.event.id === auth.id || r.event.row_id === movementId)).toBe(false);
    expect(st().cashMovements.filter((m) => m.type === 'WITHDRAWAL')).toHaveLength(withdrawn - 1);

    const again = st().finishCourierSettleFollowUp(settlement.id, { kind: 'withdrawal', auth: MANAGER });
    expect(again.ok, again.ok ? '' : again.error).toBe(true);
    expect(st().cashMovements.filter((m) => m.type === 'WITHDRAWAL')).toHaveLength(withdrawn);
    expect(st().outbox.filter((e) => e.table === 'audit_logs' && e.payload.action_type === 'CASH_WITHDRAWAL')).toHaveLength(1);
  });

  it('recusa porque o ganho já foi pago em outro registro: não volta à pendência e avisa', async () => {
    const { settlement, auth, movementId } = await settledWithWithdrawal();
    st().rejectSyncEvents([{ eventId: auth.id, status: 400, message: 'TCHEFOOD_ENTREGA: a sangria deste acerto já está registrada no caixa; o ganho não sai duas vezes.' }]);
    expect((st().courierSettleFollowUps ?? []).some((x) => x.settlement_id === settlement.id)).toBe(false);
    expect(st().cashMovements.some((m) => m.id === movementId)).toBe(false);
    expect(st().syncStatus.last_error).toContain(COURIER_WITHDRAWAL_DUPLICATE_NOTICE);
  });

  it('o movimento já recusado junto com a autorização também sai', async () => {
    const { auth, movementId } = await settledWithWithdrawal();
    const mv = st().outbox.find((e) => e.table === 'cash_movements' && e.row_id === movementId)!;
    st().rejectSyncEvents([
      { eventId: auth.id, status: 400, message: 'PIN de gerente incorreto' },
      { eventId: mv.id, status: 400, message: 'TCHEFOOD_CAIXA: sangria sem a autorização do gerente gravada.' },
    ]);
    expect((st().syncRejected ?? []).some((r) => r.event.row_id === movementId)).toBe(false);
  });
});

describe('P1-01: sangria de outro valor não resolve a pendência', () => {
  it('a sangria citando o acerto com valor menor não conta como feita', async () => {
    const { settlement, auth } = await settledWithWithdrawal();
    st().rejectSyncEvents([{ eventId: auth.id, status: 400, message: 'PIN de gerente incorreto' }]);
    // Sangria de R$ 1,00 citando o acerto (valor diferente do ganho).
    expect(st().addCashWithdrawal(1, MANAGER, { courier_settlement_id: settlement.id }).ok).toBe(true);
    const r = st().finishCourierSettleFollowUp(settlement.id, { kind: 'withdrawal', auth: MANAGER });
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    // A pendência foi resolvida pela sangria do valor certo, não pela de R$ 1,00.
    const right = st().auditLogs.filter((l) => l.action_type === 'CASH_WITHDRAWAL'
      && (l.metadata as Record<string, unknown> | null)?.courier_settlement_id === settlement.id
      && -l.amount_impact === settlement.courier_fees);
    expect(right).toHaveLength(1);
  });
});

describe('P2-01: painel do dono sem caixa aberto aqui', () => {
  it('confere o dinheiro recebido fora do caixa pelos horários do caixa da nuvem', () => {
    const since = new Date('2026-11-15T10:00:00Z');
    const now = new Date('2026-11-15T18:00:00Z');
    const pay = { id: 'p1', status: 'APPROVED', method: 'CASH', amount: 25, created_at: '2026-11-15T16:00:00Z' } as Payment;
    const remote = [{ id: 'c1', opened_at: '2026-11-15T11:00:00Z', closed_at: '2026-11-15T15:00:00Z' }];
    expect(ownerCashOutside([pay], [] as CashSession[], since, now, remote)).toEqual({ amount: 25, count: 1 });
    expect(ownerCashOutside([pay], [] as CashSession[], since, now, [])).toBeUndefined();
  });
});
