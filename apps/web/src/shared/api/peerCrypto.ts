import type {
  ConnectSignalFrame,
  RemoteEncryptedFrame,
  RemotePeerServerHello
} from "@hunsu/protocol";
import {
  REMOTE_PEER_CONTROL_CHANNEL,
  REMOTE_PEER_LEASE_MS,
  REMOTE_PEER_MAX_CHUNK_BYTES,
  REMOTE_PEER_MAX_FRAME_BYTES,
  REMOTE_PEER_PROTOCOL_VERSION,
  CONNECT_SIGNAL_FRAME_SCHEMA,
  REMOTE_PEER_STREAM_CHANNEL
} from "@hunsu/protocol";

export const HUNSU_PEER_CRYPTO_VERSION = REMOTE_PEER_PROTOCOL_VERSION;
export const HUNSU_CONTROL_CHANNEL = REMOTE_PEER_CONTROL_CHANNEL;
export const HUNSU_STREAM_CHANNEL = REMOTE_PEER_STREAM_CHANNEL;
export const MAX_PEER_CHUNK_BYTES = REMOTE_PEER_MAX_CHUNK_BYTES;
export const MAX_PEER_MESSAGE_BYTES = 4 * 1024 * 1024;
export const MAX_PEER_CHUNKS = 128;
export const MAX_ENCRYPTED_FRAME_BYTES = REMOTE_PEER_MAX_FRAME_BYTES;
export const MAX_PEER_LEASE_MS = REMOTE_PEER_LEASE_MS + 60_000;

const SIGNAL_INFO = "hunsu.connect.signal.v1";
const DATA_INFO = "hunsu.peer.data.v1";
const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export type BrowserAgreementKey = {
  privateKey: CryptoKey;
  publicKeyJwk: JsonWebKey;
};

export type PeerCryptoChannel = "control" | "stream";

type DirectionalCipher = {
  key: CryptoKey;
  noncePrefix: Uint8Array;
  sequence: number;
};

export class PeerSecurityError extends Error {
  readonly code: "INVALID_HANDSHAKE" | "INVALID_SIGNATURE" | "LEASE_EXPIRED" | "REPLAY" | "SEQUENCE_GAP" | "FRAME_BOUNDS" | "DECRYPT_FAILED";

  constructor(code: PeerSecurityError["code"], message: string) {
    super(message);
    this.code = code;
    this.name = "PeerSecurityError";
  }
}

export class BrowserSignalCryptoContext {
  private sendSequence = 0;
  private receiveSequence = 0;
  readonly sessionId: string;
  private readonly key: CryptoKey;
  private readonly browserNoncePrefix: Uint8Array;
  private readonly bridgeNoncePrefix: Uint8Array;
  private readonly subtle: SubtleCrypto;

  constructor(
    sessionId: string,
    key: CryptoKey,
    browserNoncePrefix: Uint8Array,
    bridgeNoncePrefix: Uint8Array,
    subtle: SubtleCrypto
  ) {
    this.sessionId = sessionId;
    this.key = key;
    this.browserNoncePrefix = browserNoncePrefix;
    this.bridgeNoncePrefix = bridgeNoncePrefix;
    this.subtle = subtle;
  }

  async encrypt(value: unknown): Promise<ConnectSignalFrame> {
    const sequence = this.sendSequence + 1;
    if (sequence > MAX_SEQUENCE) throw securityError("FRAME_BOUNDS", "Connect signaling sequence is exhausted.");
    const iv = sequenceNonce(this.browserNoncePrefix, sequence);
    const plaintext = encodeJson(value);
    if (plaintext.byteLength > REMOTE_PEER_MAX_FRAME_BYTES - 16) throw securityError("FRAME_BOUNDS", "Connect signaling plaintext is too large.");
    const ciphertext = await this.subtle.encrypt({
      name: "AES-GCM",
      iv: toArrayBuffer(iv),
      additionalData: toArrayBuffer(encoder.encode(signalAad(this.sessionId, sequence))),
      tagLength: 128
    }, this.key, toArrayBuffer(plaintext));
    this.sendSequence = sequence;
    return {
      schema: CONNECT_SIGNAL_FRAME_SCHEMA,
      sessionId: this.sessionId,
      sequence,
      iv: base64UrlEncode(iv),
      ciphertext: base64UrlEncode(new Uint8Array(ciphertext))
    };
  }

