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
 * execução). A regra, em uma frase: NENHUM CONTEÚDO É APAGADO SEM ANTES TER SIDO PROVADO INCLUÍDO NO ESTADO QUE
 * FICA, OU GUARDADO EM `::conflito`. Em partes (a tabela de todos os caminhos está em docs/idbStorage-invariantes.md):
 *
 *  1. Cada cópia é uma chave PRÓPRIA e só de escrita (`<nome>::copia::<seq>.<instância>`): ninguém troca o valor da
 *     cópia de outra aba, e duas gravações com o mesmo número viram duas chaves.
 *  2. Toda exclusão de cópia passa por `retire`: a cópia sai sem registro só se está provadamente incluída no estado
 *     que vale (é ele, tem o mesmo conteúdo, ou está na lista `absorbs` de uma cópia que o estado inclui); qualquer
 *     outra, de conteúdo diferente, é guardada em `<nome>::conflito::…` ANTES de ser apagada, e só é apagada se a
 *     guarda deu certo. Nada apaga `::conflito` sozinho (só `removeItem`). Cada exclusão confere que a chave ainda
 *     tem o mesmo texto que foi lido (a chave antiga única `<nome>::copia` é mutável).
 *  3. Ordem total: (número, id da instância). O IndexedDB fica com o empate de número.
 *  4. `getItem` só dá o resultado por concluído numa seleção estável: depois de qualquer espera (recuperação no
 *     IndexedDB, com sucesso ou erro) confere se apareceu ou mudou cópia e, se sim, escolhe de novo. Esgotadas as
 *     tentativas, o resultado é PROVISÓRIO: devolve o mais novo visto (nunca null, que hidrataria loja vazia), não
 *     apaga nada e, enquanto durar, as gravações também não apagam nenhuma cópia; o que sobra é guardado em
 *     `::conflito` na próxima leitura estável.
 *
 * O que o navegador não garante (limite conhecido): uma cópia que outra aba grava DEPOIS do fim da leitura desta e antes
 * de ela gravar de volta concorre com a gravação desta pela regra do último que grava (como duas abas no IndexedDB);
 * ela não é apagada e, se perder, vai para `::conflito` na próxima leitura.
 *
 * Formato da cópia: { seq, id, v, base, absorbs }. `base` é a impressão do texto que o IndexedDB tinha quando a cópia
 * foi feita (null: não se sabe); ver `pick`. `absorbs` são as chaves das cópias que o estado dela já inclui. A chave
 * antiga única `<nome>::copia` (sem `id`) continua lida, como cópia de id vazio.
 */
