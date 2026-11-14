import { useMemo, useState } from 'react';
import { Btn, toast } from './ui';
import { ManagerAuthSheet } from './ManagerAuthSheet';
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

/** Pede o estorno ao servidor e, gravado lá, espelha aqui (pagamento REFUNDED, saldo, trava da chave). */
export async function submitPointRefund(payment: Payment, managerPin: string, reason: string, deps: ReconcileDeps = defaultReconcileDeps()): Promise<ActionResult<{ nfceIssued: boolean }>> {
  const key = payment.idempotency_key;
  if (!key || payment.acquirer !== 'MERCADO_PAGO') return { ok: false, error: 'Só pagamento da Point (Mercado Pago) tem estorno registrado aqui.' };
  const staff = useTcheStore.getState().currentUserId;
  if (!staff) return { ok: false, error: 'Entre com o seu usuário antes de registrar o estorno.' };
  const out = await refundPointPayment({ idempotency_key: key, staff_id: staff, manager_pin: managerPin, reason_text: reason }, deps);
  if (out.kind !== 'refunded') return { ok: false, error: out.error };
  const mirrored = useTcheStore.getState().mirrorServerPointRefund(key, reason);
  if (!mirrored.ok) return { ok: false, error: mirrored.error };
  return { ok: true, data: { nfceIssued: mirrored.data.nfceIssued } };
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
        quickReasons={['Venda estornada na maquininha', 'Estornado no app do Mercado Pago']}
        successMessage={POINT_REFUND_DONE}
        onSubmit={(pin, reason) => submitPointRefund(payment, pin, reason)}
        onSuccess={(data) => {
          if (data.nfceIssued) toast.alert(POINT_REFUND_NFCE);
        }}
      />
    </>
  );
}

/** Pagamentos da Point aprovados e registrados no período, com o pedido de estorno. */
export function PointRefunds({ payments }: { payments: readonly Payment[] }) {
  const rows = useMemo(() => payments.filter((p) => p.acquirer === 'MERCADO_PAGO' && p.status === 'APPROVED' && p.idempotency_key), [payments]);
  if (rows.length === 0) return null;
  return (
    <div className="rounded-2xl border border-slate-200 bg-surface p-4 text-sm">
      <div className="mb-1 font-bold">Pagamentos da Point (Mercado Pago)</div>
      <p className="mb-2 text-xs text-slate-500">Estornou uma venda na maquininha ou no app do Mercado Pago? Registre aqui com o PIN do gerente.</p>
      {rows.map((p) => {
        const label = `${new Date(p.created_at).toLocaleTimeString('pt-BR')} · ${p.card_brand ?? 'cartão'} · NSU ${p.nsu ?? '?'}`;
        return (
          <div key={p.id} className="flex items-center justify-between gap-2 border-t border-slate-200 py-2">
            <span className="text-slate-600">{label} · {formatBRL(p.amount)}</span>
            <PointRefundButton payment={p} label={label} />
          </div>
        );
      })}
    </div>
  );
}
