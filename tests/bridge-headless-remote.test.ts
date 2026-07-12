import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CONNECT_SIGNAL_FRAME_SCHEMA,
  connectEnrollmentProofMessage
} from "../packages/protocol/src/connect.ts";
import {
  REMOTE_PEER_CONTROL_CHANNEL,
  REMOTE_PEER_STREAM_CHANNEL,
  REMOTE_PEER_STUN_URL,
  decodeRemotePeerClientHello
} from "../packages/protocol/src/remote-peer.ts";
import {
  canonicalPublicJwk,
  createPeerDataCryptoContext,
  createSignalCryptoContext,
  generateDeviceKeySet,
  peerTranscript,
  signEnrollmentProof,
  validateRemoteSdp,
  verifyConnectTicket
} from "../apps/bridge/src/remote/peerCrypto.ts";
import { createWeriftPeerTransportFactory } from "../apps/bridge/src/remote/peerTransport.ts";
import type { PeerTransport } from "../apps/bridge/src/remote/peerTransport.ts";
import { createRemoteService } from "../apps/bridge/src/remote/remoteService.ts";
import { createRemoteCommandRouter } from "../apps/bridge/src/remote/remoteCommandRouter.ts";
import {
  createConfigStore,
  createCredentialStore,
  createWorkspaceStore,
  resolveHunsuPaths
} from "../apps/bridge/src/state/index.ts";
import { createWorkspaceService } from "../apps/bridge/src/workspaces/workspaceService.ts";
import {
  FakeConnectSocket,
  FakePeerDataChannel,
  browserSignalCipher,
  decryptDataFrame,
  decryptSignal,
  deriveBrowserControlCipher,
  encryptDataFrame,
  encryptSignal,
  signTicket,
  validSdp,
  waitFor
} from "./fixtures/deterministic-connect-p2p.ts";

const subtle = webcrypto.subtle;

test("device enrollment proof uses the exact P-256 canonical transcript", async () => {
  const keys = await generateDeviceKeySet();
  const input = {
    deviceName: "QA workstation",
    signingPublicJwk: canonicalPublicJwk(keys.signingPublicKey),
    agreementPublicJwk: canonicalPublicJwk(keys.agreementPublicKey),
    issuedAt: "2026-07-12T00:00:00.000Z",
    nonce: "nonce_012345678901234567890123"
  };
  const proof = await signEnrollmentProof({ ...input, signingPrivateKey: keys.signingPrivateKey });
  assert.equal(Buffer.from(proof, "base64url").byteLength, 64);
  const publicKey = await subtle.importKey("jwk", keys.signingPublicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  assert.equal(await subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    Buffer.from(proof, "base64url"),
    new TextEncoder().encode(connectEnrollmentProofMessage(input))
  ), true);
});

test("Connect tickets are exact-profile, browser-key-bound, short lived, and one use", async () => {
  const signing = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const browser = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const signingPublicKey = await subtle.exportKey("jwk", signing.publicKey);
  const browserAgreementPublicJwk = canonicalPublicJwk(await subtle.exportKey("jwk", browser.publicKey));
  const claims = {
    iss: "https://connect.preview.hunsu.app",
    aud: "hunsu-bridge",
    sub: "device_123",
    jti: "ticket_123",
    environment: "preview",
    sessionId: "cs_12345678901234567890",
    accountId: "account_123",
    deviceId: "device_123",
    browserAgreementPublicJwk,
    iat: 1_783_814_400,
    exp: 1_783_814_490
  } as const;
  const ticket = await signTicket(signing.privateKey, "preview-key", claims);
  const consumed = new Set<string>();
  const verify = () => verifyConnectTicket({
    ticket,
    signingPublicKey,
    expectedKeyId: "preview-key",
    expectedIssuer: claims.iss,
    expectedEnvironment: "preview",
    expectedSessionId: claims.sessionId,
    expectedDeviceId: claims.deviceId,
    expectedBrowserAgreementPublicJwk: browserAgreementPublicJwk,
    now: new Date("2026-07-12T00:00:30.000Z"),
    consume: id => !consumed.has(id) && Boolean(consumed.add(id))
  });
  assert.deepEqual(await verify(), claims);
  await assert.rejects(verify, /already used/u);
  await assert.rejects(() => verifyConnectTicket({
    ticket,
    signingPublicKey,
    expectedKeyId: "preview-key",
    expectedIssuer: claims.iss,
    expectedEnvironment: "production",
    expectedSessionId: claims.sessionId,
    expectedDeviceId: claims.deviceId,
    now: new Date("2026-07-12T00:00:30.000Z"),
    consume: () => true
  }), /binding/u);
});

