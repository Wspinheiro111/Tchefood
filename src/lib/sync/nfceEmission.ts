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
import type { NfceCallProblem, NfceCloudRecord, NfceCloudStatus, NfceDanfePayload, NfceIssuer, Order, SyncEvent } from '../../types';
import { toCents } from '../money';
import { isValidAccessKey, isValidNfceQrCodeContent, serverNfceDocument, type ServerNfceFields } from '../nfce';
import { recordKeys, type FetchLike, type SyncConfig } from './supabaseSync';

/** HTTP que a emit-nfce devolve para cada situação do documento. */
const DOC_HTTP: Record<NfceCloudStatus, number> = { authorized: 200, cancelled: 200, contingency: 200, processing: 202, rejected: 422 };
const DOC_STATUSES: ReadonlyArray<NfceCloudStatus> = ['processing', 'authorized', 'rejected', 'contingency', 'cancelled'];
const PROBLEMS: ReadonlyArray<Exclude<NfceCallProblem, 'error' | 'network'>> = ['invalid', 'not_found', 'conflict', 'none'];

/** Consultas automáticas de uma nota autorizada que veio sem dados de impressão. */
export const NFCE_PRINT_DATA_MAX_ATTEMPTS = 8;

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
  payload: NfceDanfePayload | null;
  /** Emitente gravado no servidor junto do payload transmitido (nunca o cadastro deste aparelho). */
  issuer: NfceIssuer | null;
  message: string | null;
}

export interface NfceProblemOutcome {
  kind: NfceCallProblem;
  httpStatus: number;
  message: string;
}

export type NfceEmitOutcome = NfceDocumentOutcome | NfceProblemOutcome;

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

/** Valor em reais com no máximo 2 casas, finito e não negativo. */
function money(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.abs(Math.round(value * 100) - value * 100) < 1e-6 ? value : null;
}

/**
 * Payload transmitido, como o servidor devolveu. Só passa inteiro e coerente: soma dos
 * itens = valor_produtos, produtos + outras despesas − desconto = total = soma dos
 * pagamentos (em centavos). Qualquer coisa fora disso vira null e o DANFE não sai da bobina.
 */
export function parseDanfePayload(value: unknown): NfceDanfePayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const p = value as Record<string, unknown>;
  if (!Array.isArray(p.items) || p.items.length === 0 || p.items.length > 990 || !Array.isArray(p.formas_pagamento) || p.formas_pagamento.length === 0) return null;
  const items: NfceDanfePayload['items'] = [];
  for (const raw of p.items) {
    const it = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const numero = it.numero_item;
    const qty = it.quantidade_comercial;
    const codigo = text(it.codigo_produto, 60);
    const descricao = text(it.descricao, 120);
    const un = text(it.unidade_comercial, 6);
    const unit = money(it.valor_unitario_comercial);
    const bruto = money(it.valor_bruto);
    if (typeof numero !== 'number' || !Number.isInteger(numero) || numero < 1) return null;
    if (typeof qty !== 'number' || !Number.isFinite(qty) || qty <= 0) return null;
    if (!codigo || !descricao || !un || unit === null || bruto === null) return null;
    // Mesma conta da emit-nfce (e do trigger dos itens): round(quantidade em milésimos × unitário em centavos / 1000).
    if (Math.round((Math.round(qty * 1000) * Math.round(unit * 100)) / 1000) !== Math.round(bruto * 100)) return null;
    items.push({ numero_item: numero, codigo_produto: codigo, descricao, unidade_comercial: un, quantidade_comercial: qty, valor_unitario_comercial: unit, valor_bruto: bruto });
  }
  const formas: NfceDanfePayload['formas_pagamento'] = [];
  for (const raw of p.formas_pagamento) {
    const f = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const code = text(f.forma_pagamento, 2);
    const amount = money(f.valor_pagamento);
    if (!code || !/^\d{2}$/.test(code) || amount === null) return null;
    formas.push({ forma_pagamento: code, valor_pagamento: amount });
  }
  const produtos = money(p.valor_produtos);
  const desconto = money(p.valor_desconto);
  const outras = money(p.valor_outras_despesas);
  const total = money(p.valor_total);
  if (produtos === null || desconto === null || outras === null || total === null) return null;
  const c = (v: number) => Math.round(v * 100);
  if (items.reduce((s, i) => s + c(i.valor_bruto), 0) !== c(produtos)) return null;
  if (c(produtos) + c(outras) - c(desconto) !== c(total)) return null;
  if (formas.reduce((s, f) => s + c(f.valor_pagamento), 0) !== c(total)) return null;
  const out: NfceDanfePayload = { items, valor_produtos: produtos, valor_desconto: desconto, valor_outras_despesas: outras, valor_total: total, formas_pagamento: formas };
  const cnpj = text(p.cnpj_emitente, 14);
  if (!cnpj || !/^[0-9A-Z]{14}$/.test(cnpj)) return null;
  out.cnpj_emitente = cnpj;
  const cpf = text(p.cpf_destinatario, 11);
  if (cpf !== null) {
    if (!/^\d{11}$/.test(cpf)) return null;
    out.cpf_destinatario = cpf;
  }
  return out;
}

