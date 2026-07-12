import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CONNECT_SIGNAL_FRAME_SCHEMA } from "../packages/protocol/src/connect.ts";
import {
  base64UrlDecode,
  base64UrlEncode,
  completeBrowserPeerHandshake,
  createBrowserAgreementKey,
  createBrowserSignalCryptoContext,
  peerHandshakeTranscript
} from "../apps/web/src/shared/api/peerCrypto.ts";

const TEST_ROOT = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(TEST_ROOT, "../apps/web");
const subtle = webcrypto.subtle as unknown as SubtleCrypto;

test("hosted Web uses cookie-authenticated Connect metadata and never an HTTP command proxy", () => {
  const apiBase = readFileSync(join(WEB_ROOT, "src/shared/api/bridgeApiBase.ts"), "utf8");
  const connectClient = readFileSync(join(WEB_ROOT, "src/shared/api/connectClient.ts"), "utf8");
  const bridgeClient = readFileSync(join(WEB_ROOT, "src/shared/api/bridgeClient.ts"), "utf8");
  const connectionCenter = readFileSync(join(WEB_ROOT, "src/features/connection/ConnectionCenter.tsx"), "utf8");
  const hostedSource = `${apiBase}\n${connectClient}\n${bridgeClient}\n${connectionCenter}`;

  assert.doesNotMatch(hostedSource, /access_token|x-hunsu-connect-token|CONNECT_ACCESS_TOKEN|authorization.*Connect/iu);
  assert.match(bridgeClient, /currentActiveRemotePeer\(\)/u);
  assert.match(bridgeClient, /peer\.request<unknown>/u);
  assert.match(connectClient, /credentials:\s*"include"/u);
  assert.match(connectClient, /"\/auth\/session"/u);
  assert.match(connectClient, /"\/v1\/devices"/u);
  assert.match(connectClient, /"\/v1\/connect\/sessions"/u);
  assert.match(connectClient, /browserAgreementPublicJwk/u);
  assert.doesNotMatch(connectClient, /repositoryPath|projectPath|workspaces/u);
  assert.match(connectionCenter, /connectRemoteBridgeDevice/u);
  assert.match(connectionCenter, /Establish peer/u);
  assert.match(apiBase, /hunsuBridgeToken/u, "local Bridge pairing remains available");
  assert.match(apiBase, /hunsu\.remotePeerSelection\.v1/u);
  const storedSelectionType = apiBase.match(/export type RemoteBridgeSession = \{[^}]+\};/u)?.[0] ?? "";
  assert.doesNotMatch(storedSelectionType, /repositoryPath|projectPath|webUserId|ticket|credential/u);
});

test("Connect account login uses top-level Access navigation while status and logout use only the HttpOnly cookie", async () => {
  const previousFetch = globalThis.fetch;
  const previousWindow = (globalThis as unknown as { window?: unknown }).window;
  const calls: Array<{ path: string; method: string; credentials?: RequestCredentials }> = [];
  (globalThis as unknown as { window: unknown }).window = browserWindow("https://preview.hunsu.app/studio?panel=connections");
  globalThis.fetch = async (url, init) => {
    calls.push({ path: new URL(String(url)).pathname, method: init?.method ?? "GET", credentials: init?.credentials });
    if (init?.method === "DELETE") return Response.json({ authenticated: false, user: null });
    return Response.json({ authenticated: true, user: { accountId: "ca_123" } });
  };
  const loaded = await loadWebModule<{
    connectAccountLoginUrl(): string;
    fetchConnectAccountSession(): Promise<{ authenticated: boolean; user?: { userId: string } }>;
    logoutConnectAccountSession(): Promise<void>;
  }>("/src/shared/api/connectClient.ts");
  try {
    const session = await loaded.module.fetchConnectAccountSession();
    assert.equal(session.authenticated, true);
    assert.equal(session.user?.userId, "ca_123");
    assert.equal(loaded.module.connectAccountLoginUrl(), "https://connect.example.test/auth/login");
    await loaded.module.logoutConnectAccountSession();
    assert.deepEqual(calls, [
      { path: "/auth/session", method: "GET", credentials: "include" },
      { path: "/auth/session", method: "DELETE", credentials: "include" }
    ]);
  } finally {
    await loaded.close();
    globalThis.fetch = previousFetch;
    (globalThis as unknown as { window?: unknown }).window = previousWindow;
  }
});

