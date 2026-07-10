import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { currentProcessEnv } from "@hunsu/config";

export const defaultWindowsInstallerSmokeTimeoutMs = 60_000;

export async function smokeWindowsInstallerReinstall(input = {}) {
  const platform = input.platform ?? process.platform;
  if (platform !== "win32") {
    throw new Error(`Windows installer reinstall smoke requires win32, found ${platform}.`);
  }
  const env = { ...currentProcessEnv(), ...(input.env ?? {}) };
  const bundleDir = resolve(requiredValue(input.bundleDir, "bundleDir"));
  const installer = input.installerPath
    ? resolve(input.installerPath)
    : singleWindowsInstaller(bundleDir);
  const localAppData = input.localAppData ?? env.LOCALAPPDATA;
  if (!localAppData?.trim()) {
    throw new Error("Windows installer reinstall smoke requires LOCALAPPDATA.");
  }
  const installDir = resolve(input.installDir ?? join(localAppData, "Hunsu Bridge"));
  const sidecar = join(installDir, "hunsu-bridge-sidecar.exe");
  const uninstaller = join(installDir, "uninstall.exe");
  const timeoutMs = positiveInteger(input.timeoutMs ?? defaultWindowsInstallerSmokeTimeoutMs, "timeoutMs");
  const settleMs = nonNegativeInteger(input.settleMs ?? 1_000, "settleMs");
  const runner = input.runner ?? runCommand;
  const startSidecar = input.startSidecar ?? startDetachedSidecar;
  const processAlive = input.processAlive ?? isProcessAlive;
  const wait = input.wait ?? delay;
  const logger = input.logger ?? console.log;
  const ownsStateRoot = !input.stateRoot;
  const stateRoot = input.stateRoot ?? mkdtempSync(join(tmpdir(), "hunsu-installer-reinstall-"));
  const smokeEnv = isolatedBridgeEnv(env, stateRoot);
  const startedPids = [];
  let uninstalled = false;

  try {
    requireFile(installer, "Windows NSIS installer");
    logger(`[installer-smoke] installer=${installer}`);
    runChecked(runner, installer, ["/S"], { env: smokeEnv, timeoutMs }, "initial silent install");
    requireFile(sidecar, "installed Hunsu Bridge sidecar");
    requireFile(uninstaller, "installed Hunsu Bridge uninstaller");

    const first = await startSidecar(sidecar, ["start", "--no-open"], {
      cwd: input.cwd ?? process.cwd(),
      env: smokeEnv
    });
    startedPids.push(first.pid);
    await assertProcessSettled(first.pid, true, { processAlive, wait, timeoutMs, settleMs }, "first installed sidecar");

    logger("[installer-smoke] reinstalling over a running sidecar");
    runChecked(runner, installer, ["/S"], { env: smokeEnv, timeoutMs }, "silent reinstall");
    await waitForProcessState(first.pid, false, { processAlive, wait, timeoutMs }, "sidecar shutdown during reinstall");
    requireFile(sidecar, "reinstalled Hunsu Bridge sidecar");

    const second = await startSidecar(sidecar, ["start", "--no-open"], {
      cwd: input.cwd ?? process.cwd(),
      env: smokeEnv
    });
    startedPids.push(second.pid);
    await assertProcessSettled(second.pid, true, { processAlive, wait, timeoutMs, settleMs }, "second installed sidecar");

    logger("[installer-smoke] uninstalling with a running sidecar");
    runChecked(runner, uninstaller, ["/S"], { env: smokeEnv, timeoutMs }, "silent uninstall");
    await waitForProcessState(second.pid, false, { processAlive, wait, timeoutMs }, "sidecar shutdown during uninstall");
    await waitForFileState(sidecar, false, { wait, timeoutMs }, "installed sidecar removal");
    uninstalled = true;

    logger("[installer-smoke] reinstall and uninstall completed");
    return { installer, installDir, sidecar };
  } finally {
    for (const pid of startedPids) {
      if (processAlive(pid)) {
        runner("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
          encoding: "utf8",
          env: smokeEnv,
          timeout: timeoutMs,
          windowsHide: true
        });
      }
    }
    if (!uninstalled && existsSync(uninstaller)) {
      runner(uninstaller, ["/S"], {
        encoding: "utf8",
        env: smokeEnv,
        timeout: timeoutMs,
        windowsHide: true
      });
    }
    if (ownsStateRoot && input.keepState !== true) {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  }
}

