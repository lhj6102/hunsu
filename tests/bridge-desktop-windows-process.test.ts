import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectWindowsProcess,
  type WindowsProcessIdentity,
  windowsProcessIdentityFromJson
} from "../apps/bridge-desktop/src/processes/backgroundSpawn.ts";
import {
  stopVerifiedWindowsManagedBridge,
  verifyWindowsManagedProcessTree
} from "../apps/bridge-desktop/src/processes/windowsManagedBridgeTermination.ts";
import {
  defaultBridgeAppState,
  type BridgeAppState,
  type BridgeProcessRuntimeMetadata
} from "../apps/bridge-desktop/src/state/appState.ts";
import type { ManagedBridgeDiscovery } from "../apps/bridge-desktop/src/processes/managedBridgeRuntime.ts";

const SUPERVISOR_PID = 7000;
const DAEMON_PID = 7124;
const INSTANCE_ID = "bridge_instance_windows_behavior_test";
const SUPERVISOR_EXE = "C:\\Program Files\\Hunsu\\hunsu-bridge.exe";
const DAEMON_EXE = "C:\\Program Files\\Hunsu\\hunsu-bridge-sidecar.exe";
const SUPERVISOR_CREATED = "20260711113040.123456+540";
const DAEMON_CREATED = "20260711113042.123456+540";

test("Windows process inspection parses the CIM ownership fields used before taskkill", () => {
  const identity = windowsProcessIdentityFromJson(JSON.stringify({
    ProcessId: 7124,
    ParentProcessId: 7000,
    ExecutablePath: "C:\\Program Files\\Hunsu\\hunsu-bridge-sidecar.exe",
    CommandLine: "\"C:\\Program Files\\Hunsu\\hunsu-bridge-sidecar.exe\" daemon --no-open",
    CreationDate: "20260711113042.123456+540"
  }));

  assert.deepEqual(identity, {
    processId: 7124,
    parentProcessId: 7000,
    executablePath: "C:\\Program Files\\Hunsu\\hunsu-bridge-sidecar.exe",
    commandLine: "\"C:\\Program Files\\Hunsu\\hunsu-bridge-sidecar.exe\" daemon --no-open",
    creationDate: "20260711113042.123456+540"
  });
});

test("Windows process inspection uses a numeric CIM filter and rejects incomplete identity", () => {
  let script = "";
  const identity = inspectWindowsProcess(7124, value => {
    script = value;
    return JSON.stringify({
      ProcessId: 7124,
      ParentProcessId: 7000,
      ExecutablePath: null,
      CommandLine: "hunsu-bridge-sidecar.exe start --no-open",
      CreationDate: "20260711113042.123456+540"
    });
  });

  assert.match(script, /Get-CimInstance Win32_Process/);
  assert.match(script, /ProcessId = 7124/);
  assert.equal(identity?.processId, 7124);
  assert.equal(identity?.executablePath, undefined);
  assert.equal(windowsProcessIdentityFromJson(JSON.stringify({ ProcessId: 1 })), undefined);
  assert.equal(inspectWindowsProcess(-1, () => "{}"), undefined);
});

test("Windows fallback accepts complete identity and terminates the verified supervisor tree", async () => {
  const harness = terminationHarness();

  const result = await stopVerifiedWindowsManagedBridge(harness.discovery, harness.state, harness.options);

  assert.deepEqual(result, {
    ok: true,
    value: { previousState: "running-managed", state: "stopped" }
  });
  assert.deepEqual(harness.terminated, [SUPERVISOR_PID]);
  assert.equal(harness.cleared, 1);
  assert.deepEqual(harness.inspected, [SUPERVISOR_PID, DAEMON_PID]);
});

