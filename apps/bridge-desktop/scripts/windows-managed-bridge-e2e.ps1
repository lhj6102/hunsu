param(
  [Parameter(Mandatory = $true)]
  [string]$SidecarPath,
  [string]$WorkspaceFixture,
  [int]$BridgePort = 19687
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if (-not (Test-Path -LiteralPath $SidecarPath -PathType Leaf)) {
  throw "Packaged Bridge sidecar was not found: $SidecarPath"
}

$root = Join-Path ([System.IO.Path]::GetTempPath()) ("hunsu-bridge-e2e-" + [guid]::NewGuid().ToString("N"))
$statePath = Join-Path $root "bridge-app.json"
$logPath = Join-Path $root "bridge-app.log"
$browserCapturePath = Join-Path $root "browser-capture.log"
$roadmapRegistryPath = Join-Path $root "roadmaps.json"
New-Item -ItemType Directory -Path $root | Out-Null

$env:HUNSU_BRIDGE_APP_STATE_PATH = $statePath
$env:HUNSU_BRIDGE_APP_LOG_PATH = $logPath
$env:HUNSU_BRIDGE_TEST_MODE = "1"
$env:HUNSU_BRIDGE_TEST_BROWSER_CAPTURE_PATH = $browserCapturePath
$env:HUNSU_ROADMAP_REGISTRY_PATH = $roadmapRegistryPath
$env:HUNSU_BRIDGE_HOST = "127.0.0.1"
$env:HUNSU_BRIDGE_PORT = [string]$BridgePort
$env:HUNSU_BRIDGE_APP_JSON = "1"

function Invoke-BridgeJson {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
  $output = & $SidecarPath @Arguments 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) {
    try {
      return ($output | ConvertFrom-Json)
    } catch {
      throw "Bridge command failed ($LASTEXITCODE): $($Arguments -join ' ')`n$output"
    }
  }
  return ($output | ConvertFrom-Json)
}

function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
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

function Assert-NoUnsafeDiagnostics {
  param([string[]]$Tokens)
  $diagnostics = (& $SidecarPath diagnostics --json 2>&1 | Out-String)
  $log = if (Test-Path -LiteralPath $logPath) { Get-Content -LiteralPath $logPath -Raw } else { "" }
  foreach ($token in $Tokens) {
    Assert-True (-not $diagnostics.Contains($token)) "Raw pairing token appeared in Diagnostics."
    Assert-True (-not $log.Contains($token)) "Raw pairing token appeared in the app log."
  }
}

