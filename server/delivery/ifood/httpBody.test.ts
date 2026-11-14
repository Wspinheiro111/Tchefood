import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_BODY_BYTES, readBodyOrReject } from "./httpBody";

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
