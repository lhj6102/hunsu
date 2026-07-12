import { err, ok, type Result } from "./result.ts";

export const REMOTE_PEER_PROTOCOL_VERSION = "hunsu-peer-v1" as const;
export const REMOTE_PEER_CONTROL_CHANNEL = "hunsu.control.v1" as const;
export const REMOTE_PEER_STREAM_CHANNEL = "hunsu.stream.v1" as const;
export const REMOTE_PEER_STUN_URL = "stun:stun.cloudflare.com:3478" as const;
export const REMOTE_PEER_LEASE_MS = 12 * 60_000;
export const REMOTE_PEER_MAX_FRAME_BYTES = 64 * 1024;
export const REMOTE_PEER_MAX_CHUNK_BYTES = 32 * 1024;
export const REMOTE_PEER_MAX_ACTIVE_STREAMS = 32;

export const REMOTE_COMMAND_NAMES = [
  "health",
  "bridge.status",
  "connection.status",
  "provider.inventory",
  "modelAlias.validate",
  "modelAlias.resolve",
  "roadmap.registry.list",
  "roadmap.registry.remove",
  "roadmap.open",
  "roadmap.port.inspect",
  "roadmap.port.apply",
  "roadmap.create",
  "roadmap.board",
  "roadmap.worktree",
  "roadmap.skills",
  "roadmap.commands",
  "execute.start",
  "execute.pause",
  "execute.resume",
  "execute.stop",
  "execute.completeMove",
  "execute.status",
  "artifactAction.list",
  "artifactAction.runs",
  "artifactAction.start",
  "artifactAction.stop",
  "moveFile.tree",
  "moveFile.blob",
  "moveFile.diff",
  "hunsuDraft.list",
  "hunsuDraft.start",
  "hunsuDraft.get",
  "hunsuDraft.message",
  "hunsuDraft.diffArtifact.create",
  "hunsuDraft.diffArtifact.get",
  "hunsuDraft.approve",
  "hunsuDraft.discard",
  "line.accept",
  "line.reject",
  "agentSession.list",
  "agentSession.get",
  "agentSession.events",
  "live.events"
] as const;

export type RemoteCommandName = typeof REMOTE_COMMAND_NAMES[number];

export const REMOTE_WORKSPACE_SCOPES = [
  "remote.access",
  "execute.start",
  "artifactAction.run",
  "env.read",
  "hostAlias.expose"
] as const;

export type RemoteWorkspaceScope = typeof REMOTE_WORKSPACE_SCOPES[number];

export type RemoteWorkspaceMetadata = {
  workspaceId: string;
  displayName: string;
  scopes: RemoteWorkspaceScope[];
};

export type RemotePeerSignal =
  | { type: "peer.offer"; sdp: string }
  | { type: "peer.answer"; sdp: string }
  | {
      type: "peer.ice";
      candidate: string;
      sdpMid?: string;
      sdpMLineIndex?: number;
      usernameFragment?: string;
    }
  | { type: "peer.close"; reason: "complete" | "canceled" | "expired" | "failed" };

/** The only plaintext application message. It is sent on the control channel
 * before the ephemeral DataChannel keys exist. */
export type RemotePeerClientHello = {
  type: "peer.client-hello";
  protocolVersion: typeof REMOTE_PEER_PROTOCOL_VERSION;
  sessionId: string;
  ticket: string;
  browserAgreementPublicJwk: JsonWebKey;
  browserNonce: string;
};

/** Bridge's only plaintext response. Every later DataChannel message is an
 * authenticated encrypted frame. */
export type RemotePeerServerHello = {
  type: "peer.server-hello";
  protocolVersion: typeof REMOTE_PEER_PROTOCOL_VERSION;
  sessionId: string;
  bridgeEphemeralPublicJwk: JsonWebKey;
  bridgeNonce: string;
  leaseExpiresAt: string;
  transcriptHash: string;
  signature: string;
};

