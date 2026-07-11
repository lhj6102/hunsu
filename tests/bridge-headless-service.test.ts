import assert from "node:assert/strict";
import test from "node:test";
import { createLinuxSystemdUserServiceManager } from "../apps/bridge/src/service/linuxSystemdUser.ts";
import { createMacosLaunchAgentServiceManager, macosLaunchAgentPlist } from "../apps/bridge/src/service/macosLaunchAgent.ts";
import { createBridgeServiceManager } from "../apps/bridge/src/service/serviceManager.ts";
import { createWindowsTaskSchedulerServiceManager, windowsTaskInstallScript } from "../apps/bridge/src/service/windowsTaskScheduler.ts";
import type {
  ServiceCommand,
  ServiceCommandResult,
  ServiceFileSystem,
  ServiceInstallInput
} from "../apps/bridge/src/service/types.ts";

const linuxInstall: ServiceInstallInput = {
  nodePath: "/opt/Hunsu 100%/node",
  cliPath: "/opt/Hunsu 100%/runtime/hunsu-bridge.js",
  hunsuHome: "/home/test/Hunsu \"safe\" 100%",
  packageVersion: "0.2.0-next.0",
  runtimePath: "/opt/Hunsu 100%/runtime"
};

test("Linux service install writes a safely escaped direct-daemon unit and never starts it", async () => {
  const files = memoryFileSystem();
  const commands: ServiceCommand[] = [];
  const manager = createLinuxSystemdUserServiceManager({
    unitPath: "/home/test/.config/systemd/user/hunsu-bridge.service",
    fileSystem: files,
    commandRunner: successfulRunner(commands),
    requestAuthenticatedShutdown: async () => true,
    probeHealth: async () => false
  });

  const result = await manager.install(linuxInstall);
  assert.equal(result.ok, true);
  const unit = await files.readText("/home/test/.config/systemd/user/hunsu-bridge.service") ?? "";
  assert.match(unit, /^ExecStart="\/opt\/Hunsu 100%%\/node" "\/opt\/Hunsu 100%%\/runtime\/hunsu-bridge\.js" "daemon"$/mu);
  assert.match(unit, /^Environment="HUNSU_HOME=\/home\/test\/Hunsu \\"safe\\" 100%%"$/mu);
  assert.match(unit, /^Restart=on-failure$/mu);
  assert.deepEqual(commands, [
    { command: "systemctl", args: ["--user", "daemon-reload"] },
    { command: "systemctl", args: ["--user", "enable", "hunsu-bridge.service"] }
  ]);
  assert.equal(commands.some(command => command.args.includes("start") || command.args.includes("--now")), false);
});

test("service stop uses authenticated shutdown first and falls back only to the owned systemd unit", async () => {
  const files = memoryFileSystem({
    "/home/test/.config/systemd/user/hunsu-bridge.service": "installed"
  });
  const gracefulEvents: string[] = [];
  let healthChecks = 0;
  const graceful = createLinuxSystemdUserServiceManager({
    unitPath: "/home/test/.config/systemd/user/hunsu-bridge.service",
    fileSystem: files,
    commandRunner: async command => {
      gracefulEvents.push(`${command.command} ${command.args.join(" ")}`);
      return okCommand();
    },
    requestAuthenticatedShutdown: async () => {
      gracefulEvents.push("shutdown");
      return true;
    },
    probeHealth: async () => {
      gracefulEvents.push("health");
      healthChecks += 1;
      return healthChecks < 2;
    },
    sleep: async () => undefined,
    stopTimeoutMs: 10,
    pollIntervalMs: 5
  });
  assert.equal((await graceful.stop()).ok, true);
  assert.deepEqual(gracefulEvents, ["shutdown", "health", "health"]);

  const fallbackCommands: ServiceCommand[] = [];
  const fallback = createLinuxSystemdUserServiceManager({
    unitPath: "/home/test/.config/systemd/user/hunsu-bridge.service",
    fileSystem: files,
    commandRunner: successfulRunner(fallbackCommands),
    requestAuthenticatedShutdown: async () => false,
    probeHealth: async () => false,
    sleep: async () => undefined
  });
  assert.equal((await fallback.stop()).ok, true);
  assert.deepEqual(fallbackCommands, [{ command: "systemctl", args: ["--user", "stop", "hunsu-bridge.service"] }]);
  assert.equal(JSON.stringify(fallbackCommands).match(/kill|pkill|pid|port/iu), null);
});

