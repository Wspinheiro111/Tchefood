import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Banknote,
  CheckCircle2,
  ChevronRight,
  CreditCard,
  Delete,
  Flame,
  Hand,
  Loader2,
  Minus,
  Plus,
  QrCode as QrIcon,
  ShoppingBag,
  Trash2,
  TriangleAlert,
  UtensilsCrossed,
} from 'lucide-react';
import { useTcheStore } from '../store/useTcheStore';
import type { FulfillmentType, Order, Product } from '../types';
import { computeItemTotal, formatBRL } from '../lib/money';
import { FULFILLMENT_LABEL, formatPickupNumber } from '../lib/kiosk';
import { chargePickupOrder, printPickupReceipt } from '../lib/pickupCharge';
import { useTerminalBus } from '../lib/payments/drivers';
import { ProductSheet } from '../components/ProductSheet';
import { ManagerAuthSheet } from '../components/ManagerAuthSheet';
import { usePickupCart, usePickupMenu } from '../components/pickup/usePickupCart';
import { toast } from '../components/ui';
import { CategoryIcon } from './OrderScreen';

/**
 * Totem de autoatendimento (tela do cliente). O cliente monta o pedido, paga na maquininha
 * ao lado do totem (ou escolhe pagar no caixa) e recebe a senha. Só depois de pago o pedido
 * entra no KDS da cozinha e no painel da TV.
 */

type Step =
  | { name: 'welcome' }
  | { name: 'fulfillment' }
  | { name: 'menu' }
  | { name: 'cart' }
  | { name: 'pay' }
  | { name: 'processing'; method: PayMethod }
  | { name: 'declined'; reason: string }
  | { name: 'review'; reason: string }
  | { name: 'done'; paid: boolean };

type PayMethod = 'CREDIT' | 'DEBIT' | 'PIX';

const IDLE_MS = 90_000;
const IDLE_WARNING_MS = 15_000;
const DONE_RESET_MS = 20_000;

const PAY_OPTIONS: Array<{ key: PayMethod; label: string; hint: string; icon: typeof CreditCard }> = [
  { key: 'CREDIT', label: 'Crédito', hint: 'Aproxime ou insira o cartão', icon: CreditCard },
  { key: 'DEBIT', label: 'Débito', hint: 'Aproxime ou insira o cartão', icon: CreditCard },
  { key: 'PIX', label: 'Pix', hint: 'Leia o QR na maquininha', icon: QrIcon },
];

