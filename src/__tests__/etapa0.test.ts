import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migratePersisted, QR_PRICE_CHANGED, selectCan, useTcheStore } from '../store/useTcheStore';
import { activeSchedule, effectivePrice, scheduleIntervals, validatePriceSchedule, validateProduct, validateStaff } from '../lib/catalog';
import { can } from '../lib/permissions';
import { buildSyncRequest, flushOutbox, serverOrder, needsRefresh, sanitizePayload, signInDevice, tenantFromJwt, type FetchLike } from '../lib/sync/supabaseSync';
import { parseMoneyInput } from '../screens/admin/fields';
import { isQrSelfService } from '../data/seed';
import type { PriceSchedule, Product, SyncEvent } from '../types';

const st = () => useTcheStore.getState();
const product = (code: string) => st().products.find((p) => p.code === code)!;
const table = (n: number) => st().tables.find((t) => t.number === n)!;
const staffByPin = (pin: string) => st().staff.find((u) => u.pin_code === pin)!;
const OWNER = '8888';
const MANAGER = '9999';
const WAITER = '1111';
const CASHIER = '5555';
const KITCHEN = '7777';

function login(pin: string) {
  const r = st().login(pin);
  if (!r.ok) throw new Error(r.error);
}

function draftOf(p: Product) {
  const { tenant_id: _t, created_at: _c, ...rest } = p;
  return rest;
}

function schedule(over: Partial<PriceSchedule> = {}): PriceSchedule {
  return {
    id: 'sched-1',
    tenant_id: 't',
    product_id: product('101').id,
    name: 'Happy hour',
    weekdays: [1, 2, 3, 4, 5],
    start_time: '18:00',
    end_time: '20:00',
    price: 9.9,
    active: true,
    created_at: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

beforeEach(() => st().resetDemo());
afterEach(() => vi.useRealTimers());

// ---------------------------------------------------------------------------
describe('preço por horário', () => {
  it('janela que vira a meia-noite e sábado → domingo', () => {
    // Sábado 22:00 → 02:00 do domingo.
    const iv = scheduleIntervals({ weekdays: [6], start_time: '22:00', end_time: '02:00' });
    expect(iv).toEqual([
      [6 * 1440 + 22 * 60, 7 * 1440],
      [0, 120],
    ]);
  });

  it('recusa sobreposição no mesmo produto e aceita em produto diferente', () => {
    const a = schedule();
    const clash = { ...schedule({ id: 'sched-2', name: 'Fim de tarde', start_time: '19:30', end_time: '21:00' }) };
    expect(validatePriceSchedule(clash, [a], st().products)).toMatchObject({ ok: false });
    const other = { ...clash, product_id: product('201').id };
    expect(validatePriceSchedule(other, [a], st().products)).toEqual({ ok: true });
    const touching = { ...clash, start_time: '20:00', end_time: '22:00' };
    expect(validatePriceSchedule(touching, [a], st().products)).toEqual({ ok: true });
  });

  it('sobreposição pela virada da meia-noite também é recusada', () => {
    const night = schedule({ weekdays: [5], start_time: '23:00', end_time: '01:00' });
    const early = { ...schedule({ id: 'x', weekdays: [6], start_time: '00:30', end_time: '03:00', name: 'Madrugada' }) };
    expect(validatePriceSchedule(early, [night], st().products)).toMatchObject({ ok: false });
  });

  it('preço efetivo dentro e fora da janela', () => {
    const p = product('101');
    const rules = [schedule()];
    const monday19 = new Date(2026, 10, 9, 19, 0); // 09/11/2026 é segunda
    const monday20 = new Date(2026, 10, 9, 20, 0);
    const saturday19 = new Date(2026, 10, 14, 19, 0);
    expect(effectivePrice(p, rules, monday19)).toBe(9.9);
    expect(effectivePrice(p, rules, monday20)).toBe(p.price);
    expect(effectivePrice(p, rules, saturday19)).toBe(p.price);
    expect(activeSchedule(p.id, [{ ...rules[0]!, active: false }], monday19)).toBeNull();
  });

  it('a bandeja usa o preço do cardápio no horário, não o que a tela mandou', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 9, 19, 0));
    login(OWNER);
    const p = product('101');
    const r = st().savePriceSchedule({ product_id: p.id, name: 'Happy hour', weekdays: [1], start_time: '18:00', end_time: '20:00', price: 50, active: true });
    expect(r.ok).toBe(true);
    login(WAITER);
    const order = st().openTable(table(1).id, 2, null);
    if (!order.ok) throw new Error(order.error);
    const add = st().addToTray({
      order_id: order.data.id,
      product_id: p.id,
      half_product_ids: [],
      quantity: 1,
      unit_price: 0.01, // valor adulterado vindo da tela
      modifiers: [],
      modifiers_unit_price: 0,
      meat_doneness: p.requires_meat_doneness ? 'Ao Ponto' : null,
      quick_tags: [],
      free_notes: '',
      sector: p.sector,
    });
    expect(add.ok).toBe(true);
    expect(st().tray.at(-1)!.unit_price).toBe(50);
  });
});

