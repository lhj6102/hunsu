#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..");
const fakeCodexPath = join(repositoryRoot, "tests", "fixtures", "fake-codex.mjs");

export async function runBridgeServiceSmoke(input) {
  const startedAt = performance.now();
  const root = await mkdtemp(join(tmpdir(), "hunsu-bridge-service-smoke-"));
  const bootstrap = join(root, "bootstrap");
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const npmCache = join(root, "npm-cache");
  const preservedFile = join(home, "service-smoke-user-data.txt");
  let launcher;
  let endpoint;
  let setupCompleted = false;
  const environment = {
    ...process.env,
    HUNSU_HOME: home,
    npm_config_audit: "false",
    npm_config_cache: npmCache,
    npm_config_fund: "false",
    npm_config_loglevel: "error",
    npm_config_update_notifier: "false"
  };

  try {
    await Promise.all([
      mkdir(bootstrap, { recursive: true }),
      mkdir(workspace, { recursive: true })
    ]);
    await initializeRepository(workspace, environment);
    const codexBinary = await createFakeCodexExecutable(root);

    if (input.kind === "local-tarball") {
      const tarball = resolve(input.tarball);
      ensure(isAbsolute(tarball), "The service-smoke tarball path must be absolute after resolution.");
      ensure(tarball.endsWith(".tgz"), "The service-smoke input must be a .tgz archive.");
      await access(tarball);
      await runNpm(["init", "--yes"], { cwd: bootstrap, env: environment });
      await runNpm([
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        tarball
      ], { cwd: bootstrap, env: environment });
      const packageRoot = join(bootstrap, "node_modules", "@hunsu", "bridge");
      const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
      launcher = {
        kind: input.kind,
        version: requiredString(manifest.version, "installed tarball version"),
        command: process.execPath,
        prefix: [join(packageRoot, "dist", "cli.js")],
        setupArgs: ["--runtime-package", tarball]
      };
    } else {
      const version = exactVersion(input.version);
      launcher = {
        kind: input.kind,
        version,
        command: npxCommand(),
        prefix: ["--yes", `@hunsu/bridge@${version}`],
        setupArgs: []
      };
    }

    const firstSetup = await runCli(launcher, ["setup", ...launcher.setupArgs, "--home", home, "--json"], environment, bootstrap);
    ensure(firstSetup.ok === true, "first setup did not complete");
    setupCompleted = true;
    const install = await readInstallDocument(home);
    assertInstallIdentity(install, launcher.version, home, bootstrap, npmCache);
    endpoint = await waitForHealthyService(launcher, environment, bootstrap, launcher.version);

    await runCli(launcher, ["provider", "set", "codex", "--binary", codexBinary, "--home", home, "--json"], environment, bootstrap);
    await runCli(launcher, ["provider", "check", "codex", "--home", home, "--json"], environment, bootstrap);
    const added = await runCli(launcher, ["workspace", "add", workspace, "--home", home, "--json"], environment, bootstrap);
    const workspaceId = requiredString(added.value?.workspaceId, "service-smoke Workspace id");
    const listed = await runCli(launcher, ["workspace", "list", "--home", home, "--json"], environment, bootstrap);
    ensure(Array.isArray(listed.value) && listed.value.some(value => value?.workspaceId === workspaceId), "Workspace list smoke failed");
    await runCli(launcher, ["workspace", "inspect", workspaceId, "--home", home, "--json"], environment, bootstrap);
    await runCli(launcher, ["pair", "--workspace", workspaceId, "--home", home, "--json"], environment, bootstrap);
    await assertPlatformDefinition(install, home);
    const macOsLaunchAgentBeforeReplacement = await inspectMacOsLaunchAgent(install);
    await makeMacOsDefinitionStale(install);

    const secondSetup = await runCli(launcher, ["setup", ...launcher.setupArgs, "--home", home, "--json"], environment, bootstrap);
    ensure(secondSetup.ok === true, "same-version setup did not complete idempotently");
    const secondInstall = await readInstallDocument(home);
    assertInstallIdentity(secondInstall, launcher.version, home, bootstrap, npmCache);
    ensure(secondInstall.current.runtimePath === install.current.runtimePath, "same-version setup selected a second runtime path");
    const secondEndpoint = await waitForHealthyService(launcher, environment, bootstrap, launcher.version);
    ensure(secondEndpoint === endpoint, "same-version setup changed the configured endpoint or created another daemon");
    await assertPlatformDefinition(secondInstall, home);
    await assertMacOsLaunchAgentReplaced(macOsLaunchAgentBeforeReplacement, secondInstall);

    await mkdir(home, { recursive: true });
    await writeFile(preservedFile, "preserve this user-owned smoke marker\n", "utf8");
    await runCli(launcher, ["service", "stop", "--home", home, "--json"], environment, bootstrap);
    await assertPortReleased(endpoint);
    const stopped = await runCli(launcher, ["service", "status", "--home", home, "--json"], environment, bootstrap);
    ensure(stopped.value?.managerState === "stopped", "service stop did not reach a stopped manager state");

    const removed = await runCli(launcher, ["remove", "--home", home, "--json"], environment, bootstrap);
    ensure(removed.ok === true, "remove did not complete");
    await access(preservedFile);
    await Promise.all([
      access(join(home, "config.json")),
      access(join(home, "workspaces.json")),
      access(join(home, "credentials.json"))
    ]);
    const uninstalled = await runCli(launcher, ["service", "uninstall", "--home", home, "--json"], environment, bootstrap);
    ensure(uninstalled.ok === true, "service uninstall was not idempotent after remove");
    const finalStatus = await runCli(launcher, ["service", "status", "--home", home, "--json"], environment, bootstrap);
    ensure(finalStatus.value?.installed === false, "service definition remained installed after remove");
    await assertMissing(install.current.runtimePath, "stable runtime remained after remove");

    const durationMs = Math.round(performance.now() - startedAt);
    process.stdout.write(`[bridge-service-smoke] ${process.platform} ${launcher.version}: ${(durationMs / 1_000).toFixed(2)}s\n`);
    return { platform: process.platform, version: launcher.version, durationMs };
  } catch (error) {
    await reportWindowsTaskFailure({ launcher, env: environment, cwd: bootstrap, home });
    throw error;
  } finally {
    if (setupCompleted && launcher) {
      await runCliBestEffort(launcher, ["service", "stop", "--home", home, "--json"], environment, bootstrap);
      await runCliBestEffort(launcher, ["service", "uninstall", "--home", home, "--json"], environment, bootstrap);
    }
    if (input.keepState !== true) await rm(root, { recursive: true, force: true });
    else process.stdout.write(`[bridge-service-smoke] state preserved at ${root}\n`);
  }
}

