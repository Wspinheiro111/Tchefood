import { useMemo, useState } from 'react';
import { CheckCircle2, MapPin, MessageCircle, Phone, Route, Wallet, XCircle } from 'lucide-react';
import { CASH_ROLES, selectCurrentUser, useTcheStore } from '../store/useTcheStore';
import { formatBRL } from '../lib/money';
import { formatPickupNumber } from '../lib/kiosk';
import { MAX_ROUTE_STOPS, OWN_DELIVERY_STATUS_LABEL, outForDeliveryMessageUrl, routeUrl, settlementPreview } from '../lib/ownDelivery';
import { Badge, Btn, Sheet, toast } from '../components/ui';
import { ManagerAuthSheet } from '../components/ManagerAuthSheet';
import type { Order, OwnDelivery } from '../types';

const COLUMNS: OwnDelivery['status'][] = ['PREPARING', 'READY', 'OUT', 'DELIVERED'];
const CANCEL_REASONS = ['Cliente desistiu', 'Endereço não encontrado', 'Cliente não atendeu', 'Erro de lançamento'];

/** Quadro da entrega própria: em preparo → pronto → saiu (com rota) → entregue, e o acerto com o entregador. */
export function OwnDeliveryBoard() {
  const deliveries = useTcheStore((s) => s.ownDeliveries);
  const orders = useTcheStore((s) => s.orders);
  const couriers = useTcheStore((s) => s.couriers);
  const tenant = useTcheStore((s) => s.tenant);
  const user = useTcheStore(selectCurrentUser);
  const [selected, setSelected] = useState<string[]>([]);
  const [courierId, setCourierId] = useState('');
  const [cancelFor, setCancelFor] = useState<OwnDelivery | null>(null);
  const [settleFor, setSettleFor] = useState<string | null>(null);
  const [payAuthOpen, setPayAuthOpen] = useState(false);
  const [sentOut, setSentOut] = useState<OwnDelivery[] | null>(null);

  const orderById = useMemo(() => new Map(orders.map((o) => [o.id, o])), [orders]);
  const today = new Date().toDateString();
  // Entregues ficam no quadro só no dia; as ainda não acertadas aparecem no acerto.
  const visible = deliveries.filter((d) => d.status !== 'CANCELED' && (d.status !== 'DELIVERED' || new Date(d.delivered_at ?? d.created_at).toDateString() === today));
  const activeCouriers = couriers.filter((c) => c.active);
  const canSettle = user ? CASH_ROLES.includes(user.role) : false;
  const toSettle = couriers
    .map((c) => ({ courier: c, preview: settlementPreview(c.id, deliveries, orders) }))
    .filter((x) => x.preview.deliveries.length > 0);

  const act = (r: { ok: boolean; error?: string }, ok: string) => (r.ok ? toast.success(ok) : toast.error(r.error ?? 'Não deu certo.'));
  const label = (d: OwnDelivery) => formatPickupNumber(orderById.get(d.order_id)?.pickup_number ?? null);

  const toggle = (id: string) =>
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : cur.length >= MAX_ROUTE_STOPS ? (toast.error(`No máximo ${MAX_ROUTE_STOPS} entregas por rota.`), cur) : [...cur, id]));

  const dispatch = () => {
    const r = useTcheStore.getState().dispatchOwnDeliveries(selected, courierId);
    if (!r.ok) return toast.error(r.error);
    setSelected([]);
    setSentOut(r.data);
    toast.success(`${r.data.length} entrega(s) saíram com ${couriers.find((c) => c.id === courierId)?.name ?? 'o entregador'}.`);
  };

  const settling = toSettle.find((x) => x.courier.id === settleFor);
  const settle = (payFromDrawer: boolean, auth: { managerPin: string; reason: string } | null) =>
    useTcheStore.getState().settleCourier(settleFor!, { payFromDrawer, auth });

  return (
    <div className="mx-auto max-w-6xl p-3">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h1 className="mr-auto flex items-center gap-2 text-xl font-black"><MapPin className="h-6 w-6 text-brasa" /> Entrega própria</h1>
        <span className="text-xs text-slate-500">Lance o pedido em Balcão › Entrega.</span>
      </div>

      {toSettle.length > 0 && (
        <section className="mb-4 rounded-2xl border border-ouro/50 bg-ouro/10 p-3">
          <h2 className="mb-2 flex items-center gap-2 font-black"><Wallet className="h-5 w-5" /> Acerto com entregador</h2>
          <div className="grid gap-2 sm:grid-cols-2">
            {toSettle.map(({ courier, preview }) => (
              <div key={courier.id} className="flex items-center gap-3 rounded-xl bg-surface p-3">
                <div className="mr-auto text-sm">
                  <div className="font-black">{courier.name}</div>
                  <div className="text-slate-600">{preview.deliveries.length} entrega(s) · ganho {formatBRL(preview.courierFees)}</div>
                  <div className="text-slate-600">Dinheiro com ele: <b>{formatBRL(preview.cashToCollect)}</b> ({preview.cashOrders} conta(s))</div>
                </div>
                {canSettle && <Btn variant="gold" onClick={() => setSettleFor(courier.id)}>Acertar</Btn>}
              </div>
            ))}
          </div>
        </section>
      )}

      {selected.length > 0 && (
        <div className="sticky top-0 z-10 mb-3 flex flex-wrap items-center gap-2 rounded-2xl bg-slate-900 p-3 text-white">
          <span className="font-bold">{selected.length} na rota</span>
          <select value={courierId} onChange={(e) => setCourierId(e.target.value)} aria-label="Entregador" className="min-h-touch rounded-xl bg-white px-3 text-slate-900">
            <option value="">Entregador…</option>
            {activeCouriers.map((c) => <option key={c.id} value={c.id}>{c.name} · {formatBRL(c.fee_per_delivery)}/entrega</option>)}
          </select>
          <Btn variant="success" disabled={!courierId} onClick={dispatch}><Route className="h-4 w-4" /> Saiu para entrega</Btn>
          <Btn variant="secondary" onClick={() => setSelected([])}>Limpar</Btn>
          {activeCouriers.length === 0 && <span className="text-xs">Cadastre entregadores em Retaguarda › Entrega própria.</span>}
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {COLUMNS.map((col) => {
          const list = visible.filter((d) => d.status === col);
          return (
            <section key={col} className="rounded-2xl bg-base p-2" aria-label={OWN_DELIVERY_STATUS_LABEL[col]}>
              <h2 className="mb-2 flex items-center justify-between px-1 text-sm font-black uppercase text-slate-600">
                {OWN_DELIVERY_STATUS_LABEL[col]} <Badge className="bg-slate-200 text-slate-700">{list.length}</Badge>
              </h2>
              <div className="space-y-2">
                {list.length === 0 && <p className="px-1 py-4 text-center text-xs text-slate-400">Nada aqui.</p>}
                {list.map((d) => (
                  <DeliveryCard
                    key={d.id}
                    d={d}
                    order={orderById.get(d.order_id)}
                    label={label(d)}
                    courierName={couriers.find((c) => c.id === d.courier_id)?.name}
                    selected={selected.includes(d.id)}
                    onToggle={() => toggle(d.id)}
                    onReady={() => act(useTcheStore.getState().setOwnDeliveryStatus(d.id, 'READY'), `${label(d)} pronto para sair.`)}
                    onDelivered={() => act(useTcheStore.getState().setOwnDeliveryStatus(d.id, 'DELIVERED'), `${label(d)} entregue.`)}
                    onCancel={() => setCancelFor(d)}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>

      <Sheet open={sentOut !== null} onClose={() => setSentOut(null)} title="Rota do entregador">
        {sentOut && (
          <div className="space-y-2">
            {(() => {
              const url = routeUrl(tenant, sentOut);
              return url ? (
                <a href={url} target="_blank" rel="noreferrer" className="flex min-h-touch items-center justify-center gap-2 rounded-xl bg-verde font-black text-white">
                  <Route className="h-5 w-5" /> Abrir rota no mapa ({sentOut.length} parada{sentOut.length > 1 ? 's' : ''})
                </a>
              ) : null;
            })()}
            <p className="pt-2 text-sm text-slate-600">Avisar o cliente pelo WhatsApp (opcional):</p>
            {sentOut.map((d) => (
              <a key={d.id} href={outForDeliveryMessageUrl(d, tenant.name, label(d))} target="_blank" rel="noreferrer" className="flex min-h-touch items-center gap-2 rounded-xl border border-slate-200 px-3 text-sm font-bold">
                <MessageCircle className="h-4 w-4 text-verde" /> {label(d)} · {d.customer_name}
              </a>
            ))}
          </div>
        )}
      </Sheet>

      <Sheet open={settling !== undefined && !payAuthOpen} onClose={() => setSettleFor(null)} title={`Acerto · ${settling?.courier.name ?? ''}`}>
        {settling && (
          <div className="space-y-3 text-sm">
            <dl className="grid grid-cols-2 gap-1">
              <dt>Entregas</dt><dd className="text-right font-bold">{settling.preview.deliveries.length}</dd>
              <dt>Dinheiro recebido dos clientes</dt><dd className="text-right font-bold">{formatBRL(settling.preview.cashToCollect)}</dd>
              <dt>Ganho do entregador</dt><dd className="text-right font-bold">{formatBRL(settling.preview.courierFees)}</dd>
            </dl>
            <p className="rounded-xl bg-base p-2 text-slate-700">
              O dinheiro das contas pagas na entrega entra no caixa como recebimento em dinheiro. O ganho do entregador pode sair da gaveta
              (sangria com PIN do gerente) ou ser pago por fora.
            </p>
            <Btn block variant="success" onClick={() => setPayAuthOpen(true)} disabled={settling.preview.courierFees <= 0}>
              Receber e pagar {formatBRL(settling.preview.courierFees)} pela gaveta
            </Btn>
            <Btn
              block
              variant="secondary"
              onClick={() => {
                const r = settle(false, null);
                if (!r.ok) return toast.error(r.error);
                toast.success(`Acerto feito: ${formatBRL(r.data.cash_collected)} recebidos.`);
                setSettleFor(null);
              }}
            >
              Só receber o dinheiro (pago o entregador por fora)
            </Btn>
          </div>
        )}
      </Sheet>

      <ManagerAuthSheet
        open={payAuthOpen && settling !== undefined}
        onClose={() => setPayAuthOpen(false)}
        title="Pagar entregador pela gaveta"
        summary={<span>Sangria de <b>{formatBRL(settling?.preview.courierFees ?? 0)}</b> para {settling?.courier.name}.</span>}
        confirmLabel="Autorizar e acertar"
        quickReasons={[`Acerto do entregador ${settling?.courier.name ?? ''}`.trim()]}
        successMessage="Acerto feito."
        onSubmit={(managerPin, reason) => settle(true, { managerPin, reason })}
        onSuccess={() => { setPayAuthOpen(false); setSettleFor(null); }}
      />

      <ManagerAuthSheet
        open={cancelFor !== null}
        onClose={() => setCancelFor(null)}
        title={`Cancelar entrega ${cancelFor ? label(cancelFor) : ''}`}
        summary={<span>Cancela a entrega e a conta de <b>{cancelFor?.customer_name}</b>. Conta já paga se estorna no caixa.</span>}
        confirmLabel="Cancelar entrega"
        quickReasons={CANCEL_REASONS}
        successMessage="Entrega cancelada."
        onSubmit={(managerPin, reason) => useTcheStore.getState().cancelOwnDelivery(cancelFor!.id, { managerPin, reason })}
        onSuccess={() => setCancelFor(null)}
      />
    </div>
  );
}

interface CardProps {
  d: OwnDelivery;
  order: Order | undefined;
  label: string;
  courierName: string | undefined;
  selected: boolean;
  onToggle: () => void;
  onReady: () => void;
  onDelivered: () => void;
  onCancel: () => void;
}

function DeliveryCard({ d, order, label, courierName, selected, onToggle, onReady, onDelivered, onCancel }: CardProps) {
  const paidAtCounter = !d.pay_on_delivery;
  const waitingPayment = paidAtCounter && order?.status !== 'CLOSED';
  const total = order ? (d.pay_on_delivery ? order.remaining_balance : order.total_amount) : 0;
  return (
    <article className={`rounded-xl border-2 bg-surface p-2 text-sm ${selected ? 'border-verde' : 'border-transparent'}`}>
      <header className="flex items-start gap-2">
        {d.status === 'READY' && (
          <input type="checkbox" checked={selected} onChange={onToggle} aria-label={`Pôr ${label} na rota`} className="mt-1 h-5 w-5 accent-verde" />
        )}
        <div className="mr-auto">
          <div className="text-lg font-black">{label} · {d.customer_name}</div>
          <div className="text-slate-600">{d.address} · {d.zone_name}</div>
          {d.reference && <div className="text-xs text-slate-500">Ref.: {d.reference}</div>}
        </div>
      </header>
      <div className="mt-1 flex flex-wrap items-center gap-1 text-xs">
        <a href={`tel:${d.customer_phone}`} className="flex items-center gap-1 rounded bg-base px-1.5 py-0.5"><Phone className="h-3 w-3" /> {d.customer_phone}</a>
        {d.pay_on_delivery && order?.status === 'CLOSED' ? (
          <span className="rounded bg-stone/20 px-1.5 py-0.5 font-bold text-verde">Recebido no acerto</span>
        ) : d.pay_on_delivery ? (
          <span className="rounded bg-amarelo/30 px-1.5 py-0.5 font-bold">
            Cobrar {formatBRL(total)} em dinheiro{d.change_for ? ` · troco p/ ${formatBRL(d.change_for)}` : ''}
          </span>
        ) : (
          <span className={`rounded px-1.5 py-0.5 font-bold ${waitingPayment ? 'bg-rose-100 text-rose-700' : 'bg-stone/20 text-verde'}`}>{waitingPayment ? 'Aguardando pagamento' : 'Pago'}</span>
        )}
        {courierName && <span className="rounded bg-base px-1.5 py-0.5">🛵 {courierName}</span>}
      </div>
      <div className="mt-2 flex gap-2">
        {d.status === 'PREPARING' && <Btn variant="success" disabled={waitingPayment} onClick={onReady}><CheckCircle2 className="h-4 w-4" /> Pronto</Btn>}
        {d.status === 'OUT' && <Btn variant="success" onClick={onDelivered}><CheckCircle2 className="h-4 w-4" /> Entregue</Btn>}
        {(d.status === 'PREPARING' || d.status === 'READY' || d.status === 'OUT') && (
          <Btn variant="danger" onClick={onCancel} aria-label={`Cancelar ${label}`}><XCircle className="h-4 w-4" /></Btn>
        )}
      </div>
    </article>
  );
}
