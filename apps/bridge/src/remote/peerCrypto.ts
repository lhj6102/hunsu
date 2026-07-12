import { Buffer } from "node:buffer";
import { randomBytes as nodeRandomBytes, webcrypto } from "node:crypto";
import type {
  ConnectSignalFrame,
  RemoteEncryptedFrame,
  RemotePeerServerHello
} from "@hunsu/protocol";
import {
  CONNECT_SIGNAL_FRAME_SCHEMA,
  REMOTE_PEER_LEASE_MS,
  REMOTE_PEER_MAX_FRAME_BYTES,
  REMOTE_PEER_PROTOCOL_VERSION
} from "@hunsu/protocol";
import type { BridgeDeploymentProfile } from "../deploymentProfile.ts";
import type { StoredConnectCredential } from "../state/credentialStore.ts";

const subtle = webcrypto.subtle;
type NodeCryptoKey = Awaited<ReturnType<typeof subtle.importKey>>;
const SIGNAL_INFO = "hunsu.connect.signal.v1";
const DATA_INFO = "hunsu.peer.data.v1";
const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER;

export type DeviceKeySet = Pick<StoredConnectCredential,
  "signingPrivateKey" | "signingPublicKey" | "agreementPrivateKey" | "agreementPublicKey">;

export type ConnectTicketClaims = {
  iss: string;
  aud: "hunsu-bridge";
  sub: string;
  jti: string;
  environment: BridgeDeploymentProfile;
  sessionId: string;
  accountId: string;
  deviceId: string;
  browserAgreementPublicJwk: JsonWebKey;
  iat: number;
  exp: number;
};

type DirectionalCipher = {
  key: NodeCryptoKey;
  noncePrefix: Uint8Array;
  sequence: number;
};

export type SignalCryptoContext = {
  encrypt(value: unknown): Promise<ConnectSignalFrame>;
  decrypt(frame: ConnectSignalFrame): Promise<unknown>;
};

export type PeerDataCryptoContext = {
  serverHello: RemotePeerServerHello;
  accountId: string;
  transcriptHash: string;
  ticketId: string;
  encrypt(channel: "control" | "stream", value: unknown): Promise<string>;
  decrypt(channel: "control" | "stream", raw: string | Uint8Array): Promise<unknown>;
};

export async function generateDeviceKeySet(): Promise<DeviceKeySet> {
  const signing = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const agreement = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  return {
    signingPrivateKey: normalizedPrivateJwk(await subtle.exportKey("jwk", signing.privateKey)),
    signingPublicKey: canonicalPublicJwk(await subtle.exportKey("jwk", signing.publicKey)),
    agreementPrivateKey: normalizedPrivateJwk(await subtle.exportKey("jwk", agreement.privateKey)),
    agreementPublicKey: canonicalPublicJwk(await subtle.exportKey("jwk", agreement.publicKey))
  };
}

export async function signEnrollmentProof(input: {
  deviceName: string;
  signingPublicJwk: JsonWebKey;
  agreementPublicJwk: JsonWebKey;
  issuedAt: string;
  nonce: string;
  signingPrivateKey: JsonWebKey;
}): Promise<string> {
  const canonical = [
    "hunsu.connect.enrollment-proof.v1",
    input.deviceName,
    input.issuedAt,
    input.nonce,
    JSON.stringify(canonicalPublicJwk(input.signingPublicJwk)),
    JSON.stringify(canonicalPublicJwk(input.agreementPublicJwk))
  ].join("\n");
  const key = await importPrivateSigningKey(input.signingPrivateKey);
  const signature = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8(canonical));
  return base64Url(signature);
}

/** Signaling is encrypted before it reaches Connect. The shared key uses the
 * browser's session key and the device's enrolled long-term agreement key. */
