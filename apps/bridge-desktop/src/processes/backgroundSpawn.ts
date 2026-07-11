import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { isSea } from "node:sea";
import { codexProviderEnv, type BridgeRuntimeHandle } from "@hunsu/bridge";
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

export type BridgeCommandInvocation = {
  command: string;
  args: string[];
};

export type WindowsProcessIdentity = {
  processId: number;
  parentProcessId: number;
  executablePath?: string;
  commandLine?: string;
  creationDate: string;
};

export function bridgeNodeExecArgs(): string[] {
  return process.execArgv.filter(arg => !arg.startsWith("--inspect"));
}

export function currentBridgeCommandInvocation(input: {
  commandArgs?: string[];
  env?: Record<string, string | undefined>;
  argv?: string[];
  execPath?: string;
  packaged?: boolean;
} = {}): BridgeCommandInvocation {
  const env = input.env ?? currentProcessEnv();
  const commandArgs = input.commandArgs ?? [];
  const overrideCommand = env.HUNSU_BRIDGE_SIDECAR_COMMAND?.trim();
  if (overrideCommand) {
    return {
      command: overrideCommand,
      args: [...bridgeInvocationOverrideArgs(env.HUNSU_BRIDGE_SIDECAR_ARGS), ...commandArgs]
    };
  }
  const argv = input.argv ?? process.argv;
  const execPath = input.execPath ?? process.execPath;
  const entrypoint = currentBridgeEntrypointArg(argv, execPath);
  if (input.packaged === true || input.packaged === undefined && isPackagedBridgeExecutable(argv, execPath)) {
    return { command: execPath, args: commandArgs };
  }
  return {
    command: execPath,
    args: [
      ...bridgeNodeExecArgs(),
      entrypoint ?? "hunsu-bridge",
      ...commandArgs
    ]
  };
}

export function isPackagedBridgeExecutable(argv = process.argv, execPath = process.execPath): boolean {
  const entrypoint = currentBridgeEntrypointArg(argv, execPath);
  return isSea() || entrypoint === undefined || isPackagedBridgeExecutablePath(entrypoint);
}

export function currentBridgeProcessCommandIdentity(kind: BridgeProcessCommandIdentity["kind"]): BridgeProcessCommandIdentity {
  const inheritedNonce = currentProcessEnv()[BRIDGE_PROCESS_NONCE_ENV]?.trim() || undefined;
  const invocation = currentBridgeCommandInvocation({ commandArgs: currentBridgeRuntimeArgs() });
  return bridgeProcessCommandIdentityForSpawn(kind, [invocation.command, ...invocation.args], inheritedNonce);
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
  const windowsIdentity = process.platform === "win32" ? inspectWindowsProcess(pid) : undefined;
  const verifiableNonce = processNonceCanBeVerified() && processEnvironmentValue(pid, BRIDGE_PROCESS_NONCE_ENV) === commandIdentity.nonce
    ? commandIdentity.nonce
    : undefined;
  return {
    pid,
    processNonce: verifiableNonce,
    commandIdentity,
    startMetadata: processStartMetadata(pid),
    parentPid: windowsIdentity?.parentProcessId,
    executablePath: windowsIdentity?.executablePath,
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
  const invocation = currentBridgeCommandInvocation({
    commandArgs: [
      "daemon",
      "--cwd",
      input.cwd,
      ...(input.webUrl ? ["--web-url", input.webUrl] : []),
      ...(input.remote ? ["--remote"] : []),
      ...(input.noOpen ? ["--no-open"] : [])
    ]
  });
  return new BridgeSidecarSupervisor({
    command: invocation.command,
    args: invocation.args,
    cwd: input.cwd,
    env: {
      ...bridgeProcessEnvWithNonce({
        state: input.state,
        nonce: daemonNonce,
        activeProjectGrants: input.activeProjectGrants
      }),
      HUNSU_BRIDGE_SUPERVISOR_PID: String(process.pid)
    },
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
    const invocation = currentBridgeCommandInvocation({ commandArgs: input.args });
    const commandIdentity = bridgeProcessCommandIdentityForSpawn("remote-attach", [invocation.command, ...invocation.args]);
    const child = spawn(invocation.command, invocation.args, {
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
    ...codexProviderEnv({
      baseEnv: currentProcessEnv(),
      settings: codex
    }),
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
  if (process.platform === "win32") {
    const identity = inspectWindowsProcess(pid);
    return identity ? {
      platform: process.platform,
      source: "windows-cim-creation-date",
      value: identity.creationDate
    } : undefined;
  }
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
  if (process.platform === "win32") {
    return inspectWindowsProcess(pid)?.commandLine;
  }
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

export function inspectWindowsProcess(
  pid: number,
  runPowerShell: (script: string) => string = runWindowsPowerShell
): WindowsProcessIdentity | undefined {
  if (!Number.isInteger(pid) || pid <= 0) {
    return undefined;
  }
  const script = [
    `$process = Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\"`,
    "if ($null -eq $process) { exit 3 }",
    "$process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine,CreationDate | ConvertTo-Json -Compress"
  ].join("; ");
  try {
    return windowsProcessIdentityFromJson(runPowerShell(script));
  } catch (_error) {
    return undefined;
  }
}

export function windowsProcessIdentityFromJson(value: string): WindowsProcessIdentity | undefined {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const processId = Number(parsed.ProcessId);
    const parentProcessId = Number(parsed.ParentProcessId);
    const creationDate = typeof parsed.CreationDate === "string" ? parsed.CreationDate.trim() : "";
    if (!Number.isInteger(processId) || processId <= 0 || !Number.isInteger(parentProcessId) || parentProcessId < 0 || !creationDate) {
      return undefined;
    }
    return {
      processId,
      parentProcessId,
      executablePath: nonEmptyProcessString(parsed.ExecutablePath),
      commandLine: nonEmptyProcessString(parsed.CommandLine),
      creationDate
    };
  } catch (_error) {
    return undefined;
  }
}

function runWindowsPowerShell(script: string): string {
  return execFileSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script
  ], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true
  }).trim();
}

function nonEmptyProcessString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
    controlToken: handle.controlToken,
    pairing: handle.pairing ? {
      issuedAt: handle.pairing.issuedAt,
      expiresAt: handle.pairing.expiresAt,
      revokedAt: handle.pairing.revokedAt
    } : undefined,
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

function currentBridgeRuntimeArgs(): string[] {
  return currentBridgeEntrypointArg() === undefined ? process.argv.slice(1) : process.argv.slice(2);
}

function currentBridgeEntrypointArg(argv = process.argv, execPath = process.execPath): string | undefined {
  const entrypoint = argv[1];
  if (!entrypoint?.trim()) {
    return undefined;
  }
  try {
    if (resolve(entrypoint) === resolve(execPath)) {
      return undefined;
    }
  } catch (_error) {
    return entrypoint;
  }
  return entrypoint;
}

function isPackagedBridgeExecutablePath(value: string): boolean {
  return /\.exe$/i.test(value) && basename(value).toLowerCase().startsWith("hunsu-bridge");
}

function bridgeInvocationOverrideArgs(value: string | undefined): string[] {
  if (!value?.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed) && parsed.every(item => typeof item === "string")) {
      return parsed;
    }
  } catch (_error) {
    // Fall back to shell-like whitespace splitting for simple overrides.
  }
  return value.match(/"([^"]*)"|'([^']*)'|\S+/g)?.map(item => item.replace(/^["']|["']$/g, "")) ?? [];
}

function newBridgeProcessNonce(): string {
  return `bridge_process_${randomBytes(12).toString("base64url")}`;
}