try {
  # Scenario A: repeated and concurrent ensure-running calls reuse one managed instance.
  $first = Invoke-BridgeJson ensure-running --json
  Assert-True $first.ok "Initial ensure-running failed."
  $connected = Wait-BridgeState connected
  $firstInstance = $connected.localBridgeControl.instanceId
  $firstDaemonPid = [int]$connected.localBridgeControl.daemonPid
  $firstSupervisorPid = [int]$connected.localBridgeControl.supervisorPid
  $firstListenerPid = Get-ListenerPid

  $second = Invoke-BridgeJson ensure-running --json
  Assert-True $second.ok "Repeated ensure-running failed."
  $afterSecond = Wait-BridgeState connected
  Assert-True ($afterSecond.localBridgeControl.instanceId -eq $firstInstance) "ensure-running replaced the managed instance."
  Assert-True ([int]$afterSecond.localBridgeControl.daemonPid -eq $firstDaemonPid) "ensure-running changed the daemon PID."
  Assert-True ((Get-ListenerPid) -eq $firstListenerPid) "ensure-running changed the listener PID."

  $jobs = 1..2 | ForEach-Object {
    Start-Job -ScriptBlock {
      param($Executable)
      & $Executable ensure-running --json | Out-String
    } -ArgumentList $SidecarPath
  }
  $null = $jobs | Wait-Job
  $concurrentOutputs = $jobs | Receive-Job
  $jobs | Remove-Job -Force
  Assert-True ($concurrentOutputs.Count -ge 2) "Concurrent ensure-running commands did not complete."
  Assert-True ((Get-ListenerPid) -eq $firstListenerPid) "Concurrent ensure-running created another listener."

  # Scenario B/F: Pair and Open reuse the daemon, invoke the captured browser, and redact both tokens.
  $pair = Invoke-BridgeJson pair --json
  Assert-True $pair.ok "Pair failed."
  $firstCapture = Get-Content -LiteralPath $browserCapturePath -Tail 1
  $firstUri = [uri]$firstCapture
  $firstToken = Get-UriQueryValue $firstUri "hunsuBridgeToken"
  Assert-True (-not [string]::IsNullOrWhiteSpace($firstToken)) "Captured Pair URL did not contain a synthetic runtime token."
  Assert-True (-not (($pair | ConvertTo-Json -Depth 10).Contains($firstToken))) "Pair command output exposed its pairing token."

  $openWeb = Invoke-BridgeJson pair --json
  Assert-True $openWeb.ok "Open Hunsu Web failed."
  $secondCapture = Get-Content -LiteralPath $browserCapturePath -Tail 1
  $secondUri = [uri]$secondCapture
  $secondToken = Get-UriQueryValue $secondUri "hunsuBridgeToken"
  Assert-True (-not [string]::IsNullOrWhiteSpace($secondToken)) "Second captured URL did not contain a pairing token."
  Assert-True ($secondToken -ne $firstToken) "Pairing did not rotate exactly once per action."
  Assert-True (-not (($openWeb | ConvertTo-Json -Depth 10).Contains($secondToken))) "Open Hunsu Web command output exposed its pairing token."

  if (-not [string]::IsNullOrWhiteSpace($WorkspaceFixture)) {
    $inspect = Invoke-BridgeJson inspect $WorkspaceFixture --json
    $roadmapId = $inspect.project.roadmapId
    if (-not [string]::IsNullOrWhiteSpace($roadmapId)) {
      $opened = Invoke-BridgeJson open-roadmap $roadmapId --json
      Assert-True $opened.ok "Open Workspace failed."
    }
  }
  $afterOpen = Wait-BridgeState connected
  Assert-True ([int]$afterOpen.localBridgeControl.daemonPid -eq $firstDaemonPid) "Pair/Open replaced the daemon."
  Assert-True ([int]$afterOpen.localBridgeControl.supervisorPid -eq $firstSupervisorPid) "Pair/Open created another supervisor."
  Assert-NoUnsafeDiagnostics @($firstToken, $secondToken)
  if (Test-Path -LiteralPath $logPath) {
    Assert-True (-not (Select-String -LiteralPath $logPath -Pattern "EADDRINUSE" -Quiet)) "EADDRINUSE appeared in the managed lifecycle log."
  }

  # Scenario C: authenticated Stop terminates daemon + supervisor and remains stopped past the old restart delay.
  $stopped = Invoke-BridgeJson stop --json
  Assert-True $stopped.ok "Stop failed."
  $null = Wait-BridgeState not-running
  Assert-True ($null -eq (Get-ListenerPid)) "Stop did not release the Bridge port."
  Start-Sleep -Seconds 2
  Assert-True ($null -eq (Get-ListenerPid)) "Supervisor restarted the daemon after Stop."
  Assert-True ($null -eq (Get-Process -Id $firstDaemonPid -ErrorAction SilentlyContinue)) "Daemon process survived Stop."
  Assert-True ($null -eq (Get-Process -Id $firstSupervisorPid -ErrorAction SilentlyContinue)) "Supervisor process survived Stop."

  $restarted = Invoke-BridgeJson ensure-running --json
  Assert-True $restarted.ok "Start after Stop failed."
  $afterRestart = Wait-BridgeState connected
  Assert-True ([int]$afterRestart.localBridgeControl.daemonPid -ne $firstDaemonPid) "Start after Stop did not create a new daemon."
  $null = Invoke-BridgeJson stop --json

  # Scenario D: a Hunsu daemon owned by a different state/control token is classified as unmanaged.
  $unmanagedStatePath = Join-Path $root "unmanaged-owner.json"
  $desktopStatePath = Join-Path $root "unmanaged-desktop.json"
  $env:HUNSU_BRIDGE_APP_STATE_PATH = $unmanagedStatePath
  $unmanagedProcess = Start-Process -FilePath $SidecarPath -ArgumentList @("daemon", "--no-open") -PassThru -WindowStyle Hidden
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  while ($null -eq (Get-ListenerPid) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 200 }
  $env:HUNSU_BRIDGE_APP_STATE_PATH = $desktopStatePath
  $unmanagedSnapshot = Get-BridgeStatus
  Assert-True ($unmanagedSnapshot.localBridgeControl.ownership -eq "unmanaged") "Foreign Hunsu daemon was not classified as unmanaged."
  $unmanagedStart = Invoke-BridgeJson ensure-running --json
  Assert-True ((-not $unmanagedStart.ok) -and $unmanagedStart.code -eq "BRIDGE_ALREADY_RUNNING_UNMANAGED") "Unmanaged Start was not rejected."
  $unmanagedStop = Invoke-BridgeJson stop --json
  Assert-True ((-not $unmanagedStop.ok) -and $unmanagedStop.code -eq "BRIDGE_NOT_OWNED") "Unmanaged Stop was not rejected."
  Assert-True ($null -ne (Get-Process -Id $unmanagedProcess.Id -ErrorAction SilentlyContinue)) "Desktop killed an unmanaged daemon."
  Stop-Process -Id $unmanagedProcess.Id -Force -ErrorAction SilentlyContinue
  Wait-Process -Id $unmanagedProcess.Id -Timeout 5 -ErrorAction SilentlyContinue

  # Scenario E: a non-Hunsu listener is classified as a port conflict without a restart loop.
  $dummy = Start-Job -ScriptBlock {
    param($Port)
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
    $listener.Start()
    try { while ($true) { Start-Sleep -Seconds 1 } } finally { $listener.Stop() }
  } -ArgumentList $BridgePort
  Start-Sleep -Milliseconds 500
  $conflict = Invoke-BridgeJson ensure-running --json
  Assert-True ((-not $conflict.ok) -and $conflict.code -eq "BRIDGE_PORT_IN_USE") "Non-Hunsu listener did not return BRIDGE_PORT_IN_USE."
  Start-Sleep -Seconds 2
  Assert-True ($dummy.State -eq "Running") "Bridge disturbed the unrelated listener."
  Stop-Job $dummy
  Remove-Job $dummy -Force

  Write-Host "Windows managed Bridge E2E passed."
} finally {
  try { & $SidecarPath stop --json | Out-Null } catch { }
  Get-Job | Stop-Job -ErrorAction SilentlyContinue
  Get-Job | Remove-Job -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
