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
 * MODELO (simplificado na rodada 27 do PR #54, depois de oito rodadas de casos de concorrência entre abas):
 *
 *  A. UM ÚNICO ESCRITOR POR APARELHO. Só a instância que obtém o lock exclusivo `navigator.locks` grava, recupera ou
 *     apaga qualquer coisa. Outra aba ou instância do app no mesmo aparelho só LÊ (devolve o mais novo que vê, não
 *     muda nada, não grava). Onde `navigator.locks` não existe, a instância é a escritora (APK: uma WebView por aparelho).
 *     Isso fecha a classe inteira de concorrência entre escritores do app novo; o que resta é só o texto que uma
 *     VERSÃO ANTERIOR do app deixa (ver "foreign" abaixo) e a chave antiga `<nome>::copia`.
 *  B. NENHUM CONTEÚDO É APAGADO SEM ANTES TER SIDO PROVADO INCLUÍDO NO ESTADO QUE FICA, OU GUARDADO EM `::conflito`.
 *     Toda exclusão passa por `retire`: a cópia sai sem registro só se tem o mesmo conteúdo do estado que vale ou se é
 *     de uma gravação ANTERIOR DO MESMO ESCRITOR (a mesma instância; o estado dela só avança, então o mais novo inclui o
 *     mais velho); qualquer outra, de conteúdo diferente, é guardada em `<nome>::conflito::…` antes e só é apagada se a
 *     guarda deu certo. A chave antiga única `<nome>::copia` (mutável, escrita por versões anteriores) NUNCA é apagada
 *     automaticamente: só é lida como candidata e, se perder, o conteúdo dela continua lá.
 *  C. `getItem` só dá o resultado por concluído numa seleção estável: depois de qualquer espera (recuperação no
 *     IndexedDB, com sucesso ou erro) confere se apareceu ou mudou cópia, ou se o próprio IndexedDB mudou, e escolhe de
 *     novo. Esgotadas as tentativas (ou com o IndexedDB ilegível depois de uma recuperação recusada) o resultado é
 *     PROVISÓRIO: devolve o mais novo visto (nunca null, que hidrataria loja vazia), não apaga nada, e QUALQUER
 *     GRAVAÇÃO é recusada até uma nova seleção estável devolver exatamente o que foi hidratado; se devolver outra coisa
 *     (uma cópia mais nova), a gravação continua recusada e a próxima abertura do app hidrata o estado certo.
 *
 * Formato da cópia: { seq, id, v, base }, chave `<nome>::copia::<seq>.<instância>` (uma por gravação, nunca trocada).
 * `base` é a impressão do texto que o IndexedDB tinha quando a cópia foi feita (null: não se sabe); ver `pick`.
 */
const FALLBACK_SUFFIX = '::copia';
const CONFLICT_SUFFIX = '::conflito';
interface Stamped {
  seq: number;
  v: string;
  base?: string | null;
}
/** Cópia no localStorage: `key` é a chave exata, `raw` o texto lido dela, `id` a instância que gravou ('' na chave antiga). */
interface Entry extends Stamped {
  id: string;
  key: string;
  raw: string;
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
/** Cópias vistas na última seleção (o `retire` age só sobre elas). */
const seenCopies = new Map<string, Entry[]>();
/** Seleção não concluída: o que foi hidratado e que nenhuma gravação pode promover a estado definitivo. */
const provisional = new Set<string>();
const provisionalValue = new Map<string, string>();
const WRITER_LOCK = 'tchefood-idb-writer';
let writerPromise: Promise<boolean> | null = null;
/** Esta instância é a única escritora do aparelho? (lock exclusivo; sem `navigator.locks`, é.) */
export function isStorageWriter(): Promise<boolean> {
  if (writerPromise) return writerPromise;
  const locks = typeof navigator !== 'undefined' ? (navigator as { locks?: LockManager }).locks : undefined;
  if (!locks) return (writerPromise = Promise.resolve(true));
  writerPromise = (async () => {
    for (let i = 0; i < 4; i++) {
      const got = await new Promise<boolean>((resolve) => {
        locks
          .request(WRITER_LOCK, { ifAvailable: true }, (lock) => {
            if (!lock) {
              resolve(false);
              return undefined;
            }
            resolve(true);
            return new Promise<void>(() => undefined); // segura o lock até a página fechar
          })
          .catch(() => resolve(true));
      });
      if (got) return true;
      await new Promise((r) => setTimeout(r, 200)); // a instância anterior pode estar fechando
    }
    return false;
  })();
  return writerPromise;
}

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
        const extra = parsed as { id?: unknown };
        out.push({ ...st, id: typeof extra.id === 'string' ? extra.id : '', key, raw });
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
/**
 * ÚNICO caminho que apaga cópias. A chave antiga única nunca é apagada. Cada outra cópia lida (`covered`) sai sem
 * registro só se tem o mesmo conteúdo do estado que vale (`winnerV`) ou é de uma gravação anterior do mesmo escritor
 * (`winnerId`, número menor ou igual): o estado de um escritor só avança, então o mais novo inclui o mais velho. Qualquer
 * outra, de conteúdo diferente, é guardada em `::conflito` primeiro, e só é apagada se a guarda deu certo. Confere que a
 * chave ainda tem o texto lido.
 */
function retire(k: string, covered: Entry[], winnerV: string, winnerId: string | null, winnerSeq: number) {
  for (const e of covered) {
    try {
      if (e.key === k + FALLBACK_SUFFIX) continue; // chave antiga: mutável por versões anteriores, só preservada
      if (localStorage.getItem(e.key) !== e.raw) continue; // trocada ou já removida: não é a que foi lida
      const superseded = e.v === winnerV || (winnerId !== null && e.id === winnerId && e.seq <= winnerSeq);
      if (!superseded) {
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
}
function clearProvisional(k: string) {
  provisional.delete(k);
  provisionalValue.delete(k);
}
async function writeDb(k: string, v: string, seq: number) {
  await tx('readwrite', (s) => {
    s.put(seqRecord(seq, v), k + SEQ_SUFFIX);
    return s.put(v, k);
  });
  dbKnown.set(k, fingerprint(v));
  dropMemory(k);
  // As cópias lidas saem pelo `retire` (as do mesmo escritor sem registro, as outras guardadas); a que esta instância ainda não leu fica.
  retire(k, seenCopies.get(k) ?? [], v, INSTANCE, seq);
  seenCopies.delete(k);
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

/** Quantas seleções seguidas `select` faz até ficar estável; esgotadas, o resultado é provisório (ver acima, item C). */
const MAX_SELECTIONS = 6;

async function select(k: string): Promise<string | null> {
  const writer = await isStorageWriter();
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
      clearProvisional(k);
      return snap ? null : (fallback.getItem(k) as string | null);
    }
    last = best;
    if (!writer) return best.v; // instância só de leitura: não grava, não recupera, não apaga
    for (const c of [fromDb, ...outside]) if (c && !c.foreign) seen(c.seq);
    seenCopies.set(k, entries);
    if (best.entry && snap) {
      let healed = false;
      try {
        // A cópia foi feita em cima de OUTRO texto do IndexedDB que não é o de agora: o de agora é uma bifurcação
        // e sobrescrevê-lo só vale se ele ficar guardado antes.
        if (fromDb && !fromDb.foreign && typeof snap.text === 'string' && best.base != null && best.base !== fingerprint(snap.text)) {
          localStorage.setItem(conflictKey(k, fromDb.seq, 'db', snap.text), JSON.stringify({ seq: fromDb.seq, id: 'db', v: snap.text, base: null }));
        }
        healed = await healFromCopy(k, best, snap);
      } catch {
        // A recuperação foi recusada. Durante a espera pode ter mudado cópia OU o próprio IndexedDB: só é resultado
        // concluído se tudo continua como na leitura; se o IndexedDB não puder ser relido, o resultado é provisório.
        let again: Snapshot | null = null;
        try {
          again = await readSnapshot(k);
        } catch {
          again = null;
        }
        if (again === null) {
          provisional.add(k);
          provisionalValue.set(k, best.v);
          return best.v;
        }
        if (!same(again.text, snap.text) || !same(again.seqRaw, snap.seqRaw) || copiesChanged(k, entries)) continue;
        clearProvisional(k);
        return best.v;
      }
      if (!healed) continue; // o IndexedDB mudou: lê de novo
      retire(k, entries, best.v, best.entry.id, best.seq);
      seenCopies.delete(k);
      // Seleção estável: se apareceu ou mudou cópia durante a recuperação, é mais um candidato; recomeça.
      if (copiesChanged(k, entries)) continue;
      clearProvisional(k);
      return best.v;
    }
    if (best === fromDb && snap) {
      // O IndexedDB já é o mais novo: as cópias lidas que ele não inclui vão para `::conflito`.
      retire(k, entries, best.v, fromDb.foreign ? null : INSTANCE, best.seq);
      seenCopies.delete(k);
    }
    clearProvisional(k);
    return best.v;
  }
  // Seleção que não ficou estável: devolve o mais novo visto (null hidrataria uma loja vazia), sem apagar nada,
  // e nenhuma gravação é aceita até uma seleção estável devolver exatamente isto.
  provisional.add(k);
  if (last) provisionalValue.set(k, last.v);
  return last?.v ?? null;
}

export const idbStorage: StateStorage = hasIndexedDB
  ? {
      getItem: (k) => select(k),
      setItem: async (k, v) => {
        if (!(await isStorageWriter())) {
          console.warn('[idbStorage] outra instância do app é a escritora neste aparelho: esta só lê');
          return;
        }
        if (provisional.has(k)) {
          // O estado hidratado não veio de uma seleção estável: só grava se agora a seleção estável devolve o mesmo.
          const expected = provisionalValue.get(k);
          const now = await select(k);
          if (provisional.has(k) || now !== expected) {
            console.warn('[idbStorage] gravação recusada: o estado hidratado não era o mais novo; reabra o app');
            return;
          }
        }
        const seq = nextSeq();
        try {
          await writeDb(k, v, seq);
        } catch {
          const base = dbKnown.get(k) ?? null;
          const key = entryKey(k, seq, INSTANCE);
          const raw = JSON.stringify({ seq, id: INSTANCE, v, base });
          try {
            // Chave própria desta gravação: não troca a de outra aba, mesmo com o mesmo número.
            localStorage.setItem(key, raw);
            dropMemory(k);
            retire(k, seenCopies.get(k) ?? [], v, INSTANCE, seq);
            seenCopies.set(k, [{ seq, id: INSTANCE, v, base, key, raw }]);
          } catch {
            memory.set(k, v);
            memorySeq.set(k, seq);
            memoryBase.set(k, base);
          }
        }
      },
      removeItem: async (k) => {
        if (!(await isStorageWriter())) return;
        dropMemory(k);
        dbKnown.delete(k);
        seenCopies.delete(k);
        clearProvisional(k);
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
