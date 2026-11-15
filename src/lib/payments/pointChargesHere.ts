/**
 * Cobranças da Point iniciadas neste aparelho (auditoria interna 2, P2-3). A chave fica gravada desde o envio até o
 * fim da cobrança nesta tela; se o app recarregar no meio, a tela ainda sabe que a cobrança aberta no servidor é
 * deste aparelho (não "cobrando em outro aparelho"). Só conveniência local: sem a gravação, vale o texto antigo.
 *
 * Uma chave do localStorage por cobrança (auditoria GPT r10, "a verificar 1"): duas abas gravando a lista inteira
 * ao mesmo tempo apagavam a entrada uma da outra.
 */
const PREFIX = 'tchefood:point-charges-here:';
/** Formato anterior: a lista inteira numa chave (migrada na leitura). */
const LEGACY_KEY = 'tchefood:point-charges-here';
/** Entradas mais velhas que isto saem (a cobrança já terminou no servidor há muito). */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

type Entry = { key: string; orderId: string; at: number };

const isEntry = (e: unknown): e is Entry =>
  typeof (e as Entry)?.key === 'string' && typeof (e as Entry)?.orderId === 'string' && typeof (e as Entry)?.at === 'number';

function store(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function migrateLegacy(st: Storage): void {
  try {
    const raw = st.getItem(LEGACY_KEY);
    if (raw === null) return;
    const list = JSON.parse(raw) as unknown;
    if (Array.isArray(list)) for (const e of list) if (isEntry(e) && st.getItem(PREFIX + e.key) === null) st.setItem(PREFIX + e.key, JSON.stringify(e));
    st.removeItem(LEGACY_KEY);
  } catch {
    // sem armazenamento ou corrompido: fica como está
  }
}

function read(): Entry[] {
  const st = store();
  if (!st) return [];
  try {
    migrateLegacy(st);
    const now = Date.now();
    const out: Entry[] = [];
    const keys: string[] = [];
    for (let i = 0; i < st.length; i++) {
      const k = st.key(i);
      if (k && k.startsWith(PREFIX)) keys.push(k);
    }
    for (const k of keys) {
      let e: unknown = null;
      try {
        e = JSON.parse(st.getItem(k) ?? 'null');
      } catch {
        e = null;
      }
      if (isEntry(e) && PREFIX + e.key === k && now - e.at < MAX_AGE_MS) out.push(e);
      else {
        try {
          st.removeItem(k);
        } catch {
          // fica
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function rememberPointChargeHere(key: string, orderId: string): void {
  try {
    store()?.setItem(PREFIX + key, JSON.stringify({ key, orderId, at: Date.now() }));
  } catch {
    // sem armazenamento: a tela volta ao texto de antes
  }
}

export function forgetPointChargeHere(key: string): void {
  const st = store();
  if (!st) return;
  migrateLegacy(st);
  try {
    st.removeItem(PREFIX + key);
  } catch {
    // sem armazenamento
  }
}

export function isPointChargeHere(key: string): boolean {
  return read().some((e) => e.key === key);
}
