#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { lookup } from "node:dns";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { redactDiagnosticText } from "../apps/bridge/src/diagnostics/redaction.ts";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..");
const bridgeCliPath = join(repositoryRoot, "apps", "bridge", "src", "cli.ts");
const fakeCodexPath = join(repositoryRoot, "tests", "fixtures", "fake-codex.mjs");
const EXPECTED_HEALTH = Object.freeze({
  ok: true,
  service: "hunsu-bridge",
  version: "0.2.0-next.10",
  protocolVersion: "local-bridge-v1",
  deploymentProfile: "production"
});

export async function allocateFreePort(host = "127.0.0.1") {
  const server = createServer();
  try {
    await new Promise((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen({ host, port: 0, exclusive: true }, resolveListen);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Unable to allocate a local TCP port.");
    }
    return address.port;
  } finally {
    if (server.listening) {
      await new Promise(resolveClose => server.close(() => resolveClose()));
    }
  }
}

export async function allocateDevStackPorts(host = "127.0.0.1") {
  const bridgePort = await allocateFreePort(host);
  let webPort = await allocateFreePort(host);
  while (webPort === bridgePort) webPort = await allocateFreePort(host);
  return { bridgePort, webPort };
}

export function isExactBridgeHealth(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const expectedKeys = Object.keys(EXPECTED_HEALTH).sort();
  return keys.length === expectedKeys.length
    && keys.every((key, index) => key === expectedKeys[index])
    && value.ok === EXPECTED_HEALTH.ok
    && value.service === EXPECTED_HEALTH.service
    && value.version === EXPECTED_HEALTH.version
    && value.protocolVersion === EXPECTED_HEALTH.protocolVersion
    && value.deploymentProfile === EXPECTED_HEALTH.deploymentProfile;
}

export async function resolveDevelopmentWebHost(lookupImpl = lookup) {
  try {
    const address = await new Promise((resolveLookup, rejectLookup) => {
      lookupImpl("hunsu.localhost", { family: 4 }, (error, resolvedAddress) => {
        if (error) rejectLookup(error);
        else resolveLookup(resolvedAddress);
      });
    });
    return address === "127.0.0.1" ? "hunsu.localhost" : "127.0.0.1";
  } catch (_error) {
    return "127.0.0.1";
  }
}

export function safeChildOutputLine(component, line) {
  const sanitized = redactDiagnosticText(String(line))
    .replace(/\bhunsu_(?:bridge|control|pairing|connect)_[A-Za-z0-9_-]+\b/giu, "[redacted]")
    .slice(0, 8_192);
  return `[${component}] ${sanitized}`;
}

export async function startDevStack(options = {}) {
  const startedAt = performance.now();
  const host = "127.0.0.1";
  const keepState = options.keepState === true;
  const stateHome = await mkdtemp(join(tmpdir(), "hunsu-dev-"));
  const { bridgePort, webPort } = await allocateDevStackPorts(host);
  const webHost = await resolveDevelopmentWebHost(options.lookupImpl);
  const bridgeUrl = `http://${host}:${bridgePort}`;
  const webUrl = `http://${webHost}:${webPort}`;
  const children = [];
  let cleaned = false;

  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await Promise.all(children.map(terminateChildTree));
    if (!keepState) await rm(stateHome, { recursive: true, force: true });
  };

  try {
    const childEnvironment = developmentEnvironment({
      stateHome,
      host,
      bridgePort,
      webPort,
      webUrl
    });
    const bridge = spawn(process.execPath, [
      "--experimental-transform-types",
      "--conditions=development",
      bridgeCliPath,
      "dev",
      "--host", host,
      "--port", String(bridgePort),
      "--home", stateHome,
      "--json"
    ], childOptions(childEnvironment));
    children.push(bridge);
    forwardChildOutput(bridge, "bridge", options.stdout ?? process.stdout, options.stderr ?? process.stderr);
    await waitForBridgeHealth(bridgeUrl, bridge, options.startupTimeoutMs);
    const daemonReadyMs = Math.round(performance.now() - startedAt);

    const pnpm = pnpmLaunchCommand([
      "--filter", "@hunsu/web", "dev",
      "--host", host,
      "--port", String(webPort),
      "--strictPort",
      "--configLoader", "native"
    ]);
    const web = spawn(pnpm.command, pnpm.args, childOptions(childEnvironment));
    children.push(web);
    forwardChildOutput(web, "web", options.stdout ?? process.stdout, options.stderr ?? process.stderr);
    await waitForBridgeHealth(webUrl, web, options.startupTimeoutMs, "Web development server");
    const webReadyMs = Math.round(performance.now() - startedAt);

    writeSafe(options.stdout ?? process.stdout, `[bridge] ready at ${bridgeUrl}`);
    writeSafe(options.stdout ?? process.stdout, `[web] ready at ${webUrl}`);
    writeSafe(options.stdout ?? process.stdout, `[state] ${stateHome}`);
    writeSafe(options.stdout ?? process.stdout, `[timing] daemon ready: ${daemonReadyMs} ms`);
    writeSafe(options.stdout ?? process.stdout, `[timing] Web ready: ${webReadyMs} ms`);

    return {
      bridgeUrl,
      webUrl,
      stateHome,
      bridgePort,
      webPort,
      timings: { daemonReadyMs, webReadyMs },
      children: [...children],
      cleanup,
      async waitForChildExit() {
        return await Promise.race(children.map(child => childExit(child)));
      }
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

function developmentEnvironment(input) {
  return {
    ...process.env,
    HUNSU_HOME: input.stateHome,
    HUNSU_BRIDGE_HOST: input.host,
    HUNSU_BRIDGE_PORT: String(input.bridgePort),
    HUNSU_WEB_HOST: input.host,
    HUNSU_WEB_PORT: String(input.webPort),
    HUNSU_WEB_STRICT_PORT: "true",
    HUNSU_WEB_URL: input.webUrl,
    HUNSU_BRIDGE_API_PROXY_TARGET: `http://${input.host}:${input.bridgePort}`,
    VITE_HUNSU_BRIDGE_URL: "",
    HUNSU_CODEX_APP_SERVER_COMMAND: process.execPath,
    HUNSU_CODEX_APP_SERVER_ARGS: JSON.stringify([fakeCodexPath, "app-server", "--stdio"]),
    HUNSU_FAKE_CODEX_MODE: process.env.HUNSU_FAKE_CODEX_MODE ?? "ready",
    NODE_OPTIONS: [
      process.env.NODE_OPTIONS,
      "--no-warnings",
      "--conditions=development",
      "--experimental-transform-types"
    ].filter(Boolean).join(" ")
  };
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

function pnpmLaunchCommand(args) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && /\.(?:c?js|mjs)$/iu.test(npmExecPath)) {
    return { command: process.execPath, args: [npmExecPath, ...args] };
  }
  return { command: process.platform === "win32" ? "pnpm.cmd" : "pnpm", args };
}

function forwardChildOutput(child, component, stdout, stderr) {
  forwardLines(child.stdout, component, stdout);
  forwardLines(child.stderr, component, stderr);
}

function forwardLines(stream, component, destination) {
  const lines = createInterface({ input: stream });
  lines.on("line", line => {
    if (line.trim()) writeSafe(destination, safeChildOutputLine(component, line));
  });
}

function writeSafe(destination, line) {
  destination.write(`${line}\n`);
}

async function waitForBridgeHealth(baseUrl, child, timeoutMs = 15_000, label = "Bridge") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    assertChildRunning(child, label);
    try {
      const response = await fetch(new URL("/health", baseUrl), {
        signal: AbortSignal.timeout(750),
        cache: "no-store"
      });
      const value = await response.json();
      if (response.ok && isExactBridgeHealth(value)) return;
    } catch (_error) {
      // The foreground daemon may still be binding its allocated port.
    }
    await delay(75);
  }
  throw new Error(`${label} did not return the expected /health contract before the development timeout.`);
}

