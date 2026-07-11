param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,
  [Parameter(Mandatory = $true)]
  [string]$EvidencePath,
  [Parameter(Mandatory = $true)]
  [string]$ScreenshotPath,
  [int]$BridgePort = 19687,
  [int]$CdpPort = 0
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$runStartedAt = [DateTime]::UtcNow

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
  throw "The installed-app WebView2 E2E gate must run on Windows."
}

$resolvedInstallerPath = (Resolve-Path -LiteralPath $InstallerPath).Path
if (-not (Test-Path -LiteralPath $resolvedInstallerPath -PathType Leaf)) {
  throw "NSIS installer was not found: $InstallerPath"
}

function Get-FreeLoopbackPort {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $listener.Start()
  try {
    return [int]$listener.LocalEndpoint.Port
  } finally {
    $listener.Stop()
  }
}

function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
}

function Wait-CdpEndpoint {
  param([string]$Endpoint, [System.Diagnostics.Process]$AppProcess, [int]$TimeoutSeconds = 45)
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    if ($AppProcess.HasExited) {
      throw "Installed Hunsu Bridge exited before its WebView2 debugging endpoint became available (exit $($AppProcess.ExitCode))."
    }
    try {
      $targets = @(Invoke-RestMethod -Uri "$Endpoint/json/list" -TimeoutSec 2)
      if ($targets.Count -gt 0) { return }
    } catch {
      # WebView2 has not opened the DevTools endpoint yet.
    }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Timed out waiting for the installed Hunsu Bridge WebView2 CDP endpoint."
}

function Find-InstalledAppExecutable {
  param([string]$InstallDirectory)
  $candidates = @(Get-ChildItem -LiteralPath $InstallDirectory -Recurse -File -Filter "*.exe" |
    Where-Object {
      $_.Name -notmatch "(?i)sidecar|uninst|uninstall" -and
      ($_.BaseName -eq "Hunsu Bridge" -or $_.BaseName -eq "hunsu-bridge")
    } |
    Sort-Object @{ Expression = { if ($_.BaseName -eq "Hunsu Bridge") { 0 } else { 1 } } }, FullName)
  if ($candidates.Count -eq 0) {
    throw "The silent NSIS install completed, but the Hunsu Bridge application executable was not found under $InstallDirectory."
  }
  return $candidates[0].FullName
}

function Stop-InstalledProcesses {
  param([string]$InstallDirectory)
  $prefix = [System.IO.Path]::GetFullPath($InstallDirectory).TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      -not [string]::IsNullOrWhiteSpace($_.ExecutablePath) -and
      $_.ExecutablePath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
    } |
    ForEach-Object {
      Stop-Process -Id ([int]$_.ProcessId) -Force -ErrorAction SilentlyContinue
    }
}

if ($CdpPort -eq 0) { $CdpPort = Get-FreeLoopbackPort }
Assert-True ($BridgePort -ne $CdpPort) "Bridge and WebView2 CDP ports must be different."

$root = Join-Path ([System.IO.Path]::GetTempPath()) ("hunsu-installed-app-e2e-" + [guid]::NewGuid().ToString("N"))
$installDir = Join-Path $root "installed"
$runtimeDir = Join-Path $root "runtime"
$webViewDataDir = Join-Path $root "webview2"
$statePath = Join-Path $runtimeDir "bridge-app.json"
$logPath = Join-Path $runtimeDir "bridge-app.log"
$browserCapturePath = Join-Path $runtimeDir "browser-capture.log"
$roadmapRegistryPath = Join-Path $runtimeDir "roadmaps.json"
$fakeCodexPath = Join-Path $runtimeDir "codex-qa.exe"
$fakeCodexSourcePath = Join-Path $runtimeDir "codex-qa.rs"
$vulnerableServerPath = Join-Path $runtimeDir "vulnerable-pairing-server.mjs"
$revocationMarkerPath = Join-Path $runtimeDir "pairing-revoked.marker"
$uiEvidencePath = Join-Path $runtimeDir "ui-evidence.json"
$clipboardExpectationPath = Join-Path $runtimeDir "clipboard-expectation.txt"
$workspaceFixturePath = Join-Path $root "fixture-roadmap"
$driverPath = Join-Path $PSScriptRoot "windows-installed-app-webview-e2e.mjs"
$legacySecret = "qa_legacy_" + [guid]::NewGuid().ToString("N")
$legacyControlToken = "qa_control_" + [guid]::NewGuid().ToString("N")
$appProcess = $null
$appExecutable = $null
$installedSidecar = $null
$vulnerableServerProcess = $null

