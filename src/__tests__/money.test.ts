import { describe, expect, it } from 'vitest';
import {
  allocateCents,
  computeEqualShare,
  computeItemTotal,
  computeServiceFee,
  halfAndHalfPrice,
  round2,
} from '../lib/money';
import { accessKeyCheckDigit, buildAccessKey } from '../lib/nfce';
import { crc16 } from '../lib/pix';
import { sha1Hex } from '../lib/sha1';

describe('motor financeiro', () => {
  it('arredonda como o PostgreSQL (half away from zero)', () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(2.675)).toBe(2.68);
    expect(round2(-1.005)).toBe(-1.01);
    expect(round2(0.1 + 0.2)).toBe(0.3);
  });
  it('total do item = qtd x (unitário + adicionais)', () => {
    expect(computeItemTotal(4, 12.9, 6)).toBe(75.6);
    expect(computeItemTotal(3, 0.1, 0.2)).toBe(0.9);
    expect(computeItemTotal(0.5, 89.9, 0)).toBe(44.95);
    expect(computeItemTotal(0.333, 10, 0)).toBe(3.33);
  });
  it('taxa de serviço de 10%', () => {
    expect(computeServiceFee(408.7, 10)).toBe(40.87);
    expect(computeServiceFee(0.05, 10)).toBe(0.01);
    expect(computeServiceFee(129.95, 10)).toBe(13);
  });
  it('divisão igualitária arredonda para cima e fecha no centavo', () => {
    let remaining = 100;
    const shares: number[] = [];
    for (let left = 3; left >= 1; left--) {
      const s = computeEqualShare(remaining, left);
      shares.push(s);
      remaining = round2(remaining - s);
    }
    expect(shares).toEqual([33.34, 33.33, 33.33]);
    expect(remaining).toBe(0);
  });
  it('rateio por maiores restos não perde centavos', () => {
    const parts = allocateCents(1001, [1, 1, 1]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(1001);
    expect(parts).toEqual([334, 334, 333]);
  });
  it('meio-a-meio: maior valor ou média', () => {
    expect(halfAndHalfPrice([69.9, 89.9], 'HIGHEST')).toBe(89.9);
    expect(halfAndHalfPrice([69.9, 89.9], 'AVERAGE')).toBe(79.9);
  });
});

describe('fiscal / pix', () => {
  it('DV módulo 11 da chave de acesso', () => {
    // Exemplo do Manual de Orientação do Contribuinte
    expect(accessKeyCheckDigit('5206043300991100250655012000000780026730161')).toBe('5');
  });
  it('chave NFC-e com 44 dígitos, modelo 65, UF 43', () => {
    const k = buildAccessKey({ cnpj: '48291736000155', issuedAt: new Date('2026-11-09T12:00:00Z'), number: 1001, cNF: '12345678' });
    expect(k).toHaveLength(44);
    expect(k.slice(0, 2)).toBe('43');
    expect(k.slice(20, 22)).toBe('65');
    expect(k.slice(43)).toBe(accessKeyCheckDigit(k.slice(0, 43)));
  });
  it('CRC16 do BR Code', () => {
    expect(crc16('123456789')).toBe('29B1');
  });
  it('SHA-1', () => {
    expect(sha1Hex('abc')).toBe('A9993E364706816ABA3E25717850C26C9CD0D89D');
  });
});
