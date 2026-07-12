import { CONNECT_SESSION_SCHEMA, REMOTE_PEER_PROTOCOL_VERSION, decodeConnectP256PublicJwk } from "@hunsu/protocol";
import { connectApiHttpUrl } from "@/shared/api/bridgeApiBase";

export type ConnectAccountUser = {
  userId: string;
  email?: string;
  name?: string;
};

export type ConnectAccountSession =
  | { authenticated: false }
  | { authenticated: true; user: ConnectAccountUser };

export type ConnectDevice = {
  deviceId: string;
  deviceName: string;
  status: "online" | "offline";
  protocolVersion: string;
  signingPublicKeyJwk: JsonWebKey;
  agreementPublicKeyJwk: JsonWebKey;
  lastSeenAt?: string;
};

export type ConnectSignalFrame = {
  schema: "hunsu.connect.signal-frame.v1";
  sessionId: string;
  sequence: number;
  iv: string;
  ciphertext: string;
};

export type ConnectSignalingChannel = {
  readonly sessionId: string;
  readonly accountId: string;
  readonly deviceId: string;
  readonly ticket: string;
  send(frame: ConnectSignalFrame): void;
  close(): void;
  onFrame(listener: (frame: ConnectSignalFrame) => void): () => void;
  onClose(listener: () => void): () => void;
};

export type ConnectSignalingFactory = (options: {
  deviceId: string;
  browserAgreementPublicJwk: JsonWebKey;
  signal?: AbortSignal;
  timeoutMs?: number;
}) => Promise<ConnectSignalingChannel>;

export const MAX_CONNECT_SIGNAL_FRAME_BYTES = 64 * 1024;
const SIGNAL_SCHEMA = "hunsu.connect.signal-frame.v1" as const;

export async function fetchConnectAccountSession(): Promise<ConnectAccountSession> {
  const response = await fetch(connectApiHttpUrl("/auth/session"), {
    method: "GET",
    credentials: "include",
    cache: "no-store",
    headers: { accept: "application/json" }
  });
  if (response.status === 401) return { authenticated: false };
  if (!response.ok) throw new Error(`Connect session status failed with ${response.status}.`);
  return parseAccountSession(await response.json().catch(() => undefined));
}

export function connectAccountLoginUrl(): string {
  return connectApiHttpUrl("/auth/login");
}

export async function logoutConnectAccountSession(): Promise<void> {
  const response = await fetch(connectApiHttpUrl("/auth/session"), {
    method: "DELETE",
    credentials: "include",
    cache: "no-store",
    headers: { accept: "application/json" }
  });
  if (response.status !== 204 && response.status !== 401 && !response.ok) {
    throw new Error(`Connect logout failed with ${response.status}.`);
  }
}

export async function fetchConnectDevices(): Promise<ConnectDevice[]> {
  const response = await fetch(connectApiHttpUrl("/v1/devices"), {
    method: "GET",
    credentials: "include",
    cache: "no-store",
    headers: { accept: "application/json" }
  });
  if (!response.ok) throw new Error(`Connect device list failed with ${response.status}.`);
  const body = await response.json().catch(() => undefined);
  const values = isRecord(body) && Array.isArray(body.devices) ? body.devices : [];
  return values.flatMap(parseConnectDevice);
}

