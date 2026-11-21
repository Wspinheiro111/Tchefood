import { useSyncExternalStore } from 'react';
import { getStorageStatus, subscribeStorageStatus } from '../lib/idbStorage';

export const STORAGE_READONLY_MESSAGE =
  'O Tchê Food já está aberto em outra janela ou aba deste aparelho. Esta aqui só mostra a tela e NÃO grava nada: vendas, pagamentos e alterações feitas aqui não ficam salvas. Feche esta janela e use a outra.';
export const STORAGE_BLOCKED_MESSAGE =
  'Este aparelho não conseguiu confirmar qual é o estado mais novo salvo. Para não cobrir dados mais novos, nada pode ser feito até recarregar o app. Toque em Recarregar.';

/** Tela cheia que impede o trabalho sobre um estado que não pode ser gravado (GPT, rodada 27 do PR #54, P1-02). */
export function StorageGuard() {
  const status = useSyncExternalStore(subscribeStorageStatus, getStorageStatus, getStorageStatus);
  if (status === 'ok') return null;
  return (
    <div role="alertdialog" aria-modal="true" aria-label="Armazenamento bloqueado" className="fixed inset-0 z-[100] grid place-items-center bg-black/80 p-6">
      <div className="max-w-md rounded-2xl bg-white p-6 text-center shadow-xl">
        <h2 className="mb-2 text-lg font-black text-brasa">{status === 'readonly' ? 'Outra janela está em uso' : 'Reabra o app'}</h2>
        <p className="mb-4 text-sm font-semibold text-slate-700">{status === 'readonly' ? STORAGE_READONLY_MESSAGE : STORAGE_BLOCKED_MESSAGE}</p>
        <button onClick={() => window.location.reload()} className="min-h-touch rounded-xl bg-brasa px-5 font-black text-white">
          Recarregar
        </button>
      </div>
    </div>
  );
}
