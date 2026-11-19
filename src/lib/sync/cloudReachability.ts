/**
 * A nuvem está respondendo a este aparelho? navigator.onLine só diz se há rede: com Wi-Fi sem internet, DNS fora ou o
 * Supabase fora do ar ele continua true e nenhum pagamento passa. Aqui vale o que os pedidos à nuvem mostraram:
 * pedido sem resposta (queda, prazo vencido) ou 502/503/504 = sem nuvem; qualquer outra resposta HTTP = nuvem no ar.
 * O laço da sincronização (a cada 5 s) e a tela da Point passam por aqui, então o aviso aparece e some sozinho.
 */
import { useSyncExternalStore } from 'react';

let unreachable = false;
const listeners = new Set<() => void>();

function set(value: boolean): void {
  if (unreachable === value) return;
  unreachable = value;
  for (const l of listeners) l();
}

export function cloudUnreachable(): boolean {
  return unreachable;
}

/** Só para os testes e para quem desconecta a loja: volta ao estado inicial. */
export function resetCloudReachability(): void {
  set(false);
}

const GATEWAY_DOWN = new Set([502, 503, 504]);

/** Embrulha um fetch: cada resposta ou falha de rede atualiza o estado. O resultado passa adiante sem mudança. */
export function trackCloudReachability<A extends unknown[], R extends { status: number }>(fetchFn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return async (...args: A) => {
    let res: R;
    try {
      res = await fetchFn(...args);
    } catch (e) {
      set(true);
      throw e;
    }
    set(GATEWAY_DOWN.has(res.status));
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
