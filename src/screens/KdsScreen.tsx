import { useEffect, useMemo, useRef, useState } from 'react';
import { BellRing, ChefHat, Flame, GlassWater, LayoutGrid, Smartphone } from 'lucide-react';
import { useTcheStore } from '../store/useTcheStore';
import type { ItemStatus, OrderItem, ProductionSector } from '../types';
import { playDispatchChime } from '../lib/sound';
import { useNow } from '../lib/useOnline';
import { Badge, toast } from '../components/ui';
import { QR_SELF_SERVICE_USER_ID } from '../data/seed';

type Filter = 'ALL' | 'GRILL' | 'KITCHEN' | 'BAR';
const FILTERS: Array<{ key: Filter; label: string; icon: typeof Flame }> = [
  { key: 'ALL', label: 'Todos', icon: LayoutGrid },
  { key: 'GRILL', label: '🔥 Parrilla', icon: Flame },
  { key: 'KITCHEN', label: '🍳 Cozinha', icon: ChefHat },
  { key: 'BAR', label: '🍺 Bar / Copa', icon: GlassWater },
];

const NEXT_LABEL: Partial<Record<ItemStatus, string>> = {
  PENDING: 'Iniciar Preparo',
  PREPARING: 'Marcar Pronto',
  READY: 'Entregue na Mesa',
};
const NEXT_STYLE: Partial<Record<ItemStatus, string>> = {
  PENDING: 'bg-sky-600 text-white',
  PREPARING: 'bg-stone text-slate-950',
  READY: 'bg-slate-200 text-slate-950',
};

/** SLA: verde < 10 min, amarelo 10–19, vermelho piscante ≥ 20. */
export function slaClass(minutes: number): { card: string; timer: string; label: string } {
  if (minutes >= 20) return { card: 'animate-sla-late border-brasa', timer: 'bg-brasa text-white', label: 'Atrasado' };
  if (minutes >= 10) return { card: 'border-ouro bg-ouro/10', timer: 'bg-ouro text-slate-950', label: 'Atenção' };
  return { card: 'border-stone bg-stone/10', timer: 'bg-stone text-slate-950', label: 'No prazo' };
}

function matchFilter(sector: ProductionSector, f: Filter): boolean {
  if (f === 'ALL') return true;
  if (f === 'KITCHEN') return sector === 'KITCHEN' || sector === 'DESSERT';
  return sector === f;
}

interface Ticket {
  key: string;
  orderId: string;
  tableLabel: string;
  tableNumber: number;
  items: OrderItem[];
  oldest: string;
  fromQr: boolean;
  waiterName: string;
}