  async decrypt(frame: ConnectSignalFrame): Promise<unknown> {
    if (frame.schema !== CONNECT_SIGNAL_FRAME_SCHEMA || frame.sessionId !== this.sessionId) {
      throw securityError("DECRYPT_FAILED", "Connect signaling binding is invalid.");
    }
    if (!Number.isSafeInteger(frame.sequence) || frame.sequence < 1) throw securityError("FRAME_BOUNDS", "Connect signaling sequence is invalid.");
    if (frame.sequence <= this.receiveSequence) throw securityError("REPLAY", "Connect signaling frame was replayed.");
    if (frame.sequence !== this.receiveSequence + 1) throw securityError("SEQUENCE_GAP", "Connect signaling sequence is not contiguous.");
    const expectedIv = sequenceNonce(this.bridgeNoncePrefix, frame.sequence);
    const actualIv = base64UrlDecode(frame.iv, 12, 12);
    if (!bytesEqual(expectedIv, actualIv)) throw securityError("DECRYPT_FAILED", "Connect signaling nonce is invalid.");
    const ciphertext = base64UrlDecode(frame.ciphertext, 16, REMOTE_PEER_MAX_FRAME_BYTES);
    const value = await decryptJson(this.subtle, this.key, ciphertext, expectedIv, signalAad(this.sessionId, frame.sequence));
    this.receiveSequence = frame.sequence;
    return value;
  }
}

export class PeerCryptoContext {
  readonly sessionId: string;
  readonly deviceId: string;
  readonly transcriptHash: string;
  readonly leaseExpiresAtMs: number;
  private readonly browserControl: DirectionalCipher;
  private readonly bridgeControl: DirectionalCipher;
  private readonly browserStream: DirectionalCipher;
  private readonly bridgeStream: DirectionalCipher;
  private readonly subtle: SubtleCrypto;
  private readonly now: () => number;

  constructor(
    sessionId: string,
    deviceId: string,
    transcriptHash: string,
    leaseExpiresAtMs: number,
    browserControl: DirectionalCipher,
    bridgeControl: DirectionalCipher,
    browserStream: DirectionalCipher,
    bridgeStream: DirectionalCipher,
    subtle: SubtleCrypto,
    now: () => number = Date.now
  ) {
    this.sessionId = sessionId;
    this.deviceId = deviceId;
    this.transcriptHash = transcriptHash;
    this.leaseExpiresAtMs = leaseExpiresAtMs;
    this.browserControl = browserControl;
    this.bridgeControl = bridgeControl;
    this.browserStream = browserStream;
    this.bridgeStream = bridgeStream;
    this.subtle = subtle;
    this.now = now;
  }

  assertLease(): void {
    if (this.now() >= this.leaseExpiresAtMs) throw securityError("LEASE_EXPIRED", "The Remote Bridge peer lease has expired.");
  }

  async encryptJson(channel: PeerCryptoChannel, value: unknown): Promise<string> {
    this.assertLease();
    const cipher = channel === "control" ? this.browserControl : this.browserStream;
    const sequence = cipher.sequence + 1;
    if (sequence > MAX_SEQUENCE) throw securityError("FRAME_BOUNDS", "Peer frame sequence is exhausted.");
    const plaintext = encodeJson(value);
    if (plaintext.byteLength > REMOTE_PEER_MAX_FRAME_BYTES - 16) throw securityError("FRAME_BOUNDS", "Peer plaintext exceeds its frame bound.");
    const nonce = sequenceNonce(cipher.noncePrefix, sequence);
    const encrypted = await this.subtle.encrypt({
      name: "AES-GCM",
      iv: toArrayBuffer(nonce),
      additionalData: toArrayBuffer(encoder.encode(dataAad(this.sessionId, channel, sequence))),
      tagLength: 128
    }, cipher.key, toArrayBuffer(plaintext));
    cipher.sequence = sequence;
    const frame: RemoteEncryptedFrame = {
      version: REMOTE_PEER_PROTOCOL_VERSION,
      sessionId: this.sessionId,
      channel,
      sequence,
      nonce: base64UrlEncode(nonce),
      ciphertext: base64UrlEncode(new Uint8Array(encrypted))
    };
    return JSON.stringify(frame);
  }

