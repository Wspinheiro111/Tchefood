import { describe, expect, it } from 'vitest';
import { parsePdvQuery, searchProducts } from '../lib/pdvSearch';
import type { Product } from '../types';

const p = (code: string, name: string, extra: Partial<Product> = {}) => ({ id: code, code, name, available: true, barcode: null, ...extra }) as Product;
const menu = [
  p('101', 'Picanha na Chapa'),
  p('102', 'Picanha Fatiada'),
  p('1010', 'Costela'),
  p('201', 'Chopp Pilsen 300ml'),
  p('311', 'Água sem gás', { barcode: '7891234567890' }),
  p('312', 'Pão de alho', { available: false }),
];

describe('busca do PDV', () => {
  it('quantidade na frente: 3*101, 2x201; sem ela é 1', () => {
    expect(parsePdvQuery('3*101')).toEqual({ qty: 3, term: '101' });
    expect(parsePdvQuery('2x chopp')).toEqual({ qty: 2, term: 'chopp' });
    expect(parsePdvQuery('picanha')).toEqual({ qty: 1, term: 'picanha' });
    expect(parsePdvQuery('0*101')).toEqual({ qty: 1, term: '0*101' });
  });

  it('código exato vem primeiro, depois o que começa com o código', () => {
    expect(searchProducts(menu, '101').map((x) => x.code)).toEqual(['101', '1010']);
  });

  it('nome sem acento e por começo de palavra', () => {
    expect(searchProducts(menu, 'agua').map((x) => x.code)).toEqual(['311']);
    expect(searchProducts(menu, 'pic fat').map((x) => x.code)).toEqual(['102']);
    // Empate: ordem alfabética.
    expect(searchProducts(menu, 'picanha').map((x) => x.code)).toEqual(['102', '101']);
  });

  it('código de barras lido pelo leitor', () => {
    expect(searchProducts(menu, '7891234567890')[0]!.code).toBe('311');
  });

  it('em falta vai para o fim; vazio não busca', () => {
    expect(searchProducts([p('9', 'Pão francês', { available: false }), p('8', 'Pão de queijo')], 'pao').map((x) => x.code)).toEqual(['8', '9']);
    expect(searchProducts(menu, '  ')).toEqual([]);
  });
});
