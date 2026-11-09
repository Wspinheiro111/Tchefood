import { ChevronDown } from 'lucide-react';

const PERGUNTAS = [
  {
    p: 'Preciso trocar minhas maquininhas?',
    r: 'Não. O Tchê Food roda nas maquininhas Smart da Stone e do PagBank. Na demonstração confirmamos o modelo que você tem.',
  },
  {
    p: 'Preciso comprar tablets para os garçons?',
    r: 'Não. O garçom usa o próprio celular, pelo navegador, ou a própria maquininha para lançar os pedidos.',
  },
  {
    p: 'E se a internet cair no meio do movimento?',
    r: 'As vendas continuam e ficam guardadas no aparelho. Quando a conexão volta, tudo é sincronizado automaticamente.',
  },
  {
    p: 'A NFC-e funciona no Rio Grande do Sul?',
    r: 'Sim. A nota é emitida na SEFAZ-RS com os dados da transação do cartão vinculados, como exige a legislação estadual.',
  },
  {
    p: 'Como funciona a implantação?',
    r: 'Cadastramos seu cardápio, configuramos as maquininhas e treinamos a equipe. Você combina a data direto com a gente pelo WhatsApp.',
  },
];

export default function Faq() {
  return (
    <section id="faq" className="border-t border-borda/60 bg-surface/30 py-20">
      <div className="container-lp max-w-3xl">
        <p className="eyebrow">Dúvidas frequentes</p>
        <h2 className="mt-3 text-3xl font-bold sm:text-4xl">Perguntas de quem está pensando em trocar</h2>
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
