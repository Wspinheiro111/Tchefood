/**
 * NFC-e real pelas telas: o aparelho pede a emissão à Edge Function emit-nfce
 * (supabase/functions/emit-nfce) e só guarda o que ela respondeu.
 *
 * Regras:
 *  - O aparelho nunca monta chave, protocolo, número ou QR Code. Tudo isso vem do
 *    servidor (que fala com a Focus NFe) e é conferido antes de ir para a tela.
 *  - "Autorizada" só com status authorized, authorized=true, chave e protocolo. Qualquer
 *    outra coisa (sem chave, sem protocolo, resposta estranha) fica em processamento.
 *  - A comanda só é enviada para emissão depois que tudo dela subiu para a nuvem: nenhum
 *    evento dela na fila nem na lista de recusados. O servidor lê itens e pagamentos do
 *    banco; pedir antes faria a nota sair com o que ainda não chegou (ou ser recusada).
 *  - Em processamento ou contingência o aparelho volta a consultar com intervalo crescente
 *    (a função só faz GET da mesma referência). Rejeitada, inválida ou em conflito para:
 *    só o botão da tela tenta de novo, depois de alguém corrigir a causa.
 *  - Falha de rede ou do servidor não muda o status da nota: só a mensagem e a próxima
 *    tentativa.
 */
import type { NfceCallProblem, NfceCloudRecord, NfceCloudStatus, Order, SyncEvent } from '../../types';
import { toCents } from '../money';
import { isValidNfceQrCodeContent } from '../nfce';
import { recordKeys, type FetchLike, type SyncConfig } from './supabaseSync';

const DOC_STATUSES: ReadonlyArray<NfceCloudStatus> = ['processing', 'authorized', 'rejected', 'contingency', 'cancelled'];
const PROBLEMS: ReadonlyArray<Exclude<NfceCallProblem, 'error' | 'network'>> = ['invalid', 'not_found', 'conflict'];

/** Situação local da comanda (orders.nfce_status) para cada status do documento — o mesmo do trigger tchefood_nfce_mirror_order. */
export const NFCE_ORDER_STATUS: Record<NfceCloudStatus, string> = {
  processing: 'PROCESSANDO',
  authorized: 'AUTORIZADA',
  rejected: 'REJEITADA',
  contingency: 'CONTINGENCIA',
  cancelled: 'CANCELADA',
};

/** Comandas cuja NFC-e ainda pode ser pedida ou consultada pelo aparelho. */
const OPEN_ORDER_STATUSES: ReadonlyArray<string> = ['PENDING', 'PROCESSANDO', 'CONTINGENCIA', 'REJEITADA'];

/** Mesma máquina de estados de canTransition (emit-nfce/focus.ts) e do trigger tchefood_nfce_guard. */
const ALLOWED: Record<NfceCloudStatus, NfceCloudStatus[]> = {
  processing: ['authorized', 'rejected', 'contingency', 'cancelled'],
  rejected: ['processing', 'authorized', 'contingency'],
  contingency: ['processing', 'authorized', 'rejected', 'cancelled'],
  authorized: ['cancelled'],
  cancelled: [],
};

export function canNfceTransition(current: NfceCloudStatus | null, next: NfceCloudStatus): boolean {
  return current === null || current === next || ALLOWED[current].includes(next);
}

export interface NfceDocumentOutcome {
  kind: 'document';
  status: NfceCloudStatus;
  environment: 'homologacao' | 'producao';
  access_key: string | null;
  protocol: string | null;
  number: number | null;
  series: string | null;
  qrcode_url: string | null;
  danfe_path: string | null;
  issued_at: string | null;
  message: string | null;
}

export interface NfceProblemOutcome {
  kind: NfceCallProblem;
  httpStatus: number;
  message: string;
}

export type NfceEmitOutcome = NfceDocumentOutcome | NfceProblemOutcome;

const KEY_RE = /^\d{6}[0-9A-Z]{12}\d{26}$/;

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

/**
 * Lê a resposta da emit-nfce. Nada que não passe na conferência vai para a tela:
 * chave fora do formato vira null, QR Code de outra chave ou de fora da SEFAZ vira null,
 * "autorizada" sem chave ou protocolo vira processamento.
 */
