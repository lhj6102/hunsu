import { webcrypto } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  CONNECT_CONTROL_FRAME_SCHEMA,
  CONNECT_SIGNAL_FRAME_SCHEMA,
  REMOTE_PEER_CONTROL_CHANNEL,
  REMOTE_PEER_PROTOCOL_VERSION,
  REMOTE_PEER_STREAM_CHANNEL
} from "../../packages/protocol/src/index.ts";
import {
  ConnectHttpError,
  decodeAndVerifyEnrollment,
  publicJwkThumbprint,
  verifyDpopProof
} from "../../apps/connect-api/src/security.ts";
import {
  canonicalPublicJwk,
  peerTranscript
} from "../../apps/bridge/src/remote/peerCrypto.ts";
import type { ConnectSocket, ConnectSocketFactory } from "../../apps/bridge/src/remote/remoteService.ts";
import type {
  PeerData,
  PeerDataChannel,
  PeerTransport,
  PeerTransportFactory
} from "../../apps/bridge/src/remote/peerTransport.ts";

// The fixture imports the Connect security boundary into the root Node test
// program. The Worker build supplies this generated binding interface itself.
declare global {
  interface Env {
    HUNSU_DEPLOY_TARGET: string;
    HUNSU_RELEASE_SHA: string;
    HUNSU_CONNECT_API_BASE_URL: string;
    HUNSU_WEB_PUBLIC_URL: string;
    HUNSU_CONNECT_ACCESS_ISSUER: string;
    HUNSU_CONNECT_ACCESS_AUD: string;
    HUNSU_CONNECT_SIGNING_PUBLIC_JWK: string;
    HUNSU_CONNECT_SIGNING_KEY_ID: string;
    HUNSU_CONNECT_SIGNING_PRIVATE_JWK: string;
  }
}

const subtle = webcrypto.subtle;
const ACCOUNT_ID = "ca_fixture_account_012345678901234567890123";
const DEVICE_ID = "cd_fixture_device_012345678901";
const ENROLLMENT_ID = "ce_fixture_enrollment_012345678901";
const DEVICE_CODE = "fixture-device-code-private-012345678901";
const USER_CODE = "HUNS-UQA1";
const ACCESS_TOKEN = "fixture-access-token-private-012345678901";
const REFRESH_TOKEN = "fixture-refresh-token-private-012345678901";
const SIGNING_KEY_ID = "connect-fixture-signing-key-01";

type Enrollment = Awaited<ReturnType<typeof decodeAndVerifyEnrollment>>;

export type DeterministicBrowserSession = {
  ready: Record<string, unknown>;
  evidence: Readonly<{
    opaqueSignaling: true;
    signedTranscript: true;
    encryptedDataChannel: true;
  }>;
  command(input: {
    requestId: string;
    workspaceId: string;
    command?: "roadmap.board" | "health";
    deadline?: string;
  }): Promise<Record<string, unknown>>;
};

export type DeterministicConnectP2pFixture = {
  apiUrl: string;
  wsUrl: string;
  ticketIssuer: string;
  ticketSigningKeyId: string;
  ticketSigningPublicJwk: JsonWebKey;
  socketFactory: ConnectSocketFactory;
  peerTransportFactory: PeerTransportFactory;
  completeBrowserEnrollment(userCode: string): Promise<void>;
  authenticateBridge(): Promise<void>;
  openBrowserSession(): Promise<DeterministicBrowserSession>;
  sensitiveValues(): string[];
  evidence(): Readonly<{
    identityLogins: number;
    enrollmentRequests: number;
    enrollmentApprovals: number;
    tokenIssues: number;
    socketAuthentications: number;
    peerSessions: number;
    externalRequests: 0;
    turnRequests: 0;
    hostedForwardingRequests: 0;
  }>;
  close(): Promise<void>;
};

/**
 * A loopback-only Connect identity/enrollment service paired with an in-memory
 * direct DataChannel transport. It deliberately exercises the production
 * enrollment proof, DPoP, ticket, signaling, and peer-frame crypto code while
 * making external network access impossible.
 */
