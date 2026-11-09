import { useMemo, useState } from 'react';
import { AlertTriangle, Beer, Droplets, Gauge, History, RefreshCw } from 'lucide-react';
import { isManagerRole, selectCurrentUser, useTcheStore } from '../store/useTcheStore';
import type { KegTap } from '../types';
import { formatBRL } from '../lib/money';
import { formatLiters, kegStatus, KEG_LOSS_CRITICAL_PCT, KEG_LOSS_WARN_PCT, type KegStatus } from '../lib/kegs';
import { ManagerAuthSheet } from '../components/ManagerAuthSheet';
import { Btn, Sheet, toast } from '../components/ui';

const WASTE_REASONS = ['Sangria do barril', 'Espuma / colarinho', 'Troca de barril', 'Limpeza da linha'];

/** Cilindro do barril: nível real (com leitura) ou estimado pelo caixa. */
function KegCylinder({ st }: { st: KegStatus }) {
  const color = st.alert === 'CRITICAL' ? 'from-rose-500 to-rose-700' : st.alert === 'WARN' ? 'from-amber-300 to-amber-500' : 'from-amber-200 to-amber-400';
  return (
    <div className="relative h-44 w-24 shrink-0 overflow-hidden rounded-[28px] border-4 border-slate-500 bg-slate-900" aria-label={`Nível ${st.levelPct}%`}>
      <div className={`absolute inset-x-0 bottom-0 bg-gradient-to-t ${color} transition-all duration-700`} style={{ height: `${st.levelPct}%` }}>
        <div className="h-2 bg-white/70" />
      </div>
      <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-2xl font-black text-white drop-shadow">{st.levelPct}%</div>
    </div>
  );
}

/**
 * Monitor de barris de chopp: cada chopp vendido baixa o nível; a leitura real
 * (balança do barril ou medidor de vazão) mostra quanto saiu sem faturar.
 */
