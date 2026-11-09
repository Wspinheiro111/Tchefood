import { useMemo, useState } from 'react';
import { Clock, QrCode as QrIcon, Sparkles, Users } from 'lucide-react';
import { useTcheStore } from '../store/useTcheStore';
import type { DiningTable, TableStatus } from '../types';
import { formatBRL } from '../lib/money';
import { elapsedLabel } from '../lib/ids';
import { useNow } from '../lib/useOnline';
import { Btn, Sheet, Stepper, toast } from '../components/ui';

const STATUS_STYLE: Record<TableStatus, { card: string; label: string; dot: string }> = {
  FREE: { card: 'border-slate-700 bg-surface', label: 'Livre', dot: 'bg-stone' },
  OCCUPIED: { card: 'border-brasa bg-brasa/15', label: 'Ocupada', dot: 'bg-brasa' },
  WAITING_BILL: { card: 'border-ouro bg-ouro/15 animate-pulse-ring', label: 'Pediu a conta', dot: 'bg-ouro' },
  PAYING: { card: 'border-pagbank bg-pagbank/15', label: 'Pagando', dot: 'bg-pagbank' },
  DIRTY: { card: 'border-slate-600 bg-slate-800/60 border-dashed', label: 'Limpeza', dot: 'bg-slate-400' },
};