function singleWindowsInstaller(bundleDir) {
  const nsisDir = join(bundleDir, "nsis");
  if (!existsSync(nsisDir)) {
    throw new Error(`Windows NSIS bundle directory is missing: ${nsisDir}`);
  }
  const installers = readdirSync(nsisDir)
    .filter(name => name.toLowerCase().endsWith("-setup.exe"))
    .map(name => join(nsisDir, name));
  if (installers.length !== 1) {
    throw new Error(`Expected exactly one Windows NSIS installer under ${nsisDir}, found ${installers.length}.`);
  }
  return installers[0];
}

function isolatedBridgeEnv(env, stateRoot) {
  return {
    ...env,
    HUNSU_BRIDGE_APP_STATE_PATH: join(stateRoot, "state.json"),
    HUNSU_ROADMAP_REGISTRY_PATH: join(stateRoot, "roadmaps.json"),
    HUNSU_BRIDGE_CREDENTIAL_PATH: join(stateRoot, "credentials.json"),
    HUNSU_RELAY_REGISTRY_PATH: join(stateRoot, "relay.json"),
    HUNSU_BRIDGE_APP_LOG_PATH: join(stateRoot, "bridge-app.log")
  };
}

function runChecked(runner, command, args, input, label) {
  const result = runner(command, args, {
    encoding: "utf8",
    env: input.env,
    timeout: input.timeoutMs,
    windowsHide: true
  });
  if (result.error || result.status !== 0) {
    const output = [result.stdout, result.stderr].map(value => String(value ?? "").trim()).filter(Boolean).join("\n");
    throw new Error(`${label} failed${result.error ? `: ${result.error.message}` : ` with status ${result.status ?? "unknown"}`}${output ? `\n${output}` : ""}`);
  }
}

function runCommand(command, args, options) {
  return spawnSync(command, args, options);
}

async function startDetachedSidecar(command, args, options) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    detached: true,
    env: options.env,
    stdio: "ignore",
    windowsHide: true
  });
  await new Promise((accept, reject) => {
    child.once("spawn", accept);
    child.once("error", reject);
  });
  if (!child.pid) {
    throw new Error("Installed Hunsu Bridge sidecar started without a process ID.");
  }
  child.unref();
  return { pid: child.pid };
}

async function assertProcessSettled(pid, expected, input, label) {
  await waitForProcessState(pid, expected, input, label);
  if (input.settleMs > 0) {
    await input.wait(input.settleMs);
  }
  if (input.processAlive(pid) !== expected) {
    throw new Error(`${label} did not remain ${expected ? "running" : "stopped"}.`);
  }
}

async function waitForProcessState(pid, expected, input, label) {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    if (input.processAlive(pid) === expected) {
      return;
    }
    await input.wait(100);
  }
  throw new Error(`${label} did not become ${expected ? "running" : "stopped"} within ${input.timeoutMs} ms.`);
}

async function waitForFileState(path, expected, input, label) {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path) === expected) {
      return;
    }
    await input.wait(100);
  }
  throw new Error(`${label} did not complete within ${input.timeoutMs} ms: ${path}`);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_error) {
    return false;
  }
}

function requireFile(path, label) {
  if (!existsSync(path)) {
    throw new Error(`${label} is missing: ${path}`);
  }
}

function requiredValue(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Windows installer reinstall smoke requires ${name}.`);
  }
  return value.trim();
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return number;
}

function nonNegativeInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return number;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cliOptions(argv) {
  const allowed = new Set(["--bundle-dir", "--timeout-ms"]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!allowed.has(flag)) {
      throw new Error(`Unexpected argument: ${flag}`);
    }
    if (values.has(flag)) {
      throw new Error(`Duplicate option: ${flag}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag}.`);
    }
    values.set(flag, value);
    index += 1;
  }
  return {
    bundleDir: values.get("--bundle-dir"),
    timeoutMs: values.has("--timeout-ms") ? Number(values.get("--timeout-ms")) : undefined
  };
}

const isDirectRun = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isDirectRun) {
  smokeWindowsInstallerReinstall(cliOptions(process.argv.slice(2))).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
