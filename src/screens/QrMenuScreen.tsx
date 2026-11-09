import { useMemo, useState } from 'react';
import { BellRing, Minus, Plus, Receipt, ShoppingBag, Trash2 } from 'lucide-react';
import { useSalePrice } from '../lib/useSalePrice';
import { QR_PRICE_CHANGED, useTcheStore } from '../store/useTcheStore';
import type { Product } from '../types';
import { computeItemTotal, formatBRL, fromCents, halfAndHalfPrice, toCents } from '../lib/money';
import { ProductSheet, type ProductDraft } from '../components/ProductSheet';
import { QrCode } from '../components/QrCode';
import { Badge, toast } from '../components/ui';
import { CategoryIcon } from './OrderScreen';
import { ITEM_STATUS_STYLE } from './StatementPanel';
import { playDispatchChime } from '../lib/sound';
import { printDispatchedItems } from '../components/PrintSimulator';
import { BrandLogo } from '../components/Brand';

interface CartLine extends ProductDraft {
  key: string;
}

/** Simulador do celular do cliente lendo o QR Code da mesa (Cardápio Digital). */
export function QrMenuScreen() {
  const tables = useTcheStore((s) => s.tables);
  // Só mesas de verdade e ativas: a mesa técnica do balcão (COUNTER) não tem QR.
  const sorted = useMemo(() => tables.filter((t) => t.active && t.kind === 'TABLE').sort((a, b) => a.number - b.number), [tables]);
  const [tableId, setTableId] = useState<string>(sorted.find((t) => t.number === 4)?.id ?? sorted[0]?.id ?? '');
  const table = tables.find((t) => t.id === tableId);

  return (
    <div className="mx-auto grid max-w-5xl gap-6 px-3 pb-10 pt-3 lg:grid-cols-[1fr_380px]">
      <div className="order-2 lg:order-1">
        <h2 className="mb-2 text-xl font-black">Cardápio Digital QR Code na Mesa</h2>
        <p className="mb-3 text-sm text-slate-400">
          Cada mesa tem um QR Code único (<code>qr_code_token</code>). Escolha qual QR o cliente está lendo. Os pedidos caem direto no KDS e na comanda do garçom com <code>origin = 'QRCODE_TABLE'</code>.
        </p>
        <label className="mb-1 block text-sm font-semibold">QR Code lido</label>
        <select value={tableId} onChange={(e) => setTableId(e.target.value)} className="mb-4 min-h-touch w-full rounded-xl border border-slate-600 bg-surface px-3 text-lg">
          {sorted.map((t) => (
            <option key={t.id} value={t.id}>{t.label} · {t.area}</option>
          ))}
        </select>
        {table?.qr_code_token && (
          <div className="flex items-center gap-4 rounded-2xl bg-surface p-4">
            <div className="rounded-xl bg-white p-2"><QrCode value={`https://tche.food/m/${table.qr_code_token}`} size={128} /></div>
            <div className="text-sm">
              <div className="text-lg font-bold">{table.label}</div>
              <div className="break-all font-mono text-xs text-slate-400">tche.food/m/{table.qr_code_token}</div>
              <div className="mt-2 text-xs text-slate-400">Adesivo para colar na mesa</div>
            </div>
          </div>
        )}
      </div>

      <div className="order-1 mx-auto w-full max-w-[380px] lg:order-2">
        <div className="rounded-[2.5rem] border-[10px] border-slate-950 bg-slate-950 shadow-2xl">
          <div className="mx-auto mb-1 h-5 w-28 rounded-b-xl bg-black" />
          <div className="h-[720px] overflow-hidden rounded-[1.8rem] bg-slate-50 text-slate-900">
            {table ? <CustomerPhone key={table.id} tableId={table.id} /> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function CustomerPhone({ tableId }: { tableId: string }) {
  const s = useTcheStore();
  const table = s.tables.find((t) => t.id === tableId)!;
  const order = table.current_order_id ? s.orders.find((o) => o.id === table.current_order_id) : undefined;
  const [tab, setTab] = useState<'menu' | 'bill'>('menu');
  const priceOf = useSalePrice();
  const liveCategories = s.categories.filter((c) => c.active).sort((a, b) => a.sort_order - b.sort_order);
  const [cat, setCat] = useState(liveCategories[0]?.id ?? '');
  const [selected, setSelected] = useState<Product | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);

  // Buffet a quilo é pesado no balcão, não pedido pelo celular.
  const products = s.products.filter((p) => p.active && p.category_id === cat && !p.sold_by_weight);
  const cartTotal = cart.reduce((a, c) => a + computeItemTotal(c.quantity, c.unit_price, c.modifiers_unit_price), 0);
  const myItems = order ? s.orderItems.filter((i) => i.order_id === order.id) : [];

  const addToCart = (d: ProductDraft) => {
    setCart((c) => [...c, { ...d, key: `${Date.now()}-${Math.random()}` }]);
    setSelected(null);
    toast.info('Adicionado ao seu pedido.');
  };

  /** Recalcula o carrinho com o preço de agora (regra de horário e adicionais atuais). */
  const repriced = (lines: CartLine[]): CartLine[] =>
    lines.map((c) => {
      const p = s.products.find((x) => x.id === c.product_id);
      const modifiers = c.modifiers.map((m) => ({ ...m, additional_price: s.modifierOptions.find((o) => o.id === m.option_id)?.additional_price ?? m.additional_price }));
      const mods = fromCents(modifiers.reduce((a, m) => a + toCents(m.additional_price), 0));
      const halves = c.half_product_ids.map((id) => s.products.find((x) => x.id === id)).filter((x): x is Product => Boolean(x));
      const unit = !p ? c.unit_price : halves.length ? halfAndHalfPrice([priceOf(p), ...halves.map(priceOf)], s.halfAndHalfPricing) : priceOf(p);
      return { ...c, unit_price: unit, modifiers, modifiers_unit_price: mods };
    });

  const send = () => {
    const fresh = repriced(cart);
    const changed = fresh.some((c, i) => toCents(c.unit_price) !== toCents(cart[i]!.unit_price) || toCents(c.modifiers_unit_price) !== toCents(cart[i]!.modifiers_unit_price));
    if (changed) {
      // Nunca enviar com valor diferente do que o cliente viu: atualiza e pede para conferir.
      setCart(fresh);
      return toast.alert('O preço de algum item mudou (horário de promoção). Confira o total e toque em Pedir de novo.');
    }
    const r = s.qrPlaceOrder(tableId, cart.map(({ key: _k, ...d }) => d));
    if (!r.ok) {
      if (r.error.startsWith(QR_PRICE_CHANGED)) setCart(fresh);
      return toast.error(r.error);
    }
    if (s.soundEnabled) playDispatchChime();
    printDispatchedItems(r.data.items);
    toast.success(`📱 Pedido enviado para a cozinha da ${table.label}!`);
    setCart([]);
    setTab('bill');
  };

  const callBill = () => {
    const r = s.qrRequestBill(tableId);
    if (!r.ok) return toast.error(r.error);
    toast.alert(`🧾 ${table.label} pediu a conta / maquininha. Garçom avisado no mapa.`);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="bg-gradient-to-r from-rose-600 to-amber-500 px-4 pb-3 pt-4 text-white">
        <div className="text-xs opacity-90">{s.tenant.name}</div>
        <div className="flex items-center justify-between">
          <div className="text-2xl font-black">{table.label}</div>
          <span className="rounded-xl bg-white px-2 py-1 shadow"><BrandLogo className="h-8 w-auto" /></span>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-1 rounded-xl bg-black/20 p-1 text-sm font-bold">
          <button onClick={() => setTab('menu')} className={`min-h-touch rounded-lg ${tab === 'menu' ? 'bg-white text-rose-700' : ''}`}>Cardápio</button>
          <button onClick={() => setTab('bill')} className={`min-h-touch rounded-lg ${tab === 'bill' ? 'bg-white text-rose-700' : ''}`}>Minha conta</button>
        </div>
      </div>

      {tab === 'menu' ? (
        <>
          <div className="flex gap-2 overflow-x-auto px-3 py-2">
            {liveCategories.filter((c) => s.products.some((p) => p.active && p.category_id === c.id && !p.sold_by_weight)).map((c) => (
              <button key={c.id} onClick={() => setCat(c.id)} className={`flex shrink-0 flex-col items-center gap-1 rounded-xl px-3 py-2 text-[11px] font-bold ${cat === c.id ? 'bg-rose-600 text-white' : 'bg-white text-slate-700 shadow'}`}>
                <CategoryIcon name={c.icon_name} className="h-6 w-6" />
                {c.name}
              </button>
            ))}
          </div>
          <div className="flex-1 space-y-2 overflow-y-auto px-3 pb-3">
            {products.map((p) => {
              const catIcon = s.categories.find((c) => c.id === p.category_id)?.icon_name ?? null;
              return (
                <button key={p.id} disabled={!p.available} onClick={() => setSelected(p)} className="flex w-full items-center gap-3 rounded-2xl bg-white p-3 text-left shadow disabled:opacity-40">
                  <span className="grid h-16 w-16 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-amber-100 to-rose-100 text-rose-600">
                    <CategoryIcon name={catIcon} className="h-8 w-8" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-bold leading-tight">{p.name}</span>
                    {p.description && <span className="line-clamp-2 block text-xs text-slate-500">{p.description}</span>}
                    {!p.available && <span className="text-xs font-bold text-rose-600">Esgotado</span>}
                  </span>
                  <span className="font-black text-rose-700">{formatBRL(priceOf(p))}</span>
                </button>
              );
            })}
          </div>
          {cart.length > 0 && (
            <div className="border-t border-slate-200 bg-white p-3">
              <ul className="mb-2 max-h-32 space-y-1 overflow-y-auto text-sm">
                {cart.map((c) => (
                  <li key={c.key} className="flex items-center justify-between gap-2">
                    <span className="truncate">{c.quantity}x {s.products.find((p) => p.id === c.product_id)?.name}{c.meat_doneness ? ` (${c.meat_doneness})` : ''}</span>
                    <span className="flex items-center gap-1">
                      <button aria-label="Menos" onClick={() => setCart((cur) => cur.map((x) => (x.key === c.key ? { ...x, quantity: Math.max(1, x.quantity - 1) } : x)))} className="grid h-9 w-9 place-items-center rounded-lg bg-slate-100"><Minus className="h-4 w-4" /></button>
                      <button aria-label="Mais" onClick={() => setCart((cur) => cur.map((x) => (x.key === c.key ? { ...x, quantity: x.quantity + 1 } : x)))} className="grid h-9 w-9 place-items-center rounded-lg bg-slate-100"><Plus className="h-4 w-4" /></button>
                      <button aria-label="Remover" onClick={() => setCart((cur) => cur.filter((x) => x.key !== c.key))} className="grid h-9 w-9 place-items-center rounded-lg text-rose-600"><Trash2 className="h-4 w-4" /></button>
                    </span>
                  </li>
                ))}
              </ul>
              <button onClick={send} className="flex min-h-touch-lg w-full items-center justify-center gap-2 rounded-xl bg-rose-600 text-lg font-black text-white">
                <ShoppingBag className="h-5 w-5" /> Pedir para Minha Mesa · {formatBRL(cartTotal)}
              </button>
            </div>
          )}
        </>
      ) : (
        <div className="flex flex-1 flex-col overflow-hidden">
          <div className="flex-1 space-y-2 overflow-y-auto p-3">
            {myItems.length === 0 && <p className="py-10 text-center text-slate-500">Nenhum pedido ainda nesta mesa.</p>}
            {myItems.map((i) => {
              const st = ITEM_STATUS_STYLE[i.status];
              return (
                <div key={i.id} className={`flex items-center justify-between rounded-xl bg-white p-3 shadow ${i.status === 'CANCELED' ? 'opacity-50' : ''}`}>
                  <div>
                    <div className={`font-semibold ${i.status === 'CANCELED' ? 'line-through' : ''}`}>{i.quantity}x {s.products.find((p) => p.id === i.product_id)?.name}</div>
                    <Badge className={st.cls}>{st.label}</Badge>
                  </div>
                  <span className="font-bold">{formatBRL(i.total_item_price)}</span>
                </div>
              );
            })}
          </div>
          {order && (
            <div className="border-t border-slate-200 bg-white p-3 text-sm">
              <div className="flex justify-between"><span>Consumo</span><span>{formatBRL(order.subtotal_items)}</span></div>
              <div className="flex justify-between"><span>Serviço {order.charge_service_fee ? `${order.service_fee_pct}%` : ''} (opcional)</span><span>{formatBRL(order.service_fee_amount)}</span></div>
              {order.discount_amount > 0 && <div className="flex justify-between"><span>Desconto</span><span>− {formatBRL(order.discount_amount)}</span></div>}
              {order.paid_amount > 0 && <div className="flex justify-between text-emerald-700"><span>Já pago</span><span>{formatBRL(order.paid_amount)}</span></div>}
              <div className="mt-1 flex justify-between text-lg font-black"><span>Total a pagar</span><span>{formatBRL(order.remaining_balance)}</span></div>
              {table.status === 'WAITING_BILL' ? (
                <div className="mt-2 flex min-h-touch-lg items-center justify-center gap-2 rounded-xl bg-amber-100 font-bold text-amber-800"><BellRing className="h-5 w-5" /> Garçom a caminho com a maquininha</div>
              ) : (
                <button onClick={callBill} disabled={table.status !== 'OCCUPIED'} className="mt-2 flex min-h-touch-lg w-full items-center justify-center gap-2 rounded-xl bg-slate-900 font-black text-white disabled:opacity-40">
                  <Receipt className="h-5 w-5" /> Pedir a Conta / Chamar Maquininha
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {selected && (
        <div className="text-slate-100">
          <ProductSheet product={selected} onClose={() => setSelected(null)} onConfirm={addToCart} confirmLabel="Adicionar" audience="customer" />
        </div>
      )}
    </div>
  );
}