test("opaque signaling uses the enrolled device agreement key and strict directional sequences", async () => {
  const device = await generateDeviceKeySet();
  const browser = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const browserPublic = await subtle.exportKey("jwk", browser.publicKey);
  const sessionId = "cs_12345678901234567890";
  const bridge = await createSignalCryptoContext({
    sessionId,
    browserAgreementPublicJwk: browserPublic,
    deviceAgreementPrivateKey: device.agreementPrivateKey
  });
  const browserCipher = await browserSignalCipher(browser.privateKey, device.agreementPublicKey, sessionId);
  const browserFrame = await encryptSignal(browserCipher, sessionId, 1, "browser", { type: "peer.close", reason: "complete" });
  assert.deepEqual(await bridge.decrypt(browserFrame), { type: "peer.close", reason: "complete" });
  await assert.rejects(() => bridge.decrypt(browserFrame), /sequence/u);
  const response = await bridge.encrypt({ type: "peer.answer", sdp: "encrypted-only" });
  assert.equal(response.schema, CONNECT_SIGNAL_FRAME_SCHEMA);
  assert.deepEqual(await decryptSignal(browserCipher, response, "bridge"), { type: "peer.answer", sdp: "encrypted-only" });
});

test("signed DataChannel transcript derives four interoperable directional keys", async () => {
  const device = await generateDeviceKeySet();
  const browser = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const browserPublic = canonicalPublicJwk(await subtle.exportKey("jwk", browser.publicKey));
  const ticketClaims = {
    iss: "https://connect.preview.hunsu.app",
    aud: "hunsu-bridge",
    sub: "device_123",
    jti: "ticket_123",
    environment: "preview",
    sessionId: "cs_12345678901234567890",
    accountId: "account_123",
    deviceId: "device_123",
    browserAgreementPublicJwk: browserPublic,
    iat: 1_783_814_400,
    exp: 1_783_814_490
  } as const;
  const ticket = "signed.ticket.value";
  const browserNonce = Buffer.alloc(24, 4).toString("base64url");
  const bridge = await createPeerDataCryptoContext({
    sessionId: ticketClaims.sessionId,
    ticket,
    ticketClaims,
    browserNonce,
    deviceSigningPrivateKey: device.signingPrivateKey,
    now: () => new Date("2026-07-12T00:00:30.000Z"),
    randomBytes: size => new Uint8Array(size).fill(8)
  });
  const ticketDigest = Buffer.from(await subtle.digest("SHA-256", new TextEncoder().encode(ticket))).toString("base64url");
  const transcript = peerTranscript({
    sessionId: ticketClaims.sessionId,
    accountId: ticketClaims.accountId,
    deviceId: ticketClaims.deviceId,
    ticketDigest,
    browserAgreementPublicJwk: browserPublic,
    bridgeEphemeralPublicJwk: bridge.serverHello.bridgeEphemeralPublicJwk,
    browserNonce,
    bridgeNonce: bridge.serverHello.bridgeNonce,
    leaseExpiresAt: bridge.serverHello.leaseExpiresAt
  });
  const transcriptHash = new Uint8Array(await subtle.digest("SHA-256", transcript));
  assert.equal(Buffer.from(transcriptHash).toString("base64url"), bridge.transcriptHash);
  const signingPublic = await subtle.importKey("jwk", device.signingPublicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  assert.equal(await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, signingPublic, Buffer.from(bridge.serverHello.signature, "base64url"), transcriptHash), true);

  const bridgePublic = await subtle.importKey("jwk", bridge.serverHello.bridgeEphemeralPublicJwk, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await subtle.deriveBits({ name: "ECDH", public: bridgePublic }, browser.privateKey, 256);
  const master = await subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const directional = new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: transcriptHash, info: new TextEncoder().encode("hunsu.peer.data.v1") }, master, 1024));
  const browserControl = await subtle.importKey("raw", directional.slice(0, 32), { name: "AES-GCM" }, false, ["encrypt"]);
  const bridgeControl = await subtle.importKey("raw", directional.slice(32, 64), { name: "AES-GCM" }, false, ["decrypt"]);
  const confirm = { type: "session.confirm", sessionId: ticketClaims.sessionId, transcriptHash: bridge.transcriptHash };
  const inbound = await encryptDataFrame(browserControl, ticketClaims.sessionId, "control", "browser", 1, confirm);
  assert.deepEqual(await bridge.decrypt("control", inbound), confirm);
  const ready = { type: "session.ready", value: true };
  const outbound = await bridge.encrypt("control", ready);
  assert.deepEqual(await decryptDataFrame(bridgeControl, outbound, "bridge"), ready);
});

