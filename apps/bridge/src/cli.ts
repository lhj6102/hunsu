#!/usr/bin/env node
import { createDoctorReport } from "./diagnostics/doctor.ts";
import { pathToFileURL } from "node:url";
import { assertDiagnosticsSafe, sanitizeDiagnostics } from "./diagnostics/redaction.ts";
import { startBridgeDaemon, type RunningBridgeDaemon } from "./daemon/daemon.ts";
import {
  BridgeError,
  bridgeErrorResult,
  cliFailure,
  cliSuccess,
  type BridgeCliResult
} from "./client/cliResult.ts";
import { createBridgeControlClient } from "./client/controlClient.ts";
import { createDefaultBridgeServiceManager } from "./service/defaultServiceManager.ts";
import { createCredentialStore, resolveHunsuPaths } from "./state/index.ts";
import { BRIDGE_REMOTE_WORKSPACE_SCOPES, type BridgeRemoteWorkspaceScope } from "./state/workspaceStore.ts";
import { createRuntimeInstallStore } from "./setup/runtimeInstaller.ts";
import { removeBridge } from "./setup/uninstall.ts";
import { setupBridge } from "./setup/setup.ts";
import { HUNSU_BRIDGE_VERSION } from "./version.ts";

type ParsedArgs = {
  positionals: string[];
  flags: Map<string, string | boolean>;
};

type CliIo = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
};

const BOOLEAN_FLAGS = new Set([
  "json",
  "help",
  "version",
  "follow",
  "delete-data",
  "keep-data",
  "confirm-delete-data",
  "no-open",
  "dry-run"
]);

export async function runBridgeCli(argv = process.argv.slice(2), io: CliIo = defaultIo): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseBridgeCliArgs(argv);
  } catch (error) {
    return printResult(bridgeErrorResult(error), argv.includes("--json"), io);
  }
  const json = hasFlag(parsed, "json");

  try {
    if (hasFlag(parsed, "version") || parsed.positionals[0] === "version") {
      return printResult(cliSuccess(`Hunsu Bridge ${HUNSU_BRIDGE_VERSION}.`, { version: HUNSU_BRIDGE_VERSION }), json, io);
    }
    if (hasFlag(parsed, "help") || parsed.positionals[0] === "help" || parsed.positionals.length === 0) {
      if (json) return printResult(cliSuccess("Hunsu Bridge command help.", { usage: helpText() }), true, io);
      io.stdout(helpText());
      return 0;
    }

    const command = parsed.positionals[0]!;
    const home = command === "provider" && parsed.positionals[1] === "set"
      ? undefined
      : getFlag(parsed, "home");
    const paths = resolveHunsuPaths({ home, env: process.env });
    const client = createBridgeControlClient({ paths });

    if (command === "dev" || command === "daemon") {
      const daemon = await startBridgeDaemon({
        home,
        host: getFlag(parsed, "host"),
        port: parseOptionalPort(getFlag(parsed, "port")),
        cwd: getFlag(parsed, "cwd"),
        webUrl: getFlag(parsed, "web-url"),
        development: command === "dev"
      });
      const result = cliSuccess(
        command === "dev" ? "Hunsu Bridge development daemon is ready." : "Hunsu Bridge daemon is ready.",
        { endpoint: daemon.identity.endpoint, version: daemon.identity.version, protocolVersion: daemon.identity.protocolVersion }
      );
      printResult(result, json, io);
      await waitForDaemon(daemon);
      return 0;
    }

    const serviceManager = createDefaultBridgeServiceManager({ paths, controlClient: client });
    if (command === "setup") {
      const channel = getFlag(parsed, "channel") ?? "next";
      if (channel !== "next") throw new BridgeError("RUNTIME_INSTALL_FAILED", "The initial headless prerelease supports only the next channel.");
      const result = await setupBridge({
        paths,
        credentialStore: createCredentialStore(paths),
        serviceManager,
        dryRun: hasFlag(parsed, "dry-run"),
        verifyRuntime: installation => verifyInstalledRuntime(client, installation.packageVersion)
      });
      return printResult(result.ok ? cliSuccess(result.message, result.value) : cliFailure(result.code, result.message), json, io);
    }
    if (command === "remove") {
      const result = await removeBridge({
        deleteData: hasFlag(parsed, "delete-data"),
        confirmed: hasFlag(parsed, "confirm-delete-data"),
        dryRun: hasFlag(parsed, "dry-run")
      }, { paths, serviceManager });
      return printResult(result.ok ? cliSuccess(result.message, result.value) : cliFailure(result.code, result.message), json, io);
    }
    if (command === "service") {
      return printResult(await runServiceCommand(parsed, serviceManager, paths), json, io);
    }
    if (command === "status") {
      return printResult(await client.request("/v1/control/status"), json, io);
    }
    if (command === "doctor") {
      const online = await client.request("/v1/control/doctor");
      const result = !online.ok && online.code === "BRIDGE_NOT_RUNNING"
        ? cliSuccess("Offline Bridge diagnostics completed.", await createDoctorReport({ paths, online: false }))
        : online;
      return printResult(result, json, io);
    }
    if (command === "logs") {
      const first = await client.request("/v1/control/logs");
      const exitCode = printResult(first, json, io);
      if (exitCode !== 0 || !hasFlag(parsed, "follow")) return exitCode;
      await followLogs(client, json, io);
      return 0;
    }
    if (command === "provider") {
      return printResult(await runProviderCommand(parsed, client), json, io);
    }
    if (command === "workspace") {
      return printResult(await runWorkspaceCommand(parsed, client), json, io);
    }
    if (command === "credential") {
      const action = parsed.positionals[1];
      if (action !== "rotate") throw new BridgeError("BRIDGE_STATE_INVALID", `Unknown credential command: ${action ?? ""}`);
      return printResult(await client.request("/v1/control/credential/rotate", { method: "POST" }), json, io);
    }
    if (command === "pair" || command === "open") {
      if (command === "pair" && parsed.positionals[1] === "revoke") {
        return printResult(await client.request("/v1/control/pair/revoke", { method: "POST" }), json, io);
      }
      return printResult(await client.request("/v1/control/pair", {
        method: "POST",
        body: {
          ...(getFlag(parsed, "workspace") ? { workspaceId: getFlag(parsed, "workspace") } : {}),
          openBrowser: command === "open"
        }
      }), json, io);
    }
    if (command === "login") {
      return printResult(await client.request("/v1/control/login", {
        method: "POST",
        body: { openBrowser: !hasFlag(parsed, "no-open") }
      }), json, io);
    }
    if (command === "logout") {
      return printResult(await client.request("/v1/control/logout", { method: "POST" }), json, io);
    }
    if (command === "remote") {
      const action = parsed.positionals[1] ?? "status";
      if (action === "status") return printResult(await client.request("/v1/control/remote"), json, io);
      if (action === "enable" || action === "disable") {
        return printResult(await client.request(`/v1/control/remote/${action}`, { method: "POST" }), json, io);
      }
      throw new BridgeError("BRIDGE_STATE_INVALID", `Unknown remote command: ${action}`);
    }
    throw new BridgeError("BRIDGE_STATE_INVALID", `Unknown command: ${command}`);
  } catch (error) {
    return printResult(bridgeErrorResult(error), json, io);
  }
}

