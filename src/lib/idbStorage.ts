/**
 * Adaptador de armazenamento IndexedDB para o middleware persist do Zustand.
 * Mantém a comanda viva no aparelho mesmo sem Wi-Fi (Offline-First).
 * Cai para localStorage em ambientes sem IndexedDB (ex.: testes, WebView antiga).
 */
import type { StateStorage } from 'zustand/middleware';

const DB_NAME = 'tchefood';
const STORE = 'kv';

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

let dbPromise: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  if (!dbPromise) dbPromise = openDb();
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const t = d.transaction(STORE, mode);
        const req = run(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

const hasIndexedDB = typeof indexedDB !== 'undefined';

const memory = new Map<string, string>();
const fallback: StateStorage = {
  getItem: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return memory.get(k) ?? null;
    }
  },
  setItem: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      memory.set(k, v);
    }
  },
  removeItem: (k) => {
    try {
      localStorage.removeItem(k);
    } catch {
      memory.delete(k);
    }
  },
};

export const idbStorage: StateStorage = hasIndexedDB
  ? {
      getItem: async (k) => {
        try {
          const v = await tx<string | undefined>('readonly', (s) => s.get(k) as IDBRequest<string | undefined>);
          return v ?? null;
        } catch {
          return fallback.getItem(k) as string | null;
        }
      },
      setItem: async (k, v) => {
        try {
          await tx('readwrite', (s) => s.put(v, k));
        } catch {
          fallback.setItem(k, v);
        }
      },
      removeItem: async (k) => {
        try {
          await tx('readwrite', (s) => s.delete(k));
        } catch {
          fallback.removeItem(k);
        }
      },
    }
  : fallback;