New-Item -ItemType Directory -Path $installDir, $runtimeDir, $webViewDataDir, $workspaceFixturePath -Force | Out-Null

@{
  schema = "hunsu.bridge-app-state.v1"
  diagnosticsSecurityVersion = 0
  bridgeApiUrl = "http://127.0.0.1:$BridgePort"
  controlToken = $legacyControlToken
  authToken = $legacySecret
  pairing = @{
    token = $legacySecret
    issuedAt = [DateTime]::UtcNow.AddMinutes(-1).ToString("o")
    expiresAt = [DateTime]::UtcNow.AddMinutes(14).ToString("o")
  }
} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $statePath -Encoding utf8

Set-Content -LiteralPath $logPath -Encoding utf8 -Value (
  "{`"event`":`"legacy.qa`",`"url`":`"http://127.0.0.1/bridge?hunsuBridgeToken=$legacySecret&access_token=$legacySecret`"}"
)
Set-Content -LiteralPath $fakeCodexSourcePath -Encoding utf8 -Value @(
  "fn main() {",
  "    let mut args = std::env::args().skip(1);",
  "    if args.next().as_deref() == Some(`"--version`") && args.next().is_none() {",
  "        println!(`"codex-qa 0.0.0`");",
  "        return;",
  "    }",
  "    std::process::exit(1);",
  "}"
)
Set-Content -LiteralPath $vulnerableServerPath -Encoding utf8 -Value @'
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";

const port = Number(process.argv[2]);
const markerPath = process.argv[3];
const controlToken = process.env.HUNSU_BRIDGE_QA_CONTROL_TOKEN;
const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok", service: "hunsu-bridge", bridgeVersion: "vulnerable-qa", protocolVersion: "local-bridge-v1" }));
    return;
  }
  if (request.method === "GET" && request.url === "/api/bridge/control/status") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ state: "connected", ownership: "managed", pairingState: "active" }));
    return;
  }
  if (request.method === "POST" && request.url === "/api/bridge/pairing/revoke"
      && request.headers["x-hunsu-bridge-control-token"] === controlToken) {
    writeFileSync(markerPath, "revoked\n", "utf8");
    response.writeHead(202, { "content-type": "application/json" });
    response.end(JSON.stringify({ revoked: true }));
    setTimeout(() => server.close(() => process.exit(0)), 25);
    return;
  }
  response.writeHead(403, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "forbidden" }));
});
server.listen(port, "127.0.0.1");
setTimeout(() => process.exit(2), 30_000).unref();
'@
$rustc = (Get-Command rustc -ErrorAction Stop).Source
& $rustc --crate-name codex_qa_fixture $fakeCodexSourcePath -o $fakeCodexPath
Assert-True ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $fakeCodexPath -PathType Leaf)) "Could not compile the native Codex CLI fixture."

$fixtureVersionOutput = & $fakeCodexPath --version 2>&1 | Out-String
Assert-True ($LASTEXITCODE -eq 0 -and $fixtureVersionOutput.Trim() -eq "codex-qa 0.0.0") "The controlled Codex CLI fixture did not return its expected version."

