import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const helper = readFileSync(
  "apps/bridge-desktop/src-tauri/windows/stop-existing-bridge.ps1",
  "utf8"
);
const hooks = readFileSync(
  "apps/bridge-desktop/src-tauri/windows/installer-hooks.nsh",
  "utf8"
);
const installerTemplate = readFileSync(
  "apps/bridge-desktop/src-tauri/windows/installer-template.nsi",
  "utf8"
);
const artifactSizeReporter = readFileSync(
  "apps/bridge-desktop/scripts/report-artifact-sizes.mjs",
  "utf8"
);
const tauriConfig = JSON.parse(
  readFileSync("apps/bridge-desktop/src-tauri/tauri.conf.json", "utf8")
) as {
  bundle?: { windows?: { nsis?: { installerHooks?: string; template?: string } } };
};

function between(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Missing section start: ${start}`);
  assert.notEqual(endIndex, -1, `Missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("Tauri embeds the shutdown helper in preinstall and preuninstall lifecycle hooks", () => {
  assert.equal(
    tauriConfig.bundle?.windows?.nsis?.installerHooks,
    "./windows/installer-hooks.nsh"
  );
  assert.equal(
    tauriConfig.bundle?.windows?.nsis?.template,
    "./windows/installer-template.nsi"
  );
  assert.match(
    hooks,
    /!define HUNSU_STOP_EXISTING_BRIDGE_SOURCE "\$\{__FILEDIR__\}\\stop-existing-bridge\.ps1"/u
  );
  for (const hookName of ["NSIS_HOOK_PREINSTALL", "NSIS_HOOK_PREUNINSTALL"]) {
    const section = between(hooks, `!macro ${hookName}`, "!macroend");
    assert.match(section, /InitPluginsDir/u);
    assert.match(
      section,
      /File "\/oname=\$PLUGINSDIR\\hunsu-stop-existing-bridge\.ps1" "\$\{HUNSU_STOP_EXISTING_BRIDGE_SOURCE\}"/u
    );
    assert.ok(section.indexOf("File \"/oname=") < section.indexOf("nsExec::ExecToStack"));
    assert.match(section, /-NoProfile -NonInteractive -ExecutionPolicy Bypass/u);
    assert.match(section, /-InstallDirectory "\$INSTDIR"/u);
    assert.match(section, /\/TIMEOUT=45000/u);
    assert.match(section, /StrCmp \$0 "0"/u);
    assert.match(section, /StrCmp \$0 "10"/u);
    assert.match(section, /SetErrorLevel 1[\s\S]*MessageBox[\s\S]*Abort/u);
  }
});

test("the locked Tauri template cannot invoke an old NSIS uninstaller during maintenance", () => {
  assert.match(installerTemplate, /Vendored from tauri-cli-v2\.11\.4 installer\.nsi/u);
  assert.doesNotMatch(installerTemplate, /!insertmacro CheckIfAppIsRunning/u);
  assert.doesNotMatch(hooks, /MUI_CUSTOMFUNCTION_GUIINIT|HunsuInstallerGuiInit/u);

  const page = between(installerTemplate, "Function PageReinstall", "FunctionEnd");
  assert.match(page, /Same-version maintenance permits only Add\/Reinstall/u);
  assert.match(page, /\$R0 = 0[\s\S]*EnableWindow \$R3 0[\s\S]*BM_SETCHECK/u);
  assert.match(page, /EnableWindow \$R2 0[\s\S]*\$R3 \$\{BM_SETCHECK\}/u);

  const leave = between(installerTemplate, "Function PageLeaveReinstall", "FunctionEnd");
  assert.match(leave, /Existing NSIS installs always proceed in place/u);
  assert.match(leave, /\$WixMode = 1[\s\S]*Goto reinst_uninstall/u);
  assert.match(leave, /Goto reinst_done/u);
  assert.doesNotMatch(leave, /ReadRegStr \$R1 SHCTX "\$\{UNINSTKEY\}" "UninstallString"/u);
  assert.doesNotMatch(leave, /_\?=\$4/u);
});

test("installer failure is actionable and happens before Tauri can copy files", () => {
  const preinstall = between(hooks, "!macro NSIS_HOOK_PREINSTALL", "!macroend");
  assert.match(preinstall, /Hunsu Bridge is still running in the background/u);
  assert.match(preinstall, /Close Hunsu Bridge and retry the installation/u);
  assert.match(preinstall, /No files were replaced/u);
  assert.match(preinstall, /\/SD IDOK/u);
  assert.ok(preinstall.indexOf("Abort") > preinstall.indexOf("nsExec::ExecToStack"));
});

test("the helper grants process ownership only to exact normalized installed executable paths", () => {
  for (const executable of [
    "Hunsu Bridge.exe",
    "hunsu-bridge.exe",
    "hunsu-bridge-sidecar.exe"
  ]) {
    assert.match(helper, new RegExp(`"${executable.replace(".", "\\.")}"`, "u"));
  }
  assert.match(helper, /GetFullPath/u);
  assert.match(helper, /install directory must be fully qualified/u);
  assert.match(helper, /StringComparison\]::OrdinalIgnoreCase/u);
  assert.match(helper, /Get-CimInstance -ClassName "Win32_Process"/u);
  assert.match(helper, /ExecutablePath/u);
  assert.match(helper, /ProcessId/u);
  assert.match(helper, /ParentProcessId/u);
  assert.match(helper, /CommandLine/u);
  assert.match(helper, /CreationDate/u);
  assert.doesNotMatch(helper, /Get-Process/u);
  assert.doesNotMatch(helper, /Stop-Process/u);
  assert.doesNotMatch(helper, /taskkill[^\r\n]*\/IM/iu);
});