export async function createSignalCryptoContext(input: {
  sessionId: string;
  browserAgreementPublicJwk: JsonWebKey;
  deviceAgreementPrivateKey: JsonWebKey;
}): Promise<SignalCryptoContext> {
  const browserKey = await importPublicAgreementKey(input.browserAgreementPublicJwk);
  const deviceKey = await subtle.importKey(
    "jwk",
    normalizedPrivateJwk(input.deviceAgreementPrivateKey),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"]
  );
  const shared = await subtle.deriveBits({ name: "ECDH", public: browserKey }, deviceKey, 256);
  const material = await subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const rawKey = await subtle.deriveBits({
    name: "HKDF",
    hash: "SHA-256",
    salt: utf8(input.sessionId),
    info: utf8(SIGNAL_INFO)
  }, material, 256);
  const key = await subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  const outgoing: DirectionalCipher = {
    key,
    noncePrefix: (await digest(utf8("hunsu.connect.signal.nonce/bridge"))).slice(0, 4),
    sequence: 0
  };
  let incomingSequence = 0;
  return {
    async encrypt(value) {
      const encrypted = await encryptJson(outgoing, value, signalAad(input.sessionId));
      return {
        schema: CONNECT_SIGNAL_FRAME_SCHEMA,
        sessionId: input.sessionId,
        sequence: encrypted.sequence,
        iv: encrypted.nonce,
        ciphertext: encrypted.ciphertext
      };
    },
    async decrypt(frame) {
      if (frame.schema !== CONNECT_SIGNAL_FRAME_SCHEMA || frame.sessionId !== input.sessionId || frame.sequence !== incomingSequence + 1) {
        throw peerSecurityError("Connect signaling sequence or binding is invalid.");
      }
      const expectedNonce = sequenceNonce(
        (await digest(utf8("hunsu.connect.signal.nonce/browser"))).slice(0, 4),
        frame.sequence
      );
      const value = await decryptJson(key, frame.sequence, frame.iv, frame.ciphertext, signalAad(input.sessionId), expectedNonce);
      incomingSequence = frame.sequence;
      return value;
    }
  };
}

