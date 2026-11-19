// @vitest-environment jsdom
/**
 * P2-04 da rodada 3 do GPT (PR #55): na loja real, a Retaguarda › NFC-e só mostra número e
 * chave do documento do servidor; a chave simulada de antes da nuvem não aparece como nota real.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { NfceList } from '../screens/BackOffice';
import { useTcheStore } from '../store/useTcheStore';
import type { NfceCloudRecord, Order } from '../types';

const SIM_KEY = '43261112345678000195650010000000771000000776';
const REAL_KEY = '43261112345678000195650010000000421000000427';
const order = { id: 'o1', tenant_id: 't1', table_id: null, status: 'CLOSED', closed_at: '2026-11-19T10:00:00Z', total_amount: 32, paid_amount: 32, remaining_balance: 0, nfce_status: 'AUTORIZADA', nfce_key: SIM_KEY } as unknown as Order;
const rec = (over: Partial<NfceCloudRecord>): NfceCloudRecord => ({
  order_id: 'o1', status: null, environment: null, access_key: null, protocol: null, number: null, series: null, qrcode_url: null, danfe_path: null,
  issued_at: null, payload: null, issuer: null, message: null, problem: null, attempts: 1, next_attempt_at: null, updated_at: '2026-11-19T10:00:00Z', ...over,
});

afterEach(() => cleanup());

describe('Retaguarda › NFC-e na loja real', () => {
  it('conta antiga com chave simulada e servidor sem nota: nenhum número fiscal', () => {
    act(() => {
      useTcheStore.setState({ cloud: null, cloudTenantId: 't1', tenant: { ...useTcheStore.getState().tenant, id: 't1' }, orders: [order], tables: [], nfceCloud: { o1: rec({ problem: 'none' }) } } as never);
    });
    render(<NfceList />);
    expect(screen.getByText(/Nota simulada — sem emissão fiscal/)).toBeTruthy();
    expect(screen.queryByText(/NFC-e nº/)).toBeNull();
    expect(screen.queryByText(SIM_KEY)).toBeNull();
  });

  it('com a nota autorizada do servidor: número e chave do servidor', () => {
    act(() => {
      useTcheStore.setState({ cloud: null, cloudTenantId: 't1', tenant: { ...useTcheStore.getState().tenant, id: 't1' }, orders: [{ ...order, nfce_key: REAL_KEY }], tables: [], nfceCloud: { o1: rec({ status: 'authorized', access_key: REAL_KEY, protocol: '1' }) } } as never);
    });
    render(<NfceList />);
    expect(screen.getByText(/NFC-e nº 42/)).toBeTruthy();
    expect(screen.getByText(REAL_KEY)).toBeTruthy();
  });

  it('demonstração continua mostrando a nota simulada', () => {
    act(() => {
      useTcheStore.setState({ cloud: null, cloudTenantId: null, orders: [order], tables: [], nfceCloud: {} } as never);
    });
    render(<NfceList />);
    expect(screen.getByText(/NFC-e nº 77/)).toBeTruthy();
  });
});