function assertChildRunning(child, label) {
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(`${label} exited before it became ready.`);
  }
}

function childExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ pid: child.pid, code: child.exitCode, signal: child.signalCode });
  }
  return new Promise(resolveExit => {
    child.once("exit", (code, signal) => resolveExit({ pid: child.pid, code, signal }));
  });
}

async function terminateChildTree(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    await new Promise(resolveTaskKill => {
      const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true
      });
      killer.once("error", () => resolveTaskKill());
      killer.once("exit", () => resolveTaskKill());
    });
    return;
  }
  signalProcessGroup(child.pid, "SIGTERM");
  await Promise.race([childExit(child), delay(3_000)]);
  if (child.exitCode === null && child.signalCode === null) signalProcessGroup(child.pid, "SIGKILL");
}

function signalProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!isMissingProcess(error)) throw error;
  }
}

function isMissingProcess(error) {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}

function delay(milliseconds) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));
}

function parseArguments(argv) {
  let keepState = false;
  for (const argument of argv) {
    if (argument === "--keep-state") keepState = true;
    else if (argument === "--help" || argument === "-h") return { help: true, keepState: false };
    else throw new Error(`Unknown dev-stack option: ${argument}`);
  }
  return { help: false, keepState };
}

function printHelp() {
  process.stdout.write("Usage: pnpm dev:stack [--keep-state]\n\nStarts an isolated foreground Bridge and Hunsu Web development server.\n");
}

async function main(argv = process.argv.slice(2)) {
  const arguments_ = parseArguments(argv);
  if (arguments_.help) {
    printHelp();
    return 0;
  }

  let stack;
  let requestedSignal;
  let resolveSignal;
  const signalReceived = new Promise(resolveReceived => { resolveSignal = resolveReceived; });
  const onInterrupt = () => { requestedSignal = "SIGINT"; resolveSignal("SIGINT"); };
  const onTerminate = () => { requestedSignal = "SIGTERM"; resolveSignal("SIGTERM"); };
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  try {
    stack = await startDevStack({ keepState: arguments_.keepState });
    const outcome = await Promise.race([
      signalReceived.then(signal => ({ kind: "signal", signal })),
      stack.waitForChildExit().then(exit => ({ kind: "child", exit }))
    ]);
    if (outcome.kind === "child") {
      throw new Error("A development stack component exited unexpectedly.");
    }
    return requestedSignal === "SIGINT" ? 130 : 143;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
    await stack?.cleanup();
    if (arguments_.keepState && stack) process.stdout.write(`[state] preserved at ${stack.stateHome}\n`);
  }
}

if (resolve(process.argv[1] ?? "") === scriptPath) {
  main().then(code => {
    process.exitCode = code;
  }).catch(error => {
    process.stderr.write(safeChildOutputLine("stack", error instanceof Error ? error.message : String(error)) + "\n");
    process.exitCode = 1;
  });
}
