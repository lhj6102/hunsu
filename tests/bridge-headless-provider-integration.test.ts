import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createBridgeControlClient } from "../apps/bridge/src/client/controlClient.ts";
import { startBridgeDaemon, type RunningBridgeDaemon } from "../apps/bridge/src/daemon/daemon.ts";

const execFileAsync = promisify(execFile);
const testsDirectory = dirname(fileURLToPath(import.meta.url));
const fakeCodexPath = join(testsDirectory, "fixtures", "fake-codex.mjs");

test("provider control updates immediately drive browser inventory and Execute", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "hunsu-headless-live-provider-"));
  const repository = join(root, "workspace");
  let pairingUrl = "";
  let daemon: RunningBridgeDaemon | undefined;
  try {
    await initializeRepository(repository);
    const configuredCodexPath = await createFakeCodexExecutable(root);
    daemon = await startBridgeDaemon({
      home: join(root, "state"),
      port: 0,
      cwd: repository,
      webUrl: "http://localhost:5173/studio",
      development: true,
      env: {
        PATH: join(root, "missing-provider-path"),
        HUNSU_BRIDGE_TEST_RUNNER: "",
        HUNSU_CODEX_BINARY_PATH: "",
        HUNSU_CODEX_APP_SERVER_COMMAND: "codex",
        HUNSU_CODEX_APP_SERVER_ARGS: "[\"app-server\",\"--stdio\"]",
        HUNSU_FAKE_CODEX_MODE: "ready",
        HUNSU_FAKE_CODEX_RESPONSE: "Provider runner reached the configured fake Codex binary."
      },
      openBrowser: async url => { pairingUrl = url; }
    });
    const client = createBridgeControlClient({ paths: daemon.paths });
    const added = await client.request<{ workspaceId: string }>("/v1/control/workspaces", {
      method: "POST",
      body: { path: repository, displayName: "Live Provider Workspace" }
    });
    assert.equal(added.ok, true, JSON.stringify(added));

    const paired = await client.request("/v1/control/pair", {
      method: "POST",
      body: { openBrowser: true }
    });
    assert.equal(paired.ok, true, JSON.stringify(paired));
    const pairingCredential = new URL(pairingUrl).searchParams.get("hunsuBridgeToken");
    assert.ok(pairingCredential);
    const browserHeaders = {
      authorization: `Bearer ${pairingCredential}`,
      "content-type": "application/json"
    };

    const before = await requestJson(daemon.identity.endpoint, "/api/providers/inventory", {
      headers: browserHeaders
    });
    assert.equal(before.response.status, 200);
    assert.equal(inventoryReady(before.body), false, JSON.stringify(before.body));

    const configured = await client.request("/v1/control/provider", {
      method: "PUT",
      timeoutMs: 20_000,
      body: { providerId: "codex", binaryPath: configuredCodexPath }
    });
    assert.equal(configured.ok, true, JSON.stringify(configured));

    const after = await requestJson(daemon.identity.endpoint, "/api/providers/inventory", {
      headers: browserHeaders
    });
    assert.equal(after.response.status, 200);
    assert.equal(inventoryReady(after.body), true, JSON.stringify(after.body));

    const seeded = await requestJson(daemon.identity.endpoint, "/api/commands", {
      method: "POST",
      headers: browserHeaders,
      body: JSON.stringify({
        type: "CreateInitialTeam",
        requestId: "req_live_provider",
        lineId: "run/req_live_provider",
        title: "Live provider",
        goal: "Use the provider selected through authenticated control.",
        destinations: [{ id: "destination_001", title: "Run configured fake Codex" }]
      })
    });
    assert.equal(seeded.response.status, 202, JSON.stringify(seeded.body));

    const started = await requestJson(daemon.identity.endpoint, "/api/runs/start", {
      method: "POST",
      headers: browserHeaders,
      body: JSON.stringify({
        requestId: "req_live_provider",
        lineId: "run/req_live_provider",
        selectedDestinationIds: ["destination_001"]
      })
    });
    assert.equal(started.response.status, 202, JSON.stringify(started.body));

    const sessions = await waitForProviderSession(daemon.identity.endpoint, browserHeaders);
    assert.equal(
      sessions.some(session => session.provider?.providerThreadId?.startsWith("fake-thread-")),
      true,
      JSON.stringify(sessions)
    );
  } finally {
    await daemon?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("persisted provider configuration drives Execute immediately after daemon restart", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "hunsu-headless-restarted-provider-"));
  const repository = join(root, "workspace");
  const home = join(root, "state");
  let firstDaemon: RunningBridgeDaemon | undefined;
  let restartedDaemon: RunningBridgeDaemon | undefined;
  try {
    await initializeRepository(repository);
    const configuredCodexPath = await createFakeCodexExecutable(root);
    firstDaemon = await startBridgeDaemon({
      home,
      port: 0,
      cwd: repository,
      webUrl: "http://localhost:5173/studio",
      development: true,
      env: isolatedProviderEnvironment(root),
      openBrowser: async () => undefined
    });
    const firstClient = createBridgeControlClient({ paths: firstDaemon.paths });
    const added = await firstClient.request<{ workspaceId: string }>("/v1/control/workspaces", {
      method: "POST",
      body: { path: repository, displayName: "Restarted Provider Workspace" }
    });
    assert.equal(added.ok, true, JSON.stringify(added));
    const configured = await firstClient.request("/v1/control/provider", {
      method: "PUT",
      timeoutMs: 20_000,
      body: { providerId: "codex", binaryPath: configuredCodexPath }
    });
    assert.equal(configured.ok, true, JSON.stringify(configured));
    await firstDaemon.close();
    firstDaemon = undefined;

    let pairingUrl = "";
    restartedDaemon = await startBridgeDaemon({
      home,
      cwd: repository,
      webUrl: "http://localhost:5173/studio",
      development: true,
      env: isolatedProviderEnvironment(root),
      openBrowser: async url => { pairingUrl = url; }
    });
    const restartedClient = createBridgeControlClient({ paths: restartedDaemon.paths });
    const paired = await restartedClient.request("/v1/control/pair", {
      method: "POST",
      body: { openBrowser: true }
    });
    assert.equal(paired.ok, true, JSON.stringify(paired));
    const pairingCredential = new URL(pairingUrl).searchParams.get("hunsuBridgeToken");
    assert.ok(pairingCredential);
    const browserHeaders = {
      authorization: `Bearer ${pairingCredential}`,
      "content-type": "application/json"
    };

    const inventory = await requestJson(restartedDaemon.identity.endpoint, "/api/providers/inventory", {
      headers: browserHeaders
    });
    assert.equal(inventory.response.status, 200);
    assert.equal(inventoryReady(inventory.body), true, JSON.stringify(inventory.body));

    const seeded = await requestJson(restartedDaemon.identity.endpoint, "/api/commands", {
      method: "POST",
      headers: browserHeaders,
      body: JSON.stringify({
        type: "CreateInitialTeam",
        requestId: "req_restarted_provider",
        lineId: "run/req_restarted_provider",
        title: "Restarted provider",
        goal: "Use the provider restored during daemon startup.",
        destinations: [{ id: "destination_001", title: "Run restored fake Codex" }]
      })
    });
    assert.equal(seeded.response.status, 202, JSON.stringify(seeded.body));

    const started = await requestJson(restartedDaemon.identity.endpoint, "/api/runs/start", {
      method: "POST",
      headers: browserHeaders,
      body: JSON.stringify({
        requestId: "req_restarted_provider",
        lineId: "run/req_restarted_provider",
        selectedDestinationIds: ["destination_001"]
      })
    });
    assert.equal(started.response.status, 202, JSON.stringify(started.body));
    const sessions = await waitForProviderSession(restartedDaemon.identity.endpoint, browserHeaders);
    assert.equal(
      sessions.some(session => session.provider?.providerThreadId?.startsWith("fake-thread-")),
      true,
      JSON.stringify(sessions)
    );
  } finally {
    await restartedDaemon?.close().catch(() => undefined);
    await firstDaemon?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

async function initializeRepository(repository: string): Promise<void> {
  await mkdir(repository, { recursive: true });
  await execFileAsync("git", ["init", "-b", "main"], { cwd: repository });
  await execFileAsync("git", ["config", "user.email", "headless-provider@example.invalid"], { cwd: repository });
  await execFileAsync("git", ["config", "user.name", "Headless Provider Test"], { cwd: repository });
  await writeFile(join(repository, "README.md"), "# Live provider fixture\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: repository });
  await execFileAsync("git", ["commit", "-m", "Initialize live provider fixture"], { cwd: repository });
}

async function createFakeCodexExecutable(root: string): Promise<string> {
  const executable = join(root, "configured-fake-codex.mjs");
  await writeFile(executable, [
    `#!${process.execPath}`,
    `import { runFakeCodex } from ${JSON.stringify(pathToFileURL(fakeCodexPath).href)};`,
    "const lifetime = setTimeout(() => process.exit(0), 2_000);",
    "runFakeCodex().then(code => { clearTimeout(lifetime); process.exitCode = code; }).catch(error => {",
    "  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\\n`);",
    "  process.exitCode = 1;",
    "});",
    ""
  ].join("\n"), "utf8");
  await chmod(executable, 0o700);
  return executable;
}

function isolatedProviderEnvironment(root: string): Record<string, string> {
  return {
    PATH: join(root, "missing-provider-path"),
    HUNSU_BRIDGE_TEST_RUNNER: "",
    HUNSU_CODEX_BINARY_PATH: "",
    HUNSU_CODEX_APP_SERVER_COMMAND: "codex",
    HUNSU_CODEX_APP_SERVER_ARGS: "[\"app-server\",\"--stdio\"]",
    HUNSU_FAKE_CODEX_MODE: "ready",
    HUNSU_FAKE_CODEX_RESPONSE: "Provider runner reached the configured fake Codex binary."
  };
}

async function requestJson(
  endpoint: string,
  path: string,
  init: RequestInit
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await fetch(`${endpoint}${path}`, init);
  return { response, body: await response.json() as Record<string, unknown> };
}

function inventoryReady(body: Record<string, unknown>): boolean | undefined {
  return (body as {
    value?: { providers?: Array<{ ready?: boolean }> };
  }).value?.providers?.[0]?.ready;
}

async function waitForProviderSession(
  endpoint: string,
  headers: Record<string, string>
): Promise<Array<{ provider?: { providerThreadId?: string } }>> {
  let sessions: Array<{ provider?: { providerThreadId?: string } }> = [];
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const snapshot = await requestJson(endpoint, "/api/agent-sessions", { headers });
    const candidate = snapshot.body as { sessions?: Array<{ provider?: { providerThreadId?: string } }> };
    sessions = Array.isArray(candidate.sessions) ? candidate.sessions : [];
    if (sessions.some(session => session.provider?.providerThreadId?.startsWith("fake-thread-"))) {
      return sessions;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return sessions;
}
