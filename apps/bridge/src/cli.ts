#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { assertDiagnosticsSafe, sanitizeDiagnostics } from "./diagnostics/redaction.ts";
import { startBridgeDaemon, type RunningBridgeDaemon } from "./daemon/daemon.ts";
import {
  bridgeCliJsonRequested,
  getFlag,
  hasFlag,
  parseBridgeCliArgs,
  type ParsedBridgeCliArgs
} from "./client/cliArgs.ts";
import { isBridgeClientCommand, runBridgeClientCommand } from "./client/clientCommands.ts";
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
import { createRuntimeInstallStore } from "./setup/runtimeInstaller.ts";
import { localBridgeTarballSource } from "./setup/runtimePackageSource.ts";
import { removeBridge } from "./setup/uninstall.ts";
import { setupBridge } from "./setup/setup.ts";
import { SetupInProgressError, acquireSetupOperationLock } from "./setup/setupTransaction.ts";
import { HUNSU_BRIDGE_VERSION } from "./version.ts";

type CliIo = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
};

export { parseBridgeCliArgs } from "./client/cliArgs.ts";

export async function runBridgeCli(argv = process.argv.slice(2), io: CliIo = defaultIo): Promise<number> {
  let parsed: ParsedBridgeCliArgs;
  try {
    parsed = parseBridgeCliArgs(argv);
  } catch (error) {
    return printResult(bridgeErrorResult(error), bridgeCliJsonRequested(argv), io);
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
    const home = getFlag(parsed, "home");
    const paths = resolveHunsuPaths({ home, env: process.env });
    const client = createBridgeControlClient({ paths });

    if (command === "dev" || command === "daemon") {
      const daemon = await startBridgeDaemon({
        home,
        host: getFlag(parsed, "host"),
        port: parseOptionalPort(getFlag(parsed, "port")),
        cwd: getFlag(parsed, "cwd"),
        runtimePath: getFlag(parsed, "runtime-path"),
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
        ...(getFlag(parsed, "runtime-package")
          ? { runtimeSource: localBridgeTarballSource(getFlag(parsed, "runtime-package")!) }
          : {}),
        dryRun: hasFlag(parsed, "dry-run"),
        verifyRuntime: installation => verifyInstalledRuntime(
          client,
          installation.packageVersion,
          installation.runtimePath
        )
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
    if (isBridgeClientCommand(command)) {
      return runBridgeClientCommand({
        parsed,
        paths,
        client,
        emit: result => printResult(result, json, io)
      });
    }
    throw new BridgeError("BRIDGE_STATE_INVALID", `Unknown command: ${command}`);
  } catch (error) {
    return printResult(bridgeErrorResult(error), json, io);
  }
}

async function runServiceCommand(
  parsed: ParsedBridgeCliArgs,
  serviceManager: ReturnType<typeof createDefaultBridgeServiceManager>,
  paths: ReturnType<typeof resolveHunsuPaths>
): Promise<BridgeCliResult> {
  const action = parsed.positionals[1] ?? "status";
  if (action === "status") return cliSuccess("Hunsu Bridge service status is available.", await serviceManager.status());
  if (action === "install") {
    return withServiceMutationLock(paths, async () => {
      const install = await createRuntimeInstallStore(paths).read();
      if (!install) return cliFailure("SERVICE_INSTALL_FAILED", "Run `hunsu-bridge setup` before installing the service definition.");
      return serviceResult(await serviceManager.install(install.serviceInput));
    });
  }
  if (action === "uninstall") {
    return withServiceMutationLock(paths, async () => serviceResult(await serviceManager.uninstall()));
  }
  if (action === "start") return serviceResult(await serviceManager.start());
  if (action === "stop") return serviceResult(await serviceManager.stop());
  if (action === "restart") return serviceResult(await serviceManager.restart());
  throw new BridgeError("BRIDGE_STATE_INVALID", `Unknown service command: ${action}`);
}

async function withServiceMutationLock(
  paths: ReturnType<typeof resolveHunsuPaths>,
  action: () => Promise<BridgeCliResult>
): Promise<BridgeCliResult> {
  let lease;
  try {
    lease = await acquireSetupOperationLock(paths, "service-mutation");
  } catch (error) {
    if (error instanceof SetupInProgressError) return cliFailure(error.code, error.message);
    return cliFailure("SERVICE_INSTALL_FAILED", "The Bridge service mutation lock could not be acquired safely.");
  }
  let result: BridgeCliResult | undefined;
  let actionError: unknown;
  try {
    result = await action();
  } catch (error) {
    actionError = error;
  }
  try {
    await lease.release();
  } catch (_error) {
    return cliFailure("SERVICE_INSTALL_FAILED", "The Bridge service mutation lock could not be released safely.");
  }
  if (actionError !== undefined) throw actionError;
  return result!;
}

function serviceResult(result: Awaited<ReturnType<ReturnType<typeof createDefaultBridgeServiceManager>["start"]>>): BridgeCliResult {
  return result.ok ? cliSuccess(result.message, { manager: result.manager, changed: result.changed }, result.code) : cliFailure(result.code, result.message);
}

async function verifyInstalledRuntime(
  client: ReturnType<typeof createBridgeControlClient>,
  expectedVersion: string,
  expectedRuntimePath: string
): Promise<{ health: boolean; authenticated: boolean; version: string; runtimePath: string }> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const health = await client.health();
    if (health) {
      const status = await client.request<{ version?: string; runtimePath?: string }>("/v1/control/status");
      return {
        health: true,
        authenticated: status.ok,
        version: status.ok && typeof status.value?.version === "string" ? status.value.version : health.version,
        runtimePath: status.ok && typeof status.value?.runtimePath === "string"
          ? status.value.runtimePath
          : "unavailable"
      };
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return {
    health: false,
    authenticated: false,
    version: expectedVersion,
    runtimePath: expectedRuntimePath
  };
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
  provider list|status|set codex [--binary <path>] [--codex-home <path>]|check codex|reset codex
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
