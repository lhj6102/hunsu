import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { BridgeRuntimeHandle } from "@hunsu/bridge";
import { currentProcessEnv } from "@hunsu/config";
import { BridgeSidecarSupervisor } from "./sidecarSupervisor.ts";
import type {
  BridgeAppState,
  BridgeProcessCommandIdentity,
  BridgeProcessRuntimeMetadata,
  BridgeProcessStartMetadata
} from "../state/appState.ts";
import { bridgeCodexProviderSettings } from "../state/appState.ts";
import type { ProjectGrant } from "../relay.ts";

export const BRIDGE_PROCESS_NONCE_ENV = "HUNSU_BRIDGE_PROCESS_NONCE";

export function bridgeNodeExecArgs(): string[] {
  return process.execArgv.filter(arg => !arg.startsWith("--inspect"));
}

export function currentBridgeProcessCommandIdentity(kind: BridgeProcessCommandIdentity["kind"]): BridgeProcessCommandIdentity {
  const inheritedNonce = currentProcessEnv()[BRIDGE_PROCESS_NONCE_ENV]?.trim() || undefined;
  return bridgeProcessCommandIdentityForSpawn(kind, [process.execPath, ...bridgeNodeExecArgs(), process.argv[1] ?? "hunsu-bridge", ...process.argv.slice(2)], inheritedNonce);
}

export function bridgeProcessCommandIdentityForSpawn(kind: BridgeProcessCommandIdentity["kind"], argv: string[], nonce = newBridgeProcessNonce()): BridgeProcessCommandIdentity {
  return {
    kind,
    executable: argv[0] ?? process.execPath,
    argv,
    nonce
  };
}

export function bridgeProcessRuntimeMetadata(pid: number, commandIdentity: BridgeProcessCommandIdentity): BridgeProcessRuntimeMetadata {
  const verifiableNonce = processNonceCanBeVerified() && processEnvironmentValue(pid, BRIDGE_PROCESS_NONCE_ENV) === commandIdentity.nonce
    ? commandIdentity.nonce
    : undefined;
  return {
    pid,
    processNonce: verifiableNonce,
    commandIdentity,
    startMetadata: processStartMetadata(pid),
    recordedAt: new Date().toISOString()
  };
}

export function createBridgeAppSidecarSupervisor(input: {
  cwd: string;
  webUrl?: string;
  remote?: boolean;
  noOpen?: boolean;
  restartLimit: number;
  appLogPath: string;
  state: BridgeAppState;
  activeProjectGrants: ProjectGrant[];
}): BridgeSidecarSupervisor {
  const daemonNonce = newBridgeProcessNonce();
  return new BridgeSidecarSupervisor({
    command: process.execPath,
    args: [
      ...bridgeNodeExecArgs(),
      process.argv[1] ?? "hunsu-bridge",
      "daemon",
      "--cwd",
      input.cwd,
      ...(input.webUrl ? ["--web-url", input.webUrl] : []),
      ...(input.remote ? ["--remote"] : []),
      ...(input.noOpen ? ["--no-open"] : [])
    ],
    cwd: input.cwd,
    env: bridgeProcessEnvWithNonce({
      state: input.state,
      nonce: daemonNonce,
      activeProjectGrants: input.activeProjectGrants
    }),
    logPath: input.appLogPath,
    restartLimit: input.restartLimit,
    restartDelayMs: 750
  });
}