test("browser signaling is opaque AES-GCM with strict directional nonces and replay rejection", async () => {
  const device = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const devicePublicJwk = await subtle.exportKey("jwk", device.publicKey);
  const browser = await createBrowserAgreementKey(subtle);
  const sessionId = "cs_0123456789abcdefghijklmnop";
  const browserContext = await createBrowserSignalCryptoContext({
    agreement: browser,
    deviceAgreementPublicJwk: devicePublicJwk,
    sessionId,
    subtle
  });
  const bridgeKey = await deriveSignalKey(device.privateKey, browser.publicKeyJwk, sessionId);

  const outgoing = await browserContext.encrypt({ type: "peer.offer", sdp: "opaque-offer" });
  assert.deepEqual(Object.keys(outgoing), ["schema", "sessionId", "sequence", "iv", "ciphertext"]);
  assert.equal(outgoing.schema, CONNECT_SIGNAL_FRAME_SCHEMA);
  assert.equal(outgoing.sequence, 1);
  assert.doesNotMatch(JSON.stringify(outgoing), /opaque-offer/u);
  assert.deepEqual(
    await decryptSignal(bridgeKey, outgoing, "browser"),
    { type: "peer.offer", sdp: "opaque-offer" }
  );

  const incoming = await encryptSignal(bridgeKey, sessionId, 1, "bridge", { type: "peer.answer", sdp: "opaque-answer" });
  assert.deepEqual(await browserContext.decrypt(incoming), { type: "peer.answer", sdp: "opaque-answer" });
  await assert.rejects(() => browserContext.decrypt(incoming), /replayed/u);
});

test("Bridge-signed transcript derives four directional data keys and rejects replay", async () => {
  const nowMs = Date.parse("2026-07-12T00:00:00.000Z");
  let clockMs = nowMs;
  const browser = await createBrowserAgreementKey(subtle);
  const bridge = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const signing = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const bridgePublicJwk = await subtle.exportKey("jwk", bridge.publicKey);
  const signingPublicJwk = await subtle.exportKey("jwk", signing.publicKey);
  const sessionId = "cs_0123456789abcdefghijklmnop";
  const accountId = "ca_0123456789abcdefghijklmnop";
  const deviceId = "cd_0123456789abcdefghijklmnop";
  const ticket = "header.payload.signature";
  const browserNonce = base64UrlEncode(new Uint8Array(24).fill(7));
  const bridgeNonce = base64UrlEncode(new Uint8Array(24).fill(9));
  const leaseExpiresAt = new Date(nowMs + 12 * 60_000).toISOString();
  const ticketDigest = base64UrlEncode(new Uint8Array(await subtle.digest("SHA-256", buffer(ticket))));
  const transcript = peerHandshakeTranscript({
    sessionId,
    accountId,
    deviceId,
    ticketDigest,
    browserAgreementPublicJwk: browser.publicKeyJwk,
    bridgeEphemeralPublicJwk: bridgePublicJwk,
    browserNonce,
    bridgeNonce,
    leaseExpiresAt
  });
  const transcriptHashBytes = new Uint8Array(await subtle.digest("SHA-256", buffer(transcript)));
  const transcriptHash = base64UrlEncode(transcriptHashBytes);
  const signature = base64UrlEncode(new Uint8Array(await subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    signing.privateKey,
    buffer(transcriptHashBytes)
  )));
  const browserContext = await completeBrowserPeerHandshake({
    agreement: browser,
    sessionId,
    accountId,
    deviceId,
    ticket,
    browserNonce,
    serverHello: {
      type: "peer.server-hello",
      protocolVersion: "hunsu-peer-v1",
      sessionId,
      bridgeEphemeralPublicJwk: bridgePublicJwk,
      bridgeNonce,
      leaseExpiresAt,
      transcriptHash,
      signature
    },
    deviceSigningPublicKeyJwk: signingPublicJwk,
    subtle,
    now: () => clockMs
  });
  const bridgeKeys = await derivePeerDataKeys(bridge.privateKey, browser.publicKeyJwk, transcriptHashBytes);

  const outbound = await browserContext.encryptJson("control", { type: "session.confirm", sessionId, transcriptHash });
  assert.deepEqual(
    await decryptDataFrame(bridgeKeys.browserControl, outbound, sessionId, "control", "browser"),
    { type: "session.confirm", sessionId, transcriptHash }
  );
  const inbound = await encryptDataFrame(bridgeKeys.bridgeControl, sessionId, "control", "bridge", 1, { type: "session.ready" });
  assert.deepEqual(await browserContext.decryptJson(inbound, "control"), { type: "session.ready" });
  await assert.rejects(() => browserContext.decryptJson(inbound, "control"), /replayed/u);
  clockMs = Date.parse(leaseExpiresAt);
  await assert.rejects(() => browserContext.encryptJson("stream", { type: "after-expiry" }), /lease has expired/u);
});