const FALLBACK_SUFFIX = '::copia';
const CONFLICT_SUFFIX = '::conflito';
interface Stamped {
  seq: number;
  v: string;
  base?: string | null;
}
/** Cópia no localStorage: `key` é a chave exata, `raw` o texto lido dela, `id` a instância que gravou ('' no formato antigo). */
interface Entry extends Stamped {
  id: string;
  key: string;
  raw: string;
  absorbs: string[];
}
const INSTANCE = (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 12);
let lastSeq = 0;
const nextSeq = () => (lastSeq = Math.max(lastSeq + 1, Date.now()));
const seen = (seq: number) => {
  if (seq > lastSeq) lastSeq = seq;
};
const memorySeq = new Map<string, number>();
const memoryBase = new Map<string, string | null>();
const memoryAbsorbs = new Map<string, Set<string>>();
/** Impressão do texto que o IndexedDB tinha na última leitura ou gravação boa desta chave (ausente: não se sabe). */
const dbKnown = new Map<string, string | null>();
/** Cópias vistas na última seleção, e as chaves que o estado desta aba já inclui (só estas saem sem registro). */
const seenCopies = new Map<string, Entry[]>();
const absorbedKeys = new Map<string, Set<string>>();
/** Seleção não concluída (tentativas esgotadas): nenhuma gravação desta aba apaga cópia até a próxima leitura estável. */
const provisional = new Set<string>();

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
  /** Estado em memória desta aba (as duas gravações recusadas). */
  mem?: boolean;
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
        const raw = localStorage.getItem(key);
        if (raw === null) continue;
        const parsed = JSON.parse(raw) as unknown;
        const st = unpack(parsed);
        if (!st) continue;
        const extra = parsed as { id?: unknown; absorbs?: unknown };
        out.push({ ...st, id: typeof extra.id === 'string' ? extra.id : '', key, raw, absorbs: Array.isArray(extra.absorbs) ? extra.absorbs.filter((x): x is string => typeof x === 'string') : [] });
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
const signature = (e: Entry) => `${e.key}\0${e.raw}`;
/** Chegou ou mudou cópia desde a leitura `seenNow`? */
function copiesChanged(k: string, seenNow: Entry[]): boolean {
  const known = new Set(seenNow.map(signature));
  return listEntries(k).some((e) => !known.has(signature(e)));
}
/** A cópia `e` mais tudo o que ela já inclui (`absorbs`, transitivamente). */
function closure(e: Entry, all: Entry[]): Set<string> {
  const byKey = new Map(all.map((x) => [x.key, x]));
  const out = new Set<string>();
  const walk = (x: Entry) => {
    if (out.has(x.key)) return;
    out.add(x.key);
    for (const a of x.absorbs) out.add(a), byKey.get(a) && walk(byKey.get(a)!);
  };
  walk(e);
  return out;
}
/**
 * ÚNICO caminho que apaga cópias. Cada cópia lida (`covered`) sai sem registro só se está provadamente incluída no
 * estado que vale (`absorbed`) ou tem o mesmo conteúdo dele (`winnerV`); qualquer outra de conteúdo diferente é
 * guardada em `::conflito` primeiro, e só é apagada se a guarda deu certo. A exclusão confere que a chave ainda tem o
 * texto lido (a antiga chave única pode ter sido trocada por outra instância): se mudou, fica.
 */
