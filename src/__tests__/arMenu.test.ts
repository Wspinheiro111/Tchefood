import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { useTcheStore } from '../store/useTcheStore';
import { AR_DEMO_PRODUCT_CODE, isLocalOnly, selectActiveArModel, useArStore } from '../store/useArStore';
import { arEngagement, scaleFactorFor, validateArModel, formatArSize, type ArModelDraft } from '../lib/ar/arModels';
import { checkModelFile } from '../lib/ar/modelFiles';
import { publicModelUrl, storagePath, uploadModelFile } from '../lib/ar/modelUpload';
import { PIZZA_DEMO_COMPONENTS, PIZZA_DEMO_DIAMETER_CM } from '../lib/ar/pizzaDemo';
import type { ArEngagementEvent } from '../types';

const st = () => useTcheStore.getState();
const ar = () => useArStore.getState();
const product = (code: string) => st().products.find((p) => p.code === code)!;

function login(pin: string) {
  const r = st().login(pin);
  if (!r.ok) throw new Error(r.error);
}

function draft(over: Partial<ArModelDraft> = {}): ArModelDraft {
  return {
    product_id: product('301').id,
    glb_url: 'https://cdn.loja.test/carreteiro.glb',
    usdz_url: null,
    scale_factor: 1,
    real_width_cm: 28,
    real_depth_cm: 28,
    real_height_cm: 7,
    explode_animation: null,
    components: [{ id: 'c1', label: ' Charque ', detail: '  ', position: '0 0.04 0', normal: '0 1 0' }],
    active: true,
    ...over,
  };
}

beforeEach(() => {
  st().resetDemo();
  useArStore.setState({ arModels: [], arEvents: [], demoSeededTenants: [] });
});

describe('cardápio AR: regras', () => {
  it('fator de escala leva o arquivo para a medida real', () => {
    expect(scaleFactorFor(3.5, 35)).toBe(10); // arquivo exportado em decímetros
    expect(scaleFactorFor(3500, 35)).toBe(0.01); // em milímetros
    expect(scaleFactorFor(35, 35)).toBe(1);
    expect(scaleFactorFor(0, 35)).toBe(1);
    expect(formatArSize({ real_width_cm: 35, real_depth_cm: 35, real_height_cm: 2.94 })).toBe('35 × 35 × 2,9 cm');
  });

  it('recusa arquivo fora de metros, link inválido e etiqueta sem posição', () => {
    const products = st().products;
    expect(validateArModel(draft(), products)).toBeNull();
    expect(validateArModel(draft({ real_width_cm: 3500 }), products)).toMatch(/medida real/);
    expect(validateArModel(draft({ glb_url: 'http://inseguro.test/a.glb' }), products)).toMatch(/https/);
    expect(validateArModel(draft({ glb_url: 'https://x.test/a.usdz' }), products)).toMatch(/\.glb/);
    expect(validateArModel(draft({ product_id: 'nao-existe' }), products)).toMatch(/Produto/);
    expect(validateArModel(draft({ components: [{ id: 'c', label: 'Ovo', detail: null, position: '', normal: '' }] }), products)).toMatch(/posicionar/);
    expect(validateArModel(draft({ components: [{ id: 'c', label: '  ', detail: null, position: '0 0 0', normal: '0 1 0' }] }), products)).toMatch(/nome/);
    const many = Array.from({ length: 13 }, (_, i) => ({ id: `c${i}`, label: `Item ${i}`, detail: null, position: '0 0 0', normal: '0 1 0' }));
    expect(validateArModel(draft({ components: many }), products)).toMatch(/No máximo 12/);
  });

  it('arquivo: só .glb no principal, só .usdz no iPhone, até 15 MB', () => {
    expect(checkModelFile({ name: 'pizza.GLB', size: 1000 }, 'glb')).toBeNull();
    expect(checkModelFile({ name: 'pizza.gltf', size: 1000 }, 'glb')).toMatch(/\.glb/);
    expect(checkModelFile({ name: 'pizza.usdz', size: 1000 }, 'usdz')).toBeNull();
    expect(checkModelFile({ name: 'pizza.glb', size: 16 * 1024 * 1024 }, 'glb')).toMatch(/15 MB/);
  });

  it('engajamento por produto: aberturas, AR, itens, pedido depois e conversão', () => {
    const ev = (product_id: string, kind: ArEngagementEvent['kind'], created_at = '2026-11-09T20:00:00.000Z'): ArEngagementEvent => ({ id: Math.random().toString(), tenant_id: 't', product_id, table_id: null, kind, created_at });
    const stats = arEngagement([
      ev('a', 'VIEW_3D'), ev('a', 'VIEW_3D'), ev('a', 'VIEW_3D'), ev('a', 'VIEW_3D'), ev('a', 'AR_START'), ev('a', 'EXPLODE'), ev('a', 'ADD_AFTER_VIEW'),
      ev('b', 'VIEW_3D'), ev('b', 'VIEW_3D', '2026-10-01T00:00:00.000Z'),
    ], '2026-11-01T00:00:00.000Z');
    expect(stats).toEqual([
      { product_id: 'a', views3d: 4, arStarts: 1, explodes: 1, addsAfterView: 1, conversionPct: 25 },
      { product_id: 'b', views3d: 1, arStarts: 0, explodes: 0, addsAfterView: 0, conversionPct: 0 },
    ]);
  });
});

