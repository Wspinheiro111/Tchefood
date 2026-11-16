import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
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

/** Texto da recusa de qualquer valor (Error, texto, null, undefined; GPT, rodada 18 do PR #54, P2-02). */
export function rejectionMessage(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === 'string' && e.trim()) return e;
  return 'Não foi possível confirmar. Tente de novo.';
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
  // Trava síncrona: o toque duplo (ou o último dígito e o botão no mesmo instante) chega antes de
  // a tela redesenhar com busy, e mandaria o acerto duas vezes (auditoria interna, rodada 8 do PR #54).
  const busyRef = useRef(false);
  // Cada abertura tem um número: a resposta de uma confirmação de uma abertura anterior não mexe na de agora
  // (GPT, rodada 18 do PR #54, P2-01).
  const openGen = useRef(0);

  useEffect(() => {
    if (open) {
      openGen.current += 1;
      setPin('');
      setReason('');
      setError(null);
      // Confirmação de antes ainda esperando: a trava fica até ela responder (nada sai duas vezes).
      setBusy(busyRef.current);
    }
  }, [open]);

  // Com a confirmação esperando, o modal não fecha (botão, fundo, Esc).
  const close = () => {
    if (busyRef.current) return;
    onClose();
  };

  const reasonOk = reason.trim().length >= minReason;

  const submit = (pinValue = pin) => {
    if (!reasonOk) {
      // O PIN digitado fica: só falta o motivo.
      setError(`Informe o motivo (mínimo ${minReason} caracteres) antes do PIN.`);
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
    const gen = openGen.current;
    if (out instanceof Promise) {
      setBusy(true);
      void out.then(
        (res) => finish(res, gen),
        (e: unknown) => finish({ ok: false, error: rejectionMessage(e) }, gen),
      );
      return;
    }
    finish(out, gen);
  };

  const finish = (res: ActionResult<T>, gen: number) => {
    busyRef.current = false;
    setBusy(false);
    if (gen !== openGen.current) {
      // Resposta de uma abertura anterior: só avisa, sem fechar nem escrever no modal de agora.
      if (res.ok) toast.alert(successMessage ?? '🔔 Registrado em audit_logs e alerta enviado ao WhatsApp do proprietário.');
      else toast.error(res.error);
      return;
    }
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
      onClose={close}
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
