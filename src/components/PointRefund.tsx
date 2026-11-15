import { useEffect, useMemo, useState } from 'react';
import { Btn, toast } from './ui';
import { ManagerAuthSheet, SERVER_REASON_MIN_LENGTH } from './ManagerAuthSheet';
import { useTcheStore } from '../store/useTcheStore';
import { formatBRL } from '../lib/money';
import { defaultReconcileDeps, refundPointPayment, type ReconcileDeps } from '../lib/payments/pointReconcile';
import { closeRefundedOrder, getOrderSnapshot, listPointPayments, type ServerOrderSnapshot, type ServerPointPayment, type ServerReopenedOrder } from '../lib/payments/pointPaymentsServer';
import { isRefundReopenedOrder, pullRefundOrders, syncOrderFromServer, type BlockedReason } from '../lib/payments/refundOrdersPull';

export { isRefundReopenedOrder, syncOrderFromServer };
import type { ClaimDeps } from '../lib/payments/paymentClaim';
import { toCents } from '../lib/money';
import { uuid } from '../lib/ids';
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

/** Pagamento da Point a estornar: o local (Payment) ou a linha do servidor (sem pagamento neste aparelho). */
export interface PointRefundTarget {
  idempotency_key: string | null;
  order_id: string;
  amount: number;
  acquirer?: Payment['acquirer'];
}

export interface PointRefundOutcome {
  nfceIssued: boolean;
  itemsStayPaid: boolean;
  /** GPT r10 (P1-01): a conta estava fechada e reabriu (servidor e aqui): cobrar de novo ou encerrar como venda devolvida. */
  reopened: boolean;
  /** Havia a conta ou o pagamento neste aparelho e o estorno foi espelhado aqui. */
  mirrored: boolean;
}

/** Estorno registrado e a conta fechada reaberta: os próximos passos. */
export const POINT_REFUND_REOPENED = 'A conta estava encerrada e foi reaberta com o saldo estornado. Cobre de novo ou encerre como venda devolvida (PIN do gerente) em Conciliação › Contas reabertas pelo estorno.';
/**
 * GPT r12 (P1-02): estorno de pagamento que este aparelho não tem e a conta não pôde ser trazida do servidor agora.
 * A conta reaberta aparece em "Contas reabertas pelo estorno" (lista do servidor) quando a leitura voltar.
 */
export const POINT_REFUND_REMOTE = 'Estorno registrado no servidor. Não deu para trazer a conta para este aparelho agora: ela aparece em Conciliação › Contas reabertas pelo estorno quando a leitura da nuvem voltar.';

/**
 * Pede o estorno ao servidor e, gravado lá, espelha aqui (pagamento REFUNDED, saldo, conta reaberta, trava da chave) se
 * a conta ou o pagamento existem neste aparelho (GPT r10, P1-02: o pagamento pode ser de outro aparelho, lido do
 * servidor; então nada muda aqui).
 */
