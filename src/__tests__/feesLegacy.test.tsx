// @vitest-environment jsdom
/**
 * Taxas de antes da separação por loja (a v3 não gravava a loja). Auditorias GPT rodadas 8 a 10:
 * não somem, não sobrescrevem, ninguém de outra loja vê os valores, só o proprietário da loja
 * em que o aparelho estava ao atualizar traz (confirmando antes de ver), e nada se apaga de vez.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FeesReceivables } from '../screens/FeesReceivables';
import { useTcheStore } from '../store/useTcheStore';
import { legacyAccess, storeFees, UNKNOWN_ORIGIN, useOwnerSettings } from '../store/useOwnerSettings';

const KEY = useOwnerSettings.persist.getOptions().name!;
const V3 = {
  feeRules: [
    { id: 'r-stone', acquirer: 'STONE', method: 'CREDIT', brand: null, pct: 3, fixed: 0, days: 30, businessDays: false },
    { id: 'r-pag', acquirer: 'PAGBANK', method: 'DEBIT', brand: null, pct: 2, fixed: 0, days: 1, businessDays: true },
  ],
  appCommissionPct: { ifood: 12 },
};
const CLEAN = { feesByTenant: {}, legacyFees: null, legacyArchive: [], legacyOrigin: null, legacyConfirmedTenantId: null };
const settings = () => useOwnerSettings.getState();
const restart = async () => {
  const saved = window.localStorage.getItem(KEY)!;
  act(() => useOwnerSettings.setState(CLEAN));
  window.localStorage.setItem(KEY, saved);
  await act(async () => {
    await useOwnerSettings.persist.rehydrate();
  });
};
const base = useTcheStore.getState().tenant;
const tid = () => useTcheStore.getState().tenant.id;
const fees = (t = tid()) => storeFees(settings(), t);
const slots = (t = tid()) => fees(t).feeRules.map((r) => `${r.acquirer}/${r.method}/${r.brand ?? '*'}=${r.pct}`).sort();
const asRole = (role: 'OWNER' | 'MANAGER' | 'CASHIER') => {
  const u = useTcheStore.getState().staff.find((x) => x.role === role && x.active)!;
  act(() => useTcheStore.setState({ currentUserId: u.id } as never));
};
const asStore = (id: string) => act(() => useTcheStore.setState({ tenant: { ...base, id } } as never));
/** Texto da tela sem espaços especiais (o R$ usa espaço não separável). */
const pageText = () => document.body.textContent!.replace(/\s/g, ' ');
const ownerAdoptsOnScreen = () => {
  render(<FeesReceivables />);
  fireEvent.click(screen.getByLabelText('As taxas são desta loja'));
  fireEvent.click(screen.getByLabelText(`Confirmar que são de ${useTcheStore.getState().tenant.name}`));
  cleanup();
};

beforeEach(async () => {
  asStore('loja-A');
  asRole('OWNER');
  act(() => useTcheStore.setState({ payments: [] } as never));
  // Aparelho que vinha da v3 (lista única, sem loja), na loja A: o app carrega e migra para a v4.
  window.localStorage.setItem(KEY, JSON.stringify({ state: V3, version: 3 }));
  await restart();
});
afterEach(() => {
  cleanup();
  act(() => useOwnerSettings.setState(CLEAN));
  asStore(base.id);
  window.localStorage.removeItem(KEY);
});

describe('origem das taxas antigas', () => {
  it('ao abrir a versão nova, anota a loja que estava no aparelho; a anotação sobrevive ao reinício', async () => {
    expect(settings().legacyFees?.feeRules).toHaveLength(2);
    expect(settings().legacyOrigin).toBe('loja-A');
    asStore('loja-B');
    await restart();
    expect(settings().legacyOrigin).toBe('loja-A');
    expect(legacyAccess(settings(), 'loja-B')).toBe('quarantine');
    expect(legacyAccess(settings(), 'loja-A')).toBe('confirm');
  });
});

