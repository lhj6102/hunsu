import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { resolveBridgeRuntimeConfig, unwrapConfigResult } from "../packages/config/src/index.ts";
import { createBridgeSupervisor } from "../apps/bridge/src/index.ts";
import {
  createManagedBridgeRuntime,
  type ManagedBridgeFetch
} from "../apps/bridge-desktop/src/processes/managedBridgeRuntime.ts";
import { BridgeSidecarSupervisor } from "../apps/bridge-desktop/src/sidecar-supervisor.ts";
import { main } from "../apps/bridge-desktop/src/main.ts";
import {
  defaultBridgeAppState,
  writeBridgeAppState,
  type BridgeAppState
} from "../apps/bridge-desktop/src/state/appState.ts";

const BRIDGE_URL = "http://127.0.0.1:19687";
const CONTROL_TOKEN = "synthetic-control-token";

test("authenticated Bridge control status returns stable safe lifecycle identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-control-status-"));
  const runtimeConfig = unwrapConfigResult(resolveBridgeRuntimeConfig({}, { cwd: root, homeDir: root }));
  const supervisor = createBridgeSupervisor();
  const handle = await supervisor.start({
    cwd: root,
    noOpen: true,
    controlToken: CONTROL_TOKEN,
    runtimeConfig: {
      ...runtimeConfig,
      bridgeApi: { ...runtimeConfig.bridgeApi, port: 0 }
    }
  });

  try {
    const rejected = await fetch(new URL("/api/bridge/control/status", handle.bridgeApiUrl), {
      headers: { "x-hunsu-bridge-control-token": "wrong-control-token" }
    });
    assert.equal(rejected.status, 401);

    const accepted = await fetch(new URL("/api/bridge/control/status", handle.bridgeApiUrl), {
      headers: { "x-hunsu-bridge-control-token": CONTROL_TOKEN }
    });
    assert.equal(accepted.status, 200);
    const first = await accepted.json() as Record<string, unknown>;
    assert.equal(first.ok, true);
    assert.equal(first.state, "running");
    assert.equal(first.daemonPid, process.pid);
    assert.match(String(first.instanceId), /^bridge_instance_/);
    assert.equal(first.protocolVersion, "local-bridge-v1");

    const repeated = await fetch(new URL("/api/bridge/control/status", handle.bridgeApiUrl), {
      headers: { "x-hunsu-bridge-control-token": CONTROL_TOKEN }
    });
    const second = await repeated.json() as Record<string, unknown>;
    assert.equal(second.instanceId, first.instanceId);
    assert.equal(second.startedAt, first.startedAt);
    assert.doesNotMatch(JSON.stringify(first), /synthetic-control-token|hunsuBridgeToken|authToken|pairing/i);

    const shutdown = await fetch(new URL("/api/bridge/control/shutdown", handle.bridgeApiUrl), {
      method: "POST",
      headers: { "x-hunsu-bridge-control-token": CONTROL_TOKEN }
    });
    assert.equal(shutdown.status, 202);
    await supervisor.waitForTerminal();
    assert.equal((await supervisor.status())?.status, "stopped");
  } finally {
    if ((await supervisor.status())?.status !== "stopped") {
      await supervisor.stop();
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed Bridge discovery distinguishes managed, unmanaged, and unrelated listeners", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-managed-discovery-"));
  let state: BridgeAppState = {
    ...defaultBridgeAppState(),
    bridgeApiUrl: BRIDGE_URL,
    controlToken: CONTROL_TOKEN
  };
  const service = fakeBridgeService(() => state);
  try {
    const runtime = createManagedBridgeRuntime({
      canonicalBridgeApiUrl: BRIDGE_URL,
      lockPath: join(root, "bridge-start.lock"),
      readState: () => state,
      writeState: next => { state = next; },
      fetch: service.fetch
    });

    const managed = await runtime.discoverManagedBridge();
    assert.equal(managed.state, "running-managed");
    if (managed.state === "running-managed") {
      assert.equal(managed.instanceId, service.instanceId);
      assert.equal(managed.daemonPid, 4321);
    }

    state = { ...state, controlToken: "wrong-control-token" };
    const unmanaged = await runtime.discoverManagedBridge();
    assert.equal(unmanaged.state, "running-unmanaged");

    service.kind = "unrelated";
    const conflict = await runtime.discoverManagedBridge();
    assert.equal(conflict.state, "port-conflict");
    const refusedConflict = await runtime.ensureManagedBridgeRunning();
    assert.equal(refusedConflict.ok, false);
    if (!refusedConflict.ok) {
      assert.equal(refusedConflict.error.code, "BRIDGE_PORT_IN_USE");
      assert.deepEqual(refusedConflict.error.recovery, {
        label: "Stop the other process using Bridge port 19687, then select Start Bridge again.",
        action: "retry-start-bridge"
      });
      assert.doesNotMatch(JSON.stringify(refusedConflict.error), /synthetic-control-token/u);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent and repeated ensure-running calls start exactly one managed daemon", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-managed-ensure-"));
  let state = defaultBridgeAppState();
  const service = fakeBridgeService(() => state);
  service.online = false;
  let starts = 0;
  const runtime = createManagedBridgeRuntime({
    canonicalBridgeApiUrl: BRIDGE_URL,
    lockPath: join(root, "bridge-start.lock"),
    readState: () => state,
    writeState: next => { state = next; },
    fetch: service.fetch,
    processIsAlive: pid => pid === process.pid,
    pollIntervalMs: 2,
    coordinationTimeoutMs: 500,
    startTimeoutMs: 500,
    startSupervisor: async () => {
      starts += 1;
      await delay(20);
      state = {
        ...state,
        bridgeApiUrl: BRIDGE_URL,
        controlToken: CONTROL_TOKEN,
        pid: 4321,
        startedAt: new Date().toISOString()
      };
      service.online = true;
    }
  });

  try {
    const [first, second] = await Promise.all([
      runtime.ensureManagedBridgeRunning(),
      runtime.ensureManagedBridgeRunning()
    ]);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(starts, 1);
    const repeated = await runtime.ensureManagedBridgeRunning();
    assert.equal(repeated.ok, true);
    assert.equal(starts, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stale state is reconciled before startup and unmanaged listeners are never replaced", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-managed-stale-"));
  let state: BridgeAppState = {
    ...defaultBridgeAppState(),
    bridgeApiUrl: BRIDGE_URL,
    controlToken: "stale-control-token",
    pid: 999_999,
    startedAt: "2020-01-01T00:00:00.000Z"
  };
  const service = fakeBridgeService(() => state);
  service.online = false;
  let starts = 0;
  const runtime = createManagedBridgeRuntime({
    canonicalBridgeApiUrl: BRIDGE_URL,
    lockPath: join(root, "bridge-start.lock"),
    readState: () => state,
    writeState: next => { state = next; },
    fetch: service.fetch,
    processIsAlive: () => false,
    pollIntervalMs: 1,
    startTimeoutMs: 200,
    startSupervisor: async () => {
      starts += 1;
      assert.equal(state.pid, undefined);
      assert.equal(state.controlToken, undefined);
      state = { ...state, bridgeApiUrl: BRIDGE_URL, controlToken: CONTROL_TOKEN, pid: 4321 };
      service.online = true;
    }
  });

  try {
    const started = await runtime.ensureManagedBridgeRunning();
    assert.equal(started.ok, true);
    assert.equal(starts, 1);

    state = { ...state, controlToken: "not-the-owner" };
    const refused = await runtime.ensureManagedBridgeRunning();
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.error.code, "BRIDGE_ALREADY_RUNNING_UNMANAGED");
    assert.equal(starts, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pair and Open Roadmap reuse one daemon, rotate once per action, and return only safe results", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-managed-open-"));
  let state: BridgeAppState = {
    ...defaultBridgeAppState(),
    bridgeApiUrl: BRIDGE_URL,
    controlToken: CONTROL_TOKEN,
    pid: 4321
  };
  const service = fakeBridgeService(() => state);
  const opened: string[] = [];
  let starts = 0;
  const runtime = createManagedBridgeRuntime({
    canonicalBridgeApiUrl: BRIDGE_URL,
    lockPath: join(root, "bridge-start.lock"),
    readState: () => state,
    writeState: next => { state = next; },
    fetch: service.fetch,
    startSupervisor: async () => { starts += 1; },
    openUrl: async url => { opened.push(url); }
  });

  try {
    const paired = await runtime.createManagedPairing({ webUrl: "https://hunsu.app/studio" });
    const openedRoadmap = await runtime.openManagedRoadmap("roadmap_123", { webUrl: "https://hunsu.app/studio" });
    assert.equal(paired.ok, true);
    assert.equal(openedRoadmap.ok, true);
    assert.equal(starts, 0);
    assert.equal(service.rotations, 2);
    assert.equal(opened.length, 2);
    assert.match(opened[1], /roadmap_123/);
    assert.match(opened[1], /hunsuBridgeToken=synthetic-pairing-/);
    assert.doesNotMatch(JSON.stringify([paired, openedRoadmap]), /synthetic-pairing|hunsuBridgeToken|studioUrl|authToken/);
    assert.equal("token" in (state.pairing ?? {}), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed Stop is authenticated and idempotent while unmanaged Stop is refused", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-managed-stop-"));
  let state: BridgeAppState = {
    ...defaultBridgeAppState(),
    bridgeApiUrl: BRIDGE_URL,
    controlToken: CONTROL_TOKEN,
    pid: 4321
  };
  const service = fakeBridgeService(() => state);
  const runtime = createManagedBridgeRuntime({
    canonicalBridgeApiUrl: BRIDGE_URL,
    lockPath: join(root, "bridge-start.lock"),
    readState: () => state,
    writeState: next => { state = next; },
    fetch: service.fetch,
    processIsAlive: () => false,
    pollIntervalMs: 1,
    stopTimeoutMs: 200
  });

  try {
    const stopped = await runtime.stopManagedBridge();
    assert.deepEqual(stopped, { ok: true, value: { previousState: "running-managed", state: "stopped" } });
    assert.equal(service.shutdowns, 1);
    const repeated = await runtime.stopManagedBridge();
    assert.deepEqual(repeated, { ok: true, value: { previousState: "not-running", state: "stopped" } });
    assert.equal(service.shutdowns, 1);

    service.online = true;
    state = { ...defaultBridgeAppState(), bridgeApiUrl: BRIDGE_URL, controlToken: "foreign-token" };
    const refused = await runtime.stopManagedBridge();
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.error.code, "BRIDGE_NOT_OWNED");
    assert.equal(service.shutdowns, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("authenticated Stop persists an observable stopping transition until the runtime exits", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-managed-stopping-transition-"));
  let state: BridgeAppState = {
    ...defaultBridgeAppState(),
    bridgeApiUrl: BRIDGE_URL,
    controlToken: CONTROL_TOKEN,
    pid: 4321,
    supervisorPid: 4000
  };
  const service = fakeBridgeService(() => state);
  const fetchBeforeShutdownGate = service.fetch;
  let acknowledgeShutdown: (() => void) | undefined;
  const shutdownGate = new Promise<void>(resolve => { acknowledgeShutdown = resolve; });
  let observeShutdownRequest: (() => void) | undefined;
  const shutdownRequested = new Promise<void>(resolve => { observeShutdownRequest = resolve; });
  service.fetch = async (input, init = {}) => {
    if (new URL(input).pathname !== "/api/bridge/control/shutdown") {
      return fetchBeforeShutdownGate(input, init);
    }
    service.shutdowns += 1;
    observeShutdownRequest?.();
    await shutdownGate;
    service.online = false;
    return jsonResponse({ shuttingDown: true }, 202);
  };
  const runtime = createManagedBridgeRuntime({
    canonicalBridgeApiUrl: BRIDGE_URL,
    lockPath: join(root, "bridge-start.lock"),
    readState: () => state,
    writeState: next => { state = next; },
    fetch: service.fetch,
    probeTcpEndpoint: async () => false,
    processIsAlive: () => false,
    pollIntervalMs: 1,
    stopTimeoutMs: 200
  });

  try {
    const stop = runtime.stopManagedBridge();
    await shutdownRequested;

    assert.deepEqual(state.managedBridgeTransition, {
      state: "stopping",
      instanceId: service.instanceId,
      bridgeApiUrl: BRIDGE_URL,
      daemonPid: 4321,
      supervisorPid: 4000,
      requestedAt: state.managedBridgeTransition?.requestedAt
    });
    assert.match(state.managedBridgeTransition?.requestedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
    const duringStop = await runtime.discoverManagedBridge();
    assert.equal(duringStop.state, "stopping");
    if (duringStop.state === "stopping") {
      assert.equal(duringStop.instanceId, service.instanceId);
      assert.equal(duringStop.daemonPid, 4321);
    }
    const startDuringStop = await runtime.ensureManagedBridgeRunning();
    assert.equal(startDuringStop.ok, false);
    if (!startDuringStop.ok) assert.equal(startDuringStop.error.code, "BRIDGE_CONTROL_UNAVAILABLE");

    acknowledgeShutdown?.();
    assert.deepEqual(await stop, { ok: true, value: { previousState: "running-managed", state: "stopped" } });
    assert.equal(state.managedBridgeTransition, undefined);
    assert.equal(state.controlToken, undefined);
    assert.equal((await runtime.discoverManagedBridge()).state, "not-running");
  } finally {
    acknowledgeShutdown?.();
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejected and timed-out Stops clear the stopping transition while preserving the managed runtime", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-managed-stopping-failure-"));
  let state: BridgeAppState = {
    ...defaultBridgeAppState(),
    bridgeApiUrl: BRIDGE_URL,
    controlToken: CONTROL_TOKEN,
    pid: 4321,
    supervisorPid: 4000
  };
  const service = fakeBridgeService(() => state);
  const normalFetch = service.fetch;
  service.fetch = async (input, init = {}) => new URL(input).pathname === "/api/bridge/control/shutdown"
    ? jsonResponse({ shuttingDown: false }, 503)
    : normalFetch(input, init);
  const runtime = createManagedBridgeRuntime({
    canonicalBridgeApiUrl: BRIDGE_URL,
    lockPath: join(root, "bridge-start.lock"),
    readState: () => state,
    writeState: next => { state = next; },
    fetch: service.fetch,
    processIsAlive: () => true,
    pollIntervalMs: 1,
    stopTimeoutMs: 12
  });

  try {
    const rejected = await runtime.stopManagedBridge();
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.error.code, "BRIDGE_CONTROL_UNAVAILABLE");
    assert.equal(state.managedBridgeTransition, undefined);
    assert.equal((await runtime.discoverManagedBridge()).state, "running-managed");

    service.fetch = async (input, init = {}) => new URL(input).pathname === "/api/bridge/control/shutdown"
      ? jsonResponse({ shuttingDown: true }, 202)
      : normalFetch(input, init);
    const timedOutRuntime = createManagedBridgeRuntime({
      canonicalBridgeApiUrl: BRIDGE_URL,
      lockPath: join(root, "bridge-start.lock"),
      readState: () => state,
      writeState: next => { state = next; },
      fetch: service.fetch,
      processIsAlive: () => true,
      pollIntervalMs: 1,
      stopTimeoutMs: 12
    });
    const timedOut = await timedOutRuntime.stopManagedBridge();
    assert.equal(timedOut.ok, false);
    if (!timedOut.ok) assert.equal(timedOut.error.code, "BRIDGE_STOP_TIMEOUT");
    assert.equal(state.managedBridgeTransition, undefined);
    assert.equal((await timedOutRuntime.discoverManagedBridge()).state, "running-managed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the real app snapshot exposes stopping during an in-flight authenticated Stop", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-managed-stopping-snapshot-"));
  const statePath = join(root, "bridge-app.json");
  const logPath = join(root, "bridge-app.log");
  const roadmapRegistryPath = join(root, "roadmaps.json");
  const daemonPid = 987_651;
  const supervisorPid = 987_652;
  let shutdownResponse: import("node:http").ServerResponse | undefined;
  let signalShutdownRequest: (() => void) | undefined;
  const shutdownRequested = new Promise<void>(resolve => { signalShutdownRequest = resolve; });
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.setHeader("connection", "close");
    if (request.url === "/health") {
      response.writeHead(200).end(JSON.stringify({
        ok: true,
        service: "hunsu-bridge",
        version: { bridgeVersion: "0.1.2", protocolVersion: "local-bridge-v1" }
      }));
      return;
    }
    if (request.url === "/api/bridge/control/status") {
      if (request.headers["x-hunsu-bridge-control-token"] !== CONTROL_TOKEN) {
        response.writeHead(401).end(JSON.stringify({ ok: false }));
        return;
      }
      response.writeHead(200).end(JSON.stringify({
        ok: true,
        instanceId: "bridge_instance_snapshot_transition",
        protocolVersion: "local-bridge-v1",
        bridgeVersion: "0.1.2",
        daemonPid,
        supervisorPid,
        startedAt: "2026-07-11T00:00:00.000Z",
        state: "running"
      }));
      return;
    }
    if (request.method === "POST" && request.url === "/api/bridge/control/shutdown") {
      assert.equal(request.headers["x-hunsu-bridge-control-token"], CONTROL_TOKEN);
      shutdownResponse = response;
      signalShutdownRequest?.();
      return;
    }
    response.writeHead(404).end(JSON.stringify({ error: "not_found" }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const bridgeApiUrl = `http://127.0.0.1:${address.port}`;
  writeBridgeAppState({
    ...defaultBridgeAppState(),
    diagnosticsSecurityVersion: 1,
    bridgeApiUrl,
    controlToken: CONTROL_TOKEN,
    pid: daemonPid,
    supervisorPid,
    instanceId: "bridge_instance_snapshot_transition",
    startedAt: "2026-07-11T00:00:00.000Z"
  }, statePath);

  const envKeys = [
    "HUNSU_BRIDGE_APP_STATE_PATH",
    "HUNSU_BRIDGE_APP_LOG_PATH",
    "HUNSU_ROADMAP_REGISTRY_PATH",
    "HUNSU_BRIDGE_HOST",
    "HUNSU_BRIDGE_PORT"
  ];
  const previousEnv = new Map(envKeys.map(key => [key, process.env[key]]));
  process.env.HUNSU_BRIDGE_APP_STATE_PATH = statePath;
  process.env.HUNSU_BRIDGE_APP_LOG_PATH = logPath;
  process.env.HUNSU_ROADMAP_REGISTRY_PATH = roadmapRegistryPath;
  process.env.HUNSU_BRIDGE_HOST = "127.0.0.1";
  process.env.HUNSU_BRIDGE_PORT = String(address.port);
  const output: string[] = [];
  const previousConsoleLog = console.log;
  const previousConsoleError = console.error;
  console.log = (...values: unknown[]) => { output.push(values.map(String).join(" ")); };
  console.error = (...values: unknown[]) => { output.push(values.map(String).join(" ")); };

  try {
    const stopping = main(["stop", "--json"]);
    await shutdownRequested;
    const persistedDuringStop = JSON.parse(readFileSync(statePath, "utf8")) as BridgeAppState;
    assert.equal(persistedDuringStop.managedBridgeTransition?.state, "stopping");

    output.length = 0;
    assert.equal(await main(["snapshot"]), 0);
    const duringSnapshot = JSON.parse(output.at(-1) ?? "{}") as {
      localBridgeControl?: { state?: string; ownership?: string; canStart?: boolean; canStop?: boolean };
    };
    assert.deepEqual(duringSnapshot.localBridgeControl, {
      state: "stopping",
      ownership: "managed",
      canStart: false,
      canStop: false,
      startReason: "Bridge shutdown is in progress.",
      stopReason: "Bridge shutdown is in progress.",
      instanceId: "bridge_instance_snapshot_transition",
      daemonPid,
      supervisorPid
    });

    const serverClosed = new Promise<void>(resolve => {
      shutdownResponse?.writeHead(202);
      shutdownResponse?.end(JSON.stringify({ shuttingDown: true }), () => {
        server.close(() => resolve());
      });
    });
    assert.equal(await stopping, 0);
    await serverClosed;
    const persistedAfterStop = JSON.parse(readFileSync(statePath, "utf8")) as BridgeAppState;
    assert.equal(persistedAfterStop.managedBridgeTransition, undefined);
    assert.equal(persistedAfterStop.controlToken, undefined);

    output.length = 0;
    assert.equal(await main(["snapshot"]), 0);
    const terminalSnapshot = JSON.parse(output.at(-1) ?? "{}") as { localBridgeControl?: { state?: string } };
    assert.equal(terminalSnapshot.localBridgeControl?.state, "not-running");
  } finally {
    shutdownResponse?.end();
    if (server.listening) {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    console.log = previousConsoleLog;
    console.error = previousConsoleError;
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("sidecar supervisor treats a clean daemon exit as terminal without restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-sidecar-clean-exit-"));
  const logPath = join(root, "sidecar.log");
  try {
    const supervisor = new BridgeSidecarSupervisor({
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      logPath,
      restartLimit: 3,
      restartDelayMs: 1
    });
    supervisor.start();
    const terminal = await supervisor.waitForTerminal();
    assert.equal(terminal.status, "stopped");
    assert.equal(terminal.restartCount, 0);
    assert.equal(supervisor.status().status, "stopped");
    assert.match(readFileSync(logPath, "utf8"), /clean-exit/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deterministic EADDRINUSE exits are terminal and never enter a restart loop", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-sidecar-port-terminal-"));
  const logPath = join(root, "sidecar.log");
  const supervisor = new BridgeSidecarSupervisor({
    command: process.execPath,
    args: ["-e", "process.stderr.write('EADDRINUSE BRIDGE_PORT_IN_USE\\n'); process.exit(1)"],
    logPath,
    restartLimit: 3,
    restartDelayMs: 10
  });
  try {
    supervisor.start();
    const terminal = await supervisor.waitForTerminal();
    await delay(40);
    assert.equal(terminal.status, "crashed");
    assert.equal(terminal.restartCount, 0);
    assert.equal(supervisor.status().restartCount, 0);
    assert.match(readFileSync(logPath, "utf8"), /sidecar\.terminal-failure/);
  } finally {
    await supervisor.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

function fakeBridgeService(readState: () => BridgeAppState): {
  fetch: ManagedBridgeFetch;
  online: boolean;
  kind: "hunsu" | "unrelated";
  instanceId: string;
  rotations: number;
  shutdowns: number;
} {
  const service = {
    online: true,
    kind: "hunsu" as "hunsu" | "unrelated",
    instanceId: "bridge_instance_synthetic_runtime",
    rotations: 0,
    shutdowns: 0,
    fetch: undefined as unknown as ManagedBridgeFetch
  };
  service.fetch = async (input, init = {}) => {
    if (!service.online) {
      throw new TypeError("offline");
    }
    const url = new URL(input);
    if (url.pathname === "/health") {
      return jsonResponse(service.kind === "hunsu"
        ? {
            ok: true,
            service: "hunsu-bridge",
            version: { bridgeVersion: "0.1.2", protocolVersion: "local-bridge-v1" }
          }
        : { ok: true, service: "another-service" });
    }
    const candidate = new Headers(init.headers).get("x-hunsu-bridge-control-token");
    if (candidate !== readState().controlToken || candidate !== CONTROL_TOKEN) {
      return jsonResponse({ code: "bridge_control_token_invalid" }, 401);
    }
    if (url.pathname === "/api/bridge/control/status") {
      return jsonResponse({
        ok: true,
        instanceId: service.instanceId,
        protocolVersion: "local-bridge-v1",
        bridgeVersion: "0.1.2",
        daemonPid: 4321,
        supervisorPid: 4000,
        startedAt: "2026-07-11T00:00:00.000Z",
        state: "running"
      });
    }
    if (url.pathname === "/api/bridge/pairing/rotate") {
      service.rotations += 1;
      const request = JSON.parse(String(init.body ?? "{}")) as { roadmapId?: string };
      const token = `synthetic-pairing-${service.rotations}`;
      const roadmapPath = request.roadmapId ? `/roadmaps/${request.roadmapId}` : "";
      return jsonResponse({
        studioUrl: `https://hunsu.app/studio${roadmapPath}?hunsuBridgeToken=${token}`,
        authToken: token
      }, 202);
    }
    if (url.pathname === "/api/bridge/control/shutdown") {
      service.shutdowns += 1;
      service.online = false;
      return jsonResponse({ shuttingDown: true }, 202);
    }
    return jsonResponse({ error: "not_found" }, 404);
  };
  return service;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}
