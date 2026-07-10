param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,
  [Parameter(Mandatory = $true)]
  [string]$EvidencePath,
  [int]$BridgePort = 0,
  [int]$CdpPort = 0
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

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

if ($BridgePort -eq 0) { $BridgePort = Get-FreeLoopbackPort }
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
$fakeCodexPath = Join-Path $runtimeDir "codex-qa.cmd"
$workspaceFixturePath = Join-Path $root "fixture-roadmap"
$driverPath = Join-Path $PSScriptRoot "windows-installed-app-webview-e2e.mjs"
$legacySecret = "qa_legacy_" + [guid]::NewGuid().ToString("N")
$appProcess = $null
$appExecutable = $null
$installedSidecar = $null

New-Item -ItemType Directory -Path $installDir, $runtimeDir, $webViewDataDir, $workspaceFixturePath -Force | Out-Null

@{
  schema = "hunsu.bridge-app-state.v1"
  diagnosticsSecurityVersion = 0
  authToken = $legacySecret
  pairing = @{
    token = $legacySecret
    issuedAt = "2026-01-01T00:00:00.000Z"
    expiresAt = "2026-01-01T00:05:00.000Z"
  }
} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $statePath -Encoding utf8

Set-Content -LiteralPath $logPath -Encoding utf8 -Value (
  "{`"event`":`"legacy.qa`",`"url`":`"http://127.0.0.1/bridge?hunsuBridgeToken=$legacySecret&access_token=$legacySecret`"}"
)
Set-Content -LiteralPath $fakeCodexPath -Encoding ascii -Value @(
  "@echo off",
  "if `"%~1`"==`"--version`" (",
  "  echo codex-qa 0.0.0",
  "  exit /b 0",
  ")",
  "exit /b 1"
)

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

  $node = (Get-Command node -ErrorAction Stop).Source
  & $node $driverPath `
    --endpoint $cdpEndpoint `
    --capture-path $browserCapturePath `
    --log-path $logPath `
    --legacy-secret $legacySecret `
    --evidence-path $EvidencePath
  if ($LASTEXITCODE -ne 0) {
    throw "Installed Hunsu Bridge WebView2 E2E failed with exit code $LASTEXITCODE."
  }

  Write-Host "Windows installed Hunsu Bridge WebView2 E2E passed."
} finally {
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
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
