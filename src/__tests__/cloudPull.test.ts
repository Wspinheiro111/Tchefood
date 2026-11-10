import { beforeEach, describe, expect, it } from 'vitest';
import { adaptTable, MERGE, mergeRows, mergeStaffWithoutPins, pendingRowKeys, type CloudSnapshot } from '../lib/sync/cloudPull';
import { useTcheStore, type CloudSession } from '../store/useTcheStore';
import type { DiningTable, ModifierOption, Product, PurchaseInvoice, StaffUser } from '../types';

const st = () => useTcheStore.getState();
const T = '22222222-2222-4222-8222-222222222222';

function snapshotOfDemo(tenantId = st().tenant.id): CloudSnapshot {
  const s = st();
  const { focus_nfe_token: _f, csc_id: _i, csc_token: _c, ...tenant } = s.tenant;
  return {
    tenant: { ...tenant, id: tenantId },
    staff: s.staff.map(({ pin_code: _p, ...u }) => u),
    terminals: s.terminals,
    categories: s.categories,
    products: s.products,
    modifierGroups: s.modifierGroups,
    modifierOptions: s.modifierOptions,
    productModifierGroups: s.productModifierGroups,
    priceSchedules: s.priceSchedules,
    tables: s.tables,
    rolePermissions: s.rolePermissions,
    suppliers: s.suppliers,
    supplierProductLinks: s.supplierProductLinks,
    purchaseInvoices: s.purchaseInvoices,
    deliveryZones: s.deliveryZones,
    couriers: s.couriers,
  };
}

const session = (tenantId: string): CloudSession => ({
  url: 'https://x.supabase.co', anon_key: 'anon', email: 'a@b', access_token: 'jwt', refresh_token: 'r', expires_at: 9e9, tenant_id: tenantId,
});

beforeEach(() => st().resetDemo());

describe('mesclar o que veio da nuvem', () => {
  const p = (id: string, price: number) => ({ id, price }) as unknown as Product;

  it('a nuvem vale, menos no registro que ainda não subiu daqui', () => {
    const local = [p('a', 1), p('b', 2)];
    const cloud = [p('a', 10), p('b', 20), p('c', 30)];
    const out = mergeRows(local, cloud, pendingRowKeys([{ table: 'products', row_id: 'b' }]), MERGE.products);
    expect(out.map((x) => [x.id, x.price])).toEqual([['a', 10], ['b', 2], ['c', 30]]);
  });

  it('produto que não está na nuvem continua (as contas daqui apontam para ele)', () => {
    expect(mergeRows([p('a', 1)], [], new Set(), MERGE.products)).toHaveLength(1);
  });

  it('opção apagada na nuvem sai daqui; apagada aqui (DELETE na fila) não volta', () => {
    const o = (id: string) => ({ id }) as ModifierOption;
    expect(mergeRows([o('x')], [], new Set(), MERGE.modifierOptions)).toEqual([]);
    expect(mergeRows([], [o('y')], pendingRowKeys([{ table: 'modifier_options', row_id: 'y' }]), MERGE.modifierOptions)).toEqual([]);
  });

  it('mesa vem só com o cadastro: a ocupação é deste aparelho', () => {
    const cloud = { id: 'm', label: 'Mesa 9', status: 'OCCUPIED', current_order_id: 'o-de-outro' } as unknown as DiningTable;
    expect(adaptTable(cloud, undefined)).toMatchObject({ label: 'Mesa 9', status: 'FREE', current_order_id: null });
    const local = { ...cloud, label: 'Mesa 1', status: 'PAYING', current_order_id: 'o-daqui' } as DiningTable;
    expect(adaptTable(cloud, local)).toMatchObject({ label: 'Mesa 9', status: 'PAYING', current_order_id: 'o-daqui' });
  });

  it('mesa ocupada aqui continua ativa mesmo desativada em outro aparelho', () => {
    const cloud = { id: 'm', label: 'Mesa 9', status: 'FREE', current_order_id: null, active: false } as unknown as DiningTable;
    const busy = { ...cloud, status: 'OCCUPIED', current_order_id: 'o1', active: true } as DiningTable;
    expect(adaptTable(cloud, busy)).toMatchObject({ status: 'OCCUPIED', active: true });
    expect(adaptTable(cloud, { ...busy, status: 'FREE', current_order_id: null })).toMatchObject({ active: false });
  });

  it('equipe sem PIN: atualiza quem já está aqui e conta quem é novo', () => {
    const u = (id: string, over: Partial<StaffUser> = {}) => ({ id, tenant_id: T, name: id, role: 'WAITER', pin_code: '1234', active: true, created_at: '', ...over }) as StaffUser;
    const cloud = [u('a', { active: false }), u('n')].map(({ pin_code: _p, ...x }) => x);
    const r = mergeStaffWithoutPins([u('a')], cloud, new Set());
    expect(r.staff).toEqual([u('a', { active: false })]);
    expect(r.unknown).toBe(1);
  });
});