export function parseEmitResponse(httpStatus: number, body: string): NfceEmitOutcome {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return { kind: 'error', httpStatus, message: `Resposta inválida do servidor (HTTP ${httpStatus}).` };
  }
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const message = text(r.message, 1000);
  const status = r.status;
  if (typeof status === 'string' && (DOC_STATUSES as string[]).includes(status)) {
    const environment = r.environment === 'producao' || r.environment === 'homologacao' ? r.environment : null;
    if (!environment) return { kind: 'error', httpStatus, message: 'Resposta do servidor sem ambiente fiscal válido.' };
    const keyRaw = text(r.access_key, 60)?.toUpperCase().replace(/^NFE/, '') ?? null;
    const accessKey = keyRaw && KEY_RE.test(keyRaw) ? keyRaw : null;
    const protocolRaw = text(r.protocol, 80);
    const protocol = protocolRaw && /^\d{1,80}$/.test(protocolRaw) ? protocolRaw : null;
    const qrRaw = text(r.qrcode_url, 1000);
    const danfeRaw = text(r.danfe_path, 512);
    const issuedRaw = text(r.issued_at, 40);
    const number = typeof r.number === 'number' && Number.isInteger(r.number) && r.number > 0 ? r.number : null;
    const seriesRaw = text(r.series, 3);
    let docStatus = status as NfceCloudStatus;
    let docMessage = message;
    if (docStatus === 'authorized' && !(r.authorized === true && accessKey && protocol)) {
      docStatus = 'processing';
      docMessage = 'O servidor respondeu "autorizada" sem chave ou protocolo válidos. A nota fica em processamento até a próxima consulta.';
    }
    return {
      kind: 'document',
      status: docStatus,
      environment,
      access_key: accessKey,
      protocol: docStatus === 'authorized' || docStatus === 'cancelled' ? protocol : null,
      number,
      series: seriesRaw && /^\d{1,3}$/.test(seriesRaw) ? seriesRaw : null,
      qrcode_url: qrRaw && accessKey && isValidNfceQrCodeContent(qrRaw, accessKey) ? qrRaw : null,
      // Caminho relativo da Focus (ex.: /notas_fiscais_consumidor/NFe...html); nada de outro host.
      danfe_path: danfeRaw && /^\/[A-Za-z0-9_./-]+$/.test(danfeRaw) && !danfeRaw.includes('..') && !danfeRaw.startsWith('//') ? danfeRaw : null,
      issued_at: issuedRaw && !Number.isNaN(Date.parse(issuedRaw)) ? issuedRaw : null,
      message: docMessage,
    };
  }
  if (typeof status === 'string' && (PROBLEMS as string[]).includes(status)) {
    return { kind: status as NfceProblemOutcome['kind'], httpStatus, message: message ?? `HTTP ${httpStatus}` };
  }
  const why = httpStatus === 401 ? 'Sessão da nuvem recusada' : `Falha no servidor (HTTP ${httpStatus})`;
  return { kind: 'error', httpStatus, message: message ? `${why}: ${message}` : `${why}. A NFC-e não foi confirmada.` };
}

