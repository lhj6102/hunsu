import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  inspectWindowsProcess,
  windowsProcessIdentityFromJson
} from "../apps/bridge-desktop/src/processes/backgroundSpawn.ts";

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

test("Windows taskkill fallback is gated by complete managed-process verification", () => {
  const source = readFileSync("apps/bridge-desktop/src/main.ts", "utf8");
  const fallback = source.slice(
    source.indexOf("async function stopManagedBridgeWithVerifiedWindowsFallback"),
    source.indexOf("function verifyManagedBridgePid")
  );
  const verificationIndex = fallback.indexOf("verifyManagedBridgePid(pid, state)");
  const taskkillIndex = fallback.indexOf('execFileSync("taskkill"');
  assert.ok(verificationIndex >= 0);
  assert.ok(taskkillIndex > verificationIndex);
  assert.match(source, /windows_parent_pid_mismatch/);
  assert.match(source, /windows_executable_path_mismatch/);
  assert.match(source, /process_start_metadata_mismatch/);
  assert.match(source, /process_command_mismatch/);
});
