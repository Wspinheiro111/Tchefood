// @vitest-environment jsdom
/**
 * Telas da leitura das contas da nuvem (auditoria interna, rodada 8 do PR #54):
 * - conta encerrada pela leitura com itens na bandeja: o aviso e o "Descartar itens da bandeja"
 *   aparecem (a bandeja ficava dentro da aba Lançar, que some com a conta encerrada);
 * - a faixa de contas paradas não aparece com o horário velho da abertura anterior do app antes
 *   da primeira leitura desta abertura, e o relógio da sessão recomeça ao trocar de loja.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTcheStore, type CloudSession } from '../store/useTcheStore';
import type { Order, TrayItem } from '../types';

const fake = vi.hoisted(() => ({
  catalog: vi.fn<() => Promise<unknown>>(),
  orders: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));
vi.mock('../lib/sync/cloudPull', async (orig) => ({ ...(await orig<typeof import('../lib/sync/cloudPull')>()), fetchCloudSnapshot: fake.catalog }));
vi.mock('../lib/sync/orderPull', async (orig) => ({ ...(await orig<typeof import('../lib/sync/orderPull')>()), fetchCloudOrders: fake.orders }));

const { OrderScreen } = await import('../screens/OrderScreen');
const { CloudStaleBanner } = await import('../components/CloudStaleBanner');
const { syncOnce, resetPullLoopForTests } = await import('../lib/sync/useCloudSync');

const st = () => useTcheStore.getState();
const O1 = '01010101-0101-4101-8101-010101010101';
const session = (tenantId: string): CloudSession => ({
  url: 'https://x.supabase.co', anon_key: 'anon', email: 'a@b', access_token: 'jwt', refresh_token: 'r', expires_at: 9e9, tenant_id: tenantId,
});
const noFetch = async () => {
  throw new Error('a rede não deveria ser usada: as leituras são falsas');
};

function order(status: Order['status'], tableId: string): Order {
  const at = new Date().toISOString();
  return {
    id: O1, tenant_id: st().tenant.id, table_id: tableId, opened_by_user_id: 'u', status, customer_count: 2, customer_cpf: null, subtotal_items: 0,
    charge_service_fee: false, service_fee_pct: 0, service_fee_amount: 0, discount_amount: 0, total_amount: 0, paid_amount: 0, remaining_balance: 0,
    nfce_status: 'PENDING', nfce_key: null, opened_at: at, closed_at: status === 'CLOSED' ? at : null, pickup_number: null, pickup_name: null, fulfillment_type: null,
  };
}

function trayItem(): TrayItem {
  const p = st().products[0]!;
  return {
    tray_id: 'tr1', order_id: O1, product_id: p.id, half_product_ids: [], quantity: 2, unit_price: 10, modifiers: [], modifiers_unit_price: 0,
    meat_doneness: null, quick_tags: [], free_notes: '', sector: p.sector, added_at: new Date().toISOString(),
  };
}

beforeEach(() => {
  resetPullLoopForTests();
  act(() => st().resetDemo());
  fake.catalog.mockReset();
  fake.orders.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('bandeja de uma conta encerrada pela leitura da nuvem (auditoria interna, rodada 8 do PR #54)', () => {
  it('conta encerrada com itens na bandeja: avisa e deixa descartar (com confirmação)', () => {
    const table = st().tables.find((t) => t.kind === 'TABLE')!;
    act(() => useTcheStore.setState({ orders: [order('CLOSED', table.id)], tray: [trayItem()] }));
    render(<OrderScreen orderId={O1} onBack={() => {}} onCheckout={() => {}} />);
    expect(screen.getByRole('alert').textContent).toMatch(/já foi encerrada/);
    const discard = screen.getByRole('button', { name: /Descartar itens da bandeja/ });

    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(discard);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(st().tray).toHaveLength(1);

    confirm.mockReturnValue(true);
    fireEvent.click(discard);
    expect(st().tray).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /Descartar itens da bandeja/ })).toBeNull();
  });

  it('conta encerrada sem itens na bandeja: nada de aviso', () => {
    const table = st().tables.find((t) => t.kind === 'TABLE')!;
    act(() => useTcheStore.setState({ orders: [order('CLOSED', table.id)], tray: [] }));
    render(<OrderScreen orderId={O1} onBack={() => {}} onCheckout={() => {}} />);
    expect(screen.queryByRole('button', { name: /Descartar itens da bandeja/ })).toBeNull();
  });

  it('conta aberta: a bandeja manda para a produção, sem o aviso', () => {
    const table = st().tables.find((t) => t.kind === 'TABLE')!;
    act(() => useTcheStore.setState({ orders: [order('OPEN', table.id)], tray: [trayItem()] }));
    render(<OrderScreen orderId={O1} onBack={() => {}} onCheckout={() => {}} />);
    expect(screen.getByRole('button', { name: /Enviar para produção/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Descartar itens da bandeja/ })).toBeNull();
  });
});

describe('faixa de contas paradas (auditoria interna, rodada 8 do PR #54)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-11-14T20:00:00Z'));
  });

  it('reabrir o app com a leitura de 15 h atrás: nada até a primeira leitura desta abertura', async () => {
    const old = new Date(Date.now() - 900 * 60_000).toISOString();
    act(() => useTcheStore.setState((s) => ({
      cloud: session(s.tenant.id), outbox: [], syncRejected: [],
      pullStatus: { ...s.pullStatus, last_pull_at: new Date().toISOString(), last_orders_pull_at: old },
    })));
    render(<CloudStaleBanner />);
    expect(screen.queryByRole('status')).toBeNull();

    fake.orders.mockRejectedValue(new Error('Não foi possível ler as contas da nuvem: HTTP 500'));
    await act(async () => { await syncOnce(noFetch); });
    const text = screen.getByRole('status').textContent ?? '';
    expect(text).toMatch(/há 15 h/);
    expect(text).not.toMatch(/900 min/);
  });

  it('sem nenhuma leitura por mais de um minuto de sessão: avisa mesmo assim', () => {
    const old = new Date(Date.now() - 900 * 60_000).toISOString();
    act(() => useTcheStore.setState((s) => ({ cloud: session(s.tenant.id), pullStatus: { ...s.pullStatus, last_orders_pull_at: old } })));
    render(<CloudStaleBanner />);
    expect(screen.queryByRole('status')).toBeNull();
    act(() => { vi.advanceTimersByTime(75_000); });
    expect(screen.getByRole('status').textContent).toMatch(/há 15 h/);
  });

  it('trocar de loja recomeça o relógio da sessão', () => {
    act(() => useTcheStore.setState((s) => ({ cloud: session(s.tenant.id), pullStatus: { ...s.pullStatus, last_orders_pull_at: null } })));
    render(<CloudStaleBanner />);
    act(() => { vi.advanceTimersByTime(75_000); });
    expect(screen.getByRole('status').textContent).toMatch(/ainda não/);

    const other = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';
    act(() => useTcheStore.setState((s) => ({ tenant: { ...s.tenant, id: other }, cloud: session(other) })));
    expect(screen.queryByRole('status')).toBeNull();
    act(() => { vi.advanceTimersByTime(75_000); });
    expect(screen.getByRole('status').textContent).toMatch(/ainda não/);
  });
});