export function startDetachedRemoteAccessProcess(input: {
  state: BridgeAppState;
  cwd: string;
  args: string[];
  activeProjectGrants: ProjectGrant[];
  writeState: (state: BridgeAppState) => void;
  writeStructuredLog: (value: Record<string, unknown>) => void;
}): boolean {
  try {
    const commandIdentity = bridgeProcessCommandIdentityForSpawn("remote-attach", [
      process.execPath,
      ...bridgeNodeExecArgs(),
      process.argv[1] ?? "hunsu-bridge",
      ...input.args
    ]);
    const child = spawn(process.execPath, [
      ...bridgeNodeExecArgs(),
      process.argv[1] ?? "hunsu-bridge",
      ...input.args
    ], {
      cwd: input.cwd,
      env: bridgeProcessEnvWithNonce({
        state: input.state,
        nonce: commandIdentity.nonce,
        activeProjectGrants: input.activeProjectGrants
      }),
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.unref();
    input.writeStructuredLog({ event: "relay.process.started", pid: child.pid, args: input.args });
    input.writeState({
      ...input.state,
      pid: child.pid,
      bridgeProcess: child.pid ? bridgeProcessRuntimeMetadata(child.pid, commandIdentity) : undefined,
      processNonce: commandIdentity.nonce,
      commandIdentity,
      cwd: input.cwd,
      remoteAccess: "registered-offline"
    });
    return true;
  } catch (error) {
    input.writeStructuredLog({ event: "relay.process.start-failed", error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

export function bridgeProcessEnvWithNonce(input: {
  state: BridgeAppState;
  nonce: string;
  activeProjectGrants: ProjectGrant[];
}): NodeJS.ProcessEnv {
  const codex = bridgeCodexProviderSettings(input.state);
  return {
    ...currentProcessEnv(),
    ...(codex?.binaryPath ? { HUNSU_CODEX_BINARY_PATH: codex.binaryPath } : {}),
    ...bridgeAppPersistedStatusEnv(input.state, input.activeProjectGrants),
    [BRIDGE_PROCESS_NONCE_ENV]: input.nonce
  };
}

export function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function processEnvironmentValue(pid: number, key: string): string | undefined {
  if (process.platform !== "linux") {
    return undefined;
  }
  try {
    const entries = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
    const prefix = `${key}=`;
    return entries.find(entry => entry.startsWith(prefix))?.slice(prefix.length);
  } catch (_error) {
    return undefined;
  }
}

export function processStartMetadata(pid: number): BridgeProcessStartMetadata | undefined {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const endCommandIndex = stat.lastIndexOf(") ");
      if (endCommandIndex >= 0) {
        const fieldsFromState = stat.slice(endCommandIndex + 2).trim().split(/\s+/);
        const startTicks = fieldsFromState[19];
        if (startTicks) {
          return { platform: process.platform, source: "proc-stat", value: startTicks };
        }
      }
    } catch (_error) {
      // Fall back to ps below.
    }
  }
  try {
    const startedAt = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return startedAt ? { platform: process.platform, source: "ps-lstart", value: startedAt } : undefined;
  } catch (_error) {
    return undefined;
  }
}

export function sameProcessStartMetadata(left: BridgeProcessStartMetadata, right: BridgeProcessStartMetadata): boolean {
  return left.platform === right.platform
    && left.source === right.source
    && left.value === right.value;
}

export function processCommandLine(pid: number): string | undefined {
  if (process.platform === "linux") {
    try {
      const commandLine = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
      if (commandLine) {
        return commandLine;
      }
    } catch (_error) {
      // Fall back to ps below.
    }
  }
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch (_error) {
    return undefined;
  }
}

export function commandLineLooksLikeBridgeApp(commandLine: string, expectedKinds: BridgeProcessCommandIdentity["kind"][]): boolean {
  const normalized = commandLine.toLowerCase();
  const hasBridgeExecutable = normalized.includes("hunsu-bridge")
    || normalized.includes("bridge-desktop")
    || normalized.includes("/src/main.ts")
    || normalized.includes("\\src\\main.ts");
  const hasExpectedCommand = expectedKinds.some(expectedKind =>
    normalized.includes(expectedKind)
    || (expectedKind === "remote-attach" && (normalized.includes("remote attach") || normalized.includes("daemon")))
  );
  return hasBridgeExecutable && hasExpectedCommand;
}

export function handleToRuntimeState(state: BridgeAppState, handle: BridgeRuntimeHandle, cwd: string, webUrl: string | undefined): BridgeAppState {
  const commandIdentity = currentBridgeProcessCommandIdentity("daemon");
  return {
    ...state,
    pid: process.pid,
    bridgeProcess: bridgeProcessRuntimeMetadata(process.pid, commandIdentity),
    bridgeApiUrl: handle.bridgeApiUrl,
    processNonce: commandIdentity.nonce,
    commandIdentity,
    authToken: handle.authToken,
    controlToken: handle.controlToken,
    pairing: handle.pairing,
    cwd,
    webUrl,
    startedAt: handle.startedAt,
    remoteAccess: state.remoteAccess
  };
}

function bridgeAppPersistedStatusEnv(state: BridgeAppState, activeProjectGrants: ProjectGrant[]): NodeJS.ProcessEnv {
  const account = state.account?.status === "signed-in" ? state.account : undefined;
  return {
    ...(account?.userId ? { HUNSU_BRIDGE_ACCOUNT_USER_ID: account.userId } : {}),
    ...(account?.email ? { HUNSU_BRIDGE_ACCOUNT_EMAIL: account.email } : {}),
    HUNSU_BRIDGE_PROJECT_GRANTS_JSON: JSON.stringify(activeProjectGrants)
  };
}

function processNonceCanBeVerified(): boolean {
  return process.platform === "linux";
}

function newBridgeProcessNonce(): string {
  return `bridge_process_${randomBytes(12).toString("base64url")}`;
}
