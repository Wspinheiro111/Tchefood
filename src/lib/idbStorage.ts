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

/**
 * Resolve só quando a transação termina (oncomplete): o pedido pode dar certo e a transação abortar depois,
 * e aí nada foi gravado (GPT, rodada 18 do PR #54). Aborto e erro rejeitam.
 */
function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const t = d.transaction(STORE, mode);
        let result: T;
        let done = false;
        const fail = (e: unknown) => {
          if (done) return;
          done = true;
          reject(e ?? new Error('IndexedDB: transação abortada'));
        };
        t.oncomplete = () => {
          if (done) return;
          done = true;
          resolve(result);
        };
        t.onabort = () => fail(t.error);
        t.onerror = () => fail(t.error);
        const req = run(t.objectStore(STORE));
        const prev = req.onsuccess;
        req.onsuccess = (ev) => {
          prev?.call(req, ev);
          result = req.result;
        };
        req.onerror = () => fail(req.error);
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
      memory.delete(k);
    } catch {
      memory.set(k, v);
    }
  },
  removeItem: (k) => {
    memory.delete(k);
    try {
      localStorage.removeItem(k);
    } catch {
      // nada a apagar fora da memória
    }
  },
};

/**
 * A última gravação desta chave ficou só na memória (IndexedDB e localStorage recusaram, por exemplo sem espaço):
 * some ao fechar o app. O adaptador não lança nesse caso (o persist do Zustand grava sem esperar); quem precisa
 * saber antes de uma chamada à nuvem que não pode se perder (acerto com o entregador) confere aqui (Codex no PR #54).
 */
export function storedOnlyInMemory(k: string): boolean {
  return memory.has(k);
}

/**
 * Cópia no localStorage de uma gravação que o IndexedDB recusou, com o número da gravação ({ seq, v }).
 * A leitura fica com a mais nova entre o IndexedDB e esta cópia: reabrindo o app com o IndexedDB bom de novo,
 * o estado gravado na cópia não perde para a versão velha que ficou no IndexedDB (GPT, rodada 18 do PR #54).
 */
const FALLBACK_SUFFIX = '::copia';
interface Stamped {
  seq: number;
  v: string;
}
let lastSeq = 0;
const nextSeq = () => (lastSeq = Math.max(lastSeq + 1, Date.now()));
const seen = (seq: number) => {
  if (seq > lastSeq) lastSeq = seq;
};
const memorySeq = new Map<string, number>();

/**
 * No IndexedDB o valor continua sendo o texto puro da chave `k`, como nas versões anteriores (voltar o app
 * para uma versão anterior lê o mesmo registro; GPT, rodada 19 do PR #54). O número da gravação fica numa
 * chave ao lado (`k::seq`), gravada na mesma transação, no formato `<número>:<impressão do texto>`.
 * Se o texto de `k` não bate com a impressão, ele foi gravado por uma versão anterior do app (que não mexe
 * em `k::seq`) depois da última gravação desta versão: é o mais novo e vale mais que qualquer cópia
 * (GPT, rodada 20 do PR #54). Sem `k::seq`, vale 0.
 */
