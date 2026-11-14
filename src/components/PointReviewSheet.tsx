import { useEffect, useState } from 'react';
import { ReceiptText } from 'lucide-react';
import { Btn, Sheet, toast } from './ui';
import { PinPad } from './PinPad';
import { useTcheStore, type PaymentOutcome } from '../store/useTcheStore';
import { ACQUIRER_CNPJ } from '../lib/payments/drivers';
import { clearReviewHold, getReviewHold } from '../lib/payments/reviewHolds';
import { RECONCILE_MIN_REASON, reconcilePointCharge, type ReconcileDeps } from '../lib/payments/pointReconcile';
import { formatBRL } from '../lib/money';
import { playDeniedBuzz, vibrate } from '../lib/sound';

export const POINT_NOT_CHARGED = 'O Mercado Pago confirmou que não foi cobrado. Valor liberado.';
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
  const hold = getReviewHold(orderId);
  if (hold && (hold.idempotency_key === key || !hold.idempotency_key) && hold.acquirer === 'MERCADO_PAGO') clearReviewHold(orderId);
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
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setOperationId('');
    setReason('');
    setPin('');
    setError(null);
    setReview(null);
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

  const submit = async (pinValue = pin) => {
    if (!key) return fail('Esta cobrança não tem a chave da Point gravada. Confira no app do Mercado Pago com o gerente.');
    if (!reasonOk) return fail(`Informe o motivo (mínimo ${RECONCILE_MIN_REASON} caracteres) antes do PIN.`);
    const staff = useTcheStore.getState().currentUserId;
    if (!staff) return fail('Sessão expirada. Entre com o seu PIN.');
    setBusy(true);
    setError(null);
    setReview(null);
    const out = await reconcilePointCharge({ idempotency_key: key, staff_id: staff, manager_pin: pinValue, reason_text: reason, operation_id: operationId }, deps);
    setBusy(false);
    if (out.kind !== 'reply') return fail(out.error);
    const reply = out.reply;
    if (reply.status === 'MANUAL_REVIEW') {
      setPin('');
      setReview(reply.reason);
      return;
    }
    if (reply.status === 'DECLINED') {
      clearHoldOf(charge.order_id, key);
      toast.success(POINT_NOT_CHARGED);
      onReleased?.();
      onClose();
      return;
    }
    // APPROVED: confere com a cobrança mostrada antes de registrar.
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
          <div className="font-bold text-brasa">Continua em revisão: {review}</div>
          <p className="mt-1 text-slate-800">{POINT_REVIEW_PROCEDURE}</p>
        </div>
      )}

      <label htmlFor="point-operation-id" className="mb-1 block text-sm font-semibold text-slate-700">ID da operação (opcional)</label>
      <input id="point-operation-id" inputMode="numeric" autoComplete="off" value={operationId} onChange={(e) => { setOperationId(e.target.value.replace(/\D/g, '').slice(0, 20)); setError(null); }} placeholder="Do comprovante ou do app do Mercado Pago" className="mb-3 min-h-touch-lg w-full rounded-xl border border-slate-300 bg-base px-3 text-xl font-bold outline-none focus:border-ouro" />

      <label htmlFor="point-review-reason" className="mb-1 block text-sm font-semibold text-slate-700">Motivo</label>
      <textarea id="point-review-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="Ex.: cliente diz que a Point mostrou aprovado" className="mb-3 w-full rounded-xl border border-slate-300 bg-base p-3 text-base outline-none focus:border-ouro" />

      <p className="mb-2 text-center text-sm font-semibold text-slate-700">PIN do Gerente</p>
      <PinPad value={pin} onChange={(v) => { setPin(v); setError(null); }} onComplete={(v) => ready && void submit(v)} error={Boolean(error)} compact disabled={busy} />
      {error && <p className="mt-3 rounded-lg bg-brasa/20 p-2 text-center text-sm font-semibold text-rose-700">{error}</p>}
    </Sheet>
  );
}