export async function submitPointRefund(
  target: PointRefundTarget, managerPin: string, reason: string, deps: ReconcileDeps = defaultReconcileDeps(), snapshotDeps?: ClaimDeps,
): Promise<ActionResult<PointRefundOutcome>> {
  const key = target.idempotency_key;
  if (!key || (target.acquirer !== undefined && target.acquirer !== 'MERCADO_PAGO')) return { ok: false, error: 'Só pagamento da Point (Mercado Pago) tem estorno registrado aqui.' };
  const staff = useTcheStore.getState().currentUserId;
  if (!staff) return { ok: false, error: 'Entre com o seu usuário antes de registrar o estorno.' };
  const out = await refundPointPayment({ idempotency_key: key, staff_id: staff, manager_pin: managerPin, reason_text: reason }, deps);
  if (out.kind !== 'refunded') return { ok: false, error: out.error };
  const before = useTcheStore.getState();
  const local = before.payments.some((p) => p.idempotency_key === key && p.acquirer === 'MERCADO_PAGO');
  if (!local) {
    // GPT r12 (P1-02): o pagamento é de outro aparelho. A conta vem do servidor (estado oficial: estornado, saldo,
    // conta reaberta), para cobrar de novo ou encerrar como venda devolvida também daqui.
    const synced = await syncOrderFromServer(target.order_id, snapshotDeps);
    if (synced !== 'applied') return { ok: true, data: { nfceIssued: false, itemsStayPaid: false, reopened: false, mirrored: false } };
    const st = useTcheStore.getState();
    const order = st.orders.find((o) => o.id === target.order_id);
    const reopened = Boolean(order && isRefundReopenedOrder(order, st.payments, st.auditLogs));
    return { ok: true, data: { nfceIssued: Boolean(order?.nfce_key), itemsStayPaid: false, reopened, mirrored: true } };
  }
  // Auditoria interna 2 (P1-A): o servidor diz se tem o pagamento; sem ele, o espelho desfaz as consequências daqui.
  // GPT r10 (a verificar 4): o registro do servidor e o gerente que autorizou vão no registro local.
  const mirrored = before.mirrorServerPointRefund(key, reason, {
    ...(out.paymentRegistered === undefined ? {} : { paymentRegistered: out.paymentRegistered }),
    serverAuditId: out.serverAuditId ?? null,
    authorizationAuditId: out.authorizationAuditId ?? null,
    managerId: out.managerId ?? null,
  });
  if (!mirrored.ok) return { ok: false, error: mirrored.error };
  const st = useTcheStore.getState();
  const order = st.orders.find((o) => o.id === target.order_id);
  const itemsStayPaid = order?.status !== 'CLOSED' && st.orderItems.some((i) => i.order_id === target.order_id && i.status !== 'CANCELED' && i.is_paid);
  return { ok: true, data: { nfceIssued: mirrored.data.nfceIssued, itemsStayPaid, reopened: mirrored.data.reopened, mirrored: true } };
}

export function PointRefundButton({ payment, label, onRefunded }: { payment: PointRefundTarget; label: string; onRefunded?: (out: PointRefundOutcome) => void }) {
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
          if (data.reopened) toast.alert(POINT_REFUND_REOPENED);
          if (!data.mirrored) toast.info(POINT_REFUND_REMOTE);
          onRefunded?.(data);
        }}
      />
    </>
  );
}

/** Linha da lista de estorno: do servidor, ou deste aparelho e ainda não enviada. */
interface RefundRow {
  key: string;
  orderId: string;
  amount: number;
  nsu: string | null;
  authorizationCode: string | null;
  createdAt: string;
  status: string;
  refundedAt: string | null;
  /** Só neste aparelho: a inclusão ainda está na fila ou nos recusados. */
  pending: boolean;
  acquirer?: Payment['acquirer'];
}

/** Dia (aaaa-mm-dd, horário de Brasília) → ISO do começo do dia; vazio = sem limite. */
function dayStart(day: string, plusDays = 0): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const d = new Date(`${day}T00:00:00-03:00`);
  return new Date(d.getTime() + plusDays * 86_400_000).toISOString();
}

const when = (iso: string) => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });

function matches(r: RefundRow, q: string): boolean {
  if (!q) return true;
  const text = `${when(r.createdAt)} ${r.nsu ?? ''} ${r.authorizationCode ?? ''} ${formatBRL(r.amount)} ${r.amount.toFixed(2)} ${r.amount.toFixed(2).replace('.', ',')}`.toLowerCase();
  return text.includes(q.toLowerCase());
}

/**
 * Pagamentos da Point para estorno (GPT r10, P1-02): os do servidor, em páginas ("Carregar mais"), com período e busca
 * (NSU, valor, data, operação), sem limite de dias; mais os deste aparelho que ainda não subiram ("ainda não subiu").
 * Sem nuvem: só os deste aparelho.
 */
