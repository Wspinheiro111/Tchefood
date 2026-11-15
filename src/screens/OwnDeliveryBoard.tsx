import { useMemo, useState } from 'react';
import { CheckCircle2, MapPin, MessageCircle, Phone, Route, Wallet, XCircle } from 'lucide-react';
import { CASH_ROLES, selectCurrentUser, useTcheStore } from '../store/useTcheStore';
import { formatBRL } from '../lib/money';
import { formatPickupNumber } from '../lib/kiosk';
import { MAX_ROUTE_STOPS, OWN_DELIVERY_STATUS_LABEL, outForDeliveryMessageUrl, routeUrl, settlementPreview } from '../lib/ownDelivery';
import { Badge, Btn, Sheet, toast } from '../components/ui';
import { ManagerAuthSheet } from '../components/ManagerAuthSheet';
import type { ActionResult, CourierSettlement, Order, OwnDelivery } from '../types';
import type { CourierSettleFollowUp, CourierSettlePendingEntry } from '../lib/sync/courierSettle';

const NO_PENDING: CourierSettlePendingEntry[] = [];
const NO_FOLLOW_UPS: CourierSettleFollowUp[] = [];

/**
 * O acerto que o operador abriu, com os valores que ele viu: a tela fica presa a ele até fechar,
 * mesmo quando o entregador sai da lista do acerto (auditoria interna, rodada 8 do PR #54).
 */
