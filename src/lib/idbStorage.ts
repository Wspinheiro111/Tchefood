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
 * COPIAS DE EMERGENCIA (gravação que o IndexedDB recusou) e a regra que as protege.
 *
 * O navegador não dá transação entre localStorage e IndexedDB, nem "apagar se igual" no localStorage, e abas
 * diferentes do mesmo app podem intercalar qualquer par de operações (WHATWG: não presumir travas entre grupos de
 * execução). Por isso nenhuma cópia é sobrescrita nem apagada por comparação de número:
 *
 *  1. Cada cópia é uma chave PRÓPRIA e só de escrita (`<nome>::copia::<seq>.<instância>`): ninguém troca o valor de
 *     uma cópia de outra aba, e duas gravações com o mesmo número (mesmo milissegundo) viram duas chaves.
 *  2. Uma aba só apaga cópias pela chave exata que ELA LEU (ou escreveu) e cujo conteúdo o estado dela já inclui:
 *     as lidas na última seleção e as suas. Cópia que apareceu depois da leitura não é conhecida e nunca é apagada.
 *  3. Ordem total: (número, id da instância). Mesmo número com conteúdos diferentes: o desempate é pelo id, e a perdedora
 *     não é apagada: vai para `<nome>::conflito::…`, que nada apaga sozinho, para a pessoa poder recuperar.
 *  4. getItem só devolve depois de uma seleção estável: depois de recuperar uma cópia no IndexedDB, lê tudo de novo, e
 *     se apareceu cópia mais nova, recomeça. O que o Zustand hidrata é, portanto, o mais novo que existia ao fim da leitura.
 *
 * O que o navegador não garante (limite conhecido): uma cópia que outra aba grava DEPOIS do fim da leitura desta, e antes
 * de ela gravar de volta, concorre com a gravação desta pela regra do último que grava (como duas abas gravando no
 * IndexedDB); ela continua na chave dela até alguém a ler e vale se tiver número maior.
 *
 * Formato da cópia: { seq, id, v, base }. `base` é a impressão do texto que o IndexedDB tinha quando a cópia foi feita
 * (null: não se sabe); ver `pick`. O formato antigo, uma chave única `<nome>::copia` sem `id`, continua lido (id vazio).
 */
const FALLBACK_SUFFIX = '::copia';
const CONFLICT_SUFFIX = '::conflito';
interface Stamped {
  seq: number;
  v: string;
  base?: string | null;
}
/** Cópia no localStorage: `key` é a chave exata, `id` a instância que gravou ('' no formato antigo). */
interface Entry extends Stamped {
  id: string;
  key: string;
}
const INSTANCE = (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 12);
let lastSeq = 0;
const nextSeq = () => (lastSeq = Math.max(lastSeq + 1, Date.now()));
const seen = (seq: number) => {
  if (seq > lastSeq) lastSeq = seq;
};
const memorySeq = new Map<string, number>();
const memoryBase = new Map<string, string | null>();
/** Impressão do texto que o IndexedDB tinha na última leitura ou gravação boa desta chave (ausente: não se sabe). */
const dbKnown = new Map<string, string | null>();
/** Chaves exatas das cópias que o estado desta aba já inclui (lidas na última seleção ou gravadas por ela). */
const knownCopies = new Map<string, Set<string>>();

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
  /** Cópia do localStorage, quando é uma. */
  entry?: Entry;
  id?: string;
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
/** O envelope { seq, v } gravado direto no IndexedDB pela versão intermediária. */
function unpack(raw: unknown): Stamped | null {
  if (raw && typeof raw === 'object' && typeof (raw as Stamped).v === 'string' && typeof (raw as Stamped).seq === 'number') return raw as Stamped;
  return null;
}
const entryKey = (k: string, seq: number, id: string) => `${k}${FALLBACK_SUFFIX}::${seq.toString(36)}.${id}`;
const conflictKey = (k: string, seq: number, id: string, v: string) => `${k}${CONFLICT_SUFFIX}::${seq.toString(36)}.${id}.${fingerprint(v)}`;
/** Todas as cópias desta chave no localStorage (a chave antiga única e as de uma gravação cada). */
function listEntries(k: string): Entry[] {
  const out: Entry[] = [];
  try {
    const prefix = k + FALLBACK_SUFFIX;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key === null || !(key === prefix || key.startsWith(prefix + '::'))) continue;
      try {
        const raw = JSON.parse(localStorage.getItem(key) ?? 'null') as unknown;
        const st = unpack(raw);
        if (st) out.push({ ...st, id: typeof (raw as { id?: unknown }).id === 'string' ? (raw as { id: string }).id : '', key });
      } catch {
        // cópia ilegível: fica onde está, não é lida
      }
    }
  } catch {
    // sem localStorage
  }
  return out;
}
/** Ordem total das cópias: número e, no empate, id da instância. */
const compare = (a: { seq: number; id?: string }, b: { seq: number; id?: string }) => a.seq - b.seq || ((a.id ?? '') < (b.id ?? '') ? -1 : (a.id ?? '') > (b.id ?? '') ? 1 : 0);
/** Tira exatamente estas chaves (nada além delas). */
function removeKeys(keys: Iterable<string>) {
  for (const key of keys) {
    try {
      localStorage.removeItem(key);
    } catch {
      // fica; é lida de novo e perde pelo número
    }
  }
}
/**
 * Cópias que o estado `winner` já cobre (lidas e menores na ordem, ou iguais em conteúdo): saem pela chave exata.
 * Cópia com o MESMO número e conteúdo diferente não é descartada: vai para `::conflito` (nada a apaga sozinho).
 */
