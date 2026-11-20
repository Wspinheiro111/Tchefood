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
 * Cópia no localStorage de uma gravação que o IndexedDB recusou, com o número da gravação ({ seq, v, base }).
 * A leitura fica com a mais nova entre o IndexedDB e esta cópia: reabrindo o app com o IndexedDB bom de novo,
 * o estado gravado na cópia não perde para a versão velha que ficou no IndexedDB (GPT, rodada 18 do PR #54).
 * `base` é a impressão do texto que o IndexedDB tinha quando a cópia foi feita (null: não se sabe): a cópia foi
 * feita em cima desse texto, então só um texto diferente dele é uma escrita posterior à cópia (GPT, rodada 21).
 */
const FALLBACK_SUFFIX = '::copia';
interface Stamped {
  seq: number;
  v: string;
  base?: string | null;
}
let lastSeq = 0;
const nextSeq = () => (lastSeq = Math.max(lastSeq + 1, Date.now()));
const seen = (seq: number) => {
  if (seq > lastSeq) lastSeq = seq;
};
const memorySeq = new Map<string, number>();
const memoryBase = new Map<string, string | null>();
/** Impressão do texto que o IndexedDB tinha na última leitura ou gravação boa desta chave (ausente: não se sabe). */
const dbKnown = new Map<string, string | null>();

/**
 * No IndexedDB o valor continua sendo o texto puro da chave `k`, como nas versões anteriores (voltar o app
 * para uma versão anterior lê o mesmo registro; GPT, rodada 19 do PR #54). O número da gravação fica numa
 * chave ao lado (`k::seq`), gravada na mesma transação, no formato `<número>:<impressão do texto>`.
 * Se o texto de `k` não bate com a impressão, ele foi gravado por uma versão anterior do app (que não mexe
 * em `k::seq`) depois da última gravação desta versão: é o mais novo, a não ser que haja uma cópia feita em
 * cima dele (`base`). Sem `k::seq`, vale 0.
 */
const SEQ_SUFFIX = '::seq';
interface Candidate extends Stamped {
  /** Texto gravado por versão que não conhece `k::seq`. */
  foreign?: boolean;
}
/** Duas somas de 53 bits (cyrb53, sementes diferentes) e o tamanho: colisão por acaso é praticamente impossível. */
function cyrb53(str: string, seed: number): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
export const fingerprint = (v: string): string => `${cyrb53(v, 0).toString(16)}.${cyrb53(v, 1).toString(16)}.${v.length}`;
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
/**
 * Tira a cópia desta chave, menos uma com número maior que `upToSeq`: outra aba pode ter gravado uma cópia mais nova
 * depois de a leitura escolher a cópia que está sendo recuperada, ou depois de começar a gravação no IndexedDB, e essa
 * não pode sumir (GPT, rodada 23 do PR #54). O localStorage não tem apagar-se-igual entre abas; a conferência e a
 * remoção ficam juntas no mesmo trecho síncrono, sem esperar nada no meio.
 */
function dropCopy(k: string, upToSeq = Infinity) {
  memory.delete(k);
  memorySeq.delete(k);
  memoryBase.delete(k);
  try {
    const current = readCopy(k);
    if (current && current.seq > upToSeq) return;
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
  dbKnown.set(k, fingerprint(v));
  dropCopy(k, seq);
}

/** O que o IndexedDB tinha em `k` e `k::seq`, lido na mesma transação (nunca o texto de uma gravação com o número de outra). */
interface Snapshot {
  text: unknown;
  seqRaw: unknown;
}
async function readSnapshot(k: string): Promise<Snapshot> {
  let seqReq: IDBRequest<unknown> | undefined;
  const text = await tx<unknown>('readonly', (st) => {
    seqReq = st.get(k + SEQ_SUFFIX) as IDBRequest<unknown>;
    return st.get(k) as IDBRequest<unknown>;
  });
  return { text, seqRaw: seqReq?.result };
}
const same = (a: unknown, b: unknown) => (typeof a === 'string' || typeof b === 'string' ? a === b : JSON.stringify(a) === JSON.stringify(b));

/**
 * O mais novo entre o IndexedDB (`db`) e o que está fora dele (cópia no localStorage, memória): o IndexedDB com texto
 * de versão anterior (foreign) vale mais, a não ser que a cópia tenha sido feita em cima desse mesmo texto
 * (`base`), e então a cópia é posterior; sem texto de versão anterior, vale o número maior, empate para o IndexedDB.
 */
function pick(db: Candidate | null, outside: Candidate[]): Candidate | null {
  const newer = outside.reduce<Candidate | null>((a, b) => (a && a.seq >= b.seq ? a : b), null);
  if (!db) return newer;
  if (!newer) return db;
  if (db.foreign) return newer.base === fingerprint(db.v) ? newer : db;
  return newer.seq > db.seq ? newer : db;
}

/**
 * A cópia é mais nova que o IndexedDB e ele voltou a funcionar: a cópia entra no IndexedDB (o registro que a versão
 * anterior do app lê), na mesma transação em que `k` e `k::seq` são lidos de novo, e só se continuarem exatamente
 * como na leitura que escolheu a cópia: se outra versão gravou nesse meio tempo, nada é sobrescrito (devolve false e
 * quem chamou lê de novo; GPT, rodada 21 do PR #54).
 */
async function healFromCopy(k: string, copy: Stamped, snap: Snapshot): Promise<boolean> {
  let applied = false;
  await tx('readwrite', (s) => {
    const text = s.get(k);
    const seq = s.get(k + SEQ_SUFFIX);
    seq.onsuccess = () => {
      if (same(text.result, snap.text) && same(seq.result, snap.seqRaw)) {
        s.put(seqRecord(copy.seq, copy.v), k + SEQ_SUFFIX);
        s.put(copy.v, k);
        applied = true;
      }
    };
    return seq;
  });
  if (applied) {
    dbKnown.set(k, fingerprint(copy.v));
    dropCopy(k, copy.seq);
  }
  return applied;
}

export const idbStorage: StateStorage = hasIndexedDB
  ? {
      getItem: async (k) => {
        for (let attempt = 0; ; attempt++) {
          let snap: Snapshot | null = null;
          let fromDb: Candidate | null = null;
          try {
            snap = await readSnapshot(k);
          } catch {
            snap = null;
          }
          if (snap) {
            if (typeof snap.text === 'string') {
              const r = parseSeq(snap.seqRaw, snap.text);
              fromDb = { seq: r.seq, v: snap.text, foreign: r.foreign };
              dbKnown.set(k, fingerprint(snap.text));
            } else {
              fromDb = unpack(snap.text);
              dbKnown.set(k, null);
            }
          }
          const copy = readCopy(k);
          const mem = memory.get(k);
          const outside: Candidate[] = [];
          if (copy) outside.push(copy);
          if (mem !== undefined) outside.push({ seq: memorySeq.get(k) ?? 0, v: mem, base: memoryBase.get(k) });
          const best = pick(fromDb, outside);
          if (!best) return snap ? null : (fallback.getItem(k) as string | null);
          for (const c of [fromDb, ...outside]) if (c && !c.foreign) seen(c.seq);
          if (snap && copy && best === copy) {
            try {
              if (!(await healFromCopy(k, copy, snap)) && attempt < 2) continue;
            } catch {
              // continua só na cópia; a próxima gravação boa tira
            }
          }
          return best.v;
        }
      },
      setItem: async (k, v) => {
        const seq = nextSeq();
        try {
          await writeDb(k, v, seq);
        } catch {
          const base = dbKnown.get(k) ?? null;
          try {
            // Cópia mais nova de outra aba não é trocada por esta, mais velha.
            const current = readCopy(k);
            if (!current || current.seq < seq) localStorage.setItem(k + FALLBACK_SUFFIX, JSON.stringify({ seq, v, base } satisfies Stamped));
            memory.delete(k);
            memorySeq.delete(k);
            memoryBase.delete(k);
          } catch {
            memory.set(k, v);
            memorySeq.set(k, seq);
            memoryBase.set(k, base);
          }
        }
      },
      removeItem: async (k) => {
        memory.delete(k);
        memorySeq.delete(k);
        memoryBase.delete(k);
        dbKnown.delete(k);
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
