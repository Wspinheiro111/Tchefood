/**
 * Laço de leitura das contas da nuvem (auditoria interna, rodada 8 do PR #54): depois de uma
 * leitura das contas que falhou ou foi recusada, o aparelho espera mais a cada falha (10 s,
 * 20 s, 40 s… até 2 min) em vez de tentar a cada 5 s; a leitura dos cadastros pedida por
 * cadastro que falta nas contas sai no máximo uma vez por minuto por loja; "Sincronizar agora"
 * (forcePull) não espera. Também: erro de rede não apaga o aviso que já existe, ids de conta
 * que não são UUID não vão para o banco e o aviso de contas paradas nas telas da equipe.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudSnapshot } from '../lib/sync/cloudPull';
import type { CloudOrders } from '../lib/sync/orderPull';
import { useTcheStore, type CloudSession } from '../store/useTcheStore';
import type { Order, OrderItem } from '../types';

const fake = vi.hoisted(() => ({
  catalog: vi.fn<() => Promise<unknown>>(),
  orders: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));
vi.mock('../lib/sync/cloudPull', async (orig) => ({ ...(await orig<typeof import('../lib/sync/cloudPull')>()), fetchCloudSnapshot: fake.catalog }));
vi.mock('../lib/sync/orderPull', async (orig) => ({ ...(await orig<typeof import('../lib/sync/orderPull')>()), fetchCloudOrders: fake.orders }));

const { syncOnce, resetPullLoopForTests, ordersBackoffMs, cloudStaleMessage, ORDERS_STALE_MS } = await import('../lib/sync/useCloudSync');

const st = () => useTcheStore.getState();
const O1 = '01010101-0101-4101-8101-010101010101';
const O2 = '02020202-0202-4202-8202-020202020202';
const noFetch = async () => {
  throw new Error('a rede não deveria ser usada: as leituras são falsas');
};

const session = (tenantId: string): CloudSession => ({
  url: 'https://x.supabase.co', anon_key: 'anon', email: 'a@b', access_token: 'jwt', refresh_token: 'r', expires_at: 9e9, tenant_id: tenantId,
});

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

function openOrder(id: string, tableId: string): Order {
  const at = new Date().toISOString();
  return {
    id, tenant_id: st().tenant.id, table_id: tableId, opened_by_user_id: 'u', status: 'OPEN', customer_count: 2, customer_cpf: null, subtotal_items: 50,
    charge_service_fee: false, service_fee_pct: 0, service_fee_amount: 0, discount_amount: 0, total_amount: 50, paid_amount: 0, remaining_balance: 50,
    nfce_status: 'PENDING', nfce_key: null, opened_at: at, closed_at: null, pickup_number: null, pickup_name: null, fulfillment_type: null,
  };
}

/** Conta de outro aparelho; `tableId` desconhecido faz faltar cadastro (missingCatalog). */
function ordersWith(opts: { tableId?: string; options?: string[] } = {}): CloudOrders {
  const s = st();
  const at = new Date().toISOString();
  const order = openOrder(O1, opts.tableId ?? s.tables.find((t) => t.kind === 'TABLE')!.id);
  const item: OrderItem = {
    id: 'i1', order_id: O1, product_id: s.products[0]!.id, waiter_id: 'u', quantity: 1, unit_price: 50, modifiers_unit_price: 0, total_item_price: 50,
    meat_doneness: null, notes: null, sector: 'KITCHEN', status: 'PENDING', is_paid: false, origin: 'WAITER', created_at: at, prepared_at: null,
    canceled_at: null, canceled_by_user_id: null, cancel_reason: null, weight_gross_grams: null, weight_tare_grams: null, weight_source: null,
    keg_volume_ml: null, combo_parent_item_id: null, priced_at: at, half_product_ids: [], modifier_option_ids: opts.options ?? [],
  };
  return { tenant_id: s.tenant.id, server_now: at, orders: [order], orderItems: [item], payments: [], ownDeliveries: [], tables: [], cashSessions: [], skippedOrderIds: [] };
}

const applied = () => st().orders.some((o) => o.id === O1);

/** Uma batida do laço (5 s) com os cadastros lidos agora há pouco pela cadência normal. */
async function tick(opts: { forcePull?: boolean } = {}): Promise<void> {
  useTcheStore.setState((s) => ({
    pullStatus: { ...s.pullStatus, last_pull_at: new Date().toISOString(), last_orders_pull_at: null },
  }));
  await syncOnce(noFetch, opts);
}

