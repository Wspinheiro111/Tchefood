import { Flame } from 'lucide-react';

export default function Logo({ compacto = false }: { compacto?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-brasa to-ouro shadow-lg shadow-brasa/30">
        <Flame className="h-5 w-5 text-white" aria-hidden />
      </span>
      <span className="leading-tight">
        <span className="block font-display text-lg font-extrabold text-white">Tchê Food</span>
        {!compacto && <span className="block text-[11px] text-slate-400">um produto W9 Sistemas</span>}
      </span>
    </span>
  );
}
