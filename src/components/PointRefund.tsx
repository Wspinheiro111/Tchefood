import { useMemo, useState } from 'react';
import { Btn, toast } from './ui';
import { ManagerAuthSheet, SERVER_REASON_MIN_LENGTH } from './ManagerAuthSheet';
import { useTcheStore } from '../store/useTcheStore';
import { formatBRL } from '../lib/money';
import { defaultReconcileDeps, refundPointPayment, type ReconcileDeps } from '../lib/payments/pointReconcile';
import type { ActionResult, Payment } from '../types';

/**
 * Estorno de pagamento da Point já registrado (auditoria GPT r9, P1-01): a venda foi estornada na maquininha ou no app
 * do Mercado Pago depois de o pagamento entrar na conta. O gerente pede o registro; o servidor só grava com o Mercado
 * Pago mostrando o pagamento estornado.
 */
export const POINT_REFUND_HELP =
  'Use depois de estornar a venda na maquininha ou no app do Mercado Pago. O estorno só é registrado se o Mercado Pago mostrar este pagamento estornado; se não mostrar, nada muda.';
export const POINT_REFUND_DONE = 'Estorno registrado: o Mercado Pago confirmou e o pagamento saiu da conta.';
export const POINT_REFUND_NFCE = 'Este pagamento tinha NFC-e emitida: confira o cancelamento da nota.';
/**
 * Auditoria interna 2 (P2-B): o estorno só devolve o saldo; os itens pagos continuam marcados como pagos (aqui e no
 * servidor), e o "por item" não os oferece de novo.
 */
export const POINT_REFUND_ITEMS_PAID = 'Os itens dessa venda continuam marcados como pagos: cobre o saldo por valor (por pessoa ou valor livre), não por item.';

/** Pede o estorno ao servidor e, gravado lá, espelha aqui (pagamento REFUNDED, saldo, trava da chave). */
export async function submitPointRefund(payment: Payment, managerPin: string, reason: string, deps: ReconcileDeps = defaultReconcileDeps()): Promise<ActionResult<{ nfceIssued: boolean; itemsStayPaid: boolean }>> {
  const key = payment.idempotency_key;
  if (!key || payment.acquirer !== 'MERCADO_PAGO') return { ok: false, error: 'Só pagamento da Point (Mercado Pago) tem estorno registrado aqui.' };
  const staff = useTcheStore.getState().currentUserId;
  if (!staff) return { ok: false, error: 'Entre com o seu usuário antes de registrar o estorno.' };
  const out = await refundPointPayment({ idempotency_key: key, staff_id: staff, manager_pin: managerPin, reason_text: reason }, deps);
  if (out.kind !== 'refunded') return { ok: false, error: out.error };
  // Auditoria interna 2 (P1-A): o servidor diz se tem o pagamento; sem ele, o espelho desfaz as consequências daqui.
  const mirrored = useTcheStore.getState().mirrorServerPointRefund(key, reason, out.paymentRegistered === undefined ? undefined : { paymentRegistered: out.paymentRegistered });
  if (!mirrored.ok) return { ok: false, error: mirrored.error };
  const st = useTcheStore.getState();
  const order = st.orders.find((o) => o.id === payment.order_id);
  const itemsStayPaid = order?.status !== 'CLOSED' && st.orderItems.some((i) => i.order_id === payment.order_id && i.status !== 'CANCELED' && i.is_paid);
  return { ok: true, data: { nfceIssued: mirrored.data.nfceIssued, itemsStayPaid } };
}

