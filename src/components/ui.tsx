import { useEffect, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { create } from 'zustand';

// ---------------------------------------------------------------------------
// Botão com alvo de toque mínimo de 48px (thumb-zone)
// ---------------------------------------------------------------------------
type Variant = 'primary' | 'secondary' | 'danger' | 'success' | 'ghost' | 'gold';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brasa text-white active:bg-rose-700 disabled:opacity-40',
  secondary: 'bg-slate-200 text-slate-900 active:bg-slate-300 disabled:opacity-50',
  danger: 'bg-transparent border-2 border-brasa text-rose-600 active:bg-brasa/20 disabled:opacity-40',
  success: 'bg-stone text-white active:bg-emerald-600 disabled:opacity-50',
  ghost: 'bg-transparent text-slate-700 active:bg-slate-100 disabled:opacity-40',
  gold: 'bg-ouro text-slate-950 active:bg-amber-600 disabled:opacity-50',
};

interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'md' | 'lg';
  block?: boolean;
}

export function Btn({ variant = 'primary', size = 'md', block, className = '', ...rest }: BtnProps) {
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 font-semibold transition-colors select-none disabled:cursor-not-allowed ${
        size === 'lg' ? 'min-h-touch-lg text-lg' : 'min-h-touch text-base'
      } ${block ? 'w-full' : ''} ${VARIANTS[variant]} ${className}`}
      {...rest}
    />
  );
}

// ---------------------------------------------------------------------------
// Bottom sheet / modal
// ---------------------------------------------------------------------------
interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  tone?: 'default' | 'danger';
}

export function Sheet({ open, onClose, title, children, footer, wide, tone = 'default' }: SheetProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className={`animate-slide-up flex max-h-[94vh] w-full flex-col rounded-t-2xl border-t bg-surface sm:rounded-2xl sm:border ${
          wide ? 'sm:max-w-3xl' : 'sm:max-w-lg'
        } ${tone === 'danger' ? 'border-brasa' : 'border-slate-200'}`}
      >
        <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
          <h2 className="text-lg font-bold">{title}</h2>
          <button aria-label="Fechar" onClick={onClose} className="grid h-11 w-11 place-items-center rounded-full active:bg-slate-200">
            <X className="h-6 w-6" />
          </button>
        </div>
        <div className="scroll-thin flex-1 overflow-y-auto px-4 py-3">{children}</div>
        {footer && <div className="border-t border-slate-200 px-4 py-3">{footer}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------
export function Badge({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-bold uppercase tracking-wide ${className}`}>
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------
type ToastKind = 'success' | 'error' | 'info' | 'alert';
interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
}
interface ToastState {
  toasts: Toast[];
  push: (kind: ToastKind, text: string) => void;
  dismiss: (id: number) => void;
}
let toastSeq = 0;
export const useToast = create<ToastState>((set, get) => ({
  toasts: [],
  push: (kind, text) => {
    const id = ++toastSeq;
    set({ toasts: [...get().toasts, { id, kind, text }] });
    setTimeout(() => get().dismiss(id), kind === 'alert' ? 6000 : 3500);
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

export const toast = {
  success: (t: string) => useToast.getState().push('success', t),
  error: (t: string) => useToast.getState().push('error', t),
  info: (t: string) => useToast.getState().push('info', t),
  alert: (t: string) => useToast.getState().push('alert', t),
};

const TOAST_STYLE: Record<ToastKind, string> = {
  success: 'bg-stone text-white',
  error: 'bg-brasa text-white',
  info: 'bg-neutral-800 text-white',
  alert: 'bg-ouro text-slate-950',
};

export function ToastHost() {
  const { toasts, dismiss } = useToast();
  return (
    <div className="pointer-events-none fixed inset-x-0 top-2 z-[100] flex flex-col items-center gap-2 px-3">
      {toasts.map((t) => (
        <button
          key={t.id}
          onClick={() => dismiss(t.id)}
          className={`pointer-events-auto w-full max-w-md rounded-xl px-4 py-3 text-left text-sm font-semibold shadow-2xl ${TOAST_STYLE[t.kind]}`}
        >
          {t.text}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stepper numérico grande
// ---------------------------------------------------------------------------
export function Stepper({ value, onChange, min = 1, max = 99 }: { value: number; onChange: (v: number) => void; min?: number; max?: number }) {
  return (
    <div className="flex items-center gap-2">
      <button
        aria-label="Diminuir"
        className="grid h-14 w-14 place-items-center rounded-xl bg-slate-200 text-2xl font-bold active:bg-slate-300 disabled:opacity-40"
        disabled={value <= min}
        onClick={() => onChange(Math.max(min, value - 1))}
      >
        −
      </button>
      <span className="w-14 text-center text-3xl font-black tabular-nums">{value}</span>
      <button
        aria-label="Aumentar"
        className="grid h-14 w-14 place-items-center rounded-xl bg-slate-200 text-2xl font-bold active:bg-slate-300 disabled:opacity-40"
        disabled={value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}
      >
        +
      </button>
    </div>
  );
}