export type RemoteEncryptedFrame = {
  version: typeof REMOTE_PEER_PROTOCOL_VERSION;
  sessionId: string;
  channel: "control" | "stream";
  sequence: number;
  nonce: string;
  ciphertext: string;
};

export type RemoteControlMessage =
  | { type: "session.confirm"; sessionId: string; transcriptHash: string }
  | {
      type: "session.ready";
      sessionId: string;
      deviceId: string;
      transcriptHash: string;
      leaseExpiresAt: string;
      workspaces: RemoteWorkspaceMetadata[];
    }
  | {
      type: "command.request";
      sessionId: string;
      requestId: string;
      workspaceId: string;
      deadline: string;
      command: RemoteCommandName;
      payload?: unknown;
    }
  | {
      type: "command.result";
      sessionId: string;
      requestId: string;
      workspaceId: string;
      status: number;
      ok: boolean;
      body?: unknown;
      error?: string;
    }
  | {
      type: "stream.cancel";
      sessionId: string;
      requestId: string;
      streamId: string;
      workspaceId: string;
      reason?: string;
    }
  | {
      type: "session.close";
      sessionId: string;
      reason: "lease_expired" | "replaced" | "canceled" | "protocol_error";
    };

export type RemoteStreamMessage =
  | { type: "stream.open"; sessionId: string; requestId: string; streamId: string; workspaceId: string }
  | {
      type: "stream.chunk";
      sessionId: string;
      requestId: string;
      streamId: string;
      workspaceId: string;
      chunkSequence: number;
      event: string;
      data?: unknown;
    }
  | {
      type: "stream.end";
      sessionId: string;
      requestId: string;
      streamId: string;
      workspaceId: string;
      status: number;
      error?: string;
    };

export type RemotePeerDecodeError = {
  code: "INVALID_REMOTE_PEER_WIRE";
  field: string;
  message: string;
};

const MAX_ID = 256;
const MAX_TEXT = 1024;
const MAX_SDP = 64 * 1024;
const MAX_CANDIDATE = 2 * 1024;
const FORBIDDEN_LOCAL_KEYS = new Set([
  "projectPath",
  "repositoryPath",
  "repositoryRoot",
  "worktreePath",
  "runtimePath",
  "cwd"
]);

export function requiredScopesForRemoteCommand(command: RemoteCommandName): RemoteWorkspaceScope[] {
  const scopes: RemoteWorkspaceScope[] = ["remote.access"];
  if (command === "execute.start" || command === "execute.pause" || command === "execute.resume" || command === "execute.stop" || command === "execute.completeMove") {
    scopes.push("execute.start");
  }
  if (command === "artifactAction.start" || command === "artifactAction.stop") scopes.push("artifactAction.run");
  if (command === "artifactAction.list" || command === "artifactAction.runs" || command === "artifactAction.start" || command === "artifactAction.stop") {
    scopes.push("env.read", "hostAlias.expose");
  }
  return scopes;
}

