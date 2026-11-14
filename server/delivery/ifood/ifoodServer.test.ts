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
  type ManagerOutcome,
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
      // Mesmo id com outro alvo ou conteúdo: conflito (como a comparação de metadata.details no banco).
      if (existing && JSON.stringify(authorized[Number(existing.slice("audit-".length)) - 1]) !== JSON.stringify(request)) {
        return { status: "CONFLICT", message: "Esta autorização já foi usada para outra ação." };
      }
      if (existing) {
        const last = [...results].reverse().find((result) => result.auditId === existing);
        return { status: "OK", auditId: existing, repeated: true, lastOutcome: (last?.outcome as ManagerOutcome | undefined) ?? null };
      }
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

function setup(options: { merchants?: string[]; authorizer?: TenantAuthorizer; now?: () => Date } = {}) {
  const manager = fakeApproval();
  const clock = options.now ?? (() => NOW);
  const sandbox = new IfoodSandbox(undefined, undefined, clock);
  const api = new IfoodMerchantApi({
    credentials: { clientId: sandbox.clientId, clientSecret: sandbox.clientSecret },
    baseUrl: sandbox.baseUrl,
    fetchImpl: sandbox.fetch,
  });
  const repository = new InMemoryDeliveryRepository();
  const inbox = new DeliveryInbox({ adapters: [api], repository, now: clock });
  const merchants = { activeMerchants: vi.fn(async () => (options.merchants ?? [sandbox.merchantId]).map((merchantExternalId) => ({ merchantExternalId }))) };
  const poller = new IfoodPoller({ api, inbox, merchants, now: () => clock().getTime() });
  // Loja do token "loja-a": vê tudo; "loja-b": não vê nada (outro tenant).
  const authorizer: TenantAuthorizer = options.authorizer ?? {
    canAccessOrder: async (token) => token === "loja-a",
    canAccessMerchant: async (token) => token === "loja-a",
  };
  const handle = createIfoodApiHandler({ inbox, api, authorizer, approval: manager.approval, poller, now: clock });
  const call = (method: string, path: string, body?: unknown, token = "loja-a") =>
    handle({ method, path, headers: { authorization: token ? `Bearer ${token}` : undefined }, body: body === undefined ? "" : JSON.stringify(body) } satisfies ApiRequest);
  return { sandbox, api, inbox, poller, merchants, call, manager, repository };
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

  it("ação de status: a resposta diz qual ação foi enviada; repetir em 60 s sem evento novo é 409 sem chamar o iFood", async () => {
    let clock = NOW;
    const { sandbox, poller, call, api, repository } = setup({ now: () => clock });
    const id = sandbox.placeOrder({ items: ITEMS });
    await poller.runOnce();
    const send = vi.spyOn(api, "performAction");
    const confirmed = await call("POST", `/ifood/orders/${id}/actions/confirm`);
    // O status novo só vem com o evento do iFood: a resposta ainda traz "placed", mas diz que a ação foi enviada.
    expect(confirmed).toMatchObject({ status: 200, body: { actionSent: "confirm", order: { status: "placed" } } });
    expect(send).toHaveBeenCalledTimes(1);
    const again = await call("POST", `/ifood/orders/${id}/actions/confirm`);
    expect(again).toMatchObject({ status: 409, body: { error: expect.stringMatching(/já enviad.*aguardando/i) } });
    expect(send).toHaveBeenCalledTimes(1);
    // Passados os 60 s sem evento, a ação vai de novo ao iFood (que decide).
    clock = new Date(NOW.getTime() + 61_000);
    await call("POST", `/ifood/orders/${id}/actions/confirm`);
    expect(send).toHaveBeenCalledTimes(2);
    // Com o evento do iFood gravado, a trava some e a próxima ação segue normal.
    await poller.runOnce();
    expect((await repository.getOrder("ifood", id))?.order.status).toBe("confirmed");
    expect((await call("POST", `/ifood/orders/${id}/actions/start_preparation`)).status).toBe(200);
  });

  it("ação de status: falha não trava a nova tentativa; pedido que mudou (evento novo) libera a repetição", async () => {
    const { sandbox, poller, call, api, repository } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await poller.runOnce();
    const send = vi.spyOn(api, "performAction");
    sandbox.failNext("/confirm", 503);
    expect((await call("POST", `/ifood/orders/${id}/actions/confirm`)).status).toBe(503);
    const retried = await call("POST", `/ifood/orders/${id}/actions/confirm`);
    expect(retried).toMatchObject({ status: 200, body: { actionSent: "confirm" } });
    expect(send).toHaveBeenCalledTimes(2);
    // Outro evento gravou o pedido (versão nova) dentro dos 60 s: a repetição não fica presa.
    const stored = (await repository.getOrder("ifood", id))!;
    await repository.saveOrder(stored);
    await call("POST", `/ifood/orders/${id}/actions/confirm`);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("cancelamento de pedido que o iFood não deixa cancelar (sem motivos): diz isso, não 'motivo inválido'", async () => {
    const { sandbox, poller, call } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await poller.runOnce();
    sandbox.emitFromMarketplace(id, "CON");
    await poller.runOnce();
    const response = await call("POST", `/ifood/orders/${id}/cancellation`, { code: "503", description: "Item indisponível", authorization: auth() });
    expect(response.status).toBe(400);
    expect((response.body as { error: string }).error).toMatch(/iFood não aceita cancelamento deste pedido agora/);
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
    const disputeId = sandbox.openDispute(id);
    await poller.runOnce();
    expect((await call("POST", `/ifood/orders/${id}/dispute`, { kind: "reject", disputeId, authorization: auth() })).status).toBe(400);
    expect((await call("POST", `/ifood/orders/${id}/dispute`, { kind: "talvez", disputeId, authorization: auth() })).status).toBe(400);
    const rejected = await call("POST", `/ifood/orders/${id}/dispute`, { kind: "reject", reason: "Pedido já saiu", disputeId, authorization: auth() });
    expect(rejected.status).toBe(200);
    expect(sandbox.eventHistory().at(-1)?.code).toBe("HSS");
  });

  it("negociação: motivo do aceite, valor e prazo da proposta conferidos antes do PIN e enviados ao iFood", async () => {
    const { sandbox, poller, inbox, call, manager } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await poller.runOnce();
    const cancel = sandbox.openDispute(id, { acceptCancellationReasons: ["HIGH_STORE_DEMAND"] });
    await poller.runOnce();
    const path = `/ifood/orders/${id}/dispute`;
    const missing = await call("POST", path, { kind: "accept", disputeId: cancel, authorization: auth() });
    expect(missing).toMatchObject({ status: 400, body: { error: expect.stringMatching(/motivo do aceite/) } });
    expect((await call("POST", path, { kind: "accept", reason: "INVENTADO", disputeId: cancel, authorization: auth() })).status).toBe(400);
    expect(manager.authorized).toHaveLength(0);
    const accepted = await call("POST", path, { kind: "accept", reason: "HIGH_STORE_DEMAND", detailReason: "Fila grande", disputeId: cancel, authorization: auth() });
    expect(accepted.status).toBe(200);
    expect(sandbox.eventHistory().find((event) => event.code === "HSS")?.metadata).toMatchObject({ disputeId: cancel, status: "ACCEPTED", reason: "HIGH_STORE_DEMAND" });

    const other = sandbox.placeOrder({ items: ITEMS });
    await poller.runOnce();
    const otherDispute = sandbox.openDispute(other, { alternatives: [{ type: "REFUND", maxAmountCents: 2000 }] });
    await poller.runOnce();
    const alternativeId = (await inbox.listOrders()).find((record) => record.order.externalId === other)!.dispute!.alternatives[0]!.id;
    const otherPath = `/ifood/orders/${other}/dispute`;
    expect((await call("POST", otherPath, { kind: "alternative", alternativeId, disputeId: otherDispute, authorization: auth() })).status).toBe(400);
    expect((await call("POST", otherPath, { kind: "alternative", alternativeId, amountCents: "15", disputeId: otherDispute, authorization: auth() })).status).toBe(400);
    expect((await call("POST", otherPath, { kind: "alternative", alternativeId, amountCents: 2500, disputeId: otherDispute, authorization: auth() })).status).toBe(400);
    expect(manager.authorized).toHaveLength(1);
    expect((await call("POST", otherPath, { kind: "alternative", alternativeId, amountCents: 1500, disputeId: otherDispute, authorization: auth() })).status).toBe(200);
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
    const disputeId = sandbox.openDispute(id);
    await poller.runOnce();
    expect((await call("POST", `/ifood/orders/${id}/dispute`, { kind: "accept", disputeId })).status).toBe(400);
    expect((await call("POST", `/ifood/orders/${id}/dispute`, { kind: "accept", disputeId, authorization: auth() }, "loja-b")).status).toBe(404);
    expect((await call("POST", `/ifood/merchants/${sandbox.merchantId}/pauses`, { description: "Gás", minutes: 10, authorization: auth({ managerPin: "1111" }) })).status).toBe(403);
    expect(sandbox.activeInterruptions()).toHaveLength(0);
    expect(manager.authorized).toHaveLength(0);
    expect((await call("POST", `/ifood/orders/${id}/dispute`, { kind: "accept", disputeId, authorization: auth() })).status).toBe(200);
    expect(manager.authorized.map((request) => request.action)).toEqual(["DELIVERY_DISPUTE"]);
  });

  it("falha incerta do iFood fica registrada como incerta e bloqueia nova tentativa; recusa clara como falha", async () => {
    const { sandbox, poller, call, manager } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    const other = sandbox.placeOrder({ items: ITEMS });
    await poller.runOnce();
    sandbox.failNext("/requestCancellation", 503);
    const path = `/ifood/orders/${id}/cancellation`;
    const uncertain = await call("POST", path, { code: "503", description: "Item indisponível", authorization: auth() });
    // Não diz só "iFood indisponível": a tela precisa saber que pode ter sido aplicado.
    expect(uncertain).toMatchObject({ status: 503, body: { code: "uncertain", error: expect.stringMatching(/pode ter sido aplicado.*antes de tentar de novo/) } });
    expect(manager.results.at(-1)?.outcome).toBe("uncertain");
    // Pode ter chegado ao iFood: outra tentativa (outro PIN, outro aparelho) não manda um segundo cancelamento.
    expect((await call("POST", path, { code: "503", description: "Item indisponível", authorization: auth() })).status).toBe(409);
    expect(sandbox.lastEventCode(id)).toBe("PLC");
    sandbox.failNext("/requestCancellation", 400);
    expect((await call("POST", `/ifood/orders/${other}/cancellation`, { code: "503", description: "Item indisponível", authorization: auth() })).status).toBe(400);
    expect(manager.results.at(-1)?.outcome).toBe("failed");
  });

  it("cancelamento sem confirmação com o prazo vencido: só repete com a conferência do gerente, que fica no registro", async () => {
    const { sandbox, poller, call, manager, repository, api } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await poller.runOnce();
    const stored = (await repository.getOrder("ifood", id))!;
    stored.cancellationRequest = { state: "uncertain", reservedAt: new Date(NOW.getTime() - 11 * 60_000).toISOString(), code: "503" };
    stored.version = await repository.saveOrder(stored);
    const send = vi.spyOn(api, "requestCancellation");
    const path = `/ifood/orders/${id}/cancellation`;
    const base = { code: "503", description: "Item indisponível" };
    const blocked = await call("POST", path, { ...base, authorization: auth() });
    expect(blocked).toMatchObject({ status: 409, body: { code: "conflict", error: expect.stringMatching(/Portal do Parceiro/) } });
    expect(send).not.toHaveBeenCalled();
    expect((await call("POST", path, { ...base, confirmUncertainRetry: "sim", authorization: auth() })).status).toBe(400);
    const retried = await call("POST", path, { ...base, confirmUncertainRetry: true, authorization: auth() });
    expect(retried.status).toBe(200);
    expect(send).toHaveBeenCalledOnce();
    expect(manager.authorized.at(-1)?.details).toMatchObject({ code: "503", confirmUncertainRetry: true });
    expect(manager.authorized[0]?.details).not.toHaveProperty("confirmUncertainRetry");
  });

  it("pausa com resultado incerto (tempo esgotado): pode ter sido aplicada, a tela confere a lista antes de repetir", async () => {
    const sandbox = new IfoodSandbox(undefined, undefined, () => NOW);
    let hang = true;
    // O iFood aplica a pausa e a resposta nunca chega.
    const fetchImpl: typeof fetch = async (input, init) => {
      const response = await sandbox.fetch(input, init);
      if (hang && String(input).endsWith("/interruptions") && init?.method === "POST") return new Promise<Response>(() => undefined);
      return response;
    };
    const api = new IfoodMerchantApi({ credentials: { clientId: sandbox.clientId, clientSecret: sandbox.clientSecret }, baseUrl: sandbox.baseUrl, fetchImpl, timeoutMs: 20 });
    const inbox = new DeliveryInbox({ adapters: [api], repository: new InMemoryDeliveryRepository(), now: () => NOW });
    const manager = fakeApproval();
    const handle = createIfoodApiHandler({ inbox, api, authorizer: { canAccessOrder: async () => true, canAccessMerchant: async () => true }, approval: manager.approval, now: () => NOW });
    const path = `/ifood/merchants/${sandbox.merchantId}/pauses`;
    const response = await handle({ method: "POST", path, headers: { authorization: "Bearer x" }, body: JSON.stringify({ description: "Gás", minutes: 30, authorization: auth() }) });
    expect(response).toEqual({
      status: 503,
      body: { code: "uncertain", error: "A pausa pode ter sido aplicada no iFood (sem resposta clara); confira a lista de pausas antes de tentar de novo." },
    });
    expect(manager.results.at(-1)?.outcome).toBe("uncertain");
    hang = false;
    // A lista mostra a pausa que foi aplicada.
    expect(sandbox.activeInterruptions()).toHaveLength(1);
    // Recusa clara do iFood continua com o código do iFood (nada foi aplicado).
    sandbox.failNext("/interruptions", 400);
    const refused = await handle({ method: "POST", path, headers: { authorization: "Bearer x" }, body: JSON.stringify({ description: "Gás", minutes: 30, authorization: auth() }) });
    expect(refused).toMatchObject({ status: 400, body: { code: "invalid_request" } });
  });

  it("cancelamento sem confirmação ainda no prazo da reserva: avisa a partir de quando a repetição com conferência vale", async () => {
    const { sandbox, poller, call, repository, api } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await poller.runOnce();
    const stored = (await repository.getOrder("ifood", id))!;
    // Reservado às 14:57Z (11:57 em Brasília): a repetição com conferência vale a partir de 12:07.
    stored.cancellationRequest = { state: "uncertain", reservedAt: new Date(NOW.getTime() - 3 * 60_000).toISOString(), code: "503" };
    await repository.saveOrder(stored);
    const send = vi.spyOn(api, "requestCancellation");
    const blocked = await call("POST", `/ifood/orders/${id}/cancellation`, { code: "503", description: "Item indisponível", confirmUncertainRetry: true, authorization: auth() });
    expect(blocked).toMatchObject({ status: 409, body: { code: "conflict", error: expect.stringMatching(/a partir de 12:07 \(horário de Brasília\)/) } });
    expect(send).not.toHaveBeenCalled();
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

  it("reenvio sem resultado gravado (resposta do banco perdida): não afirma que foi enviado ao iFood", async () => {
    const { sandbox, poller, call, manager } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await poller.runOnce();
    // A autorização gravou, mas a resposta do banco não voltou: o app reenviou com o mesmo id e nada foi ao iFood.
    manager.approval.authorize = async () => ({ status: "OK", auditId: "audit-perdida", repeated: true, lastOutcome: null });
    const spy = vi.spyOn(IfoodMerchantApi.prototype, "requestCancellation");
    const again = await call("POST", `/ifood/orders/${id}/cancellation`, { code: "503", description: "Item indisponível", authorization: auth() });
    expect(again).toMatchObject({ status: 409, body: { code: "ALREADY_SUBMITTED" } });
    const error = (again.body as { error: string }).error;
    expect(error).not.toMatch(/já foi enviada/);
    expect(error).toMatch(/registrada/);
    expect(error).toMatch(/Portal do Parceiro/);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("banco fora do ar antes do iFood: resultado 'failed' e o reenvio pede nova tentativa (nada foi enviado)", async () => {
    const { sandbox, poller, call, manager, repository } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await poller.runOnce();
    sandbox.autoAcceptCancellation = false;
    const spy = vi.spyOn(IfoodMerchantApi.prototype, "requestCancellation");
    // A reserva do cancelamento não grava: o iFood nunca é chamado.
    const save = vi.spyOn(repository, "saveOrder").mockRejectedValueOnce(new DeliveryRepositoryError("Supabase fora do ar."));
    const cancel = { code: "503", description: "Item indisponível", authorization: auth() };
    expect((await call("POST", `/ifood/orders/${id}/cancellation`, cancel)).status).toBe(503);
    expect(spy).not.toHaveBeenCalled();
    expect(manager.results.at(-1)).toMatchObject({ outcome: "failed" });
    expect(await call("POST", `/ifood/orders/${id}/cancellation`, cancel)).toMatchObject({ status: 409, body: { code: "RETRY_WITH_NEW_ID" } });
    // Nova tentativa (outro id) segue normal.
    save.mockRestore();
    expect((await call("POST", `/ifood/orders/${id}/cancellation`, { ...cancel, authorization: auth() })).status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("resposta da negociação vale só para a negociação conferida: outra aberta durante o PIN dá conflito", async () => {
    const { sandbox, poller, call, manager, api } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await poller.runOnce();
    const first = sandbox.openDispute(id);
    await poller.runOnce();
    // Enquanto o PIN é conferido, o app fecha a primeira negociação e abre outra (o polling grava as duas).
    const authorize = manager.approval.authorize;
    let second = "";
    manager.approval.authorize = async (token, request) => {
      sandbox.expireDispute(first);
      second = sandbox.openDispute(id);
      await poller.runOnce();
      return authorize(token, request);
    };
    const spy = vi.spyOn(api, "respondToDispute");
    const response = await call("POST", `/ifood/orders/${id}/dispute`, { kind: "accept", disputeId: first, authorization: auth() });
    expect(response.status).toBe(409);
    expect(spy).not.toHaveBeenCalled();
    expect(manager.authorized.at(-1)?.details).toMatchObject({ disputeId: first, kind: "accept" });
    manager.approval.authorize = authorize;
    // A tela que mostra a negociação nova manda o id dela; um id velho é recusado antes do PIN.
    const before = manager.authorized.length;
    expect((await call("POST", `/ifood/orders/${id}/dispute`, { kind: "accept", disputeId: first, authorization: auth() })).status).toBe(409);
    expect(manager.authorized).toHaveLength(before);
    expect((await call("POST", `/ifood/orders/${id}/dispute`, { kind: "accept", disputeId: second, authorization: auth() })).status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("disputeId é obrigatório: a tela mostrou A, o app trocou por B; sem id ou com o id de A não autoriza nem chama o iFood", async () => {
    const { sandbox, poller, call, manager, api } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await poller.runOnce();
    const shown = sandbox.openDispute(id);
    await poller.runOnce();
    // Antes da requisição, o app fecha A e abre B (o polling grava a troca).
    sandbox.expireDispute(shown);
    const current = sandbox.openDispute(id);
    await poller.runOnce();
    const spy = vi.spyOn(api, "respondToDispute");
    const path = `/ifood/orders/${id}/dispute`;
    const missing = await call("POST", path, { kind: "accept", authorization: auth() });
    expect(missing).toMatchObject({ status: 400, body: { error: expect.stringMatching(/negociação/) } });
    for (const disputeId of ["", "../x", 42, null, "a".repeat(65)]) {
      expect((await call("POST", path, { kind: "accept", disputeId, authorization: auth() })).status).toBe(400);
    }
    expect((await call("POST", path, { kind: "accept", disputeId: shown, authorization: auth() })).status).toBe(409);
    expect(manager.authorized).toHaveLength(0);
    expect(manager.results).toHaveLength(0);
    expect(spy).not.toHaveBeenCalled();
    const ok = await call("POST", path, { kind: "accept", disputeId: current, authorization: auth() });
    expect(ok.status).toBe(200);
    expect(manager.authorized.map((request) => request.details)).toEqual([{ disputeId: current, kind: "accept" }]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(current, { kind: "accept" });
  });

  it("resposta à negociação sem confirmação (iFood 503): só repete com a conferência do gerente, que fica no registro", async () => {
    const { sandbox, poller, call, manager, api } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    await poller.runOnce();
    const disputeId = sandbox.openDispute(id, { handshakeType: "PREPARATION_TIME", timeoutAction: "ACCEPT_CANCELLATION" });
    await poller.runOnce();
    const path = `/ifood/orders/${id}/dispute`;
    const base = { kind: "reject", reason: "Já está saindo", disputeId };
    sandbox.failNext("/disputes/", 503);
    expect((await call("POST", path, { ...base, authorization: auth() })).status).toBe(503);
    expect(manager.results.at(-1)?.outcome).toBe("uncertain");
    const send = vi.spyOn(api, "respondToDispute");
    // Sem a conferência: 409 antes do PIN, explicando que a resposta anterior pode não ter chegado.
    const authorizedBefore = manager.authorized.length;
    const blocked = await call("POST", path, { ...base, authorization: auth() });
    expect(blocked).toMatchObject({ status: 409, body: { code: "conflict", error: expect.stringMatching(/pode não ter chegado.*Portal do Parceiro/) } });
    expect(manager.authorized).toHaveLength(authorizedBefore);
    expect((await call("POST", path, { ...base, confirmUncertainRetry: "sim", authorization: auth() })).status).toBe(400);
    expect(send).not.toHaveBeenCalled();
    const retried = await call("POST", path, { ...base, confirmUncertainRetry: true, authorization: auth() });
    expect(retried.status).toBe(200);
    expect(send).toHaveBeenCalledOnce();
    expect(manager.authorized.at(-1)?.details).toMatchObject({ disputeId, kind: "reject", confirmUncertainRetry: true });
    expect(manager.authorized[0]?.details).not.toHaveProperty("confirmUncertainRetry");
    // O iFood recebeu a resposta: o prazo não aplica o timeoutAction.
    expect(sandbox.eventHistory().filter((event) => event.code === "HSS")).toHaveLength(1);
  });

  it("a autorização leva o que o gerente aprovou (motivo do iFood, resposta, duração da pausa)", async () => {
    const { sandbox, poller, call, manager } = setup();
    const id = sandbox.placeOrder({ items: ITEMS });
    const other = sandbox.placeOrder({ items: ITEMS });
    await poller.runOnce();
    const otherDispute = sandbox.openDispute(other, { alternatives: ["REFUND"] });
    await poller.runOnce();
    await call("POST", `/ifood/orders/${id}/cancellation`, { code: "503", description: "Item indisponível", authorization: auth() });
    await call("POST", `/ifood/orders/${other}/dispute`, { kind: "reject", reason: "Pedido já saiu", disputeId: otherDispute, authorization: auth() });
    const created = await call("POST", `/ifood/merchants/${sandbox.merchantId}/pauses`, { description: "Falta de gás", minutes: 30, authorization: auth() });
    await call("DELETE", `/ifood/merchants/${sandbox.merchantId}/pauses/${(created.body as { id: string }).id}`, { authorization: auth() });
    expect(manager.authorized.map((request) => request.details)).toEqual([
      { code: "503", reason: "Item indisponível" },
      { disputeId: otherDispute, kind: "reject", reason: "Pedido já saiu" },
      { minutes: 30, description: "Falta de gás" },
      { pauseId: (created.body as { id: string }).id },
    ]);
  });

  it("a autorização do cancelamento grava o código e o texto exatos que o iFood recebe; mesmo id com outro texto é conflito", async () => {
    const manager = fakeApproval();
    const sandbox = new IfoodSandbox(undefined, undefined, () => NOW);
    const sent: Array<Record<string, unknown>> = [];
    const fetchImpl: typeof sandbox.fetch = async (input, init = {}) => {
      if (String(input).endsWith("/requestCancellation")) sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return sandbox.fetch(input, init);
    };
    const api = new IfoodMerchantApi({ credentials: { clientId: sandbox.clientId, clientSecret: sandbox.clientSecret }, baseUrl: sandbox.baseUrl, fetchImpl });
    const inbox = new DeliveryInbox({ adapters: [api], repository: new InMemoryDeliveryRepository(), now: () => NOW });
    const poller = new IfoodPoller({ api, inbox, merchants: { activeMerchants: async () => [{ merchantExternalId: sandbox.merchantId }] }, now: () => NOW.getTime() });
    const handle = createIfoodApiHandler({ inbox, api, authorizer: { canAccessOrder: async () => true, canAccessMerchant: async () => true }, approval: manager.approval, now: () => NOW });
    const call = (path: string, body: unknown) => handle({ method: "POST", path, headers: { authorization: "Bearer loja-a" }, body: JSON.stringify(body) });
    const id = sandbox.placeOrder({ items: ITEMS });
    const plain = sandbox.placeOrder({ items: ITEMS });
    await poller.runOnce();
    sandbox.autoAcceptCancellation = false;

    // Texto adicional com espaços e mais de 250 caracteres (o corte cai num espaço): vai aparado e cortado, e o
    // registro leva o mesmo texto.
    const details = `  ${"a".repeat(249)} resto do texto  `;
    const authorization = auth();
    expect((await call(`/ifood/orders/${id}/cancellation`, { code: "503", description: "Item indisponível", details, authorization })).status).toBe(200);
    expect(sent).toHaveLength(1);
    expect((sent[0]!.reason as string).length).toBeLessThanOrEqual(250);
    expect(manager.authorized.at(-1)?.details).toEqual({ code: sent[0]!.cancellationCode, reason: sent[0]!.reason });
    expect(sent[0]).toEqual({ cancellationCode: "503", reason: "a".repeat(249) });

    // Mesmo id da tentativa com outro texto: 409 CONFLICT, sem chamar o iFood.
    const spy = vi.spyOn(api, "requestCancellation");
    const conflict = await call(`/ifood/orders/${id}/cancellation`, { code: "503", description: "Item indisponível", details: "Outro texto", authorization });
    expect(conflict).toMatchObject({ status: 409, body: { code: "CONFLICT" } });
    expect(spy).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    spy.mockRestore();

    // Sem texto adicional: vai a descrição do motivo do iFood, e é ela que fica no registro.
    expect((await call(`/ifood/orders/${plain}/cancellation`, { code: "503", description: "Item indisponível", details: "   ", authorization: auth() })).status).toBe(200);
    expect(sent).toHaveLength(2);
    expect(manager.authorized.at(-1)?.details).toEqual({ code: "503", reason: sent[1]!.reason });
    expect(sent[1]!.reason).toBe("Item indisponível");
  });

  // Rodada 3 do GPT: o texto era cortado em 250 unidades UTF-16 e aparado de novo antes de ir ao iFood, então o
  // registro podia terminar em espaço (diferente do enviado) ou num emoji partido (surrogate solto, que o jsonb do
  // Postgres recusa). O corte agora é por caractere (code point), sem passar de 250 unidades UTF-16 (o limite que o
  // sandbox confere), e o espaço final sai depois do corte.
  it("negociação e cancelamento: o texto gravado na autorização é exatamente o que o iFood recebe (corte por caractere)", async () => {
    const manager = fakeApproval();
    const sandbox = new IfoodSandbox(undefined, undefined, () => NOW);
    const sent: Array<{ path: string; body: Record<string, unknown> }> = [];
    const fetchImpl: typeof sandbox.fetch = async (input, init = {}) => {
      const path = String(input);
      if (/\/(reject|accept|requestCancellation)$/.test(path)) sent.push({ path, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return sandbox.fetch(input, init);
    };
    const api = new IfoodMerchantApi({ credentials: { clientId: sandbox.clientId, clientSecret: sandbox.clientSecret }, baseUrl: sandbox.baseUrl, fetchImpl });
    const inbox = new DeliveryInbox({ adapters: [api], repository: new InMemoryDeliveryRepository(), now: () => NOW });
    const poller = new IfoodPoller({ api, inbox, merchants: { activeMerchants: async () => [{ merchantExternalId: sandbox.merchantId }] }, now: () => NOW.getTime() });
    const handle = createIfoodApiHandler({ inbox, api, authorizer: { canAccessOrder: async () => true, canAccessMerchant: async () => true }, approval: manager.approval, now: () => NOW });
    const call = (path: string, body: unknown) => handle({ method: "POST", path, headers: { authorization: "Bearer loja-a" }, body: JSON.stringify(body) });
    const spaced = "a".repeat(249) + " b";
    const emoji = "a".repeat(249) + "😀" + "resto"; // emoji nas unidades 250-251: não cabe, sai inteiro
    const fits = "a".repeat(248) + "😀" + "resto"; // emoji nas unidades 249-250: cabe inteiro
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

    // Recusa: corte cai no espaço (249 "a" + " b") e corte depois de um emoji na posição 250.
    for (const [reason, expected] of [[spaced, "a".repeat(249)], [emoji, "a".repeat(249)], [fits, "a".repeat(248) + "😀"]] as const) {
      const id = sandbox.placeOrder({ items: ITEMS });
      await poller.runOnce();
      const disputeId = sandbox.openDispute(id);
      await poller.runOnce();
      expect((await call(`/ifood/orders/${id}/dispute`, { kind: "reject", reason, disputeId, authorization: auth() })).status).toBe(200);
      const body = sent.at(-1)!.body;
      expect(sent.at(-1)!.path).toMatch(/\/reject$/);
      expect(body).toEqual({ reason: expected });
      expect(manager.authorized.at(-1)?.details).toEqual({ disputeId, kind: "reject", reason: body.reason });
      expect(loneSurrogate.test(JSON.stringify(manager.authorized.at(-1)?.details))).toBe(false);
    }

    // Aceite com texto adicional (detailReason): mesmo corte.
    for (const [detailReason, expected] of [[spaced, "a".repeat(249)], [emoji, "a".repeat(249)], [fits, "a".repeat(248) + "😀"]] as const) {
      const id = sandbox.placeOrder({ items: ITEMS });
      await poller.runOnce();
      const disputeId = sandbox.openDispute(id, { acceptCancellationReasons: ["HIGH_STORE_DEMAND"] });
      await poller.runOnce();
      const accepted = await call(`/ifood/orders/${id}/dispute`, { kind: "accept", reason: "HIGH_STORE_DEMAND", detailReason, disputeId, authorization: auth() });
      expect(accepted.status).toBe(200);
      const body = sent.at(-1)!.body;
      expect(sent.at(-1)!.path).toMatch(/\/accept$/);
      expect(body).toEqual({ reason: "HIGH_STORE_DEMAND", detailReason: expected });
      expect(manager.authorized.at(-1)?.details).toEqual({ disputeId, kind: "accept", reason: "HIGH_STORE_DEMAND", detailReason: body.detailReason });
    }

    // Cancelamento com emoji na posição 250 do texto adicional (não cabe inteiro: sai).
    const id = sandbox.placeOrder({ items: ITEMS });
    await poller.runOnce();
    expect((await call(`/ifood/orders/${id}/cancellation`, { code: "503", description: "Item indisponível", details: emoji, authorization: auth() })).status).toBe(200);
    const body = sent.at(-1)!.body;
    expect(body).toEqual({ cancellationCode: "503", reason: "a".repeat(249) });
    expect(manager.authorized.at(-1)?.details).toEqual({ code: "503", reason: body.reason });
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
    expect(await approval.authorize("jwt-da-loja", request)).toEqual({ status: "OK", auditId: "x1", repeated: false, lastOutcome: null });
    expect(calls[0]!.url).toBe("https://x.supabase.co/rest/v1/rpc/tchefood_delivery_authorize");
    expect(calls[0]!.headers.authorization).toBe("Bearer jwt-da-loja");
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({ p_action: "DELIVERY_PAUSE", p_merchant_external_id: "m-1", p_external_order_id: null, p_details: { minutes: 10, description: "Gás" } });
    reply = { ok: true, status: 200, text: '{"status":"OK","auditId":"x1","repeated":true}' };
    expect(await approval.authorize("jwt", request)).toEqual({ status: "OK", auditId: "x1", repeated: true, lastOutcome: null });
    reply = { ok: true, status: 200, text: '{"status":"OK","auditId":"x1","repeated":true,"lastOutcome":"failed"}' };
    expect(await approval.authorize("jwt", request)).toEqual({ status: "OK", auditId: "x1", repeated: true, lastOutcome: "failed" });
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
