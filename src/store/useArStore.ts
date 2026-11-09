/**
 * Cardápio em realidade aumentada: modelos 3D por produto e engajamento do cliente.
 *
 * Store separado do useTcheStore (que já é grande e tem as regras financeiras): aqui não
 * há dinheiro. Quem pode cadastrar e a fila da nuvem continuam vindo do store principal:
 * salvar exige MENU_MANAGE e cada mudança entra no mesmo outbox, na mesma ordem.
 */
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { idbStorage } from '../lib/idbStorage';
import { nowISO, uuid } from '../lib/ids';
import { AR_EVENTS_KEEP, normalizeComponents, validateArModel, type ArModelDraft } from '../lib/ar/arModels';
import { PIZZA_DEMO_COMPONENTS, PIZZA_DEMO_DIAMETER_CM, PIZZA_DEMO_EXPLODE_ANIMATION, PIZZA_DEMO_GLB } from '../lib/ar/pizzaDemo';
import { deleteModelFile } from '../lib/ar/modelFiles';
import { selectCan, useTcheStore } from './useTcheStore';
import type { ActionResult, ArEngagementEvent, ArEngagementKind, ProductArModel, SyncEvent, UUID } from '../types';

/** Produto do seed que ganha o modelo de demonstração (Pizza Calabresa). */
export const AR_DEMO_PRODUCT_CODE = '401';

interface ArState {
  arModels: ProductArModel[];
  arEvents: ArEngagementEvent[];
  /** Lojas (tenant_id) que já receberam o modelo de demonstração; não volta se o dono apagar. */
  demoSeededTenants: UUID[];
  ensureDemoModel: () => void;
  saveArModel: (draft: ArModelDraft) => ActionResult<ProductArModel>;
  removeArModel: (productId: UUID) => ActionResult;
  /** Troca o arquivo idb:… pelo link da nuvem depois do envio (ver modelUpload.ts). */
  setArModelUrls: (productId: UUID, urls: { glb_url: string; usdz_url: string | null }) => ActionResult<ProductArModel>;
  recordArEvent: (productId: UUID, kind: ArEngagementKind, tableId: UUID | null) => void;
}

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

/** Arquivo ainda só no aparelho: o cadastro não sobe, porque o celular do cliente não abriria. */
export function isLocalOnly(m: Pick<ProductArModel, 'glb_url' | 'usdz_url'>): boolean {
  return m.glb_url.startsWith('idb:') || Boolean(m.usdz_url?.startsWith('idb:'));
}

function enqueue(table: SyncEvent['table'], op: SyncEvent['op'], row: { id: UUID }): void {
  const event: SyncEvent = { id: uuid(), table, op, row_id: row.id, payload: { ...row } as Record<string, unknown>, created_at: nowISO() };
  useTcheStore.setState((s) => ({ outbox: [...s.outbox, event] }));
}

function canManage(): ActionResult {
  return selectCan(useTcheStore.getState(), 'MENU_MANAGE') ? { ok: true, data: undefined } : fail('Sem permissão para alterar o cardápio.');
}