export function PointRefunds({ payments, listDeps, onRefunded }: { payments: readonly Payment[]; listDeps?: ClaimDeps; onRefunded?: () => void }) {
  const cloud = useTcheStore((s) => s.cloud !== null);
  const outbox = useTcheStore((s) => s.outbox);
  const rejected = useTcheStore((s) => s.syncRejected);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [query, setQuery] = useState('');
  const [applied, setApplied] = useState({ from: '', to: '', query: '' });
  const [server, setServer] = useState<ServerPointPayment[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refundedKeys, setRefundedKeys] = useState<string[]>([]);

  const load = async (next: string | null, filters = applied) => {
    setLoading(true);
    setError(null);
    const out = await listPointPayments({ from: dayStart(filters.from), to: dayStart(filters.to, 1), search: filters.query || null, cursor: next }, listDeps);
    setLoading(false);
    if (out.kind !== 'ok') return setError(out.error);
    setServer((cur) => (next ? [...cur, ...out.items.filter((i) => !cur.some((c) => c.payment_id === i.payment_id))] : out.items));
    setCursor(out.nextCursor);
  };
  useEffect(() => {
    if (cloud) void load(null);
  }, [cloud]); // eslint-disable-line react-hooks/exhaustive-deps

  const search = () => {
    const filters = { from, to, query: query.trim() };
    setApplied(filters);
    if (cloud) void load(null, filters);
  };

  const pendingIds = useMemo(() => new Set([...outbox, ...(rejected ?? []).map((r) => r.event)]
    .filter((e) => e.table === 'payments' && e.op === 'INSERT').map((e) => e.row_id)), [outbox, rejected]);
  const rows = useMemo(() => {
    const fromIso = dayStart(applied.from);
    const toIso = dayStart(applied.to, 1);
    const inPeriod = (iso: string) => (!fromIso || iso >= fromIso) && (!toIso || iso < toIso);
    const serverKeys = new Set(server.map((r) => r.idempotency_key));
    // Deste aparelho: com nuvem, só os que ainda não subiram (o resto vem do servidor); sem nuvem, todos.
    const local: RefundRow[] = payments
      .filter((p) => p.acquirer === 'MERCADO_PAGO' && p.status === 'APPROVED' && p.idempotency_key && !serverKeys.has(p.idempotency_key) && (!cloud || pendingIds.has(p.id)))
      .map((p) => ({ key: p.idempotency_key!, orderId: p.order_id, amount: p.amount, nsu: p.nsu, authorizationCode: p.authorization_code, createdAt: p.created_at, status: 'APPROVED', refundedAt: null, pending: cloud, acquirer: p.acquirer }))
      .filter((r) => inPeriod(new Date(r.createdAt).toISOString()) && matches(r, applied.query));
    const remote: RefundRow[] = server.map((r) => ({ key: r.idempotency_key, orderId: r.order_id, amount: r.amount, nsu: r.nsu, authorizationCode: r.authorization_code, createdAt: r.created_at, status: r.status, refundedAt: r.refunded_at, pending: false }));
    return [...local, ...remote].sort((x, y) => Date.parse(y.createdAt) - Date.parse(x.createdAt));
  }, [payments, server, pendingIds, applied, cloud]);

  if (!cloud && rows.length === 0 && !applied.query && !applied.from && !applied.to) return null;
  return (
    <div className="rounded-2xl border border-slate-200 bg-surface p-4 text-sm">
      <div className="mb-1 font-bold">Pagamentos da Point (Mercado Pago)</div>
      <p className="mb-2 text-xs text-slate-500">{cloud ? 'Lista do servidor, mais os deste aparelho que ainda não subiram.' : 'Lista deste aparelho.'} Estornou uma venda na maquininha ou no app do Mercado Pago? Registre aqui com o PIN do gerente; o servidor confere a cobrança no Mercado Pago.</p>
      <form className="mb-2 grid gap-2 sm:grid-cols-[1fr_auto_auto_auto]" onSubmit={(e) => { e.preventDefault(); search(); }}>
        <div>
          <label htmlFor="point-refund-search" className="mb-1 block text-xs font-semibold text-slate-600">Buscar (NSU, valor, data ou operação)</label>
          <input id="point-refund-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Ex.: 123456 ou 50,00" className="min-h-touch w-full rounded-xl border border-slate-300 bg-base px-3 outline-none focus:border-ouro" />
        </div>
        <div>
          <label htmlFor="point-refund-from" className="mb-1 block text-xs font-semibold text-slate-600">De</label>
          <input id="point-refund-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="min-h-touch rounded-xl border border-slate-300 bg-base px-2" />
        </div>
        <div>
          <label htmlFor="point-refund-to" className="mb-1 block text-xs font-semibold text-slate-600">Até</label>
          <input id="point-refund-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="min-h-touch rounded-xl border border-slate-300 bg-base px-2" />
        </div>
        <Btn type="submit" variant="secondary" className="self-end" disabled={loading}>Buscar</Btn>
      </form>
      {error && <p role="alert" className="mb-2 rounded-lg bg-brasa/10 p-2 text-rose-700">{error}</p>}
      {rows.length === 0 && !loading && !error && <p className="py-2 text-slate-500">Nenhum pagamento da Point com essa busca.</p>}
      {rows.map((r) => {
        const label = `${when(r.createdAt)} · NSU ${r.nsu ?? '?'}`;
        const refunded = r.status === 'REFUNDED' || refundedKeys.includes(r.key);
        return (
          <div key={`${r.pending ? 'l' : 's'}-${r.key}`} className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 py-2">
            <span className="text-slate-600">
              {label} · {formatBRL(r.amount)}
              {r.pending && <span className="ml-2 rounded bg-ouro/20 px-1 text-xs font-bold text-brasa">ainda não subiu</span>}
            </span>
            {refunded
              ? <span className="text-xs font-semibold text-slate-500">estornado{r.refundedAt ? ` em ${when(r.refundedAt)}` : ''}</span>
              : r.status === 'APPROVED' && (
                <PointRefundButton
                  payment={{ idempotency_key: r.key, order_id: r.orderId, amount: r.amount, ...(r.acquirer ? { acquirer: r.acquirer } : {}) }}
                  label={label}
                  onRefunded={() => {
                    setRefundedKeys((k) => [...k, r.key]);
                    onRefunded?.();
                  }}
                />
              )}
          </div>
        );
      })}
      {cloud && cursor && (
        <Btn variant="secondary" block className="mt-2" disabled={loading} onClick={() => void load(cursor)}>{loading ? 'Carregando…' : 'Carregar mais'}</Btn>
      )}
      {loading && !cursor && <p className="py-2 text-xs text-slate-500">Carregando…</p>}
    </div>
  );
}

