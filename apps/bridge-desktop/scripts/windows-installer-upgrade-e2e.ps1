param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,
  [Parameter(Mandatory = $true)]
  [string]$CandidateSidecarPath,
  [Parameter(Mandatory = $true)]
  [string]$EvidencePath,
  [int]$BridgePort = 19687,
  [int]$InstallerTimeoutSeconds = 120
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$runStartedAt = [DateTime]::UtcNow

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
  throw "The Windows installer upgrade E2E gate must run on Windows."
}

$resolvedInstallerPath = (Resolve-Path -LiteralPath $InstallerPath).Path
$resolvedCandidateSidecarPath = (Resolve-Path -LiteralPath $CandidateSidecarPath).Path
$desktopPackagePath = Join-Path (Split-Path -Parent $PSScriptRoot) "package.json"
if (-not (Test-Path -LiteralPath $resolvedInstallerPath -PathType Leaf)) {
  throw "NSIS installer was not found: $InstallerPath"
}
if (-not (Test-Path -LiteralPath $resolvedCandidateSidecarPath -PathType Leaf)) {
  throw "Candidate Bridge sidecar was not found: $CandidateSidecarPath"
}
if (-not (Test-Path -LiteralPath $desktopPackagePath -PathType Leaf)) {
  throw "Bridge desktop package metadata was not found."
}
$expectedAppVersion = [string](Get-Content -LiteralPath $desktopPackagePath -Raw | ConvertFrom-Json).version
if ($expectedAppVersion -ne "0.1.1") {
  throw "The upgrade candidate must be desktop version 0.1.1; package metadata reported $expectedAppVersion."
}
if ($InstallerTimeoutSeconds -lt 30 -or $InstallerTimeoutSeconds -gt 600) {
  throw "InstallerTimeoutSeconds must be between 30 and 600."
}

function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
}

function Get-TextSha256 {
  param([AllowEmptyString()][string]$Text)
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
  $hash = [System.Security.Cryptography.SHA256]::HashData($bytes)
  return [Convert]::ToHexString($hash).ToLowerInvariant()
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

function Get-ListenerPids {
  param([int]$Port = $BridgePort)
  return @(Get-NetTCPConnection `
    -LocalAddress "127.0.0.1" `
    -LocalPort $Port `
    -State Listen `
    -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique)
}

function Wait-Listener {
  param([int]$Port, [int]$TimeoutSeconds = 15)
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    $pids = @(Get-ListenerPids -Port $Port)
    if ($pids.Count -gt 0) { return $pids }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Timed out waiting for a fixture listener."
}

function Wait-NoListener {
  param([int]$Port = $BridgePort, [int]$TimeoutSeconds = 15)
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    if (@(Get-ListenerPids -Port $Port).Count -eq 0) { return }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Timed out waiting for the Bridge listener to exit."
}

function Wait-NoExactPathProcesses {
  param([string]$ExecutablePath, [int]$TimeoutSeconds = 15)
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    if (@(Get-ExactPathProcesses -ExecutablePath $ExecutablePath).Count -eq 0) { return }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Timed out waiting for an exact-path fixture process to exit."
}

function Get-InstallProcesses {
  $allowedPaths = @(
    [System.IO.Path]::GetFullPath((Join-Path $installDir "Hunsu Bridge.exe")),
    [System.IO.Path]::GetFullPath((Join-Path $installDir "hunsu-bridge.exe")),
    [System.IO.Path]::GetFullPath((Join-Path $installDir "hunsu-bridge-sidecar.exe"))
  )
  return @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
    if ([string]::IsNullOrWhiteSpace([string]$_.ExecutablePath)) { return $false }
    $processPath = [System.IO.Path]::GetFullPath([string]$_.ExecutablePath)
    foreach ($allowedPath in $allowedPaths) {
      if ($processPath.Equals($allowedPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $true
      }
    }
    return $false
  })
}

function Get-ExactPathProcesses {
  param([string]$ExecutablePath)
  $normalized = [System.IO.Path]::GetFullPath($ExecutablePath)
  return @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
    -not [string]::IsNullOrWhiteSpace([string]$_.ExecutablePath) -and
    [System.IO.Path]::GetFullPath([string]$_.ExecutablePath).Equals(
      $normalized,
      [System.StringComparison]::OrdinalIgnoreCase
    )
  })
}

