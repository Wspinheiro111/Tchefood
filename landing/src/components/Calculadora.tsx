import { useId, useMemo, useState } from 'react';
import { Clock, Cpu, Info, MessageCircle, ShieldCheck, TrendingUp } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { calcularEconomia, formatarBRL, formatarNumero, PREMISSAS } from '../lib/calculadora';
import { linkWhatsApp } from '../lib/config';

interface SliderProps {
  rotulo: string;
  valor: number;
  min: number;
  max: number;
  passo: number;
  formatar: (v: number) => string;
  onChange: (v: number) => void;
}

function Slider({ rotulo, valor, min, max, passo, formatar, onChange }: SliderProps) {
  const id = useId();
  const pct = ((valor - min) / (max - min)) * 100;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-4">
        <label htmlFor={id} className="text-sm font-medium text-slate-700">
          {rotulo}
        </label>
        <output htmlFor={id} className="font-display text-xl font-bold text-slate-900">
          {formatar(valor)}
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={passo}
        value={valor}
        onChange={(e) => onChange(Number(e.target.value))}
        className="slider mt-3"
        style={{ background: `linear-gradient(90deg,#D2232A ${pct}%,#e2e8f0 ${pct}%)` }}
      />
      <div className="mt-1 flex justify-between text-[11px] text-slate-500">
        <span>{formatar(min)}</span>
        <span>{formatar(max)}</span>
      </div>
    </div>
  );
}

interface CardResultadoProps {
  icone: LucideIcon;
  titulo: string;
  valor: string;
  detalhe: string;
}

function CardResultado({ icone: Icone, titulo, valor, detalhe }: CardResultadoProps) {
  return (
    <div className="rounded-xl border border-borda bg-fundo/60 p-4">
      <div className="flex items-center gap-2 text-sm text-slate-600">
        <Icone className="h-4 w-4 text-amber-600" aria-hidden />
        {titulo}
      </div>
      <p className="mt-2 font-display text-2xl font-extrabold text-slate-900">{valor}</p>
      <p className="mt-1 text-xs leading-relaxed text-slate-600">{detalhe}</p>
    </div>
  );
}

const pct = (v: number) => `${formatarNumero(v * 100)}%`;

