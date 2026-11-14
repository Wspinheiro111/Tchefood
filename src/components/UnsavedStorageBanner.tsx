import { useEffect, useState } from 'react';
import { reviewHoldsUnsaved, subscribeReviewHolds } from '../lib/payments/reviewHolds';
import { claimLedgerUnsaved } from '../lib/payments/claimLedger';

export const UNSAVED_STORAGE_WARNING =
  'Este aparelho não conseguiu gravar uma trava ou reserva de pagamento (armazenamento cheio ou bloqueado). Não feche nem recarregue o app: libere espaço no navegador e chame o gerente antes de cobrar de novo esta conta.';

/** Aviso fixo enquanto houver trava ou reserva de pagamento só em memória (some se o app fechar). */
export function UnsavedStorageBanner() {
  const check = () => reviewHoldsUnsaved() || claimLedgerUnsaved();
  const [unsaved, setUnsaved] = useState(check);
  useEffect(() => {
    const refresh = () => setUnsaved(check());
    const off = subscribeReviewHolds(refresh);
    const timer = setInterval(refresh, 5_000);
    return () => {
      off();
      clearInterval(timer);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!unsaved) return null;
  return (
    <div role="alert" className="sticky top-14 z-30 bg-brasa px-3 py-2 text-sm font-bold text-white">
      {UNSAVED_STORAGE_WARNING}
    </div>
  );
}
