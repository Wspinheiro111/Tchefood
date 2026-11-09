import { useMemo, useState } from 'react';
import { Banknote, CheckCircle2, CreditCard, Minus, MonitorSmartphone, Plus, Printer, QrCode as QrIcon, ShoppingBag, Trash2, UtensilsCrossed, XCircle } from 'lucide-react';
import { useTcheStore } from '../store/useTcheStore';
import type { FulfillmentType, Order, Product } from '../types';
import { computeItemTotal, formatBRL, round2 } from '../lib/money';
import { FULFILLMENT_LABEL, formatPickupNumber, kioskStage, kioskTableIds, brasiliaDate, type KioskStage } from '../lib/kiosk';
import { chargePickupOrder, printPickupKitchen, printPickupReceipt } from '../lib/pickupCharge';
import { useTerminalBus, type Chassis } from '../lib/payments/drivers';
import { clearReviewHold, getReviewHold } from '../lib/payments/reviewHolds';
import { ProductSheet } from '../components/ProductSheet';
import { ManagerAuthSheet } from '../components/ManagerAuthSheet';
import { usePickupCart, usePickupMenu } from '../components/pickup/usePickupCart';
import { Badge, Btn, toast } from '../components/ui';
import { CategoryIcon } from './OrderScreen';
import { useSalePrice } from '../lib/useSalePrice';

type Method = 'CREDIT' | 'DEBIT' | 'PIX' | 'CASH';

const METHODS: Array<{ key: Method; label: string; icon: typeof CreditCard }> = [
  { key: 'CREDIT', label: 'Crédito', icon: CreditCard },
  { key: 'DEBIT', label: 'Débito', icon: CreditCard },
  { key: 'PIX', label: 'Pix', icon: QrIcon },
  { key: 'CASH', label: 'Dinheiro', icon: Banknote },
];

const STAGE_BADGE: Record<KioskStage, { label: string; className: string }> = {
  AWAITING_PAYMENT: { label: 'Aguardando pagamento', className: 'bg-ouro text-slate-950' },
  PREPARING: { label: 'Preparando', className: 'bg-sky-600 text-white' },
  READY: { label: 'Pronto', className: 'bg-stone text-slate-950' },
  DELIVERED: { label: 'Entregue', className: 'bg-slate-600 text-white' },
  CANCELED: { label: 'Cancelado', className: 'bg-rose-800 text-white' },
};

/**
 * Pedido no caixa: a atendente monta o pedido no balcão, cobra (cartão, Pix ou dinheiro) e o
 * cliente recebe a senha. Pago, o pedido vai direto para o KDS e para o painel da TV.
 * Também recebe aqui as senhas do totem que escolheram "pagar no caixa".
 */
export function PickupCounterScreen() {
  const [checkoutId, setCheckoutId] = useState<string | null>(null);
  if (checkoutId) return <PickupCheckout orderId={checkoutId} onDone={() => setCheckoutId(null)} />;
  return <OrderBuilder onCheckout={setCheckoutId} />;
}