test("peer transport configures only Cloudflare STUN and requires the two reliable ordered channels", async () => {
  const seen: unknown[] = [];
  const control = fakeChannel(REMOTE_PEER_CONTROL_CHANNEL);
  const stream = fakeChannel(REMOTE_PEER_STREAM_CHANNEL);
  const connection = fakePeerConnection(control, stream);
  const factory = createWeriftPeerTransportFactory({
    loadWerift: async () => ({
      RTCPeerConnection: class {
        constructor(configuration: unknown) {
          seen.push(configuration);
          return connection;
        }
      } as never
    })
  });
  const transport = await factory();
  await transport.acceptOffer(validSdp("offer"));
  const result = await transport.waitForChannels();
  assert.equal(result.control.label, REMOTE_PEER_CONTROL_CHANNEL);
  assert.equal(result.stream.label, REMOTE_PEER_STREAM_CHANNEL);
  assert.deepEqual(seen, [{
    iceServers: [{ urls: REMOTE_PEER_STUN_URL }],
    iceTransportPolicy: "all",
    maxMessageSize: 128 * 1024
  }]);
  await transport.close();
});

test("hostile SDP and unencrypted local-path hello fields fail closed", () => {
  const forbiddenCandidateType = `typ ${["re", "lay"].join("")}`;
  assert.throws(() => validateRemoteSdp("offer", validSdp("offer").replace("typ host", forbiddenCandidateType)), /invalid ICE candidates/u);
  assert.throws(() => validateRemoteSdp("offer", `${validSdp("offer")}m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n`), /DataChannel section/u);
  const hello = decodeRemotePeerClientHello({
    type: "peer.client-hello",
    protocolVersion: "hunsu-peer-v1",
    sessionId: "cs_12345678901234567890",
    ticket: "ticket",
    browserAgreementPublicJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
    browserNonce: Buffer.alloc(24).toString("base64url"),
    repositoryPath: "/private/repository"
  });
  assert.equal(hello.ok, false);
});

