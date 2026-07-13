import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type HeadlessBrowserMode = "proxy" | "direct";

export type HeadlessBrowserHarness = {
  mode: HeadlessBrowserMode;
  bridgeUrl: string;
  webUrl: string;
  pairingUrl: string;
  workspacePath: string;
  workspaceName: string;
  assertNoCredentialLeaks(): Promise<void>;
  stop(): Promise<void>;
};

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bridgeCliPath = join(repositoryRoot, "apps", "bridge", "src", "cli.ts");
const vitePath = join(repositoryRoot, "apps", "web", "node_modules", "vite", "bin", "vite.js");
const webRoot = join(repositoryRoot, "apps", "web");
const fakeCodexPath = join(repositoryRoot, "tests", "fixtures", "fake-codex.mjs");
const EXPECTED_HEALTH = {
  ok: true,
  service: "hunsu-bridge",
  version: "0.2.0-next.11",
  protocolVersion: "local-bridge-v1",
  deploymentProfile: "production"
};

export async function startHeadlessBrowserHarness(mode: HeadlessBrowserMode): Promise<HeadlessBrowserHarness> {
  const root = await mkdtemp(join(tmpdir(), `hunsu-browser-${mode}-`));
  const hunsuHome = join(root, "home");
  const workspacePath = join(root, `workspace-${mode}`);
  const workspaceName = basename(workspacePath);
  const { bridgePort, webPort } = await allocatePorts();
  const bridgeUrl = `http://127.0.0.1:${bridgePort}`;
  const webUrl = mode === "proxy"
    ? `http://hunsu.localhost:${webPort}`
    : `http://127.0.0.1:${webPort}`;
  const children: ChildProcess[] = [];
  const childOutput = new Map<ChildProcess, string>();
  let stopped = false;
  let controlToken = "";
  let pairingToken = "";
  const browserCapture = await createBrowserCaptureFixture(root);

  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HUNSU_HOME: hunsuHome,
    HUNSU_BRIDGE_HOST: "127.0.0.1",
    HUNSU_BRIDGE_PORT: String(bridgePort),
    HUNSU_WEB_HOST: "127.0.0.1",
    HUNSU_WEB_PORT: String(webPort),
    HUNSU_WEB_STRICT_PORT: "true",
    HUNSU_WEB_URL: `${webUrl}/studio`,
    HUNSU_BRIDGE_ALLOWED_ORIGINS: webUrl,
    HUNSU_BRIDGE_API_PROXY_TARGET: bridgeUrl,
    VITE_HUNSU_BRIDGE_URL: mode === "direct" ? bridgeUrl : "",
    HUNSU_CODEX_APP_SERVER_COMMAND: process.execPath,
    HUNSU_CODEX_APP_SERVER_ARGS: JSON.stringify([fakeCodexPath, "app-server", "--stdio"]),
    HUNSU_FAKE_CODEX_MODE: "ready",
    HUNSU_E2E_BROWSER_CAPTURE_PATH: browserCapture.urlFile,
    PATH: [browserCapture.binDirectory, process.env.PATH].filter(Boolean).join(delimiter),
    NODE_OPTIONS: [
      process.env.NODE_OPTIONS,
      "--conditions=development",
      "--experimental-transform-types"
    ].filter(Boolean).join(" ")
  };

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await Promise.all(children.map(terminateChildTree));
    await rm(root, { recursive: true, force: true });
  };

  try {
    const bridge = spawn(process.execPath, [
      "--experimental-transform-types",
      "--conditions=development",
      bridgeCliPath,
      "dev",
      "--host", "127.0.0.1",
      "--port", String(bridgePort),
      "--home", hunsuHome,
      "--web-url", `${webUrl}/studio`,
      "--json"
    ], childOptions(environment));
    children.push(bridge);
    captureChildOutput(bridge, childOutput);
    await waitForExactHealth(bridgeUrl, bridge, childOutput);

    const credentials = JSON.parse(await readFile(join(hunsuHome, "credentials.json"), "utf8")) as {
      controlToken?: unknown;
    };
    if (typeof credentials.controlToken !== "string" || !credentials.controlToken) {
      throw new Error("Bridge browser harness could not read its temporary control credential.");
    }
    controlToken = credentials.controlToken;

    const vite = spawn(process.execPath, [
      "--conditions=development",
      "--experimental-transform-types",
      vitePath,
      webRoot,
      "--configLoader", "native",
      "--host", "127.0.0.1",
      "--port", String(webPort),
      "--strictPort"
    ], childOptions(environment));
    children.push(vite);
    captureChildOutput(vite, childOutput);
    await waitForHttp(`http://127.0.0.1:${webPort}`, vite, childOutput);

    const pairingCommand = await runBridgeCli(["open", "--home", hunsuHome, "--json"], environment);
    if (pairingCommand.exitCode !== 0) {
      throw new Error(`hunsu-bridge open failed with exit code ${pairingCommand.exitCode}.`);
    }
    const pairingResult = parseStrictCliResult(pairingCommand.stdout);
    if (pairingResult.ok !== true || pairingResult.code !== "OK") {
      throw new Error("hunsu-bridge open did not return the successful CLI pairing contract.");
    }
    if (/pairingUrl|credential|hunsuBridgeToken|hunsu_bridge_pair_/iu.test(pairingCommand.stdout)) {
      throw new Error("hunsu-bridge open exposed browser pairing credential material in CLI output.");
    }
    const pairingUrl = await waitForCapturedBrowserUrl(browserCapture.urlFile);
    pairingToken = new URL(pairingUrl).searchParams.get("hunsuBridgeToken") ?? "";
    if (!pairingToken) throw new Error("hunsu-bridge open did not launch a browser pairing URL.");

    return {
      mode,
      bridgeUrl,
      webUrl,
      pairingUrl,
      workspacePath,
      workspaceName,
      async assertNoCredentialLeaks() {
        const headers = { "x-hunsu-bridge-control-token": controlToken };
        const [doctor, logs] = await Promise.all([
          fetch(new URL("/v1/control/doctor", bridgeUrl), { headers }),
          fetch(new URL("/v1/control/logs", bridgeUrl), { headers })
        ]);
        if (!doctor.ok || !logs.ok) throw new Error("Bridge diagnostics were unavailable to the browser harness.");
        const diagnosticText = `${JSON.stringify(await doctor.json())}\n${JSON.stringify(await logs.json())}`;
        const logDirectory = join(hunsuHome, "logs");
        const persisted = await readdir(logDirectory)
          .then(files => Promise.all(files.map(file => readFile(join(logDirectory, file), "utf8"))))
          .then(files => files.join("\n"));
        const evidence = `${diagnosticText}\n${persisted}`;
        if (evidence.includes(controlToken) || evidence.includes(pairingToken)) {
          throw new Error("Bridge diagnostics contained a browser or control credential.");
        }
        if (/\bhunsu_(?:bridge|control|pairing|connect)_[A-Za-z0-9_-]+\b/iu.test(evidence)
          || /authorization\s*[=:]\s*Bearer\s+(?!\[redacted\])/iu.test(evidence)) {
          throw new Error("Bridge diagnostics contained unsanitized credential material.");
        }
      },
      stop
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function createBrowserCaptureFixture(root: string): Promise<{ binDirectory: string; urlFile: string }> {
  const binDirectory = join(root, "browser-bin");
  const urlFile = join(root, "browser-url.txt");
  const captureModule = join(binDirectory, "capture-browser.mjs");
  await mkdir(binDirectory, { recursive: true });
  const captureSource = [
    "import { writeFileSync } from \"node:fs\";",
    "const outputPath = process.env.HUNSU_E2E_BROWSER_CAPTURE_PATH;",
    "const browserUrl = process.argv.at(-1);",
    "if (!outputPath || !browserUrl) process.exit(2);",
    "writeFileSync(outputPath, `${browserUrl}\\n`, \"utf8\");",
    ""
  ].join("\n");
  await writeFile(captureModule, captureSource, "utf8");
  const executableSource = `#!/usr/bin/env node\n${captureSource}`;
  const posixOpeners = [join(binDirectory, "xdg-open"), join(binDirectory, "open")];
  await Promise.all(posixOpeners.map(async path => {
    await writeFile(path, executableSource, "utf8");
    await chmod(path, 0o755);
  }));
  await writeFile(join(binDirectory, "cmd.cmd"), "@node \"%~dp0capture-browser.mjs\" %*\r\n", "utf8");
  return { binDirectory, urlFile };
}

async function runBridgeCli(
  args: string[],
  environment: NodeJS.ProcessEnv
): Promise<{ exitCode: number | null; stdout: string }> {
  const child = spawn(process.execPath, [
    "--experimental-transform-types",
    "--conditions=development",
    bridgeCliPath,
    ...args
  ], {
    ...childOptions(environment),
    detached: false
  });
  let stdout = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", chunk => { stdout += String(chunk); });
  await new Promise<void>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", () => resolveExit());
  });
  return { exitCode: child.exitCode, stdout };
}

