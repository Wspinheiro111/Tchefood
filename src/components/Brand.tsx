import iconUrl from '../assets/brand/icon.png';
import logoUrl from '../assets/brand/logo.png';
import logoDarkUrl from '../assets/brand/logo-dark.png';
import logoAnimadaUrl from '../assets/brand/logo-animada.webp';
import { LOGO_ANIMADA_ENCAIXE } from '../assets/brand/logoAnimada';

/** Símbolo oficial do Tchê Food (balão com talheres, sem o acento solto em cima), fundo transparente. */
export function BrandMark({ className = 'h-9 w-9' }: { className?: string }) {
  return <img src={iconUrl} alt="Tchê Food" draggable={false} className={`object-contain ${className}`} />;
}

/**
 * Logo horizontal completa (símbolo + "TchêFood" + "Sistema para restaurantes e delivery").
 * `variant="dark"` é a versão negativa oficial (Tchê branco, Food amarelo) para fundos escuros.
 */
export function BrandLogo({
  variant = 'light',
  className = 'h-12 w-auto',
  effect = false,
}: {
  variant?: 'light' | 'dark';
  className?: string;
  /**
   * Versão animada oficial (balão pula, farelos, o acento cai no "ê" e um brilho passa no balão),
   * em loop. Usada no login, no totem e no painel de pedidos. Só existe na versão clara; quem
   * pede menos movimento no sistema vê a logo parada.
   */
  effect?: boolean;
}) {
  const src = variant === 'dark' ? logoDarkUrl : logoUrl;
  const alt = 'Tchê Food — Sistema para restaurantes e delivery';
  if (!effect || variant === 'dark') {
    return <img src={src} alt={alt} draggable={false} className={`object-contain ${className}`} />;
  }
  const e = LOGO_ANIMADA_ENCAIXE;
  return (
    <span role="img" aria-label={alt} className="relative inline-block">
      {/* A logo parada reserva o espaço (e aparece sozinha com movimento reduzido). */}
      <img src={src} alt="" aria-hidden="true" draggable={false} className={`brand-fx-still object-contain ${className}`} />
      <img
        src={logoAnimadaUrl}
        alt=""
        aria-hidden="true"
        draggable={false}
        className="brand-fx-anim pointer-events-none absolute max-w-none"
        style={{ left: `${e.left}%`, top: `${e.top}%`, width: `${e.width}%`, height: `${e.height}%` }}
      />
    </span>
  );
}

/**
 * Cabeçalho padrão de relatórios e telas de gestão: logo oficial + título + loja + data/hora.
 */
export function ReportHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  const now = new Date().toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-surface px-4 py-3">
      <BrandLogo className="h-12 w-auto sm:h-14" />
      <div className="text-right leading-tight">
        <div className="text-lg font-black">{title}</div>
        {subtitle && <div className="text-sm text-slate-500">{subtitle}</div>}
        <div className="text-xs text-slate-500">{now}</div>
      </div>
    </div>
  );
}