export function KdsScreen() {
  const items = useTcheStore((s) => s.orderItems);
  const orders = useTcheStore((s) => s.orders);
  const tables = useTcheStore((s) => s.tables);
  const staff = useTcheStore((s) => s.staff);
  const products = useTcheStore((s) => s.products);
  const advanceItems = useTcheStore((s) => s.advanceItems);
  const sound = useTcheStore((s) => s.soundEnabled);
  const now = useNow(1000);
  const [filter, setFilter] = useState<Filter>('ALL');

  // Alerta sonoro quando chega item novo na fila
  const pendingCount = items.filter((i) => i.status === 'PENDING').length;
  const prev = useRef(pendingCount);
  useEffect(() => {
    if (pendingCount > prev.current) {
      if (sound) playDispatchChime();
      toast.alert(`🔔 ${pendingCount - prev.current} novo(s) item(ns) na produção`);
    }
    prev.current = pendingCount;
  }, [pendingCount, sound]);

  const tickets = useMemo<Ticket[]>(() => {
    const active = items.filter((i) => (i.status === 'PENDING' || i.status === 'PREPARING' || i.status === 'READY') && matchFilter(i.sector, filter));
    const map = new Map<string, Ticket>();
    for (const i of active) {
      const order = orders.find((o) => o.id === i.order_id);
      if (!order || order.status === 'CLOSED' || order.status === 'CANCELED') continue;
      // Um ticket por comanda + lote de origem (QR Code separado do garçom)
      const fromQr = i.origin === 'QRCODE_TABLE';
      const key = `${i.order_id}:${fromQr ? 'qr' : i.waiter_id}`;
      const table = tables.find((t) => t.id === order.table_id);
      if (!map.has(key)) {
        map.set(key, {
          key,
          orderId: order.id,
          tableLabel: table?.label ?? '?',
          tableNumber: table?.number ?? 0,
          items: [],
          oldest: i.created_at,
          fromQr,
          waiterName: staff.find((u) => u.id === i.waiter_id)?.name ?? '?',
        });
      }
      const t = map.get(key)!;
      t.items.push(i);
      if (i.created_at < t.oldest) t.oldest = i.created_at;
    }
    return [...map.values()].sort((a, b) => a.oldest.localeCompare(b.oldest));
  }, [items, orders, tables, staff, filter]);

  const bump = (ids: string[], fromStatus: ItemStatus) => {
    const r = advanceItems(ids);
    if (!r.ok) return toast.error(r.error);
    if (fromStatus === 'PREPARING' && sound) playDispatchChime();
    if (fromStatus === 'PREPARING') toast.success('✅ Pronto! Garçom avisado no mapa de mesas.');
  };

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { ALL: 0, GRILL: 0, KITCHEN: 0, BAR: 0 };
    for (const i of items) {
      if (i.status !== 'PENDING' && i.status !== 'PREPARING') continue;
      const o = orders.find((x) => x.id === i.order_id);
      if (!o || o.status === 'CLOSED') continue;
      c.ALL++;
      if (matchFilter(i.sector, 'GRILL')) c.GRILL++;
      if (matchFilter(i.sector, 'KITCHEN')) c.KITCHEN++;
      if (matchFilter(i.sector, 'BAR')) c.BAR++;
    }
    return c;
  }, [items, orders]);

  return (
    <div className="px-3 pb-10 pt-3">
      <div className="scroll-thin -mx-3 mb-3 flex gap-2 overflow-x-auto px-3">
        {FILTERS.map((f) => (
          <button key={f.key} onClick={() => setFilter(f.key)} className={`flex min-h-touch-lg shrink-0 items-center gap-2 rounded-xl px-5 text-lg font-bold ${filter === f.key ? 'bg-ouro text-slate-950' : 'bg-surface text-slate-300'}`}>
            {f.label} <span className="rounded-full bg-black/30 px-2 text-sm">{counts[f.key]}</span>
          </button>
        ))}
      </div>

      {tickets.length === 0 && (
        <div className="flex flex-col items-center py-20 text-slate-500">
          <BellRing className="mb-2 h-12 w-12" /> Nenhum pedido em produção. Bom trabalho, tchê!
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        {tickets.map((t) => {
          const waiting = t.items.filter((i) => i.status !== 'READY');
          const ref = waiting.length ? waiting.reduce((a, b) => (a.created_at < b.created_at ? a : b)).created_at : t.oldest;
          const seconds = Math.max(0, Math.floor((now - new Date(ref).getTime()) / 1000));
          const minutes = Math.floor(seconds / 60);
          const sla = waiting.length ? slaClass(minutes) : { card: 'border-slate-500 bg-slate-800', timer: 'bg-slate-500 text-white', label: 'Pronto' };
          const lowest: ItemStatus = t.items.some((i) => i.status === 'PENDING') ? 'PENDING' : t.items.some((i) => i.status === 'PREPARING') ? 'PREPARING' : 'READY';
          const lowestIds = t.items.filter((i) => i.status === lowest).map((i) => i.id);
          return (
            <article key={t.key} className={`flex flex-col rounded-2xl border-4 p-3 ${sla.card}`}>
              <header className="mb-2 flex items-start justify-between gap-2">
                <div>
                  <div className="text-4xl font-black leading-none">{t.tableNumber}</div>
                  <div className="text-sm text-slate-300">{t.tableLabel}</div>
                </div>
                <div className="text-right">
                  <div className={`rounded-lg px-2 py-1 font-mono text-2xl font-black tabular-nums ${sla.timer}`}>
                    {minutes.toString().padStart(2, '0')}:{(seconds % 60).toString().padStart(2, '0')}
                  </div>
                  <div className="mt-1 text-xs font-bold uppercase">{sla.label}</div>
                </div>
              </header>
              <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
                {t.fromQr ? (
                  <Badge className="bg-sky-500 text-white"><Smartphone className="h-3 w-3" /> 📱 Pedido via QR Code</Badge>
                ) : (
                  <span className="font-semibold">Garçom: {t.waiterName === staff.find((u) => u.id === QR_SELF_SERVICE_USER_ID)?.name ? '-' : t.waiterName}</span>
                )}
                <span className="text-slate-400">{new Date(t.oldest).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>
              </div>
              <ul className="mb-3 flex-1 space-y-2">
                {t.items.map((i) => {
                  const p = products.find((x) => x.id === i.product_id);
                  return (
                    <li key={i.id} className={`rounded-xl bg-black/40 p-2 ${i.status === 'READY' ? 'opacity-60' : ''}`}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="text-xl font-black leading-tight">
                          <span className="text-ouro">{i.quantity}x</span> {p?.name}
                        </div>
                        <Badge className={i.status === 'PENDING' ? 'bg-slate-600' : i.status === 'PREPARING' ? 'bg-ouro text-slate-950' : 'bg-stone text-slate-950'}>
                          {i.status === 'PENDING' ? 'Fila' : i.status === 'PREPARING' ? 'Preparo' : 'Pronto'}
                        </Badge>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {i.meat_doneness && <span className="rounded-md bg-rose-600 px-2 py-0.5 text-base font-black uppercase text-white">{i.meat_doneness}</span>}
                        {i.notes?.split(' · ').map((n) => (
                          <span key={n} className={`rounded-md px-2 py-0.5 text-sm font-bold ${n.startsWith('+') ? 'bg-emerald-200 text-emerald-950' : n.startsWith('1/2') ? 'bg-amber-200 text-amber-950' : 'bg-yellow-300 text-slate-950'}`}>{n}</span>
                        ))}
                      </div>
                      {NEXT_LABEL[i.status] && (
                        <button onClick={() => bump([i.id], i.status)} className={`mt-2 min-h-touch w-full rounded-lg text-base font-bold ${NEXT_STYLE[i.status]}`}>
                          {NEXT_LABEL[i.status]}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
              {t.items.length > 1 && NEXT_LABEL[lowest] && (
                <button onClick={() => bump(lowestIds, lowest)} className={`min-h-touch-lg rounded-xl text-lg font-black ${NEXT_STYLE[lowest]}`}>
                  {NEXT_LABEL[lowest]} · pedido completo ({lowestIds.length})
                </button>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
