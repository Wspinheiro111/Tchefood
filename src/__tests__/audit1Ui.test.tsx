// @vitest-environment jsdom
/**
 * Auditoria interna 1, telas: consulta da reserva sem sobreposição (P3-4) e a maquininha simulada que termina
 * com a adquirente do começo da cobrança (P3-1 do revisor de contrato).
 */
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTcheStore } from '../store/useTcheStore';
import { useTerminalBus, type ChargeRequest, type TerminalResult } from '../lib/payments/drivers';

const fetchPointReservation = vi.fn();
vi.mock('../lib/sync/cloudPull', async (orig) => ({
  ...(await orig<typeof import('../lib/sync/cloudPull')>()),
  fetchPointReservation: (...a: unknown[]) => fetchPointReservation(...a),
}));
vi.mock('../lib/sync/useCloudSync', async (orig) => ({
  ...(await orig<typeof import('../lib/sync/useCloudSync')>()),
  freshCloudConfig: async () => ({ url: 'https://x.supabase.co', anonKey: 'anon', accessToken: 'jwt' }),
}));

const { useOrderClaims } = await import('../components/StuckClaims');
const { SmartPosSimulator } = await import('../components/SmartPosSimulator');

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  fetchPointReservation.mockReset();
});

const claim = (key: string) => ({ idempotencyKey: key, amountCents: 100, method: 'CASH', acquirer: 'CASH_DESK', createdAt: null, createdBy: null, createdByName: null, activeUntil: null, releasableAt: null });
const reservation = (keys: string[]) => ({ reservedCents: 0, openCharges: 0, manualReview: false, charges: [], claims: keys.map(claim) });

describe('P3-4: consulta das reservas da conta, uma leitura por vez', () => {
  it('leitura lenta: a consulta seguinte não começa outra; a resposta antiga não volta por cima da nova', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    useTcheStore.setState({ cloud: { url: 'x' } } as never);
    let finishFirst: (v: unknown) => void = () => undefined;
    fetchPointReservation.mockImplementationOnce(() => new Promise((r) => (finishFirst = r)));
    fetchPointReservation.mockResolvedValue(reservation(['nova']));
    const { result } = renderHook(() => useOrderClaims('o1'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000); // duas voltas da consulta com a primeira leitura parada
    });
    expect(fetchPointReservation).toHaveBeenCalledTimes(1);
    await act(async () => {
      finishFirst(reservation(['antiga']));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.claims.map((c) => c.idempotencyKey)).toEqual(['antiga']);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(fetchPointReservation).toHaveBeenCalledTimes(2);
    expect(result.current.claims.map((c) => c.idempotencyKey)).toEqual(['nova']);
  });
});

describe('P3-1: maquininha simulada termina com a adquirente do começo da cobrança', () => {
  it('trocar o chassi no meio de uma cobrança embarcada não muda a adquirente da recusa', async () => {
    let result: TerminalResult | null = null;
    const request: ChargeRequest = { request_id: 'r1', idempotency_key: 'k1', amount: 10, method: 'PIX', table_label: 'Mesa 1', order_id: 'o1', description: '' };
    act(() => {
      useTerminalBus.getState().submit({ request, chassis: 'STONE', mode: 'SMARTPOS_EMBEDDED', terminal: null, resolve: (r) => (result = r) });
    });
    render(<SmartPosSimulator />);
    act(() => useTerminalBus.getState().setChassis('PAGBANK'));
    fireEvent.click(screen.getByRole('button', { name: 'Recusar (Saldo Insuficiente)' }));
    expect(result).toMatchObject({ status: 'DECLINED', acquirer: 'STONE', terminal_serial: 'STONE-SMART-EMB' });
  });
});

describe('Auditoria 2 P1: aviso fixo de trava não gravada', () => {
  it('trava só em memória: o aviso aparece; gravada, some', async () => {
    const { UnsavedStorageBanner, UNSAVED_STORAGE_WARNING } = await import('../components/UnsavedStorageBanner');
    const holds = await import('../lib/payments/reviewHolds');
    render(<UnsavedStorageBanner />);
    expect(screen.queryByRole('alert')).toBeNull();
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    act(() => void holds.setReviewHold({ order_id: 'o-b', amount: 1, reason: 'r', code: 'MANUAL_REVIEW', refund: 'TERMINAL', idempotency_key: 'k-b' }));
    expect(screen.getByRole('alert').textContent).toBe(UNSAVED_STORAGE_WARNING);
    spy.mockRestore();
    act(() => holds.clearReviewHold('o-b', 'k-b'));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