  async decryptJson<T>(raw: string, channel: PeerCryptoChannel): Promise<T> {
    this.assertLease();
    if (encoder.encode(raw).byteLength > REMOTE_PEER_MAX_FRAME_BYTES * 2) throw securityError("FRAME_BOUNDS", "Encoded peer frame is too large.");
    const frame = parseDataFrame(raw, this.sessionId, channel);
    const cipher = channel === "control" ? this.bridgeControl : this.bridgeStream;
    if (frame.sequence <= cipher.sequence) throw securityError("REPLAY", "Peer frame was replayed.");
    if (frame.sequence !== cipher.sequence + 1) throw securityError("SEQUENCE_GAP", "Peer frame sequence is not contiguous.");
    const expectedNonce = sequenceNonce(cipher.noncePrefix, frame.sequence);
    const actualNonce = base64UrlDecode(frame.nonce, 12, 12);
    if (!bytesEqual(expectedNonce, actualNonce)) throw securityError("DECRYPT_FAILED", "Peer frame nonce is invalid.");
    const ciphertext = base64UrlDecode(frame.ciphertext, 16, REMOTE_PEER_MAX_FRAME_BYTES);
    const value = await decryptJson(this.subtle, cipher.key, ciphertext, expectedNonce, dataAad(this.sessionId, channel, frame.sequence));
    cipher.sequence = frame.sequence;
    return value as T;
  }
}

export async function createBrowserAgreementKey(subtle: SubtleCrypto = crypto.subtle): Promise<BrowserAgreementKey> {
  const pair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  return {
    privateKey: pair.privateKey,
    publicKeyJwk: canonicalPublicJwk(await subtle.exportKey("jwk", pair.publicKey))
  };
}

