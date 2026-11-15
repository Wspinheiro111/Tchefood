// @vitest-environment jsdom
/**
 * Taxas de antes da separação por loja (auditoria GPT rodada 8, P2-01): cadastrar uma taxa
 * nova não pode esconder as antigas nem impedir de trazê-las.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FeesReceivables } from '../screens/FeesReceivables';
import { useTcheStore } from '../store/useTcheStore';
import { storeFees, useOwnerSettings } from '../store/useOwnerSettings';

const KEY = useOwnerSettings.persist.getOptions().name!;
const V3 = {
  feeRules: [
    { id: 'r-stone', acquirer: 'STONE', method: 'CREDIT', brand: null, pct: 3, fixed: 0, days: 30, businessDays: false },
    { id: 'r-pag', acquirer: 'PAGBANK', method: 'DEBIT', brand: null, pct: 2, fixed: 0, days: 1, businessDays: true },
  ],
  appCommissionPct: { ifood: 12 },
};
const restart = async () => {
  const saved = window.localStorage.getItem(KEY)!;
  act(() => useOwnerSettings.setState({ feesByTenant: {}, legacyFees: null }));
  window.localStorage.setItem(KEY, saved);
  await act(async () => {
    await useOwnerSettings.persist.rehydrate();
  });
};
const tid = () => useTcheStore.getState().tenant.id;
const fees = () => storeFees(useOwnerSettings.getState(), tid());
const slots = () => fees().feeRules.map((r) => `${r.acquirer}/${r.method}/${r.brand ?? '*'}=${r.pct}`).sort();

beforeEach(async () => {
  const s = useTcheStore.getState();
  const manager = s.staff.find((u) => u.role === 'OWNER' || u.role === 'MANAGER')!;
  act(() => useTcheStore.setState({ currentUserId: manager.id, payments: [] } as never));
  // Aparelho que vinha da v3 (lista única, sem loja): o app carrega e migra para a v4.
  window.localStorage.setItem(KEY, JSON.stringify({ state: V3, version: 3 }));
  await restart();
});
afterEach(() => {
  cleanup();
  act(() => useOwnerSettings.setState({ feesByTenant: {}, legacyFees: null }));
  window.localStorage.removeItem(KEY);
});

describe('taxas antigas depois de cadastrar uma nova (auditoria GPT rodada 8)', () => {
  it('3 antigas + Pix novo na loja, reinício: o aviso continua e as 4 ficam na loja, sem perda nem duplicata', async () => {
    expect(useOwnerSettings.getState().legacyFees?.feeRules).toHaveLength(2);
    expect(fees().feeRules).toHaveLength(0);
    // Antes de confirmar as antigas, cadastra Pix 0,99% (Stone).
    expect(useOwnerSettings.getState().saveFeeRule({ acquirer: 'STONE', method: 'PIX', brand: null, pct: 0.99, fixed: 0, days: 0, businessDays: false })).toBeNull();
    await restart();
    render(<FeesReceivables />);
    const alert = screen.getByRole('alert', { name: 'Taxas antigas' });
    expect(alert.textContent).toContain('Stone · ');
    expect(alert.textContent).toContain('Comissão iFood: 12%');
    expect(alert.textContent).not.toContain('(conflito');
    fireEvent.click(screen.getByLabelText('As taxas são desta loja'));
    expect(screen.queryByRole('alert', { name: 'Taxas antigas' })).toBeNull();
    await restart();
    expect(slots()).toEqual(['PAGBANK/DEBIT/*=2', 'STONE/CREDIT/*=3', 'STONE/PIX/*=0.99']);
    expect(fees().appCommissionPct).toEqual({ ifood: 12 });
    expect(useOwnerSettings.getState().legacyFees).toBeNull();
    // Trazer de novo não duplica nada.
    expect(useOwnerSettings.getState().adoptLegacyFees(tid())).toMatch(/Não há taxas antigas/);
    expect(fees().feeRules).toHaveLength(3);
  });

  it('só a comissão do iFood mudada na loja: as taxas entram, a comissão antiga fica à vista como conflito (não sobrescreve)', async () => {
    expect(useOwnerSettings.getState().setAppCommission('ifood', 15)).toBeNull();
    await restart();
    render(<FeesReceivables />);
    expect(screen.getByRole('alert', { name: 'Taxas antigas' }).textContent).toContain('conflito: a loja já tem outra comissão');
    fireEvent.click(screen.getByLabelText('As taxas são desta loja'));
    await restart();
    expect(slots()).toEqual(['PAGBANK/DEBIT/*=2', 'STONE/CREDIT/*=3']);
    expect(fees().appCommissionPct).toEqual({ ifood: 15 });
    // A comissão antiga de 12% continua guardada e visível, com a opção de descartar.
    expect(useOwnerSettings.getState().legacyFees).toEqual({ feeRules: [], appCommissionPct: { ifood: 12 } });
    cleanup();
    render(<FeesReceivables />);
    expect(screen.getByRole('alert', { name: 'Taxas antigas' }).textContent).toContain('Comissão iFood: 12%');
    expect(screen.queryByLabelText('As taxas são desta loja')).toBeNull();
    fireEvent.click(screen.getByLabelText('Descartar as taxas antigas em conflito'));
    expect(useOwnerSettings.getState().legacyFees).toBeNull();
    expect(fees().appCommissionPct).toEqual({ ifood: 15 });
  });

  it('taxa da mesma maquininha, forma e bandeira com valor diferente não é trocada; igual não duplica', () => {
    const st = () => useOwnerSettings.getState();
    expect(st().saveFeeRule({ acquirer: 'STONE', method: 'CREDIT', brand: null, pct: 4, fixed: 0, days: 30, businessDays: false })).toBeNull();
    expect(st().saveFeeRule({ acquirer: 'PAGBANK', method: 'DEBIT', brand: null, pct: 2, fixed: 0, days: 1, businessDays: true })).toBeNull();
    expect(st().adoptLegacyFees(tid())).toBeNull();
    expect(slots()).toEqual(['PAGBANK/DEBIT/*=2', 'STONE/CREDIT/*=4']);
    expect(st().legacyFees?.feeRules.map((r) => r.id)).toEqual(['r-stone']);
    expect(fees().appCommissionPct).toEqual({ ifood: 12 });
  });
});
