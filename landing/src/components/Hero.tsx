import { ArrowRight, CheckCircle2, MessageCircle } from 'lucide-react';
import { linkWhatsApp } from '../lib/config';
import MockupDispositivos from './MockupDispositivos';

const PROVAS = [
  'Garçons ilimitados em todos os planos',
  'Funciona sem internet e sincroniza depois',
  'Sem servidor no restaurante',
];

export default function Hero() {
  return (
    <section id="topo" className="relative overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 h-[520px] w-[900px] -translate-x-1/2 animate-brasa rounded-full bg-[radial-gradient(closest-side,rgba(210,35,42,0.14),transparent)]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute right-[-200px] top-40 h-[420px] w-[420px] rounded-full bg-[radial-gradient(closest-side,rgba(245,158,11,0.14),transparent)]"
      />
      <div className="container-lp relative grid grid-cols-1 items-center gap-12 pb-20 pt-10 md:pt-16 lg:grid-cols-[1.1fr_1fr] lg:pb-28">
        <div className="min-w-0 animate-fade-up">
          <p className="eyebrow">Da comanda à maquininha</p>
          <h1 className="mt-4 text-4xl font-extrabold leading-[1.08] tracking-tight sm:text-5xl lg:text-[3.1rem]">
            Sistema para{' '}
            <span className="bg-gradient-to-r from-brasa to-ouro bg-clip-text text-transparent">restaurantes, bares e delivery</span>{' '}
            que roda no celular do garçom.
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-slate-700">
            PDV, comanda eletrônica, tela da cozinha (KDS), totem de autoatendimento, cardápio digital QR Code, delivery
            próprio, controle de caixa, cashback e NFC-e num sistema só, integrado às maquininhas Smart Stone, PagBank e
            Mercado Pago.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <a
              className="btn-primario text-base"
              href={linkWhatsApp('Olá! Vi o site do Tchê Food e quero agendar uma demonstração.')}
              target="_blank"
              rel="noopener noreferrer"
            >
              <MessageCircle className="h-5 w-5" aria-hidden />
              Agendar demonstração no WhatsApp
            </a>
            <a className="btn-secundario text-base" href="#funcionalidades">
              Ver todas as funções
              <ArrowRight className="h-5 w-5" aria-hidden />
            </a>
          </div>
          <ul className="mt-8 grid gap-2 text-sm text-slate-700 sm:grid-cols-3 sm:gap-4">
            {PROVAS.map((p) => (
              <li key={p} className="flex items-start gap-2">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />
                {p}
              </li>
            ))}
          </ul>
        </div>
        <MockupDispositivos />
      </div>
    </section>
  );
}