/** Emitente devolvido pelo servidor: só passa inteiro (nome, razão social, CNPJ de 14, UF de 2). */
export function parseNfceIssuer(value: unknown): NfceIssuer | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const name = text(v.name, 150);
  const legal = text(v.legal_name, 200);
  const cnpj = text(v.cnpj, 14);
  const city = text(v.city, 100);
  const state = text(v.state, 2);
  const ie = v.state_registration === null || v.state_registration === undefined ? null : text(v.state_registration, 20);
  if (!name || !legal || !cnpj || !/^[0-9A-Z]{14}$/.test(cnpj) || !city || !state || !/^[A-Z]{2}$/.test(state)) return null;
  if (v.state_registration !== null && v.state_registration !== undefined && ie === null) return null;
  return { name, legal_name: legal, cnpj, state_registration: ie, city, state };
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
  // Documento só vale com o HTTP que a emit-nfce usa para aquele status; erro 4xx/5xx com corpo de
  // "autorizada" não muda a situação fiscal.
  if (typeof status === 'string' && (DOC_STATUSES as string[]).includes(status)) {
    if (httpStatus !== DOC_HTTP[status as NfceCloudStatus]) {
      return { kind: 'error', httpStatus, message: `Resposta inconsistente do servidor (HTTP ${httpStatus}). A NFC-e não foi confirmada.` };
    }
    const environment = r.environment === 'producao' || r.environment === 'homologacao' ? r.environment : null;
    if (!environment) return { kind: 'error', httpStatus, message: 'Resposta do servidor sem ambiente fiscal válido.' };
    const keyRaw = text(r.access_key, 60)?.toUpperCase().replace(/^NFE/, '') ?? null;
    const accessKey = keyRaw && isValidAccessKey(keyRaw) ? keyRaw : null;
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
      qrcode_url: qrRaw && accessKey && isValidNfceQrCodeContent(qrRaw, accessKey, environment) ? qrRaw : null,
      // Caminho relativo da Focus (ex.: /notas_fiscais_consumidor/NFe...html); nada de outro host.
      danfe_path: danfeRaw && /^\/[A-Za-z0-9_./-]+$/.test(danfeRaw) && !danfeRaw.includes('..') && !danfeRaw.startsWith('//') ? danfeRaw : null,
      issued_at: issuedRaw && !Number.isNaN(Date.parse(issuedRaw)) ? issuedRaw : null,
      payload: parseDanfePayload(r.payload),
      issuer: parseNfceIssuer(r.issuer),
      message: docMessage,
    };
  }
  if (typeof status === 'string' && (PROBLEMS as string[]).includes(status)) {
    return { kind: status as NfceProblemOutcome['kind'], httpStatus, message: message ?? `HTTP ${httpStatus}` };
  }
  const why = httpStatus === 401 ? 'Sessão da nuvem recusada' : `Falha no servidor (HTTP ${httpStatus})`;
  return { kind: 'error', httpStatus, message: message ? `${why}: ${message}` : `${why}. A NFC-e não foi confirmada.` };
}

