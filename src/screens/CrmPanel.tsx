import { useMemo, useState } from 'react';
import { Gift, MessageCircle, Search } from 'lucide-react';
import { useTcheStore } from '../store/useTcheStore';
import { formatBRL } from '../lib/money';
import {
  availableCashback,
  balanceCashback,
  CASHBACK_DAYS_LABEL,
  CASHBACK_MAX_USAGE_PCT,
  CASHBACK_PCT,
  CASHBACK_VALIDITY_DAYS,
  formatWhatsapp,
  isCashbackCredit,
  isCashbackDay,
} from '../lib/loyalty';
import { Badge } from '../components/ui';
import { WinbackPanel } from './WinbackPanel';

const ENTRY_LABEL = { EARN: 'Crédito', REDEEM: 'Resgate', EXPIRE: 'Vencido', REFUND: 'Devolvido' } as const;

/** Retaguarda · CRM: clientes do programa, saldo de cashback e extrato. */
export function CrmPanel() {
  const customers = useTcheStore((s) => s.loyaltyCustomers);
  const ledger = useTcheStore((s) => s.cashbackLedger);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const now = new Date();

  const rows = useMemo(() => {
    const term = q.replace(/\D/g, '') || q.trim().toLowerCase();
    return customers
      .filter((c) => !q || c.phone_whatsapp.includes(term) || (c.name ?? '').toLowerCase().includes(term))
      .map((c) => ({
        c,
        balance: balanceCashback(ledger, c.id, now),
        available: availableCashback(ledger, c.id, now),
        visits: ledger.filter((e) => e.customer_id === c.id && e.entry_type === 'EARN').length,
        last: ledger.filter((e) => e.customer_id === c.id).reduce<string | null>((a, e) => (!a || e.created_at > a ? e.created_at : a), null),
      }))
      .sort((a, b) => ((a.last ?? '') < (b.last ?? '') ? 1 : -1));
  }, [customers, ledger, q]); // eslint-disable-line react-hooks/exhaustive-deps

  const earned = ledger.filter((e) => e.entry_type === 'EARN').reduce((a, e) => a + e.amount, 0);
  // Resgatado líquido: o que voltou ao cliente num cancelamento (REFUND) não foi usado.
  const redeemed = ledger.reduce((a, e) => a + (e.entry_type === 'REDEEM' ? e.amount : e.entry_type === 'REFUND' ? -e.amount : 0), 0);
  const outstanding = rows.reduce((a, r) => a + r.balance, 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Clientes no programa" value={String(customers.length)} hint={`${customers.filter((c) => c.whatsapp_opt_in).length} com WhatsApp autorizado`} />
        <Kpi label="Cashback concedido" value={formatBRL(earned)} hint={`${CASHBACK_PCT}% do consumo`} tone="text-brasa" />
        <Kpi label="Cashback resgatado" value={formatBRL(redeemed)} hint={`Só de ${CASHBACK_DAYS_LABEL}`} tone="text-verde" />
        <Kpi label="Saldo em aberto" value={formatBRL(outstanding)} hint={`Vence em ${CASHBACK_VALIDITY_DAYS} dias`} tone="text-rose-600" />
      </div>
      <p className="text-sm text-slate-500">
        Regras: {CASHBACK_PCT}% sobre o consumo sem os 10%, liberado a partir do dia seguinte, válido por {CASHBACK_VALIDITY_DAYS} dias, resgate de {CASHBACK_DAYS_LABEL} em até {CASHBACK_MAX_USAGE_PCT}% da conta. Hoje {isCashbackDay(now) ? 'é' : 'não é'} dia de resgate.
      </p>
      <WinbackPanel />
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-500" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar por nome ou WhatsApp" className="min-h-touch w-full rounded-xl border border-slate-200 bg-surface pl-11 pr-3 outline-none focus:border-ouro" />
      </div>
      <div className="space-y-2">
        {rows.map(({ c, balance, available, visits, last }) => (
          <div key={c.id} className="rounded-2xl border border-slate-200 bg-surface">
            <button onClick={() => setOpen(open === c.id ? null : c.id)} className="flex min-h-touch w-full items-center gap-3 p-3 text-left">
              <Gift className="h-5 w-5 shrink-0 text-brasa" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-bold">{c.name ?? 'Sem nome'} <span className="font-normal text-slate-500">· {formatWhatsapp(c.phone_whatsapp)}</span></div>
                <div className="text-xs text-slate-500">{visits} visita(s){last ? ` · última ${new Date(last).toLocaleDateString('pt-BR')}` : ''}</div>
              </div>
              {c.whatsapp_opt_in ? <Badge className="bg-emerald-50 text-emerald-700"><MessageCircle className="mr-1 inline h-3 w-3" />opt-in</Badge> : <Badge className="bg-slate-200">sem opt-in</Badge>}
              <div className="text-right">
                <div className="font-black tabular-nums text-brasa">{formatBRL(balance)}</div>
                <div className="text-[11px] text-slate-500">{formatBRL(available)} liberado</div>
              </div>
            </button>
            {open === c.id && (
              <table className="mx-3 mb-3 w-[calc(100%-1.5rem)] text-sm">
                <thead className="text-left text-xs uppercase text-slate-500"><tr><th className="py-1">Data</th><th>Tipo</th><th className="text-right">Valor</th><th className="text-right">Restante</th><th className="text-right">Vence</th></tr></thead>
                <tbody>
                  {ledger.filter((e) => e.customer_id === c.id).sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).map((e) => (
                    <tr key={e.id} className="border-t border-slate-200">
                      <td className="py-1">{new Date(e.created_at).toLocaleDateString('pt-BR')}</td>
                      <td>{ENTRY_LABEL[e.entry_type]}</td>
                      <td className={`text-right tabular-nums ${isCashbackCredit(e) ? 'text-verde' : 'text-rose-600'}`}>{isCashbackCredit(e) ? '+' : '−'}{formatBRL(e.amount)}</td>
                      <td className="text-right tabular-nums">{isCashbackCredit(e) ? formatBRL(e.remaining_amount) : ''}</td>
                      <td className="text-right">{e.expires_at ? new Date(e.expires_at).toLocaleDateString('pt-BR') : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ))}
        {rows.length === 0 && <p className="py-8 text-center text-slate-500">Nenhum cliente encontrado.</p>}
      </div>
    </div>
  );
}

function Kpi({ label, value, hint, tone = 'text-slate-900' }: { label: string; value: string; hint?: string; tone?: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-surface p-4">
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-black tabular-nums ${tone}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-500">{hint}</div>}
    </div>
  );
}
