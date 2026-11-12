import { Bike, Flame, MonitorSmartphone, QrCode, ShieldCheck, Smartphone, SplitSquareHorizontal, WifiOff } from 'lucide-react';
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
    titulo: 'Rachadinha em segundos',
    texto: 'Divide a conta por pessoa, por item consumido ou em partes iguais, com os 10% proporcionais de cada um.',
  },
  {
    icone: MonitorSmartphone,
    titulo: 'PDV, totem e painel de senhas',
    texto: 'Caixa rápido no teclado, totem para o cliente pedir sozinho e a TV chamando a senha quando o pedido fica pronto.',
  },
  {
    icone: Flame,
    titulo: 'Tela da cozinha (KDS)',
    texto: 'Pedidos por praça, com tempo de preparo e alerta visual quando um prato passa do prazo.',
  },
  {
    icone: QrCode,
    titulo: 'Cardápio QR Code e 3D',
    texto: 'O cliente pede pelo celular na mesa e pode ver o prato em realidade aumentada, sem instalar app.',
  },
  {
    icone: Bike,
    titulo: 'Delivery próprio',
    texto: 'Taxa por bairro, entregador, rota no Google Maps e acerto do dinheiro com o entregador no fim do dia.',
  },
  {
    icone: ShieldCheck,
    titulo: 'Antifraude e caixa às cegas',
    texto: 'Cancelamento e desconto só com PIN de gerente, tudo registrado. O caixa fecha sem ver o valor esperado.',
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
          <h2 className="mt-3 text-3xl font-bold sm:text-4xl">Do salão ao delivery, tudo num sistema só.</h2>
        </div>
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {BENEFICIOS.map(({ icone: Icone, titulo, texto }) => (
            <article key={titulo} className="card p-5 transition hover:border-slate-300">
              <span className="grid h-10 w-10 place-items-center rounded-lg bg-brasa/15 text-brasa">
                <Icone className="h-5 w-5" aria-hidden />
              </span>
              <h3 className="mt-4 text-base font-semibold">{titulo}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">{texto}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