function OrderBuilder({ onCheckout }: { onCheckout: (orderId: string) => void }) {
  const priceOf = useSalePrice();
  const cart = usePickupCart();
  const { cats, sellable } = usePickupMenu();
  const [catId, setCatId] = useState('');
  const [selected, setSelected] = useState<Product | null>(null);
  const [fulfillment, setFulfillment] = useState<FulfillmentType>('TAKEOUT');
  const [name, setName] = useState('');
  const activeCat = catId || cats[0]?.id || '';
  const list = sellable.filter((p) => p.category_id === activeCat);

  const tap = (p: Product) => {
    if (!p.available) return toast.error(`${p.name} em falta hoje.`);
    if (cart.needsOptions(p)) return setSelected(p);
    cart.addSimple(p);
  };

  const goPay = () => {
    const r = useTcheStore.getState().createPickupOrder({ lines: cart.toInput(), fulfillment, customerName: name });
    if (!r.ok) return toast.error(r.error);
    cart.clear();
    setName('');
    onCheckout(r.data.id);
  };

  return (
    <div className="mx-auto grid max-w-6xl gap-3 px-3 pb-10 pt-3 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="min-w-0">
        <div className="scroll-thin -mx-3 mb-3 flex gap-2 overflow-x-auto px-3 pb-1">
          {cats.map((c) => (
            <button key={c.id} onClick={() => setCatId(c.id)} className={`flex min-h-touch shrink-0 items-center gap-2 rounded-full px-4 font-semibold ${activeCat === c.id ? 'bg-ouro text-slate-950' : 'bg-surface text-slate-300'}`}>
              <CategoryIcon name={c.icon_name} className="h-4 w-4" /> {c.name}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {list.map((p) => (
            <button key={p.id} onClick={() => tap(p)} disabled={!p.available} className="flex min-h-[88px] flex-col justify-between rounded-2xl border border-slate-700 bg-surface p-3 text-left active:bg-slate-700 disabled:opacity-40">
              <span className="line-clamp-2 font-bold leading-tight">{p.name}</span>
              <span className="flex items-center justify-between">
                <span className="text-lg font-black tabular-nums text-ouro">{formatBRL(priceOf(p))}</span>
                {cart.needsOptions(p) && <Badge className="bg-slate-700">opções</Badge>}
              </span>
            </button>
          ))}
        </div>
        <PickupQueue onCharge={onCheckout} />
      </div>

      <aside className="h-fit rounded-2xl border-2 border-ouro/60 bg-surface p-3 lg:sticky lg:top-[72px]">
        <div className="mb-2 grid grid-cols-2 gap-2">
          {(['TAKEOUT', 'DINE_IN'] as FulfillmentType[]).map((f) => (
            <button key={f} onClick={() => setFulfillment(f)} className={`flex min-h-touch items-center justify-center gap-2 rounded-xl text-sm font-black ${fulfillment === f ? 'bg-brasa text-white' : 'bg-base text-slate-300'}`}>
              {f === 'TAKEOUT' ? <ShoppingBag className="h-4 w-4" /> : <UtensilsCrossed className="h-4 w-4" />} {FULFILLMENT_LABEL[f]}
            </button>
          ))}
        </div>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={20} placeholder="Nome do cliente (para chamar)" className="mb-3 min-h-touch w-full rounded-xl border border-slate-600 bg-base px-3 outline-none focus:border-ouro" />
        {cart.lines.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500">Toque nos produtos para montar o pedido.</p>
        ) : (
          <ul className="mb-3 space-y-2">
            {cart.lines.map((l) => (
              <li key={l.key} className="flex items-center gap-2 rounded-xl bg-base p-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">{l.label}</div>
                  {l.details.length > 0 && <div className="truncate text-xs text-slate-400">{l.details.join(' · ')}</div>}
                  <div className="text-xs text-slate-400">{formatBRL(computeItemTotal(l.quantity, l.unitTotal, 0))}</div>
                </div>
                <button aria-label="Menos" onClick={() => cart.setQty(l.key, l.quantity - 1)} className="grid h-11 w-11 place-items-center rounded-lg bg-slate-700">{l.quantity === 1 ? <Trash2 className="h-4 w-4" /> : <Minus className="h-5 w-5" />}</button>
                <span className="w-6 text-center font-bold">{l.quantity}</span>
                <button aria-label="Mais" onClick={() => cart.setQty(l.key, l.quantity + 1)} className="grid h-11 w-11 place-items-center rounded-lg bg-slate-700"><Plus className="h-5 w-5" /></button>
              </li>
            ))}
          </ul>
        )}
        <div className="mb-3 flex items-end justify-between"><span className="text-slate-400">Total</span><span className="text-3xl font-black tabular-nums text-ouro">{formatBRL(cart.total)}</span></div>
        <Btn block size="lg" variant="success" disabled={cart.count === 0} onClick={goPay}>Cobrar e gerar senha</Btn>
        <p className="mt-2 text-center text-[11px] text-slate-500">Sem os 10% do garçom. O pedido vai para a cozinha assim que o pagamento for aprovado.</p>
      </aside>

      <ProductSheet product={selected} onClose={() => setSelected(null)} onConfirm={(d) => { cart.addDraft(d); setSelected(null); }} confirmLabel="Adicionar ao pedido" />
    </div>
  );
}

/** Senhas de hoje: as que esperam pagamento no caixa e o andamento das pagas. */
function PickupQueue({ onCharge }: { onCharge: (orderId: string) => void }) {
  const tables = useTcheStore((s) => s.tables);
  const orders = useTcheStore((s) => s.orders);
  const items = useTcheStore((s) => s.orderItems);
  const { waiting, others } = useMemo(() => {
    const ids = kioskTableIds(tables);
    const day = brasiliaDate(new Date());
    const pickup = orders
      .filter((o) => ids.has(o.table_id) && o.pickup_number !== null)
      .sort((a, b) => (a.opened_at < b.opened_at ? 1 : -1));
    return {
      // Senha não paga continua na fila mesmo depois da meia-noite: é a única entrada para cobrar ou cancelar.
      waiting: pickup.filter((o) => o.status === 'PAYING'),
      others: pickup.filter((o) => o.status !== 'PAYING' && brasiliaDate(o.opened_at) === day).slice(0, 12),
    };
  }, [tables, orders]);
  if (waiting.length === 0 && others.length === 0) return null;
  return (
    <div className="mt-4 space-y-3">
      {waiting.length > 0 && (
        <div className="rounded-2xl border border-ouro/50 bg-ouro/10 p-3">
          <div className="mb-2 text-sm font-black text-ouro">Senhas aguardando pagamento</div>
          {waiting.map((o) => (
            <button key={o.id} onClick={() => onCharge(o.id)} className="mb-1 flex min-h-touch w-full items-center gap-3 rounded-xl bg-base px-3 text-left text-sm">
              <span className="text-2xl font-black tabular-nums">{formatPickupNumber(o.pickup_number)}</span>
              <span className="flex-1 text-slate-300">
                {o.pickup_name ?? 'Sem nome'} · {o.fulfillment_type ? FULFILLMENT_LABEL[o.fulfillment_type] : ''}
                {getReviewHold(o.id) && <span className="ml-2 font-bold text-ouro">· conferir maquininha</span>}
              </span>
              <OriginTag order={o} />
              <b className="tabular-nums">{formatBRL(o.remaining_balance)}</b>
            </button>
          ))}
        </div>
      )}
      {others.length > 0 && (
        <div className="rounded-2xl border border-slate-700 bg-surface p-3">
          <div className="mb-2 text-sm font-black">Senhas de hoje</div>
          {others.map((o) => {
            const stage = kioskStage(o, items);
            return (
              <div key={o.id} className="mb-1 flex items-center gap-3 rounded-xl bg-base px-3 py-2 text-sm">
                <span className="text-xl font-black tabular-nums">{formatPickupNumber(o.pickup_number)}</span>
                <span className="flex-1 truncate text-slate-300">{o.pickup_name ?? 'Sem nome'} · {formatBRL(o.total_amount)}</span>
                <OriginTag order={o} />
                <Badge className={STAGE_BADGE[stage].className}>{STAGE_BADGE[stage].label}</Badge>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function OriginTag({ order }: { order: Order }) {
  const staff = useTcheStore((s) => s.staff);
  const fromKiosk = staff.find((u) => u.id === order.opened_by_user_id)?.role === 'KIOSK';
  return fromKiosk ? (
    <span className="inline-flex items-center gap-1 text-xs text-slate-400"><MonitorSmartphone className="h-3 w-3" /> Totem</span>
  ) : (
    <span className="inline-flex items-center gap-1 text-xs text-slate-400"><ShoppingBag className="h-3 w-3" /> Caixa</span>
  );
}

/** Cobrança da senha no caixa (cartão / Pix na SmartPOS ou dinheiro). */
function PickupCheckout({ orderId, onDone }: { orderId: string; onDone: () => void }) {
  const order = useTcheStore((s) => s.orders.find((o) => o.id === orderId));
  const allItems = useTcheStore((s) => s.orderItems);
  const products = useTcheStore((s) => s.products);
  const items = useMemo(() => allItems.filter((i) => i.order_id === orderId && i.status !== 'CANCELED'), [allItems, orderId]);
  const [method, setMethod] = useState<Method>('CREDIT');
  const [chassis, setChassis] = useState<Chassis>(() => useTerminalBus.getState().chassis);
  const [cashGiven, setCashGiven] = useState('');
  const [busy, setBusy] = useState(false);
  const [hold, setHold] = useState(() => getReviewHold(orderId));
  const [voidOpen, setVoidOpen] = useState(false);

  if (!order) return null;
  const number = formatPickupNumber(order.pickup_number);

  const charge = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await chargePickupOrder({ orderId, method, chassis, cashGiven: method === 'CASH' ? round2(Number(cashGiven.replace(',', '.')) || 0) : undefined });
      if (r.status === 'APPROVED') {
        toast.success(`✅ Senha ${number} paga e enviada para a cozinha.`);
        if (r.change > 0) toast.info(`Troco: ${formatBRL(r.change)}`);
      } else if (r.status === 'DECLINED') toast.error(`❌ Transação recusada: ${r.reason}`);
      else if (r.status === 'MANUAL_REVIEW') {
        setHold(getReviewHold(orderId));
        toast.alert(`⚠️ ${r.reason}`);
      } else toast.error(r.reason);
    } finally {
      setBusy(false);
    }
  };

  if (order.status === 'CLOSED') {
    return (
      <div className="mx-auto max-w-xl space-y-3 px-3 pt-6 text-center">
        <CheckCircle2 className="mx-auto h-16 w-16 text-stone" />
        <div className="text-sm font-bold uppercase text-slate-400">Senha</div>
        <div className="text-7xl font-black tabular-nums">{number}</div>
        <div className="text-xl font-black">Pago · {formatBRL(order.total_amount)}</div>
        <p className="text-slate-400">Pedido na cozinha (KDS). Entregue o comprovante com a senha ao cliente.</p>
        <div className="grid grid-cols-2 gap-2">
          <Btn variant="secondary" size="lg" onClick={() => { printPickupReceipt(orderId, chassis); printPickupKitchen(orderId); }}><Printer className="h-5 w-5" /> Reimprimir</Btn>
          <Btn size="lg" variant="success" onClick={onDone}>Novo pedido</Btn>
        </div>
      </div>
    );
  }

  if (order.status === 'CANCELED') {
    return (
      <div className="mx-auto max-w-xl space-y-3 px-3 pt-6 text-center">
        <XCircle className="mx-auto h-16 w-16 text-rose-400" />
        <div className="text-xl font-black">Senha {number} cancelada</div>
        <Btn size="lg" onClick={onDone}>Voltar</Btn>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl px-3 pb-10 pt-3">
      <div className="mb-3 rounded-2xl border border-slate-700 bg-surface p-3">
        <div className="mb-2 flex items-baseline justify-between">
          <div>
            <div className="text-xs font-bold uppercase text-slate-400">Senha</div>
            <div className="text-5xl font-black tabular-nums">{number}</div>
          </div>
          <div className="text-right text-sm text-slate-300">
            {order.fulfillment_type ? FULFILLMENT_LABEL[order.fulfillment_type] : ''}
            {order.pickup_name && <div className="font-bold">{order.pickup_name}</div>}
          </div>
        </div>
        <ul className="space-y-1 text-sm">
          {items.map((i) => (
            <li key={i.id} className="flex justify-between gap-2">
              <span>{i.quantity}x {products.find((p) => p.id === i.product_id)?.name}{i.meat_doneness ? ` · ${i.meat_doneness}` : ''}{i.notes ? ` · ${i.notes}` : ''}</span>
              <span className="tabular-nums">{formatBRL(i.total_item_price)}</span>
            </li>
          ))}
        </ul>
        <div className="mt-2 flex justify-between border-t border-slate-700 pt-2 text-xl font-black"><span>Total</span><span className="tabular-nums text-ouro">{formatBRL(order.remaining_balance)}</span></div>
      </div>

      <div className="mb-3 grid grid-cols-4 gap-2">
        {METHODS.map((m) => (
          <button key={m.key} onClick={() => setMethod(m.key)} className={`flex min-h-touch-lg flex-col items-center justify-center gap-1 rounded-xl text-sm font-bold ${method === m.key ? 'bg-ouro text-slate-950' : 'bg-surface text-slate-300'}`}><m.icon className="h-5 w-5" /> {m.label}</button>
        ))}
      </div>
      {method === 'CASH' ? (
        <input inputMode="decimal" value={cashGiven} onChange={(e) => setCashGiven(e.target.value.replace(/[^\d.,]/g, ''))} placeholder="Valor recebido (para troco)" className="mb-3 min-h-touch-lg w-full rounded-xl border border-slate-600 bg-base px-3 text-lg outline-none focus:border-ouro" />
      ) : (
        <div className="mb-3 grid grid-cols-2 gap-2">
          <button onClick={() => setChassis('STONE')} className={`min-h-touch-lg rounded-xl font-bold ${chassis === 'STONE' ? 'bg-stone text-slate-950' : 'bg-base'}`}>SmartPOS Stone</button>
          <button onClick={() => setChassis('PAGBANK')} className={`min-h-touch-lg rounded-xl font-bold ${chassis === 'PAGBANK' ? 'bg-pagbank text-slate-950' : 'bg-base'}`}>SmartPOS PagBank</button>
        </div>
      )}

      {hold ? (
        <div className="mb-3 rounded-2xl border-2 border-ouro bg-ouro/10 p-3 text-sm">
          <p className="mb-2 font-bold text-ouro">⚠️ {hold.reason}</p>
          <p className="mb-2">Confira no extrato da maquininha se {formatBRL(hold.amount)} foi cobrado antes de receber de novo, em qualquer forma de pagamento. Se a maquininha mostra a transação aprovada, não cobre de novo: guarde o comprovante e chame o gerente.</p>
          <Btn variant="secondary" block onClick={() => { clearReviewHold(orderId); setHold(null); }}>Conferi no extrato: não foi cobrado</Btn>
        </div>
      ) : (
        <Btn block size="lg" variant="success" disabled={busy} onClick={() => void charge()}>{busy ? 'Aguardando a maquininha…' : `Cobrar ${formatBRL(order.remaining_balance)}`}</Btn>
      )}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Btn variant="secondary" onClick={onDone}>Voltar (fica pendente)</Btn>
        <Btn variant="danger" disabled={busy || hold !== null} onClick={() => setVoidOpen(true)}>Cancelar senha</Btn>
      </div>

      <ManagerAuthSheet
        open={voidOpen}
        onClose={() => setVoidOpen(false)}
        title={`Cancelar senha ${number}`}
        summary={<span>Pedido de {formatBRL(order.total_amount)} sem pagamento. Os itens ficam cancelados e auditados.</span>}
        confirmLabel="Cancelar senha"
        onSubmit={(managerPin, reason) => useTcheStore.getState().voidPickupOrder(orderId, { managerPin, reason })}
        onSuccess={() => { setVoidOpen(false); toast.info(`Senha ${number} cancelada.`); onDone(); }}
      />
    </div>
  );
}
