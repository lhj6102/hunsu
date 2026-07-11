import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const powershell = readFileSync("apps/bridge-desktop/scripts/windows-installed-app-e2e.ps1", "utf8");
const driver = readFileSync("apps/bridge-desktop/scripts/windows-installed-app-webview-e2e.mjs", "utf8");
const packageJson = JSON.parse(readFileSync("apps/bridge-desktop/package.json", "utf8")) as {
  scripts?: Record<string, string>;
};
const artifactWorkflow = readFileSync(".github/workflows/bridge-desktop-artifacts.yml", "utf8");
const artifactStage = readFileSync("apps/bridge-desktop/scripts/stage-desktop-artifacts.mjs", "utf8");

test("installed Windows app gate silently installs an isolated NSIS candidate and exposes WebView2 CDP", () => {
  assert.match(powershell, /Start-Process -FilePath \$resolvedInstallerPath -ArgumentList @\("\/S", "\/D=\$installDir"\)/u);
  assert.match(powershell, /hunsu-installed-app-e2e-/u);
  assert.match(powershell, /HUNSU_BRIDGE_APP_STATE_PATH/u);
  assert.match(powershell, /HUNSU_BRIDGE_APP_LOG_PATH/u);
  assert.match(powershell, /HUNSU_BRIDGE_TEST_BROWSER_CAPTURE_PATH/u);
  assert.match(powershell, /WEBVIEW2_USER_DATA_FOLDER/u);
  assert.match(powershell, /WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS/u);
  assert.match(powershell, /--remote-debugging-port=\$CdpPort/u);
  assert.match(powershell, /\/json\/list/u);
  assert.match(powershell, /windows-installed-app-webview-e2e\.mjs/u);
  assert.match(powershell, /create \$workspaceFixturePath --no-open --json/u);
  assert.match(powershell, /No-open fixture preparation unexpectedly handed off/u);
  assert.equal(
    powershell.indexOf("create $workspaceFixturePath --no-open --json")
      < powershell.indexOf("Start-Process -FilePath $appExecutable"),
    true
  );
  assert.match(powershell, /existing managed daemon verifies reuse/u);
  assert.match(powershell, /\[string\]\$EvidencePath/u);
  assert.match(powershell, /\[string\]\$ScreenshotPath/u);
  assert.match(powershell, /\[int\]\$BridgePort = 19687/u);
  assert.match(powershell, /qa_legacy_.*NewGuid/u);
  assert.match(powershell, /Get-Command rustc/u);
  assert.match(powershell, /--crate-name codex_qa_fixture/u);
  assert.match(powershell, /codex-qa\.exe/u);
  assert.match(powershell, /fixtureVersionOutput/u);
  assert.match(powershell, /installedSnapshot\.versions\.codexCli/u);
  assert.match(powershell, /vulnerable-pairing-server\.mjs/u);
  assert.match(powershell, /\/api\/bridge\/pairing\/revoke/u);
  assert.match(powershell, /pairing-revoked\.marker/u);
  assert.match(powershell, /vulnerableServerProcess\.WaitForExit\(10000\)/u);
  assert.match(powershell, /\$installedSidecar\.FullName snapshot/u);
  assert.match(powershell, /Get-Clipboard -Raw/u);
  assert.match(powershell, /nativeClipboardRoundTrip/u);
  assert.match(powershell, /MainWindowHandle -eq 0/u);
  assert.match(powershell, /installerSha256/u);
  assert.match(powershell, /screenshotSha256/u);
  assert.match(powershell, /--evidence-path \$uiEvidencePath/u);
  assert.match(powershell, /Stop-InstalledProcesses/u);
  assert.match(powershell, /uninst\|uninstall/u);
  assert.match(packageJson.scripts?.["e2e:windows-installed"] ?? "", /windows-installed-app-e2e\.ps1/u);
});

