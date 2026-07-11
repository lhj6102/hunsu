param(
  [Parameter(Mandatory = $true)]
  [string]$InstallDirectory,
  [ValidateRange(1, 60)]
  [int]$GracefulTimeoutSeconds = 8,
  [ValidateRange(1, 60)]
  [int]$ProcessExitTimeoutSeconds = 5,
  [ValidateRange(1, 60)]
  [int]$UnlockTimeoutSeconds = 5
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ExitStopped = 0
$ExitGracefulStopTimedOut = 10
$ExitProcessEnumerationFailed = 11
$ExitVerifiedTreeTerminationFailed = 12
$ExitInstalledExecutableLocked = 13
$ExitInvalidInstallDirectory = 14
$BridgePort = 19687
$CimOperationTimeoutSeconds = 3
$AllowedExecutableNames = @(
  "Hunsu Bridge.exe",
  "hunsu-bridge.exe",
  "hunsu-bridge-sidecar.exe"
)

function Write-SafeDiagnostic {
  param([string]$Message)
  # Write directly to redirected stdout without adding a value to the
  # PowerShell success pipeline. Boolean helper return values must stay scalar.
  [System.Console]::Out.WriteLine("hunsu-installer: " + $Message)
}

function Exit-WithCode {
  param([int]$Code, [string]$Diagnostic)
  Write-SafeDiagnostic $Diagnostic
  exit $Code
}

function Get-NormalizedPath {
  param([Parameter(Mandatory = $true)][string]$Path)

  $fullPath = [System.IO.Path]::GetFullPath($Path)
  $root = [System.IO.Path]::GetPathRoot($fullPath)
  if ([string]::Equals($fullPath, $root, [System.StringComparison]::OrdinalIgnoreCase)) {
    return $fullPath
  }
  return $fullPath.TrimEnd([char[]]@(
    [System.IO.Path]::DirectorySeparatorChar,
    [System.IO.Path]::AltDirectorySeparatorChar
  ))
}

function Test-IsAllowedExecutablePath {
  param([string]$ExecutablePath)

  if ([string]::IsNullOrWhiteSpace($ExecutablePath)) { return $false }
  try {
    $normalizedExecutablePath = Get-NormalizedPath $ExecutablePath
  } catch {
    return $false
  }
  foreach ($allowedPath in $script:AllowedExecutablePaths) {
    if ([string]::Equals(
      $normalizedExecutablePath,
      $allowedPath,
      [System.StringComparison]::OrdinalIgnoreCase
    )) {
      return $true
    }
  }
  return $false
}

function Get-InstalledProcessSnapshot {
  try {
    $allProcesses = @(Get-CimInstance -ClassName "Win32_Process" -OperationTimeoutSec $CimOperationTimeoutSeconds -ErrorAction Stop)
  } catch {
    Exit-WithCode $ExitProcessEnumerationFailed (
      "process enumeration failed (" + $_.Exception.GetType().Name + ")"
    )
  }

  return @($allProcesses |
    Where-Object { Test-IsAllowedExecutablePath ([string]$_.ExecutablePath) } |
    ForEach-Object {
      [pscustomobject]@{
        ProcessId = [int]$_.ProcessId
        ParentProcessId = [int]$_.ParentProcessId
        ExecutablePath = [string]$_.ExecutablePath
        CommandLine = [string]$_.CommandLine
        CreationDate = [string]$_.CreationDate
      }
    })
}

function Invoke-HiddenProcess {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string]$Arguments,
    [Parameter(Mandatory = $true)][int]$TimeoutMilliseconds
  )

  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $process.StartInfo.FileName = $FilePath
  $process.StartInfo.Arguments = $Arguments
  $process.StartInfo.UseShellExecute = $false
  $process.StartInfo.CreateNoWindow = $true
  $process.StartInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  $process.StartInfo.RedirectStandardOutput = $true
  $process.StartInfo.RedirectStandardError = $true

  try {
    $started = $process.Start()
  } catch {
    $process.Dispose()
    return [pscustomobject]@{
      Started = $false
      TimedOut = $false
      ExitCode = $null
      StdoutCharacters = 0
      StderrCharacters = 0
      FailureType = $_.Exception.GetType().Name
    }
  }
  if (-not $started) {
    $process.Dispose()
    return [pscustomobject]@{
      Started = $false
      TimedOut = $false
      ExitCode = $null
      StdoutCharacters = 0
      StderrCharacters = 0
      FailureType = "ProcessStartReturnedFalse"
    }
  }

  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  $timedOut = -not $process.WaitForExit($TimeoutMilliseconds)
  if ($timedOut) {
    try { $process.Kill() } catch { }
    try { $null = $process.WaitForExit(1000) } catch { }
  }

  $stdout = ""
  $stderr = ""
  if ($stdoutTask.IsCompleted -and -not $stdoutTask.IsFaulted) {
    try { $stdout = [string]$stdoutTask.Result } catch { }
  }
  if ($stderrTask.IsCompleted -and -not $stderrTask.IsFaulted) {
    try { $stderr = [string]$stderrTask.Result } catch { }
  }
  $exitCode = $null
  try {
    if ($process.HasExited) { $exitCode = [int]$process.ExitCode }
  } catch { }
  $process.Dispose()

  return [pscustomobject]@{
    Started = $true
    TimedOut = $timedOut
    ExitCode = $exitCode
    StdoutCharacters = $stdout.Length
    StderrCharacters = $stderr.Length
    FailureType = $null
  }
}

