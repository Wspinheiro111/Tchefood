/**
 * Adicional desconhecido nas contas que descem da nuvem (GPT, rodada 7 do PR #54): a foto das
 * contas só é aplicada depois de uma leitura dos cadastros que começou depois dela e deu certo,
 * sem depender do horário do item (relógio de outro aparelho, lançamento sem internet que subiu
 * atrasado). O adicional que continua faltando depois dessa leitura não pede outra a cada 10 s;
 * um adicional novo pede.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudSnapshot } from '../lib/sync/cloudPull';
import type { CloudOrders } from '../lib/sync/orderPull';
import { useTcheStore, type CloudSession } from '../store/useTcheStore';
import type { Order, OrderItem } from '../types';

const fake = vi.hoisted(() => ({
  catalog: vi.fn<() => Promise<unknown>>(),
  orders: vi.fn<() => Promise<unknown>>(),
}));
vi.mock('../lib/sync/cloudPull', async (orig) => ({ ...(await orig<typeof import('../lib/sync/cloudPull')>()), fetchCloudSnapshot: fake.catalog }));
vi.mock('../lib/sync/orderPull', async (orig) => ({ ...(await orig<typeof import('../lib/sync/orderPull')>()), fetchCloudOrders: fake.orders }));

const { syncOnce, resetPullLoopForTests } = await import('../lib/sync/useCloudSync');

const st = () => useTcheStore.getState();
const O1 = '01010101-0101-4101-8101-010101010101';
const noFetch = async () => {
  throw new Error('a rede não deveria ser usada: as leituras são falsas');
};

const session = (tenantId: string): CloudSession => ({
  url: 'https://x.supabase.co', anon_key: 'anon', email: 'a@b', access_token: 'jwt', refresh_token: 'r', expires_at: 9e9, tenant_id: tenantId,
});

/** Os cadastros da nuvem iguais aos deste aparelho (sem o adicional novo). */
function catalogOfDemo(): CloudSnapshot {
  const s = st();
  const { focus_nfe_token: _f, csc_id: _i, csc_token: _c, ...tenant } = s.tenant;
  return {
    tenant, staff: s.staff.map(({ pin_code: _p, ...u }) => u), terminals: s.terminals, categories: s.categories, products: s.products,
    modifierGroups: s.modifierGroups, modifierOptions: s.modifierOptions, productModifierGroups: s.productModifierGroups,
    priceSchedules: s.priceSchedules, tables: s.tables, rolePermissions: s.rolePermissions, suppliers: s.suppliers,
    supplierProductLinks: s.supplierProductLinks, purchaseInvoices: s.purchaseInvoices, deliveryZones: s.deliveryZones, couriers: s.couriers,
  };
}

/** Conta de outro aparelho com um item que usa os adicionais `options`, lançado às `createdAt`. */
function ordersWith(options: string[], createdAt: string, halves: string[] = []): CloudOrders {
  const s = st();
  const at = createdAt;
  const table = s.tables.find((t) => t.kind === 'TABLE')!;
  const order: Order = {
    id: O1, tenant_id: s.tenant.id, table_id: table.id, opened_by_user_id: 'u', status: 'OPEN', customer_count: 2, customer_cpf: null, subtotal_items: 50,
    charge_service_fee: false, service_fee_pct: 0, service_fee_amount: 0, discount_amount: 0, total_amount: 50, paid_amount: 0, remaining_balance: 50,
    nfce_status: 'PENDING', nfce_key: null, opened_at: at, closed_at: null, pickup_number: null, pickup_name: null, fulfillment_type: null,
  };
  const item: OrderItem = {
    id: 'i1', order_id: O1, product_id: s.products[0]!.id, waiter_id: 'u', quantity: 1, unit_price: 50, modifiers_unit_price: 0, total_item_price: 50,
    meat_doneness: null, notes: null, sector: 'KITCHEN', status: 'PENDING', is_paid: false, origin: 'WAITER', created_at: at, prepared_at: null,
    canceled_at: null, canceled_by_user_id: null, cancel_reason: null, weight_gross_grams: null, weight_tare_grams: null, weight_source: null,
    keg_volume_ml: null, combo_parent_item_id: null, priced_at: at, half_product_ids: halves, modifier_option_ids: options,
  };
  return { tenant_id: s.tenant.id, server_now: at, orders: [order], orderItems: [item], payments: [], ownDeliveries: [], tables: [], cashSessions: [], skippedOrderIds: [] };
}

const applied = () => st().orders.some((o) => o.id === O1);

/**
 * Rodada só das contas: os cadastros foram lidos agora há pouco por este aparelho. Zera a espera
 * depois de falha e o limite de leitura dos cadastros (auditoria interna, rodada 8 do PR #54;
 * testados em pullLoop.test.ts): aqui cada rodada é uma leitura que já está na hora.
 */
async function ordersRound(): Promise<void> {
  resetPullLoopForTests();
  useTcheStore.setState((s) => ({
    pullStatus: { ...s.pullStatus, last_pull_at: new Date().toISOString(), last_orders_pull_at: null },
  }));
  await syncOnce(noFetch);
}

