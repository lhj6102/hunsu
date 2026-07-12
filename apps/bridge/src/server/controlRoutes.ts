import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  BRIDGE_CONTROL_TOKEN_HEADER,
  type BridgeControlClient
} from "../client/controlClient.ts";
import {
  BridgeError,
  bridgeErrorResult,
  cliFailure,
  cliSuccess,
  type BridgeCliResult
} from "../client/cliResult.ts";
import type { StructuredLog } from "../diagnostics/structuredLog.ts";
import type { PairingService } from "../pairing/pairingService.ts";
import type { HeadlessProviderService } from "../provider/providerRegistry.ts";
import type { RemoteService } from "../remote/remoteService.ts";
import type { BridgeRuntimeIdentity } from "../state/index.ts";
import { BRIDGE_REMOTE_WORKSPACE_SCOPES, type BridgeRemoteWorkspaceScope } from "../workspaces/remoteScopes.ts";
import type { WorkspaceService } from "../workspaces/workspaceService.ts";

export type HeadlessControlContext = {
  controlToken: () => string;
  rotateControlToken: () => Promise<void>;
  runtimeIdentity: () => BridgeRuntimeIdentity;
  providerService: HeadlessProviderService;
  workspaceService: WorkspaceService;
  pairingService: PairingService;
  remoteService: RemoteService;
  structuredLog: StructuredLog;
  webUrl?: string;
  openBrowser: (url: string) => Promise<void>;
  doctor: () => Promise<unknown>;
  onShutdown: () => void;
};

export type HeadlessControlRouteHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
) => Promise<boolean>;

