import { useEffect, useState } from 'react';
import { reviewHoldsUnsaved, subscribeReviewHolds, unsavedReviewHoldOrders } from '../lib/payments/reviewHolds';
import { claimLedgerUnsaved, unsavedClaimOrders } from '../lib/payments/claimLedger';
import { useTcheStore } from '../store/useTcheStore';

export const UNSAVED_STORAGE_WARNING =
  'Este aparelho não conseguiu gravar uma trava ou reserva de pagamento (armazenamento cheio ou bloqueado). Não feche nem recarregue o app: libere espaço no navegador e chame o gerente antes de cobrar de novo.';

/** O que falta gravar agora; nunca lança (armazenamento bloqueado não derruba a tela). */
function unsavedNow(): { any: boolean; orders: string[] } {
  try {
    const any = reviewHoldsUnsaved() || claimLedgerUnsaved();
    return { any, orders: any ? [...new Set([...unsavedReviewHoldOrders(), ...unsavedClaimOrders()])] : [] };
  } catch {
    return { any: false, orders: [] };
  }
}

/** Aviso fixo enquanto houver trava ou reserva de pagamento só em memória (some se o app fechar), com as contas. */
export function UnsavedStorageBanner() {
  const [state, setState] = useState(unsavedNow);
  const labels = useTcheStore((s) =>
    state.orders
      .map((id) => {
        const order = s.orders.find((o) => o.id === id);
        const table = order ? s.tables.find((t) => t.id === order.table_id) : undefined;
        return table?.label ?? (order?.pickup_number != null ? `Senha ${order.pickup_number}` : null);
      })
      .filter((x): x is string => Boolean(x))
      .join(', '),
  );
  useEffect(() => {
    const refresh = () => setState(unsavedNow());
    const off = subscribeReviewHolds(refresh);
    const timer = setInterval(refresh, 5_000);
    return () => {
      off();
      clearInterval(timer);
    };
  }, []);
  if (!state.any) return null;
  return (
    <div role="alert" className="sticky top-14 z-30 bg-brasa px-3 py-2 text-sm font-bold text-white">
      {UNSAVED_STORAGE_WARNING}
      {labels ? ` Contas: ${labels}.` : ''}
    </div>
  );
}
