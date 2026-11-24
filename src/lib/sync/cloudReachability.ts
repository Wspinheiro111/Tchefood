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

export function cloudUnreachable(): boolean {
  return unreachable;
}

/** Quando um pedido à nuvem respondeu ou falhou pela última vez (ms; 0 = nunca). */
export function lastCloudContactAt(): number {
  return lastContactAt;
}

/**
 * A conexão da loja que o monitor serve (auditoria #59 r6 P2-01). O número muda, de forma síncrona, quando a loja
 * conectada no aparelho (url + loja) muda ou o aparelho desconecta e conecta de novo (useTcheStore, ver o fim de
 * src/store/useTcheStore.ts). Renovar o token não muda. Todo pedido leva o número da conexão em que foi montado: o que
 * ele observar só vale enquanto esse número for o de agora.
 */
let generation = 0;

/** Número da conexão atual: quem monta um pedido à nuvem guarda este número junto com a sessão que vai usar. */
export function cloudGeneration(): number {
  return generation;
}

/**
 * A conexão da loja mudou (ou acabou): o que a anterior viu não vale mais, nem o horário do último contato dela.
 * Recomeça sem aviso até a primeira observação da conexão nova.
 */
export function cloudConnectionChanged(): void {
  generation += 1;
  appliedSeq = startedSeq; // pedidos que já estavam no ar não valem mais
  lastContactAt = 0;
  if (unreachable) {
    unreachable = false;
    for (const l of listeners) l();
  }
}

/** Só para os testes: volta ao estado inicial, de uma conexão nova. */
export function resetCloudReachability(): void {
  cloudConnectionChanged();
}

const GATEWAY_DOWN = new Set([502, 503, 504]);

// Pedidos terminam fora de ordem (e podem ser de outra loja ou de outra conexão): só vale a observação do pedido mais
// novo já visto, da conexão de agora (auditoria #59 r5 P2-03 e r6 P2-01).
let startedSeq = 0;
let appliedSeq = 0;

function observe(seq: number, gen: number, value: boolean): void {
  if (gen !== generation || seq < appliedSeq) return;
  appliedSeq = seq;
  set(value);
}

/**
 * Embrulha um fetch: cada resposta ou falha de rede atualiza o estado. O resultado passa adiante sem mudança.
 * `gen` é a conexão em que o pedido foi montado (cloudGeneration() lido junto com a sessão): a resposta de um pedido
 * mais antigo, de outra loja ou de uma conexão que já acabou não sobrescreve a observação mais nova, e um fluxo
 * atrasado da loja anterior não volta a ser a loja atual.
 */
export function trackCloudReachability<A extends unknown[], R extends { status: number }>(fetchFn: (...args: A) => Promise<R>, gen: number = generation): (...args: A) => Promise<R> {
  return async (...args: A) => {
    startedSeq += 1;
    const seq = startedSeq;
    let res: R;
    try {
      res = await fetchFn(...args);
    } catch (e) {
      observe(seq, gen, true);
      throw e;
    }
    observe(seq, gen, GATEWAY_DOWN.has(res.status));
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
