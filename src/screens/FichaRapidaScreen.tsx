import { useEffect, useMemo, useRef, useState } from 'react';
import { Banknote, CheckCircle2, CreditCard, Minus, Plus, Printer, QrCode as QrIcon, ScanLine, Ticket, Trash2, XCircle } from 'lucide-react';
import { COUNTER_EVENT_LABEL, useTcheStore, type CounterLine } from '../store/useTcheStore';
import type { EventTicket, Order, PaymentMethod, Product, SelectedModifier } from '../types';
import { effectivePrice } from '../lib/catalog';
import { computeItemTotal, formatBRL, round2, toCents } from '../lib/money';
import { uuid } from '../lib/ids';
import { createDriver, useTerminalBus, type Chassis, type ChargeRequest } from '../lib/payments/drivers';
import { clearReviewHold, getReviewHold, setReviewHold, type ReviewHold } from '../lib/payments/reviewHolds';
import { cardReceiptLines } from '../lib/receipts';
import { formatTicketToken, ticketPrint } from '../lib/eventTickets';
import { ProductSheet, type ProductDraft } from '../components/ProductSheet';
import { ManagerAuthSheet } from '../components/ManagerAuthSheet';
import { ConfirmReviewedChargeSheet } from '../components/ConfirmReviewedChargeSheet';
import { ReviewCapture } from '../components/ReviewCapture';
import { CashbackCapture } from '../components/CashbackPanel';
import { Badge, Btn, toast } from '../components/ui';
import { CategoryIcon } from './OrderScreen';

interface CartLine extends CounterLine {
  key: string;
  label: string;
  /** Só os adicionais: o preço do produto é recalculado a cada tela (vira com o happy hour). */
  modsUnit: number;
}

const METHODS: Array<{ key: PaymentMethod; label: string; icon: typeof CreditCard }> = [
  { key: 'CREDIT', label: 'Crédito', icon: CreditCard },
  { key: 'DEBIT', label: 'Débito', icon: CreditCard },
  { key: 'PIX', label: 'Pix', icon: QrIcon },
  { key: 'CASH', label: 'Dinheiro', icon: Banknote },
];

/** Imprime uma ficha destacável por unidade (nome gigante + data/hora + QR antifraude). */
export function printTickets(tickets: readonly EventTicket[], chassis: Chassis) {
  const tenant = useTcheStore.getState().tenant;
  const total = tickets.length;
  for (const ticket of tickets) {
    const p = ticketPrint({ tenant, ticket, total, eventLabel: COUNTER_EVENT_LABEL });
    useTerminalBus.getState().enqueuePrint({ title: `Ficha ${ticket.ticket_seq}/${total}`, headline: p.headline, lines: p.lines, qr: ticket.barcode_token, footer: p.footer, chassis });
  }
}

/**
 * ⚡ Ficha Rápida — Balcão & Eventos: vende sem abrir mesa, cobra na SmartPOS
 * (Stone/PagBank) e imprime uma ficha por unidade. A retirada valida a ficha
 * (uso único) e só então o item conta como entregue.
 */
export function FichaRapidaScreen() {
  const [tab, setTab] = useState<'sell' | 'redeem'>('sell');
  return (
    <div className="mx-auto max-w-5xl px-3 pb-10 pt-3">
      <div className="mb-3 grid grid-cols-2 gap-2">
        <button onClick={() => setTab('sell')} className={`flex min-h-touch-lg items-center justify-center gap-2 rounded-xl font-black ${tab === 'sell' ? 'bg-brasa text-white' : 'bg-surface text-slate-700'}`}><Ticket className="h-5 w-5" /> Vender fichas</button>
        <button onClick={() => setTab('redeem')} className={`flex min-h-touch-lg items-center justify-center gap-2 rounded-xl font-black ${tab === 'redeem' ? 'bg-brasa text-white' : 'bg-surface text-slate-700'}`}><ScanLine className="h-5 w-5" /> Validar retirada</button>
      </div>
      {tab === 'sell' ? <SellPanel /> : <RedeemPanel />}
    </div>
  );
}

