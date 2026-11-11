import { CheckCircle2, Clock, Settings2 } from 'lucide-react';
import { GRUPOS_FUNCOES, ROTULO_STATUS, type StatusFuncao } from '../lib/funcionalidades';

const ESTILO_STATUS: Record<StatusFuncao, string> = {
  pronto: 'border-emerald-600/30 bg-emerald-50 text-emerald-800',
  implantacao: 'border-sky-600/30 bg-sky-50 text-sky-800',
  'em-breve': 'border-ouro/40 bg-ouro/10 text-amber-800',
};

const ICONE_STATUS = { pronto: CheckCircle2, implantacao: Settings2, 'em-breve': Clock } as const;

export function SeloStatus({ status }: { status: StatusFuncao }) {
  const Icone = ICONE_STATUS[status];
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${ESTILO_STATUS[status]}`}
    >
      <Icone className="h-3 w-3" aria-hidden />
      {ROTULO_STATUS[status]}
    </span>
  );
}

export default function Funcionalidades() {
  return (
    <section id="funcionalidades" className="py-20" aria-labelledby="titulo-funcionalidades">
      <div className="container-lp">
        <div className="max-w-3xl">
          <p className="eyebrow">Funcionalidades</p>
          <h2 id="titulo-funcionalidades" className="mt-3 text-3xl font-bold sm:text-4xl">
            Tudo o que o sistema para restaurantes Tchê Food faz
          </h2>
          <p className="mt-4 text-slate-600">
            PDV, comanda eletrônica, KDS, totem, cardápio digital, delivery, controle de caixa, estoque, cashback e NFC-e.
            Cada função mostra se já está pronta, se é ativada na implantação com os dados da sua loja (certificado da
            NFC-e, contrato da maquininha) ou se está chegando.
          </p>
          <ul className="mt-5 flex flex-wrap gap-2" aria-label="Legenda">
            {(Object.keys(ROTULO_STATUS) as StatusFuncao[]).map((s) => (
              <li key={s}>
                <SeloStatus status={s} />
              </li>
            ))}
          </ul>
        </div>

        <nav aria-label="Áreas do sistema" className="mt-8 flex flex-wrap gap-2">
          {GRUPOS_FUNCOES.map((g) => (
            <a
              key={g.id}
              href={`#func-${g.id}`}
              className="rounded-full border border-borda bg-surface px-3 py-1.5 text-sm text-slate-700 transition hover:border-slate-400 hover:text-slate-900"
            >
              {g.titulo}
            </a>
          ))}
        </nav>

        <div className="mt-10 space-y-12">
          {GRUPOS_FUNCOES.map((g) => (
            <section key={g.id} id={`func-${g.id}`} aria-labelledby={`titulo-func-${g.id}`} className="scroll-mt-24">
              <h3 id={`titulo-func-${g.id}`} className="text-2xl font-bold">
                {g.titulo}
              </h3>
              <p className="mt-1 text-slate-600">{g.resumo}</p>
              <ul className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {g.funcoes.map((f) => (
                  <li key={f.titulo} className="card flex flex-col p-5">
                    <h4 className="font-display text-base font-semibold text-slate-900">{f.titulo}</h4>
                    <div className="mt-2">
                      <SeloStatus status={f.status} />
                    </div>
                    <p className="mt-2 text-sm leading-relaxed text-slate-600">{f.texto}</p>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </section>
  );
}
