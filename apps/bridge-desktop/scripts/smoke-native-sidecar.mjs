#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { currentProcessEnv } from "@hunsu/config";

export const defaultSmokeTimeoutMs = 60_000;

const targetHosts = new Map([
  ["x86_64-apple-darwin", { platform: "darwin", arch: "x64", extension: "" }],
  ["aarch64-apple-darwin", { platform: "darwin", arch: "arm64", extension: "" }],
  ["x86_64-unknown-linux-gnu", { platform: "linux", arch: "x64", extension: "" }],
  ["aarch64-unknown-linux-gnu", { platform: "linux", arch: "arm64", extension: "" }],
  ["x86_64-pc-windows-msvc", { platform: "win32", arch: "x64", extension: ".exe" }],
  ["aarch64-pc-windows-msvc", { platform: "win32", arch: "arm64", extension: ".exe" }]
]);

const statusMarkers = [
  /^Hunsu Bridge\r?$/mu,
  /^Status:\r?$/mu,
  /^\s+Local Bridge:/mu
];

export function smokeNativeSidecar(input) {
  const target = String(input.target ?? "");
  const targetHost = targetHosts.get(target);
  if (!targetHost) {
    throw new Error(`Unsupported sidecar target: ${target || "(missing)"}. Expected one of: ${[...targetHosts.keys()].join(", ")}.`);
  }

  const runnerPlatform = input.runnerPlatform ?? process.platform;
  const runnerArch = input.runnerArch ?? process.arch;
  if (runnerPlatform !== targetHost.platform || runnerArch !== targetHost.arch) {
    throw new Error(
      `Sidecar target ${target} requires ${targetHost.platform}/${targetHost.arch}, `
      + `but this runner is ${runnerPlatform}/${runnerArch}.`
    );
  }

  const sidecarPath = resolve(String(input.sidecar ?? ""));
  const expectedName = `hunsu-bridge-sidecar-${target}${targetHost.extension}`;
  if (basename(sidecarPath) !== expectedName) {
    throw new Error(`Expected sidecar filename ${expectedName}, found ${basename(sidecarPath) || "(missing)"}.`);
  }
  if (!existsSync(sidecarPath) || !statSync(sidecarPath).isFile()) {
    throw new Error(`Expected native sidecar is missing: ${sidecarPath}`);
  }

  const timeoutMs = normalizeTimeout(input.timeoutMs);
  const logger = input.logger ?? console.log;
  const run = input.runner ?? spawnSync;
  const makeTemporaryDirectory = input.makeTemporaryDirectory ?? (prefix => mkdtempSync(prefix));
  const removeTemporaryDirectory = input.removeTemporaryDirectory
    ?? (directory => rmSync(directory, { recursive: true, force: true }));
  const smokeRoot = makeTemporaryDirectory(join(input.temporaryRoot ?? tmpdir(), "hunsu-bridge-sidecar-smoke-"));

  try {
    logger(`[sidecar-smoke] target=${target}`);
    logger(`[sidecar-smoke] executable=${sidecarPath}`);
    const startedAt = Date.now();
    logger("[sidecar-smoke] starting status command");
    let result;
    try {
      result = run(sidecarPath, ["status"], {
        cwd: input.cwd ?? process.cwd(),
        encoding: "utf8",
        timeout: timeoutMs,
        windowsHide: true,
        env: {
          ...(input.env ?? currentProcessEnv()),
          HUNSU_BRIDGE_APP_STATE_PATH: join(smokeRoot, "state.json"),
          HUNSU_ROADMAP_REGISTRY_PATH: join(smokeRoot, "roadmaps.json"),
          HUNSU_BRIDGE_CREDENTIAL_PATH: join(smokeRoot, "credentials.json"),
          HUNSU_RELAY_REGISTRY_PATH: join(smokeRoot, "relay.json"),
          HUNSU_BRIDGE_APP_LOG_PATH: join(smokeRoot, "bridge-app.log")
        }
      });
    } catch (error) {
      throw smokeError({
        summary: "Native Hunsu Bridge sidecar could not start while running `status`.",
        target,
        sidecarPath,
        reason: error instanceof Error ? error.message : String(error)
      });
    }

    const stdout = outputText(result.stdout);
    const stderr = outputText(result.stderr);
    if (isTimeoutResult(result)) {
      throw smokeError({
        summary: `Native Hunsu Bridge sidecar timed out after ${timeoutMs} ms while running \`status\`.`,
        target,
        sidecarPath,
        stdout,
        stderr
      });
    }
    if (result.error) {
      throw smokeError({
        summary: "Native Hunsu Bridge sidecar failed to spawn while running `status`.",
        target,
        sidecarPath,
        reason: result.error instanceof Error ? result.error.message : String(result.error),
        stdout,
        stderr
      });
    }
    if (result.status !== 0) {
      throw smokeError({
        summary: `Native Hunsu Bridge sidecar exited with code ${result.status ?? "unknown"} while running \`status\`.`,
        target,
        sidecarPath,
        stdout,
        stderr
      });
    }
    if (statusMarkers.some(marker => !marker.test(stdout))) {
      throw smokeError({
        summary: "Native Hunsu Bridge sidecar status output is missing expected Hunsu Bridge markers.",
        target,
        sidecarPath,
        stdout,
        stderr
      });
    }

    const elapsedMs = Date.now() - startedAt;
    if (stdout) {
      (input.writeOutput ?? (value => process.stdout.write(value)))(stdout.endsWith("\n") ? stdout : `${stdout}\n`);
    }
    logger(`[sidecar-smoke] completed in ${(elapsedMs / 1000).toFixed(1)}s`);
    return { target, executable: sidecarPath, elapsedMs, stdout, stderr, stateDirectory: smokeRoot };
  } finally {
    removeTemporaryDirectory(smokeRoot);
  }
}