export function KegMonitorScreen({ compact = false }: { compact?: boolean }) {
  const taps = useTcheStore((s) => s.kegTaps);
  const history = useTcheStore((s) => s.kegHistory);
  const user = useTcheStore(selectCurrentUser);
  const statuses = useMemo(() => taps.filter((t) => t.active).sort((a, b) => a.tap_number - b.tap_number).map(kegStatus), [taps]);
  const [wasteTap, setWasteTap] = useState<KegTap | null>(null);
  const [readingTap, setReadingTap] = useState<KegTap | null>(null);
  const [changeTap, setChangeTap] = useState<KegTap | null>(null);

  const totals = useMemo(() => {
    const billed = statuses.reduce((a, s) => a + s.tap.billed_volume_ml, 0);
    const consumed = statuses.reduce((a, s) => a + (s.realConsumedMl ?? 0), 0);
    const measuredBilled = statuses.filter((s) => s.realConsumedMl !== null).reduce((a, s) => a + s.tap.billed_volume_ml, 0);
    const loss = statuses.reduce((a, s) => a + (s.lossValue ?? 0), 0);
    return { billed, efficiency: consumed > 0 ? Math.round((measuredBilled / consumed) * 1000) / 10 : null, loss };
  }, [statuses]);
  const critical = statuses.filter((s) => s.alert === 'CRITICAL');

  return (
    <div className={compact ? '' : 'mx-auto max-w-6xl px-3 pb-10 pt-3'}>
      {critical.length > 0 && (
        <div className="mb-3 flex animate-pulse items-start gap-3 rounded-2xl border-2 border-rose-500 bg-rose-950/70 p-3 text-rose-100">
          <AlertTriangle className="h-7 w-7 shrink-0" />
          <div>
            <div className="font-black">ALERTA: volume real diferente do faturado</div>
            {critical.map((c) => <div key={c.tap.id} className="text-sm">Torneira {c.tap.tap_number} · {c.tap.beer_name}: {c.message}</div>)}
          </div>
        </div>
      )}

      <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-2xl border border-slate-700 bg-surface p-4">
          <div className="text-xs font-semibold uppercase text-slate-400">Índice de Aproveitamento</div>
          <div className={`text-3xl font-black tabular-nums ${totals.efficiency === null ? 'text-slate-400' : totals.efficiency >= 100 - KEG_LOSS_WARN_PCT ? 'text-stone' : totals.efficiency >= 100 - KEG_LOSS_CRITICAL_PCT ? 'text-ouro' : 'text-rose-400'}`}>
            {totals.efficiency === null ? '—' : `${totals.efficiency.toLocaleString('pt-BR')}%`}
          </div>
          <div className="text-xs text-slate-500">Faturado ÷ o que saiu do barril (torneiras com leitura)</div>
        </div>
        <div className="rounded-2xl border border-slate-700 bg-surface p-4">
          <div className="text-xs font-semibold uppercase text-slate-400">Desperdício não explicado</div>
          <div className={`text-3xl font-black tabular-nums ${totals.loss > 0 ? 'text-rose-400' : 'text-stone'}`}>{formatBRL(totals.loss)}</div>
          <div className="text-xs text-slate-500">Pelo custo do barril</div>
        </div>
        <div className="rounded-2xl border border-slate-700 bg-surface p-4">
          <div className="text-xs font-semibold uppercase text-slate-400">Faturado nos barris atuais</div>
          <div className="text-3xl font-black tabular-nums">{formatLiters(totals.billed)}</div>
          <div className="text-xs text-slate-500">Desde o engate de cada barril</div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {statuses.map((st) => (
          <div key={st.tap.id} className={`rounded-2xl border-2 bg-surface p-4 ${st.alert === 'CRITICAL' ? 'border-rose-500' : st.alert === 'WARN' ? 'border-amber-500/70' : 'border-slate-700'}`}>
            <div className="mb-3 flex items-center gap-2">
              <Beer className="h-6 w-6 text-ouro" />
              <div className="flex-1">
                <div className="font-black">Torneira {st.tap.tap_number} · {st.tap.beer_name}</div>
                <div className="text-xs text-slate-400">Barril de {formatLiters(st.tap.total_capacity_ml)} · engatado {new Date(st.tap.tapped_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</div>
              </div>
            </div>
            <div className="flex gap-4">
              <KegCylinder st={st} />
              <div className="flex-1 space-y-1 text-sm">
                <Row label="Faturado no caixa" value={formatLiters(st.tap.billed_volume_ml)} />
                <Row label="Desperdício registrado" value={formatLiters(st.tap.wasted_foam_ml)} />
                <Row label="Resta (estimado)" value={formatLiters(st.estimatedRemainingMl)} />
                <Row label="Resta (leitura real)" value={st.tap.measured_remaining_ml === null ? '—' : formatLiters(st.tap.measured_remaining_ml)} hint={st.tap.measured_at ? new Date(st.tap.measured_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : undefined} />
                {st.unexplainedLossMl !== null && <Row label="Saiu sem faturar" value={formatLiters(Math.max(st.unexplainedLossMl, 0))} tone={st.alert === 'CRITICAL' ? 'text-rose-400' : undefined} />}
                {st.efficiencyPct !== null && <Row label="Aproveitamento" value={`${st.efficiencyPct.toLocaleString('pt-BR')}%`} tone={st.alert === 'OK' ? 'text-stone' : st.alert === 'WARN' ? 'text-ouro' : 'text-rose-400'} />}
                {st.lossValue !== null && st.lossValue > 0 && <Row label="Prejuízo" value={formatBRL(st.lossValue)} tone="text-rose-400" />}
                <p className={`pt-1 text-xs font-bold ${st.alert === 'CRITICAL' ? 'text-rose-300' : st.alert === 'WARN' ? 'text-amber-300' : 'text-slate-400'}`}>{st.message}</p>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2">
              <Btn variant="secondary" onClick={() => setWasteTap(st.tap)}><Droplets className="h-4 w-4" /> Desperdício</Btn>
              <Btn variant="secondary" onClick={() => setReadingTap(st.tap)}><Gauge className="h-4 w-4" /> Leitura</Btn>
              <Btn variant="gold" onClick={() => setChangeTap(st.tap)}><RefreshCw className="h-4 w-4" /> Trocar barril</Btn>
            </div>
          </div>
        ))}
        {statuses.length === 0 && <p className="py-8 text-center text-slate-500">Nenhuma torneira ativa.</p>}
      </div>

      {!compact && history.length > 0 && (
        <div className="mt-4 rounded-2xl border border-slate-700 bg-surface p-4">
          <div className="mb-2 flex items-center gap-2 font-black"><History className="h-5 w-5" /> Barris encerrados</div>
          <div className="scroll-thin overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="text-left text-xs uppercase text-slate-400"><tr><th className="py-1">Torneira</th><th>Chopp</th><th>Faturado</th><th>Desperdício</th><th>Sobrou</th><th>Trocado</th></tr></thead>
              <tbody>
                {[...history].sort((a, b) => (a.kicked_at < b.kicked_at ? 1 : -1)).map((h) => (
                  <tr key={h.id} className="border-t border-slate-800">
                    <td className="py-1">{h.tap_number}</td><td>{h.beer_name}</td><td>{formatLiters(h.billed_volume_ml)}</td><td>{formatLiters(h.wasted_foam_ml)}</td>
                    <td>{h.measured_remaining_ml === null ? '—' : formatLiters(h.measured_remaining_ml)}</td>
                    <td>{new Date(h.kicked_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <WasteSheet tap={wasteTap} onClose={() => setWasteTap(null)} />
      <ReadingSheet tap={readingTap} onClose={() => setReadingTap(null)} />
      <ChangeKegSheet tap={changeTap} onClose={() => setChangeTap(null)} canSee={!!user && (isManagerRole(user.role) || user.role === 'CASHIER' || user.role === 'KITCHEN')} />
    </div>
  );
}

function Row({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: string }) {
  return (
    <div className="flex justify-between gap-2"><span className="text-slate-400">{label}{hint ? ` (${hint})` : ''}</span><b className={`tabular-nums ${tone ?? ''}`}>{value}</b></div>
  );
}

function parseLiters(raw: string): number {
  return Math.round((Number(raw.replace(',', '.')) || 0) * 1000);
}

function WasteSheet({ tap, onClose }: { tap: KegTap | null; onClose: () => void }) {
  const [liters, setLiters] = useState('');
  const [reason, setReason] = useState(WASTE_REASONS[0]!);
  if (!tap) return null;
  const submit = () => {
    const r = useTcheStore.getState().registerKegWaste(tap.id, parseLiters(liters), reason);
    if (!r.ok) return toast.error(r.error);
    toast.info(`Desperdício de ${formatLiters(parseLiters(liters))} registrado na torneira ${tap.tap_number}.`);
    setLiters('');
    onClose();
  };
  return (
    <Sheet open onClose={onClose} title={`Desperdício · Torneira ${tap.tap_number}`} footer={<Btn block size="lg" onClick={submit}>Registrar</Btn>}>
      <input inputMode="decimal" autoFocus value={liters} onChange={(e) => setLiters(e.target.value.replace(/[^\d.,]/g, ''))} placeholder="Litros (ex.: 0,5)" className="mb-3 min-h-touch-lg w-full rounded-xl border border-slate-600 bg-base px-3 text-lg outline-none focus:border-ouro" />
      <div className="flex flex-wrap gap-2">
        {WASTE_REASONS.map((r) => (
          <button key={r} onClick={() => setReason(r)} className={`min-h-touch rounded-xl px-3 text-sm font-bold ${reason === r ? 'bg-sky-600 text-white' : 'bg-base text-slate-300'}`}>{r}</button>
        ))}
      </div>
    </Sheet>
  );
}

function ReadingSheet({ tap, onClose }: { tap: KegTap | null; onClose: () => void }) {
  const [liters, setLiters] = useState('');
  if (!tap) return null;
  const submit = () => {
    const r = useTcheStore.getState().recordKegReading(tap.id, parseLiters(liters));
    if (!r.ok) return toast.error(r.error);
    const st = kegStatus(r.data);
    if (st.alert === 'CRITICAL') toast.alert(`🚨 Torneira ${tap.tap_number}: ${st.message}`);
    else toast.success(`Leitura registrada: aproveitamento ${st.efficiencyPct?.toLocaleString('pt-BR') ?? '—'}%.`);
    setLiters('');
    onClose();
  };
  return (
    <Sheet open onClose={onClose} title={`Leitura real · Torneira ${tap.tap_number}`} footer={<Btn block size="lg" onClick={submit}>Salvar leitura</Btn>}>
      <p className="mb-2 text-sm text-slate-400">Quanto resta no barril pela balança de barril ou pelo medidor de vazão. Barril de {formatLiters(tap.total_capacity_ml)}.</p>
      <input inputMode="decimal" autoFocus value={liters} onChange={(e) => setLiters(e.target.value.replace(/[^\d.,]/g, ''))} placeholder="Litros restantes (ex.: 26,3)" className="min-h-touch-lg w-full rounded-xl border border-slate-600 bg-base px-3 text-lg outline-none focus:border-ouro" />
    </Sheet>
  );
}

function ChangeKegSheet({ tap, onClose, canSee }: { tap: KegTap | null; onClose: () => void; canSee: boolean }) {
  const [beer, setBeer] = useState('');
  const [liters, setLiters] = useState('50');
  const [cost, setCost] = useState('');
  const [auth, setAuth] = useState(false);
  if (!tap || !canSee) return null;
  const keg = { beer_name: beer.trim() || tap.beer_name, total_capacity_ml: parseLiters(liters), keg_cost: Math.round((Number(cost.replace(',', '.')) || 0) * 100) / 100 };
  return (
    <>
      <Sheet open={!auth} onClose={onClose} title={`Trocar barril · Torneira ${tap.tap_number}`} footer={<Btn block size="lg" variant="gold" disabled={keg.total_capacity_ml <= 0} onClick={() => setAuth(true)}>Continuar (PIN do gerente)</Btn>}>
        <p className="mb-3 text-sm text-slate-400">O barril atual vai para o histórico com o faturado e o desperdício. O novo começa cheio.</p>
        <input value={beer} onChange={(e) => setBeer(e.target.value)} placeholder={tap.beer_name} className="mb-2 min-h-touch w-full rounded-xl border border-slate-600 bg-base px-3 outline-none focus:border-ouro" />
        <div className="grid grid-cols-2 gap-2">
          <input inputMode="decimal" value={liters} onChange={(e) => setLiters(e.target.value.replace(/[^\d.,]/g, ''))} placeholder="Litros" className="min-h-touch rounded-xl border border-slate-600 bg-base px-3 outline-none focus:border-ouro" />
          <input inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value.replace(/[^\d.,]/g, ''))} placeholder="Custo do barril (R$)" className="min-h-touch rounded-xl border border-slate-600 bg-base px-3 outline-none focus:border-ouro" />
        </div>
      </Sheet>
      <ManagerAuthSheet
        open={auth}
        onClose={() => setAuth(false)}
        title="Troca de barril"
        summary={<span>Torneira {tap.tap_number}: {tap.beer_name} → {keg.beer_name} ({formatLiters(keg.total_capacity_ml)})</span>}
        confirmLabel="Engatar barril novo"
        onSubmit={(managerPin, reason) => useTcheStore.getState().tapNewKeg(tap.id, keg, { managerPin, reason })}
        onSuccess={() => { setAuth(false); toast.success(`🍺 Barril novo engatado na torneira ${tap.tap_number}.`); onClose(); }}
      />
    </>
  );
}
