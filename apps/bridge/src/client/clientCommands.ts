import { createDoctorReport } from "../diagnostics/doctor.ts";
import type { HunsuPaths } from "../state/paths.ts";
import {
  BRIDGE_REMOTE_WORKSPACE_SCOPES,
  type BridgeRemoteWorkspaceScope
} from "../workspaces/remoteScopes.ts";
import { getFlag, hasFlag, type ParsedBridgeCliArgs } from "./cliArgs.ts";
import { BridgeError, cliFailure, cliSuccess, type BridgeCliResult } from "./cliResult.ts";
import type { BridgeControlClient } from "./controlClient.ts";

const CLIENT_COMMANDS = new Set([
  "status",
  "doctor",
  "logs",
  "provider",
  "workspace",
  "credential",
  "pair",
  "open",
  "login",
  "logout",
  "remote"
]);
const PROVIDER_CONTROL_TIMEOUT_MS = 20_000;

export type BridgeClientCommandOptions = {
  parsed: ParsedBridgeCliArgs;
  paths: HunsuPaths;
  client: BridgeControlClient;
  emit(result: BridgeCliResult): number;
};

export function isBridgeClientCommand(command: string): boolean {
  return CLIENT_COMMANDS.has(command);
}

export async function runBridgeClientCommand(options: BridgeClientCommandOptions): Promise<number> {
  const { parsed, paths, client, emit } = options;
  const command = parsed.positionals[0]!;
  if (command === "status") return emit(await client.request("/v1/control/status"));
  if (command === "doctor") {
    const online = await client.request("/v1/control/doctor");
    const result = !online.ok && (online.code === "BRIDGE_NOT_RUNNING" || online.code === "BRIDGE_STATE_INVALID")
      ? cliSuccess("Offline Bridge diagnostics completed.", await createDoctorReport({ paths, online: false }))
      : online;
    return emit(result);
  }
  if (command === "logs") {
    const first = await client.request("/v1/control/logs");
    const exitCode = emit(first);
    if (exitCode !== 0 || !hasFlag(parsed, "follow")) return exitCode;
    return followLogs(client, emit);
  }
  if (command === "provider") return emit(await runProviderCommand(parsed, client));
  if (command === "workspace") return emit(await runWorkspaceCommand(parsed, client));
  if (command === "credential") {
    const action = parsed.positionals[1];
    if (action !== "rotate") throw new BridgeError("BRIDGE_STATE_INVALID", `Unknown credential command: ${action ?? ""}`);
    return emit(await client.request("/v1/control/credential/rotate", { method: "POST" }));
  }
  if (command === "pair" || command === "open") {
    if (command === "pair" && parsed.positionals[1] === "revoke") {
      return emit(await client.request("/v1/control/pair/revoke", { method: "POST" }));
    }
    return emit(await client.request("/v1/control/pair", {
      method: "POST",
      body: {
        ...(getFlag(parsed, "workspace") ? { workspaceId: getFlag(parsed, "workspace") } : {}),
        openBrowser: command === "open"
      }
    }));
  }
  if (command === "login") {
    return emit(await client.request("/v1/control/login", {
      method: "POST",
      body: { openBrowser: !hasFlag(parsed, "no-open") }
    }));
  }
  if (command === "logout") return emit(await client.request("/v1/control/logout", { method: "POST" }));
  if (command === "remote") {
    const action = parsed.positionals[1] ?? "status";
    if (action === "status") return emit(await client.request("/v1/control/remote"));
    if (action === "enable" || action === "disable") {
      return emit(await client.request(`/v1/control/remote/${action}`, { method: "POST" }));
    }
    throw new BridgeError("BRIDGE_STATE_INVALID", `Unknown remote command: ${action}`);
  }
  throw new BridgeError("BRIDGE_STATE_INVALID", `Unknown client command: ${command}`);
}