type SettleTarget =
  | { kind: 'new'; courierId: string; courierName: string; deliveryIds: string[]; cash: number; fees: number }
  | { kind: 'pending'; entry: CourierSettlePendingEntry };

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
  const [target, setTarget] = useState<SettleTarget | null>(null);
  const [payAuthOpen, setPayAuthOpen] = useState(false);
  const [followPinFor, setFollowPinFor] = useState<CourierSettleFollowUp | null>(null);
  // "Pago por fora" pede PIN de gerente e motivo (GPT, rodada 10 do PR #54).
  const [paidOutsideFor, setPaidOutsideFor] = useState<CourierSettleFollowUp | null>(null);
  // Senha presa na pendência: sai só com PIN de gerente e registro (GPT, rodada 10 do PR #54).
  const [resolveFor, setResolveFor] = useState<{ f: CourierSettleFollowUp; m: CourierSettleFollowUp['missing_payments'][number] } | null>(null);
  const pendingList = useTcheStore((s) => s.courierSettlePending ?? NO_PENDING);
  const followUps = useTcheStore((s) => s.courierSettleFollowUps ?? NO_FOLLOW_UPS);
  const [sentOut, setSentOut] = useState<OwnDelivery[] | null>(null);

  const orderById = useMemo(() => new Map(orders.map((o) => [o.id, o])), [orders]);
  const today = new Date().toDateString();
  // Entregues ficam no quadro só no dia; as ainda não acertadas aparecem no acerto.
  const visible = deliveries.filter((d) => d.status !== 'CANCELED' && (d.status !== 'DELIVERED' || new Date(d.delivered_at ?? d.created_at).toDateString() === today));
  const activeCouriers = couriers.filter((c) => c.active);
  const canSettle = user ? CASH_ROLES.includes(user.role) : false;
  // As entregas de um acerto sem resposta da nuvem ficam no cartão dele, nunca num acerto novo.
  const inPending = new Set(pendingList.flatMap((p) => p.delivery_ids));
  const toSettle = couriers
    .map((c) => ({ courier: c, preview: settlementPreview(c.id, deliveries.filter((d) => !inPending.has(d.id)), orders) }))
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

  // Com a loja ligada à nuvem, a nuvem confirma o acerto antes de sair dinheiro da gaveta
  // (sem internet não acerta); sem nuvem, acerta neste aparelho (auditoria interna, rodada 8 do PR #54).
  const cloudStore = useTcheStore((s) => s.cloud !== null);
  const [settlingBusy, setSettlingBusy] = useState(false);
  const shown = target === null ? null
    : target.kind === 'new'
      ? { name: target.courierName, count: target.deliveryIds.length, cash: target.cash, fees: target.fees }
      : { name: target.entry.courier_name, count: target.entry.delivery_ids.length, cash: target.entry.cash_collected, fees: target.entry.courier_fees };
  const settle = (t: SettleTarget, payFromDrawer: boolean, auth: { managerPin: string; reason: string } | null) =>
    t.kind === 'new'
      ? useTcheStore.getState().settleCourierOnline(t.courierId, { payFromDrawer, auth, deliveryIds: t.deliveryIds, expected: { cash: t.cash, fees: t.fees } })
      : useTcheStore.getState().settleCourierOnline(t.entry.courier_id, { payFromDrawer, auth, pendingId: t.entry.id });
  const closeSettle = () => {
    setPayAuthOpen(false);
    setTarget(null);
  };
  /**
   * O acerto foi para o quadro (gravado na nuvem com pendência, ou sem resposta da nuvem): o
   * erro vai para o aviso e as telas fecham; o cartão do quadro mostra o que falta.
   */
  const settleLanded = (t: SettleTarget, r: ActionResult<CourierSettlement>): boolean => {
    if (r.ok) return false;
    const ids = t.kind === 'new' ? t.deliveryIds : t.entry.delivery_ids;
    const s = useTcheStore.getState();
    const covers = (list: readonly { delivery_ids: string[] }[]) => list.some((x) => x.delivery_ids.some((id) => ids.includes(id)));
    if (!covers(s.courierSettleFollowUps ?? []) && !covers(s.courierSettlePending ?? [])) return false;
    toast.error(r.error);
    closeSettle();
    return true;
  };
  const finishFollowUp = (f: CourierSettleFollowUp, step: { kind: 'payments' }) => {
    const r = useTcheStore.getState().finishCourierSettleFollowUp(f.settlement_id, step);
    if (!r.ok) return toast.error(r.error);
    toast.success(r.data === null ? `Acerto de ${f.courier_name} terminado.` : 'Senhas recebidas.');
  };

  return (
    <div className="mx-auto max-w-6xl p-3">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h1 className="mr-auto flex items-center gap-2 text-xl font-black"><MapPin className="h-6 w-6 text-brasa" /> Entrega própria</h1>
        <span className="text-xs text-slate-500">Lance o pedido em Balcão › Entrega.</span>
      </div>

      {(followUps.length > 0 || pendingList.length > 0) && (
        <section className="mb-4 space-y-2 rounded-2xl border border-brasa/50 bg-brasa/10 p-3" aria-label="Acertos a terminar">
          {followUps.map((f) => (
            <div key={f.settlement_id} className="rounded-xl bg-surface p-3 text-sm">
              <h3 className="font-black text-rose-700">Acerto gravado na nuvem com pendência · {f.courier_name}</h3>
              <p className="text-slate-600">{f.delivery_ids.length} entrega(s) · dinheiro {formatBRL(f.cash_collected)} · ganho {formatBRL(f.courier_fees)}</p>
              <ul className="my-1 list-disc pl-5 text-slate-700">
                {f.missing_payments.map((m) => (
                  <li key={m.delivery_id}>
                    Senha {formatPickupNumber(m.pickup_number)}: {formatBRL(m.amount)} não recebido. {m.error}
                    {canSettle && (
                      <Btn variant="secondary" className="ml-2" onClick={() => setResolveFor({ f, m })}>Resolver com gerente</Btn>
                    )}
                  </li>
                ))}
                {f.missing_withdrawal && <li>Sangria de {formatBRL(f.missing_withdrawal.amount)} para o entregador não feita. {f.missing_withdrawal.error}</li>}
              </ul>
              {canSettle && (
                <div className="flex flex-wrap gap-2">
                  {f.missing_payments.length > 0 && <Btn variant="gold" onClick={() => finishFollowUp(f, { kind: 'payments' })}>Receber as senhas</Btn>}
                  {f.missing_withdrawal && <Btn variant="success" onClick={() => setFollowPinFor(f)}>Fazer a sangria (PIN do gerente)</Btn>}
                  {f.missing_withdrawal && <Btn variant="secondary" onClick={() => setPaidOutsideFor(f)}>Pago por fora</Btn>}
                </div>
              )}
            </div>
          ))}
          {pendingList.map((p) => (
            <div key={p.id} className="rounded-xl bg-surface p-3 text-sm">
              <h3 className="font-black text-rose-700">Acerto sem resposta da nuvem · {p.courier_name}</h3>
              <p className="text-slate-600">
                {p.delivery_ids.length} entrega(s) · dinheiro {formatBRL(p.cash_collected)} · ganho {formatBRL(p.courier_fees)}. A nuvem pode ter gravado:
                tente de novo (o mesmo acerto, com os mesmos valores). Nada saiu da gaveta por ele.
              </p>
              {canSettle && <Btn variant="gold" className="mt-2" onClick={() => setTarget({ kind: 'pending', entry: p })}>Tentar de novo</Btn>}
            </div>
          ))}
        </section>
      )}

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
                {canSettle && (
                  <Btn
                    variant="gold"
                    onClick={() => setTarget({
                      kind: 'new', courierId: courier.id, courierName: courier.name,
                      deliveryIds: preview.deliveries.map((d) => d.id), cash: preview.cashToCollect, fees: preview.courierFees,
                    })}
                  >
                    Acertar
                  </Btn>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {selected.length > 0 && (
        <div className="sticky top-[var(--equipe-topo,56px)] z-10 mb-3 flex flex-wrap items-center gap-2 rounded-2xl bg-slate-900 p-3 text-white">
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

      <Sheet open={target !== null && !payAuthOpen} onClose={closeSettle} title={`Acerto · ${shown?.name ?? ''}`}>
        {target && shown && (
          <div className="space-y-3 text-sm">
            {target.kind === 'pending' && (
              <p className="rounded-xl bg-brasa/10 p-2 text-slate-700">
                Tentativa de novo do acerto sem resposta da nuvem: as mesmas entregas e os mesmos valores. Se a nuvem gravou, ela devolve o mesmo acerto.
              </p>
            )}
            <dl className="grid grid-cols-2 gap-1">
              <dt>Entregas</dt><dd className="text-right font-bold">{shown.count}</dd>
              <dt>Dinheiro recebido dos clientes</dt><dd className="text-right font-bold">{formatBRL(shown.cash)}</dd>
              <dt>Ganho do entregador</dt><dd className="text-right font-bold">{formatBRL(shown.fees)}</dd>
            </dl>
            <p className="rounded-xl bg-base p-2 text-slate-700">
              O dinheiro das contas pagas na entrega entra no caixa como recebimento em dinheiro. O ganho do entregador pode sair da gaveta
              (sangria com PIN do gerente) ou ser pago por fora.
            </p>
            {cloudStore && (
              <p className="rounded-xl bg-ouro/15 p-2 text-slate-700">
                Loja na nuvem: o acerto precisa da internet. A nuvem confirma que nenhuma destas entregas já foi acertada em outro aparelho
                antes de sair dinheiro da gaveta.
              </p>
            )}
            <Btn block variant="success" onClick={() => setPayAuthOpen(true)} disabled={shown.fees <= 0 || settlingBusy}>
              Receber e pagar {formatBRL(shown.fees)} pela gaveta
            </Btn>
            <Btn
              block
              variant="secondary"
              disabled={settlingBusy}
              onClick={async () => {
                const t = target;
                setSettlingBusy(true);
                const r = await settle(t, false, null);
                setSettlingBusy(false);
                if (settleLanded(t, r)) return;
                if (!r.ok) return toast.error(r.error);
                toast.success(`Acerto feito: ${formatBRL(r.data.cash_collected)} recebidos.`);
                closeSettle();
              }}
            >
              Só receber o dinheiro (pago o entregador por fora)
            </Btn>
          </div>
        )}
      </Sheet>

      <ManagerAuthSheet
        open={payAuthOpen && target !== null}
        onClose={() => setPayAuthOpen(false)}
        title="Pagar entregador pela gaveta"
        summary={<span>Sangria de <b>{formatBRL(shown?.fees ?? 0)}</b> para {shown?.name}.</span>}
        confirmLabel="Autorizar e acertar"
        quickReasons={[`Acerto do entregador ${shown?.name ?? ''}`.trim()]}
        successMessage="Acerto feito."
        onSubmit={async (managerPin, reason) => {
          const t = target!;
          const r = await settle(t, true, { managerPin, reason });
          settleLanded(t, r);
          return r;
        }}
        onSuccess={closeSettle}
      />

      <ManagerAuthSheet
        open={followPinFor !== null}
        onClose={() => setFollowPinFor(null)}
        title="Sangria do acerto com pendência"
        summary={<span>Sangria de <b>{formatBRL(followPinFor?.missing_withdrawal?.amount ?? 0)}</b> para {followPinFor?.courier_name} (acerto já gravado na nuvem).</span>}
        confirmLabel="Autorizar sangria"
        quickReasons={[`Acerto do entregador ${followPinFor?.courier_name ?? ''}`.trim()]}
        successMessage="Sangria feita."
        onSubmit={(managerPin, reason) => useTcheStore.getState().finishCourierSettleFollowUp(followPinFor!.settlement_id, { kind: 'withdrawal', auth: { managerPin, reason } })}
        onSuccess={() => setFollowPinFor(null)}
      />

      <ManagerAuthSheet
        open={paidOutsideFor !== null}
        onClose={() => setPaidOutsideFor(null)}
        title="Ganho do entregador pago por fora"
        summary={<span>Ganho de <b>{formatBRL(paidOutsideFor?.missing_withdrawal?.amount ?? 0)}</b> para {paidOutsideFor?.courier_name} pago sem sair da gaveta. Fica registrado na auditoria; diga no motivo como foi pago.</span>}
        confirmLabel="Autorizar pago por fora"
        quickReasons={['Pago em pix pela loja', 'Pago em dinheiro fora do caixa']}
        successMessage="Ganho marcado como pago por fora."
        onSubmit={(managerPin, reason) => useTcheStore.getState().finishCourierSettleFollowUp(paidOutsideFor!.settlement_id, { kind: 'paid_outside', auth: { managerPin, reason } })}
        onSuccess={() => setPaidOutsideFor(null)}
      />

      <ManagerAuthSheet
        open={resolveFor !== null}
        onClose={() => setResolveFor(null)}
        title="Senha resolvida com o gerente"
        summary={<span>Senha {formatPickupNumber(resolveFor?.m.pickup_number ?? null)} de {resolveFor?.f.courier_name}: <b>{formatBRL(resolveFor?.m.amount ?? 0)}</b> sai da pendência sem ser recebida aqui. Fica registrado na auditoria; diga no motivo o que aconteceu.</span>}
        confirmLabel="Autorizar"
        quickReasons={['Recebido no caixa por outro meio', 'Conta desfeita pelo cliente']}
        successMessage="Senha resolvida."
        onSubmit={(managerPin, reason) => useTcheStore.getState().finishCourierSettleFollowUp(resolveFor!.f.settlement_id, { kind: 'payment_resolved', delivery_id: resolveFor!.m.delivery_id, auth: { managerPin, reason } })}
        onSuccess={() => setResolveFor(null)}
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
