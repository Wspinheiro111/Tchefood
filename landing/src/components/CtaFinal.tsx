import { MessageCircle } from 'lucide-react';
import { linkWhatsApp } from '../lib/config';

export default function CtaFinal() {
  return (
    <section className="py-20">
      <div className="container-lp">
        <div className="relative overflow-hidden rounded-3xl border border-brasa/40 bg-gradient-to-br from-brasa/25 via-surface to-fundo p-8 text-center sm:p-14">
          <div
            aria-hidden
            className="pointer-events-none absolute -bottom-32 left-1/2 h-72 w-[700px] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgba(245,158,11,0.25),transparent)]"
          />
          <h2 className="relative text-3xl font-bold sm:text-4xl">Veja o Tchê Food rodando na sua maquininha.</h2>
          <p className="relative mx-auto mt-4 max-w-xl text-slate-700">
            Em 20 minutos mostramos a comanda, a rachadinha e a NFC-e funcionando com o seu cardápio.
          </p>
          <a
            className="btn-primario relative mt-8 text-base"
            href={linkWhatsApp('Olá! Quero ver o Tchê Food funcionando na minha maquininha.')}
            target="_blank"
            rel="noopener noreferrer"
          >
            <MessageCircle className="h-5 w-5" aria-hidden />
            Agendar demonstração no WhatsApp
          </a>
        </div>
      </div>
    </section>
  );
}
