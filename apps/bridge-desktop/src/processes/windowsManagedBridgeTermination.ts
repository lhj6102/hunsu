import { execFileSync } from "node:child_process";
import type {
  BridgeAppState,
  BridgeProcessCommandIdentity,
  BridgeProcessRuntimeMetadata
} from "../state/appState.ts";
import type {
  ManagedBridgeDiscovery,
  ManagedBridgeStopResult
} from "./managedBridgeRuntime.ts";
import {
  inspectWindowsProcess,
  processIsAlive,
  type WindowsProcessIdentity
} from "./backgroundSpawn.ts";

type RunningManagedBridge = Extract<ManagedBridgeDiscovery, { state: "running-managed" }>;

export type WindowsManagedProcessVerificationFailure =
  | "bridge_instance_mismatch"
  | "process_not_alive"
  | "process_metadata_unavailable"
  | "windows_process_identity_unavailable"
  | "windows_process_id_mismatch"
  | "process_start_metadata_mismatch"
  | "windows_parent_pid_mismatch"
  | "windows_process_tree_mismatch"
  | "windows_executable_path_mismatch"
  | "process_command_mismatch";

export type VerifiedWindowsManagedProcessTree = {
  ok: true;
  treeRootPid: number;
  targetPids: number[];
};

export type WindowsManagedProcessTreeVerification =
  | VerifiedWindowsManagedProcessTree
  | {
      ok: false;
      pid?: number;
      reason: WindowsManagedProcessVerificationFailure;
    };

export type WindowsManagedProcessInspectionDependencies = {
  processIsAlive: (pid: number) => boolean;
  inspectProcess: (pid: number) => WindowsProcessIdentity | undefined;
};

export type WindowsManagedBridgeTerminationOptions = Partial<WindowsManagedProcessInspectionDependencies> & {
  platform?: NodeJS.Platform;
  terminateProcessTree?: (treeRootPid: number) => void;
  isBridgeOnline: () => Promise<boolean>;
  onStopped: () => void;
  writeStructuredLog?: (event: Record<string, unknown>) => void;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  stopTimeoutMs?: number;
  pollIntervalMs?: number;
};

/**
 * Verify every persisted identity field before authorizing the Windows taskkill
 * fallback. The caller must obtain `discovery` from the authenticated control
 * status endpoint; a PID in the state file is never sufficient on its own.
 */
export function verifyWindowsManagedProcessTree(
  discovery: RunningManagedBridge,
  state: BridgeAppState,
  dependencies: Partial<WindowsManagedProcessInspectionDependencies> = {}
): WindowsManagedProcessTreeVerification {
  if (state.instanceId !== undefined && state.instanceId !== discovery.instanceId) {
    return { ok: false, reason: "bridge_instance_mismatch" };
  }

  const targetPids = uniqueProcessIds([discovery.supervisorPid, discovery.daemonPid]);
  const treeRootPid = discovery.supervisorPid ?? discovery.daemonPid;
  const isAlive = dependencies.processIsAlive ?? processIsAlive;
  const inspectProcess = dependencies.inspectProcess ?? inspectWindowsProcess;

  for (const pid of targetPids) {
    if (!isAlive(pid)) {
      return { ok: false, pid, reason: "process_not_alive" };
    }
    const metadata = storedProcessMetadataForPid(pid, state);
    if (!metadata?.startMetadata) {
      return { ok: false, pid, reason: "process_metadata_unavailable" };
    }
    const identity = inspectProcess(pid);
    if (!identity) {
      return { ok: false, pid, reason: "windows_process_identity_unavailable" };
    }
    if (identity.processId !== pid) {
      return { ok: false, pid, reason: "windows_process_id_mismatch" };
    }
    if (metadata.startMetadata.platform !== "win32"
      || metadata.startMetadata.source !== "windows-cim-creation-date"
      || metadata.startMetadata.value !== identity.creationDate) {
      return { ok: false, pid, reason: "process_start_metadata_mismatch" };
    }
    if (metadata.parentPid === undefined || identity.parentProcessId !== metadata.parentPid) {
      return { ok: false, pid, reason: "windows_parent_pid_mismatch" };
    }
    if (pid === discovery.daemonPid
      && discovery.supervisorPid !== undefined
      && identity.parentProcessId !== discovery.supervisorPid) {
      return { ok: false, pid, reason: "windows_process_tree_mismatch" };
    }
    if (!sameWindowsExecutable(metadata.executablePath, identity.executablePath)) {
      return { ok: false, pid, reason: "windows_executable_path_mismatch" };
    }
    if (!identity.commandLine
      || !windowsCommandLineMatchesBridgeIdentity(identity.commandLine, metadata.commandIdentity)) {
      return { ok: false, pid, reason: "process_command_mismatch" };
    }
  }

  return { ok: true, treeRootPid, targetPids };
}

