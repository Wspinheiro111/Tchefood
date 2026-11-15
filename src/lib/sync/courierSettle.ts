/**
 * Acerto com o entregador pela nuvem (db/schema_contas_aparelhos.sql, seção 10; auditoria
 * interna, rodada 8 do PR #54). Com a loja ligada à nuvem, o acerto é gravado primeiro no
 * banco (tchefood_settle_courier, que trava as entregas e recusa a entrega já acertada em
 * outro aparelho) e só depois o ganho sai da gaveta, como uma sangria comum. Sem internet
 * não há acerto: a nuvem confirma antes de sair dinheiro da gaveta.
 */
import type { CourierSettlement, UUID } from '../../types';
import type { FetchLike, SyncConfig } from './supabaseSync';

export interface CourierSettleRequest {
  /** Id do acerto, gerado no aparelho: a mesma chamada repetida devolve o mesmo acerto. */
  id: UUID;
  courier_id: UUID;
  delivery_ids: UUID[];
  cash_collected: number;
  courier_fees: number;
  staff_id: UUID;
  /** PIN de quem acertou: a nuvem confere (GPT, rodada 10 do PR #54). */
  staff_pin: string;
}

/** A nuvem não aceitou o PIN de quem acertou (ou está bloqueado por tentativas). */
export const COURIER_SETTLE_PIN_REFUSED = 'A nuvem recusou o PIN de quem está acertando. Saia e entre de novo com o seu PIN atual.';

export type CourierSettleResult =
  | { ok: true; settlement: CourierSettlement }
  /**
   * refused: a nuvem respondeu e recusou (definitivo); senão, a rede falhou (pode ter gravado:
   * tente de novo com o mesmo id). message: para o operador, sem o código TCHEFOOD_, sem id e sem
   * "Nada saiu da gaveta" (quem mostra acrescenta uma vez). code e detail: os da recusa do banco.
   */
  | { ok: false; refused: boolean; message: string; code?: string; detail?: { delivery_id?: UUID; settlement_id?: UUID } };

/**
 * Acerto mandado à nuvem sem resposta (pode ter sido gravado). Fica guardado no aparelho
 * (persistido) e é repetido só com o mesmo id e os mesmos termos, à parte de entregas novas
 * (auditoria interna, rodada 8 do PR #54).
 */
export interface CourierSettlePendingEntry {
  id: UUID;
  courier_id: UUID;
  courier_name: string;
  delivery_ids: UUID[];
  cash_collected: number;
  courier_fees: number;
  /** Os termos mandados (entregas, ganho e dinheiro): a repetição manda exatamente estes. */
  terms: string;
  created_at: string;
  /**
   * O que a primeira tentativa ia receber de cada senha paga na entrega (valor em reais, exato em
   * centavos). A repetição recebe isto, não o saldo de agora; ausente em pendentes antigas.
   */
  planned?: { delivery_id: UUID; order_id: UUID; pickup_number: number | null; amount: number }[];
  /** Quem fez a primeira tentativa: a repetição vai no nome dele (ausente em pendentes antigas). */
  staff_id?: UUID;
}

/**
 * Acerto que a nuvem gravou e que ficou com pendência neste aparelho: senha paga na entrega não
 * recebida ou sangria do ganho não feita. Fica no quadro da entrega até ser terminado
 * (auditoria interna, rodada 8 do PR #54).
 */
export interface CourierSettleFollowUp {
  settlement_id: UUID;
  courier_id: UUID;
  courier_name: string;
  delivery_ids: UUID[];
  cash_collected: number;
  courier_fees: number;
  missing_payments: { delivery_id: UUID; order_id: UUID; pickup_number: number | null; amount: number; error: string }[];
  /** Sangria do ganho ainda não feita (null = nada a fazer pela gaveta). */
  missing_withdrawal: { amount: number; error: string } | null;
  created_at: string;
}

/** Entregas que este aparelho acertou há pouco: a leitura velha não as devolve para "sem acerto". */
export interface CourierSettledRecently {
  settlement_id: UUID;
  delivery_ids: UUID[];
  /** Date.now() da resposta da nuvem. */
  at: number;
}

/** Quanto tempo a marca local do acerto vale contra uma leitura que ainda não o mostra. */
export const COURIER_SETTLED_KEEP_MS = 2 * 60_000;

const UUID_RE = /\s*\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/** Texto do banco para o operador: sem o código TCHEFOOD_*, sem ids e sem "Nada sai(u) da gaveta". */
export function cleanCloudMessage(raw: string): string {
  const text = raw
    .replace(/^\s*TCHEFOOD_[A-Z_]+:\s*/, '')
    .replace(UUID_RE, '')
    .replace(/\s*Nada sai(u)? da gaveta[^.]*\.?/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}

function parseDetail(raw: unknown): { delivery_id?: UUID; settlement_id?: UUID } | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  try {
    const d = JSON.parse(raw) as Record<string, unknown>;
    return {
      ...(typeof d.delivery_id === 'string' ? { delivery_id: d.delivery_id } : {}),
      ...(typeof d.settlement_id === 'string' ? { settlement_id: d.settlement_id } : {}),
    };
  } catch {
    return undefined;
  }
}