export async function createPeerDataCryptoContext(input: {
  sessionId: string;
  ticket: string;
  ticketClaims: ConnectTicketClaims;
  browserNonce: string;
  deviceSigningPrivateKey: JsonWebKey;
  now?: () => Date;
  randomBytes?: (size: number) => Uint8Array;
}): Promise<PeerDataCryptoContext> {
  if (input.ticketClaims.sessionId !== input.sessionId) throw peerSecurityError("Ticket session binding is invalid.");
  const now = input.now ?? (() => new Date());
  const randomBytes = input.randomBytes ?? nodeRandomBytes;
  const ephemeral = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const browserKey = await importPublicAgreementKey(input.ticketClaims.browserAgreementPublicJwk);
  const shared = await subtle.deriveBits({ name: "ECDH", public: browserKey }, ephemeral.privateKey, 256);
  const bridgeEphemeralPublicJwk = canonicalPublicJwk(await subtle.exportKey("jwk", ephemeral.publicKey));
  const bridgeNonce = base64Url(randomBytes(24));
  const leaseExpiresAt = new Date(now().getTime() + REMOTE_PEER_LEASE_MS).toISOString();
  const ticketDigest = base64Url(await digest(utf8(input.ticket)));
  const transcript = peerTranscript({
    sessionId: input.sessionId,
    accountId: input.ticketClaims.accountId,
    deviceId: input.ticketClaims.deviceId,
    ticketDigest,
    browserAgreementPublicJwk: input.ticketClaims.browserAgreementPublicJwk,
    bridgeEphemeralPublicJwk,
    browserNonce: input.browserNonce,
    bridgeNonce,
    leaseExpiresAt
  });
  const transcriptHashBytes = await digest(transcript);
  const transcriptHash = base64Url(transcriptHashBytes);
  const signingKey = await importPrivateSigningKey(input.deviceSigningPrivateKey);
  const signature = base64Url(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signingKey, transcriptHashBytes));
  const master = await subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const directional = new Uint8Array(await subtle.deriveBits({
    name: "HKDF",
    hash: "SHA-256",
    salt: transcriptHashBytes,
    info: utf8(DATA_INFO)
  }, master, 1024));
  const browserControl = await dataCipher(directional.slice(0, 32), "control/browser");
  const bridgeControl = await dataCipher(directional.slice(32, 64), "control/bridge");
  const browserStream = await dataCipher(directional.slice(64, 96), "stream/browser");
  const bridgeStream = await dataCipher(directional.slice(96, 128), "stream/bridge");

  return {
    serverHello: {
      type: "peer.server-hello",
      protocolVersion: REMOTE_PEER_PROTOCOL_VERSION,
      sessionId: input.sessionId,
      bridgeEphemeralPublicJwk,
      bridgeNonce,
      leaseExpiresAt,
      transcriptHash,
      signature
    },
    accountId: input.ticketClaims.accountId,
    transcriptHash,
    ticketId: input.ticketClaims.jti,
    async encrypt(channel, value) {
      const cipher = channel === "control" ? bridgeControl : bridgeStream;
      const encrypted = await encryptJson(cipher, value, dataAad(input.sessionId, channel));
      const frame: RemoteEncryptedFrame = {
        version: REMOTE_PEER_PROTOCOL_VERSION,
        sessionId: input.sessionId,
        channel,
        sequence: encrypted.sequence,
        nonce: encrypted.nonce,
        ciphertext: encrypted.ciphertext
      };
      return JSON.stringify(frame);
    },
    async decrypt(channel, raw) {
      const text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
      if (Buffer.byteLength(text, "utf8") > REMOTE_PEER_MAX_FRAME_BYTES * 2) throw peerSecurityError("Peer frame exceeds its encoded bound.");
      let frame: unknown;
      try {
        frame = JSON.parse(text) as unknown;
      } catch {
        throw peerSecurityError("Peer frame is not valid JSON.");
      }
      const parsed = parseDataFrame(frame, input.sessionId, channel);
      const cipher = channel === "control" ? browserControl : browserStream;
      if (parsed.sequence !== cipher.sequence + 1) throw peerSecurityError("Peer frame sequence is not contiguous.");
      const expectedNonce = sequenceNonce(cipher.noncePrefix, parsed.sequence);
      const value = await decryptJson(cipher.key, parsed.sequence, parsed.nonce, parsed.ciphertext, dataAad(input.sessionId, channel), expectedNonce);
      cipher.sequence = parsed.sequence;
      return value;
    }
  };
}

