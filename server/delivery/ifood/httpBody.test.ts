import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_BODY_BYTES, gracefulShutdown, parsePort, readBodyOrReject } from "./httpBody";

// Servidor HTTP de verdade (porta efêmera): o 413 precisa chegar ao app, não virar conexão derrubada.
let server: Server | null = null;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

async function start(): Promise<string> {
  server = createServer(async (request, response) => {
    const body = await readBodyOrReject(request, response);
    if (body === null) return;
    response.writeHead(200, { "content-type": "text/plain" }).end(`recebi ${body.length}`);
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

describe("corpo da requisição do servidor do iFood", () => {
  it("corpo grande demais: o app recebe 413 com JSON (não ECONNRESET) e a conexão fecha", async () => {
    const base = await start();
    for (const size of [MAX_BODY_BYTES + 1, 200 * 1024, 5 * 1024 * 1024]) {
      const response = await fetch(`${base}/ifood/orders/x/cancellation`, { method: "POST", body: "a".repeat(size) });
      expect(response.status).toBe(413);
      expect(response.headers.get("connection")).toBe("close");
      expect(await response.json()).toEqual({ error: "Corpo grande demais." });
    }
  });

  it("corpo dentro do limite chega inteiro", async () => {
    const base = await start();
    const response = await fetch(`${base}/x`, { method: "POST", body: "a".repeat(MAX_BODY_BYTES) });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(`recebi ${MAX_BODY_BYTES}`);
  });
});

describe("porta do servidor do iFood (PORT)", () => {
  it("ausente ou vazia: 8787; número de 1 a 65535 vale", () => {
    expect(parsePort(undefined)).toBe(8787);
    expect(parsePort("")).toBe(8787);
    expect(parsePort("  ")).toBe(8787);
    expect(parsePort("3000")).toBe(3000);
    expect(parsePort(" 65535 ")).toBe(65535);
  });

  it("inválida: erro claro (antes PORT= vazio virava 0, porta aleatória)", () => {
    for (const raw of ["0", "-1", "65536", "abc", "80.5", "8787x", "0x50", "1e3"]) {
      expect(() => parsePort(raw)).toThrow(`PORT inválida: "${raw.trim()}" (use um número de 1 a 65535).`);
    }
  });
});

describe("desligamento do servidor do iFood (SIGTERM/SIGINT)", () => {
  it("espera a requisição em andamento terminar (e o ciclo de polling) antes de sair", async () => {
    let finishHandler: () => void = () => undefined;
    const handlerDone = new Promise<void>((resolve) => { finishHandler = resolve; });
    const events: string[] = [];
    const server = createServer((_request, response) => {
      void handlerDone.then(() => {
        events.push("resposta");
        response.writeHead(200, { "content-type": "application/json" }).end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const inFlight = fetch(`http://127.0.0.1:${port}/ifood/x`).then((r) => r.status);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const exits: number[] = [];
    const done = gracefulShutdown({
      server,
      stopPoller: async () => { events.push("polling parado"); },
      exit: (code) => { events.push(`saiu ${code}`); exits.push(code); },
      log: () => undefined,
      timeoutMs: 5_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(exits).toEqual([]); // não sai com a ação ainda no meio
    finishHandler();
    expect(await inFlight).toBe(200);
    await done;
    expect(events).toEqual(["polling parado", "resposta", "saiu 0"]);
  });

  it("requisição que não termina no prazo: sai com código 1 e avisa no log", async () => {
    const server = createServer(() => undefined); // nunca responde
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    void fetch(`http://127.0.0.1:${port}/x`).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const logs: string[] = [];
    const exits: number[] = [];
    await gracefulShutdown({ server, stopPoller: async () => undefined, exit: (code) => { exits.push(code); }, log: (m) => logs.push(m), timeoutMs: 50 });
    expect(exits).toEqual([1]);
    expect(logs.join(" ")).toContain("prazo");
    server.closeAllConnections();
  });
});
