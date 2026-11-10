/**
 * Arquivos 3D enviados na Retaguarda (GLB/USDZ), guardados no IndexedDB do aparelho.
 *
 * Ficam fora do estado persistido do Zustand de propósito: um modelo tem alguns MB e o
 * estado é regravado inteiro a cada mudança. O cadastro guarda só "idb:<id>".
 * Na nuvem, o arquivo vai para o bucket público product-models (db/schema_ar.sql) e o
 * cadastro passa a ter o link https; o cardápio do cliente sempre carrega por link.
 */
import { uuid } from '../ids';
import { AR_MAX_FILE_MB } from './arModels';

const DB_NAME = 'tchefood-ar-files';
const STORE = 'files';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const req = fn(d.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

/** Confere tipo e tamanho do arquivo escolhido. Devolve a mensagem de erro ou null. */
export function checkModelFile(file: { name: string; size: number }, kind: 'glb' | 'usdz'): string | null {
  const ext = file.name.toLowerCase().split('.').pop();
  if (kind === 'glb' && ext !== 'glb') return 'O modelo principal precisa ser um arquivo .glb (glTF binário).';
  if (kind === 'usdz' && ext !== 'usdz') return 'O arquivo do iPhone precisa ser .usdz.';
  if (file.size > AR_MAX_FILE_MB * 1024 * 1024) return `Arquivo com ${(file.size / 1024 / 1024).toFixed(1)} MB. O limite é ${AR_MAX_FILE_MB} MB: reduza as texturas (ex.: gltf.report) para abrir rápido no 4G.`;
  if (file.size === 0) return 'Arquivo vazio.';
  return null;
}

/** Guarda o arquivo e devolve a referência "idb:<id>" para o cadastro. */
export async function storeModelFile(file: Blob): Promise<string> {
  const id = uuid();
  await run('readwrite', (s) => s.put(file, id));
  return `idb:${id}`;
}

const objectUrls = new Map<string, string>();

/** Base do app no build (BASE_URL do Vite: "/" ou "./" na demonstração). */
function appBase(): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  return env.BASE_URL ?? '/';
}

/**
 * Link que o <model-viewer> consegue abrir: https e ar/… passam direto (ar/… relativo
 * à base do app); idb:… vira um blob: URL do arquivo guardado no aparelho.
 */
export async function resolveModelUrl(ref: string): Promise<string | null> {
  if (!ref.startsWith('idb:')) return ref.startsWith('ar/') ? `${appBase()}${ref}` : ref;
  const cached = objectUrls.get(ref);
  if (cached) return cached;
  try {
    const blob = await run<Blob | undefined>('readonly', (s) => s.get(ref.slice(4)) as IDBRequest<Blob | undefined>);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    objectUrls.set(ref, url);
    return url;
  } catch {
    return null;
  }
}

export async function deleteModelFile(ref: string | null): Promise<void> {
  if (!ref?.startsWith('idb:')) return;
  const url = objectUrls.get(ref);
  if (url) URL.revokeObjectURL(url);
  objectUrls.delete(ref);
  try {
    await run('readwrite', (s) => s.delete(ref.slice(4)));
  } catch {
    // Arquivo já não existe: nada a fazer.
  }
}

/** Arquivo guardado no aparelho (para enviar à nuvem depois). */
export async function readModelFile(ref: string): Promise<Blob | null> {
  if (!ref.startsWith('idb:')) return null;
  try {
    return (await run<Blob | undefined>('readonly', (s) => s.get(ref.slice(4)) as IDBRequest<Blob | undefined>)) ?? null;
  } catch {
    return null;
  }
}