// ---------------------------------------------------------------------------
describe('validações do cadastro', () => {
  it('produto: código único, preço com 2 casas e fiscal', () => {
    const p = product('101');
    const base = draftOf(p);
    expect(validateProduct(base, st().products, st().categories)).toEqual({ ok: true });
    expect(validateProduct({ ...base, id: 'novo', code: '101' }, st().products, st().categories)).toMatchObject({ ok: false });
    expect(validateProduct({ ...base, price: 10.555 }, st().products, st().categories)).toMatchObject({ ok: false });
    expect(validateProduct({ ...base, price: 0 }, st().products, st().categories)).toMatchObject({ ok: false });
    expect(validateProduct({ ...base, ncm: '1234' }, st().products, st().categories)).toMatchObject({ ok: false });
    expect(validateProduct({ ...base, cfop: '1102' }, st().products, st().categories)).toMatchObject({ ok: false });
  });

  it('equipe: PIN novo de 4 dígitos, único e não trivial; PIN antigo do seed continua valendo', () => {
    const owner = staffByPin(OWNER);
    const tiao = staffByPin(WAITER);
    const all = st().staff;
    expect(validateStaff({ id: 'n', name: 'Nova', role: 'WAITER', pin_code: '4826', active: true }, all, owner)).toEqual({ ok: true });
    expect(validateStaff({ id: 'n', name: 'Nova', role: 'WAITER', pin_code: '1234', active: true }, all, owner)).toMatchObject({ ok: false });
    expect(validateStaff({ id: 'n', name: 'Nova', role: 'WAITER', pin_code: '4444', active: true }, all, owner)).toMatchObject({ ok: false });
    expect(validateStaff({ id: 'n', name: 'Nova', role: 'WAITER', pin_code: '48261', active: true }, all, owner)).toMatchObject({ ok: false });
    expect(validateStaff({ id: 'n', name: 'Nova', role: 'WAITER', pin_code: WAITER, active: true }, all, owner)).toMatchObject({ ok: false });
    // Só renomear o Tião (PIN 1111 do seed) não esbarra na regra de PIN trivial.
    expect(validateStaff({ id: tiao.id, name: 'Tião Garçom', role: 'WAITER', pin_code: WAITER, active: true }, all, owner)).toEqual({ ok: true });
  });

  it('equipe: gerente não mexe em gerente/proprietário e a loja não fica sem proprietário', () => {
    const owner = staffByPin(OWNER);
    const manager = staffByPin(MANAGER);
    const all = st().staff;
    expect(validateStaff({ id: 'n', name: 'Outro', role: 'MANAGER', pin_code: '4826', active: true }, all, manager)).toMatchObject({ ok: false });
    expect(validateStaff({ id: owner.id, name: owner.name, role: 'OWNER', pin_code: OWNER, active: false }, all, manager)).toMatchObject({ ok: false });
    expect(validateStaff({ id: owner.id, name: owner.name, role: 'MANAGER', pin_code: OWNER, active: true }, all, owner)).toMatchObject({ ok: false });
  });

  it('valor digitado em reais', () => {
    expect(parseMoneyInput('1.234,50')).toBe(1234.5);
    expect(parseMoneyInput('49,9')).toBe(49.9);
    expect(parseMoneyInput('12.5')).toBe(12.5);
    expect(parseMoneyInput('R$ 10,00')).toBe(10);
    expect(Number.isNaN(parseMoneyInput('dez'))).toBe(true);
    expect(Number.isNaN(parseMoneyInput(''))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('permissões', () => {
  it('padrão por perfil, exceção da loja e proprietário sempre pode', () => {
    expect(can('MANAGER', 'MENU_MANAGE', [])).toBe(true);
    expect(can('WAITER', 'MENU_MANAGE', [])).toBe(false);
    expect(can('KITCHEN', 'MENU_AVAILABILITY', [])).toBe(true);
    const deny = [{ tenant_id: 't', role: 'MANAGER' as const, permission: 'MENU_MANAGE' as const, allowed: false, updated_at: '' }];
    expect(can('MANAGER', 'MENU_MANAGE', deny)).toBe(false);
    expect(can('OWNER', 'MENU_MANAGE', [{ ...deny[0]!, role: 'OWNER' }])).toBe(true);
    expect(can(null, 'MENU_MANAGE', [])).toBe(false);
  });

  it('garçom não edita cardápio; cozinha marca esgotado', () => {
    login(WAITER);
    const p = product('101');
    expect(st().saveProduct({ ...draftOf(p), price: 1 })).toMatchObject({ ok: false });
    expect(st().setProductAvailable(p.id, false)).toMatchObject({ ok: false });
    login(KITCHEN);
    const r = st().setProductAvailable(p.id, false);
    expect(r.ok).toBe(true);
    expect(product('101').available).toBe(false);
    expect(st().outbox.at(-1)).toMatchObject({ table: 'products', op: 'UPDATE', row_id: p.id });
  });

  it('só o proprietário muda permissão, com PIN e motivo, e fica auditado', () => {
    login(MANAGER);
    expect(st().setRolePermission('CASHIER', 'MENU_MANAGE', true, { managerPin: MANAGER, reason: 'Cobertura de turno' })).toMatchObject({ ok: false });
    login(OWNER);
    expect(st().setRolePermission('OWNER', 'MENU_MANAGE', false, { managerPin: OWNER, reason: 'Cobertura de turno' })).toMatchObject({ ok: false });
    expect(st().setRolePermission('CASHIER', 'MENU_MANAGE', true, { managerPin: OWNER, reason: 'oi' })).toMatchObject({ ok: false });
    const r = st().setRolePermission('CASHIER', 'MENU_MANAGE', true, { managerPin: OWNER, reason: 'Cobertura de turno' });
    expect(r.ok).toBe(true);
    expect(st().auditLogs[0]).toMatchObject({ action_type: 'PERMISSION_CHANGED', metadata: { role: 'CASHIER', allowed_before: false, allowed_after: true } });
    expect(st().outbox.slice(-2).map((e) => e.table)).toEqual(['role_permissions', 'audit_logs']);
    login(CASHIER);
    expect(selectCan(st(), 'MENU_MANAGE')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('cadastro de cardápio', () => {
  it('troca de preço é auditada e não muda item já lançado', () => {
    login(WAITER);
    const order = st().openTable(table(1).id, 2, null);
    if (!order.ok) throw new Error(order.error);
    const p = product('101');
    const added = st().addToTray({ order_id: order.data.id, product_id: p.id, half_product_ids: [], quantity: 1, unit_price: p.price, modifiers: [], modifiers_unit_price: 0, meat_doneness: p.requires_meat_doneness ? 'Ao Ponto' : null, quick_tags: [], free_notes: '', sector: p.sector });
    expect(added.ok).toBe(true);
    expect(st().dispatchTray(order.data.id).ok).toBe(true);
    const launched = st().orderItems.filter((i) => i.order_id === order.data.id);
    const totalBefore = st().orders.find((o) => o.id === order.data.id)!.total_amount;

    login(MANAGER);
    const r = st().saveProduct({ ...draftOf(p), price: 129.9 });
    expect(r.ok).toBe(true);
    expect(st().auditLogs[0]).toMatchObject({ action_type: 'PRODUCT_PRICE_CHANGED', amount_impact: 0, metadata: { price_before: p.price, price_after: 129.9 } });
    expect(st().orderItems.filter((i) => i.order_id === order.data.id)).toEqual(launched);
    expect(st().orders.find((o) => o.id === order.data.id)!.total_amount).toBe(totalBefore);
  });

  it('salvar sem trocar preço não gera auditoria', () => {
    login(MANAGER);
    const logs = st().auditLogs.length;
    expect(st().saveProduct({ ...draftOf(product('101')), name: 'Picanha na brasa' }).ok).toBe(true);
    expect(st().auditLogs.length).toBe(logs);
  });

  it('produto desativado some da venda e categoria com produto ativo não desativa', () => {
    login(MANAGER);
    const p = product('101');
    const cat = st().categories.find((c) => c.id === p.category_id)!;
    expect(st().saveCategory({ ...cat, active: false })).toMatchObject({ ok: false });
    expect(st().saveProduct({ ...draftOf(p), active: false }).ok).toBe(true);
    login(WAITER);
    const order = st().openTable(table(3).id, 2, null);
    if (!order.ok) throw new Error(order.error);
    const r = st().addToTray({ order_id: order.data.id, product_id: p.id, half_product_ids: [], quantity: 1, unit_price: p.price, modifiers: [], modifiers_unit_price: 0, meat_doneness: 'Ao Ponto', quick_tags: [], free_notes: '', sector: p.sector });
    expect(r.ok).toBe(false);
  });

  it('vínculo de adicionais gera DELETE só do que saiu', () => {
    login(MANAGER);
    const link = st().productModifierGroups[0]!;
    const others = st().productModifierGroups.filter((l) => l.product_id === link.product_id && l.group_id !== link.group_id);
    expect(st().setProductModifierGroups(link.product_id, others.map((o) => o.group_id)).ok).toBe(true);
    const del = st().outbox.filter((e) => e.op === 'DELETE');
    expect(del).toHaveLength(1);
    expect(del[0]!.payload).toMatchObject({ product_id: link.product_id, group_id: link.group_id });
  });

  it('mesa nova ganha QR e número repetido é recusado', () => {
    login(MANAGER);
    const used = table(1);
    expect(st().saveTable({ number: used.number, label: 'Dup', area: 'Salão', capacity: 4, active: true })).toMatchObject({ ok: false });
    const r = st().saveTable({ number: 99, label: 'Mesa 99', area: 'Varanda', capacity: 6, active: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.qr_code_token).toMatch(/^tchefood-[0-9a-f]{32}$/);
  });
});

// ---------------------------------------------------------------------------
describe('equipe no store', () => {
  it('trocar PIN de outra pessoa pede PIN de gerente e motivo, e o PIN não vai para o log', () => {
    login(MANAGER);
    const tiao = staffByPin(WAITER);
    const draft = { id: tiao.id, name: tiao.name, role: tiao.role, pin_code: '4826', active: true };
    expect(st().saveStaff(draft)).toMatchObject({ ok: false });
    const r = st().saveStaff(draft, { managerPin: MANAGER, reason: 'Esqueceu o PIN' });
    expect(r.ok).toBe(true);
    const log = st().auditLogs[0]!;
    expect(log.action_type).toBe('STAFF_PIN_CHANGED');
    expect(JSON.stringify(log)).not.toContain('4826');
    expect(JSON.stringify(log)).not.toContain(WAITER);
    expect(st().login('4826').ok).toBe(true);
  });

  it('trocar o próprio PIN não pede autorização', () => {
    login(MANAGER);
    const me = staffByPin(MANAGER);
    expect(st().saveStaff({ id: me.id, name: me.name, role: me.role, pin_code: '4826', active: true }).ok).toBe(true);
    expect(st().auditLogs[0]!.action_type).toBe('STAFF_PIN_CHANGED');
  });

  it('usuário técnico do QR não é editável', () => {
    login(OWNER);
    const qr = st().staff.find(isQrSelfService)!;
    expect(st().saveStaff({ id: qr.id, name: 'X', role: 'WAITER', pin_code: qr.pin_code, active: true })).toMatchObject({ ok: false });
  });
});

// ---------------------------------------------------------------------------
describe('loja nova', () => {
  const tenant = { name: 'Bar do Zé', legal_name: 'Zé Comércio de Alimentos Ltda', cnpj: '11.222.333/0001-81', state_registration: null, city: 'Pelotas', state: 'rs', default_service_fee_pct: 10 };

  it('recusa com conta aberta e com PIN que não é do proprietário', () => {
    login(OWNER);
    // O seed tem contas abertas.
    expect(st().startNewStore({ tenant, owner_name: 'Zé', owner_pin: '4826' }, { managerPin: OWNER, reason: 'Sair da demonstração' })).toMatchObject({ ok: false });
  });

  it('começa do zero com o proprietário e o usuário do QR', () => {
    const seedTerminalIds = st().terminals.map((t) => t.id);
    useTcheStore.setState({ orders: st().orders.map((o) => (o.status === 'OPEN' || o.status === 'PAYING' ? { ...o, status: 'CLOSED' as const } : o)) });
    login(OWNER);
    expect(st().startNewStore({ tenant, owner_name: 'Zé', owner_pin: '4826' }, { managerPin: MANAGER, reason: 'Sair da demonstração' })).toMatchObject({ ok: false });
    const r = st().startNewStore({ tenant, owner_name: 'Zé', owner_pin: '4826' }, { managerPin: OWNER, reason: 'Sair da demonstração' });
    expect(r.ok).toBe(true);
    expect(st().tenant).toMatchObject({ name: 'Bar do Zé', cnpj: '11222333000181', state: 'RS', focus_nfe_token: null });
    expect(st().products).toHaveLength(0);
    expect(st().staff.map((u) => u.role).sort()).toEqual(['OWNER', 'WAITER']);
    expect(st().staff.some(isQrSelfService)).toBe(true);
    expect(st().staff.every((u) => u.tenant_id === st().tenant.id)).toBe(true);
    // Maquininhas do aparelho continuam (sem elas o TEF POS Sem Fio não cobra cartão).
    expect(st().terminals.length).toBeGreaterThan(0);
    expect(st().terminals.every((t) => t.tenant_id === st().tenant.id)).toBe(true);
    // Id novo por loja: o mesmo id da demonstração colidiria entre lojas na nuvem.
    expect(st().terminals.some((t) => seedTerminalIds.includes(t.id))).toBe(false);
    const terms = st().terminals.length;
    expect(st().outbox.map((e) => e.table)).toEqual(['tenants', 'staff_users', 'staff_users', ...Array(terms).fill('pos_terminals'), 'audit_logs']);
    st().logout();
    expect(st().login('4826').ok).toBe(true);
  });

  it('com nuvem ligada, não inicia loja nova enquanto houver evento recusado', () => {
    useTcheStore.setState({ orders: st().orders.map((o) => (o.status === 'OPEN' || o.status === 'PAYING' ? { ...o, status: 'CLOSED' as const } : o)) });
    login(OWNER);
    const event: SyncEvent = { id: 'e', table: 'products', op: 'UPDATE', row_id: 'p', payload: { id: 'p' }, created_at: '' };
    useTcheStore.setState({
      outbox: [],
      syncRejected: [{ event, status: 403, message: 'x', rejected_at: '' }],
      cloud: { url: 'u', anon_key: 'k', email: 'e', access_token: 'a', refresh_token: 'r', expires_at: 0, tenant_id: st().tenant.id },
    });
    const r = st().startNewStore({ tenant, owner_name: 'Zé', owner_pin: '4826' }, { managerPin: OWNER, reason: 'Sair da demonstração' });
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toContain('recusado');
    expect(st().syncRejected).toHaveLength(1);
  });

  it('CNPJ com dígito errado é recusado', () => {
    login(OWNER);
    expect(st().updateTenant({ ...tenant, cnpj: '11222333000182' })).toMatchObject({ ok: false });
    expect(st().updateTenant({ ...tenant, default_service_fee_pct: 12.555 })).toMatchObject({ ok: false });
    expect(st().updateTenant(tenant).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('migração do armazenamento local', () => {
  it('v1 ganha active e listas novas sem perder dados', () => {
    const v1 = { products: [{ id: 'p', price: 10 }], tables: [{ id: 't' }], orders: [{ id: 'o' }] };
    const v2 = migratePersisted(v1, 1) as Record<string, unknown>;
    expect(v2.products).toEqual([{ id: 'p', price: 10, active: true }]);
    expect(v2.tables).toEqual([{ id: 't', active: true }]);
    expect(v2.orders).toEqual([{ id: 'o' }]);
    expect(v2.priceSchedules).toEqual([]);
    expect(v2.rolePermissions).toEqual([]);
    expect(v2.cloud).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('sincronização com o Supabase', () => {
  const cfg = { url: 'https://abc.supabase.co/', anonKey: 'anon', accessToken: 'jwt' };
  const ev = (over: Partial<SyncEvent>): SyncEvent => ({ id: 'e1', table: 'orders', op: 'INSERT', row_id: 'r1', payload: { id: 'r1' }, created_at: '', ...over });

  it('monta upsert, insert-only, PATCH da loja sem segredos e DELETE restrito', () => {
    const up = buildSyncRequest(ev({}), cfg);
    expect(up).toMatchObject({ method: 'POST', url: 'https://abc.supabase.co/rest/v1/orders?on_conflict=id' });
    expect(up.headers.Prefer).toContain('merge-duplicates');
    expect(up.headers.Authorization).toBe('Bearer jwt');

    const pay = buildSyncRequest(ev({ table: 'payments' }), cfg);
    expect(pay.headers.Prefer).toContain('ignore-duplicates');

    const link = buildSyncRequest(ev({ table: 'product_modifier_groups', payload: { product_id: 'p', group_id: 'g' } }), cfg);
    expect(link.url).toContain('on_conflict=product_id,group_id');

    const t = buildSyncRequest(ev({ table: 'tenants', op: 'UPDATE', row_id: 'T1', payload: { id: 'T1', name: 'X', focus_nfe_token: 's', csc_id: '1', csc_token: 's', created_at: 'x' } }), cfg);
    expect(t.method).toBe('PATCH');
    expect(t.url).toBe('https://abc.supabase.co/rest/v1/tenants?id=eq.T1');
    expect(JSON.parse(t.body!)).toEqual({ id: 'T1', name: 'X' });

    const del = buildSyncRequest(ev({ table: 'product_modifier_groups', op: 'DELETE', payload: { product_id: 'p', group_id: 'g' } }), cfg);
    expect(del).toMatchObject({ method: 'DELETE', url: 'https://abc.supabase.co/rest/v1/product_modifier_groups?product_id=eq.p&group_id=eq.g' });
    expect(() => buildSyncRequest(ev({ table: 'payments', op: 'DELETE' }), cfg)).toThrow();
    expect(sanitizePayload(ev({ table: 'orders', payload: { a: 1, nfce_status: 'AUTORIZADA', nfce_key: '4326' } }))).toEqual({ a: 1 });
  });

  it('evento recusado (4xx) não trava a fila: os próximos continuam subindo', async () => {
    const calls: string[] = [];
    const fetchFn: FetchLike = async (url) => {
      calls.push(url);
      if (url.includes('order_items')) return { ok: false, status: 409, text: async () => JSON.stringify({ message: 'violates check', details: 'x' }) };
      return { ok: true, status: 201, text: async () => '' };
    };
    const events = [ev({ id: 'a' }), ev({ id: 'b', table: 'order_items' }), ev({ id: 'c' })];
    const r = await flushOutbox(events, cfg, fetchFn);
    expect(r.sent).toEqual(['a', 'c']);
    expect(r.rejected).toEqual([{ eventId: 'b', status: 409, message: 'violates check — x' }]);
    expect(r.retryLater).toBeNull();
    expect(calls).toHaveLength(3);
  });

  it('erro de rede, 5xx e 401 ficam para depois', async () => {
    const down: FetchLike = async () => {
      throw new Error('offline');
    };
    expect(await flushOutbox([ev({})], cfg, down)).toMatchObject({ sent: [], rejected: [], retryLater: expect.stringContaining('offline') });
    const s503: FetchLike = async () => ({ ok: false, status: 503, text: async () => '' });
    expect(await flushOutbox([ev({})], cfg, s503)).toMatchObject({ rejected: [], retryLater: expect.stringContaining('503') });
    const s401: FetchLike = async () => ({ ok: false, status: 401, text: async () => '' });
    expect(await flushOutbox([ev({})], cfg, s401)).toMatchObject({ rejected: [] });
  });

  const authLog = (over: Record<string, unknown> = {}) => ({
    id: 'A1',
    tenant_id: 'T1',
    order_id: 'O1',
    performed_by_user_id: 'U1',
    authorized_by_manager_id: 'M1',
    action_type: 'DISCOUNT_APPLIED',
    amount_impact: -10,
    reason: 'Cliente fiel da casa',
    whatsapp_alert_sent: true,
    metadata: { discount_before: 0, discount_after: 10 },
    created_at: '2026-11-09T19:00:00.000Z',
    ...over,
  });

  it('autorização de gerente sobe pela RPC que confere o PIN, não direto em audit_logs', () => {
    const req = buildSyncRequest(ev({ id: 'e', table: 'audit_logs', row_id: 'A1', payload: authLog(), manager_pin: '9999' }), cfg);
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://abc.supabase.co/rest/v1/rpc/tchefood_authorize_manager');
    expect(JSON.parse(req.body!)).toEqual({
      p_order_id: 'O1',
      p_action_type: 'DISCOUNT_APPLIED',
      p_manager_pin: '9999',
      p_performed_by: 'U1',
      p_reason: 'Cliente fiel da casa',
      p_amount_impact: -10,
      p_metadata: { discount_before: 0, discount_after: 10, client_audit_id: 'A1' },
    });
    for (const action_type of ['ITEM_CANCELED', 'SERVICE_FEE_REMOVED']) {
      expect(buildSyncRequest(ev({ table: 'audit_logs', payload: authLog({ action_type }), manager_pin: '9999' }), cfg).url).toContain('/rpc/tchefood_authorize_manager');
    }
    // Log sem gerente (PIN errado, taxa reativada) continua sendo INSERT comum.
    const failed = buildSyncRequest(ev({ table: 'audit_logs', payload: authLog({ authorized_by_manager_id: null, action_type: 'MANAGER_PIN_FAILED' }) }), cfg);
    expect(failed.url).toBe('https://abc.supabase.co/rest/v1/audit_logs?on_conflict=id');
    // Fila antiga, sem o PIN guardado: não há como o servidor conferir.
    expect(() => buildSyncRequest(ev({ table: 'audit_logs', payload: authLog() }), cfg)).toThrow(/PIN/);
  });

  it('RPC que devolve null (PIN não confere no servidor) é recusa, segura a comanda e o resto segue', async () => {
    const auth = ev({ id: 'a', table: 'audit_logs', row_id: 'A1', payload: authLog(), manager_pin: '0000', created_at: '2026-11-09T19:00:00.000Z' });
    const upd = ev({ id: 'u', table: 'orders', op: 'UPDATE', row_id: 'O1', payload: { id: 'O1', discount_amount: 10 }, created_at: '2026-11-09T19:00:00.000Z' });
    const other = ev({ id: 'x', table: 'products', op: 'UPDATE', row_id: 'P1', payload: { id: 'P1' }, created_at: '2026-11-09T19:00:05.000Z' });
    const fetchFn: FetchLike = async (url) => {
      if (url.includes('/rpc/')) return { ok: true, status: 200, text: async () => 'null' };
      if (url.includes('/orders')) return { ok: false, status: 400, text: async () => JSON.stringify({ message: 'TCHEFOOD_ANTIFRAUDE: DISCOUNT_APPLIED sem PIN de gerente registrado em audit_logs.' }) };
      return { ok: true, status: 201, text: async () => '' };
    };
    const r = await flushOutbox([auth, upd, other], cfg, fetchFn);
    // A comanda nem sobe: espera a autorização recusada ser resolvida.
    expect(r.sent).toEqual(['x']);
    expect(r.rejected.map((x) => x.eventId)).toEqual(['a']);
    expect(r.rejected[0]!.message).toContain('PIN do gerente');

    const okRpc: FetchLike = async (url) =>
      url.includes('/rpc/') ? { ok: true, status: 200, text: async () => '"3f1c2b9e-1d2a-4c55-9a77-0e8f6d5b4a21"' } : { ok: true, status: 204, text: async () => '' };
    expect(await flushOutbox([auth, upd], cfg, okRpc)).toEqual({ sent: ['a', 'u'], retryLater: null, rejected: [] });
  });

  it('depois de um recusado, eventos do mesmo registro esperam e não sobrescrevem a nuvem', async () => {
    const calls: string[] = [];
    const fetchFn: FetchLike = async (url, init) => {
      calls.push(`${url} ${init.body ?? ''}`);
      if (init.body?.includes('"v":1')) return { ok: false, status: 403, text: async () => '' };
      return { ok: true, status: 204, text: async () => '' };
    };
    const p1 = ev({ id: 'p1', table: 'products', op: 'UPDATE', row_id: 'P', payload: { id: 'P', v: 1 } });
    const p2 = ev({ id: 'p2', table: 'products', op: 'UPDATE', row_id: 'P', payload: { id: 'P', v: 2 } });
    const q = ev({ id: 'q', table: 'products', op: 'UPDATE', row_id: 'Q', payload: { id: 'Q' } });
    const r = await flushOutbox([p1, p2, q], cfg, fetchFn);
    expect(r.sent).toEqual(['q']);
    expect(r.rejected.map((x) => x.eventId)).toEqual(['p1']);
    // Rodada seguinte: p1 está nos recusados, p2 continua esperando na fila.
    const next = await flushOutbox([p2], cfg, fetchFn, 50, [p1]);
    expect(next).toEqual({ sent: [], retryLater: null, rejected: [] });
    // Autorização recusada segura a atualização da comanda.
    const auth = ev({ id: 'a', table: 'audit_logs', row_id: 'A1', payload: authLog(), manager_pin: '9999' });
    const order = ev({ id: 'o', table: 'orders', op: 'UPDATE', row_id: 'O1', payload: { id: 'O1' } });
    expect((await flushOutbox([order], cfg, fetchFn, 50, [auth])).sent).toEqual([]);
    expect(calls.some((c) => c.includes('"v":2'))).toBe(false);
  });

  it('o store guarda o PIN só no evento da fila e não no audit_log', () => {
    login(WAITER);
    const opened = st().openTable(table(1).id, 2, null);
    if (!opened.ok) throw new Error(opened.error);
    const n = st().outbox.length;
    expect(st().removeServiceFee(opened.data.id, { managerPin: MANAGER, reason: 'Cliente não aceitou os 10%' }).ok).toBe(true);
    const authEvent = st().outbox.slice(n).find((e) => e.table === 'audit_logs')!;
    expect(authEvent.manager_pin).toBe(MANAGER);
    expect(JSON.stringify(authEvent.payload)).not.toContain(MANAGER);
    expect(JSON.stringify(st().auditLogs)).not.toContain(`"${MANAGER}"`);
    expect(buildSyncRequest(authEvent, cfg).url).toContain('/rpc/tchefood_authorize_manager');
  });

  it('recusados saem da fila, ficam guardados e voltam na ordem ao reenviar', () => {
    login(KITCHEN);
    st().setProductAvailable(product('101').id, false);
    st().setProductAvailable(product('201').id, false);
    st().setProductAvailable(product('101').id, true);
    const all = [...st().outbox];
    const [a, b] = all.slice(-3);
    st().rejectSyncEvents([
      { eventId: b!.id, status: 400, message: 'trava' },
      { eventId: a!.id, status: 403, message: 'permissão' },
    ]);
    expect(st().outbox.map((e) => e.id)).toEqual(all.filter((e) => e !== a && e !== b).map((e) => e.id));
    expect(st().syncRejected.map((r) => [r.event.id, r.status, r.message])).toEqual([
      [a!.id, 403, 'permissão'],
      [b!.id, 400, 'trava'],
    ]);
    st().retryRejectedSync();
    expect(st().syncRejected).toEqual([]);
    expect(st().outbox.slice(0, 2).map((e) => e.id)).toEqual([a!.id, b!.id]);
    expect(st().outbox).toHaveLength(all.length);
  });

  it('audit_log de pedido sobe antes das atualizações daquele pedido (filas antigas)', () => {
    const t0 = '2026-11-09T19:00:00.000Z';
    const items = ev({ id: 'i', table: 'order_items', op: 'UPDATE', row_id: 'item1', payload: { id: 'item1', order_id: 'O1' }, created_at: t0 });
    const order = ev({ id: 'o', table: 'orders', op: 'UPDATE', row_id: 'O1', payload: { id: 'O1' }, created_at: t0 });
    const audit = ev({ id: 'a', table: 'audit_logs', row_id: 'L1', payload: { id: 'L1', order_id: 'O1' }, created_at: '2026-11-09T19:00:00.001Z' });
    const insert = ev({ id: 'n', table: 'orders', op: 'INSERT', row_id: 'O1', payload: { id: 'O1' }, created_at: t0 });
    const other = ev({ id: 'x', table: 'orders', op: 'UPDATE', row_id: 'O2', payload: { id: 'O2' }, created_at: t0 });
    expect(serverOrder([insert, items, order, audit]).map((e) => e.id)).toEqual(['n', 'a', 'i', 'o']);
    expect(serverOrder([order, other, audit]).map((e) => e.id)).toEqual(['o', 'x', 'a']);
    // Fila nova (autorização primeiro) com dois descontos seguidos: nada muda de lugar.
    const at = (sec: number) => `2026-11-09T19:0${sec}:00.000Z`;
    const a1 = ev({ id: 'a1', table: 'audit_logs', payload: { order_id: 'O1' }, created_at: at(1) });
    const u1 = ev({ id: 'u1', table: 'orders', op: 'UPDATE', row_id: 'O1', payload: { id: 'O1' }, created_at: at(1) });
    const a2 = ev({ id: 'a2', table: 'audit_logs', payload: { order_id: 'O1' }, created_at: at(2) });
    const u2 = ev({ id: 'u2', table: 'orders', op: 'UPDATE', row_id: 'O1', payload: { id: 'O1' }, created_at: at(2) });
    expect(serverOrder([a1, u1, a2, u2]).map((e) => e.id)).toEqual(['a1', 'u1', 'a2', 'u2']);
    // Fila antiga com dois descontos: cada autorização só passa a frente da própria mudança.
    expect(serverOrder([u1, a1, u2, a2]).map((e) => e.id)).toEqual(['a1', 'u1', 'a2', 'u2']);
    const catalog = ev({ id: 'c', table: 'audit_logs', payload: { order_id: null } });
    expect(serverOrder([order, catalog]).map((e) => e.id)).toEqual(['o', 'c']);
  });

  it('o store enfileira a autorização antes do desconto e do cancelamento', () => {
    login(WAITER);
    const opened = st().openTable(table(1).id, 2, null);
    if (!opened.ok) throw new Error(opened.error);
    const id = opened.data.id;
    const p = product('105');
    expect(st().addToTray({ order_id: id, product_id: p.id, half_product_ids: [], quantity: 1, unit_price: p.price, modifiers: [], modifiers_unit_price: 0, meat_doneness: p.requires_meat_doneness ? 'Ao Ponto' : null, quick_tags: [], free_notes: '', sector: p.sector }).ok).toBe(true);
    expect(st().dispatchTray(id).ok).toBe(true);
    const item = st().orderItems.find((i) => i.order_id === id)!;
    const n = st().outbox.length;
    expect(st().removeServiceFee(id, { managerPin: MANAGER, reason: 'Cliente não aceitou os 10%' }).ok).toBe(true);
    expect(st().cancelOrderItem(item.id, { managerPin: MANAGER, reason: 'Cliente desistiu' }).ok).toBe(true);
    expect(st().outbox.slice(n).map((e) => e.table)).toEqual(['audit_logs', 'orders', 'audit_logs', 'order_items', 'orders']);
  });

  it('Cardápio QR não envia com preço diferente do que o cliente viu', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 9, 19, 0));
    login(OWNER);
    const p = product('105');
    expect(st().savePriceSchedule({ product_id: p.id, name: 'Happy hour', weekdays: [1], start_time: '18:00', end_time: '20:00', price: 20, active: true }).ok).toBe(true);
    st().logout();
    const line = { product_id: p.id, half_product_ids: [], quantity: 1, unit_price: 20, modifiers: [], modifiers_unit_price: 0, meat_doneness: p.requires_meat_doneness ? 'Ao Ponto' : null, quick_tags: [], free_notes: '', sector: p.sector };
    // O happy hour acabou entre montar o carrinho e enviar.
    vi.setSystemTime(new Date(2026, 10, 9, 20, 1));
    const r = st().qrPlaceOrder(table(4).id, [line]);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toContain(QR_PRICE_CHANGED);
    expect(st().qrPlaceOrder(table(4).id, [{ ...line, unit_price: p.price }]).ok).toBe(true);
  });

  it('lê tenant_id do JWT e exige a loja na conta', async () => {
    const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    const jwt = (claims: object) => `${b64({ alg: 'HS256' })}.${b64(claims)}.sig`;
    expect(tenantFromJwt(jwt({ tenant_id: 'T1' }))).toBe('T1');
    expect(tenantFromJwt(jwt({ app_metadata: { tenant_id: 'T2' } }))).toBe('T2');
    expect(tenantFromJwt(jwt({}))).toBeNull();
    expect(tenantFromJwt('lixo')).toBeNull();

    const ok: FetchLike = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ access_token: jwt({ tenant_id: 'T1' }), refresh_token: 'r', expires_in: 3600 }) });
    await expect(signInDevice('https://x.supabase.co', 'anon', 'a@b.c', 'p', ok)).resolves.toMatchObject({ tenant_id: 'T1', refresh_token: 'r' });
    const noTenant: FetchLike = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ access_token: jwt({}), refresh_token: 'r', expires_in: 3600 }) });
    await expect(signInDevice('https://x.supabase.co', 'anon', 'a@b.c', 'p', noTenant)).rejects.toThrow(/tenant_id/);
    const denied: FetchLike = async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ error_description: 'Invalid login credentials' }) });
    await expect(signInDevice('https://x.supabase.co', 'anon', 'a@b.c', 'p', denied)).rejects.toThrow(/Invalid login/);
  });

  it('renova o token perto de expirar e recusa conta de outra loja', () => {
    expect(needsRefresh(1000, 1000 * 1000 - 60_000)).toBe(true);
    expect(needsRefresh(1000, 1000 * 1000 - 600_000)).toBe(false);
    const session = { url: 'u', anon_key: 'k', email: 'e', access_token: 'a', refresh_token: 'r', expires_at: 0, tenant_id: 'outra' };
    expect(st().setCloudSession(session)).toMatchObject({ ok: false });
    expect(st().setCloudSession({ ...session, tenant_id: st().tenant.id }).ok).toBe(true);
  });

  it('confirmação tira da fila só o que subiu', () => {
    login(KITCHEN);
    st().setProductAvailable(product('101').id, false);
    st().setProductAvailable(product('201').id, false);
    const [first] = st().outbox.slice(-2);
    const before = st().outbox.length;
    st().ackSyncedEvents([first!.id]);
    expect(st().outbox.length).toBe(before - 1);
    expect(st().syncStatus.last_success_at).not.toBeNull();
  });
});