export function createHeadlessControlRouteHandler(context: HeadlessControlContext): HeadlessControlRouteHandler {
  return async (request, response, url) => {
    if (!url.pathname.startsWith("/v1/control")) return false;
    if (!validControlToken(request, context.controlToken())) {
      sendResult(response, 401, cliFailure(
        "BRIDGE_CONTROL_UNAUTHORIZED",
        "Hunsu Bridge rejected the local control credential."
      ));
      return true;
    }

    try {
      const pathname = url.pathname;
      if (request.method === "GET" && pathname === "/v1/control/status") {
        sendResult(response, 200, cliSuccess("Hunsu Bridge is running.", context.runtimeIdentity()));
        return true;
      }
      if (request.method === "POST" && pathname === "/v1/control/credential/rotate") {
        await context.rotateControlToken();
        sendResult(response, 200, cliSuccess(
          "Hunsu Bridge control credential was rotated.",
          { rotated: true, pairingPreserved: true },
          "CONTROL_CREDENTIAL_ROTATED"
        ));
        return true;
      }
      if (request.method === "GET" && pathname === "/v1/control/provider") {
        const [providers, provider] = await Promise.all([
          context.providerService.list(),
          context.providerService.status(url.searchParams.get("force") === "1")
        ]);
        sendResult(response, 200, cliSuccess("Codex provider status is available.", { providers, provider }));
        return true;
      }
      if (request.method === "PUT" && pathname === "/v1/control/provider") {
        const body = await readJson(request);
        if (body.providerId !== "codex") {
          throw new BridgeError("PROVIDER_NOT_CONFIGURED", "The first headless Bridge prerelease supports only Codex.");
        }
        const provider = body.reset === true
          ? await context.providerService.resetCodex()
          : await context.providerService.setCodex({
              binaryPath: optionalString(body.binaryPath),
              home: optionalString(body.home)
            });
        sendResult(response, 200, cliSuccess(body.reset === true ? "Codex provider configuration was reset." : "Codex provider was configured.", { provider }));
        return true;
      }
      if (request.method === "POST" && pathname === "/v1/control/provider/check") {
        const provider = await context.providerService.status(true);
        if (!provider.installed) throw new BridgeError("PROVIDER_BINARY_NOT_FOUND", provider.safeMessage ?? "Codex was not found.");
        if (!provider.configured) throw new BridgeError("PROVIDER_CHECK_FAILED", provider.safeMessage ?? "Codex could not initialize.");
        sendResult(response, 200, cliSuccess(provider.ready ? "Codex is ready." : "Codex was checked and needs attention.", { provider }));
        return true;
      }

      if (request.method === "GET" && pathname === "/v1/control/workspaces") {
        sendWorkspaceResult(response, await context.workspaceService.list(), "Workspaces are available.");
        return true;
      }
      if (request.method === "POST" && pathname === "/v1/control/workspaces") {
        const body = await readJson(request);
        sendWorkspaceResult(response, await context.workspaceService.add(
          requiredString(body.path, "Workspace path"),
          { displayName: optionalString(body.displayName) }
        ), "Workspace was added.", 201);
        return true;
      }
      const workspaceRoute = parseWorkspaceRoute(pathname);
      if (workspaceRoute && request.method === "GET" && workspaceRoute.action === "inspect") {
        sendWorkspaceResult(response, await context.workspaceService.get(workspaceRoute.workspaceId), "Workspace is available.");
        return true;
      }
      if (workspaceRoute && request.method === "DELETE" && workspaceRoute.action === "inspect") {
        sendWorkspaceResult(response, await context.workspaceService.remove(workspaceRoute.workspaceId), "Workspace was removed.");
        return true;
      }
      if (workspaceRoute && request.method === "POST" && workspaceRoute.action === "open") {
        const workspace = await context.workspaceService.open(workspaceRoute.workspaceId);
        if (!workspace.ok) {
          sendWorkspaceResult(response, workspace, "Workspace could not be opened.");
          return true;
        }
        const paired = unwrapPairingRotation(context.pairingService.rotate({
          browserUrl: context.webUrl ?? "https://hunsu.app/studio",
          workspaceId: workspaceRoute.workspaceId
        }));
        let browserOpened = false;
        try {
          await context.openBrowser(paired.internal.pairingUrl);
          browserOpened = true;
          context.pairingService.markBrowserOpened(paired.safe.pairingId);
        } catch (_error) {
          browserOpened = false;
        }
        sendResult(response, browserOpened ? 200 : 503, browserOpened
          ? cliSuccess("Workspace was opened in Hunsu Web.", { workspace: workspace.value, ...paired.safe, browserOpened })
          : cliFailure("BROWSER_OPEN_FAILED", "The Workspace is paired, but the browser could not be opened."));
        return true;
      }
      if (workspaceRoute && request.method === "PUT" && workspaceRoute.action === "remote-access") {
        const body = await readJson(request);
        if (typeof body.enabled !== "boolean") {
          throw new BridgeError("BRIDGE_STATE_INVALID", "Workspace Remote access requires an enabled boolean.");
        }
        const scopes = body.enabled ? parseRemoteWorkspaceScopes(body.scopes) : [];
        sendWorkspaceResult(response, await context.workspaceService.setRemoteAccess(workspaceRoute.workspaceId, {
          enabled: body.enabled,
          scopes
        }), body.enabled ? "Workspace Remote access was granted." : "Workspace Remote access was revoked.");
        return true;
      }

      if (request.method === "POST" && (pathname === "/v1/control/pair" || workspaceRoute?.action === "pair")) {
        const body = await readJson(request, true);
        const workspaceId = workspaceRoute?.workspaceId ?? optionalString(body.workspaceId);
        if (workspaceId) {
          const workspace = await context.workspaceService.get(workspaceId);
          if (!workspace.ok) {
            sendWorkspaceResult(response, workspace, "Workspace was not found.");
            return true;
          }
        }
        const paired = unwrapPairingRotation(context.pairingService.rotate({
          browserUrl: optionalString(body.webUrl) ?? context.webUrl ?? "https://hunsu.app/studio",
          ...(workspaceId ? { workspaceId } : {})
        }));
        let browserOpened = false;
        if (body.openBrowser === true) {
          try {
            await context.openBrowser(paired.internal.pairingUrl);
            browserOpened = true;
            context.pairingService.markBrowserOpened(paired.safe.pairingId);
          } catch (_error) {
            throw new BridgeError("BROWSER_OPEN_FAILED", "Pairing was created, but the browser could not be opened.");
          }
        }
        sendResult(response, 201, cliSuccess("A short-lived Hunsu Web pairing was created.", {
          ...paired.safe,
          browserOpened
        }));
        return true;
      }
      if (request.method === "POST" && pathname === "/v1/control/pair/revoke") {
        const body = await readJson(request, true);
        const revoked = context.pairingService.revoke(optionalString(body.pairingId));
        sendResult(response, revoked ? 200 : 404, revoked
          ? cliSuccess("The active browser pairing credential was revoked.", { revoked: true })
          : cliFailure("PAIRING_ROTATION_FAILED", "No matching active browser pairing credential was found."));
        return true;
      }

      if (request.method === "POST" && pathname === "/v1/control/login") {
        const body = await readJson(request, true);
        const login = await context.remoteService.login({ openBrowser: body.openBrowser !== false });
        sendResult(response, 202, cliSuccess("Hunsu sign-in is waiting for browser or device-code approval.", login));
        return true;
      }
      if (request.method === "POST" && pathname === "/v1/control/logout") {
        await context.remoteService.logout();
        sendResult(response, 200, cliSuccess("Signed out of Hunsu and disabled Remote Bridge."));
        return true;
      }
      if (request.method === "GET" && pathname === "/v1/control/remote") {
        sendResult(response, 200, cliSuccess("Remote Bridge status is available.", await context.remoteService.status()));
        return true;
      }
      if (request.method === "POST" && pathname === "/v1/control/remote/enable") {
        sendResult(response, 200, cliSuccess("Remote Bridge is enabled.", await context.remoteService.enable()));
        return true;
      }
      if (request.method === "POST" && pathname === "/v1/control/remote/disable") {
        sendResult(response, 200, cliSuccess("Remote Bridge is disabled.", await context.remoteService.disable()));
        return true;
      }
      if (request.method === "GET" && pathname === "/v1/control/doctor") {
        sendResult(response, 200, cliSuccess("Bridge diagnostics completed.", await context.doctor()));
        return true;
      }
      if (request.method === "GET" && pathname === "/v1/control/logs") {
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "200", 10);
        sendResult(response, 200, cliSuccess("Bridge logs are available.", {
          events: await context.structuredLog.read({ limit: Number.isFinite(limit) ? Math.max(1, Math.min(1_000, limit)) : 200 })
        }));
        return true;
      }
      if (request.method === "POST" && pathname === "/v1/control/shutdown") {
        sendResult(response, 202, cliSuccess("Hunsu Bridge is shutting down."));
        setImmediate(context.onShutdown);
        return true;
      }
      sendResult(response, 404, cliFailure("BRIDGE_CONTROL_UNAVAILABLE", "Unknown Hunsu Bridge control route."));
      return true;
    } catch (error) {
      const result = bridgeErrorResult(error);
      sendResult(response, statusForError(result.code), result);
      return true;
    }
  };
}