test("Windows fallback refuses PID reuse when the persisted start time no longer matches", async () => {
  const harness = terminationHarness({
    identities: {
      [DAEMON_PID]: { ...daemonIdentity(), creationDate: "20260711123042.123456+540" }
    }
  });

  assert.deepEqual(
    verifyWindowsManagedProcessTree(harness.discovery, harness.state, harness.inspection),
    { ok: false, pid: DAEMON_PID, reason: "process_start_metadata_mismatch" }
  );
  await assertRefusesWithoutTermination(harness, "process_start_metadata_mismatch");
});

test("Windows fallback refuses a changed parent PID without taskkill", async () => {
  const harness = terminationHarness({
    identities: {
      [DAEMON_PID]: { ...daemonIdentity(), parentProcessId: 9555 }
    }
  });

  await assertRefusesWithoutTermination(harness, "windows_parent_pid_mismatch");
});

test("Windows fallback refuses an executable mismatch without taskkill", async () => {
  const harness = terminationHarness({
    identities: {
      [DAEMON_PID]: { ...daemonIdentity(), executablePath: "C:\\Windows\\System32\\notepad.exe" }
    }
  });

  await assertRefusesWithoutTermination(harness, "windows_executable_path_mismatch");
});

test("Windows fallback refuses command-line and authenticated-instance mismatches", async t => {
  await t.test("command line", async () => {
    const harness = terminationHarness({
      identities: {
        [DAEMON_PID]: {
          ...daemonIdentity(),
          commandLine: `"${DAEMON_EXE}" daemon --cwd C:\\other-instance --no-open`
        }
      }
    });
    await assertRefusesWithoutTermination(harness, "process_command_mismatch");
  });

  await t.test("instance", async () => {
    const harness = terminationHarness({
      state: { instanceId: "bridge_instance_stale" }
    });
    await assertRefusesWithoutTermination(harness, "bridge_instance_mismatch");
    assert.deepEqual(harness.inspected, []);
  });
});

test("Windows fallback reports termination failure and never clears state", async () => {
  const harness = terminationHarness({ terminateError: new Error("synthetic taskkill failure") });

  const result = await stopVerifiedWindowsManagedBridge(harness.discovery, harness.state, harness.options);

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "BRIDGE_CONTROL_UNAVAILABLE");
  assert.deepEqual(harness.terminated, [SUPERVISOR_PID]);
  assert.equal(harness.cleared, 0);
});

test("Windows fallback does not report success until the verified tree and endpoint are offline", async () => {
  const harness = terminationHarness({ terminationLeavesProcessAlive: true });

  const result = await stopVerifiedWindowsManagedBridge(harness.discovery, harness.state, harness.options);

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "BRIDGE_STOP_TIMEOUT");
  assert.deepEqual(harness.terminated, [SUPERVISOR_PID]);
  assert.equal(harness.cleared, 0);
});

type HarnessOverrides = {
  identities?: Partial<Record<number, WindowsProcessIdentity>>;
  state?: Partial<BridgeAppState>;
  terminateError?: Error;
  terminationLeavesProcessAlive?: boolean;
};

