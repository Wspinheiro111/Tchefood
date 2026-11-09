import iconUrl from '../assets/brand/icon.png';
import logoUrl from '../assets/brand/logo.png';
import logoDarkUrl from '../assets/brand/logo-dark.png';

/** Símbolo oficial do Tchê Food (balão com talheres), fundo transparente. */
export function BrandMark({ className = 'h-9 w-9' }: { className?: string }) {
  return <img src={iconUrl} alt="Tchê Food" draggable={false} className={`object-contain ${className}`} />;
}

/**
 * Logo horizontal completa (símbolo + "TchêFood" + "Sistema para restaurantes e delivery").
 * `variant="dark"` troca o slogan preto por branco para fundos escuros.
 */
export function BrandLogo({ variant = 'light', className = 'h-12 w-auto' }: { variant?: 'light' | 'dark'; className?: string }) {
  return (
    <img
      src={variant === 'dark' ? logoDarkUrl : logoUrl}
      alt="Tchê Food — Sistema para restaurantes e delivery"
      draggable={false}
      className={`object-contain ${className}`}
    />
  );
}

/**
 * Cabeçalho padrão de relatórios e telas de gestão: logo oficial + título + loja + data/hora.
 */
export function ReportHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  const now = new Date().toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-700 bg-surface px-4 py-3">
      <BrandLogo variant="dark" className="h-12 w-auto sm:h-14" />
      <div className="text-right leading-tight">
        <div className="text-lg font-black">{title}</div>
        {subtitle && <div className="text-sm text-slate-400">{subtitle}</div>}
        <div className="text-xs text-slate-500">{now}</div>
      </div>
    </div>
  );
}

