#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHunsuRelayServer } from "../apps/relay/src/index.ts";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..");
const bridgeCliPath = join(repositoryRoot, "apps", "bridge", "src", "cli.ts");
const vitePath = join(repositoryRoot, "apps", "web", "node_modules", "vite", "bin", "vite.js");
const webRoot = join(repositoryRoot, "apps", "web");
const fakeCodexPath = join(repositoryRoot, "tests", "fixtures", "fake-codex.mjs");

export async function runHeadlessScenario(options = {}) {
  const startedAt = performance.now();
  const root = await mkdtemp(join(tmpdir(), "hunsu-headless-scenario-"));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const relay = createHunsuRelayServer({
    config: relayConfig(join(root, "relay-state.json")),
    commandTimeoutMs: 4_000
  });
  let daemon;
  let web;
  const captured = [];
  let endpoint;
  let webUrl;
  let authenticatedShutdown = false;

  try {
    await initializeRepository(workspace, captured);
    const codexBinary = await createFakeCodexExecutable(root);
    const relayUrls = await relay.listen();
    const webPort = await allocateFreePort();
    webUrl = `http://127.0.0.1:${webPort}`;
    const environment = {
      ...process.env,
      HUNSU_HOME: home,
      HUNSU_WEB_URL: `${webUrl}/studio`,
      HUNSU_BRIDGE_ALLOWED_ORIGINS: webUrl,
      HUNSU_CODEX_APP_SERVER_COMMAND: codexBinary,
      HUNSU_CODEX_APP_SERVER_ARGS: JSON.stringify(["app-server", "--stdio"]),
      HUNSU_FAKE_CODEX_MODE: "ready",
      HUNSU_BRIDGE_AUTH_BASE_URL: relayUrls.apiUrl,
      HUNSU_RELAY_API_URL: relayUrls.apiUrl,
      HUNSU_RELAY_PUBLIC_API_URL: relayUrls.apiUrl,
      HUNSU_RELAY_WS_URL: relayUrls.wsUrl,
      NODE_OPTIONS: [
        process.env.NODE_OPTIONS,
        "--no-warnings",
        "--conditions=development",
        "--experimental-transform-types"
      ].filter(Boolean).join(" ")
    };

    daemon = spawn(process.execPath, [
      "--experimental-transform-types",
      "--conditions=development",
      bridgeCliPath,
      "dev",
      "--host", "127.0.0.1",
      "--port", "0",
      "--cwd", workspace,
      "--web-url", `${webUrl}/studio`,
      "--json"
    ], childOptions(environment));
    captureChild(daemon, captured);
    const ready = await waitForDaemonResult(daemon, captured);
    endpoint = requiredUrl(ready.value?.endpoint, "foreground daemon endpoint");
    const daemonReadyMs = Math.round(performance.now() - startedAt);

    const status = await runCli(["status", "--json"], environment, captured);
    ensure(status.value?.endpoint === endpoint, "status did not report the foreground daemon endpoint");

    await runCli(["provider", "set", "codex", "--binary", codexBinary, "--json"], environment, captured);
    const provider = await runCli(["provider", "check", "codex", "--json"], environment, captured);
    ensure(provider.ok === true, "fake Codex provider check failed");

    const added = await runCli(["workspace", "add", workspace, "--json"], environment, captured);
    const workspaceId = requiredString(added.value?.workspaceId, "Workspace id");
    const listed = await runCli(["workspace", "list", "--json"], environment, captured);
    ensure(
      Array.isArray(listed.value) && listed.value.some(candidate => candidate?.workspaceId === workspaceId),
      "Workspace list did not include the scenario Workspace"
    );
    const inspected = await runCli(["workspace", "inspect", workspaceId, "--json"], environment, captured);
    ensure(inspected.value?.workspaceId === workspaceId, "Workspace inspect returned the wrong Workspace");
    await runCli(["pair", "--workspace", workspaceId, "--json"], environment, captured);

    web = spawn(process.execPath, [
      "--conditions=development",
      "--experimental-transform-types",
      vitePath,
      webRoot,
      "--configLoader", "native",
      "--host", "127.0.0.1",
      "--port", String(webPort),
      "--strictPort"
    ], childOptions({
      ...environment,
      HUNSU_BRIDGE_API_PROXY_TARGET: endpoint,
      HUNSU_WEB_HOST: "127.0.0.1",
      HUNSU_WEB_PORT: String(webPort),
      HUNSU_WEB_STRICT_PORT: "true",
      VITE_HUNSU_BRIDGE_URL: ""
    }));
    captureChild(web, captured);
    await waitForHealth(webUrl, web, captured);
    const webReadyMs = Math.round(performance.now() - startedAt);

    const login = await runCli(["login", "--no-open", "--json"], environment, captured);
    const approvalUrl = requiredUrl(login.value?.verificationUriComplete, "device approval URL");
    const approval = await fetch(approvalUrl, { signal: AbortSignal.timeout(2_000) });
    ensure(approval.ok, `device approval failed with HTTP ${approval.status}`);
    await waitFor(async () => {
      const remoteStatus = await runCli(["remote", "status", "--json"], environment, captured, { quiet: true });
      return remoteStatus.value?.signedIn === true;
    }, 8_000, "headless login completion");

    await runCli([
      "workspace", "grant", workspaceId,
      "--scopes", "remoteRelay.access",
      "--json"
    ], environment, captured);
    await runCli(["remote", "enable", "--json"], environment, captured);
    const connected = await waitFor(async () => {
      const remoteStatus = await runCli(["remote", "status", "--json"], environment, captured, { quiet: true });
      return remoteStatus.value?.connection === "connected" ? remoteStatus : undefined;
    }, 8_000, "outbound Relay connection");
    const credentials = JSON.parse(await readFile(join(home, "credentials.json"), "utf8"));
    const accountToken = requiredString(credentials.account?.accessToken, "temporary account token");
    const deviceId = requiredString(connected.value?.deviceId ?? credentials.relay?.deviceId, "Relay device id");
    const roundTripResponse = await fetch(`${relayUrls.apiUrl}/v1/commands`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accountToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ deviceId, command: "bridge.status" }),
      signal: AbortSignal.timeout(5_000)
    });
    const roundTrip = await roundTripResponse.json();
    ensure(roundTripResponse.ok && roundTrip.ok === true, "Relay command did not round-trip through Bridge");
    ensure(!JSON.stringify(roundTrip).includes(workspace), "Relay status response exposed the local Workspace path");

    await runCli(["workspace", "revoke", workspaceId, "--json"], environment, captured);
    const revoked = await runCli(["workspace", "inspect", workspaceId, "--json"], environment, captured);
    ensure(revoked.value?.remoteAccess?.enabled === false, "Workspace revoke did not persist before shutdown");
    await runCli(["remote", "disable", "--json"], environment, captured);

    const controlToken = requiredString(credentials.controlToken, "temporary control token");
    const shutdown = await fetch(new URL("/v1/control/shutdown", endpoint), {
      method: "POST",
      headers: { "X-Hunsu-Bridge-Control-Token": controlToken },
      signal: AbortSignal.timeout(3_000)
    });
    ensure(shutdown.ok, `authenticated shutdown failed with HTTP ${shutdown.status}`);
    authenticatedShutdown = true;
    await waitForChildExit(daemon, 8_000);
    await assertPortReleased(endpoint);

    const persistedLogs = await readTextTree(join(home, "logs"));
    const evidence = `${captured.join("\n")}\n${persistedLogs}`;
    assertNoCredentialLeak(evidence, [controlToken, accountToken, credentials.account?.refreshToken, credentials.relay?.token]);
    const totalMs = Math.round(performance.now() - startedAt);
    process.stdout.write(`[headless-scenario] daemon ready: ${formatElapsed(daemonReadyMs)}\n`);
    process.stdout.write(`[headless-scenario] Web ready: ${formatElapsed(webReadyMs)}\n`);
    process.stdout.write(`[headless-scenario] full local scenario: ${formatElapsed(totalMs)}\n`);
    return { daemonReadyMs, webReadyMs, totalMs };
  } finally {
    if (web) await terminateChildTree(web);
    if (daemon && !authenticatedShutdown) await terminateChildTree(daemon);
    await relay.close().catch(() => undefined);
    if (options.keepState !== true) await rm(root, { recursive: true, force: true });
    else process.stdout.write(`[headless-scenario] state preserved at ${root}\n`);
  }
}