test("installed WebView driver verifies the real lifecycle, handoff, diagnostics, provider feedback, and versions", () => {
  assert.match(driver, /chromium\.connectOverCDP/u);
  assert.match(driver, /#start-bridge/u);
  assert.match(driver, /#stop-bridge/u);
  assert.match(driver, /`local · \$\{value\.localLabel\}`/u);
  assert.match(driver, /Stopping Bridge/u);
  assert.match(driver, /Starting Bridge/u);
  assert.match(driver, /before\.length \+ 1/u);
  assert.match(driver, /verifyWorkspaceOpenHandoff/u);
  assert.match(driver, /#active-roadmap-list button/u);
  assert.match(driver, /hunsuBridgeToken/u);
  assert.match(driver, /#copy-diagnostics/u);
  assert.doesNotMatch(driver, /__hunsuQaClipboardText/u);
  assert.match(driver, /clipboardExpectationPath/u);
  assert.match(driver, /legacySecret/u);
  assert.match(driver, /EADDRINUSE/u);
  assert.match(driver, /#validate-codex-config/u);
  assert.match(driver, /Recheck complete/u);
  for (const selector of ["#bridge-app-version", "#bridge-runtime-version", "#protocol-version", "#embedded-node-version", "#codex-cli-version"]) {
    assert.match(driver, new RegExp(selector));
  }
  assert.match(driver, /version labels passed/u);
  assert.match(driver, /pageErrors\.length === 0/u);
  assert.match(driver, /consoleErrors\.length === 0/u);
  assert.match(driver, /safeConsoleErrorSummary/u);
  assert.match(driver, /redactConsoleError/u);
  assert.match(driver, /verifyPortConflictFeedback/u);
  assert.match(driver, /The configured Bridge port is in use by another process\./u);
  assert.match(driver, /Bridge port \$\{bridgePort\}.*select Start Bridge again/u);
  assert.match(driver, /configuredPort: bridgePort/u);
  assert.match(driver, /capturedUrl\.pathname === `\/studio\/roadmaps\/\$\{encodeURIComponent\(roadmapId\)\}`/u);
  assert.match(driver, /page\.screenshot/u);
  assert.match(driver, /silent-isolated-install/u);
  assert.match(driver, /candidateKind: "installed-nsis"/u);
  assert.match(driver, /automatedInstalledAppQa: "passed"/u);
  assert.match(driver, /manualVisualQa: "required"/u);
  assert.match(driver, /releaseEligible: false/u);
  assert.match(driver, /writeFileSync\(options\.evidencePath/u);
});

test("Windows x64 workflow gates upload on installed WebView evidence and checksum-stages it", () => {
  assert.match(artifactWorkflow, /Run installed Windows Bridge App WebView E2E/u);
  assert.match(artifactWorkflow, /Run Windows managed Bridge lifecycle E2E[\s\S]{0,120}timeout-minutes: 10/u);
  assert.match(artifactWorkflow, /Run installed Windows Bridge App WebView E2E[\s\S]{0,120}timeout-minutes: 10/u);
  assert.match(artifactWorkflow, /windows-installed-app-e2e\.ps1/u);
  assert.match(artifactWorkflow, /-InstallerPath \$installer\.FullName/u);
  assert.match(artifactWorkflow, /-EvidencePath \$env:INSTALLED_APP_EVIDENCE_PATH/u);
  assert.match(artifactWorkflow, /-ScreenshotPath \$env:INSTALLED_APP_SCREENSHOT_PATH/u);
  assert.match(artifactWorkflow, /--installed-evidence-path "\$\{INSTALLED_APP_EVIDENCE_PATH\}"/u);
  assert.match(artifactWorkflow, /--installed-screenshot-path "\$\{INSTALLED_APP_SCREENSHOT_PATH\}"/u);
  assert.match(artifactWorkflow, /Linux repository validation/u);
  assert.match(artifactWorkflow, /pnpm run check/u);
  assert.match(artifactWorkflow, /Prepare Linux sidecar resource for Rust validation/u);
  assert.match(artifactWorkflow, /sidecars:build -- --target x86_64-unknown-linux-gnu/u);
  assert.match(artifactWorkflow, /pnpm run check:desktop-rust/u);
  assert.match(artifactWorkflow, /needs: \[select, validate\]/u);
  assert.equal(
    artifactWorkflow.indexOf("Prepare Linux sidecar resource for Rust validation")
      < artifactWorkflow.indexOf("pnpm run check:desktop-rust"),
    true
  );
  assert.equal(
    artifactWorkflow.indexOf("Run installed Windows Bridge App WebView E2E")
      < artifactWorkflow.indexOf("Upload desktop artifact"),
    true
  );
  assert.match(artifactStage, /windows-installed-app-e2e-evidence\.json/u);
  assert.match(artifactStage, /validateInstalledAppEvidence\(installedEvidencePath, installedScreenshotPath\)/u);
  assert.match(artifactStage, /releaseEligible !== false/u);
  assert.match(artifactStage, /windows-installed-app-e2e-screenshot\.png/u);
  assert.match(artifactStage, /validatePngScreenshot/u);
  assert.match(artifactStage, /workspace-open-handoff-once/u);
  assert.match(artifactStage, /no-eaddrinuse-log/u);
});