export async function createDeterministicConnectP2pFixture(): Promise<DeterministicConnectP2pFixture> {
  const ticketKeys = await subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
  const ticketSigningPublicJwk = canonicalPublicJwk(await subtle.exportKey("jwk", ticketKeys.publicKey));
  let apiUrl = "";
  let enrollment: Enrollment | undefined;
  let signingJkt: string | undefined;
  let enrollmentApproved = false;
  let currentSocket: FakeConnectSocket | undefined;
  let currentPeer: FixturePeerTransport | undefined;
  let closed = false;
  const counters = {
    identityLogins: 0,
    enrollmentRequests: 0,
    enrollmentApprovals: 0,
    tokenIssues: 0,
    socketAuthentications: 0,
    peerSessions: 0
  };

  const server = createServer((request, response) => {
    void handleFixtureRequest(request, response).catch(error => {
      const status = error instanceof ConnectHttpError ? error.status : 500;
      const code = error instanceof ConnectHttpError ? error.code : "fixture_error";
      sendJson(response, status, { error: code });
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolveListen);
  });
  const address = server.address() as AddressInfo;
  apiUrl = `http://127.0.0.1:${address.port}`;
  const wsUrl = `ws://127.0.0.1:${address.port}/v1/connect/device`;

  async function handleFixtureRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (closed) throw new ConnectHttpError(503, "fixture_closed", "Fixture is closed.");
    const url = new URL(request.url ?? "/", apiUrl);
    ensure(url.origin === apiUrl, "Connect fixture received a foreign host.");

    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { ok: true, service: "hunsu-connect-fixture", mode: "direct-p2p" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/auth/login") {
      counters.identityLogins += 1;
      response.setHeader("set-cookie", "hunsu_fixture_identity=qa; HttpOnly; SameSite=Lax; Path=/");
      sendJson(response, 200, { authenticated: true, provider: "fixture-google" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/auth/device-enrollments") {
      response.statusCode = 200;
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end("<!doctype html><title>Hunsu Connect fixture</title><p>Approve the deterministic QA device enrollment.</p>");
      return;
    }
    if (request.method === "POST" && url.pathname === "/auth/device-enrollments") {
      ensure((request.headers.cookie ?? "").includes("hunsu_fixture_identity=qa"), "Fixture identity login is required.");
      const value = await readJson(request);
      ensure(isRecord(value) && value.userCode === USER_CODE, "Fixture user code is invalid.");
      enrollmentApproved = true;
      counters.enrollmentApprovals += 1;
      sendJson(response, 200, { approved: true });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/device-enrollments") {
      ensure(!enrollment, "Fixture permits one disposable enrollment.");
      enrollment = await decodeAndVerifyEnrollment(await readJson(request), Date.now());
      signingJkt = await publicJwkThumbprint(enrollment.signingPublicJwk);
      counters.enrollmentRequests += 1;
      sendJson(response, 201, {
        schema: "hunsu.connect.enrollment-created.v1",
        enrollmentId: ENROLLMENT_ID,
        deviceCode: DEVICE_CODE,
        userCode: USER_CODE,
        verificationUri: `${apiUrl}/auth/device-enrollments`,
        verificationUriComplete: `${apiUrl}/auth/device-enrollments?user_code=${encodeURIComponent(USER_CODE)}`,
        expiresIn: 600,
        interval: 1
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/device-enrollment-tokens") {
      ensure(enrollment && signingJkt, "Fixture enrollment does not exist.");
      await verifyDpopProof(toRequest(request, url), signingJkt);
      const value = await readJson(request);
      ensure(isRecord(value) && value.enrollmentId === ENROLLMENT_ID && value.deviceCode === DEVICE_CODE, "Fixture device credential is invalid.");
      if (!enrollmentApproved) {
        sendJson(response, 400, { error: "authorization_pending" });
        return;
      }
      counters.tokenIssues += 1;
      sendJson(response, 200, {
        schema: "hunsu.connect.device-token.v1",
        tokenType: "DPoP",
        accessToken: ACCESS_TOKEN,
        refreshToken: REFRESH_TOKEN,
        expiresIn: 300,
        deviceId: DEVICE_ID,
        accountId: ACCOUNT_ID
      });
      return;
    }
    sendJson(response, 404, { error: "fixture_not_found" });
  }

  const socketFactory: ConnectSocketFactory = async input => {
    ensure(input.url === wsUrl, "Bridge used an unexpected Connect WebSocket URL.");
    ensure(enrollment && signingJkt && enrollmentApproved, "Bridge connected before fixture enrollment completed.");
    ensure(input.headers.authorization === `DPoP ${ACCESS_TOKEN}`, "Bridge Connect authorization is invalid.");
    await verifyDpopProof(new Request(wsUrl.replace(/^ws:/u, "http:"), {
      method: "GET",
      headers: { dpop: input.headers.dpop }
    }), signingJkt, ACCESS_TOKEN);
    currentSocket?.close(1000, "replaced");
    currentSocket = new FakeConnectSocket();
    return currentSocket;
  };

  const peerTransportFactory: PeerTransportFactory = async () => {
    currentPeer = new FixturePeerTransport();
    return currentPeer;
  };

  return {
    apiUrl,
    wsUrl,
    ticketIssuer: apiUrl,
    ticketSigningKeyId: SIGNING_KEY_ID,
    ticketSigningPublicJwk,
    socketFactory,
    peerTransportFactory,
    async completeBrowserEnrollment(userCode) {
      ensure(userCode === USER_CODE, "Bridge exposed an unexpected fixture user code.");
      const login = await fetch(`${apiUrl}/auth/login`, { redirect: "error", signal: AbortSignal.timeout(2_000) });
      ensure(login.ok, "Fixture identity login failed.");
      const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
      ensure(cookie, "Fixture identity cookie is missing.");
      const approval = await fetch(`${apiUrl}/auth/device-enrollments`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ userCode }),
        redirect: "error",
        signal: AbortSignal.timeout(2_000)
      });
      ensure(approval.ok, "Fixture device enrollment approval failed.");
    },
    async authenticateBridge() {
      ensure(currentSocket && currentSocket.readyState === 1, "Bridge has no open fixture Connect socket.");
      currentSocket.receive({
        schema: CONNECT_CONTROL_FRAME_SCHEMA,
        type: "connect.authenticated",
        deviceId: DEVICE_ID,
        accountId: ACCOUNT_ID,
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString()
      });
      counters.socketAuthentications += 1;
    },
    async openBrowserSession() {
      ensure(enrollment && currentSocket?.readyState === 1, "Bridge fixture is not enrolled and connected.");
      const session = await openFixtureBrowserSession({
        socket: currentSocket,
        deviceSigningPublicJwk: enrollment.signingPublicJwk,
        deviceAgreementPublicJwk: enrollment.agreementPublicJwk,
        ticketPrivateKey: ticketKeys.privateKey,
        ticketIssuer: apiUrl,
        ticketSigningKeyId: SIGNING_KEY_ID,
        peer: () => currentPeer
      });
      counters.peerSessions += 1;
      return session;
    },
    sensitiveValues() {
      return [DEVICE_CODE, ACCESS_TOKEN, REFRESH_TOKEN];
    },
    evidence() {
      return Object.freeze({ ...counters, externalRequests: 0 as const, turnRequests: 0 as const, hostedForwardingRequests: 0 as const });
    },
    async close() {
      if (closed) return;
      closed = true;
      currentSocket?.close(1000, "fixture_shutdown");
      currentPeer?.close();
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close(error => error ? rejectClose(error) : resolveClose());
      });
    }
  };
}

