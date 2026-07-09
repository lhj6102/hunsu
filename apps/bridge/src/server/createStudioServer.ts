import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export type StudioHttpRequestHandler = (
  request: IncomingMessage,
  response: ServerResponse
) => void | Promise<void>;

export function createStudioHttpServer(handler: StudioHttpRequestHandler) {
  return createServer(handler);
}

export function studioRequestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? "/", "http://localhost");
}