const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-14T20:00:00Z'));
  resetPullLoopForTests();
  st().resetDemo();
  useTcheStore.setState({ cloud: session(st().tenant.id), outbox: [], syncRejected: [] });
  fake.catalog.mockReset();
  fake.orders.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('espera depois de uma leitura das contas que falhou (auditoria interna, rodada 8 do PR #54)', () => {
  it('a espera dobra a cada falha, de 10 s até 2 min', () => {
    expect([1, 2, 3, 4, 5, 6, 10].map(ordersBackoffMs)).toEqual([10_000, 20_000, 40_000, 80_000, 120_000, 120_000, 120_000]);
  });

  it('falha: as batidas seguintes não leem de novo até passar a espera; "Sincronizar agora" lê na hora; dar certo zera a espera', async () => {
    fake.orders.mockRejectedValue(new Error('Não foi possível ler as contas da nuvem: HTTP 500'));
    await tick();
    expect(fake.orders).toHaveBeenCalledTimes(1);

    // Batidas de 5 s antes de passar 10 s: nada.
    advance(5_000);
    await tick();
    expect(fake.orders).toHaveBeenCalledTimes(1);

    advance(5_000);
    await tick();
    expect(fake.orders).toHaveBeenCalledTimes(2);

    // Segunda falha: 20 s.
    advance(10_000);
    await tick();
    expect(fake.orders).toHaveBeenCalledTimes(2);
    advance(10_000);
    await tick();
    expect(fake.orders).toHaveBeenCalledTimes(3);

    // "Sincronizar agora" não espera.
    await tick({ forcePull: true });
    expect(fake.orders).toHaveBeenCalledTimes(4);

    // Deu certo: a próxima falha volta a esperar só 10 s.
    fake.orders.mockImplementation(async () => ordersWith());
    fake.catalog.mockImplementation(async () => catalogOfDemo());
    await tick({ forcePull: true });
    expect(applied()).toBe(true);
    fake.orders.mockRejectedValue(new Error('HTTP 500'));
    await tick();
    expect(fake.orders).toHaveBeenCalledTimes(6);
    advance(10_000);
    await tick();
    expect(fake.orders).toHaveBeenCalledTimes(7);
  });

  it('a espera é por loja: outra loja no aparelho não herda a falha', async () => {
    fake.orders.mockRejectedValue(new Error('HTTP 500'));
    await tick();
    expect(fake.orders).toHaveBeenCalledTimes(1);
    const other = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';
    useTcheStore.setState((s) => ({ tenant: { ...s.tenant, id: other }, cloud: session(other) }));
    await tick();
    expect(fake.orders).toHaveBeenCalledTimes(2);
  });
});

describe('leitura dos cadastros pedida pelas contas: no máximo uma por minuto (auditoria interna, rodada 8 do PR #54)', () => {
  it('mesa que nunca chega: lê os cadastros uma vez por minuto, não a cada leitura das contas', async () => {
    fake.catalog.mockImplementation(async () => catalogOfDemo());
    fake.orders.mockImplementation(async () => ordersWith({ tableId: 'mesa-que-nao-existe' }));
    await tick();
    expect(fake.orders).toHaveBeenCalledTimes(1);
    expect(fake.catalog).toHaveBeenCalledTimes(1);
    expect(applied()).toBe(false);
    expect(st().pullStatus).toMatchObject({ last_error_source: 'orders' });

    // 10 s (1ª espera) e depois 20 s: lê as contas, mas não os cadastros.
    advance(10_000);
    await tick();
    expect(fake.orders).toHaveBeenCalledTimes(2);
    expect(fake.catalog).toHaveBeenCalledTimes(1);
    advance(20_000);
    await tick();
    expect(fake.orders).toHaveBeenCalledTimes(3);
    expect(fake.catalog).toHaveBeenCalledTimes(1);

    // 40 s depois (70 s da primeira leitura dos cadastros): pode ler de novo.
    advance(40_000);
    await tick();
    expect(fake.orders).toHaveBeenCalledTimes(4);
    expect(fake.catalog).toHaveBeenCalledTimes(2);
    expect(applied()).toBe(false);
  });

  it('adicional desconhecido também entra no limite', async () => {
    fake.catalog.mockRejectedValue(new Error('Cadastros: HTTP 500'));
    fake.orders.mockImplementation(async () => ordersWith({ options: ['m-r8-loop'] }));
    await tick();
    expect(fake.catalog).toHaveBeenCalledTimes(1);
    advance(10_000);
    await tick();
    expect(fake.orders).toHaveBeenCalledTimes(2);
    expect(fake.catalog).toHaveBeenCalledTimes(1);
  });

  it('"Sincronizar agora" não respeita o limite', async () => {
    fake.catalog.mockRejectedValue(new Error('Cadastros: HTTP 500'));
    fake.orders.mockImplementation(async () => ordersWith({ options: ['m-r8-force'] }));
    await tick();
    expect(fake.catalog).toHaveBeenCalledTimes(1);
    await tick({ forcePull: true });
    // Uma no começo da rodada (forcePull) e outra depois da foto, mesmo dentro do minuto.
    expect(fake.catalog).toHaveBeenCalledTimes(3);
  });
});