export const WRITE_OFF_HELP = 'Encerra a conta sem cobrar o saldo estornado: a venda fica registrada como devolvida, com o valor baixado. Só com o PIN do gerente, conferido no servidor.';

/**
 * GPT r12 (P1-03): o id da tentativa de encerramento fica gravado neste aparelho antes do envio. Resposta perdida e o
 * aplicativo reiniciado: a nova tentativa usa o mesmo id e o servidor devolve o mesmo encerramento (sem baixar de novo).
 */
const WRITE_OFF_ATTEMPT = 'tchefood.writeOffAttempt.v1:';
export function writeOffAttemptId(orderId: string): string {
  try {
    const saved = localStorage.getItem(WRITE_OFF_ATTEMPT + orderId);
    if (saved) return saved;
    const id = uuid();
    localStorage.setItem(WRITE_OFF_ATTEMPT + orderId, id);
    return id;
  } catch {
    return uuid();
  }
}
function clearWriteOffAttempt(orderId: string): void {
  try {
    localStorage.removeItem(WRITE_OFF_ATTEMPT + orderId);
  } catch {
    // Sem armazenamento: nada guardado.
  }
}

/** Pede ao servidor o encerramento como venda devolvida; só com a resposta dele a conta fecha aqui. */
export async function submitRefundedWriteOff(orderId: string, managerPin: string, reason: string, deps?: ClaimDeps, clientAuditId: string = writeOffAttemptId(orderId), retried = false): Promise<ActionResult<{ writtenOff: number }>> {
  const staffId = useTcheStore.getState().currentUserId;
  if (!staffId) return { ok: false, error: 'Entre com o seu usuário antes de encerrar a conta.' };
  const out = await closeRefundedOrder({ orderId, staffId, managerPin, reason, clientAuditId }, deps);
  if (out.kind === 'closed') {
    const r = useTcheStore.getState().mirrorRefundedOrderWriteOff(orderId, out, reason);
    if (r.ok) clearWriteOffAttempt(orderId);
    return r;
  }
  if (out.kind === 'pin') return { ok: false, error: out.error };
  // Sem resposta ou recusado (a conta pode já estar encerrada, por esta tentativa ou por outro aparelho): o estado
  // oficial da conta decide. Fechada no servidor: fecha aqui igual, com o registro dele (sem nova baixa).
  const snap = await getOrderSnapshot(orderId, deps);
  if (snap.kind === 'ok' && snap.snapshot.order.status === 'CLOSED') {
    const applied = useTcheStore.getState().applyServerOrderSnapshot(snap.snapshot);
    if (applied.ok && applied.data.kind === 'applied') {
      clearWriteOffAttempt(orderId);
      const how = closedHow(snap.snapshot);
      // GPT r15 P2-02: só é venda devolvida com o registro da baixa no servidor. Conta quitada por pagamento (outro
      // operador recebeu) não é baixa: diz o que aconteceu.
      if (how.kind === 'written_off') return { ok: true, data: { writtenOff: how.cents / 100 } };
      if (how.kind === 'paid') return { ok: false, error: WRITE_OFF_ALREADY_PAID };
      return { ok: false, error: WRITE_OFF_CLOSED_UNKNOWN };
    }
  }
  // O id desta tentativa já fechou esta conta antes (resposta perdida, a conta foi reaberta por outro estorno e o id
  // ficou guardado aqui): o servidor devolve o encerramento antigo e não encerra de novo. O id gasto sai e a
  // tentativa é refeita uma vez com um id novo (o servidor confere tudo de novo, PIN inclusive).
  if (snap.kind === 'ok' && (snap.snapshot.order.status === 'PAYING' || snap.snapshot.order.status === 'OPEN')
    && snap.snapshot.audits.some((a) => a.action_type === 'ORDER_REFUNDED_WRITE_OFF' && (a.metadata as Record<string, unknown> | null)?.client_audit_id === clientAuditId)) {
    clearWriteOffAttempt(orderId);
    if (!retried) return submitRefundedWriteOff(orderId, managerPin, reason, deps, writeOffAttemptId(orderId), true);
  }
  return { ok: false, error: out.error };
}

