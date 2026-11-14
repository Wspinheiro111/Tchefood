/**
 * Reservas de pagamento (payment_claims) do ponto de vista deste aparelho, guardadas fora da tela:
 *  - em andamento AQUI agora (memória): a tela não oferece "Liberar reserva" para a cobrança que ela mesma
 *    está fazendo;
 *  - tomadas e ainda sem fim conhecido (persistido): reserva feita e o app caiu antes de terminar a cobrança.
 *    A reserva aparece na lista de reservas presas (vinda do servidor) com o aviso de que foi este aparelho;
 *  - liberação pendente (persistido): a maquininha recusou, mas a liberação não chegou ao servidor. O laço
 *    de sincronização tenta de novo; até lá a reserva aparece na lista para o gerente.
 */
export interface LocalClaim {
  key: string;
  order_id: string;
  started_at: string;
}

export interface PendingRelease {
  key: string;
  order_id: string;
  reason: string;
  created_at: string;
  last_error: string | null;
}

interface Ledger {
  inFlight: LocalClaim[];
  pendingReleases: PendingRelease[];
}

const STORAGE_KEY = 'tchefood.paymentClaims.v1';
const active = new Set<string>();
let ledger: Ledger | null = null;

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function load(): Ledger {
  if (ledger) return ledger;
  ledger = { inFlight: [], pendingReleases: [] };
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Ledger>;
      ledger.inFlight = Array.isArray(parsed.inFlight) ? parsed.inFlight : [];
      ledger.pendingReleases = Array.isArray(parsed.pendingReleases) ? parsed.pendingReleases : [];
    }
  } catch {
    // Conteúdo corrompido: começa vazio (o servidor ainda lista as reservas abertas).
  }
  return ledger;
}

function persist() {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(load()));
  } catch {
    // Sem armazenamento: fica em memória enquanto o app estiver aberto.
  }
}

/** Reserva feita; a cobrança vai começar. Gravado antes de mandar para a maquininha ou registrar o dinheiro. */
export function beginLocalClaim(key: string, orderId: string): void {
  const l = load();
  active.add(key);
  l.inFlight = [...l.inFlight.filter((c) => c.key !== key), { key, order_id: orderId, started_at: new Date().toISOString() }];
  persist();
}

/** A cobrança terminou (com qualquer resultado já tratado pela tela). */
export function endLocalClaim(key: string): void {
  const l = load();
  active.delete(key);
  l.inFlight = l.inFlight.filter((c) => c.key !== key);
  persist();
}

/**
 * A tela saiu sem saber o fim (erro inesperado no meio): a cobrança deixa de contar como "rodando aqui", mas o
 * registro persistido fica, e a reserva aparece na lista de presas com o aviso de que foi este aparelho.
 */
export function detachLocalClaim(key: string): void {
  active.delete(key);
}

/** A cobrança desta chave está rodando neste aparelho agora. */
export function isClaimActiveHere(key: string): boolean {
  return active.has(key);
}

/** Reserva que este aparelho tomou e não viu terminar (app caiu no meio). */
export function localClaim(key: string): LocalClaim | null {
  return load().inFlight.find((c) => c.key === key) ?? null;
}

export function addPendingRelease(p: Omit<PendingRelease, 'created_at' | 'last_error'> & { last_error?: string | null }): void {
  const l = load();
  const prev = l.pendingReleases.find((r) => r.key === p.key);
  l.pendingReleases = [
    ...l.pendingReleases.filter((r) => r.key !== p.key),
    { key: p.key, order_id: p.order_id, reason: p.reason, created_at: prev?.created_at ?? new Date().toISOString(), last_error: p.last_error ?? null },
  ];
  persist();
}

export function removePendingRelease(key: string): void {
  const l = load();
  l.pendingReleases = l.pendingReleases.filter((r) => r.key !== key);
  persist();
}

export function pendingReleases(): PendingRelease[] {
  return [...load().pendingReleases];
}

export function pendingRelease(key: string): PendingRelease | null {
  return load().pendingReleases.find((r) => r.key === key) ?? null;
}

/** Só para testes. */
export function resetClaimLedger(): void {
  active.clear();
  ledger = { inFlight: [], pendingReleases: [] };
  persist();
}
