/**
 * Cadastro da Point Smart: a lista das maquininhas da conta do Mercado Pago da loja (point-charge, ação
 * "terminals", só leitura) e o estado de cada maquininha cadastrada aqui, para a tela mostrar o que falta.
 */
import type { PosTerminal } from '../../types';
import type { SyncConfig } from '../sync/supabaseSync';
import { pointChargeEndpoint } from './mercadoPagoPointDriver';

/** terminal_id do Mercado Pago (ex.: NEWLAND_N950__N950NCB801293324). Cabe em pos_terminals.serial_number (60). */
export const MP_TERMINAL_ID = /^[A-Za-z0-9_-]{4,60}$/;

export interface MpTerminal {
  id: string;
  operating_mode: 'pdv' | 'standalone' | 'unknown';
}

export type PointListing =
  | { kind: 'ok'; terminals: MpTerminal[] }
  | { kind: 'no_cloud' }
  | { kind: 'not_configured' }
  | { kind: 'error'; message: string };

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; text(): Promise<string> }>;

export interface PointListingDeps {
  config: () => Promise<SyncConfig | null>;
  fetch: FetchLike;
}

const MODES: ReadonlySet<string> = new Set(['pdv', 'standalone', 'unknown']);

/** Resposta 200 validada; qualquer item fora do formato invalida a lista toda (nada parcial). */
export function parseTerminalsReply(text: string): MpTerminal[] | null {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  const list = (body as { terminals?: unknown } | null)?.terminals;
  if (!Array.isArray(list)) return null;
  const out: MpTerminal[] = [];
  for (const raw of list) {
    const t = raw as { id?: unknown; operating_mode?: unknown } | null;
    if (!t || typeof t.id !== 'string' || !t.id || typeof t.operating_mode !== 'string' || !MODES.has(t.operating_mode)) return null;
    out.push({ id: t.id, operating_mode: t.operating_mode as MpTerminal['operating_mode'] });
  }
  return out;
}

export async function fetchPointTerminals(deps: PointListingDeps): Promise<PointListing> {
  const cfg = await deps.config().catch(() => null);
  if (!cfg) return { kind: 'no_cloud' };
  const endpoint = pointChargeEndpoint(cfg);
  let status: number;
  let text: string;
  try {
    const res = await deps.fetch(endpoint.url, { method: 'POST', headers: endpoint.headers, body: JSON.stringify({ action: 'terminals' }) });
    status = res.status;
    text = await res.text();
  } catch {
    return { kind: 'error', message: 'Sem resposta da nuvem. Confira a internet e tente de novo.' };
  }
  if (status === 200) {
    const terminals = parseTerminalsReply(text);
    return terminals ? { kind: 'ok', terminals } : { kind: 'error', message: 'Resposta da nuvem fora do formato. Tente de novo.' };
  }
  let error = '';
  let message = `Falha na nuvem (HTTP ${status}). Tente de novo.`;
  try {
    const b = JSON.parse(text) as { error?: unknown; message?: unknown };
    if (typeof b.error === 'string') error = b.error;
    if (typeof b.message === 'string' && b.message) message = b.message;
  } catch {
    // corpo que não é da função: fica a mensagem genérica
  }
  if (status === 412 && error === 'not_configured') return { kind: 'not_configured' };
  return { kind: 'error', message };
}

export type PairingState = 'inactive' | 'unchecked' | 'ready' | 'not_pdv' | 'not_in_account';

export const PAIRING_TEXT: Record<PairingState, string> = {
  inactive: 'Desativada: não aparece no caixa.',
  unchecked: 'Ainda não conferida no Mercado Pago. Toque em "Conferir no Mercado Pago".',
  ready: 'Pronta: está na conta do Mercado Pago da loja e no modo PDV. O caixa já pode cobrar nela.',
  not_pdv: 'Está na conta do Mercado Pago, mas fora do modo PDV: ainda não recebe cobrança do caixa. Ative o modo PDV desta maquininha.',
  not_in_account: 'Não aparece na conta do Mercado Pago desta loja. Confira o ID e se a Point está logada com a conta da loja.',
};

/** Estado da maquininha cadastrada, pela última lista do Mercado Pago (null = ainda não conferida). */
export function pairingState(terminal: Pick<PosTerminal, 'serial_number' | 'online'>, listing: PointListing | null): PairingState {
  if (!terminal.online) return 'inactive';
  if (!listing || listing.kind !== 'ok') return 'unchecked';
  const found = listing.terminals.find((t) => t.id === terminal.serial_number);
  if (!found) return 'not_in_account';
  return found.operating_mode === 'pdv' ? 'ready' : 'not_pdv';
}
