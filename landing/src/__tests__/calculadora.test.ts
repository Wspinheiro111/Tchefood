import { describe, expect, it } from 'vitest';
import { calcularEconomia, PREMISSAS } from '../lib/calculadora';

describe('calcularEconomia', () => {
  it('calcula um salão médio com as premissas padrão', () => {
    const r = calcularEconomia({ garcons: 8, mesas: 30, faturamentoMensal: 150000 });
    // 8 tablets × 1200 + 1 computador × 3500
    expect(r.economiaHardware).toBe(13100);
    expect(r.computadoresEvitados).toBe(1);
    // 30 × 2,5 × 26 = 1950 fechamentos
    expect(r.fechamentosMes).toBe(1950);
    // 1950 × 8 = 15600 min = 260 h
    expect(r.horasEconomizadasMes).toBe(260);
    // floor(15600 × 0,3 / 75) = 62 mesas extras
    expect(r.mesasExtrasMes).toBe(62);
    expect(r.ticketMedioMesa).toBeCloseTo(76.92, 2);
    expect(r.receitaExtraMes).toBeCloseTo(62 * (150000 / 1950), 1);
    // 150000 × 12 × 1% × 60%
    expect(r.furosEvitadosAno).toBe(10800);
    expect(r.ganhoPrimeiroAno).toBeCloseTo(13100 + r.receitaExtraMes * 12 + 10800, 1);
  });

  it('adiciona um computador de apoio a cada 40 mesas', () => {
    expect(calcularEconomia({ garcons: 1, mesas: 40, faturamentoMensal: 0 }).computadoresEvitados).toBe(1);
    expect(calcularEconomia({ garcons: 1, mesas: 41, faturamentoMensal: 0 }).computadoresEvitados).toBe(2);
    expect(calcularEconomia({ garcons: 1, mesas: 100, faturamentoMensal: 0 }).computadoresEvitados).toBe(3);
  });

  it('não gera números negativos nem divide por zero', () => {
    const r = calcularEconomia({ garcons: -3, mesas: 0, faturamentoMensal: -10 });
    expect(r.economiaHardware).toBe(0);
    expect(r.ticketMedioMesa).toBe(0);
    expect(r.receitaExtraMes).toBe(0);
    expect(r.furosEvitadosAno).toBe(0);
  });

  it('aceita premissas customizadas', () => {
    const r = calcularEconomia(
      { garcons: 2, mesas: 10, faturamentoMensal: 100000 },
      { ...PREMISSAS, custoTabletPorGarcom: 2000, perdaCaixaSemTrava: 0.02 },
    );
    expect(r.economiaHardware).toBe(2 * 2000 + 3500);
    expect(r.furosEvitadosAno).toBe(100000 * 12 * 0.02 * 0.6);
  });
});
