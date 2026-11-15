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
  act(() => useOwnerSettings.setState({ feesByTenant: {}, legacyFees: null, legacyArchive: [] }));
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
  act(() => useOwnerSettings.setState({ feesByTenant: {}, legacyFees: null, legacyArchive: [] }));
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
    fireEvent.click(screen.getByLabelText('Revisar taxas antigas'));
    const alert = screen.getByRole('alert', { name: 'Taxas antigas' });
    expect(alert.textContent).toContain('Stone · ');
    expect(alert.textContent).toContain('Comissão iFood: antiga 12%');
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
    fireEvent.click(screen.getByLabelText('Revisar taxas antigas'));
    expect(screen.getByRole('alert', { name: 'Taxas antigas' }).textContent).toContain('Comissão iFood: antiga 12% (conflito: na loja 15%)');
    fireEvent.click(screen.getByLabelText('As taxas são desta loja'));
    await restart();
    expect(slots()).toEqual(['PAGBANK/DEBIT/*=2', 'STONE/CREDIT/*=3']);
    expect(fees().appCommissionPct).toEqual({ ifood: 15 });
    // A comissão antiga de 12% continua guardada e visível, com a opção de descartar.
    expect(useOwnerSettings.getState().legacyFees).toEqual({ feeRules: [], appCommissionPct: { ifood: 12 } });
    cleanup();
    render(<FeesReceivables />);
    fireEvent.click(screen.getByLabelText('Revisar taxas antigas'));
    expect(screen.getByRole('alert', { name: 'Taxas antigas' }).textContent).toContain('Comissão iFood: antiga 12%');
    expect(screen.queryByLabelText('As taxas são desta loja')).toBeNull();
    // Tirar da lista pede confirmação; cancelar não mexe em nada.
    fireEvent.click(screen.getByLabelText('Tirar as taxas antigas em conflito da lista'));
    fireEvent.click(screen.getByLabelText('Cancelar'));
    expect(useOwnerSettings.getState().legacyFees).not.toBeNull();
    fireEvent.click(screen.getByLabelText('Tirar as taxas antigas em conflito da lista'));
    fireEvent.click(screen.getByLabelText('Confirmar: tirar da lista'));
    expect(useOwnerSettings.getState().legacyFees).toBeNull();
    expect(fees().appCommissionPct).toEqual({ ifood: 15 });
    // Não foi apagada: fica guardada (também depois de reiniciar) e volta ao restaurar.
    await restart();
    expect(useOwnerSettings.getState().legacyArchive).toEqual([{ feeRules: [], appCommissionPct: { ifood: 12 } }]);
    fireEvent.click(screen.getByLabelText('Restaurar taxas antigas'));
    expect(useOwnerSettings.getState().legacyFees).toEqual({ feeRules: [], appCommissionPct: { ifood: 12 } });
    expect(useOwnerSettings.getState().legacyArchive).toEqual([]);
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

describe('taxas antigas: quem vê e quem tira da lista (auditoria GPT rodada 9)', () => {
  const asRole = (role: 'CASHIER' | 'MANAGER') => {
    const u = useTcheStore.getState().staff.find((x) => x.role === role || (role === 'MANAGER' && x.role === 'OWNER'))!;
    act(() => useTcheStore.setState({ currentUserId: u.id } as never));
  };
  const base = useTcheStore.getState().tenant;
  afterEach(() => act(() => useTcheStore.setState({ tenant: base } as never)));

  it('P0-01: v3 da loja A, aparelho vai para a loja B, caixa não vê nenhuma taxa antiga; gerente não apaga de vez', async () => {
    act(() => useTcheStore.setState({ tenant: { ...base, id: 'loja-B' } } as never));
    asRole('CASHIER');
    render(<FeesReceivables />);
    expect(screen.queryByRole('alert', { name: 'Taxas antigas' })).toBeNull();
    expect(document.body.textContent).not.toMatch(/antiga|3%|12%/);
    // A loja não aceita a ação de quem não é da gerência, nem chamada direto.
    expect(useOwnerSettings.getState().discardLegacyFees()).toMatch(/Só gerente/);
    expect(useOwnerSettings.getState().adoptLegacyFees('loja-B')).toMatch(/Só gerente/);
    expect(useOwnerSettings.getState().legacyFees?.feeRules).toHaveLength(2);
    cleanup();
    // Gerente de B: os valores só aparecem depois de abrir a revisão.
    asRole('MANAGER');
    render(<FeesReceivables />);
    expect(screen.getByRole('alert', { name: 'Taxas antigas' }).textContent).not.toContain('3%');
    // Gerente de B com taxas próprias nas mesmas posições: só conflitos; tirar da lista guarda.
    expect(useOwnerSettings.getState().saveFeeRule({ acquirer: 'STONE', method: 'CREDIT', brand: null, pct: 4, fixed: 0, days: 30, businessDays: false })).toBeNull();
    expect(useOwnerSettings.getState().saveFeeRule({ acquirer: 'PAGBANK', method: 'DEBIT', brand: null, pct: 1, fixed: 0, days: 1, businessDays: true })).toBeNull();
    expect(useOwnerSettings.getState().setAppCommission('ifood', 20)).toBeNull();
    expect(useOwnerSettings.getState().discardLegacyFees()).toBeNull();
    await restart();
    expect(useOwnerSettings.getState().legacyFees).toBeNull();
    expect(useOwnerSettings.getState().legacyArchive).toEqual([V3]);
    // A loja A volta ao aparelho: a gerência restaura e traz as suas, completas.
    act(() => useTcheStore.setState({ tenant: { ...base, id: 'loja-A' } } as never));
    expect(useOwnerSettings.getState().restoreLegacyFees()).toBeNull();
    expect(useOwnerSettings.getState().adoptLegacyFees('loja-A')).toBeNull();
    expect(storeFees(useOwnerSettings.getState(), 'loja-A')).toEqual(V3);
    expect(storeFees(useOwnerSettings.getState(), 'loja-B').appCommissionPct).toEqual({ ifood: 20 });
  });

  it('P2-01: D+1 útil e D+1 corrido aparecem diferentes na revisão, e o conflito mostra a antiga ao lado da da loja', () => {
    act(() => useOwnerSettings.setState({ legacyFees: { feeRules: [{ id: 'old', acquirer: 'STONE', method: 'CREDIT', brand: null, pct: 3, fixed: 0, days: 1, businessDays: true }], appCommissionPct: {} } }));
    expect(useOwnerSettings.getState().saveFeeRule({ acquirer: 'STONE', method: 'CREDIT', brand: null, pct: 3, fixed: 0, days: 1, businessDays: false })).toBeNull();
    render(<FeesReceivables />);
    fireEvent.click(screen.getByLabelText('Revisar taxas antigas'));
    expect(screen.getByRole('alert', { name: 'Taxas antigas' }).textContent!.replace(/\s/g, ' ')).toContain('antiga 3% + R$ 0,00, D+1 útil (conflito: na loja 3% + R$ 0,00, D+1 corrido)');
  });
});
