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

const STORAGE_KEY = 'tchefood.paymentReviewHolds.v2';
/** Formato antigo: uma trava por comanda (migrado na primeira leitura). */
const LEGACY_KEY = 'tchefood.paymentReviewHolds.v1';
const memory = new Map<string, ReviewHold>();
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

function load() {
  if (loaded) return;
  loaded = true;
  const read = (key: string) => {
    try {
      const raw = storage()?.getItem(key);
      const list = raw ? (JSON.parse(raw) as unknown) : [];
      return Array.isArray(list) ? (list as ReviewHold[]).filter((h) => h && typeof h.order_id === 'string') : [];
    } catch {
      // Ignora conteúdo corrompido.
      return [];
    }
  };
  for (const h of read(STORAGE_KEY)) memory.set(reviewHoldKey(h), h);
  const legacy = read(LEGACY_KEY);
  for (const h of legacy) if (!memory.has(reviewHoldKey(h))) memory.set(reviewHoldKey(h), h);
  // A versão antiga só sai depois que a nova foi gravada (sem isso a trava se perderia ao reabrir o app).
  if (legacy.length > 0 && !persist()) return;
  try {
    storage()?.removeItem(LEGACY_KEY);
  } catch {
    // Sem armazenamento.
  }
}

/** true = gravado. */
function persist(): boolean {
  try {
    const st = storage();
    if (!st) return false;
    st.setItem(STORAGE_KEY, JSON.stringify([...memory.values()]));
    return true;
  } catch {
    // Sem armazenamento: a trava continua em memória enquanto o app estiver aberto.
    return false;
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
  persist();
  notify(hold.order_id);
  return full;
}

/**
 * Tira a trava do pagamento `key` (reviewHoldKey). Sem `key`: tira todas as travas da comanda (só para
 * limpeza e testes; as telas sempre dizem qual trava resolveram).
 */
export function clearReviewHold(orderId: string, key?: string) {
  load();
  if (key !== undefined) {
    const h = memory.get(key);
    if (h && h.order_id === orderId) memory.delete(key);
  } else {
    for (const [k, h] of memory) if (h.order_id === orderId) memory.delete(k);
  }
  persist();
  notify(orderId);
}