export const WRITE_OFF_ALREADY_PAID = 'Esta conta já foi quitada por pagamento (recebido em outro aparelho). Nada foi baixado: ela não é venda devolvida. A conta foi atualizada aqui.';
export const WRITE_OFF_CLOSED_UNKNOWN = 'A conta já está fechada no servidor, mas sem o registro desta baixa. Nada foi baixado por esta tentativa; confira a conta na conciliação.';

/**
 * Como a conta fechada no servidor fechou, para a tentativa de encerramento que ficou sem resposta ou foi recusada
 * (GPT r15 P2-02): 'written_off' só com a conta fechada devendo exatamente o total baixado no último registro de baixa
 * do servidor (esta tentativa, com a resposta perdida, ou outro aparelho); 'paid': fechada sem saldo;
 * 'unknown': o resto.
 */
export function closedHow(snapshot: ServerOrderSnapshot): { kind: 'written_off'; cents: number } | { kind: 'paid' } | { kind: 'unknown' } {
  const total = (a: Record<string, unknown>) => {
    const meta = a.metadata as Record<string, unknown> | null | undefined;
    const cents = Number(meta?.cumulative_written_off_cents ?? meta?.written_off_cents);
    return Number.isInteger(cents) && cents > 0 ? cents : null;
  };
  const writeOffs = snapshot.audits.filter((a) => a.action_type === 'ORDER_REFUNDED_WRITE_OFF');
  const remaining = toCents(Number(snapshot.order.remaining_balance));
  const last = writeOffs[writeOffs.length - 1];
  // O servidor devolve os registros em ordem (server_seq): o último é o que fechou a conta.
  if (remaining > 0 && last && total(last) === remaining) return { kind: 'written_off', cents: remaining };
  if (remaining === 0) return { kind: 'paid' };
  return { kind: 'unknown' };
}

