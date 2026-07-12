import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBridgeControlClient } from "../apps/bridge/src/client/controlClient.ts";
import { createCredentialStore } from "../apps/bridge/src/state/credentialStore.ts";
import { resolveHunsuPaths } from "../apps/bridge/src/state/paths.ts";

test("the typed control probe distinguishes offline, foreign, healthy, and unhealthy endpoints", async () => {
  const paths = resolveHunsuPaths({ home: join(tmpdir(), "hunsu-control-probe-unused") });
  const offline = createBridgeControlClient({
    paths,
    endpoint: "http://127.0.0.1:19687",
    fetchImpl: async () => { throw new TypeError("connection refused"); }
  });
  assert.deepEqual(await offline.probe(), { state: "offline" });
  assertFailure(await offline.request("/v1/control/status"), "BRIDGE_NOT_RUNNING");

  const foreign = createBridgeControlClient({
    paths,
    endpoint: "http://127.0.0.1:19687",
    fetchImpl: async () => jsonResponse({ ok: true, service: "another-service" })
  });
  assert.deepEqual(await foreign.probe(), { state: "foreign-listener" });
  assertFailure(await foreign.request("/v1/control/status"), "BRIDGE_PORT_IN_USE");

  const unhealthy = createBridgeControlClient({
    paths,
    endpoint: "http://127.0.0.1:19687",
    fetchImpl: async () => jsonResponse({ ok: false, service: "hunsu-bridge" }, 503)
  });
  assert.deepEqual(await unhealthy.probe(), { state: "hunsu-unhealthy", status: 503 });
  assertFailure(await unhealthy.request("/v1/control/status"), "BRIDGE_CONTROL_UNAVAILABLE");

  const healthy = createBridgeControlClient({
    paths,
    endpoint: "http://127.0.0.1:19687",
    fetchImpl: async () => healthResponse()
  });
  assert.deepEqual(await healthy.probe(), { state: "hunsu-healthy" });
});

test("invalid config JSON, schema, and non-loopback endpoints remain BRIDGE_STATE_INVALID with safe messages", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunsu-control-invalid-config-"));
  const paths = resolveHunsuPaths({ home: join(root, "private-state") });
  let fetchCalls = 0;
  const fetchImpl: typeof fetch = async () => {
    fetchCalls += 1;
    return healthResponse();
  };
  try {
    await mkdir(paths.home, { recursive: true });
    await writeFile(paths.configFile, "{not-json", "utf8");
    const invalidJson = await createBridgeControlClient({ paths, fetchImpl }).request("/v1/control/status");
    assertSafeStateFailure(invalidJson, root, "config.json");

    await writeFile(paths.configFile, `${JSON.stringify({ schema: "wrong" })}\n`, "utf8");
    const invalidSchema = await createBridgeControlClient({ paths, fetchImpl }).request("/v1/control/status");
    assertSafeStateFailure(invalidSchema, root, "config.json");

    await writeFile(paths.configFile, `${JSON.stringify({
      schema: "hunsu.bridge.config.v1",
      host: "bridge.example.invalid",
      port: 19687,
      provider: { kind: "unconfigured" },
      remote: { enabled: false }
    })}\n`, "utf8");
    const nonLoopback = await createBridgeControlClient({ paths, fetchImpl }).request("/v1/control/status");
    assertFailure(nonLoopback, "BRIDGE_STATE_INVALID");
    assert.equal(JSON.stringify(nonLoopback).includes(root), false);
    assert.equal(fetchCalls, 0, "invalid state must fail before probing an endpoint");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid and unreadable credentials remain BRIDGE_STATE_INVALID after valid Hunsu health", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunsu-control-invalid-credentials-"));
  const paths = resolveHunsuPaths({ home: join(root, "private-state") });
  const fetchImpl: typeof fetch = async () => healthResponse();
  try {
    await mkdir(paths.home, { recursive: true });
    await writeFile(paths.credentialsFile, `${JSON.stringify({ schema: "wrong" })}\n`, "utf8");
    const invalidSchema = await createBridgeControlClient({ paths, fetchImpl }).request("/v1/control/status");
    assertSafeStateFailure(invalidSchema, root, "credentials.json");

    await rm(paths.credentialsFile, { recursive: true, force: true });
    await mkdir(paths.credentialsFile);
    const unreadable = await createBridgeControlClient({ paths, fetchImpl }).request("/v1/control/status");
    assertSafeStateFailure(unreadable, root, "credentials.json");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("valid Hunsu health maps missing and rejected control credentials to unauthorized", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunsu-control-unauthorized-"));
  const paths = resolveHunsuPaths({ home: join(root, "state") });
  try {
    let calls = 0;
    const missingFetch: typeof fetch = async () => {
      calls += 1;
      return healthResponse();
    };
    const missing = await createBridgeControlClient({ paths, fetchImpl: missingFetch }).request("/v1/control/status");
    assertFailure(missing, "BRIDGE_CONTROL_UNAUTHORIZED");
    assert.equal(calls, 1, "missing credentials must not trigger an authenticated request");

    const credentials = await createCredentialStore(paths).write({ controlToken: "hunsu_control_wrong" });
    const rejectedFetch: typeof fetch = async (_resource, init) => {
      calls += 1;
      if (calls === 2) return healthResponse();
      assert.equal(new Headers(init?.headers).get("x-hunsu-bridge-control-token"), credentials.controlToken);
      return jsonResponse({ error: "unauthorized" }, 401);
    };
    const rejected = await createBridgeControlClient({ paths, fetchImpl: rejectedFetch }).request("/v1/control/status");
    assertFailure(rejected, "BRIDGE_CONTROL_UNAUTHORIZED");
    assert.equal(JSON.stringify(rejected).includes(credentials.controlToken), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a malformed authenticated control response maps to BRIDGE_CONTROL_UNAVAILABLE", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunsu-control-malformed-"));
  const paths = resolveHunsuPaths({ home: join(root, "state") });
  try {
    await createCredentialStore(paths).write({ controlToken: "hunsu_control_test" });
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return calls === 1
        ? healthResponse()
        : new Response("{malformed", { status: 200, headers: { "content-type": "application/json" } });
    };
    const result = await createBridgeControlClient({ paths, fetchImpl }).request("/v1/control/status");
    assertFailure(result, "BRIDGE_CONTROL_UNAVAILABLE");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function healthResponse(): Response {
  return jsonResponse({
    ok: true,
    service: "hunsu-bridge",
    version: "0.2.0-test",
    protocolVersion: "local-bridge-v1"
  });
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function assertFailure(result: { ok: boolean; code: string }, code: string): void {
  assert.equal(result.ok, false);
  assert.equal(result.code, code);
}

function assertSafeStateFailure(
  result: { ok: boolean; code: string; message: string },
  privateRoot: string,
  basename: string
): void {
  assertFailure(result, "BRIDGE_STATE_INVALID");
  assert.match(result.message, new RegExp(basename.replace(".", "\\."), "u"));
  assert.equal(JSON.stringify(result).includes(privateRoot), false);
}
