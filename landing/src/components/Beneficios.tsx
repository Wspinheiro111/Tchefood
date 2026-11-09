import { BellRing, Flame, QrCode, ReceiptText, Smartphone, SplitSquareHorizontal, WifiOff, ShieldCheck } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

interface Beneficio {
  icone: LucideIcon;
  titulo: string;
  texto: string;
}

const BENEFICIOS: Beneficio[] = [
  {
    icone: Smartphone,
    titulo: 'Comanda no celular do garçom',
    texto: 'O garçom lança o pedido no próprio celular e ele cai na cozinha na hora. Nada de tablet comprado só para isso.',
  },
  {
    icone: SplitSquareHorizontal,
    titulo: 'Rachadinha na maquininha',
    texto: 'A conta vai da mesa para a Stone ou PagBank já dividida por pessoa, por item ou em partes iguais.',
  },
  {
    icone: ReceiptText,
    titulo: 'NFC-e automática',
    texto: 'Pagou, emitiu. A nota sai com os dados da transação vinculados, como a SEFAZ-RS exige.',
  },
  {
    icone: ShieldCheck,
    titulo: 'Cancelamento com PIN de gerente',
    texto: 'Item cancelado depois de enviado à cozinha só sai com autorização, e fica registrado com quem cancelou.',
  },
  {
    icone: BellRing,
    titulo: 'Alerta no seu WhatsApp',
    texto: 'Você fica sabendo de cada cancelamento e estorno no celular, mesmo longe do restaurante.',
  },
  {
    icone: Flame,
    titulo: 'Tela da cozinha (KDS)',
    texto: 'Pedidos por praça, com tempo de preparo e alerta visual quando um prato passa do prazo.',
  },
  {
    icone: QrCode,
    titulo: 'Cardápio QR Code incluso',
    texto: 'O cliente vê o cardápio com fotos e chama o garçom pela mesa, sem custo adicional.',
  },
  {
    icone: WifiOff,
    titulo: 'Internet caiu? Continua vendendo',
    texto: 'As vendas ficam guardadas no aparelho e sincronizam sozinhas quando a conexão volta.',
  },
];

export default function Beneficios() {
  return (
    <section id="beneficios" className="border-t border-borda/60 bg-surface/30 py-20">
      <div className="container-lp">
        <div className="max-w-2xl">
          <p className="eyebrow">O que muda no seu salão</p>
          <h2 className="mt-3 text-3xl font-bold sm:text-4xl">Tudo que o salão precisa, na maquininha que já está na mesa.</h2>
        </div>
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {BENEFICIOS.map(({ icone: Icone, titulo, texto }) => (
            <article key={titulo} className="card p-5 transition hover:border-slate-600">
              <span className="grid h-10 w-10 place-items-center rounded-lg bg-brasa/15 text-rose-300">
                <Icone className="h-5 w-5" aria-hidden />
              </span>
              <h3 className="mt-4 text-base font-semibold">{titulo}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-400">{texto}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