function parseStrictCliResult(stdout: string): { schema?: unknown; ok?: unknown; code?: unknown } {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim());
  } catch (_error) {
    throw new Error("hunsu-bridge open did not emit exactly one JSON result.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (value as { schema?: unknown }).schema !== "hunsu.bridge.cli-result.v1") {
    throw new Error("hunsu-bridge open emitted an invalid CLI result schema.");
  }
  return value as { schema?: unknown; ok?: unknown; code?: unknown };
}

async function waitForCapturedBrowserUrl(path: string, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = (await readFile(path, "utf8")).trim();
      if (value) return value;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
    }
    await delay(25);
  }
  throw new Error("hunsu-bridge open did not invoke the browser command before the test timeout.");
}

async function allocatePorts(): Promise<{ bridgePort: number; webPort: number }> {
  const bridgePort = await allocatePort();
  let webPort = await allocatePort();
  while (webPort === bridgePort) webPort = await allocatePort();
  return { bridgePort, webPort };
}

async function allocatePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Browser harness could not allocate a local port.");
  await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  return address.port;
}

function childOptions(env: NodeJS.ProcessEnv) {
  return {
    cwd: repositoryRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"] as const,
    detached: process.platform !== "win32",
    windowsHide: true
  };
}

function captureChildOutput(child: ChildProcess, output: Map<ChildProcess, string>): void {
  output.set(child, "");
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding("utf8");
    stream?.on("data", chunk => {
      const current = `${output.get(child) ?? ""}${sanitizeOutput(String(chunk))}`;
      output.set(child, current.slice(-24_000));
    });
  }
}

