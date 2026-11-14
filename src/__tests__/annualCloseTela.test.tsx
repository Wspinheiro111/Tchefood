// @vitest-environment jsdom
/**
 * Tela Retaguarda › Fechamento anual: só dono e gerente; ano escolhido; vale-refeição
 * sem registro aparece como "não registrado"; no app Android não oferece exportação.
 */
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnnualClose } from '../screens/AnnualClose';
import { useBackOfficeTabs } from '../screens/BackOffice';
import { useTcheStore } from '../store/useTcheStore';
import type { Payment, StaffUser } from '../types';

const staff = [
  { id: 'own', name: 'Dono', role: 'OWNER', active: true },
  { id: 'cx', name: 'Caixa', role: 'CASHIER', active: true },
] as unknown as StaffUser[];
const pay = (amount: number, at: string, method = 'PIX') =>
  ({ id: `${amount}-${at}`, order_id: 'o', amount, tip_amount: 0, method, status: 'APPROVED', acquirer: 'CASH_DESK', card_brand: null, created_at: `${at}-03:00` }) as unknown as Payment;

function setup(userId: string, payments: Payment[] = []) {
  act(() => {
    useTcheStore.setState({
      staff,
      currentUserId: userId,
      payments,
      stockMovements: [],
      purchaseInvoices: [],
      purchaseInvoiceItems: [],
      cashSessions: [],
      cashMovements: [],
      ownDeliveries: [],
      courierSettlements: [],
    } as never);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-02-10T10:00:00-03:00'));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (window as unknown as Record<string, unknown>).SmartPosNative;
});

describe('Fechamento anual (tela)', () => {
  it('a aba só aparece para dono e gerente', () => {
    setup('cx');
    expect(renderHook(() => useBackOfficeTabs()).result.current.some((t) => t.key === 'annual')).toBe(false);
    setup('own');
    expect(renderHook(() => useBackOfficeTabs()).result.current.some((t) => t.key === 'annual')).toBe(true);
  });

  it('avisa que são só os registros deste aparelho', () => {
    setup('own');
    render(<AnnualClose />);
    expect(screen.getByRole('note').textContent).toContain('NESTE aparelho');
  });

  it('caixa não vê o faturamento do ano', () => {
    setup('cx', [pay(100, '2025-05-01T12:00:00')]);
    render(<AnnualClose />);
    expect(screen.getByText(/Só o proprietário e o gerente/)).toBeTruthy();
    expect(screen.queryByText(/Total vendido/)).toBeNull();
  });

  it('dono: em fevereiro abre o ano que terminou, troca de ano e mostra VR/VA como não registrado', () => {
    setup('own', [pay(100, '2025-05-01T12:00:00'), pay(40, '2026-01-15T12:00:00')]);
    render(<AnnualClose />);
    const select = screen.getByLabelText('Ano do fechamento') as HTMLSelectElement;
    expect(select.value).toBe('2025');
    const fmt = (v: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
    expect(screen.getByText('Total vendido').parentElement!.textContent).toContain(fmt(100));
    expect(screen.getByText('Vale-refeição / alimentação').parentElement!.parentElement!.textContent).toContain('não registrado');
    expect(screen.getAllByRole('button', { name: /baixar Excel/ })).toHaveLength(4);
    fireEvent.change(select, { target: { value: '2026' } });
    expect(screen.getByText('Total vendido').parentElement!.textContent).toContain(fmt(40));
    expect(screen.getByText(/2026 ainda não terminou/)).toBeTruthy();
  });

  it('sem dados não quebra; no app Android não oferece exportar', () => {
    (window as unknown as Record<string, unknown>).SmartPosNative = {};
    setup('own');
    render(<AnnualClose />);
    expect(screen.getByText(/não salva planilha nem PDF/)).toBeTruthy();
    expect(screen.queryAllByRole('button', { name: /baixar Excel/ })).toHaveLength(0);
  });
});