export async function openConnectSignalingChannel({
  deviceId,
  browserAgreementPublicJwk,
  signal,
  timeoutMs = 10_000
}: {
  deviceId: string;
  browserAgreementPublicJwk: JsonWebKey;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<ConnectSignalingChannel> {
  if (typeof WebSocket === "undefined") throw new Error("This browser does not support WebSocket signaling.");
  const session = await createConnectSession({ deviceId, browserAgreementPublicJwk, signal });
  const path = `/v1/connect/sessions/${encodeURIComponent(session.sessionId)}/browser`;
  const url = new URL(connectWebSocketUrl(path));
  url.searchParams.set("ticket", session.ticket);
  const socket = new WebSocket(url);
  await waitForSocketOpen(socket, signal, timeoutMs);
  return nativeSignalingChannel(socket, session);
}

export function assertConnectSignalOpacity(frame: ConnectSignalFrame): void {
  if (frame.schema !== SIGNAL_SCHEMA
    || !boundedText(frame.sessionId, 256)
    || !Number.isSafeInteger(frame.sequence)
    || frame.sequence < 1
    || !base64Url(frame.iv, 32)
    || !base64Url(frame.ciphertext, MAX_CONNECT_SIGNAL_FRAME_BYTES * 2)
    || byteLength(JSON.stringify(frame)) > MAX_CONNECT_SIGNAL_FRAME_BYTES) {
    throw new Error("Connect signaling frame is invalid or too large.");
  }
}

async function createConnectSession(input: {
  deviceId: string;
  browserAgreementPublicJwk: JsonWebKey;
  signal?: AbortSignal;
}): Promise<{ sessionId: string; accountId: string; deviceId: string; ticket: string }> {
  if (!boundedText(input.deviceId, 256) || !isP256PublicJwk(input.browserAgreementPublicJwk)) {
    throw new Error("Connect session metadata is invalid.");
  }
  const response = await fetch(connectApiHttpUrl("/v1/connect/sessions"), {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      deviceId: input.deviceId,
      browserAgreementPublicJwk: input.browserAgreementPublicJwk
    }),
    signal: input.signal
  });
  if (!response.ok) throw new Error(`Connect session creation failed with ${response.status}.`);
  const body = await response.json().catch(() => undefined);
  if (!isRecord(body)
    || body.schema !== CONNECT_SESSION_SCHEMA
    || !boundedText(body.sessionId, 256)
    || !boundedText(body.ticket, 8_192)
    || !boundedText(body.expiresAt, 64)
    || !Number.isFinite(Date.parse(body.expiresAt))
    || !boundedText(body.webSocketUrl, 2_048)) {
    throw new Error("Connect session response was invalid.");
  }
  const claims = decodeSessionTicketClaims(body.ticket);
  if (claims.sessionId !== body.sessionId
    || claims.deviceId !== input.deviceId
    || !samePublicJwk(claims.browserAgreementPublicJwk, input.browserAgreementPublicJwk)) {
    throw new Error("Connect session ticket binding was invalid.");
  }
  const expectedSocket = new URL(connectWebSocketUrl(`/v1/connect/sessions/${encodeURIComponent(body.sessionId)}/browser`));
  const advertisedSocket = new URL(body.webSocketUrl);
  if (advertisedSocket.origin !== expectedSocket.origin || advertisedSocket.pathname !== expectedSocket.pathname) {
    throw new Error("Connect session WebSocket endpoint was invalid.");
  }
  return { sessionId: body.sessionId, accountId: claims.accountId, deviceId: input.deviceId, ticket: body.ticket };
}

function decodeSessionTicketClaims(ticket: string): {
  sessionId: string;
  accountId: string;
  deviceId: string;
  browserAgreementPublicJwk: JsonWebKey;
} {
  const parts = ticket.split(".");
  if (parts.length !== 3) throw new Error("Connect session ticket encoding was invalid.");
  let claims: unknown;
  try {
    const encoded = parts[1]!.replace(/-/gu, "+").replace(/_/gu, "/").padEnd(Math.ceil(parts[1]!.length / 4) * 4, "=");
    claims = JSON.parse(atob(encoded)) as unknown;
  } catch {
    throw new Error("Connect session ticket claims were invalid.");
  }
  if (!isRecord(claims)
    || !boundedText(claims.sessionId, 256)
    || !boundedText(claims.accountId, 256)
    || !boundedText(claims.deviceId, 256)
    || !isP256PublicJwk(claims.browserAgreementPublicJwk)) {
    throw new Error("Connect session ticket claims were invalid.");
  }
  return {
    sessionId: claims.sessionId,
    accountId: claims.accountId,
    deviceId: claims.deviceId,
    browserAgreementPublicJwk: claims.browserAgreementPublicJwk
  };
}

