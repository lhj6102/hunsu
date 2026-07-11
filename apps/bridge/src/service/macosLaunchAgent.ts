import { homedir } from "node:os";
import { join } from "node:path";
import {
  createManagedBridgeService,
  defaultServiceCommandRunner,
  defaultServiceFileSystem,
  writeServiceDefinition,
  xmlEscape,
  type BridgeServiceAdapter,
  type ServiceAdapterDependencies
} from "./lifecycle.ts";
import type { BridgeServiceManager, ServiceCommandResult, ServiceInstallInput } from "./types.ts";

const LAUNCH_AGENT_LABEL = "app.hunsu.bridge";

export type MacosLaunchAgentOptions = ServiceAdapterDependencies & {
  homeDirectory?: string;
  plistPath?: string;
  uid?: number;
};

export function createMacosLaunchAgentServiceManager(options: MacosLaunchAgentOptions): BridgeServiceManager {
  const commandRunner = options.commandRunner ?? defaultServiceCommandRunner;
  const fileSystem = options.fileSystem ?? defaultServiceFileSystem;
  const homeDirectory = options.homeDirectory ?? homedir();
  const plistPath = options.plistPath ?? join(homeDirectory, "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
  const uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0);
  const domain = `gui/${uid}`;
  const target = `${domain}/${LAUNCH_AGENT_LABEL}`;

  const adapter: BridgeServiceAdapter = {
    manager: "launchd-user",
    definitionPath: plistPath,
    platform: "darwin",
    async install(input) {
      await fileSystem.mkdir(join(input.hunsuHome, "logs"), { mode: 0o700 });
      const definition = macosLaunchAgentPlist(input);
      const changed = await fileSystem.readText(plistPath) !== definition;
      if (changed) {
        // launchd caches ProgramArguments when a job is bootstrapped. Rewriting
        // the plist alone would therefore keep launching the previous stable
        // CLI path after an upgrade. Unload a changed definition without
        // starting it; the platform-neutral start step bootstraps the new one.
        const loaded = await commandRunner({ command: "launchctl", args: ["print", target] });
        if (loaded.exitCode === 0) {
          requireCommandSuccess(
            await commandRunner({ command: "launchctl", args: ["bootout", target] }),
            "reload the changed LaunchAgent definition"
          );
        }
      }
      return { changed: await writeServiceDefinition(fileSystem, plistPath, definition) };
    },
    async uninstall() {
      const existed = await fileSystem.exists(plistPath);
      await commandRunner({ command: "launchctl", args: ["bootout", target] });
      await fileSystem.remove(plistPath);
      return { changed: existed };
    },
    async start() {
      const current = await commandRunner({ command: "launchctl", args: ["print", target] });
      const result = current.exitCode === 0
        ? await commandRunner({ command: "launchctl", args: ["kickstart", target] })
        : await commandRunner({ command: "launchctl", args: ["bootstrap", domain, plistPath] });
      requireCommandSuccess(result, "start the LaunchAgent");
    },
    async stopOwned() {
      requireCommandSuccess(await commandRunner({ command: "launchctl", args: ["bootout", target] }), "stop the LaunchAgent");
    },
    async status() {
      if (!await fileSystem.exists(plistPath)) {
        return { installed: false, state: "stopped" };
      }
      const result = await commandRunner({ command: "launchctl", args: ["print", target] });
      const stateMatch = result.stdout.match(/^\s*state\s*=\s*([^\r\n]+)\s*$/imu);
      const state = stateMatch?.[1]?.trim().toLowerCase();
      return {
        installed: true,
        state: result.exitCode !== 0
          ? "stopped"
          : state === "running"
            ? "running"
            : state
              ? "stopped"
              : "unknown",
        detail: result.exitCode === 0 ? state ?? "loaded; state unavailable" : "not loaded"
      };
    }
  };

  return createManagedBridgeService(adapter, options);
}

export function macosLaunchAgentPlist(input: ServiceInstallInput): string {
  const stdoutPath = join(input.hunsuHome, "logs", "bridge.stdout.log");
  const stderrPath = join(input.hunsuHome, "logs", "bridge.stderr.log");
  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
    "<plist version=\"1.0\">",
    "<dict>",
    "  <key>Label</key>",
    `  <string>${LAUNCH_AGENT_LABEL}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    `    <string>${xmlEscape(input.nodePath)}</string>`,
    `    <string>${xmlEscape(input.cliPath)}</string>`,
    "    <string>daemon</string>",
    "  </array>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    "    <key>HUNSU_HOME</key>",
    `    <string>${xmlEscape(input.hunsuHome)}</string>`,
    "  </dict>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <dict>",
    "    <key>SuccessfulExit</key>",
    "    <false/>",
    "  </dict>",
    "  <key>StandardOutPath</key>",
    `  <string>${xmlEscape(stdoutPath)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xmlEscape(stderrPath)}</string>`,
    "</dict>",
    "</plist>",
    ""
  ].join("\n");
}

function requireCommandSuccess(result: ServiceCommandResult, action: string): void {
  if (result.exitCode !== 0) {
    throw new Error(`Unable to ${action}.`);
  }
}