function Wait-ForInstalledProcessesToExit {
  param([int]$TimeoutMilliseconds)

  $timer = [System.Diagnostics.Stopwatch]::StartNew()
  do {
    if (@(Get-InstalledProcessSnapshot).Count -eq 0) { return $true }
    if ($timer.ElapsedMilliseconds -ge $TimeoutMilliseconds) { break }
    Start-Sleep -Milliseconds 100
  } while ($true)
  return (@(Get-InstalledProcessSnapshot).Count -eq 0)
}

function Get-VerifiedCurrentProcess {
  param([Parameter(Mandatory = $true)][object]$Expected)

  try {
    $current = @(Get-CimInstance -ClassName "Win32_Process" -Filter ("ProcessId = " + [string]$Expected.ProcessId) -OperationTimeoutSec $CimOperationTimeoutSeconds -ErrorAction Stop)
  } catch {
    Exit-WithCode $ExitProcessEnumerationFailed (
      "process identity recheck failed (" + $_.Exception.GetType().Name + ")"
    )
  }
  if ($current.Count -eq 0) { return $null }
  $candidate = $current[0]
  if (-not (Test-IsAllowedExecutablePath ([string]$candidate.ExecutablePath))) { return $null }
  if ([string]::IsNullOrWhiteSpace([string]$Expected.CreationDate) -or
      -not [string]::Equals(
        [string]$candidate.CreationDate,
        [string]$Expected.CreationDate,
        [System.StringComparison]::Ordinal
      ) -or
      [int]$candidate.ParentProcessId -ne [int]$Expected.ParentProcessId -or
      -not [string]::Equals(
        [string]$candidate.CommandLine,
        [string]$Expected.CommandLine,
        [System.StringComparison]::Ordinal
      )) {
    return $null
  }
  return $candidate
}

function Get-VerifiedTerminationOrder {
  param([Parameter(Mandatory = $true)][object[]]$Processes)

  $matchedById = @{}
  foreach ($processRecord in $Processes) {
    $matchedById[[int]$processRecord.ProcessId] = $processRecord
  }

  $ranked = @(foreach ($processRecord in $Processes) {
    $depth = 0
    $current = $processRecord
    $seenIds = @{}
    while ($matchedById.ContainsKey([int]$current.ParentProcessId)) {
      $currentId = [int]$current.ProcessId
      if ($seenIds.ContainsKey($currentId)) { break }
      $seenIds[$currentId] = $true
      $depth += 1
      $current = $matchedById[[int]$current.ParentProcessId]
    }
    [pscustomobject]@{ Process = $processRecord; Depth = $depth }
  })
  $sortProperties = @(
    @{ Expression = { $_.Depth }; Descending = $true },
    @{ Expression = { $_.Process.ProcessId }; Descending = $true }
  )
  return @($ranked |
    Sort-Object -Property $sortProperties |
    ForEach-Object { $_.Process })
}