export function assertNoCredentialLeak(evidence, credentials = []) {
  const values = credentials.filter(value => typeof value === "string" && value.length > 0);
  for (const credential of values) {
    ensure(!evidence.includes(credential), "scenario output or persisted logs contained a raw credential");
  }
  ensure(
    !/\bhunsu_(?:bridge|control|pairing|relay)_[A-Za-z0-9_-]+\b/iu.test(evidence),
    "scenario evidence contained token-shaped material"
  );
  ensure(
    !/authorization\s*[=:]\s*Bearer\s+(?!\[redacted\])/iu.test(evidence),
    "scenario evidence contained an Authorization value"
  );
}

function relayConfig(storagePath) {
  return {
    relay: { name: "relay", host: "127.0.0.1", hostSource: "override", port: 0, portSource: "override", reserved: false },
    publicApiUrl: "http://127.0.0.1:0",
    publicWsUrl: "ws://127.0.0.1:0/v1/device/connect",
    issuer: "http://127.0.0.1:0",
    storagePath,
    processEnv: {}
  };
}

async function initializeRepository(path, captured) {
  await mkdir(path, { recursive: true });
  await run("git", ["init", "-b", "main"], { cwd: path }, captured);
  await run("git", ["config", "user.email", "headless-scenario@example.invalid"], { cwd: path }, captured);
  await run("git", ["config", "user.name", "Headless Scenario"], { cwd: path }, captured);
  await writeFile(join(path, "README.md"), "# Headless scenario fixture\n", "utf8");
  await run("git", ["add", "README.md"], { cwd: path }, captured);
  await run("git", ["commit", "-m", "Initialize headless scenario"], { cwd: path }, captured);
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

async function runCli(args, env, captured, options = {}) {
  const result = await run(process.execPath, [
    "--no-warnings",
    "--experimental-transform-types",
    "--conditions=development",
    bridgeCliPath,
    ...args
  ], { cwd: repositoryRoot, env }, captured, options);
  const lines = result.stdout.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  ensure(lines.length === 1, `hunsu-bridge ${args[0] ?? "command"} did not emit exactly one JSON line`);
  ensure(result.stderr.trim() === "", `hunsu-bridge ${args[0] ?? "command"} wrote unexpected stderr`);
  let value;
  try {
    value = JSON.parse(lines[0]);
  } catch (_error) {
    throw new Error(`hunsu-bridge ${args[0] ?? "command"} emitted malformed JSON`);
  }
  ensure(value?.schema === "hunsu.bridge.cli-result.v1", "Bridge CLI result used the wrong schema");
  ensure(value.ok === true, `Bridge CLI failed with ${String(value.code ?? "unknown")}: ${String(value.message ?? "")}`);
  return value;
}

async function run(command, args, options, captured, behavior = {}) {
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
  captured.push(stdout, stderr);
  if (exit.code !== 0) {
    const detail = behavior.quiet === true ? "" : `\n${sanitizeEvidence(`${stdout}\n${stderr}`)}`;
    throw new Error(`${command} exited with ${exit.code ?? exit.signal ?? "unknown"}.${detail}`);
  }
  return { stdout, stderr };
}

function captureChild(child, captured) {
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", chunk => captured.push(String(chunk)));
  }
}

