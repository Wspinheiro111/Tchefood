import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import type { AdminClient, StoreRow } from '../lib/api';
import { dateBr, dateTimeBr, formatCnpj, money, onlyDigits } from '../lib/format';
import NewStoreForm from './NewStoreForm';
import { Erro, Selo, useLoad } from './ui';

type Filtro = 'todas' | 'TRIAL' | 'ACTIVE' | 'SUSPENDED' | 'CANCELLED' | 'sem' | 'vencidas';

export default function Stores({ client, today, onOpenStore }: { client: AdminClient; today: string; onOpenStore: (id: string) => void }) {
  const { data, error, reload } = useLoad<StoreRow[]>(() => client.stores(), [client, today]);
  const [filtro, setFiltro] = useState<Filtro>('todas');
  const [busca, setBusca] = useState('');
  const [criando, setCriando] = useState(false);

  const lista = useMemo(() => {
    const q = busca.trim().toLowerCase();
    const qd = onlyDigits(q);
    return (data ?? []).filter((r) => {
      if (filtro === 'sem' && r.subscription) return false;
      if (filtro === 'vencidas' && r.overdue_count === 0) return false;
      if (['TRIAL', 'ACTIVE', 'SUSPENDED', 'CANCELLED'].includes(filtro) && r.subscription?.status !== filtro) return false;
      if (!q) return true;
      return r.name.toLowerCase().includes(q) || r.legal_name.toLowerCase().includes(q) || (qd.length >= 3 && r.cnpj.includes(qd)) || (r.city ?? '').toLowerCase().includes(q);
    });
  }, [data, filtro, busca]);

  if (criando) {
    return (
      <NewStoreForm
        client={client}
        onCancel={() => setCriando(false)}
        onCreated={(id) => {
          setCriando(false);
          reload();
          onOpenStore(id);
        }}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-xl font-bold text-slate-900">Lojas</h1>
        <button type="button" className="btn-primario" onClick={() => setCriando(true)}>
          <Plus className="h-4 w-4" /> Nova loja
        </button>
      </div>
      <div className="flex flex-wrap gap-2">
        <input className="campo max-w-xs" placeholder="Buscar por nome, CNPJ ou cidade" value={busca} onChange={(e) => setBusca(e.target.value)} />
        <select className="campo max-w-[14rem]" value={filtro} onChange={(e) => setFiltro(e.target.value as Filtro)}>
          <option value="todas">Todas</option>
          <option value="ACTIVE">Ativas</option>
          <option value="TRIAL">Em teste</option>
          <option value="SUSPENDED">Suspensas</option>
          <option value="CANCELLED">Canceladas</option>
          <option value="vencidas">Com cobrança vencida</option>
          <option value="sem">Sem assinatura</option>
        </select>
      </div>
      <Erro>{error}</Erro>
      {!data && !error && <p className="text-sm text-slate-500">Carregando…</p>}
      {data && (
        <div className="overflow-x-auto rounded-xl border border-borda">
          <table className="tabela w-full min-w-[760px]">
            <thead className="bg-surface">
              <tr>
                <th>Loja</th>
                <th>Situação</th>
                <th>Mensalidade</th>
                <th>Em aberto</th>
                <th>Uso</th>
              </tr>
            </thead>
            <tbody>
              {lista.map((r) => (
                <tr key={r.tenant_id} className="cursor-pointer hover:bg-surface" onClick={() => onOpenStore(r.tenant_id)}>
                  <td>
                    <p className="font-semibold text-slate-900">{r.name}</p>
                    <p className="text-xs text-slate-500">
                      {formatCnpj(r.cnpj)} · {r.city ?? '—'}/{r.state ?? '—'}
                    </p>
                  </td>
                  <td>
                    <Selo status={r.subscription?.status ?? null} />
                    {r.subscription?.status === 'TRIAL' && <p className="mt-1 text-xs text-slate-500">até {dateBr(r.subscription.trial_ends_on)}</p>}
                    {r.subscription && r.subscription.device_status !== 'READY' && <p className="mt-1 text-xs text-amber-700">sem conta do aparelho</p>}
                  </td>
                  <td>{r.subscription ? `${money(r.subscription.monthly_price)} · dia ${r.subscription.billing_day}` : '—'}</td>
                  <td>
                    {r.open_count === 0 ? (
                      <span className="text-slate-500">—</span>
                    ) : (
                      <>
                        <p>{money(r.open_amount)}</p>
                        {r.overdue_count > 0 && <p className="text-xs font-semibold text-brasa">vencida desde {dateBr(r.oldest_overdue_due)}</p>}
                      </>
                    )}
                  </td>
                  <td>
                    <p>{r.orders_7d} pedido(s) em 7 dias</p>
                    <p className="text-xs text-slate-500">última venda: {dateTimeBr(r.last_order_at)}</p>
                  </td>
                </tr>
              ))}
              {lista.length === 0 && (
                <tr>
                  <td colSpan={5} className="text-center text-slate-500">
                    Nenhuma loja neste filtro.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
