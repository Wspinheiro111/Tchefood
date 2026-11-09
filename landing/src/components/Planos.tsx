import { Check, MessageCircle, Star } from 'lucide-react';
import { EM_BREVE, linkWhatsApp, PLANOS } from '../lib/config';
import { formatarBRL } from '../lib/calculadora';
import { SeloEmBreve } from './Comparativo';

export default function Planos() {
  return (
    <section id="planos" className="py-20">
      <div className="container-lp">
        <div className="mx-auto max-w-2xl text-center">
          <p className="eyebrow">Planos</p>
          <h2 className="mt-3 text-3xl font-bold sm:text-4xl">Planos transparentes. Garçons ilimitados em todos.</h2>
          <p className="mt-4 text-slate-600">
            Sem cobrança por tela ou por garçom. TEF integrado à maquininha a partir do plano Churrascaria &amp; Salão Pro.
          </p>
        </div>

        <div className="mt-12 grid gap-6 lg:grid-cols-3">
          {PLANOS.map((p) => (
            <article
              key={p.id}
              className={`relative flex flex-col rounded-2xl border p-6 ${
                p.destaque
                  ? 'border-brasa/70 bg-gradient-to-b from-brasa/15 to-surface/80 shadow-[0_20px_60px_-25px_rgba(225,29,72,0.6)]'
                  : 'border-borda bg-surface/70'
              }`}
            >
              {p.destaque && (
                <span className="absolute -top-3 left-6 inline-flex items-center gap-1 rounded-full bg-brasa px-3 py-1 text-xs font-semibold text-white">
                  <Star className="h-3 w-3" aria-hidden /> Mais escolhido
                </span>
              )}
              <h3 className="text-xl font-bold">{p.nome}</h3>
              <p className="mt-1 text-sm text-slate-600">{p.publico}</p>
              <div className="mt-6">
                {p.precoMensal === null ? (
                  <p className="font-display text-3xl font-extrabold text-slate-900">Sob consulta</p>
                ) : (
                  <p className="font-display text-4xl font-extrabold text-slate-900">
                    {formatarBRL(p.precoMensal)}
                    <span className="text-base font-medium text-slate-600">/mês</span>
                  </p>
                )}
              </div>
              <ul className="mt-5 flex flex-wrap gap-2">
                {p.limites.map((l) => (
                  <li key={l} className="rounded-full border border-borda bg-fundo/60 px-3 py-1 text-xs text-slate-700">
                    {l}
                  </li>
                ))}
              </ul>
              <ul className="mt-6 flex-1 space-y-3 text-sm">
                {p.recursos.map((r) => (
                  <li key={r} className="flex items-start gap-2 text-slate-800">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />
                    <span>
                      {r}
                      {EM_BREVE.has(r) && <SeloEmBreve />}
                    </span>
                  </li>
                ))}
              </ul>
              <a
                className={`${p.destaque ? 'btn-primario' : 'btn-secundario'} mt-8 w-full`}
                href={linkWhatsApp(`Olá! Quero agendar uma demonstração do Tchê Food, plano ${p.nome}.`)}
                target="_blank"
                rel="noopener noreferrer"
              >
                <MessageCircle className="h-5 w-5" aria-hidden />
                Agendar demonstração
              </a>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