async function waitForHealthyService(launcher, env, cwd, version) {
  let last;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    last = await runCli(launcher, ["service", "status", "--home", env.HUNSU_HOME, "--json"], env, cwd, { allowFailure: true });
    if (last.ok === true
      && last.value?.installed === true
      && last.value?.managerState === "running"
      && last.value?.health === "healthy"
      && last.value?.authentication === "authenticated") {
      ensure(last.value?.packageVersion === version, "service status reported the wrong package version");
      const status = await runCli(launcher, ["status", "--home", env.HUNSU_HOME, "--json"], env, cwd);
      ensure(status.value?.version === version, "authenticated status reported the wrong package version");
      return requiredString(status.value?.endpoint, "healthy service endpoint");
    }
    await delay(100);
  }
  throw new Error(`The user service did not become healthy: ${safeJson(last)}`);
}

async function readInstallDocument(home) {
  const value = JSON.parse(await readFile(join(home, "runtime", "install.json"), "utf8"));
  ensure(value?.schema === "hunsu.bridge.runtime-install.v1", "runtime install document used the wrong schema");
  return value;
}

function assertInstallIdentity(install, version, home, bootstrap, npmCache) {
  ensure(install.current?.packageVersion === version, "install.json reported the wrong exact package version");
  const expectedRuntime = resolve(home, "runtime", "versions", version);
  ensure(samePath(install.current?.runtimePath, expectedRuntime), "stable runtime path was not HUNSU_HOME/runtime/versions/<version>");
  ensure(isAbsolute(install.current?.nodePath ?? ""), "service Node path was not absolute");
  ensure(isAbsolute(install.current?.cliPath ?? ""), "service CLI path was not absolute");
  ensure(isContained(expectedRuntime, install.current.cliPath), "service CLI path was outside the stable runtime");
  ensure(!isContained(bootstrap, install.current.runtimePath), "service runtime pointed into the bootstrap project");
  ensure(!isContained(npmCache, install.current.runtimePath), "service runtime pointed into npm cache");
  ensure(!isContained(repositoryRoot, install.current.runtimePath), "service runtime pointed into the repository checkout");
}

