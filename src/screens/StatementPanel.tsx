import { useMemo, useState } from 'react';
import { Ban, BadgePercent, CheckCheck, CreditCard, HandPlatter, Lock, Printer, QrCode as QrIcon, Receipt, RotateCcw } from 'lucide-react';
import { useTcheStore } from '../store/useTcheStore';
import type { ItemStatus, OrderItem } from '../types';
import { formatBRL, round2 } from '../lib/money';
import { conferenceLines } from '../lib/receipts';
import { useTerminalBus } from '../lib/payments/drivers';
import { ManagerAuthSheet } from '../components/ManagerAuthSheet';
import { Badge, Btn, Sheet, Stepper, toast } from '../components/ui';
import { SECTOR_LABEL } from './OrderScreen';
import { NfceViewer } from './NfceViewer';

export const ITEM_STATUS_STYLE: Record<ItemStatus, { label: string; cls: string }> = {
  PENDING: { label: 'Na fila', cls: 'bg-slate-600 text-white' },
  PREPARING: { label: 'Preparando', cls: 'bg-ouro text-slate-950' },
  READY: { label: 'Pronto', cls: 'bg-stone text-slate-950' },
  DELIVERED: { label: 'Entregue', cls: 'bg-slate-800 text-slate-300' },
  CANCELED: { label: 'Cancelado', cls: 'bg-brasa/30 text-rose-200 line-through' },
};

type Pending =
  | { kind: 'cancel'; item: OrderItem }
  | { kind: 'fee' }
  | { kind: 'discount'; amount: number }
  | null;