const SEQ_SUFFIX = '::seq';
interface Candidate extends Stamped {
  /** Texto gravado por versão que não conhece `k::seq`: vale mais que qualquer número. */
  foreign?: boolean;
}
const fingerprint = (v: string): string => {
  let h = 5381;
  for (let i = 0; i < v.length; i++) h = ((h << 5) + h + v.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16) + '.' + v.length;
};
const seqRecord = (seq: number, v: string) => `${seq}:${fingerprint(v)}`;
/** Lê `k::seq` (texto `<número>:<impressão>`, ou só o número de uma versão intermediária) para o texto `v`. */
function parseSeq(raw: unknown, v: string): { seq: number; foreign: boolean } {
  if (typeof raw === 'number') return { seq: raw, foreign: false };
  if (typeof raw === 'string') {
    const i = raw.indexOf(':');
    const n = Number(raw.slice(0, i));
    if (i > 0 && Number.isFinite(n)) return { seq: n, foreign: raw.slice(i + 1) !== fingerprint(v) };
  }
  return { seq: 0, foreign: false };
}
/** Valor da cópia no localStorage, ou o envelope { seq, v } gravado direto no IndexedDB pela versão intermediária. */
function unpack(raw: unknown): Stamped | null {
  if (raw && typeof raw === 'object' && typeof (raw as Stamped).v === 'string' && typeof (raw as Stamped).seq === 'number') return raw as Stamped;
  return null;
}
function readCopy(k: string): Stamped | null {
  try {
    const raw = localStorage.getItem(k + FALLBACK_SUFFIX);
    return raw ? unpack(JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}
function dropCopy(k: string) {
  memory.delete(k);
  memorySeq.delete(k);
  try {
    localStorage.removeItem(k + FALLBACK_SUFFIX);
  } catch {
    // a cópia velha perde pelo número da gravação
  }
}
async function writeDb(k: string, v: string, seq: number) {
  await tx('readwrite', (s) => {
    s.put(seqRecord(seq, v), k + SEQ_SUFFIX);
    return s.put(v, k);
  });
  dropCopy(k);
}
/**
 * Cópia mais nova que o IndexedDB e o IndexedDB voltou a funcionar: a cópia entra no IndexedDB (o registro que a
 * versão anterior do app lê), só se ele ainda estiver com número menor, na mesma transação (GPT, rodada 20).
 */
async function healFromCopy(k: string, copy: Stamped) {
  await tx('readwrite', (s) => {
    const cur = s.get(k + SEQ_SUFFIX);
    cur.onsuccess = () => {
      const raw = cur.result as unknown;
      const n = typeof raw === 'string' ? Number(raw.slice(0, raw.indexOf(':'))) : typeof raw === 'number' ? raw : 0;
      if (!(n >= copy.seq)) {
        s.put(seqRecord(copy.seq, copy.v), k + SEQ_SUFFIX);
        s.put(copy.v, k);
      }
    };
    return cur;
  });
  dropCopy(k);
}

export const idbStorage: StateStorage = hasIndexedDB
  ? {
      getItem: async (k) => {
        let fromDb: Candidate | null = null;
        let dbFailed = false;
        try {
          // Texto e número na mesma transação: nunca o texto de uma gravação com o número de outra.
          let seqReq: IDBRequest<unknown> | undefined;
          const text = await tx<unknown>('readonly', (st) => {
            seqReq = st.get(k + SEQ_SUFFIX) as IDBRequest<unknown>;
            return st.get(k) as IDBRequest<unknown>;
          });
          if (typeof text === 'string') {
            const r = parseSeq(seqReq?.result, text);
            fromDb = { seq: r.seq, v: text, foreign: r.foreign };
          } else {
            fromDb = unpack(text);
          }
        } catch {
          dbFailed = true;
        }
        const copy = readCopy(k);
        const mem = memory.get(k);
        const candidates: Candidate[] = [];
        if (fromDb) candidates.push(fromDb);
        if (copy) candidates.push(copy);
        if (mem !== undefined) candidates.push({ seq: memorySeq.get(k) ?? 0, v: mem });
        if (candidates.length === 0) return dbFailed ? (fallback.getItem(k) as string | null) : null;
        // O texto de versão anterior vale mais que tudo; senão o número maior; empate: o IndexedDB (ordem acima) fica.
        const best = candidates.find((c) => c.foreign) ?? candidates.reduce((a, b) => (b.seq > a.seq ? b : a));
        for (const c of candidates) if (!c.foreign) seen(c.seq);
        if (!dbFailed && copy && best === copy) {
          try {
            await healFromCopy(k, copy);
          } catch {
            // continua só na cópia; a próxima gravação boa tira
          }
        }
        return best.v;
      },
      setItem: async (k, v) => {
        const seq = nextSeq();
        try {
          await writeDb(k, v, seq);
        } catch {
          try {
            localStorage.setItem(k + FALLBACK_SUFFIX, JSON.stringify({ seq, v } satisfies Stamped));
            memory.delete(k);
            memorySeq.delete(k);
          } catch {
            memory.set(k, v);
            memorySeq.set(k, seq);
          }
        }
      },
      removeItem: async (k) => {
        memory.delete(k);
        memorySeq.delete(k);
        try {
          localStorage.removeItem(k + FALLBACK_SUFFIX);
        } catch {
          // nada a apagar
        }
        try {
          await tx('readwrite', (s) => {
            s.delete(k + SEQ_SUFFIX);
            return s.delete(k);
          });
        } catch {
          fallback.removeItem(k);
        }
      },
    }
  : fallback;