async function waitForExactHealth(
  baseUrl: string,
  child: ChildProcess,
  output: Map<ChildProcess, string>,
  timeoutMs = 20_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    assertChildRunning(child, output, "Bridge");
    try {
      const response = await fetch(new URL("/health", baseUrl), { signal: AbortSignal.timeout(700) });
      const body = await response.json();
      if (response.ok && JSON.stringify(body) === JSON.stringify(EXPECTED_HEALTH)) return;
    } catch (_error) {
      // The daemon may still be binding its random port.
    }
    await delay(75);
  }
  throw new Error("Bridge browser harness timed out waiting for the exact health contract.");
}

async function waitForHttp(
  url: string,
  child: ChildProcess,
  output: Map<ChildProcess, string>,
  timeoutMs = 20_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    assertChildRunning(child, output, "Web server");
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(700), redirect: "manual" });
      if (response.status >= 200 && response.status < 500) return;
    } catch (_error) {
      // Vite may still be loading its native TypeScript config.
    }
    await delay(75);
  }
  throw new Error("Bridge browser harness timed out waiting for Vite.");
}

function assertChildRunning(child: ChildProcess, output: Map<ChildProcess, string>, label: string): void {
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(`${label} exited before browser readiness.\n${output.get(child) ?? ""}`);
  }
}

async function terminateChildTree(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
    releaseChildHandles(child);
    return;
  }
  if (process.platform === "win32") {
    await new Promise<void>(resolveKill => {
      const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true
      });
      killer.once("error", () => resolveKill());
      killer.once("exit", () => resolveKill());
    });
    releaseChildHandles(child);
    return;
  }
  signalGroup(child.pid, "SIGTERM");
  await waitForExitWithin(child, 2_000);
  if (child.exitCode === null && child.signalCode === null) {
    signalGroup(child.pid, "SIGKILL");
    await waitForExitWithin(child, 500);
  }
  releaseChildHandles(child);
}

function releaseChildHandles(child: ChildProcess): void {
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH")) throw error;
  }
}

function waitForExitWithin(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolveExit => {
    const finish = (exited: boolean) => {
      clearTimeout(timeout);
      child.removeListener("exit", onExit);
      resolveExit(exited);
    };
    const onExit = () => finish(true);
    const timeout = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}

function sanitizeOutput(value: string): string {
  return value
    .replace(/([?&](?:hunsuBridgeToken|token|authorization)=)[^&#\s]+/giu, "$1[redacted]")
    .replace(/\bhunsu_(?:bridge|control|pairing|connect)_[A-Za-z0-9_-]+\b/giu, "[redacted]")
    .replace(/(Bearer\s+)[^\s,"']+/giu, "$1[redacted]");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));
}
