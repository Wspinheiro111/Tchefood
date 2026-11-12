import iconUrl from '../assets/brand/icon.png';
import logoUrl from '../assets/brand/logo.webp';

/**
 * Logo oficial do Tchê Food.
 * - padrão: logo horizontal completa (símbolo + nome + "Sistema para restaurantes e delivery")
 * - `compacto`: só o símbolo + nome em texto, para espaços pequenos
 */
export default function Logo({ compacto = false }: { compacto?: boolean }) {
  if (compacto) {
    return (
      <span className="inline-flex items-center gap-2">
        <img src={iconUrl} alt="" aria-hidden width={36} height={35} className="h-9 w-9 object-contain" />
        <span className="font-display text-lg font-extrabold">
          <span className="text-verde">Tchê</span>
          <span className="text-brasa">Food</span>
        </span>
      </span>
    );
  }
  return (
    <span className="inline-flex flex-col items-start">
      <img
        src={logoUrl}
        alt="Tchê Food — Sistema para restaurantes e delivery"
        width={360}
        height={89}
        decoding="async"
        className="h-10 w-auto object-contain sm:h-11"
      />
      <span className="sr-only">um produto W9 Sistemas</span>
    </span>
  );
}
