import { useEffect, useMemo, useRef, useState } from 'react';
import { Banknote, Bike, CheckCircle2, CreditCard, Keyboard, Minus, MonitorSmartphone, Plus, Printer, QrCode as QrIcon, Search, ShoppingBag, Trash2, UtensilsCrossed, XCircle } from 'lucide-react';
import { useTcheStore } from '../store/useTcheStore';
import type { FulfillmentType, Order, Product } from '../types';
import { computeItemTotal, formatBRL, round2 } from '../lib/money';
import { FULFILLMENT_LABEL, formatPickupNumber, kioskStage, kioskTableIds, brasiliaDate, type KioskStage } from '../lib/kiosk';
import { chargePickupOrder, finishPaidPickup, printPickupKitchen, printPickupReceipt } from '../lib/pickupCharge';
import { useTerminalBus, type Chassis } from '../lib/payments/drivers';
import { clearReviewHold, getReviewHold } from '../lib/payments/reviewHolds';
import { ProductSheet } from '../components/ProductSheet';
import { ManagerAuthSheet } from '../components/ManagerAuthSheet';
import { ConfirmReviewedChargeSheet } from '../components/ConfirmReviewedChargeSheet';
import { usePickupCart, usePickupMenu } from '../components/pickup/usePickupCart';
import { Badge, Btn, toast } from '../components/ui';
import { CategoryIcon } from './OrderScreen';
import { useSalePrice } from '../lib/useSalePrice';
import { parsePdvQuery, PDV_SHORTCUTS, searchProducts } from '../lib/pdvSearch';

/** Barra com os atalhos de teclado (só em tela larga, onde há teclado). */
function ShortcutBar({ items }: { items: ReadonlyArray<readonly [string, string]> }) {
  return (
    <div className="mb-3 hidden flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-surface px-3 py-2 text-xs text-slate-600 lg:flex" aria-label="Atalhos de teclado">
      <Keyboard className="h-4 w-4" />
      {items.map(([k, l]) => (
        <span key={k}><kbd className="rounded border border-slate-300 bg-base px-1.5 py-0.5 font-mono font-bold text-slate-800">{k}</kbd> {l}</span>
      ))}
    </div>
  );
}

type Method = 'CREDIT' | 'DEBIT' | 'PIX' | 'CASH';

const METHODS: Array<{ key: Method; label: string; icon: typeof CreditCard }> = [
  { key: 'CREDIT', label: 'Crédito', icon: CreditCard },
  { key: 'DEBIT', label: 'Débito', icon: CreditCard },
  { key: 'PIX', label: 'Pix', icon: QrIcon },
  { key: 'CASH', label: 'Dinheiro', icon: Banknote },
];

const METHOD_KEY: Record<Method, string> = { CREDIT: 'F3', DEBIT: 'F4', PIX: 'F6', CASH: 'F7' };