function terminationHarness(overrides: HarnessOverrides = {}) {
  const discovery: Extract<ManagedBridgeDiscovery, { state: "running-managed" }> = {
    state: "running-managed",
    bridgeApiUrl: "http://127.0.0.1:19687",
    instanceId: INSTANCE_ID,
    supervisorPid: SUPERVISOR_PID,
    daemonPid: DAEMON_PID,
    startedAt: "2026-07-11T02:30:40.000Z",
    bridgeVersion: "0.1.0",
    protocolVersion: "local-bridge-v1"
  };
  const state: BridgeAppState = {
    ...defaultBridgeAppState(),
    instanceId: INSTANCE_ID,
    supervisorPid: SUPERVISOR_PID,
    pid: DAEMON_PID,
    supervisorProcess: supervisorMetadata(),
    bridgeProcess: daemonMetadata(),
    ...overrides.state
  };
  const identities: Record<number, WindowsProcessIdentity> = {
    [SUPERVISOR_PID]: supervisorIdentity(),
    [DAEMON_PID]: daemonIdentity(),
    ...overrides.identities
  };
  const alive = new Set([SUPERVISOR_PID, DAEMON_PID]);
  const terminated: number[] = [];
  const inspected: number[] = [];
  const logged: Array<Record<string, unknown>> = [];
  let cleared = 0;
  let clock = 1_000;
  const inspection = {
    processIsAlive: (pid: number) => alive.has(pid),
    inspectProcess: (pid: number) => {
      inspected.push(pid);
      return identities[pid];
    }
  };
  const options = {
    platform: "win32" as const,
    ...inspection,
    terminateProcessTree: (pid: number) => {
      terminated.push(pid);
      if (overrides.terminateError) throw overrides.terminateError;
      if (!overrides.terminationLeavesProcessAlive) alive.clear();
    },
    isBridgeOnline: async () => alive.size > 0,
    onStopped: () => { cleared += 1; },
    writeStructuredLog: (event: Record<string, unknown>) => { logged.push(event); },
    now: () => clock,
    sleep: async (milliseconds: number) => { clock += milliseconds; },
    stopTimeoutMs: 10,
    pollIntervalMs: 1
  };
  return {
    discovery,
    state,
    inspection,
    options,
    identities,
    alive,
    terminated,
    inspected,
    logged,
    get cleared() { return cleared; }
  };
}

async function assertRefusesWithoutTermination(
  harness: ReturnType<typeof terminationHarness>,
  expectedReason: string
): Promise<void> {
  const result = await stopVerifiedWindowsManagedBridge(harness.discovery, harness.state, harness.options);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "BRIDGE_NOT_OWNED");
  assert.deepEqual(harness.terminated, []);
  assert.equal(harness.cleared, 0);
  assert.equal(harness.logged.at(-1)?.reason, expectedReason);
}

function supervisorMetadata(): BridgeProcessRuntimeMetadata {
  const argv = [SUPERVISOR_EXE, "supervise", "--cwd", "C:\\work\\hunsu", "--attempt-id", "attempt_windows"];
  return {
    pid: SUPERVISOR_PID,
    commandIdentity: {
      kind: "supervise",
      executable: SUPERVISOR_EXE,
      argv,
      nonce: "supervisor_nonce"
    },
    startMetadata: {
      platform: "win32",
      source: "windows-cim-creation-date",
      value: SUPERVISOR_CREATED
    },
    parentPid: 6400,
    executablePath: SUPERVISOR_EXE,
    recordedAt: "2026-07-11T02:30:40.000Z"
  };
}

function daemonMetadata(): BridgeProcessRuntimeMetadata {
  const argv = [DAEMON_EXE, "daemon", "--cwd", "C:\\work\\hunsu", "--no-open"];
  return {
    pid: DAEMON_PID,
    commandIdentity: {
      kind: "daemon",
      executable: DAEMON_EXE,
      argv,
      nonce: "daemon_nonce"
    },
    startMetadata: {
      platform: "win32",
      source: "windows-cim-creation-date",
      value: DAEMON_CREATED
    },
    parentPid: SUPERVISOR_PID,
    executablePath: DAEMON_EXE,
    recordedAt: "2026-07-11T02:30:42.000Z"
  };
}

function supervisorIdentity(): WindowsProcessIdentity {
  return {
    processId: SUPERVISOR_PID,
    parentProcessId: 6400,
    executablePath: SUPERVISOR_EXE,
    commandLine: `"${SUPERVISOR_EXE}" supervise --cwd C:\\work\\hunsu --attempt-id attempt_windows`,
    creationDate: SUPERVISOR_CREATED
  };
}

function daemonIdentity(): WindowsProcessIdentity {
  return {
    processId: DAEMON_PID,
    parentProcessId: SUPERVISOR_PID,
    executablePath: DAEMON_EXE,
    commandLine: `"${DAEMON_EXE}" daemon --cwd C:\\work\\hunsu --no-open`,
    creationDate: DAEMON_CREATED
  };
}