export function KioskScreen() {
  const tenant = useTcheStore((s) => s.tenant);
  const cart = usePickupCart();
  const { cats, sellable } = usePickupMenu();
  const [step, setStep] = useState<Step>({ name: 'welcome' });
  const [fulfillment, setFulfillment] = useState<FulfillmentType>('DINE_IN');
  const [catId, setCatId] = useState('');
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<Product | null>(null);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [idleWarning, setIdleWarning] = useState(false);
  const [exitOpen, setExitOpen] = useState(false);
  const order = useTcheStore((s) => (orderId ? s.orders.find((o) => o.id === orderId) : undefined));
  const lastTouch = useRef(Date.now());
  const logoTaps = useRef<number[]>([]);

  const activeCat = catId || cats[0]?.id || '';
  // Pedido já criado e ainda não pago: os itens ficaram travados na primeira tentativa de pagamento.
  const pendingOrder = order && order.status === 'PAYING' ? order : null;
  const list = sellable.filter((p) => p.category_id === activeCat);

  const clearCart = cart.clear;
  const reset = useCallback(() => {
    clearCart();
    setName('');
    setOrderId(null);
    setSelected(null);
    setCatId('');
    setIdleWarning(false);
    setStep({ name: 'welcome' });
  }, [clearCart]);

  // Inatividade: pergunta "ainda está aí?" e volta ao início (o pedido já criado fica no caixa).
  useEffect(() => {
    const touch = () => {
      lastTouch.current = Date.now();
      setIdleWarning(false);
    };
    window.addEventListener('pointerdown', touch);
    window.addEventListener('keydown', touch);
    const timer = window.setInterval(() => {
      if (step.name === 'welcome' || step.name === 'processing' || step.name === 'done') return;
      const idle = Date.now() - lastTouch.current;
      if (idle >= IDLE_MS + IDLE_WARNING_MS) reset();
      else if (idle >= IDLE_MS) setIdleWarning(true);
    }, 1_000);
    return () => {
      window.removeEventListener('pointerdown', touch);
      window.removeEventListener('keydown', touch);
      window.clearInterval(timer);
    };
  }, [step.name, reset]);

  // Tela da senha volta sozinha para o início.
  useEffect(() => {
    if (step.name !== 'done') return;
    const timer = window.setTimeout(reset, DONE_RESET_MS);
    return () => window.clearTimeout(timer);
  }, [step.name, reset]);

  // Saída escondida para a equipe: 5 toques no logo em 3 segundos pedem o PIN de gerente.
  const tapLogo = () => {
    const now = Date.now();
    logoTaps.current = [...logoTaps.current.filter((t) => now - t < 3_000), now];
    if (logoTaps.current.length >= 5) {
      logoTaps.current = [];
      setExitOpen(true);
    }
  };

  /** Cria o pedido uma vez só (reaproveitado nas novas tentativas de pagamento). */
  const ensureOrder = (): Order | null => {
    if (pendingOrder) return pendingOrder;
    const r = useTcheStore.getState().createPickupOrder({ lines: cart.toInput(), fulfillment, customerName: name });
    if (!r.ok) {
      toast.error(r.error);
      return null;
    }
    setOrderId(r.data.id);
    return r.data;
  };

  const pay = async (method: PayMethod) => {
    const o = ensureOrder();
    if (!o) return;
    setStep({ name: 'processing', method });
    const result = await chargePickupOrder({ orderId: o.id, method, chassis: useTerminalBus.getState().chassis, kitchenPreview: false });
    if (result.status === 'APPROVED') {
      cart.clear();
      setStep({ name: 'done', paid: true });
    } else if (result.status === 'DECLINED') setStep({ name: 'declined', reason: result.reason });
    else if (result.status === 'MANUAL_REVIEW') setStep({ name: 'review', reason: result.reason });
    else {
      toast.error(result.reason);
      setStep({ name: 'pay' });
    }
  };

  const payAtCounter = () => {
    const o = ensureOrder();
    if (!o) return;
    printPickupReceipt(o.id, useTerminalBus.getState().chassis);
    cart.clear();
    setStep({ name: 'done', paid: false });
  };

  const tapProduct = (p: Product) => {
    if (!p.available) return;
    if (cart.needsOptions(p)) return setSelected(p);
    cart.addSimple(p);
  };

  const showCartBar = step.name === 'menu' && cart.count > 0 && !pendingOrder;

  return (
    <div className="fixed inset-0 z-40 flex select-none flex-col bg-[#fff8ef] text-neutral-900">
      {/* Topo */}
      {step.name !== 'welcome' && (
        <header className="flex items-center gap-3 border-b border-orange-200 bg-white/70 px-5 py-3">
          <button aria-label="Logo" onClick={tapLogo} className="grid h-12 w-12 place-items-center rounded-2xl bg-brasa text-white">
            <Flame className="h-7 w-7" />
          </button>
          <div className="mr-auto leading-tight">
            <div className="text-xl font-black">{tenant.name}</div>
            <div className="text-sm text-neutral-500">{FULFILLMENT_LABEL[fulfillment]}</div>
          </div>
          {(step.name === 'menu' || step.name === 'cart' || step.name === 'pay') && (
            <button onClick={reset} className="min-h-touch rounded-full border-2 border-neutral-300 px-5 font-bold text-neutral-600">
              Cancelar
            </button>
          )}
        </header>
      )}

      <div className="relative min-h-0 flex-1">
        {step.name === 'welcome' && <Welcome name={tenant.name} onStart={() => setStep({ name: 'fulfillment' })} onLogo={tapLogo} />}

        {step.name === 'fulfillment' && (
          <div className="flex h-full flex-col items-center justify-center gap-8 p-6">
            <h1 className="text-center text-4xl font-black">Onde você vai comer?</h1>
            <div className="grid w-full max-w-3xl grid-cols-2 gap-5">
              {(['DINE_IN', 'TAKEOUT'] as FulfillmentType[]).map((f) => (
                <button
                  key={f}
                  onClick={() => {
                    setFulfillment(f);
                    setStep({ name: 'menu' });
                  }}
                  className="flex aspect-square flex-col items-center justify-center gap-4 rounded-[2rem] border-4 border-orange-200 bg-white text-3xl font-black shadow-lg active:scale-95 active:border-brasa"
                >
                  <span className="grid h-28 w-28 place-items-center rounded-full bg-orange-100 text-brasa">
                    {f === 'DINE_IN' ? <UtensilsCrossed className="h-16 w-16" /> : <ShoppingBag className="h-16 w-16" />}
                  </span>
                  {FULFILLMENT_LABEL[f]}
                </button>
              ))}
            </div>
          </div>
        )}

        {step.name === 'menu' && (
          <div className="flex h-full">
            <nav className="scroll-thin w-36 shrink-0 overflow-y-auto border-r border-orange-200 bg-white/60 py-3 sm:w-44">
              {cats.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setCatId(c.id)}
                  className={`mx-2 mb-2 flex w-[calc(100%-1rem)] flex-col items-center gap-2 rounded-2xl px-2 py-4 text-center text-sm font-bold leading-tight ${activeCat === c.id ? 'bg-brasa text-white shadow-md' : 'text-neutral-700 active:bg-orange-100'}`}
                >
                  <CategoryIcon name={c.icon_name} className="h-9 w-9" />
                  {c.name}
                </button>
              ))}
            </nav>
            <section className={`scroll-thin min-w-0 flex-1 overflow-y-auto p-4 ${showCartBar ? 'pb-32' : ''}`}>
              <h2 className="mb-4 text-3xl font-black">{cats.find((c) => c.id === activeCat)?.name}</h2>
              <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
                {list.map((p) => {
                  const cat = cats.find((c) => c.id === p.category_id);
                  return (
                    <button
                      key={p.id}
                      onClick={() => tapProduct(p)}
                      disabled={!p.available}
                      className="flex flex-col overflow-hidden rounded-3xl border-2 border-orange-100 bg-white text-left shadow-sm active:scale-[0.98] active:border-brasa disabled:opacity-40"
                    >
                      <span className="grid h-28 place-items-center bg-gradient-to-br from-orange-100 to-amber-200 text-brasa">
                        <CategoryIcon name={cat?.icon_name ?? null} className="h-14 w-14" />
                      </span>
                      <span className="flex flex-1 flex-col gap-1 p-4">
                        <span className="text-lg font-black leading-tight">{p.name}</span>
                        {p.description && <span className="line-clamp-2 text-sm text-neutral-500">{p.description}</span>}
                        <span className="mt-auto flex items-center justify-between pt-2">
                          <span className="text-2xl font-black tabular-nums text-brasa">{formatBRL(p.price)}</span>
                          {!p.available ? (
                            <span className="rounded-full bg-neutral-200 px-3 py-1 text-xs font-bold">Esgotado</span>
                          ) : (
                            <span className="grid h-11 w-11 place-items-center rounded-full bg-brasa text-white"><Plus className="h-6 w-6" /></span>
                          )}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          </div>
        )}

        {step.name === 'cart' && (
          <div className="mx-auto flex h-full max-w-3xl flex-col p-5">
            <div className="mb-4 flex items-center gap-3">
              <button aria-label="Voltar ao cardápio" onClick={() => setStep({ name: 'menu' })} className="grid h-14 w-14 place-items-center rounded-full bg-white shadow"><ArrowLeft className="h-7 w-7" /></button>
              <h1 className="text-3xl font-black">Seu pedido</h1>
            </div>
            <ul className="scroll-thin min-h-0 flex-1 space-y-3 overflow-y-auto">
              {cart.lines.map((l) => (
                <li key={l.key} className="flex items-center gap-3 rounded-3xl bg-white p-4 shadow-sm">
                  <div className="min-w-0 flex-1">
                    <div className="text-xl font-black leading-tight">{l.label}</div>
                    {l.details.map((d) => <div key={d} className="text-sm text-neutral-500">{d}</div>)}
                    <div className="mt-1 text-lg font-bold tabular-nums text-brasa">{formatBRL(computeItemTotal(l.quantity, l.unitTotal, 0))}</div>
                  </div>
                  <button aria-label="Menos" onClick={() => cart.setQty(l.key, l.quantity - 1)} className="grid h-14 w-14 place-items-center rounded-full bg-orange-100">
                    {l.quantity === 1 ? <Trash2 className="h-6 w-6" /> : <Minus className="h-7 w-7" />}
                  </button>
                  <span className="w-8 text-center text-2xl font-black tabular-nums">{l.quantity}</span>
                  <button aria-label="Mais" onClick={() => cart.setQty(l.key, l.quantity + 1)} className="grid h-14 w-14 place-items-center rounded-full bg-brasa text-white"><Plus className="h-7 w-7" /></button>
                </li>
              ))}
              {cart.lines.length === 0 && <li className="py-10 text-center text-xl text-neutral-500">Seu pedido está vazio.</li>}
            </ul>
            <div className="mt-4 rounded-3xl bg-white p-4 shadow-sm">
              <div className="mb-2 text-lg font-bold">Seu nome para chamarmos <span className="font-normal text-neutral-500">(opcional)</span></div>
              <div className="mb-3 min-h-touch-lg rounded-2xl border-2 border-orange-200 px-4 py-3 text-2xl font-black">{name || <span className="text-neutral-300">Toque nas letras</span>}</div>
              <NameKeyboard value={name} onChange={setName} />
            </div>
            <div className="mt-4 flex items-center justify-between gap-4">
              <div>
                <div className="text-neutral-500">Total</div>
                <div className="text-4xl font-black tabular-nums">{formatBRL(cart.total)}</div>
              </div>
              <button disabled={cart.count === 0} onClick={() => setStep({ name: 'pay' })} className="flex min-h-[72px] items-center gap-2 rounded-full bg-brasa px-10 text-2xl font-black text-white shadow-lg disabled:opacity-40">
                Ir para o pagamento <ChevronRight className="h-7 w-7" />
              </button>
            </div>
          </div>
        )}

        {step.name === 'pay' && (
          <div className="mx-auto flex h-full max-w-3xl flex-col justify-center gap-5 p-5">
            <div className="flex items-center gap-3">
              {/* Depois que o pedido foi criado (tentativa recusada) ele não muda mais: só a forma de pagamento. */}
              {!pendingOrder && (
                <button aria-label="Voltar ao pedido" onClick={() => setStep({ name: 'cart' })} className="grid h-14 w-14 place-items-center rounded-full bg-white shadow"><ArrowLeft className="h-7 w-7" /></button>
              )}
              <div>
                <h1 className="text-3xl font-black">Como você quer pagar?</h1>
                <div className="text-xl text-neutral-500">Total <b className="tabular-nums text-neutral-900">{formatBRL(order?.status === 'PAYING' ? order.remaining_balance : cart.total)}</b></div>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-4">
              {PAY_OPTIONS.map((m) => (
                <button key={m.key} onClick={() => void pay(m.key)} className="flex aspect-[4/5] flex-col items-center justify-center gap-3 rounded-[2rem] border-4 border-orange-200 bg-white p-3 text-center shadow-md active:scale-95 active:border-brasa">
                  <m.icon className="h-16 w-16 text-brasa" />
                  <span className="text-3xl font-black">{m.label}</span>
                  <span className="text-sm text-neutral-500">{m.hint}</span>
                </button>
              ))}
            </div>
            <button onClick={payAtCounter} className="flex min-h-[80px] items-center justify-center gap-3 rounded-[2rem] border-4 border-dashed border-neutral-300 bg-white/60 text-2xl font-black text-neutral-700 active:scale-[0.98]">
              <Banknote className="h-9 w-9" /> Pagar no caixa (dinheiro)
            </button>
            <p className="text-center text-sm text-neutral-500">Pagando no caixa, o pedido só vai para a cozinha depois do pagamento.</p>
          </div>
        )}

        {step.name === 'processing' && (
          <div className="flex h-full flex-col items-center justify-center gap-6 p-6 text-center">
            <Loader2 className="h-24 w-24 animate-spin text-brasa" />
            <h1 className="text-4xl font-black">{step.method === 'PIX' ? 'Pague o Pix na maquininha' : 'Siga as instruções na maquininha'}</h1>
            <p className="text-2xl text-neutral-600">Valor: <b className="tabular-nums">{formatBRL(order?.remaining_balance ?? cart.total)}</b></p>
          </div>
        )}

        {step.name === 'declined' && (
          <div className="mx-auto flex h-full max-w-2xl flex-col items-center justify-center gap-5 p-6 text-center">
            <TriangleAlert className="h-20 w-20 text-brasa" />
            <h1 className="text-4xl font-black">Pagamento não aprovado</h1>
            <p className="text-xl text-neutral-600">{step.reason}</p>
            <div className="grid w-full gap-3">
              <button onClick={() => setStep({ name: 'pay' })} className="min-h-[72px] rounded-full bg-brasa text-2xl font-black text-white">Tentar outra forma</button>
              <button onClick={payAtCounter} className="min-h-[72px] rounded-full border-4 border-neutral-300 text-2xl font-black text-neutral-700">Pagar no caixa</button>
            </div>
          </div>
        )}

        {step.name === 'review' && order && (
          <div className="mx-auto flex h-full max-w-2xl flex-col items-center justify-center gap-5 p-6 text-center">
            <Hand className="h-20 w-20 text-ouro" />
            <h1 className="text-4xl font-black">Procure o caixa, por favor</h1>
            <p className="text-xl text-neutral-600">Não conseguimos confirmar o pagamento. Não pague de novo: o caixa vai conferir na maquininha.</p>
            <div className="rounded-3xl bg-white px-10 py-6 shadow">
              <div className="text-lg font-bold uppercase text-neutral-500">Sua senha</div>
              <div className="text-8xl font-black tabular-nums">{formatPickupNumber(order.pickup_number)}</div>
            </div>
            <button onClick={reset} className="min-h-[64px] rounded-full bg-neutral-900 px-10 text-xl font-black text-white">Entendi</button>
          </div>
        )}

        {step.name === 'done' && order && <DoneScreen order={order} paid={step.paid} onFinish={reset} />}

        {showCartBar && (
          <div className="absolute inset-x-0 bottom-0 p-4">
            <button onClick={() => setStep({ name: 'cart' })} className="mx-auto flex min-h-[80px] w-full max-w-3xl items-center justify-between rounded-full bg-neutral-900 px-8 text-white shadow-2xl">
              <span className="flex items-center gap-3 text-xl font-bold">
                <span className="grid h-11 w-11 place-items-center rounded-full bg-brasa text-lg font-black">{cart.count}</span> Ver meu pedido
              </span>
              <span className="text-3xl font-black tabular-nums">{formatBRL(cart.total)}</span>
            </button>
          </div>
        )}
      </div>

      {idleWarning && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-6">
          <div className="max-w-md rounded-[2rem] bg-white p-8 text-center">
            <h2 className="mb-2 text-3xl font-black">Ainda está aí?</h2>
            <p className="mb-6 text-lg text-neutral-600">Toque na tela para continuar seu pedido.</p>
            <button onClick={() => setIdleWarning(false)} className="min-h-[64px] w-full rounded-full bg-brasa text-xl font-black text-white">Continuar</button>
          </div>
        </div>
      )}

      <ProductSheet product={selected} onClose={() => setSelected(null)} onConfirm={(d) => { cart.addDraft(d); setSelected(null); }} confirmLabel="Adicionar ao pedido" audience="customer" />

      <ManagerAuthSheet
        open={exitOpen}
        onClose={() => setExitOpen(false)}
        title="Fechar o modo totem"
        summary={<span>O totem volta para a tela de login da equipe.</span>}
        confirmLabel="Fechar totem"
        onSubmit={(managerPin, reason) => useTcheStore.getState().exitKioskMode({ managerPin, reason })}
        onSuccess={() => setExitOpen(false)}
      />
    </div>
  );
}

