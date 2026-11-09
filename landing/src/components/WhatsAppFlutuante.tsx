import { MessageCircle } from 'lucide-react';
import { linkWhatsApp } from '../lib/config';

export default function WhatsAppFlutuante() {
  return (
    <a
      href={linkWhatsApp('Olá! Quero saber mais sobre o Tchê Food.')}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Falar no WhatsApp"
      className="fixed bottom-5 right-5 z-50 grid h-14 w-14 place-items-center rounded-full bg-emerald-500 text-white shadow-lg shadow-black/40 transition hover:scale-105 hover:bg-emerald-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
    >
      <MessageCircle className="h-7 w-7" aria-hidden />
    </a>
  );
}
