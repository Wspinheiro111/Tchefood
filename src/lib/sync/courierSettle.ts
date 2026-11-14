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
}

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

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v));

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
      }),
    });
  } catch {
    // Sem o texto do navegador ("Failed to fetch"): não diz nada ao operador.
    return { ok: false, refused: false, message: 'Sem resposta da nuvem.' };
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    let raw = '';
    let detail: { delivery_id?: UUID; settlement_id?: UUID } | undefined;
    try {
      const body = JSON.parse(text) as { message?: unknown; details?: unknown };
      raw = typeof body.message === 'string' ? body.message : '';
      detail = parseDetail(body.details);
    } catch {
      // resposta sem JSON: fica o texto
      raw = text;
    }
    const code = /^\s*(TCHEFOOD_[A-Z_]+):/.exec(raw)?.[1];
    // 4xx é a recusa do banco (definitiva); 5xx e afins, a nuvem não respondeu direito.
    const refused = res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 408 && res.status !== 429;
    if (!refused) return { ok: false, refused, message: `A nuvem não confirmou o acerto (erro ${res.status}).` };
    const message = code === 'TCHEFOOD_ENTREGA_JA_ACERTADA'
      ? 'Uma das entregas já foi acertada com o entregador (em outro aparelho).'
      : cleanCloudMessage(raw) || `Erro ${res.status}.`;
    return { ok: false, refused, message, ...(code ? { code } : {}), ...(detail ? { detail } : {}) };
  }
  let body: unknown = null;
  try {
    body = JSON.parse(text || 'null');
  } catch {
    // cai na conferência abaixo
  }
  const settlement = parseSettlementRow(body);
  if (!settlement || settlement.id !== req.id) {
    return { ok: false, refused: false, message: 'Resposta inválida da nuvem ao acerto.' };
  }
  return { ok: true, settlement };
}