export function WriteOffRefundedButton({ orderId, label, onClosed, deps }: { orderId: string; label: string; onClosed?: () => void; deps?: ClaimDeps }) {
  const [open, setOpen] = useState(false);
  const balance = useTcheStore((s) => s.orders.find((o) => o.id === orderId)?.remaining_balance ?? 0);
  return (
    <>
      <Btn variant="secondary" onClick={() => setOpen(true)}>Encerrar como venda devolvida</Btn>
      <ManagerAuthSheet
        open={open}
        onClose={() => setOpen(false)}
        title="Encerrar como venda devolvida"
        summary={<span>{label} · saldo {formatBRL(balance)} · {WRITE_OFF_HELP}</span>}
        confirmLabel="Encerrar"
        minReason={SERVER_REASON_MIN_LENGTH}
        quickReasons={['Venda estornada, cliente não vai pagar', 'Devolução ao cliente']}
        successMessage="Conta encerrada no servidor como venda devolvida."
        onSubmit={async (pin, reason) => {
          const r = await submitRefundedWriteOff(orderId, pin, reason, deps);
          // A conta fechou de outro jeito e sai desta lista (a folha fecha junto): o aviso fica na tela.
          if (!r.ok && (r.error === WRITE_OFF_ALREADY_PAID || r.error === WRITE_OFF_CLOSED_UNKNOWN)) toast.alert(r.error);
          return r;
        }}
        onSuccess={(data) => {
          toast.alert(`Conta encerrada como venda devolvida: ${formatBRL(data.writtenOff)} baixado no total da conta.`);
          onClosed?.();
        }}
      />
    </>
  );
}

/** De quanto em quanto tempo a lista do servidor é lida de novo (GPT r12 P2-01). */
export const SERVER_REFRESH_MS = 60_000;

const hhmm = (d: Date) => d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

/**
 * Contas reabertas pelo estorno da Point, com os próximos passos (GPT r10, P1-01). GPT r12 (P1-02): com nuvem, a lista
 * vem também do servidor (conta reaberta por estorno feito em outro aparelho) e cada conta diferente da daqui é trazida
 * do servidor; conta que só este aparelho ainda vê como reaberta (encerrada em outro aparelho, ou resposta perdida)
 * também é conferida lá. Lida de novo a cada minuto, com a hora da última leitura.
 */
