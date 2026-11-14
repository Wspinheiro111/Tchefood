import { describe, expect, it, vi } from "vitest";
import { DeliveryInbox, InMemoryDeliveryRepository } from "../deliveryInbox";
import { DeliveryRepositoryError } from "../supabaseDeliveryRepository";
import { IfoodMerchantApi } from "./ifoodMerchantApi";
import { IfoodSandbox } from "./ifoodSandbox";
import {
  createIfoodApiHandler,
  IfoodPoller,
  SupabaseCallerAuthorizer,
  SupabaseManagerApproval,
  type ApiRequest,
  type ManagerApproval,
  type ManagerRequest,
  type TenantAuthorizer,
} from "./ifoodServer";

const ITEMS = [{ name: "Xis Galpão", externalCode: "301", quantity: 1, unitPrice: 38 }];
const NOW = new Date("2026-11-14T15:00:00.000Z");
const MANAGER_PIN = "7391";
const auth = (extra: Partial<{ managerPin: string; reason: string; requestId: string }> = {}) => ({
  managerPin: MANAGER_PIN,
  performedBy: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  reason: "Cliente ligou desistindo",
  requestId: crypto.randomUUID(),
  ...extra,
});
const ALLOW_ALL: ManagerApproval = { authorize: async () => ({ status: "OK", auditId: "a1" }), recordResult: async () => undefined };

// Gerente falso: PIN certo = 7391; guarda as autorizações e os resultados.
function fakeApproval() {
  const authorized: ManagerRequest[] = [];
  const results: Array<{ auditId: string; outcome: string; detail: string }> = [];
  const byRequest = new Map<string, string>();
  const approval: ManagerApproval = {
    authorize: async (_token, request) => {
      if (request.managerPin !== MANAGER_PIN) return { status: "PIN_FAILED", message: "PIN de gerente incorreto." };
      // Mesmo id da tentativa: devolve a autorização já gravada (como tchefood_delivery_authorize).
      const existing = byRequest.get(request.requestId);
      if (existing) return { status: "OK", auditId: existing, repeated: true };
      authorized.push(request);
      byRequest.set(request.requestId, `audit-${authorized.length}`);
      return { status: "OK", auditId: `audit-${authorized.length}` };
    },
    recordResult: async (auditId, outcome, detail) => {
      results.push({ auditId, outcome, detail });
    },
  };
  return { approval, authorized, results };
}

function setup(options: { merchants?: string[]; authorizer?: TenantAuthorizer } = {}) {
  const manager = fakeApproval();
  const sandbox = new IfoodSandbox(undefined, undefined, () => NOW);
  const api = new IfoodMerchantApi({
    credentials: { clientId: sandbox.clientId, clientSecret: sandbox.clientSecret },
    baseUrl: sandbox.baseUrl,
    fetchImpl: sandbox.fetch,
  });
  const repository = new InMemoryDeliveryRepository();
  const inbox = new DeliveryInbox({ adapters: [api], repository, now: () => NOW });
  const merchants = { activeMerchants: vi.fn(async () => (options.merchants ?? [sandbox.merchantId]).map((merchantExternalId) => ({ merchantExternalId }))) };
  const poller = new IfoodPoller({ api, inbox, merchants, now: () => NOW.getTime() });
  // Loja do token "loja-a": vê tudo; "loja-b": não vê nada (outro tenant).
  const authorizer: TenantAuthorizer = options.authorizer ?? {
    canAccessOrder: async (token) => token === "loja-a",
    canAccessMerchant: async (token) => token === "loja-a",
  };
  const handle = createIfoodApiHandler({ inbox, api, authorizer, approval: manager.approval, poller, now: () => NOW });
  const call = (method: string, path: string, body?: unknown, token = "loja-a") =>
    handle({ method, path, headers: { authorization: token ? `Bearer ${token}` : undefined }, body: body === undefined ? "" : JSON.stringify(body) } satisfies ApiRequest);
  return { sandbox, api, inbox, poller, merchants, call, manager };
}