// Item com horário de uma hora antes da última leitura dos cadastros deste aparelho.
const earlier = () => new Date(Date.now() - 3_600_000).toISOString();

beforeEach(() => {
  st().resetDemo();
  useTcheStore.setState({ cloud: session(st().tenant.id), outbox: [], syncRejected: [] });
  fake.catalog.mockReset();
  fake.orders.mockReset();
});

describe('adicional desconhecido nas contas da nuvem (GPT, rodada 7 do PR #54)', () => {
  it('item com horário anterior à última leitura dos cadastros: lê os cadastros antes de aplicar; com a leitura falhando, não aplica', async () => {
    fake.orders.mockImplementation(async () => ordersWith(['m-r7-a'], earlier()));
    fake.catalog.mockRejectedValue(new Error('Cadastros: HTTP 500'));
    await ordersRound();
    expect(fake.orders).toHaveBeenCalledTimes(1);
    expect(fake.catalog).toHaveBeenCalledTimes(1);
    expect(applied()).toBe(false);
    expect(st().pullStatus).toMatchObject({ last_error_source: 'orders' });

    // Leitura falhou: não conta como conferido; a próxima rodada tenta de novo.
    fake.catalog.mockImplementation(async () => catalogOfDemo());
    await ordersRound();
    expect(fake.catalog).toHaveBeenCalledTimes(2);
    expect(applied()).toBe(true);
  });

  it('depois de uma leitura que deu certo e continuou sem o adicional, as próximas rodadas aplicam sem ler os cadastros de novo', async () => {
    fake.orders.mockImplementation(async () => ordersWith(['m-r7-b'], earlier()));
    fake.catalog.mockImplementation(async () => catalogOfDemo());
    await ordersRound();
    expect(fake.catalog).toHaveBeenCalledTimes(1);
    expect(applied()).toBe(true);

    useTcheStore.setState({ orders: st().orders.filter((o) => o.id !== O1) });
    await ordersRound();
    await ordersRound();
    expect(fake.orders).toHaveBeenCalledTimes(3);
    expect(fake.catalog).toHaveBeenCalledTimes(1);
    expect(applied()).toBe(true);
  });

  it('outro adicional desconhecido pede uma leitura nova', async () => {
    fake.catalog.mockImplementation(async () => catalogOfDemo());
    fake.orders.mockImplementation(async () => ordersWith(['m-r7-c'], earlier()));
    await ordersRound();
    expect(fake.catalog).toHaveBeenCalledTimes(1);

    fake.orders.mockImplementation(async () => ordersWith(['m-r7-c', 'm-r7-d'], earlier()));
    await ordersRound();
    expect(fake.catalog).toHaveBeenCalledTimes(2);
    expect(applied()).toBe(true);
  });

  it('cadastros lidos no começo da rodada, antes da foto das contas, não contam: lê de novo depois dela', async () => {
    fake.catalog.mockImplementation(async () => catalogOfDemo());
    fake.orders.mockImplementation(async () => ordersWith(['m-r7-e'], earlier()));
    await syncOnce(noFetch, { forcePull: true });
    // Uma leitura no começo da rodada e outra depois da foto que trouxe o adicional.
    expect(fake.catalog).toHaveBeenCalledTimes(2);
    expect(fake.orders.mock.invocationCallOrder[0]!).toBeLessThan(fake.catalog.mock.invocationCallOrder[1]!);
    expect(applied()).toBe(true);
  });

  it('adicional que chega na leitura dos cadastros feita depois da foto: aplica', async () => {
    const withOption = (): CloudSnapshot => {
      const c = catalogOfDemo();
      const base = c.modifierOptions[0]!;
      return { ...c, modifierOptions: [...c.modifierOptions, { ...base, id: 'm-r7-f' }] };
    };
    fake.catalog.mockImplementation(async () => withOption());
    fake.orders.mockImplementation(async () => ordersWith(['m-r7-f'], earlier()));
    await ordersRound();
    expect(fake.catalog).toHaveBeenCalledTimes(1);
    expect(applied()).toBe(true);
    expect(st().modifierOptions.some((m) => m.id === 'm-r7-f')).toBe(true);
  });
});

describe('sabor de meio a meio desconhecido nas contas da nuvem (auditoria interna, rodada 8 do PR #54)', () => {
  it('lê os cadastros antes de aplicar; com a leitura falhando não aplica; depois de uma leitura que deu certo não trava nem lê a cada rodada', async () => {
    fake.orders.mockImplementation(async () => ordersWith([], earlier(), [st().products[0]!.id, 'h-r8-a']));
    fake.catalog.mockRejectedValue(new Error('Cadastros: HTTP 500'));
    await ordersRound();
    expect(fake.catalog).toHaveBeenCalledTimes(1);
    expect(applied()).toBe(false);

    fake.catalog.mockImplementation(async () => catalogOfDemo());
    await ordersRound();
    expect(fake.catalog).toHaveBeenCalledTimes(2);
    expect(applied()).toBe(true);

    useTcheStore.setState({ orders: st().orders.filter((o) => o.id !== O1) });
    await ordersRound();
    await ordersRound();
    expect(fake.catalog).toHaveBeenCalledTimes(2);
    expect(applied()).toBe(true);
  });
});