test("WebRTC configuration is STUN-only and creates exactly the two reliable ordered channels", () => {
  const source = readFileSync(join(WEB_ROOT, "src/shared/api/peerTransport.ts"), "utf8");
  const protocol = readFileSync(resolve(TEST_ROOT, "../packages/protocol/src/remote-peer.ts"), "utf8");
  assert.match(protocol, /stun:stun\.cloudflare\.com:3478/u);
  assert.doesNotMatch(`${source}\n${protocol}`, /turn:/iu);
  assert.match(source, /createDataChannel\(HUNSU_CONTROL_CHANNEL, \{ ordered: true \}\)/u);
  assert.match(source, /createDataChannel\(HUNSU_STREAM_CHANNEL, \{ ordered: true \}\)/u);
  assert.match(source, /maxRetransmits !== null/u);
  assert.match(source, /maxPacketLifeTime !== null/u);
});

test("browser command authority is derived from the Bridge Workspace grant", async () => {
  const loaded = await loadWebModule<{
    requiredScopesForPeerCommand(name: string): string[];
    assertWorkspaceScopeAuthority(workspace: { workspaceId: string; displayName: string; scopes: string[] }, name: string): void;
  }>("/src/shared/api/peerTransport.ts");
  try {
    assert.deepEqual(loaded.module.requiredScopesForPeerCommand("execute.start"), ["remote.access", "execute.start"]);
    assert.deepEqual(loaded.module.requiredScopesForPeerCommand("artifactAction.list"), ["remote.access", "env.read", "hostAlias.expose"]);
    assert.throws(
      () => loaded.module.assertWorkspaceScopeAuthority({ workspaceId: "workspace_1", displayName: "QA", scopes: ["remote.access"] }, "execute.start"),
      /execute\.start/u
    );
    loaded.module.assertWorkspaceScopeAuthority(
      { workspaceId: "workspace_1", displayName: "QA", scopes: ["remote.access", "execute.start"] },
      "execute.start"
    );
  } finally {
    await loaded.close();
  }
});

async function deriveSignalKey(devicePrivateKey: CryptoKey, browserPublicJwk: JsonWebKey, sessionId: string): Promise<CryptoKey> {
  const browserPublic = await subtle.importKey("jwk", browserPublicJwk, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await subtle.deriveBits({ name: "ECDH", public: browserPublic }, devicePrivateKey, 256);
  const material = await subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const raw = await subtle.deriveBits({
    name: "HKDF",
    hash: "SHA-256",
    salt: buffer(sessionId),
    info: buffer("hunsu.connect.signal.v1")
  }, material, 256);
  return subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function derivePeerDataKeys(bridgePrivateKey: CryptoKey, browserPublicJwk: JsonWebKey, transcriptHash: Uint8Array) {
  const browserPublic = await subtle.importKey("jwk", browserPublicJwk, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await subtle.deriveBits({ name: "ECDH", public: browserPublic }, bridgePrivateKey, 256);
  const material = await subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const directional = new Uint8Array(await subtle.deriveBits({
    name: "HKDF",
    hash: "SHA-256",
    salt: buffer(transcriptHash),
    info: buffer("hunsu.peer.data.v1")
  }, material, 1024));
  return {
    browserControl: await subtle.importKey("raw", directional.slice(0, 32), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]),
    bridgeControl: await subtle.importKey("raw", directional.slice(32, 64), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]),
    browserStream: await subtle.importKey("raw", directional.slice(64, 96), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]),
    bridgeStream: await subtle.importKey("raw", directional.slice(96, 128), { name: "AES-GCM" }, false, ["encrypt", "decrypt"])
  };
}

async function encryptDataFrame(
  key: CryptoKey,
  sessionId: string,
  channel: "control" | "stream",
  role: "browser" | "bridge",
  sequence: number,
  value: unknown
): Promise<string> {
  const nonce = await dataNonce(channel, role, sequence);
  const ciphertext = await subtle.encrypt({
    name: "AES-GCM",
    iv: buffer(nonce),
    additionalData: buffer(`hunsu-peer-v1:${sessionId}:${channel}:${sequence}`),
    tagLength: 128
  }, key, buffer(JSON.stringify(value)));
  return JSON.stringify({
    version: "hunsu-peer-v1",
    sessionId,
    channel,
    sequence,
    nonce: base64UrlEncode(nonce),
    ciphertext: base64UrlEncode(new Uint8Array(ciphertext))
  });
}

