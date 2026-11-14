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
  /** Leituras do servidor em que a reserva não apareceu (para limpar registros de cobranças que caíram). */
  absent_count?: number;
  absent_first_at?: number;
  /** Termos da reserva pedida (o pagamento registrado com a chave precisa bater). Ausente em registros antigos. */
  terms?: ClaimTerms;
}

export interface ClaimTerms {
  method: string;
  acquirer: string;
  amount_cents: number;
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
  /**
   * A chamada da reserva ficou sem resposta: o servidor pode gravá-la depois. "Não existe" (TF005) não encerra;
   * só depois de 3 respostas "não existe" espaçadas por 2 min ou mais.
   */
  unknown_claim?: boolean;
  not_found_count?: number;
  not_found_first_at?: number;
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

const emptyLedger = (): Ledger => ({ inFlight: [], pendingReleases: [] });

/**
 * O registro como está guardado agora. Lido do armazenamento a cada uso (não de uma cópia desta aba): outra aba
 * pode ter gravado uma reserva no meio. Sem armazenamento: a cópia em memória desta aba.
 */
function load(): Ledger {
  const st = storage();
  if (!st) return (ledger ??= emptyLedger());
  try {
    const raw = st.getItem(STORAGE_KEY);
    const out = emptyLedger();
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Ledger>;
      out.inFlight = Array.isArray(parsed.inFlight) ? parsed.inFlight : [];
      out.pendingReleases = Array.isArray(parsed.pendingReleases) ? parsed.pendingReleases : [];
    }
    ledger = out;
    return out;
  } catch {
    // Conteúdo corrompido ou leitura bloqueada: a cópia em memória (o servidor ainda lista as reservas abertas).
    return (ledger ??= emptyLedger());
  }
}

/**
 * Lê, muda uma entrada e grava, no mesmo passo síncrono: nunca regrava o registro inteiro a partir de uma cópia
 * antiga desta aba (duas abas abertas não apagam o segredo uma da outra). Síncrono de propósito: a reserva é
 * gravada antes da chamada ao servidor, e navigator.locks só existe assíncrono.
 */
function mutate<T>(change: (l: Ledger) => T): T {
  const l = load();
  const out = change(l);
  ledger = l;
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(l));
  } catch {
    // Sem armazenamento: fica em memória enquanto o app estiver aberto.
  }
  return out;
}

/**
 * A reserva vai ser pedida; a cobrança vai começar. Gravado ANTES de chamar o servidor (com o segredo): se a
 * resposta se perder, o aparelho ainda consegue liberar a reserva que o servidor criou.
 */
export function beginLocalClaim(key: string, orderId: string, releaseToken: string | null = null, terms?: ClaimTerms): void {
  active.add(key);
  mutate((l) => {
    l.inFlight = [...l.inFlight.filter((c) => c.key !== key), { key, order_id: orderId, started_at: new Date().toISOString(), release_token: releaseToken, state: 'charging', ...(terms ? { terms } : {}) }];
  });
}

/** Fim conhecido (pago ou em conferência): o registro fica, com o segredo, até o servidor consumir ou liberar. */
export function settleLocalClaim(key: string): void {
  active.delete(key);
  mutate((l) => {
    l.inFlight = l.inFlight.map((c) => (c.key === key ? { ...c, state: 'settled' as const } : c));
  });
}

/** Todos os registros de reserva deste aparelho. */
export function inFlightClaims(): LocalClaim[] {
  return [...load().inFlight];
}

/**
 * Leitura do servidor sem a reserva (`nowMs`) ou com ela (null, zera a contagem). Devolve a contagem atual.
 */
export function markClaimAbsent(key: string, nowMs: number | null): { count: number; firstAt: number } | null {
  return mutate((l) => {
    let out: { count: number; firstAt: number } | null = null;
    l.inFlight = l.inFlight.map((c) => {
      if (c.key !== key) return c;
      if (nowMs === null) return { ...c, absent_count: 0, absent_first_at: undefined };
      const count = (c.absent_count ?? 0) + 1;
      const firstAt = c.absent_first_at ?? nowMs;
      out = { count, firstAt };
      return { ...c, absent_count: count, absent_first_at: firstAt };
    });
    return out as { count: number; firstAt: number } | null;
  });
}

/** Reservas terminadas aqui que aguardam o servidor (batimento e limpeza pelo laço de sincronização). */
export function settledClaims(): LocalClaim[] {
  return load().inFlight.filter((c) => c.state === 'settled');
}

/** A cobrança terminou (com qualquer resultado já tratado pela tela). */
export function endLocalClaim(key: string): void {
  active.delete(key);
  mutate((l) => {
    l.inFlight = l.inFlight.filter((c) => c.key !== key);
  });
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

export function addPendingRelease(
  p: Omit<PendingRelease, 'created_at' | 'last_error' | 'release_token' | 'final'> & { last_error?: string | null; release_token?: string | null; final?: boolean },
): void {
  mutate((l) => {
    const prev = l.pendingReleases.find((r) => r.key === p.key);
    l.pendingReleases = [
      ...l.pendingReleases.filter((r) => r.key !== p.key),
      {
        key: p.key, order_id: p.order_id, reason: p.reason, created_at: prev?.created_at ?? new Date().toISOString(), last_error: p.last_error ?? null,
        release_token: p.release_token ?? prev?.release_token ?? null,
        final: Boolean(p.final),
        ...((p.unknown_claim ?? prev?.unknown_claim) ? { unknown_claim: true } : {}),
        ...(p.not_found_count !== undefined ? { not_found_count: p.not_found_count, not_found_first_at: p.not_found_first_at } : prev?.not_found_count !== undefined ? { not_found_count: prev.not_found_count, not_found_first_at: prev.not_found_first_at } : {}),
      },
    ];
  });
}

export function removePendingRelease(key: string): void {
  mutate((l) => {
    l.pendingReleases = l.pendingReleases.filter((r) => r.key !== key);
  });
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
  ledger = emptyLedger();
  mutate((l) => {
    l.inFlight = [];
    l.pendingReleases = [];
  });
}