async function assertPlatformDefinition(install, home) {
  const nodePath = install.current.nodePath;
  const cliPath = install.current.cliPath;
  const runtimePath = install.current.runtimePath;
  await access(cliPath);
  if (process.platform === "linux") {
    const unit = await readFile(join(homedir(), ".config", "systemd", "user", "hunsu-bridge.service"), "utf8");
    ensure(unit.includes(nodePath) && unit.includes(cliPath), "systemd user unit did not use stable absolute paths");
    ensure(unit.includes("WantedBy=default.target"), "systemd user unit was not enabled by contract");
    ensure(unit.includes(`HUNSU_HOME=${home}`), "systemd user unit did not bind the selected HUNSU_HOME");
    const enabled = await runCommand("systemctl", ["--user", "is-enabled", "hunsu-bridge.service"], {
      cwd: repositoryRoot,
      env: process.env
    });
    ensure(enabled.stdout.trim() === "enabled", "systemd user unit was not actually enabled");
    return;
  }
  if (process.platform === "darwin") {
    const plist = await readFile(join(homedir(), "Library", "LaunchAgents", "app.hunsu.bridge.plist"), "utf8");
    ensure(plist.includes(nodePath) && plist.includes(cliPath), "LaunchAgent ProgramArguments did not use stable paths");
    ensure(plist.includes(`<string>${home}</string>`), "LaunchAgent did not bind the selected HUNSU_HOME");
    await inspectMacOsLaunchAgent(install);
    return;
  }
  if (process.platform === "win32") {
    const task = await runPowerShell([
      "$Task = Get-ScheduledTask -TaskName 'Hunsu Bridge'",
      "$Identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name",
      "@{ Execute = $Task.Actions[0].Execute; Arguments = $Task.Actions[0].Arguments; WorkingDirectory = $Task.Actions[0].WorkingDirectory; UserId = $Task.Principal.UserId; CurrentIdentity = $Identity } | ConvertTo-Json -Compress"
    ].join("; "));
    const value = JSON.parse(task.stdout.replace(/^\uFEFF/u, "").trim());
    ensure(samePath(value.Execute, nodePath), "Task Scheduler did not use the selected Node executable");
    ensure(String(value.Arguments).includes(cliPath), "Task Scheduler did not use the stable CLI path");
    ensure(samePath(value.WorkingDirectory, runtimePath), "Task Scheduler did not use the stable runtime working directory");
    ensure(String(value.UserId).toLowerCase() === String(value.CurrentIdentity).toLowerCase(), "Task Scheduler did not use the current user");

    const acl = await runPowerShell([
      `$Acl = Get-Acl -LiteralPath ${powerShellQuote(join(home, "credentials.json"))}`,
      "$Identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name",
      "@{ Owner = $Acl.Owner; Protected = $Acl.AreAccessRulesProtected; Rules = @($Acl.Access | ForEach-Object { @{ Identity = $_.IdentityReference.Value; Type = $_.AccessControlType.ToString(); Rights = $_.FileSystemRights.ToString() } }); CurrentIdentity = $Identity } | ConvertTo-Json -Depth 6 -Compress"
    ].join("; "));
    const aclValue = JSON.parse(acl.stdout.replace(/^\uFEFF/u, "").trim());
    ensure(String(aclValue.Owner).toLowerCase() === String(aclValue.CurrentIdentity).toLowerCase(), "Windows credentials owner was not the current user");
    ensure(aclValue.Protected === true, "Windows credentials ACL inherited broader rules");
    ensure(Array.isArray(aclValue.Rules) && aclValue.Rules.length === 1, "Windows credentials ACL was not current-user-only");
    ensure(String(aclValue.Rules[0]?.Identity).toLowerCase() === String(aclValue.CurrentIdentity).toLowerCase(), "Windows credentials ACL identity was not the current user");
    ensure(aclValue.Rules[0]?.Type === "Allow" && String(aclValue.Rules[0]?.Rights).includes("FullControl"), "Windows credentials ACL did not grant only current-user FullControl");
  }
}

