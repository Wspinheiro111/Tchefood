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

/**
 * 'none': ambiente sem localStorage (fora do navegador): o registro vive só na memória, como sempre foi.
 * 'blocked': o navegador tem o armazenamento, mas o acesso falha. 'ok': lê e grava.
 */
type Access = { kind: 'none' } | { kind: 'blocked' } | { kind: 'ok'; st: Storage };

function access(): Access {
  try {
    return typeof localStorage === 'undefined' ? { kind: 'none' } : { kind: 'ok', st: localStorage };
  } catch {
    return { kind: 'blocked' };
  }
}

const emptyLedger = (): Ledger => ({ inFlight: [], pendingReleases: [] });

/**
 * Entradas que esta aba mudou e não conseguiu gravar (armazenamento cheio, Safari privado antigo): valem por cima
 * do que for lido, e cada nova mudança tenta gravá-las de novo. null = apagada aqui.
 */
const unsavedClaims = new Map<string, LocalClaim | null>();
const unsavedReleases = new Map<string, PendingRelease | null>();

function overlay<T extends { key: string }>(list: T[], unsaved: Map<string, T | null>): T[] {
  if (unsaved.size === 0) return list;
  const out = list.filter((x) => !unsaved.has(x.key));
  for (const v of unsaved.values()) if (v) out.push(v);
  return out;
}

/**
 * O registro como está guardado agora, com as mudanças desta aba que não foram gravadas por cima. Lido do
 * armazenamento a cada uso (não de uma cópia desta aba): outra aba pode ter gravado uma reserva no meio.
 * Fora do navegador: a cópia em memória.
 */
function load(): Ledger {
  const a = access();
  if (a.kind === 'none') return (ledger ??= emptyLedger());
  let base = emptyLedger();
  if (a.kind === 'ok') {
    try {
      const raw = a.st.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<Ledger>;
        base.inFlight = Array.isArray(parsed.inFlight) ? parsed.inFlight : [];
        base.pendingReleases = Array.isArray(parsed.pendingReleases) ? parsed.pendingReleases : [];
      }
    } catch {
      // Conteúdo corrompido ou leitura bloqueada: a última leitura (o servidor ainda lista as reservas abertas).
      base = ledger ? { inFlight: [...ledger.inFlight], pendingReleases: [...ledger.pendingReleases] } : emptyLedger();
    }
  }
  const out = { inFlight: overlay(base.inFlight, unsavedClaims), pendingReleases: overlay(base.pendingReleases, unsavedReleases) };
  ledger = out;
  return out;
}

function byKey<T extends { key: string }>(list: T[]): Map<string, string> {
  return new Map(list.map((x) => [x.key, JSON.stringify(x)]));
}

function noteChanges<T extends { key: string }>(before: Map<string, string>, after: T[], unsaved: Map<string, T | null>) {
  const now = new Map(after.map((x) => [x.key, x]));
  for (const [k, v] of now) if (before.get(k) !== JSON.stringify(v)) unsaved.set(k, v);
  for (const k of before.keys()) if (!now.has(k)) unsaved.set(k, null);
}

/**
 * Lê, muda uma entrada e grava, no mesmo passo síncrono: nunca regrava o registro inteiro a partir de uma cópia
 * antiga desta aba (duas abas abertas não apagam o segredo uma da outra). Síncrono de propósito: a reserva é
 * gravada antes da chamada ao servidor, e navigator.locks só existe assíncrono.
 * Gravação que falha: a mudança fica por cima do que for lido (unsaved*) e a próxima mudança tenta de novo.
 * Devolve se ficou gravado (fora do navegador, sempre true: não há onde gravar).
 */
function mutate<T>(change: (l: Ledger) => T): { value: T; durable: boolean } {
  const l = load();
  const beforeClaims = byKey(l.inFlight);
  const beforeReleases = byKey(l.pendingReleases);
  const value = change(l);
  ledger = l;
  const a = access();
  if (a.kind === 'none') return { value, durable: true };
  noteChanges(beforeClaims, l.inFlight, unsavedClaims);
  noteChanges(beforeReleases, l.pendingReleases, unsavedReleases);
  if (a.kind === 'ok') {
    try {
      a.st.setItem(STORAGE_KEY, JSON.stringify(l));
      unsavedClaims.clear();
      unsavedReleases.clear();
      return { value, durable: true };
    } catch {
      // Cheio ou bloqueado: fica por cima, em memória, e tenta de novo na próxima mudança.
    }
  }
  return { value, durable: false };
}

/**
 * Desfaz a mudança não gravada desta reserva (volta ao que está guardado). Para a reserva nova que não pôde ser
 * gravada: nada foi pedido ao servidor, e um registro anterior com a mesma chave (gravado) continua valendo.
 */
export function forgetUnsavedClaim(key: string): void {
  unsavedClaims.delete(key);
  active.delete(key);
  if (access().kind !== 'none') load();
}

/** Há mudança do registro de reservas que não foi gravada neste aparelho. */
export function claimLedgerUnsaved(): boolean {
  return unsavedClaims.size > 0 || unsavedReleases.size > 0;
}

/**
 * A reserva vai ser pedida; a cobrança vai começar. Gravado ANTES de chamar o servidor (com o segredo): se a
 * resposta se perder, o aparelho ainda consegue liberar a reserva que o servidor criou.
 * Devolve false quando não ficou gravado no aparelho (cheio ou bloqueado): quem chama não pede a reserva.
 */
export function beginLocalClaim(key: string, orderId: string, releaseToken: string | null = null, terms?: ClaimTerms): boolean {
  active.add(key);
  return mutate((l) => {
    l.inFlight = [...l.inFlight.filter((c) => c.key !== key), { key, order_id: orderId, started_at: new Date().toISOString(), release_token: releaseToken, state: 'charging', ...(terms ? { terms } : {}) }];
  }).durable;
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
  }).value;
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
  unsavedClaims.clear();
  unsavedReleases.clear();
  ledger = emptyLedger();
  mutate((l) => {
    l.inFlight = [];
    l.pendingReleases = [];
  });
}