test("direct peer session rechecks the real Workspace grant for every encrypted command", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "hunsu-direct-peer-"));
  const repository = join(root, "private-repository");
  await mkdir(repository);
  const paths = resolveHunsuPaths({ home: join(root, "state") });
  const configStore = createConfigStore(paths);
  const credentialStore = createCredentialStore(paths);
  const workspaceService = createWorkspaceService({ store: createWorkspaceStore(paths) });
  const added = await workspaceService.add(repository, { displayName: "Direct peer fixture" });
  assert.equal(added.ok, true);
  if (!added.ok) return;
  const workspaceId = added.value.workspaceId;
  const granted = await workspaceService.setRemoteAccess(workspaceId, {
    enabled: true,
    scopes: ["remote.access"]
  });
  assert.equal(granted.ok, true);

  const device = await generateDeviceKeySet();
  const deviceId = "device_direct_123";
  const accountId = "account_direct_123";
  const accessToken = "direct-access-token";
  await credentialStore.ensure();
  await credentialStore.write({
    connect: {
      ...device,
      state: "registered",
      deviceId,
      accountId,
      accessToken,
      refreshToken: "direct-refresh-token",
      expiresAt: "2026-07-12T01:00:00.000Z",
      connectWsUrl: "wss://connect.preview.hunsu.app/v1/connect/device"
    }
  });

  const socket = new FakeConnectSocket();
  const control = new FakePeerDataChannel(REMOTE_PEER_CONTROL_CHANNEL);
  const stream = new FakePeerDataChannel(REMOTE_PEER_STREAM_CHANNEL);
  const offered: string[] = [];
  const peerTransport: PeerTransport = {
    async acceptOffer(sdp) {
      offered.push(sdp);
      return { answerSdp: validSdp("answer") };
    },
    async waitForChannels() { return { control, stream }; },
    async addIceCandidate() {},
    async close() {}
  };
  const loopbackRequests: Array<{ url: string; init?: RequestInit }> = [];
  const loopbackFetch: typeof fetch = async (resource, init) => {
    const url = resource instanceof URL ? resource : new URL(typeof resource === "string" ? resource : resource.url);
    loopbackRequests.push({ url: url.toString(), init });
    assert.equal(url.origin, "http://127.0.0.1:19687");
    assert.equal(url.pathname, `/api/roadmaps/${encodeURIComponent(workspaceId)}/board`);
    assert.equal(new Headers(init?.headers).get("x-hunsu-bridge-control-token"), "fixture-control-token");
    return new Response(JSON.stringify({
      roadmapId: workspaceId,
      accepted: true,
      repositoryPath: repository
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const router = createRemoteCommandRouter({
    workspaceService,
    endpoint: () => "http://127.0.0.1:19687",
    controlToken: () => "fixture-control-token",
    fetchImpl: loopbackFetch
  });
  const ticketSigner = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const ticketSigningPublicKey = await subtle.exportKey("jwk", ticketSigner.publicKey);
  const now = new Date("2026-07-12T00:00:30.000Z");
  const service = createRemoteService({
    configStore,
    credentialStore,
    workspaceService,
    deploymentProfile: "preview",
    connectApiUrl: "https://connect.preview.hunsu.app",
    connectWsUrl: "wss://connect.preview.hunsu.app/v1/connect/device",
    connectTicketIssuer: "https://connect.preview.hunsu.app",
    connectTicketSigningKeyId: "preview-direct-key",
    connectTicketSigningPublicJwk: ticketSigningPublicKey,
    fetchImpl: loopbackFetch,
    socketFactory: async request => {
      assert.equal(request.url, "wss://connect.preview.hunsu.app/v1/connect/device");
      assert.equal(request.headers.authorization, `DPoP ${accessToken}`);
      assert.equal(request.headers.dpop.includes(accessToken), false);
      return socket;
    },
    peerTransportFactory: async () => peerTransport,
    sleep: () => new Promise(() => undefined),
    now: () => now,
    randomBytes: size => new Uint8Array(size).fill(11),
    onCommand: router
  });

  try {
    await service.enable();
    socket.receive({
      schema: "hunsu.connect.control-frame.v1",
      type: "connect.authenticated",
      deviceId,
      accountId,
      expiresAt: "2026-07-12T01:00:00.000Z"
    });
    await waitFor(() => service.status().then(status => status.connection === "connected"));

    const browser = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const browserAgreementPublicJwk = canonicalPublicJwk(await subtle.exportKey("jwk", browser.publicKey));
    const sessionId = "cs_12345678901234567890";
    const ticketClaims = {
      iss: "https://connect.preview.hunsu.app",
      aud: "hunsu-bridge",
      sub: deviceId,
      jti: "ticket_direct_123",
      environment: "preview",
      sessionId,
      accountId,
      deviceId,
      browserAgreementPublicJwk,
      iat: 1_783_814_400,
      exp: 1_783_814_490
    } as const;
    const ticket = await signTicket(ticketSigner.privateKey, "preview-direct-key", ticketClaims);
    socket.receive({
      schema: "hunsu.connect.control-frame.v1",
      type: "connect.session",
      sessionId,
      ticket,
      expiresAt: "2026-07-12T00:01:30.000Z"
    });
    await waitFor(() => service.status().then(status => status.peerSessionId === sessionId));

    const signalCipher = await browserSignalCipher(browser.privateKey, device.agreementPublicKey, sessionId);
    socket.receive(await encryptSignal(signalCipher, sessionId, 1, "browser", { type: "peer.offer", sdp: validSdp("offer") }));
    await waitFor(() => socket.sent.length === 1 && control.canReceive());
    assert.deepEqual(offered, [validSdp("offer")]);
    const answerFrame = JSON.parse(socket.sent[0]!) as Awaited<ReturnType<typeof encryptSignal>>;
    assert.deepEqual(await decryptSignal(signalCipher, answerFrame, "bridge"), { type: "peer.answer", sdp: validSdp("answer") });

    const browserNonce = Buffer.alloc(24, 12).toString("base64url");
    control.receive(JSON.stringify({
      type: "peer.client-hello",
      protocolVersion: "hunsu-peer-v1",
      sessionId,
      ticket,
      browserAgreementPublicJwk,
      browserNonce
    }));
    await waitFor(() => control.sent.length === 1);
    const serverHello = JSON.parse(String(control.sent[0])) as {
      bridgeEphemeralPublicJwk: JsonWebKey;
      bridgeNonce: string;
      leaseExpiresAt: string;
      transcriptHash: string;
      signature: string;
    };
    const browserData = await deriveBrowserControlCipher({
      browserPrivateKey: browser.privateKey,
      browserAgreementPublicJwk,
      deviceSigningPublicJwk: device.signingPublicKey,
      ticket,
      ticketClaims,
      browserNonce,
      serverHello
    });
    control.receive(await encryptDataFrame(browserData.sendKey, sessionId, "control", "browser", 1, {
      type: "session.confirm",
      sessionId,
      transcriptHash: browserData.transcriptHash
    }));
    await waitFor(() => control.sent.length === 2);
    const ready = await decryptDataFrame(browserData.receiveKey, String(control.sent[1]), "bridge") as {
      type: string;
      workspaces: Array<Record<string, unknown>>;
    };
    assert.equal(ready.type, "session.ready");
    assert.deepEqual(ready.workspaces, [{
      workspaceId,
      displayName: "Direct peer fixture",
      scopes: ["remote.access"]
    }]);
    assert.equal(JSON.stringify(ready).includes(repository), false);
    assert.equal(JSON.stringify(ready).includes("repositoryPath"), false);

    const deadline = "2026-07-12T00:01:00.000Z";
    control.receive(await encryptDataFrame(browserData.sendKey, sessionId, "control", "browser", 2, {
      type: "command.request",
      sessionId,
      requestId: "request_allowed",
      workspaceId,
      deadline,
      command: "roadmap.board"
    }));
    await waitFor(() => control.sent.length === 3);
    const allowed = await decryptDataFrame(browserData.receiveKey, String(control.sent[2]), "bridge") as {
      type: string;
      ok: boolean;
      status: number;
      body: Record<string, unknown>;
    };
    assert.equal(allowed.type, "command.result");
    assert.equal(allowed.ok, true);
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.accepted, true);
    assert.equal(allowed.body.repositoryPath, undefined);
    assert.equal(allowed.body.pathRedacted, true);
    assert.equal(loopbackRequests.length, 1);

    const revoked = await workspaceService.setRemoteAccess(workspaceId, { enabled: false, scopes: [] });
    assert.equal(revoked.ok, true);
    control.receive(await encryptDataFrame(browserData.sendKey, sessionId, "control", "browser", 3, {
      type: "command.request",
      sessionId,
      requestId: "request_revoked",
      workspaceId,
      deadline,
      command: "roadmap.board"
    }));
    await waitFor(() => control.sent.length === 4);
    const denied = await decryptDataFrame(browserData.receiveKey, String(control.sent[3]), "bridge") as {
      type: string;
      ok: boolean;
      status: number;
      error: string;
    };
    assert.equal(denied.type, "command.result");
    assert.equal(denied.ok, false);
    assert.equal(denied.status, 403);
    assert.match(denied.error, /not granted/u);
    assert.equal(loopbackRequests.length, 1);
  } finally {
    service.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("Remote service persists only Connect enrollment secrets and returns path-free login data", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunsu-connect-login-"));
  const repository = join(root, "private-repository");
  await mkdir(repository);
  const paths = resolveHunsuPaths({ home: join(root, "state") });
  const credentialStore = createCredentialStore(paths);
  const workspaceService = createWorkspaceService({ store: createWorkspaceStore(paths) });
  await workspaceService.add(repository);
  const signing = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const service = createRemoteService({
    configStore: createConfigStore(paths),
    credentialStore,
    workspaceService,
    deploymentProfile: "preview",
    connectApiUrl: "https://connect.preview.hunsu.app",
    connectWsUrl: "wss://connect.preview.hunsu.app/v1/connect/device",
    connectTicketIssuer: "https://connect.preview.hunsu.app",
    connectTicketSigningKeyId: "preview-key",
    connectTicketSigningPublicJwk: await subtle.exportKey("jwk", signing.publicKey),
    fetchImpl: async () => new Response(JSON.stringify({
      schema: "hunsu.connect.enrollment-created.v1",
      enrollmentId: "enrollment_123",
      deviceCode: "private_device_code",
      userCode: "ABCD-EFGH",
      verificationUri: "https://connect.preview.hunsu.app/auth/device-enrollments",
      verificationUriComplete: "https://connect.preview.hunsu.app/auth/device-enrollments?user_code=ABCD-EFGH",
      expiresIn: 600,
      interval: 5
    }), { status: 201, headers: { "content-type": "application/json" } }),
    sleep: () => new Promise(() => undefined),
    now: () => new Date("2026-07-12T00:00:00.000Z"),
    openBrowser: async () => undefined
  });
  try {
    const login = await service.login({ openBrowser: false });
    assert.equal(login.userCode, "ABCD-EFGH");
    assert.equal(JSON.stringify(login).includes("private_device_code"), false);
    assert.equal(JSON.stringify(login).includes(repository), false);
    const stored = await credentialStore.read();
    assert.equal(stored?.connect?.state, "enrolling");
    assert.equal(stored?.connect?.state === "enrolling" ? stored.connect.deviceCode : undefined, "private_device_code");
  } finally {
    service.stop();
    await rm(root, { recursive: true, force: true });
  }
});

class FakeEvent<T extends unknown[]> {
  private readonly listeners = new Set<(...args: T) => void>();
  subscribe(listener: (...args: T) => void) {
    this.listeners.add(listener);
    return { unSubscribe: () => this.listeners.delete(listener) };
  }
  emit(...args: T): void { for (const listener of this.listeners) listener(...args); }
}

function fakeChannel(label: string) {
  return {
    label,
    ordered: true,
    maxRetransmits: undefined,
    maxPacketLifeTime: undefined,
    isCreatedByRemote: true,
    readyState: "open" as const,
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    onMessage: new FakeEvent<[string | Buffer]>(),
    stateChange: new FakeEvent<["connecting" | "open" | "closing" | "closed"]>(),
    bufferedAmountLow: new FakeEvent<[]>(),
    send() {},
    close() {}
  };
}

function fakePeerConnection(control: ReturnType<typeof fakeChannel>, stream: ReturnType<typeof fakeChannel>) {
  const onDataChannel = new FakeEvent<[ReturnType<typeof fakeChannel>]>();
  const iceGatheringStateChange = new FakeEvent<["new" | "gathering" | "complete"]>();
  return {
    onDataChannel,
    connectionStateChange: new FakeEvent<[string]>(),
    iceGatheringState: "complete" as const,
    iceGatheringStateChange,
    localDescription: { sdp: validSdp("answer") },
    async setRemoteDescription() { onDataChannel.emit(control); onDataChannel.emit(stream); },
    async createAnswer() { return { type: "answer" as const, sdp: validSdp("answer") }; },
    async setLocalDescription() {},
    async addIceCandidate() {},
    async close() {}
  };
}
