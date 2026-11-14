import { useEffect, useState } from 'react';
import { ReceiptText } from 'lucide-react';
import { Btn, Sheet, toast } from './ui';
import { PinPad } from './PinPad';
import { MIN_REASON_LENGTH, RECEIPT_CARD_BRANDS, useTcheStore, type PaymentOutcome } from '../store/useTcheStore';
import { PointReviewSheet } from './PointReviewSheet';
import type { ReviewHold } from '../lib/payments/reviewHolds';
import { checkReceiptProof } from '../lib/payments/terminalGuard';
import { formatBRL } from '../lib/money';
import { playDeniedBuzz, vibrate } from '../lib/sound';

type Method = 'CREDIT' | 'DEBIT' | 'PIX';
type Acquirer = 'STONE' | 'PAGBANK';

const METHOD_LABEL: Record<Method, string> = { CREDIT: 'Crédito', DEBIT: 'Débito', PIX: 'Pix' };
const ACQUIRER_LABEL: Record<Acquirer, string> = { STONE: 'Stone', PAGBANK: 'PagBank' };
const DEFAULT_REASON = 'Maquininha aprovou, conferido no comprovante';

/** Maquininha da trava que aceita registro pelo comprovante (Mercado Pago não aceita). */
function receiptAcquirer(a: ReviewHold['acquirer']): Acquirer | null {
  return a === 'STONE' || a === 'PAGBANK' ? a : null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  hold: ReviewHold;
  /** Mesa, ficha ou senha, só para o resumo. */
  label: string;
  onSuccess: (outcome: PaymentOutcome) => void;
  /** Mercado Pago confirmou que não cobrou: a trava local saiu. */
  onReleased?: () => void;
}

/**
 * Cobrança incerta que a maquininha mostra APROVADA: o gerente digita o NSU e a
 * autorização do comprovante (nada é gerado nem preenchido sozinho), aprova com
 * o PIN e o pagamento entra sem nova cobrança. Fica em audit_logs.
 */
