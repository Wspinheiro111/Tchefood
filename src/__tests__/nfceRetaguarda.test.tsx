// @vitest-environment jsdom
/**
 * P2-04 da rodada 3 do GPT (PR #55): na loja real, a Retaguarda › NFC-e só mostra número e
 * chave do documento do servidor; a chave simulada de antes da nuvem não aparece como nota real.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { NfceList } from '../screens/BackOffice';
import { NFCE_REFUNDED_WARNING, NFCE_REFUNDED_WARNING_REAL, NfceViewer } from '../screens/NfceViewer';
import { DEMO_TENANT_ID } from '../data/seed';
import { useTcheStore } from '../store/useTcheStore';
import type { NfceCloudRecord, Order } from '../types';

const SIM_KEY = '43261112345678000195650010000000771000000776';
const REAL_KEY = '43261112345678000195650010000000421000000420';
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
      useTcheStore.setState({ cloud: null, cloudTenantId: null, tenant: { ...useTcheStore.getState().tenant, id: DEMO_TENANT_ID }, orders: [order], tables: [], nfceCloud: {} } as never);
    });
    render(<NfceList />);
    expect(screen.getByText(/NFC-e nº 77/)).toBeTruthy();
  });
});

describe('NfceViewer › aviso de estorno na nota real (P2-04, rodada 8c07a77)', () => {
  const payload = {
    items: [{ numero_item: 1, codigo_produto: '311', descricao: 'X-SALADA', unidade_comercial: 'UN', quantidade_comercial: 1, valor_unitario_comercial: 32, valor_bruto: 32 }],
    valor_produtos: 32, valor_desconto: 0, valor_outras_despesas: 0, valor_total: 32,
    formas_pagamento: [{ forma_pagamento: '01', valor_pagamento: 32 }], cnpj_emitente: '12345678000195',
  };
  const real = rec({
    status: 'authorized', environment: 'homologacao', access_key: REAL_KEY, protocol: '143260000000042', number: 42, series: '1',
    qrcode_url: `https://www.sefaz.rs.gov.br/NFCE/NFCE-COM.aspx?p=${REAL_KEY}|2|2|1|ABCDEF0123456789ABCDEF0123456789ABCDEF01`, issued_at: '2026-11-14T10:00:00-03:00', payload,
    issuer: { name: 'Flip', legal_name: 'FLIP LTDA', cnpj: '12345678000195', state_registration: '0960000000', city: 'Santo Angelo', state: 'RS' },
    issuer_address: { street: 'Rua das Missoes', number: '123', complement: null, district: 'Centro', city: 'Santo Angelo', state: 'RS', zip: '98800000' },
    authorized_at: '2026-11-14T10:03:00-03:00',
  } as never);

  it('nota real reimpressa depois do estorno: a mensagem diz que a bobina reproduz o pagamento original', () => {
    act(() => {
      useTcheStore.setState({
        cloud: null, cloudTenantId: 't1', tenant: { ...useTcheStore.getState().tenant, id: 't1' }, tables: [], orderItems: [],
        orders: [{ ...order, nfce_key: REAL_KEY }], payments: [{ id: 'p1', order_id: 'o1', status: 'REFUNDED', amount: 32, method: 'CASH' }],
        nfceCloud: { o1: real },
      } as never);
    });
    render(<NfceViewer orderId="o1" onClose={() => undefined} />);
    expect(screen.getByText(NFCE_REFUNDED_WARNING_REAL)).toBeTruthy();
    expect(screen.queryByText(NFCE_REFUNDED_WARNING)).toBeNull();
    expect(NFCE_REFUNDED_WARNING_REAL).toMatch(/reproduz a nota como foi emitida/);
    expect(NFCE_REFUNDED_WARNING_REAL).not.toMatch(/não mostra/);
  });
});
