param(
  [Parameter(Mandatory = $true)]
  [string]$SidecarPath,
  [string]$WorkspaceFixture,
  [string]$EvidencePath,
  [int]$BridgePort = 19687
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if (-not (Test-Path -LiteralPath $SidecarPath -PathType Leaf)) {
  throw "Packaged Bridge sidecar was not found: $SidecarPath"
}

$SidecarPath = [System.IO.Path]::GetFullPath($SidecarPath)
$root = Join-Path ([System.IO.Path]::GetTempPath()) ("hunsu-bridge-e2e-" + [guid]::NewGuid().ToString("N"))
$statePath = Join-Path $root "bridge-app.json"
$logPath = Join-Path $root "bridge-app.log"
$browserCapturePath = Join-Path $root "browser-capture.log"
$roadmapRegistryPath = Join-Path $root "roadmaps.json"
New-Item -ItemType Directory -Path $root | Out-Null

if ([string]::IsNullOrWhiteSpace($WorkspaceFixture)) {
  $WorkspaceFixture = Join-Path $root "fixture-roadmap"
  New-Item -ItemType Directory -Path $WorkspaceFixture | Out-Null
} elseif (-not (Test-Path -LiteralPath $WorkspaceFixture -PathType Container)) {
  throw "Workspace fixture directory was not found: $WorkspaceFixture"
}
$WorkspaceFixture = [System.IO.Path]::GetFullPath($WorkspaceFixture)

$env:HUNSU_BRIDGE_APP_STATE_PATH = $statePath
$env:HUNSU_BRIDGE_APP_LOG_PATH = $logPath
$env:HUNSU_BRIDGE_TEST_MODE = "1"
$env:HUNSU_BRIDGE_TEST_BROWSER_CAPTURE_PATH = $browserCapturePath
$env:HUNSU_ROADMAP_REGISTRY_PATH = $roadmapRegistryPath
$env:HUNSU_BRIDGE_HOST = "127.0.0.1"
$env:HUNSU_BRIDGE_PORT = [string]$BridgePort
$env:HUNSU_BRIDGE_APP_JSON = "1"

$evidence = [ordered]@{
  schemaVersion = 1
  result = "passed"
  scenarios = [ordered]@{}
}

function Invoke-BridgeJson {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
  $output = & $SidecarPath @Arguments 2>&1 | Out-String
  $exitCode = $LASTEXITCODE
  try {
    return ($output | ConvertFrom-Json)
  } catch {
    throw "Bridge command returned invalid JSON ($exitCode): $($Arguments -join ' ')`n$output"
  }
}

function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
}

function Assert-BridgeJsonSuccess {
  param([object]$Result, [string]$Message)
  Assert-True ($null -ne $Result -and $Result.ok -eq $true) $Message
}

function Get-UriQueryValue {
  param([uri]$Uri, [string]$Name)
  foreach ($entry in $Uri.Query.TrimStart("?").Split("&", [System.StringSplitOptions]::RemoveEmptyEntries)) {
    $parts = $entry.Split("=", 2)
    $key = [uri]::UnescapeDataString($parts[0].Replace("+", " "))
    if ($key.Equals($Name, [System.StringComparison]::OrdinalIgnoreCase)) {
      if ($parts.Count -lt 2) { return "" }
      return [uri]::UnescapeDataString($parts[1].Replace("+", " "))
    }
  }
  return $null
}

function Get-BridgeStatus {
  return Invoke-BridgeJson snapshot
}

function Wait-BridgeState {
  param([string]$State, [int]$TimeoutSeconds = 15)
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    $snapshot = Get-BridgeStatus
    if ($snapshot.localBridgeControl.state -eq $State) { return $snapshot }
    Start-Sleep -Milliseconds 200
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Bridge did not reach lifecycle state '$State'."
}

function Get-ListenerPid {
  $listener = Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort $BridgePort -State Listen -ErrorAction SilentlyContinue
  if ($null -eq $listener) { return $null }
  $pids = @($listener | Select-Object -ExpandProperty OwningProcess -Unique)
  Assert-True ($pids.Count -eq 1) "Expected exactly one listener on 127.0.0.1:$BridgePort."
  return [int]$pids[0]
}

