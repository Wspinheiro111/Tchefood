import { useEffect, useState } from 'react';
import { Menu, X } from 'lucide-react';
import Logo from './Logo';
import { linkWhatsApp } from '../lib/config';

const LINKS = [
  { href: '#beneficios', label: 'Benefícios' },
  { href: '#calculadora', label: 'Calculadora' },
  { href: '#comparativo', label: 'Comparativo' },
  { href: '#planos', label: 'Planos' },
  { href: '#faq', label: 'Dúvidas' },
];

export default function Header() {
  const [aberto, setAberto] = useState(false);
  const [rolou, setRolou] = useState(false);

  useEffect(() => {
    const onScroll = () => setRolou(window.scrollY > 12);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header
      className={`sticky top-0 z-40 border-b transition-colors ${
        rolou ? 'border-borda bg-fundo/85 backdrop-blur' : 'border-transparent bg-transparent'
      }`}
    >
      <div className="container-lp flex h-16 items-center justify-between">
        <a href="#topo" aria-label="Tchê Food, início">
          <Logo />
        </a>
        <nav className="hidden items-center gap-7 text-sm text-slate-300 md:flex">
          {LINKS.map((l) => (
            <a key={l.href} href={l.href} className="transition hover:text-white">
              {l.label}
            </a>
          ))}
        </nav>
        <div className="hidden md:block">
          <a
            className="btn-primario py-2 text-sm"
            href={linkWhatsApp('Olá! Quero agendar uma demonstração do Tchê Food.')}
            target="_blank"
            rel="noopener noreferrer"
          >
            Agendar demonstração
          </a>
        </div>
        <button
          className="grid h-10 w-10 place-items-center rounded-lg border border-borda md:hidden"
          onClick={() => setAberto((v) => !v)}
          aria-expanded={aberto}
          aria-label={aberto ? 'Fechar menu' : 'Abrir menu'}
        >
          {aberto ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>
      {aberto && (
        <nav className="container-lp flex flex-col gap-1 border-t border-borda bg-fundo pb-4 pt-2 md:hidden">
          {LINKS.map((l) => (
            <a
              key={l.href}
              href={l.href}
              onClick={() => setAberto(false)}
              className="rounded-lg px-2 py-3 text-slate-200 hover:bg-surface"
            >
              {l.label}
            </a>
          ))}
          <a
            className="btn-primario mt-2"
            href={linkWhatsApp('Olá! Quero agendar uma demonstração do Tchê Food.')}
            target="_blank"
            rel="noopener noreferrer"
          >
            Agendar demonstração
          </a>
        </nav>
      )}
    </header>
  );
}
