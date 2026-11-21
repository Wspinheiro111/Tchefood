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
import type { Order, OrderItem, OwnDelivery } from '../types';

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

describe('entrega sem acerto aqui com a conta encerrada há mais de 24 h (Codex no PR #54)', () => {
  const O3 = '03030303-0303-4303-8303-030303030303';
  const O4 = '04040404-0404-4404-8404-040404040404';
  const O5 = '05050505-0505-4505-8505-050505050505';
  const S1 = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
  const delivery = (id: string, orderId: string, over: Partial<OwnDelivery> = {}): OwnDelivery => ({
    id, tenant_id: st().tenant.id, order_id: orderId, customer_name: 'Ana', customer_phone: '55999990000', address: 'Rua 1', reference: null,
    zone_id: 'z1', zone_name: 'Centro', delivery_fee: 5, pay_on_delivery: false, change_for: null, status: 'DELIVERED', courier_id: 'c1',
    courier_fee: 4, out_at: '2026-11-12T19:00:00Z', delivered_at: '2026-11-12T19:30:00Z', settlement_id: null, created_at: '2026-11-12T18:30:00Z', ...over,
  });
  const closed = (id: string): Order => ({ ...openOrder(id, st().tables.find((t) => t.kind === 'TABLE')!.id), status: 'CLOSED', closed_at: '2026-11-12T19:30:00Z', paid_amount: 50, remaining_balance: 0 });

  it('a leitura pede a conta da entrega sem acerto (depois das abertas), e o acerto feito em outro aparelho desce', async () => {
    const table = st().tables.find((t) => t.kind === 'TABLE')!.id;
    useTcheStore.setState({
      orders: [closed(O3), openOrder(O2, table), closed(O4), closed(O5)],
      ownDeliveries: [
        delivery('d3', O3),
        delivery('d4', O4, { settlement_id: '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b' }),
        delivery('d5', O5, { status: 'CANCELED' }),
      ],
    });
    fake.orders.mockImplementation(async () => {
      const c = ordersWith();
      return { ...c, orders: [...c.orders, closed(O3)], ownDeliveries: [delivery('d3', O3, { settlement_id: S1 })] };
    });
    await tick();
    expect(fake.orders.mock.calls[0]![3]).toEqual([O2, O3]);
    expect(st().ownDeliveries.find((d) => d.id === 'd3')!.settlement_id).toBe(S1);
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

describe('mais de 500 contas pedidas pelo id: cada leitura pede o lote seguinte (GPT, rodada 13 do PR #54)', () => {
  const id = (n: number) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
  const empty = (): CloudOrders => ({ tenant_id: st().tenant.id, server_now: new Date().toISOString(), orders: [], orderItems: [], payments: [], ownDeliveries: [], tables: [], cashSessions: [], skippedOrderIds: [] });

  it('reconcileWindow percorre a lista inteira e volta ao começo', async () => {
    const { reconcileWindow } = await import('../lib/sync/orderPull');
    const ids = Array.from({ length: 1200 }, (_, n) => id(n));
    const seen = new Set<string>();
    let after: string | null = null;
    for (let i = 0; i < 3; i++) {
      const w = reconcileWindow(ids, after);
      expect(w.ids).toHaveLength(500);
      w.ids.forEach((x) => seen.add(x));
      after = w.next;
    }
    expect(seen.size).toBe(1200);
    expect(reconcileWindow(ids.slice(0, 10), id(7))).toEqual({ ids: ids.slice(0, 10), next: null });
  });

  it('lista que muda entre leituras não pula id ainda não pedido no giro (GPT, rodada 14)', async () => {
    const { reconcileWindow } = await import('../lib/sync/orderPull');
    let ids = Array.from({ length: 1200 }, (_, n) => id(n));
    const first = reconcileWindow(ids, null);
    // 100 contas do primeiro lote fecham e 50 novas entram antes do fim da lista.
    ids = [...ids.filter((x) => !first.ids.slice(0, 100).includes(x)), ...Array.from({ length: 50 }, (_, n) => id(5000 + n))];
    const seen = new Set<string>();
    let after = first.next;
    for (let i = 0; i < 3; i++) {
      const w = reconcileWindow(ids, after);
      w.ids.forEach((x) => seen.add(x));
      after = w.next;
    }
    // Do id 500 em diante (e as 50 novas), tudo foi pedido no mesmo giro.
    for (const x of ids.filter((x) => x > first.next!)) expect(seen.has(x)).toBe(true);
    expect(seen.has(id(500))).toBe(true);
    // O id que sumiu da lista: o próximo lote começa no seguinte que ainda existe.
    expect(reconcileWindow([id(1), id(3), ...Array.from({ length: 600 }, (_, n) => id(1000 + n))], id(2)).ids[0]).toBe(id(3));
  });

  it('a conta encerrada em outro aparelho fora do primeiro lote chega e libera a mesa', async () => {
    const table = st().tables.find((t) => t.kind === 'TABLE')!;
    const target = id(599);
    const local = Array.from({ length: 600 }, (_, n) => openOrder(id(n), n === 599 ? table.id : `mesa-${n}`));
    useTcheStore.setState((s) => ({
      orders: [...s.orders, ...local],
      tables: s.tables.map((t) => (t.id === table.id ? { ...t, status: 'OCCUPIED', current_order_id: target } : t)),
    }));
    const closedAt = new Date(Date.now() - 2 * 24 * 3600_000).toISOString();
    fake.catalog.mockResolvedValue(catalogOfDemo());
    fake.orders.mockImplementation(async (...args: unknown[]) => {
      const asked = args[3] as string[];
      expect(asked.length).toBeLessThanOrEqual(500);
      if (!asked.includes(target)) return empty();
      const closed = { ...openOrder(target, table.id), status: 'CLOSED' as const, closed_at: closedAt, paid_amount: 50, remaining_balance: 0 };
      return { ...empty(), orders: [closed], tables: [{ id: table.id, status: 'FREE', current_order_id: null, updated_at: closedAt }] };
    });
    await tick({ forcePull: true });
    expect(st().orders.find((o) => o.id === target)!.status).toBe('OPEN');
    await tick({ forcePull: true });
    expect(st().orders.find((o) => o.id === target)!.status).toBe('CLOSED');
    expect(st().tables.find((t) => t.id === table.id)!.current_order_id).toBeNull();
  });

  it('foto que não pode ser aplicada pede o mesmo lote de novo (GPT, rodada 14)', async () => {
    const local = Array.from({ length: 600 }, (_, n) => openOrder(id(n), `mesa-${n}`));
    useTcheStore.setState((s) => ({ orders: [...s.orders, ...local] }));
    fake.catalog.mockResolvedValue(catalogOfDemo());
    let calls = 0;
    fake.orders.mockImplementation(async () => {
      calls += 1;
      // Primeira foto traz um produto que nenhuma leitura dos cadastros conhece: não é aplicada.
      if (calls === 1) return { ...empty(), orders: [openOrder(id(0), 'mesa-0')], orderItems: [{ id: 'it-x', order_id: id(0), product_id: 'produto-que-nao-existe', quantity: 1, unit_price: 1, total_price: 1, status: 'PENDING', is_paid: false, sector: 'KITCHEN', created_at: new Date().toISOString() } as never] };
      return empty();
    });
    await tick({ forcePull: true });
    await tick({ forcePull: true });
    const asked = fake.orders.mock.calls.map((c) => c[3] as string[]);
    expect(asked.length).toBeGreaterThanOrEqual(2);
    expect(asked[1]).toEqual(asked[0]);
    await tick({ forcePull: true });
    const third = fake.orders.mock.calls.at(-1)![3] as string[];
    expect(third).not.toEqual(asked[0]);
    expect(third).toContain(id(599));
  });

  it('conta antiga que espera o lote dela fica não conferida, não é cobrada e depois fecha (GPT, rodada 15)', async () => {
    const table = st().tables.find((t) => t.kind === 'TABLE')!;
    const target = id(500);
    const local = Array.from({ length: 501 }, (_, n) => openOrder(id(n), n === 500 ? table.id : `mesa-${n}`));
    useTcheStore.setState((s) => ({
      orders: [...s.orders, ...local],
      tables: s.tables.map((t) => (t.id === table.id ? { ...t, status: 'OCCUPIED', current_order_id: target } : t)),
    }));
    const closedAt = new Date(Date.now() - 2 * 24 * 3600_000).toISOString();
    fake.catalog.mockResolvedValue(catalogOfDemo());
    fake.orders.mockImplementation(async (...args: unknown[]) => {
      const asked = args[3] as string[];
      if (!asked.includes(target)) return empty();
      const closed = { ...openOrder(target, table.id), status: 'CLOSED' as const, closed_at: closedAt, paid_amount: 50, remaining_balance: 0 };
      return { ...empty(), orders: [closed], tables: [{ id: table.id, status: 'FREE', current_order_id: null, updated_at: closedAt }] };
    });
    await tick({ forcePull: true });
    // Só o primeiro lote: a conta continua aberta aqui, mas marcada como não conferida.
    expect(st().orders.find((o) => o.id === target)!.status).toBe('OPEN');
    // (com as contas abertas da demonstração, de id maior, também fora do primeiro lote)
    const waiting = st().cloudUnreconciledOrderIds!;
    expect(waiting).toContain(target);
    expect(waiting.every((x) => !(fake.orders.mock.calls[0]![3] as string[]).includes(x))).toBe(true);
    expect(cloudStaleMessage({ cloud: true, pullStatus: st().pullStatus, sessionSinceMs: Date.now(), nowMs: Date.now(), unreconciled: waiting.length })).toMatch(new RegExp(`${waiting.length} contas antigas deste aparelho ainda não foram conferidas com a nuvem`));
    expect(cloudStaleMessage({ cloud: true, pullStatus: st().pullStatus, sessionSinceMs: Date.now(), nowMs: Date.now(), unreconciled: 1 })).toMatch(/1 conta antiga deste aparelho ainda não foi conferida/);
    // Cobrar em dinheiro aqui é recusado enquanto ela espera o lote.
    const login = st().login('5555');
    if (!login.ok) throw new Error(login.error);
    const paid = st().registerPayment({ orderId: target, amount: 50, method: 'CASH', status: 'APPROVED', terminal_id: null, acquirer: 'CASH_DESK', acquirer_cnpj: null, card_brand: null, nsu: null, authorization_code: null, terminal_serial: null, idempotency_key: 'nao-conferida', item_ids: [] });
    expect(paid.ok).toBe(false);
    expect(paid.ok ? '' : paid.error).toMatch(/ainda não foi conferida com a nuvem/);
    expect(st().payments.some((p) => p.order_id === target)).toBe(false);
    // As do primeiro lote foram conferidas e continuam cobráveis.
    expect(st().cloudUnreconciledOrderIds).not.toContain(id(0));
    // Próximo lote: o fechamento chega, a mesa fica livre e nada mais espera.
    await tick({ forcePull: true });
    expect(st().orders.find((o) => o.id === target)!.status).toBe('CLOSED');
    expect(st().tables.find((t) => t.id === table.id)!.current_order_id).toBeNull();
    expect(st().cloudUnreconciledOrderIds).toEqual([]);
    // A volta seguinte (primeiro lote de novo) não marca de novo as já conferidas.
    await tick({ forcePull: true });
    expect(st().cloudUnreconciledOrderIds).toEqual([]);
  });

  it('a entrega sem acerto fora do primeiro lote também é pedida', async () => {
    const local = Array.from({ length: 600 }, (_, n) => openOrder(id(n), `mesa-${n}`));
    const deliveryOrder = id(700);
    useTcheStore.setState((s) => ({
      orders: [...s.orders, ...local],
      ownDeliveries: [...s.ownDeliveries, { id: 'd-700', order_id: deliveryOrder, status: 'DELIVERED', settlement_id: null } as OwnDelivery],
    }));
    fake.catalog.mockResolvedValue(catalogOfDemo());
    fake.orders.mockImplementation(async () => empty());
    await tick({ forcePull: true });
    await tick({ forcePull: true });
    for (const c of fake.orders.mock.calls) expect((c[3] as string[]).length).toBeLessThanOrEqual(500);
    const asked = fake.orders.mock.calls.flatMap((c) => c[3] as string[]);
    expect(asked).toContain(deliveryOrder);
  });
});

describe('falha de leitura da loja anterior não aparece na loja atual (GPT, rodada 15 do PR #54)', () => {
  const B = '0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e';
  const switchToB = () => useTcheStore.setState((s) => ({ tenant: { ...s.tenant, id: B }, cloud: { ...session(B), access_token: 'jwt-b' }, pullStatus: { ...s.pullStatus, last_error: null, last_error_source: null } }));

  it('contas: a leitura de A falha depois da troca para B e B fica como estava', async () => {
    let reject: (e: unknown) => void = () => undefined;
    fake.orders.mockImplementation(() => new Promise((_, rej) => { reject = rej; }));
    const round = syncOnce(noFetch, {});
    await vi.waitFor(() => expect(fake.orders).toHaveBeenCalledTimes(1));
    switchToB();
    const before = st().pullStatus;
    reject(new Error('Não foi possível ler as contas da nuvem: HTTP 500'));
    await round;
    expect(st().pullStatus).toEqual(before);
    expect(st().pullStatus?.last_error ?? null).toBeNull();
  });

  it('cadastros: a leitura de A falha depois da troca para B e B fica como estava', async () => {
    let reject: (e: unknown) => void = () => undefined;
    fake.catalog.mockImplementation(() => new Promise((_, rej) => { reject = rej; }));
    fake.orders.mockImplementation(async () => { throw new Error('as contas de B não deviam ser lidas com o token de A'); });
    useTcheStore.setState((s) => ({ pullStatus: { ...s.pullStatus, last_pull_at: null, last_orders_pull_at: new Date().toISOString() } }));
    const round = syncOnce(noFetch, { forcePull: true });
    await vi.waitFor(() => expect(fake.catalog).toHaveBeenCalledTimes(1));
    switchToB();
    const before = st().pullStatus;
    reject(new Error('Não foi possível ler os cadastros da nuvem: HTTP 500'));
    await round;
    expect(st().pullStatus).toEqual(before);
    expect(fake.orders).not.toHaveBeenCalled();
  });
});

describe('GPT, rodada 17 do PR #54', () => {
  const id = (n: number) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
  const empty = (): CloudOrders => ({ tenant_id: st().tenant.id, server_now: new Date().toISOString(), orders: [], orderItems: [], payments: [], ownDeliveries: [], tables: [], cashSessions: [], skippedOrderIds: [] });
  const login = () => {
    const r = st().login('5555');
    if (!r.ok) throw new Error(r.error);
  };
  const cash = (orderId: string, key: string) => st().registerPayment({ orderId, amount: 50, method: 'CASH', status: 'APPROVED', terminal_id: null, acquirer: 'CASH_DESK', acquirer_cnpj: null, card_brand: null, nsu: null, authorization_code: null, terminal_serial: null, idempotency_key: key, item_ids: [] });

  it('P1-01: conta não conferida não recebe item novo (bandeja nem envio), nem muda pessoas ou pede a conta', async () => {
    const table = st().tables.find((t) => t.kind === 'TABLE')!;
    const target = id(500);
    const local = Array.from({ length: 501 }, (_, n) => openOrder(id(n), n === 500 ? table.id : `mesa-${n}`));
    useTcheStore.setState((s) => ({
      orders: [...s.orders, ...local],
      tables: s.tables.map((t) => (t.id === table.id ? { ...t, status: 'OCCUPIED', current_order_id: target } : t)),
    }));
    fake.catalog.mockResolvedValue(catalogOfDemo());
    fake.orders.mockImplementation(async () => empty());
    await tick({ forcePull: true });
    expect(st().cloudUnreconciledOrderIds).toContain(target);
    login();
    const p = st().products.find((x) => x.active && x.available && !x.sold_by_weight && !x.requires_meat_doneness && !x.allows_half_and_half)!;
    const draft = { order_id: target, product_id: p.id, half_product_ids: [], quantity: 1, unit_price: p.price, modifiers: [], modifiers_unit_price: 0, meat_doneness: null, quick_tags: [], free_notes: '', sector: p.sector };
    const added = st().addToTray(draft);
    expect(added.ok ? '' : added.error).toMatch(/ainda não foi conferida com a nuvem/);
    // Item que já estava na bandeja antes da leitura: o envio também é recusado, sem item, evento nem pedido da cozinha.
    useTcheStore.setState((s) => ({ tray: [...s.tray, { ...draft, id: 'tray-1' } as never] }));
    const items = st().orderItems.length;
    const outbox = st().outbox.length;
    const sent = st().dispatchTray(target);
    expect(sent.ok ? '' : sent.error).toMatch(/ainda não foi conferida com a nuvem/);
    expect(st().orderItems.length).toBe(items);
    expect(st().orderItems.some((i) => i.order_id === target)).toBe(false);
    expect(st().outbox.length).toBe(outbox);
    expect(st().updateCustomerCount(target, 4).ok).toBe(false);
    expect(st().requestBill(target).ok).toBe(false);
    // O pedido pelo QR da mesa também não entra nessa conta.
    const qr = st().qrPlaceOrder(table.id, [{ product_id: p.id, half_product_ids: [], quantity: 1, modifiers: [], meat_doneness: null, notes: '' } as never]);
    expect(qr.ok ? '' : qr.error).toMatch(/Conta em conferência/);
    expect(st().orderItems.some((i) => i.order_id === target)).toBe(false);
    // Conta já conferida (primeiro lote) continua aceitando item.
    expect(st().addToTray({ ...draft, order_id: id(0) }).ok).toBe(true);
  });

  it('P1-01: conta deixada de lado pela leitura (versão do app) também não recebe item', async () => {
    const table = st().tables.find((t) => t.kind === 'TABLE')!;
    const target = id(1);
    useTcheStore.setState((s) => ({ orders: [...s.orders, openOrder(target, table.id)] }));
    fake.catalog.mockResolvedValue(catalogOfDemo());
    fake.orders.mockImplementation(async () => ({ ...empty(), skippedOrderIds: [target] }));
    await tick({ forcePull: true });
    login();
    const p = st().products.find((x) => x.active && x.available && !x.sold_by_weight && !x.requires_meat_doneness && !x.allows_half_and_half)!;
    const r = st().addToTray({ order_id: target, product_id: p.id, half_product_ids: [], quantity: 1, unit_price: p.price, modifiers: [], modifiers_unit_price: 0, meat_doneness: null, quick_tags: [], free_notes: '', sector: p.sector });
    expect(r.ok ? '' : r.error).toMatch(/atualize o app/);
  });

  it('P2-01: conta deixada de lado no primeiro lote continua bloqueada no lote seguinte, até voltar válida', async () => {
    const target = id(400);
    const tableId = st().tables.find((t) => t.kind === 'TABLE')!.id;
    const local = Array.from({ length: 1200 }, (_, n) => openOrder(id(n), n === 400 ? tableId : `mesa-${n}`));
    useTcheStore.setState((s) => ({ orders: [...s.orders, ...local] }));
    fake.catalog.mockResolvedValue(catalogOfDemo());
    let valid = false;
    fake.orders.mockImplementation(async (...args: unknown[]) => {
      const asked = args[3] as string[];
      if (!asked.includes(target)) return empty();
      if (!valid) return { ...empty(), skippedOrderIds: [target] };
      const closed = { ...openOrder(target, tableId), status: 'CLOSED' as const, closed_at: new Date(Date.now() - 2 * 24 * 3600_000).toISOString(), paid_amount: 50, remaining_balance: 0 };
      return { ...empty(), orders: [closed] };
    });
    await tick({ forcePull: true });
    expect(st().cloudSkippedOrderIds).toContain(target);
    // Segundo lote (sem a O400): continua de lado e não é cobrada.
    await tick({ forcePull: true });
    expect((fake.orders.mock.calls.at(-1)![3] as string[]).includes(target)).toBe(false);
    expect(st().cloudSkippedOrderIds).toContain(target);
    login();
    const paid = cash(target, 'pulada-1');
    expect(paid.ok ? '' : paid.error).toMatch(/atualize o app/);
    // Terceiro lote e volta ao primeiro: o app foi atualizado e a conta vem válida (encerrada).
    valid = true;
    for (let i = 0; i < 3 && st().orders.find((o) => o.id === target)!.status !== 'CLOSED'; i++) await tick({ forcePull: true });
    expect(st().orders.find((o) => o.id === target)!.status).toBe('CLOSED');
    expect(st().cloudSkippedOrderIds).not.toContain(target);
  });

  it('P2-02: leitura das contas que volta a dar certo não apaga o aviso dos estornos, só a leitura dos estornos', async () => {
    let refundsFail = true;
    const fetchFn = (async (url: string) => {
      const fn = String(url).split('/rpc/')[1] ?? '';
      if (fn.startsWith('tchefood_list_refund_order_changes') && refundsFail) return { ok: false, status: 500, text: async () => 'erro' };
      if (fn.startsWith('tchefood_list_refund_order_changes')) return { ok: true, status: 200, text: async () => JSON.stringify({ items: [], next_seq: 0, safe_seq: 0, has_more: false }) };
      return { ok: true, status: 200, text: async () => JSON.stringify({ items: [], next_cursor: null }) };
    }) as never;
    fake.catalog.mockResolvedValue(catalogOfDemo());
    fake.orders.mockRejectedValueOnce(new Error('Não foi possível ler as contas da nuvem: HTTP 500'));
    await syncOnce(fetchFn, { forcePull: true });
    expect(st().pullStatus?.last_error_source).toBe('orders');
    expect(st().pullStatus?.refund_error ?? '').toMatch(/estornos e encerramentos/);
    // Dez segundos depois só a leitura das contas roda (a dos estornos é por minuto) e dá certo.
    fake.orders.mockResolvedValue(empty());
    advance(10_000);
    useTcheStore.setState((s) => ({ pullStatus: { ...s.pullStatus!, last_pull_at: new Date().toISOString(), last_orders_pull_at: null } }));
    await syncOnce(fetchFn, {});
    expect(fake.orders).toHaveBeenCalledTimes(2);
    expect(st().pullStatus?.last_error ?? null).toBeNull();
    expect(st().pullStatus?.refund_error ?? '').toMatch(/estornos e encerramentos/);
    expect(cloudStaleMessage({ cloud: true, pullStatus: st().pullStatus, sessionSinceMs: Date.now(), nowMs: Date.now() }) ?? '').toMatch(/estornos e encerramentos/);
    // A leitura dos estornos que dá certo limpa o aviso dela.
    refundsFail = false;
    await syncOnce(fetchFn, { forcePull: true });
    expect(st().pullStatus?.refund_error ?? null).toBeNull();
  });
});