export const useArStore = create<ArState>()(
  persist(
    (set, get) => ({
      arModels: [],
      arEvents: [],
      demoSeededTenants: [],

      ensureDemoModel: () => {
        const main = useTcheStore.getState();
        const tenantId = main.tenant.id;
        if (get().demoSeededTenants.includes(tenantId)) return;
        const product = main.products.find((p) => p.code === AR_DEMO_PRODUCT_CODE && p.tenant_id === tenantId);
        if (!product) return;
        const now = nowISO();
        const demo: ProductArModel = {
          id: uuid(),
          tenant_id: tenantId,
          product_id: product.id,
          glb_url: PIZZA_DEMO_GLB,
          usdz_url: null,
          scale_factor: 1,
          real_width_cm: PIZZA_DEMO_DIAMETER_CM,
          real_depth_cm: PIZZA_DEMO_DIAMETER_CM,
          real_height_cm: 2.9,
          explode_animation: PIZZA_DEMO_EXPLODE_ANIMATION,
          components: PIZZA_DEMO_COMPONENTS.map((c) => ({ id: uuid(), label: c.label, detail: c.detail, position: c.position.join(' '), normal: '0 1 0' })),
          active: true,
          created_at: now,
          updated_at: now,
        };
        // Demonstração local, como o resto do seed: não entra na fila da nuvem.
        set((s) => ({
          arModels: s.arModels.some((m) => m.product_id === product.id) ? s.arModels : [...s.arModels, demo],
          demoSeededTenants: [...s.demoSeededTenants, tenantId],
        }));
      },

      saveArModel: (draft) => {
        const perm = canManage();
        if (!perm.ok) return perm;
        const main = useTcheStore.getState();
        const error = validateArModel(draft, main.products);
        if (error) return fail(error);
        const existing = get().arModels.find((m) => m.product_id === draft.product_id);
        if (draft.id && existing && existing.id !== draft.id) return fail('Este produto já tem outro modelo 3D.');
        const now = nowISO();
        const row: ProductArModel = {
          id: existing?.id ?? uuid(),
          tenant_id: main.tenant.id,
          product_id: draft.product_id,
          glb_url: draft.glb_url,
          usdz_url: draft.usdz_url,
          scale_factor: draft.scale_factor,
          real_width_cm: Math.round(draft.real_width_cm * 10) / 10,
          real_depth_cm: Math.round(draft.real_depth_cm * 10) / 10,
          real_height_cm: Math.round(draft.real_height_cm * 10) / 10,
          explode_animation: draft.explode_animation || null,
          components: normalizeComponents(draft.components),
          active: draft.active,
          created_at: existing?.created_at ?? now,
          updated_at: now,
        };
        // Arquivo trocado: o antigo guardado no aparelho sai.
        if (existing && existing.glb_url !== row.glb_url) void deleteModelFile(existing.glb_url);
        if (existing && existing.usdz_url !== row.usdz_url) void deleteModelFile(existing.usdz_url);
        set((s) => ({ arModels: existing ? s.arModels.map((m) => (m.id === row.id ? row : m)) : [...s.arModels, row] }));
        if (!isLocalOnly(row)) enqueue('product_ar_models', existing && !isLocalOnly(existing) ? 'UPDATE' : 'INSERT', row);
        return { ok: true, data: row };
      },

      setArModelUrls: (productId, urls) => {
        const current = get().arModels.find((m) => m.product_id === productId);
        if (!current) return fail('Modelo 3D não encontrado.');
        const { id: _id, tenant_id: _t, created_at: _c, updated_at: _u, ...rest } = current;
        return get().saveArModel({ ...rest, id: current.id, ...urls });
      },

      removeArModel: (productId) => {
        const perm = canManage();
        if (!perm.ok) return perm;
        const current = get().arModels.find((m) => m.product_id === productId);
        if (!current) return fail('Modelo 3D não encontrado.');
        void deleteModelFile(current.glb_url);
        void deleteModelFile(current.usdz_url);
        set((s) => ({ arModels: s.arModels.filter((m) => m.id !== current.id) }));
        // Sem valor financeiro: pode apagar. O histórico de visualizações fica.
        if (!isLocalOnly(current) && !current.glb_url.startsWith('ar/')) enqueue('product_ar_models', 'DELETE', current);
        return { ok: true, data: undefined };
      },

      recordArEvent: (productId, kind, tableId) => {
        const tenantId = useTcheStore.getState().tenant.id;
        const ev: ArEngagementEvent = { id: uuid(), tenant_id: tenantId, product_id: productId, table_id: tableId, kind, created_at: nowISO() };
        set((s) => ({ arEvents: [...s.arEvents, ev].slice(-AR_EVENTS_KEEP) }));
        enqueue('ar_engagement_events', 'INSERT', ev);
      },
    }),
    {
      name: 'tchefood-ar',
      version: 1,
      storage: createJSONStorage(() => idbStorage),
      partialize: (s) => ({ arModels: s.arModels, arEvents: s.arEvents, demoSeededTenants: s.demoSeededTenants }),
    },
  ),
);

/** Modelo ativo do produto, para o cardápio do cliente. */
export function selectActiveArModel(s: Pick<ArState, 'arModels'>, productId: UUID): ProductArModel | undefined {
  return s.arModels.find((m) => m.product_id === productId && m.active);
}