export const COURIER_SETTLE_OFFLINE =
  'Acerto do entregador precisa da internet nesta loja: a nuvem confirma antes de sair dinheiro da gaveta.';

// Só número ou texto numérico: null, '', booleano e lista viram NaN (Number(null) === 0 aceitaria
// um acerto sem valor como zero).
const num = (v: unknown): number =>
  typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN;

/** Linha devolvida pela função (to_jsonb de courier_settlements) no formato do aparelho. */
export function parseSettlementRow(body: unknown): CourierSettlement | null {
  if (!body || typeof body !== 'object') return null;
  const r = body as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.tenant_id !== 'string' || typeof r.courier_id !== 'string' || typeof r.settled_by_user_id !== 'string') return null;
  const ids = Array.isArray(r.delivery_ids) ? r.delivery_ids.filter((x): x is string => typeof x === 'string') : undefined;
  const deliveries = num(r.deliveries);
  const cash = num(r.cash_collected);
  const fees = num(r.courier_fees);
  if (![deliveries, cash, fees].every(Number.isFinite)) return null;
  return {
    id: r.id,
    tenant_id: r.tenant_id,
    courier_id: r.courier_id,
    deliveries,
    cash_collected: cash,
    courier_fees: fees,
    cash_movement_id: typeof r.cash_movement_id === 'string' ? r.cash_movement_id : null,
    ...(ids ? { delivery_ids: ids } : {}),
    settled_by_user_id: r.settled_by_user_id,
    created_at: typeof r.created_at === 'string' ? r.created_at : new Date().toISOString(),
  };
}

export async function settleCourierInCloud(cfg: SyncConfig, req: CourierSettleRequest, fetchFn: FetchLike): Promise<CourierSettleResult> {
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchFn(`${cfg.url.replace(/\/+$/, '')}/rest/v1/rpc/tchefood_settle_courier`, {
      method: 'POST',
      headers: { apikey: cfg.anonKey, Authorization: `Bearer ${cfg.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        p_id: req.id,
        p_courier: req.courier_id,
        p_delivery_ids: req.delivery_ids,
        p_cash_collected: req.cash_collected,
        p_courier_fees: req.courier_fees,
        p_staff: req.staff_id,
        p_staff_pin: req.staff_pin,
      }),
    });
  } catch {
    // Sem o texto do navegador ("Failed to fetch"): não diz nada ao operador.
    return { ok: false, refused: false, message: 'Sem resposta da nuvem.' };
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    let raw = '';
    let pgCode = '';
    let detail: { delivery_id?: UUID; settlement_id?: UUID } | undefined;
    try {
      const body = JSON.parse(text) as { message?: unknown; details?: unknown; code?: unknown };
      raw = typeof body.message === 'string' ? body.message : '';
      pgCode = typeof body.code === 'string' && /^[A-Z0-9]{1,12}$/.test(body.code) ? body.code : '';
      detail = parseDetail(body.details);
    } catch {
      // resposta sem JSON: fica o texto (só serve se trouxer o código TCHEFOOD_)
      raw = text;
    }
    const code = /^\s*(TCHEFOOD_[A-Z_]+):/.exec(raw)?.[1];
    // 4xx é a recusa do banco (definitiva); 5xx e afins, a nuvem não respondeu direito.
    const refused = res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 408 && res.status !== 429;
    if (!refused) return { ok: false, refused, message: `A nuvem não confirmou o acerto (erro ${res.status}).` };
    // Sem código TCHEFOOD_ o texto é do PostgREST/Postgres (em inglês, técnico): não vai ao
    // operador; fica só o status e o código, para o suporte.
    const generic = `Erro ${res.status}${pgCode ? ` (${pgCode})` : ''} da nuvem. Atualize o aplicativo ou fale com o suporte.`;
    const message = code === 'TCHEFOOD_ENTREGA_JA_ACERTADA'
      ? 'Uma das entregas já foi acertada com o entregador (em outro aparelho).'
      : (code ? cleanCloudMessage(raw) : '') || generic;
    return { ok: false, refused, message, ...(code ? { code } : {}), ...(detail ? { detail } : {}) };
  }
  let body: unknown = null;
  try {
    body = JSON.parse(text || 'null');
  } catch {
    // cai na conferência abaixo
  }
  // PIN recusado: a função responde sem erro (para a falha ficar no registro), e é definitivo:
  // nada foi gravado (GPT, rodada 10 do PR #54). O "Nada saiu da gaveta" quem mostra acrescenta.
  if (body && typeof body === 'object' && (body as { error?: unknown }).error === 'TCHEFOOD_PIN_RECUSADO') {
    return { ok: false, refused: true, message: COURIER_SETTLE_PIN_REFUSED, code: 'TCHEFOOD_PIN_RECUSADO' };
  }
  const settlement = parseSettlementRow(body);
  if (!settlement || settlement.id !== req.id) {
    return { ok: false, refused: false, message: 'Resposta inválida da nuvem ao acerto.' };
  }
  return { ok: true, settlement };
}