describe("servidor do iFood: polling", () => {
  it("busca só as lojas ligadas e grava os pedidos", async () => {
    const { sandbox, poller, inbox } = setup();
    sandbox.placeOrder({ items: ITEMS });
    const report = await poller.runOnce();
    expect(report).toMatchObject({ received: 1, acknowledged: 1 });
    expect(await inbox.listOrders()).toHaveLength(1);
    expect(poller.snapshot()).toMatchObject({ merchants: 1, lastError: null, lastCycleAt: NOW.toISOString() });
  });

  it("sem loja ligada não faz polling (o iFood mandaria eventos que ninguém grava)", async () => {
    const { sandbox, poller } = setup({ merchants: [] });
    sandbox.placeOrder({ items: ITEMS });
    expect(await poller.runOnce()).toBeNull();
    expect(sandbox.stats.polls).toBe(0);
  });

  it("evento de loja que saiu da lista não chega (header x-polling-merchants)", async () => {
    const { sandbox, poller } = setup({ merchants: ["11111111-2222-4333-8444-555555555555"] });
    sandbox.placeOrder({ items: ITEMS });
    const report = await poller.runOnce();
    expect(report?.received).toBe(0);
    expect(sandbox.pendingEventCount()).toBe(1);
  });

  it("merchantId inválido numa integração não derruba o polling das outras lojas", async () => {
    const log = vi.fn();
    const sandbox = new IfoodSandbox(undefined, undefined, () => NOW);
    const api = new IfoodMerchantApi({ credentials: { clientId: sandbox.clientId, clientSecret: sandbox.clientSecret }, baseUrl: sandbox.baseUrl, fetchImpl: sandbox.fetch });
    const inbox = new DeliveryInbox({ adapters: [api], repository: new InMemoryDeliveryRepository(), now: () => NOW });
    const merchants = { activeMerchants: async () => [{ merchantExternalId: `${sandbox.merchantId} ` }, { merchantExternalId: sandbox.merchantId }] };
    const poller = new IfoodPoller({ api, inbox, merchants, log, now: () => NOW.getTime() });
    sandbox.placeOrder({ items: ITEMS });
    const report = await poller.runOnce();
    expect(report).toMatchObject({ received: 1, acknowledged: 1 });
    expect(poller.snapshot()).toMatchObject({ merchants: 1, invalidMerchants: 1 });
    expect(poller.snapshot().lastError).toMatch(/merchantId inválido/);
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`merchantId inválido, fora do polling: "${sandbox.merchantId} "`));
  });

  it("só merchantId inválido: não faz polling e o status mostra o erro", async () => {
    const { sandbox, poller } = setup({ merchants: ["loja errada"] });
    sandbox.placeOrder({ items: ITEMS });
    expect(await poller.runOnce()).toBeNull();
    expect(sandbox.stats.polls).toBe(0);
    expect(poller.snapshot()).toMatchObject({ merchants: 0, invalidMerchants: 1 });
    expect(poller.snapshot().lastError).toMatch(/merchantId inválido/);
  });

  it("falha ao ler as lojas não derruba o servidor", async () => {
    const { poller, merchants } = setup();
    merchants.activeMerchants.mockRejectedValueOnce(new Error("banco fora do ar"));
    expect(await poller.runOnce()).toBeNull();
    expect(poller.snapshot().lastError).toMatch(/banco fora do ar/);
  });

  it("ciclos nunca se sobrepõem e respeitam o intervalo", async () => {
    vi.useFakeTimers();
    try {
      const sandbox = new IfoodSandbox();
      const api = new IfoodMerchantApi({ credentials: { clientId: sandbox.clientId, clientSecret: sandbox.clientSecret }, baseUrl: sandbox.baseUrl, fetchImpl: sandbox.fetch });
      const inbox = new DeliveryInbox({ adapters: [api], repository: new InMemoryDeliveryRepository() });
      let active = 0;
      let maxActive = 0;
      let cycles = 0;
      const merchants = {
        activeMerchants: async () => {
          active += 1;
          cycles += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 40_000));
          active -= 1;
          return [{ merchantExternalId: sandbox.merchantId }];
        },
      };
      const poller = new IfoodPoller({ api, inbox, merchants, intervalMs: 30_000 });
      poller.start();
      await vi.advanceTimersByTimeAsync(150_000);
      expect(maxActive).toBe(1);
      expect(cycles).toBeGreaterThanOrEqual(3);
      const stopping = poller.stop();
      await vi.advanceTimersByTimeAsync(40_000);
      await stopping;
      const after = cycles;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(cycles).toBe(after);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("servidor do iFood: API do app", () => {
  it("sem sessão: 401; pedido de outra loja: 404 sem tocar no iFood", async () => {
    const { sandbox, poller, call } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await poller.runOnce();
    expect((await call("POST", `/ifood/orders/${id}/actions/confirm`, undefined, "")).status).toBe(401);
    expect((await call("POST", `/ifood/orders/${id}/actions/confirm`, undefined, "loja-b")).status).toBe(404);
    expect(sandbox.lastEventCode(id)).toBe("PLC");
  });

  it("confirma e devolve o pedido sem a versão interna; ação fora de ordem é 409", async () => {
    const { sandbox, poller, call } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await poller.runOnce();
    const confirmed = await call("POST", `/ifood/orders/${id}/actions/confirm`);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).not.toHaveProperty("version");
    expect(sandbox.lastEventCode(id)).toBe("CFM");
    expect((await call("POST", `/ifood/orders/${id}/actions/dispatch`)).status).toBe(409);
    expect((await call("POST", `/ifood/orders/${id}/actions/voar`)).status).toBe(404);
  });

  it("cancelamento só com motivo que o iFood oferece agora para o pedido", async () => {
    const { sandbox, poller, call } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await poller.runOnce();
    const reasons = await call("GET", `/ifood/orders/${id}/cancellation-reasons`);
    expect(reasons.status).toBe(200);
    expect((await call("POST", `/ifood/orders/${id}/cancellation`, { code: "999", description: "Inventado", authorization: auth() })).status).toBe(400);
    expect((await call("POST", `/ifood/orders/${id}/cancellation`, {})).status).toBe(400);
    expect(sandbox.lastEventCode(id)).toBe("PLC");
    const ok = await call("POST", `/ifood/orders/${id}/cancellation`, { code: "503", description: "Item indisponível", authorization: auth() });
    expect(ok.status).toBe(200);
    expect(sandbox.lastEventCode(id)).toBe("CAN");
  });

  it("resposta à negociação valida o corpo", async () => {
    const { sandbox, poller, call } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await poller.runOnce();
    sandbox.openDispute(id);
    await poller.runOnce();
    expect((await call("POST", `/ifood/orders/${id}/dispute`, { kind: "reject", authorization: auth() })).status).toBe(400);
    expect((await call("POST", `/ifood/orders/${id}/dispute`, { kind: "talvez", authorization: auth() })).status).toBe(400);
    const rejected = await call("POST", `/ifood/orders/${id}/dispute`, { kind: "reject", reason: "Pedido já saiu", authorization: auth() });
    expect(rejected.status).toBe(200);
    expect(sandbox.eventHistory().at(-1)?.code).toBe("HSS");
  });

  it("negociação: motivo do aceite, valor e prazo da proposta conferidos antes do PIN e enviados ao iFood", async () => {
    const { sandbox, poller, inbox, call, manager } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await poller.runOnce();
    const cancel =sandbox.openDispute(id, { acceptCancellationReasons: ["HIGH_STORE_DEMAND"] });
    await poller.runOnce();
    const path = `/ifood/orders/${id}/dispute`;
    const missing = await call("POST", path, { kind: "accept", authorization: auth() });
    expect(missing).toMatchObject({ status: 400, body: { error: expect.stringMatching(/motivo do aceite/) } });
    expect((await call("POST", path, { kind: "accept", reason: "INVENTADO", authorization: auth() })).status).toBe(400);
    expect(manager.authorized).toHaveLength(0);
    const accepted = await call("POST", path, { kind: "accept", reason: "HIGH_STORE_DEMAND", detailReason: "Fila grande", authorization: auth() });
    expect(accepted.status).toBe(200);
    expect(sandbox.eventHistory().find((event) => event.code === "HSS")?.metadata).toMatchObject({ disputeId: cancel, status: "ACCEPTED", reason: "HIGH_STORE_DEMAND" });

    const other = sandbox.placeOrder({ items: ITEMS });
    await poller.runOnce();
    sandbox.openDispute(other, { alternatives: [{ type: "REFUND", maxAmountCents: 2000 }] });
    await poller.runOnce();
    const alternativeId = (await inbox.listOrders()).find((record) => record.order.externalId === other)!.dispute!.alternatives[0]!.id;
    const otherPath = `/ifood/orders/${other}/dispute`;
    expect((await call("POST", otherPath, { kind: "alternative", alternativeId, authorization: auth() })).status).toBe(400);
    expect((await call("POST", otherPath, { kind: "alternative", alternativeId, amountCents: "15", authorization: auth() })).status).toBe(400);
    expect((await call("POST", otherPath, { kind: "alternative", alternativeId, amountCents: 2500, authorization: auth() })).status).toBe(400);
    expect(manager.authorized).toHaveLength(1);
    expect((await call("POST", otherPath, { kind: "alternative", alternativeId, amountCents: 1500, authorization: auth() })).status).toBe(200);
    expect(sandbox.eventHistory().at(-1)?.metadata).toMatchObject({ status: "ALTERNATIVE_REPLIED", selectedDisputeAlternative: { metadata: { amount: { value: "1500" } } } });
  });

  it("JSON quebrado é 400, não 500", async () => {
    const { sandbox, poller } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await poller.runOnce();
    const handle = createIfoodApiHandler({
      inbox: new DeliveryInbox({ adapters: [], repository: new InMemoryDeliveryRepository() }),
      api: {} as IfoodMerchantApi,
      authorizer: { canAccessOrder: async () => true, canAccessMerchant: async () => true },
      approval: ALLOW_ALL,
    });
    const response = await handle({ method: "POST", path: `/ifood/orders/${id}/dispute`, headers: { authorization: "Bearer x" }, body: "{" });
    expect(response.status).toBe(400);
  });

  it("pausa a loja pelo relógio do servidor, com limite de duração, e retoma", async () => {
    const { sandbox, call } = setup();
    const pauses = `/ifood/merchants/${sandbox.merchantId}/pauses`;
    expect((await call("POST", pauses, { description: "Falta de gás", minutes: 0, authorization: auth() })).status).toBe(400);
    expect((await call("POST", pauses, { description: "Falta de gás", minutes: 24 * 60 + 1, authorization: auth() })).status).toBe(400);
    expect((await call("POST", pauses, { minutes: 30, authorization: auth() })).status).toBe(400);
    const created = await call("POST", pauses, { description: "Falta de gás", minutes: 30, start: "2020-01-01T00:00:00Z", authorization: auth() });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ start: "2026-11-14T15:00:00.000Z", end: "2026-11-14T15:30:00.000Z" });
    expect(((await call("GET", `/ifood/merchants/${sandbox.merchantId}/status`)).body as { state: string }).state).toBe("closed");
    const pauseId = (created.body as { id: string }).id;
    expect((await call("DELETE", `/ifood/merchants/${sandbox.merchantId}/pauses/${pauseId}`)).status).toBe(400);
    expect((await call("DELETE", `/ifood/merchants/${sandbox.merchantId}/pauses/${pauseId}`, { authorization: auth() })).status).toBe(204);
    expect(((await call("GET", `/ifood/merchants/${sandbox.merchantId}/status`)).body as { state: string }).state).toBe("open");
  });

  it("loja de outro tenant não pode ser pausada", async () => {
    const { sandbox, call } = setup();
    const response = await call("POST", `/ifood/merchants/${sandbox.merchantId}/pauses`, { description: "x", minutes: 10, authorization: auth() }, "loja-b");
    expect(response.status).toBe(404);
    expect(sandbox.activeInterruptions()).toHaveLength(0);
  });

  it("erro do iFood vira status claro; erro interno não vaza detalhe", async () => {
    const { sandbox, poller, call } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await poller.runOnce();
    sandbox.failNext("/confirm", 503);
    expect((await call("POST", `/ifood/orders/${id}/actions/confirm`)).status).toBe(503);

    const log = vi.fn();
    const handle = createIfoodApiHandler({
      inbox: { performAction: async () => { throw new Error("senha do banco xyz"); } } as unknown as DeliveryInbox,
      api: {} as IfoodMerchantApi,
      authorizer: { canAccessOrder: async () => true, canAccessMerchant: async () => true },
      approval: ALLOW_ALL,
      log,
    });
    const response = await handle({ method: "POST", path: `/ifood/orders/${id}/actions/confirm`, headers: { authorization: "Bearer x" }, body: "" });
    expect(response).toEqual({ status: 500, body: { error: "Erro interno do servidor de delivery." } });
    expect(log).toHaveBeenCalledOnce();
  });

  it("health não exige sessão nem expõe pedidos", async () => {
    const { call, poller } = setup();
    await poller.runOnce();
    const health = await call("GET", "/health", undefined, "");
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ ok: true, poller: { merchants: 1 } });
  });

  it("health público não devolve o texto do erro (merchantId, resposta do iFood), só se há erro", async () => {
    const { call, poller, merchants } = setup();
    merchants.activeMerchants.mockRejectedValueOnce(new Error("iFood recusou a loja 11111111-2222-4333-8444-555555555555"));
    await poller.runOnce();
    const health = await call("GET", "/health", undefined, "");
    expect(health.body).toEqual({ ok: true, poller: { running: false, merchants: 0, lastCycleAt: NOW.toISOString(), hasError: true } });
    expect(JSON.stringify(health.body)).not.toMatch(/11111111/);
  });
});

