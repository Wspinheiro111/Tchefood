import { describe, expect, it } from 'vitest';
import { encaixeLogoAnimada, mostraAnimada } from '../components/brandFx';
import { LOGO_PARADA_PROPORCAO } from '../assets/brand/logoAnimada';

// Tamanho real de src/assets/brand/logo-animada.webp (gerado por scripts/gerar-marca.py).
const WEBP_PROPORCAO = 667 / 265;

describe('logo animada: encaixe na logo parada (auditoria GPT PR #37, P2-02)', () => {
  it('mantém a proporção do WebP quando a caixa tem a proporção da logo', () => {
    const c = encaixeLogoAnimada(386.6, 96)!;
    expect(c.width / c.height).toBeCloseTo(WEBP_PROPORCAO, 2);
  });

  it('login no desktop: h-24 limitado a 360px de largura não estica a animada', () => {
    // caixa da parada: 360 x 96 (altura fixa, largura cortada pelo max-w)
    const c = encaixeLogoAnimada(360, 96)!;
    expect(c.width / c.height).toBeCloseTo(WEBP_PROPORCAO, 2);
    // o desenho da parada (object-contain) tem 360 x 89,4 e fica centralizado na vertical
    const alturaDesenho = 360 / LOGO_PARADA_PROPORCAO;
    expect(alturaDesenho).toBeCloseTo(89.4, 1);
    // a animada ocupa a mesma largura proporcional que tinha sobre a logo inteira
    expect(c.width).toBeCloseTo(360 * 1.02932, 1);
    // o topo do desenho fica (96 - 89,4) / 2 abaixo do topo da caixa, e a animada sobe a folga dela a partir dali
    expect(c.top).toBeCloseTo((96 - alturaDesenho) / 2 - 0.25466 * alturaDesenho, 1);
  });

  it('celular de 320px: max-w de 90vw (288px) com h-20 também não estica', () => {
    const c = encaixeLogoAnimada(288, 80)!;
    expect(c.width / c.height).toBeCloseTo(WEBP_PROPORCAO, 2);
  });

  it('caixa mais alta que a logo também centraliza sem esticar', () => {
    const c = encaixeLogoAnimada(200, 200)!;
    expect(c.width / c.height).toBeCloseTo(WEBP_PROPORCAO, 2);
    expect(c.width).toBeCloseTo(200 * 1.02932, 1);
  });

  it('sem medida ainda (0 ou NaN): não encaixa', () => {
    expect(encaixeLogoAnimada(0, 96)).toBeNull();
    expect(encaixeLogoAnimada(360, 0)).toBeNull();
    expect(encaixeLogoAnimada(Number.NaN, 96)).toBeNull();
  });
});

describe('logo animada: quando a parada some (auditoria GPT PR #37, P2-01)', () => {
  const caixa = encaixeLogoAnimada(360, 96);

  it('só troca para a animada depois de carregada e com caixa medida', () => {
    expect(mostraAnimada('pronta', caixa)).toBe(true);
  });

  it('carregando (requisição pendente): mostra a parada', () => {
    expect(mostraAnimada('carregando', caixa)).toBe(false);
  });

  it('erro (404, rede fora, arquivo que não decodifica): mostra a parada', () => {
    expect(mostraAnimada('erro', caixa)).toBe(false);
  });

  it('pronta mas ainda sem medida: mostra a parada', () => {
    expect(mostraAnimada('pronta', null)).toBe(false);
  });
});