export function parseSmokeArgs(argv) {
  const allowed = new Set(["--sidecar", "--target", "--timeout-ms"]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag) || !value || value.startsWith("--")) {
      throw new Error("Usage: smoke-native-sidecar.mjs --sidecar <path> --target <target-triple> [--timeout-ms <milliseconds>]");
    }
    if (values.has(flag)) {
      throw new Error(`Duplicate option: ${flag}`);
    }
    values.set(flag, value);
  }
  if (!values.has("--sidecar") || !values.has("--target")) {
    throw new Error("Usage: smoke-native-sidecar.mjs --sidecar <path> --target <target-triple> [--timeout-ms <milliseconds>]");
  }
  return {
    sidecar: values.get("--sidecar"),
    target: values.get("--target"),
    timeoutMs: values.has("--timeout-ms") ? Number(values.get("--timeout-ms")) : defaultSmokeTimeoutMs
  };
}

function normalizeTimeout(value) {
  const timeoutMs = value ?? defaultSmokeTimeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Sidecar smoke timeout must be a positive integer in milliseconds; received ${String(timeoutMs)}.`);
  }
  return timeoutMs;
}

function isTimeoutResult(result) {
  return result?.error?.code === "ETIMEDOUT";
}

function outputText(value) {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
}

function smokeError(input) {
  const lines = [
    input.summary,
    `Target: ${input.target}`,
    `Executable: ${input.sidecarPath}`
  ];
  if (input.reason) lines.push(`Reason: ${input.reason}`);
  if (input.stdout) lines.push("", "Captured stdout:", input.stdout.trimEnd());
  if (input.stderr) lines.push("", "Captured stderr:", input.stderr.trimEnd());
  return new Error(lines.join("\n"));
}

function isCurrentScriptEntrypoint() {
  const entrypoint = process.argv[1];
  return Boolean(entrypoint) && import.meta.url === pathToFileURL(resolve(entrypoint)).href;
}

if (isCurrentScriptEntrypoint()) {
  try {
    smokeNativeSidecar(parseSmokeArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
