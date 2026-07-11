import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { resolveBridgeRuntimeConfig, unwrapConfigResult } from "../packages/config/src/index.ts";
import { createBridgeSupervisor } from "../apps/bridge/src/index.ts";
import {
  createManagedBridgeRuntime,
  type ManagedBridgeFetch
} from "../apps/bridge-desktop/src/processes/managedBridgeRuntime.ts";
import {
  defaultBridgeAppState,
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
