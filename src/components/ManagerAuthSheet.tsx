import { useEffect, useState, type ReactNode } from 'react';
import { ShieldAlert } from 'lucide-react';
import { Btn, Sheet, toast } from './ui';
import { PinPad } from './PinPad';
import type { ActionResult } from '../types';
import { MIN_REASON_LENGTH } from '../store/useTcheStore';
import { playDeniedBuzz, vibrate } from '../lib/sound';

const QUICK_REASONS = ['Cliente desistiu', 'Erro de lançamento', 'Item com defeito / reclamação', 'Demora excessiva', 'Cortesia da casa', 'Cliente não aceitou os 10%'];

interface Props<T> {
  open: boolean;
  onClose: () => void;
  title: string;
  summary: ReactNode;
  confirmLabel: string;
  onSubmit: (managerPin: string, reason: string) => ActionResult<T>;
  onSuccess: (data: T) => void;
}

/**
 * Modal de PIN do Gerente + Motivo Obrigatório.
 * A validação real do PIN acontece no store (authorizeManager); aqui só coletamos.
 */
export function ManagerAuthSheet<T>({ open, onClose, title, summary, confirmLabel, onSubmit, onSuccess }: Props<T>) {
  const [pin, setPin] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setPin('');
      setReason('');
      setError(null);
    }
  }, [open]);

  const reasonOk = reason.trim().length >= MIN_REASON_LENGTH;

  const submit = (pinValue = pin) => {
    if (!reasonOk) {
      setError(`Informe o motivo (mínimo ${MIN_REASON_LENGTH} caracteres) antes do PIN.`);
      return;
    }
    const res = onSubmit(pinValue, reason);
    if (!res.ok) {
      setError(res.error);
      setPin('');
      playDeniedBuzz();
      vibrate([80, 40, 80]);
      return;
    }
    toast.alert('🔔 Registrado em audit_logs e alerta enviado ao WhatsApp do proprietário.');
    onSuccess(res.data);
    onClose();
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      tone="danger"
      title={
        <span className="flex items-center gap-2 text-rose-300">
          <ShieldAlert className="h-6 w-6" /> {title}
        </span>
      }
      footer={
        <Btn block size="lg" disabled={pin.length !== 4 || !reasonOk} onClick={() => submit()}>
          {confirmLabel}
        </Btn>
      }
    >
      <div className="mb-3 rounded-xl border border-brasa/50 bg-brasa/10 p-3 text-sm">{summary}</div>

      <label className="mb-1 block text-sm font-semibold text-slate-300">Motivo obrigatório</label>
      <div className="mb-2 flex flex-wrap gap-2">
        {QUICK_REASONS.map((r) => (
          <button
            key={r}
            onClick={() => setReason(r)}
            className={`min-h-touch rounded-full px-3 text-sm font-medium ${reason === r ? 'bg-ouro text-slate-950' : 'bg-slate-700 text-slate-200'}`}
          >
            {r}
          </button>
        ))}
      </div>
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={2}
        placeholder="Descreva o motivo…"
        className="mb-4 w-full rounded-xl border border-slate-600 bg-base p-3 text-base outline-none focus:border-ouro"
      />

      <p className="mb-2 text-center text-sm font-semibold text-slate-300">PIN do Gerente</p>
      <PinPad value={pin} onChange={(v) => { setPin(v); setError(null); }} onComplete={(v) => reasonOk && submit(v)} error={Boolean(error)} compact />
      {error && <p className="mt-3 rounded-lg bg-brasa/20 p-2 text-center text-sm font-semibold text-rose-200">{error}</p>}
    </Sheet>
  );
}
