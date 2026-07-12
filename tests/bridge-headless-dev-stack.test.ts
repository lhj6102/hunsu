import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const devStackPath = join(repositoryRoot, "scripts", "dev-stack.mjs");
const scenarioSmokePath = join(repositoryRoot, "scripts", "headless-scenario-smoke.mjs");
const serviceSmokePath = join(repositoryRoot, "scripts", "bridge-service-smoke.mjs");
const verifyBridgePath = join(repositoryRoot, "scripts", "verify-bridge.mjs");
const evidenceValidatorPath = join(repositoryRoot, "scripts", "validate-bridge-production-evidence.mjs");
const fakeCodexPath = join(repositoryRoot, "tests", "fixtures", "fake-codex.mjs");
const fakeRelayPath = join(repositoryRoot, "tests", "fixtures", "fake-relay.mjs");

test("development scripts have valid Node syntax and safe helper contracts", async () => {
  await Promise.all([
    devStackPath,
    scenarioSmokePath,
    serviceSmokePath,
    verifyBridgePath,
    evidenceValidatorPath,
    fakeCodexPath,
    fakeRelayPath
  ].map(path =>
    execFileAsync(process.execPath, ["--check", path])
  ));
  const stackModuleUrl = pathToFileURL(devStackPath).href;
  const stack = await import(stackModuleUrl) as {
    allocateFreePort(host?: string): Promise<number>;
    isExactBridgeHealth(value: unknown): boolean;
    resolveDevelopmentWebHost(lookupImpl?: unknown): Promise<string>;
    safeChildOutputLine(component: string, line: string): string;
  };

  const port = await stack.allocateFreePort();
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", resolveListen);
  });
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close(error => error ? rejectClose(error) : resolveClose());
  });

  assert.equal(stack.isExactBridgeHealth({
    ok: true,
    service: "hunsu-bridge",
    version: "0.2.0-next.1",
    protocolVersion: "local-bridge-v1"
  }), true);
  assert.equal(stack.isExactBridgeHealth({
    ok: true,
    service: "hunsu-bridge",
    version: "0.2.0-next.1",
    protocolVersion: "local-bridge-v1",
    daemonPid: 123
  }), false);
  assert.equal(
    await stack.resolveDevelopmentWebHost((_hostname: string, _options: unknown, callback: (error: null, address: string) => void) => {
      callback(null, "127.0.0.1");
    }),
    "hunsu.localhost"
  );
  assert.equal(
    await stack.resolveDevelopmentWebHost((_hostname: string, _options: unknown, callback: (error: Error) => void) => {
      callback(new Error("fixture lookup failure"));
    }),
    "127.0.0.1"
  );
  const safe = stack.safeChildOutputLine(
    "bridge",
    "http://localhost/?hunsuBridgeToken=hunsu_bridge_pair_secret Authorization=Bearer secret hunsu_control_secret"
  );
  assert.match(safe, /^\[bridge\] /u);
  assert.equal(safe.includes("hunsu_bridge_pair_secret"), false);
  assert.equal(safe.includes("hunsu_control_secret"), false);
  assert.equal(safe.includes("Bearer secret"), false);
});