describe("servidor do iFood: alçada de gerente", () => {
  it("cancelar sem PIN, motivo ou id da tentativa: 400 sem chamar o iFood nem conferir PIN", async () => {
    const { sandbox, poller, call, manager } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await poller.runOnce();
    const path = `/ifood/orders/${id}/cancellation`;
    const base = { code: "503", description: "Item indisponível" };
    expect((await call("POST", path, base)).status).toBe(400);
    expect((await call("POST", path, { ...base, authorization: auth({ reason: "ok" }) })).status).toBe(400);
    expect((await call("POST", path, { ...base, authorization: auth({ requestId: "1" }) })).status).toBe(400);
    expect((await call("POST", path, { ...base, authorization: { ...auth(), performedBy: "x" } })).status).toBe(400);
    expect(manager.authorized).toHaveLength(0);
    expect(sandbox.lastEventCode(id)).toBe("PLC");
  });

  it("PIN errado: 403, nada no iFood; PIN certo: cancela e grava o resultado", async () => {
    const { sandbox, poller, call, manager } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await poller.runOnce();
    const path = `/ifood/orders/${id}/cancellation`;
    const base = { code: "503", description: "Item indisponível" };
    const denied = await call("POST", path, { ...base, authorization: auth({ managerPin: "0000" }) });
    expect(denied).toMatchObject({ status: 403, body: { code: "PIN_FAILED" } });
    expect(sandbox.lastEventCode(id)).toBe("PLC");
    expect(manager.results).toHaveLength(0);
    const ok = await call("POST", path, { ...base, authorization: auth() });
    expect(ok.status).toBe(200);
    expect(manager.authorized[0]).toMatchObject({ action: "DELIVERY_CANCEL", externalOrderId: id, merchantExternalId: null });
    expect(manager.results).toEqual([{ auditId: "audit-1", outcome: "sent", detail: "HTTP 200" }]);
  });

  it("negociação, pausa e retomada pedem PIN; outra loja: 404 antes do PIN", async () => {
    const { sandbox, poller, call, manager } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await poller.runOnce();
    sandbox.openDispute(id);
    await poller.runOnce();
    expect((await call("POST", `/ifood/orders/${id}/dispute`, { kind: "accept" })).status).toBe(400);
    expect((await call("POST", `/ifood/orders/${id}/dispute`, { kind: "accept", authorization: auth() }, "loja-b")).status).toBe(404);
    expect((await call("POST", `/ifood/merchants/${sandbox.merchantId}/pauses`, { description: "Gás", minutes: 10, authorization: auth({ managerPin: "1111" }) })).status).toBe(403);
    expect(sandbox.activeInterruptions()).toHaveLength(0);
    expect(manager.authorized).toHaveLength(0);
    expect((await call("POST", `/ifood/orders/${id}/dispute`, { kind: "accept", authorization: auth() })).status).toBe(200);
    expect(manager.authorized.map((request) => request.action)).toEqual(["DELIVERY_DISPUTE"]);
  });

  it("falha incerta do iFood fica registrada como incerta e bloqueia nova tentativa; recusa clara como falha", async () => {
    const { sandbox, poller, call, manager } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    const other = sandbox.placeOrder({ items: ITEMS });
    await poller.runOnce();
    sandbox.failNext("/requestCancellation", 503);
    const path = `/ifood/orders/${id}/cancellation`;
    expect((await call("POST", path, { code: "503", description: "Item indisponível", authorization: auth() })).status).toBe(503);
    expect(manager.results.at(-1)?.outcome).toBe("uncertain");
    // Pode ter chegado ao iFood: outra tentativa (outro PIN, outro aparelho) não manda um segundo cancelamento.
    expect((await call("POST", path, { code: "503", description: "Item indisponível", authorization: auth() })).status).toBe(409);
    expect(sandbox.lastEventCode(id)).toBe("PLC");
    sandbox.failNext("/requestCancellation", 400);
    expect((await call("POST", `/ifood/orders/${other}/cancellation`, { code: "503", description: "Item indisponível", authorization: auth() })).status).toBe(400);
    expect(manager.results.at(-1)?.outcome).toBe("failed");
  });

  it("reenvio com o mesmo id da tentativa não chama o iFood de novo (pausa não duplica)", async () => {
    const { sandbox, poller, call, manager } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await poller.runOnce();
    const pauses = `/ifood/merchants/${sandbox.merchantId}/pauses`;
    const authorization = auth();
    const created = await call("POST", pauses, { description: "Falta de gás", minutes: 30, authorization });
    expect(created.status).toBe(201);
    // O id da interrupção no iFood é o id da tentativa: um reenvio nunca cria outra.
    expect((created.body as { id: string }).id).toBe(authorization.requestId);
    const again = await call("POST", pauses, { description: "Falta de gás", minutes: 30, authorization });
    expect(again).toMatchObject({ status: 409, body: { code: "ALREADY_SUBMITTED" } });
    expect(sandbox.activeInterruptions()).toHaveLength(1);
    const cancel = { code: "503", description: "Item indisponível", authorization: auth() };
    sandbox.autoAcceptCancellation = false;
    expect((await call("POST", `/ifood/orders/${id}/cancellation`, cancel)).status).toBe(200);
    const spy = vi.spyOn(IfoodMerchantApi.prototype, "requestCancellation");
    expect((await call("POST", `/ifood/orders/${id}/cancellation`, cancel)).body).toMatchObject({ code: "ALREADY_SUBMITTED" });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    // Reenvio não grava outro resultado.
    expect(manager.results).toHaveLength(2);
  });

  it("a autorização leva o que o gerente aprovou (motivo do iFood, resposta, duração da pausa)", async () => {
    const { sandbox, poller, call, manager } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    const other = sandbox.placeOrder({ items: ITEMS });
    await poller.runOnce();
    sandbox.openDispute(other, { alternatives: ["REFUND"] });
    await poller.runOnce();
    await call("POST", `/ifood/orders/${id}/cancellation`, { code: "503", description: "Item indisponível", authorization: auth() });
    await call("POST", `/ifood/orders/${other}/dispute`, { kind: "reject", reason: "Pedido já saiu", authorization: auth() });
    const created = await call("POST", `/ifood/merchants/${sandbox.merchantId}/pauses`, { description: "Falta de gás", minutes: 30, authorization: auth() });
    await call("DELETE", `/ifood/merchants/${sandbox.merchantId}/pauses/${(created.body as { id: string }).id}`, { authorization: auth() });
    expect(manager.authorized.map((request) => request.details)).toEqual([
      { code: "503" },
      { kind: "reject", reason: "Pedido já saiu" },
      { minutes: 30, description: "Falta de gás" },
      { pauseId: (created.body as { id: string }).id },
    ]);
  });

  it("iFood aceitou e o banco falhou depois: resposta diz que foi enviado (não 'tente de novo') e o resultado fica como enviado", async () => {
    const { sandbox, poller, call, manager, inbox } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await poller.runOnce();
    const repository = (inbox as unknown as { options: { repository: InMemoryDeliveryRepository } }).options.repository;
    const save = repository.saveOrder.bind(repository);
    let calls = 0;
    vi.spyOn(repository, "saveOrder").mockImplementation(async (record) => {
      calls += 1;
      if (calls >= 2) throw new DeliveryRepositoryError("Supabase não respondeu (tchefood_delivery_save_order).");
      return save(record);
    });
    const response = await call("POST", `/ifood/orders/${id}/cancellation`, { code: "503", description: "Item indisponível", authorization: auth() });
    expect(response).toMatchObject({ status: 503, body: { code: "sent_not_saved", error: "Enviado ao iFood, mas não deu para gravar; confira o pedido antes de repetir." } });
    expect(manager.results.at(-1)?.outcome).toBe("sent");
  });

  it("autorização pelo Supabase: JWT do app no RPC, PIN errado e bloqueio viram 403, erro do banco 503", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body?: string }> = [];
    let reply: { ok: boolean; status: number; text: string } = { ok: true, status: 200, text: '{"status":"OK","auditId":"x1"}' };
    const fetchImpl = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
      calls.push({ url, headers: init.headers, body: init.body });
      return { ok: reply.ok, status: reply.status, text: async () => reply.text };
    };
    const approval = new SupabaseManagerApproval({ url: "https://x.supabase.co", anonKey: "anon", serviceRoleKey: "service", fetchImpl });
    const request: ManagerRequest = { action: "DELIVERY_PAUSE", externalOrderId: null, merchantExternalId: "m-1", details: { minutes: 10, description: "Gás" }, ...auth() };
    expect(await approval.authorize("jwt-da-loja", request)).toEqual({ status: "OK", auditId: "x1", repeated: false });
    expect(calls[0]!.url).toBe("https://x.supabase.co/rest/v1/rpc/tchefood_delivery_authorize");
    expect(calls[0]!.headers.authorization).toBe("Bearer jwt-da-loja");
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({ p_action: "DELIVERY_PAUSE", p_merchant_external_id: "m-1", p_external_order_id: null, p_details: { minutes: 10, description: "Gás" } });
    reply = { ok: true, status: 200, text: '{"status":"OK","auditId":"x1","repeated":true}' };
    expect(await approval.authorize("jwt", request)).toEqual({ status: "OK", auditId: "x1", repeated: true });
    reply = { ok: true, status: 200, text: '{"status":"PIN_LOCKED"}' };
    expect((await approval.authorize("jwt", request)).status).toBe("PIN_LOCKED");
    reply = { ok: false, status: 400, text: '{"message":"TCHEFOOD_ANTIFRAUDE: loja do app não pertence a esta loja."}' };
    expect(await approval.authorize("jwt", request)).toEqual({ status: "DENIED", message: "loja do app não pertence a esta loja." });
    reply = { ok: false, status: 500, text: "" };
    await expect(approval.authorize("jwt", request)).rejects.toThrow(/HTTP 500/);
    reply = { ok: true, status: 200, text: "" };
    await approval.recordResult("x1", "sent", "HTTP 200");
    expect(calls.at(-1)!.headers.authorization).toBe("Bearer service");
  });

  it("Supabase que não responde: a API responde 503 no prazo e não chama o iFood", async () => {
    const sandbox = new IfoodSandbox(undefined, undefined, () => NOW);
    const api = new IfoodMerchantApi({ credentials: { clientId: sandbox.clientId, clientSecret: sandbox.clientSecret }, baseUrl: sandbox.baseUrl, fetchImpl: sandbox.fetch });
    const inbox = new DeliveryInbox({ adapters: [api], repository: new InMemoryDeliveryRepository() });
    const id = sandbox.placeOrder({ items: ITEMS });
    await inbox.runChannel(api);
    let aborted = false;
    const hanging = (_url: string, init: { signal?: AbortSignal }) =>
      new Promise<never>((_, reject) => init.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("abort")); }));
    const handle = createIfoodApiHandler({
      inbox,
      api,
      authorizer: new SupabaseCallerAuthorizer({ url: "https://x.supabase.co", anonKey: "anon", fetchImpl: hanging, timeoutMs: 20 }),
      approval: ALLOW_ALL,
    });
    const started = Date.now();
    const response = await handle({ method: "POST", path: `/ifood/orders/${id}/actions/confirm`, headers: { authorization: "Bearer x" }, body: "" });
    expect(response.status).toBe(503);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(aborted).toBe(true);
    expect(sandbox.lastEventCode(id)).toBe("PLC");
  });
});