describe('erro de rede na leitura das contas (auditoria interna, rodada 8 do PR #54)', () => {
  it('não apaga o aviso que já existe; sem aviso, explica em português', async () => {
    fake.orders.mockRejectedValue(new TypeError('Failed to fetch'));
    fake.catalog.mockImplementation(async () => catalogOfDemo());
    useTcheStore.setState((s) => ({ pullStatus: { ...s.pullStatus, last_error: 'aviso anterior', last_error_source: 'orders' } }));
    await tick();
    expect(st().pullStatus.last_error).toBe('aviso anterior');

    useTcheStore.setState((s) => ({ pullStatus: { ...s.pullStatus, last_error: null, last_error_source: null } }));
    await tick({ forcePull: true });
    expect(st().pullStatus.last_error).toMatch(/^Sem conexão com a nuvem/);
  });
});

describe('contas abertas enviadas ao banco (auditoria interna, rodada 8 do PR #54)', () => {
  it('só vão ids que são UUID', async () => {
    const table = st().tables.find((t) => t.kind === 'TABLE')!.id;
    useTcheStore.setState({ orders: [openOrder('conta-local-antiga', table), openOrder(O2, table)] });
    fake.orders.mockImplementation(async () => ordersWith());
    await tick();
    expect(fake.orders).toHaveBeenCalledTimes(1);
    expect(fake.orders.mock.calls[0]![3]).toEqual([O2]);
  });
});

describe('contas deixadas de lado pela leitura (auditoria interna, rodada 8 do PR #54)', () => {
  it('aplica o resto e deixa o aviso das contas', async () => {
    fake.orders.mockImplementation(async () => ({ ...ordersWith(), skippedOrderIds: [O2] }));
    await tick();
    expect(applied()).toBe(true);
    expect(st().pullStatus.last_error).toBeTruthy();
    expect(st().pullStatus.last_error_source).toBe('orders');
  });
});

describe('aviso de contas paradas nas telas da equipe (auditoria interna, rodada 8 do PR #54)', () => {
  const now = Date.parse('2026-11-14T20:00:00Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it('sem nuvem: nada', () => {
    expect(cloudStaleMessage({ cloud: false, pullStatus: { last_orders_pull_at: ago(600_000) }, sessionSinceMs: now - 600_000, nowMs: now })).toBeNull();
  });

  it('lidas há pouco: nada; há mais de um minuto: avisa com os minutos', () => {
    expect(cloudStaleMessage({ cloud: true, pullStatus: { last_orders_pull_at: ago(30_000) }, sessionSinceMs: now - 600_000, nowMs: now })).toBeNull();
    expect(cloudStaleMessage({ cloud: true, pullStatus: { last_orders_pull_at: ago(ORDERS_STALE_MS + 1) }, sessionSinceMs: now - 600_000, nowMs: now })).toMatch(/há 1 min/);
    expect(cloudStaleMessage({ cloud: true, pullStatus: { last_orders_pull_at: ago(5 * 60_000) }, sessionSinceMs: now - 600_000, nowMs: now })).toMatch(/há 5 min/);
  });

  it('nunca lidas: avisa só depois de um minuto com a nuvem conectada', () => {
    expect(cloudStaleMessage({ cloud: true, pullStatus: { last_orders_pull_at: null }, sessionSinceMs: now - 30_000, nowMs: now })).toBeNull();
    expect(cloudStaleMessage({ cloud: true, pullStatus: { last_orders_pull_at: null }, sessionSinceMs: now - 90_000, nowMs: now })).toMatch(/ainda não/);
  });

  it('aviso da leitura das contas aparece mesmo com a leitura em dia; o dos cadastros não', () => {
    expect(cloudStaleMessage({ cloud: true, pullStatus: { last_orders_pull_at: ago(1_000), last_error: 'Conta deixada de lado', last_error_source: 'orders' }, sessionSinceMs: now - 600_000, nowMs: now })).toBe('Conta deixada de lado');
    expect(cloudStaleMessage({ cloud: true, pullStatus: { last_orders_pull_at: ago(1_000), last_error: 'Cadastros: HTTP 500', last_error_source: 'catalog' }, sessionSinceMs: now - 600_000, nowMs: now })).toBeNull();
  });
});

