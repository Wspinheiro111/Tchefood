import { DeliveryConcurrencyError, type DeliveryOrderRecord, type DeliveryRepository } from "./deliveryInbox";
import type { DeliveryChannelKey, DeliveryEvent } from "./marketplace";

// Persistência da caixa de entrada de delivery no Supabase, pelo PostgREST, com a chave service_role.
// Só as funções de db/schema_delivery_servidor.sql são chamadas (o app não grava nessas tabelas).
// A chave service_role fica só no servidor; nunca no navegador nem no repositório.

export type RestFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export type SupabaseDeliveryRepositoryOptions = {
  url: string;
  serviceRoleKey: string;
  channel: DeliveryChannelKey;
  fetchImpl?: RestFetch;
  timeoutMs?: number;
};

export type DeliveryMerchantLink = { tenantId: string; merchantExternalId: string };

export class DeliveryRepositoryError extends Error {
  constructor(message: string, readonly httpStatus: number | null = null) {
    super(message);
    this.name = "DeliveryRepositoryError";
  }
}

export class SupabaseDeliveryRepository implements DeliveryRepository {
  private readonly base: string;
  private readonly fetchImpl: RestFetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: SupabaseDeliveryRepositoryOptions) {
    if (!/^https?:\/\//.test(options.url)) throw new Error("SUPABASE_URL inválida.");
    if (!options.serviceRoleKey.trim()) throw new Error("Informe a SUPABASE_SERVICE_ROLE_KEY.");
    this.base = options.url.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async activeMerchants(): Promise<DeliveryMerchantLink[]> {
    const rows = await this.rpc("tchefood_delivery_active_merchants", { p_channel: this.options.channel });
    if (!Array.isArray(rows)) throw new DeliveryRepositoryError("Lista de lojas inválida.");
    return rows.map((row) => {
      const record = row as Record<string, unknown>;
      if (typeof record.tenantId !== "string" || typeof record.merchantExternalId !== "string") {
        throw new DeliveryRepositoryError("Loja de delivery inválida.");
      }
      return { tenantId: record.tenantId, merchantExternalId: record.merchantExternalId };
    });
  }

  async hasEvent(channel: DeliveryChannelKey, externalEventId: string): Promise<boolean> {
    return (await this.rpc("tchefood_delivery_has_event", { p_channel: channel, p_external_event_id: externalEventId })) === true;
  }

  async recordEvent(event: DeliveryEvent): Promise<void> {
    const { dispute: _dispute, ...summary } = event;
    await this.rpc("tchefood_delivery_record_event", { p_event: summary });
  }

  async getOrder(channel: DeliveryChannelKey, externalOrderId: string): Promise<DeliveryOrderRecord | null> {
    const row = await this.rpc("tchefood_delivery_get_order", { p_channel: channel, p_external_id: externalOrderId });
    return row === null ? null : toRecord(row);
  }

  async saveOrder(record: DeliveryOrderRecord): Promise<number> {
    const version = await this.rpc("tchefood_delivery_save_order", {
      p_channel: record.order.channel,
      p_expected_version: record.version,
      p_record: record,
    });
    // NULL = outra gravação passou na frente: nada foi gravado.
    if (version === null) throw new DeliveryConcurrencyError(record.order.channel, record.order.externalId);
    if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
      throw new DeliveryRepositoryError("Versão gravada inválida.");
    }
    return version;
  }

  async listOrders(): Promise<DeliveryOrderRecord[]> {
    const rows = await this.rpc("tchefood_delivery_list_orders", { p_channel: this.options.channel, p_limit: 200 });
    if (!Array.isArray(rows)) throw new DeliveryRepositoryError("Lista de pedidos inválida.");
    return rows.map(toRecord);
  }

  private async rpc(fn: string, args: Record<string, unknown>): Promise<unknown> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new DeliveryRepositoryError(`Supabase não respondeu (${fn}).`));
      }, this.timeoutMs);
    });
    const exchange = (async () => {
      const response = await this.fetchImpl(`${this.base}/rest/v1/rpc/${fn}`, {
        method: "POST",
        headers: {
          apikey: this.options.serviceRoleKey,
          authorization: `Bearer ${this.options.serviceRoleKey}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        // O Postgres recusa o caractere NUL em texto e JSONB ("unsupported Unicode escape sequence"): um NUL vindo
        // do app (observação, nome) deixaria o pedido sem gravar e o evento sem ack para sempre. Sai antes de gravar.
        body: JSON.stringify(args, (_key, value: unknown) => (typeof value === "string" ? value.replace(/\u0000/g, "") : value)),
        // O signal libera a conexão quando o prazo vence. Não garante que nada foi gravado: se o Postgres já
        // recebeu a chamada, ele termina a transação mesmo com o abort. Isso é seguro porque toda gravação é
        // idempotente ou leva a versão lida (o evento tem id único; o pedido só grava com a versão esperada, e a
        // repetição recebe conflito e relê), então refazer a chamada que "falhou" nunca duplica nem sobrescreve.
        signal: controller.signal,
      });
      return { status: response.status, ok: response.ok, text: await response.text() };
    })();
    try {
      const response = await Promise.race([exchange, deadline]);
      if (!response.ok) {
        let detail = "";
        try {
          const body = JSON.parse(response.text) as { message?: unknown };
          detail = typeof body.message === "string" ? body.message.slice(0, 200) : "";
        } catch {
          detail = "";
        }
        throw new DeliveryRepositoryError(`Supabase recusou ${fn} (HTTP ${response.status})${detail ? `: ${detail}` : ""}.`, response.status);
      }
      if (!response.text.trim()) return null;
      try {
        return JSON.parse(response.text) as unknown;
      } catch {
        throw new DeliveryRepositoryError(`Resposta de ${fn} não é JSON.`);
      }
    } catch (error) {
      if (error instanceof DeliveryRepositoryError) throw error;
      throw new DeliveryRepositoryError(`Falha de rede no Supabase (${fn}).`);
    } finally {
      clearTimeout(timer);
      exchange.catch(() => undefined);
    }
  }
}

function toRecord(raw: unknown): DeliveryOrderRecord {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new DeliveryRepositoryError("Pedido gravado inválido.");
  const row = raw as Record<string, unknown>;
  const version = row.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) throw new DeliveryRepositoryError("Pedido gravado sem versão.");
  if (row.order === null || typeof row.order !== "object") throw new DeliveryRepositoryError("Pedido gravado sem o pedido do app.");
  const iso = (value: unknown): string | null => (typeof value === "string" && value ? new Date(value).toISOString() : null);
  return {
    order: row.order as DeliveryOrderRecord["order"],
    cancellationPending: row.cancellationPending === true,
    cancellationRequest: cancellationRequest(row.cancellationRequest),
    needsReview: row.needsReview === true,
    reviewReasons: Array.isArray(row.reviewReasons) ? row.reviewReasons.filter((reason): reason is string => typeof reason === "string") : [],
    newOrderNotified: row.newOrderNotified === true,
    lastCancellationEventAt: iso(row.lastCancellationEventAt),
    lastEventAt: iso(row.lastEventAt) ?? new Date(0).toISOString(),
    updatedAt: iso(row.updatedAt) ?? new Date(0).toISOString(),
    dispute: (row.dispute ?? null) as DeliveryOrderRecord["dispute"],
    version,
  };
}

// Reserva do pedido de cancelamento. Estado desconhecido vira "incerta" (bloqueia até expirar); sem horário legível
// a reserva conta como já expirada, para não travar o cancelamento para sempre.
function cancellationRequest(raw: unknown): DeliveryOrderRecord["cancellationRequest"] {
  if (raw === null || raw === undefined) return null;
  const value = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const reservedAt = typeof value.reservedAt === "string" && Number.isFinite(Date.parse(value.reservedAt)) ? value.reservedAt : new Date(0).toISOString();
  const state = value.state === "sending" || value.state === "sent" || value.state === "uncertain" ? value.state : "uncertain";
  return { state, reservedAt, ...(typeof value.code === "string" ? { code: value.code } : {}) };
}

// Chamada ao Supabase com prazo: estourado o prazo, a requisição é cancelada (abort) e a chamada falha com
// DeliveryRepositoryError. Devolve status e corpo já lidos. O abort só libera a conexão: o que o banco já
// recebeu ele termina (ver o comentário em rpc), então quem chama trata a falha como "pode ter gravado".
export async function fetchWithDeadline(
  fetchImpl: RestFetch,
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
  timeoutMs: number,
  label: string,
): Promise<{ ok: boolean; status: number; text: string }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new DeliveryRepositoryError(`Supabase não respondeu (${label}).`));
    }, timeoutMs);
  });
  const exchange = (async () => {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    return { ok: response.ok, status: response.status, text: await response.text() };
  })();
  try {
    return await Promise.race([exchange, deadline]);
  } catch (error) {
    if (error instanceof DeliveryRepositoryError) throw error;
    throw new DeliveryRepositoryError(`Falha de rede no Supabase (${label}).`);
  } finally {
    clearTimeout(timer);
    exchange.catch(() => undefined);
  }
}