export async function createBrowserSignalCryptoContext(input: {
  agreement: BrowserAgreementKey;
  deviceAgreementPublicJwk: JsonWebKey;
  sessionId: string;
  subtle?: SubtleCrypto;
}): Promise<BrowserSignalCryptoContext> {
  const subtle = input.subtle ?? crypto.subtle;
  const deviceKey = await subtle.importKey("jwk", canonicalPublicJwk(input.deviceAgreementPublicJwk), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await subtle.deriveBits({ name: "ECDH", public: deviceKey }, input.agreement.privateKey, 256);
  const material = await subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const rawKey = await subtle.deriveBits({
    name: "HKDF",
    hash: "SHA-256",
    salt: toArrayBuffer(encoder.encode(input.sessionId)),
    info: toArrayBuffer(encoder.encode(SIGNAL_INFO))
  }, material, 256);
  const key = await subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  const [browserPrefix, bridgePrefix] = await Promise.all([
    digestPrefix(subtle, "hunsu.connect.signal.nonce/browser"),
    digestPrefix(subtle, "hunsu.connect.signal.nonce/bridge")
  ]);
  return new BrowserSignalCryptoContext(input.sessionId, key, browserPrefix, bridgePrefix, subtle);
}

export async function completeBrowserPeerHandshake(input: {
  agreement: BrowserAgreementKey;
  sessionId: string;
  accountId: string;
  deviceId: string;
  ticket: string;
  browserNonce: string;
  serverHello: RemotePeerServerHello;
  deviceSigningPublicKeyJwk: JsonWebKey;
  subtle?: SubtleCrypto;
  now?: () => number;
}): Promise<PeerCryptoContext> {
  const subtle = input.subtle ?? crypto.subtle;
  const now = input.now ?? Date.now;
  const hello = input.serverHello;
  const leaseExpiresAtMs = Date.parse(hello.leaseExpiresAt);
  if (hello.type !== "peer.server-hello"
    || hello.protocolVersion !== REMOTE_PEER_PROTOCOL_VERSION
    || hello.sessionId !== input.sessionId
    || !Number.isFinite(leaseExpiresAtMs)
    || leaseExpiresAtMs <= now() + 5_000
    || leaseExpiresAtMs > now() + MAX_PEER_LEASE_MS) {
    throw securityError("INVALID_HANDSHAKE", "Bridge peer hello is invalid.");
  }
  base64UrlDecode(input.browserNonce, 24, 64);
  base64UrlDecode(hello.bridgeNonce, 24, 64);
  const bridgeEphemeral = canonicalPublicJwk(hello.bridgeEphemeralPublicJwk);
  const ticketDigest = base64UrlEncode(new Uint8Array(await subtle.digest("SHA-256", toArrayBuffer(encoder.encode(input.ticket)))));
  const transcript = peerHandshakeTranscript({
    sessionId: input.sessionId,
    accountId: input.accountId,
    deviceId: input.deviceId,
    ticketDigest,
    browserAgreementPublicJwk: input.agreement.publicKeyJwk,
    bridgeEphemeralPublicJwk: bridgeEphemeral,
    browserNonce: input.browserNonce,
    bridgeNonce: hello.bridgeNonce,
    leaseExpiresAt: hello.leaseExpiresAt
  });
  const transcriptHashBytes = new Uint8Array(await subtle.digest("SHA-256", toArrayBuffer(transcript)));
  const transcriptHash = base64UrlEncode(transcriptHashBytes);
  if (hello.transcriptHash !== transcriptHash) throw securityError("INVALID_HANDSHAKE", "Bridge transcript hash is invalid.");
  const signingKey = await subtle.importKey("jwk", canonicalPublicJwk(input.deviceSigningPublicKeyJwk), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const signature = base64UrlDecode(hello.signature, 64, 64);
  const valid = await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, signingKey, toArrayBuffer(signature), toArrayBuffer(transcriptHashBytes));
  if (!valid) throw securityError("INVALID_SIGNATURE", "Bridge peer signature is invalid.");
  const bridgeKey = await subtle.importKey("jwk", bridgeEphemeral, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await subtle.deriveBits({ name: "ECDH", public: bridgeKey }, input.agreement.privateKey, 256);
  const master = await subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const directional = new Uint8Array(await subtle.deriveBits({
    name: "HKDF",
    hash: "SHA-256",
    salt: toArrayBuffer(transcriptHashBytes),
    info: toArrayBuffer(encoder.encode(DATA_INFO))
  }, master, 1024));
  const [browserControl, bridgeControl, browserStream, bridgeStream] = await Promise.all([
    dataCipher(subtle, directional.slice(0, 32), "control/browser"),
    dataCipher(subtle, directional.slice(32, 64), "control/bridge"),
    dataCipher(subtle, directional.slice(64, 96), "stream/browser"),
    dataCipher(subtle, directional.slice(96, 128), "stream/bridge")
  ]);
  return new PeerCryptoContext(input.sessionId, input.deviceId, transcriptHash, leaseExpiresAtMs, browserControl, bridgeControl, browserStream, bridgeStream, subtle, now);
}

export function peerHandshakeTranscript(input: {
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
  return encoder.encode(JSON.stringify({
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

export function base64UrlEncode(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

export function base64UrlDecode(value: string, minBytes = 1, maxBytes = Number.MAX_SAFE_INTEGER): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) throw securityError("FRAME_BOUNDS", "Base64url value is invalid.");
  const padded = value.replace(/-/gu, "+").replace(/_/gu, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  let binary: string;
  try { binary = atob(padded); } catch { throw securityError("FRAME_BOUNDS", "Base64url value is invalid."); }
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  if (bytes.byteLength < minBytes || bytes.byteLength > maxBytes || base64UrlEncode(bytes) !== value) throw securityError("FRAME_BOUNDS", "Base64url value has an invalid size.");
  return bytes;
}

function parseDataFrame(raw: string, sessionId: string, channel: PeerCryptoChannel): RemoteEncryptedFrame {
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; } catch { throw securityError("FRAME_BOUNDS", "Peer frame is not valid JSON."); }
  if (!isRecord(value)
    || !exactKeys(value, ["version", "sessionId", "channel", "sequence", "nonce", "ciphertext"])
    || value.version !== REMOTE_PEER_PROTOCOL_VERSION
    || value.sessionId !== sessionId
    || value.channel !== channel
    || !Number.isSafeInteger(value.sequence)
    || Number(value.sequence) < 1
    || typeof value.nonce !== "string"
    || typeof value.ciphertext !== "string") throw securityError("FRAME_BOUNDS", "Peer frame fields are invalid.");
  return value as RemoteEncryptedFrame;
}

async function dataCipher(subtle: SubtleCrypto, rawKey: Uint8Array, nonceLabel: string): Promise<DirectionalCipher> {
  return {
    key: await subtle.importKey("raw", toArrayBuffer(rawKey), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]),
    noncePrefix: await digestPrefix(subtle, `hunsu.peer.data.nonce/${nonceLabel}`),
    sequence: 0
  };
}

async function digestPrefix(subtle: SubtleCrypto, label: string): Promise<Uint8Array> {
  return new Uint8Array(await subtle.digest("SHA-256", toArrayBuffer(encoder.encode(label)))).slice(0, 4);
}

async function decryptJson(subtle: SubtleCrypto, key: CryptoKey, ciphertext: Uint8Array, iv: Uint8Array, aad: string): Promise<unknown> {
  let plaintext: ArrayBuffer;
  try {
    plaintext = await subtle.decrypt({ name: "AES-GCM", iv: toArrayBuffer(iv), additionalData: toArrayBuffer(encoder.encode(aad)), tagLength: 128 }, key, toArrayBuffer(ciphertext));
  } catch {
    throw securityError("DECRYPT_FAILED", "Encrypted peer frame authentication failed.");
  }
  try { return JSON.parse(decoder.decode(plaintext)) as unknown; } catch { throw securityError("DECRYPT_FAILED", "Encrypted peer frame plaintext is invalid."); }
}

function encodeJson(value: unknown): Uint8Array {
  try { return encoder.encode(JSON.stringify(value)); } catch { throw securityError("FRAME_BOUNDS", "Peer value is not JSON serializable."); }
}

function sequenceNonce(prefix: Uint8Array, sequence: number): Uint8Array {
  const nonce = new Uint8Array(12);
  nonce.set(prefix, 0);
  new DataView(nonce.buffer).setBigUint64(4, BigInt(sequence), false);
  return nonce;
}

function signalAad(sessionId: string, sequence: number): string {
  return `${CONNECT_SIGNAL_FRAME_SCHEMA}:${sessionId}:${sequence}`;
}

function dataAad(sessionId: string, channel: PeerCryptoChannel, sequence: number): string {
  return `${REMOTE_PEER_PROTOCOL_VERSION}:${sessionId}:${channel}:${sequence}`;
}

function canonicalPublicJwk(value: unknown): { crv: "P-256"; kty: "EC"; x: string; y: string } {
  if (!isRecord(value) || value.kty !== "EC" || value.crv !== "P-256" || typeof value.x !== "string" || typeof value.y !== "string" || value.d !== undefined) {
    throw securityError("INVALID_HANDSHAKE", "P-256 public key is invalid.");
  }
  base64UrlDecode(value.x, 32, 32);
  base64UrlDecode(value.y, 32, 32);
  return { crv: "P-256", kty: "EC", x: value.x, y: value.y };
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function securityError(code: PeerSecurityError["code"], message: string): PeerSecurityError {
  return new PeerSecurityError(code, message);
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  return Uint8Array.from(value).buffer;
}
