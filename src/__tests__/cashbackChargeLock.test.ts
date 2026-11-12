import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PENDING_CHARGE_TTL_MS, useTcheStore } from '../store/useTcheStore';
import { seedId } from '../data/seed';
import type { SelectedModifier } from '../types';

// P0-01 da rodada 8 do GPT (PR #35): com o cashback recusado pela nuvem, a exceção da trava
// de cobrança vale só para a resposta da cobrança da maquininha em andamento (trava ativa
// com o mesmo request_id), não para qualquer charge_request_id.
const st = () => useTcheStore.getState();
const PHONE = '55999991234';

function size(key: '300' | '500'): SelectedModifier {
  const opt = st().modifierOptions.find((o) => o.id === seedId(`mo:tamanho-chopp:${key}`))!;
  return { group_id: opt.group_id, option_id: opt.id, name: opt.name, additional_price: opt.additional_price };
}

function openWithChopp(tableNumber: number, qty: number, mod: SelectedModifier): string {
  expect(st().login('1111').ok).toBe(true);
  const table = st().tables.find((t) => t.number === tableNumber)!;
  const opened = st().openTable(table.id, 2, null);
  if (!opened.ok) throw new Error(opened.error);
  const p = st().products.find((x) => x.code === '201')!;
  const tray = st().addToTray({
    order_id: opened.data.id, product_id: p.id, half_product_ids: [], quantity: qty, unit_price: p.price, modifiers: [mod],
    modifiers_unit_price: 0, meat_doneness: null, quick_tags: [], free_notes: '', sector: p.sector,
  });
  if (!tray.ok) throw new Error(tray.error);
  const sent = st().dispatchTray(opened.data.id);
  if (!sent.ok) throw new Error(sent.error);
  return opened.data.id;
}

const card = (orderId: string, amount: number, key: string, chargeRequestId?: string) => st().registerPayment({
  orderId, amount, method: 'CREDIT', status: 'APPROVED', terminal_id: 't1', acquirer: 'STONE', acquirer_cnpj: '16501555000157',
  card_brand: 'VISA', nsu: '123456', authorization_code: 'A1B2C3', terminal_serial: 'SN1', idempotency_key: key, item_ids: [],
  ...(chargeRequestId !== undefined ? { charge_request_id: chargeRequestId } : {}),
});

/** Conta com cashback resgatado e o resgate recusado pela nuvem (o banco não concedeu). */
function orderWithRejectedCashback(beforeRejection?: (orderId: string) => void): { orderId: string; balance: number } {
  vi.useFakeTimers({ now: new Date('2026-11-09T21:00:00-03:00'), toFake: ['Date'] }); // segunda
  const first = openWithChopp(4, 4, size('500'));
  const due = st().orders.find((o) => o.id === first)!.remaining_balance;
  const paid = st().registerPayment({
    orderId: first, amount: due, method: 'CASH', status: 'APPROVED', terminal_id: null, acquirer: 'CASH_DESK', acquirer_cnpj: null,
    card_brand: null, nsu: null, authorization_code: null, terminal_serial: null, idempotency_key: 'k-first', item_ids: [],
  });
  if (!paid.ok) throw new Error(paid.error);
  expect(st().earnCashback(first, { phone: PHONE, name: 'Ana', cpf: null, optIn: true }).ok).toBe(true);
  vi.setSystemTime(new Date('2026-11-10T20:00:00-03:00')); // terça
  const orderId = openWithChopp(6, 1, size('300'));
  const redeemed = st().redeemCashback(orderId, PHONE);
  if (!redeemed.ok) throw new Error(redeemed.error);
  expect(redeemed.data.amount).toBeGreaterThan(0);
  beforeRejection?.(orderId);
  const redeemEvent = st().outbox.find((e) => e.table === 'cashback_ledger' && e.op === 'INSERT' && e.payload.order_id === orderId)!;
  st().rejectSyncEvents([{ eventId: redeemEvent.id, status: 400, message: 'TCHEFOOD_CASHBACK: resgate só de terça a quinta (relógio do servidor).' }]);
  return { orderId, balance: st().orders.find((o) => o.id === orderId)!.remaining_balance };
}

/** O que uma tentativa recusada não pode mudar. */
const snapshot = (orderId: string) => {
  const o = st().orders.find((x) => x.id === orderId)!;
  return JSON.stringify({ payments: st().payments, paid: o.paid_amount, balance: o.remaining_balance, status: o.status, outbox: st().outbox.map((e) => e.id) });
};

beforeEach(() => st().resetDemo());
afterEach(() => vi.useRealTimers());

describe('cashback recusado: exceção da trava de cobrança só para a cobrança em andamento', () => {
  const BLOCKED = 'A nuvem recusou o cashback desta conta';

  it('pagamento aprovado sem charge_request_id, com id arbitrário ou de cobrança encerrada é recusado e não muda nada', () => {
    let closedRequest = '';
    const { orderId, balance } = orderWithRejectedCashback((id) => {
      // Cobrança iniciada antes da recusa e já encerrada (resposta tratada, trava liberada).
      expect(st().beginTerminalCharge(id, 'req-encerrada', st().orders.find((o) => o.id === id)!.remaining_balance).ok).toBe(true);
      st().endTerminalCharge('req-encerrada');
      closedRequest = 'req-encerrada';
    });
    expect(st().pendingCharges).toEqual([]);
    const before = snapshot(orderId);
    for (const r of [card(orderId, balance, 'k1'), card(orderId, balance, 'k2', 'requisicao-antiga'), card(orderId, balance, 'k3', closedRequest)]) {
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).toContain(BLOCKED);
    }
    expect(snapshot(orderId)).toBe(before);
  });

  it('cobrança com a trava expirada (mais de 5 minutos) também é recusada: vai para a conferência pelo comprovante', () => {
    const { orderId, balance } = orderWithRejectedCashback((id) => {
      expect(st().beginTerminalCharge(id, 'req-expirada', st().orders.find((o) => o.id === id)!.remaining_balance).ok).toBe(true);
    });
    vi.setSystemTime(new Date(Date.now() + PENDING_CHARGE_TTL_MS + 1000));
    const before = snapshot(orderId);
    const r = card(orderId, balance, 'k-exp', 'req-expirada');
    expect(!r.ok && r.error).toContain(BLOCKED);
    expect(snapshot(orderId)).toBe(before);
  });

  it('resposta da cobrança iniciada antes da recusa, com o mesmo request_id: registrada uma vez', () => {
    const { orderId, balance } = orderWithRejectedCashback((id) => {
      expect(st().beginTerminalCharge(id, 'req-viva', st().orders.find((o) => o.id === id)!.remaining_balance).ok).toBe(true);
    });
    // Outro id com a trava ativa continua recusado (a trava da conta é desta cobrança).
    const before = snapshot(orderId);
    expect(card(orderId, balance, 'k-outro', 'req-outra').ok).toBe(false);
    expect(snapshot(orderId)).toBe(before);
    const ok = card(orderId, balance, 'k-viva', 'req-viva');
    if (!ok.ok) throw new Error(ok.error);
    expect(st().payments.filter((p) => p.order_id === orderId)).toHaveLength(1);
    expect(st().pendingCharges.some((c) => c.request_id === 'req-viva')).toBe(false);
    // Reenvio da mesma resposta: não registra de novo.
    const again = card(orderId, balance, 'k-viva', 'req-viva');
    expect(again.ok).toBe(false);
    expect(st().payments.filter((p) => p.order_id === orderId)).toHaveLength(1);
    expect(st().outbox.filter((e) => e.table === 'payments' && e.payload.order_id === orderId)).toHaveLength(1);
  });
});