function Stop-VerifiedInstalledProcesses {
  param([int]$TimeoutMilliseconds)

  $taskkillPath = Join-Path $env:SystemRoot "System32\taskkill.exe"
  $timer = [System.Diagnostics.Stopwatch]::StartNew()
  do {
    $remaining = @(Get-InstalledProcessSnapshot)
    if ($remaining.Count -eq 0) { return $true }

    # Kill only exact-path matched PIDs, children first. Do not use taskkill /T:
    # an otherwise unrelated child process must never inherit authorization
    # merely because its parent executable belongs to this installation.
    foreach ($candidateProcess in @(Get-VerifiedTerminationOrder $remaining)) {
      $millisecondsLeft = $TimeoutMilliseconds - [int]$timer.ElapsedMilliseconds
      if ($millisecondsLeft -le 0) { break }
      $verified = Get-VerifiedCurrentProcess $candidateProcess
      if ($null -eq $verified) {
        Write-SafeDiagnostic (
          "skipped stale process identity pid=" + [string]$candidateProcess.ProcessId
        )
        continue
      }

      # The PID passed to taskkill has just been revalidated by exact normalized
      # executable path plus creation, parent, and command-line identity.
      $millisecondsLeft = $TimeoutMilliseconds - [int]$timer.ElapsedMilliseconds
      if ($millisecondsLeft -le 0) { break }
      $taskkillTimeout = [Math]::Min(3000, $millisecondsLeft)
      $taskkillOptions = @{
        FilePath = $taskkillPath
        Arguments = "/PID " + [string]$candidateProcess.ProcessId + " /F"
        TimeoutMilliseconds = $taskkillTimeout
      }
      $taskkill = Invoke-HiddenProcess @taskkillOptions
      $taskkillExit = "unavailable"
      if ($null -ne $taskkill.ExitCode) { $taskkillExit = [string]$taskkill.ExitCode }
      Write-SafeDiagnostic (
        "verified taskkill pid=" + [string]$candidateProcess.ProcessId +
        " exitCode=" + $taskkillExit +
        " timedOut=" + [string]$taskkill.TimedOut
      )
    }

    if ($timer.ElapsedMilliseconds -ge $TimeoutMilliseconds) { break }
    Start-Sleep -Milliseconds 100
  } while ($true)

  return (@(Get-InstalledProcessSnapshot).Count -eq 0)
}

function Test-BridgePortHasInstalledOwner {
  try {
    $connectionQuery = @{
      Namespace = "root/StandardCimv2"
      ClassName = "MSFT_NetTCPConnection"
      Filter = "LocalPort = " + [string]$BridgePort + " AND State = 2"
      OperationTimeoutSec = $CimOperationTimeoutSeconds
      ErrorAction = "Stop"
    }
    $listeners = @(Get-CimInstance @connectionQuery |
      Where-Object { $_.LocalAddress -in @("127.0.0.1", "0.0.0.0", "::1", "::") })
    if ($listeners.Count -eq 0) { return $false }
    $allProcesses = @(Get-CimInstance -ClassName "Win32_Process" -OperationTimeoutSec $CimOperationTimeoutSeconds -ErrorAction Stop)
  } catch {
    Write-SafeDiagnostic (
      "bounded port ownership check unavailable (" + $_.Exception.GetType().Name +
      "); file ownership checks remain authoritative"
    )
    return $false
  }
  $processesById = @{}
  foreach ($processRecord in $allProcesses) {
    $processesById[[int]$processRecord.ProcessId] = $processRecord
  }
  foreach ($listener in $listeners) {
    $ownerProcessId = [int]$listener.OwningProcess
    if (-not $processesById.ContainsKey($ownerProcessId)) {
      Write-SafeDiagnostic (
        "listener pid=" + [string]$ownerProcessId + " could not be classified; it was not terminated"
      )
      continue
    }
    $owner = $processesById[$ownerProcessId]
    if (Test-IsAllowedExecutablePath ([string]$owner.ExecutablePath)) {
      Write-SafeDiagnostic (
        "listener pid=" + [string]$ownerProcessId + " still belongs to this installation"
      )
      return $true
    }
    Write-SafeDiagnostic (
      "unrelated listener pid=" + [string]$ownerProcessId +
      " remains on port 19687; it was not terminated (the app may report BRIDGE_PORT_IN_USE)"
    )
  }
  return $false
}

function Test-InstalledExecutablesUnlocked {
  param([int]$TimeoutMilliseconds)

  $timer = [System.Diagnostics.Stopwatch]::StartNew()
  do {
    $lockedNames = @()
    foreach ($executableName in $AllowedExecutableNames) {
      $path = Join-Path $script:NormalizedInstallDirectory $executableName
      if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
      $stream = $null
      try {
        $stream = [System.IO.File]::Open(
          $path,
          [System.IO.FileMode]::Open,
          [System.IO.FileAccess]::ReadWrite,
          [System.IO.FileShare]::None
        )
      } catch {
        $lockedNames += $executableName
      } finally {
        if ($null -ne $stream) { $stream.Dispose() }
      }
    }
    if ($lockedNames.Count -eq 0) { return $true }
    if ($timer.ElapsedMilliseconds -ge $TimeoutMilliseconds) {
      Write-SafeDiagnostic ("exclusive open failed for " + ($lockedNames -join ", "))
      return $false
    }
    Start-Sleep -Milliseconds 100
  } while ($true)
}

