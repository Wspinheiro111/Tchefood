// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { awaitPersisted, useTcheStore } from '../store/useTcheStore';
import { idbStorage } from '../lib/idbStorage';

// Pendência do acerto com o entregador (auditoria interna do PR #54):
// 1) "pago por fora" / "senha resolvida com gerente" recusados pela nuvem (PIN não conferiu,
//    acerto não encontrado, sangria já registrada): a pendência volta neste aparelho.
// 2) awaitPersisted: espera a gravação do estado no aparelho antes de chamar a nuvem.

const st = () => useTcheStore.getState();
const SID = '00000000-0000-4000-8000-0000000000a1';
const D1 = '00000000-0000-4000-8000-0000000000d1';
const D2 = '00000000-0000-4000-8000-0000000000d2';
const MANAGER = { managerPin: '9999', reason: 'Resolvido com o gerente' };
const PIN_REFUSED = 'A nuvem não confirmou o PIN do gerente.';

function stuck(withdrawal: boolean, payments: 0 | 1 | 2 = 2) {
  const all = [
    { delivery_id: D1, order_id: 'o-1', pickup_number: 12, amount: 30, error: 'A conta da senha 12 não está neste aparelho.' },
    { delivery_id: D2, order_id: 'o-2', pickup_number: 13, amount: 20, error: 'O saldo da senha 13 mudou desde o acerto.' },
  ];
  useTcheStore.setState({ courierSettleFollowUps: [{
    settlement_id: SID, courier_id: st().couriers[0]!.id, courier_name: st().couriers[0]!.name, delivery_ids: [D1, D2], cash_collected: 50, courier_fees: 14,
    missing_payments: all.slice(0, payments),
    missing_withdrawal: withdrawal ? { amount: 14, error: 'x' } : null,
    created_at: '2026-11-14T12:00:00Z',
  }] });
}
const auditEvent = (action: string) => st().outbox.find((e) => e.table === 'audit_logs' && e.payload.action_type === action)!;
const follow = () => (st().courierSettleFollowUps ?? []).find((f) => f.settlement_id === SID);

