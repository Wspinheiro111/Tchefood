import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ShieldAlert } from 'lucide-react';
import { Btn, Sheet, toast } from './ui';
import { PinPad } from './PinPad';
import { useTcheStore } from '../store/useTcheStore';
import { formatBRL } from '../lib/money';
import { playDeniedBuzz, vibrate } from '../lib/sound';
import { MANAGER_RELEASE_MIN_REASON, releasePaymentClaimManager, requirePaymentClaim } from '../lib/payments/paymentClaim';
import { isClaimActiveHere, localClaim, pendingRelease } from '../lib/payments/claimLedger';
import { fetchPointReservation, type CloudPaymentClaim } from '../lib/sync/cloudPull';
import { freshCloudConfig } from '../lib/sync/useCloudSync';
import { clearReviewHold, type ReviewHold } from '../lib/payments/reviewHolds';
import { ManagerAuthSheet } from './ManagerAuthSheet';

/** Hora no horário de Brasília (o servidor também fala nesse horário). */
export function brasiliaTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
}

/** Travas criadas pela reserva com a maquininha aprovada: bloqueiam qualquer forma de pagamento, inclusive dinheiro. */
const CLAIM_HOLD_CODES = new Set(['CLAIM_RELEASED', 'CLAIM_UNCONFIRMED', 'ACQUIRER_MISMATCH']);
export function holdBlocksCash(hold: ReviewHold | null): boolean {
  return hold !== null && CLAIM_HOLD_CODES.has(hold.code);
}

export const HOLD_BLOCKS_ALL = 'A maquininha aprovou uma cobrança desta conta que não pôde ser registrada: resolva a trava antes de receber de novo, em qualquer forma de pagamento.';

export const REFUND_INSTRUCTION =
  'A maquininha aprovou, mas a reserva deste pagamento foi liberada no servidor: o pagamento não pode ser registrado. Estorne (cancele a venda) na maquininha e, depois, o gerente confirma aqui.';

/** Trava CLAIM_RELEASED: em vez de "registrar comprovante", a instrução de estorno e "Estornei na maquininha" (PIN de gerente). */
export function RefundedAtTerminalButton({ hold, label, onCleared, size = 'lg' }: { hold: ReviewHold; label: string; onCleared: () => void; size?: 'md' | 'lg' }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <p className="mb-2 rounded-xl bg-brasa/10 p-2 font-semibold text-brasa">{REFUND_INSTRUCTION}</p>
      <Btn variant="secondary" size={size} block onClick={() => setOpen(true)}>Estornei na maquininha</Btn>
      <ManagerAuthSheet
        open={open}
        onClose={() => setOpen(false)}
        title="Estornei na maquininha"
        summary={<span>{label} · {formatBRL(hold.amount)} · confirme que a venda foi estornada (cancelada) na maquininha.</span>}
        confirmLabel="Confirmar estorno"
        quickReasons={['Venda estornada na maquininha', 'Cancelado na maquininha, cliente reembolsado']}
        onSubmit={(pin, reason) => useTcheStore.getState().resolveRefundedClaimHold(hold.order_id, { managerPin: pin, reason })}
        onSuccess={() => onCleared()}
        successMessage="Estorno registrado (audit_logs deste aparelho)."
      />
    </>
  );
}

export const RELEASE_CLAIM_WARNING =
  'Use só se o pagamento NÃO aconteceu: nenhum dinheiro foi recebido e a maquininha não mostra aprovação. Liberar devolve o valor ao saldo livre da conta.';

const ACQUIRER_LABEL: Record<string, string> = { CASH_DESK: 'Dinheiro', STONE: 'Stone', PAGBANK: 'PagBank' };
const METHOD_LABEL: Record<string, string> = { CASH: 'Dinheiro', CREDIT: 'Crédito', DEBIT: 'Débito', PIX: 'Pix' };

interface ReleaseProps {
  open: boolean;
  onClose: () => void;
  claimKey: string;
  title?: string;
  summary: ReactNode;
  onReleased: () => void;
}

