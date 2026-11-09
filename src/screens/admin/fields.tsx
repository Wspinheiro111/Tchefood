/** Etapa 0 — campos de formulário reutilizados pelas telas de cadastro. */
import type { InputHTMLAttributes, ReactNode } from 'react';

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="mb-3 block">
      <span className="mb-1 block text-sm font-semibold text-slate-700">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

const INPUT = 'min-h-touch w-full rounded-xl border border-slate-300 bg-base px-3 text-[1rem] text-slate-900 outline-none focus:border-ouro disabled:opacity-50';

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${INPUT} ${props.className ?? ''}`} />;
}

export function Select<T extends string>({ value, onChange, options, disabled }: { value: T; onChange: (v: T) => void; options: ReadonlyArray<{ value: T; label: string }>; disabled?: boolean }) {
  return (
    <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as T)} className={INPUT}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="mb-2 flex min-h-touch w-full items-center justify-between gap-3 rounded-xl bg-base px-3 text-left disabled:opacity-50"
    >
      <span className="text-sm font-semibold">{label}</span>
      <span className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${checked ? 'bg-stone' : 'bg-slate-300'}`}>
        <span className={`absolute top-1 h-5 w-5 rounded-full bg-white transition-all ${checked ? 'left-6' : 'left-1'}`} />
      </span>
    </button>
  );
}

export function Panel({ title, action, children }: { title: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-surface p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-bold">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

export function FormError({ error }: { error: string | null }) {
  if (!error) return null;
  return <p className="mb-3 rounded-lg bg-brasa/20 p-2 text-sm font-semibold text-rose-700">{error}</p>;
}

/**
 * Lê valor em reais digitado no padrão brasileiro ("1.234,50") ou com ponto ("12.5").
 * Devolve NaN quando não é número; a regra de 2 casas fica no validador do cadastro.
 */
export function parseMoneyInput(v: string): number {
  const t = v.trim().replace(/^R\$\s*/, '');
  if (t === '') return NaN;
  const normalized = t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t;
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) return NaN;
  return Number(normalized);
}

/** Valor em reais para preencher um campo de edição ("12,50"). */
export function moneyToInput(v: number): string {
  return v.toFixed(2).replace('.', ',');
}

/** Inteiro digitado; NaN quando vazio ou com letras. */
export function parseIntInput(v: string): number {
  return /^-?\d+$/.test(v.trim()) ? Number(v.trim()) : NaN;
}
