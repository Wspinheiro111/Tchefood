/**
 * Busca do PDV por teclado: o caixa digita parte do nome, o código do cardápio ou
 * lê o código de barras, e o Enter lança o primeiro resultado.
 * "3*101" (ou "3x101") lança 3 unidades do código 101.
 */
import type { Product } from '../types';

export const PDV_MAX_RESULTS = 8;
export const PDV_MAX_QTY = 99;

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** Separa a quantidade do termo: "3*101" → { qty: 3, term: "101" }. */
export function parsePdvQuery(raw: string): { qty: number; term: string } {
  const m = /^\s*(\d{1,2})\s*[*xX]\s*(.+)$/.exec(raw);
  if (m) {
    const qty = Number(m[1]);
    if (qty >= 1 && qty <= PDV_MAX_QTY) return { qty, term: m[2]!.trim() };
  }
  return { qty: 1, term: raw.trim() };
}

/**
 * Produtos que batem com o termo, do mais provável para o menos:
 * código exato, código de barras exato, código que começa com o termo,
 * palavra do nome que começa com o termo, nome que contém o termo.
 */
export function searchProducts(products: readonly Product[], term: string, limit = PDV_MAX_RESULTS): Product[] {
  const t = fold(term);
  if (!t) return [];
  const words = t.split(/\s+/);
  const scored: Array<{ p: Product; score: number }> = [];
  for (const p of products) {
    const code = fold(p.code ?? '');
    const name = fold(p.name);
    let score = 0;
    if (code === t) score = 100;
    else if (p.barcode && p.barcode === term.trim()) score = 90;
    else if (code.startsWith(t)) score = 70;
    else if (words.every((w) => name.split(/\s+/).some((nw) => nw.startsWith(w)))) score = 50;
    else if (words.every((w) => name.includes(w))) score = 30;
    if (score) scored.push({ p, score: score + (p.available ? 5 : 0) });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.p.name.localeCompare(b.p.name, 'pt-BR'))
    .slice(0, limit)
    .map((s) => s.p);
}

/** Atalhos do PDV (mostrados na tela e na ajuda). */
export const PDV_SHORTCUTS = {
  builder: [
    ['F1', 'Buscar produto'],
    ['Enter', 'Lançar o produto marcado'],
    ['↑ ↓', 'Escolher na lista'],
    ['F2', 'Cobrar e gerar senha'],
    ['F6', 'Nome do cliente'],
    ['F8', 'Tirar o último item'],
    ['F9', 'Levar / Comer aqui / Entrega'],
    ['Esc', 'Limpar a busca'],
  ],
  checkout: [
    ['F2', 'Cobrar'],
    ['F3', 'Crédito'],
    ['F4', 'Débito'],
    ['F6', 'Pix'],
    ['F7', 'Dinheiro'],
    ['Esc', 'Voltar (fica pendente)'],
  ],
} as const;
