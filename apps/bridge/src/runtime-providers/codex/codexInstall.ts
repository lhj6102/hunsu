import { spawn } from "node:child_process";
import { currentProcessEnv } from "@hunsu/config";
import type { RuntimeProviderInstallPlan } from "../types.ts";

export type CodexInstaller = (input: {
  env: Record<string, string | undefined>;
  dryRun?: boolean;
}) => Promise<{ ok: boolean; command: string; args: string[]; exitCode?: number; output?: string; error?: string }>;

export function codexInstallPlan(): RuntimeProviderInstallPlan {
  return {
    providerId: "codex",
    available: true,
    label: "Install Codex",
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    args: ["install", "-g", "@openai/codex@latest"],
    confirmationRequired: true,
    instructions: [
      "Hunsu Bridge can run the Codex npm installer after you confirm.",
      "If Codex is already installed in a custom location, select that binary in Advanced settings."
    ]
  };
}

export const runDefaultCodexInstaller: CodexInstaller = async input => {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const args = ["install", "-g", "@openai/codex@latest"];
  if (input.dryRun) {
    return { ok: true, command, args };
  }
  return new Promise(resolve => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...currentProcessEnv(), ...input.env },
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
