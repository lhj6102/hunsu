import type { IncomingMessage, ServerResponse } from "node:http";
import type { BridgeStatusResponse } from "../server/bridgeStatus.ts";

type ConnectionRouteContext = {
  bridgeStatus: () => Promise<BridgeStatusResponse>;
  studioConnectionStatus: () => unknown;
  headlessRemote?: {
    enable: () => Promise<unknown>;
    disable: () => Promise<unknown>;
  };
  sendJson: (response: ServerResponse, status: number, body: unknown) => void;
};

export async function handleConnectionRoute(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  context: ConnectionRouteContext
): Promise<boolean> {
  if (request.method === "GET" && pathname === "/api/connection/status") {
    context.sendJson(response, 200, context.studioConnectionStatus());
    return true;
  }
  if (request.method === "GET" && pathname === "/api/bridge/status") {
    context.sendJson(response, 200, await context.bridgeStatus());
    return true;
  }
  if (request.method === "GET" && pathname === "/api/connections") {
    const status = await context.bridgeStatus();
    context.sendJson(response, 200, { connections: status.connections });
    return true;
  }
  if (request.method === "GET" && pathname === "/api/connections/local") {
    const status = await context.bridgeStatus();
    context.sendJson(response, 200, { connection: status.connections.find(connection => connection.mode === "local") });
    return true;
  }
  if (request.method === "GET" && pathname === "/api/connections/remote") {
    context.sendJson(response, 200, { connections: [] });
    return true;
  }
  if (request.method === "POST" && pathname === "/api/connections/remote/enable") {
    if (!context.headlessRemote) {
      context.sendJson(response, 503, { error: "remote_unavailable", message: "Remote access is owned by the headless Bridge service." });
      return true;
    }
    context.sendJson(response, 202, { enabled: true, remote: await context.headlessRemote.enable() });
    return true;
  }
  if (request.method === "POST" && pathname === "/api/connections/remote/disable") {
    if (!context.headlessRemote) {
      context.sendJson(response, 503, { error: "remote_unavailable", message: "Remote access is owned by the headless Bridge service." });
      return true;
    }
    context.sendJson(response, 202, { enabled: false, remote: await context.headlessRemote.disable() });
    return true;
  }
  return false;
}
