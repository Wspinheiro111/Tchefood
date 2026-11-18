import { CloudOff } from 'lucide-react';
import { useTcheStore } from '../store/useTcheStore';

/** Texto combinado com o Will (15/11/2026): no piloto, sem internet a loja usa o sistema antigo. */
export const OFFLINE_OLD_SYSTEM_TEXT = 'Sem internet: use o sistema antigo até voltar';

/**
 * Loja ligada à nuvem e aparelho sem internet: nenhum pagamento é recebido (todo pagamento é reservado no
 * servidor antes, ver CLAIM_OFFLINE_ERROR). O aviso fica no topo de todas as telas da equipe até a rede voltar.
 */
export function OfflineCloudBanner({ online, underHeader = false }: { online: boolean; underHeader?: boolean }) {
  const cloud = useTcheStore((s) => s.cloud !== null);
  if (online || !cloud) return null;
  return (
    <div role="alert" className={`${underHeader ? 'sticky top-14 z-20' : ''} flex items-center gap-3 border-b-2 border-brasa bg-brasa px-4 py-3 text-white shadow`}>
      <CloudOff aria-hidden className="h-6 w-6 shrink-0" />
      <div className="leading-tight">
        <div className="text-lg font-black">{OFFLINE_OLD_SYSTEM_TEXT}</div>
        <div className="text-sm">Este aparelho não recebe pagamentos sem conexão com a nuvem.</div>
      </div>
    </div>
  );
}
