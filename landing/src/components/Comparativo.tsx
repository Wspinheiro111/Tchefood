import { Check, Minus } from 'lucide-react';

interface Linha {
  criterio: string;
  tche: string;
  tradicional: string;
  emBreve?: boolean;
}

const LINHAS: Linha[] = [
  {
    criterio: 'Equipamento',
    tche: 'Usa a maquininha Stone ou PagBank e o celular que você já tem',
    tradicional: 'Costuma exigir tablets, computadores e terminais dedicados',
  },
  {
    criterio: 'Servidor',
    tche: 'Na nuvem, sem servidor Windows no caixa para travar ou formatar',
    tradicional: 'Normalmente depende de um servidor local no restaurante',
  },
  {
    criterio: 'Telas de garçom',
    tche: 'Garçons ilimitados em todos os planos',
    tradicional: 'É comum cobrar licença por terminal ou por usuário',
  },
  {
    criterio: 'Divisão de conta',
    tche: 'Rachadinha nativa na maquininha, na própria mesa',
    tradicional: 'Geralmente feita no caixa, com calculadora',
  },
  {
    criterio: 'NFC-e',
    tche: 'Emitida automaticamente no pagamento, já vinculada à transação',
    tradicional: 'Muitas vezes emitida à parte, no caixa',
  },
  {
    criterio: 'Cancelamentos',
    tche: 'PIN de gerente obrigatório e alerta no WhatsApp do dono',
    tradicional: 'Nem sempre têm trava ou aviso em tempo real',
  },
  {
    criterio: 'Cardápio QR Code',
    tche: 'Incluso em todos os planos',
    tradicional: 'Frequentemente vendido como módulo extra',
  },
  {
    criterio: 'Barril de chopp',
    tche: 'Controle de volume por torneira e alerta de desperdício',
    tradicional: 'Raramente disponível',
    emBreve: true,
  },
];

export default function Comparativo() {
  return (
    <section id="comparativo" className="border-t border-borda/60 bg-surface/30 py-20">
      <div className="container-lp">
        <div className="max-w-2xl">
          <p className="eyebrow">Comparativo</p>
          <h2 className="mt-3 text-3xl font-bold sm:text-4xl">Tchê Food vs. sistemas tradicionais</h2>
          <p className="mt-4 text-slate-400">
            Sistemas antigos foram feitos para o computador do caixa. O Tchê Food foi feito para a maquininha que anda pelo
            salão.
          </p>
        </div>

        {/* Tabela (telas médias e grandes) */}
        <div className="card mt-10 hidden overflow-hidden md:block">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Comparação entre o Tchê Food e sistemas tradicionais</caption>
            <thead>
              <tr className="border-b border-borda text-xs uppercase tracking-wider text-slate-400">
                <th scope="col" className="w-48 px-5 py-4 font-medium">Critério</th>
                <th scope="col" className="bg-brasa/10 px-5 py-4 font-semibold text-white">Tchê Food</th>
                <th scope="col" className="px-5 py-4 font-medium">Sistemas tradicionais</th>
              </tr>
            </thead>
            <tbody>
              {LINHAS.map((l) => (
                <tr key={l.criterio} className="border-b border-borda/60 last:border-0">
                  <th scope="row" className="px-5 py-4 font-medium text-slate-200">{l.criterio}</th>
                  <td className="bg-brasa/5 px-5 py-4 text-slate-100">
                    <span className="flex items-start gap-2">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" aria-hidden />
                      <span>
                        {l.tche}
                        {l.emBreve && <SeloEmBreve />}
                      </span>
                    </span>
                  </td>
                  <td className="px-5 py-4 text-slate-400">
                    <span className="flex items-start gap-2">
                      <Minus className="mt-0.5 h-4 w-4 shrink-0 text-slate-600" aria-hidden />
                      {l.tradicional}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Cartões (celular) */}
        <div className="mt-10 space-y-3 md:hidden">
          {LINHAS.map((l) => (
            <div key={l.criterio} className="card p-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">{l.criterio}</p>
              <p className="mt-2 flex items-start gap-2 text-sm text-slate-100">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" aria-hidden />
                <span>
                  <strong className="text-white">Tchê Food:</strong> {l.tche}
                  {l.emBreve && <SeloEmBreve />}
                </span>
              </p>
              <p className="mt-2 flex items-start gap-2 text-sm text-slate-400">
                <Minus className="mt-0.5 h-4 w-4 shrink-0 text-slate-600" aria-hidden />
                <span>
                  <strong className="text-slate-300">Tradicionais:</strong> {l.tradicional}
                </span>
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function SeloEmBreve() {
  return (
    <span className="ml-2 inline-block rounded-full border border-ouro/40 bg-ouro/10 px-2 py-0.5 align-middle text-[10px] font-semibold uppercase tracking-wider text-amber-300">
      Em breve
    </span>
  );
}