describe('cardápio AR: store', () => {
  it('a demonstração ganha a Pizza Calabresa em 3D uma vez só, fora da fila da nuvem', () => {
    const outbox = st().outbox.length;
    ar().ensureDemoModel();
    const pizza = product(AR_DEMO_PRODUCT_CODE);
    const m = selectActiveArModel(ar(), pizza.id)!;
    expect(m.glb_url).toBe('ar/pizza-calabresa.glb');
    expect(m.real_width_cm).toBe(PIZZA_DEMO_DIAMETER_CM);
    expect(m.components.map((c) => c.label)).toEqual(PIZZA_DEMO_COMPONENTS.map((c) => c.label));
    expect(st().outbox.length).toBe(outbox);
    // Dono removeu: não volta sozinho.
    login('8888');
    expect(ar().removeArModel(pizza.id).ok).toBe(true);
    ar().ensureDemoModel();
    expect(ar().arModels).toEqual([]);
  });

  it('só quem gerencia o cardápio cadastra o 3D', () => {
    login('1111'); // garçom
    const r = ar().saveArModel(draft());
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/permissão/);
    login('8888');
    expect(ar().saveArModel(draft()).ok).toBe(true);
  });

  it('salva limpo, sobe para a nuvem e edita no mesmo registro', () => {
    login('8888');
    const n = st().outbox.length;
    const m = ar().saveArModel(draft());
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.data.components[0]).toMatchObject({ label: 'Charque', detail: null });
    const ins = st().outbox.slice(n);
    expect(ins.map((e) => `${e.table}/${e.op}`)).toEqual(['product_ar_models/INSERT']);
    const again = ar().saveArModel(draft({ id: m.data.id, real_width_cm: 30 }));
    expect(again.ok && again.data.id).toBe(m.data.id);
    expect(ar().arModels).toHaveLength(1);
    expect(st().outbox.at(-1)).toMatchObject({ table: 'product_ar_models', op: 'UPDATE' });
  });

  it('arquivo só no aparelho não sobe até virar link https', () => {
    login('8888');
    const n = st().outbox.length;
    const local = ar().saveArModel(draft({ glb_url: 'idb:0b0c3c3e-4c2d-4d1e-9f00-000000000001' }));
    expect(local.ok && isLocalOnly(local.data)).toBe(true);
    expect(st().outbox.length).toBe(n);
    const sent = ar().setArModelUrls(product('301').id, { glb_url: 'https://x.supabase.co/storage/v1/object/public/product-models/t/m.glb', usdz_url: null });
    expect(sent.ok && isLocalOnly(sent.data)).toBe(false);
    expect(st().outbox.slice(n).map((e) => `${e.table}/${e.op}`)).toEqual(['product_ar_models/INSERT']);
  });

  it('cada ação do cliente vira um evento na fila da nuvem', () => {
    const p = product('401').id;
    const t = st().tables.find((x) => x.number === 4)!.id;
    const n = st().outbox.length;
    ar().recordArEvent(p, 'VIEW_3D', t);
    ar().recordArEvent(p, 'AR_START', t);
    expect(ar().arEvents.map((e) => e.kind)).toEqual(['VIEW_3D', 'AR_START']);
    expect(st().outbox.slice(n).map((e) => e.table)).toEqual(['ar_engagement_events', 'ar_engagement_events']);
    expect(st().outbox.at(-1)!.payload).toMatchObject({ product_id: p, table_id: t, kind: 'AR_START', tenant_id: st().tenant.id });
  });
});

