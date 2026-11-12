import type { CashbackReconcileResult } from './sync/cloudPull';
import { formatBRL } from './money';
import { SHIFT_TIME_ZONE } from './reports';

/** Data e hora de Brasília (fuso da loja), não do aparelho (P2-02 da rodada 1 do GPT no PR #48). */
export function formatBrasiliaDateTime(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', { timeZone: SHIFT_TIME_ZONE });
}

export type ReconcileOutcome = {
  /** O id da próxima decisão desta pendência: novo só depois de uma decisão confirmada pela nuvem. */
  nextRequestId: string;
  tone: 'success' | 'error';
  message: string;
  /** Ler as pendências de novo (a decisão foi gravada; a pendência pode ter mudado). */
  reload: boolean;
};

/**
 * O que fazer com o resultado de uma conciliação (P1-01 e P2-01 da rodada 1 do GPT no PR #48):
 *  - confirmada pela nuvem: a próxima decisão desta linha ganha id novo; uma pendência nova
 *    do mesmo cliente não reaproveita a decisão já gravada;
 *  - "já estava gravada" (reenvio com o id de uma decisão anterior): avisa que não houve
 *    nova conciliação, troca o id e lê de novo, para a pendência que ainda existir ser
 *    decidida à parte;
 *  - recusada pela nuvem (PIN, valor mudou...): nada foi gravado; o id fica;
 *  - sem resposta (rede): a decisão pode ter sido gravada; o id fica, para o reenvio
 *    conferir sem duplicar.
 */
export function reconcileOutcome(
  result: CashbackReconcileResult | { networkError: string },
  decision: 'RELEASE' | 'DISCARD',
  currentId: string,
  newId: () => string,
): ReconcileOutcome {
  if ('networkError' in result) {
    return {
      nextRequestId: currentId,
      tone: 'error',
      message: `Sem resposta da nuvem (${result.networkError}). A decisão pode ter sido gravada: toque de novo na mesma opção para conferir, sem duplicar.`,
      reload: false,
    };
  }
  if (!result.ok && 'conflict' in result) {
    // P2-02 da segunda auditoria: o pedido com este id já tinha outra decisão gravada. Nada
    // foi gravado agora; a tela mostra o que vale, troca o id e lê de novo.
    const c = result.conflict;
    return {
      nextRequestId: newId(),
      tone: 'error',
      message: `Já havia uma decisão gravada para este pedido (${c.decision === 'RELEASE' ? 'liberar' : 'descartar'} ${formatBRL(c.amount)}, motivo "${c.reason}"). A nova não foi gravada; confira as pendências.`,
      reload: true,
    };
  }
  if (!result.ok) return { nextRequestId: currentId, tone: 'error', message: result.error, reload: false };
  if (result.repeated) {
    return {
      nextRequestId: newId(),
      tone: 'success',
      message: `Esta decisão (${formatBRL(result.amount)}) já estava gravada na nuvem; nada foi conciliado de novo. Confira as pendências.`,
      reload: true,
    };
  }
  return {
    nextRequestId: newId(),
    tone: 'success',
    message: decision === 'RELEASE' ? `${formatBRL(result.amount)} liberados ao cliente.` : `${formatBRL(result.amount)} conciliados sem devolver.`,
    reload: true,
  };
}

export type ReconcileDecisionDeps = {
  decision: 'RELEASE' | 'DISCARD';
  currentId: string;
  newId: () => string;
  /** Chamada à nuvem (reconcileCashback); pode rejeitar (rede). */
  send: (requestId: string) => Promise<CashbackReconcileResult>;
  /** Leitura da nuvem depois da decisão (syncOnce com forcePull); pode rejeitar. */
  reload: () => Promise<unknown>;
  notify: (tone: 'success' | 'error', message: string) => void;
};

/**
 * O toque em Liberar/Descartar (P2-01 das duas auditorias da rodada 1 do GPT no PR #48): nenhuma
 * falha de rede escapa sem aviso. Antes do envio ou com a resposta perdida depois do commit,
 * avisa que a decisão pode estar gravada e devolve o mesmo id (o reenvio confere sem duplicar).
 * Falha na leitura depois da decisão gravada avisa à parte, sem desfazer nada.
 * Devolve o id da próxima decisão e se a pendência foi resolvida (a lista deve ser lida de novo).
 */
export async function runReconcileDecision(deps: ReconcileDecisionDeps): Promise<{ nextRequestId: string; done: boolean }> {
  let result: CashbackReconcileResult | { networkError: string };
  try {
    result = await deps.send(deps.currentId);
  } catch (e) {
    result = { networkError: e instanceof Error ? e.message : String(e) };
  }
  const out = reconcileOutcome(result, deps.decision, deps.currentId, deps.newId);
  deps.notify(out.tone, out.message);
  if (!out.reload) return { nextRequestId: out.nextRequestId, done: false };
  try {
    await deps.reload();
  } catch {
    deps.notify('error', 'Conciliação gravada, mas a leitura da nuvem falhou. Toque em Sincronizar agora.');
  }
  return { nextRequestId: out.nextRequestId, done: true };
}