async function inspectMacOsLaunchAgent(install) {
  if (process.platform !== "darwin") return undefined;
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const loaded = await runCommand("launchctl", ["print", `gui/${uid}/app.hunsu.bridge`], {
    cwd: repositoryRoot,
    env: process.env
  });
  const pidMatch = loaded.stdout.match(/^\s*pid\s*=\s*(\d+)\s*$/imu);
  const pid = Number(pidMatch?.[1]);
  ensure(Number.isSafeInteger(pid) && pid > 0, "LaunchAgent did not expose one running daemon PID");
  for (const argument of [
    install.current.nodePath,
    install.current.cliPath,
    "daemon",
    "--runtime-path",
    install.current.runtimePath
  ]) {
    ensure(loaded.stdout.includes(argument), `loaded LaunchAgent arguments omitted ${basename(argument)}`);
  }
  return { pid };
}

async function assertMacOsLaunchAgentReplaced(previous, install) {
  if (process.platform !== "darwin") return;
  ensure(previous, "The initial loaded LaunchAgent state was not captured");
  const current = await inspectMacOsLaunchAgent(install);
  ensure(current.pid !== previous.pid, "changed LaunchAgent plist was rewritten without booting out the cached job");
}

async function makeMacOsDefinitionStale(install) {
  if (process.platform !== "darwin") return;
  const path = join(homedir(), "Library", "LaunchAgents", "app.hunsu.bridge.plist");
  const current = await readFile(path, "utf8");
  const staleCliPath = `${install.current.cliPath}.stale`;
  const stale = current.replace(install.current.cliPath, staleCliPath);
  ensure(stale !== current, "LaunchAgent fixture could not make the installed definition stale");
  await writeFile(path, stale, "utf8");
}

async function initializeRepository(path, env) {
  await runCommand("git", ["init", "-b", "main"], { cwd: path, env });
  await runCommand("git", ["config", "user.email", "bridge-service-smoke@example.invalid"], { cwd: path, env });
  await runCommand("git", ["config", "user.name", "Bridge Service Smoke"], { cwd: path, env });
  await writeFile(join(path, "README.md"), "# Bridge service smoke fixture\n", "utf8");
  await runCommand("git", ["add", "README.md"], { cwd: path, env });
  await runCommand("git", ["commit", "-m", "Initialize service smoke fixture"], { cwd: path, env });
}

