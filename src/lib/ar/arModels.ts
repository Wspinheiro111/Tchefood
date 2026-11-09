/**
 * Cardápio em realidade aumentada: regras puras (sem tela), usadas pelo store e testadas.
 */
import type { ArComponent, ArEngagementEvent, ArEngagementKind, Product, ProductArModel } from '../../types';

/** Arquivos aceitos no envio. GLB é o formato do Android/computador; USDZ é o do iPhone. */
export const AR_MAX_FILE_MB = 15;
export const AR_MAX_COMPONENTS = 12;
export const AR_LABEL_MAX = 40;
export const AR_DETAIL_MAX = 80;
/** Limites de medida de um prato/bebida de verdade (cm). Fora disso o arquivo não está em metros. */
export const AR_MIN_CM = 1;
export const AR_MAX_CM = 150;

export type ArModelDraft = Omit<ProductArModel, 'id' | 'tenant_id' | 'created_at' | 'updated_at'> & { id?: string };

const URL_RE = /^(https:\/\/\S+|idb:[0-9a-f-]{36}|ar\/[a-z0-9-]+\.(glb|usdz))$/i;

function isVec3(v: string): boolean {
  const parts = v.trim().split(/\s+/);
  return parts.length === 3 && parts.every((p) => Number.isFinite(Number(p)));
}

/** Confere o cadastro do modelo antes de salvar. Devolve a mensagem para a tela ou null. */
export function validateArModel(d: ArModelDraft, products: ReadonlyArray<Product>): string | null {
  if (!products.some((p) => p.id === d.product_id)) return 'Produto não encontrado.';
  if (!URL_RE.test(d.glb_url)) return 'Envie o arquivo .glb do modelo ou informe um link https.';
  if (/\.usdz(\?|$)/i.test(d.glb_url)) return 'O arquivo principal precisa ser .glb. O .usdz vai no campo do iPhone.';
  if (d.usdz_url !== null && !URL_RE.test(d.usdz_url)) return 'Link do USDZ inválido (use https).';
  if (!(d.scale_factor > 0) || d.scale_factor > 1000) return 'Fator de escala inválido.';
  for (const [name, v] of [['largura', d.real_width_cm], ['profundidade', d.real_depth_cm]] as const) {
    if (!(v >= AR_MIN_CM && v <= AR_MAX_CM)) {
      return `A ${name} real ficou em ${formatCm(v)} cm. Um prato tem entre ${AR_MIN_CM} e ${AR_MAX_CM} cm: informe a medida real para corrigir a escala.`;
    }
  }
  if (!(d.real_height_cm >= 0 && d.real_height_cm <= AR_MAX_CM)) return 'Altura real inválida.';
  if (d.components.length > AR_MAX_COMPONENTS) return `No máximo ${AR_MAX_COMPONENTS} itens com etiqueta.`;
  for (const c of d.components) {
    const label = c.label.trim();
    if (!label) return 'Todo item precisa de um nome.';
    if (label.length > AR_LABEL_MAX) return `Nome do item "${label.slice(0, 20)}…" passa de ${AR_LABEL_MAX} letras.`;
    if (c.detail && c.detail.length > AR_DETAIL_MAX) return `Detalhe de "${label}" passa de ${AR_DETAIL_MAX} letras.`;
    if (!isVec3(c.position) || !isVec3(c.normal)) return `Toque no modelo para posicionar a etiqueta de "${label}".`;
  }
  return null;
}

/**
 * Fator para o modelo ficar no tamanho real: o dono informa a maior medida do prato
 * (ex.: 35 cm de diâmetro) e o arquivo mediu `measuredCm` nessa mesma direção.
 */
export function scaleFactorFor(measuredCm: number, realCm: number): number {
  if (!(measuredCm > 0) || !(realCm > 0)) return 1;
  return Number((realCm / measuredCm).toFixed(4));
}

export function formatCm(v: number): string {
  return (Math.round(v * 10) / 10).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
}

/** "35 × 35 × 2,9 cm" */
export function formatArSize(m: Pick<ProductArModel, 'real_width_cm' | 'real_depth_cm' | 'real_height_cm'>): string {
  return `${formatCm(m.real_width_cm)} × ${formatCm(m.real_depth_cm)} × ${formatCm(m.real_height_cm)} cm`;
}

/** Limpa os textos e devolve os itens na ordem de exibição. */
export function normalizeComponents(list: ReadonlyArray<ArComponent>): ArComponent[] {
  return list.map((c) => ({ ...c, label: c.label.trim(), detail: c.detail?.trim() || null, position: c.position.trim(), normal: c.normal.trim() }));
}

export interface ArProductStats {
  product_id: string;
  views3d: number;
  arStarts: number;
  explodes: number;
  addsAfterView: number;
  /** Pedidos depois de ver o 3D ÷ aberturas do 3D, em % inteiro. null sem aberturas. */
  conversionPct: number | null;
}

const EMPTY: Record<ArEngagementKind, number> = { VIEW_3D: 0, AR_START: 0, EXPLODE: 0, ADD_AFTER_VIEW: 0 };

/** Engajamento por produto, do mais visto para o menos visto. `sinceISO` filtra o período. */
export function arEngagement(events: ReadonlyArray<ArEngagementEvent>, sinceISO?: string): ArProductStats[] {
  const by = new Map<string, Record<ArEngagementKind, number>>();
  for (const e of events) {
    if (sinceISO && e.created_at < sinceISO) continue;
    const row = by.get(e.product_id) ?? { ...EMPTY };
    row[e.kind] += 1;
    by.set(e.product_id, row);
  }
  return [...by.entries()]
    .map(([product_id, r]) => ({
      product_id,
      views3d: r.VIEW_3D,
      arStarts: r.AR_START,
      explodes: r.EXPLODE,
      addsAfterView: r.ADD_AFTER_VIEW,
      conversionPct: r.VIEW_3D > 0 ? Math.round((Math.min(r.ADD_AFTER_VIEW, r.VIEW_3D) / r.VIEW_3D) * 100) : null,
    }))
    .sort((a, b) => b.views3d - a.views3d || b.arStarts - a.arStarts);
}

/** Quantos eventos guardar no aparelho (os mais antigos saem; a nuvem guarda todos). */
export const AR_EVENTS_KEEP = 5000;