/**
 * POST /functions/v1/emit-nfce com o JWT do aparelho; o corpo só leva o order_id e o modo.
 * consult: o servidor só devolve/consulta o documento existente, nunca transmite.
 */
export async function requestNfceEmission(cfg: SyncConfig, orderId: string, fetchFn: FetchLike, mode: NfceCallMode = 'emit'): Promise<NfceEmitOutcome> {
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchFn(`${cfg.url.replace(/\/+$/, '')}/functions/v1/emit-nfce`, {
      method: 'POST',
      headers: { apikey: cfg.anonKey, Authorization: `Bearer ${cfg.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ order_id: orderId, mode }),
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

/** Próximo registro a partir da resposta (resposta que regrediria a situação só conta a tentativa). */
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
    payload: null,
    issuer: null,
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
    // Autorizada ainda sem DANFE imprimível continua consultando (só leitura), no mesmo limite.
    if (base.status === 'authorized' && missingPrintData(base)) {
      const printAttempts = (base.print_attempts ?? 0) + 1;
      const more = printAttempts < NFCE_PRINT_DATA_MAX_ATTEMPTS;
      return { ...base, attempts, print_attempts: printAttempts, next_attempt_at: more ? new Date(nowMs + nfceBackoffMs(printAttempts)).toISOString() : null, updated_at: ts };
    }
    const done = base.status === 'authorized' || base.status === 'cancelled';
    return { ...base, attempts, next_attempt_at: done ? null : retryAt, updated_at: ts };
  }
  // Chave nova (ex.: rejeitada e corrigida com outra numeração): nada da nota anterior completa esta.
  const keyChanged = !!outcome.access_key && !!base.access_key && outcome.access_key !== base.access_key;
  const carry = keyChanged
    ? { protocol: null, number: null, series: null, qrcode_url: null, danfe_path: null, issued_at: null, payload: null, issuer: null }
    : base;
  const merged = {
    status: outcome.status,
    environment: outcome.environment,
    access_key: outcome.access_key ?? base.access_key,
    protocol: outcome.protocol ?? (outcome.status === 'authorized' || outcome.status === 'cancelled' ? carry.protocol : null),
    number: outcome.number ?? carry.number,
    series: outcome.series ?? carry.series,
    qrcode_url: outcome.qrcode_url ?? carry.qrcode_url,
    danfe_path: outcome.danfe_path ?? carry.danfe_path,
    issued_at: outcome.issued_at ?? carry.issued_at,
    payload: outcome.payload ?? carry.payload,
    // Emitente de nota já autorizada (mesma chave) fica como chegou: o servidor também não o deixa mudar.
    issuer: (base.status === 'authorized' || base.status === 'cancelled') && !keyChanged && carry.issuer ? carry.issuer : (outcome.issuer ?? carry.issuer ?? null),
  };
  // Autorizada sem DANFE imprimível (falta dado ou o dado não confere com a chave): consulta (só leitura)
  // com intervalo crescente, até um limite. Contador próprio, a partir da primeira autorização.
  const missing = outcome.status === 'authorized' && missingPrintData(merged);
  const printAttempts = missing ? (base.status === 'authorized' && !keyChanged ? (base.print_attempts ?? 0) : 0) + 1 : 0;
  const printPolling = missing && printAttempts < NFCE_PRINT_DATA_MAX_ATTEMPTS;
  const polling = outcome.status === 'processing' || outcome.status === 'contingency' || printPolling;
  const nextAt = printPolling ? new Date(nowMs + nfceBackoffMs(printAttempts)).toISOString() : retryAt;
  return {
    ...base,
    ...merged,
    message: outcome.message,
    problem: null,
    attempts,
    print_attempts: printAttempts,
    next_attempt_at: polling ? nextAt : null,
    updated_at: ts,
  };
}

/**
 * Nota autorizada cujo DANFE da bobina não sai: falta dado do servidor ou o dado não confere
 * (QR, número/série, modelo, emitente com a chave). Mesma regra da impressão (serverNfceDocument),
 * então o que não imprime pode ser consultado de novo (fila e botão).
 */
export function missingPrintData(rec: ServerNfceFields): boolean {
  return serverNfceDocument(rec) === null;
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
export type NfceCallMode = 'emit' | 'consult';

/**
 * Que chamada à emit-nfce esta comanda pede agora (null = nenhuma):
 *  - situação aberta (pendente, processando, contingência, rejeitada pelo botão): emit;
 *  - autorizada sem QR/data/payload: consult (só leitura), até o limite ou pelo botão;
 *  - comanda antiga com NFC-e simulada no aparelho (AUTORIZADA sem registro do servidor):
 *    consult primeiro. Se o servidor não tem documento (none), só o botão emite a nota real
 *    (o servidor é idempotente por comanda, então não há duplicidade).
 */
export function nfceCall(
  order: Order,
  rec: NfceCloudRecord | undefined,
  pending: ReadonlySet<string>,
  forced: boolean,
  nowMs: number,
): NfceCallMode | null {
  if (order.status !== 'CLOSED' || toCents(order.total_amount) <= 0 || toCents(order.paid_amount) <= 0 || pending.has(order.id)) return null;
  const due = forced || (!!rec?.next_attempt_at && Date.parse(rec.next_attempt_at) <= nowMs);
  if (rec?.status === 'cancelled') return null;
  if (rec?.status === 'authorized') {
    if (!missingPrintData(rec)) return null;
    return due ? 'consult' : null;
  }
  if (OPEN_ORDER_STATUSES.includes(order.nfce_status ?? '')) {
    if (!rec || due) return 'emit';
    return null;
  }
  // Situação local final sem documento do servidor: NFC-e simulada antes da emissão real.
  if (order.nfce_status !== 'AUTORIZADA') return null;
  if (rec && rec.status !== null) return due ? 'emit' : null;
  if (rec?.problem === 'none') return forced ? 'emit' : null;
  if (!rec) return 'consult';
  return due ? 'consult' : null;
}

/** Compatível com a regra antiga: há chamada a fazer, se pedida já? */
export function nfceEligible(order: Order, pending: ReadonlySet<string>, rec?: NfceCloudRecord): boolean {
  return nfceCall(order, rec, pending, true, Date.now()) !== null;
}

/** Comandas a pedir/consultar agora, das mais antigas para as mais novas. */
export function dueNfceCalls(state: NfceQueueState, nowMs: number, limit = 3): Array<{ orderId: string; mode: NfceCallMode }> {
  const pending = ordersWithPendingEvents([...state.outbox, ...(state.syncRejected ?? []).map((r) => r.event)]);
  const records = state.nfceCloud ?? {};
  const forced = new Set(state.nfceForced ?? []);
  const out: Array<{ orderId: string; mode: NfceCallMode; closed: string }> = [];
  for (const o of state.orders) {
    const mode = nfceCall(o, records[o.id], pending, forced.has(o.id), nowMs);
    if (mode) out.push({ orderId: o.id, mode, closed: o.closed_at ?? '' });
  }
  return out
    .sort((a, b) => a.closed.localeCompare(b.closed))
    .slice(0, limit)
    .map(({ orderId, mode }) => ({ orderId, mode }));
}

/**
 * A chamada que esta comanda pede agora, conferida de novo no estado atual (situação, fila,
 * recusados, registro e botão). A rodada usa antes de cada chamada: a lista escolhida no
 * começo pode ter mudado durante a chamada anterior (comanda reaberta, evento novo na fila).
 */
export function nfceCallNow(state: NfceQueueState, orderId: string, nowMs: number): NfceCallMode | null {
  const order = state.orders.find((o) => o.id === orderId);
  if (!order) return null;
  const pending = ordersWithPendingEvents([...state.outbox, ...(state.syncRejected ?? []).map((r) => r.event)]);
  return nfceCall(order, state.nfceCloud?.[orderId], pending, (state.nfceForced ?? []).includes(orderId), nowMs);
}

export function dueNfceOrders(state: NfceQueueState, nowMs: number, limit = 3): string[] {
  return dueNfceCalls(state, nowMs, limit).map((c) => c.orderId);
}
