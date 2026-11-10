import { useEffect, useMemo, useRef, useState } from 'react';
import { Ban, BellRing, ChefHat, Flame, GlassWater, LayoutGrid, MonitorSmartphone, ShoppingBag, Smartphone } from 'lucide-react';
import { selectCan, useTcheStore } from '../store/useTcheStore';
import type { ItemStatus, OrderItem, ProductionSector } from '../types';
import { playDispatchChime } from '../lib/sound';
import { useNow } from '../lib/useOnline';
import { Badge, Btn, Sheet, toast } from '../components/ui';
import { FULFILLMENT_LABEL, formatPickupNumber } from '../lib/kiosk';

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
/** No pedido com senha o cliente retira no balcão (o painel da TV chama a senha). */
function nextLabel(status: ItemStatus, pickup: boolean): string | undefined {
  if (pickup && status === 'READY') return 'Entregue no Balcão';
  return NEXT_LABEL[status];
}
const NEXT_STYLE: Partial<Record<ItemStatus, string>> = {
  PENDING: 'bg-sky-600 text-white',
  PREPARING: 'bg-stone text-white',
  READY: 'bg-slate-200 text-slate-950',
};

/** SLA: verde < 10 min, amarelo 10–19, vermelho piscante ≥ 20. */
export function slaClass(minutes: number): { card: string; timer: string; label: string } {
  if (minutes >= 20) return { card: 'animate-sla-late border-brasa', timer: 'bg-brasa text-white', label: 'Atrasado' };
  if (minutes >= 10) return { card: 'border-ouro bg-ouro/10', timer: 'bg-ouro text-slate-950', label: 'Atenção' };
  return { card: 'border-stone bg-stone/10', timer: 'bg-stone text-white', label: 'No prazo' };
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
  /** Pedido com senha (totem / caixa): mostra a senha no lugar da mesa. */
  pickup: { number: string; fulfillment: string | null; name: string | null; fromKiosk: boolean } | null;
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
  const canSoldOut = useTcheStore((s) => selectCan(s, 'MENU_AVAILABILITY'));
  const [soldOutOpen, setSoldOutOpen] = useState(false);
  const soldOutCount = products.filter((p) => p.active && !p.available).length;

  // Venda de balcão (Ficha Rápida) é entregue pela ficha no balcão, fora do KDS.
  const counterOrderIds = useMemo(() => {
    const counterTables = new Set(tables.filter((t) => t.kind === 'COUNTER').map((t) => t.id));
    return new Set(orders.filter((o) => counterTables.has(o.table_id)).map((o) => o.id));
  }, [orders, tables]);

  const ownDeliveries = useTcheStore((st) => st.ownDeliveries);
  // Pedido com senha (totem / caixa) só entra na produção depois de pago.
  const unpaidPickupIds = useMemo(() => {
    const kioskTables = new Set(tables.filter((t) => t.kind === 'KIOSK').map((t) => t.id));
    // Entrega paga na entrega vai para a cozinha logo: o dinheiro chega no acerto do entregador.
    const payOnDelivery = new Set(ownDeliveries.filter((d) => d.pay_on_delivery && d.status !== 'CANCELED').map((d) => d.order_id));
    return new Set(orders.filter((o) => kioskTables.has(o.table_id) && o.status !== 'CLOSED' && !payOnDelivery.has(o.id)).map((o) => o.id));
  }, [orders, tables, ownDeliveries]);
  const hiddenOrderIds = useMemo(() => new Set([...counterOrderIds, ...unpaidPickupIds]), [counterOrderIds, unpaidPickupIds]);

  // Alerta sonoro quando chega item novo na fila
  const pendingCount = items.filter((i) => i.status === 'PENDING' && !hiddenOrderIds.has(i.order_id)).length;
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
      // Conta paga não tira o item da produção: só o status do item decide.
      if (!order || order.status === 'CANCELED' || hiddenOrderIds.has(order.id)) continue;
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
          pickup:
            table?.kind === 'KIOSK'
              ? {
                  number: formatPickupNumber(order.pickup_number),
                  fulfillment: order.fulfillment_type ? FULFILLMENT_LABEL[order.fulfillment_type] : null,
                  name: order.pickup_name,
                  fromKiosk: i.origin === 'KIOSK',
                }
              : null,
        });
      }
      const t = map.get(key)!;
      t.items.push(i);
      if (i.created_at < t.oldest) t.oldest = i.created_at;
    }
    return [...map.values()].sort((a, b) => a.oldest.localeCompare(b.oldest));
  }, [items, orders, tables, staff, filter, hiddenOrderIds]);

  const bump = (ids: string[], fromStatus: ItemStatus, pickup = false) => {
    const r = advanceItems(ids);
    if (!r.ok) return toast.error(r.error);
    if (fromStatus === 'PREPARING' && sound) playDispatchChime();
    if (fromStatus === 'PREPARING') toast.success(pickup ? '✅ Pronto! Quando o pedido todo ficar pronto, a senha é chamada no painel.' : '✅ Pronto! Garçom avisado no mapa de mesas.');
  };

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { ALL: 0, GRILL: 0, KITCHEN: 0, BAR: 0 };
    for (const i of items) {
      if (i.status !== 'PENDING' && i.status !== 'PREPARING') continue;
      const o = orders.find((x) => x.id === i.order_id);
      if (!o || unpaidPickupIds.has(o.id)) continue;
      // Pedido com senha está pago (CLOSED) enquanto é preparado: conta na fila.
      if (o.status === 'CLOSED' && !tables.some((t) => t.id === o.table_id && t.kind === 'KIOSK')) continue;
      c.ALL++;
      if (matchFilter(i.sector, 'GRILL')) c.GRILL++;
      if (matchFilter(i.sector, 'KITCHEN')) c.KITCHEN++;
      if (matchFilter(i.sector, 'BAR')) c.BAR++;
    }
    return c;
  }, [items, orders, tables, unpaidPickupIds]);

  return (
    <div className="px-3 pb-10 pt-3">
      <div className="scroll-thin -mx-3 mb-3 flex gap-2 overflow-x-auto px-3">
        {FILTERS.map((f) => (
          <button key={f.key} onClick={() => setFilter(f.key)} className={`flex min-h-touch-lg shrink-0 items-center gap-2 rounded-xl px-5 text-lg font-bold ${filter === f.key ? 'bg-ouro text-slate-950' : 'bg-surface text-slate-700'}`}>
            {f.label} <span className="rounded-full bg-black/10 px-2 text-sm">{counts[f.key]}</span>
          </button>
        ))}
        {canSoldOut && (
          <button onClick={() => setSoldOutOpen(true)} className="ml-auto flex min-h-touch-lg shrink-0 items-center gap-2 rounded-xl bg-surface px-5 text-lg font-bold text-rose-600">
            <Ban className="h-5 w-5" /> Esgotados <span className="rounded-full bg-black/10 px-2 text-sm">{soldOutCount}</span>
          </button>
        )}
      </div>
      {soldOutOpen && <SoldOutSheet filter={filter} onClose={() => setSoldOutOpen(false)} />}

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
          const sla = waiting.length ? slaClass(minutes) : { card: 'border-slate-300 bg-slate-100', timer: 'bg-neutral-500 text-white', label: 'Pronto' };
          const lowest: ItemStatus = t.items.some((i) => i.status === 'PENDING') ? 'PENDING' : t.items.some((i) => i.status === 'PREPARING') ? 'PREPARING' : 'READY';
          const lowestIds = t.items.filter((i) => i.status === lowest).map((i) => i.id);
          return (
            <article key={t.key} className={`flex flex-col rounded-2xl border-4 p-3 ${sla.card}`}>
              <header className="mb-2 flex items-start justify-between gap-2">
                {t.pickup ? (
                  <div>
                    <div className="text-xs font-bold uppercase text-brasa">Senha</div>
                    <div className="text-4xl font-black leading-none tabular-nums">{t.pickup.number}</div>
                    <div className="text-sm text-slate-700">{[t.pickup.fulfillment, t.pickup.name].filter(Boolean).join(' · ')}</div>
                  </div>
                ) : (
                  <div>
                    <div className="text-4xl font-black leading-none">{t.tableNumber}</div>
                    <div className="text-sm text-slate-700">{t.tableLabel}</div>
                  </div>
                )}
                <div className="text-right">
                  <div className={`rounded-lg px-2 py-1 font-mono text-2xl font-black tabular-nums ${sla.timer}`}>
                    {minutes.toString().padStart(2, '0')}:{(seconds % 60).toString().padStart(2, '0')}
                  </div>
                  <div className="mt-1 text-xs font-bold uppercase">{sla.label}</div>
                </div>
              </header>
              <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
                {t.pickup ? (
                  <Badge className="bg-ouro text-slate-950">
                    {t.pickup.fromKiosk ? <MonitorSmartphone className="h-3 w-3" /> : <ShoppingBag className="h-3 w-3" />} {t.pickup.fromKiosk ? 'Totem' : `Caixa: ${t.waiterName}`} · pago
                  </Badge>
                ) : t.fromQr ? (
                  <Badge className="bg-sky-500 text-white"><Smartphone className="h-3 w-3" /> 📱 Pedido via QR Code</Badge>
                ) : (
                  <span className="font-semibold">Garçom: {t.fromQr ? '-' : t.waiterName}</span>
                )}
                <span className="text-slate-500">{new Date(t.oldest).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>
              </div>
              <ul className="mb-3 flex-1 space-y-2">
                {t.items.map((i) => {
                  const p = products.find((x) => x.id === i.product_id);
                  return (
                    <li key={i.id} className={`rounded-xl bg-white/80 p-2 shadow-sm ${i.status === 'READY' ? 'opacity-60' : ''}`}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="text-xl font-black leading-tight">
                          <span className="text-brasa">{i.quantity}x</span> {p?.name}
                        </div>
                        <Badge className={i.status === 'PENDING' ? 'bg-slate-300' : i.status === 'PREPARING' ? 'bg-ouro text-slate-950' : 'bg-stone text-white'}>
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
                        <button onClick={() => bump([i.id], i.status, Boolean(t.pickup))} className={`mt-2 min-h-touch w-full rounded-lg text-base font-bold ${NEXT_STYLE[i.status]}`}>
                          {nextLabel(i.status, Boolean(t.pickup))}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
              {t.items.length > 1 && NEXT_LABEL[lowest] && (
                <button onClick={() => bump(lowestIds, lowest, Boolean(t.pickup))} className={`min-h-touch-lg rounded-xl text-lg font-black ${NEXT_STYLE[lowest]}`}>
                  {nextLabel(lowest, Boolean(t.pickup))} · pedido completo ({lowestIds.length})
                </button>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}

/** Etapa 0 — a cozinha marca o que acabou; some do pedido do garçom e do cardápio QR. */
function SoldOutSheet({ filter, onClose }: { filter: Filter; onClose: () => void }) {
  const products = useTcheStore((s) => s.products);
  const setAvailable = useTcheStore((s) => s.setProductAvailable);
  const [q, setQ] = useState('');
  const term = q.trim().toLowerCase();
  const list = products
    .filter((p) => p.active && p.sector !== 'NONE' && matchFilter(p.sector, filter))
    .filter((p) => !term || p.name.toLowerCase().includes(term) || p.code.toLowerCase().includes(term))
    .sort((a, b) => Number(a.available) - Number(b.available) || a.name.localeCompare(b.name, 'pt-BR'));
  return (
    <Sheet open onClose={onClose} title="Marcar esgotado">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar produto" className="mb-3 min-h-touch w-full rounded-xl border border-slate-300 bg-base px-3 text-[1rem] text-slate-900 outline-none focus:border-ouro" />
      <div className="divide-y divide-slate-200 rounded-xl bg-base">
        {list.map((p) => (
          <div key={p.id} className="flex items-center gap-3 p-3">
            <div className="flex-1 font-bold">{p.name}{!p.available && <Badge className="ml-2 bg-brasa text-white">esgotado</Badge>}</div>
            <Btn
              variant={p.available ? 'secondary' : 'success'}
              onClick={() => {
                const r = setAvailable(p.id, !p.available);
                if (!r.ok) toast.error(r.error);
              }}
            >
              {p.available ? 'Esgotar' : 'Voltou'}
            </Btn>
          </div>
        ))}
        {list.length === 0 && <p className="p-4 text-center text-sm text-slate-500">Nenhum produto neste setor.</p>}
      </div>
    </Sheet>
  );
}