export function RefundReopenedOrders({ onOpenCheckout, deps }: { onOpenCheckout?: (orderId: string) => void; deps?: ClaimDeps }) {
  const cloud = useTcheStore((s) => s.cloud !== null);
  const orders = useTcheStore((s) => s.orders);
  const payments = useTcheStore((s) => s.payments);
  const logs = useTcheStore((s) => s.auditLogs);
  const tables = useTcheStore((s) => s.tables);
  const outbox = useTcheStore((s) => s.outbox);
  const rejected = useTcheStore((s) => s.syncRejected);
  const [server, setServer] = useState<ServerReopenedOrder[] | null>(null);
  const [readAt, setReadAt] = useState<Date | null>(null);
  const [failed, setFailed] = useState(false);
  // GPT r14 P1-01: contas reabertas no servidor que não puderam vir para cá (alteração desta conta na fila ou recusada).
  const [blocked, setBlocked] = useState<Record<string, BlockedReason>>({});
  // Muda quando a fila ou os recusados de uma conta bloqueada mudam: lê o servidor de novo na hora (sem esperar o minuto).
  const blockedKey = useMemo(() => Object.keys(blocked).sort().map((id) => {
    const touches = (e: { row_id: string; payload?: unknown }) => e.row_id === id || (e.payload as Record<string, unknown> | undefined)?.order_id === id;
    return `${id}:${outbox.some(touches) ? 'q' : ''}${(rejected ?? []).some((r) => touches(r.event)) ? 'r' : ''}`;
  }).join(','), [blocked, outbox, rejected]);
  useEffect(() => {
    if (!cloud) return;
    let alive = true;
    const read = async () => {
      // A mesma leitura do laço da nuvem (GPT r15 P1-01): estornos e encerramentos feitos em outro aparelho, e as
      // contas reabertas que ainda devem.
      const out = await pullRefundOrders(deps);
      if (!alive) return;
      if (!out.reopened) return setFailed(true);
      setServer(out.reopened);
      setBlocked(out.blocked);
      setFailed(false);
      setReadAt(new Date());
    };
    void read();
    const t = setInterval(() => void read(), SERVER_REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [cloud, deps, blockedKey]);
  const local = orders.filter((o) => isRefundReopenedOrder(o, payments, logs) && !blocked[o.id]);
  // Reaberta no servidor e ainda não aplicada aqui (mesmo que este aparelho ainda a veja fechada): aparece com os dados
  // do servidor e o motivo, sem ações até convergir (cobrar ou encerrar dependem do estado do servidor aqui).
  const remoteOnly = (server ?? []).filter((r) => blocked[r.order_id] || !orders.some((o) => o.id === r.order_id));
  if (local.length === 0 && remoteOnly.length === 0) return null;
  const why = (id: string) => (blocked[id] === 'rejected'
    ? 'este aparelho tem alteração desta conta recusada pela nuvem: resolva em Nuvem › recusados; depois a conta vem do servidor e as ações aparecem aqui.'
    : blocked[id] === 'pending'
      ? 'este aparelho tem alteração desta conta ainda não enviada: aguarde a sincronização; depois a conta vem do servidor e as ações aparecem aqui.'
      : 'ainda não trazida para este aparelho (leitura da nuvem falhou); tentando de novo a cada minuto.');
  return (
    <div role="alert" className="rounded-2xl border-2 border-ouro bg-ouro/10 p-4 text-sm">
      <div className="mb-1 font-black text-brasa">Contas reabertas pelo estorno</div>
      <p className="mb-2 text-slate-800">A venda foi estornada depois de a conta fechar: o saldo voltou a dever. Cobre de novo ou encerre como venda devolvida.</p>
      {cloud && (readAt || failed) && (
        <p className="mb-2 text-xs text-slate-600">{failed ? 'Não foi possível ler o servidor agora; tentando de novo a cada minuto.' : `Servidor lido às ${hhmm(readAt!)} (de novo a cada minuto).`}</p>
      )}
      {local.map((o) => {
        const label = tables.find((t) => t.id === o.table_id)?.label ?? 'Conta';
        return (
          <div key={o.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-ouro/40 py-2">
            <span><b>{label}</b> · saldo {formatBRL(o.remaining_balance)}</span>
            <span className="flex flex-wrap gap-2">
              {onOpenCheckout && <Btn variant="gold" onClick={() => onOpenCheckout(o.id)}>Cobrar de novo</Btn>}
              <WriteOffRefundedButton orderId={o.id} label={label} deps={deps} />
            </span>
          </div>
        );
      })}
      {remoteOnly.map((r) => {
        const label = tables.find((t) => t.id === r.table_id)?.label ?? 'Conta';
        return (
          <div key={r.order_id} data-testid={`reopened-blocked-${r.order_id}`} className="flex flex-wrap items-center justify-between gap-2 border-t border-ouro/40 py-2">
            <span><b>{label}</b> · saldo {formatBRL(r.remaining_balance)} no servidor · <span className="text-xs">{why(r.order_id)}</span></span>
          </div>
        );
      })}
    </div>
  );
}
