import { useEffect, useState } from 'react';
import { ReceiptText } from 'lucide-react';
import { Btn, Sheet, toast } from './ui';
import { PinPad } from './PinPad';
import { useTcheStore, type PaymentOutcome } from '../store/useTcheStore';
import { ACQUIRER_CNPJ } from '../lib/payments/drivers';
import { clearReviewHold, getReviewHolds, reviewHoldKey } from '../lib/payments/reviewHolds';
import { RECONCILE_MIN_REASON, pointPaymentOnServer, readPointChargeStatus, reconcilePointCharge, type ReconcileDeps } from '../lib/payments/pointReconcile';
import { formatBRL } from '../lib/money';
import { playDeniedBuzz, vibrate } from '../lib/sound';
import { MAX_REASON_LENGTH } from './ManagerAuthSheet';
import { POINT_REFUND_NFCE } from './PointRefund';

export const POINT_NOT_CHARGED = 'O Mercado Pago confirmou que não foi cobrado. Valor liberado.';
/** Estorno provado pelo Mercado Pago (houve cobrança e o dinheiro voltou ao cliente). */
export const POINT_REFUNDED = 'Cobrança estornada no Mercado Pago: o dinheiro voltou ao cliente e nada fica cobrado. Valor liberado.';
/** Cobrança ainda em andamento (no prazo, envio a caminho, aberta na maquininha): não é caso de digitar o ID da operação. */
export const POINT_IN_PROGRESS = 'A cobrança está em andamento, talvez em outro aparelho. Aguarde ela terminar (ou finalize/cancele na maquininha) e confira de novo. Não cobre de novo.';
/** Códigos da conferência para cobrança ainda em andamento (charge.ts: openReply, APPROVED_ELSEWHERE). */
const IN_PROGRESS_CODES: ReadonlySet<string> = new Set(['WAITING_CARD', 'DISPATCH_PENDING', 'MP_PENDING', 'APPROVED_ELSEWHERE']);
/** Conferência recusada (já terminou) e o servidor confirma o fim sem cobrança: a trava sai. */
export const POINT_SERVER_CLOSED = 'O servidor confirma que esta cobrança terminou sem cobrar. Trava liberada.';
/**
 * Aprovada e com o pagamento registrado no servidor por outro aparelho (a conferência respondeu "já resolvida" e a
 * consulta, APPROVED): o servidor tem o pagamento, então a trava sai. Este aparelho não baixa pagamentos da nuvem;
 * uma nova cobrança acima do saldo do servidor é recusada lá.
 */
export const POINT_APPROVED_ELSEWHERE =
  'A cobrança foi aprovada e o pagamento já está registrado no servidor (por outro aparelho). Trava liberada. Não cobre de novo: o saldo desta conta neste aparelho ainda não mostra esse pagamento, e o servidor recusa cobrança acima do saldo dele.';
export const POINT_STILL_OPEN = 'A cobrança ainda está aberta na maquininha. Finalize ou cancele nela e confira de novo.';
export const POINT_REVIEW_PROCEDURE =
  'Confira a cobrança no app do Mercado Pago. Se houver a operação, digite o ID da operação acima e confira de novo. Se não houver, tente de novo mais tarde. Enquanto isso, a conta segue com o valor reservado.';

/** Cobrança da Point em revisão: a trava deste aparelho ou uma cobrança da conta lida da nuvem (outro aparelho). */
export interface PointReviewTarget {
  order_id: string;
  /** Chave da cobrança na Point; sem ela (trava antiga) não há o que conferir. */
  idempotency_key: string | null;
  amount: number;
  method: 'CREDIT' | 'DEBIT' | null;
  terminal_id: string | null;
  item_ids: string[];
}

interface Props {
  open: boolean;
  onClose: () => void;
  label: string;
  charge: PointReviewTarget;
  onSuccess: (outcome: PaymentOutcome) => void;
  onReleased?: () => void;
  /** Só para testes. */
  deps?: ReconcileDeps;
}

const METHOD_LABEL = { CREDIT: 'Crédito', DEBIT: 'Débito' } as const;