test("taskkill is bounded and follows a fresh exact-path and identity recheck", () => {
  const recheck = between(helper, "function Get-VerifiedCurrentProcess", "function Get-VerifiedTerminationOrder");
  assert.match(recheck, /Get-CimInstance -ClassName "Win32_Process" -Filter/u);
  assert.match(recheck, /Test-IsAllowedExecutablePath/u);
  assert.match(recheck, /CreationDate/u);
  assert.match(recheck, /ParentProcessId/u);
  assert.match(recheck, /CommandLine/u);

  const fallback = between(
    helper,
    "function Stop-VerifiedInstalledProcesses",
    "function Test-BridgePortHasInstalledOwner"
  );
  assert.ok(fallback.indexOf("Get-VerifiedCurrentProcess") < fallback.indexOf('"/PID "'));
  assert.match(fallback, /Arguments = "\/PID "[\s\S]*" \/F"/u);
  assert.doesNotMatch(fallback, /Arguments = [^\r\n]* \/T/u);
  assert.match(fallback, /Stopwatch\]::StartNew/u);
  assert.match(fallback, /\[Math\]::Min\(3000, \$millisecondsLeft\)/u);
});

test("an unmatched descendant can never fall under taskkill tree termination", () => {
  const ordering = between(
    helper,
    "function Get-VerifiedTerminationOrder",
    "function Stop-VerifiedInstalledProcesses"
  );
  assert.match(ordering, /ParentProcessId/u);
  assert.match(ordering, /Depth = \$depth/u);
  assert.match(ordering, /Descending = \$true/u);

  const fallback = between(
    helper,
    "function Stop-VerifiedInstalledProcesses",
    "function Test-BridgePortHasInstalledOwner"
  );
  assert.match(fallback, /Do not use taskkill \/T/u);
  assert.match(fallback, /foreach \(\$candidateProcess in @\(Get-VerifiedTerminationOrder \$remaining\)\)/u);
  assert.match(fallback, /Get-VerifiedCurrentProcess \$candidateProcess/u);
  assert.doesNotMatch(fallback, /Arguments = [^\r\n]* \/T/u);
});

test("graceful shutdown is hidden and finite without logging raw command output", () => {
  assert.match(helper, /"stop --json"/u);
  assert.match(helper, /CreateNoWindow = \$true/u);
  assert.match(helper, /ProcessWindowStyle\]::Hidden/u);
  assert.match(helper, /WaitForExit\(\$TimeoutMilliseconds\)/u);
  assert.match(helper, /RedirectStandardOutput = \$true/u);
  assert.match(helper, /RedirectStandardError = \$true/u);
  assert.match(helper, /stdoutCharacters=/u);
  assert.match(helper, /stderrCharacters=/u);
  assert.doesNotMatch(helper, /Write-(?:Output|Host)[^\r\n]*\$(?:stdout|stderr)\b/iu);
  assert.doesNotMatch(helper, /bridge-app\.json|controlToken|Authorization header/iu);
});