/** PIN de gerente + motivo (10+) para liberar uma reserva no servidor (tchefood_release_payment_claim_manager). */
export function ReleaseClaimSheet({ open, onClose, claimKey, title = 'Liberar reserva', summary, onReleased }: ReleaseProps) {
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setReason('');
    setPin('');
    setError(null);
    setBusy(false);
  }, [open, claimKey]);

  const reasonOk = reason.trim().length >= MANAGER_RELEASE_MIN_REASON;

  const submit = async (pinValue = pin) => {
    if (!reasonOk) {
      setError(`Informe o motivo (mínimo ${MANAGER_RELEASE_MIN_REASON} caracteres) antes do PIN.`);
      setPin('');
      return;
    }
    setBusy(true);
    setError(null);
    const out = await releasePaymentClaimManager(claimKey, pinValue, reason);
    setBusy(false);
    if (!out.ok) {
      setError(out.error);
      setPin('');
      playDeniedBuzz();
      vibrate([80, 40, 80]);
      return;
    }
    toast.success('Reserva liberada no servidor. Registrado em audit_logs.');
    onReleased();
    onClose();
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      tone="danger"
      title={<span className="flex items-center gap-2 text-rose-600"><ShieldAlert className="h-6 w-6" /> {title}</span>}
      footer={<Btn block size="lg" disabled={busy || !reasonOk || pin.length !== 4} onClick={() => void submit()}>{busy ? 'Liberando…' : 'Liberar reserva'}</Btn>}
    >
      <div className="mb-3 rounded-xl border border-brasa/50 bg-brasa/10 p-3 text-sm">
        <div className="font-bold">{summary}</div>
        <p className="mt-1 text-slate-800">{RELEASE_CLAIM_WARNING}</p>
      </div>
      <label htmlFor="release-claim-reason" className="mb-1 block text-sm font-semibold text-slate-700">Motivo</label>
      <textarea id="release-claim-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="Ex.: maquininha recusou, cliente pagou de outro jeito" className="mb-3 w-full rounded-xl border border-slate-300 bg-base p-3 text-base outline-none focus:border-ouro" />
      <p className="mb-2 text-center text-sm font-semibold text-slate-700">PIN do Gerente</p>
      <PinPad value={pin} onChange={(v) => { setPin(v); setError(null); }} onComplete={(v) => reasonOk && !busy && void submit(v)} error={Boolean(error)} compact disabled={busy} />
      {error && <p className="mt-3 rounded-lg bg-brasa/20 p-2 text-center text-sm font-semibold text-rose-700">{error}</p>}
    </Sheet>
  );
}

/**
 * Reservas abertas da conta que nada neste aparelho está usando agora: a cobrança não está rodando aqui, não há
 * pagamento registrado aqui com a chave e não é a trava de conferência desta tela.
 */
export function stuckClaims(claims: readonly CloudPaymentClaim[], paidKeys: ReadonlySet<string>, excludeKeys: ReadonlyArray<string | null | undefined> = []): CloudPaymentClaim[] {
  return claims.filter((c) => !isClaimActiveHere(c.idempotencyKey) && !paidKeys.has(c.idempotencyKey) && !excludeKeys.includes(c.idempotencyKey));
}

interface PanelProps {
  claims: readonly CloudPaymentClaim[];
  excludeKeys?: ReadonlyArray<string | null | undefined>;
  label: string;
  /** Depois de liberar (a tela relê a reserva). */
  onReleased?: () => void;
}