function Welcome({ name, onStart, onLogo }: { name: string; onStart: () => void; onLogo: () => void }) {
  const products = useTcheStore((s) => s.products);
  const highlights = useMemo(() => products.filter((p) => p.available && !p.sold_by_weight).slice(0, 6), [products]);
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setI((x) => x + 1), 3_500);
    return () => window.clearInterval(t);
  }, []);
  const featured = highlights.length ? highlights[i % highlights.length] : undefined;
  return (
    <div className="relative flex h-full flex-col items-center justify-between overflow-hidden bg-gradient-to-b from-brasa to-[#7f1d1d] p-8 text-white" onClick={onStart}>
      <div className="pointer-events-none absolute -right-24 -top-24 h-96 w-96 rounded-full bg-ouro/30 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-32 -left-24 h-96 w-96 rounded-full bg-orange-400/30 blur-3xl" />
      <button aria-label="Logo" onClick={(e) => { e.stopPropagation(); onLogo(); }} className="relative mt-6 grid h-24 w-24 place-items-center rounded-[2rem] bg-white/15">
        <Flame className="h-14 w-14" />
      </button>
      <div className="relative text-center">
        <div className="text-2xl font-bold uppercase tracking-[0.3em] text-orange-200">Bem-vindo ao</div>
        <div className="text-6xl font-black leading-tight sm:text-7xl">{name}</div>
        {featured && (
          <div key={featured.id} className="mx-auto mt-10 max-w-md rounded-[2rem] bg-white/10 px-8 py-6 backdrop-blur">
            <div className="text-sm font-bold uppercase tracking-widest text-orange-200">Peça hoje</div>
            <div className="text-3xl font-black">{featured.name}</div>
            <div className="text-4xl font-black tabular-nums text-ouro">{formatBRL(featured.price)}</div>
          </div>
        )}
      </div>
      <div className="relative mb-6 flex animate-pulse flex-col items-center gap-3">
        <Hand className="h-16 w-16" />
        <div className="rounded-full bg-white px-12 py-6 text-3xl font-black text-brasa shadow-2xl">Toque para pedir</div>
      </div>
    </div>
  );
}

