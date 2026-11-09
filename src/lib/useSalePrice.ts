/** Preço de venda agora (cadastro + regra de horário), para exibir nas telas de pedido. */
import { useTcheStore } from '../store/useTcheStore';
import { effectivePrice } from './catalog';
import type { Product } from '../types';

export function useSalePrice(): (p: Pick<Product, 'id' | 'price'>) => number {
  const schedules = useTcheStore((s) => s.priceSchedules);
  return (p) => effectivePrice(p, schedules, new Date());
}
