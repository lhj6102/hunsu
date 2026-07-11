[CmdletBinding()]
param(
  [switch]$Apply
)

$ErrorActionPreference = "Stop"
$taskName = "Hunsu Bridge"
$startupScript = [System.IO.Path]::GetFullPath(
  (Join-Path $env:APPDATA "Hunsu\Bridge\hunsu-bridge-startup.cmd")
)
$installRoots = @(
  [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "Hunsu Bridge")),
  [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "Programs\Hunsu Bridge"))
)
$prototypeExecutables = @(
  foreach ($root in $installRoots) {
    [System.IO.Path]::GetFullPath((Join-Path $root "Hunsu Bridge.exe"))
    [System.IO.Path]::GetFullPath((Join-Path $root "hunsu-bridge.exe"))
    [System.IO.Path]::GetFullPath((Join-Path $root "hunsu-bridge-sidecar.exe"))
  }
)

function Write-Plan {
  param([string]$Message)
  if ($Apply) {
    Write-Host $Message
  } else {
    Write-Host "[dry-run] $Message"
  }
}

function Test-SamePath {
  param([string]$Left, [string]$Right)
  if ([string]::IsNullOrWhiteSpace($Left) -or [string]::IsNullOrWhiteSpace($Right)) {
    return $false
  }
  try {
    return [System.IO.Path]::GetFullPath($Left).Equals(
      [System.IO.Path]::GetFullPath($Right),
      [System.StringComparison]::OrdinalIgnoreCase
    )
  } catch {
    return $false
  }
}

function Stop-ExactExecutable {
  param([string]$ExecutablePath)
  if (-not (Test-Path -LiteralPath $ExecutablePath -PathType Leaf)) {
    return
  }
  $resolvedTarget = [System.IO.Path]::GetFullPath(
    (Resolve-Path -LiteralPath $ExecutablePath).Path
  )
  $matches = Get-CimInstance Win32_Process |
    Where-Object { Test-SamePath $_.ExecutablePath $resolvedTarget }
  foreach ($match in $matches) {
    $fresh = Get-CimInstance Win32_Process -Filter "ProcessId = $($match.ProcessId)" -ErrorAction SilentlyContinue
    if ($null -eq $fresh -or -not (Test-SamePath $fresh.ExecutablePath $resolvedTarget)) {
      continue
    }
    Write-Plan "Stop exact prototype executable $resolvedTarget (PID $($fresh.ProcessId))"
    if ($Apply) {
      Stop-Process -Id $fresh.ProcessId -ErrorAction Stop
    }
  }
}

$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($null -ne $task) {
  $verifiedTask = @($task.Actions).Where({
    Test-SamePath $_.Execute $startupScript
  }).Count -gt 0
  if ($verifiedTask) {
    Write-Plan "Stop and unregister verified scheduled task '$taskName' with action $startupScript"
    if ($Apply) {
      Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    }
  } else {
    Write-Warning "Skipped scheduled task '$taskName': its action is not the exact prototype startup path."
  }
}

foreach ($executable in $prototypeExecutables) {
  Stop-ExactExecutable -ExecutablePath $executable
}

$commandKey = "HKCU:\Software\Classes\hunsu\shell\open\command"
$protocolRoot = "HKCU:\Software\Classes\hunsu"
if (Test-Path -LiteralPath $commandKey) {
  $registeredCommand = (Get-Item -LiteralPath $commandKey).GetValue("")
  $verifiedProtocol = @($prototypeExecutables).Where({
    -not [string]::IsNullOrWhiteSpace($registeredCommand) -and
    $registeredCommand.IndexOf($_, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
  }).Count -gt 0
  if ($verifiedProtocol) {
    Write-Plan "Remove verified prototype protocol registration at $protocolRoot"
    if ($Apply) {
      Remove-Item -LiteralPath $protocolRoot -Recurse -Force
    }
  } else {
    Write-Warning "Skipped protocol registration: its command is not an exact known prototype executable."
  }
}

foreach ($root in $installRoots) {
  $uninstaller = Join-Path $root "uninstall.exe"
  if (Test-Path -LiteralPath $uninstaller -PathType Leaf) {
    Write-Plan "Run exact prototype uninstaller $uninstaller"
    if ($Apply) {
      $process = Start-Process -FilePath $uninstaller -ArgumentList "/S" -Wait -PassThru
      if ($process.ExitCode -ne 0) {
        throw "Prototype uninstaller failed with exit code $($process.ExitCode)."
      }
    }
  }
}

if (Test-Path -LiteralPath $startupScript -PathType Leaf) {
  Write-Plan "Remove exact prototype startup script $startupScript"
  if ($Apply) {
    Remove-Item -LiteralPath $startupScript -Force
  }
}

Write-Host "Workspace, configuration, credential, runtime-state, and log directories were not read or removed."
if (-not $Apply) {
  Write-Host "Dry run only. Re-run with -Apply after reviewing the exact targets above."
}