/** POST /functions/v1/emit-nfce com o JWT do aparelho; o corpo só leva o order_id. */
export async function requestNfceEmission(cfg: SyncConfig, orderId: string, fetchFn: FetchLike): Promise<NfceEmitOutcome> {
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchFn(`${cfg.url.replace(/\/+$/, '')}/functions/v1/emit-nfce`, {
      method: 'POST',
      headers: { apikey: cfg.anonKey, Authorization: `Bearer ${cfg.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ order_id: orderId }),
    });
  } catch {
    return { kind: 'network', httpStatus: 0, message: 'Sem resposta do servidor. A NFC-e não foi confirmada; o aparelho consulta de novo.' };
  }
  let body = '';
  try {
    body = await res.text();
  } catch {
    return { kind: 'network', httpStatus: res.status, message: 'A resposta do servidor foi interrompida. O aparelho consulta de novo.' };
  }
  return parseEmitResponse(res.status, body);
}

/** Intervalo até a próxima chamada automática: 10 s, 20 s, 40 s… até 5 min. */
export function nfceBackoffMs(attempts: number): number {
  return Math.min(300_000, 10_000 * 2 ** Math.max(0, Math.min(attempts - 1, 10)));
}

/** Próximo registro a partir da resposta. Devolve null quando a resposta deve ser ignorada. */
export function nextNfceRecord(orderId: string, prev: NfceCloudRecord | undefined, outcome: NfceEmitOutcome, nowMs: number): NfceCloudRecord {
  const attempts = (prev?.attempts ?? 0) + 1;
  const ts = new Date(nowMs).toISOString();
  const retryAt = new Date(nowMs + nfceBackoffMs(attempts)).toISOString();
  const base: NfceCloudRecord = prev ?? {
    order_id: orderId,
    status: null,
    environment: null,
    access_key: null,
    protocol: null,
    number: null,
    series: null,
    qrcode_url: null,
    danfe_path: null,
    issued_at: null,
    message: null,
    problem: null,
    attempts: 0,
    next_attempt_at: null,
    updated_at: ts,
  };
  if (outcome.kind !== 'document') {
    // Sem documento na resposta: a situação fiscal fica como estava.
    const autoRetry = outcome.kind === 'network' || outcome.kind === 'error' || outcome.kind === 'not_found';
    return { ...base, problem: outcome.kind, message: outcome.message, attempts, next_attempt_at: autoRetry ? retryAt : null, updated_at: ts };
  }
  if (!canNfceTransition(base.status, outcome.status) || (base.environment && base.environment !== outcome.environment)) {
    // Resposta atrasada não regride uma situação mais confiável (ex.: autorizada → processamento).
    const done = base.status === 'authorized' || base.status === 'cancelled';
    return { ...base, attempts, next_attempt_at: done ? null : retryAt, updated_at: ts };
  }
  const polling = outcome.status === 'processing' || outcome.status === 'contingency';
  return {
    ...base,
    status: outcome.status,
    environment: outcome.environment,
    access_key: outcome.access_key ?? base.access_key,
    protocol: outcome.protocol ?? (outcome.status === 'authorized' || outcome.status === 'cancelled' ? base.protocol : null),
    number: outcome.number ?? base.number,
    series: outcome.series ?? base.series,
    qrcode_url: outcome.qrcode_url ?? base.qrcode_url,
    danfe_path: outcome.danfe_path ?? base.danfe_path,
    issued_at: outcome.issued_at ?? base.issued_at,
    message: outcome.message,
    problem: null,
    attempts,
    next_attempt_at: polling ? retryAt : null,
    updated_at: ts,
  };
}

/** Comandas com evento ainda na fila ou recusado: não estão inteiras na nuvem. */
export function ordersWithPendingEvents(events: readonly SyncEvent[]): Set<string> {
  const out = new Set<string>();
  for (const e of events) for (const k of recordKeys(e)) if (k.startsWith('orders:')) out.add(k.slice(7));
  return out;
}

export interface NfceQueueState {
  orders: readonly Order[];
  outbox: readonly SyncEvent[];
  syncRejected?: ReadonlyArray<{ event: SyncEvent }>;
  nfceCloud?: Readonly<Record<string, NfceCloudRecord>>;
  /** Pedidos do botão "emitir/consultar agora" (ids de comanda). */
  nfceForced?: ReadonlyArray<string>;
}

/** A comanda já está pronta para a emissão real: fechada, com valor e com tudo na nuvem. */
export function nfceEligible(order: Order, pending: ReadonlySet<string>): boolean {
  return (
    order.status === 'CLOSED' &&
    toCents(order.total_amount) > 0 &&
    toCents(order.paid_amount) > 0 &&
    OPEN_ORDER_STATUSES.includes(order.nfce_status ?? '') &&
    !pending.has(order.id)
  );
}

/** Comandas a pedir/consultar agora, das mais antigas para as mais novas. */
export function dueNfceOrders(state: NfceQueueState, nowMs: number, limit = 3): string[] {
  const pending = ordersWithPendingEvents([...state.outbox, ...(state.syncRejected ?? []).map((r) => r.event)]);
  const records = state.nfceCloud ?? {};
  const forced = new Set(state.nfceForced ?? []);
  return state.orders
    .filter((o) => nfceEligible(o, pending))
    .filter((o) => {
      const rec = records[o.id];
      if (rec && (rec.status === 'authorized' || rec.status === 'cancelled')) return false;
      if (forced.has(o.id)) return true;
      if (!rec) return true;
      return rec.next_attempt_at !== null && Date.parse(rec.next_attempt_at) <= nowMs;
    })
    .sort((a, b) => (a.closed_at ?? '').localeCompare(b.closed_at ?? ''))
    .slice(0, limit)
    .map((o) => o.id);
}
