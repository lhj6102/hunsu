import assert from "node:assert/strict";
import test from "node:test";
import {
  computeManifestIntegrity,
  hubSeedPackageManifests
} from "../packages/protocol-registry/src/index.ts";
import {
  publishSeedManifest,
  seedHubPackages
} from "../apps/hub-api/scripts/seed-local.mjs";

const BASE_URL = "https://hub.example.test";
const TOKEN = "seed-token-must-stay-secret";
const [FIRST_MANIFEST, SECOND_MANIFEST] = hubSeedPackageManifests();

test("Hub seed retries a propagating 401 and preserves the publish request", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const sleeps: number[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init });
    return calls.length === 1
      ? jsonResponse(401, { error: "stale Worker secret" })
      : jsonResponse(201, { summary: FIRST_MANIFEST });
  };

  const result = await publishSeedManifest({
    baseUrl: `${BASE_URL}/`,
    token: TOKEN,
    manifest: FIRST_MANIFEST,
    attempts: 3,
    delayMs: 17,
    fetchImpl,
    sleep: async delay => { sleeps.push(delay); }
  });

  assert.equal(result, "published");
  assert.deepEqual(sleeps, [17]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
  assertPublishRequest(calls[0], FIRST_MANIFEST);
});

test("Hub seed retries network and 503 failures before success", async () => {
  let callCount = 0;
  const sleeps: number[] = [];
  const fetchImpl = async (): Promise<Response> => {
    callCount += 1;
    if (callCount === 1) throw new Error("connection reset");
    if (callCount === 2) return jsonResponse(503, { error: "deployment propagating" });
    return jsonResponse(201, {});
  };

  const result = await publishSeedManifest({
    baseUrl: BASE_URL,
    token: TOKEN,
    manifest: FIRST_MANIFEST,
    attempts: 4,
    delayMs: 9,
    fetchImpl,
    sleep: async delay => { sleeps.push(delay); }
  });

  assert.equal(result, "published");
  assert.equal(callCount, 3);
  assert.deepEqual(sleeps, [9, 9]);
});

for (const status of [400, 403]) {
  test(`Hub seed fails immediately for ${status}`, async () => {
    let callCount = 0;
    let sleepCount = 0;
    await assert.rejects(
      publishSeedManifest({
        baseUrl: BASE_URL,
        token: TOKEN,
        manifest: FIRST_MANIFEST,
        attempts: 4,
        delayMs: 5,
        fetchImpl: async () => {
          callCount += 1;
          return jsonResponse(status, { error: "configuration rejected" });
        },
        sleep: async () => { sleepCount += 1; }
      }),
      new RegExp(`Hub seed failed.*${status} configuration rejected`, "u")
    );
    assert.equal(callCount, 1);
    assert.equal(sleepCount, 0);
  });
}

test("Hub seed exhaustion neither sleeps after the last attempt nor leaks the token", async () => {
  let callCount = 0;
  const sleeps: number[] = [];
  const error = await captureError(() => publishSeedManifest({
    baseUrl: BASE_URL,
    token: TOKEN,
    manifest: FIRST_MANIFEST,
    attempts: 2,
    delayMs: 3,
    fetchImpl: async () => {
      callCount += 1;
      return jsonResponse(401, { error: `Bearer ${TOKEN}` });
    },
    sleep: async delay => { sleeps.push(delay); }
  }));

  assert.equal(callCount, 2);
  assert.deepEqual(sleeps, [3]);
  assert.doesNotMatch(error.message, new RegExp(TOKEN, "u"));
  assert.match(error.message, /\[REDACTED\]/u);
});

test("Hub seed accepts a 409 only when the immutable manifest integrity matches", async () => {
  const calls: string[] = [];
  const storedManifest = {
    ...FIRST_MANIFEST,
    integrity: computeManifestIntegrity(FIRST_MANIFEST)
  };
  const result = await publishSeedManifest({
    baseUrl: BASE_URL,
    token: TOKEN,
    manifest: FIRST_MANIFEST,
    attempts: 2,
    delayMs: 1,
    fetchImpl: async (input, init) => {
      calls.push(String(input));
      return init?.method === "POST"
        ? jsonResponse(409, { error: "already exists" })
        : jsonResponse(200, storedManifest);
    },
    sleep: async () => { throw new Error("unexpected sleep"); }
  });

  assert.equal(result, "already-present");
  assert.deepEqual(calls, [
    `${BASE_URL}/api/hub/packages`,
    immutableUrl(FIRST_MANIFEST)
  ]);
});

