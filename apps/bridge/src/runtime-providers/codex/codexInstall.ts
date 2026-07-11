import { spawn, spawnSync } from "node:child_process";
import { currentProcessEnv } from "@hunsu/config";
import type { RuntimeProviderInstallPlan } from "../types.ts";

export type CodexInstaller = (input: {
  env: Record<string, string | undefined>;
  dryRun?: boolean;
}) => Promise<{ ok: boolean; command: string; args: string[]; exitCode?: number; output?: string; error?: string }>;

export type CodexInstallerPrerequisite =
  | { available: true; command: "npm" | "npm.cmd"; version?: string }
  | { available: false; command: "npm" | "npm.cmd"; message: string };

export type CodexInstallerPrerequisiteProbe = (input: {
  env: Record<string, string | undefined>;
}) => Promise<CodexInstallerPrerequisite> | CodexInstallerPrerequisite;

const CODEX_NPM_PREREQUISITE_GUIDANCE =
  "npm is required to install Codex. Install npm and retry, or use Select Existing Codex.";

export function codexInstallerCommand(platform = process.platform): "npm" | "npm.cmd" {
  return platform === "win32" ? "npm.cmd" : "npm";
}

export function detectCodexInstallerPrerequisite(input: {
  env: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
}): CodexInstallerPrerequisite {
  const command = codexInstallerCommand(input.platform);
  const env = { ...currentProcessEnv(), ...input.env };
  const launch = codexInstallerLaunchCommand(command, ["--version"], env, input.platform);
  const result = spawnSync(launch.command, launch.args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env,
    windowsHide: true
  });
  if (result.status === 0) {
    const version = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().split(/\r?\n/u).find(Boolean);
    return { available: true, command, version };
  }
  return { available: false, command, message: CODEX_NPM_PREREQUISITE_GUIDANCE };
}

export function codexInstallPlan(
  prerequisite: CodexInstallerPrerequisite = { available: true, command: codexInstallerCommand() }
): RuntimeProviderInstallPlan {
  return {
    providerId: "codex",
    available: prerequisite.available,
    label: "Install Codex",
    command: prerequisite.command,
    args: ["install", "-g", "@openai/codex@latest"],
    confirmationRequired: true,
    instructions: prerequisite.available
      ? [
          "Hunsu Bridge can run the Codex npm installer after you confirm.",
          "If Codex is already installed in a custom location, use Select Existing Codex."
        ]
      : [
          prerequisite.message,
          "pnpm and yarn cannot run this npm-specific provider installer."
        ]
  };
}

export const runDefaultCodexInstaller: CodexInstaller = async input => {
  const command = codexInstallerCommand();
  const args = ["install", "-g", "@openai/codex@latest"];
  if (input.dryRun) {
    return { ok: true, command, args };
  }
  return new Promise(resolve => {
    const env = { ...currentProcessEnv(), ...input.env };
    const launch = codexInstallerLaunchCommand(command, args, env);
    const child = spawn(launch.command, launch.args, {
      stdio: ["ignore", "pipe", "pipe"],
      env,
      windowsHide: true
    });
    let output = "";
    const append = (chunk: Buffer | string) => {
      output = `${output}${chunk.toString()}`.slice(-16 * 1024);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.once("error", error => {
      resolve({ ok: false, command, args, output: output.trim(), error: error.message });
    });
    child.once("close", code => {
      resolve({
        ok: code === 0,
        command,
        args,
        exitCode: code ?? undefined,
        output: output.trim(),
        error: code === 0 ? undefined : `Codex installer exited with status ${code ?? "unknown"}.`
      });
    });
  });
};

export function codexInstallerLaunchCommand(
  command: "npm" | "npm.cmd",
  args: string[],
  env: Record<string, string | undefined>,
  platform = process.platform
): { command: string; args: string[] } {
  if (platform !== "win32") {
    return { command, args };
  }
  const comSpec = env.ComSpec ?? env.COMSPEC ?? "cmd.exe";
  return {
    command: comSpec,
    args: ["/d", "/s", "/c", windowsCmdCommandLine(command, args)]
  };
}

function windowsCmdCommandLine(command: string, args: string[]): string {
  return `"${[command, ...args].map(quoteWindowsCmdArgument).join(" ")}"`;
}

function quoteWindowsCmdArgument(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}