describe("servidor do iFood: prova de loja pelo Supabase", () => {
  it("usa o JWT do app com a chave anon e só libera quando o RLS mostra a linha", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = async (url: string, init: { method: string; headers: Record<string, string> }) => {
      calls.push({ url, headers: init.headers });
      const visible = init.headers.authorization === "Bearer dono";
      return { ok: true, status: 200, text: async () => (visible ? '[{"tenant_id":"t1"}]' : "[]") };
    };
    const authorizer = new SupabaseCallerAuthorizer({ url: "https://x.supabase.co/", anonKey: "anon", fetchImpl });
    expect(await authorizer.canAccessOrder("dono", "o-1")).toBe(true);
    expect(await authorizer.canAccessOrder("outro", "o-1")).toBe(false);
    expect(calls[0]!.url).toBe("https://x.supabase.co/rest/v1/delivery_orders?channel=eq.ifood&external_id=eq.o-1&select=tenant_id");
    expect(calls[0]!.headers.apikey).toBe("anon");
    expect(await authorizer.canAccessMerchant("dono", "m-1")).toBe(true);
    expect(calls[2]!.url).toContain("delivery_integrations?channel=eq.ifood&active=eq.true&merchant_external_id=eq.m-1");
  });

  it("JWT recusado pelo Supabase ou resposta estranha não libera", async () => {
    const denied = new SupabaseCallerAuthorizer({ url: "https://x.supabase.co", anonKey: "anon", fetchImpl: async () => ({ ok: false, status: 401, text: async () => "" }) });
    expect(await denied.canAccessOrder("t", "o")).toBe(false);
    const weird = new SupabaseCallerAuthorizer({ url: "https://x.supabase.co", anonKey: "anon", fetchImpl: async () => ({ ok: true, status: 200, text: async () => "<html>" }) });
    expect(await weird.canAccessMerchant("t", "m")).toBe(false);
  });
});
