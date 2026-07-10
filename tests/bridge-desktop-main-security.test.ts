import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createTcpServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyDiagnosticsSecurityMigration,
  main,
  readLogTail,
  writeStructuredLog
} from "../apps/bridge-desktop/src/main.ts";

test("Pair CLI never prints a token-bearing pairing URL", () => {
  const source = readFileSync(join(process.cwd(), "apps/bridge-desktop/src/main.ts"), "utf8");
  assert.doesNotMatch(source, /console\.log\(\s*(?:running\.)?pairingUrl\s*\)/u);
  assert.doesNotMatch(source, /console\.log\([^)]*(?:studioUrl|authToken|hunsuBridgeToken)/u);
});

test("first fixed launch revokes legacy pairing and rewrites persisted/logged tokens", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-bridge-security-migration-"));
  const statePath = join(root, "bridge-app.json");
  const logPath = join(root, "bridge-app.log");
  const pairingToken = `bridge_test_${randomBytes(24).toString("base64url")}`;
  const secondToken = `bridge_test_${randomBytes(24).toString("base64url")}`;
  const controlToken = `control_test_${randomBytes(18).toString("base64url")}`;
  let revokeRequests = 0;
  const server = createServer((request, response) => {
    if (request.method === "POST" && request.url === "/api/bridge/pairing/revoke") {
      revokeRequests += 1;
      assert.equal(request.headers["x-hunsu-bridge-control-token"], controlToken);
      response.writeHead(202, { "content-type": "application/json" });
      response.end(JSON.stringify({ revoked: true }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const previousStatePath = process.env.HUNSU_BRIDGE_APP_STATE_PATH;
  const previousLogPath = process.env.HUNSU_BRIDGE_APP_LOG_PATH;
  process.env.HUNSU_BRIDGE_APP_STATE_PATH = statePath;
  process.env.HUNSU_BRIDGE_APP_LOG_PATH = logPath;
  try {
    writeFileSync(statePath, JSON.stringify({
      schema: "hunsu.bridge-app-state.v1",
      bridgeApiUrl: `http://127.0.0.1:${address.port}`,
      authToken: pairingToken,
      controlToken,
      pairing: {
        token: pairingToken,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      },
      account: { status: "signed-out" },
      device: { id: "device_security", name: "Security Test", registered: false },
      remoteAccess: "off",
      projectGrants: [],
      service: { installed: false, manager: "manual" }
    }), "utf8");
    writeFileSync(logPath, `${JSON.stringify({
      event: "legacy.unsafe",
      url: `https://hunsu.app/studio?hunsuBridgeToken=${pairingToken}`
    })}\n`, "utf8");

    await applyDiagnosticsSecurityMigration({ configuredBridgeApiUrl: null });
    await applyDiagnosticsSecurityMigration({ configuredBridgeApiUrl: null });

    assert.equal(revokeRequests, 1);
    const stateText = readFileSync(statePath, "utf8");
    const state = JSON.parse(stateText) as Record<string, unknown>;
    assert.equal(state.diagnosticsSecurityVersion, 1);
    assert.equal(state.authToken, undefined);
    assert.equal(state.pairing, undefined);
    assert.equal(state.controlToken, controlToken);
    assert.doesNotMatch(stateText, new RegExp(pairingToken));
    assert.doesNotMatch(readFileSync(logPath, "utf8"), new RegExp(pairingToken));

    writeStructuredLog({
      event: "synthetic.unsafe",
      url: `https://hunsu.app/studio?hunsuRelayToken=${secondToken}`,
      nested: JSON.stringify({ authorization: secondToken })
    });
    assert.doesNotMatch(readFileSync(logPath, "utf8"), new RegExp(secondToken));

    writeFileSync(logPath, `legacy url https://hunsu.app/studio?hunsuBridgeToken=${secondToken}\n`, "utf8");
    const tail = readLogTail(logPath, 5);
    assert.equal(tail.length, 1);
    assert.doesNotMatch(tail[0] ?? "", new RegExp(secondToken));
    assert.match(tail[0] ?? "", /\[redacted\]/);
  } finally {
    if (previousStatePath === undefined) delete process.env.HUNSU_BRIDGE_APP_STATE_PATH;
    else process.env.HUNSU_BRIDGE_APP_STATE_PATH = previousStatePath;
    if (previousLogPath === undefined) delete process.env.HUNSU_BRIDGE_APP_LOG_PATH;
    else process.env.HUNSU_BRIDGE_APP_LOG_PATH = previousLogPath;
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejected legacy pairing revocation stays pending and a successful retry completes it", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-bridge-security-rejected-"));
  const statePath = join(root, "bridge-app.json");
  const logPath = join(root, "bridge-app.log");
  const pairingToken = `bridge_test_${randomBytes(24).toString("base64url")}`;
  const controlToken = `control_test_${randomBytes(18).toString("base64url")}`;
  let rejectRevocation = true;
  let revokeRequests = 0;
  const server = createServer((request, response) => {
    if (request.method === "POST" && request.url === "/api/bridge/pairing/revoke") {
      revokeRequests += 1;
      assert.equal(request.headers["x-hunsu-bridge-control-token"], controlToken);
      if (rejectRevocation) {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ revoked: false }));
      } else {
        response.writeHead(202, { "content-type": "application/json" });
        response.end(JSON.stringify({ revoked: true }));
      }
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const restore = installSecurityMigrationFixture({
    statePath,
    logPath,
    bridgeApiUrl: `http://127.0.0.1:${address.port}`,
    controlToken,
    pairingToken,
    pid: process.pid
  });
  try {
    await applyDiagnosticsSecurityMigration({ configuredBridgeApiUrl: null });

    const pendingText = readFileSync(statePath, "utf8");
    const pending = JSON.parse(pendingText) as Record<string, unknown>;
    assert.equal(pending.diagnosticsSecurityVersion, 0);
    assert.equal(pending.authToken, undefined);
    assert.equal(pending.pairing, undefined);
    assert.equal(pending.controlToken, controlToken);
    assert.doesNotMatch(pendingText, new RegExp(pairingToken));
    assert.doesNotMatch(readFileSync(logPath, "utf8"), new RegExp(pairingToken));

    rejectRevocation = false;
    await applyDiagnosticsSecurityMigration({ configuredBridgeApiUrl: null });

    assert.equal(revokeRequests, 2);
    const completed = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
    assert.equal(completed.diagnosticsSecurityVersion, 1);
  } finally {
    restore();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("transient revocation network failure remains pending while a managed process is alive and recovers", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-bridge-security-network-retry-"));
  const statePath = join(root, "bridge-app.json");
  const logPath = join(root, "bridge-app.log");
  const pairingToken = `bridge_test_${randomBytes(24).toString("base64url")}`;
  const controlToken = `control_test_${randomBytes(18).toString("base64url")}`;
  const managedPid = 424_242;
  let reachable = false;
  let revokeAttempts = 0;
  const restore = installSecurityMigrationFixture({
    statePath,
    logPath,
    bridgeApiUrl: "http://127.0.0.1:24681",
    controlToken,
    pairingToken,
    pid: managedPid
  });
  const migrationOptions = {
    configuredBridgeApiUrl: null,
    processIsAlive: (pid: number) => pid === managedPid,
    probeTcpEndpoint: async () => false,
    fetch: async (): Promise<Response> => {
      revokeAttempts += 1;
      if (!reachable) throw new TypeError("synthetic transient network failure");
      return new Response(JSON.stringify({ revoked: true }), {
        status: 202,
        headers: { "content-type": "application/json" }
      });
    }
  };
  try {
    await applyDiagnosticsSecurityMigration(migrationOptions);
    assert.equal((JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>).diagnosticsSecurityVersion, 0);
    assert.doesNotMatch(readFileSync(statePath, "utf8"), new RegExp(pairingToken));

    reachable = true;
    await applyDiagnosticsSecurityMigration(migrationOptions);
    assert.equal(revokeAttempts, 2);
    assert.equal((JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>).diagnosticsSecurityVersion, 1);
  } finally {
    restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("timed out legacy revocation remains pending and a responsive retry completes it", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-bridge-security-timeout-retry-"));
  const statePath = join(root, "bridge-app.json");
  const logPath = join(root, "bridge-app.log");
  const pairingToken = `bridge_test_${randomBytes(24).toString("base64url")}`;
  const controlToken = `control_test_${randomBytes(18).toString("base64url")}`;
  let respond = false;
  let revokeRequests = 0;
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/api/bridge/pairing/revoke") {
      response.writeHead(404).end();
      return;
    }
    revokeRequests += 1;
    if (!respond) {
      return;
    }
    response.writeHead(202, { "content-type": "application/json" });
    response.end(JSON.stringify({ revoked: true }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const restore = installSecurityMigrationFixture({
    statePath,
    logPath,
    bridgeApiUrl: `http://127.0.0.1:${address.port}`,
    controlToken,
    pairingToken
  });
  const migrationOptions = {
    configuredBridgeApiUrl: null,
    fetchTimeoutMs: 50,
    probeTcpEndpoint: async () => true
  };
  try {
    const startedAt = Date.now();
    await applyDiagnosticsSecurityMigration(migrationOptions);
    assert.ok(Date.now() - startedAt < 1_000, "A nonresponsive revocation endpoint stalled migration.");

    const pendingText = readFileSync(statePath, "utf8");
    assert.equal((JSON.parse(pendingText) as Record<string, unknown>).diagnosticsSecurityVersion, 0);
    assert.doesNotMatch(pendingText, new RegExp(pairingToken));

    respond = true;
    await applyDiagnosticsSecurityMigration(migrationOptions);
    assert.equal(revokeRequests, 2);
    assert.equal((JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>).diagnosticsSecurityVersion, 1);
  } finally {
    restore();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("reachable nonresponsive health endpoint cannot stall a finite CLI command", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-bridge-security-finite-cli-"));
  const statePath = join(root, "bridge-app.json");
  const logPath = join(root, "bridge-app.log");
  const pairingToken = `bridge_test_${randomBytes(24).toString("base64url")}`;
  const sockets = new Set<Socket>();
  const server = createTcpServer(socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("data", () => undefined);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const restore = installSecurityMigrationFixture({
    statePath,
    logPath,
    bridgeApiUrl: `http://127.0.0.1:${address.port}`,
    pairingToken
  });
  const originalLog = console.log;
  console.log = () => undefined;
  try {
    const startedAt = Date.now();
    const exitCode = await main(["help"], {
      diagnosticsSecurityMigration: {
        configuredBridgeApiUrl: null,
        fetchTimeoutMs: 50
      }
    });
    assert.equal(exitCode, 0);
    assert.ok(Date.now() - startedAt < 1_000, "A reachable nonresponsive endpoint stalled a finite CLI command.");
    assert.equal((JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>).diagnosticsSecurityVersion, 0);
  } finally {
    console.log = originalLog;
    restore();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("offline legacy state with no live managed process completes without remote revocation", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-bridge-security-offline-"));
  const statePath = join(root, "bridge-app.json");
  const logPath = join(root, "bridge-app.log");
  const pairingToken = `bridge_test_${randomBytes(24).toString("base64url")}`;
  const controlToken = `control_test_${randomBytes(18).toString("base64url")}`;
  const restore = installSecurityMigrationFixture({
    statePath,
    logPath,
    bridgeApiUrl: "http://127.0.0.1:24682",
    controlToken,
    pairingToken
  });
  try {
    await applyDiagnosticsSecurityMigration({
      configuredBridgeApiUrl: null,
      processIsAlive: () => false,
      probeTcpEndpoint: async () => false,
      fetch: async () => { throw new TypeError("synthetic offline endpoint"); }
    });

    const stateText = readFileSync(statePath, "utf8");
    const state = JSON.parse(stateText) as Record<string, unknown>;
    assert.equal(state.diagnosticsSecurityVersion, 1);
    assert.equal(state.pairing, undefined);
    assert.equal(state.controlToken, controlToken);
    assert.doesNotMatch(stateText, new RegExp(pairingToken));
  } finally {
    restore();
    rmSync(root, { recursive: true, force: true });
  }
});

function installSecurityMigrationFixture(input: {
  statePath: string;
  logPath: string;
  bridgeApiUrl: string;
  controlToken?: string;
  pairingToken: string;
  pid?: number;
}): () => void {
  const previousStatePath = process.env.HUNSU_BRIDGE_APP_STATE_PATH;
  const previousLogPath = process.env.HUNSU_BRIDGE_APP_LOG_PATH;
  process.env.HUNSU_BRIDGE_APP_STATE_PATH = input.statePath;
  process.env.HUNSU_BRIDGE_APP_LOG_PATH = input.logPath;
  writeFileSync(input.statePath, JSON.stringify({
    schema: "hunsu.bridge-app-state.v1",
    bridgeApiUrl: input.bridgeApiUrl,
    authToken: input.pairingToken,
    controlToken: input.controlToken,
    pid: input.pid,
    pairing: {
      token: input.pairingToken,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    },
    account: { status: "signed-out" },
    device: { id: "device_security", name: "Security Test", registered: false },
    remoteAccess: "off",
    projectGrants: [],
    service: { installed: false, manager: "manual" }
  }), "utf8");
  writeFileSync(input.logPath, `legacy url https://hunsu.app/studio?hunsuBridgeToken=${input.pairingToken}\n`, "utf8");
  return () => {
    if (previousStatePath === undefined) delete process.env.HUNSU_BRIDGE_APP_STATE_PATH;
    else process.env.HUNSU_BRIDGE_APP_STATE_PATH = previousStatePath;
    if (previousLogPath === undefined) delete process.env.HUNSU_BRIDGE_APP_LOG_PATH;
    else process.env.HUNSU_BRIDGE_APP_LOG_PATH = previousLogPath;
  };
}