export async function verifyConnectTicket(input: {
  ticket: string;
  signingPublicKey: JsonWebKey;
  expectedKeyId: string;
  expectedIssuer: string;
  expectedEnvironment: BridgeDeploymentProfile;
  expectedSessionId: string;
  expectedDeviceId: string;
  expectedBrowserAgreementPublicJwk?: JsonWebKey;
  now: Date;
  consume: (ticketId: string, ticketDigest: string) => boolean | Promise<boolean>;
}): Promise<ConnectTicketClaims> {
  const parts = input.ticket.split(".");
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/u.test(part))) throw peerSecurityError("Connect ticket encoding is invalid.");
  const header = parseJsonPart(parts[0]!, "Connect ticket header");
  const claims = parseJsonPart(parts[1]!, "Connect ticket claims");
  if (!exactKeys(header, ["alg", "typ", "kid"])
    || header.alg !== "ES256"
    || header.typ !== "hunsu-connect-session+jwt"
    || header.kid !== input.expectedKeyId) throw peerSecurityError("Connect ticket protected header is invalid.");
  if (!exactKeys(claims, ["iss", "aud", "sub", "jti", "environment", "sessionId", "accountId", "deviceId", "browserAgreementPublicJwk", "iat", "exp"])) {
    throw peerSecurityError("Connect ticket claims are invalid.");
  }
  const browserAgreementPublicJwk = canonicalPublicJwk(claims.browserAgreementPublicJwk as JsonWebKey);
  const nowSeconds = Math.floor(input.now.getTime() / 1_000);
  if (claims.iss !== input.expectedIssuer
    || claims.aud !== "hunsu-bridge"
    || claims.environment !== input.expectedEnvironment
    || claims.sessionId !== input.expectedSessionId
    || claims.sub !== input.expectedDeviceId
    || claims.deviceId !== input.expectedDeviceId
    || !boundedText(claims.jti, 256)
    || !boundedText(claims.accountId, 256)
    || !Number.isSafeInteger(claims.iat)
    || !Number.isSafeInteger(claims.exp)
    || Number(claims.iat) > nowSeconds + 15
    || Number(claims.exp) <= nowSeconds
    || Number(claims.exp) <= Number(claims.iat)
    || Number(claims.exp) - Number(claims.iat) > 90
    || (input.expectedBrowserAgreementPublicJwk && !samePublicJwk(browserAgreementPublicJwk, input.expectedBrowserAgreementPublicJwk))) {
    throw peerSecurityError("Connect ticket claim binding is invalid.");
  }
  const key = await subtle.importKey("jwk", canonicalPublicJwk(input.signingPublicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const signature = decodeBase64Url(parts[2]!, 64, 64);
  const valid = await subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    signature,
    utf8(`${parts[0]}.${parts[1]}`)
  );
  if (!valid) throw peerSecurityError("Connect ticket signature is invalid.");
  const ticketDigest = base64Url(await digest(utf8(input.ticket)));
  if (!await input.consume(claims.jti as string, ticketDigest)) throw peerSecurityError("Connect ticket was already used.");
  return {
    iss: claims.iss as string,
    aud: "hunsu-bridge",
    sub: claims.sub as string,
    jti: claims.jti as string,
    environment: claims.environment as BridgeDeploymentProfile,
    sessionId: claims.sessionId as string,
    accountId: claims.accountId as string,
    deviceId: claims.deviceId as string,
    browserAgreementPublicJwk,
    iat: claims.iat as number,
    exp: claims.exp as number
  };
}

export function validateRemoteSdp(type: "offer" | "answer", sdp: string): { fingerprint: string } {
  if (typeof sdp !== "string" || !sdp.startsWith("v=0\r\n") || Buffer.byteLength(sdp, "utf8") > 64 * 1024 || /[\u0000\u000b\u000c]/u.test(sdp)) throw peerSecurityError("Peer SDP is invalid.");
  const lines = sdp.split("\r\n").filter(Boolean);
  const media = lines.filter(line => line.startsWith("m="));
  if (media.length !== 1 || !/^m=application \d+ UDP\/DTLS\/SCTP webrtc-datachannel$/u.test(media[0]!)) throw peerSecurityError("Peer SDP must contain exactly one WebRTC DataChannel section.");
  if (lines.some(line => /^m=(audio|video)\b/u.test(line))) throw peerSecurityError("Peer SDP requested unsupported media.");
  const candidates = lines.filter(line => line.startsWith("a=candidate:"));
  if (candidates.length > 64 || candidates.some(line => !/ typ (?:host|srflx)(?: |$)/u.test(line))) throw peerSecurityError("Peer SDP contains invalid ICE candidates.");
  if (!lines.some(line => /^a=ice-ufrag:[A-Za-z0-9+/]{4,256}$/u.test(line))
    || !lines.some(line => /^a=ice-pwd:[A-Za-z0-9+/]{22,256}$/u.test(line))
    || !lines.some(line => type === "offer" ? line === "a=setup:actpass" : /^a=setup:(?:active|passive)$/u.test(line))) throw peerSecurityError("Peer SDP ICE or DTLS setup is invalid.");
  const fingerprints = [...new Set(lines.flatMap(line => {
    const match = line.match(/^a=fingerprint:sha-256 ((?:[0-9A-F]{2}:){31}[0-9A-F]{2})$/u);
    return match?.[1] ? [match[1]] : [];
  }))];
  if (fingerprints.length !== 1) throw peerSecurityError("Peer SDP must contain one consistent SHA-256 fingerprint.");
  return { fingerprint: fingerprints[0]! };
}