async function openFixtureBrowserSession(input: {
  socket: FakeConnectSocket;
  deviceSigningPublicJwk: JsonWebKey;
  deviceAgreementPublicJwk: JsonWebKey;
  ticketPrivateKey: webcrypto.CryptoKey;
  ticketIssuer: string;
  ticketSigningKeyId: string;
  peer: () => FixturePeerTransport | undefined;
}): Promise<DeterministicBrowserSession> {
  const browser = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const browserAgreementPublicJwk = canonicalPublicJwk(await subtle.exportKey("jwk", browser.publicKey));
  const sessionId = "cs_fixture_session_012345678901";
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const ticketClaims = {
    iss: input.ticketIssuer,
    aud: "hunsu-bridge",
    sub: DEVICE_ID,
    jti: "ctj_fixture_ticket_012345678901",
    environment: "preview",
    sessionId,
    accountId: ACCOUNT_ID,
    deviceId: DEVICE_ID,
    browserAgreementPublicJwk,
    iat: nowSeconds,
    exp: nowSeconds + 90
  } as const;
  const ticket = await signTicket(input.ticketPrivateKey, input.ticketSigningKeyId, ticketClaims);
  input.socket.receive({
    schema: CONNECT_CONTROL_FRAME_SCHEMA,
    type: "connect.session",
    sessionId,
    ticket,
    expiresAt: new Date((nowSeconds + 90) * 1_000).toISOString()
  });

  const signalCipher = await browserSignalCipher(browser.privateKey, input.deviceAgreementPublicJwk, sessionId);
  const socketSendIndex = input.socket.sent.length;
  input.socket.receive(await encryptSignal(signalCipher, sessionId, 1, "browser", {
    type: "peer.offer",
    sdp: validSdp("offer")
  }));
  await waitFor(() => input.socket.sent.length > socketSendIndex && Boolean(input.peer()?.control.canReceive()));
  const peer = input.peer();
  ensure(peer, "Bridge did not create the direct peer transport.");
  ensure(peer.offeredSdp === validSdp("offer"), "Bridge did not accept the direct host-only SDP offer.");
  const encryptedAnswer = JSON.parse(input.socket.sent[socketSendIndex]!) as SignalFrame;
  ensure(!input.socket.sent[socketSendIndex]!.includes("peer.answer"), "Connect observed plaintext signaling.");
  const answer = await decryptSignal(signalCipher, encryptedAnswer, "bridge") as { type?: string; sdp?: string };
  ensure(answer.type === "peer.answer" && answer.sdp === validSdp("answer"), "Bridge returned an invalid encrypted peer answer.");

  const browserNonce = Buffer.alloc(24, 12).toString("base64url");
  peer.control.receive(JSON.stringify({
    type: "peer.client-hello",
    protocolVersion: REMOTE_PEER_PROTOCOL_VERSION,
    sessionId,
    ticket,
    browserAgreementPublicJwk,
    browserNonce
  }));
  await waitFor(() => peer.control.sent.length === 1);
  const serverHello = JSON.parse(String(peer.control.sent[0])) as ServerHello;
  const browserData = await deriveBrowserControlCipher({
    browserPrivateKey: browser.privateKey,
    browserAgreementPublicJwk,
    deviceSigningPublicJwk: input.deviceSigningPublicJwk,
    ticket,
    ticketClaims,
    browserNonce,
    serverHello
  });
  peer.control.receive(await encryptDataFrame(browserData.sendKey, sessionId, "control", "browser", 1, {
    type: "session.confirm",
    sessionId,
    transcriptHash: browserData.transcriptHash
  }));
  await waitFor(() => peer.control.sent.length === 2);
  const ready = await decryptDataFrame(browserData.receiveKey, String(peer.control.sent[1]), "bridge") as Record<string, unknown>;
  ensure(ready.type === "session.ready", "Bridge did not establish the encrypted peer session.");
  let browserSequence = 1;
  let bridgeFrameIndex = 2;

  return {
    ready,
    evidence: Object.freeze({ opaqueSignaling: true, signedTranscript: true, encryptedDataChannel: true }),
    async command(commandInput) {
      browserSequence += 1;
      const request = {
        type: "command.request",
        sessionId,
        requestId: commandInput.requestId,
        workspaceId: commandInput.workspaceId,
        deadline: commandInput.deadline ?? new Date(Date.now() + 30_000).toISOString(),
        command: commandInput.command ?? "roadmap.board"
      };
      const encoded = await encryptDataFrame(browserData.sendKey, sessionId, "control", "browser", browserSequence, request);
      ensure(!encoded.includes("command.request") && !encoded.includes(commandInput.workspaceId), "Peer command was not opaque on the DataChannel.");
      peer.control.receive(encoded);
      await waitFor(() => peer.control.sent.length > bridgeFrameIndex);
      const result = await decryptDataFrame(browserData.receiveKey, String(peer.control.sent[bridgeFrameIndex]), "bridge") as Record<string, unknown>;
      bridgeFrameIndex += 1;
      return result;
    }
  };
}

