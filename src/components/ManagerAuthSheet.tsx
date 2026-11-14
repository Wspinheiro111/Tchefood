import { useEffect, useRef, useState, type ReactNode } from 'react';
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
  /** Pode ser assíncrono (ex.: acerto do entregador confirmado pela nuvem): o botão espera a resposta. */
  onSubmit: (managerPin: string, reason: string) => ActionResult<T> | Promise<ActionResult<T>>;
  onSuccess: (data: T) => void;
  /** Mensagem depois de autorizado (padrão: alerta anti-fraude enviado ao proprietário). */
  successMessage?: string;
  /** Motivos rápidos da tela (padrão: os do salão). */
  quickReasons?: string[];
}

/**
 * Modal de PIN do Gerente + Motivo Obrigatório.
 * A validação real do PIN acontece no store (authorizeManager); aqui só coletamos.
 */
export function ManagerAuthSheet<T>({ open, onClose, title, summary, confirmLabel, onSubmit, onSuccess, successMessage, quickReasons = QUICK_REASONS }: Props<T>) {
  const [pin, setPin] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Trava síncrona: o toque duplo (ou o último dígito e o botão no mesmo instante) chega antes de
  // a tela redesenhar com busy, e mandaria o acerto duas vezes (auditoria interna, rodada 8 do PR #54).
  const busyRef = useRef(false);

  useEffect(() => {
    if (open) {
      setPin('');
      setReason('');
      setError(null);
      setBusy(false);
      busyRef.current = false;
    }
  }, [open]);

  const reasonOk = reason.trim().length >= MIN_REASON_LENGTH;

  const submit = (pinValue = pin) => {
    if (!reasonOk) {
      setError(`Informe o motivo (mínimo ${MIN_REASON_LENGTH} caracteres) antes do PIN.`);
      return;
    }
    // Conferido antes de chamar onSubmit: com a confirmação ainda esperando, nada sai de novo.
    if (busyRef.current) return;
    busyRef.current = true;
    let out: ActionResult<T> | Promise<ActionResult<T>>;
    try {
      out = onSubmit(pinValue, reason);
    } catch (e) {
      busyRef.current = false;
      throw e;
    }
    if (out instanceof Promise) {
      setBusy(true);
      void out.then(finish, (e: unknown) => finish({ ok: false, error: (e as Error).message }));
      return;
    }
    finish(out);
  };

  const finish = (res: ActionResult<T>) => {
    busyRef.current = false;
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      setPin('');
      playDeniedBuzz();
      vibrate([80, 40, 80]);
      return;
    }
    toast.alert(successMessage ?? '🔔 Registrado em audit_logs e alerta enviado ao WhatsApp do proprietário.');
    onSuccess(res.data);
    onClose();
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      tone="danger"
      title={
        <span className="flex items-center gap-2 text-rose-600">
          <ShieldAlert className="h-6 w-6" /> {title}
        </span>
      }
      footer={
        <Btn block size="lg" disabled={busy || pin.length !== 4 || !reasonOk} onClick={() => submit()}>
          {confirmLabel}
        </Btn>
      }
    >
      <div className="mb-3 rounded-xl border border-brasa/50 bg-brasa/10 p-3 text-sm">{summary}</div>

      <label className="mb-1 block text-sm font-semibold text-slate-700">Motivo obrigatório</label>
      <div className="mb-2 flex flex-wrap gap-2">
        {quickReasons.map((r) => (
          <button
            key={r}
            onClick={() => setReason(r)}
            className={`min-h-touch rounded-full px-3 text-sm font-medium ${reason === r ? 'bg-ouro text-slate-950' : 'bg-slate-200 text-slate-800'}`}
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
        className="mb-4 w-full rounded-xl border border-slate-300 bg-base p-3 text-[1rem] text-slate-900 outline-none focus:border-ouro"
      />

      <p className="mb-2 text-center text-sm font-semibold text-slate-700">PIN do Gerente</p>
      <PinPad value={pin} onChange={(v) => { setPin(v); setError(null); }} onComplete={(v) => reasonOk && !busy && submit(v)} error={Boolean(error)} compact />
      {error && <p className="mt-3 rounded-lg bg-brasa/20 p-2 text-center text-sm font-semibold text-rose-700">{error}</p>}
    </Sheet>
  );
}
