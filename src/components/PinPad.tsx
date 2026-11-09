import { useEffect } from 'react';
import { Delete } from 'lucide-react';
import { playTap } from '../lib/sound';

interface PinPadProps {
  value: string;
  onChange: (v: string) => void;
  onComplete?: (v: string) => void;
  length?: number;
  disabled?: boolean;
  error?: boolean;
  compact?: boolean;
}

/** Teclado numérico gigante para PIN (zero dependência de hover). */
export function PinPad({ value, onChange, onComplete, length = 4, disabled, error, compact }: PinPadProps) {
  const press = (d: string) => {
    if (disabled || value.length >= length) return;
    playTap();
    const next = value + d;
    onChange(next);
    if (next.length === length) onComplete?.(next);
  };
  const back = () => !disabled && onChange(value.slice(0, -1));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') back();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const keySize = compact ? 'h-14 text-2xl' : 'h-16 text-3xl sm:h-20';
  return (
    <div className="mx-auto w-full max-w-xs">
      <div className={`mb-4 flex justify-center gap-3 ${error ? 'animate-pulse' : ''}`}>
        {Array.from({ length }).map((_, i) => (
          <span
            key={i}
            className={`h-5 w-5 rounded-full border-2 ${
              error ? 'border-brasa bg-brasa' : i < value.length ? 'border-ouro bg-ouro' : 'border-slate-300'
            }`}
          />
        ))}
      </div>
      <div className="grid grid-cols-3 gap-3">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <button
            key={d}
            disabled={disabled}
            onClick={() => press(d)}
            className={`${keySize} rounded-2xl bg-slate-100 font-bold active:bg-slate-300 disabled:opacity-40`}
          >
            {d}
          </button>
        ))}
        <span />
        <button disabled={disabled} onClick={() => press('0')} className={`${keySize} rounded-2xl bg-slate-100 font-bold active:bg-slate-300 disabled:opacity-40`}>
          0
        </button>
        <button aria-label="Apagar" disabled={disabled} onClick={back} className={`${keySize} grid place-items-center rounded-2xl bg-slate-50 active:bg-slate-200`}>
          <Delete className="h-7 w-7" />
        </button>
      </div>
    </div>
  );
}
