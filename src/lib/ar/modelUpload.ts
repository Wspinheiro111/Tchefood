/**
 * Envio do arquivo 3D para o Supabase Storage (bucket público product-models, ver
 * db/schema_ar.sql). O caminho começa pelo tenant_id: a política do bucket só deixa
 * o aparelho gravar na pasta da própria loja.
 */
export const AR_BUCKET = 'product-models';

export interface UploadTarget {
  url: string;
  anonKey: string;
  accessToken: string;
}

export type BlobFetch = (url: string, init: { method: string; headers: Record<string, string>; body: Blob }) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

/**
 * Caminho no bucket. A revisão entra no nome: trocar o arquivo gera um link novo, para o
 * celular do cliente não reaproveitar o 3D antigo do cache (do navegador ou do model-viewer).
 */
export function storagePath(tenantId: string, modelId: string, ext: 'glb' | 'usdz', revision: number): string {
  return `${tenantId}/${modelId}-${revision}.${ext}`;
}

export function publicModelUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/storage/v1/object/public/${AR_BUCKET}/${path}`;
}

/** Sobe o arquivo (substitui o anterior do mesmo modelo) e devolve o link público. */
export async function uploadModelFile(target: UploadTarget, path: string, file: Blob, ext: 'glb' | 'usdz', fetchFn: BlobFetch): Promise<string> {
  const res = await fetchFn(`${target.url.replace(/\/+$/, '')}/storage/v1/object/${AR_BUCKET}/${path}`, {
    method: 'POST',
    headers: {
      apikey: target.anonKey,
      Authorization: `Bearer ${target.accessToken}`,
      'Content-Type': ext === 'glb' ? 'model/gltf-binary' : 'model/vnd.usdz+zip',
      'x-upsert': 'true',
      'cache-control': '3600',
    },
    body: file,
  });
  if (!res.ok) {
    const msg = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`Nuvem recusou o arquivo 3D (HTTP ${res.status})${msg ? `: ${msg}` : ''}`);
  }
  return publicModelUrl(target.url, path);
}
