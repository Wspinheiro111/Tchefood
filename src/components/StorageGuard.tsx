import { useEffect, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { getStorageStatus, onWriterAvailable, subscribeStorageStatus } from '../lib/idbStorage';

export const STORAGE_READONLY_MESSAGE =
  'O Tchê Food já está aberto em outra janela ou aba deste aparelho. Esta aqui só mostra a tela e NÃO grava nada: vendas, pagamentos e alterações feitas aqui não ficam salvas. Feche esta janela e use a outra.';
export const STORAGE_BLOCKED_MESSAGE =
  'Este aparelho não conseguiu confirmar qual é o estado mais novo salvo. Para não cobrir dados mais novos, nada pode ser feito até recarregar o app. Toque em Recarregar.';

/** Tela cheia que impede o trabalho sobre um estado que não pode ser gravado (GPT, rodada 27 do PR #54, P1-02). */
export function StorageGuard() {
  const status = useSyncExternalStore(subscribeStorageStatus, getStorageStatus, getStorageStatus);
  // Atrás da tela cheia nada pode receber foco nem teclado (leitor de código de barras): o app todo fica inerte.
  useEffect(() => {
    if (status === 'ok') return;
    const root = document.getElementById('root');
    root?.setAttribute('inert', '');
    return () => root?.removeAttribute('inert');
  }, [status]);
  // A instância escritora fechou: esta (só leitura) recarrega para assumir e hidratar o estado gravado.
  useEffect(() => {
    if (status !== 'readonly') return;
    return onWriterAvailable(() => {
      try {
        window.location.reload();
      } catch {
        // o botão Recarregar continua valendo
      }
    });
  }, [status]);
  // Página restaurada do cache de navegação (bfcache): o lock de escritor é solto ao congelar a página, então o estado em
  // memória pode estar velho e já não há exclusividade. Recarrega para hidratar de novo e pedir o lock.
  useEffect(() => {
    const onShow = (e: Event) => {
      if ((e as PageTransitionEvent).persisted) {
        try {
          window.location.reload();
        } catch {
          // sem como recarregar
        }
      }
    };
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
  }, []);
  if (status === 'ok') return null;
  // Fora do #root: o root fica inerte e o diálogo precisa continuar clicável e acessível (Codex, rodada 29 do PR #54).
  return createPortal(
    <div role="alertdialog" aria-modal="true" aria-label="Armazenamento bloqueado" className="fixed inset-0 z-[100] grid place-items-center bg-black/80 p-6">
      <div className="max-w-md rounded-2xl bg-white p-6 text-center shadow-xl">
        <h2 className="mb-2 text-lg font-black text-brasa">{status === 'readonly' ? 'Outra janela está em uso' : 'Reabra o app'}</h2>
        <p className="mb-4 text-sm font-semibold text-slate-700">{status === 'readonly' ? STORAGE_READONLY_MESSAGE : STORAGE_BLOCKED_MESSAGE}</p>
        <button onClick={() => window.location.reload()} className="min-h-touch rounded-xl bg-brasa px-5 font-black text-white">
          Recarregar
        </button>
      </div>
    </div>,
    document.body,
  );
}