function Test-OldInstallPidsGone {
  param([int[]]$ProcessIds)
  if ($ProcessIds.Count -eq 0) { return $true }
  $current = @(Get-InstallProcesses | Select-Object -ExpandProperty ProcessId)
  return @($ProcessIds | Where-Object { $current -contains $_ }).Count -eq 0
}

function Wait-OldInstallPidsGone {
  param([int[]]$ProcessIds, [int]$TimeoutSeconds = 20)
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    if (Test-OldInstallPidsGone -ProcessIds $ProcessIds) { return }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "One or more prior target-installation processes remained active."
}

function Invoke-BoundedProcess {
  param(
    [string]$FilePath,
    [string[]]$ArgumentList,
    [int[]]$OldInstallPids = @(),
    [int]$TimeoutSeconds = $InstallerTimeoutSeconds
  )
  $timer = [System.Diagnostics.Stopwatch]::StartNew()
  $shutdownElapsedMs = if ($OldInstallPids.Count -eq 0) { 0 } else { $null }
  $process = Start-Process `
    -FilePath $FilePath `
    -ArgumentList $ArgumentList `
    -PassThru
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    if ($null -eq $shutdownElapsedMs -and (Test-OldInstallPidsGone -ProcessIds $OldInstallPids)) {
      $shutdownElapsedMs = [int][Math]::Round($timer.Elapsed.TotalMilliseconds)
    }
    if ($process.HasExited) { break }
    Start-Sleep -Milliseconds 100
    $process.Refresh()
  } while ([DateTime]::UtcNow -lt $deadline)

  if (-not $process.HasExited) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    throw "A silent installer operation exceeded the bounded timeout."
  }
  $process.WaitForExit()
  $timer.Stop()
  if ($null -eq $shutdownElapsedMs -and (Test-OldInstallPidsGone -ProcessIds $OldInstallPids)) {
    $shutdownElapsedMs = [int][Math]::Round($timer.Elapsed.TotalMilliseconds)
  }
  return [pscustomobject]@{
    ExitCode = [int]$process.ExitCode
    ElapsedMs = [int][Math]::Round($timer.Elapsed.TotalMilliseconds)
    ShutdownElapsedMs = $shutdownElapsedMs
  }
}

function Invoke-Installer {
  param([int[]]$OldInstallPids = @())
  # NSIS requires /D to be the final argument. Every invocation uses the same directory.
  $result = Invoke-BoundedProcess `
    -FilePath $resolvedInstallerPath `
    -ArgumentList @("/S", "/D=$installDir") `
    -OldInstallPids $OldInstallPids
  Assert-True ($result.ExitCode -eq 0) "Silent same-directory NSIS install failed with exit code $($result.ExitCode)."
  Wait-OldInstallPidsGone -ProcessIds $OldInstallPids
  return $result
}

function Find-InstalledFiles {
  $appCandidates = @(Get-ChildItem -LiteralPath $installDir -File -Filter "*.exe" -ErrorAction Stop |
    Where-Object { $_.BaseName -eq "Hunsu Bridge" -or $_.BaseName -eq "hunsu-bridge" } |
    Sort-Object @{ Expression = { if ($_.BaseName -eq "Hunsu Bridge") { 0 } else { 1 } } }, FullName)
  Assert-True ($appCandidates.Count -eq 1) "Expected exactly one installed desktop application executable."
  $sidecarCandidates = @(Get-ChildItem -LiteralPath $installDir -File -Filter "hunsu-bridge-sidecar*.exe" -ErrorAction Stop)
  Assert-True ($sidecarCandidates.Count -eq 1) "Expected exactly one installed Bridge sidecar executable."
  $script:appExecutable = $appCandidates[0].FullName
  $script:installedSidecar = $sidecarCandidates[0].FullName
  $installedHash = (Get-FileHash -LiteralPath $script:installedSidecar -Algorithm SHA256).Hash.ToLowerInvariant()
  Assert-True ($installedHash -eq $candidateSidecarSha256) "Installed sidecar hash did not match the candidate sidecar."
}

function Invoke-SidecarJson {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
  $output = & $script:installedSidecar @Arguments 2>&1 | Out-String
  $exitCode = $LASTEXITCODE
  try {
    $payload = $output | ConvertFrom-Json
  } catch {
    throw "Installed sidecar returned invalid JSON (exit $exitCode, command $($Arguments[0]))."
  }
  return [pscustomobject]@{ ExitCode = [int]$exitCode; Payload = $payload }
}