describe('baixar a loja da nuvem', () => {
  it('troca os dados do aparelho pelos da loja e entra com quem confirmou', () => {
    expect(st().login('8888').ok).toBe(true);
    const snap = snapshotOfDemo(T);
    const staff = st().staff.map((u) => ({ ...u, tenant_id: T }));
    const manager = staff.find((u) => u.role === 'MANAGER')!;
    const r = st().joinCloudStore({ session: session(T), snapshot: snap, staff, userId: manager.id });
    if (!r.ok) throw new Error(r.error);
    expect(st().tenant.id).toBe(T);
    expect(st().currentUserId).toBe(manager.id);
    expect(st().orders).toEqual([]);
    expect(st().cloud?.tenant_id).toBe(T);
    expect(st().tables.every((t) => t.status === 'FREE' && t.current_order_id === null)).toBe(true);
  });

  it('baixar a loja traz as notas de compra já importadas (a mesma NF-e não soma o estoque de novo)', () => {
    expect(st().login('8888').ok).toBe(true);
    const snap = snapshotOfDemo(T);
    const staff = st().staff.map((u) => ({ ...u, tenant_id: T }));
    const manager = staff.find((u) => u.role === 'MANAGER')!;
    const invoice = { id: 'inv-1', tenant_id: T, access_key: '3'.repeat(44) } as unknown as PurchaseInvoice;
    const r = st().joinCloudStore({ session: session(T), snapshot: { ...snap, purchaseInvoices: [invoice] }, staff, userId: manager.id });
    if (!r.ok) throw new Error(r.error);
    expect(st().purchaseInvoices.map((i) => i.access_key)).toEqual(['3'.repeat(44)]);
  });

  it('recusa: quem não é proprietário aqui, loja de outra conta, ou quem confirma não é gerente', () => {
    const snap = snapshotOfDemo(T);
    const staff = st().staff.map((u) => ({ ...u, tenant_id: T }));
    const waiter = staff.find((u) => u.role === 'WAITER')!;
    const manager = staff.find((u) => u.role === 'MANAGER')!;
    expect(st().login('1111').ok).toBe(true);
    expect(st().joinCloudStore({ session: session(T), snapshot: snap, staff, userId: manager.id })).toMatchObject({ ok: false });
    expect(st().login('8888').ok).toBe(true);
    expect(st().joinCloudStore({ session: session('outra'), snapshot: snap, staff, userId: manager.id })).toMatchObject({ ok: false });
    expect(st().joinCloudStore({ session: session(T), snapshot: snap, staff, userId: waiter.id })).toMatchObject({ ok: false });
  });

  it('leitura periódica só vale para a loja deste aparelho', () => {
    expect(st().applyCloudSnapshot(snapshotOfDemo())).toMatchObject({ ok: false }); // sem nuvem
    useTcheStore.setState({ cloud: session(st().tenant.id) });
    expect(st().applyCloudSnapshot(snapshotOfDemo(T))).toMatchObject({ ok: false });
    expect(st().applyCloudSnapshot(snapshotOfDemo())).toMatchObject({ ok: true, data: { unknownStaff: 0 } });
  });
});
