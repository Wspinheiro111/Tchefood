/**
 * Ledger durável de impressão física — portado do Tchê Vendas
 * (apps/w9-smart-pagbank/.../SharedPreferencesReceiptPrintLedger.kt).
 *
 * Antes de mandar os bytes para a impressora grava STARTED; depois de uma
 * resposta clara grava COMPLETE (impresso) ou FAILED (a impressora recusou,
 * pode reimprimir). Se o app cair ou a ponte lançar exceção entre os dois,
 * fica STARTED: o resultado é incerto e o sistema NÃO reimprime sozinho
 * (evita a cozinha preparar o mesmo prato duas vezes).
 */
export type PrintLedgerState = 'STARTED' | 'COMPLETE' | 'FAILED';

export interface PrintLedgerEntry {
  key: string;
  state: PrintLedgerState;
  updated_at: string;
}

const STORAGE_KEY = 'tchefood.printLedger.v1';
/** Mantém só as entradas recentes: o ledger protege reimpressão do mesmo turno. */
const MAX_ENTRIES = 500;

const memory = new Map<string, PrintLedgerEntry>();
let loaded = false;

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function load() {
  if (loaded) return;
  loaded = true;
  const raw = storage()?.getItem(STORAGE_KEY);
  if (!raw) return;
  try {
    for (const e of JSON.parse(raw) as PrintLedgerEntry[]) memory.set(e.key, e);
  } catch {
    // Ledger corrompido: começa vazio (nada é reimpresso sem pedido explícito).
  }
}

function persist() {
  const entries = [...memory.values()].sort((a, b) => a.updated_at.localeCompare(b.updated_at)).slice(-MAX_ENTRIES);
  memory.clear();
  for (const e of entries) memory.set(e.key, e);
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Sem espaço/privado: fica só em memória.
  }
}

export function printLedgerGet(key: string): PrintLedgerEntry | null {
  load();
  return memory.get(key) ?? null;
}

export function printLedgerMark(key: string, state: PrintLedgerState) {
  load();
  memory.set(key, { key, state, updated_at: new Date().toISOString() });
  persist();
}

/** Uso em testes. */
export function printLedgerReset() {
  memory.clear();
  loaded = true;
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // ignorado
  }
}