async function decryptDataFrame(
  key: CryptoKey,
  raw: string,
  sessionId: string,
  channel: "control" | "stream",
  role: "browser" | "bridge"
): Promise<unknown> {
  const frame = JSON.parse(raw) as { sequence: number; nonce: string; ciphertext: string };
  const nonce = await dataNonce(channel, role, frame.sequence);
  assert.deepEqual(base64UrlDecode(frame.nonce), nonce);
  const plaintext = await subtle.decrypt({
    name: "AES-GCM",
    iv: buffer(nonce),
    additionalData: buffer(`hunsu-peer-v1:${sessionId}:${channel}:${frame.sequence}`),
    tagLength: 128
  }, key, buffer(base64UrlDecode(frame.ciphertext)));
  return JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
}

async function dataNonce(channel: "control" | "stream", role: "browser" | "bridge", sequence: number): Promise<Uint8Array> {
  const digest = new Uint8Array(await subtle.digest("SHA-256", buffer(`hunsu.peer.data.nonce/${channel}/${role}`)));
  const nonce = new Uint8Array(12);
  nonce.set(digest.slice(0, 4));
  new DataView(nonce.buffer).setBigUint64(4, BigInt(sequence), false);
  return nonce;
}

async function encryptSignal(key: CryptoKey, sessionId: string, sequence: number, role: "browser" | "bridge", value: unknown) {
  const iv = await signalNonce(role, sequence);
  const ciphertext = await subtle.encrypt({
    name: "AES-GCM",
    iv: buffer(iv),
    additionalData: buffer(`${CONNECT_SIGNAL_FRAME_SCHEMA}:${sessionId}:${sequence}`),
    tagLength: 128
  }, key, buffer(JSON.stringify(value)));
  return {
    schema: CONNECT_SIGNAL_FRAME_SCHEMA,
    sessionId,
    sequence,
    iv: base64UrlEncode(iv),
    ciphertext: base64UrlEncode(new Uint8Array(ciphertext))
  };
}

async function decryptSignal(key: CryptoKey, frame: Awaited<ReturnType<typeof encryptSignal>>, role: "browser" | "bridge") {
  const iv = await signalNonce(role, frame.sequence);
  assert.deepEqual(base64UrlDecode(frame.iv), iv);
  const plaintext = await subtle.decrypt({
    name: "AES-GCM",
    iv: buffer(iv),
    additionalData: buffer(`${CONNECT_SIGNAL_FRAME_SCHEMA}:${frame.sessionId}:${frame.sequence}`),
    tagLength: 128
  }, key, buffer(base64UrlDecode(frame.ciphertext)));
  return JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
}

async function signalNonce(role: "browser" | "bridge", sequence: number): Promise<Uint8Array> {
  const digest = new Uint8Array(await subtle.digest("SHA-256", buffer(`hunsu.connect.signal.nonce/${role}`)));
  const iv = new Uint8Array(12);
  iv.set(digest.slice(0, 4));
  new DataView(iv.buffer).setBigUint64(4, BigInt(sequence), false);
  return iv;
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function buffer(value: string | Uint8Array): ArrayBuffer {
  return Uint8Array.from(typeof value === "string" ? bytes(value) : value).buffer;
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

function browserWindow(href: string) {
  return {
    location: new URL(href),
    history: { state: undefined, replaceState() {} },
    localStorage: new MemoryStorage(),
    __HUNSU_WEB_RUNTIME_CONFIG__: undefined,
    setTimeout,
    clearTimeout
  };
}

async function loadWebModule<T>(path: string): Promise<{ module: T; close: () => Promise<void> }> {
  const vite = await import("../apps/web/node_modules/vite/dist/node/index.js");
  const server = await vite.createServer({
    root: WEB_ROOT,
    configFile: false,
    appType: "custom",
    logLevel: "silent",
    resolve: { alias: { "@": resolve(WEB_ROOT, "src") } },
    define: {
      __HUNSU_BRIDGE_API_BASE_URL__: JSON.stringify(""),
      __HUNSU_CONNECT_API_BASE_URL__: JSON.stringify("https://connect.example.test"),
      __HUNSU_HUB_API_BASE_URL__: JSON.stringify("")
    },
    server: { middlewareMode: true }
  });
  try {
    const module = await server.ssrLoadModule(path) as T;
    return { module, close: () => server.close() };
  } catch (error) {
    await server.close();
    throw error;
  }
}