export function decodeRemotePeerSignal(value: unknown): Result<RemotePeerSignal, RemotePeerDecodeError> {
  const record = readRecord(value, "$signalPlaintext");
  if (!record.ok) return record;
  if (record.value.type === "peer.offer" || record.value.type === "peer.answer") {
    const keys = onlyKeys(record.value, ["type", "sdp"], "$signalPlaintext");
    if (!keys.ok) return keys;
    const sdp = readString(record.value.sdp, "sdp", MAX_SDP, false);
    return sdp.ok ? ok({ type: record.value.type, sdp: sdp.value }) : sdp;
  }
  if (record.value.type === "peer.ice") {
    const keys = onlyKeys(record.value, ["type", "candidate", "sdpMid", "sdpMLineIndex", "usernameFragment"], "$signalPlaintext");
    if (!keys.ok) return keys;
    const candidate = readString(record.value.candidate, "candidate", MAX_CANDIDATE);
    const sdpMid = optionalString(record.value.sdpMid, "sdpMid", 64);
    const usernameFragment = optionalString(record.value.usernameFragment, "usernameFragment", 256);
    if (!candidate.ok) return candidate;
    if (!sdpMid.ok) return sdpMid;
    if (!usernameFragment.ok) return usernameFragment;
    if (record.value.sdpMLineIndex !== undefined && (!Number.isInteger(record.value.sdpMLineIndex) || Number(record.value.sdpMLineIndex) < 0 || Number(record.value.sdpMLineIndex) > 8)) {
      return invalid("sdpMLineIndex", "ICE media line index is invalid.");
    }
    return ok({
      type: "peer.ice",
      candidate: candidate.value,
      ...(sdpMid.value ? { sdpMid: sdpMid.value } : {}),
      ...(record.value.sdpMLineIndex === undefined ? {} : { sdpMLineIndex: Number(record.value.sdpMLineIndex) }),
      ...(usernameFragment.value ? { usernameFragment: usernameFragment.value } : {})
    });
  }
  if (record.value.type === "peer.close") {
    const keys = onlyKeys(record.value, ["type", "reason"], "$signalPlaintext");
    if (!keys.ok) return keys;
    return record.value.reason === "complete" || record.value.reason === "canceled" || record.value.reason === "expired" || record.value.reason === "failed"
      ? ok({ type: "peer.close", reason: record.value.reason })
      : invalid("reason", "Peer close reason is invalid.");
  }
  return invalid("type", "Peer signaling message type is not supported.");
}

export function decodeRemotePeerClientHello(value: unknown): Result<RemotePeerClientHello, RemotePeerDecodeError> {
  const record = readRecord(value, "$hello");
  if (!record.ok) return record;
  const keys = onlyKeys(record.value, ["type", "protocolVersion", "sessionId", "ticket", "browserAgreementPublicJwk", "browserNonce"], "$hello");
  if (!keys.ok) return keys;
  if (record.value.type !== "peer.client-hello" || record.value.protocolVersion !== REMOTE_PEER_PROTOCOL_VERSION) return invalid("type", "Peer client hello version is not supported.");
  const sessionId = readString(record.value.sessionId, "sessionId", MAX_ID);
  const ticket = readString(record.value.ticket, "ticket", 8192);
  const key = decodeP256PublicJwk(record.value.browserAgreementPublicJwk, "browserAgreementPublicJwk");
  const browserNonce = readBase64Url(record.value.browserNonce, "browserNonce", 24, 64);
  if (!sessionId.ok) return sessionId;
  if (!ticket.ok) return ticket;
  if (!key.ok) return key;
  if (!browserNonce.ok) return browserNonce;
  return ok({ type: "peer.client-hello", protocolVersion: REMOTE_PEER_PROTOCOL_VERSION, sessionId: sessionId.value, ticket: ticket.value, browserAgreementPublicJwk: key.value, browserNonce: browserNonce.value });
}

export function decodeRemoteEncryptedFrame(value: unknown): Result<RemoteEncryptedFrame, RemotePeerDecodeError> {
  const record = readRecord(value, "$frame");
  if (!record.ok) return record;
  const keys = onlyKeys(record.value, ["version", "sessionId", "channel", "sequence", "nonce", "ciphertext"], "$frame");
  if (!keys.ok) return keys;
  if (record.value.version !== REMOTE_PEER_PROTOCOL_VERSION) return invalid("version", "Remote peer protocol version is not supported.");
  const sessionId = readString(record.value.sessionId, "sessionId", MAX_ID);
  const sequence = readSequence(record.value.sequence, "sequence");
  const nonce = readBase64Url(record.value.nonce, "nonce", 12, 12);
  const ciphertext = readBase64Url(record.value.ciphertext, "ciphertext", 16, REMOTE_PEER_MAX_FRAME_BYTES);
  if (!sessionId.ok) return sessionId;
  if (!sequence.ok) return sequence;
  if (!nonce.ok) return nonce;
  if (!ciphertext.ok) return ciphertext;
  if (record.value.channel !== "control" && record.value.channel !== "stream") return invalid("channel", "Remote peer channel is invalid.");
  return ok({ version: REMOTE_PEER_PROTOCOL_VERSION, sessionId: sessionId.value, channel: record.value.channel, sequence: sequence.value, nonce: nonce.value, ciphertext: ciphertext.value });
}