beforeEach(() => {
  st().resetDemo();
  expect(st().login('5555').ok).toBe(true);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('pendência do acerto volta quando a nuvem recusa o registro do gerente', () => {
  it('"pago por fora" recusado (PIN): a sangria volta à pendência, com o motivo; descartar o recusado não a tira', () => {
    stuck(true, 0);
    expect(st().finishCourierSettleFollowUp(SID, { kind: 'paid_outside', auth: MANAGER }).ok).toBe(true);
    expect(follow()).toBeUndefined();
    const ev = auditEvent('COURIER_PAID_OUTSIDE');
    st().rejectSyncEvents([{ eventId: ev.id, status: 200, message: PIN_REFUSED }]);
    expect(st().syncRejected.map((r) => r.event.id)).toEqual([ev.id]);
    const f = follow()!;
    expect(f).toMatchObject({ settlement_id: SID, courier_id: st().couriers[0]!.id, missing_payments: [] });
    expect(f.missing_withdrawal).toEqual({ amount: 14, error: expect.stringContaining(PIN_REFUSED) });
    // Descartado da lista de recusados: a pendência fica.
    useTcheStore.setState({ syncRejected: [] });
    expect(follow()!.missing_withdrawal).not.toBeNull();
    // E dá para refazer com o PIN certo.
    expect(st().finishCourierSettleFollowUp(SID, { kind: 'paid_outside', auth: MANAGER }).ok).toBe(true);
  });

  it('"pago por fora" recusado com outras senhas ainda na pendência: só a sangria volta, sem duplicar', () => {
    stuck(true, 1);
    expect(st().finishCourierSettleFollowUp(SID, { kind: 'paid_outside', auth: MANAGER }).ok).toBe(true);
    const ev = auditEvent('COURIER_PAID_OUTSIDE');
    st().rejectSyncEvents([{ eventId: ev.id, status: 404, message: 'acerto não encontrado' }]);
    expect(st().courierSettleFollowUps).toHaveLength(1);
    expect(follow()!.missing_payments.map((m) => m.delivery_id)).toEqual([D1]);
    expect(follow()!.missing_withdrawal).toMatchObject({ amount: 14 });
  });

  it('não restaura em dobro: a sangria já de volta na pendência fica como está', () => {
    stuck(true, 0);
    expect(st().finishCourierSettleFollowUp(SID, { kind: 'paid_outside', auth: MANAGER }).ok).toBe(true);
    const ev = auditEvent('COURIER_PAID_OUTSIDE');
    stuck(true, 0); // já voltou (ex.: outra recusa)
    const before = follow();
    st().rejectSyncEvents([{ eventId: ev.id, status: 200, message: PIN_REFUSED }]);
    expect(st().courierSettleFollowUps).toHaveLength(1);
    expect(follow()).toEqual(before);
  });

  it('"senha resolvida" recusada: a senha volta à pendência (com a outra que ficou), uma vez só', () => {
    stuck(false, 2);
    expect(st().finishCourierSettleFollowUp(SID, { kind: 'payment_resolved', delivery_id: D1, auth: MANAGER }).ok).toBe(true);
    expect(follow()!.missing_payments.map((m) => m.delivery_id)).toEqual([D2]);
    const ev = auditEvent('COURIER_PAYMENT_RESOLVED');
    st().rejectSyncEvents([{ eventId: ev.id, status: 200, message: PIN_REFUSED }]);
    const f = follow()!;
    expect(f.missing_payments.map((m) => m.delivery_id).sort()).toEqual([D1, D2].sort());
    expect(f.missing_payments.find((m) => m.delivery_id === D1)).toMatchObject({ order_id: 'o-1', pickup_number: 12, amount: 30, error: expect.stringContaining(PIN_REFUSED) });
    // Recusa repetida do mesmo registro (ex.: Reenviar recusados): não duplica a senha.
    useTcheStore.setState((s) => ({ outbox: [ev, ...s.outbox], syncRejected: [] }));
    st().rejectSyncEvents([{ eventId: ev.id, status: 200, message: PIN_REFUSED }]);
    expect(follow()!.missing_payments).toHaveLength(2);
  });

  it('"senha resolvida" recusada depois de a pendência terminar: a pendência volta inteira, com os dados do acerto', () => {
    stuck(false, 1);
    useTcheStore.setState((s) => ({ courierSettlements: [{
      id: SID, tenant_id: s.tenant.id, courier_id: s.couriers[0]!.id, deliveries: 2, cash_collected: 50, courier_fees: 14, cash_movement_id: null,
      delivery_ids: [D1, D2], settled_by_user_id: 'u', created_at: '2026-11-14T12:00:00Z',
    } as never, ...s.courierSettlements] }));
    expect(st().finishCourierSettleFollowUp(SID, { kind: 'payment_resolved', delivery_id: D1, auth: MANAGER }).ok).toBe(true);
    expect(follow()).toBeUndefined();
    const ev = auditEvent('COURIER_PAYMENT_RESOLVED');
    st().rejectSyncEvents([{ eventId: ev.id, status: 409, message: 'registro recusado' }]);
    expect(follow()).toMatchObject({
      settlement_id: SID, courier_id: st().couriers[0]!.id, courier_name: st().couriers[0]!.name,
      delivery_ids: [D1, D2], cash_collected: 50, courier_fees: 14, missing_withdrawal: null,
      missing_payments: [{ delivery_id: D1, order_id: 'o-1', pickup_number: 12, amount: 30 }],
    });
  });

  it('outros registros recusados não mexem na pendência', () => {
    stuck(true, 0);
    const before = st().courierSettleFollowUps;
    const ev = { id: 'e-x', table: 'audit_logs' as const, op: 'INSERT' as const, row_id: 'r-x', payload: { id: 'r-x', action_type: 'CASH_WITHDRAWAL', metadata: { courier_settlement_id: SID } }, created_at: '2026-11-14T12:00:00Z' };
    useTcheStore.setState((s) => ({ outbox: [...s.outbox, ev] }));
    st().rejectSyncEvents([{ eventId: ev.id, status: 400, message: 'x' }]);
    expect(st().courierSettleFollowUps).toEqual(before);
  });
});

describe('awaitPersisted: o estado está gravado no aparelho antes da chamada à nuvem', () => {
  it('grava o estado atual no aparelho e devolve true', async () => {
    const writes: string[] = [];
    const orig = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      writes.push(v);
      orig.call(this, k, v);
    });
    useTcheStore.setState({ courierSettlePending: [{ id: 'pend-1' } as never] });
    await expect(awaitPersisted()).resolves.toBe(true);
    expect(writes.at(-1)).toContain('pend-1');
  });

  it('falha na gravação não lança (o acerto segue como antes): devolve false', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    await expect(awaitPersisted()).resolves.toBe(false);
  });

  it('o estado que só ficaria na memória (IndexedDB e localStorage recusam) não conta como gravado (Codex no PR #54)', async () => {
    // O adaptador do persist cai para a memória sem avisar: awaitPersisted não pode devolver true.
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('cheio', 'QuotaExceededError'); });
    expect(() => idbStorage.setItem('x', 'y')).not.toThrow();
    await expect(awaitPersisted()).resolves.toBe(false);
  });
});
