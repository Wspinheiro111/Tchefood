/**
 * A nuvem está respondendo a este aparelho? navigator.onLine só diz se há rede: com Wi-Fi sem internet, DNS fora ou o
 * Supabase fora do ar ele continua true e nenhum pagamento passa. Aqui vale o que os pedidos à nuvem mostraram:
 * pedido sem resposta (queda, prazo vencido) ou 502/503/504 = sem nuvem; qualquer outra resposta HTTP = nuvem no ar.
 * O laço da sincronização (a cada 5 s), a verificação leve com o laço parado (probeCloudIfIdle, a cada 15 s sem
 * nenhum outro pedido) e a tela da Point passam por aqui, então o aviso aparece e some sozinho.
 */
import { useSyncExternalStore } from 'react';

let unreachable = false;
let lastContactAt = 0;
const listeners = new Set<() => void>();

function set(value: boolean): void {
  lastContactAt = Date.now();
  if (unreachable === value) return;
  unreachable = value;
  for (const l of listeners) l();
}

/** Chave da loja/sessão que um pedido serve: só a observação do pedido mais novo desta chave vale. */
export function cloudKey(session: { url: string; tenant_id: string }): string {
  return `${session.url}|${session.tenant_id}`;
}

export function cloudUnreachable(): boolean {
  return unreachable;
}

/** Quando um pedido à nuvem respondeu ou falhou pela última vez (ms; 0 = nunca). */
export function lastCloudContactAt(): number {
  return lastContactAt;
}

/** Só para os testes e para quem desconecta a loja: volta ao estado inicial. */
export function resetCloudReachability(): void {
  set(false);
  lastContactAt = 0;
  appliedSeq = startedSeq; // pedidos que já estavam no ar não valem mais
}

const GATEWAY_DOWN = new Set([502, 503, 504]);

// Pedidos terminam fora de ordem (e podem ser de outra loja, depois de uma troca de sessão): só vale a observação do
// pedido mais novo já visto, da loja de agora (auditoria #59 r5 P2-03).
let startedSeq = 0;
let appliedSeq = 0;
let currentKey = '';

function begin(key: string): number {
  if (key !== currentKey) {
    // Outra loja/sessão: o que a anterior viu não vale mais. Recomeça sem aviso até a primeira observação.
    currentKey = key;
    appliedSeq = startedSeq;
    if (unreachable) {
      unreachable = false;
      for (const l of listeners) l();
    }
  }
  startedSeq += 1;
  return startedSeq;
}

function observe(seq: number, key: string, value: boolean): void {
  if (key !== currentKey || seq < appliedSeq) return;
  appliedSeq = seq;
  set(value);
}

/**
 * Embrulha um fetch: cada resposta ou falha de rede atualiza o estado. O resultado passa adiante sem mudança.
 * `key` identifica a loja/sessão do pedido: a resposta de um pedido mais antigo, ou de outra loja, não sobrescreve a
 * observação mais nova.
 */
export function trackCloudReachability<A extends unknown[], R extends { status: number }>(fetchFn: (...args: A) => Promise<R>, key = ''): (...args: A) => Promise<R> {
  return async (...args: A) => {
    const seq = begin(key);
    let res: R;
    try {
      res = await fetchFn(...args);
    } catch (e) {
      observe(seq, key, true);
      throw e;
    }
    observe(seq, key, GATEWAY_DOWN.has(res.status));
    return res;
  };
}

export function useCloudUnreachable(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => unreachable,
    () => false,
  );
}