function Get-RelevantSidecarTopology {
  $sidecars = @(Get-CimInstance Win32_Process | Where-Object {
    -not [string]::IsNullOrWhiteSpace($_.ExecutablePath) -and
    [string]::Equals(
      [System.IO.Path]::GetFullPath([string]$_.ExecutablePath),
      $SidecarPath,
      [System.StringComparison]::OrdinalIgnoreCase
    )
  })
  return [pscustomobject]@{
    Supervisors = @($sidecars | Where-Object { [string]$_.CommandLine -match "(?i)(?:^|\s)supervise(?:\s|$)" })
    Daemons = @($sidecars | Where-Object { [string]$_.CommandLine -match "(?i)(?:^|\s)daemon(?:\s|$)" })
  }
}

function Assert-SingleManagedTopology {
  param([object]$Snapshot)
  $topology = Get-RelevantSidecarTopology
  $supervisors = @($topology.Supervisors)
  $daemons = @($topology.Daemons)
  Assert-True ($supervisors.Count -eq 1) "Expected exactly one relevant Bridge supervisor process."
  Assert-True ($daemons.Count -eq 1) "Expected exactly one relevant Bridge daemon process."
  Assert-True ([int]$supervisors[0].ProcessId -eq [int]$Snapshot.localBridgeControl.supervisorPid) "Enumerated supervisor did not match managed state."
  Assert-True ([int]$daemons[0].ProcessId -eq [int]$Snapshot.localBridgeControl.daemonPid) "Enumerated daemon did not match managed state."
  return [pscustomobject]@{ SupervisorCount = $supervisors.Count; DaemonCount = $daemons.Count }
}

