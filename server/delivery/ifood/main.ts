import { createServer } from "node:http";
import { DeliveryInbox, InMemoryDeliveryRepository, type DeliveryRepository } from "../deliveryInbox";
import { SupabaseDeliveryRepository } from "../supabaseDeliveryRepository";
import { readBodyOrReject } from "./httpBody";
import { IfoodMerchantApi } from "./ifoodMerchantApi";
import { IfoodSandbox } from "./ifoodSandbox";
import {
  createIfoodApiHandler,
  IfoodPoller,
  SupabaseCallerAuthorizer,
  SupabaseManagerApproval,
  type ManagerApproval,
  type MerchantSource,
  type TenantAuthorizer,
} from "./ifoodServer";

// Processo do servidor do iFood. Variáveis de ambiente:
//   IFOOD_CLIENT_ID, IFOOD_CLIENT_SECRET   credenciais do app centralizado (Portal do Desenvolvedor iFood)
//   IFOOD_BASE_URL                         opcional (padrão https://merchant-api.ifood.com.br)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY
//   PORT                                   porta da API (padrão 8787)
//   CORS_ORIGINS                           origens do app separadas por vírgula (obrigatória; só no simulador
//                                          pode faltar, e aí qualquer origem é aceita)
//   IFOOD_SANDBOX=1                        roda contra o iFood simulado em memória, sem credenciais nem Supabase
//                                          (só para testar o processo; nada é gravado de verdade)
// Rodar exatamente UMA instância: o polling de duas instâncias não perde pedido (versão no banco), mas avisaria
// pedido novo em dobro.

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Falta a variável de ambiente ${name}.`);
    process.exit(1);
  }
  return value;
}

function build(): { api: IfoodMerchantApi; repository: DeliveryRepository; merchants: MerchantSource; authorizer: TenantAuthorizer; approval: ManagerApproval } {
  if (process.env.IFOOD_SANDBOX === "1") {
    const sandbox = new IfoodSandbox();
    const api = new IfoodMerchantApi({
      credentials: { clientId: sandbox.clientId, clientSecret: sandbox.clientSecret },
      baseUrl: sandbox.baseUrl,
      fetchImpl: sandbox.fetch,
    });
    console.warn("[ifood] MODO SIMULADOR: iFood falso em memória, nada é gravado no Supabase.");
    return {
      api,
      repository: new InMemoryDeliveryRepository(),
      merchants: { activeMerchants: async () => [{ merchantExternalId: sandbox.merchantId }] },
      authorizer: { canAccessOrder: async () => true, canAccessMerchant: async () => true },
      // Simulador: qualquer PIN serve e nada é gravado (não há banco).
      approval: { authorize: async () => ({ status: "OK", auditId: "simulador" }), recordResult: async () => undefined },
    };
  }
  const url = required("SUPABASE_URL");
  const repository = new SupabaseDeliveryRepository({ url, serviceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"), channel: "ifood" });
  const api = new IfoodMerchantApi({
    credentials: { clientId: required("IFOOD_CLIENT_ID"), clientSecret: required("IFOOD_CLIENT_SECRET") },
    baseUrl: process.env.IFOOD_BASE_URL?.trim() || undefined,
  });
  const anonKey = required("SUPABASE_ANON_KEY");
  return {
    api,
    repository,
    merchants: repository,
    authorizer: new SupabaseCallerAuthorizer({ url, anonKey }),
    approval: new SupabaseManagerApproval({ url, anonKey, serviceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY") }),
  };
}

function main(): void {
  const { api, repository, merchants, authorizer, approval } = build();
  const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
  const inbox = new DeliveryInbox({ adapters: [api], repository });
  const poller = new IfoodPoller({ api, inbox, merchants, log });
  const handle = createIfoodApiHandler({ inbox, api, authorizer, approval, poller, log });
  const origins = (process.env.CORS_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean);
  // Fora do simulador a API só responde ao navegador nas origens do app: sem a lista, o servidor não sobe.
  if (origins.length === 0 && process.env.IFOOD_SANDBOX !== "1") required("CORS_ORIGINS");

  const server = createServer(async (request, response) => {
    const origin = request.headers.origin;
    const allowOrigin = origins.length === 0 ? "*" : origin && origins.includes(origin) ? origin : null;
    if (allowOrigin) {
      response.setHeader("access-control-allow-origin", allowOrigin);
      response.setHeader("access-control-allow-headers", "authorization, content-type");
      response.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
      response.setHeader("vary", "origin");
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    let body: string | null;
    try {
      // Corpo acima do limite: readBodyOrReject já respondeu 413 (e fecha a conexão depois).
      body = await readBodyOrReject(request, response);
    } catch {
      // O app derrubou a conexão no meio do envio: não há a quem responder.
      request.destroy();
      return;
    }
    if (body === null) return;
    const result = await handle({
      method: request.method ?? "GET",
      path: request.url ?? "/",
      headers: { authorization: request.headers.authorization },
      body,
    });
    if (result.status === 204) {
      response.writeHead(204).end();
      return;
    }
    response.writeHead(result.status, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(result.body));
  });

  const port = Number(process.env.PORT ?? 8787);
  server.listen(port, () => log(`[ifood] API na porta ${port}; polling a cada 30 s.`));
  poller.start();

  const shutdown = () => {
    log("[ifood] desligando: termina o ciclo em andamento antes de sair.");
    server.close();
    void poller.stop().then(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main();