describe('taxas antigas depois de cadastrar uma nova (rodada 8)', () => {
  it('3 antigas + Pix novo na loja, reinício: o proprietário confirma e as 4 ficam na loja, sem perda nem duplicata', async () => {
    expect(settings().saveFeeRule({ acquirer: 'STONE', method: 'PIX', brand: null, pct: 0.99, fixed: 0, days: 0, businessDays: false })).toBeNull();
    await restart();
    ownerAdoptsOnScreen();
    await restart();
    expect(slots()).toEqual(['PAGBANK/DEBIT/*=2', 'STONE/CREDIT/*=3', 'STONE/PIX/*=0.99']);
    expect(fees().appCommissionPct).toEqual({ ifood: 12 });
    expect(settings().legacyFees).toBeNull();
    expect(settings().adoptLegacyFees(tid())).toMatch(/Não há taxas antigas/);
    expect(fees().feeRules).toHaveLength(3);
  });

  it('só a comissão do iFood mudada: as taxas entram, a comissão antiga fica como conflito ao lado da atual, sai da lista com confirmação e volta ao restaurar', async () => {
    expect(settings().setAppCommission('ifood', 15)).toBeNull();
    await restart();
    ownerAdoptsOnScreen();
    await restart();
    expect(slots()).toEqual(['PAGBANK/DEBIT/*=2', 'STONE/CREDIT/*=3']);
    expect(fees().appCommissionPct).toEqual({ ifood: 15 });
    expect(settings().legacyFees).toEqual({ feeRules: [], appCommissionPct: { ifood: 12 } });
    render(<FeesReceivables />);
    expect(pageText()).toContain('Comissão iFood: antiga 12% (conflito: na loja 15%)');
    fireEvent.click(screen.getByLabelText('Tirar as taxas antigas da lista'));
    fireEvent.click(screen.getByLabelText('Cancelar'));
    expect(settings().legacyFees).not.toBeNull();
    fireEvent.click(screen.getByLabelText('Tirar as taxas antigas da lista'));
    fireEvent.click(screen.getByLabelText('Confirmar: tirar da lista'));
    expect(settings().legacyFees).toBeNull();
    await restart();
    expect(settings().legacyArchive).toEqual([{ fees: { feeRules: [], appCommissionPct: { ifood: 12 } }, origin: 'loja-A', confirmedTenantId: 'loja-A' }]);
    fireEvent.click(screen.getByLabelText('Restaurar taxas antigas'));
    expect(settings().legacyFees).toEqual({ feeRules: [], appCommissionPct: { ifood: 12 } });
    expect(legacyAccess(settings(), 'loja-A')).toBe('revealed');
  });

  it('mesma maquininha, forma e bandeira com valor diferente não é trocada; igual não duplica', () => {
    expect(settings().saveFeeRule({ acquirer: 'STONE', method: 'CREDIT', brand: null, pct: 4, fixed: 0, days: 30, businessDays: false })).toBeNull();
    expect(settings().saveFeeRule({ acquirer: 'PAGBANK', method: 'DEBIT', brand: null, pct: 2, fixed: 0, days: 1, businessDays: true })).toBeNull();
    expect(settings().adoptLegacyFees(tid())).toBeNull();
    expect(slots()).toEqual(['PAGBANK/DEBIT/*=2', 'STONE/CREDIT/*=4']);
    expect(settings().legacyFees?.feeRules.map((r) => r.id)).toEqual(['r-stone']);
  });
});