/** Lista de reservas presas com "Liberar reserva" (PIN de gerente). */
export function StuckClaimsPanel({ claims, excludeKeys = [], label, onReleased }: PanelProps) {
  const payments = useTcheStore((s) => s.payments);
  const [target, setTarget] = useState<CloudPaymentClaim | null>(null);
  const [released, setReleased] = useState<string[]>([]);
  // Só pagamento APROVADO aqui consome a reserva (r6 P2-01): recusado ou outro estado não esconde nada.
  const paid = new Set(payments.filter((p) => p.status === 'APPROVED').map((p) => p.idempotency_key).filter((k): k is string => typeof k === 'string'));
  const now = Date.now();
  const list = stuckClaims(claims, paid, [...excludeKeys, ...released]);
  if (list.length === 0) return null;
  return (
    <div role="alert" className="mb-3 rounded-2xl border-2 border-ouro bg-ouro/10 p-4 text-sm">
      <div className="mb-1 font-black text-brasa">Reserva de pagamento aberta nesta conta</div>
      <p className="mb-2 text-slate-800">Um pagamento foi reservado no servidor e não terminou. Enquanto estiver aberto, o valor não pode ser recebido de novo.</p>
      <ul className="grid gap-2">
        {list.map((c) => {
          const mine = localClaim(c.idempotencyKey);
          const pending = pendingRelease(c.idempotencyKey);
          // Cobrança ainda rodando em outro aparelho (prazo renovado + 5 min): o servidor recusa liberar (TF011).
          const until = c.releasableAt ? Date.parse(c.releasableAt) : NaN;
          const running = Number.isFinite(until) && until > now;
          return (
            <li key={c.idempotencyKey} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-surface p-2">
              <span>
                <b>{formatBRL(c.amountCents / 100)}</b> · {METHOD_LABEL[c.method] ?? c.method}{c.acquirer && c.acquirer !== 'CASH_DESK' ? ` · ${ACQUIRER_LABEL[c.acquirer] ?? c.acquirer}` : ''}
                {c.createdByName ? ` · ${c.createdByName}` : ''}
                {c.createdAt ? ` · ${new Date(c.createdAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` : ''}
                {mine && mine.state !== 'settled' && <span className="block text-xs text-slate-600">Este aparelho reservou e não viu a cobrança terminar: confira a maquininha antes de liberar.</span>}
                {pending && (
                  <span className="block text-xs text-slate-600">
                    {!pending.release_token
                      ? 'Nada foi cobrado, mas este aparelho não tem o código desta reserva: só o gerente libera.'
                      : pending.final
                        ? `Nada foi cobrado, mas o servidor não aceitou a liberação automática${pending.last_error ? ` (${pending.last_error})` : ''}: só o gerente libera.`
                        : `Nada foi cobrado, mas a liberação automática ainda não chegou ao servidor${pending.last_error ? ` (${pending.last_error})` : ''}.`}
                  </span>
                )}
                {running && <span className="block text-xs font-semibold text-brasa">{mine ? 'Em andamento' : 'Em andamento (outro aparelho)'} — liberável às {brasiliaTime(until)} (horário de Brasília)</span>}
              </span>
              <Btn variant="secondary" disabled={running} onClick={() => setTarget(c)}>Liberar reserva</Btn>
            </li>
          );
        })}
      </ul>
      {target && (
        <ReleaseClaimSheet
          open
          onClose={() => setTarget(null)}
          claimKey={target.idempotencyKey}
          summary={<span>{label} · {formatBRL(target.amountCents / 100)} · {METHOD_LABEL[target.method] ?? target.method}</span>}
          onReleased={() => {
            setReleased((r) => [...r, target.idempotencyKey]);
            onReleased?.();
          }}
        />
      )}
    </div>
  );
}

const POLL_MS = 5000;

/** Reservas abertas da conta lidas da nuvem (para telas sem a leitura da reserva da Point). */
export function useOrderClaims(orderId: string): { claims: CloudPaymentClaim[]; refresh: () => void } {
  const needsClaim = useTcheStore((s) => requirePaymentClaim(s));
  const [claims, setClaims] = useState<CloudPaymentClaim[]>([]);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    if (!needsClaim) {
      setClaims([]);
      return;
    }
    let alive = true;
    const read = async () => {
      try {
        const cfg = await freshCloudConfig();
        if (!cfg) return;
        const r = await fetchPointReservation(cfg, (url, init) => fetch(url, init), orderId);
        if (alive) setClaims(r.claims ?? []);
      } catch {
        // Sem leitura: fica a última lista (o servidor ainda recusa o que passar da reserva).
      }
    };
    void read();
    const timer = setInterval(() => void read(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [orderId, needsClaim, tick]);
  return { claims, refresh };
}

interface HoldButtonProps {
  hold: ReviewHold;
  label: string;
  onCleared: () => void;
  size?: 'md' | 'lg';
}

/**
 * "Conferi no extrato: não foi cobrado" da trava de Stone/PagBank. Loja com Point: a reserva dessa chave no
 * servidor sai junto, pelo gerente (é ele quem atesta); a trava local só sai se a liberação deu certo (ou se
 * não havia reserva). Loja sem Point: tira a trava como sempre.
 */
export function HoldNotChargedButton({ hold, label, onCleared, size = 'lg' }: HoldButtonProps) {
  const needsClaim = useTcheStore((s) => requirePaymentClaim(s));
  const [open, setOpen] = useState(false);
  const clear = () => {
    clearReviewHold(hold.order_id);
    onCleared();
  };
  const key = hold.idempotency_key;
  return (
    <>
      <Btn variant="secondary" size={size} block onClick={() => (needsClaim && key ? setOpen(true) : clear())}>Conferi no extrato: não foi cobrado</Btn>
      {needsClaim && key && (
        <ReleaseClaimSheet
          open={open}
          onClose={() => setOpen(false)}
          claimKey={key}
          title="Não foi cobrado: liberar a reserva"
          summary={<span>{label} · {formatBRL(hold.amount)}</span>}
          onReleased={clear}
        />
      )}
    </>
  );
}
