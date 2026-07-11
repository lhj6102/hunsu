import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const script = readFileSync("apps/bridge-desktop/scripts/windows-managed-bridge-e2e.ps1", "utf8");
const artifactStage = readFileSync("apps/bridge-desktop/scripts/stage-desktop-artifacts.mjs", "utf8");
const artifactWorkflow = readFileSync(".github/workflows/bridge-desktop-artifacts.yml", "utf8");
const packageJson = JSON.parse(readFileSync("apps/bridge-desktop/package.json", "utf8")) as { scripts?: Record<string, string> };
const desktopMain = readFileSync("apps/bridge-desktop/src/main.ts", "utf8");

function between(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Missing section start: ${start}`);
  assert.notEqual(endIndex, -1, `Missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("desktop create, port, and open persist through the isolated Roadmap registry", () => {
  const command = between(desktopMain, "async function openProjectCommand", "async function resolveChosenProjectPath");
  assert.match(command, /const registryOptions = roadmapRegistryOptions\(\)/u);
  assert.match(command, /createStudioRoadmap\([\s\S]*\{ persist: true, \.\.\.registryOptions \}\)/u);
  assert.match(command, /applyStudioPort\([\s\S]*state, registryOptions\)/u);
  assert.match(command, /openStudioRoadmap\([\s\S]*\{ persist: true, \.\.\.registryOptions \}\)/u);
});

test("Windows managed Bridge E2E always prepares and opens an isolated Workspace fixture", () => {
  const setup = between(script, "if ([string]::IsNullOrWhiteSpace($WorkspaceFixture))", "$env:HUNSU_BRIDGE_APP_STATE_PATH");
  assert.match(setup, /\$WorkspaceFixture = Join-Path \$root "fixture-roadmap"/);
  assert.match(setup, /New-Item -ItemType Directory -Path \$WorkspaceFixture/);
  assert.match(setup, /elseif \(-not \(Test-Path -LiteralPath \$WorkspaceFixture -PathType Container\)\)/);
  assert.doesNotMatch(script, /if \(-not \[string\]::IsNullOrWhiteSpace\(\$WorkspaceFixture\)\) \{\s*\$inspect/);

  const openScenario = between(script, "# Scenario B/F", "# Scenario C");
  assert.match(openScenario, /Invoke-BridgeJson create \$WorkspaceFixture --no-open --json/);
  assert.match(openScenario, /Assert-True \(@\(Get-BrowserCaptureLines\)\.Count -eq \$captureCountBeforeFixtureSetup\)/);
  assert.match(openScenario, /Invoke-BrowserAction "Workspace Open" \{ Invoke-BridgeJson open-roadmap \$roadmapId --json \}/);
});

test("concurrent ensure-running checks parse every result and prove one managed process topology", () => {
  const singletonScenario = between(script, "# Scenario A", "# Scenario B/F");
  assert.match(singletonScenario, /Assert-True \(\$concurrentRecords\.Count -eq 2\)/);
  assert.match(singletonScenario, /foreach \(\$record in \$concurrentRecords\)/);
  assert.match(singletonScenario, /\$record\.ExitCode -eq 0/);
  assert.match(singletonScenario, /\$record\.Output \| ConvertFrom-Json/);
  assert.match(singletonScenario, /Assert-BridgeJsonSuccess \$concurrentResult/);
  assert.match(singletonScenario, /Assert-SingleManagedTopology \$afterConcurrent/);

  const topology = between(script, "function Get-RelevantSidecarTopology", "function Get-BrowserCaptureLines");
  assert.match(topology, /Get-CimInstance Win32_Process/);
  assert.match(topology, /ExecutablePath/);
  assert.match(topology, /CommandLine -match .*supervise/);
  assert.match(topology, /CommandLine -match .*daemon/);
  assert.match(topology, /\$supervisors\.Count -eq 1/);
  assert.match(topology, /\$daemons\.Count -eq 1/);
  assert.match(topology, /ProcessId -eq \[int\]\$Snapshot\.localBridgeControl\.supervisorPid/);
  assert.match(topology, /ProcessId -eq \[int\]\$Snapshot\.localBridgeControl\.daemonPid/);
});

test("Pair, Open, Web, and Workspace actions each require exactly one browser handoff and distinct rotation", () => {
  const handoffFunction = between(script, "function Invoke-BrowserAction", "function Get-ActionSecret");
  assert.match(handoffFunction, /\$beforeCount = @\(Get-BrowserCaptureLines\)\.Count/);
  assert.match(handoffFunction, /Wait-BrowserCaptureCount \(\$beforeCount \+ 1\)/);
  assert.match(handoffFunction, /\$lines\.Count - \$beforeCount -eq 1/);

  const openScenario = between(script, "# Scenario B/F", "# Scenario C");
  const expectedActions = [
    ["Pair", "pair --json"],
    ["Open", "open-project \\$WorkspaceFixture --json"],
    ["Open Hunsu Web", "pair --json"],
    ["Workspace Open", "open-roadmap \\$roadmapId --json"]
  ] as const;
  for (const [label, command] of expectedActions) {
    assert.match(openScenario, new RegExp(`Invoke-BrowserAction "${label}" \\{ Invoke-BridgeJson ${command} \\}`));
  }
  assert.match(openScenario, /Select-Object -Unique\)\.Count -eq 4/);
  assert.match(openScenario, /pair = \$pairAction\.HandoffCount/);
  assert.match(openScenario, /open = \$openAction\.HandoffCount/);
  assert.match(openScenario, /web = \$webAction\.HandoffCount/);
  assert.match(openScenario, /workspace = \$workspaceAction\.HandoffCount/);
});

test("redaction scenario uses fresh Diagnostics plus a real Windows clipboard round trip", () => {
  const diagnostics = between(script, "function Assert-NoUnsafeDiagnostics", "function Write-SafeEvidence");
  assert.match(diagnostics, /& \$SidecarPath diagnostics --json/);
  assert.match(diagnostics, /Assert-True \(\$LASTEXITCODE -eq 0\)/);
  assert.match(diagnostics, /Set-Clipboard -Value \$diagnostics/);
  assert.match(diagnostics, /Get-Clipboard -Raw/);
  assert.match(diagnostics, /-not \$diagnostics\.Contains\(\$secret\)/);
  assert.match(diagnostics, /-not \$log\.Contains\(\$secret\)/);
  assert.match(diagnostics, /-not \$clipboard\.Contains\(\$secret\)/);
});

test("port-conflict scenario samples beyond the restart delay and leaves no Bridge process", () => {
  const conflictScenario = between(script, "# Scenario E", "Write-SafeEvidence");
  assert.match(conflictScenario, /BRIDGE_PORT_IN_USE/);
  assert.match(conflictScenario, /supervise --cwd \$root --attempt-id bridge_attempt_windows_port_conflict --restart-limit 3/);
  assert.match(conflictScenario, /sidecarStartsAfter - \$sidecarStartsBefore\) -eq 1/);
  assert.match(conflictScenario, /sidecar\.terminal-failure/);
  assert.match(conflictScenario, /'"exitCode":78'/);
  assert.match(conflictScenario, /typed-terminal-exit/);
  assert.match(conflictScenario, /for \(\$sample = 0; \$sample -lt 12; \$sample \+= 1\)/);
  assert.match(conflictScenario, /Supervisors\)\.Count -eq 0/);
  assert.match(conflictScenario, /Daemons\)\.Count -eq 0/);
  assert.match(conflictScenario, /Get-ListenerPid\) -eq \$conflictListenerPid/);
  assert.match(conflictScenario, /Start-Sleep -Milliseconds 250/);
});