$env:HUNSU_BRIDGE_APP_STATE_PATH = $statePath
$env:HUNSU_BRIDGE_APP_LOG_PATH = $logPath
$env:HUNSU_BRIDGE_TEST_MODE = "1"
$env:HUNSU_BRIDGE_TEST_BROWSER_CAPTURE_PATH = $browserCapturePath
$env:HUNSU_ROADMAP_REGISTRY_PATH = $roadmapRegistryPath
$env:HUNSU_BRIDGE_HOST = "127.0.0.1"
$env:HUNSU_BRIDGE_PORT = [string]$BridgePort
$env:HUNSU_BRIDGE_APP_JSON = "1"
$env:HUNSU_CODEX_BINARY_PATH = $fakeCodexPath
$env:HUNSU_CODEX_BINARY_PATH_SOURCE = "qa_fixture"
$env:WEBVIEW2_USER_DATA_FOLDER = $webViewDataDir
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$CdpPort --remote-debugging-address=127.0.0.1 --remote-allow-origins=*"

try {
  # NSIS /D must be the final installer argument. The GUID path keeps this candidate isolated.
  $installer = Start-Process -FilePath $resolvedInstallerPath -ArgumentList @("/S", "/D=$installDir") -PassThru -Wait
  Assert-True ($installer.ExitCode -eq 0) "Silent NSIS install failed with exit code $($installer.ExitCode)."

  $appExecutable = Find-InstalledAppExecutable $installDir
  $installedSidecar = Get-ChildItem -LiteralPath $installDir -Recurse -File -Filter "hunsu-bridge-sidecar*.exe" |
    Select-Object -First 1
  Assert-True ($null -ne $installedSidecar) "The installed Bridge sidecar was not found."

  # Recreate an active vulnerable-build pairing session and require the fixed candidate to revoke it.
  $node = (Get-Command node -ErrorAction Stop).Source
  $env:HUNSU_BRIDGE_QA_CONTROL_TOKEN = $legacyControlToken
  $vulnerableServerProcess = Start-Process -FilePath $node -ArgumentList @(
    $vulnerableServerPath,
    [string]$BridgePort,
    $revocationMarkerPath
  ) -PassThru -WindowStyle Hidden
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  do {
    $legacyListener = Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort $BridgePort -State Listen -ErrorAction SilentlyContinue
    if ($null -ne $legacyListener) { break }
    if ($vulnerableServerProcess.HasExited) { throw "The vulnerable-build pairing fixture exited before listening." }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $deadline)
  Assert-True ($null -ne $legacyListener) "The vulnerable-build pairing fixture did not start."

  $migrationOutput = & $installedSidecar.FullName snapshot 2>&1 | Out-String
  $migrationExitCode = $LASTEXITCODE
  try {
    $null = $migrationOutput | ConvertFrom-Json
  } catch {
    throw "The installed sidecar returned invalid JSON during the live pairing migration (exit $migrationExitCode)."
  }
  Assert-True ($migrationExitCode -eq 0) "The installed sidecar failed its live pairing migration."
  Assert-True (Test-Path -LiteralPath $revocationMarkerPath -PathType Leaf) "The fixed candidate did not revoke the active vulnerable-build pairing session."
  $migratedStateText = Get-Content -LiteralPath $statePath -Raw
  $migratedState = $migratedStateText | ConvertFrom-Json
  Assert-True ([int]$migratedState.diagnosticsSecurityVersion -ge 1) "The fixed candidate did not record its completed security migration."
  Assert-True (-not $migratedStateText.Contains($legacySecret)) "The completed security migration retained the vulnerable pairing token."
  Assert-True ($vulnerableServerProcess.WaitForExit(10000)) "The vulnerable-build pairing fixture did not exit after revocation."
  Remove-Item Env:HUNSU_BRIDGE_QA_CONTROL_TOKEN -ErrorAction SilentlyContinue
  $vulnerableServerProcess = $null

  $fixtureOutput = & $installedSidecar.FullName create $workspaceFixturePath --no-open --json 2>&1 | Out-String
  $fixtureExitCode = $LASTEXITCODE
  try {
    $fixtureResult = $fixtureOutput | ConvertFrom-Json
  } catch {
    throw "The installed sidecar returned invalid JSON while preparing the fixture Workspace (exit $fixtureExitCode)."
  }
  if ($fixtureExitCode -ne 0 -or $fixtureResult.ok -ne $true) {
    $fixtureCode = if ([string]::IsNullOrWhiteSpace([string]$fixtureResult.code)) { "UNKNOWN" } else { [string]$fixtureResult.code }
    throw "The installed sidecar could not prepare the fixture Workspace (exit $fixtureExitCode, code $fixtureCode)."
  }
  $fixtureRoadmapId = [string]$fixtureResult.value.roadmapId
  Assert-True (-not [string]::IsNullOrWhiteSpace($fixtureRoadmapId)) "The installed sidecar did not return the fixture Roadmap ID."
  Assert-True (-not (Test-Path -LiteralPath $browserCapturePath -PathType Leaf)) "No-open fixture preparation unexpectedly handed off to a browser."

  $snapshotOutput = & $installedSidecar.FullName snapshot 2>&1 | Out-String
  $snapshotExitCode = $LASTEXITCODE
  try {
    $installedSnapshot = $snapshotOutput | ConvertFrom-Json
  } catch {
    throw "The installed sidecar returned invalid JSON while checking candidate versions (exit $snapshotExitCode)."
  }
  Assert-True (
    $snapshotExitCode -eq 0 -and [string]$installedSnapshot.versions.codexCli -eq "codex-qa 0.0.0"
  ) "The installed sidecar did not resolve the controlled Codex CLI version."

  # Launching the installed App against this existing managed daemon verifies reuse at the native boundary.
  $appProcess = Start-Process -FilePath $appExecutable -WorkingDirectory (Split-Path -Parent $appExecutable) -PassThru
  $cdpEndpoint = "http://127.0.0.1:$CdpPort"
  Wait-CdpEndpoint -Endpoint $cdpEndpoint -AppProcess $appProcess
  $installedSidecarProcesses = @(Get-CimInstance Win32_Process | Where-Object {
    -not [string]::IsNullOrWhiteSpace($_.ExecutablePath) -and
    $_.ExecutablePath.StartsWith([System.IO.Path]::GetFullPath($installDir), [System.StringComparison]::OrdinalIgnoreCase) -and
    $_.Name -like "hunsu-bridge-sidecar*"
  })
  Assert-True ($installedSidecarProcesses.Count -ge 2) "The installed managed runtime topology was not present."
  foreach ($processInfo in $installedSidecarProcesses) {
    $nativeProcess = Get-Process -Id ([int]$processInfo.ProcessId) -ErrorAction Stop
    Assert-True ($nativeProcess.MainWindowHandle -eq 0) "An installed Bridge sidecar exposed a console window."
  }

  & $node $driverPath `
    --endpoint $cdpEndpoint `
    --capture-path $browserCapturePath `
    --log-path $logPath `
    --legacy-secret $legacySecret `
    --roadmap-id $fixtureRoadmapId `
    --bridge-port "$BridgePort" `
    --screenshot-path $ScreenshotPath `
    --clipboard-expectation-path $clipboardExpectationPath `
    --evidence-path $uiEvidencePath
  if ($LASTEXITCODE -ne 0) {
    throw "Installed Hunsu Bridge WebView2 E2E failed with exit code $LASTEXITCODE."
  }

  $clipboardText = Get-Clipboard -Raw
  $clipboardExpectation = Get-Content -LiteralPath $clipboardExpectationPath -Raw
  $normalizedClipboard = $clipboardText.Replace("`r`n", "`n")
  $normalizedExpectation = $clipboardExpectation.Replace("`r`n", "`n")
  Assert-True ($normalizedClipboard -eq $normalizedExpectation) "The installed WebView Copy Diagnostics payload did not reach the native Windows clipboard."
  Assert-True (-not $clipboardText.Contains($legacySecret)) "The native Windows clipboard retained the vulnerable pairing token."

  $uiEvidence = Get-Content -LiteralPath $uiEvidencePath -Raw | ConvertFrom-Json
  $uiEvidence | Add-Member -NotePropertyName provenance -NotePropertyValue ([ordered]@{
    runId = if ([string]::IsNullOrWhiteSpace($env:GITHUB_RUN_ID)) { "local" } else { $env:GITHUB_RUN_ID }
    runAttempt = if ([string]::IsNullOrWhiteSpace($env:GITHUB_RUN_ATTEMPT)) { "1" } else { $env:GITHUB_RUN_ATTEMPT }
    headSha = if ([string]::IsNullOrWhiteSpace($env:GITHUB_SHA)) { "local" } else { $env:GITHUB_SHA }
    target = "x86_64-pc-windows-msvc"
    runnerOs = [System.Environment]::OSVersion.VersionString
    runnerImage = if ([string]::IsNullOrWhiteSpace($env:ImageOS)) { "unknown" } else { $env:ImageOS }
    startedAt = $runStartedAt.ToString("o")
    completedAt = [DateTime]::UtcNow.ToString("o")
    installerSha256 = (Get-FileHash -LiteralPath $resolvedInstallerPath -Algorithm SHA256).Hash.ToLowerInvariant()
    screenshotSha256 = (Get-FileHash -LiteralPath $ScreenshotPath -Algorithm SHA256).Hash.ToLowerInvariant()
    sanitizedLogSha256 = (Get-FileHash -LiteralPath $logPath -Algorithm SHA256).Hash.ToLowerInvariant()
  })
  $uiEvidence.observations | Add-Member -NotePropertyName nativeClipboardRoundTrip -NotePropertyValue $true
  $uiEvidence.observations | Add-Member -NotePropertyName sidecarConsoleWindows -NotePropertyValue 0
  $uiEvidence.observations | Add-Member -NotePropertyName liveLegacyPairingRevoked -NotePropertyValue $true
  $evidenceParent = Split-Path -Parent $EvidencePath
  if (-not [string]::IsNullOrWhiteSpace($evidenceParent)) {
    New-Item -ItemType Directory -Path $evidenceParent -Force | Out-Null
  }
  [System.IO.File]::WriteAllText(
    [System.IO.Path]::GetFullPath($EvidencePath),
    ($uiEvidence | ConvertTo-Json -Depth 12) + [Environment]::NewLine,
    [System.Text.UTF8Encoding]::new($false)
  )

  Write-Host "Windows installed Hunsu Bridge WebView2 E2E passed."
} finally {
  Remove-Item Env:HUNSU_BRIDGE_QA_CONTROL_TOKEN -ErrorAction SilentlyContinue
  if ($null -ne $vulnerableServerProcess -and -not $vulnerableServerProcess.HasExited) {
    Stop-Process -Id $vulnerableServerProcess.Id -Force -ErrorAction SilentlyContinue
  }
  if ($null -ne $installedSidecar) {
    try { & $installedSidecar.FullName stop --json 2>$null | Out-Null } catch { }
  }
  if ($null -ne $appProcess -and -not $appProcess.HasExited) {
    Stop-Process -Id $appProcess.Id -Force -ErrorAction SilentlyContinue
  }
  Stop-InstalledProcesses $installDir

  $uninstaller = Get-ChildItem -LiteralPath $installDir -Recurse -File -Filter "*.exe" -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match "(?i)uninst|uninstall" } |
    Select-Object -First 1
  if ($null -ne $uninstaller) {
    try { Start-Process -FilePath $uninstaller.FullName -ArgumentList "/S" -PassThru -Wait | Out-Null } catch { }
  }
  try { Set-Clipboard -Value "" } catch { }
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
