/**
 * Calculadora de economia do Tchê Food.
 *
 * Todas as premissas ficam explícitas em PREMISSAS e aparecem na página,
 * para o vendedor poder explicar de onde sai cada número.
 */

export const PREMISSAS = {
  /** Custo de um tablet/celular dedicado por garçom num sistema tradicional (R$). */
  custoTabletPorGarcom: 1200,
  /** Computador de apoio/servidor do caixa num sistema tradicional (R$). */
  custoComputadorApoio: 3500,
  /** Um computador de apoio para cada N mesas (salões grandes precisam de mais de um ponto). */
  mesasPorComputador: 40,
  /** Giros médios por mesa por dia. */
  girosPorMesaDia: 2.5,
  /** Dias de operação no mês. */
  diasOperacaoMes: 26,
  /** Minutos economizados por fechamento de conta (divisão e pagamento na mesa). */
  minutosEconomizadosPorFechamento: 8,
  /** Tempo médio de ocupação de uma mesa (min). */
  minutosOcupacaoMesa: 75,
  /** Parcela do tempo liberado que vira de fato um novo atendimento (demanda nem sempre existe). */
  aproveitamentoTempoLiberado: 0.3,
  /** Perda estimada do faturamento com cancelamentos e estornos indevidos sem trava. */
  perdaCaixaSemTrava: 0.01,
  /** Parcela dessa perda que a trava com PIN de gerente evita. */
  reducaoComTrava: 0.6,
} as const;

export type Premissas = { readonly [K in keyof typeof PREMISSAS]: number };

export interface EntradaCalculadora {
  garcons: number;
  mesas: number;
  faturamentoMensal: number;
}

export interface ResultadoCalculadora {
  economiaHardware: number;
  tabletsEvitados: number;
  computadoresEvitados: number;
  fechamentosMes: number;
  horasEconomizadasMes: number;
  mesasExtrasMes: number;
  receitaExtraMes: number;
  ticketMedioMesa: number;
  furosEvitadosAno: number;
  ganhoPrimeiroAno: number;
}

const arred = (v: number, casas = 2) => {
  const f = 10 ** casas;
  return Math.round(v * f) / f;
};

export function calcularEconomia(
  entrada: EntradaCalculadora,
  p: Premissas = PREMISSAS,
): ResultadoCalculadora {
  const garcons = Math.max(0, Math.floor(entrada.garcons));
  const mesas = Math.max(0, Math.floor(entrada.mesas));
  const faturamento = Math.max(0, entrada.faturamentoMensal);

  const tabletsEvitados = garcons;
  const computadoresEvitados = mesas > 0 ? Math.ceil(mesas / p.mesasPorComputador) : 0;
  const economiaHardware =
    tabletsEvitados * p.custoTabletPorGarcom + computadoresEvitados * p.custoComputadorApoio;

  const fechamentosMes = Math.round(mesas * p.girosPorMesaDia * p.diasOperacaoMes);
  const minutosEconomizados = fechamentosMes * p.minutosEconomizadosPorFechamento;
  const mesasExtrasMes = Math.floor(
    (minutosEconomizados * p.aproveitamentoTempoLiberado) / p.minutosOcupacaoMesa,
  );
  const ticketMedioMesa = fechamentosMes > 0 ? faturamento / fechamentosMes : 0;
  const receitaExtraMes = mesasExtrasMes * ticketMedioMesa;

  const furosEvitadosAno = faturamento * 12 * p.perdaCaixaSemTrava * p.reducaoComTrava;

  return {
    economiaHardware: arred(economiaHardware),
    tabletsEvitados,
    computadoresEvitados,
    fechamentosMes,
    horasEconomizadasMes: arred(minutosEconomizados / 60, 1),
    mesasExtrasMes,
    receitaExtraMes: arred(receitaExtraMes),
    ticketMedioMesa: arred(ticketMedioMesa),
    furosEvitadosAno: arred(furosEvitadosAno),
    ganhoPrimeiroAno: arred(economiaHardware + receitaExtraMes * 12 + furosEvitadosAno),
  };
}

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
export const formatarBRL = (v: number) => brl.format(v);
const num = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
export const formatarNumero = (v: number) => num.format(v);
const brlCent = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
export const formatarBRLCentavos = (v: number) => brlCent.format(v);
