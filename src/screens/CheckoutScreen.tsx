import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Banknote, CheckCircle2, CreditCard, Divide, ListChecks, QrCode as QrIcon, Radio, Smartphone, Wallet } from 'lucide-react';
import { useTcheStore } from '../store/useTcheStore';
import type { OperationMode, Payment } from '../types';
import { computeEqualShare, computeItemsShare, formatBRL, round2, toCents } from '../lib/money';
import { createDriver, useTerminalBus, type Chassis, type ChargeRequest, type IPaymentTerminalDriver } from '../lib/payments/drivers';
import { cardReceiptLines, conferenceLines } from '../lib/receipts';
import { uuid } from '../lib/ids';
import { clearReviewHold, getReviewHold, setReviewHold, type ReviewHold } from '../lib/payments/reviewHolds';
import { Btn, Stepper, toast } from '../components/ui';
import { NfceViewer } from './NfceViewer';
import { ReviewCapture } from '../components/ReviewCapture';
import { CashbackCapture, CashbackRedeem } from '../components/CashbackPanel';
import { ConfirmReviewedChargeSheet } from '../components/ConfirmReviewedChargeSheet';

type SplitMode = 'EQUAL' | 'FREE' | 'ITEMS';
type Method = 'CREDIT' | 'DEBIT' | 'PIX' | 'CASH';

const METHOD_META: Record<Method, { label: string; icon: typeof CreditCard }> = {
  CREDIT: { label: 'Crédito', icon: CreditCard },
  DEBIT: { label: 'Débito', icon: Wallet },
  PIX: { label: 'Pix', icon: QrIcon },
  CASH: { label: 'Dinheiro', icon: Banknote },
};