const STAGE_BADGE: Record<KioskStage, { label: string; className: string }> = {
  AWAITING_PAYMENT: { label: 'Aguardando pagamento', className: 'bg-ouro text-slate-950' },
  PREPARING: { label: 'Preparando', className: 'bg-sky-600 text-white' },
  READY: { label: 'Pronto', className: 'bg-stone text-white' },
  DELIVERED: { label: 'Entregue', className: 'bg-neutral-500 text-white' },
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
  const [selectedQty, setSelectedQty] = useState(1);
  const [fulfillment, setFulfillment] = useState<FulfillmentType>('TAKEOUT');
  const [name, setName] = useState('');
  const [addr, setAddr] = useState({ phone: '', address: '', reference: '', zoneId: '', payOnDelivery: false, changeFor: '' });
  const zones = useTcheStore((s) => s.deliveryZones);
  const pastDeliveries = useTcheStore((s) => s.ownDeliveries);
  const activeZones = zones.filter((z) => z.active);
  const zone = activeZones.find((z) => z.id === addr.zoneId);
  const isDelivery = fulfillment === 'DELIVERY';
  const deliveryFee = isDelivery ? zone?.fee ?? 0 : 0;
  /** Cliente que já pediu: telefone preenche nome, endereço e bairro da última entrega. */
  const fillFromPhone = (phone: string) => {
    const digits = phone.replace(/\D/g, '');
    const last = digits.length >= 10 ? pastDeliveries.find((d) => d.customer_phone.endsWith(digits.slice(-10))) : undefined;
    setAddr((a) => ({ ...a, phone, ...(last ? { address: last.address, reference: last.reference ?? '', zoneId: zones.some((z) => z.id === last.zone_id && z.active) ? last.zone_id : a.zoneId } : {}) }));
    if (last && !name) setName(last.customer_name.slice(0, 20));
  };
  const activeCat = catId || cats[0]?.id || '';
  const list = sellable.filter((p) => p.category_id === activeCat);
  const [query, setQuery] = useState('');
  const [hit, setHit] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const parsed = parsePdvQuery(query);
  const results = useMemo(() => searchProducts(sellable, parsed.term), [sellable, parsed.term]);

  const tap = (p: Product, qty = 1) => {
    if (!p.available) return toast.error(`${p.name} em falta hoje.`);
    if (cart.needsOptions(p)) {
      setSelectedQty(qty);
      return setSelected(p);
    }
    cart.add({ product_id: p.id, quantity: qty, modifiers: [], meat_doneness: null, half_product_ids: [], quick_tags: [], free_notes: '' });
  };

  /** Enter na busca: lança o produto marcado e volta para a busca vazia. */
  const launchHit = () => {
    const p = results[Math.min(hit, results.length - 1)];
    if (!p) {
      if (parsed.term) toast.error(`Nenhum produto com "${parsed.term}".`);
      return;
    }
    tap(p, parsed.qty);
    setQuery('');
    setHit(0);
  };

  const goPay = () => {
    if (cart.count === 0) return toast.error('Pedido vazio: lance um produto.');
    const changeFor = addr.changeFor.trim() ? Number(addr.changeFor.replace(/\./g, '').replace(',', '.')) : null;
    const r = useTcheStore.getState().createPickupOrder({
      lines: cart.toInput(),
      fulfillment,
      customerName: name,
      delivery: isDelivery
        ? { customerName: name, phone: addr.phone, address: addr.address, reference: addr.reference, zoneId: addr.zoneId, payOnDelivery: addr.payOnDelivery, changeFor: addr.payOnDelivery ? changeFor : null }
        : undefined,
    });
    if (!r.ok) return toast.error(r.error);
    cart.clear();
    setName('');
    if (isDelivery) setAddr({ phone: '', address: '', reference: '', zoneId: '', payOnDelivery: false, changeFor: '' });
    if (isDelivery && addr.payOnDelivery) {
      // Paga na entrega: vai direto para a cozinha; o dinheiro chega no acerto do entregador.
      printPickupKitchen(r.data.id);
      toast.success(`Entrega ${formatPickupNumber(r.data.pickup_number)} enviada para a cozinha. Recebe na entrega.`);
      return;
    }
    onCheckout(r.data.id);
  };

  // Atalhos de teclado do PDV (fora quando a ficha de opções está aberta).
  const keys = useRef({ goPay, cart, setFulfillment });
  keys.current = { goPay, cart, setFulfillment };
  useEffect(() => {
    if (selected) return;
    const onKey = (e: KeyboardEvent) => {
      const k = keys.current;
      if (e.key === 'F1') searchRef.current?.focus();
      else if (e.key === 'F2') k.goPay();
      else if (e.key === 'F6') nameRef.current?.focus();
      else if (e.key === 'F8') {
        const last = k.cart.lines.at(-1);
        if (last) k.cart.setQty(last.key, last.quantity - 1);
      } else if (e.key === 'F9') k.setFulfillment((f) => (f === 'TAKEOUT' ? 'DINE_IN' : f === 'DINE_IN' ? 'DELIVERY' : 'TAKEOUT'));
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected]);

  // A busca fica travada com a ficha aberta; ao fechar, o cursor volta para ela (depois de destravar).
  useEffect(() => {
    if (!selected) searchRef.current?.focus();
  }, [selected]);

  return (
    <div className="mx-auto grid max-w-6xl gap-3 px-3 pb-10 pt-3 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="min-w-0">
        <ShortcutBar items={PDV_SHORTCUTS.builder} />
        <div className="relative mb-3">
          <label className="flex items-center gap-2 rounded-xl border-2 border-slate-300 bg-base px-3 focus-within:border-ouro">
            <Search className="h-5 w-5 text-slate-400" />
            <input
              ref={searchRef}
              autoFocus
              // Com a ficha de opções aberta a busca fica travada: digitar ou ler outro código não mexe no pedido por trás.
              disabled={selected !== null}
              value={query}
              onChange={(e) => { setQuery(e.target.value); setHit(0); }}
              onKeyDown={(e) => {
                if (selected) return;
                if (e.key === 'Enter') { e.preventDefault(); launchHit(); }
                else if (e.key === 'ArrowDown') { e.preventDefault(); setHit((h) => Math.min(h + 1, Math.max(0, results.length - 1))); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setHit((h) => Math.max(0, h - 1)); }
                else if (e.key === 'Escape') { setQuery(''); setHit(0); }
              }}
              placeholder="Buscar: nome, código ou código de barras (3*101 = 3 do código 101)"
              aria-label="Buscar produto"
              role="combobox"
              aria-expanded={results.length > 0}
              aria-controls="pdv-results"
              className="min-h-touch w-full bg-transparent outline-none"
            />
            {parsed.qty > 1 && <Badge className="bg-ouro text-slate-950">{parsed.qty}x</Badge>}
          </label>
          {results.length > 0 && (
            <ul id="pdv-results" role="listbox" className="absolute inset-x-0 top-full z-10 mt-1 overflow-hidden rounded-xl border border-slate-200 bg-base shadow-lg">
              {results.map((p, i) => (
                <li key={p.id} role="option" aria-selected={i === hit}>
                  <button
                    onMouseEnter={() => setHit(i)}
                    onClick={() => { tap(p, parsed.qty); setQuery(''); setHit(0); searchRef.current?.focus(); }}
                    className={`flex min-h-touch w-full items-center gap-3 px-3 text-left text-sm ${i === hit ? 'bg-ouro/25' : ''} ${p.available ? '' : 'opacity-50'}`}
                  >
                    <span className="w-12 font-mono text-xs text-slate-500">{p.code}</span>
                    <span className="flex-1 font-semibold">{p.name}{!p.available && ' · em falta'}</span>
                    {cart.needsOptions(p) && <Badge className="bg-slate-200">opções</Badge>}
                    <span className="font-black tabular-nums text-brasa">{formatBRL(priceOf(p))}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="scroll-thin -mx-3 mb-3 flex gap-2 overflow-x-auto px-3 pb-1">
          {cats.map((c) => (
            <button key={c.id} onClick={() => setCatId(c.id)} className={`flex min-h-touch shrink-0 items-center gap-2 rounded-full px-4 font-semibold ${activeCat === c.id ? 'bg-ouro text-slate-950' : 'bg-surface text-slate-700'}`}>
              <CategoryIcon name={c.icon_name} className="h-4 w-4" /> {c.name}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {list.map((p) => (
            <button key={p.id} onClick={() => tap(p)} disabled={!p.available} className="flex min-h-[88px] flex-col justify-between rounded-2xl border border-slate-200 bg-surface p-3 text-left active:bg-slate-200 disabled:opacity-40">
              <span className="line-clamp-2 font-bold leading-tight">{p.name}</span>
              <span className="flex items-center justify-between">
                <span className="text-lg font-black tabular-nums text-brasa">{formatBRL(priceOf(p))}</span>
                {cart.needsOptions(p) && <Badge className="bg-slate-200">opções</Badge>}
              </span>
            </button>
          ))}
        </div>
        <PickupQueue onCharge={onCheckout} />
      </div>

      <aside className="h-fit rounded-2xl border-2 border-ouro/60 bg-surface p-3 lg:sticky lg:top-[72px]">
        <div className="mb-2 grid grid-cols-3 gap-2">
          {(['TAKEOUT', 'DINE_IN', 'DELIVERY'] as FulfillmentType[]).map((f) => (
            <button key={f} onClick={() => setFulfillment(f)} className={`flex min-h-touch items-center justify-center gap-1.5 rounded-xl text-sm font-black ${fulfillment === f ? 'bg-brasa text-white' : 'bg-base text-slate-700'}`}>
              {f === 'TAKEOUT' ? <ShoppingBag className="h-4 w-4" /> : f === 'DINE_IN' ? <UtensilsCrossed className="h-4 w-4" /> : <Bike className="h-4 w-4" />} {FULFILLMENT_LABEL[f]}
            </button>
          ))}
        </div>
        {isDelivery && (
          <div className="mb-2 space-y-2">
            {activeZones.length === 0 && <p className="rounded-xl bg-amarelo/20 p-2 text-xs">Cadastre os bairros em Retaguarda › Entrega própria.</p>}
            <input inputMode="tel" value={addr.phone} onChange={(e) => fillFromPhone(e.target.value)} placeholder="Telefone com DDD" aria-label="Telefone do cliente" className="min-h-touch w-full rounded-xl border border-slate-300 bg-base px-3 outline-none focus:border-ouro" />
          </div>
        )}
        <input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} maxLength={20} placeholder="Nome do cliente (para chamar)" className="mb-3 min-h-touch w-full rounded-xl border border-slate-300 bg-base px-3 outline-none focus:border-ouro" />
        {isDelivery && (
          <div className="-mt-1 mb-3 space-y-2">
            <input value={addr.address} onChange={(e) => setAddr({ ...addr, address: e.target.value })} maxLength={160} placeholder="Endereço (rua, número, complemento)" aria-label="Endereço" className="min-h-touch w-full rounded-xl border border-slate-300 bg-base px-3 outline-none focus:border-ouro" />
            <input value={addr.reference} onChange={(e) => setAddr({ ...addr, reference: e.target.value })} maxLength={120} placeholder="Ponto de referência (opcional)" aria-label="Referência" className="min-h-touch w-full rounded-xl border border-slate-300 bg-base px-3 outline-none focus:border-ouro" />
            <select value={addr.zoneId} onChange={(e) => setAddr({ ...addr, zoneId: e.target.value })} aria-label="Bairro" className="min-h-touch w-full rounded-xl border border-slate-300 bg-base px-3">
              <option value="">Bairro…</option>
              {activeZones.map((z) => <option key={z.id} value={z.id}>{z.name} · {formatBRL(z.fee)} · {z.eta_minutes} min</option>)}
            </select>
            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => setAddr({ ...addr, payOnDelivery: false, changeFor: '' })} className={`min-h-touch rounded-xl text-sm font-bold ${!addr.payOnDelivery ? 'bg-verde text-white' : 'bg-base text-slate-700'}`}>Pagar agora</button>
              <button onClick={() => setAddr({ ...addr, payOnDelivery: true })} className={`min-h-touch rounded-xl text-sm font-bold ${addr.payOnDelivery ? 'bg-verde text-white' : 'bg-base text-slate-700'}`}>Dinheiro na entrega</button>
            </div>
            {addr.payOnDelivery && (
              <input inputMode="decimal" value={addr.changeFor} onChange={(e) => setAddr({ ...addr, changeFor: e.target.value.replace(/[^\d.,]/g, '') })} placeholder="Troco para (opcional)" aria-label="Troco para" className="min-h-touch w-full rounded-xl border border-slate-300 bg-base px-3 outline-none focus:border-ouro" />
            )}
          </div>
        )}
        {cart.lines.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500">Toque nos produtos para montar o pedido.</p>
        ) : (
          <ul className="mb-3 space-y-2">
            {cart.lines.map((l) => (
              <li key={l.key} className="flex items-center gap-2 rounded-xl bg-base p-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">{l.label}</div>
                  {l.details.length > 0 && <div className="truncate text-xs text-slate-500">{l.details.join(' · ')}</div>}
                  <div className="text-xs text-slate-500">{formatBRL(computeItemTotal(l.quantity, l.unitTotal, 0))}</div>
                </div>
                <button aria-label="Menos" onClick={() => cart.setQty(l.key, l.quantity - 1)} className="grid h-11 w-11 place-items-center rounded-lg bg-slate-200">{l.quantity === 1 ? <Trash2 className="h-4 w-4" /> : <Minus className="h-5 w-5" />}</button>
                <span className="w-6 text-center font-bold">{l.quantity}</span>
                <button aria-label="Mais" onClick={() => cart.setQty(l.key, l.quantity + 1)} className="grid h-11 w-11 place-items-center rounded-lg bg-slate-200"><Plus className="h-5 w-5" /></button>
              </li>
            ))}
          </ul>
        )}
        {isDelivery && zone && <div className="flex justify-between text-sm text-slate-600"><span>Entrega {zone.name}</span><span className="tabular-nums">{formatBRL(deliveryFee)}</span></div>}
        <div className="mb-3 flex items-end justify-between"><span className="text-slate-500">Total</span><span className="text-3xl font-black tabular-nums text-brasa">{formatBRL(round2(cart.total + deliveryFee))}</span></div>
        <Btn block size="lg" variant="success" disabled={cart.count === 0} onClick={goPay}>
          {isDelivery && addr.payOnDelivery ? 'Enviar para a cozinha' : 'Cobrar e gerar senha'} <kbd className="hidden rounded bg-white/20 px-1.5 text-xs lg:inline">F2</kbd>
        </Btn>
        <p className="mt-2 text-center text-[11px] text-slate-500">Sem os 10% do garçom. O pedido vai para a cozinha assim que o pagamento for aprovado.</p>
      </aside>

      <ProductSheet product={selected} initialQty={selectedQty} onClose={() => { setSelected(null); searchRef.current?.focus(); }} onConfirm={(d) => { cart.addDraft(d); setSelected(null); searchRef.current?.focus(); }} confirmLabel="Adicionar ao pedido" />
    </div>
  );
}

/** Senhas de hoje: as que esperam pagamento no caixa e o andamento das pagas. */
function PickupQueue({ onCharge }: { onCharge: (orderId: string) => void }) {
  const tables = useTcheStore((s) => s.tables);
  const orders = useTcheStore((s) => s.orders);
  const items = useTcheStore((s) => s.orderItems);
  const ownDeliveries = useTcheStore((s) => s.ownDeliveries);
  const { waiting, others } = useMemo(() => {
    const payOnDelivery = new Set(ownDeliveries.filter((d) => d.pay_on_delivery).map((d) => d.order_id));
    const ids = kioskTableIds(tables);
    const day = brasiliaDate(new Date());
    const pickup = orders
      .filter((o) => ids.has(o.table_id) && o.pickup_number !== null)
      .sort((a, b) => (a.opened_at < b.opened_at ? 1 : -1));
    return {
      // Senha não paga continua na fila mesmo depois da meia-noite: é a única entrada para cobrar ou cancelar.
      // Entrega paga na entrega recebe no acerto do entregador, não aqui.
      waiting: pickup.filter((o) => o.status === 'PAYING' && !payOnDelivery.has(o.id)),
      others: pickup.filter((o) => o.status !== 'PAYING' && brasiliaDate(o.opened_at) === day).slice(0, 12),
    };
  }, [tables, orders, ownDeliveries]);
  if (waiting.length === 0 && others.length === 0) return null;
  return (
    <div className="mt-4 space-y-3">
      {waiting.length > 0 && (
        <div className="rounded-2xl border border-ouro/50 bg-ouro/10 p-3">
          <div className="mb-2 text-sm font-black text-brasa">Senhas aguardando pagamento</div>
          {waiting.map((o) => (
            <button key={o.id} onClick={() => onCharge(o.id)} className="mb-1 flex min-h-touch w-full items-center gap-3 rounded-xl bg-base px-3 text-left text-sm">
              <span className="text-2xl font-black tabular-nums">{formatPickupNumber(o.pickup_number)}</span>
              <span className="flex-1 text-slate-700">
                {o.pickup_name ?? 'Sem nome'} · {o.fulfillment_type ? FULFILLMENT_LABEL[o.fulfillment_type] : ''}
                {getReviewHold(o.id) && <span className="ml-2 font-bold text-brasa">· conferir maquininha</span>}
              </span>
              <OriginTag order={o} />
              <b className="tabular-nums">{formatBRL(o.remaining_balance)}</b>
            </button>
          ))}
        </div>
      )}
      {others.length > 0 && (
        <div className="rounded-2xl border border-slate-200 bg-surface p-3">
          <div className="mb-2 text-sm font-black">Senhas de hoje</div>
          {others.map((o) => {
            const stage = kioskStage(o, items);
            return (
              <div key={o.id} className="mb-1 flex items-center gap-3 rounded-xl bg-base px-3 py-2 text-sm">
                <span className="text-xl font-black tabular-nums">{formatPickupNumber(o.pickup_number)}</span>
                <span className="flex-1 truncate text-slate-700">{o.pickup_name ?? 'Sem nome'} · {formatBRL(o.total_amount)}</span>
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
    <span className="inline-flex items-center gap-1 text-xs text-slate-500"><MonitorSmartphone className="h-3 w-3" /> Totem</span>
  ) : (
    <span className="inline-flex items-center gap-1 text-xs text-slate-500"><ShoppingBag className="h-3 w-3" /> Caixa</span>
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
  const [confirmOpen, setConfirmOpen] = useState(false);
  const cashRef = useRef<HTMLInputElement>(null);

  // Atalhos da cobrança (desligados com o PIN do gerente ou o comprovante abertos).
  const keys = useRef({ charge: () => {}, onDone, blocked: false });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = keys.current;
      if (k.blocked) return;
      const pick: Record<string, Method> = { F3: 'CREDIT', F4: 'DEBIT', F6: 'PIX', F7: 'CASH' };
      if (e.key === 'F2') void k.charge();
      else if (pick[e.key]) {
        setMethod(pick[e.key]!);
        if (pick[e.key] === 'CASH') setTimeout(() => cashRef.current?.focus(), 0);
      } else if (e.key === 'Escape') k.onDone();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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

  keys.current = { charge: hold || order.status !== 'PAYING' ? () => {} : charge, onDone, blocked: voidOpen || confirmOpen };

  if (order.status === 'CLOSED') {
    return (
      <div className="mx-auto max-w-xl space-y-3 px-3 pt-6 text-center">
        <CheckCircle2 className="mx-auto h-16 w-16 text-verde" />
        <div className="text-sm font-bold uppercase text-slate-500">Senha</div>
        <div className="text-7xl font-black tabular-nums">{number}</div>
        <div className="text-xl font-black">Pago · {formatBRL(order.total_amount)}</div>
        <p className="text-slate-500">Pedido na cozinha (KDS). Entregue o comprovante com a senha ao cliente.</p>
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
        <XCircle className="mx-auto h-16 w-16 text-rose-600" />
        <div className="text-xl font-black">Senha {number} cancelada</div>
        <Btn size="lg" onClick={onDone}>Voltar</Btn>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl px-3 pb-10 pt-3">
      <ShortcutBar items={PDV_SHORTCUTS.checkout} />
      <div className="mb-3 rounded-2xl border border-slate-200 bg-surface p-3">
        <div className="mb-2 flex items-baseline justify-between">
          <div>
            <div className="text-xs font-bold uppercase text-slate-500">Senha</div>
            <div className="text-5xl font-black tabular-nums">{number}</div>
          </div>
          <div className="text-right text-sm text-slate-700">
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
        <div className="mt-2 flex justify-between border-t border-slate-200 pt-2 text-xl font-black"><span>Total</span><span className="tabular-nums text-brasa">{formatBRL(order.remaining_balance)}</span></div>
      </div>

      <div className="mb-3 grid grid-cols-4 gap-2">
        {METHODS.map((m) => (
          <button key={m.key} onClick={() => setMethod(m.key)} className={`flex min-h-touch-lg flex-col items-center justify-center gap-1 rounded-xl text-sm font-bold ${method === m.key ? 'bg-ouro text-slate-950' : 'bg-surface text-slate-700'}`}>
            <m.icon className="h-5 w-5" /> {m.label}
            <kbd className="hidden text-[10px] font-mono text-slate-500 lg:block">{METHOD_KEY[m.key]}</kbd>
          </button>
        ))}
      </div>
      {method === 'CASH' ? (
        <input ref={cashRef} inputMode="decimal" value={cashGiven} onChange={(e) => setCashGiven(e.target.value.replace(/[^\d.,]/g, ''))} placeholder="Valor recebido (para troco)" className="mb-3 min-h-touch-lg w-full rounded-xl border border-slate-300 bg-base px-3 text-lg outline-none focus:border-ouro" />
      ) : (
        <div className="mb-3 grid grid-cols-2 gap-2">
          <button onClick={() => setChassis('STONE')} className={`min-h-touch-lg rounded-xl font-bold ${chassis === 'STONE' ? 'bg-stone text-white' : 'bg-base'}`}>SmartPOS Stone</button>
          <button onClick={() => setChassis('PAGBANK')} className={`min-h-touch-lg rounded-xl font-bold ${chassis === 'PAGBANK' ? 'bg-pagbank text-slate-950' : 'bg-base'}`}>SmartPOS PagBank</button>
        </div>
      )}

      {hold ? (
        <div className="mb-3 rounded-2xl border-2 border-ouro bg-ouro/10 p-3 text-sm">
          <p className="mb-2 font-bold text-brasa">⚠️ {hold.reason}</p>
          <p className="mb-2">Confira no extrato da maquininha se {formatBRL(hold.amount)} foi cobrado antes de receber de novo, em qualquer forma de pagamento. Se a maquininha mostra a transação aprovada, não cobre de novo: guarde o comprovante e chame o gerente.</p>
          <div className="grid gap-2">
            <Btn variant="success" block onClick={() => setConfirmOpen(true)}>Maquininha aprovou: registrar comprovante</Btn>
            <Btn variant="secondary" block onClick={() => { clearReviewHold(orderId); setHold(null); }}>Conferi no extrato: não foi cobrado</Btn>
          </div>
          <ConfirmReviewedChargeSheet
            open={confirmOpen}
            onClose={() => setConfirmOpen(false)}
            hold={hold}
            label={`Senha ${number}`}
            onSuccess={(outcome) => {
              setHold(null);
              // O comprovante TEF já saiu da maquininha: imprime a senha e manda para a cozinha.
              if (outcome.closed) finishPaidPickup(orderId, chassis, null, null);
            }}
          />
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
