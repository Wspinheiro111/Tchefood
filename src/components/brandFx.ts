import { LOGO_ANIMADA_ENCAIXE, LOGO_PARADA_PROPORCAO } from '../assets/brand/logoAnimada';

/** Estado do arquivo da logo animada: só depois de carregado e decodificado ele substitui a logo parada. */
export type EstadoLogoAnimada = 'carregando' | 'pronta' | 'erro';

export interface CaixaPx {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Onde desenhar o quadro animado, em px, dentro da caixa da logo parada.
 *
 * A logo parada usa `object-contain`: quando a altura fixa e o `max-w` da tela dão à caixa uma
 * proporção diferente da logo, o desenho fica centralizado e menor que a caixa. A animada precisa
 * seguir esse desenho, não a caixa, senão ela estica. Aqui o conteúdo é calculado como o
 * `object-contain` faz (maior retângulo na proporção da logo, centralizado) e o quadro animado é
 * posicionado em relação a ele, sempre na proporção do próprio WebP.
 *
 * Devolve `null` enquanto a caixa ainda não tem tamanho (nada para encaixar).
 */
export function encaixeLogoAnimada(caixaLargura: number, caixaAltura: number): CaixaPx | null {
  if (!(caixaLargura > 0) || !(caixaAltura > 0)) return null;
  const largura = Math.min(caixaLargura, caixaAltura * LOGO_PARADA_PROPORCAO);
  const altura = largura / LOGO_PARADA_PROPORCAO;
  const x = (caixaLargura - largura) / 2;
  const y = (caixaAltura - altura) / 2;
  const e = LOGO_ANIMADA_ENCAIXE;
  return {
    left: x + (e.left / 100) * largura,
    top: y + (e.top / 100) * altura,
    width: (e.width / 100) * largura,
    height: (e.height / 100) * altura,
  };
}

/**
 * A logo parada fica escondida só quando a animada está pronta E já tem onde ser desenhada.
 * Carregando, com erro (404, rede, arquivo que não decodifica) ou sem medida: a parada aparece.
 * (Com "reduzir movimento", o CSS mostra a parada e esconde a animada de qualquer jeito.)
 */
export function mostraAnimada(estado: EstadoLogoAnimada, encaixe: CaixaPx | null): boolean {
  return estado === 'pronta' && encaixe !== null;
}
