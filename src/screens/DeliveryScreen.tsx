import { useCallback, useMemo, useState } from 'react';
import { AlertTriangle, Bike, CheckCircle2, Clock, Plus, RefreshCw, ShoppingBag, XCircle } from 'lucide-react';
import { useTcheStore } from '../store/useTcheStore';
import { formatBRL, fromCents } from '../lib/money';
import { playDispatchChime } from '../lib/sound';
import { Badge, Btn, Sheet, toast } from '../components/ui';
import type { DeliveryCycleReport, DeliveryOrderRecord } from '../../server/delivery/deliveryInbox';
import type { IfoodSandboxOrderInput } from '../../server/delivery/ifood/ifoodSandbox';
import { getDeliveryDemo as getDemo, syncDeliveryOrders, useDeliveryOrders, useDeliveryPolling } from '../lib/deliveryDemo';
import {
  DELIVERY_CHANNEL_CATALOG,
  allowedDeliveryActions,
  type DeliveryCancellationReason,
  type DeliveryOrderAction,
  type DeliveryOrderStatus,
} from '../../server/delivery/marketplace';
import type { Product } from '../types';
import { OwnDeliveryBoard } from './OwnDeliveryBoard';

const STATUS_LABEL: Record<DeliveryOrderStatus, string> = {
  placed: 'Novo: aceitar',
  confirmed: 'Aceito',
  preparing: 'Em preparo',
  ready_for_pickup: 'Pronto',
  dispatched: 'Saiu para entrega',
  concluded: 'Concluído',
  cancelled: 'Cancelado',
  unknown: 'Status desconhecido',
};
const STATUS_STYLE: Record<DeliveryOrderStatus, string> = {
  placed: 'bg-brasa text-white animate-pulse',
  confirmed: 'bg-sky-600 text-white',
  preparing: 'bg-ouro text-slate-950',
  ready_for_pickup: 'bg-stone text-white',
  dispatched: 'bg-slate-200 text-slate-950',
  concluded: 'bg-slate-200 text-slate-800',
  cancelled: 'bg-slate-100 text-rose-600 line-through',
  unknown: 'bg-ouro text-slate-950',
};
const ACTION_LABEL: Record<DeliveryOrderAction, string> = {
  confirm: 'Aceitar pedido',
  start_preparation: 'Iniciar preparo',
  ready_for_pickup: 'Pronto para retirar',
  dispatch: 'Saiu para entrega',
};
const PAYMENT_LABEL: Record<string, string> = {
  credit: 'Crédito',
  debit: 'Débito',
  pix: 'Pix',
  cash: 'Dinheiro',
  voucher: 'Vale',
  meal_voucher: 'Vale-refeição',
  other: 'Outro',
};

function randomDemoOrder(products: Product[]): IfoodSandboxOrderInput {
  const available = products.filter((product) => product.available);
  const pick = (): Product => available[Math.floor(Math.random() * available.length)] ?? available[0]!;
  const lines: IfoodSandboxOrderInput['items'] = Array.from({ length: 1 + Math.floor(Math.random() * 3) }, () => {
    const product = pick();
    return { name: product.name, externalCode: product.code, quantity: 1 + Math.floor(Math.random() * 2), unitPrice: product.price };
  });
  // De vez em quando um item que o lojista ainda não vinculou no portal do iFood.
  if (Math.random() < 0.25) lines.push({ name: 'Combo Promo iFood', externalCode: null, quantity: 1, unitPrice: 24.9 });
  const names = ['Ana Paula', 'Jorge Lemes', 'Carla Fontoura', 'Tiago Brum', 'Renata Kist'];
  const roll = Math.random();
  return {
    customerName: names[Math.floor(Math.random() * names.length)],
    orderType: roll < 0.2 ? 'TAKEOUT' : 'DELIVERY',
    deliveredBy: roll < 0.6 ? 'IFOOD' : 'MERCHANT',
    items: lines,
    deliveryFee: 6.99,
    payment: roll < 0.7 ? { method: 'CREDIT', prepaid: true } : { method: 'CASH', prepaid: false, changeFor: 200 },
  };
}

