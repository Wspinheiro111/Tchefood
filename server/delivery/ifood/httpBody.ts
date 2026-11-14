import type { IncomingMessage, ServerResponse } from "node:http";

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
