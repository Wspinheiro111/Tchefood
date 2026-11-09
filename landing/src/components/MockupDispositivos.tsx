import { useEffect, useState } from 'react';
import { Check, CreditCard, Nfc, Play, RotateCcw, Smartphone, Users } from 'lucide-react';
import { formatarBRLCentavos as brl } from '../lib/calculadora';

const ITENS = [
  { qtd: 2, nome: 'Picanha na chapa', preco: 89.9 },
  { qtd: 1, nome: 'Costela fogo de chão', preco: 74.9 },
  { qtd: 4, nome: 'Chopp Pilsen 500ml', preco: 16.9 },
  { qtd: 1, nome: 'Polenta frita', preco: 28.0 },
];
const PESSOAS = 4;
const subtotal = ITENS.reduce((s, i) => s + i.qtd * i.preco, 0);
const servico = Math.round(subtotal * 0.1 * 100) / 100;
const total = Math.round((subtotal + servico) * 100) / 100;
// Divisão em centavos: o resto vai para a primeira pessoa, sem perder 1 centavo.
const totalCent = Math.round(total * 100);
const base = Math.floor(totalCent / PESSOAS);
const partes = Array.from({ length: PESSOAS }, (_, i) => (base + (i === 0 ? totalCent - base * PESSOAS : 0)) / 100);

type Etapa = 'parado' | 'aproximando' | 'aprovado';

export default function MockupDispositivos() {
  const [pagos, setPagos] = useState(0);
  const [etapa, setEtapa] = useState<Etapa>('parado');
  const [rodando, setRodando] = useState(false);

  useEffect(() => {
    if (!rodando) return;
    if (pagos >= PESSOAS) {
      setRodando(false);
      return;
    }
    setEtapa('aproximando');
    const t1 = setTimeout(() => setEtapa('aprovado'), 900);
    const t2 = setTimeout(() => setPagos((p) => p + 1), 1600);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [rodando, pagos]);

  const concluido = pagos >= PESSOAS;
  const iniciar = () => {
    setPagos(0);
    setEtapa('parado');
    setRodando(true);
  };

  return (
    <div className="relative mx-auto w-full max-w-[520px] animate-fade-up [animation-delay:120ms]">
      <div className="flex items-end justify-center gap-2 sm:gap-6">
        {/* Celular do garçom */}
        <div className="w-[46%] max-w-[220px] rounded-[2rem] border border-slate-700 bg-slate-950 p-2 shadow-2xl shadow-black/50">
          <div className="overflow-hidden rounded-[1.6rem] bg-surface">
            <div className="flex items-center justify-between bg-fundo px-3 py-2 text-[10px] text-slate-400">
              <span className="flex items-center gap-1">
                <Smartphone className="h-3 w-3" aria-hidden /> Garçom: Rafa
              </span>
              <span>20:41</span>
            </div>
            <div className="px-3 pb-3 pt-2">
              <p className="text-[11px] text-slate-400">Comanda</p>
              <p className="font-display text-base font-bold text-white">Mesa 12</p>
              <ul className="mt-2 space-y-1.5 text-[11px]">
                {ITENS.map((i) => (
                  <li key={i.nome} className="flex justify-between gap-2">
                    <span className="truncate text-slate-200">
                      {i.qtd}× {i.nome}
                    </span>
                    <span className="shrink-0 text-slate-400">{brl(i.qtd * i.preco)}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-3 space-y-0.5 border-t border-borda pt-2 text-[11px]">
                <div className="flex justify-between text-slate-400">
                  <span>Serviço 10%</span>
                  <span>{brl(servico)}</span>
                </div>
                <div className="flex justify-between font-semibold text-white">
                  <span>Total</span>
                  <span>{brl(total)}</span>
                </div>
              </div>
              <div className="mt-3 flex items-center gap-1.5 rounded-lg bg-brasa/15 px-2 py-1.5 text-[10px] font-medium text-rose-200">
                <Users className="h-3 w-3" aria-hidden /> Enviado para a maquininha · {PESSOAS} pessoas
              </div>
            </div>
          </div>
        </div>

        {/* Maquininha */}
        <div className="w-[50%] max-w-[240px] rounded-[1.75rem] border border-slate-600 bg-gradient-to-b from-slate-800 to-slate-900 p-2.5 shadow-2xl shadow-black/60">
          <div className="mb-2 flex items-center justify-between px-1">
            <span className="h-1.5 w-10 rounded-full bg-slate-700" />
            <Nfc className="h-4 w-4 text-slate-500" aria-hidden />
          </div>
          <div className="rounded-2xl bg-fundo p-3" aria-live="polite">
            <p className="text-[10px] uppercase tracking-wider text-ouro">Rachadinha · Mesa 12</p>
            <p className="mt-1 font-display text-xl font-extrabold text-white">
              {brl(total)}
            </p>
            <ul className="mt-2 space-y-1">
              {partes.map((v, idx) => {
                const pago = idx < pagos;
                const atual = idx === pagos && rodando;
                return (
                  <li
                    key={idx}
                    className={`flex items-center justify-between rounded-md px-2 py-1 text-[11px] transition ${
                      pago
                        ? 'bg-emerald-500/15 text-emerald-300'
                        : atual
                          ? 'bg-ouro/15 text-amber-200'
                          : 'bg-surface text-slate-400'
                    }`}
                  >
                    <span>Pessoa {idx + 1}</span>
                    <span className="flex items-center gap-1">
                      {brl(v)}
                      {pago && <Check className="h-3 w-3" aria-hidden />}
                    </span>
                  </li>
                );
              })}
            </ul>
            <div className="mt-2 h-8 text-center text-[11px]">
              {concluido ? (
                <p className="font-semibold text-emerald-300">Conta paga · NFC-e emitida</p>
              ) : rodando && etapa === 'aproximando' ? (
                <p className="flex items-center justify-center gap-1 text-amber-200">
                  <CreditCard className="h-3.5 w-3.5" aria-hidden /> Aproxime o cartão…
                </p>
              ) : rodando && etapa === 'aprovado' ? (
                <p className="font-semibold text-emerald-300">Aprovado</p>
              ) : (
                <p className="text-slate-500">Aguardando pagamento</p>
              )}
            </div>
          </div>
          <div className="mt-2 grid grid-cols-3 gap-1.5 px-1 pb-1">
            {Array.from({ length: 6 }).map((_, i) => (
              <span key={i} className="h-3 rounded bg-slate-700/70" />
            ))}
          </div>
        </div>
      </div>

      <div className="mt-6 flex justify-center">
        <button className="btn-secundario py-2 text-sm" onClick={iniciar} disabled={rodando}>
          {concluido ? <RotateCcw className="h-4 w-4" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}
          {rodando ? 'Dividindo a conta…' : concluido ? 'Ver de novo' : 'Simular a rachadinha'}
        </button>
      </div>
      <p className="mt-2 text-center text-xs text-slate-500">Demonstração ilustrativa</p>
    </div>
  );
}