function SellPanel() {
  const categories = useTcheStore((s) => s.categories);
  const products = useTcheStore((s) => s.products);
  const links = useTcheStore((s) => s.productModifierGroups);
  const schedules = useTcheStore((s) => s.priceSchedules);
  // O relógio do happy hour: refaz o preço do carrinho quando a janela vira, sem tocar na tela.
  const [, setClock] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setClock((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, []);
  const priceNow = (p: Product) => effectivePrice(p, schedules, new Date());
  const lineUnit = (l: CartLine) => {
    const p = products.find((x) => x.id === l.product_id);
    return round2((p ? priceNow(p) : 0) + l.modsUnit);
  };
  const [cat, setCat] = useState<string>('');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [selected, setSelected] = useState<Product | null>(null);
  const [checkoutId, setCheckoutId] = useState<string | null>(null);

  const sellable = useMemo(() => products.filter((p) => !p.sold_by_weight), [products]);
  const cats = useMemo(
    () => categories.filter((c) => c.active && sellable.some((p) => p.category_id === c.id)).sort((a, b) => a.sort_order - b.sort_order),
    [categories, sellable],
  );
  const activeCat = cat || cats[0]?.id || '';
  const list = sellable.filter((p) => p.category_id === activeCat);

  const needsSheet = (p: Product) => p.requires_meat_doneness || links.some((l) => l.product_id === p.id);

  const pushLine = (p: Product, quantity: number, modifiers: SelectedModifier[], doneness: string | null) => {
    const modsUnit = round2(modifiers.reduce((a, m) => a + m.additional_price, 0));
    const label = [p.name, doneness, ...modifiers.map((m) => m.name)].filter(Boolean).join(' · ');
    const key = `${p.id}|${doneness ?? ''}|${modifiers.map((m) => m.option_id).sort().join(',')}`;
    setCart((c) => {
      const found = c.find((l) => l.key === key);
      if (found) return c.map((l) => (l.key === key ? { ...l, quantity: Math.min(l.quantity + quantity, 99) } : l));
      return [...c, { key, label, product_id: p.id, quantity, modifiers, meat_doneness: doneness, modsUnit }];
    });
  };

  const tap = (p: Product) => {
    if (!p.available) return toast.error(`${p.name} em falta hoje.`);
    if (needsSheet(p)) return setSelected(p);
    pushLine(p, 1, [], null);
  };

  const fromSheet = (d: ProductDraft) => {
    const p = products.find((x) => x.id === d.product_id);
    if (!p) return;
    if (d.half_product_ids.length > 0) return toast.error('Ficha de balcão não vende meio a meio: lance na mesa.');
    pushLine(p, d.quantity, d.modifiers, d.meat_doneness);
    setSelected(null);
  };

  const setQty = (key: string, q: number) => setCart((c) => (q <= 0 ? c.filter((l) => l.key !== key) : c.map((l) => (l.key === key ? { ...l, quantity: Math.min(q, 99) } : l))));

  const total = round2(cart.reduce((a, l) => a + computeItemTotal(l.quantity, lineUnit(l), 0), 0));
  const units = cart.reduce((a, l) => a + l.quantity, 0);

  const goPay = () => {
    const r = useTcheStore.getState().createCounterSale(cart.map(({ product_id, quantity, modifiers, meat_doneness }) => ({ product_id, quantity, modifiers, meat_doneness })));
    if (!r.ok) return toast.error(r.error);
    setCart([]);
    setCheckoutId(r.data.id);
  };

  if (checkoutId) return <CounterCheckout orderId={checkoutId} onDone={() => setCheckoutId(null)} />;

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0">
        <div className="scroll-thin -mx-3 mb-3 flex gap-2 overflow-x-auto px-3 pb-1">
          {cats.map((c) => (
            <button key={c.id} onClick={() => setCat(c.id)} className={`flex min-h-touch shrink-0 items-center gap-2 rounded-full px-4 font-semibold ${activeCat === c.id ? 'bg-ouro text-slate-950' : 'bg-surface text-slate-700'}`}>
              <CategoryIcon name={c.icon_name} className="h-4 w-4" /> {c.name}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {list.map((p) => (
            <button key={p.id} onClick={() => tap(p)} disabled={!p.available} className="flex min-h-[88px] flex-col justify-between rounded-2xl border border-slate-200 bg-surface p-3 text-left active:bg-slate-200 disabled:opacity-40">
              <span className="line-clamp-2 font-bold leading-tight">{p.name}</span>
              <span className="flex items-center justify-between">
                <span className="text-lg font-black tabular-nums text-brasa">{formatBRL(priceNow(p))}</span>
                {needsSheet(p) && <Badge className="bg-slate-200">opções</Badge>}
              </span>
            </button>
          ))}
        </div>
        <PendingCounterSales onResume={setCheckoutId} />
        <RecentCounterSales />
      </div>

      <aside className="h-fit rounded-2xl border-2 border-ouro/60 bg-surface p-3 lg:sticky lg:top-[72px]">
        <div className="mb-2 flex items-center justify-between font-black"><span>Venda de balcão</span><span className="text-sm text-slate-500">{units} ficha(s)</span></div>
        {cart.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500">Toque nos produtos. Cada unidade sai numa ficha separada.</p>
        ) : (
          <ul className="mb-3 space-y-2">
            {cart.map((l) => (
              <li key={l.key} className="flex items-center gap-2 rounded-xl bg-base p-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">{l.label}</div>
                  <div className="text-xs text-slate-500">{formatBRL(computeItemTotal(l.quantity, lineUnit(l), 0))}</div>
                </div>
                <button aria-label="Menos" onClick={() => setQty(l.key, l.quantity - 1)} className="grid h-11 w-11 place-items-center rounded-lg bg-slate-200">{l.quantity === 1 ? <Trash2 className="h-4 w-4" /> : <Minus className="h-5 w-5" />}</button>
                <span className="w-6 text-center font-bold">{l.quantity}</span>
                <button aria-label="Mais" onClick={() => setQty(l.key, l.quantity + 1)} className="grid h-11 w-11 place-items-center rounded-lg bg-slate-200"><Plus className="h-5 w-5" /></button>
              </li>
            ))}
          </ul>
        )}
        <div className="mb-3 flex items-end justify-between"><span className="text-slate-500">Total</span><span className="text-3xl font-black tabular-nums text-brasa">{formatBRL(total)}</span></div>
        <Btn block size="lg" variant="success" disabled={cart.length === 0} onClick={goPay}>Cobrar {formatBRL(total)}</Btn>
        <p className="mt-2 text-center text-[11px] text-slate-500">Sem os 10% do garçom. As fichas só são impressas com o pagamento aprovado.</p>
      </aside>

      <ProductSheet product={selected} onClose={() => setSelected(null)} onConfirm={fromSheet} confirmLabel="Adicionar à venda" />
    </div>
  );
}

/** Cobrança da venda de balcão na SmartPOS e impressão das fichas. */
function CounterCheckout({ orderId, onDone }: { orderId: string; onDone: () => void }) {
  const s = useTcheStore();
  const order = s.orders.find((o) => o.id === orderId);
  const items = s.orderItems.filter((i) => i.order_id === orderId);
  // Combo: sai uma ficha por item do combo (cada um é retirado na praça dele), não do combo.
  const ticketItems = items.filter((i) => !items.some((c) => c.combo_parent_item_id === i.id));
  const [method, setMethod] = useState<PaymentMethod>('CREDIT');
  const [chassis, setChassis] = useState<Chassis>('STONE');
  const [cashGiven, setCashGiven] = useState('');
  const [busy, setBusy] = useState(false);
  const [hold, setHold] = useState<ReviewHold | null>(() => getReviewHold(orderId));
  const [voidOpen, setVoidOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const printed = useRef(false);

  if (!order) return null;
  const tickets = s.eventTickets.filter((t) => t.order_id === orderId);

  const finish = (pan: string | null, paymentId: string | null) => {
    const payment = paymentId ? useTcheStore.getState().payments.find((p) => p.id === paymentId) : undefined;
    if (payment && payment.method !== 'CASH') {
      useTerminalBus.getState().enqueuePrint({ title: 'Comprovante TEF', lines: cardReceiptLines({ tenant: s.tenant, payment, tableLabel: 'Balcão', maskedPan: pan }), chassis });
    }
    const t = useTcheStore.getState().issueEventTickets(orderId);
    if (!t.ok) return toast.error(t.error);
    if (!printed.current) {
      printed.current = true;
      printTickets(t.data, chassis);
    }
    toast.success(`🎟️ ${t.data.length} ficha(s) impressas.`);
  };

  const charge = async () => {
    if (busy || order.status !== 'PAYING') return;
    const amount = order.remaining_balance;
    const idempotency_key = uuid();
    if (method === 'CASH') {
      const given = round2(Number(cashGiven.replace(',', '.')) || 0);
      if (given > 0 && toCents(given) < toCents(amount)) return toast.error('Valor recebido menor que o total.');
      const r = s.registerPayment({ orderId, amount, method: 'CASH', status: 'APPROVED', terminal_id: null, acquirer: 'CASH_DESK', acquirer_cnpj: null, card_brand: null, nsu: null, authorization_code: null, terminal_serial: null, idempotency_key, item_ids: [] });
      if (!r.ok) return toast.error(r.error);
      if (given > amount) toast.info(`Troco: ${formatBRL(round2(given - amount))}`);
      return finish(null, r.data.payment.id);
    }
    if (hold) return toast.error('Há uma cobrança sem confirmação. Confira o extrato da maquininha antes de cobrar de novo.');
    const driver = createDriver({ terminal: null, chassis, mode: 'SMARTPOS_EMBEDDED' });
    const req: ChargeRequest = { request_id: uuid(), idempotency_key, amount, method: method as ChargeRequest['method'], table_label: 'Balcão', order_id: orderId, description: `${ticketItems.reduce((a, i) => a + i.quantity, 0)} ficha(s)` };
    const lock = s.beginTerminalCharge(orderId, req.request_id, amount);
    if (!lock.ok) return toast.error(lock.error);
    setBusy(true);
    try {
      const result = await driver.charge(req);
      if (result.status === 'MANUAL_REVIEW') {
        setHold(setReviewHold({
          order_id: orderId, amount, reason: result.reason, code: result.failure_code, method: req.method,
          acquirer: result.acquirer === 'PAGBANK' ? 'PAGBANK' : 'STONE', terminal_id: result.terminal_id, terminal_serial: result.terminal_serial, idempotency_key,
        }));
        toast.alert(`⚠️ ${result.reason}`);
        return;
      }
      if (result.status === 'DECLINED') {
        s.registerPayment({ orderId, amount, method, status: 'DECLINED', terminal_id: result.terminal_id, acquirer: result.acquirer, acquirer_cnpj: null, card_brand: null, nsu: null, authorization_code: null, terminal_serial: result.terminal_serial, idempotency_key, item_ids: [], charge_request_id: req.request_id });
        toast.error(`❌ Transação recusada: ${result.reason}`);
        return;
      }
      const r = s.registerPayment({
        orderId, amount, method, status: 'APPROVED', terminal_id: result.terminal_id, acquirer: result.acquirer, acquirer_cnpj: result.acquirer_cnpj,
        card_brand: result.card_brand, nsu: result.nsu, authorization_code: result.authorization_code, terminal_serial: result.terminal_serial,
        idempotency_key, item_ids: [], charge_request_id: req.request_id,
      });
      if (!r.ok) {
        // A maquininha aprovou mas o registro falhou: trava a venda (nunca cobra de novo) e o gerente registra pelo comprovante.
        setHold(setReviewHold({
          order_id: orderId, amount, reason: `Aprovado na maquininha, mas não registrado: ${r.error}`, code: 'REGISTER_FAILED', method: req.method,
          acquirer: result.acquirer === 'PAGBANK' ? 'PAGBANK' : 'STONE', terminal_id: result.terminal_id, terminal_serial: result.terminal_serial, idempotency_key,
        }));
        toast.alert(`⚠️ Aprovado na maquininha, mas não registrado: ${r.error}`);
        return;
      }
      finish(result.masked_pan, r.data.payment.id);
    } finally {
      useTcheStore.getState().endTerminalCharge(req.request_id);
      setBusy(false);
    }
  };

  if (order.status === 'CLOSED') {
    return (
      <div className="mx-auto max-w-xl space-y-3 text-center">
        <CheckCircle2 className="mx-auto h-16 w-16 text-verde" />
        <div className="text-2xl font-black">Pago · {formatBRL(order.total_amount)}</div>
        <p className="text-slate-500">{tickets.length} ficha(s) impressas. Destaque e entregue ao cliente.</p>
        <div className="grid grid-cols-2 gap-2">
          <Btn variant="secondary" size="lg" onClick={() => { if (tickets.length) printTickets(tickets, chassis); else finish(null, null); }}><Printer className="h-5 w-5" /> {tickets.length ? 'Reimprimir fichas' : 'Imprimir fichas'}</Btn>
          <Btn size="lg" variant="success" onClick={onDone}>Nova venda</Btn>
        </div>
        <CashbackCapture orderId={orderId} />
        <ReviewCapture orderId={orderId} source="COUNTER" />
      </div>
    );
  }

  if (order.status === 'CANCELED') {
    return (
      <div className="mx-auto max-w-xl space-y-3 text-center">
        <XCircle className="mx-auto h-16 w-16 text-rose-600" />
        <div className="text-xl font-black">Venda cancelada</div>
        <Btn size="lg" onClick={onDone}>Nova venda</Btn>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl">
      <div className="mb-3 rounded-2xl border border-slate-200 bg-surface p-3">
        <div className="mb-2 font-black">Fichas desta venda</div>
        <ul className="space-y-1 text-sm">
          {items.map((i) => (
            <li key={i.id} className="flex justify-between gap-2"><span>{i.quantity}x {s.products.find((p) => p.id === i.product_id)?.name}{i.meat_doneness ? ` · ${i.meat_doneness}` : ''}{i.notes ? ` · ${i.notes}` : ''}</span><span className="tabular-nums">{i.combo_parent_item_id ? 'no combo' : formatBRL(i.total_item_price)}</span></li>
          ))}
        </ul>
        <div className="mt-2 flex justify-between border-t border-slate-200 pt-2 text-xl font-black"><span>Total</span><span className="tabular-nums text-brasa">{formatBRL(order.remaining_balance)}</span></div>
      </div>

      <div className="mb-3 grid grid-cols-4 gap-2">
        {METHODS.map((m) => (
          <button key={m.key} onClick={() => setMethod(m.key)} className={`flex min-h-touch-lg flex-col items-center justify-center gap-1 rounded-xl text-sm font-bold ${method === m.key ? 'bg-ouro text-slate-950' : 'bg-surface text-slate-700'}`}><m.icon className="h-5 w-5" /> {m.label}</button>
        ))}
      </div>
      {method === 'CASH' ? (
        <input inputMode="decimal" value={cashGiven} onChange={(e) => setCashGiven(e.target.value.replace(/[^\d.,]/g, ''))} placeholder="Valor recebido (para troco)" className="mb-3 min-h-touch-lg w-full rounded-xl border border-slate-300 bg-base px-3 text-lg outline-none focus:border-ouro" />
      ) : (
        <div className="mb-3 grid grid-cols-2 gap-2">
          <button onClick={() => setChassis('STONE')} className={`min-h-touch-lg rounded-xl font-bold ${chassis === 'STONE' ? 'bg-stone text-white' : 'bg-base'}`}>SmartPOS Stone</button>
          <button onClick={() => setChassis('PAGBANK')} className={`min-h-touch-lg rounded-xl font-bold ${chassis === 'PAGBANK' ? 'bg-pagbank text-slate-950' : 'bg-base'}`}>SmartPOS PagBank</button>
        </div>
      )}

      {hold ? (
        <div className="mb-3 rounded-2xl border-2 border-ouro bg-ouro/10 p-3 text-sm">
          <p className="mb-2 font-bold text-brasa">⚠️ {hold.reason}</p>
          <p className="mb-2">Confira no extrato da maquininha se {formatBRL(hold.amount)} foi cobrado antes de tentar de novo.</p>
          <div className="grid gap-2">
            <Btn variant="success" block onClick={() => setConfirmOpen(true)}>Maquininha aprovou: registrar comprovante</Btn>
            <Btn variant="secondary" block onClick={() => { clearReviewHold(orderId); setHold(null); }}>Conferi no extrato: não foi cobrado</Btn>
          </div>
          <ConfirmReviewedChargeSheet
            open={confirmOpen}
            onClose={() => setConfirmOpen(false)}
            hold={hold}
            label="Balcão"
            onSuccess={(outcome) => {
              setHold(null);
              // O comprovante TEF já saiu da maquininha: imprime só as fichas.
              if (outcome.closed) finish(null, null);
            }}
          />
        </div>
      ) : (
        <Btn block size="lg" variant="success" disabled={busy} onClick={() => void charge()}>{busy ? 'Aguardando a maquininha…' : `Cobrar ${formatBRL(order.remaining_balance)}`}</Btn>
      )}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Btn variant="secondary" onClick={onDone}>Voltar (fica pendente)</Btn>
        <Btn variant="danger" disabled={busy} onClick={() => setVoidOpen(true)}>Cancelar venda</Btn>
      </div>

      <ManagerAuthSheet
        open={voidOpen}
        onClose={() => setVoidOpen(false)}
        title="Cancelar venda de balcão"
        summary={<span>Venda de {formatBRL(order.total_amount)} sem pagamento. Os itens ficam cancelados e auditados.</span>}
        confirmLabel="Cancelar venda"
        onSubmit={(managerPin, reason) => useTcheStore.getState().voidCounterSale(orderId, { managerPin, reason })}
        onSuccess={() => { setVoidOpen(false); toast.info('Venda de balcão cancelada.'); onDone(); }}
      />
    </div>
  );
}

function useCounterOrders(): Order[] {
  const tables = useTcheStore((s) => s.tables);
  const orders = useTcheStore((s) => s.orders);
  return useMemo(() => {
    const counterIds = new Set(tables.filter((t) => t.kind === 'COUNTER').map((t) => t.id));
    return orders.filter((o) => counterIds.has(o.table_id)).sort((a, b) => (a.opened_at < b.opened_at ? 1 : -1));
  }, [tables, orders]);
}

function PendingCounterSales({ onResume }: { onResume: (id: string) => void }) {
  const pending = useCounterOrders().filter((o) => o.status === 'PAYING');
  if (pending.length === 0) return null;
  return (
    <div className="mt-4 rounded-2xl border border-ouro/50 bg-ouro/10 p-3">
      <div className="mb-2 text-sm font-black text-brasa">Vendas aguardando pagamento</div>
      {pending.map((o) => (
        <button key={o.id} onClick={() => onResume(o.id)} className="mb-1 flex min-h-touch w-full items-center justify-between rounded-xl bg-base px-3 text-sm">
          <span>{new Date(o.opened_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>
          <b className="tabular-nums">{formatBRL(o.remaining_balance)}</b>
        </button>
      ))}
    </div>
  );
}

function RecentCounterSales() {
  const closed = useCounterOrders().filter((o) => o.status === 'CLOSED').slice(0, 5);
  const tickets = useTcheStore((s) => s.eventTickets);
  if (closed.length === 0) return null;
  return (
    <div className="mt-4 rounded-2xl border border-slate-200 bg-surface p-3">
      <div className="mb-2 text-sm font-black">Últimas vendas de balcão</div>
      {closed.map((o) => {
        const list = tickets.filter((t) => t.order_id === o.id);
        const used = list.filter((t) => t.redeemed).length;
        return (
          <div key={o.id} className="mb-1 flex items-center gap-2 rounded-xl bg-base px-3 py-2 text-sm">
            <span className="flex-1">{new Date(o.closed_at ?? o.opened_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} · {formatBRL(o.total_amount)} · {used}/{list.length} retiradas</span>
            {list.length > 0 && (
              <button onClick={() => printTickets(list.filter((t) => !t.redeemed && !t.voided_at), useTerminalBus.getState().chassis)} className="flex min-h-touch items-center gap-1 rounded-lg bg-slate-200 px-3 font-bold"><Printer className="h-4 w-4" /> Reimprimir</button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Retirada no balcão: lê o QR / digita o código. Uso único. */
function RedeemPanel() {
  const tickets = useTcheStore((s) => s.eventTickets);
  const [code, setCode] = useState('');
  const [result, setResult] = useState<{ ok: true; ticket: EventTicket } | { ok: false; error: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const redeem = () => {
    if (!code.trim()) return;
    const r = useTcheStore.getState().redeemEventTicket(code);
    setResult(r.ok ? { ok: true, ticket: r.data } : { ok: false, error: r.error });
    setCode('');
    inputRef.current?.focus();
  };

  const today = tickets.filter((t) => new Date(t.created_at).toDateString() === new Date().toDateString());
  const redeemed = today.filter((t) => t.redeemed).length;

  return (
    <div className="mx-auto max-w-xl">
      <div className="mb-3 flex gap-2">
        <input
          ref={inputRef}
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          onKeyDown={(e) => e.key === 'Enter' && redeem()}
          placeholder="Leia o QR ou digite o código da ficha"
          className="min-h-touch-lg flex-1 rounded-xl border border-slate-300 bg-surface px-3 font-mono text-lg uppercase tracking-wider outline-none focus:border-ouro"
        />
        <Btn size="lg" variant="gold" onClick={redeem}><ScanLine className="h-5 w-5" /> Validar</Btn>
      </div>
      {result && (
        <div className={`mb-3 rounded-3xl p-6 text-center ${result.ok ? 'bg-emerald-600 text-white' : 'bg-rose-700 text-white'}`}>
          {result.ok ? (
            <>
              <CheckCircle2 className="mx-auto mb-2 h-14 w-14" />
              <div className="text-sm font-bold uppercase">Pode entregar</div>
              <div className="text-4xl font-black leading-tight">{result.ticket.product_name_snapshot}</div>
              <div className="mt-1 font-mono text-sm opacity-80">{formatTicketToken(result.ticket.barcode_token)}</div>
            </>
          ) : (
            <>
              <XCircle className="mx-auto mb-2 h-14 w-14" />
              <div className="text-2xl font-black leading-tight">{result.error}</div>
            </>
          )}
        </div>
      )}
      <p className="text-center text-sm text-slate-500">Hoje: {redeemed} de {today.length} ficha(s) retiradas.</p>
    </div>
  );
}