export default function Calculadora() {
  const [garcons, setGarcons] = useState(8);
  const [mesas, setMesas] = useState(30);
  const [faturamento, setFaturamento] = useState(150000);
  const [premissasAbertas, setPremissasAbertas] = useState(false);

  const r = useMemo(
    () => calcularEconomia({ garcons, mesas, faturamentoMensal: faturamento }),
    [garcons, mesas, faturamento],
  );

  const mensagem =
    `Olá! Fiz a simulação no site do Tchê Food: ${garcons} garçons, ${mesas} mesas e faturamento de ` +
    `${formatarBRL(faturamento)}/mês. Deu um ganho estimado de ${formatarBRL(r.ganhoPrimeiroAno)} no primeiro ano. ` +
    `Quero agendar uma demonstração.`;

  return (
    <section id="calculadora" className="py-20">
      <div className="container-lp">
        <div className="max-w-2xl">
          <p className="eyebrow">Calculadora de economia</p>
          <h2 className="mt-3 text-3xl font-bold sm:text-4xl">Quanto o seu restaurante ganha com o Tchê Food?</h2>
          <p className="mt-4 text-slate-600">
            Ajuste os números do seu salão. O cálculo é feito na hora, com premissas conservadoras que você pode conferir
            logo abaixo.
          </p>
        </div>

        <div className="mt-10 grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
          <div className="card space-y-8 p-6">
            <Slider rotulo="Garçons" valor={garcons} min={1} max={30} passo={1} formatar={(v) => String(v)} onChange={setGarcons} />
            <Slider rotulo="Mesas" valor={mesas} min={5} max={100} passo={1} formatar={(v) => String(v)} onChange={setMesas} />
            <Slider
              rotulo="Faturamento mensal"
              valor={faturamento}
              min={20000}
              max={1000000}
              passo={10000}
              formatar={formatarBRL}
              onChange={setFaturamento}
            />
          </div>

          <div className="card relative overflow-hidden p-6">
            <div
              aria-hidden
              className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full bg-[radial-gradient(closest-side,rgba(245,158,11,0.18),transparent)]"
            />
            <div className="relative" aria-live="polite">
              <p className="text-sm text-slate-600">Ganho estimado no primeiro ano</p>
              <p className="mt-1 bg-gradient-to-r from-brasa to-amber-500 bg-clip-text font-display text-4xl font-extrabold text-transparent sm:text-5xl">
                {formatarBRL(r.ganhoPrimeiroAno)}
              </p>
              <div className="mt-6 grid gap-3 sm:grid-cols-3">
                <CardResultado
                  icone={Cpu}
                  titulo="Hardware"
                  valor={formatarBRL(r.economiaHardware)}
                  detalhe={`${r.tabletsEvitados} tablets e ${r.computadoresEvitados} computador${r.computadoresEvitados === 1 ? '' : 'es'} de apoio que você não compra.`}
                />
                <CardResultado
                  icone={TrendingUp}
                  titulo="Giro de mesa"
                  valor={`+${r.mesasExtrasMes} mesas/mês`}
                  detalhe={`${formatarNumero(r.horasEconomizadasMes)} h a menos fechando conta. Cerca de ${formatarBRL(r.receitaExtraMes)} a mais por mês.`}
                />
                <CardResultado
                  icone={ShieldCheck}
                  titulo="Furos de caixa"
                  valor={`${formatarBRL(r.furosEvitadosAno)}/ano`}
                  detalhe="Perdas com cancelamentos e estornos indevidos que a trava com PIN de gerente evita."
                />
              </div>
              <a
                className="btn-primario mt-6 w-full sm:w-auto"
                href={linkWhatsApp(mensagem)}
                target="_blank"
                rel="noopener noreferrer"
              >
                <MessageCircle className="h-5 w-5" aria-hidden />
                Quero esse resultado no meu salão
              </a>
            </div>
          </div>
        </div>

        <div className="mt-6">
          <button
            className="inline-flex items-center gap-2 text-sm text-slate-600 transition hover:text-slate-900"
            onClick={() => setPremissasAbertas((v) => !v)}
            aria-expanded={premissasAbertas}
          >
            <Info className="h-4 w-4" aria-hidden />
            {premissasAbertas ? 'Esconder premissas do cálculo' : 'Ver premissas do cálculo'}
          </button>
          {premissasAbertas && (
            <div className="card mt-3 grid gap-x-8 gap-y-2 p-5 text-sm text-slate-600 sm:grid-cols-2">
              <p>
                <Clock className="mr-1 inline h-3.5 w-3.5" aria-hidden />
                {formatarNumero(PREMISSAS.minutosEconomizadosPorFechamento)} min economizados por fechamento de conta
              </p>
              <p>{formatarBRL(PREMISSAS.custoTabletPorGarcom)} por tablet de garçom evitado</p>
              <p>
                {formatarBRL(PREMISSAS.custoComputadorApoio)} por computador de apoio (1 a cada {PREMISSAS.mesasPorComputador} mesas)
              </p>
              <p>
                {formatarNumero(PREMISSAS.girosPorMesaDia)} giros por mesa ao dia, {PREMISSAS.diasOperacaoMes} dias por mês
              </p>
              <p>
                Mesa ocupada em média {PREMISSAS.minutosOcupacaoMesa} min; só {pct(PREMISSAS.aproveitamentoTempoLiberado)} do tempo
                liberado vira novo atendimento
              </p>
              <p>
                Perda de {pct(PREMISSAS.perdaCaixaSemTrava)} do faturamento com cancelamentos indevidos, dos quais a trava evita{' '}
                {pct(PREMISSAS.reducaoComTrava)}
              </p>
              <p className="sm:col-span-2 text-xs text-slate-500">
                Valores estimados para apoiar a decisão. O resultado real depende da operação de cada restaurante.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
