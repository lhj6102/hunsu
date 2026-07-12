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
import { startBridgeDaemon } from "../apps/bridge/src/daemon/daemon.ts";
import { createDeterministicConnectP2pFixture } from "../tests/fixtures/deterministic-connect-p2p.ts";

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
  let daemon;
  let web;
  let connectFixture;
  const captured = [];
  let endpoint;
  let webUrl;
  let authenticatedShutdown = false;

  try {
    await initializeRepository(workspace, captured);
    const codexBinary = await createFakeCodexExecutable(root);
    const webPort = await allocateFreePort();
    webUrl = `http://127.0.0.1:${webPort}`;
    connectFixture = await createDeterministicConnectP2pFixture();
    const environment = {
      ...process.env,
      HUNSU_HOME: home,
      HUNSU_WEB_URL: `${webUrl}/studio`,
      HUNSU_BRIDGE_ALLOWED_ORIGINS: webUrl,
      HUNSU_CODEX_APP_SERVER_COMMAND: codexBinary,
      HUNSU_CODEX_APP_SERVER_ARGS: JSON.stringify(["app-server", "--stdio"]),
      HUNSU_FAKE_CODEX_MODE: "ready",
      HUNSU_CONNECT_API_BASE_URL: connectFixture.apiUrl,
      HUNSU_CONNECT_WS_URL: connectFixture.wsUrl,
      HUNSU_DEVELOPMENT_CONNECT_TICKET_ISSUER: connectFixture.ticketIssuer,
      HUNSU_DEVELOPMENT_CONNECT_TICKET_SIGNING_KEY_ID: connectFixture.ticketSigningKeyId,
      HUNSU_DEVELOPMENT_CONNECT_TICKET_SIGNING_PUBLIC_JWK: JSON.stringify(connectFixture.ticketSigningPublicJwk),
      NODE_OPTIONS: [
        process.env.NODE_OPTIONS,
        "--no-warnings",
        "--conditions=development",
        "--experimental-transform-types"
      ].filter(Boolean).join(" ")
    };

    daemon = await startBridgeDaemon({
      home,
      host: "127.0.0.1",
      port: 0,
      cwd: workspace,
      webUrl: `${webUrl}/studio`,
      deploymentProfile: "preview",
      development: true,
      env: environment,
      socketFactory: connectFixture.socketFactory,
      peerTransportFactory: connectFixture.peerTransportFactory,
      openBrowser: async () => undefined
    });
    endpoint = requiredUrl(daemon.identity.endpoint, "foreground daemon endpoint");
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
    ensure(login.value?.state === "pending", "Connect login did not start device enrollment");
    ensure(new URL(requiredString(login.value?.verificationUri, "Connect verification URI")).origin === connectFixture.apiUrl, "Connect login escaped the fixture origin");
    await connectFixture.completeBrowserEnrollment(requiredString(login.value?.userCode, "Connect user code"));
    await waitFor(async () => {
      try {
        const value = JSON.parse(await readFile(join(home, "credentials.json"), "utf8"));
        return value?.connect?.state === "registered" ? value.connect : undefined;
      } catch (_error) {
        return undefined;
      }
    }, 5_000, "Connect device enrollment");

    const enabled = await runCli(["remote", "enable", "--json"], environment, captured);
    ensure(enabled.value?.enabled === true, "Remote Bridge did not enable after enrollment");
    await connectFixture.authenticateBridge();
    await waitFor(async () => {
      const statusResult = await runCli(["remote", "status", "--json"], environment, captured, { quiet: true });
      return statusResult.value?.connection === "connected" ? statusResult : undefined;
    }, 3_000, "authenticated Connect socket");

    await runCli([
      "workspace", "grant", workspaceId,
      "--scopes", "remote.access",
      "--json"
    ], environment, captured);
    const granted = await runCli(["workspace", "inspect", workspaceId, "--json"], environment, captured);
    ensure(granted.value?.remoteAccess?.enabled === true, "Workspace grant was not persisted");

    const browserSession = await connectFixture.openBrowserSession();
    ensure(browserSession.evidence.opaqueSignaling, "P2P fixture did not prove opaque signaling");
    ensure(browserSession.evidence.signedTranscript, "P2P fixture did not verify the Bridge transcript signature");
    ensure(browserSession.evidence.encryptedDataChannel, "P2P fixture did not use encrypted DataChannel frames");
    const readyWorkspaces = Array.isArray(browserSession.ready.workspaces) ? browserSession.ready.workspaces : [];
    ensure(readyWorkspaces.some(candidate => candidate?.workspaceId === workspaceId), "Direct peer did not receive the granted Workspace");
    ensure(!JSON.stringify(browserSession.ready).includes(workspace), "Direct peer leaked the local Workspace path");
    const allowed = await browserSession.command({ requestId: "request_allowed", workspaceId });
    ensure(allowed.type === "command.result" && allowed.ok === true && allowed.status === 200, "Encrypted direct P2P command failed");
    ensure(!JSON.stringify(allowed).includes(workspace), "Direct peer command leaked the local Workspace path");

    await runCli(["workspace", "revoke", workspaceId, "--json"], environment, captured);
    const revoked = await runCli(["workspace", "inspect", workspaceId, "--json"], environment, captured);
    ensure(revoked.value?.remoteAccess?.enabled === false, "Workspace revoke did not persist before shutdown");
    const denied = await browserSession.command({ requestId: "request_revoked", workspaceId });
    ensure(denied.type === "command.result" && denied.ok === false && denied.status === 403, "Revoked Workspace command did not fail closed");

    const disabled = await runCli(["remote", "disable", "--json"], environment, captured);
    ensure(disabled.value?.enabled === false && disabled.value?.connection === "disabled", "Remote Bridge did not disable cleanly");
    await runCli(["logout", "--json"], environment, captured);
    const signedOut = await runCli(["remote", "status", "--json"], environment, captured);
    ensure(signedOut.value?.signedIn === false && signedOut.value?.connection === "signed_out", "Connect logout did not clear device enrollment");

    const credentials = JSON.parse(await readFile(join(home, "credentials.json"), "utf8"));
    const controlToken = requiredString(credentials.controlToken, "temporary control token");
    ensure(credentials.connect === null, "Connect credentials remained after logout");
    const shutdown = await fetch(new URL("/v1/control/shutdown", endpoint), {
      method: "POST",
      headers: { "X-Hunsu-Bridge-Control-Token": controlToken },
      signal: AbortSignal.timeout(3_000)
    });
    ensure(shutdown.ok, `authenticated shutdown failed with HTTP ${shutdown.status}`);
    authenticatedShutdown = true;
    await withTimeout(
      daemon.waitUntilClosed(),
      8_000,
      "Foreground daemon did not exit after authenticated shutdown."
    );
    await assertPortReleased(endpoint);

    const persistedLogs = await readTextTree(join(home, "logs"));
    const evidence = `${captured.join("\n")}\n${persistedLogs}`;
    assertNoCredentialLeak(evidence, [controlToken, ...connectFixture.sensitiveValues()]);
    const fixtureEvidence = connectFixture.evidence();
    ensure(fixtureEvidence.identityLogins === 1, "Connect identity login was not exercised exactly once");
    ensure(fixtureEvidence.enrollmentRequests === 1 && fixtureEvidence.enrollmentApprovals === 1 && fixtureEvidence.tokenIssues === 1, "Connect enrollment flow was incomplete");
    ensure(fixtureEvidence.socketAuthentications === 1 && fixtureEvidence.peerSessions === 1, "Connect/P2P session evidence was incomplete");
    ensure(fixtureEvidence.externalRequests === 0 && fixtureEvidence.turnRequests === 0 && fixtureEvidence.hostedForwardingRequests === 0, "Scenario used a non-direct network path");
    const totalMs = Math.round(performance.now() - startedAt);
    process.stdout.write(`[headless-scenario] daemon ready: ${formatElapsed(daemonReadyMs)}\n`);
    process.stdout.write(`[headless-scenario] Web ready: ${formatElapsed(webReadyMs)}\n`);
    process.stdout.write(`[headless-scenario] full local scenario: ${formatElapsed(totalMs)}\n`);
    return { daemonReadyMs, webReadyMs, totalMs };
  } finally {
    if (web) await terminateChildTree(web);
    if (daemon && !authenticatedShutdown) await daemon.close().catch(() => undefined);
    await connectFixture?.close().catch(() => undefined);
    releaseChildHandles(web);
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
    !/\bhunsu_(?:bridge|control|pairing|connect)_[A-Za-z0-9_-]+\b/iu.test(evidence),
    "scenario evidence contained token-shaped material"
  );
  ensure(
    !/authorization\s*[=:]\s*Bearer\s+(?!\[redacted\])/iu.test(evidence),
    "scenario evidence contained an Authorization value"
  );
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

async function terminateChildTree(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
    releaseChildHandles(child);
    return;
  }
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    await new Promise(resolveExit => killer.once("exit", resolveExit));
    releaseChildHandles(child);
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
  await waitForExitWithin(child, 2_000);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
    await waitForExitWithin(child, 500);
  }
  releaseChildHandles(child);
}

function waitForExitWithin(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolveExit => {
    const finish = exited => {
      clearTimeout(timeout);
      child.removeListener("exit", onExit);
      resolveExit(exited);
    };
    const onExit = () => finish(true);
    const timeout = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}

function releaseChildHandles(child) {
  child?.stdin?.destroy();
  child?.stdout?.destroy();
  child?.stderr?.destroy();
  child?.unref();
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
    .replace(/\bhunsu_(?:bridge|control|pairing|connect)_[A-Za-z0-9_-]+\b/giu, "[redacted]")
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

async function withTimeout(promise, timeoutMs, message) {
  let timeout;
  const expired = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    timeout.unref?.();
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timeout);
  }
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
