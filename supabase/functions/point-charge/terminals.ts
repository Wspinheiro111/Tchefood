/**
 * Lista das maquininhas Point da conta do Mercado Pago da loja (só leitura), para a tela de cadastro da Point
 * mostrar se a maquininha cadastrada está na conta e no modo PDV (o único em que recebe cobrança do caixa).
 * Não grava nada e não cobra nada: o cadastro em si é a linha de pos_terminals que o aparelho sobe.
 */
import type { PaymentTerminalInfo } from '../../../server/shared/paymentTerminal.ts';

export interface StoreTerminal {
  /** terminal_id do Mercado Pago (ex.: NEWLAND_N950__N950NCB801293324), o que vai em pos_terminals.serial_number. */
  id: string;
  operating_mode: 'pdv' | 'standalone' | 'unknown';
}

export interface TerminalsReply {
  terminals: StoreTerminal[];
}

/** Só o que a tela usa: o ID e o modo. Lista incompleta ou ilegível falha no provedor (nada parcial chega aqui). */
export async function listStoreTerminals(provider: { listTerminals(): Promise<PaymentTerminalInfo[]> }): Promise<TerminalsReply> {
  const list = await provider.listTerminals();
  return { terminals: list.map((t) => ({ id: t.externalTerminalId, operating_mode: t.operatingMode })) };
}
