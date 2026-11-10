/**
 * Retaguarda › Taxas e recebíveis: o contrato da maquininha (taxa por forma e bandeira,
 * tarifa fixa e prazo), a comissão dos apps e a agenda do que cai na conta.
 * Gerente e proprietário editam; o caixa só consulta.
 */
import { useMemo, useState } from 'react';
import { CalendarDays, Pencil, Plus, Trash2 } from 'lucide-react';
import { Btn, Sheet, toast } from '../components/ui';
import { isManagerRole, selectCurrentUser, useTcheStore } from '../store/useTcheStore';
import { useOwnerSettings } from '../store/useOwnerSettings';
import { formatBRL } from '../lib/money';
import { parseMoneyInput } from '../lib/cashRegister';
import { DELIVERY_CHANNEL_CATALOG } from '../../server/delivery/marketplace';
import { FEE_ACQUIRER_LABEL, FEE_BRANDS, FEE_METHOD_LABEL, receivables, type FeeAcquirer, type FeeMethod, type FeeRule } from '../lib/cardFees';

type Draft = { id?: string; acquirer: FeeAcquirer; method: FeeMethod; brand: string | null; pct: string; fixed: string; days: string; businessDays: boolean };

const EMPTY: Draft = { acquirer: 'STONE', method: 'DEBIT', brand: null, pct: '', fixed: '0', days: '1', businessDays: true };
const pctText = (v: number) => `${v.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;
const dayLabel = (d: Date) => d.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' });

/** "1,99" ou "1.99" → número; vazio ou inválido → NaN. */
const parsePct = (raw: string) => {
  const t = raw.trim().replace('%', '').replace(',', '.');
  return t === '' || !/^\d+(\.\d{1,2})?$/.test(t) ? NaN : Number(t);
};

export function FeesReceivables() {
  const user = useTcheStore(selectCurrentUser);
  const payments = useTcheStore((s) => s.payments);
  const canEdit = isManagerRole(user?.role);
  const rules = useOwnerSettings((s) => s.feeRules);
  const saveFeeRule = useOwnerSettings((s) => s.saveFeeRule);
  const removeFeeRule = useOwnerSettings((s) => s.removeFeeRule);
  const commissions = useOwnerSettings((s) => s.appCommissionPct);
  const setAppCommission = useOwnerSettings((s) => s.setAppCommission);
  const [draft, setDraft] = useState<Draft | null>(null);
  const agenda = useMemo(() => receivables(payments, rules), [payments, rules]);
  const maxNet = Math.max(1, ...agenda.days.map((d) => d.net));

  const sorted = [...rules].sort((a, b) => `${a.acquirer}${a.method}${a.brand ?? ''}`.localeCompare(`${b.acquirer}${b.method}${b.brand ?? ''}`));

  const save = () => {
    if (!draft) return;
    const err = saveFeeRule({
      id: draft.id,
      acquirer: draft.acquirer,
      method: draft.method,
      brand: draft.brand,
      pct: parsePct(draft.pct),
      fixed: parseMoneyInput(draft.fixed || '0'),
      days: Number(draft.days),
      businessDays: draft.businessDays,
    });
    if (err) return toast.error(err);
    setDraft(null);
    toast.success('Taxa salva.');
  };

  const edit = (r: FeeRule) => setDraft({ id: r.id, acquirer: r.acquirer, method: r.method, brand: r.brand, pct: String(r.pct).replace('.', ','), fixed: String(r.fixed).replace('.', ','), days: String(r.days), businessDays: r.businessDays });

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-slate-200 bg-base p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="font-black">Agenda de recebíveis</h3>
            <p className="text-sm text-slate-500">O que cai na conta nos próximos 35 dias, já sem a taxa. Fim de semana conta; feriado não.</p>
          </div>
          <div className="text-right">
            <div className="text-xs font-bold uppercase text-slate-500">A receber</div>
            <div className="text-2xl font-black tabular-nums text-verde">{formatBRL(agenda.totalNet)}</div>
          </div>
        </div>
        {agenda.withoutRuleCount > 0 && (
          <p role="alert" className="mb-3 rounded-xl bg-amarelo/15 p-3 text-sm">
            {agenda.withoutRuleCount} pagamento(s) na maquininha ({formatBRL(agenda.withoutRule)}) sem taxa cadastrada ficaram fora da agenda. Cadastre a taxa abaixo.
          </p>
        )}
        {agenda.days.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 p-4 text-center text-sm text-slate-500">Nada a receber nos próximos dias.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="text-left text-xs uppercase text-slate-500">
                <tr><th className="p-2">Dia</th><th className="p-2 text-right">Vendas</th><th className="p-2 text-right">Bruto</th><th className="p-2 text-right">Taxa</th><th className="p-2 text-right">Cai na conta</th><th className="p-2">Por maquininha</th></tr>
              </thead>
              <tbody>
                {agenda.days.map((d) => (
                  <tr key={d.date.getTime()} className="border-t border-slate-100">
                    <td className="p-2 font-semibold"><CalendarDays className="mr-1 inline h-4 w-4 text-slate-400" />{dayLabel(d.date)}</td>
                    <td className="p-2 text-right">{d.count}</td>
                    <td className="p-2 text-right tabular-nums">{formatBRL(d.gross)}</td>
                    <td className="p-2 text-right tabular-nums text-rose-700">− {formatBRL(d.fee)}</td>
                    <td className="p-2 text-right font-black tabular-nums">
                      {formatBRL(d.net)}
                      <div className="ml-auto mt-1 h-1.5 rounded-full bg-surface"><div className="ml-auto h-1.5 rounded-full bg-verde" style={{ width: `${(d.net / maxNet) * 100}%` }} /></div>
                    </td>
                    <td className="p-2 text-xs text-slate-600">{Object.entries(d.byAcquirer).map(([a, v]) => `${FEE_ACQUIRER_LABEL[a as FeeAcquirer]} ${formatBRL(v)}`).join(' · ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-base p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="font-black">Taxas da maquininha</h3>
            <p className="text-sm text-slate-500">Use as taxas do seu contrato. Taxa por bandeira vale antes da taxa de "todas as bandeiras".</p>
          </div>
          {canEdit && <Btn variant="gold" onClick={() => setDraft({ ...EMPTY })}><Plus className="h-4 w-4" /> Nova taxa</Btn>}
        </div>
        {sorted.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 p-4 text-center text-sm text-slate-500">Nenhuma taxa cadastrada. Sem elas o painel não desconta as taxas e a agenda fica vazia.</div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {sorted.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                <span className="mr-auto">
                  <b>{FEE_ACQUIRER_LABEL[r.acquirer]}</b> · {FEE_METHOD_LABEL[r.method]} · {r.brand ?? 'todas as bandeiras'}
                </span>
                <span className="tabular-nums">{pctText(r.pct)}{r.fixed > 0 ? ` + ${formatBRL(r.fixed)}` : ''}</span>
                <span className="w-28 text-right text-slate-600">D+{r.days} {r.businessDays ? 'útil' : 'corrido'}</span>
                {canEdit && (
                  <>
                    <button aria-label="Editar taxa" onClick={() => edit(r)} className="grid h-11 w-11 place-items-center rounded-xl bg-surface"><Pencil className="h-4 w-4" /></button>
                    <button aria-label="Excluir taxa" onClick={() => removeFeeRule(r.id)} className="grid h-11 w-11 place-items-center rounded-xl bg-surface text-brasa"><Trash2 className="h-4 w-4" /></button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-slate-500">O app cobra só à vista; parcelado e antecipação ficam para quando a maquininha passar a cobrar parcelado.</p>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-base p-4">
        <h3 className="font-black">Comissão dos apps de delivery</h3>
        <p className="mb-3 text-sm text-slate-500">Percentual do seu plano em cada app, para o "Quanto sobrou?".</p>
        <ul className="grid gap-2 sm:grid-cols-2">
          {Object.values(DELIVERY_CHANNEL_CATALOG).map((c) => (
            <li key={`${c.key}-${commissions[c.key] ?? ""}`} className="flex items-center gap-2 rounded-xl bg-surface p-2">
              <span className="mr-auto font-semibold">{c.label}</span>
              <input
                aria-label={`Comissão ${c.label}`}
                disabled={!canEdit}
                inputMode="decimal"
                defaultValue={commissions[c.key] === null || commissions[c.key] === undefined ? '' : String(commissions[c.key]).replace('.', ',')}
                placeholder="—"
                onBlur={(e) => {
                  const raw = e.target.value.trim();
                  const err = setAppCommission(c.key, raw === '' ? null : parsePct(raw));
                  if (err) toast.error(err);
                }}
                className="min-h-touch w-32 rounded-lg border border-slate-300 bg-base px-2 text-right"
              />
              <span className="text-slate-500">%</span>
            </li>
          ))}
        </ul>
      </section>

      <Sheet open={draft !== null} onClose={() => setDraft(null)} title={draft?.id ? 'Editar taxa' : 'Nova taxa'} footer={<Btn block onClick={save}>Salvar taxa</Btn>}>
        {draft && (
          <div className="space-y-3">
            <Choice label="Maquininha" value={draft.acquirer} options={Object.entries(FEE_ACQUIRER_LABEL)} onChange={(v) => setDraft({ ...draft, acquirer: v as FeeAcquirer })} />
            <Choice label="Forma de pagamento" value={draft.method} options={Object.entries(FEE_METHOD_LABEL)} onChange={(v) => setDraft({ ...draft, method: v as FeeMethod, brand: v === 'PIX' ? null : draft.brand })} />
            {draft.method !== 'PIX' && (
              <Choice label="Bandeira" value={draft.brand ?? ''} options={[['', 'Todas'], ...FEE_BRANDS.map((b) => [b, b] as [string, string])]} onChange={(v) => setDraft({ ...draft, brand: v || null })} />
            )}
            <div className="grid grid-cols-3 gap-2">
              <Field label="Taxa (%)" value={draft.pct} onChange={(v) => setDraft({ ...draft, pct: v })} placeholder="1,99" />
              <Field label="Tarifa fixa (R$)" value={draft.fixed} onChange={(v) => setDraft({ ...draft, fixed: v })} placeholder="0,00" />
              <Field label="Prazo (D+)" value={draft.days} onChange={(v) => setDraft({ ...draft, days: v.replace(/\D/g, '') })} placeholder="30" />
            </div>
            <label className="flex min-h-touch items-center gap-2 text-sm font-semibold">
              <input type="checkbox" checked={draft.businessDays} onChange={(e) => setDraft({ ...draft, businessDays: e.target.checked })} className="h-5 w-5" />
              Prazo em dias úteis (pula sábado e domingo)
            </label>
          </div>
        )}
      </Sheet>
    </div>
  );
}

function Choice({ label, value, options, onChange }: { label: string; value: string; options: Array<[string, string]>; onChange: (v: string) => void }) {
  return (
    <div>
      <div className="mb-1 text-sm font-bold text-slate-700">{label}</div>
      <div className="flex flex-wrap gap-2">
        {options.map(([k, l]) => (
          <button key={k} onClick={() => onChange(k)} className={`min-h-touch rounded-xl px-3 text-sm font-bold ${value === k ? 'bg-brasa text-white' : 'bg-surface text-slate-700'}`}>{l}</button>
        ))}
      </div>
    </div>
  );
}

function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <label className="block">
      <span className="text-sm font-bold text-slate-700">{label}</span>
      <input inputMode="decimal" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className="mt-1 min-h-touch w-full rounded-xl border border-slate-300 px-3 text-right" />
    </label>
  );
}