/**
 * Terminate a Windows process tree only after complete ownership verification,
 * then verify that both the recorded processes and Bridge endpoint stay down.
 */
export async function stopVerifiedWindowsManagedBridge(
  discovery: RunningManagedBridge,
  state: BridgeAppState,
  options: WindowsManagedBridgeTerminationOptions
): Promise<ManagedBridgeStopResult> {
  if ((options.platform ?? process.platform) !== "win32") {
    return controlUnavailable("The managed Bridge control endpoint is unavailable.");
  }

  const processAlive = options.processIsAlive ?? processIsAlive;
  const verification = verifyWindowsManagedProcessTree(discovery, state, {
    processIsAlive: processAlive,
    inspectProcess: options.inspectProcess
  });
  if (!verification.ok) {
    options.writeStructuredLog?.({
      event: "bridge.stop.pid-verification-failed",
      ...(verification.pid === undefined ? {} : { pid: verification.pid }),
      reason: verification.reason
    });
    return {
      ok: false,
      error: {
        code: "BRIDGE_NOT_OWNED",
        message: "Bridge process ownership could not be verified.",
        canForceStop: false
      }
    };
  }

  const terminateProcessTree = options.terminateProcessTree ?? taskkillProcessTree;
  try {
    terminateProcessTree(verification.treeRootPid);
  } catch (_error) {
    return controlUnavailable("Verified Bridge process termination failed.");
  }

  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const deadline = now() + (options.stopTimeoutMs ?? 8_000);
  while (now() <= deadline) {
    const processTreeExited = verification.targetPids.every(pid => !processAlive(pid));
    const bridgeOnline = await options.isBridgeOnline();
    if (processTreeExited && !bridgeOnline) {
      options.onStopped();
      options.writeStructuredLog?.({
        event: "bridge.stop.completed",
        instanceId: discovery.instanceId,
        method: "verified-windows-taskkill"
      });
      return { ok: true, value: { previousState: "running-managed", state: "stopped" } };
    }
    await sleep(options.pollIntervalMs ?? 100);
  }

  return {
    ok: false,
    error: {
      code: "BRIDGE_STOP_TIMEOUT",
      message: "Timed out waiting for the managed Bridge to stop.",
      canForceStop: false
    }
  };
}

export function windowsCommandLineMatchesBridgeIdentity(
  commandLine: string,
  identity: BridgeProcessCommandIdentity
): boolean {
  if (identity.argv.length === 0 || identity.argv[0] !== identity.executable) {
    return false;
  }
  return normalizeWindowsCommandLine(commandLine)
    === normalizeWindowsCommandLine(identity.argv.join(" "));
}

function storedProcessMetadataForPid(
  pid: number,
  state: BridgeAppState
): BridgeProcessRuntimeMetadata | undefined {
  if (state.supervisorPid === pid && state.supervisorProcess?.pid === pid) {
    return state.supervisorProcess;
  }
  if (state.pid === pid && state.bridgeProcess?.pid === pid) {
    return state.bridgeProcess;
  }
  return undefined;
}

function sameWindowsExecutable(expected: string | undefined, actual: string | undefined): boolean {
  return expected !== undefined
    && actual !== undefined
    && normalizeWindowsPath(expected) === normalizeWindowsPath(actual);
}

function normalizeWindowsPath(value: string): string {
  return value.trim().replace(/\\/g, "/").toLowerCase();
}

function normalizeWindowsCommandLine(value: string): string {
  return value
    .trim()
    .replace(/["']/g, "")
    .replace(/\\/g, "/")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function uniqueProcessIds(values: Array<number | undefined>): number[] {
  return [...new Set(values.filter((value): value is number =>
    value !== undefined && Number.isInteger(value) && value > 0
  ))];
}

function taskkillProcessTree(treeRootPid: number): void {
  execFileSync("taskkill", ["/PID", String(treeRootPid), "/T"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
}

function controlUnavailable(message: string): ManagedBridgeStopResult {
  return {
    ok: false,
    error: {
      code: "BRIDGE_CONTROL_UNAVAILABLE",
      message,
      canForceStop: false
    }
  };
}
