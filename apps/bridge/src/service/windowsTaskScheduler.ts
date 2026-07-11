import {
  createManagedBridgeService,
  defaultServiceCommandRunner,
  defaultServiceFileSystem,
  powerShellQuote,
  windowsArgument,
  type BridgeServiceAdapter,
  type ServiceAdapterDependencies
} from "./lifecycle.ts";
import type { BridgeServiceManager, ServiceCommandResult, ServiceInstallInput } from "./types.ts";

const WINDOWS_TASK_NAME = "Hunsu Bridge";

export type WindowsTaskSchedulerOptions = ServiceAdapterDependencies & {
  taskName?: string;
  powershellPath?: string;
};

export function createWindowsTaskSchedulerServiceManager(options: WindowsTaskSchedulerOptions): BridgeServiceManager {
  const commandRunner = options.commandRunner ?? defaultServiceCommandRunner;
  const taskName = options.taskName ?? WINDOWS_TASK_NAME;
  const powershellPath = options.powershellPath ?? "powershell.exe";
  let installed = false;

  const runPowerShell = (script: string): Promise<ServiceCommandResult> => commandRunner({
    command: powershellPath,
    args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script]
  });

  const probeTask = async (): Promise<ServiceCommandResult> => runPowerShell([
    "$ErrorActionPreference = 'Stop'",
    `Get-ScheduledTask -TaskName ${powerShellQuote(taskName)} | Select-Object -ExpandProperty State`
  ].join("; "));

  const probeTaskAction = async (): Promise<ServiceCommandResult> => runPowerShell([
    "$ErrorActionPreference = 'Stop'",
    `$Task = Get-ScheduledTask -TaskName ${powerShellQuote(taskName)}`,
    "@{ Execute = $Task.Actions[0].Execute; Arguments = $Task.Actions[0].Arguments; WorkingDirectory = $Task.Actions[0].WorkingDirectory } | ConvertTo-Json -Compress"
  ].join("; "));

  const adapter: BridgeServiceAdapter = {
    manager: "windows-task-scheduler",
    definitionPath: `Task Scheduler: ${taskName}`,
    platform: "win32",
    async install(input) {
      const before = await probeTaskAction();
      const changed = !windowsTaskActionMatches(before, input);
      const result = await runPowerShell(windowsTaskInstallScript(input, taskName));
      requireCommandSuccess(result, "register the current-user scheduled task");
      installed = true;
      return { changed };
    },
    async uninstall() {
      const before = await probeTask();
      const result = await runPowerShell([
        "$ErrorActionPreference = 'Stop'",
        `Unregister-ScheduledTask -TaskName ${powerShellQuote(taskName)} -Confirm:$false`
      ].join("; "));
      if (before.exitCode === 0) {
        requireCommandSuccess(result, "unregister the current-user scheduled task");
      }
      installed = false;
      return { changed: before.exitCode === 0 };
    },
    async start() {
      requireCommandSuccess(await runPowerShell(`Start-ScheduledTask -TaskName ${powerShellQuote(taskName)}`), "start the current-user scheduled task");
    },
    async stopOwned() {
      requireCommandSuccess(await runPowerShell(`Stop-ScheduledTask -TaskName ${powerShellQuote(taskName)}`), "stop the current-user scheduled task");
    },
    async status() {
      const result = await probeTask();
      if (result.exitCode !== 0) {
        return { installed, state: "stopped", detail: "task not registered" };
      }
      installed = true;
      const taskState = result.stdout.trim().toLowerCase();
      return {
        installed: true,
        state: taskState === "running" ? "running" : taskState ? "stopped" : "unknown",
        detail: taskState || undefined
      };
    }
  };

  return createManagedBridgeService(adapter, options);
}

export function windowsTaskInstallScript(input: ServiceInstallInput, taskName = WINDOWS_TASK_NAME): string {
  const actionArguments = windowsTaskActionArguments(input);
  return [
    "$ErrorActionPreference = 'Stop'",
    "$CurrentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name",
    `$Action = New-ScheduledTaskAction -Execute ${powerShellQuote(input.nodePath)} -Argument ${powerShellQuote(actionArguments)} -WorkingDirectory ${powerShellQuote(input.runtimePath)}`,
    "$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $CurrentUser",
    "$Principal = New-ScheduledTaskPrincipal -UserId $CurrentUser -LogonType Interactive -RunLevel Limited",
    "$Settings = New-ScheduledTaskSettingsSet -Hidden -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)",
    `Register-ScheduledTask -TaskName ${powerShellQuote(taskName)} -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings -Description 'Hunsu Bridge current-user daemon' -Force | Out-Null`
  ].join("; ");
}

function windowsTaskActionArguments(input: ServiceInstallInput): string {
  return [
    windowsArgument(input.cliPath),
    "daemon",
    "--home",
    windowsArgument(input.hunsuHome)
  ].join(" ");
}

function windowsTaskActionMatches(result: ServiceCommandResult, input: ServiceInstallInput): boolean {
  if (result.exitCode !== 0) return false;
  try {
    const value = JSON.parse(result.stdout.trim().replace(/^\uFEFF/u, "")) as {
      Execute?: unknown;
      Arguments?: unknown;
      WorkingDirectory?: unknown;
    };
    return typeof value.Execute === "string"
      && value.Execute.toLowerCase() === input.nodePath.toLowerCase()
      && value.Arguments === windowsTaskActionArguments(input)
      && typeof value.WorkingDirectory === "string"
      && value.WorkingDirectory.toLowerCase() === input.runtimePath.toLowerCase();
  } catch (_error) {
    return false;
  }
}

function requireCommandSuccess(result: ServiceCommandResult, action: string): void {
  if (result.exitCode !== 0) {
    throw new Error(`Unable to ${action}.`);
  }
}