describe('quem vê e quem traz as taxas antigas (rodadas 9 e 10)', () => {
  it('P0-01: taxas da loja A, aparelho vai para B: nem caixa, nem gerente, nem proprietário de B veem os valores ou conseguem trazê-las', async () => {
    asStore('loja-B');
    await restart();
    for (const role of ['CASHIER', 'MANAGER', 'OWNER'] as const) {
      asRole(role);
      render(<FeesReceivables />);
      const t = pageText();
      expect(t).not.toMatch(/Stone ·|PagBank ·|Comissão iFood: antiga|3%|12%|D\+30/);
      expect(screen.queryByLabelText('As taxas são desta loja')).toBeNull();
      if (role === 'CASHIER') expect(screen.queryByRole('alert', { name: 'Taxas antigas' })).toBeNull();
      else expect(screen.getByRole('alert', { name: 'Taxas antigas' }).textContent).toContain('não são desta loja');
      cleanup();
    }
    // Chamadas diretas também recusam: outra loja, ou uma loja que não é a do aparelho.
    expect(settings().adoptLegacyFees('loja-B')).toMatch(/não são desta loja/);
    expect(settings().adoptLegacyFees('loja-A')).toMatch(/loja que está neste aparelho/);
    asRole('CASHIER');
    expect(settings().discardLegacyFees()).toMatch(/Só gerente/);
    expect(fees('loja-B').feeRules).toHaveLength(0);
    expect(fees('loja-A').feeRules).toHaveLength(0);
    // Gerente de B tira da lista: fica guardada (com a origem A), e restaurar em B não revela nada.
    asRole('MANAGER');
    expect(settings().discardLegacyFees()).toBeNull();
    await restart();
    expect(settings().legacyArchive).toEqual([{ fees: V3, origin: 'loja-A', confirmedTenantId: null }]);
    expect(settings().restoreLegacyFees()).toBeNull();
    expect(legacyAccess(settings(), 'loja-B')).toBe('quarantine');
    // De volta à loja A: só o proprietário de A traz, e completas.
    asStore('loja-A');
    asRole('MANAGER');
    expect(settings().adoptLegacyFees('loja-A')).toMatch(/Só o proprietário/);
    asRole('OWNER');
    ownerAdoptsOnScreen();
    expect(fees('loja-A')).toEqual(V3);
    expect(fees('loja-B').feeRules).toHaveLength(0);
  });

  it('na loja de origem, os valores só aparecem depois da confirmação do proprietário; o gerente não confirma', () => {
    asRole('MANAGER');
    render(<FeesReceivables />);
    expect(pageText()).not.toMatch(/3%|12%|Stone ·/);
    expect(screen.queryByLabelText('As taxas são desta loja')).toBeNull();
    expect(pageText()).toContain('Peça ao proprietário');
    cleanup();
    asRole('OWNER');
    render(<FeesReceivables />);
    fireEvent.click(screen.getByLabelText('As taxas são desta loja'));
    // Antes de confirmar, ainda nenhum valor das antigas.
    expect(pageText()).not.toMatch(/Comissão iFood: antiga|D\+30/);
    fireEvent.click(screen.getByLabelText('Cancelar'));
    expect(fees().feeRules).toHaveLength(0);
  });

  it('taxas antigas sem origem anotada ficam em quarentena para sempre (tirar e restaurar não muda isso)', () => {
    act(() => useOwnerSettings.setState({ legacyOrigin: null, legacyConfirmedTenantId: null }));
    asRole('MANAGER');
    expect(settings().discardLegacyFees()).toBeNull();
    expect(settings().legacyArchive[0]!.origin).toBe(UNKNOWN_ORIGIN);
    expect(settings().restoreLegacyFees()).toBeNull();
    expect(legacyAccess(settings(), 'loja-A')).toBe('quarantine');
    asRole('OWNER');
    expect(settings().adoptLegacyFees('loja-A')).toMatch(/não são desta loja/);
  });

  it('P2-01: D+1 útil e D+1 corrido aparecem diferentes, com a antiga ao lado da da loja', () => {
    act(() => useOwnerSettings.setState({ legacyFees: { feeRules: [{ id: 'old', acquirer: 'STONE', method: 'CREDIT', brand: null, pct: 3, fixed: 0, days: 1, businessDays: true }], appCommissionPct: {} }, legacyConfirmedTenantId: 'loja-A' }));
    expect(settings().saveFeeRule({ acquirer: 'STONE', method: 'CREDIT', brand: null, pct: 3, fixed: 0, days: 1, businessDays: false })).toBeNull();
    render(<FeesReceivables />);
    expect(pageText()).toContain('antiga 3% + R$ 0,00, D+1 útil (conflito: na loja 3% + R$ 0,00, D+1 corrido)');
  });
});