async function waitForDaemonResult(child, captured, timeoutMs = 15_000) {
  return waitFor(() => {
    assertChildRunning(child, captured, "foreground daemon");
    for (const line of captured.join("").split(/\r?\n/u)) {
      try {
        const value = JSON.parse(line);
        if (value?.schema === "hunsu.bridge.cli-result.v1" && value.ok === true && value.value?.endpoint) return value;
      } catch (_error) {
        // The daemon may have emitted a partial line while it was starting.
      }
    }
    return undefined;
  }, timeoutMs, "foreground daemon readiness");
}

async function waitForHealth(baseUrl, child, captured, timeoutMs = 15_000) {
  return waitFor(async () => {
    assertChildRunning(child, captured, "Web development server");
    try {
      const response = await fetch(new URL("/health", baseUrl), { signal: AbortSignal.timeout(700) });
      const body = await response.json();
      return response.ok && body?.service === "hunsu-bridge" ? body : undefined;
    } catch (_error) {
      return undefined;
    }
  }, timeoutMs, "Web proxy health");
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function allocateFreePort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolveListen);
  });
  const address = server.address();
  ensure(address && typeof address !== "string", "could not allocate a Web port");
  await new Promise(resolveClose => server.close(() => resolveClose()));
  return address.port;
}

async function assertPortReleased(endpoint) {
  const url = new URL(endpoint);
  await waitFor(async () => {
    try {
      await fetch(new URL("/health", url), { signal: AbortSignal.timeout(200) });
      return false;
    } catch (_error) {
      return true;
    }
  }, 5_000, "Bridge endpoint release");
}

