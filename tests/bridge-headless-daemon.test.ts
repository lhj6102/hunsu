import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBridgeControlClient } from "../apps/bridge/src/client/controlClient.ts";
import { BridgeError } from "../apps/bridge/src/client/cliResult.ts";
import {
  rotateDaemonControlCredential,
  startBridgeDaemon,
  type RunningBridgeDaemon
} from "../apps/bridge/src/daemon/daemon.ts";
import { acquireDaemonStartupLock } from "../apps/bridge/src/daemon/singleton.ts";
import { createStructuredLog, STRUCTURED_LOG_SCHEMA } from "../apps/bridge/src/diagnostics/structuredLog.ts";
import { createPairingService } from "../apps/bridge/src/pairing/pairingService.ts";
import { createCredentialStore } from "../apps/bridge/src/state/credentialStore.ts";
import { resolveHunsuPaths } from "../apps/bridge/src/state/paths.ts";
import { HUNSU_BRIDGE_VERSION } from "../apps/bridge/src/version.ts";

test("the daemon exposes the exact health contract, rejects unauthenticated control, and status is read-only", async () => {
  await withDaemon(async daemon => {
    const health = await fetch(`${daemon.identity.endpoint}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      ok: true,
      service: "hunsu-bridge",
      version: HUNSU_BRIDGE_VERSION,
      protocolVersion: "local-bridge-v1"
    });

    const unauthorized = await fetch(`${daemon.identity.endpoint}/v1/control/status`);
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(await unauthorized.json(), {
      schema: "hunsu.bridge.cli-result.v1",
      ok: false,
      code: "BRIDGE_CONTROL_UNAUTHORIZED",
      message: "Hunsu Bridge rejected the local control credential."
    });

    const tracked = [
      daemon.paths.configFile,
      daemon.paths.credentialsFile,
      daemon.paths.runtimeFile,
      daemon.paths.structuredLogFile
    ];
    const before = await Promise.all(tracked.map(path => readFile(path, "utf8")));
    const client = createBridgeControlClient({ paths: daemon.paths });
    const statuses = await Promise.all(Array.from({ length: 100 }, () => client.request("/v1/control/status")));
    assert.equal(statuses.every(result => result.ok), true);
    assert.equal(statuses.every(result => result.ok && result.value && (result.value as { instanceId?: string }).instanceId === daemon.identity.instanceId), true);
    assert.deepEqual(await Promise.all(tracked.map(path => readFile(path, "utf8"))), before);
    assert.equal(process.pid, daemon.identity.daemonPid);
    const doctor = await client.request<{ state?: { credentialsPresent?: unknown } }>("/v1/control/doctor");
    assert.equal(doctor.ok, true);
    if (doctor.ok) assert.equal(typeof doctor.value?.state?.credentialsPresent, "boolean");
  });
});

test("control client verifies exact loopback health before sending its credential", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunsu-headless-control-preflight-"));
  const paths = resolveHunsuPaths({ home: join(root, "state") });
  const credentials = await createCredentialStore(paths).ensure();
  let receivedToken: string | undefined;
  const foreign = createServer((request, response) => {
    receivedToken = request.headers["x-hunsu-bridge-control-token"] as string | undefined;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, service: "foreign-loopback" }));
  });
  try {
    await listen(foreign, 0);
    const address = foreign.address();
    assert.ok(address && typeof address !== "string");
    const client = createBridgeControlClient({ paths, endpoint: `http://127.0.0.1:${address.port}` });
    const result = await client.request("/v1/control/status");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "BRIDGE_NOT_RUNNING");
    assert.equal(receivedToken, undefined);
    assert.ok(credentials.controlToken);
  } finally {
    await closeServer(foreign);
    await rm(root, { recursive: true, force: true });
  }
});

test("an ambiguous post-commit rotation failure resyncs the daemon token from authoritative credentials", async () => {
  let activeControlToken = "hunsu_control_old";
  await assert.rejects(
    () => rotateDaemonControlCredential({
      credentialStore: {
        async rotateControlToken() {
          throw new Error("injected post-commit failure");
        },
        async read() {
          return {
            schema: "hunsu.bridge.credentials.v1",
            controlToken: "hunsu_control_authoritative",
            account: null,
            relay: null
          };
        }
      },
      activate: controlToken => { activeControlToken = controlToken; }
    }),
    /injected post-commit failure/u
  );
  assert.equal(activeControlToken, "hunsu_control_authoritative");
});

test("authenticated control credential rotation revokes the old token without invalidating browser pairing", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunsu-headless-control-rotation-"));
  let pairingUrl = "";
  let daemon: RunningBridgeDaemon | undefined;
  try {
    daemon = await startBridgeDaemon({
      home: join(root, "state"),
      port: 0,
      cwd: root,
      webUrl: "http://localhost:5173/studio",
      development: true,
      openBrowser: async url => { pairingUrl = url; }
    });
    const credentialStore = createCredentialStore(daemon.paths);
    const before = await credentialStore.read();
    assert.ok(before?.controlToken);
    const client = createBridgeControlClient({ paths: daemon.paths });
    const paired = await client.request("/v1/control/pair", {
      method: "POST",
      body: { openBrowser: true }
    });
    assert.equal(paired.ok, true);
    const pairingCredential = new URL(pairingUrl).searchParams.get("hunsuBridgeToken");
    assert.ok(pairingCredential);

    const rotated = await client.request("/v1/control/credential/rotate", { method: "POST" });
    assert.deepEqual(rotated, {
      schema: "hunsu.bridge.cli-result.v1",
      ok: true,
      code: "CONTROL_CREDENTIAL_ROTATED",
      message: "Hunsu Bridge control credential was rotated.",
      value: { rotated: true, pairingPreserved: true }
    });
    const after = await credentialStore.read();
    assert.ok(after?.controlToken);
    assert.notEqual(after.controlToken, before.controlToken);
    assert.equal(JSON.stringify(rotated).includes(before.controlToken), false);
    assert.equal(JSON.stringify(rotated).includes(after.controlToken), false);

    const rejectedOldToken = await fetch(`${daemon.identity.endpoint}/v1/control/status`, {
      headers: { "X-Hunsu-Bridge-Control-Token": before.controlToken }
    });
    assert.equal(rejectedOldToken.status, 401);
    assert.deepEqual(await rejectedOldToken.json(), {
      schema: "hunsu.bridge.cli-result.v1",
      ok: false,
      code: "BRIDGE_CONTROL_UNAUTHORIZED",
      message: "Hunsu Bridge rejected the local control credential."
    });
    assert.equal((await client.request("/v1/control/status")).ok, true);

    const rejectedOldCompatibilityToken = await fetch(`${daemon.identity.endpoint}/api/prerequisites`, {
      headers: { "X-Hunsu-Bridge-Control-Token": before.controlToken }
    });
    assert.equal(rejectedOldCompatibilityToken.status, 401);
    const acceptedNewCompatibilityToken = await fetch(`${daemon.identity.endpoint}/api/prerequisites`, {
      headers: { "X-Hunsu-Bridge-Control-Token": after.controlToken }
    });
    assert.equal(acceptedNewCompatibilityToken.status, 200);

    const stillPaired = await fetch(`${daemon.identity.endpoint}/api/prerequisites`, {
      headers: { authorization: `Bearer ${pairingCredential}` }
    });
    assert.equal(stillPaired.status, 200);
  } finally {
    await daemon?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy browser pairing and CLI control pairing share one rotation and revocation authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunsu-headless-pairing-authority-"));
  let openedPairingUrl = "";
  let daemon: RunningBridgeDaemon | undefined;
  try {
    daemon = await startBridgeDaemon({
      home: join(root, "state"),
      port: 0,
      cwd: root,
      webUrl: "http://localhost:5173/studio",
      development: true,
      openBrowser: async url => { openedPairingUrl = url; }
    });
    const credentials = await createCredentialStore(daemon.paths).read();
    assert.ok(credentials?.controlToken);
    const controlHeaders = {
      "content-type": "application/json",
      "x-hunsu-bridge-control-token": credentials.controlToken
    };
    const authorize = (credential: string) => fetch(`${daemon!.identity.endpoint}/api/prerequisites`, {
      headers: { authorization: `Bearer ${credential}` }
    });

    const legacyRotation = await fetch(`${daemon.identity.endpoint}/api/bridge/pairing/rotate`, {
      method: "POST",
      headers: controlHeaders,
      body: JSON.stringify({ webUrl: "http://localhost:5173/studio" })
    });
    assert.equal(legacyRotation.status, 202);
    const legacyPairing = await legacyRotation.json() as {
      authToken?: string;
      studioUrl?: string;
      pairing?: { pairingId?: string };
    };
    assert.ok(legacyPairing.authToken);
    assert.equal(new URL(legacyPairing.studioUrl ?? "").searchParams.get("hunsuBridgeToken"), legacyPairing.authToken);
    assert.match(legacyPairing.pairing?.pairingId ?? "", /^pair_/u);
    assert.equal((await authorize(legacyPairing.authToken)).status, 200);

    const client = createBridgeControlClient({ paths: daemon.paths });
    const cliRotation = await client.request("/v1/control/pair", {
      method: "POST",
      body: { openBrowser: true }
    });
    assert.equal(cliRotation.ok, true);
    const cliCredential = new URL(openedPairingUrl).searchParams.get("hunsuBridgeToken");
    assert.ok(cliCredential);
    assert.equal((await authorize(legacyPairing.authToken)).status, 401);
    assert.equal((await authorize(cliCredential)).status, 200);

    assert.equal((await client.request("/v1/control/pair/revoke", { method: "POST" })).ok, true);
    assert.equal((await authorize(cliCredential)).status, 401);

    const secondLegacyRotation = await fetch(`${daemon.identity.endpoint}/api/bridge/pairing/rotate`, {
      method: "POST",
      headers: controlHeaders,
      body: JSON.stringify({ webUrl: "http://localhost:5173/studio" })
    });
    const secondLegacyPairing = await secondLegacyRotation.json() as { authToken?: string };
    assert.ok(secondLegacyPairing.authToken);
    assert.equal((await authorize(secondLegacyPairing.authToken)).status, 200);
    const legacyRevoke = await fetch(`${daemon.identity.endpoint}/api/bridge/pairing/revoke`, {
      method: "POST",
      headers: controlHeaders
    });
    assert.equal(legacyRevoke.status, 202);
    assert.equal((await legacyRevoke.json() as { revoked?: boolean }).revoked, true);
    assert.equal((await authorize(secondLegacyPairing.authToken)).status, 401);
  } finally {
    await daemon?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("a random daemon port is propagated to the browser compatibility status", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunsu-headless-daemon-random-port-"));
  let pairingUrl = "";
  let daemon: RunningBridgeDaemon | undefined;
  try {
    daemon = await startBridgeDaemon({
      home: join(root, "state"),
      port: 0,
      cwd: root,
      webUrl: "http://localhost:5173/studio",
      development: true,
      openBrowser: async url => { pairingUrl = url; }
    });
    const assignedPort = new URL(daemon.identity.endpoint).port;
    assert.notEqual(assignedPort, "0");

    const client = createBridgeControlClient({ paths: daemon.paths });
    const paired = await client.request("/v1/control/pair", {
      method: "POST",
      body: { openBrowser: true }
    });
    assert.equal(paired.ok, true);
    const pairingCredential = new URL(pairingUrl).searchParams.get("hunsuBridgeToken");
    assert.ok(pairingCredential);

    const response = await fetch(`${daemon.identity.endpoint}/api/connection/status`, {
      headers: { authorization: `Bearer ${pairingCredential}` }
    });
    assert.equal(response.status, 200);
    const status = await response.json() as {
      bridge?: { id?: string };
      endpoint?: { apiUrl?: string };
    };
    assert.equal(status.endpoint?.apiUrl, daemon.identity.endpoint);
    assert.equal(new URL(status.endpoint?.apiUrl ?? "http://127.0.0.1:0").port, assignedPort);
    assert.equal(status.bridge?.id, `local:127.0.0.1:${assignedPort}`);
  } finally {
    await daemon?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("authenticated control owns the workspace lifecycle and pairing responses stay safe", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunsu-headless-daemon-workspace-"));
  const repository = join(root, "repository");
  await mkdir(repository);
  let pairingUrl = "";
  let daemon: RunningBridgeDaemon | undefined;
  try {
    daemon = await startBridgeDaemon({
      home: join(root, "state"),
      port: 0,
      cwd: repository,
      webUrl: "http://localhost:5173/studio",
      development: true,
      openBrowser: async url => { pairingUrl = url; }
    });
    const client = createBridgeControlClient({ paths: daemon.paths });

    const initiallyEmpty = await client.request<unknown[]>("/v1/control/workspaces");
    assert.equal(initiallyEmpty.ok, true);
    if (initiallyEmpty.ok) assert.deepEqual(initiallyEmpty.value, []);

    const added = await client.request<{ workspaceId: string; repositoryPath: string }>("/v1/control/workspaces", {
      method: "POST",
      body: { path: repository, displayName: "Disposable Workspace" }
    });
    assert.equal(added.ok, true);
    if (!added.ok || !added.value) return;
    assert.match(added.value.workspaceId, /^ws_[a-f0-9]{64}$/u);
    assert.equal(added.value.repositoryPath, repository);

    const listed = await client.request<Array<{ workspaceId: string }>>("/v1/control/workspaces");
    assert.equal(listed.ok, true);
    if (listed.ok) assert.deepEqual(listed.value?.map(workspace => workspace.workspaceId), [added.value.workspaceId]);
    const inspected = await client.request<{ workspaceId: string }>(`/v1/control/workspaces/${encodeURIComponent(added.value.workspaceId)}`);
    assert.equal(inspected.ok, true);
    if (inspected.ok) assert.equal(inspected.value?.workspaceId, added.value.workspaceId);

    const paired = await client.request<Record<string, unknown>>("/v1/control/pair", {
      method: "POST",
      body: { workspaceId: added.value.workspaceId, openBrowser: true }
    });
    assert.equal(paired.ok, true);
    assert.ok(pairingUrl);
    const pairingCredential = new URL(pairingUrl).searchParams.get("hunsuBridgeToken");
    assert.ok(pairingCredential);
    const safeJson = JSON.stringify(paired);
    assert.equal(safeJson.includes(pairingCredential), false);
    assert.equal(safeJson.includes(pairingUrl), false);
    assert.equal(/pairingUrl|credential|hunsuBridgeToken/iu.test(safeJson), false);

    const missingBearer = await fetch(`${daemon.identity.endpoint}/api/prerequisites`);
    assert.equal(missingBearer.status, 401);
    const currentBearer = await fetch(`${daemon.identity.endpoint}/api/prerequisites`, {
      headers: { authorization: `Bearer ${pairingCredential}` }
    });
    assert.equal(currentBearer.status, 200);
    const revoked = await client.request("/v1/control/pair/revoke", { method: "POST" });
    assert.equal(revoked.ok, true);
    const revokedBearer = await fetch(`${daemon.identity.endpoint}/api/prerequisites`, {
      headers: { authorization: `Bearer ${pairingCredential}` }
    });
    assert.equal(revokedBearer.status, 401);

    const removed = await client.request(`/v1/control/workspaces/${encodeURIComponent(added.value.workspaceId)}`, { method: "DELETE" });
    assert.equal(removed.ok, true);
    const emptyAgain = await client.request<unknown[]>("/v1/control/workspaces");
    assert.equal(emptyAgain.ok, true);
    if (emptyAgain.ok) assert.deepEqual(emptyAgain.value, []);
  } finally {
    await daemon?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("pairing credentials expire and revoke at the browser authorization boundary", () => {
  let now = 1_000;
  let byte = 1;
  const pairing = createPairingService({
    controlToken: "hunsu_control_test",
    ttlMs: 100,
    now: () => now,
    randomBytes: size => new Uint8Array(size).fill(byte++)
  });
  const first = pairing.rotate({ browserUrl: "https://hunsu.app/studio" });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.deepEqual(pairing.validate(first.value.internal.credential), { valid: true });
  assert.equal(pairing.revoke(first.value.safe.pairingId), true);
  assert.deepEqual(pairing.validate(first.value.internal.credential), { valid: false, reason: "revoked" });

  const second = pairing.rotate({ browserUrl: "https://hunsu.app/studio" });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  now += 101;
  assert.deepEqual(pairing.validate(second.value.internal.credential), { valid: false, reason: "expired" });
});

test("authenticated shutdown releases the listener, while singleton and foreign-port errors remain distinct", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunsu-headless-daemon-port-"));
  let daemon: RunningBridgeDaemon | undefined;
  try {
    daemon = await startBridgeDaemon({ home: join(root, "same-home"), port: 0, cwd: root, development: true, openBrowser: async () => undefined });
    const endpoint = new URL(daemon.identity.endpoint);
    const port = Number(endpoint.port);

    await assert.rejects(
      () => startBridgeDaemon({ home: daemon!.paths.home, cwd: root, development: true, openBrowser: async () => undefined }),
      error => error instanceof BridgeError && error.code === "BRIDGE_ALREADY_RUNNING"
    );
    await assert.rejects(
      () => startBridgeDaemon({ home: daemon!.paths.home, port: 0, cwd: root, development: true, openBrowser: async () => undefined }),
      error => error instanceof BridgeError && error.code === "BRIDGE_ALREADY_RUNNING"
    );

    const client = createBridgeControlClient({ paths: daemon.paths });
    const shutdown = await client.request("/v1/control/shutdown", { method: "POST" });
    assert.equal(shutdown.ok, true);
    await daemon.waitUntilClosed();
    daemon = undefined;
    await assertPortCanBind(port);

    const foreign = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, service: "not-hunsu" }));
    });
    await listen(foreign, 0);
    try {
      const address = foreign.address();
      assert.ok(address && typeof address !== "string");
      await assert.rejects(
        () => startBridgeDaemon({ home: join(root, "foreign-home"), port: address.port, cwd: root, development: true, openBrowser: async () => undefined }),
        error => error instanceof BridgeError && error.code === "BRIDGE_PORT_IN_USE"
      );
    } finally {
      await closeServer(foreign);
    }
  } finally {
    await daemon?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("singleton lock removal requires a valid recorded dead process", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunsu-headless-singleton-lock-"));
  const paths = resolveHunsuPaths({ home: join(root, "state") });
  await mkdir(paths.runtimeDirectory, { recursive: true });
  const unreachableFetch: typeof fetch = async () => { throw new Error("unreachable"); };
  try {
    await writeFile(paths.daemonLockFile, "not-json\n", "utf8");
    await assert.rejects(
      () => acquireDaemonStartupLock({
        paths,
        endpoint: "http://127.0.0.1:43199",
        controlToken: "hunsu_control_test",
        fetchImpl: unreachableFetch,
        processAlive: () => false
      }),
      error => error instanceof BridgeError && error.code === "BRIDGE_ALREADY_RUNNING"
    );
    assert.equal(await readFile(paths.daemonLockFile, "utf8"), "not-json\n");

    await writeFile(paths.daemonLockFile, `${JSON.stringify({ pid: 999_999, createdAt: new Date().toISOString() })}\n`, "utf8");
    const acquired = await acquireDaemonStartupLock({
      paths,
      endpoint: "http://127.0.0.1:43199",
      controlToken: "hunsu_control_test",
      fetchImpl: unreachableFetch,
      processAlive: () => false
    });
    await acquired.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("structured diagnostics redact secrets both before persistence and when reading historical JSONL", async () => {
  const home = await mkdtemp(join(tmpdir(), "hunsu-headless-daemon-log-"));
  const paths = resolveHunsuPaths({ home });
  const log = createStructuredLog({ paths });
  const secret = "hunsu_bridge_pair_super-secret-value";
  try {
    await log.append({
      level: "warn",
      event: "redaction.write",
      message: `request used Bearer ${secret}`,
      data: { controlToken: secret, url: `https://example.test/?hunsuBridgeToken=${secret}` }
    });
    const persisted = await readFile(paths.structuredLogFile, "utf8");
    assert.equal(persisted.includes(secret), false);
    assert.match(persisted, /\[redacted\]/u);

    await appendFile(paths.structuredLogFile, `${JSON.stringify({
      schema: STRUCTURED_LOG_SCHEMA,
      timestamp: "2026-07-12T00:00:00.000Z",
      level: "error",
      event: "redaction.read",
      message: `authorization=Bearer ${secret}`,
      data: { accessToken: secret }
    })}\n`);
    const readBack = await log.read();
    const safe = JSON.stringify(readBack);
    assert.equal(safe.includes(secret), false);
    assert.match(safe, /\[redacted\]/u);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

async function withDaemon(run: (daemon: RunningBridgeDaemon) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "hunsu-headless-daemon-"));
  let daemon: RunningBridgeDaemon | undefined;
  try {
    daemon = await startBridgeDaemon({ home: join(root, "state"), port: 0, cwd: root, development: true, openBrowser: async () => undefined });
    await run(daemon);
  } finally {
    await daemon?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

async function assertPortCanBind(port: number): Promise<void> {
  const server = createServer();
  await listen(server, port);
  await closeServer(server);
}

async function listen(server: ReturnType<typeof createServer>, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