export function ConfirmReviewedChargeSheet({ open, onClose, hold, label, onSuccess, onReleased }: Props) {
  const [nsu, setNsu] = useState('');
  const [authCode, setAuthCode] = useState('');
  const [brand, setBrand] = useState<string | null>(null);
  const [method, setMethod] = useState<Method | null>(hold.method ?? null);
  const [acquirer, setAcquirer] = useState<Acquirer | null>(receiptAcquirer(hold.acquirer));
  const [reason, setReason] = useState(DEFAULT_REASON);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setNsu('');
    setAuthCode('');
    setBrand(null);
    setMethod(hold.method ?? null);
    setAcquirer(receiptAcquirer(hold.acquirer));
    setReason(DEFAULT_REASON);
    setPin('');
    setError(null);
  }, [open, hold]);

  const proof = checkReceiptProof({ nsu, authorization_code: authCode });
  const reasonOk = reason.trim().length >= MIN_REASON_LENGTH;
  const ready = proof.ok && reasonOk && method !== null && acquirer !== null;

  const submit = (pinValue = pin) => {
    if (!proof.ok) return setError(proof.error);
    if (!method || !acquirer) return setError('Informe a forma de pagamento e a maquininha do comprovante.');
    if (!reasonOk) return setError(`Informe o motivo (mínimo ${MIN_REASON_LENGTH} caracteres).`);
    const res = useTcheStore.getState().confirmReviewedCharge(
      { orderId: hold.order_id, nsu, authorization_code: authCode, card_brand: method === 'PIX' ? null : brand, method, acquirer },
      { managerPin: pinValue, reason },
    );
    if (!res.ok) {
      setError(res.error);
      setPin('');
      playDeniedBuzz();
      vibrate([80, 40, 80]);
      return;
    }
    toast.success(`✅ ${formatBRL(res.data.payment.amount)} registrado pelo comprovante · NSU ${res.data.payment.nsu}`);
    toast.alert('🔔 Registrado em audit_logs e alerta enviado ao WhatsApp do proprietário.');
    onSuccess(res.data);
    onClose();
  };

  const field = 'min-h-touch-lg w-full rounded-xl border border-slate-300 bg-base px-3 text-2xl font-black tracking-widest outline-none focus:border-ouro';
  if (hold.acquirer === 'MERCADO_PAGO') {
    return (
      <PointReviewSheet
        open={open}
        onClose={onClose}
        label={label}
        charge={{
          order_id: hold.order_id,
          idempotency_key: hold.idempotency_key ?? null,
          amount: hold.amount,
          method: hold.method === 'CREDIT' || hold.method === 'DEBIT' ? hold.method : null,
          terminal_id: hold.terminal_id ?? null,
          item_ids: hold.item_ids ?? [],
        }}
        onSuccess={onSuccess}
        onReleased={onReleased}
      />
    );
  }

  const chip = (on: boolean) => `min-h-touch rounded-xl px-3 text-sm font-bold ${on ? 'bg-ouro text-slate-950' : 'bg-slate-200 text-slate-800'}`;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={<span className="flex items-center gap-2 text-brasa"><ReceiptText className="h-6 w-6" /> Registrar cobrança aprovada</span>}
      footer={<Btn block size="lg" variant="success" disabled={!ready || pin.length !== 4} onClick={() => submit()}>Registrar {formatBRL(hold.amount)} sem cobrar de novo</Btn>}
    >
      <div className="mb-3 rounded-xl border border-ouro/50 bg-ouro/10 p-3 text-sm">
        <div className="font-bold">{label} · {formatBRL(hold.amount)}{hold.method ? ` · ${METHOD_LABEL[hold.method]}` : ''}{hold.acquirer ? ` · ${ACQUIRER_LABEL[hold.acquirer]}` : ''}</div>
        <p className="mt-1 text-slate-700">Use só se o comprovante da maquininha mostra esta cobrança APROVADA. Digite o NSU e a autorização exatamente como estão no papel. O cliente não é cobrado de novo.</p>
      </div>

      {!hold.method && (
        <div className="mb-3">
          <p className="mb-1 text-sm font-semibold text-slate-700">Forma no comprovante</p>
          <div className="flex flex-wrap gap-2">{(Object.keys(METHOD_LABEL) as Method[]).map((m) => <button key={m} onClick={() => setMethod(m)} className={chip(method === m)}>{METHOD_LABEL[m]}</button>)}</div>
        </div>
      )}
      {!hold.acquirer && (
        <div className="mb-3">
          <p className="mb-1 text-sm font-semibold text-slate-700">Maquininha</p>
          <div className="flex flex-wrap gap-2">{(Object.keys(ACQUIRER_LABEL) as Acquirer[]).map((a) => <button key={a} onClick={() => setAcquirer(a)} className={chip(acquirer === a)}>{ACQUIRER_LABEL[a]}</button>)}</div>
        </div>
      )}

      <label className="mb-1 block text-sm font-semibold text-slate-700">NSU do comprovante</label>
      <input inputMode="numeric" autoComplete="off" value={nsu} onChange={(e) => { setNsu(e.target.value.replace(/\D/g, '').slice(0, 12)); setError(null); }} placeholder="Só números" className={`${field} mb-3`} />
      <label className="mb-1 block text-sm font-semibold text-slate-700">Código de autorização (AUT / cAut)</label>
      <input autoComplete="off" autoCapitalize="characters" value={authCode} onChange={(e) => { setAuthCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12)); setError(null); }} placeholder="Letras e números" className={`${field} mb-3`} />

      {method !== 'PIX' && (
        <div className="mb-3">
          <p className="mb-1 text-sm font-semibold text-slate-700">Bandeira (opcional)</p>
          <div className="flex flex-wrap gap-2">
            {RECEIPT_CARD_BRANDS.map((b) => <button key={b} onClick={() => setBrand(brand === b ? null : b)} className={chip(brand === b)}>{b}</button>)}
          </div>
        </div>
      )}

      <label className="mb-1 block text-sm font-semibold text-slate-700">Motivo</label>
      <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} className="mb-3 w-full rounded-xl border border-slate-300 bg-base p-3 text-base outline-none focus:border-ouro" />

      <p className="mb-2 text-center text-sm font-semibold text-slate-700">PIN do Gerente</p>
      <PinPad value={pin} onChange={(v) => { setPin(v); setError(null); }} onComplete={(v) => ready && submit(v)} error={Boolean(error)} compact />
      {error && <p className="mt-3 rounded-lg bg-brasa/20 p-2 text-center text-sm font-semibold text-rose-700">{error}</p>}
    </Sheet>
  );
}
