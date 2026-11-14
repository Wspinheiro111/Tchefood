import { describe, expect, it } from "vitest";
import { DeliveryRepositoryError, SupabaseDeliveryRepository, type RestFetch } from "./supabaseDeliveryRepository";

describe("gravação no Supabase", () => {
  it("prazo estourado cancela a requisição de verdade (abort chega ao fetch)", async () => {
    let signal: AbortSignal | undefined;
    const fetchImpl: RestFetch = (_url, init) => {
      signal = init.signal;
      return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    };
    const repository = new SupabaseDeliveryRepository({ url: "https://x.supabase.co", serviceRoleKey: "s", channel: "ifood", fetchImpl, timeoutMs: 10 });
    await expect(repository.hasEvent("ifood", "e1")).rejects.toBeInstanceOf(DeliveryRepositoryError);
    expect(signal?.aborted).toBe(true);
  });

  it("manda a chave service_role e o nome da função", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body?: string }> = [];
    const fetchImpl: RestFetch = async (url, init) => {
      calls.push({ url, headers: init.headers, body: init.body });
      return { ok: true, status: 200, text: async () => "true" };
    };
    const repository = new SupabaseDeliveryRepository({ url: "https://x.supabase.co/", serviceRoleKey: "segredo", channel: "ifood", fetchImpl });
    expect(await repository.hasEvent("ifood", "e1")).toBe(true);
    expect(calls[0]!.url).toBe("https://x.supabase.co/rest/v1/rpc/tchefood_delivery_has_event");
    expect(calls[0]!.headers.authorization).toBe("Bearer segredo");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ p_channel: "ifood", p_external_event_id: "e1" });
  });

  it("lê a reserva do pedido de cancelamento gravada no banco", async () => {
    let row: Record<string, unknown> = {};
    const fetchImpl: RestFetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(row) });
    const repository = new SupabaseDeliveryRepository({ url: "https://x.supabase.co", serviceRoleKey: "s", channel: "ifood", fetchImpl });
    const base = { order: { channel: "ifood", externalId: "o1" }, version: 1 };
    row = { ...base, cancellationRequest: { state: "sent", reservedAt: "2026-11-14T15:00:00.000Z", code: "503" } };
    expect((await repository.getOrder("ifood", "o1"))!.cancellationRequest).toEqual({ state: "sent", reservedAt: "2026-11-14T15:00:00.000Z", code: "503" });
    row = { ...base, cancellationRequest: null };
    expect((await repository.getOrder("ifood", "o1"))!.cancellationRequest).toBeNull();
    // Estado desconhecido não libera um segundo cancelamento: vira incerto.
    row = { ...base, cancellationRequest: { state: "???", reservedAt: "2026-11-14T15:00:00.000Z" } };
    expect((await repository.getOrder("ifood", "o1"))!.cancellationRequest?.state).toBe("uncertain");
  });
});