function nativeSignalingChannel(
  socket: WebSocket,
  session: { sessionId: string; accountId: string; deviceId: string; ticket: string }
): ConnectSignalingChannel {
  const frameListeners = new Set<(frame: ConnectSignalFrame) => void>();
  const closeListeners = new Set<() => void>();
  const queuedFrames: ConnectSignalFrame[] = [];
  const handleMessage = (event: MessageEvent<unknown>) => {
    if (typeof event.data !== "string" || byteLength(event.data) > MAX_CONNECT_SIGNAL_FRAME_BYTES) {
      socket.close(1009, "signal_too_large");
      return;
    }
    const frame = parseSignalFrame(event.data, session.sessionId);
    if (!frame) {
      socket.close(1008, "invalid_signal");
      return;
    }
    if (frameListeners.size === 0) {
      if (queuedFrames.length >= 16) {
        socket.close(1009, "signal_queue_full");
        return;
      }
      queuedFrames.push(frame);
      return;
    }
    for (const listener of frameListeners) listener(frame);
  };
  const handleClose = () => {
    for (const listener of closeListeners) listener();
  };
  socket.addEventListener("message", handleMessage);
  socket.addEventListener("close", handleClose);
  socket.addEventListener("error", handleClose);
  return {
    ...session,
    send(frame) {
      assertConnectSignalOpacity(frame);
      if (frame.sessionId !== session.sessionId) throw new Error("Connect signaling session binding is invalid.");
      if (socket.readyState !== WebSocket.OPEN) throw new Error("Connect signaling is closed.");
      socket.send(JSON.stringify(frame));
    },
    close() {
      socket.removeEventListener("message", handleMessage);
      socket.removeEventListener("close", handleClose);
      socket.removeEventListener("error", handleClose);
      socket.close(1000, "client_close");
      for (const listener of closeListeners) listener();
    },
    onFrame(listener) {
      frameListeners.add(listener);
      for (const frame of queuedFrames.splice(0)) listener(frame);
      return () => frameListeners.delete(listener);
    },
    onClose(listener) {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    }
  };
}

function parseSignalFrame(raw: string, sessionId: string): ConnectSignalFrame | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const frame: ConnectSignalFrame = {
    schema: value.schema as typeof SIGNAL_SCHEMA,
    sessionId: value.sessionId as string,
    sequence: value.sequence as number,
    iv: value.iv as string,
    ciphertext: value.ciphertext as string
  };
  try {
    assertConnectSignalOpacity(frame);
    return frame.sessionId === sessionId ? frame : undefined;
  } catch {
    return undefined;
  }
}

function parseAccountSession(value: unknown): ConnectAccountSession {
  if (isRecord(value) && value.authenticated === false) return { authenticated: false };
  const user = isRecord(value) && value.authenticated === true && isRecord(value.user) ? value.user : undefined;
  const userId = text(user?.accountId);
  if (!userId) throw new Error("Connect session response was invalid.");
  return { authenticated: true, user: { userId } };
}

function parseConnectDevice(value: unknown): ConnectDevice[] {
  if (!isRecord(value)) return [];
  const deviceId = text(value.deviceId);
  const deviceName = text(value.deviceName);
  if (!deviceId
    || !deviceName
    || value.status === "revoked"
    || !isP256PublicJwk(value.signingPublicJwk)
    || !isP256PublicJwk(value.agreementPublicJwk)) return [];
  return [{
    deviceId,
    deviceName,
    status: value.status === "online" ? "online" : "offline",
    protocolVersion: REMOTE_PEER_PROTOCOL_VERSION,
    signingPublicKeyJwk: value.signingPublicJwk,
    agreementPublicKeyJwk: value.agreementPublicJwk,
    lastSeenAt: text(value.lastSeenAt)
  }];
}

function connectWebSocketUrl(path: string): string {
  const url = new URL(connectApiHttpUrl(path));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function waitForSocketOpen(socket: WebSocket, signal: AbortSignal | undefined, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      window.clearTimeout(timeout);
      socket.removeEventListener("open", handleOpen);
      socket.removeEventListener("error", handleError);
      signal?.removeEventListener("abort", handleAbort);
      if (error) {
        socket.close();
        reject(error);
      } else resolve();
    };
    const handleOpen = () => finish();
    const handleError = () => finish(new Error("Connect signaling could not open."));
    const handleAbort = () => finish(new DOMException("Operation aborted.", "AbortError"));
    const timeout = window.setTimeout(() => finish(new Error("Connect signaling timed out.")), timeoutMs);
    socket.addEventListener("open", handleOpen, { once: true });
    socket.addEventListener("error", handleError, { once: true });
    signal?.addEventListener("abort", handleAbort, { once: true });
    if (signal?.aborted) handleAbort();
  });
}

function isP256PublicJwk(value: unknown): value is JsonWebKey {
  return decodeConnectP256PublicJwk(value).ok;
}

function samePublicJwk(left: JsonWebKey, right: JsonWebKey): boolean {
  return isP256PublicJwk(left)
    && isP256PublicJwk(right)
    && left.x === right.x
    && left.y === right.y;
}

function base64Url(value: unknown, maxLength: number): value is string {
  return boundedText(value, maxLength) && /^[A-Za-z0-9_-]+$/u.test(value);
}

function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
