import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { BridgeRuntimeConfig } from "@hunsu/config";

export type StudioHttpRequestHandler = (
  request: IncomingMessage,
  response: ServerResponse
) => void | Promise<void>;

export function createStudioHttpServer(
  handler: StudioHttpRequestHandler,
  options: { runtimeConfig?: BridgeRuntimeConfig } = {}
) {
  const server = createServer(handler);
  const runtimeConfig = options.runtimeConfig;
  if (runtimeConfig?.bridgeApi.port === 0) {
    server.once("listening", () => {
      const address = server.address();
      if (!address || typeof address === "string") return;
      applyAssignedBridgePort(runtimeConfig, address.port);
    });
  }
  return server;
}

export function studioRequestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? "/", "http://localhost");
}

function applyAssignedBridgePort(runtimeConfig: BridgeRuntimeConfig, port: number): void {
  runtimeConfig.bridgeApi = { ...runtimeConfig.bridgeApi, port };
  runtimeConfig.processEnv.HUNSU_BRIDGE_PORT = String(port);
  runtimeConfig.codexAppServer.environment.HUNSU_BRIDGE_PORT = String(port);
}