function validControlToken(request: IncomingMessage, expected: string): boolean {
  const raw = request.headers[BRIDGE_CONTROL_TOKEN_HEADER.toLowerCase()];
  const candidate = Array.isArray(raw) ? raw[0] : raw;
  if (!candidate) return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function sendResult(response: ServerResponse, status: number, result: BridgeCliResult): void {
  const body = JSON.stringify(result);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  response.end(body);
}

function sendWorkspaceResult(
  response: ServerResponse,
  result: { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } },
  message: string,
  successStatus = 200
): void {
  if (result.ok) {
    sendResult(response, successStatus, cliSuccess(message, result.value));
  } else {
    sendResult(response, result.error.code === "WORKSPACE_NOT_FOUND" ? 404 : 400, cliFailure(result.error.code, result.error.message));
  }
}

async function readJson(request: IncomingMessage, allowEmpty = false): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_048_576) throw new BridgeError("BRIDGE_STATE_INVALID", "Control request body is too large.");
    chunks.push(buffer);
  }
  if (chunks.length === 0 && allowEmpty) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object required");
    return value as Record<string, unknown>;
  } catch (_error) {
    throw new BridgeError("BRIDGE_STATE_INVALID", "Control request body must be a JSON object.");
  }
}

function parseWorkspaceRoute(pathname: string): { workspaceId: string; action: "inspect" | "pair" | "open" | "remote-access" } | undefined {
  const match = pathname.match(/^\/v1\/control\/workspaces\/([^/]+)(?:\/(pair|open|remote-access))?$/);
  if (!match?.[1]) return undefined;
  return {
    workspaceId: decodeURIComponent(match[1]),
    action: match[2] === "pair" ? "pair" : match[2] === "open" ? "open" : match[2] === "remote-access" ? "remote-access" : "inspect"
  };
}

function parseRemoteWorkspaceScopes(value: unknown): BridgeRemoteWorkspaceScope[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new BridgeError("BRIDGE_STATE_INVALID", "Workspace Remote access requires at least one explicit scope.");
  }
  const scopes = value.map(scope => {
    if (typeof scope !== "string" || !BRIDGE_REMOTE_WORKSPACE_SCOPES.includes(scope as BridgeRemoteWorkspaceScope)) {
      throw new BridgeError("BRIDGE_STATE_INVALID", "Workspace Remote access contains an unsupported scope.");
    }
    return scope as BridgeRemoteWorkspaceScope;
  });
  if (!scopes.includes("remoteRelay.access")) {
    throw new BridgeError("BRIDGE_STATE_INVALID", "Workspace Remote access requires the remoteRelay.access scope.");
  }
  return [...new Set(scopes)];
}

function requiredString(value: unknown, label: string): string {
  const parsed = optionalString(value);
  if (!parsed) throw new BridgeError("BRIDGE_STATE_INVALID", `${label} is required.`);
  return parsed;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function statusForError(code: string): number {
  if (code === "WORKSPACE_NOT_FOUND") return 404;
  if (code === "BRIDGE_CONTROL_UNAUTHORIZED") return 401;
  if (code === "PROVIDER_BINARY_NOT_FOUND" || code === "PROVIDER_LOGIN_REQUIRED" || code === "ACCOUNT_LOGIN_REQUIRED") return 409;
  return 400;
}

function unwrapPairingRotation(
  result: ReturnType<PairingService["rotate"]>
): Extract<ReturnType<PairingService["rotate"]>, { ok: true }>["value"] {
  if (!result.ok) throw new BridgeError(result.error.code, result.error.message);
  return result.value;
}

// This type-only reference keeps the service-manager shutdown boundary explicit
// without allowing control routes to own daemon startup or service lifecycle.
export type HeadlessShutdownClient = Pick<BridgeControlClient, "request">;