function DoneScreen({ order, paid, onFinish }: { order: Order; paid: boolean; onFinish: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-6 text-center">
      <CheckCircle2 className={`h-20 w-20 ${paid ? 'text-emerald-600' : 'text-ouro'}`} />
      <h1 className="text-4xl font-black">{paid ? 'Pedido confirmado!' : 'Pedido anotado!'}</h1>
      <div className="rounded-[2.5rem] border-4 border-neutral-900 bg-white px-14 py-8 shadow-xl">
        <div className="text-xl font-bold uppercase tracking-widest text-neutral-500">Sua senha</div>
        <div className="text-[9rem] font-black leading-none tabular-nums">{formatPickupNumber(order.pickup_number)}</div>
        {order.pickup_name && <div className="text-2xl font-bold">{order.pickup_name}</div>}
      </div>
      <p className="max-w-xl text-2xl text-neutral-600">
        {paid
          ? 'Pegue o comprovante. Acompanhe a senha no painel: quando aparecer em PRONTO, é só retirar no balcão.'
          : `Leve a senha ao caixa e pague ${formatBRL(order.remaining_balance)}. Depois do pagamento o pedido vai para a cozinha.`}
      </p>
      <button onClick={onFinish} className="min-h-[72px] rounded-full bg-neutral-900 px-12 text-2xl font-black text-white">Concluir</button>
    </div>
  );
}

