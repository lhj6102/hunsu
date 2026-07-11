import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  createManagedBridgeService,
  defaultServiceCommandRunner,
  defaultServiceFileSystem,
  systemdQuote,
  writeServiceDefinition,
  type BridgeServiceAdapter,
  type ServiceAdapterDependencies
} from "./lifecycle.ts";
import type { BridgeServiceManager, ServiceCommandResult, ServiceInstallInput } from "./types.ts";

const SYSTEMD_UNIT_NAME = "hunsu-bridge.service";

export type LinuxSystemdUserOptions = ServiceAdapterDependencies & {
  homeDirectory?: string;
  unitPath?: string;
};

export function createLinuxSystemdUserServiceManager(options: LinuxSystemdUserOptions): BridgeServiceManager {
  const commandRunner = options.commandRunner ?? defaultServiceCommandRunner;
  const fileSystem = options.fileSystem ?? defaultServiceFileSystem;
  const unitPath = options.unitPath ?? join(options.homeDirectory ?? homedir(), ".config", "systemd", "user", SYSTEMD_UNIT_NAME);

  const adapter: BridgeServiceAdapter = {
    manager: "systemd-user",
    definitionPath: unitPath,
    platform: "linux",
    async install(input) {
      const changed = await writeServiceDefinition(fileSystem, unitPath, linuxSystemdUserUnit(input));
      requireCommandSuccess(await commandRunner({ command: "systemctl", args: ["--user", "daemon-reload"] }), "reload systemd user units");
      requireCommandSuccess(await commandRunner({ command: "systemctl", args: ["--user", "enable", SYSTEMD_UNIT_NAME] }), "enable the systemd user unit");
      return { changed };
    },
    async uninstall() {
      const existed = await fileSystem.exists(unitPath);
      await commandRunner({ command: "systemctl", args: ["--user", "disable", SYSTEMD_UNIT_NAME] });
      await fileSystem.remove(unitPath);
      requireCommandSuccess(await commandRunner({ command: "systemctl", args: ["--user", "daemon-reload"] }), "reload systemd user units");
      return { changed: existed };
    },
    async start() {
      requireCommandSuccess(await commandRunner({ command: "systemctl", args: ["--user", "start", SYSTEMD_UNIT_NAME] }), "start the systemd user unit");
    },
    async stopOwned() {
      requireCommandSuccess(await commandRunner({ command: "systemctl", args: ["--user", "stop", SYSTEMD_UNIT_NAME] }), "stop the systemd user unit");
    },
    async status() {
      if (!await fileSystem.exists(unitPath)) {
        return { installed: false, state: "stopped" };
      }
      const result = await commandRunner({ command: "systemctl", args: ["--user", "is-active", SYSTEMD_UNIT_NAME] });
      const state = result.exitCode === 0 && result.stdout.trim() === "active"
        ? "running"
        : /^(inactive|failed|deactivating)$/u.test(result.stdout.trim()) || result.exitCode === 3
          ? "stopped"
          : "unknown";
      return {
        installed: true,
        state,
        detail: result.stdout.trim() || result.stderr.trim() || undefined
      };
    }
  };

  return createManagedBridgeService(adapter, options);
}

export function linuxSystemdUserUnit(input: ServiceInstallInput): string {
  return [
    "[Unit]",
    "Description=Hunsu Bridge",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${[input.nodePath, input.cliPath, "daemon"].map(systemdQuote).join(" ")}`,
    `Environment=${systemdQuote(`HUNSU_HOME=${input.hunsuHome}`)}`,
    "Restart=on-failure",
    "RestartSec=2",
    "",
    "[Install]",
    "WantedBy=default.target",
    ""
  ].join("\n");
}

function requireCommandSuccess(result: ServiceCommandResult, action: string): void {
  if (result.exitCode !== 0) {
    throw new Error(`Unable to ${action}.`);
  }
}