test("offline service status combines manager, health, authentication, version, and runtime path", async () => {
  const files = memoryFileSystem({
    "/home/test/.config/systemd/user/hunsu-bridge.service": "installed"
  });
  const manager = createLinuxSystemdUserServiceManager({
    unitPath: "/home/test/.config/systemd/user/hunsu-bridge.service",
    fileSystem: files,
    commandRunner: async () => ({ exitCode: 3, stdout: "inactive\n", stderr: "" }),
    requestAuthenticatedShutdown: async () => false,
    probeHealth: async () => false,
    probeAuthenticatedStatus: async () => ({ state: "authenticated" }),
    readInstalledRuntime: async () => ({
      packageVersion: "0.2.0-next.0",
      runtimePath: "/home/test/.local/share/hunsu/bridge/runtime/versions/0.2.0-next.0"
    })
  });
  assert.deepEqual(await manager.status(), {
    installed: true,
    manager: "systemd-user",
    managerState: "stopped",
    health: "offline",
    authentication: "unavailable",
    definitionPath: "/home/test/.config/systemd/user/hunsu-bridge.service",
    packageVersion: "0.2.0-next.0",
    runtimePath: "/home/test/.local/share/hunsu/bridge/runtime/versions/0.2.0-next.0",
    detail: "inactive"
  });
});

test("online service status reports authenticated-control availability without exposing its payload", async () => {
  const manager = createLinuxSystemdUserServiceManager({
    unitPath: "/home/test/.config/systemd/user/hunsu-bridge.service",
    fileSystem: memoryFileSystem({
      "/home/test/.config/systemd/user/hunsu-bridge.service": "installed"
    }),
    commandRunner: async () => ({ exitCode: 0, stdout: "active\n", stderr: "" }),
    requestAuthenticatedShutdown: async () => true,
    probeHealth: async () => true,
    probeAuthenticatedStatus: async () => ({
      state: "authenticated",
      value: { instanceId: "safe-instance", controlToken: "must-not-be-copied" }
    })
  });
  const status = await manager.status();
  assert.equal(status.health, "healthy");
  assert.equal(status.authentication, "authenticated");
  assert.doesNotMatch(JSON.stringify(status), /safe-instance|must-not-be-copied/u);
});

test("macOS LaunchAgent is a direct daemon with RunAtLoad, crash-only KeepAlive, escaped paths, and logs", async () => {
  const input: ServiceInstallInput = {
    nodePath: "/Applications/Hunsu & Node/node",
    cliPath: "/Users/test/Hunsu <next>/cli.js",
    hunsuHome: "/Users/test/Library/Application Support/Hunsu & Bridge",
    packageVersion: "0.2.0-next.0",
    runtimePath: "/Users/test/Hunsu/runtime"
  };
  const plist = macosLaunchAgentPlist(input);
  assert.match(plist, /<string>\/Applications\/Hunsu &amp; Node\/node<\/string>/u);
  assert.match(plist, /<string>\/Users\/test\/Hunsu &lt;next&gt;\/cli\.js<\/string>/u);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/u);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/u);
  assert.match(plist, /bridge\.stdout\.log/u);
  assert.match(plist, /bridge\.stderr\.log/u);

  const files = memoryFileSystem();
  const commands: ServiceCommand[] = [];
  const manager = createMacosLaunchAgentServiceManager({
    uid: 501,
    plistPath: "/Users/test/Library/LaunchAgents/app.hunsu.bridge.plist",
    fileSystem: files,
    commandRunner: async command => {
      commands.push(command);
      return command.args[0] === "print"
        ? { exitCode: 113, stdout: "", stderr: "Could not find service" }
        : okCommand();
    },
    requestAuthenticatedShutdown: async () => false,
    probeHealth: async () => false
  });
  assert.equal((await manager.install(input)).ok, true);
  assert.deepEqual(commands, [
    { command: "launchctl", args: ["print", "gui/501/app.hunsu.bridge"] }
  ]);
  assert.equal((await manager.start()).ok, true);
  assert.deepEqual(commands, [
    { command: "launchctl", args: ["print", "gui/501/app.hunsu.bridge"] },
    { command: "launchctl", args: ["print", "gui/501/app.hunsu.bridge"] },
    { command: "launchctl", args: ["print", "gui/501/app.hunsu.bridge"] },
    { command: "launchctl", args: ["bootstrap", "gui/501", "/Users/test/Library/LaunchAgents/app.hunsu.bridge.plist"] }
  ]);
});