const KEY_ROWS = ['QWERTYUIOP', 'ASDFGHJKLÇ', 'ZXCVBNM'];

function NameKeyboard({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const type = (ch: string) => {
    if (value.length >= 20) return;
    const next = value.length === 0 || value.endsWith(' ') ? ch : ch.toLowerCase();
    onChange(value + next);
  };
  return (
    <div className="space-y-2">
      {KEY_ROWS.map((row) => (
        <div key={row} className="flex justify-center gap-1.5">
          {row.split('').map((ch) => (
            <button key={ch} onClick={() => type(ch)} className="h-12 min-w-0 flex-1 rounded-xl bg-orange-50 text-xl font-bold active:bg-orange-200">{ch}</button>
          ))}
        </div>
      ))}
      <div className="flex gap-1.5">
        <button onClick={() => value && !value.endsWith(' ') && onChange(value + ' ')} className="h-12 flex-[3] rounded-xl bg-orange-50 font-bold active:bg-orange-200">espaço</button>
        <button aria-label="Apagar" onClick={() => onChange(value.slice(0, -1))} className="grid h-12 flex-1 place-items-center rounded-xl bg-orange-100 active:bg-orange-200"><Delete className="h-6 w-6" /></button>
        <button onClick={() => onChange('')} className="h-12 flex-1 rounded-xl bg-orange-100 font-bold active:bg-orange-200">limpar</button>
      </div>
    </div>
  );
}
