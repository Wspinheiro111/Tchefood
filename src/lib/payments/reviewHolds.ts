/**
 * Cobranças com resultado incerto (MANUAL_REVIEW) por comanda. Persistidas
 * fora da tela de fechamento: sair e voltar ao caixa, ou recarregar o app,
 * não libera nova cobrança na maquininha. Só a conferência explícita do
 * operador (clearReviewHold) remove a trava.
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
  acquirer?: 'STONE' | 'PAGBANK';
  terminal_id?: string | null;
  terminal_serial?: string | null;
  /** Mesma chave da cobrança enviada à maquininha: o registro manual nunca duplica. */
  idempotency_key?: string;
  /** Mesa "por item consumido": itens que a cobrança incerta quitaria. */
  item_ids?: string[];
}

const STORAGE_KEY = 'tchefood.paymentReviewHolds.v1';
const memory = new Map<string, ReviewHold>();
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
    for (const h of JSON.parse(raw) as ReviewHold[]) memory.set(h.order_id, h);
  } catch {
    // Ignora conteúdo corrompido.
  }
}

function persist() {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify([...memory.values()]));
  } catch {
    // Sem armazenamento: a trava continua em memória enquanto o app estiver aberto.
  }
}

export function getReviewHold(orderId: string): ReviewHold | null {
  load();
  return memory.get(orderId) ?? null;
}

export function setReviewHold(hold: Omit<ReviewHold, 'created_at'>): ReviewHold {
  load();
  const full = { ...hold, created_at: new Date().toISOString() };
  memory.set(hold.order_id, full);
  persist();
  return full;
}

export function clearReviewHold(orderId: string) {
  load();
  memory.delete(orderId);
  persist();
}
