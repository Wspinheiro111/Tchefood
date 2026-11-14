/**
 * Reservas de pagamento (payment_claims) do ponto de vista deste aparelho, guardadas fora da tela:
 *  - em andamento AQUI agora (memória): a tela não oferece "Liberar reserva" para a cobrança que ela mesma
 *    está fazendo;
 *  - tomadas e ainda sem fim conhecido (persistido): reserva feita e o app caiu antes de terminar a cobrança.
 *    A reserva aparece na lista de reservas presas (vinda do servidor) com o aviso de que foi este aparelho;
 *  - liberação pendente (persistido): a maquininha recusou, mas a liberação não chegou ao servidor. O laço
 *    de sincronização tenta de novo; até lá a reserva aparece na lista para o gerente.
 *  - cobrança terminada aguardando o servidor (persistido, estado 'settled'): o pagamento foi registrado aqui
 *    e a reserva precisa continuar viva (batimento pelo laço de sincronização) até o servidor consumi-la.
 *
 * O segredo da reserva (release_token) é gerado AQUI, gravado antes de chamar o servidor e nunca mostrado.
 */
export interface LocalClaim {
  key: string;
  order_id: string;
  started_at: string;
  /** Segredo da reserva (32 bytes em hex). Ausente em registros de versões anteriores. */
  release_token?: string | null;
  /** 'charging': cobrança em andamento (ou o app caiu no meio). 'settled': fim conhecido, aguardando o servidor. */
  state?: 'charging' | 'settled';
}

/** Segredo novo da reserva: 32 bytes aleatórios em hex (64 caracteres). */
export function generateReleaseToken(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface PendingRelease {
  key: string;
  order_id: string;
  reason: string;
  created_at: string;
  last_error: string | null;
  /** Segredo da reserva para liberar sem PIN (nunca mostrado). null = só o gerente libera. */
  release_token: string | null;
  /** O servidor recusou de vez (ou falta o segredo): não tenta mais sozinho; só o gerente libera. */
  final?: boolean;
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

/**
 * A reserva vai ser pedida; a cobrança vai começar. Gravado ANTES de chamar o servidor (com o segredo): se a
 * resposta se perder, o aparelho ainda consegue liberar a reserva que o servidor criou.
 */
export function beginLocalClaim(key: string, orderId: string, releaseToken: string | null = null): void {
  const l = load();
  active.add(key);
  l.inFlight = [...l.inFlight.filter((c) => c.key !== key), { key, order_id: orderId, started_at: new Date().toISOString(), release_token: releaseToken, state: 'charging' }];
  persist();
}

/** Fim conhecido (pago ou em conferência): o registro fica, com o segredo, até o servidor consumir ou liberar. */
export function settleLocalClaim(key: string): void {
  const l = load();
  active.delete(key);
  l.inFlight = l.inFlight.map((c) => (c.key === key ? { ...c, state: 'settled' as const } : c));
  persist();
}

/** Reservas terminadas aqui que aguardam o servidor (batimento e limpeza pelo laço de sincronização). */
export function settledClaims(): LocalClaim[] {
  return load().inFlight.filter((c) => c.state === 'settled');
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

export function addPendingRelease(p: Omit<PendingRelease, 'created_at' | 'last_error' | 'release_token' | 'final'> & { last_error?: string | null; release_token?: string | null; final?: boolean }): void {
  const l = load();
  const prev = l.pendingReleases.find((r) => r.key === p.key);
  l.pendingReleases = [
    ...l.pendingReleases.filter((r) => r.key !== p.key),
    {
      key: p.key, order_id: p.order_id, reason: p.reason, created_at: prev?.created_at ?? new Date().toISOString(), last_error: p.last_error ?? null,
      release_token: p.release_token ?? prev?.release_token ?? null,
      final: Boolean(p.final),
    },
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