export function decodeRemoteControlMessage(value: unknown): Result<RemoteControlMessage, RemotePeerDecodeError> {
  const safe = rejectLocalPaths(value, "$message", new WeakSet());
  if (!safe.ok) return safe;
  const record = readRecord(value, "$message");
  if (!record.ok) return record;
  const type = readString(record.value.type, "type", 64);
  const sessionId = readString(record.value.sessionId, "sessionId", MAX_ID);
  if (!type.ok) return type;
  if (!sessionId.ok) return sessionId;
  if (type.value === "session.confirm") {
    const keys = onlyKeys(record.value, ["type", "sessionId", "transcriptHash"], "$message");
    if (!keys.ok) return keys;
    const transcriptHash = readBase64Url(record.value.transcriptHash, "transcriptHash", 32, 32);
    return transcriptHash.ok ? ok({ type: "session.confirm", sessionId: sessionId.value, transcriptHash: transcriptHash.value }) : transcriptHash;
  }
  if (type.value === "command.request") {
    const keys = onlyKeys(record.value, ["type", "sessionId", "requestId", "workspaceId", "deadline", "command", "payload"], "$message");
    if (!keys.ok) return keys;
    const requestId = readString(record.value.requestId, "requestId", MAX_ID);
    const workspaceId = readString(record.value.workspaceId, "workspaceId", MAX_ID);
    const deadline = readTimestamp(record.value.deadline, "deadline");
    if (!requestId.ok) return requestId;
    if (!workspaceId.ok) return workspaceId;
    if (!deadline.ok) return deadline;
    if (!isRemoteCommandName(record.value.command)) return invalid("command", "Remote command name is not supported.");
    return ok({ type: "command.request", sessionId: sessionId.value, requestId: requestId.value, workspaceId: workspaceId.value, deadline: deadline.value, command: record.value.command, ...(record.value.payload === undefined ? {} : { payload: record.value.payload }) });
  }
  if (type.value === "stream.cancel") {
    const keys = onlyKeys(record.value, ["type", "sessionId", "requestId", "streamId", "workspaceId", "reason"], "$message");
    if (!keys.ok) return keys;
    const requestId = readString(record.value.requestId, "requestId", MAX_ID);
    const streamId = readString(record.value.streamId, "streamId", MAX_ID);
    const workspaceId = readString(record.value.workspaceId, "workspaceId", MAX_ID);
    const reason = optionalString(record.value.reason, "reason", MAX_TEXT);
    if (!requestId.ok) return requestId;
    if (!streamId.ok) return streamId;
    if (!workspaceId.ok) return workspaceId;
    if (!reason.ok) return reason;
    return ok({ type: "stream.cancel", sessionId: sessionId.value, requestId: requestId.value, streamId: streamId.value, workspaceId: workspaceId.value, ...(reason.value ? { reason: reason.value } : {}) });
  }
  if (type.value === "session.close") {
    const keys = onlyKeys(record.value, ["type", "sessionId", "reason"], "$message");
    if (!keys.ok) return keys;
    return record.value.reason === "lease_expired" || record.value.reason === "replaced" || record.value.reason === "canceled" || record.value.reason === "protocol_error"
      ? ok({ type: "session.close", sessionId: sessionId.value, reason: record.value.reason })
      : invalid("reason", "Session close reason is invalid.");
  }
  return invalid("type", "Inbound remote control message is not supported.");
}

export function isRemoteCommandName(value: unknown): value is RemoteCommandName {
  return typeof value === "string" && (REMOTE_COMMAND_NAMES as readonly string[]).includes(value);
}