function Get-BrowserCaptureLines {
  if (-not (Test-Path -LiteralPath $browserCapturePath -PathType Leaf)) { return @() }
  return @(Get-Content -LiteralPath $browserCapturePath | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
}

function Wait-BrowserCaptureCount {
  param([int]$ExpectedCount, [int]$TimeoutSeconds = 5)
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    $lines = @(Get-BrowserCaptureLines)
    if ($lines.Count -ge $ExpectedCount) {
      Assert-True ($lines.Count -eq $ExpectedCount) "Browser action produced more than one handoff."
      return $lines
    }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Browser action did not produce exactly one captured handoff."
}

function Invoke-BrowserAction {
  param([string]$Label, [scriptblock]$Action)
  $beforeCount = @(Get-BrowserCaptureLines).Count
  $result = & $Action
  Assert-BridgeJsonSuccess $result "$Label failed."
  $lines = @(Wait-BrowserCaptureCount ($beforeCount + 1))
  Assert-True ($lines.Count - $beforeCount -eq 1) "$Label did not produce exactly one browser handoff."
  return [pscustomobject]@{
    Result = $result
    Capture = [string]$lines[-1]
    HandoffCount = 1
  }
}

function Get-ActionSecret {
  param([object]$Action, [string]$Label)
  $captureUri = [uri]$Action.Capture
  $secret = Get-UriQueryValue $captureUri "hunsuBridgeToken"
  Assert-True (-not [string]::IsNullOrWhiteSpace($secret)) "$Label browser handoff did not contain a synthetic runtime credential."
  Assert-True (-not (($Action.Result | ConvertTo-Json -Depth 10).Contains($secret))) "$Label command output exposed its runtime credential."
  return $secret
}

function Assert-NoUnsafeDiagnostics {
  param([string[]]$Secrets)
  $diagnostics = (& $SidecarPath diagnostics --json 2>&1 | Out-String)
  Assert-True ($LASTEXITCODE -eq 0) "Fresh Diagnostics failed."
  $log = if (Test-Path -LiteralPath $logPath) { Get-Content -LiteralPath $logPath -Raw } else { "" }

  Set-Clipboard -Value $diagnostics
  $clipboard = Get-Clipboard -Raw
  foreach ($secret in $Secrets) {
    Assert-True (-not $diagnostics.Contains($secret)) "A raw runtime credential appeared in fresh Diagnostics."
    Assert-True (-not $log.Contains($secret)) "A raw runtime credential appeared in the app log."
    Assert-True (-not $clipboard.Contains($secret)) "A raw runtime credential appeared after the Windows clipboard round trip."
  }
  return [pscustomobject]@{
    FreshDiagnostics = $true
    ClipboardRoundTrip = $true
    RawSecretsAbsent = $true
  }
}

function Write-SafeEvidence {
  param([string[]]$Secrets)
  if ([string]::IsNullOrWhiteSpace($EvidencePath)) { return }
  $json = $evidence | ConvertTo-Json -Depth 10
  Assert-True ($json -notmatch "(?i)\b[a-z][a-z0-9+.-]*://|hunsuBridgeToken") "Evidence unexpectedly contained a URL or credential parameter."
  foreach ($secret in $Secrets) {
    Assert-True (-not $json.Contains($secret)) "Evidence unexpectedly contained a raw runtime credential."
  }
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

$capturedSecrets = @()
$unmanagedProcess = $null
try {
  # Scenario A: repeated and concurrent ensure-running calls reuse one managed instance.
  $first = Invoke-BridgeJson ensure-running --json
  Assert-BridgeJsonSuccess $first "Initial ensure-running failed."
  $connected = Wait-BridgeState connected
  $firstInstance = $connected.localBridgeControl.instanceId
  $firstDaemonPid = [int]$connected.localBridgeControl.daemonPid
  $firstSupervisorPid = [int]$connected.localBridgeControl.supervisorPid
  $firstListenerPid = Get-ListenerPid
  Assert-True ($firstListenerPid -eq $firstDaemonPid) "Managed daemon did not own the Bridge listener."

  $second = Invoke-BridgeJson ensure-running --json
  Assert-BridgeJsonSuccess $second "Repeated ensure-running failed."
  $afterSecond = Wait-BridgeState connected
  Assert-True ($afterSecond.localBridgeControl.instanceId -eq $firstInstance) "ensure-running replaced the managed instance."
  Assert-True ([int]$afterSecond.localBridgeControl.daemonPid -eq $firstDaemonPid) "ensure-running changed the daemon PID."
  Assert-True ([int]$afterSecond.localBridgeControl.supervisorPid -eq $firstSupervisorPid) "ensure-running changed the supervisor PID."
  Assert-True ((Get-ListenerPid) -eq $firstListenerPid) "ensure-running changed the listener PID."

  $jobs = 1..2 | ForEach-Object {
    Start-Job -ScriptBlock {
      param($Executable)
      $output = & $Executable ensure-running --json 2>&1 | Out-String
      [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = $output }
    } -ArgumentList $SidecarPath
  }
  $null = $jobs | Wait-Job
  $concurrentRecords = @($jobs | Receive-Job)
  $jobs | Remove-Job -Force
  Assert-True ($concurrentRecords.Count -eq 2) "Concurrent ensure-running commands did not both complete."
  foreach ($record in $concurrentRecords) {
    Assert-True ([int]$record.ExitCode -eq 0) "A concurrent ensure-running process failed."
    try {
      $concurrentResult = [string]$record.Output | ConvertFrom-Json
    } catch {
      throw "A concurrent ensure-running process returned invalid JSON."
    }
    Assert-BridgeJsonSuccess $concurrentResult "A concurrent ensure-running result reported failure."
  }
  $afterConcurrent = Wait-BridgeState connected
  Assert-True ($afterConcurrent.localBridgeControl.instanceId -eq $firstInstance) "Concurrent ensure-running replaced the managed instance."
  Assert-True ([int]$afterConcurrent.localBridgeControl.daemonPid -eq $firstDaemonPid) "Concurrent ensure-running changed the daemon PID."
  Assert-True ([int]$afterConcurrent.localBridgeControl.supervisorPid -eq $firstSupervisorPid) "Concurrent ensure-running changed the supervisor PID."
  Assert-True ((Get-ListenerPid) -eq $firstListenerPid) "Concurrent ensure-running created another listener."
  $topology = Assert-SingleManagedTopology $afterConcurrent
  $evidence.scenarios.A = [ordered]@{
    result = "passed"
    concurrentRequests = 2
    allConcurrentRequestsSucceeded = $true
    listenerCount = 1
    supervisorCount = $topology.SupervisorCount
    daemonCount = $topology.DaemonCount
    instanceReused = $true
  }

  # Scenario B/F: Pair, Open, Open Hunsu Web, and Workspace Open each hand off once and reuse the daemon.
  $captureCountBeforeFixtureSetup = @(Get-BrowserCaptureLines).Count
  $fixtureSetup = Invoke-BridgeJson create $WorkspaceFixture --no-open --json
  Assert-BridgeJsonSuccess $fixtureSetup "Fixture Workspace setup failed."
  Assert-True (@(Get-BrowserCaptureLines).Count -eq $captureCountBeforeFixtureSetup) "No-open fixture setup unexpectedly handed off to a browser."
  $roadmapId = [string]$fixtureSetup.value.roadmapId
  Assert-True (-not [string]::IsNullOrWhiteSpace($roadmapId)) "Fixture Workspace setup did not return a Roadmap ID."

  $pairAction = Invoke-BrowserAction "Pair" { Invoke-BridgeJson pair --json }
  $openAction = Invoke-BrowserAction "Open" { Invoke-BridgeJson open-project $WorkspaceFixture --json }
  $webAction = Invoke-BrowserAction "Open Hunsu Web" { Invoke-BridgeJson pair --json }
  $workspaceAction = Invoke-BrowserAction "Workspace Open" { Invoke-BridgeJson open-roadmap $roadmapId --json }
  $capturedSecrets = @(
    Get-ActionSecret $pairAction "Pair"
    Get-ActionSecret $openAction "Open"
    Get-ActionSecret $webAction "Open Hunsu Web"
    Get-ActionSecret $workspaceAction "Workspace Open"
  )
  Assert-True (@($capturedSecrets | Select-Object -Unique).Count -eq 4) "Browser actions did not each rotate to a distinct runtime credential."

  $afterOpen = Wait-BridgeState connected
  Assert-True ([int]$afterOpen.localBridgeControl.daemonPid -eq $firstDaemonPid) "Pair/Open replaced the daemon."
  Assert-True ([int]$afterOpen.localBridgeControl.supervisorPid -eq $firstSupervisorPid) "Pair/Open created another supervisor."
  $null = Assert-SingleManagedTopology $afterOpen
  if (Test-Path -LiteralPath $logPath) {
    Assert-True (-not (Select-String -LiteralPath $logPath -Pattern "EADDRINUSE" -Quiet)) "EADDRINUSE appeared in the managed lifecycle log."
  }
  $evidence.scenarios.B = [ordered]@{
    result = "passed"
    browserHandoffs = [ordered]@{
      pair = $pairAction.HandoffCount
      open = $openAction.HandoffCount
      web = $webAction.HandoffCount
      workspace = $workspaceAction.HandoffCount
    }
    distinctRotations = 4
    daemonReused = $true
    supervisorReused = $true
  }

  $redaction = Assert-NoUnsafeDiagnostics $capturedSecrets
  $evidence.scenarios.F = [ordered]@{
    result = "passed"
    freshDiagnostics = $redaction.FreshDiagnostics
    clipboardRoundTrip = $redaction.ClipboardRoundTrip
    rawSecretsAbsent = $redaction.RawSecretsAbsent
  }

  # Scenario C: authenticated Stop terminates daemon + supervisor and remains stopped past the old restart delay.
  $stopped = Invoke-BridgeJson stop --json
  Assert-BridgeJsonSuccess $stopped "Stop failed."
  $null = Wait-BridgeState not-running
  Assert-True ($null -eq (Get-ListenerPid)) "Stop did not release the Bridge port."
  Start-Sleep -Seconds 2
  Assert-True ($null -eq (Get-ListenerPid)) "Supervisor restarted the daemon after Stop."
  Assert-True ($null -eq (Get-Process -Id $firstDaemonPid -ErrorAction SilentlyContinue)) "Daemon process survived Stop."
  Assert-True ($null -eq (Get-Process -Id $firstSupervisorPid -ErrorAction SilentlyContinue)) "Supervisor process survived Stop."
  $stoppedTopology = Get-RelevantSidecarTopology
  Assert-True (@($stoppedTopology.Supervisors).Count -eq 0) "A relevant supervisor remained after Stop."
  Assert-True (@($stoppedTopology.Daemons).Count -eq 0) "A relevant daemon remained after Stop."

  $restarted = Invoke-BridgeJson ensure-running --json
  Assert-BridgeJsonSuccess $restarted "Start after Stop failed."
  $afterRestart = Wait-BridgeState connected
  Assert-True ([int]$afterRestart.localBridgeControl.daemonPid -ne $firstDaemonPid) "Start after Stop did not create a new daemon."
  $null = Assert-SingleManagedTopology $afterRestart
  $restopped = Invoke-BridgeJson stop --json
  Assert-BridgeJsonSuccess $restopped "Cleanup Stop after restart failed."
  $null = Wait-BridgeState not-running
  $evidence.scenarios.C = [ordered]@{
    result = "passed"
    daemonExited = $true
    supervisorExited = $true
    portReleased = $true
    noRestartAfterDelay = $true
    freshDaemonStarted = $true
  }

  # Scenario D: a Hunsu daemon owned by a different state/control credential is classified as unmanaged.
  $unmanagedStatePath = Join-Path $root "unmanaged-owner.json"
  $desktopStatePath = Join-Path $root "unmanaged-desktop.json"
  $env:HUNSU_BRIDGE_APP_STATE_PATH = $unmanagedStatePath
  $unmanagedProcess = Start-Process -FilePath $SidecarPath -ArgumentList @("daemon", "--no-open") -PassThru -WindowStyle Hidden
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  while ($null -eq (Get-ListenerPid) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 200 }
  Assert-True ($null -ne (Get-ListenerPid)) "Unmanaged Hunsu daemon did not start listening."
  $env:HUNSU_BRIDGE_APP_STATE_PATH = $desktopStatePath
  $unmanagedSnapshot = Get-BridgeStatus
  Assert-True ($unmanagedSnapshot.localBridgeControl.ownership -eq "unmanaged") "Foreign Hunsu daemon was not classified as unmanaged."
  $unmanagedStart = Invoke-BridgeJson ensure-running --json
  Assert-True ((-not $unmanagedStart.ok) -and $unmanagedStart.code -eq "BRIDGE_ALREADY_RUNNING_UNMANAGED") "Unmanaged Start was not rejected."
  $unmanagedStop = Invoke-BridgeJson stop --json
  Assert-True ((-not $unmanagedStop.ok) -and $unmanagedStop.code -eq "BRIDGE_NOT_OWNED") "Unmanaged Stop was not rejected."
  Assert-True ($null -ne (Get-Process -Id $unmanagedProcess.Id -ErrorAction SilentlyContinue)) "Desktop killed an unmanaged daemon."
  $evidence.scenarios.D = [ordered]@{
    result = "passed"
    ownership = "unmanaged"
    startRefused = $true
    stopRefused = $true
    foreignDaemonPreserved = $true
  }
  Stop-Process -Id $unmanagedProcess.Id -Force -ErrorAction SilentlyContinue
  Wait-Process -Id $unmanagedProcess.Id -Timeout 5 -ErrorAction SilentlyContinue
  $deadline = [DateTime]::UtcNow.AddSeconds(5)
  while ($null -ne (Get-ListenerPid) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }

  # Scenario E: a non-Hunsu listener is classified as a port conflict with no lingering or restarting sidecar.
  $dummy = Start-Job -ScriptBlock {
    param($Port)
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
    $listener.Start()
    try { while ($true) { Start-Sleep -Seconds 1 } } finally { $listener.Stop() }
  } -ArgumentList $BridgePort
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  while ($null -eq (Get-ListenerPid) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
  $conflictListenerPid = Get-ListenerPid
  Assert-True ($null -ne $conflictListenerPid) "Dummy listener did not claim the Bridge port."
  $conflict = Invoke-BridgeJson ensure-running --json
  Assert-True ((-not $conflict.ok) -and $conflict.code -eq "BRIDGE_PORT_IN_USE") "Non-Hunsu listener did not return BRIDGE_PORT_IN_USE."
  for ($sample = 0; $sample -lt 12; $sample += 1) {
    $conflictTopology = Get-RelevantSidecarTopology
    Assert-True (@($conflictTopology.Supervisors).Count -eq 0) "Port conflict left or restarted a Bridge supervisor."
    Assert-True (@($conflictTopology.Daemons).Count -eq 0) "Port conflict left or restarted a Bridge daemon."
    Assert-True ((Get-ListenerPid) -eq $conflictListenerPid) "Bridge disturbed the unrelated listener."
    Start-Sleep -Milliseconds 250
  }
  Assert-True ($dummy.State -eq "Running") "Bridge stopped the unrelated listener job."
  $evidence.scenarios.E = [ordered]@{
    result = "passed"
    actionableCode = "BRIDGE_PORT_IN_USE"
    unrelatedListenerPreserved = $true
    supervisorSamples = 12
    lingeringSupervisors = 0
    lingeringDaemons = 0
  }
  Stop-Job $dummy
  Remove-Job $dummy -Force

  Write-SafeEvidence $capturedSecrets
  Write-Host "Windows managed Bridge E2E passed."
} finally {
  try { & $SidecarPath stop --json | Out-Null } catch { }
  if ($null -ne $unmanagedProcess) {
    Stop-Process -Id $unmanagedProcess.Id -Force -ErrorAction SilentlyContinue
  }
  try { Set-Clipboard -Value "" } catch { }
  Get-Job | Stop-Job -ErrorAction SilentlyContinue
  Get-Job | Remove-Job -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