export function TableMap({ onOpenOrder }: { onOpenOrder: (orderId: string) => void }) {
  const tables = useTcheStore((s) => s.tables);
  const orders = useTcheStore((s) => s.orders);
  const orderItems = useTcheStore((s) => s.orderItems);
  const releaseTable = useTcheStore((s) => s.releaseTable);
  const now = useNow(30_000);
  const [area, setArea] = useState<string>('ALL');
  const [opening, setOpening] = useState<DiningTable | null>(null);

  // Áreas vêm do cadastro de mesas (Retaguarda > Salão), na ordem em que aparecem.
  const filters = useMemo(() => {
    const areas = Array.from(new Set(tables.filter((t) => t.active).map((t) => t.area)));
    return [{ key: 'ALL', label: 'Todas' }, ...areas.map((a) => ({ key: a, label: a === 'Salão Principal' ? 'Salão' : a }))];
  }, [tables]);
  const visible = useMemo(
    () => tables.filter((t) => t.active && (area === 'ALL' || t.area === area)).sort((a, b) => a.number - b.number),
    [tables, area],
  );
  const counts = useMemo(() => {
    const c: Record<TableStatus, number> = { FREE: 0, OCCUPIED: 0, WAITING_BILL: 0, PAYING: 0, DIRTY: 0 };
    for (const t of tables) if (t.active) c[t.status] += 1;
    return c;
  }, [tables]);

  const tap = (t: DiningTable) => {
    if (t.status === 'FREE') return setOpening(t);
    if (t.status === 'DIRTY') {
      const r = releaseTable(t.id);
      if (r.ok) toast.success(`${t.label} liberada.`);
      else toast.error(r.error);
      return;
    }
    if (t.current_order_id) onOpenOrder(t.current_order_id);
  };

  return (
    <div className="mx-auto max-w-5xl px-3 pb-24 pt-3">
      <div className="scroll-thin -mx-3 mb-3 flex gap-2 overflow-x-auto px-3">
        {filters.map((f) => (
          <button
            key={f.key}
            onClick={() => setArea(f.key)}
            className={`min-h-touch shrink-0 rounded-full px-5 text-base font-semibold ${area === f.key ? 'bg-ouro text-slate-950' : 'bg-surface text-slate-300'}`}
          >
            {f.label}
          </button>
        ))}
      </div>
      <div className="mb-3 flex flex-wrap gap-3 text-xs text-slate-400">
        {(Object.keys(STATUS_STYLE) as TableStatus[]).map((s) => (
          <span key={s} className="inline-flex items-center gap-1">
            <span className={`h-2.5 w-2.5 rounded-full ${STATUS_STYLE[s].dot}`} /> {STATUS_STYLE[s].label} ({counts[s]})
          </span>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {visible.map((t) => {
          const order = t.current_order_id ? orders.find((o) => o.id === t.current_order_id) : undefined;
          const style = STATUS_STYLE[t.status];
          const hasQr = order ? orderItems.some((i) => i.order_id === order.id && i.origin === 'QRCODE_TABLE' && i.status === 'PENDING') : false;
          const ready = order ? orderItems.filter((i) => i.order_id === order.id && i.status === 'READY').length : 0;
          return (
            <button
              key={t.id}
              onClick={() => tap(t)}
              className={`relative flex min-h-[112px] flex-col justify-between rounded-2xl border-2 p-3 text-left active:scale-[0.98] ${style.card}`}
            >
              <div className="flex items-start justify-between">
                <div>
                  <div className="text-2xl font-black leading-none">{t.number}</div>
                  <div className="text-xs text-slate-400">{t.area === 'Salão Principal' ? 'Salão' : t.area}</div>
                </div>
                <span className="inline-flex items-center gap-1 rounded-md bg-black/30 px-1.5 py-0.5 text-[11px] font-bold">
                  <span className={`h-2 w-2 rounded-full ${style.dot}`} />
                  {style.label}
                </span>
              </div>
              {order ? (
                <div className="mt-2 space-y-0.5 text-sm">
                  <div className="text-lg font-bold tabular-nums">{formatBRL(order.paid_amount > 0 ? order.remaining_balance : order.total_amount)}</div>
                  <div className="flex items-center gap-3 text-xs text-slate-300">
                    <span className="inline-flex items-center gap-1"><Users className="h-3 w-3" />{order.customer_count}</span>
                    <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" />{elapsedLabel(order.opened_at, now)}</span>
                  </div>
                </div>
              ) : (
                <div className="mt-2 text-xs text-slate-500">
                  {t.status === 'DIRTY' ? (
                    <span className="inline-flex items-center gap-1 text-slate-300"><Sparkles className="h-3 w-3" /> Toque para liberar</span>
                  ) : (
                    <span>{t.capacity} lugares</span>
                  )}
                </div>
              )}
              {(hasQr || ready > 0) && (
                <div className="absolute -right-1 -top-1 flex gap-1">
                  {hasQr && <span className="grid h-6 w-6 place-items-center rounded-full bg-sky-500 text-white" title="Pedido via QR Code"><QrIcon className="h-3.5 w-3.5" /></span>}
                  {ready > 0 && <span className="grid h-6 min-w-6 place-items-center rounded-full bg-stone px-1.5 text-xs font-black text-slate-950" title="Itens prontos">{ready}</span>}
                </div>
              )}
            </button>
          );
        })}
      </div>

      <OpenTableSheet table={opening} onClose={() => setOpening(null)} onOpened={onOpenOrder} />
    </div>
  );
}

function OpenTableSheet({ table, onClose, onOpened }: { table: DiningTable | null; onClose: () => void; onOpened: (orderId: string) => void }) {
  const openTable = useTcheStore((s) => s.openTable);
  const [count, setCount] = useState(2);
  const [cpf, setCpf] = useState('');
  if (!table) return null;
  const confirm = () => {
    const r = openTable(table.id, count, cpf.trim() || null);
    if (!r.ok) return toast.error(r.error);
    toast.success(`${table.label} aberta.`);
    setCpf('');
    setCount(2);
    onClose();
    onOpened(r.data.id);
  };
  return (
    <Sheet
      open
      onClose={onClose}
      title={`Abrir ${table.label}`}
      footer={<Btn block size="lg" onClick={confirm}>Abrir mesa</Btn>}
    >
      <p className="mb-2 text-sm text-slate-400">{table.area} · {table.capacity} lugares</p>
      <label className="mb-2 block font-semibold">Quantas pessoas?</label>
      <div className="mb-3 flex justify-center"><Stepper value={count} onChange={setCount} max={40} /></div>
      <div className="mb-4 flex flex-wrap justify-center gap-2">
        {[1, 2, 3, 4, 6, 8].map((n) => (
          <button key={n} onClick={() => setCount(n)} className={`h-12 w-12 rounded-xl text-lg font-bold ${count === n ? 'bg-ouro text-slate-950' : 'bg-slate-700'}`}>{n}</button>
        ))}
      </div>
      <label className="mb-1 block font-semibold">CPF na nota (opcional)</label>
      <input
        inputMode="numeric"
        value={cpf}
        onChange={(e) => setCpf(e.target.value.replace(/[^\d.-]/g, '').slice(0, 14))}
        placeholder="000.000.000-00"
        className="min-h-touch w-full rounded-xl border border-slate-600 bg-base px-3 text-lg outline-none focus:border-ouro"
      />
    </Sheet>
  );
}