async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise(resolveExit => child.once("exit", resolveExit)),
    delay(timeoutMs).then(() => { throw new Error("Foreground daemon did not exit after authenticated shutdown."); })
  ]);
}

async function terminateChildTree(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    await new Promise(resolveExit => killer.once("exit", resolveExit));
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
  await Promise.race([new Promise(resolveExit => child.once("exit", resolveExit)), delay(2_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  }
}

function childOptions(env) {
  return {
    cwd: repositoryRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32"
  };
}

function assertChildRunning(child, captured, label) {
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(`${label} exited before readiness.\n${sanitizeEvidence(captured.join("\n"))}`);
  }
}

async function readTextTree(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
    throw error;
  }
  const values = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) values.push(await readTextTree(path));
    else if (entry.isFile()) values.push(await readFile(path, "utf8"));
  }
  return values.join("\n");
}

function sanitizeEvidence(value) {
  return String(value)
    .replace(/([?&](?:hunsuBridgeToken|token|authorization)=)[^&#\s]+/giu, "$1[redacted]")
    .replace(/\bhunsu_(?:bridge|control|pairing|relay)_[A-Za-z0-9_-]+\b/giu, "[redacted]")
    .replace(/(Bearer\s+)[^\s,"']+/giu, "$1[redacted]")
    .slice(-24_000);
}

function requiredString(value, label) {
  ensure(typeof value === "string" && value.trim(), `${label} is missing`);
  return value.trim();
}

function requiredUrl(value, label) {
  const raw = requiredString(value, label);
  const url = new URL(raw);
  ensure(url.hostname === "127.0.0.1" || url.hostname === "hunsu.localhost", `${label} must stay loopback-local`);
  return url.toString().replace(/\/$/u, "");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function formatElapsed(milliseconds) {
  return `${(milliseconds / 1_000).toFixed(2)}s`;
}

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(milliseconds) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));
}

function parseArguments(argv = process.argv.slice(2)) {
  let keepState = false;
  for (const argument of argv) {
    if (argument === "--keep-state") keepState = true;
    else if (argument === "--help" || argument === "-h") return { help: true, keepState: false };
    else throw new Error(`Unknown headless scenario option: ${argument}`);
  }
  return { help: false, keepState };
}

if (resolve(process.argv[1] ?? "") === scriptPath) {
  try {
    const options = parseArguments();
    if (options.help) {
      process.stdout.write("Usage: pnpm run test:headless:scenario [-- --keep-state]\n");
    } else {
      await runHeadlessScenario({ keepState: options.keepState });
    }
  } catch (error) {
    process.stderr.write(`[headless-scenario] ${sanitizeEvidence(error instanceof Error ? error.message : String(error))}\n`);
    process.exitCode = 1;
  }
}
