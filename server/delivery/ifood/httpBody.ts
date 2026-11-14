import type { IncomingMessage, Server, ServerResponse } from "node:http";

export const MAX_BODY_BYTES = 16 * 1024;

// Lê o corpo da requisição até MAX_BODY_BYTES. Passou do limite: para de guardar, responde 413 na hora (com
// connection: close) e só encerra a conexão depois de a resposta sair; devolve null. Derrubar a conexão antes de
// responder (request.destroy) fazia o app ver ECONNRESET em vez do 413.
export function readBodyOrReject(request: IncomingMessage, response: ServerResponse, maxBytes = MAX_BODY_BYTES): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        response
          .writeHead(413, { "content-type": "application/json; charset=utf-8", connection: "close" })
          .end(JSON.stringify({ error: "Corpo grande demais." }), () => request.socket.destroy());
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!tooLarge) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", (error) => {
      if (!tooLarge) reject(error);
    });
  });
}

export const DEFAULT_PORT = 8787;

// Porta da API (variável PORT). Ausente ou vazia: 8787 (Number("") era 0, e o servidor subia numa porta aleatória).
// Qualquer outra coisa que não seja um inteiro de 1 a 65535: erro com mensagem clara (o main.ts sai).
export function parsePort(raw: string | undefined): number {
  const value = raw?.trim() ?? "";
  if (!value) return DEFAULT_PORT;
  const port = /^\d{1,5}$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`PORT inválida: "${value}" (use um número de 1 a 65535).`);
  return port;
}

export const SHUTDOWN_TIMEOUT_MS = 25_000;

// Desligamento (SIGTERM/SIGINT): para de aceitar conexões, fecha as ociosas e espera as requisições em andamento
// (um cancelamento, uma resposta à negociação ou uma pausa que já foi ao iFood precisam gravar o resultado e a
// auditoria) e o ciclo de polling em andamento. Passado o prazo, sai com código 1 e avisa no log.
export async function gracefulShutdown(options: {
  server: Server;
  stopPoller: () => Promise<void>;
  exit: (code: number) => void;
  log: (message: string) => void;
  timeoutMs?: number;
}): Promise<void> {
  const closed = new Promise<void>((resolve) => options.server.close(() => resolve()));
  options.server.closeIdleConnections();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), options.timeoutMs ?? SHUTDOWN_TIMEOUT_MS);
  });
  const finished = Promise.all([options.stopPoller(), closed]).then(() => "done" as const);
  const outcome = await Promise.race([finished, deadline]);
  clearTimeout(timer);
  if (outcome === "timeout") {
    options.log("[ifood] desligando: prazo esgotado com requisição ou ciclo ainda em andamento; saindo assim mesmo.");
    options.exit(1);
    return;
  }
  options.exit(0);
}
