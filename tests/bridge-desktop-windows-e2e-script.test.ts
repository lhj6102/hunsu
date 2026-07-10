import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const script = readFileSync("apps/bridge-desktop/scripts/windows-managed-bridge-e2e.ps1", "utf8");
const artifactWorkflow = readFileSync(".github/workflows/bridge-desktop-artifacts.yml", "utf8");
const packageJson = JSON.parse(readFileSync("apps/bridge-desktop/package.json", "utf8")) as { scripts?: Record<string, string> };

test("Windows managed Bridge E2E covers singleton, Pair/Open, Stop/Start, ownership, conflict, and redaction", () => {
  for (const scenario of ["Scenario A", "Scenario B/F", "Scenario C", "Scenario D", "Scenario E"]) {
    assert.match(script, new RegExp(scenario.replace("/", "\\/")));
  }
  assert.match(script, /ensure-running --json/);
  assert.match(script, /localBridgeControl\.instanceId/);
  assert.match(script, /localBridgeControl\.daemonPid/);
  assert.match(script, /localBridgeControl\.supervisorPid/);
  assert.match(script, /BRIDGE_ALREADY_RUNNING_UNMANAGED/);
  assert.match(script, /BRIDGE_PORT_IN_USE/);
  assert.match(script, /Assert-NoUnsafeDiagnostics/);
  assert.match(script, /EADDRINUSE/);
  assert.match(packageJson.scripts?.["e2e:windows-managed"] ?? "", /windows-managed-bridge-e2e\.ps1/);
  assert.match(artifactWorkflow, /Run Windows managed Bridge lifecycle E2E/);
  assert.match(artifactWorkflow, /if: matrix\.platform == 'windows'/);
  assert.match(artifactWorkflow, /windows-managed-bridge-e2e\.ps1/);
});