export function validateRemoteIceCandidate(candidate: string): void {
  if (typeof candidate !== "string"
    || candidate.length > 2_048
    || !/^candidate:[^\r\n]+ typ (?:host|srflx)(?: |$)/u.test(candidate)) throw peerSecurityError("Peer ICE candidate is invalid.");
}

export function peerTranscript(input: {
  sessionId: string;
  accountId: string;
  deviceId: string;
  ticketDigest: string;
  browserAgreementPublicJwk: JsonWebKey;
  bridgeEphemeralPublicJwk: JsonWebKey;
  browserNonce: string;
  bridgeNonce: string;
  leaseExpiresAt: string;
}): Uint8Array {
  return utf8(JSON.stringify({
    v: 1,
    sessionId: input.sessionId,
    accountId: input.accountId,
    deviceId: input.deviceId,
    ticketDigest: input.ticketDigest,
    browserAgreementPublicJwk: canonicalPublicJwk(input.browserAgreementPublicJwk),
    bridgeEphemeralPublicJwk: canonicalPublicJwk(input.bridgeEphemeralPublicJwk),
    browserNonce: input.browserNonce,
    bridgeNonce: input.bridgeNonce,
    leaseExpiresAt: input.leaseExpiresAt
  }));
}

async function dataCipher(rawKey: Uint8Array, nonceLabel: string): Promise<DirectionalCipher> {
  return {
    key: await subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]),
    noncePrefix: (await digest(utf8(`hunsu.peer.data.nonce/${nonceLabel}`))).slice(0, 4),
    sequence: 0
  };
}

async function encryptJson(cipher: DirectionalCipher, value: unknown, aadPrefix: string): Promise<{ sequence: number; nonce: string; ciphertext: string }> {
  const plaintext = utf8(JSON.stringify(value));
  if (plaintext.byteLength > REMOTE_PEER_MAX_FRAME_BYTES - 16) throw peerSecurityError("Peer plaintext exceeds its bound.");
  const sequence = cipher.sequence + 1;
  if (sequence > MAX_SEQUENCE) throw peerSecurityError("Peer frame sequence is exhausted.");
  const nonce = sequenceNonce(cipher.noncePrefix, sequence);
  const ciphertext = await subtle.encrypt({
    name: "AES-GCM",
    iv: nonce,
    additionalData: utf8(`${aadPrefix}:${sequence}`),
    tagLength: 128
  }, cipher.key, plaintext);
  cipher.sequence = sequence;
  return { sequence, nonce: base64Url(nonce), ciphertext: base64Url(ciphertext) };
}

async function decryptJson(
  key: NodeCryptoKey,
  sequence: number,
  encodedNonce: string,
  encodedCiphertext: string,
  aadPrefix: string,
  expectedNonce: Uint8Array
): Promise<unknown> {
  const actualNonce = decodeBase64Url(encodedNonce, 12, 12);
  if (!Buffer.from(actualNonce).equals(Buffer.from(expectedNonce))) throw peerSecurityError("Peer frame nonce is invalid.");
  const ciphertext = decodeBase64Url(encodedCiphertext, 16, REMOTE_PEER_MAX_FRAME_BYTES);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await subtle.decrypt({
      name: "AES-GCM",
      iv: expectedNonce,
      additionalData: utf8(`${aadPrefix}:${sequence}`),
      tagLength: 128
    }, key, ciphertext);
  } catch {
    throw peerSecurityError("Peer frame authentication failed.");
  }
  try {
    return JSON.parse(Buffer.from(plaintext).toString("utf8")) as unknown;
  } catch {
    throw peerSecurityError("Peer frame plaintext is invalid.");
  }
}