export async function signTicket(privateKey: webcrypto.CryptoKey, kid: string, claims: unknown): Promise<string> {
  const header = encodeJson({ alg: "ES256", typ: "hunsu-connect-session+jwt", kid });
  const payload = encodeJson(claims);
  const signature = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${Buffer.from(signature).toString("base64url")}`;
}

export async function browserSignalCipher(privateKey: webcrypto.CryptoKey, devicePublicJwk: JsonWebKey, sessionId: string): Promise<webcrypto.CryptoKey> {
  const publicKey = await subtle.importKey("jwk", devicePublicJwk, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256);
  const master = await subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const bits = await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode(sessionId), info: new TextEncoder().encode("hunsu.connect.signal.v1") }, master, 256);
  return subtle.importKey("raw", bits, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

type SignalFrame = { schema: typeof CONNECT_SIGNAL_FRAME_SCHEMA; sessionId: string; sequence: number; iv: string; ciphertext: string };

export async function encryptSignal(key: webcrypto.CryptoKey, sessionId: string, sequence: number, role: "browser" | "bridge", value: unknown): Promise<SignalFrame> {
  const iv = await roleNonce(role, sequence);
  const ciphertext = await subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(`${CONNECT_SIGNAL_FRAME_SCHEMA}:${sessionId}:${sequence}`), tagLength: 128 }, key, new TextEncoder().encode(JSON.stringify(value)));
  return { schema: CONNECT_SIGNAL_FRAME_SCHEMA, sessionId, sequence, iv: Buffer.from(iv).toString("base64url"), ciphertext: Buffer.from(ciphertext).toString("base64url") };
}

export async function decryptSignal(key: webcrypto.CryptoKey, frame: SignalFrame, role: "browser" | "bridge"): Promise<unknown> {
  const iv = await roleNonce(role, frame.sequence);
  const plaintext = await subtle.decrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(`${CONNECT_SIGNAL_FRAME_SCHEMA}:${frame.sessionId}:${frame.sequence}`), tagLength: 128 }, key, Buffer.from(frame.ciphertext, "base64url"));
  return JSON.parse(Buffer.from(plaintext).toString("utf8")) as unknown;
}

export async function encryptDataFrame(key: webcrypto.CryptoKey, sessionId: string, channel: "control" | "stream", role: "browser" | "bridge", sequence: number, value: unknown): Promise<string> {
  const nonce = await dataNonce(channel, role, sequence);
  const ciphertext = await subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: new TextEncoder().encode(`hunsu-peer-v1:${sessionId}:${channel}:${sequence}`), tagLength: 128 }, key, new TextEncoder().encode(JSON.stringify(value)));
  return JSON.stringify({ version: REMOTE_PEER_PROTOCOL_VERSION, sessionId, channel, sequence, nonce: Buffer.from(nonce).toString("base64url"), ciphertext: Buffer.from(ciphertext).toString("base64url") });
}

export async function decryptDataFrame(key: webcrypto.CryptoKey, encoded: string, role: "browser" | "bridge"): Promise<unknown> {
  const frame = JSON.parse(encoded) as { sessionId: string; channel: "control" | "stream"; sequence: number; nonce: string; ciphertext: string };
  const nonce = await dataNonce(frame.channel, role, frame.sequence);
  ensure(frame.nonce === Buffer.from(nonce).toString("base64url"), "Peer frame nonce is invalid.");
  const plaintext = await subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: new TextEncoder().encode(`hunsu-peer-v1:${frame.sessionId}:${frame.channel}:${frame.sequence}`), tagLength: 128 }, key, Buffer.from(frame.ciphertext, "base64url"));
  return JSON.parse(Buffer.from(plaintext).toString("utf8")) as unknown;
}

type ServerHello = {
  bridgeEphemeralPublicJwk: JsonWebKey;
  bridgeNonce: string;
  leaseExpiresAt: string;
  transcriptHash: string;
  signature: string;
};

export async function deriveBrowserControlCipher(input: {
  browserPrivateKey: webcrypto.CryptoKey;
  browserAgreementPublicJwk: JsonWebKey;
  deviceSigningPublicJwk: JsonWebKey;
  ticket: string;
  ticketClaims: { sessionId: string; accountId: string; deviceId: string };
  browserNonce: string;
  serverHello: ServerHello;
}): Promise<{ sendKey: webcrypto.CryptoKey; receiveKey: webcrypto.CryptoKey; transcriptHash: string }> {
  const ticketDigest = Buffer.from(await subtle.digest("SHA-256", new TextEncoder().encode(input.ticket))).toString("base64url");
  const transcript = peerTranscript({
    sessionId: input.ticketClaims.sessionId,
    accountId: input.ticketClaims.accountId,
    deviceId: input.ticketClaims.deviceId,
    ticketDigest,
    browserAgreementPublicJwk: input.browserAgreementPublicJwk,
    bridgeEphemeralPublicJwk: input.serverHello.bridgeEphemeralPublicJwk,
    browserNonce: input.browserNonce,
    bridgeNonce: input.serverHello.bridgeNonce,
    leaseExpiresAt: input.serverHello.leaseExpiresAt
  });
  const transcriptHashBytes = new Uint8Array(await subtle.digest("SHA-256", transcript));
  const transcriptHash = Buffer.from(transcriptHashBytes).toString("base64url");
  ensure(transcriptHash === input.serverHello.transcriptHash, "Peer transcript hash does not match.");
  const signingKey = await subtle.importKey("jwk", input.deviceSigningPublicJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  ensure(await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, signingKey, Buffer.from(input.serverHello.signature, "base64url"), transcriptHashBytes), "Bridge peer transcript signature is invalid.");
  const bridgeKey = await subtle.importKey("jwk", input.serverHello.bridgeEphemeralPublicJwk, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await subtle.deriveBits({ name: "ECDH", public: bridgeKey }, input.browserPrivateKey, 256);
  const master = await subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const directional = new Uint8Array(await subtle.deriveBits({
    name: "HKDF",
    hash: "SHA-256",
    salt: transcriptHashBytes,
    info: new TextEncoder().encode("hunsu.peer.data.v1")
  }, master, 1024));
  return {
    sendKey: await subtle.importKey("raw", directional.slice(0, 32), { name: "AES-GCM" }, false, ["encrypt"]),
    receiveKey: await subtle.importKey("raw", directional.slice(32, 64), { name: "AES-GCM" }, false, ["decrypt"]),
    transcriptHash
  };
}

export class FakeConnectSocket implements ConnectSocket {
  readyState = 1;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Set<(event: { data?: unknown }) => void>>();

  send(data: string): void {
    ensure(this.readyState === 1, "Fake Connect socket is closed.");
    this.sent.push(data);
  }

  close(_code?: number, _reason?: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", {});
  }

  addEventListener(type: "open" | "close" | "error" | "message", listener: (event: { data?: unknown }) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: "open" | "close" | "error" | "message", listener: (event: { data?: unknown }) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  receive(value: unknown): void {
    this.emit("message", { data: JSON.stringify(value) });
  }

  private emit(type: string, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

export class FakePeerDataChannel implements PeerDataChannel {
  readonly label: string;
  readonly ordered = true;
  readonly maxRetransmits = undefined;
  readonly maxPacketLifeTime = undefined;
  readyState: PeerDataChannel["readyState"] = "open";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  readonly sent: Array<string | Uint8Array> = [];
  private readonly messageListeners = new Set<(value: PeerData) => void>();
  private readonly stateListeners = new Set<(state: PeerDataChannel["readyState"]) => void>();
  private readonly lowListeners = new Set<() => void>();

  constructor(label: string) { this.label = label; }
  send(value: string | Uint8Array): void { ensure(this.readyState === "open", "Fake peer channel is closed."); this.sent.push(value); }
  close(): void {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    for (const listener of this.stateListeners) listener("closed");
  }
  onMessage(listener: (value: PeerData) => void): () => void { this.messageListeners.add(listener); return () => this.messageListeners.delete(listener); }
  onStateChange(listener: (state: PeerDataChannel["readyState"]) => void): () => void { this.stateListeners.add(listener); return () => this.stateListeners.delete(listener); }
  onBufferedAmountLow(listener: () => void): () => void { this.lowListeners.add(listener); return () => this.lowListeners.delete(listener); }
  receive(value: PeerData): void { for (const listener of this.messageListeners) listener(value); }
  canReceive(): boolean { return this.messageListeners.size > 0; }
}

export class FixturePeerTransport implements PeerTransport {
  readonly control = new FakePeerDataChannel(REMOTE_PEER_CONTROL_CHANNEL);
  readonly stream = new FakePeerDataChannel(REMOTE_PEER_STREAM_CHANNEL);
  offeredSdp = "";
  async acceptOffer(sdp: string): Promise<{ answerSdp: string }> { this.offeredSdp = sdp; return { answerSdp: validSdp("answer") }; }
  async waitForChannels() { return { control: this.control, stream: this.stream }; }
  async addIceCandidate(): Promise<void> {}
  async close(): Promise<void> { this.control.close(); this.stream.close(); }
}

export function validSdp(type: "offer" | "answer"): string {
  const fingerprint = Array.from({ length: 32 }, () => "AA").join(":");
  return [
    "v=0",
    "o=- 0 0 IN IP4 127.0.0.1",
    "s=-",
    "t=0 0",
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    "c=IN IP4 0.0.0.0",
    "a=ice-ufrag:abcd",
    "a=ice-pwd:abcdefghijklmnopqrstuv",
    `a=fingerprint:sha-256 ${fingerprint}`,
    type === "offer" ? "a=setup:actpass" : "a=setup:active",
    "a=candidate:1 1 UDP 1 192.0.2.1 5000 typ host",
    "a=sctp-port:5000",
    ""
  ].join("\r\n");
}

export async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 5));
  }
  throw new Error("Timed out waiting for the deterministic direct-peer fixture.");
}

function encodeJson(value: unknown): string { return Buffer.from(JSON.stringify(value), "utf8").toString("base64url"); }

async function roleNonce(role: "browser" | "bridge", sequence: number): Promise<Uint8Array> {
  const hash = new Uint8Array(await subtle.digest("SHA-256", new TextEncoder().encode(`hunsu.connect.signal.nonce/${role}`)));
  const nonce = new Uint8Array(12);
  nonce.set(hash.slice(0, 4));
  new DataView(nonce.buffer).setBigUint64(4, BigInt(sequence), false);
  return nonce;
}

async function dataNonce(channel: "control" | "stream", role: "browser" | "bridge", sequence: number): Promise<Uint8Array> {
  const hash = new Uint8Array(await subtle.digest("SHA-256", new TextEncoder().encode(`hunsu.peer.data.nonce/${channel}/${role}`)));
  const nonce = new Uint8Array(12);
  nonce.set(hash.slice(0, 4));
  new DataView(nonce.buffer).setBigUint64(4, BigInt(sequence), false);
  return nonce;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    ensure(size <= 96 * 1024, "Fixture request body is too large.");
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw new ConnectHttpError(400, "fixture_json_invalid", "Fixture request JSON is invalid."); }
}

function toRequest(request: IncomingMessage, url: URL): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, value);
  }
  return new Request(url, { method: request.method, headers });
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(value)}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
