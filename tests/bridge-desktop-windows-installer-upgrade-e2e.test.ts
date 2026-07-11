import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const upgradeScript = readFileSync("apps/bridge-desktop/scripts/windows-installer-upgrade-e2e.ps1", "utf8");
const workflow = readFileSync(".github/workflows/bridge-desktop-artifacts.yml", "utf8");
const stageScript = readFileSync("apps/bridge-desktop/scripts/stage-desktop-artifacts.mjs", "utf8");
const reportScript = join(process.cwd(), "apps/bridge-desktop/scripts/report-artifact-sizes.mjs");
const baseline = JSON.parse(readFileSync("apps/bridge-desktop/windows-artifact-size-baseline.json", "utf8")) as {
  measurements: { installerBytes: number; artifactZipBytes: number };
  policy: { maximumGrowthPercent: number; minimumGrowthAllowanceBytes: number };
};
const packageJson = JSON.parse(readFileSync("apps/bridge-desktop/package.json", "utf8")) as {
  scripts?: Record<string, string>;
};

function between(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Missing section start: ${start}`);
  assert.notEqual(endIndex, -1, `Missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("Windows installer upgrade gate exercises same-directory scenarios A-F with exact-path process safety", () => {
  const scenarioA = between(upgradeScript, "# Scenario A", "# Scenario B");
  assert.match(scenarioA, /Invoke-Installer -OldInstallPids \$oldA/u);
  assert.match(scenarioA, /installedSidecarSha256/u);
  assert.match(scenarioA, /candidateVersion = \$afterA\.candidateVersion/u);
  assert.match(scenarioA, /singletonTopology = \$true/u);
  assert.match(scenarioA, /eaddrinuseObserved = \$false/u);

  const scenarioB = between(upgradeScript, "# Scenario B", "# Scenario C");
  assert.match(scenarioB, /settings quit-behavior set keep-background/u);
  assert.match(scenarioB, /Stop-DesktopShellOnly/u);
  assert.match(scenarioB, /Background-only scenario did not retain one supervisor and one daemon/u);
  assert.match(scenarioB, /Invoke-Installer -OldInstallPids \$oldB/u);

  const scenarioC = between(upgradeScript, "# Scenario C", "# Scenario F");
  assert.match(scenarioC, /Stop-BridgeAndShell/u);
  assert.match(scenarioC, /verifiedProcessesBeforeInstall/u);
  assert.match(scenarioC, /fallbackTerminationTargets = 0/u);

  const scenarioF = between(upgradeScript, "# Scenario F", "# Scenario D");
  assert.match(upgradeScript, /\$otherDir = Join-Path \$root "qa-other"/u);
  assert.match(scenarioF, /hunsu-bridge-sidecar\.exe/u);
  assert.match(scenarioF, /-not \$outsideProcess\.HasExited/u);
  assert.match(scenarioF, /similarExecutableOutsideTargetPreserved = \$true/u);
  assert.match(scenarioF, /exactInstallDirectoryMatching = \$true/u);

  const scenarioD = between(upgradeScript, "# Scenario D", "# Scenario E");
  assert.match(scenarioD, /Find-Uninstaller/u);
  assert.match(scenarioD, /Wait-CoreFilesRemoved/u);
  assert.match(scenarioD, /Wait-NoListener/u);
  assert.match(scenarioD, /runtimeWasBackgroundOnly = \$true/u);

  const scenarioE = between(upgradeScript, "# Scenario E", "$evidence.measurements");
  assert.match(scenarioE, /TcpListener/u);
  assert.match(scenarioE, /Invoke-Installer/u);
  assert.match(scenarioE, /BRIDGE_PORT_IN_USE/u);
  assert.match(scenarioE, /unrelatedListenerPreserved = \$true/u);
  assert.match(scenarioE, /lingeringTargetSidecars = 0/u);

  const exactProcessEnumeration = between(upgradeScript, "function Get-InstallProcesses", "function Get-ExactPathProcesses");
  assert.match(exactProcessEnumeration, /Get-CimInstance Win32_Process/u);
  assert.match(exactProcessEnumeration, /Hunsu Bridge\.exe/u);
  assert.match(exactProcessEnumeration, /hunsu-bridge\.exe/u);
  assert.match(exactProcessEnumeration, /hunsu-bridge-sidecar\.exe/u);
  assert.match(exactProcessEnumeration, /OrdinalIgnoreCase/u);
  assert.doesNotMatch(upgradeScript, /Stop-Process\s+-Name|taskkill/u);
});

test("upgrade evidence is versioned, redacted, hash-bound, and records required timing and size fields", () => {
  assert.match(upgradeScript, /hunsu\.windows-installer-upgrade-e2e\.v1/u);
  assert.match(upgradeScript, /runId/u);
  assert.match(upgradeScript, /runAttempt/u);
  assert.match(upgradeScript, /candidateSha/u);
  assert.match(upgradeScript, /installerSha256/u);
  assert.match(upgradeScript, /installDirectoryId = Get-TextSha256/u);
  assert.match(upgradeScript, /shutdownElapsedMs/u);
  assert.match(upgradeScript, /installElapsedMs/u);
  assert.match(upgradeScript, /installedAppBytes/u);
  assert.match(upgradeScript, /installedSidecarBytes/u);
  assert.match(upgradeScript, /expectedAppVersion -ne "0\.1\.1"/u);
  assert.match(upgradeScript, /Snapshot\.versions\.bridgeApp -eq \$expectedAppVersion/u);
  assert.match(upgradeScript, /ConvertTo-Json -Depth 12/u);
  assert.match(upgradeScript, /hunsuBridgeToken\|hunsuRelayToken\|authorization\|access_token\|refresh_token\|controlToken/u);
  assert.match(upgradeScript, /\[a-z\]:\\\\users\\\\/u);
  assert.match(packageJson.scripts?.["e2e:windows-upgrade"] ?? "", /windows-installer-upgrade-e2e\.ps1/u);
  assert.match(packageJson.scripts?.["artifacts:verify-checksums"] ?? "", /verify-desktop-artifact-checksums\.mjs/u);
});

test("Windows x64 workflow runs upgrade after fresh installed-app QA and checksum-stages its evidence and guarded size report", () => {
  const installedIndex = workflow.indexOf("Run installed Windows Bridge App WebView E2E");
  const upgradeIndex = workflow.indexOf("Run Windows same-directory installer upgrade E2E");
  const guardIndex = workflow.indexOf("Guard Windows artifact sizes");
  const stageIndex = workflow.indexOf("Stage installer artifacts and checksums");
  const finalizeIndex = workflow.indexOf("Finalize Windows artifact ZIP size measurement");
  const verifyIndex = workflow.indexOf("Verify staged artifact checksums");
  const uploadIndex = workflow.indexOf("Upload desktop artifact");
  assert.ok(installedIndex < upgradeIndex && upgradeIndex < guardIndex && guardIndex < stageIndex);
  assert.ok(stageIndex < finalizeIndex && finalizeIndex < verifyIndex && verifyIndex < uploadIndex);
  assert.match(workflow, /windows-installer-upgrade-e2e\.ps1/u);
  assert.match(workflow, /-CandidateSidecarPath "\$\{\{ matrix\.sidecar \}\}"/u);
  assert.match(workflow, /--upgrade-evidence-path "\$\{INSTALLER_UPGRADE_EVIDENCE_PATH\}"/u);
  assert.match(workflow, /--include-size-report/u);
  assert.match(workflow, /Compress-Archive/u);
  assert.match(workflow, /--artifact-zip \$env:ARTIFACT_ZIP_PREVIEW/u);
  assert.match(workflow, /windows-artifact-size-baseline\.json/u);
  assert.match(workflow, /verify-desktop-artifact-checksums\.mjs/u);
  assert.match(stageScript, /windows-installer-upgrade-e2e-evidence\.json/u);
  assert.match(stageScript, /validateInstallerUpgradeEvidence\(upgradeEvidencePath\)/u);
  assert.match(stageScript, /validateArtifactSizeReport\(reportPath, target\)/u);
});

test("Windows artifact size baseline uses the attested prior candidate and the 5%-or-1MiB policy", () => {
  assert.equal(baseline.measurements.installerBytes, 24_997_090);
  assert.equal(baseline.measurements.artifactZipBytes, 25_065_843);
  assert.equal(baseline.policy.maximumGrowthPercent, 5);
  assert.equal(baseline.policy.minimumGrowthAllowanceBytes, 1_048_576);
});

test("artifact size report records every Windows measurement and rejects growth unless a reviewed exception is explicit", () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-windows-size-policy-"));
  const bundleDir = join(root, "bundle");
  const distDir = join(root, "dist");
  const helperDir = join(root, "helpers");
  const installerPath = join(bundleDir, "nsis", "Hunsu Bridge_0.1.1_x64-setup.exe");
  const sidecarPath = join(distDir, "hunsu-bridge-sidecar-x86_64-pc-windows-msvc.exe");
  const manifestPath = join(distDir, "sidecar-manifest.json");
  const evidencePath = join(root, "upgrade-evidence.json");
  const archivePath = join(root, "artifact.zip");
  const baselinePath = join(root, "baseline.json");
  const outputPath = join(bundleDir, "artifact-size-report.json");
  const hookPath = join(helperDir, "installer-hooks.nsh");
  const helperPath = join(helperDir, "stop-existing-bridge.ps1");
  const target = "x86_64-pc-windows-msvc";

  try {
    writeBinary(installerPath, 1_000);
    writeBinary(sidecarPath, 700);
    writeBinary(archivePath, 1_200);
    writeBinary(hookPath, 30);
    writeBinary(helperPath, 70);
    writeJson(manifestPath, {
      schema: "hunsu.bridge-sidecars.v1",
      target,
      artifacts: [{ target, file: "hunsu-bridge-sidecar-x86_64-pc-windows-msvc.exe", kind: "native-executable" }]
    });
    writeJson(evidencePath, {
      schema: "hunsu.windows-installer-upgrade-e2e.v1",
      result: "passed",
      measurements: { installedAppBytes: 600, installedSidecarBytes: 700 }
    });
    writeJson(baselinePath, {
      schema: "hunsu.bridge-desktop-windows-size-baseline.v1",
      source: { workflowRunId: "1" },
      measurements: { installerBytes: 1_000, artifactZipBytes: 1_200 },
      policy: { maximumGrowthPercent: 5, minimumGrowthAllowanceBytes: 1_048_576 }
    });

    const commonArgs = [
      reportScript,
      "--directory", bundleDir,
      "--output", outputPath,
      "--sidecar-manifest", manifestPath,
      "--target", target,
      "--upgrade-evidence", evidencePath,
      "--artifact-zip", archivePath,
      "--baseline", baselinePath,
      "--helper-path", hookPath,
      "--helper-path", helperPath
    ];
    const passed = spawnSync(process.execPath, commonArgs, { encoding: "utf8" });
    assert.equal(passed.status, 0, passed.stderr);
    let report = JSON.parse(readFileSync(outputPath, "utf8")) as any;
    assert.equal(report.schema, "hunsu.bridge-desktop-artifact-sizes.v3");
    assert.equal(report.measurements.installer.sizeBytes, 1_000);
    assert.equal(report.measurements.artifactZip.sizeBytes, 1_200);
    assert.equal(report.measurements.installedApp.sizeBytes, 600);
    assert.equal(report.measurements.installedSidecar.sizeBytes, 700);
    assert.equal(report.measurements.installerLifecycleHelpers.sizeBytes, 100);
    assert.equal(report.policy.status, "passed");
    assert.equal(report.packaging.fixedWebViewRuntimeBundled, false);

    writeBinary(installerPath, 1_050_000 + 1_000);
    const rejected = spawnSync(process.execPath, commonArgs, { encoding: "utf8" });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /size regression policy failed/u);
    report = JSON.parse(readFileSync(outputPath, "utf8"));
    assert.equal(report.policy.status, "failed");

    const excepted = spawnSync(process.execPath, [
      ...commonArgs,
      "--size-exception",
      "Reviewed installer payload growth in pull request QA-123."
    ], { encoding: "utf8" });
    assert.equal(excepted.status, 0, excepted.stderr);
    report = JSON.parse(readFileSync(outputPath, "utf8"));
    assert.equal(report.policy.status, "passed-with-reviewed-exception");
    assert.match(report.policy.reviewedException, /QA-123/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeBinary(path: string, size: number) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.alloc(size, 0x61));
}

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