test("macOS reloads a changed cached LaunchAgent definition before starting the new stable CLI", async () => {
  const plistPath = "/Users/test/Library/LaunchAgents/app.hunsu.bridge.plist";
  const files = memoryFileSystem({ [plistPath]: "old definition" });
  const commands: ServiceCommand[] = [];
  const manager = createMacosLaunchAgentServiceManager({
    uid: 501,
    plistPath,
    fileSystem: files,
    commandRunner: successfulRunner(commands),
    requestAuthenticatedShutdown: async () => false,
    probeHealth: async () => false
  });

  const result = await manager.install({
    nodePath: "/opt/node/bin/node",
    cliPath: "/Users/test/.hunsu/runtime/versions/0.2.0-next.0/dist/cli.js",
    hunsuHome: "/Users/test/.hunsu",
    packageVersion: "0.2.0-next.0",
    runtimePath: "/Users/test/.hunsu/runtime/versions/0.2.0-next.0"
  });

  assert.equal(result.ok, true);
  assert.deepEqual(commands, [
    { command: "launchctl", args: ["print", "gui/501/app.hunsu.bridge"] },
    { command: "launchctl", args: ["bootout", "gui/501/app.hunsu.bridge"] }
  ]);
});

test("macOS service status distinguishes a loaded stopped job from a running daemon", async () => {
  const plistPath = "/Users/test/Library/LaunchAgents/app.hunsu.bridge.plist";
  const files = memoryFileSystem({ [plistPath]: "installed" });
  let state = "exited";
  const manager = createMacosLaunchAgentServiceManager({
    uid: 501,
    plistPath,
    fileSystem: files,
    commandRunner: async command => command.args[0] === "print"
      ? { exitCode: 0, stdout: `service = {\n\tstate = ${state}\n}\n`, stderr: "" }
      : okCommand(),
    requestAuthenticatedShutdown: async () => false,
    probeHealth: async () => false
  });

  const stopped = await manager.status();
  assert.equal(stopped.managerState, "stopped");
  assert.equal(stopped.detail, "exited");
  state = "running";
  const running = await manager.status();
  assert.equal(running.managerState, "running");
  assert.equal(running.detail, "running");
});

test("Windows Task Scheduler uses current-user ScheduledTasks, hidden settings, and absolute direct paths", async () => {
  const input: ServiceInstallInput = {
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    cliPath: "C:\\Users\\O'Brien\\Hunsu Bridge\\cli.js",
    hunsuHome: "C:\\Users\\O'Brien\\AppData\\Local\\Hunsu\\Bridge",
    packageVersion: "0.2.0-next.0",
    runtimePath: "C:\\Users\\O'Brien\\AppData\\Local\\Hunsu\\Bridge\\runtime"
  };
  const script = windowsTaskInstallScript(input);
  assert.match(script, /New-ScheduledTaskAction -Execute 'C:\\Program Files\\nodejs\\node\.exe'/u);
  assert.match(script, /O''Brien/u);
  assert.match(script, /New-ScheduledTaskTrigger -AtLogOn -User \$CurrentUser/u);
  assert.match(script, /New-ScheduledTaskPrincipal -UserId \$CurrentUser -LogonType Interactive -RunLevel Limited/u);
  assert.match(script, /New-ScheduledTaskSettingsSet -Hidden/u);
  assert.match(script, /Register-ScheduledTask/u);
  assert.doesNotMatch(script, /Start-ScheduledTask|Stop-Process|taskkill|Get-Process/iu);

  const commands: ServiceCommand[] = [];
  let probeCount = 0;
  const manager = createWindowsTaskSchedulerServiceManager({
    commandRunner: async command => {
      commands.push(command);
      probeCount += 1;
      return probeCount === 1
        ? { exitCode: 1, stdout: "", stderr: "not found" }
        : okCommand();
    },
    requestAuthenticatedShutdown: async () => false,
    probeHealth: async () => false
  });
  assert.equal((await manager.install(input)).ok, true);
  assert.equal(commands.length, 2);
  assert.match(commands[1]?.args.at(-1) ?? "", /Register-ScheduledTask/u);
  assert.doesNotMatch(commands[1]?.args.at(-1) ?? "", /Start-ScheduledTask/u);
});