test("Bridge verification budget and production evidence contracts are explicit and safe", async () => {
  const verify = await import(pathToFileURL(verifyBridgePath).href) as {
    verificationBudget(env?: Record<string, string>): { targetMs: number; thresholdMs: number; limitMs: number };
    parseVerifyArguments(argv?: string[]): { help: boolean; enforceBudget: boolean };
  };
  assert.deepEqual(verify.verificationBudget({}), {
    targetMs: 300_000,
    thresholdMs: 30_000,
    limitMs: 330_000
  });
  assert.deepEqual(verify.parseVerifyArguments(["--enforce-budget"]), { help: false, enforceBudget: true });

  const evidence = await import(pathToFileURL(evidenceValidatorPath).href) as {
    validateProductionEvidence(input: Record<string, string>): Record<string, unknown>;
  };
  const record = evidence.validateProductionEvidence({
    npmVersion: "0.2.0-next.1",
    npmIntegrity: `sha512-${"a".repeat(86)}==`,
    npmProvenanceUrl: "https://registry.example.test/provenance/bridge-next-1",
    evidenceUrl: "https://evidence.example.test/bridge-next-1",
    hunsuAppDeployment: "https://hunsu.app/deployments/bridge-next-1",
    codexVersion: "codex-cli 1.2.3",
    relayEnvironment: "production-qa",
    workspaceFixtureId: "ws_disposable_001",
    platformEvidence: JSON.stringify({
      windows: { os: "windows-latest", node: "22.18.0", serviceManager: "Task Scheduler" },
      macos: { os: "macos-latest", node: "22.18.0", serviceManager: "LaunchAgent" },
      linux: { os: "ubuntu-latest", node: "22.18.0", serviceManager: "systemd --user" }
    })
  });
  assert.equal(record.schema, "hunsu.bridge.production-evidence.v1");
  assert.throws(() => evidence.validateProductionEvidence({
    npmVersion: "0.2.0-next.1",
    npmIntegrity: "sha512-YQ==",
    npmProvenanceUrl: "https://registry.example.test/provenance/bridge-next-1",
    evidenceUrl: "https://evidence.example.test/bridge-next-1",
    hunsuAppDeployment: "https://hunsu.app/deployments/bridge-next-1",
    codexVersion: "codex-cli 1.2.3",
    relayEnvironment: "production-qa",
    workspaceFixtureId: "ws_disposable_001",
    platformEvidence: JSON.stringify({
      windows: { os: "windows-latest", node: "22.18.0", serviceManager: "Task Scheduler" },
      macos: { os: "macos-latest", node: "22.18.0", serviceManager: "LaunchAgent" },
      linux: { os: "ubuntu-latest", node: "22.18.0", serviceManager: "systemd --user" }
    })
  }));
  assert.throws(() => evidence.validateProductionEvidence({
    npmVersion: "0.2.0-next.1",
    npmIntegrity: "sha512-invalid",
    npmProvenanceUrl: "https://example.test/?token=secret",
    evidenceUrl: "https://example.test/evidence",
    hunsuAppDeployment: "https://hunsu.app",
    codexVersion: "codex-cli 1.2.3",
    relayEnvironment: "production-qa",
    workspaceFixtureId: "ws_disposable_001",
    platformEvidence: "{}"
  }));
});

test("fake Codex provides version, readiness, login-required, unsupported-model, and controlled app-server responses", async () => {
  const version = await execFileAsync(process.execPath, [fakeCodexPath, "--version"]);
  assert.equal(version.stdout.trim(), "codex-cli 0.0.0-fake");

  const ready = createJsonRpcFixture(["app-server", "--stdio", "--response", "controlled fixture response"]);
  try {
    const initialized = await ready.request("initialize", { clientInfo: { name: "test" } });
    assert.equal(initialized.result.serverInfo.name, "hunsu-fake-codex");
    const account = await ready.request("account/read", { refreshToken: false });
    assert.equal(account.result.account.email, "fixture@example.invalid");
    const thread = await ready.request("thread/start", { model: "fake-codex-model" });
    assert.match(thread.result.thread.id, /^fake-thread-/u);
    const turn = await ready.request("turn/start", { threadId: thread.result.thread.id });
    assert.equal(turn.result.turn.status, "completed");
    assert.equal(turn.result.turn.items[0].text, "controlled fixture response");
  } finally {
    await ready.close();
  }

  const loginRequired = createJsonRpcFixture(["app-server", "--mode", "login-required"]);
  try {
    await loginRequired.request("initialize");
    const account = await loginRequired.request("account/read");
    assert.equal(account.error.code, -32001);
    assert.match(account.error.message, /login is required/iu);
  } finally {
    await loginRequired.close();
  }

  const unsupported = createJsonRpcFixture(["app-server", "--mode=unsupported-model"]);
  try {
    await unsupported.request("initialize");
    const thread = await unsupported.request("thread/start", { model: "not-supported" });
    assert.equal(thread.error.code, -32002);
    assert.match(thread.error.message, /unsupported/iu);
  } finally {
    await unsupported.close();
  }
});