try {
  if ([string]::IsNullOrWhiteSpace($InstallDirectory) -or
      -not [System.IO.Path]::IsPathRooted($InstallDirectory)) {
    Exit-WithCode $ExitInvalidInstallDirectory "install directory must be an absolute path"
  }
  $argumentRoot = [System.IO.Path]::GetPathRoot($InstallDirectory)
  $hasQualifiedDriveRoot = $argumentRoot -match "^[a-zA-Z]:[\\/]$"
  $hasQualifiedUncRoot = $argumentRoot.StartsWith("\\")
  if (-not $hasQualifiedDriveRoot -and -not $hasQualifiedUncRoot) {
    Exit-WithCode $ExitInvalidInstallDirectory "install directory must be fully qualified"
  }
  $script:NormalizedInstallDirectory = Get-NormalizedPath $InstallDirectory
  $installRoot = [System.IO.Path]::GetPathRoot($script:NormalizedInstallDirectory)
  if ([string]::Equals(
    $script:NormalizedInstallDirectory,
    $installRoot,
    [System.StringComparison]::OrdinalIgnoreCase
  )) {
    Exit-WithCode $ExitInvalidInstallDirectory "install directory cannot be a filesystem root"
  }
} catch {
  Exit-WithCode $ExitInvalidInstallDirectory (
    "install directory could not be normalized (" + $_.Exception.GetType().Name + ")"
  )
}

$script:AllowedExecutablePaths = @($AllowedExecutableNames | ForEach-Object {
  Get-NormalizedPath (Join-Path $script:NormalizedInstallDirectory $_)
})

if (-not (Test-Path -LiteralPath $script:NormalizedInstallDirectory)) {
  Exit-WithCode $ExitStopped "target install directory does not exist; no shutdown needed"
}
if (-not (Test-Path -LiteralPath $script:NormalizedInstallDirectory -PathType Container)) {
  Exit-WithCode $ExitInvalidInstallDirectory "install directory path is not a directory"
}

$gracefulStopTimedOut = $false
$installedSidecarPath = Join-Path $script:NormalizedInstallDirectory "hunsu-bridge-sidecar.exe"
if (Test-Path -LiteralPath $installedSidecarPath -PathType Leaf) {
  $gracefulOptions = @{
    FilePath = $installedSidecarPath
    Arguments = "stop --json"
    TimeoutMilliseconds = $GracefulTimeoutSeconds * 1000
  }
  $graceful = Invoke-HiddenProcess @gracefulOptions
  if (-not $graceful.Started) {
    Write-SafeDiagnostic (
      "graceful stop could not start (" + [string]$graceful.FailureType + "); checking verified fallback"
    )
  } elseif ($graceful.TimedOut) {
    $gracefulStopTimedOut = $true
    Write-SafeDiagnostic (
      "graceful stop timed out; captured stdoutCharacters=" +
      [string]$graceful.StdoutCharacters + " stderrCharacters=" +
      [string]$graceful.StderrCharacters + "; checking verified fallback"
    )
  } else {
    $gracefulExit = "unavailable"
    if ($null -ne $graceful.ExitCode) { $gracefulExit = [string]$graceful.ExitCode }
    Write-SafeDiagnostic (
      "graceful stop exitCode=" + $gracefulExit +
      " stdoutCharacters=" + [string]$graceful.StdoutCharacters +
      " stderrCharacters=" + [string]$graceful.StderrCharacters
    )
  }
}

$null = Wait-ForInstalledProcessesToExit 1500
if (-not (Stop-VerifiedInstalledProcesses ($ProcessExitTimeoutSeconds * 1000))) {
  Exit-WithCode $ExitVerifiedTreeTerminationFailed (
    "verified processes under the target install directory did not exit"
  )
}
if (Test-BridgePortHasInstalledOwner) {
  Exit-WithCode $ExitVerifiedTreeTerminationFailed (
    "a verified target-installation process still owns the Bridge listener"
  )
}
if (-not (Test-InstalledExecutablesUnlocked ($UnlockTimeoutSeconds * 1000))) {
  Exit-WithCode $ExitInstalledExecutableLocked "an installed executable remained locked"
}
if (@(Get-InstalledProcessSnapshot).Count -ne 0) {
  Exit-WithCode $ExitVerifiedTreeTerminationFailed (
    "a target-installation process appeared again after the unlock check"
  )
}

if ($gracefulStopTimedOut) {
  Exit-WithCode $ExitGracefulStopTimedOut (
    "graceful stop timed out, but verified fallback stopped the installation safely"
  )
}
Exit-WithCode $ExitStopped "existing installation is stopped and executable locks are clear"