function retire(k: string, covered: Entry[], winner: { seq: number; v: string; id?: string }) {
  const keys: string[] = [];
  for (const e of covered) {
    if (e.seq === winner.seq && e.v !== winner.v) {
      try {
        localStorage.setItem(conflictKey(k, e.seq, e.id, e.v), JSON.stringify({ seq: e.seq, id: e.id, v: e.v, base: e.base ?? null } satisfies Stamped & { id: string }));
      } catch {
        continue; // sem como guardar o conflito: a cópia fica onde está
      }
    }
    keys.push(e.key);
  }
  removeKeys(keys);
}
function dropMemory(k: string) {
  memory.delete(k);
  memorySeq.delete(k);
  memoryBase.delete(k);
}
async function writeDb(k: string, v: string, seq: number) {
  await tx('readwrite', (s) => {
    s.put(seqRecord(seq, v), k + SEQ_SUFFIX);
    return s.put(v, k);
  });
  dbKnown.set(k, fingerprint(v));
  dropMemory(k);
  // Só as cópias que o estado desta aba já inclui; cópia de outra aba que ainda não foi lida fica.
  removeKeys(knownCopies.get(k) ?? []);
  knownCopies.delete(k);
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
 * O mais novo entre o IndexedDB (`db`) e o que está fora dele (cópias, memória): o IndexedDB com texto de versão anterior
 * (foreign) vale mais, a não ser que a cópia tenha sido feita em cima desse mesmo texto (`base`), e então a cópia é
 * posterior; sem texto de versão anterior, vale o número maior (empate com conteúdo igual ou diferente: o IndexedDB fica
 * e a cópia empatada e diferente vai para `::conflito`, ver `retire`).
 */
function pick(db: Candidate | null, outside: Candidate[]): Candidate | null {
  const top = (list: Candidate[]) => list.reduce<Candidate | null>((a, b) => (a && compare(a, b) >= 0 ? a : b), null);
  if (!db) return top(outside);
  if (db.foreign) {
    const fp = fingerprint(db.v);
    return top(outside.filter((c) => c.base === fp)) ?? db;
  }
  const newer = top(outside);
  return newer && newer.seq > db.seq ? newer : db;
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
  if (applied) dbKnown.set(k, fingerprint(copy.v));
  return applied;
}

/** Quantas leituras seguidas getItem faz até a seleção ficar estável (cópia nova no meio da recuperação). */
const MAX_SELECTIONS = 6;

export const idbStorage: StateStorage = hasIndexedDB
  ? {
      getItem: async (k) => {
        let last: Candidate | null = null;
        for (let attempt = 0; attempt < MAX_SELECTIONS; attempt++) {
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
          const entries = listEntries(k);
          const mem = memory.get(k);
          const outside: Candidate[] = entries.map((e) => ({ seq: e.seq, v: e.v, base: e.base, id: e.id, entry: e }));
          if (mem !== undefined) outside.push({ seq: memorySeq.get(k) ?? 0, v: mem, base: memoryBase.get(k), id: INSTANCE });
          const best = pick(fromDb, outside);
          if (!best) return snap ? null : (fallback.getItem(k) as string | null);
          last = best;
          for (const c of [fromDb, ...outside]) if (c && !c.foreign) seen(c.seq);
          // O estado desta aba passa a incluir as cópias lidas: só estas chaves podem ser apagadas por ela.
          knownCopies.set(k, new Set(entries.map((e) => e.key)));
          if (best.entry && snap) {
            try {
              if (!(await healFromCopy(k, best, snap))) continue; // o IndexedDB mudou: lê de novo
            } catch {
              return best.v; // o IndexedDB ainda recusa: segue na cópia, que fica onde está
            }
            retire(k, entries, best);
            knownCopies.delete(k);
            // Seleção estável: se apareceu cópia que esta leitura não viu, ela é mais um candidato; recomeça.
            const known = new Set(entries.map((e) => e.key));
            if (listEntries(k).some((e) => !known.has(e.key))) continue;
            return best.v;
          }
          if (best === fromDb && snap) {
            // O IndexedDB já é o mais novo: as cópias lidas são mais velhas (ou empatadas: ver retire).
            retire(k, entries, best);
            knownCopies.delete(k);
          }
          return best.v;
        }
        return last?.v ?? null;
      },
      setItem: async (k, v) => {
        const seq = nextSeq();
        try {
          await writeDb(k, v, seq);
        } catch {
          const base = dbKnown.get(k) ?? null;
          const key = entryKey(k, seq, INSTANCE);
          try {
            // Chave própria desta gravação: não troca a de outra aba, mesmo com o mesmo número.
            localStorage.setItem(key, JSON.stringify({ seq, id: INSTANCE, v, base }));
            dropMemory(k);
            // Esta cópia já inclui o que o estado tinha: as cópias conhecidas e mais velhas saem pela chave exata.
            const known = knownCopies.get(k) ?? new Set<string>();
            removeKeys([...known].filter((x) => x !== key));
            knownCopies.set(k, new Set([key]));
          } catch {
            memory.set(k, v);
            memorySeq.set(k, seq);
            memoryBase.set(k, base);
          }
        }
      },
      removeItem: async (k) => {
        dropMemory(k);
        dbKnown.delete(k);
        knownCopies.delete(k);
        // Apagar o estado é decisão explícita (sair da loja): vão também as cópias e os conflitos guardados.
        try {
          const doomed: string[] = [];
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key !== null && (key.startsWith(k + FALLBACK_SUFFIX) || key.startsWith(k + CONFLICT_SUFFIX + '::'))) doomed.push(key);
          }
          removeKeys(doomed);
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