test("fake Relay supports deterministic device login, registration, commands, disconnect, and reconnect", { timeout: 15_000 }, async t => {
  const relay = spawn(process.execPath, [fakeRelayPath, "--port", "0", "--json"], {
    cwd: repositoryRoot,
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(async () => {
    if (relay.exitCode === null && relay.signalCode === null) relay.kill("SIGTERM");
    await waitForExit(relay).catch(() => undefined);
  });
  const readyLine = await readFirstLine(relay.stdout);
  assert.equal(/token|credential|authorization/iu.test(readyLine), false);
  const ready = JSON.parse(readyLine) as { ready: boolean; url: string };
  assert.equal(ready.ready, true);

  const deviceCodeResponse = await fetch(`${ready.url}/oauth/device/code`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: "hunsu-bridge", device_id: "fixture-device" })
  });
  const deviceCode = await deviceCodeResponse.json() as {
    device_code: string;
    user_code: string;
    verification_uri: string;
  };
  assert.match(deviceCode.user_code, /^HUNSU-/u);
  assert.match(deviceCode.verification_uri, /^http:\/\/127\.0\.0\.1:/u);

  const pending = await requestDeviceToken(ready.url, deviceCode.device_code);
  assert.equal(pending.response.status, 400);
  assert.equal(pending.body.error, "authorization_pending");

  const approval = await fetch(`${ready.url}/__fixture/device/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceCode: deviceCode.device_code })
  });
  assert.equal(approval.status, 200);
  const authorized = await requestDeviceToken(ready.url, deviceCode.device_code);
  assert.equal(authorized.response.status, 200);
  assert.match(authorized.body.access_token, /^fake-account-access-/u);

  const registration = await fetch(`${ready.url}/v1/devices`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${authorized.body.access_token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      device: {
        deviceId: "fixture-device",
        deviceName: "Fixture Bridge",
        userId: "fixture-user",
        protocolVersion: "local-bridge-v1"
      },
      workspaces: [{ workspaceId: "ws_fixture", displayName: "Fixture" }],
      projectGrants: []
    })
  });
  assert.equal(registration.status, 202);

  const command = { name: "bridge.status", payload: { fixture: true } };
  const firstRoundTrip = await postJson(`${ready.url}/v1/commands`, {
    deviceId: "fixture-device",
    command
  });
  assert.equal(firstRoundTrip.response.status, 200);
  assert.deepEqual(firstRoundTrip.body.result.echoed, command);

  await fetch(`${ready.url}/__fixture/disconnect`, { method: "POST" });
  const disconnected = await fetch(`${ready.url}/v1/remote/status`).then(response => response.json()) as { connected: boolean };
  assert.equal(disconnected.connected, false);
  const failedRoundTrip = await postJson(`${ready.url}/v1/commands`, { deviceId: "fixture-device", command });
  assert.equal(failedRoundTrip.response.status, 503);

  await fetch(`${ready.url}/__fixture/reconnect`, { method: "POST" });
  const secondRoundTrip = await postJson(`${ready.url}/v1/commands`, { deviceId: "fixture-device", command });
  assert.equal(secondRoundTrip.response.status, 200);
});

test("dev stack launches isolated Bridge and Web processes with all same-origin proxy paths", { timeout: 35_000 }, async t => {
  const stack = spawn(process.execPath, [
    "--no-warnings",
    "--conditions=development",
    "--experimental-transform-types",
    devStackPath
  ], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  stack.stdout.setEncoding("utf8");
  stack.stderr.setEncoding("utf8");
  stack.stdout.on("data", chunk => { output += chunk; });
  stack.stderr.on("data", chunk => { output += chunk; });
  t.after(async () => {
    if (stack.exitCode === null && stack.signalCode === null) stack.kill("SIGTERM");
    await waitForExit(stack).catch(() => undefined);
  });

  await waitForOutput(stack, () => output, /^\[state\] .+$/mu, 25_000);
  const bridgeUrl = output.match(/^\[bridge\] ready at (http:\/\/\S+)$/mu)?.[1];
  const webUrl = output.match(/^\[web\] ready at (http:\/\/\S+)$/mu)?.[1];
  const relayUrl = output.match(/^\[relay\] ready at (http:\/\/\S+)$/mu)?.[1];
  const stateHome = output.match(/^\[state\] (.+)$/mu)?.[1];
  assert.ok(bridgeUrl);
  assert.ok(webUrl);
  assert.ok(relayUrl);
  assert.ok(stateHome);
  await access(stateHome);

  const expectedHealth = {
    ok: true,
    service: "hunsu-bridge",
    version: "0.2.0-next.1",
    protocolVersion: "local-bridge-v1"
  };
  assert.deepEqual(await fetch(`${bridgeUrl}/health`).then(response => response.json()), expectedHealth);
  assert.deepEqual(await fetch(`${webUrl}/health`).then(response => response.json()), expectedHealth);
  assert.deepEqual(await fetch(`${webUrl}/__bridge/health`).then(response => response.json()), expectedHealth);
  assert.deepEqual(await fetch(`${relayUrl}/health`).then(response => response.json()), {
    ok: true,
    service: "hunsu-relay",
    issuer: relayUrl
  });
  const apiResponse = await fetch(`${webUrl}/api/roadmaps/recent`);
  assert.notEqual(apiResponse.status, 404);

  assert.equal(/hunsu_(?:bridge|control|pairing|relay)_[A-Za-z0-9_-]+/iu.test(output), false);
  assert.match(output, /^\[bridge\] /mu);
  assert.match(output, /^\[web\] /mu);
  assert.match(output, /^\[relay\] /mu);
  assert.match(output, /^\[timing\] daemon ready: \d+ ms$/mu);
  assert.match(output, /^\[timing\] Web ready: \d+ ms$/mu);

  stack.kill("SIGTERM");
  await waitForExit(stack);
  await assert.rejects(access(stateHome), error =>
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
});

function createJsonRpcFixture(args: string[]) {
  const child = spawn(process.execPath, [fakeCodexPath, ...args], {
    cwd: repositoryRoot,
    stdio: ["pipe", "pipe", "pipe"]
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  let id = 0;
  return {
    async request(method: string, params?: unknown): Promise<any> {
      const requestId = ++id;
      child.stdin.write(`${JSON.stringify({ id: requestId, method, ...(params === undefined ? {} : { params }) })}\n`);
      const next = await withTimeout(iterator.next(), 3_000, `Fake Codex timed out for ${method}.`);
      if (next.done) throw new Error("Fake Codex exited before replying.");
      const response = JSON.parse(next.value) as { id?: unknown };
      assert.equal(response.id, requestId);
      return response;
    },
    async close() {
      child.stdin.end();
      await waitForExit(child);
      lines.close();
    }
  };
}

async function requestDeviceToken(baseUrl: string, deviceCode: string): Promise<{ response: Response; body: any }> {
  const response = await fetch(`${baseUrl}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: "hunsu-bridge",
      device_code: deviceCode,
      device_id: "fixture-device"
    })
  });
  return { response, body: await response.json() };
}

async function postJson(url: string, value: unknown): Promise<{ response: Response; body: any }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value)
  });
  return { response, body: await response.json() };
}

function readFirstLine(stream: NodeJS.ReadableStream): Promise<string> {
  const lines = createInterface({ input: stream });
  return new Promise((resolveLine, rejectLine) => {
    lines.once("line", line => {
      lines.close();
      resolveLine(line);
    });
    stream.once("error", rejectLine);
  });
}

async function waitForOutput(
  child: ReturnType<typeof spawn>,
  output: () => string,
  pattern: RegExp,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pattern.test(output())) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Development stack exited before readiness:\n${output()}`);
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Development stack readiness timed out:\n${output()}`);
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolveValue, rejectValue) => {
    const timer = setTimeout(() => rejectValue(new Error(message)), timeoutMs);
    promise.then(
      value => {
        clearTimeout(timer);
        resolveValue(value);
      },
      error => {
        clearTimeout(timer);
        rejectValue(error);
      }
    );
  });
}