type DeliveryTab = 'ifood' | 'own';

/** Delivery: pedidos do iFood e a entrega própria (motoboy da casa). */
export function DeliveryScreen() {
  const [tab, setTab] = useState<DeliveryTab>('own');
  return (
    <div>
      <div className="mx-auto flex max-w-5xl gap-2 px-3 pt-3" role="tablist">
        {([['own', 'Entrega própria'], ['ifood', 'iFood']] as const).map(([key, label]) => (
          <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)} className={`min-h-touch rounded-xl px-4 text-sm font-black ${tab === key ? 'bg-brasa text-white' : 'bg-base text-slate-700'}`}>
            {label}
          </button>
        ))}
      </div>
      {/* O iFood continua montado (escondido) para não parar de buscar pedidos novos. */}
      <div hidden={tab !== 'ifood'}><IfoodDeliveryPanel /></div>
      {tab === 'own' && <OwnDeliveryBoard />}
    </div>
  );
}

function IfoodDeliveryPanel() {
  const products = useTcheStore((s) => s.products);
  const sound = useTcheStore((s) => s.soundEnabled);
  const orders = useDeliveryOrders((s) => s.orders);
  const lastSync = useDeliveryOrders((s) => s.lastSync);
  const [busy, setBusy] = useState<string | null>(null);
  const [cancelFor, setCancelFor] = useState<DeliveryOrderRecord | null>(null);
  const [reasons, setReasons] = useState<DeliveryCancellationReason[]>([]);
  const [showFinished, setShowFinished] = useState(false);
  const productByCode = useMemo(() => new Map(products.map((product) => [product.code, product])), [products]);

  const onCycle = useCallback((reports: DeliveryCycleReport[]) => {
    const fresh = reports.reduce((sum, report) => sum + report.newOrders.length, 0);
    const failed = reports.find((report) => report.error);
    if (fresh > 0) {
      if (sound) playDispatchChime();
      toast.success(`${fresh} pedido(s) novo(s) do iFood`);
    }
    if (failed?.error) toast.error(`iFood: ${failed.error}`);
  }, [sound]);
  useDeliveryPolling(onCycle);
  const sync = useCallback(async () => onCycle(await syncDeliveryOrders()), [onCycle]);

  const simulateOrder = async () => {
    getDemo().sandbox.placeOrder(randomDemoOrder(products));
    await sync();
  };

  const act = async (record: DeliveryOrderRecord, action: DeliveryOrderAction) => {
    setBusy(record.order.externalId);
    try {
      await getDemo().inbox.performAction(record.order.channel, record.order.externalId, action);
      await sync();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const openCancel = async (record: DeliveryOrderRecord) => {
    try {
      setReasons(await getDemo().inbox.listCancellationReasons(record.order.channel, record.order.externalId));
      setCancelFor(record);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const confirmCancel = async (reason: DeliveryCancellationReason) => {
    if (!cancelFor) return;
    try {
      await getDemo().inbox.requestCancellation(cancelFor.order.channel, cancelFor.order.externalId, reason);
      toast.info('Cancelamento pedido ao iFood. Só vale quando o iFood confirmar.');
      setCancelFor(null);
      await sync();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const active = orders.filter((record) => !['concluded', 'cancelled'].includes(record.order.status));
  const finished = orders.filter((record) => ['concluded', 'cancelled'].includes(record.order.status));
  const visible = showFinished ? [...active, ...finished] : active;

  return (
    <div className="mx-auto max-w-5xl p-3">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h1 className="mr-auto flex items-center gap-2 text-xl font-black"><Bike className="h-6 w-6 text-brasa" /> Pedidos Delivery</h1>
        <span className="text-xs text-slate-500">{lastSync ? `Atualizado ${lastSync}` : 'Conectando…'}</span>
        <Btn variant="secondary" onClick={() => void sync()} aria-label="Atualizar"><RefreshCw className="h-4 w-4" /></Btn>
        <Btn variant="gold" onClick={() => void simulateOrder()}><Plus className="h-4 w-4" /> Simular pedido iFood</Btn>
      </div>

      <div className="mb-3 rounded-xl border border-ouro/40 bg-ouro/10 p-3 text-sm text-amber-700">
        <b>Modo simulador:</b> o iFood aqui é falso e roda no seu navegador. O fluxo é o mesmo da API real; para ligar a loja
        de verdade faltam as credenciais do Portal do Desenvolvedor iFood e a homologação.
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        {Object.values(DELIVERY_CHANNEL_CATALOG).map((channel) => (
          <span key={channel.key} title={channel.requirements} className={`rounded-lg px-2 py-1 text-xs font-bold ${channel.status === 'mock_ready' ? 'bg-stone/20 text-verde' : 'bg-slate-100 text-slate-500'}`}>
            {channel.label} · {channel.status === 'mock_ready' ? 'simulador' : 'em breve'}
          </span>
        ))}
      </div>

      {visible.length === 0 && (
        <div className="grid place-items-center rounded-2xl border border-dashed border-slate-200 p-10 text-center text-slate-500">
          <ShoppingBag className="mb-2 h-10 w-10" />
          Nenhum pedido de delivery em andamento. Use “Simular pedido iFood” para ver o fluxo.
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        {visible.map((record) => {
          const { order } = record;
          const actions = allowedDeliveryActions(order, record.cancellationPending);
          const canCancel = !['concluded', 'cancelled'].includes(order.status) && !record.cancellationPending;
          return (
            <article key={`${order.channel}:${order.externalId}`} className="flex flex-col rounded-2xl border border-slate-200 bg-surface p-3">
              <header className="mb-2 flex items-start gap-2">
                <div className="mr-auto">
                  <div className="text-xs font-bold uppercase text-rose-600">{DELIVERY_CHANNEL_CATALOG[order.channel].label}</div>
                  <div className="text-2xl font-black">#{order.displayId}</div>
                  <div className="text-sm text-slate-700">{order.customer.name}{order.customer.phoneLocalizer ? ` · localizador ${order.customer.phoneLocalizer}` : ''}</div>
                </div>
                <Badge className={STATUS_STYLE[order.status]}>{STATUS_LABEL[order.status]}</Badge>
              </header>

              <div className="mb-2 flex flex-wrap gap-2 text-xs">
                <Badge className="bg-slate-100 text-slate-800">{order.fulfillment === 'takeout' ? 'Retirada no balcão' : order.fulfillment === 'indoor' ? 'Consumo no local' : 'Entrega'}</Badge>
                {order.fulfillment === 'delivery' && (
                  <Badge className="bg-slate-100 text-slate-800">{order.courier === 'merchant' ? 'Motoboy da loja' : order.courier === 'marketplace' ? 'Entregador iFood' : 'Entregador ?'}</Badge>
                )}
                <Badge className="bg-slate-100 text-slate-800"><Clock className="mr-1 inline h-3 w-3" />{new Date(order.createdAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</Badge>
              </div>

              <ul className="mb-2 space-y-1 text-sm">
                {order.items.map((item) => {
                  const linked = item.externalCode ? productByCode.get(item.externalCode) : undefined;
                  return (
                    <li key={item.externalId} className="flex gap-2">
                      <span className="font-bold">{item.quantity}×</span>
                      <span className="mr-auto">
                        {item.name}
                        {!linked && <span className="ml-1 text-xs text-brasa">(sem vínculo no cardápio)</span>}
                        {item.options.length > 0 && <span className="block text-xs text-slate-500">{item.options.map((option) => option.name).join(', ')}</span>}
                        {item.notes && <span className="block text-xs text-brasa">Obs.: {item.notes}</span>}
                      </span>
                      <span className="tabular-nums">{formatBRL(fromCents(item.totalPriceCents))}</span>
                    </li>
                  );
                })}
              </ul>

              <div className="mb-2 border-t border-slate-200 pt-2 text-sm">
                {order.totals.deliveryFeeCents > 0 && <div className="flex justify-between text-slate-500"><span>Taxa de entrega</span><span>{formatBRL(fromCents(order.totals.deliveryFeeCents))}</span></div>}
                {order.totals.benefitsCents > 0 && <div className="flex justify-between text-slate-500"><span>Desconto</span><span>−{formatBRL(fromCents(order.totals.benefitsCents))}</span></div>}
                <div className="flex justify-between font-black"><span>Total</span><span>{formatBRL(fromCents(order.totals.orderCents))}</span></div>
                {order.payments.map((payment, index) => (
                  <div key={index} className="text-xs text-slate-700">
                    {PAYMENT_LABEL[payment.method]} · {payment.prepaid ? 'pago no app' : 'cobrar na entrega'}
                    {payment.changeForCents ? ` · troco para ${formatBRL(fromCents(payment.changeForCents))}` : ''}
                  </div>
                ))}
                {order.address && (
                  <div className="mt-1 text-xs text-slate-500">
                    {order.address.street}, {order.address.number}{order.address.complement ? ` – ${order.address.complement}` : ''} · {order.address.neighborhood}
                    {order.address.reference ? ` · ${order.address.reference}` : ''}
                  </div>
                )}
              </div>

              {(record.needsReview || record.cancellationPending) && (
                <div className="mb-2 rounded-lg border border-ouro/50 bg-ouro/10 p-2 text-xs text-amber-700">
                  {record.cancellationPending && <div className="flex gap-1"><AlertTriangle className="h-4 w-4 shrink-0" /> Cancelamento aguardando confirmação do iFood.</div>}
                  {record.reviewReasons.map((reason) => <div key={reason} className="flex gap-1"><AlertTriangle className="h-4 w-4 shrink-0" /> {reason}</div>)}
                </div>
              )}

              <div className="mt-auto flex flex-wrap gap-2">
                {actions.map((action) => (
                  <Btn key={action} variant={action === 'confirm' ? 'success' : 'primary'} disabled={busy === order.externalId} onClick={() => void act(record, action)}>
                    <CheckCircle2 className="h-4 w-4" /> {ACTION_LABEL[action]}
                  </Btn>
                ))}
                {canCancel && (
                  <Btn variant="danger" onClick={() => void openCancel(record)}><XCircle className="h-4 w-4" /> Cancelar</Btn>
                )}
              </div>
            </article>
          );
        })}
      </div>

      {finished.length > 0 && (
        <button className="mt-4 text-sm font-bold text-slate-500 underline" onClick={() => setShowFinished((value) => !value)}>
          {showFinished ? 'Esconder' : 'Mostrar'} {finished.length} pedido(s) concluído(s)/cancelado(s)
        </button>
      )}

      <Sheet open={cancelFor !== null} onClose={() => setCancelFor(null)} title={`Cancelar pedido #${cancelFor?.order.displayId ?? ''}`} tone="danger">
        <p className="mb-3 text-sm text-slate-700">Escolha o motivo aceito pelo iFood. Cancelar com frequência derruba a nota da loja no app.</p>
        <div className="grid gap-2">
          {reasons.map((reason) => (
            <Btn key={reason.code} variant="secondary" block onClick={() => void confirmCancel(reason)}>{reason.description}</Btn>
          ))}
          {reasons.length === 0 && <p className="text-sm text-slate-500">O iFood não permite mais cancelar este pedido.</p>}
        </div>
      </Sheet>
    </div>
  );
}