function Wait-ConnectedManaged {
  param([int]$TimeoutSeconds = 20)
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    try {
      $result = Invoke-SidecarJson snapshot
      $snapshot = $result.Payload
      if ($result.ExitCode -eq 0 -and
        $snapshot.localBridgeControl.state -eq "connected" -and
        $snapshot.localBridgeControl.ownership -eq "managed") {
        return $snapshot
      }
    } catch {
      # Startup may still be creating the managed runtime state.
    }
    Start-Sleep -Milliseconds 200
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Installed Bridge did not reach connected-managed."
}

function Assert-SingleInstalledTopology {
  param([object]$Snapshot)
  $apps = @(Get-ExactPathProcesses -ExecutablePath $script:appExecutable)
  $sidecars = @(Get-ExactPathProcesses -ExecutablePath $script:installedSidecar)
  $supervisors = @($sidecars | Where-Object { [string]$_.CommandLine -match "(?i)(?:^|\s)supervise(?:\s|$)" })
  $daemons = @($sidecars | Where-Object { [string]$_.CommandLine -match "(?i)(?:^|\s)daemon(?:\s|$)" })
  $listeners = @(Get-ListenerPids)
  Assert-True ($apps.Count -eq 1) "Expected exactly one installed desktop application process."
  Assert-True ($supervisors.Count -eq 1) "Expected exactly one installed Bridge supervisor."
  Assert-True ($daemons.Count -eq 1) "Expected exactly one installed Bridge daemon."
  Assert-True ($listeners.Count -eq 1) "Expected exactly one Bridge listener."
  Assert-True ([int]$supervisors[0].ProcessId -eq [int]$Snapshot.localBridgeControl.supervisorPid) "Supervisor PID did not match managed state."
  Assert-True ([int]$daemons[0].ProcessId -eq [int]$Snapshot.localBridgeControl.daemonPid) "Daemon PID did not match managed state."
  Assert-True ([int]$listeners[0] -eq [int]$daemons[0].ProcessId) "Managed daemon did not own the Bridge listener."
  Assert-True ([string]$Snapshot.versions.bridgeApp -eq $expectedAppVersion) "Installed snapshot did not report desktop candidate version $expectedAppVersion."
  return [ordered]@{
    appPid = [int]$apps[0].ProcessId
    supervisorPid = [int]$supervisors[0].ProcessId
    daemonPid = [int]$daemons[0].ProcessId
    listenerPid = [int]$listeners[0]
    candidateVersion = [string]$Snapshot.versions.bridgeApp
  }
}