export function parseBridgeCliArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const raw = token.slice(2);
    if (!raw) throw new BridgeError("BRIDGE_STATE_INVALID", "Invalid empty command flag.");
    const equals = raw.indexOf("=");
    if (equals >= 0) {
      flags.set(raw.slice(0, equals), raw.slice(equals + 1));
      continue;
    }
    if (BOOLEAN_FLAGS.has(raw)) {
      flags.set(raw, true);
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new BridgeError("BRIDGE_STATE_INVALID", `--${raw} requires a value.`);
    flags.set(raw, value);
    index += 1;
  }
  return { positionals, flags };
}

async function runServiceCommand(
  parsed: ParsedArgs,
  serviceManager: ReturnType<typeof createDefaultBridgeServiceManager>,
  paths: ReturnType<typeof resolveHunsuPaths>
): Promise<BridgeCliResult> {
  const action = parsed.positionals[1] ?? "status";
  if (action === "status") return cliSuccess("Hunsu Bridge service status is available.", await serviceManager.status());
  if (action === "install") {
    const install = await createRuntimeInstallStore(paths).read();
    if (!install) return cliFailure("SERVICE_INSTALL_FAILED", "Run `hunsu-bridge setup` before installing the service definition.");
    return serviceResult(await serviceManager.install(install.serviceInput));
  }
  if (action === "uninstall") return serviceResult(await serviceManager.uninstall());
  if (action === "start") return serviceResult(await serviceManager.start());
  if (action === "stop") return serviceResult(await serviceManager.stop());
  if (action === "restart") return serviceResult(await serviceManager.restart());
  throw new BridgeError("BRIDGE_STATE_INVALID", `Unknown service command: ${action}`);
}

async function runProviderCommand(parsed: ParsedArgs, client: ReturnType<typeof createBridgeControlClient>): Promise<BridgeCliResult> {
  const action = parsed.positionals[1] ?? "status";
  if (action === "list" || action === "status") return client.request(`/v1/control/provider${action === "status" ? "" : "?list=1"}`);
  if (action === "check") {
    assertCodex(parsed.positionals[2]);
    return client.request("/v1/control/provider/check", { method: "POST" });
  }
  if (action === "set") {
    assertCodex(parsed.positionals[2]);
    return client.request("/v1/control/provider", {
      method: "PUT",
      body: {
        providerId: "codex",
        ...(getFlag(parsed, "binary") ? { binaryPath: getFlag(parsed, "binary") } : {}),
        ...(getFlag(parsed, "home") ? { home: getFlag(parsed, "home") } : {})
      }
    });
  }
  if (action === "reset") {
    assertCodex(parsed.positionals[2]);
    return client.request("/v1/control/provider", { method: "PUT", body: { providerId: "codex", reset: true } });
  }
  throw new BridgeError("BRIDGE_STATE_INVALID", `Unknown provider command: ${action}`);
}