function parseDataFrame(value: unknown, sessionId: string, channel: "control" | "stream"): RemoteEncryptedFrame {
  if (!isRecord(value)
    || !exactKeys(value, ["version", "sessionId", "channel", "sequence", "nonce", "ciphertext"])
    || value.version !== REMOTE_PEER_PROTOCOL_VERSION
    || value.sessionId !== sessionId
    || value.channel !== channel
    || !Number.isSafeInteger(value.sequence)
    || Number(value.sequence) < 1
    || !boundedText(value.nonce, 16)
    || !boundedText(value.ciphertext, Math.ceil(REMOTE_PEER_MAX_FRAME_BYTES * 4 / 3))) {
    throw peerSecurityError("Peer frame fields are invalid.");
  }
  return value as RemoteEncryptedFrame;
}

function sequenceNonce(prefix: Uint8Array, sequence: number): Uint8Array {
  const nonce = new Uint8Array(12);
  nonce.set(prefix, 0);
  new DataView(nonce.buffer).setBigUint64(4, BigInt(sequence), false);
  return nonce;
}

function signalAad(sessionId: string): string {
  return `${CONNECT_SIGNAL_FRAME_SCHEMA}:${sessionId}`;
}

function dataAad(sessionId: string, channel: "control" | "stream"): string {
  return `${REMOTE_PEER_PROTOCOL_VERSION}:${sessionId}:${channel}`;
}

function parseJsonPart(value: string, label: string): Record<string, unknown> {
  try {
    const decoded = decodeBase64Url(value, 2, 8 * 1024);
    const parsed = JSON.parse(Buffer.from(decoded).toString("utf8")) as unknown;
    if (!isRecord(parsed)) throw new Error();
    return parsed;
  } catch {
    throw peerSecurityError(`${label} is invalid.`);
  }
}

async function importPrivateSigningKey(value: JsonWebKey): Promise<NodeCryptoKey> {
  return subtle.importKey("jwk", normalizedPrivateJwk(value), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

async function importPublicAgreementKey(value: JsonWebKey): Promise<NodeCryptoKey> {
  return subtle.importKey("jwk", canonicalPublicJwk(value), { name: "ECDH", namedCurve: "P-256" }, false, []);
}

function normalizedPrivateJwk(value: JsonWebKey): JsonWebKey {
  if (!boundedText(value.d, 128)) throw peerSecurityError("P-256 private key is invalid.");
  const publicKey = canonicalPublicJwk({ kty: value.kty, crv: value.crv, x: value.x, y: value.y });
  return { ...publicKey, d: value.d, ext: true };
}

export function canonicalPublicJwk(value: unknown): { crv: "P-256"; kty: "EC"; x: string; y: string } {
  if (!isRecord(value)
    || value.kty !== "EC"
    || value.crv !== "P-256"
    || !boundedText(value.x, 128)
    || !boundedText(value.y, 128)
    || value.d !== undefined) throw peerSecurityError("P-256 public key is invalid.");
  decodeBase64Url(value.x, 32, 32);
  decodeBase64Url(value.y, 32, 32);
  return { crv: "P-256", kty: "EC", x: value.x, y: value.y };
}

function samePublicJwk(left: JsonWebKey, right: JsonWebKey): boolean {
  const a = canonicalPublicJwk(left);
  const b = canonicalPublicJwk(right);
  return a.x === b.x && a.y === b.y;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function decodeBase64Url(value: string, minBytes: number, maxBytes: number): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) throw peerSecurityError("Base64url value is invalid.");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength < minBytes || decoded.byteLength > maxBytes || decoded.toString("base64url") !== value) throw peerSecurityError("Base64url value has an invalid size or encoding.");
  return new Uint8Array(decoded);
}

function base64Url(value: ArrayBuffer | Uint8Array): string {
  return Buffer.from(value instanceof Uint8Array ? value : new Uint8Array(value)).toString("base64url");
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

async function digest(value: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle.digest("SHA-256", value));
}

function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function peerSecurityError(message: string): Error {
  return new Error(message);
}
