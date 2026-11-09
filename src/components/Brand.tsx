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
