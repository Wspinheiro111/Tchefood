/**
 * Cobranças com resultado incerto (MANUAL_REVIEW) por comanda. Persistidas
 * fora da tela de fechamento: sair e voltar ao caixa, ou recarregar o app,
 * não libera nova cobrança na maquininha. Só a conferência explícita do
 * operador (clearReviewHold) remove a trava.
 *
 * Uma trava por PAGAMENTO (chave do pagamento), várias por comanda (r7 P1/P2-D):
 * qualquer trava da comanda bloqueia; tirar uma nunca tira outra. Travas antigas
 * (uma por comanda, sem chave) são migradas e ficam com a chave "order:<id>".
 */
export interface ReviewHold {
  order_id: string;
  amount: number;
  reason: string;
  code: string;
  created_at: string;
  /**
   * Contexto da cobrança incerta, para o gerente registrar a aprovação que a
   * maquininha mostrou sem cobrar de novo. Opcional: travas gravadas antes
   * desta versão não têm esses campos e o gerente informa forma e adquirente.
   */
  method?: 'CREDIT' | 'DEBIT' | 'PIX';
  acquirer?: 'STONE' | 'PAGBANK' | 'MERCADO_PAGO';
  terminal_id?: string | null;
  terminal_serial?: string | null;
  /** Mesma chave da cobrança enviada à maquininha: o registro manual nunca duplica. */
  idempotency_key?: string;
  /** Mesa "por item consumido": itens que a cobrança incerta quitaria. */
  item_ids?: string[];
  /**
   * Trava de pagamento que não entrou no servidor (CLAIM_RELEASED / PAYMENT_REJECTED): como devolver ao
   * cliente. 'CASH' = devolver o dinheiro; ausente ou 'TERMINAL' = estornar na maquininha.
   */
  refund?: 'TERMINAL' | 'CASH';
  /** ACQUIRER_MISMATCH: chave nova da reserva trocada para a adquirente real (o segredo fica no claimLedger). */
  reclaim_key?: string;
}

/** Chave da trava: a do pagamento; sem ela (versões antigas), a da comanda. */
export function reviewHoldKey(h: Pick<ReviewHold, 'order_id' | 'idempotency_key'>): string {
  return h.idempotency_key ?? `order:${h.order_id}`;
}

/** Adquirente gravado na trava: Mercado Pago e PagBank pelo nome; o resto como antes (Stone). */
export function holdAcquirer(acquirer: string): 'STONE' | 'PAGBANK' | 'MERCADO_PAGO' {
  return acquirer === 'PAGBANK' || acquirer === 'MERCADO_PAGO' ? acquirer : 'STONE';
}

/**
 * Uma chave do localStorage por trava (auditoria GPT r10, "a verificar 1"): ler a lista inteira, mudar e regravar
 * numa chave só não é atômico entre abas (duas abas gravando juntas, a última apagava a trava da outra). Com uma
 * chave por trava, cada gravação só troca a própria trava.
 */
const PREFIX = 'tchefood.paymentReviewHolds.v3:';
/** Formatos anteriores: a lista inteira numa chave (v2) e uma trava por comanda (v1). Migrados na leitura. */
const LEGACY_LIST_KEY = 'tchefood.paymentReviewHolds.v2';
const LEGACY_KEY = 'tchefood.paymentReviewHolds.v1';
const memory = new Map<string, ReviewHold>();
/**
 * Travas que esta aba mudou e não conseguiu gravar (armazenamento cheio, Safari privado antigo): valem por cima do
 * que for lido, e cada nova mudança tenta gravar de novo. null = tirada aqui.
 */
const unsaved = new Map<string, ReviewHold | null>();
let loaded = false;
const listeners = new Set<(orderId: string) => void>();

