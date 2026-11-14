import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { AdminApiError } from '../lib/api';
import { STATUS_LABEL } from '../lib/format';

export function errorText(e: unknown): string {
  if (e instanceof AdminApiError) return e.message;
  if (e instanceof Error) return e.message;
  return 'Erro inesperado.';
}

/** Carrega dados com recarregar; erro aparece na tela. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const run = useCallback(load, deps);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    run()
      .then((d) => {
        if (!alive) return;
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => alive && setError(errorText(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [run, tick]);
  return { data, error, loading, reload: () => setTick((t) => t + 1) };
}

export function Erro({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{children}</p>;
}

export function Aviso({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{children}</p>;
}

const STATUS_COR: Record<string, string> = {
  TRIAL: 'bg-amber-100 text-amber-900',
  ACTIVE: 'bg-green-100 text-green-900',
  SUSPENDED: 'bg-red-100 text-red-900',
  CANCELLED: 'bg-slate-200 text-slate-700',
  OPEN: 'bg-amber-100 text-amber-900',
  PAID: 'bg-green-100 text-green-900',
};

export function Selo({ status }: { status: string | null }) {
  if (!status) return <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">Sem assinatura</span>;
  return <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_COR[status] ?? 'bg-slate-100'}`}>{STATUS_LABEL[status] ?? status}</span>;
}

export function Numero({ titulo, valor, detalhe, destaque }: { titulo: string; valor: string; detalhe?: string; destaque?: 'vermelho' | 'verde' }) {
  const cor = destaque === 'vermelho' ? 'text-brasa' : destaque === 'verde' ? 'text-verde' : 'text-slate-900';
  return (
    <div className="card">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{titulo}</p>
      <p className={`mt-1 text-2xl font-bold ${cor}`}>{valor}</p>
      {detalhe && <p className="mt-1 text-xs text-slate-500">{detalhe}</p>}
    </div>
  );
}

export function Campo({ rotulo, children, dica }: { rotulo: string; children: ReactNode; dica?: string }) {
  return (
    <label className="block">
      <span className="rotulo">{rotulo}</span>
      {children}
      {dica && <span className="mt-1 block text-xs text-slate-500">{dica}</span>}
    </label>
  );
}