/** Fechamento de conta: Rachadinha em 3 modos + TEF POS Sem Fio / SmartPOS Embarcado. */
export function CheckoutScreen({ orderId, onBack, onClosed }: { orderId: string; onBack: () => void; onClosed: () => void }) {
  const s = useTcheStore();
  const order = s.orders.find((o) => o.id === orderId);
  const table = s.tables.find((t) => t.id === order?.table_id);
  const items = useMemo(() => s.orderItems.filter((i) => i.order_id === orderId && i.status !== 'CANCELED' && i.combo_parent_item_id == null), [s.orderItems, orderId]);

  const [mode, setMode] = useState<SplitMode>('EQUAL');
  const [peopleLeft, setPeopleLeft] = useState(order?.customer_count ?? 1);
  const [freeRaw, setFreeRaw] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [method, setMethod] = useState<Method>('CREDIT');
  const [opMode, setOpMode] = useState<OperationMode>(s.tenant.default_mode);
  const [terminalId, setTerminalId] = useState<string>(s.terminals.find((t) => t.online)?.id ?? '');
  const [chassis, setChassis] = useState<Chassis>('STONE');
  const [cashGiven, setCashGiven] = useState('');
  const [busy, setBusy] = useState(false);
  const [closedOrderId, setClosedOrderId] = useState<string | null>(null);
  /** Cobrança com resultado incerto: bloqueia nova cobrança em maquininha até o operador conferir o extrato. */
  const [reviewHold, setReviewHoldState] = useState<ReviewHold | null>(() => getReviewHold(orderId));
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    if (order && order.status === 'OPEN' && order.remaining_balance > 0) {
      const r = s.startCheckout(orderId);
      if (!r.ok) toast.error(r.error);
    }
  }, [orderId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (closedOrderId) {
    const closedOrder = s.orders.find((o) => o.id === closedOrderId)!;
    return <ClosedView orderId={closedOrderId} label={table?.label ?? ''} total={closedOrder.total_amount} onDone={onClosed} />;
  }
  if (!order || !table) return <div className="p-6">Comanda não encontrada.</div>;

  const remaining = order.remaining_balance;
  const unpaidItems = items.filter((i) => !i.is_paid);
  const itemShare = computeItemsShare(order, s.orderItems.filter((i) => selected.includes(i.id)), s.orderItems);
  const freeValue = round2(Number(freeRaw.replace(',', '.')) || 0);

  const amount =
    mode === 'EQUAL' ? computeEqualShare(remaining, peopleLeft) : mode === 'FREE' ? freeValue : itemShare.share;
  const amountValid = amount > 0 && toCents(amount) <= toCents(remaining);
  const trayPending = s.tray.some((t) => t.order_id === orderId);
  const cashGivenValue = round2(Number(cashGiven.replace(',', '.')) || 0);
  const change = method === 'CASH' && cashGivenValue > amount ? round2(cashGivenValue - amount) : 0;

  const terminal = s.terminals.find((t) => t.id === terminalId) ?? null;
  const description =
    mode === 'EQUAL' ? `Cota ${order.customer_count - peopleLeft + 1} de ${order.customer_count}` : mode === 'FREE' ? 'Valor parcial livre' : `${selected.length} item(ns) consumido(s)`;

  const afterApproved = (payment: Payment, closed: boolean, pan: string | null, driver: IPaymentTerminalDriver | null) => {
    if (payment.method !== 'CASH' && driver) {
      // Bobina da própria maquininha quando há ponte nativa; no navegador, o simulador visual.
      const lines = cardReceiptLines({ tenant: s.tenant, payment, tableLabel: table.label, maskedPan: pan });
      driver.print(lines).catch(() => toast.error('Comprovante não impresso. Reimprima pela maquininha.'));
    }
    toast.success(`✅ ${formatBRL(payment.amount)} aprovado${payment.authorization_code ? ` · cAut ${payment.authorization_code}` : ''}`);
    if (mode === 'EQUAL') setPeopleLeft((n) => Math.max(1, n - 1));
    setSelected([]);
    setFreeRaw('');
    setCashGiven('');
    if (closed) setClosedOrderId(order.id);
  };

  const charge = async () => {
    if (!amountValid || busy || trayPending) return;
    const idempotency_key = uuid();
    const itemIds = mode === 'ITEMS' ? selected : [];

    if (method === 'CASH') {
      if (cashGivenValue > 0 && cashGivenValue < amount) return toast.error('Valor recebido menor que a cobrança.');
      const r = s.registerPayment({
        orderId, amount, method: 'CASH', status: 'APPROVED', terminal_id: null, acquirer: 'CASH_DESK', acquirer_cnpj: null,
        card_brand: null, nsu: null, authorization_code: null, terminal_serial: null, idempotency_key, item_ids: itemIds,
      });
      if (!r.ok) return toast.error(r.error);
      if (change > 0) toast.info(`Troco: ${formatBRL(change)}`);
      afterApproved(r.data.payment, r.data.closed, null, null);
      return;
    }

    if (reviewHold) return toast.error('Há uma cobrança sem confirmação. Confira o extrato da maquininha antes de cobrar de novo.');
    if (opMode === 'TEF_POS_WIRELESS' && (!terminal || !terminal.online)) return toast.error('Selecione uma maquininha online.');
    const driver = createDriver({ terminal: opMode === 'TEF_POS_WIRELESS' ? terminal : null, chassis: opMode === 'TEF_POS_WIRELESS' ? (terminal?.acquirer === 'PAGBANK' ? 'PAGBANK' : 'STONE') : chassis, mode: opMode });
    const req: ChargeRequest = { request_id: uuid(), idempotency_key, amount, method, table_label: table.label, order_id: orderId, description };
    const lock = s.beginTerminalCharge(orderId, req.request_id, amount);
    if (!lock.ok) return toast.error(lock.error);
    setBusy(true);
    if (opMode === 'TEF_POS_WIRELESS') toast.info(`📡 Cobrança de ${formatBRL(amount)} enviada para ${terminal?.name} (${terminal?.serial_number}).`);
    try {
      const result = await driver.charge(req);
      if (result.status === 'MANUAL_REVIEW') {
        // Não registra pagamento nem recusa: o resultado é desconhecido e não pode ser repetido sozinho.
        setReviewHoldState(setReviewHold({
          order_id: orderId, amount, reason: result.reason, code: result.failure_code, method,
          acquirer: result.acquirer === 'PAGBANK' ? 'PAGBANK' : 'STONE', terminal_id: result.terminal_id, terminal_serial: result.terminal_serial,
          idempotency_key, item_ids: itemIds,
        }));
        toast.alert(`⚠️ ${result.reason}`);
        return;
      }
      if (result.status === 'DECLINED') {
        s.registerPayment({
          orderId, amount, method, status: 'DECLINED', terminal_id: result.terminal_id, acquirer: result.acquirer, acquirer_cnpj: null,
          card_brand: null, nsu: null, authorization_code: null, terminal_serial: result.terminal_serial, idempotency_key, item_ids: [],
          charge_request_id: req.request_id,
        });
        toast.error(`❌ Transação recusada: ${result.reason}`);
        return;
      }
      const r = s.registerPayment({
        orderId, amount, method, status: 'APPROVED', terminal_id: result.terminal_id, acquirer: result.acquirer,
        acquirer_cnpj: result.acquirer_cnpj, card_brand: result.card_brand, nsu: result.nsu, authorization_code: result.authorization_code,
        terminal_serial: result.terminal_serial, idempotency_key, item_ids: itemIds, charge_request_id: req.request_id,
      });
      if (!r.ok) {
        // A maquininha aprovou mas o registro falhou: trava a conta (nunca cobra de novo) e o gerente registra pelo comprovante.
        setReviewHoldState(setReviewHold({
          order_id: orderId, amount, reason: `Aprovado na maquininha, mas não registrado: ${r.error}`, code: 'REGISTER_FAILED', method,
          acquirer: result.acquirer === 'PAGBANK' ? 'PAGBANK' : 'STONE', terminal_id: result.terminal_id, terminal_serial: result.terminal_serial,
          idempotency_key, item_ids: itemIds,
        }));
        toast.alert(`⚠️ Aprovado na maquininha, mas não registrado: ${r.error}`);
        return;
      }
      afterApproved(r.data.payment, r.data.closed, result.masked_pan, driver);
    } finally {
      useTcheStore.getState().endTerminalCharge(req.request_id);
      setBusy(false);
    }
  };

  const printPreview = () => {
    const waiter = s.staff.find((u) => u.id === order.opened_by_user_id) ?? null;
    useTerminalBus.getState().enqueuePrint({
      title: `Conferência ${table.label}`,
      lines: conferenceLines({ tenant: s.tenant, table, order, items: s.orderItems, products: s.products, waiter }),
      chassis: opMode === 'TEF_POS_WIRELESS' ? (terminal?.acquirer === 'PAGBANK' ? 'PAGBANK' : 'STONE') : chassis,
    });
  };

  return (
    <div className="mx-auto max-w-3xl px-3 pb-10 pt-3">
      <div className="mb-3 flex items-center gap-2">
        <button aria-label="Voltar" onClick={onBack} className="grid h-12 w-12 place-items-center rounded-xl bg-surface"><ArrowLeft className="h-6 w-6" /></button>
        <div className="flex-1">
          <div className="text-xl font-black">Fechamento · {table.label}</div>
          <div className="text-xs text-slate-500">Total {formatBRL(order.total_amount)} · pago {formatBRL(order.paid_amount)}</div>
        </div>
        <div className="text-right">
          <div className="text-xs text-slate-500">Saldo</div>
          <div className="text-2xl font-black tabular-nums text-brasa">{formatBRL(remaining)}</div>
        </div>
      </div>

      {/* Rachadinha — 3 modos */}
      <div className="mb-3 grid grid-cols-3 gap-2">
        {([
          ['EQUAL', 'Por pessoa', Divide],
          ['FREE', 'Valor livre', Wallet],
          ['ITEMS', 'Por item', ListChecks],
        ] as const).map(([k, label, Icon]) => (
          <button key={k} onClick={() => setMode(k)} className={`flex min-h-touch-lg flex-col items-center justify-center rounded-xl text-sm font-bold ${mode === k ? 'bg-brasa text-white' : 'bg-surface text-slate-700'}`}>
            <Icon className="h-5 w-5" /> {label}
          </button>
        ))}
      </div>

      <div className="mb-3 rounded-2xl border border-slate-200 bg-surface p-4">
        {mode === 'EQUAL' && (
          <div className="flex flex-col items-center gap-3">
            <p className="text-sm text-slate-500">Dividir o saldo restante entre quem ainda vai pagar</p>
            <Stepper value={peopleLeft} onChange={setPeopleLeft} max={50} />
            <div className="flex gap-2">{[2, 3, 4, 5, 6].map((n) => <button key={n} onClick={() => setPeopleLeft(n)} className={`h-11 w-11 rounded-lg font-bold ${peopleLeft === n ? 'bg-ouro text-slate-950' : 'bg-slate-200'}`}>{n}</button>)}</div>
            <p className="text-sm">Cota desta passada: <b className="text-lg text-brasa">{formatBRL(amount)}</b>{peopleLeft > 1 ? ` (${peopleLeft} pessoas restantes)` : ' (último pagante: saldo exato)'}</p>
          </div>
        )}
        {mode === 'FREE' && (
          <div>
            <label className="mb-1 block text-sm text-slate-500">Quanto o cliente quer pagar agora?</label>
            <input inputMode="decimal" value={freeRaw} onChange={(e) => setFreeRaw(e.target.value.replace(/[^\d.,]/g, ''))} placeholder="0,00" className="mb-2 min-h-touch-lg w-full rounded-xl border border-slate-300 bg-base px-3 text-3xl font-black outline-none focus:border-ouro" />
            <div className="flex flex-wrap gap-2">
              {[50, 80, 100, 150].map((v) => <button key={v} onClick={() => setFreeRaw(String(v))} className="min-h-touch rounded-xl bg-slate-200 px-4 font-bold">{formatBRL(v)}</button>)}
              <button onClick={() => setFreeRaw(remaining.toFixed(2))} className="min-h-touch rounded-xl bg-ouro px-4 font-bold text-slate-950">Saldo total</button>
            </div>
            {freeValue > remaining && <p className="mt-2 text-sm text-rose-600">Valor maior que o saldo restante.</p>}
          </div>
        )}
        {mode === 'ITEMS' && (
          <div>
            <p className="mb-2 text-sm text-slate-500">Marque o que este cliente consumiu (taxa de {order.charge_service_fee ? `${order.service_fee_pct}%` : '0%'} proporcional incluída)</p>
            <ul className="scroll-thin max-h-72 space-y-2 overflow-y-auto">
              {unpaidItems.map((i) => {
                const p = s.products.find((x) => x.id === i.product_id);
                const on = selected.includes(i.id);
                return (
                  <li key={i.id}>
                    <button onClick={() => setSelected((cur) => (on ? cur.filter((x) => x !== i.id) : [...cur, i.id]))} className={`flex min-h-touch w-full items-center justify-between rounded-xl border-2 px-3 text-left ${on ? 'border-stone bg-stone/15' : 'border-slate-200 bg-base'}`}>
                      <span><span className="mr-2 inline-block h-5 w-5 rounded border-2 border-slate-400 align-middle" style={on ? { background: '#10b981', borderColor: '#10b981' } : undefined} />{i.quantity}x {p?.name}</span>
                      <span className="tabular-nums">{formatBRL(i.total_item_price)}</span>
                    </button>
                  </li>
                );
              })}
              {items.filter((i) => i.is_paid).map((i) => (
                <li key={i.id} className="flex min-h-touch items-center justify-between rounded-xl bg-slate-50 px-3 text-slate-500 line-through">
                  <span>{i.quantity}x {s.products.find((x) => x.id === i.product_id)?.name}</span><span>pago</span>
                </li>
              ))}
            </ul>
            <div className="mt-2 text-sm">
              Itens {formatBRL(itemShare.items)} + taxa {formatBRL(itemShare.fee)}{itemShare.discount > 0 ? ` − desconto ${formatBRL(itemShare.discount)}` : ''} = <b className="text-brasa">{formatBRL(itemShare.share)}</b>
            </div>
          </div>
        )}
      </div>

      <CashbackRedeem orderId={orderId} />

      {/* Forma de pagamento */}
      <div className="mb-3 grid grid-cols-4 gap-2">
        {(Object.keys(METHOD_META) as Method[]).map((m) => {
          const Icon = METHOD_META[m].icon;
          return (
            <button key={m} onClick={() => setMethod(m)} className={`flex min-h-touch-lg flex-col items-center justify-center rounded-xl text-sm font-bold ${method === m ? 'bg-ouro text-slate-950' : 'bg-surface text-slate-700'}`}>
              <Icon className="h-5 w-5" />{METHOD_META[m].label}
            </button>
          );
        })}
      </div>

      {method === 'CASH' ? (
        <div className="mb-3 rounded-2xl border border-slate-200 bg-surface p-4">
          <label className="mb-1 block text-sm text-slate-500">Valor recebido (para troco)</label>
          <input inputMode="decimal" value={cashGiven} onChange={(e) => setCashGiven(e.target.value.replace(/[^\d.,]/g, ''))} placeholder={amount.toFixed(2)} className="min-h-touch-lg w-full rounded-xl border border-slate-300 bg-base px-3 text-2xl font-bold outline-none" />
          {change > 0 && <p className="mt-2 text-lg font-bold text-verde">Troco: {formatBRL(change)}</p>}
        </div>
      ) : (
        <div className="mb-3 rounded-2xl border border-slate-200 bg-surface p-4">
          <div className="mb-3 grid grid-cols-2 gap-2">
            <button onClick={() => setOpMode('TEF_POS_WIRELESS')} className={`flex min-h-touch-lg items-center justify-center gap-2 rounded-xl text-sm font-bold ${opMode === 'TEF_POS_WIRELESS' ? 'bg-stone text-white' : 'bg-base text-slate-700'}`}><Radio className="h-5 w-5" /> TEF POS Sem Fio</button>
            <button onClick={() => setOpMode('SMARTPOS_EMBEDDED')} className={`flex min-h-touch-lg items-center justify-center gap-2 rounded-xl text-sm font-bold ${opMode === 'SMARTPOS_EMBEDDED' ? 'bg-pagbank text-slate-950' : 'bg-base text-slate-700'}`}><Smartphone className="h-5 w-5" /> SmartPOS Embarcado</button>
          </div>
          {opMode === 'TEF_POS_WIRELESS' ? (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {s.terminals.map((t) => (
                <button key={t.id} disabled={!t.online} onClick={() => setTerminalId(t.id)} className={`flex min-h-touch-lg items-center justify-between rounded-xl border-2 px-3 text-left disabled:opacity-40 ${terminalId === t.id ? 'border-ouro bg-ouro/10' : 'border-slate-200 bg-base'}`}>
                  <span>
                    <span className="block font-bold">{t.name}</span>
                    <span className="text-xs text-slate-500">{t.serial_number} · {t.online ? `${t.battery_level ?? '?'}% bateria` : 'offline'}</span>
                  </span>
                  <span className={`h-3 w-3 rounded-full ${t.acquirer === 'STONE' ? 'bg-stone' : 'bg-pagbank'}`} />
                </button>
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => setChassis('STONE')} className={`min-h-touch-lg rounded-xl font-bold ${chassis === 'STONE' ? 'bg-stone text-white' : 'bg-base'}`}>Stone (Verde)</button>
              <button onClick={() => setChassis('PAGBANK')} className={`min-h-touch-lg rounded-xl font-bold ${chassis === 'PAGBANK' ? 'bg-pagbank text-slate-950' : 'bg-base'}`}>PagBank Moderninha (Amarelo)</button>
            </div>
          )}
        </div>
      )}

      {reviewHold && (
        <div role="alert" className="mb-3 rounded-2xl border-2 border-ouro bg-ouro/10 p-4 text-sm">
          <div className="mb-1 font-black text-brasa">Cobrança de {formatBRL(reviewHold.amount)} sem confirmação ({reviewHold.code})</div>
          <p className="mb-3 text-slate-800">{reviewHold.reason} Se a maquininha mostra a transação aprovada, não cobre de novo: o gerente registra pelo comprovante. Se não houve cobrança, libere abaixo.</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <Btn variant="success" size="lg" onClick={() => setConfirmOpen(true)}>Maquininha aprovou: registrar comprovante</Btn>
            <Btn variant="secondary" size="lg" onClick={() => { clearReviewHold(orderId); setReviewHoldState(null); }}>Conferi no extrato: não foi cobrado</Btn>
          </div>
          <ConfirmReviewedChargeSheet
            open={confirmOpen}
            onClose={() => setConfirmOpen(false)}
            hold={reviewHold}
            label={table.label}
            onSuccess={(outcome) => {
              // Mesmos ajustes de afterApproved, sem reimprimir o comprovante TEF (a maquininha já imprimiu).
              setReviewHoldState(null);
              if (mode === 'EQUAL') setPeopleLeft((n) => Math.max(1, n - 1));
              setSelected([]);
              setFreeRaw('');
              setCashGiven('');
              if (outcome.closed) setClosedOrderId(order.id);
            }}
          />
        </div>
      )}

      {trayPending && (
        <p className="mb-2 rounded-xl border border-rose-500 bg-rose-50 p-3 text-sm text-rose-700">Há itens na bandeja desta mesa que ainda não foram enviados. Volte e envie ou remova antes de cobrar.</p>
      )}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_2fr]">
        <Btn variant="secondary" size="lg" onClick={printPreview}>Prévia de conferência</Btn>
        <Btn variant="success" size="lg" disabled={!amountValid || busy || trayPending || (reviewHold !== null && method !== 'CASH')} onClick={charge}>
          {busy ? 'Aguardando maquininha…' : `${method === 'CASH' ? 'Receber' : opMode === 'TEF_POS_WIRELESS' ? 'Enviar para maquininha' : 'Cobrar na SmartPOS'} ${formatBRL(amount)}`}
        </Btn>
      </div>
    </div>
  );
}

function ClosedView({ orderId, label, total, onDone }: { orderId: string; label: string; total: number; onDone: () => void }) {
  const [showNfce, setShowNfce] = useState(false);
  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-4 py-10 text-center">
      <CheckCircle2 className="mb-3 h-20 w-20 text-verde" />
      <h2 className="text-2xl font-black">Conta encerrada!</h2>
      <p className="mb-1 text-slate-700">{label} · {formatBRL(total)} · saldo R$ 0,00</p>
      <p className="mb-6 text-sm text-slate-500">Mesa liberada no mapa e NFC-e modelo 65 gerada (tpIntegra = 1).</p>
      <div className="grid w-full gap-2">
        <CashbackCapture orderId={orderId} />
        <ReviewCapture orderId={orderId} source="TABLE" />
        <Btn variant="gold" size="lg" onClick={() => setShowNfce(true)}>Ver NFC-e / Imprimir DANFE</Btn>
        <Btn size="lg" onClick={onDone}>Voltar ao mapa de mesas</Btn>
      </div>
      {showNfce && <NfceViewer orderId={orderId} onClose={() => setShowNfce(false)} />}
    </div>
  );
}
