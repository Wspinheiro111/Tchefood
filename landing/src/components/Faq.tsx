import { ChevronDown } from 'lucide-react';
import { PERGUNTAS } from '../lib/faq';


export default function Faq() {
  return (
    <section id="faq" className="border-t border-borda/60 bg-surface/30 py-20">
      <div className="container-lp max-w-3xl">
        <p className="eyebrow">Dúvidas</p>
        <h2 className="mt-3 text-3xl font-bold sm:text-4xl">Perguntas frequentes sobre o sistema para restaurantes</h2>
        <div className="mt-10 space-y-3">
          {PERGUNTAS.map(({ p, r }) => (
            <details key={p} className="card group p-5 [&_summary::-webkit-details-marker]:hidden">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-semibold text-slate-900">
                {p}
                <ChevronDown className="h-5 w-5 shrink-0 text-slate-600 transition group-open:rotate-180" aria-hidden />
              </summary>
              <p className="mt-3 text-sm leading-relaxed text-slate-600">{r}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