describe('mensagens da leitura das contas e espera medida do fim (auditoria interna, rodada 8 do PR #54)', () => {
  it('erro de rede: só o texto em português, sem o texto do navegador', async () => {
    fake.orders.mockRejectedValue(new TypeError('Failed to fetch'));
    fake.catalog.mockImplementation(async () => catalogOfDemo());
    await tick();
    expect(st().pullStatus.last_error).toMatch(/^Sem conexão com a nuvem/);
    expect(st().pullStatus.last_error).not.toMatch(/Failed to fetch/);
  });

  it('função da leitura que o banco ainda não tem (HTTP 404 / PGRST202): pede o suporte em português', async () => {
    fake.catalog.mockImplementation(async () => catalogOfDemo());
    fake.orders.mockRejectedValue(new Error('Não foi possível ler as contas da nuvem: Could not find the function public.tchefood_pull_orders(p_order_ids) in the schema cache'));
    await tick();
    expect(st().pullStatus.last_error).toMatch(/migration/);
    expect(st().pullStatus.last_error).toMatch(/suporte/);
    expect(st().pullStatus.last_error).not.toMatch(/Could not find/);

    useTcheStore.setState((s) => ({ pullStatus: { ...s.pullStatus, last_error: null, last_error_source: null } }));
    fake.orders.mockRejectedValue(new Error('Não foi possível ler as contas da nuvem: HTTP 404'));
    await tick({ forcePull: true });
    expect(st().pullStatus.last_error).toMatch(/migration/);
  });

  it('cadastro faltando com a leitura dos cadastros falhando: o aviso das contas conta as duas', async () => {
    fake.catalog.mockRejectedValue(new Error('Cadastros: HTTP 500'));
    fake.orders.mockImplementation(async () => ordersWith({ tableId: 'mesa-que-nao-existe' }));
    await tick();
    expect(st().pullStatus.last_error).toMatch(/falta o cadastro/);
    expect(st().pullStatus.last_error).toMatch(/a leitura dos cadastros também falhou: Cadastros: HTTP 500/);
    expect(st().pullStatus.last_error_source).toBe('orders');

    // Com a leitura dos cadastros dando certo, só o cadastro faltando.
    fake.catalog.mockImplementation(async () => catalogOfDemo());
    await tick({ forcePull: true });
    expect(st().pullStatus.last_error).toMatch(/falta o cadastro/);
    expect(st().pullStatus.last_error).not.toMatch(/também falhou/);
  });

  it('cadastro faltando com a leitura dos cadastros sem conexão: um "Tentando de novo" só, sem ponto repetido', async () => {
    // Auditoria interna, rodada 8 do PR #54.
    fake.catalog.mockRejectedValue(new TypeError('Failed to fetch'));
    fake.orders.mockImplementation(async () => ordersWith({ tableId: 'mesa-que-nao-existe' }));
    await tick();
    expect(st().pullStatus.last_error).toBe(
      'Não foi possível ler as contas da nuvem: falta o cadastro de um produto, adicional ou mesa usado nelas; a leitura dos cadastros também falhou: Sem conexão com a nuvem. Tentando de novo.',
    );
  });

  it('a espera conta do fim da leitura que falhou, não do começo', async () => {
    // Leitura lenta: 8 s até falhar.
    fake.orders.mockImplementation(async () => {
      advance(8_000);
      throw new Error('HTTP 500');
    });
    await tick();
    expect(fake.orders).toHaveBeenCalledTimes(1);
    advance(5_000); // 13 s do começo, 5 s do fim
    await tick();
    expect(fake.orders).toHaveBeenCalledTimes(1);
    advance(5_000); // 10 s do fim
    await tick();
    expect(fake.orders).toHaveBeenCalledTimes(2);
  });

  it('tempo parado em min, h e dias; nada antes da primeira leitura desta abertura (com menos de um minuto de sessão)', () => {
    const now = Date.parse('2026-11-14T20:00:00Z');
    const ago = (ms: number) => new Date(now - ms).toISOString();
    const msg = (ms: number, ordersRoundRan = true) =>
      cloudStaleMessage({ cloud: true, pullStatus: { last_orders_pull_at: ago(ms) }, sessionSinceMs: now - 5_000, nowMs: now, ordersRoundRan });
    expect(msg(5 * 60_000)).toMatch(/há 5 min/);
    expect(msg(90 * 60_000)).toMatch(/há 1 h 30 min/);
    expect(msg(900 * 60_000)).toMatch(/há 15 h:/);
    expect(msg(26 * 3_600_000)).toMatch(/há 1 dia:/);
    expect(msg(3 * 86_400_000)).toMatch(/há 3 dias/);
    expect(msg(900 * 60_000, false)).toBeNull();
  });
});