export function StatementPanel({ orderId, onCheckout }: { orderId: string; onCheckout: () => void }) {
  const s = useTcheStore();
  const order = s.orders.find((o) => o.id === orderId)!;
  const table = s.tables.find((t) => t.id === order.table_id)!;
  const items = useMemo(() => s.orderItems.filter((i) => i.order_id === orderId).sort((a, b) => a.created_at.localeCompare(b.created_at)), [s.orderItems, orderId]);
  const payments = s.payments.filter((p) => p.order_id === orderId);
  const [pending, setPending] = useState<Pending>(null);
  const [discountOpen, setDiscountOpen] = useState(false);
  const [nfceOpen, setNfceOpen] = useState(false);
  const closed = order.status === 'CLOSED';

  const productOf = (id: string) => s.products.find((p) => p.id === id);
  const staffName = (id: string) => s.staff.find((u) => u.id === id)?.name ?? '?';

  const printConference = () => {
    const waiter = s.staff.find((u) => u.id === order.opened_by_user_id) ?? null;
    const lines = conferenceLines({ tenant: s.tenant, table, order, items: s.orderItems, products: s.products, waiter });
    useTerminalBus.getState().enqueuePrint({ title: `Conferência ${table.label}`, lines, chassis: useTerminalBus.getState().chassis });
  };

  return (
    <div className="flex-1 px-3 pb-10 pt-3">
      {closed && (
        <div className="mb-3 rounded-xl border border-stone bg-stone/10 p-3">
          <div className="font-bold text-stone">Conta encerrada · NFC-e {order.nfce_status}</div>
          <div className="mb-2 break-all font-mono text-xs text-slate-300">{order.nfce_key}</div>
          <Btn variant="success" onClick={() => setNfceOpen(true)}><Receipt className="h-5 w-5" /> Ver NFC-e / DANFE</Btn>
        </div>
      )}

      <ul className="mb-4 space-y-2">
        {items.map((it) => {
          const p = productOf(it.product_id);
          const st = ITEM_STATUS_STYLE[it.status];
          const canceled = it.status === 'CANCELED';
          return (
            <li key={it.id} className={`rounded-xl border p-3 ${canceled ? 'border-brasa/40 bg-brasa/5' : 'border-slate-700 bg-surface'}`}>
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className={`font-semibold ${canceled ? 'line-through opacity-60' : ''}`}>
                    {it.quantity}x {p?.name}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    <Badge className={st.cls}>{st.label}</Badge>
                    <Badge className="bg-slate-700 text-slate-200">{SECTOR_LABEL[it.sector]}</Badge>
                    {it.meat_doneness && <Badge className="bg-rose-800 text-white">{it.meat_doneness}</Badge>}
                    {it.origin === 'QRCODE_TABLE' && <Badge className="bg-sky-600 text-white"><QrIcon className="h-3 w-3" /> QR Code</Badge>}
                    {it.is_paid && <Badge className="bg-stone text-slate-950">Pago</Badge>}
                  </div>
                  {it.notes && <div className="mt-1 text-xs text-sky-300">{it.notes}</div>}
                  <div className="mt-1 text-xs text-slate-500">
                    {new Date(it.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} · {staffName(it.waiter_id)}
                  </div>
                  {canceled && <div className="mt-1 text-xs text-rose-300">Cancelado por {staffName(it.canceled_by_user_id ?? '')}: {it.cancel_reason}</div>}
                </div>
                <div className="text-right">
                  <div className={`font-bold tabular-nums ${canceled ? 'line-through opacity-50' : ''}`}>{formatBRL(it.total_item_price)}</div>
                  {!closed && !canceled && (
                    <div className="mt-2 flex flex-col items-end gap-1">
                      {it.status === 'READY' && (
                        <button onClick={() => { const r = s.markItemDelivered(it.id); if (!r.ok) toast.error(r.error); }} className="inline-flex min-h-touch items-center gap-1 rounded-lg bg-stone px-3 text-sm font-bold text-slate-950">
                          <HandPlatter className="h-4 w-4" /> Entregar
                        </button>
                      )}
                      {!it.is_paid && (
                        <button onClick={() => setPending({ kind: 'cancel', item: it })} className="inline-flex min-h-touch items-center gap-1 rounded-lg border border-brasa px-3 text-sm font-bold text-rose-300">
                          <Lock className="h-4 w-4" /> Cancelar
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </li>
          );
        })}
        {items.length === 0 && <li className="py-6 text-center text-slate-500">Nenhum item lançado ainda.</li>}
      </ul>

      <div className="mb-4 rounded-2xl border border-slate-700 bg-surface p-4">
        <Row label="Subtotal dos itens" value={formatBRL(order.subtotal_items)} />
        <div className="flex items-center justify-between py-1">
          <span className={order.charge_service_fee ? '' : 'text-slate-500 line-through'}>Taxa de serviço {order.service_fee_pct}%</span>
          <span className="flex items-center gap-2">
            <span className="tabular-nums">{formatBRL(order.service_fee_amount)}</span>
            {!closed &&
              (order.charge_service_fee ? (
                <button onClick={() => setPending({ kind: 'fee' })} className="inline-flex min-h-touch items-center gap-1 rounded-lg border border-brasa px-2 text-xs font-bold text-rose-300">
                  <Lock className="h-3 w-3" /> Remover
                </button>
              ) : (
                <button
                  onClick={() => { const r = s.restoreServiceFee(orderId); if (!r.ok) toast.error(r.error); else toast.success('Taxa de serviço reativada.'); }}
                  className="inline-flex min-h-touch items-center gap-1 rounded-lg bg-slate-700 px-2 text-xs font-bold"
                >
                  <RotateCcw className="h-3 w-3" /> Reativar
                </button>
              ))}
          </span>
        </div>
        <div className="flex items-center justify-between py-1">
          <span>Desconto</span>
          <span className="flex items-center gap-2">
            <span className="tabular-nums text-rose-300">{order.discount_amount > 0 ? `− ${formatBRL(order.discount_amount)}` : formatBRL(0)}</span>
            {!closed && (
              <button onClick={() => setDiscountOpen(true)} className="inline-flex min-h-touch items-center gap-1 rounded-lg border border-brasa px-2 text-xs font-bold text-rose-300">
                <BadgePercent className="h-3 w-3" /> Aplicar
              </button>
            )}
          </span>
        </div>
        <div className="my-2 border-t border-slate-700" />
        <Row label={<span className="text-lg font-bold">Total da mesa</span>} value={<span className="text-2xl font-black text-ouro">{formatBRL(order.total_amount)}</span>} />
        {order.paid_amount > 0 && (
          <>
            <Row label="Já pago" value={<span className="text-stone">{formatBRL(order.paid_amount)}</span>} />
            <Row label={<span className="font-bold">Saldo restante</span>} value={<span className="text-xl font-black">{formatBRL(order.remaining_balance)}</span>} />
          </>
        )}
        {!closed && (
          <div className="mt-3 flex items-center justify-between rounded-xl bg-base p-2">
            <span className="text-sm">Pessoas na mesa · {formatBRL(order.customer_count ? round2(order.remaining_balance / order.customer_count) : 0)} cada</span>
            <Stepper value={order.customer_count} onChange={(n) => s.updateCustomerCount(orderId, n)} />
          </div>
        )}
      </div>

      {payments.length > 0 && (
        <div className="mb-4 rounded-2xl border border-slate-700 bg-surface p-4">
          <h3 className="mb-2 font-bold">Pagamentos</h3>
          {payments.map((p) => (
            <div key={p.id} className="flex items-center justify-between border-b border-slate-800 py-1 text-sm last:border-0">
              <span>
                <Badge className={p.status === 'APPROVED' ? 'bg-stone text-slate-950' : 'bg-brasa text-white'}>{p.status === 'APPROVED' ? 'Aprovado' : 'Recusado'}</Badge>{' '}
                {p.method} · {p.acquirer} {p.card_brand ?? ''} {p.authorization_code ? `· cAut ${p.authorization_code}` : ''}
              </span>
              <span className="tabular-nums">{formatBRL(p.amount)}</span>
            </div>
          ))}
        </div>
      )}

      {!closed && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <Btn variant="secondary" size="lg" onClick={printConference}><Printer className="h-5 w-5" /> Imprimir conferência</Btn>
          {table.status === 'WAITING_BILL' ? (
            <Btn variant="secondary" size="lg" onClick={() => s.resumeService(orderId)}><CheckCheck className="h-5 w-5" /> Voltar a atender</Btn>
          ) : (
            <Btn variant="gold" size="lg" disabled={table.status !== 'OCCUPIED'} onClick={() => { const r = s.requestBill(orderId); if (!r.ok) toast.error(r.error); else toast.success('Mesa marcada como "Pediu a conta".'); }}>
              <Receipt className="h-5 w-5" /> Pedir a conta
            </Btn>
          )}
          <Btn variant="success" size="lg" disabled={order.remaining_balance <= 0} onClick={onCheckout}><CreditCard className="h-5 w-5" /> Fechar / Cobrar</Btn>
        </div>
      )}

      {pending?.kind === 'cancel' && (
        <ManagerAuthSheet
          open
          onClose={() => setPending(null)}
          title="Cancelar item enviado"
          confirmLabel="Autorizar cancelamento"
          summary={
            <>
              <div className="font-bold">{pending.item.quantity}x {productOf(pending.item.product_id)?.name}</div>
              <div>Status atual: {ITEM_STATUS_STYLE[pending.item.status].label} · {SECTOR_LABEL[pending.item.sector]}</div>
              <div>Valor: {formatBRL(pending.item.total_item_price)} (+ taxa proporcional)</div>
              <div className="mt-1 text-xs text-rose-200">O item NÃO será excluído: fica como CANCELADO com registro imutável em audit_logs.</div>
            </>
          }
          onSubmit={(pin, reason) => s.cancelOrderItem(pending.item.id, { managerPin: pin, reason })}
          onSuccess={() => toast.success('Item cancelado.')}
        />
      )}
      {pending?.kind === 'fee' && (
        <ManagerAuthSheet
          open
          onClose={() => setPending(null)}
          title="Remover taxa de serviço"
          confirmLabel="Autorizar remoção dos 10%"
          summary={<div>Remover {order.service_fee_pct}% ({formatBRL(order.service_fee_amount)}) da {table.label}.</div>}
          onSubmit={(pin, reason) => s.removeServiceFee(orderId, { managerPin: pin, reason })}
          onSuccess={() => toast.success('Taxa de serviço removida.')}
        />
      )}
      {pending?.kind === 'discount' && (
        <ManagerAuthSheet
          open
          onClose={() => setPending(null)}
          title="Aplicar desconto"
          confirmLabel={`Autorizar desconto de ${formatBRL(pending.amount)}`}
          summary={<div>Desconto de {formatBRL(pending.amount)} na {table.label} (total atual {formatBRL(order.total_amount)}).</div>}
          onSubmit={(pin, reason) => s.applyDiscount(orderId, pending.amount, { managerPin: pin, reason })}
          onSuccess={() => toast.success('Desconto aplicado.')}
        />
      )}
      <DiscountSheet
        open={discountOpen}
        gross={round2(order.subtotal_items + order.service_fee_amount)}
        onClose={() => setDiscountOpen(false)}
        onNext={(amount) => { setDiscountOpen(false); setPending({ kind: 'discount', amount }); }}
      />
      {nfceOpen && <NfceViewer orderId={orderId} onClose={() => setNfceOpen(false)} />}
    </div>
  );
}

function Row({ label, value }: { label: React.ReactNode; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-1">
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

function DiscountSheet({ open, gross, onClose, onNext }: { open: boolean; gross: number; onClose: () => void; onNext: (amount: number) => void }) {
  const [raw, setRaw] = useState('');
  const value = Number(raw.replace(',', '.')) || 0;
  return (
    <Sheet open={open} onClose={onClose} title="Valor do desconto" footer={<Btn block size="lg" disabled={!(value > 0) || value > gross} onClick={() => { onNext(round2(value)); setRaw(''); }}><Ban className="h-5 w-5" /> Continuar para PIN do gerente</Btn>}>
      <p className="mb-2 text-sm text-slate-400">Conta bruta (itens + taxa): {formatBRL(gross)}</p>
      <input
        inputMode="decimal"
        value={raw}
        onChange={(e) => setRaw(e.target.value.replace(/[^\d.,]/g, ''))}
        placeholder="0,00"
        className="mb-3 min-h-touch-lg w-full rounded-xl border border-slate-600 bg-base px-3 text-2xl font-bold outline-none focus:border-ouro"
      />
      <div className="flex flex-wrap gap-2">
        {[5, 10, 15, 20].map((pct) => (
          <button key={pct} onClick={() => setRaw(round2((gross * pct) / 100).toFixed(2))} className="min-h-touch rounded-xl bg-slate-700 px-4 font-bold">{pct}%</button>
        ))}
      </div>
    </Sheet>
  );
}
