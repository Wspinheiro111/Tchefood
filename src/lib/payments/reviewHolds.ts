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
