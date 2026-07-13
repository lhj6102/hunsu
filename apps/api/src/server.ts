import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { HunsuHttpApp } from "./http.ts";

const ADAPTER_BODY_LIMIT = 2_200_000;

export function createHunsuNodeServer(app: HunsuHttpApp, publicApiUrl: string): Server {
  const base = publicApiUrl.replace(/\/$/u, "");
  return createServer(async (incoming, outgoing) => {
    try {
      const request = await webRequest(incoming, base);
      const response = await app.handle(request);
      await writeResponse(outgoing, response);
    } catch (error) {
      const status = error instanceof AdapterBodyTooLargeError ? 413 : 500;
      outgoing.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      outgoing.end(`${JSON.stringify({ error: { code: status === 413 ? "invalid_request" : "temporarily_unavailable", message: status === 413 ? "Request body is too large." : "The Hunsu API could not read the request.", retryable: false } })}\n`);
    }
  });
}

async function webRequest(incoming: IncomingMessage, base: string): Promise<Request> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) value.forEach(item => headers.append(name, item));
    else if (value !== undefined) headers.set(name, value);
  }
  const method = incoming.method ?? "GET";
  const init: RequestInit & { duplex?: "half" } = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = await incomingBody(incoming);
    init.duplex = "half";
  }
  return new Request(`${base}${incoming.url ?? "/"}`, init);
}

async function incomingBody(incoming: IncomingMessage): Promise<ArrayBuffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of incoming) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += bytes.byteLength;
    if (size > ADAPTER_BODY_LIMIT) throw new AdapterBodyTooLargeError();
    chunks.push(bytes);
  }
  const combined = Buffer.concat(chunks);
  return combined.buffer.slice(combined.byteOffset, combined.byteOffset + combined.byteLength) as ArrayBuffer;
}

async function writeResponse(outgoing: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, name) => { headers[name] = value; });
  const getSetCookie = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  if (getSetCookie) {
    const cookies = getSetCookie.call(response.headers);
    if (cookies.length > 0) headers["set-cookie"] = cookies;
  }
  outgoing.writeHead(response.status, headers);
  if (!response.body) {
    outgoing.end();
    return;
  }
  const reader = response.body.getReader();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    if (!outgoing.write(Buffer.from(chunk.value))) await new Promise<void>(resolve => outgoing.once("drain", resolve));
  }
  outgoing.end();
}

class AdapterBodyTooLargeError extends Error {}
