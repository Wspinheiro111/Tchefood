import { AlertTriangle } from 'lucide-react';
import { useCloudStaleMessage } from '../lib/sync/useCloudSync';

/**
 * Faixa nas telas da equipe quando as contas não atualizam da nuvem (auditoria interna, rodada 8
 * do PR #54): sem ela, a leitura parada só aparecia na tela da nuvem, e garçom e caixa viam mesa e
 * saldo velhos sem saber. Some sozinha quando a leitura volta a dar certo. Fica presa no topo,
 * abaixo do cabeçalho, junto com ele (App.tsx).
 */
export function CloudStaleBanner() {
  const message = useCloudStaleMessage();
  if (!message) return null;
  return (
    // Fica no topo fixo do App, logo abaixo do cabeçalho (auditoria interna, rodada 8 do PR #54):
    // fundo branco opaco para o conteúdo não aparecer por trás ao rolar.
    <div role="status" className="flex items-start gap-2 border-b-2 border-ouro bg-white px-3 py-2 text-sm font-bold text-brasa">
      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
      {/* No máximo duas linhas, para o topo fixo não crescer no celular; o texto inteiro fica no
          title e no leitor de tela (auditoria interna, rodada 8 do PR #54). */}
      <span className="line-clamp-2" title={message}>{message}</span>
    </div>
  );
}