test("safe per-scenario evidence is passed to the Windows gate and checksum-staged before upload", () => {
  const evidenceWriter = between(script, "function Write-SafeEvidence", "$capturedSecrets = @()");
  assert.match(script, /\[string\]\$EvidencePath/);
  assert.match(evidenceWriter, /ConvertTo-Json -Depth 10/);
  assert.match(evidenceWriter, /-notmatch "\(\?i\)\\b\[a-z\]\[a-z0-9\+\.\-\]\*:\/\/\|hunsuBridgeToken"/);
  assert.match(evidenceWriter, /-not \$json\.Contains\(\$secret\)/);
  for (const scenario of ["A", "B", "C", "D", "E", "F"]) {
    assert.match(script, new RegExp(`\\$evidence\\.scenarios\\.${scenario} = \\[ordered\\]@\\{`));
  }

  assert.match(artifactWorkflow, /-EvidencePath \$env:MANAGED_BRIDGE_EVIDENCE_PATH/);
  assert.match(artifactWorkflow, /stage_args\+=\(--evidence-path "\$\{MANAGED_BRIDGE_EVIDENCE_PATH\}"\)/);
  assert.equal(
    artifactWorkflow.indexOf("Run Windows managed Bridge lifecycle E2E")
      < artifactWorkflow.indexOf("Stage installer artifacts and checksums"),
    true
  );
  assert.equal(
    artifactWorkflow.indexOf("Stage installer artifacts and checksums")
      < artifactWorkflow.indexOf("Upload desktop artifact"),
    true
  );
  assert.match(artifactStage, /windows-managed-bridge-e2e-evidence\.json/);
  assert.match(artifactStage, /validateManagedBridgeEvidence\(evidencePath\)/);
  assert.match(artifactStage, /copyIntoStage\(evidencePath, outputRoot, managedBridgeEvidenceName\)/);
  assert.match(packageJson.scripts?.["e2e:windows-managed"] ?? "", /windows-managed-bridge-e2e\.ps1/);
});