test("Windows service install reports changes only when the stable action path changes", async () => {
  const input: ServiceInstallInput = {
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    cliPath: "C:\\Users\\test\\Hunsu\\runtime\\0.2.0-next.0\\cli.js",
    hunsuHome: "C:\\Users\\test\\Hunsu",
    packageVersion: "0.2.0-next.0",
    runtimePath: "C:\\Users\\test\\Hunsu\\runtime\\0.2.0-next.0"
  };
  const actionArguments = `"${input.cliPath}" daemon --home "${input.hunsuHome}"`;
  let existingArguments = actionArguments;
  const manager = createWindowsTaskSchedulerServiceManager({
    commandRunner: async command => {
      const script = command.args.at(-1) ?? "";
      if (script.includes("ConvertTo-Json")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ Execute: input.nodePath.toUpperCase(), Arguments: existingArguments }),
          stderr: ""
        };
      }
      return okCommand();
    },
    requestAuthenticatedShutdown: async () => false,
    probeHealth: async () => false
  });

  const unchanged = await manager.install(input);
  assert.equal(unchanged.ok, true);
  if (unchanged.ok) assert.equal(unchanged.changed, false);
  existingArguments = `"C:\\old\\cli.js" daemon --home "${input.hunsuHome}"`;
  const changed = await manager.install(input);
  assert.equal(changed.ok, true);
  if (changed.ok) assert.equal(changed.changed, true);
});

test("Windows stop fallback targets only the owned task and install input rejects injection", async () => {
  const commands: ServiceCommand[] = [];
  const manager = createWindowsTaskSchedulerServiceManager({
    commandRunner: async command => {
      commands.push(command);
      if ((command.args.at(-1) ?? "").includes("Get-ScheduledTask")) {
        return { exitCode: 0, stdout: "Ready\n", stderr: "" };
      }
      return okCommand();
    },
    requestAuthenticatedShutdown: async () => false,
    probeHealth: async () => false
  });
  assert.equal((await manager.stop()).ok, true);
  const fallback = commands.find(command => (command.args.at(-1) ?? "").includes("Stop-ScheduledTask"));
  assert.ok(fallback);
  assert.match(fallback.args.at(-1) ?? "", /^Stop-ScheduledTask -TaskName 'Hunsu Bridge'$/u);
  assert.doesNotMatch(JSON.stringify(commands), /Stop-Process|taskkill|Get-Process|netstat/iu);

  const commandCountBeforeInvalidInstall = commands.length;
  const invalid = await manager.install({
    ...linuxInstall,
    nodePath: "relative/node",
    cliPath: "C:\\Hunsu\\cli.js",
    hunsuHome: "C:\\Hunsu\nInjected",
    runtimePath: "C:\\Hunsu\\runtime"
  });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.code, "SERVICE_INSTALL_FAILED");
  assert.equal(commands.length, commandCountBeforeInvalidInstall);
});

test("platform-neutral selector refuses an unconfigured platform", () => {
  assert.throws(() => createBridgeServiceManager({ platform: "freebsd" }), /does not have a configured user service manager/u);
});

function successfulRunner(commands: ServiceCommand[]) {
  return async (command: ServiceCommand): Promise<ServiceCommandResult> => {
    commands.push(command);
    return okCommand();
  };
}

function okCommand(): ServiceCommandResult {
  return { exitCode: 0, stdout: "", stderr: "" };
}

function memoryFileSystem(initial: Record<string, string> = {}): ServiceFileSystem {
  const files = new Map(Object.entries(initial));
  return {
    exists: async path => files.has(path),
    readText: async path => files.get(path),
    mkdir: async () => undefined,
    writeText: async (path, text) => {
      files.set(path, text);
    },
    remove: async path => {
      files.delete(path);
    }
  };
}
