import {
  createDefaultServiceCommandRunner,
  createManagedBridgeService,
  defaultServiceFileSystem,
  powerShellQuote,
  windowsArgument,
  type BridgeServiceAdapter,
  type ServiceAdapterDependencies
} from "./lifecycle.ts";
import type { BridgeServiceManager, ServiceCommandResult, ServiceInstallInput } from "./types.ts";

const WINDOWS_TASK_NAME = "Hunsu Bridge";
const WINDOWS_TASK_NOT_FOUND_MARKER = "__HUNSU_TASK_NOT_FOUND__";
const WINDOWS_TASK_STOPPED_STATES = new Set(["ready", "disabled"]);

type WindowsTaskProbe =
  | { kind: "missing" }
  | { kind: "state"; state: string }
  | { kind: "unavailable" };

export type WindowsTaskSchedulerOptions = ServiceAdapterDependencies & {
  taskName?: string;
  powershellPath?: string;
  processEnv?: Readonly<Record<string, string | undefined>>;
};

export function createWindowsTaskSchedulerServiceManager(options: WindowsTaskSchedulerOptions): BridgeServiceManager {
  const commandRunner = options.commandRunner ?? createDefaultServiceCommandRunner(options.processEnv ?? {});
  const taskName = options.taskName ?? WINDOWS_TASK_NAME;
  const powershellPath = options.powershellPath ?? "powershell.exe";
  let installed = false;

  const runPowerShell = (script: string): Promise<ServiceCommandResult> => commandRunner({
    command: powershellPath,
    args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script]
  });

  const probeTask = async (): Promise<ServiceCommandResult> => runPowerShell([
    "$ErrorActionPreference = 'Stop'",
    `$Task = @(Get-ScheduledTask | Where-Object { $_.TaskName -eq ${powerShellQuote(taskName)} })`,
    `if ($Task.Count -eq 0) { Write-Output ${powerShellQuote(WINDOWS_TASK_NOT_FOUND_MARKER)}; exit 0 }`,
    "if ($Task.Count -ne 1) { throw 'Expected exactly one Hunsu Bridge scheduled task.' }",
    "$Task[0] | Select-Object -ExpandProperty State"
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
      const task = windowsTaskProbe(before);
      if (task.kind === "unavailable") {
        throw new Error("Unable to verify the current-user scheduled task before unregistering it.");
      }
      if (task.kind === "missing") {
        installed = false;
        return { changed: false };
      }
      if (!WINDOWS_TASK_STOPPED_STATES.has(task.state)) {
        throw new Error("The current-user scheduled task is not definitively stopped.");
      }
      const result = await runPowerShell([
        "$ErrorActionPreference = 'Stop'",
        `Unregister-ScheduledTask -TaskName ${powerShellQuote(taskName)} -Confirm:$false`
      ].join("; "));
      requireCommandSuccess(result, "unregister the current-user scheduled task");
      installed = false;
      return { changed: true };
    },
    async start() {
      requireCommandSuccess(await runPowerShell(`Start-ScheduledTask -TaskName ${powerShellQuote(taskName)}`), "start the current-user scheduled task");
    },
    async stopOwned() {
      requireCommandSuccess(await runPowerShell(`Stop-ScheduledTask -TaskName ${powerShellQuote(taskName)}`), "stop the current-user scheduled task");
    },
    async status() {
      const task = windowsTaskProbe(await probeTask());
      if (task.kind === "missing") {
        installed = false;
        return { installed: false, state: "stopped", detail: "task not registered" };
      }
      if (task.kind === "unavailable") {
        return { installed: true, state: "unknown", detail: "scheduled task status unavailable" };
      }
      installed = true;
      return {
        installed: true,
        state: task.state === "running"
          ? "running"
          : WINDOWS_TASK_STOPPED_STATES.has(task.state) ? "stopped" : "unknown",
        detail: task.state
      };
    }
  };

  return createManagedBridgeService(adapter, options);
}

function windowsTaskProbe(result: ServiceCommandResult): WindowsTaskProbe {
  if (result.exitCode !== 0) return { kind: "unavailable" };
  const output = result.stdout.trim().replace(/^\uFEFF/u, "");
  if (output === WINDOWS_TASK_NOT_FOUND_MARKER) return { kind: "missing" };
  if (!output || output.includes("\n") || output.includes("\r")) return { kind: "unavailable" };
  return { kind: "state", state: output.toLowerCase() };
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
    "--runtime-path",
    windowsArgument(input.runtimePath),
    "--home",
    windowsArgument(input.hunsuHome),
    "--profile",
    input.deploymentProfile
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