async function runWorkspaceCommand(parsed: ParsedArgs, client: ReturnType<typeof createBridgeControlClient>): Promise<BridgeCliResult> {
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

function serviceResult(result: Awaited<ReturnType<ReturnType<typeof createDefaultBridgeServiceManager>["start"]>>): BridgeCliResult {
  return result.ok ? cliSuccess(result.message, { manager: result.manager, changed: result.changed }, result.code) : cliFailure(result.code, result.message);
}

async function verifyInstalledRuntime(
  client: ReturnType<typeof createBridgeControlClient>,
  expectedVersion: string
): Promise<{ health: boolean; authenticated: boolean; version: string }> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const health = await client.health();
    if (health) {
      const status = await client.request<{ version?: string }>("/v1/control/status");
      return {
        health: true,
        authenticated: status.ok,
        version: status.ok && typeof status.value?.version === "string" ? status.value.version : health.version
      };
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return { health: false, authenticated: false, version: expectedVersion };
}

async function waitForDaemon(daemon: RunningBridgeDaemon): Promise<void> {
  const shutdown = (): void => { void daemon.close(); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    await daemon.waitUntilClosed();
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  }
}

async function followLogs(
  client: ReturnType<typeof createBridgeControlClient>,
  json: boolean,
  io: CliIo
): Promise<void> {
  let stopped = false;
  const stop = (): void => { stopped = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    while (!stopped) {
      await new Promise(resolve => setTimeout(resolve, 1_000));
      if (stopped) break;
      const result = await client.request("/v1/control/logs?limit=50");
      if (printResult(result, json, io) !== 0) break;
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

function printResult(result: BridgeCliResult, json: boolean, io: CliIo): number {
  const safe = safeResult(result);
  if (json) {
    io.stdout(JSON.stringify(safe));
  } else if (safe.ok) {
    io.stdout(safe.message);
    if (safe.value !== undefined) io.stdout(JSON.stringify(safe.value, null, 2));
  } else {
    io.stderr(`${safe.code}: ${safe.message}`);
    if (safe.recovery?.command) io.stderr(`Recovery: ${safe.recovery.command}`);
  }
  return safe.ok ? 0 : 1;
}

function safeResult(result: BridgeCliResult): BridgeCliResult {
  try {
    const safe = sanitizeDiagnostics(result) as BridgeCliResult;
    assertDiagnosticsSafe(safe);
    return safe;
  } catch (_error) {
    return cliFailure("DIAGNOSTICS_SENSITIVE_DATA_DETECTED", "Sensitive data was removed from Bridge command output.");
  }
}

function parseOptionalPort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new BridgeError("BRIDGE_STATE_INVALID", "--port must be an integer from 0 through 65535.");
  return port;
}

function assertCodex(value: string | undefined): void {
  if (value !== "codex") throw new BridgeError("PROVIDER_NOT_CONFIGURED", "The first headless Bridge prerelease supports only Codex.");
}

function getFlag(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function hasFlag(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags.get(name) === true;
}

function helpText(): string {
  return `Usage: hunsu-bridge <command> [options]

Lifecycle:
  setup [--channel next]              Install an exact stable runtime and user service.
  remove [--delete-data --confirm-delete-data]
  service install|uninstall|start|stop|restart|status
  dev [--host 127.0.0.1] [--port 0] [--home <path>]
  daemon

Client commands (never start a daemon):
  status | doctor | logs [--follow]
  provider list|status|set codex|check codex|reset codex
  workspace add <path>|list|inspect <id>|remove <id>|open <id>
  workspace grant <id> [--scopes <csv>] | revoke <id>
  credential rotate                   Rotate and revoke the local control credential.
  pair [--workspace <id>] | pair revoke | open [--workspace <id>]
  login | logout | remote enable|disable|status

Common options:
  --json                              Emit the stable hunsu.bridge.cli-result.v1 schema.
  --home <path>                       Use an explicit HUNSU_HOME for this invocation.
  --help                              Show help.
  --version                           Show the package version.`;
}

const defaultIo: CliIo = {
  stdout: text => process.stdout.write(`${text}\n`),
  stderr: text => process.stderr.write(`${text}\n`)
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runBridgeCli().then(code => {
    process.exitCode = code;
  }).catch(() => {
    process.stderr.write("Hunsu Bridge command failed unexpectedly.\n");
    process.exitCode = 1;
  });
}