function retire(k: string, covered: Entry[], absorbed: Set<string>, winnerV: string) {
  for (const e of covered) {
    try {
      if (localStorage.getItem(e.key) !== e.raw) continue; // trocada ou já removida: não é a que foi lida
      if (!absorbed.has(e.key) && e.v !== winnerV) {
        localStorage.setItem(conflictKey(k, e.seq, e.id, e.v), JSON.stringify({ seq: e.seq, id: e.id, v: e.v, base: e.base ?? null } satisfies Stamped & { id: string }));
      }
      localStorage.removeItem(e.key);
    } catch {
      // sem como guardar ou apagar: a cópia fica onde está e é lida de novo
    }
  }
}
function dropMemory(k: string) {
  memory.delete(k);
  memorySeq.delete(k);
  memoryBase.delete(k);
  memoryAbsorbs.delete(k);
}
function forgetSelection(k: string) {
  seenCopies.delete(k);
  absorbedKeys.delete(k);
}
async function writeDb(k: string, v: string, seq: number) {
  await tx('readwrite', (s) => {
    s.put(seqRecord(seq, v), k + SEQ_SUFFIX);
    return s.put(v, k);
  });
  dbKnown.set(k, fingerprint(v));
  dropMemory(k);
  // As cópias lidas saem pelo `retire` (as incluídas sem registro, as outras guardadas); cópia que esta aba
  // ainda não leu fica onde está. Com seleção provisória nada é apagado.
  if (!provisional.has(k)) retire(k, seenCopies.get(k) ?? [], absorbedKeys.get(k) ?? new Set(), v);
  forgetSelection(k);
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
 * posterior; sem texto de versão anterior, vale o número maior (empate: o IndexedDB). As que perdem não somem: `retire`
 * guarda em `::conflito` o que o estado escolhido não inclui.
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

/** Quantas seleções seguidas getItem faz até ficar estável; esgotadas, o resultado é provisório (ver acima, item 4). */
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
          if (mem !== undefined) outside.push({ seq: memorySeq.get(k) ?? 0, v: mem, base: memoryBase.get(k), id: INSTANCE, mem: true });
          const best = pick(fromDb, outside);
          if (!best) {
            provisional.delete(k);
            return snap ? null : (fallback.getItem(k) as string | null);
          }
          last = best;
          for (const c of [fromDb, ...outside]) if (c && !c.foreign) seen(c.seq);
          // Só o que o estado escolhido inclui sai sem registro: ele mesmo e o que ele absorveu.
          const absorbed = best.entry ? closure(best.entry, entries) : best.mem ? new Set(memoryAbsorbs.get(k) ?? []) : new Set<string>();
          seenCopies.set(k, entries);
          absorbedKeys.set(k, absorbed);
          if (best.entry && snap) {
            let healed = false;
            try {
              // A cópia foi feita em cima de OUTRO texto do IndexedDB que não é o de agora: o de agora é uma bifurcação
              // (outra aba gravou depois) e sobrescrevê-lo só vale se ele ficar guardado antes.
              if (fromDb && !fromDb.foreign && typeof snap.text === 'string' && best.base != null && best.base !== fingerprint(snap.text)) {
                localStorage.setItem(conflictKey(k, fromDb.seq, 'db', snap.text), JSON.stringify({ seq: fromDb.seq, id: 'db', v: snap.text, base: null }));
              }
              healed = await healFromCopy(k, best, snap);
            } catch {
              // O IndexedDB recusa a recuperação. A cópia segue de pé (nada é apagado), mas durante a espera
              // pode ter chegado outra mais nova: só é resultado concluído se nada mudou.
              if (copiesChanged(k, entries)) continue;
              provisional.delete(k);
              return best.v;
            }
            if (!healed) continue; // o IndexedDB mudou: lê de novo
            retire(k, entries, absorbed, best.v);
            forgetSelection(k);
            // Seleção estável: se apareceu ou mudou cópia durante a recuperação, é mais um candidato; recomeça.
            if (copiesChanged(k, entries)) continue;
            provisional.delete(k);
            return best.v;
          }
          if (best === fromDb && snap) {
            // O IndexedDB já é o mais novo: as cópias lidas que ele não inclui vão para `::conflito`.
            retire(k, entries, absorbed, best.v);
            forgetSelection(k);
          }
          provisional.delete(k);
          return best.v;
        }
        // Seleção que não ficou estável: devolve o mais novo visto (null hidrataria uma loja vazia), sem apagar nada.
        provisional.add(k);
        return last?.v ?? null;
      },
      setItem: async (k, v) => {
        const seq = nextSeq();
        try {
          await writeDb(k, v, seq);
        } catch {
          const base = dbKnown.get(k) ?? null;
          const key = entryKey(k, seq, INSTANCE);
          const absorbs = [...(absorbedKeys.get(k) ?? [])];
          const raw = JSON.stringify({ seq, id: INSTANCE, v, base, absorbs });
          try {
            // Chave própria desta gravação: não troca a de outra aba, mesmo com o mesmo número.
            localStorage.setItem(key, raw);
            dropMemory(k);
            const mine: Entry = { seq, id: INSTANCE, v, base, absorbs, key, raw };
            const prior = seenCopies.get(k) ?? [];
            const absorbed = new Set([...(absorbedKeys.get(k) ?? []), key]);
            // O estado desta cópia inclui o que a aba já tinha absorvido: sai sem registro; o resto lido é guardado.
            if (!provisional.has(k)) retire(k, prior, absorbed, v);
            seenCopies.set(k, provisional.has(k) ? [...prior, mine] : [mine]);
            absorbedKeys.set(k, absorbed);
          } catch {
            memory.set(k, v);
            memorySeq.set(k, seq);
            memoryBase.set(k, base);
            memoryAbsorbs.set(k, new Set(absorbedKeys.get(k) ?? []));
          }
        }
      },
      removeItem: async (k) => {
        dropMemory(k);
        dbKnown.delete(k);
        forgetSelection(k);
        provisional.delete(k);
        // Apagar o estado é decisão explícita (sair da loja): vão também as cópias e os conflitos guardados.
        try {
          const doomed: string[] = [];
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key !== null && (key.startsWith(k + FALLBACK_SUFFIX) || key.startsWith(k + CONFLICT_SUFFIX + '::'))) doomed.push(key);
          }
          for (const key of doomed) localStorage.removeItem(key);
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
