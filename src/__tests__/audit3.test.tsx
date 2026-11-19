// @vitest-environment jsdom
/**
 * Auditoria interna 3 (revisor de regressão/UX): textos para toda loja na nuvem, liberação da própria reserva sem
 * PIN no "Conferi no extrato", evento recusado com o que fazer, aviso de não gravado com as contas e sem quebrar com
 * o armazenamento bloqueado, recusa da maquininha esperando a liberação, pagamento duplicado (23505) segurando a
 * conta, e o PIN do gerente conferido antes de pedir reserva no servidor.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncEvent } from '../types';

const releasePaymentClaim = vi.fn();
vi.mock('../lib/payments/paymentClaim', async (orig) => ({
  ...(await orig<typeof import('../lib/payments/paymentClaim')>()),
  releasePaymentClaim: (...a: unknown[]) => releasePaymentClaim(...a),
}));
const startPaymentClaim = vi.fn();
const checkHoldClaim = vi.fn();
vi.mock('../lib/payments/claimFlow', async (orig) => ({
  ...(await orig<typeof import('../lib/payments/claimFlow')>()),
  startPaymentClaim: (...a: unknown[]) => startPaymentClaim(...a),
  checkHoldClaim: (...a: unknown[]) => checkHoldClaim(...a),
}));

const { useTcheStore } = await import('../store/useTcheStore');
const { HoldNotChargedButton, OWN_CLAIM_RELEASED, holdHasApprovalEvidence } = await import('../components/StuckClaims');
const { UnsavedStorageBanner, UNSAVED_STORAGE_WARNING } = await import('../components/UnsavedStorageBanner');
const { ConfirmReviewedChargeSheet } = await import('../components/ConfirmReviewedChargeSheet');
const holds = await import('../lib/payments/reviewHolds');
const ledger = await import('../lib/payments/claimLedger');
const { CLAIM_ACTIVE_HERE, CLAIM_REQUIRED_ERROR, CLAIM_OFFLINE_ERROR, releasePaymentClaimManager } = await import('../lib/payments/paymentClaim');
const { CLOUD_READ_BLOCK } = await import('../screens/CheckoutScreen');
const { declinedAwaitingRelease, rejectedOrderMessage } = await import('../lib/sync/useCloudSync');
const { flushOutbox } = await import('../lib/sync/supabaseSync');
const { useToast } = await import('../components/ui');

const TOKEN = 'cd'.repeat(32);
const CFG = { url: 'https://x.supabase.co', anonKey: 'anon', accessToken: 'jwt' };
const st = () => useTcheStore.getState();
const toasts = () => useToast.getState().toasts.map((t) => t.text);

beforeEach(() => {
  localStorage.clear();
  ledger.resetClaimLedger();
  for (const o of st().orders) holds.clearReviewHold(o.id);
  releasePaymentClaim.mockReset();
  startPaymentClaim.mockReset();
  checkHoldClaim.mockReset();
  useToast.setState({ toasts: [] });
});
afterEach(() => {
  cleanup();
  useTcheStore.setState({ cloud: null } as never);
});

describe('item 1: textos de toda loja na nuvem (com ou sem Point)', () => {
  it('sem conexão, sem reserva e sem leitura: nenhum fala de Point; o de sem conexão diz o que fazer', () => {
    for (const text of [CLAIM_OFFLINE_ERROR, CLAIM_REQUIRED_ERROR, CLOUD_READ_BLOCK]) {
      expect(text).toMatch(/^(Loja conectada à nuvem|Sem leitura da nuvem: loja conectada à nuvem)/);
      expect(text).not.toMatch(/Point/);
    }
    expect(CLAIM_OFFLINE_ERROR).toMatch(/sem conexão não dá para receber neste aparelho\. Confira a internet e tente de novo\./);
  });

  it('TF011 numa reserva deste aparelho não fala de "outro aparelho"', async () => {
    ledger.beginLocalClaim('k-own', 'o1', TOKEN);
    const d = {
      config: async () => CFG, staff: async () => 'staff-1', timer: () => new Promise<void>(() => undefined),
      fetch: async () => ({ ok: false, status: 400, text: async () => '{"code":"TF011","message":"claim_active"}' }),
      prepareOrder: async () => ({ ok: true }),
    } as never;
    const out = await releasePaymentClaimManager('k-own', '9999', 'Não houve cobrança', d);
    expect(out).toEqual({ ok: false, active: true, error: CLAIM_ACTIVE_HERE });
    expect(CLAIM_ACTIVE_HERE).not.toMatch(/outro aparelho/);
  });
});

function stoneHold(code: string, key = 'k-own') {
  return holds.setReviewHold({ order_id: 'o-own', amount: 12, reason: 'Sem resposta da maquininha', code, refund: 'TERMINAL', method: 'CREDIT', acquirer: 'STONE', idempotency_key: key, item_ids: [] });
}

describe('item 2 (P2-2): "Conferi no extrato: não foi cobrado" na reserva deste aparelho', () => {
  beforeEach(() => useTcheStore.setState({ cloud: { url: 'x' } } as never));

  it('com o segredo e a cobrança parada: libera pelo segredo na hora, sem PIN; tira a trava e o registro', async () => {
    ledger.beginLocalClaim('k-own', 'o-own', TOKEN);
    ledger.detachLocalClaim('k-own'); // a cobrança não está rodando aqui
    ledger.addPendingRelease({ key: 'k-own', order_id: 'o-own', reason: 'r', release_token: TOKEN });
    const hold = stoneHold('TIMEOUT');
    releasePaymentClaim.mockResolvedValue({ ok: true });
    const onCleared = vi.fn();
    render(<HoldNotChargedButton hold={hold} label="Mesa 1" onCleared={onCleared} />);
    fireEvent.click(screen.getByRole('button', { name: 'Conferi no extrato: não foi cobrado' }));
    await waitFor(() => expect(onCleared).toHaveBeenCalledTimes(1));
    expect(releasePaymentClaim).toHaveBeenCalledWith('k-own', 'Conferido no extrato: não foi cobrado', TOKEN);
    expect(holds.getReviewHoldByKey('k-own')).toBeNull();
    expect(ledger.localClaim('k-own')).toBeNull();
    expect(ledger.pendingRelease('k-own')).toBeNull();
    expect(toasts()).toContain(OWN_CLAIM_RELEASED);
    expect(screen.queryByText('Não foi cobrado: liberar a reserva')).toBeNull();
  });

  it('sem resposta do servidor: a trava fica, com o aviso; recusa definitiva abre o gerente', async () => {
    ledger.beginLocalClaim('k-own', 'o-own', TOKEN);
    ledger.detachLocalClaim('k-own');
    const hold = stoneHold('TIMEOUT');
    releasePaymentClaim.mockResolvedValueOnce({ ok: false, transient: true, error: CLAIM_OFFLINE_ERROR });
    const onCleared = vi.fn();
    render(<HoldNotChargedButton hold={hold} label="Mesa 1" onCleared={onCleared} />);
    fireEvent.click(screen.getByRole('button', { name: 'Conferi no extrato: não foi cobrado' }));
    await waitFor(() => expect(toasts()).toContain(CLAIM_OFFLINE_ERROR));
    expect(onCleared).not.toHaveBeenCalled();
    expect(holds.getReviewHoldByKey('k-own')).not.toBeNull();
    releasePaymentClaim.mockResolvedValueOnce({ ok: false, transient: false, error: 'TF004' });
    fireEvent.click(screen.getByRole('button', { name: 'Conferi no extrato: não foi cobrado' }));
    await waitFor(() => expect(screen.getByText('Não foi cobrado: liberar a reserva')).toBeTruthy());
    expect(holds.getReviewHoldByKey('k-own')).not.toBeNull();
  });

  it.each([
    ['trava com aprovação na maquininha (REGISTER_FAILED)', 'REGISTER_FAILED', false],
    ['trava com aprovação na maquininha (APPROVED_WITHOUT_REFERENCE)', 'APPROVED_WITHOUT_REFERENCE', false],
    ['cobrança ainda rodando neste aparelho', 'TIMEOUT', true],
  ])('%s: não libera sozinho, abre a liberação do gerente', async (_n, code, running) => {
    ledger.beginLocalClaim('k-own', 'o-own', TOKEN);
    if (!running) ledger.detachLocalClaim('k-own');
    const hold = stoneHold(code);
    render(<HoldNotChargedButton hold={hold} label="Mesa 1" onCleared={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Conferi no extrato: não foi cobrado' }));
    await waitFor(() => expect(screen.getByText('Não foi cobrado: liberar a reserva')).toBeTruthy());
    expect(releasePaymentClaim).not.toHaveBeenCalled();
    expect(holds.getReviewHoldByKey('k-own')).not.toBeNull();
  });

  it('sem o segredo neste aparelho: abre a liberação do gerente', async () => {
    const hold = stoneHold('TIMEOUT');
    render(<HoldNotChargedButton hold={hold} label="Mesa 1" onCleared={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Conferi no extrato: não foi cobrado' }));
    await waitFor(() => expect(screen.getByText('Não foi cobrado: liberar a reserva')).toBeTruthy());
    expect(releasePaymentClaim).not.toHaveBeenCalled();
  });

  it('sinal de aprovação: os códigos de trava com aprovação na maquininha', () => {
    for (const c of ['REGISTER_FAILED', 'CLAIM_UNCONFIRMED', 'ACQUIRER_MISMATCH', 'INCONSISTENT_APPROVAL', 'CLAIM_RELEASED', 'APPROVED_WITHOUT_REFERENCE']) {
      expect(holdHasApprovalEvidence({ code: c })).toBe(true);
    }
    for (const c of ['TIMEOUT', 'MANUAL_REVIEW', 'CLAIM_NOT_STORED']) expect(holdHasApprovalEvidence({ code: c })).toBe(false);
  });
});

const ev = (over: Partial<SyncEvent> & Pick<SyncEvent, 'table' | 'op' | 'row_id' | 'payload'>): SyncEvent =>
  ({ id: `e-${over.row_id}-${over.op}`, created_at: '2026-11-14T10:00:00Z', attempts: 0, ...over }) as SyncEvent;

describe('item 3 (P2-1): evento recusado na conta', () => {
  it('diz qual evento, que nada foi recebido e o que fazer (Retaguarda › Nuvem); sem falar de Point', () => {
    const pay = rejectedOrderMessage(ev({ table: 'payments', op: 'INSERT', row_id: 'p1', payload: {} }), 'HTTP 400');
    expect(pay).toBe('A nuvem recusou um pagamento desta conta (HTTP 400). Nada foi recebido: nenhum pagamento entra nesta conta até resolver. Em Retaguarda › Nuvem, corrija a causa e toque em Reenviar recusados.');
    expect(rejectedOrderMessage(ev({ table: 'orders', op: 'UPDATE', row_id: 'o1', payload: {} }), 'x')).toMatch(/^A nuvem recusou uma alteração desta conta \(x\)/);
    expect(rejectedOrderMessage(ev({ table: 'order_items', op: 'INSERT', row_id: 'i1', payload: {} }), 'x')).toMatch(/^A nuvem recusou um item desta conta/);
    expect(rejectedOrderMessage(ev({ table: 'audit_logs', op: 'INSERT', row_id: 'a1', payload: {} }), 'x')).toMatch(/uma autorização do gerente/);
    expect(pay).not.toMatch(/Point/);
  });
});

describe('P2-01 do auditor: armazenamento bloqueado (getter de localStorage lança)', () => {
  it('trava só em memória e localStorage que lança: o aviso aparece com a conta, sem quebrar a tela', async () => {
    st().resetDemo();
    expect(st().login('1111').ok).toBe(true);
    const table = st().tables.find((t) => t.number === 3)!;
    const r = st().openTable(table.id, 2, null);
    if (!r.ok) throw new Error(r.error);
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    holds.setReviewHold({ order_id: r.data.id, amount: 1, reason: 'r', code: 'MANUAL_REVIEW', refund: 'TERMINAL', idempotency_key: 'k-mem' });
    set.mockRestore();
    const desc = Object.getOwnPropertyDescriptor(window, 'localStorage')!;
    Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('blocked', 'SecurityError'); } });
    try {
      expect(() => holds.reviewHoldsUnsaved()).not.toThrow();
      expect(holds.reviewHoldsUnsaved()).toBe(true);
      render(<UnsavedStorageBanner />);
      expect(screen.getByRole('alert').textContent).toBe(`${UNSAVED_STORAGE_WARNING} Contas: ${table.label}.`);
    } finally {
      Object.defineProperty(window, 'localStorage', desc);
    }
    holds.clearReviewHold(r.data.id, 'k-mem');
  });

  it('nenhuma trava só em memória e localStorage que lança: não quebra e não mostra aviso', () => {
    const desc = Object.getOwnPropertyDescriptor(window, 'localStorage')!;
    Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('blocked', 'SecurityError'); } });
    try {
      expect(holds.reviewHoldsUnsaved()).toBe(false);
      render(<UnsavedStorageBanner />);
      expect(screen.queryByRole('alert')).toBeNull();
    } finally {
      Object.defineProperty(window, 'localStorage', desc);
    }
  });
});

describe('verificar 3: recusa da maquininha espera a liberação da reserva', () => {
  const declined = ev({ table: 'payments', op: 'INSERT', row_id: 'p-d', payload: { id: 'p-d', order_id: 'o-d', status: 'DECLINED', acquirer: 'STONE', idempotency_key: 'k-d' } });
  const after = ev({ table: 'orders', op: 'UPDATE', row_id: 'o-d', payload: { id: 'o-d' } });

  it('liberação pendente com segredo: o DECLINED e a conta esperam; liberada (final ou removida), sobem', async () => {
    const urls: string[] = [];
    const fetchFn = async (url: string) => { urls.push(url); return { ok: true, status: 201, text: async () => '' }; };
    ledger.addPendingRelease({ key: 'k-d', order_id: 'o-d', reason: 'Maquininha recusou', release_token: TOKEN });
    expect(declinedAwaitingRelease(declined)).toBe(true);
    const first = await flushOutbox([declined, after], CFG, fetchFn, 50, [], declinedAwaitingRelease);
    expect(first.sent).toEqual([]);
    expect(first.rejected).toEqual([]);
    expect(urls).toEqual([]);
    ledger.addPendingRelease({ key: 'k-d', order_id: 'o-d', reason: 'Maquininha recusou', release_token: TOKEN, final: true });
    expect(declinedAwaitingRelease(declined)).toBe(false);
    ledger.removePendingRelease('k-d');
    expect(declinedAwaitingRelease(declined)).toBe(false);
    const second = await flushOutbox([declined, after], CFG, fetchFn, 50, [], declinedAwaitingRelease);
    expect(second.sent).toEqual([declined.id, after.id]);
  });

  it('só a recusa fora do Mercado Pago, com chave, e liberação com segredo', () => {
    ledger.addPendingRelease({ key: 'k-d', order_id: 'o-d', reason: 'r', release_token: TOKEN });
    expect(declinedAwaitingRelease({ ...declined, payload: { ...declined.payload, acquirer: 'MERCADO_PAGO' } })).toBe(false);
    expect(declinedAwaitingRelease({ ...declined, payload: { ...declined.payload, status: 'APPROVED' } })).toBe(false);
    expect(declinedAwaitingRelease({ ...declined, op: 'UPDATE' })).toBe(false);
    expect(declinedAwaitingRelease(after)).toBe(false);
    ledger.addPendingRelease({ key: 'k-d', order_id: 'o-d', reason: 'r', release_token: null });
    // addPendingRelease mantém o segredo anterior: sem segredo só numa entrada nova.
    ledger.removePendingRelease('k-d');
    ledger.addPendingRelease({ key: 'k-d', order_id: 'o-d', reason: 'r' });
    expect(declinedAwaitingRelease(declined)).toBe(false);
  });
});

describe('verificar 4: segundo aparelho com a mesma chave do Mercado Pago (23505)', () => {
  it('o pagamento recusado segura o fechamento da conta nesta rodada e nas seguintes', async () => {
    const pay = ev({ table: 'payments', op: 'INSERT', row_id: 'p-mp', payload: { id: 'p-mp', order_id: 'o-mp', status: 'APPROVED', acquirer: 'MERCADO_PAGO', idempotency_key: 'k-mp' } });
    const close = ev({ table: 'orders', op: 'UPDATE', row_id: 'o-mp', payload: { id: 'o-mp', status: 'CLOSED' } });
    const table = ev({ table: 'dining_tables', op: 'UPDATE', row_id: 't-1', payload: { id: 't-1', current_order_id: 'o-mp' } });
    const calls: string[] = [];
    const fetchFn = async (url: string) => {
      calls.push(url);
      return { ok: false, status: 409, text: async () => JSON.stringify({ code: '23505', message: 'duplicate key value violates unique constraint "payments_idempotency_key_key"' }) };
    };
    const first = await flushOutbox([pay, close, table], CFG, fetchFn);
    expect(first.rejected.map((r) => r.eventId)).toEqual([pay.id]);
    expect(first.sent).toEqual([]);
    expect(calls).toHaveLength(1);
    const ok = async (url: string) => { calls.push(url); return { ok: true, status: 200, text: async () => '' }; };
    const next = await flushOutbox([close, table], CFG, ok, 50, [pay]);
    expect(next.sent).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});

describe('P3: ConfirmReviewedChargeSheet confere o PIN antes de pedir reserva no servidor', () => {
  it('trava sem reserva neste aparelho e PIN errado: não pede reserva nem registra', async () => {
    st().resetDemo();
    expect(st().login('1111').ok).toBe(true);
    useTcheStore.setState({ cloud: { url: 'x' } } as never);
    const t = st().tables.find((x) => x.number === 3)!;
    const r = st().openTable(t.id, 2, null);
    if (!r.ok) throw new Error(r.error);
    const hold = holds.setReviewHold({ order_id: r.data.id, amount: 5, reason: 'r', code: 'TIMEOUT', refund: 'TERMINAL', method: 'CREDIT', acquirer: 'STONE', idempotency_key: 'k-pin', item_ids: [] });
    checkHoldClaim.mockResolvedValue({ ok: true });
    startPaymentClaim.mockResolvedValue({ ok: false, error: 'não deveria' });
    render(<ConfirmReviewedChargeSheet open onClose={() => undefined} hold={hold} label="Mesa 2" onSuccess={() => undefined} />);
    fireEvent.change(screen.getByPlaceholderText('Só números'), { target: { value: '123456' } });
    fireEvent.change(screen.getByPlaceholderText('Letras e números'), { target: { value: 'AB12CD' } });
    const typePin = async (p: string) => {
      for (const d of p) fireEvent.click(screen.getByRole('button', { name: d }));
      await act(async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); });
    };
    await typePin('1234');
    await waitFor(() => expect(checkHoldClaim).toHaveBeenCalledTimes(1));
    expect(startPaymentClaim).not.toHaveBeenCalled();
    expect(st().payments.filter((p) => p.order_id === r.data.id && p.status === 'APPROVED')).toHaveLength(0);
    // Controle: com o PIN certo, pede a reserva (e a recusa dela não registra nada).
    await typePin('9999');
    await waitFor(() => expect(startPaymentClaim).toHaveBeenCalledTimes(1));
    expect(st().payments.filter((p) => p.order_id === r.data.id && p.status === 'APPROVED')).toHaveLength(0);
  });
});