/** Tira a trava local só se for desta cobrança. */
function clearHoldOf(orderId: string, key: string) {
  // Só a trava desta cobrança (ou a antiga, sem chave); as outras travas da comanda ficam.
  for (const hold of getReviewHolds(orderId)) {
    if ((hold.idempotency_key === key || !hold.idempotency_key) && hold.acquirer === 'MERCADO_PAGO') clearReviewHold(orderId, reviewHoldKey(hold));
  }
}

/**
 * Cobrança da Point em revisão (docs/integracoes/r6-spec.md C2): o gerente pede a conferência com PIN e
 * motivo; o servidor lê o Mercado Pago e só ele decide. APPROVED registra o pagamento com os dados do
 * servidor (sem cobrar de novo); DECLINED libera o valor; MANUAL_REVIEW continua reservando.
 */
export function PointReviewSheet({ open, onClose, label, charge, onSuccess, onReleased, deps }: Props) {
  const [operationId, setOperationId] = useState('');
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<string | null>(null);
  /** A revisão mostrada é de cobrança em andamento (sem o procedimento do ID da operação). */
  const [reviewInProgress, setReviewInProgress] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setOperationId('');
    setReason('');
    setPin('');
    setError(null);
    setReview(null);
    setReviewInProgress(false);
    setBusy(false);
  }, [open, charge.idempotency_key]);

  const reasonOk = reason.trim().length >= RECONCILE_MIN_REASON;
  const key = charge.idempotency_key;
  const ready = Boolean(key) && reasonOk && !busy;

  const fail = (message: string) => {
    setError(message);
    setPin('');
    playDeniedBuzz();
    vibrate([80, 40, 80]);
  };

  /**
   * Revisão PR #49 (P2): a conferência respondeu que não há o que conferir (a cobrança terminou por uma consulta, outro
   * aparelho resolveu, ou está aprovada com o pagamento registrado). Lê o estado gravado no servidor e só tira a trava
   * com o fim provado lá: recusada/cancelada/expirada (DECLINED, que o servidor só dá com o Mercado Pago ou com a prova
   * de que nada saiu daqui) ou aprovada com o pagamento já registrado NESTE aparelho. Aprovada com o pagamento só no
   * servidor, estornada, em revisão ou aberta: a trava fica, com o motivo. Erro ou resposta de outra chave: fica.
   */
  const settleNotApplicable = async (k: string) => {
    const status = await readPointChargeStatus(k, deps);
    if (status.kind !== 'reply') return fail(status.error);
    const r = status.reply;
    if (r.idempotency_key !== k) return fail('O servidor respondeu sobre outra cobrança. Nada foi registrado e a trava continua; confira com o gerente.');
    if (r.status === 'DECLINED') {
      clearHoldOf(charge.order_id, k);
      toast.success(`${POINT_SERVER_CLOSED} ${r.reason}`);
      onReleased?.();
      onClose();
      return;
    }
    if (r.status === 'APPROVED') {
      if (useTcheStore.getState().payments.some((p) => p.idempotency_key === k && p.status === 'APPROVED')) {
        clearHoldOf(charge.order_id, k);
        toast.info('Este pagamento já está registrado neste aparelho.');
        onClose();
        return;
      }
      if (r.amount_cents !== Math.round(charge.amount * 100) || (charge.method && r.method !== charge.method)) {
        setPin('');
        setReviewInProgress(false);
        setReview(`O Mercado Pago aprovou ${formatBRL(r.amount_cents / 100)} (${METHOD_LABEL[r.method]}), diferente desta cobrança. A trava continua; confira com o gerente.`);
        return;
      }
      clearHoldOf(charge.order_id, k);
      toast.info(POINT_APPROVED_ELSEWHERE);
      onReleased?.();
      onClose();
      return;
    }
    setPin('');
    setReviewInProgress(r.status === 'PENDING' || IN_PROGRESS_CODES.has(r.code));
    setReview(r.status === 'MANUAL_REVIEW' ? r.reason : POINT_STILL_OPEN);
  };

  const submit = async (pinValue = pin) => {
    if (!key) return fail('Esta cobrança não tem a chave da Point gravada. Confira no app do Mercado Pago com o gerente.');
    if (!reasonOk) return fail(`Informe o motivo (mínimo ${RECONCILE_MIN_REASON} caracteres) antes do PIN.`);
    const staff = useTcheStore.getState().currentUserId;
    if (!staff) return fail('Sessão expirada. Entre com o seu PIN.');
    setBusy(true);
    setError(null);
    setReview(null);
    setReviewInProgress(false);
    const out = await reconcilePointCharge({ idempotency_key: key, staff_id: staff, manager_pin: pinValue, reason_text: reason, operation_id: operationId }, deps);
    if (out.kind === 'error' && out.notApplicable) {
      await settleNotApplicable(key);
      setBusy(false);
      return;
    }
    setBusy(false);
    if (out.kind !== 'reply') return fail(out.error);
    const reply = out.reply;
    // Resposta sobre outra cobrança: não registra nem tira a trava (seja qual for o status).
    if (reply.idempotency_key !== key) {
      return fail('O Mercado Pago respondeu sobre outra cobrança. Nada foi registrado e a trava continua; confira com o gerente.');
    }
    if (reply.status === 'MANUAL_REVIEW') {
      setPin('');
      setReviewInProgress(IN_PROGRESS_CODES.has(reply.code));
      setReview(reply.reason);
      return;
    }
    if (reply.status === 'DECLINED') {
      // Auditoria interna 2 (P1-A, variante): estornada no Mercado Pago e com o pagamento aprovado aqui (a inclusão
      // seria recusada para sempre, TF007): o mesmo espelho do estorno registrado.
      const local = out.refunded ? useTcheStore.getState().payments.find((p) => p.idempotency_key === key && p.acquirer === 'MERCADO_PAGO' && p.status === 'APPROVED') : undefined;
      if (local) {
        const m = useTcheStore.getState().mirrorServerPointRefund(key, reason);
        if (!m.ok) return fail(m.error);
        if (m.data.nfceIssued) toast.alert(POINT_REFUND_NFCE);
      }
      clearHoldOf(charge.order_id, key);
      toast.success(out.refunded ? POINT_REFUNDED : POINT_NOT_CHARGED);
      onReleased?.();
      onClose();
      return;
    }
    // APPROVED: confere com a cobrança mostrada antes de registrar (o valor e a forma; a chave já conferida).
    if (reply.amount_cents !== Math.round(charge.amount * 100) || (charge.method && reply.method !== charge.method)) {
      return fail(`O Mercado Pago aprovou ${formatBRL(reply.amount_cents / 100)} (${METHOD_LABEL[reply.method]}), diferente desta cobrança. Nada foi registrado; confira com o gerente.`);
    }
    const st = useTcheStore.getState();
    const already = st.payments.find((p) => p.idempotency_key === key && p.status === 'APPROVED');
    if (already) {
      clearHoldOf(charge.order_id, key);
      toast.info('Este pagamento já está registrado neste aparelho.');
      onClose();
      return;
    }
    // Auditoria interna 3 (P1-02): antes de registrar, o servidor ainda precisa mostrar esta cobrança aprovada SEM
    // pagamento. Já registrada lá (outro aparelho): não registra aqui (seria o segundo pagamento e a segunda NFC-e).
    const onServer = await pointPaymentOnServer(charge.order_id, key, deps);
    if (onServer.kind === 'not_reserving') {
      clearHoldOf(charge.order_id, key);
      toast.info(POINT_APPROVED_ELSEWHERE);
      onReleased?.();
      onClose();
      return;
    }
    if (onServer.kind === 'error') return fail(onServer.error);
    if (onServer.kind === 'other') return fail(`A cobrança mudou no servidor (${onServer.status}). Nada foi registrado e a trava continua; confira de novo.`);
    const terminalId = charge.terminal_id ?? st.terminals.find((t) => t.acquirer === 'MERCADO_PAGO' && t.serial_number === reply.terminal_serial)?.id ?? null;
    const r = st.registerPayment({
      orderId: charge.order_id,
      amount: reply.amount_cents / 100,
      method: reply.method,
      status: 'APPROVED',
      terminal_id: terminalId,
      acquirer: 'MERCADO_PAGO',
      acquirer_cnpj: ACQUIRER_CNPJ.MERCADO_PAGO,
      card_brand: reply.card_brand,
      nsu: reply.nsu,
      authorization_code: reply.authorization_code,
      terminal_serial: reply.terminal_serial,
      idempotency_key: key,
      item_ids: charge.item_ids,
    });
    if (!r.ok) return fail(`O Mercado Pago confirmou a aprovação, mas o registro falhou: ${r.error}`);
    clearHoldOf(charge.order_id, key);
    toast.success(`✅ ${formatBRL(r.data.payment.amount)} confirmado pelo Mercado Pago · NSU ${reply.nsu}`);
    onSuccess(r.data);
    onClose();
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={<span className="flex items-center gap-2 text-brasa"><ReceiptText className="h-6 w-6" /> Cobrança da Point em revisão</span>}
      footer={<Btn block size="lg" variant="success" disabled={!ready || pin.length !== 4} onClick={() => void submit()}>{busy ? 'Conferindo…' : 'Conferir no Mercado Pago'}</Btn>}
    >
      <div className="mb-3 rounded-xl border border-ouro/50 bg-ouro/10 p-3 text-sm">
        <div className="font-bold">{label} · {formatBRL(charge.amount)}{charge.method ? ` · ${METHOD_LABEL[charge.method]}` : ''} · Mercado Pago</div>
        <p className="mt-1 text-slate-700">O servidor confere esta cobrança no Mercado Pago. Se foi aprovada, o pagamento entra sem cobrar de novo; se não foi cobrada, o valor é liberado. O PIN e o motivo só pedem a conferência e ficam registrados.</p>
      </div>

      {review && (
        <div role="alert" className="mb-3 rounded-xl border-2 border-ouro bg-ouro/10 p-3 text-sm">
          <div className="font-bold text-brasa">{reviewInProgress ? 'Em andamento' : 'Continua em revisão'}: {review}</div>
          <p className="mt-1 text-slate-800">{reviewInProgress ? POINT_IN_PROGRESS : POINT_REVIEW_PROCEDURE}</p>
        </div>
      )}

      <label htmlFor="point-operation-id" className="mb-1 block text-sm font-semibold text-slate-700">ID da operação (opcional)</label>
      <input id="point-operation-id" inputMode="numeric" autoComplete="off" value={operationId} onChange={(e) => { setOperationId(e.target.value.replace(/\D/g, '').slice(0, 20)); setError(null); }} placeholder="Do comprovante ou do app do Mercado Pago" className="mb-3 min-h-touch-lg w-full rounded-xl border border-slate-300 bg-base px-3 text-xl font-bold outline-none focus:border-ouro" />

      <label htmlFor="point-review-reason" className="mb-1 block text-sm font-semibold text-slate-700">Motivo</label>
      <textarea id="point-review-reason" value={reason} maxLength={MAX_REASON_LENGTH} onChange={(e) => setReason(e.target.value.slice(0, MAX_REASON_LENGTH))} rows={2} placeholder="Ex.: cliente diz que a Point mostrou aprovado" className="mb-3 w-full rounded-xl border border-slate-300 bg-base p-3 text-base outline-none focus:border-ouro" />

      <p className="mb-2 text-center text-sm font-semibold text-slate-700">PIN do Gerente</p>
      <PinPad value={pin} onChange={(v) => { setPin(v); setError(null); }} onComplete={(v) => ready && void submit(v)} error={Boolean(error)} compact disabled={busy} label="PIN do gerente" />
      {error && <p className="mt-3 rounded-lg bg-brasa/20 p-2 text-center text-sm font-semibold text-rose-700">{error}</p>}
    </Sheet>
  );
}