export function PointRefundButton({ payment, label }: { payment: Payment; label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Btn variant="secondary" size="md" onClick={() => setOpen(true)}>Registrar estorno</Btn>
      <ManagerAuthSheet
        open={open}
        onClose={() => setOpen(false)}
        title="Estorno da Point"
        summary={<span>{label} · {formatBRL(payment.amount)} · {POINT_REFUND_HELP}</span>}
        confirmLabel="Conferir e registrar"
        minReason={SERVER_REASON_MIN_LENGTH}
        quickReasons={['Venda estornada na maquininha', 'Estornado no app do Mercado Pago']}
        successMessage={POINT_REFUND_DONE}
        onSubmit={(pin, reason) => submitPointRefund(payment, pin, reason)}
        onSuccess={(data) => {
          if (data.nfceIssued) toast.alert(POINT_REFUND_NFCE);
          if (data.itemsStayPaid) toast.alert(POINT_REFUND_ITEMS_PAID);
        }}
      />
    </>
  );
}

/** Quantos dias para trás a lista de estorno mostra (auditoria interna 2, P2-E: estorno da venda de ontem). */
export const POINT_REFUND_LIST_DAYS = 30;
/** Linhas mostradas de uma vez (a busca acha as outras). */
const POINT_REFUND_LIST_MAX = 50;

/**
 * Pagamentos da Point aprovados neste aparelho nos últimos POINT_REFUND_LIST_DAYS dias (o servidor pode ainda não ter
 * algum), com busca por NSU, valor, bandeira ou data, e o pedido de estorno.
 */
export function PointRefunds({ payments, nowMs = Date.now() }: { payments: readonly Payment[]; nowMs?: number }) {
  const [query, setQuery] = useState('');
  const recent = useMemo(() => {
    const since = nowMs - POINT_REFUND_LIST_DAYS * 24 * 60 * 60 * 1000;
    return payments
      .filter((p) => p.acquirer === 'MERCADO_PAGO' && p.status === 'APPROVED' && p.idempotency_key && Date.parse(p.created_at) >= since)
      .sort((x, y) => Date.parse(y.created_at) - Date.parse(x.created_at));
  }, [payments, nowMs]);
  const label = (p: Payment) => `${new Date(p.created_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} · ${p.card_brand ?? 'cartão'} · NSU ${p.nsu ?? '?'}`;
  const q = query.trim().toLowerCase();
  const rows = (q ? recent.filter((p) => `${label(p)} ${formatBRL(p.amount)} ${p.amount.toFixed(2)} ${p.authorization_code ?? ''}`.toLowerCase().includes(q)) : recent).slice(0, POINT_REFUND_LIST_MAX);
  if (recent.length === 0) return null;
  return (
    <div className="rounded-2xl border border-slate-200 bg-surface p-4 text-sm">
      <div className="mb-1 font-bold">Pagamentos da Point aprovados neste aparelho (Mercado Pago, últimos {POINT_REFUND_LIST_DAYS} dias)</div>
      <p className="mb-2 text-xs text-slate-500">Lista deste aparelho: algum pode ainda não ter chegado ao servidor. Estornou uma venda na maquininha ou no app do Mercado Pago? Registre aqui com o PIN do gerente; o servidor confere a cobrança no Mercado Pago.</p>
      <label htmlFor="point-refund-search" className="mb-1 block text-xs font-semibold text-slate-600">Buscar (NSU, valor, bandeira ou data)</label>
      <input id="point-refund-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Ex.: 123456 ou 50,00" className="mb-2 min-h-touch w-full rounded-xl border border-slate-300 bg-base px-3 outline-none focus:border-ouro" />
      {rows.length === 0 && <p className="py-2 text-slate-500">Nenhum pagamento da Point com essa busca.</p>}
      {rows.map((p) => (
        <div key={p.id} className="flex items-center justify-between gap-2 border-t border-slate-200 py-2">
          <span className="text-slate-600">{label(p)} · {formatBRL(p.amount)}</span>
          <PointRefundButton payment={p} label={label(p)} />
        </div>
      ))}
      {!q && recent.length > rows.length && <p className="pt-2 text-xs text-slate-500">Mostrando os {rows.length} mais recentes de {recent.length}: use a busca para achar outro.</p>}
    </div>
  );
}
