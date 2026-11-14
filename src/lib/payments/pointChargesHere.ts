/**
 * Cobranças da Point iniciadas neste aparelho (auditoria interna 2, P2-3). A chave fica gravada desde o envio até o
 * fim da cobrança nesta tela; se o app recarregar no meio, a tela ainda sabe que a cobrança aberta no servidor é
 * deste aparelho (não "cobrando em outro aparelho"). Só conveniência local: sem a gravação, vale o texto antigo.
 */
const STORAGE_KEY = 'tchefood:point-charges-here';
/** Entradas mais velhas que isto saem (a cobrança já terminou no servidor há muito). */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

type Entry = { key: string; orderId: string; at: number };

function read(): Entry[] {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(list)) return [];
    const now = Date.now();
    return list.filter((e): e is Entry => typeof e?.key === 'string' && typeof e?.orderId === 'string' && typeof e?.at === 'number' && now - e.at < MAX_AGE_MS);
  } catch {
    return [];
  }
}

function write(list: Entry[]): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // sem armazenamento: a tela volta ao texto de antes
  }
}

export function rememberPointChargeHere(key: string, orderId: string): void {
  write([...read().filter((e) => e.key !== key), { key, orderId, at: Date.now() }]);
}

export function forgetPointChargeHere(key: string): void {
  write(read().filter((e) => e.key !== key));
}

export function isPointChargeHere(key: string): boolean {
  return read().some((e) => e.key === key);
}