test("unrelated port owners are warnings and are never taskkill authorization", () => {
  const portCheck = between(
    helper,
    "function Test-BridgePortHasInstalledOwner",
    "function Test-InstalledExecutablesUnlocked"
  );
  assert.match(portCheck, /MSFT_NetTCPConnection/u);
  assert.match(portCheck, /State = 2/u);
  assert.match(portCheck, /OperationTimeoutSec = \$CimOperationTimeoutSeconds/u);
  assert.match(portCheck, /Test-IsAllowedExecutablePath/u);
  assert.match(portCheck, /unrelated listener/u);
  assert.match(portCheck, /BRIDGE_PORT_IN_USE/u);
  assert.doesNotMatch(portCheck, /taskkill|Stop-Process/iu);
});

test("all installed executables receive a bounded exclusive read-write lock probe", () => {
  const unlock = between(
    helper,
    "function Test-InstalledExecutablesUnlocked",
    "try {\n  if ([string]::IsNullOrWhiteSpace($InstallDirectory)"
  );
  assert.match(unlock, /foreach \(\$executableName in \$AllowedExecutableNames\)/u);
  assert.match(unlock, /FileMode\]::Open/u);
  assert.match(unlock, /FileAccess\]::ReadWrite/u);
  assert.match(unlock, /FileShare\]::None/u);
  assert.match(unlock, /Stopwatch\]::StartNew/u);
  assert.match(unlock, /ElapsedMilliseconds -ge \$TimeoutMilliseconds/u);
  assert.match(unlock, /Dispose\(\)/u);
});

test("only Tauri's finish page can launch after an interactive install", () => {
  assert.doesNotMatch(hooks, /NSIS_HOOK_POSTINSTALL|RunAsUser|WasRunningMarker/u);
  assert.doesNotMatch(helper, /WasRunningMarker|hunsu-bridge-was-running/u);
  assert.match(installerTemplate, /!define MUI_FINISHPAGE_RUN/u);
  assert.match(installerTemplate, /!define MUI_FINISHPAGE_RUN_FUNCTION RunMainBinary/u);
  const runMainBinary = between(installerTemplate, "Function RunMainBinary", "FunctionEnd");
  assert.equal((runMainBinary.match(/RunAsUser/gu) ?? []).length, 1);
});

test("the Windows size guard counts the vendored installer template with its lifecycle helpers", () => {
  assert.match(
    artifactSizeReporter,
    /src-tauri\/windows\/installer-template\.nsi[\s\S]*src-tauri\/windows\/installer-hooks\.nsh[\s\S]*src-tauri\/windows\/stop-existing-bridge\.ps1/u
  );
});

test("every CIM ownership query has a finite operation timeout", () => {
  assert.equal((helper.match(/Get-NetTCPConnection/gu) ?? []).length, 0);
  const directProcessQueries = helper.match(/Get-CimInstance -ClassName "Win32_Process"[^\r\n]*/gu) ?? [];
  assert.ok(directProcessQueries.length >= 3);
  for (const query of directProcessQueries) {
    assert.match(query, /-OperationTimeoutSec \$CimOperationTimeoutSeconds/u);
  }
  const connectionQuery = between(
    helper,
    "$connectionQuery = @{",
    "$listeners = @(Get-CimInstance @connectionQuery"
  );
  assert.match(connectionQuery, /OperationTimeoutSec = \$CimOperationTimeoutSeconds/u);
});

test("helper stable exit codes distinguish timeout recovery from safety failures", () => {
  assert.match(helper, /\$ExitStopped = 0/u);
  assert.match(helper, /\$ExitGracefulStopTimedOut = 10/u);
  assert.match(helper, /\$ExitProcessEnumerationFailed = 11/u);
  assert.match(helper, /\$ExitVerifiedTreeTerminationFailed = 12/u);
  assert.match(helper, /\$ExitInstalledExecutableLocked = 13/u);
  assert.match(helper, /\$ExitInvalidInstallDirectory = 14/u);
});