async function createFakeCodexExecutable(root) {
  if (process.platform === "win32") {
    const path = join(root, "fake-codex.cmd");
    await writeFile(path, `@echo off\r\n"${process.execPath}" "${fakeCodexPath}" %*\r\n`, "utf8");
    return path;
  }
  const path = join(root, "fake-codex");
  await writeFile(path, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fakeCodexPath)} "$@"\n`, "utf8");
  await chmod(path, 0o700);
  return path;
}

async function runCli(launcher, args, env, cwd, options = {}) {
  const action = safeCliAction(args);
  let result;
  try {
    result = await runCommand(launcher.command, [...launcher.prefix, ...args], { cwd, env }, { allowFailure: options.allowFailure });
  } catch (error) {
    throw new Error(`${action} failed: ${error instanceof Error ? error.message : "Bridge CLI process failed."}`, { cause: error });
  }
  const lines = result.stdout.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  if (lines.length !== 1) throw new Error(`Bridge CLI emitted ${lines.length} stdout lines instead of one JSON result.`);
  let value;
  try {
    value = JSON.parse(lines[0]);
  } catch (_error) {
    throw new Error("Bridge CLI emitted malformed JSON.");
  }
  ensure(value?.schema === "hunsu.bridge.cli-result.v1", "Bridge CLI emitted the wrong result schema");
  if (options.allowFailure !== true) {
    ensure(result.code === 0 && value.ok === true, `${action} failed: ${safeJson(value)}`);
    ensure(result.stderr.trim() === "", `${action} wrote stderr for a successful product operation`);
  }
  return value;
}

async function runCliBestEffort(launcher, args, env, cwd) {
  try {
    await runCli(launcher, args, env, cwd, { allowFailure: true });
  } catch (_error) {
    // Cleanup is intentionally best effort after a failed platform smoke.
  }
}

async function runNpm(args, options) {
  return runCommand(npmCommand(), args, options);
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function npxCommand() {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

async function runPowerShell(script) {
  return runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
    cwd: repositoryRoot,
    env: process.env
  });
}

async function reportWindowsTaskFailure(input) {
  if (process.platform !== "win32") return;
  try {
    const result = await runPowerShell([
      "$Task = Get-ScheduledTask -TaskName 'Hunsu Bridge'",
      "$Info = $Task | Get-ScheduledTaskInfo",
      "@{ State = $Task.State.ToString(); LastTaskResult = $Info.LastTaskResult; MissedRuns = $Info.NumberOfMissedRuns } | ConvertTo-Json -Compress"
    ].join("; "));
    process.stderr.write(`[bridge-service-smoke] Windows task diagnostic: ${sanitize(result.stdout.trim())}\n`);
  } catch (_error) {
    process.stderr.write("[bridge-service-smoke] Windows task diagnostic was unavailable.\n");
  }
  if (input.launcher) {
    try {
      const status = await runCli(
        input.launcher,
        ["service", "status", "--home", input.home, "--json"],
        input.env,
        input.cwd,
        { allowFailure: true }
      );
      process.stderr.write(`[bridge-service-smoke] Windows Bridge diagnostic: ${safeJson({
        ok: status.ok,
        code: status.code,
        installed: status.value?.installed,
        managerState: status.value?.managerState,
        health: status.value?.health,
        authentication: status.value?.authentication,
        packageVersion: status.value?.packageVersion
      })}\n`);
    } catch (_error) {
      process.stderr.write("[bridge-service-smoke] Windows Bridge status diagnostic was unavailable.\n");
    }
  }
  const stateFiles = {
    config: join(input.home, "config.json"),
    runtimeIdentity: join(input.home, "runtime.json"),
    daemonLock: join(input.home, "runtime", "daemon.lock"),
    setupTransaction: join(input.home, "runtime", "setup-transaction.json")
  };
  const presence = {};
  for (const [name, path] of Object.entries(stateFiles)) {
    presence[name] = await access(path).then(() => true, () => false);
  }
  process.stderr.write(`[bridge-service-smoke] Windows state presence: ${safeJson(presence)}\n`);
  try {
    const lines = (await readFile(join(input.home, "logs", "bridge.jsonl"), "utf8"))
      .split(/\r?\n/u)
      .filter(Boolean)
      .slice(-12);
    const events = lines.map(line => {
      try {
        const value = JSON.parse(line);
        return {
          level: typeof value.level === "string" ? value.level : "unknown",
          event: typeof value.event === "string" ? value.event : "unknown"
        };
      } catch (_error) {
        return { level: "unknown", event: "malformed" };
      }
    });
    process.stderr.write(`[bridge-service-smoke] Windows log events: ${safeJson(events)}\n`);
  } catch (_error) {
    process.stderr.write("[bridge-service-smoke] Windows log event diagnostic was unavailable.\n");
  }
}

async function runCommand(command, args, options, behavior = {}) {
  const child = spawn(command, args, {
    ...options,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: process.platform === "win32" && /\.(?:cmd|bat)$/iu.test(command)
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += String(chunk); });
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  const exit = await new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  if (exit.code !== 0 && behavior.allowFailure !== true) {
    throw new Error(`${basename(command)} exited with ${exit.code ?? exit.signal ?? "unknown"}: ${sanitize(`${stdout}\n${stderr}`)}`);
  }
  return { code: exit.code, signal: exit.signal, stdout, stderr };
}

async function assertPortReleased(endpoint) {
  const url = new URL(endpoint);
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try {
      await fetch(new URL("/health", url), { signal: AbortSignal.timeout(250) });
    } catch (_error) {
      return;
    }
    await delay(100);
  }
  throw new Error("Stopped service did not release the Bridge endpoint.");
}

async function assertMissing(path, message) {
  try {
    await access(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(message);
}

function samePath(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isContained(parent, candidate) {
  if (typeof parent !== "string" || typeof candidate !== "string") return false;
  const result = relative(resolve(parent), resolve(candidate));
  return result === "" || (!result.startsWith(`..${sep}`) && result !== ".." && !isAbsolute(result));
}

function exactVersion(value) {
  const version = requiredString(value, "registry version");
  ensure(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version), "Registry service smoke requires one exact semver version.");
  return version;
}

function powerShellQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function safeJson(value) {
  return sanitize(JSON.stringify(value));
}

function safeCliAction(args) {
  const command = typeof args[0] === "string" ? args[0] : "command";
  const nested = new Set(["credential", "provider", "remote", "service", "workspace"]);
  const subcommand = nested.has(command) && typeof args[1] === "string" && !args[1].startsWith("-")
    ? args[1]
    : undefined;
  return sanitize(subcommand ? `${command} ${subcommand}` : command);
}

function sanitize(value) {
  return String(value)
    .replace(/([?&](?:hunsuBridgeToken|token|authorization)=)[^&#\s]+/giu, "$1[redacted]")
    .replace(/\bhunsu_(?:bridge|control|pairing|relay)_[A-Za-z0-9_-]+\b/giu, "[redacted]")
    .replace(/(Bearer\s+)[^\s,"']+/giu, "$1[redacted]")
    .slice(-16_000);
}

function requiredString(value, label) {
  ensure(typeof value === "string" && value.trim(), `${label} is missing`);
  return value.trim();
}

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(milliseconds) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));
}

function parseArguments(argv = process.argv.slice(2)) {
  let source;
  let keepState = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--tarball") {
      ensure(!source, "Provide exactly one service-smoke package source.");
      source = { kind: "local-tarball", tarball: argv[++index] };
    } else if (argument === "--registry-version") {
      ensure(!source, "Provide exactly one service-smoke package source.");
      source = { kind: "registry-exact", version: argv[++index] };
    }
    else if (argument === "--keep-state") keepState = true;
    else if (argument === "--help" || argument === "-h") return { help: true };
    else throw new Error(`Unknown Bridge service-smoke option: ${argument}`);
  }
  ensure(source?.tarball || source?.version, "Provide exactly one --tarball or --registry-version input.");
  return { help: false, ...source, keepState };
}

if (resolve(process.argv[1] ?? "") === scriptPath) {
  try {
    const options = parseArguments();
    if (options.help) {
      process.stdout.write("Usage: node scripts/bridge-service-smoke.mjs (--tarball <absolute.tgz> | --registry-version <exact>) [--keep-state]\n");
    } else {
      await runBridgeServiceSmoke(options);
    }
  } catch (error) {
    process.stderr.write(`[bridge-service-smoke] ${sanitize(error instanceof Error ? error.message : String(error))}\n`);
    process.exitCode = 1;
  }
}