export function isRemoteWorkspaceScope(value: unknown): value is RemoteWorkspaceScope {
  return typeof value === "string" && (REMOTE_WORKSPACE_SCOPES as readonly string[]).includes(value);
}

function decodeP256PublicJwk(value: unknown, field: string): Result<JsonWebKey, RemotePeerDecodeError> {
  const record = readRecord(value, field);
  if (!record.ok) return record;
  const keys = onlyKeys(record.value, ["kty", "crv", "x", "y", "key_ops", "ext"], field);
  if (!keys.ok) return keys;
  if (record.value.kty !== "EC" || record.value.crv !== "P-256" || record.value.d !== undefined) return invalid(field, "Peer public key must be a public P-256 EC key.");
  const x = readBase64Url(record.value.x, `${field}.x`, 32, 32);
  const y = readBase64Url(record.value.y, `${field}.y`, 32, 32);
  if (!x.ok) return x;
  if (!y.ok) return y;
  return ok({ kty: "EC", crv: "P-256", x: x.value, y: y.value, ext: true });
}

function rejectLocalPaths(value: unknown, field: string, seen: WeakSet<object>): Result<true, RemotePeerDecodeError> {
  if (typeof value !== "object" || value === null) return ok(true);
  if (seen.has(value)) return invalid(field, "Remote peer message must not be cyclic.");
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_LOCAL_KEYS.has(key)) return invalid(`${field}.${key}`, "Remote peer messages cannot contain canonical local paths.");
    const nested = rejectLocalPaths(child, `${field}.${key}`, seen);
    if (!nested.ok) return nested;
  }
  seen.delete(value);
  return ok(true);
}

function readRecord(value: unknown, field: string): Result<Record<string, unknown>, RemotePeerDecodeError> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? ok(value as Record<string, unknown>) : invalid(field, "Value must be an object.");
}

function readString(value: unknown, field: string, maxLength: number, trim = true): Result<string, RemotePeerDecodeError> {
  if (typeof value !== "string") return invalid(field, "Value must be a string.");
  const text = trim ? value.trim() : value;
  return text && text.length <= maxLength && !/[\u0000\u000b\u000c\u007f]/u.test(text)
    ? ok(text)
    : invalid(field, `Value must contain 1-${maxLength} allowed characters.`);
}

function optionalString(value: unknown, field: string, maxLength: number): Result<string | undefined, RemotePeerDecodeError> {
  return value === undefined ? ok(undefined) : readString(value, field, maxLength);
}

function readTimestamp(value: unknown, field: string): Result<string, RemotePeerDecodeError> {
  const text = readString(value, field, 64);
  return text.ok && Number.isFinite(Date.parse(text.value)) ? text : invalid(field, "Value must be an ISO timestamp.");
}

function readSequence(value: unknown, field: string): Result<number, RemotePeerDecodeError> {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? ok(value) : invalid(field, "Sequence must be a positive safe integer.");
}

function readBase64Url(value: unknown, field: string, minBytes: number, maxBytes: number): Result<string, RemotePeerDecodeError> {
  const maxLength = Math.ceil(maxBytes * 4 / 3);
  const text = readString(value, field, maxLength);
  if (!text.ok) return text;
  if (!/^[A-Za-z0-9_-]+$/u.test(text.value) || text.value.length % 4 === 1) return invalid(field, "Value must be unpadded base64url.");
  const decodedBytes = Math.floor(text.value.length * 3 / 4);
  return decodedBytes >= minBytes && decodedBytes <= maxBytes ? ok(text.value) : invalid(field, "Decoded value has an invalid size.");
}

function onlyKeys(record: Record<string, unknown>, allowed: readonly string[], field: string): Result<true, RemotePeerDecodeError> {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(record).find(key => !allowedSet.has(key));
  return unknown ? invalid(`${field}.${unknown}`, "Field is not allowed.") : ok(true);
}

function invalid(field: string, message: string): Result<never, RemotePeerDecodeError> {
  return err({ code: "INVALID_REMOTE_PEER_WIRE", field, message });
}