test("Hub seed rejects a 409 whose immutable manifest has different integrity", async () => {
  const mismatchedManifest = {
    ...FIRST_MANIFEST,
    version: `${FIRST_MANIFEST.version}-different`
  };
  await assert.rejects(
    publishSeedManifest({
      baseUrl: BASE_URL,
      token: TOKEN,
      manifest: FIRST_MANIFEST,
      attempts: 3,
      delayMs: 1,
      fetchImpl: async (_input, init) => init?.method === "POST"
        ? jsonResponse(409, { error: "already exists" })
        : jsonResponse(200, mismatchedManifest),
      sleep: async () => { throw new Error("unexpected sleep"); }
    }),
    /immutable manifest integrity mismatch/u
  );
});

test("Hub seed rejects a 409 whose immutable manifest declares a mismatched integrity", async () => {
  const storedManifest = {
    ...FIRST_MANIFEST,
    integrity: `sha256:${"f".repeat(64)}`
  };
  await assert.rejects(
    publishSeedManifest({
      baseUrl: BASE_URL,
      token: TOKEN,
      manifest: FIRST_MANIFEST,
      attempts: 3,
      delayMs: 1,
      fetchImpl: async (_input, init) => init?.method === "POST"
        ? jsonResponse(409, { error: "already exists" })
        : jsonResponse(200, storedManifest),
      sleep: async () => { throw new Error("unexpected sleep"); }
    }),
    /immutable manifest integrity mismatch/u
  );
});

test("Hub seed reproduces the CI 409 then 401 secret-propagation sequence", async () => {
  assert.ok(FIRST_MANIFEST);
  assert.ok(SECOND_MANIFEST);
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const storedFirstManifest = {
    ...FIRST_MANIFEST,
    integrity: computeManifestIntegrity(FIRST_MANIFEST)
  };
  const responses = [
    jsonResponse(409, { error: "already present" }),
    jsonResponse(200, storedFirstManifest),
    jsonResponse(401, { error: "retry second" }),
    jsonResponse(201, {})
  ];
  await seedHubPackages({
    baseUrl: BASE_URL,
    token: TOKEN,
    manifests: [FIRST_MANIFEST, SECOND_MANIFEST],
    attempts: 2,
    delayMs: 0,
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), init });
      const response = responses.shift();
      assert.ok(response);
      return response;
    },
    sleep: async () => {},
    log: () => {}
  });

  assert.equal(calls.length, 4);
  assert.deepEqual(calls[2], calls[3]);
  assertPublishRequest(calls[0], FIRST_MANIFEST);
  assert.equal(calls[1]?.url, immutableUrl(FIRST_MANIFEST));
  assert.equal(calls[1]?.init, undefined);
  assertPublishRequest(calls[2], SECOND_MANIFEST);
});

function assertPublishRequest(call: { url: string; init?: RequestInit }, manifest: unknown): void {
  assert.equal(call.url, `${BASE_URL}/api/hub/packages`);
  assert.equal(call.init?.method, "POST");
  assert.equal(new Headers(call.init?.headers).get("content-type"), "application/json");
  assert.equal(new Headers(call.init?.headers).get("authorization"), `Bearer ${TOKEN}`);
  assert.equal(call.init?.body, JSON.stringify({ manifest, publishedBy: "hub-seed" }));
}

function immutableUrl(manifest: { kind: string; key: string; version: string }): string {
  return `${BASE_URL}/v1/packages/${encodeURIComponent(manifest.kind)}/${encodeURIComponent(manifest.key)}/versions/${encodeURIComponent(manifest.version)}`;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

async function captureError(operation: () => Promise<unknown>): Promise<Error> {
  try {
    await operation();
  } catch (error) {
    assert.ok(error instanceof Error);
    return error;
  }
  throw new Error("Expected operation to fail");
}
