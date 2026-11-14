// @vitest-environment jsdom
/**
 * Tela do Caixa com o aparelho fora do fuso de Brasília: o aviso de dinheiro
 * recebido com o caixa fechado conta desde as 05:00 de Brasília, não desde as
 * 05:00 do relógio do aparelho.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CashRegisterScreen } from '../screens/CashRegisterScreen';
import { useTcheStore } from '../store/useTcheStore';
import type { CashSession, Payment, StaffUser } from '../types';

const BRT = (iso: string) => new Date(`${iso}-03:00`);
const cash = (id: string, amount: number, at: string) =>
  ({ id, order_id: 'o', amount, tip_amount: 0, method: 'CASH', status: 'APPROVED', acquirer: 'CASH_DESK', created_at: BRT(at).toISOString() }) as unknown as Payment;
const closed = {
  id: 's1', status: 'CLOSED', opened_at: BRT('2026-11-09T18:00:00').toISOString(), closed_at: BRT('2026-11-09T23:30:00').toISOString(),
  opening_float: 0, opened_by_user_id: 'c1', closed_by_user_id: 'c1',
} as unknown as CashSession;
const staff = [{ id: 'c1', name: 'Caixa', role: 'CASHIER', active: true }] as unknown as StaffUser[];

const ORIGINAL_TZ = process.env.TZ;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  process.env.TZ = ORIGINAL_TZ;
});

describe('Caixa: dinheiro fora do caixa desde as 05:00 de Brasília', () => {
  it.each(['UTC', 'America/Sao_Paulo', 'Asia/Tokyo'])('aparelho em %s: 03:00 é do turno anterior, 06:00 entra', (tz) => {
    process.env.TZ = tz;
    vi.setSystemTime(BRT('2026-11-10T10:00:00'));
    act(() => {
      useTcheStore.setState({
        staff,
        currentUserId: 'c1',
        cashSessions: [closed],
        cashMovements: [],
        payments: [cash('madrugada', 30, '2026-11-10T03:00:00'), cash('manha', 20, '2026-11-10T06:00:00')],
      } as never);
    });
    render(<CashRegisterScreen />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('(1 pagamento)');
    expect(alert.textContent).toContain(new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(20));
  });
});
