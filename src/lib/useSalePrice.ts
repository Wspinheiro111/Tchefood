/** Preço de venda agora (cadastro + regra de horário), para exibir nas telas de pedido. */
import { useTcheStore } from '../store/useTcheStore';
import { useNow } from './useOnline';
import { effectivePrice } from './catalog';
import type { Product } from '../types';

export function useSalePrice(): (p: Pick<Product, 'id' | 'price'>) => number {
  const schedules = useTcheStore((s) => s.priceSchedules);
  // Re-renderiza a cada 15 s para o preço mostrado acompanhar o início/fim da regra de horário.
  // O preço cobrado é sempre o do store (addToTray), calculado na hora do lançamento.
  const now = useNow(15_000);
  return (p) => effectivePrice(p, schedules, new Date(Math.max(now, Date.now())));
}
