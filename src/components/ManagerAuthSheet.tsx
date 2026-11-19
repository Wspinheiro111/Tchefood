import { useEffect, useId, useState, type ReactNode } from 'react';
import { ShieldAlert } from 'lucide-react';
import { Btn, Sheet, toast } from './ui';
import { PinPad } from './PinPad';
import type { ActionResult } from '../types';
import { MIN_REASON_LENGTH } from '../store/useTcheStore';
import { playDeniedBuzz, vibrate } from '../lib/sound';

/** Motivo mínimo que o servidor exige no estorno da Point e na reserva estornada (point-charge, schema_point_reserva). */
export const SERVER_REASON_MIN_LENGTH = 10;
/** Motivo máximo que o servidor aceita (point-charge e as funções de reserva: 500; acima disso, recusa). */
export const MAX_REASON_LENGTH = 500;

const QUICK_REASONS = ['Cliente desistiu', 'Erro de lançamento', 'Item com defeito / reclamação', 'Demora excessiva', 'Cortesia da casa', 'Cliente não aceitou os 10%'];

interface Props<T> {
  open: boolean;
  onClose: () => void;
  title: string;
  summary: ReactNode;
  confirmLabel: string;
  /** Pode ser assíncrono (conferência no servidor): enquanto espera, o botão fica bloqueado. */
  onSubmit: (managerPin: string, reason: string) => ActionResult<T> | Promise<ActionResult<T>>;
  onSuccess: (data: T) => void;
  /** Mensagem depois de autorizado (padrão: alerta anti-fraude enviado ao proprietário). */
  successMessage?: string;
  /** Motivos rápidos da tela (padrão: os do salão). */
  quickReasons?: string[];
  /**
   * Mínimo de caracteres do motivo (padrão MIN_REASON_LENGTH). Auditoria interna 2 (P2-4): quem chama uma função que
   * exige mais (estorno da Point, reserva estornada: 10) passa o mesmo número, e o botão só liga com ele.
   */
  minReason?: number;
}

/**
 * Modal de PIN do Gerente + Motivo Obrigatório.
 * A validação real do PIN acontece no store (authorizeManager); aqui só coletamos.
 */
export function ManagerAuthSheet<T>({ open, onClose, title, summary, confirmLabel, onSubmit, onSuccess, successMessage, quickReasons = QUICK_REASONS, minReason = MIN_REASON_LENGTH }: Props<T>) {
  const reasonId = useId();
  const [pin, setPin] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setPin('');
      setReason('');
      setError(null);
    }
  }, [open]);

  const reasonOk = reason.trim().length >= minReason;

  const submit = (pinValue = pin) => {
    if (!reasonOk) {
      // O PIN digitado fica: só falta o motivo.
      setError(`Informe o motivo (mínimo ${minReason} caracteres) antes do PIN.`);
      return;
    }
    if (busy) return;
    const out = onSubmit(pinValue, reason);
    if (out instanceof Promise) {
      setBusy(true);
      void out
        .catch((e: unknown): ActionResult<T> => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
        .then((res) => {
          setBusy(false);
          finish(res);
        });
      return;
    }
    finish(out);
  };

  const finish = (res: ActionResult<T>) => {
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

      <label htmlFor={reasonId} className="mb-1 block text-sm font-semibold text-slate-700">Motivo obrigatório</label>
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
        id={reasonId}
        value={reason}
        maxLength={MAX_REASON_LENGTH}
        onChange={(e) => setReason(e.target.value.slice(0, MAX_REASON_LENGTH))}
        rows={2}
        placeholder="Descreva o motivo…"
        className="mb-4 w-full rounded-xl border border-slate-300 bg-base p-3 text-[1rem] text-slate-900 outline-none focus:border-ouro"
      />

      <p className="mb-2 text-center text-sm font-semibold text-slate-700">PIN do Gerente</p>
      <PinPad value={pin} onChange={(v) => { setPin(v); setError(null); }} onComplete={(v) => submit(v)} error={Boolean(error)} compact label="PIN do gerente" />
      {error && <p className="mt-3 rounded-lg bg-brasa/20 p-2 text-center text-sm font-semibold text-rose-700">{error}</p>}
    </Sheet>
  );
}