async function runProviderCommand(parsed: ParsedBridgeCliArgs, client: BridgeControlClient): Promise<BridgeCliResult> {
  const action = parsed.positionals[1] ?? "status";
  if (action === "list" || action === "status") {
    return client.request(`/v1/control/provider${action === "status" ? "" : "?list=1"}`, {
      timeoutMs: PROVIDER_CONTROL_TIMEOUT_MS
    });
  }
  if (action === "check") {
    assertCodex(parsed.positionals[2]);
    return client.request("/v1/control/provider/check", {
      method: "POST",
      timeoutMs: PROVIDER_CONTROL_TIMEOUT_MS
    });
  }
  if (action === "set") {
    assertCodex(parsed.positionals[2]);
    const result = await client.request("/v1/control/provider", {
      method: "PUT",
      timeoutMs: PROVIDER_CONTROL_TIMEOUT_MS,
      body: {
        providerId: "codex",
        ...(getFlag(parsed, "binary") ? { binaryPath: getFlag(parsed, "binary") } : {}),
        ...(getFlag(parsed, "codex-home") ? { home: getFlag(parsed, "codex-home") } : {})
      }
    });
    if (!result.ok
      && result.code === "BRIDGE_NOT_RUNNING"
      && getFlag(parsed, "home")
      && !getFlag(parsed, "codex-home")) {
      return cliFailure(
        "BRIDGE_NOT_RUNNING",
        "Hunsu Bridge is not running at the selected HUNSU_HOME. --home selects HUNSU_HOME; use --codex-home to configure Codex Home."
      );
    }
    return result;
  }
  if (action === "reset") {
    assertCodex(parsed.positionals[2]);
    return client.request("/v1/control/provider", {
      method: "PUT",
      timeoutMs: PROVIDER_CONTROL_TIMEOUT_MS,
      body: { providerId: "codex", reset: true }
    });
  }
  throw new BridgeError("BRIDGE_STATE_INVALID", `Unknown provider command: ${action}`);
}

async function runWorkspaceCommand(parsed: ParsedBridgeCliArgs, client: BridgeControlClient): Promise<BridgeCliResult> {
  const action = parsed.positionals[1] ?? "list";
  if (action === "list") return client.request("/v1/control/workspaces");
  if (action === "add") {
    const path = parsed.positionals[2];
    if (!path) throw new BridgeError("WORKSPACE_PATH_INVALID", "Workspace path is required.");
    return client.request("/v1/control/workspaces", { method: "POST", body: { path } });
  }
  const workspaceId = parsed.positionals[2];
  if (!workspaceId) throw new BridgeError("WORKSPACE_NOT_FOUND", "Workspace id is required.");
  const encoded = encodeURIComponent(workspaceId);
  if (action === "inspect") return client.request(`/v1/control/workspaces/${encoded}`);
  if (action === "remove") return client.request(`/v1/control/workspaces/${encoded}`, { method: "DELETE" });
  if (action === "open") return client.request(`/v1/control/workspaces/${encoded}/open`, { method: "POST" });
  if (action === "grant" || action === "revoke") {
    const scopes = action === "revoke" ? [] : parseRemoteScopes(getFlag(parsed, "scopes"));
    return client.request(`/v1/control/workspaces/${encoded}/remote-access`, {
      method: "PUT",
      body: { enabled: action === "grant", scopes }
    });
  }
  throw new BridgeError("BRIDGE_STATE_INVALID", `Unknown workspace command: ${action}`);
}

function parseRemoteScopes(value: string | undefined): BridgeRemoteWorkspaceScope[] {
  const requested = (value ?? "remoteRelay.access")
    .split(",")
    .map(scope => scope.trim())
    .filter(Boolean);
  const scopes = requested.map(scope => {
    if (!BRIDGE_REMOTE_WORKSPACE_SCOPES.includes(scope as BridgeRemoteWorkspaceScope)) {
      throw new BridgeError("BRIDGE_STATE_INVALID", `Unsupported Workspace Remote scope: ${scope}`);
    }
    return scope as BridgeRemoteWorkspaceScope;
  });
  if (!scopes.includes("remoteRelay.access")) {
    throw new BridgeError("BRIDGE_STATE_INVALID", "Workspace Remote grants require remoteRelay.access.");
  }
  return [...new Set(scopes)];
}

async function followLogs(client: BridgeControlClient, emit: (result: BridgeCliResult) => number): Promise<number> {
  let stopped = false;
  const stop = (): void => { stopped = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    while (!stopped) {
      await new Promise(resolve => setTimeout(resolve, 1_000));
      if (stopped) break;
      const result = await client.request("/v1/control/logs?limit=50");
      if (emit(result) !== 0) return 1;
    }
    return 0;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

function assertCodex(value: string | undefined): void {
  if (value !== "codex") throw new BridgeError("PROVIDER_NOT_CONFIGURED", "The first headless Bridge prerelease supports only Codex.");
}