function Start-OrReuseInstalledApp {
  $apps = @(Get-ExactPathProcesses -ExecutablePath $script:appExecutable)
  Assert-True ($apps.Count -le 1) "More than one installed desktop application was already running."
  if ($apps.Count -eq 0) {
    $null = Start-Process `
      -FilePath $script:appExecutable `
      -WorkingDirectory (Split-Path -Parent $script:appExecutable) `
      -PassThru
  }
  $snapshot = Wait-ConnectedManaged
  return Assert-SingleInstalledTopology -Snapshot $snapshot
}

function Stop-DesktopShellOnly {
  $apps = @(Get-ExactPathProcesses -ExecutablePath $script:appExecutable)
  Assert-True ($apps.Count -eq 1) "Expected one desktop shell before the background-only transition."
  # Native tray activation is not reliable on hosted runners. Terminating only the exact-path
  # shell reproduces the post-Quit keep-background topology without touching the runtime.
  Stop-Process -Id ([int]$apps[0].ProcessId) -Force
  Wait-Process -Id ([int]$apps[0].ProcessId) -Timeout 10 -ErrorAction SilentlyContinue
  Assert-True (@(Get-ExactPathProcesses -ExecutablePath $script:appExecutable).Count -eq 0) "Desktop shell did not exit."
}

function Stop-BridgeAndShell {
  $stop = Invoke-SidecarJson stop --json
  Assert-True ($stop.ExitCode -eq 0 -and $stop.Payload.ok -eq $true) "Installed Bridge stop failed."
  Stop-DesktopShellOnly
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  do {
    $sidecars = @(Get-ExactPathProcesses -ExecutablePath $script:installedSidecar)
    if ($sidecars.Count -eq 0) { break }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $deadline)
  Assert-True ($sidecars.Count -eq 0) "Installed supervisor or daemon remained after Stop."
  Wait-NoListener
}

function Assert-NoEaddrinuse {
  if (Test-Path -LiteralPath $logPath -PathType Leaf) {
    Assert-True (-not (Select-String -LiteralPath $logPath -Pattern "EADDRINUSE" -Quiet)) "EADDRINUSE appeared during same-directory upgrade."
  }
}

function Find-Uninstaller {
  $candidates = @(Get-ChildItem -LiteralPath $installDir -File -Filter "*.exe" -ErrorAction Stop |
    Where-Object { $_.Name -match "(?i)uninst|uninstall" })
  Assert-True ($candidates.Count -eq 1) "Expected exactly one installed NSIS uninstaller."
  return $candidates[0].FullName
}

function Wait-CoreFilesRemoved {
  param([int]$TimeoutSeconds = 20)
  $coreFiles = @(
    $script:appExecutable,
    $script:installedSidecar,
    (Join-Path $installDir "hunsu-bridge.exe")
  )
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    if (@($coreFiles | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }).Count -eq 0) { return }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Uninstall left one or more core Hunsu executable files behind."
}

function Write-SafeEvidence {
  $json = $evidence | ConvertTo-Json -Depth 12
  Assert-True ($json -notmatch "(?i)\b[a-z][a-z0-9+.-]*://|hunsuBridgeToken|hunsuRelayToken|authorization|access_token|refresh_token|controlToken") "Upgrade evidence contained a URL or credential parameter."
  Assert-True ($json -notmatch "(?i)[a-z]:\\users\\") "Upgrade evidence contained a full user-profile path."
  $parent = Split-Path -Parent $EvidencePath
  if (-not [string]::IsNullOrWhiteSpace($parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
  [System.IO.File]::WriteAllText(
    [System.IO.Path]::GetFullPath($EvidencePath),
    $json + [Environment]::NewLine,
    [System.Text.UTF8Encoding]::new($false)
  )
}

$root = Join-Path ([System.IO.Path]::GetTempPath()) ("hunsu-installer-upgrade-e2e-" + [guid]::NewGuid().ToString("N"))
$installDir = Join-Path $root "fixed-install"
$runtimeDir = Join-Path $root "runtime"
$statePath = Join-Path $runtimeDir "state.json"
$logPath = Join-Path $runtimeDir "runtime.log"
$roadmapRegistryPath = Join-Path $runtimeDir "roadmaps.json"
$otherDir = Join-Path $root "qa-other"
$appExecutable = $null
$installedSidecar = $null
$outsideProcess = $null
$portFixture = $null
$candidateSidecarSha256 = (Get-FileHash -LiteralPath $resolvedCandidateSidecarPath -Algorithm SHA256).Hash.ToLowerInvariant()
$installerSha256 = (Get-FileHash -LiteralPath $resolvedInstallerPath -Algorithm SHA256).Hash.ToLowerInvariant()

$environmentNames = @(
  "HUNSU_BRIDGE_APP_STATE_PATH",
  "HUNSU_BRIDGE_APP_LOG_PATH",
  "HUNSU_ROADMAP_REGISTRY_PATH",
  "HUNSU_BRIDGE_TEST_MODE",
  "HUNSU_BRIDGE_APP_JSON",
  "HUNSU_BRIDGE_HOST",
  "HUNSU_BRIDGE_PORT"
)
$previousEnvironment = @{}
foreach ($name in $environmentNames) {
  $previousEnvironment[$name] = [System.Environment]::GetEnvironmentVariable($name, "Process")
}

New-Item -ItemType Directory -Path $installDir, $runtimeDir, $otherDir -Force | Out-Null
$env:HUNSU_BRIDGE_APP_STATE_PATH = $statePath
$env:HUNSU_BRIDGE_APP_LOG_PATH = $logPath
$env:HUNSU_ROADMAP_REGISTRY_PATH = $roadmapRegistryPath
$env:HUNSU_BRIDGE_TEST_MODE = "1"
$env:HUNSU_BRIDGE_APP_JSON = "1"
$env:HUNSU_BRIDGE_HOST = "127.0.0.1"
$env:HUNSU_BRIDGE_PORT = [string]$BridgePort

$evidence = [ordered]@{
  schema = "hunsu.windows-installer-upgrade-e2e.v1"
  schemaVersion = 1
  result = "passed"
  provenance = [ordered]@{
    runId = if ([string]::IsNullOrWhiteSpace($env:GITHUB_RUN_ID)) { "local" } else { $env:GITHUB_RUN_ID }
    runAttempt = if ([string]::IsNullOrWhiteSpace($env:GITHUB_RUN_ATTEMPT)) { "1" } else { $env:GITHUB_RUN_ATTEMPT }
    candidateSha = if ([string]::IsNullOrWhiteSpace($env:GITHUB_SHA)) { "local" } else { $env:GITHUB_SHA }
    target = "x86_64-pc-windows-msvc"
    runnerOs = [System.Environment]::OSVersion.VersionString
    runnerImage = if ([string]::IsNullOrWhiteSpace($env:ImageOS)) { "unknown" } else { $env:ImageOS }
    startedAt = $runStartedAt.ToString("o")
    installerSha256 = $installerSha256
    candidateSidecarSha256 = $candidateSidecarSha256
    expectedAppVersion = $expectedAppVersion
    installDirectoryId = Get-TextSha256 ([System.IO.Path]::GetFullPath($installDir).ToLowerInvariant())
  }
  scenarios = [ordered]@{}
  measurements = [ordered]@{}
}

try {
  # Scenario A: reinstall into the same directory while app, supervisor, and daemon are active.
  $initialInstall = Invoke-Installer
  Find-InstalledFiles
  $beforeA = Start-OrReuseInstalledApp
  $oldA = @($beforeA.appPid, $beforeA.supervisorPid, $beforeA.daemonPid)
  $reinstallA = Invoke-Installer -OldInstallPids $oldA
  Find-InstalledFiles
  $afterA = Start-OrReuseInstalledApp
  Assert-NoEaddrinuse
  $evidence.scenarios.A = [ordered]@{
    result = "passed"
    sameDirectory = $true
    installerExitCode = $reinstallA.ExitCode
    fileWriteDialogObserved = $false
    oldPids = $beforeA
    newPids = $afterA
    shutdownElapsedMs = $reinstallA.ShutdownElapsedMs
    installElapsedMs = $reinstallA.ElapsedMs
    installedSidecarSha256 = (Get-FileHash -LiteralPath $script:installedSidecar -Algorithm SHA256).Hash.ToLowerInvariant()
    candidateVersion = $afterA.candidateVersion
    singletonTopology = $true
    eaddrinuseObserved = $false
  }

  # Scenario B: keep only the supervisor/daemon alive, then reinstall into the same directory.
  $null = & $script:installedSidecar settings quit-behavior set keep-background 2>&1
  Assert-True ($LASTEXITCODE -eq 0) "Could not set keep-background for the background-only scenario."
  Stop-DesktopShellOnly
  $backgroundSnapshot = Wait-ConnectedManaged
  $backgroundSidecars = @(Get-ExactPathProcesses -ExecutablePath $script:installedSidecar)
  Assert-True ($backgroundSidecars.Count -eq 2) "Background-only scenario did not retain one supervisor and one daemon."
  $beforeB = [ordered]@{
    appPid = $null
    supervisorPid = [int]$backgroundSnapshot.localBridgeControl.supervisorPid
    daemonPid = [int]$backgroundSnapshot.localBridgeControl.daemonPid
    listenerPid = [int](@(Get-ListenerPids)[0])
  }
  $oldB = @($beforeB.supervisorPid, $beforeB.daemonPid)
  $reinstallB = Invoke-Installer -OldInstallPids $oldB
  Find-InstalledFiles
  $afterB = Start-OrReuseInstalledApp
  Assert-NoEaddrinuse
  $evidence.scenarios.B = [ordered]@{
    result = "passed"
    keepBackgroundConfigured = $true
    desktopShellExited = $true
    runtimeWasBackgroundOnly = $true
    installerExitCode = $reinstallB.ExitCode
    oldPids = $beforeB
    newPids = $afterB
    shutdownElapsedMs = $reinstallB.ShutdownElapsedMs
    installElapsedMs = $reinstallB.ElapsedMs
    singletonTopology = $true
  }

  # Scenario C: a fully stopped installation reinstalls without any process fallback target.
  Stop-BridgeAndShell
  $beforeCProcessCount = @(Get-InstallProcesses).Count
  Assert-True ($beforeCProcessCount -eq 0) "Target installation was not fully stopped before scenario C."
  $reinstallC = Invoke-Installer
  Find-InstalledFiles
  Assert-True (@(Get-InstallProcesses).Count -eq 0) "Fully stopped reinstall unexpectedly launched a target process."
  $evidence.scenarios.C = [ordered]@{
    result = "passed"
    verifiedProcessesBeforeInstall = $beforeCProcessCount
    fallbackTerminationTargets = 0
    installerExitCode = $reinstallC.ExitCode
    shutdownElapsedMs = $reinstallC.ShutdownElapsedMs
    installElapsedMs = $reinstallC.ElapsedMs
  }

  # Scenario F: an exact-name sidecar outside the target directory must survive reinstall.
  $outsideExecutable = Join-Path $otherDir "hunsu-bridge-sidecar.exe"
  Copy-Item -LiteralPath $resolvedCandidateSidecarPath -Destination $outsideExecutable -Force
  $outsidePort = Get-FreeLoopbackPort
  $savedStatePath = $env:HUNSU_BRIDGE_APP_STATE_PATH
  $savedLogPath = $env:HUNSU_BRIDGE_APP_LOG_PATH
  $savedPort = $env:HUNSU_BRIDGE_PORT
  try {
    $env:HUNSU_BRIDGE_APP_STATE_PATH = Join-Path $otherDir "outside-state.json"
    $env:HUNSU_BRIDGE_APP_LOG_PATH = Join-Path $otherDir "outside.log"
    $env:HUNSU_BRIDGE_PORT = [string]$outsidePort
    $outsideProcess = Start-Process `
      -FilePath $outsideExecutable `
      -ArgumentList @("daemon", "--no-open") `
      -WindowStyle Hidden `
      -PassThru
  } finally {
    $env:HUNSU_BRIDGE_APP_STATE_PATH = $savedStatePath
    $env:HUNSU_BRIDGE_APP_LOG_PATH = $savedLogPath
    $env:HUNSU_BRIDGE_PORT = $savedPort
  }
  $outsideListenerPids = @(Wait-Listener -Port $outsidePort)
  Assert-True ($outsideListenerPids -contains $outsideProcess.Id) "Outside-path sidecar did not own its fixture listener."
  $reinstallF = Invoke-Installer
  Assert-True (-not $outsideProcess.HasExited) "Installer terminated a similar executable outside the target directory."
  Assert-True (@(Get-ListenerPids -Port $outsidePort) -contains $outsideProcess.Id) "Installer disturbed the outside-path fixture listener."
  Find-InstalledFiles
  $evidence.scenarios.F = [ordered]@{
    result = "passed"
    similarExecutableOutsideTargetPreserved = $true
    exactInstallDirectoryMatching = $true
    outsidePid = [int]$outsideProcess.Id
    installerExitCode = $reinstallF.ExitCode
    shutdownElapsedMs = $reinstallF.ShutdownElapsedMs
    installElapsedMs = $reinstallF.ElapsedMs
  }
  Stop-Process -Id $outsideProcess.Id -Force -ErrorAction Stop
  Wait-Process -Id $outsideProcess.Id -Timeout 10 -ErrorAction SilentlyContinue
  $outsideProcess = $null

  # Scenario D: uninstall while only the background managed runtime is active.
  $beforeD = Start-OrReuseInstalledApp
  Stop-DesktopShellOnly
  $oldD = @($beforeD.appPid, $beforeD.supervisorPid, $beforeD.daemonPid)
  $oldD = @($oldD | Where-Object { $null -ne $_ })
  $uninstallerPath = Find-Uninstaller
  $uninstallD = Invoke-BoundedProcess `
    -FilePath $uninstallerPath `
    -ArgumentList @("/S") `
    -OldInstallPids $oldD
  Assert-True ($uninstallD.ExitCode -eq 0) "Silent running-runtime uninstall failed with exit code $($uninstallD.ExitCode)."
  Wait-OldInstallPidsGone -ProcessIds $oldD
  Wait-CoreFilesRemoved
  Wait-NoListener
  Assert-True (@(Get-InstallProcesses).Count -eq 0) "Uninstall left an installed Hunsu process running."
  $evidence.scenarios.D = [ordered]@{
    result = "passed"
    runtimeWasBackgroundOnly = $true
    oldPids = $beforeD
    uninstallerExitCode = $uninstallD.ExitCode
    shutdownElapsedMs = $uninstallD.ShutdownElapsedMs
    uninstallElapsedMs = $uninstallD.ElapsedMs
    appFileRemoved = $true
    sidecarFileRemoved = $true
    portReleased = $true
  }

  # Scenario E: an unrelated owner of the configured port must survive install and launch.
  Remove-Item -LiteralPath $logPath -Force -ErrorAction SilentlyContinue
  $portFixture = Start-Job -ScriptBlock {
    param($Port)
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
    $listener.Start()
    try { while ($true) { Start-Sleep -Seconds 1 } } finally { $listener.Stop() }
  } -ArgumentList $BridgePort
  $fixturePids = @(Wait-Listener -Port $BridgePort)
  Assert-True ($fixturePids.Count -eq 1) "Expected one unrelated fixture listener."
  $fixturePid = [int]$fixturePids[0]
  $installE = Invoke-Installer
  Assert-True ($portFixture.State -eq "Running") "Installer stopped the unrelated port-owner job."
  Assert-True (@(Get-ListenerPids) -contains $fixturePid) "Installer replaced the unrelated port owner."
  Find-InstalledFiles
  $appE = Start-Process `
    -FilePath $script:appExecutable `
    -WorkingDirectory (Split-Path -Parent $script:appExecutable) `
    -PassThru
  Start-Sleep -Milliseconds 500
  $conflict = Invoke-SidecarJson ensure-running --json
  Assert-True (
    $conflict.ExitCode -ne 0 -and
    $conflict.Payload.ok -eq $false -and
    $conflict.Payload.code -eq "BRIDGE_PORT_IN_USE"
  ) "Installed Hunsu runtime did not report BRIDGE_PORT_IN_USE for an unrelated listener."
  Assert-True (-not $appE.HasExited) "Desktop app exited while reporting the unrelated port conflict."
  Assert-True ($portFixture.State -eq "Running") "Hunsu stopped the unrelated port-owner job."
  Assert-True (@(Get-ListenerPids) -contains $fixturePid) "Hunsu disturbed the unrelated listener."
  Wait-NoExactPathProcesses -ExecutablePath $script:installedSidecar
  Assert-True (@(Get-ExactPathProcesses -ExecutablePath $script:installedSidecar).Count -eq 0) "Port conflict left a target-installation sidecar running."
  $evidence.scenarios.E = [ordered]@{
    result = "passed"
    unrelatedListenerPid = $fixturePid
    unrelatedListenerPreserved = $true
    installerExitCode = $installE.ExitCode
    installElapsedMs = $installE.ElapsedMs
    launchReportedCode = "BRIDGE_PORT_IN_USE"
    lingeringTargetSidecars = 0
  }

  $evidence.measurements = [ordered]@{
    installerBytes = [long](Get-Item -LiteralPath $resolvedInstallerPath).Length
    installedAppBytes = [long](Get-Item -LiteralPath $script:appExecutable).Length
    installedSidecarBytes = [long](Get-Item -LiteralPath $script:installedSidecar).Length
    installedSidecarSha256 = (Get-FileHash -LiteralPath $script:installedSidecar -Algorithm SHA256).Hash.ToLowerInvariant()
    initialInstallElapsedMs = $initialInstall.ElapsedMs
  }
  $evidence.provenance.completedAt = [DateTime]::UtcNow.ToString("o")
  Write-SafeEvidence
  Write-Host "Windows installer upgrade/reinstall/uninstall E2E scenarios A-F passed."
} finally {
  if ($null -ne $outsideProcess -and -not $outsideProcess.HasExited) {
    Stop-Process -Id $outsideProcess.Id -Force -ErrorAction SilentlyContinue
  }
  if ($null -ne $portFixture) {
    Stop-Job $portFixture -ErrorAction SilentlyContinue
    Remove-Job $portFixture -Force -ErrorAction SilentlyContinue
  }
  if ($null -ne $script:installedSidecar -and (Test-Path -LiteralPath $script:installedSidecar -PathType Leaf)) {
    try { & $script:installedSidecar stop --json 2>$null | Out-Null } catch { }
  }
  foreach ($processInfo in @(Get-InstallProcesses)) {
    Stop-Process -Id ([int]$processInfo.ProcessId) -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $installDir -PathType Container) {
    try {
      $cleanupUninstaller = Find-Uninstaller
      $null = Invoke-BoundedProcess -FilePath $cleanupUninstaller -ArgumentList @("/S") -TimeoutSeconds 60
    } catch { }
  }
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
  foreach ($name in $environmentNames) {
    [System.Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], "Process")
  }
}
