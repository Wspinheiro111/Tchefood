import { beforeEach, describe, expect, it } from 'vitest';
import { migratePersisted, useTcheStore } from '../store/useTcheStore';
import { seedId } from '../data/seed';
import { buildSyncRequest } from '../lib/sync/supabaseSync';

const st = () => useTcheStore.getState();
const product = (code: string) => st().products.find((p) => p.code === code)!;
const table = (n: number) => st().tables.find((t) => t.number === n)!;

beforeEach(() => st().resetDemo());

describe('dados para o servidor refazer o preço', () => {
  it('o item leva quando foi precificado, os sabores e os adicionais escolhidos', () => {
    expect(st().login('1111').ok).toBe(true);
    const opened = st().openTable(table(1).id, 2, null);
    if (!opened.ok) throw new Error(opened.error);
    const p = product('201');
    const opt = st().modifierOptions.find((o) => o.id === seedId('mo:tamanho-chopp:500'))!;
    const tray = st().addToTray({
      order_id: opened.data.id, product_id: p.id, half_product_ids: [], quantity: 1, unit_price: p.price,
      modifiers: [{ group_id: opt.group_id, option_id: opt.id, name: opt.name, additional_price: opt.additional_price }],
      modifiers_unit_price: 0, meat_doneness: null, quick_tags: [], free_notes: '', sector: p.sector,
    });
    if (!tray.ok) throw new Error(tray.error);
    const sent = st().dispatchTray(opened.data.id);
    if (!sent.ok) throw new Error(sent.error);
    const [item] = sent.data.items;
    expect(item!.priced_at).toBe(tray.data.added_at);
    expect(item!.half_product_ids).toEqual([]);
    expect(item!.modifier_option_ids).toEqual([opt.id]);
  });

  it('a regra do meio a meio é da loja e sobe para a nuvem', () => {
    st().setHalfAndHalfPricing('AVERAGE');
    expect(st().tenant.half_and_half_pricing).toBe('AVERAGE');
    const ev = st().outbox.at(-1)!;
    expect(ev).toMatchObject({ table: 'tenants', op: 'UPDATE' });
    expect(ev.payload.half_and_half_pricing).toBe('AVERAGE');
  });

  it('pagamento sobe pela função do servidor', () => {
    const cfg = { url: 'https://abc.supabase.co', anonKey: 'anon', accessToken: 'jwt' };
    const req = buildSyncRequest({ id: 'e', table: 'payments', op: 'INSERT', row_id: 'P', payload: { id: 'P', amount: 5 }, created_at: '' }, cfg);
    expect(req.url).toBe('https://abc.supabase.co/rest/v1/rpc/tchefood_register_payment');
    expect(() => buildSyncRequest({ id: 'e', table: 'payments', op: 'UPDATE', row_id: 'P', payload: { id: 'P' }, created_at: '' }, cfg)).toThrow();
  });

  it('migração v8: a regra do aparelho vira a da loja e os itens antigos ficam sem os campos novos', () => {
    const out = migratePersisted({ tenant: { id: 't' }, halfAndHalfPricing: 'AVERAGE', orderItems: [{ id: 'i' }] }, 7) as Record<string, unknown>;
    expect(out.tenant).toEqual({ id: 't', half_and_half_pricing: 'AVERAGE' });
    expect(out.halfAndHalfPricing).toBeUndefined();
    expect(out.orderItems).toEqual([{ id: 'i', priced_at: null, half_product_ids: [], modifier_option_ids: [] }]);
  });

  it('migração v8: loja ligada à nuvem com "média" sobe a regra antes do próximo download', () => {
    const out = migratePersisted({ tenant: { id: 't' }, halfAndHalfPricing: 'AVERAGE', cloud: { tenant_id: 't' }, outbox: [] }, 7) as { outbox: Array<{ table: string; op: string; payload: Record<string, unknown> }> };
    expect(out.outbox).toHaveLength(1);
    expect(out.outbox[0]).toMatchObject({ table: 'tenants', op: 'UPDATE', payload: { half_and_half_pricing: 'AVERAGE' } });
    const highest = migratePersisted({ tenant: { id: 't' }, cloud: { tenant_id: 't' }, outbox: [] }, 7) as { outbox: unknown[] };
    expect(highest.outbox).toHaveLength(0);
  });
});