/** Avisa a tela quando uma trava muda fora dela (ex.: reserva liberada antes do pagamento chegar ao servidor). */
export function subscribeReviewHolds(fn: (orderId: string) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function notify(orderId: string) {
  for (const fn of [...listeners]) {
    try {
      fn(orderId);
    } catch {
      // Uma tela com erro não impede as outras.
    }
  }
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

const isHold = (h: unknown): h is ReviewHold => typeof h === 'object' && h !== null && typeof (h as ReviewHold).order_id === 'string';

/** Lista no formato antigo (v1/v2). null = leitura bloqueada ou conteúdo corrompido. */
function readList(key: string): ReviewHold[] | null {
  try {
    const st = storage();
    if (!st) return null;
    const raw = st.getItem(key);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter(isHold) : [];
  } catch {
    return null;
  }
}

/** As travas gravadas (uma chave cada). null = leitura bloqueada: fica com a cópia em memória. */
function readStored(): Map<string, ReviewHold> | null {
  const st = storage();
  if (!st) return null;
  try {
    const out = new Map<string, ReviewHold>();
    const keys: string[] = [];
    for (let i = 0; i < st.length; i++) {
      const k = st.key(i);
      if (k && k.startsWith(PREFIX)) keys.push(k);
    }
    for (const k of keys) {
      const key = k.slice(PREFIX.length);
      const raw = st.getItem(k);
      if (raw === null) continue; // outra aba tirou entre a lista e a leitura
      let h: unknown = null;
      try {
        h = JSON.parse(raw);
      } catch {
        h = null;
      }
      // Corrompida: a cópia da última leitura (se houver).
      const v = isHold(h) && reviewHoldKey(h) === key ? h : memory.get(key);
      if (v) out.set(key, v);
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Atualiza a cópia em memória com o que está guardado agora (outra aba pode ter gravado uma trava). Lido a cada
 * uso; cada mudança grava só a trava que mudou, na própria chave.
 */
function load() {
  const stored = readStored();
  if (stored) {
    memory.clear();
    for (const [k, h] of stored) memory.set(k, h);
    for (const [k, h] of unsaved) {
      if (h) memory.set(k, h);
      else memory.delete(k);
    }
    migrateLegacy(LEGACY_LIST_KEY);
  }
  if (loaded) return;
  loaded = true;
  listenOtherTabs();
  migrateLegacy(LEGACY_KEY);
}

/**
 * Travas no formato antigo (também as de uma aba que ainda roda a versão anterior): cada uma que não existe no
 * formato novo é gravada nele; a chave antiga só sai depois que todas foram gravadas (sem isso a trava se perderia
 * ao reabrir o app).
 */
function migrateLegacy(legacyKey: string) {
  try {
    if (storage()?.getItem(legacyKey) == null) return;
  } catch {
    return;
  }
  const legacy = readList(legacyKey);
  if (!legacy || legacy.length === 0) {
    if (legacy) {
      try {
        storage()?.removeItem(legacyKey);
      } catch {
        // Sem armazenamento.
      }
    }
    return;
  }
  const migrated: Array<[string, ReviewHold]> = [];
  for (const h of legacy) {
    const k = reviewHoldKey(h);
    if (memory.has(k) || unsaved.has(k)) continue;
    memory.set(k, h);
    migrated.push([k, h]);
  }
  if (!persist(migrated)) return;
  try {
    storage()?.removeItem(legacyKey);
  } catch {
    // Sem armazenamento.
  }
}

/** Outra aba mudou as travas: a tela desta aba se atualiza. */
function listenOtherTabs() {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  window.addEventListener('storage', (e) => {
    if (e.key !== null && !e.key.startsWith(PREFIX) && e.key !== LEGACY_LIST_KEY) return;
    const before = new Set([...memory.values()].map((h) => h.order_id));
    load();
    for (const h of memory.values()) before.add(h.order_id);
    for (const orderId of before) notify(orderId);
  });
}

/**
 * Grava as travas mudadas agora (`changed`) e as que ficaram sem gravar antes, cada uma na própria chave.
 * true = as mudadas agora ficaram gravadas (as que falham ficam por cima, em memória, e a próxima mudança tenta).
 */
function persist(changed: Array<[string, ReviewHold | null]> = []): boolean {
  for (const [k, h] of changed) unsaved.set(k, h);
  const st = storage();
  if (!st) return false;
  for (const [k, h] of [...unsaved]) {
    try {
      if (h) st.setItem(PREFIX + k, JSON.stringify(h));
      else st.removeItem(PREFIX + k);
      unsaved.delete(k);
    } catch {
      // Cheio ou bloqueado: a trava continua em memória (por cima do que for lido) e a próxima mudança tenta de novo.
    }
  }
  return changed.every(([k]) => !unsaved.has(k));
}

/** Contas com trava não gravada neste aparelho (para o aviso dizer quais). */
export function unsavedReviewHoldOrders(): string[] {
  if (!reviewHoldsUnsaved()) return [];
  const ids = new Set<string>();
  for (const [k, h] of unsaved) {
    const order = h?.order_id ?? memory.get(k)?.order_id;
    if (order) ids.add(order);
  }
  return [...ids];
}

/**
 * Há trava que não ficou gravada neste aparelho (some se o app fechar): a tela mostra um aviso fixo até gravar.
 * Fora do navegador (sem localStorage) não há onde gravar: não conta.
 */
export function reviewHoldsUnsaved(): boolean {
  if (unsaved.size === 0) return false;
  try {
    return typeof localStorage !== 'undefined';
  } catch {
    // Acesso bloqueado (SecurityError): o navegador tem o armazenamento e a trava não ficou gravada.
    return true;
  }
}

/** Todas as travas da comanda, da mais antiga para a mais nova. */
export function getReviewHolds(orderId: string): ReviewHold[] {
  load();
  return [...memory.values()].filter((h) => h.order_id === orderId).sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/** A trava da comanda mostrada agora (a mais antiga); resolvida, aparece a próxima. null = nenhuma. */
export function getReviewHold(orderId: string): ReviewHold | null {
  return getReviewHolds(orderId)[0] ?? null;
}

/** A trava do pagamento com esta chave. */
export function getReviewHoldByKey(key: string): ReviewHold | null {
  load();
  return memory.get(key) ?? null;
}

/** Grava (ou troca) a trava DESTE pagamento; as outras travas da comanda ficam. */
export function setReviewHold(hold: Omit<ReviewHold, 'created_at'> & { created_at?: string }): ReviewHold {
  load();
  const key = reviewHoldKey(hold);
  const prev = memory.get(key);
  const full = { ...hold, created_at: prev?.created_at ?? new Date().toISOString() };
  memory.set(key, full);
  persist([[key, full]]);
  notify(hold.order_id);
  return full;
}

/**
 * Tira a trava do pagamento `key` (reviewHoldKey). Sem `key`: tira todas as travas da comanda (só para
 * limpeza e testes; as telas sempre dizem qual trava resolveram).
 */
export function clearReviewHold(orderId: string, key?: string) {
  load();
  const removed: Array<[string, null]> = [];
  if (key !== undefined) {
    const h = memory.get(key);
    if (h && h.order_id === orderId) {
      memory.delete(key);
      removed.push([key, null]);
    }
  } else {
    for (const [k, h] of memory) {
      if (h.order_id === orderId) {
        memory.delete(k);
        removed.push([k, null]);
      }
    }
  }
  persist(removed);
  notify(orderId);
}