describe('cardápio AR: envio do arquivo', () => {
  it('sobe na pasta da loja e devolve o link público', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const url = await uploadModelFile(
      { url: 'https://proj.supabase.co/', anonKey: 'anon', accessToken: 'jwt' },
      storagePath('tenant-1', 'model-1', 'glb', 1731186000000),
      new Blob(['glTF']),
      'glb',
      async (u, init) => {
        calls.push({ url: u, headers: init.headers });
        return { ok: true, status: 200, text: async () => '' };
      },
    );
    expect(calls[0]!.url).toBe('https://proj.supabase.co/storage/v1/object/product-models/tenant-1/model-1-1731186000000.glb');
    expect(calls[0]!.headers).toMatchObject({ Authorization: 'Bearer jwt', 'Content-Type': 'model/gltf-binary', 'x-upsert': 'true' });
    expect(url).toBe(publicModelUrl('https://proj.supabase.co', 'tenant-1/model-1-1731186000000.glb'));
    await expect(
      uploadModelFile({ url: 'https://p', anonKey: 'a', accessToken: 'j' }, 'x/y.glb', new Blob(['x']), 'glb', async () => ({ ok: false, status: 403, text: async () => 'new row violates row-level security policy' })),
    ).rejects.toThrow(/HTTP 403/);
  });
});

describe('cardápio AR: modelo de demonstração', () => {
  it('GLB válido, 35 cm de diâmetro, com a animação que separa as camadas', () => {
    const buf = readFileSync(join(__dirname, '..', '..', 'public', 'ar', 'pizza-calabresa.glb'));
    expect(buf.readUInt32LE(0)).toBe(0x46546c67); // "glTF"
    expect(buf.readUInt32LE(4)).toBe(2);
    expect(buf.readUInt32LE(8)).toBe(buf.length);
    const jsonLen = buf.readUInt32LE(12);
    const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8')) as {
      animations: Array<{ name: string; channels: unknown[] }>;
      accessors: Array<{ min?: number[]; max?: number[] }>;
      meshes: Array<{ primitives: Array<{ attributes: { POSITION: number } }> }>;
    };
    expect(gltf.animations.map((a) => a.name)).toEqual(['explodir']);
    expect(gltf.animations[0]!.channels).toHaveLength(PIZZA_DEMO_COMPONENTS.length);
    const maxX = Math.max(...gltf.meshes.map((m) => gltf.accessors[m.primitives[0]!.attributes.POSITION]!.max![0]!));
    expect(Math.round(maxX * 200)).toBe(PIZZA_DEMO_DIAMETER_CM);
  });
});

describe('cardápio AR: fila da nuvem', () => {
  it('evento de engajamento reenviado não vira UPDATE (a métrica é imutável no banco)', async () => {
    const { buildSyncRequest } = await import('../lib/sync/supabaseSync');
    const ev = { id: 'e1', table: 'ar_engagement_events' as const, op: 'INSERT' as const, row_id: 'r1', payload: { id: 'r1', kind: 'VIEW_3D' }, created_at: '2026-11-09T21:00:00.000Z' };
    const req = buildSyncRequest(ev, { url: 'https://p.supabase.co', anonKey: 'a', accessToken: 'j' });
    expect(req.headers.Prefer).toMatch(/ignore-duplicates/);
  });
});

describe('cardápio AR: loja nova no mesmo aparelho', () => {
  it('modelo de outra loja não aparece no cardápio', () => {
    ar().ensureDemoModel();
    const pizza = product(AR_DEMO_PRODUCT_CODE).id;
    expect(selectActiveArModel(ar(), pizza)).toBeDefined();
    expect(selectActiveArModel(ar(), pizza, 'outra-loja')).toBeUndefined();
  });

  it('loja real com um prato de código 401 não ganha a pizza de demonstração', () => {
    const real = 'loja-real';
    const prato = { ...product(AR_DEMO_PRODUCT_CODE), id: 'prato-real', tenant_id: real, name: 'Xis Salada' };
    useTcheStore.setState((s) => ({ tenant: { ...s.tenant, id: real }, products: [...s.products, prato] }));
    ar().ensureDemoModel();
    expect(ar().arModels).toEqual([]);
    expect(ar().demoSeededTenants).not.toContain(real);
  });
});
