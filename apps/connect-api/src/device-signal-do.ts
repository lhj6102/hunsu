import { DurableObject } from "cloudflare:workers";
import {
  CONNECT_CONTROL_FRAME_SCHEMA,
  CONNECT_MAX_SIGNAL_FRAME_BYTES,
  decodeConnectSignalFrame,
  type ConnectCloseReason,
  type ConnectServerControlFrame
} from "../../../packages/protocol/src/connect.ts";
import { ConnectHttpError, errorResponse, isRecord, jsonResponse, readJsonBody } from "./security.ts";
import {
  CONNECT_SOCKET_ATTACHMENT_VERSION,
  decodeConnectSocketAttachment,
  type ConnectSocketAttachment
} from "./signal-state.ts";

const MAX_SESSION_SIGNAL_COUNT = 512;
const MAX_SESSION_SIGNAL_BYTES = 4 * 1024 * 1024;

type SessionRow = {
  session_id: string;
  account_id: string;
  ticket_hash: string;
  ticket_jti: string;
  expires_at_ms: number;
  ticket_used: number;
  status: "active" | "closed";
  device_sequence: number;
  browser_sequence: number;
  signal_count: number;
  signal_bytes: number;
};

type CreateSessionInput = {
  sessionId: string;
  accountId: string;
  ticket: string;
  ticketHash: string;
  ticketJti: string;
  expiresAtMs: number;
};

export class DeviceSignalDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
    });
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.headers.get("x-hunsu-connect-internal") !== "1") {
        throw new ConnectHttpError(404, "connect_not_found", "Not found.");
      }
      if (request.method === "GET" && url.pathname === "/status") {
        return jsonResponse({ online: this.openSockets("device").length === 1 });
      }
      if (request.method === "POST" && url.pathname === "/revoke") {
        this.closeAll("revoked");
        return new Response(null, { status: 204 });
      }
      if (request.method === "POST" && url.pathname === "/sessions") {
        return await this.createSession(request);
      }
      if (request.method === "GET" && url.pathname === "/device") {
        return this.acceptDevice(request);
      }
      if (request.method === "GET" && url.pathname === "/browser") {
        return this.acceptBrowser(request);
      }
      throw new ConnectHttpError(404, "connect_not_found", "Not found.");
    } catch (error) {
      return errorResponse(error);
    }
  }

  async alarm(): Promise<void> {
    const device = this.openSockets("device")[0];
    const deviceAttachment = device ? decodeConnectSocketAttachment(device.deserializeAttachment()) : undefined;
    if (device && deviceAttachment?.role === "device" && deviceAttachment.accessExpiresAtMs <= Date.now()) {
      device.close(4003, "device access expired");
    }
    const active = this.activeSession();
    if (active && active.expires_at_ms <= Date.now()) {
      this.closeSession(active.session_id, "expired");
    }
    await this.scheduleNextAlarm();
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    const attachment = decodeConnectSocketAttachment(socket.deserializeAttachment());
    if (!attachment) {
      socket.close(1008, "invalid attachment");
      return;
    }
    if (typeof message !== "string" || encoderByteLength(message) > CONNECT_MAX_SIGNAL_FRAME_BYTES) {
      this.protocolFailure(socket, attachment, "signal frame exceeds the Connect bound");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(message) as unknown;
    } catch {
      this.protocolFailure(socket, attachment, "signal frame is not valid JSON");
      return;
    }
    const decoded = decodeConnectSignalFrame(parsed);
    if (!decoded.ok) {
      this.protocolFailure(socket, attachment, decoded.error.message);
      return;
    }
    const frame = decoded.value;
    const active = this.activeSession();
    if (!active || active.session_id !== frame.sessionId || active.status !== "active") {
      this.protocolFailure(socket, attachment, "signal session is not active");
      return;
    }
    if (active.expires_at_ms <= Date.now()) {
      this.closeSession(active.session_id, "expired");
      return;
    }
    if (attachment.accountId !== active.account_id
      || (attachment.role === "browser" && attachment.sessionId !== active.session_id)) {
      this.protocolFailure(socket, attachment, "signal session binding is invalid");
      return;
    }
    if (attachment.role === "device" && attachment.accessExpiresAtMs <= Date.now()) {
      this.closeSession(active.session_id, "expired");
      socket.close(4003, "device access expired");
      return;
    }
    const expectedSequence = (attachment.role === "device" ? active.device_sequence : active.browser_sequence) + 1;
    if (frame.sequence !== expectedSequence) {
      this.protocolFailure(socket, attachment, "signal sequence is not strictly contiguous");
      return;
    }
    const ciphertextBytes = decodedBase64UrlLength(frame.ciphertext);
    if (active.signal_count + 1 > MAX_SESSION_SIGNAL_COUNT
      || active.signal_bytes + ciphertextBytes > MAX_SESSION_SIGNAL_BYTES) {
      this.protocolFailure(socket, attachment, "signal session rate bound exceeded");
      return;
    }
    const counterpart = attachment.role === "device"
      ? this.openSockets(`browser:${active.session_id}`)[0]
      : this.openSockets("device")[0];
    if (!counterpart) {
      this.closeSession(active.session_id, "peer_disconnected");
      return;
    }
    this.ctx.storage.sql.exec(`
      UPDATE connect_sessions
      SET device_sequence = CASE WHEN ?1 = 'device' THEN ?2 ELSE device_sequence END,
          browser_sequence = CASE WHEN ?1 = 'browser' THEN ?2 ELSE browser_sequence END,
          signal_count = signal_count + 1,
          signal_bytes = signal_bytes + ?3
      WHERE session_id = ?4 AND status = 'active'
    `, attachment.role, frame.sequence, ciphertextBytes, active.session_id);
    try {
      counterpart.send(JSON.stringify(frame));
    } catch {
      this.closeSession(active.session_id, "peer_disconnected");
    }
  }

  webSocketClose(socket: WebSocket, code: number, reason: string): void {
    const attachment = decodeConnectSocketAttachment(socket.deserializeAttachment());
    if (attachment?.role === "device" && this.openSockets("device").length === 0) {
      const active = this.activeSession();
      if (active) this.closeSession(active.session_id, "peer_disconnected");
    } else if (attachment?.role === "browser") {
      this.closeSession(attachment.sessionId, "peer_disconnected");
    }
    void code;
    void reason;
  }

  webSocketError(socket: WebSocket): void {
    const attachment = decodeConnectSocketAttachment(socket.deserializeAttachment());
    if (attachment?.role === "device" && this.openSockets("device").length === 0) {
      const active = this.activeSession();
      if (active) this.closeSession(active.session_id, "peer_disconnected");
    } else if (attachment?.role === "browser") {
      this.closeSession(attachment.sessionId, "peer_disconnected");
    }
    socket.close(1011, "connect websocket error");
  }

  private migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS _connect_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS connect_sessions (
        session_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        ticket_hash TEXT NOT NULL,
        ticket_jti TEXT NOT NULL UNIQUE,
        expires_at_ms INTEGER NOT NULL,
        ticket_used INTEGER NOT NULL DEFAULT 0 CHECK (ticket_used IN (0, 1)),
        status TEXT NOT NULL CHECK (status IN ('active', 'closed')),
        device_sequence INTEGER NOT NULL DEFAULT 0,
        browser_sequence INTEGER NOT NULL DEFAULT 0,
        signal_count INTEGER NOT NULL DEFAULT 0,
        signal_bytes INTEGER NOT NULL DEFAULT 0,
        created_at_ms INTEGER NOT NULL,
        closed_at_ms INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_connect_sessions_active
      ON connect_sessions(status, expires_at_ms);
      INSERT OR IGNORE INTO _connect_schema_migrations (version, applied_at_ms)
      VALUES (1, unixepoch('subsec') * 1000);
    `);
  }

  private async createSession(request: Request): Promise<Response> {
    const input = decodeCreateSessionInput(await readJsonBody(request, 24 * 1024));
    const nowMs = Date.now();
    if (input.expiresAtMs <= nowMs || input.expiresAtMs > nowMs + 90_000) {
      throw new ConnectHttpError(400, "connect_session_invalid", "Connect session expiry is invalid.");
    }
    const device = this.openSockets("device")[0];
    if (!device) {
      throw new ConnectHttpError(409, "connect_device_offline", "Connect device is offline.");
    }
    const deviceAttachment = decodeConnectSocketAttachment(device.deserializeAttachment());
    if (!deviceAttachment || deviceAttachment.role !== "device" || deviceAttachment.accountId !== input.accountId) {
      throw new ConnectHttpError(403, "connect_session_denied", "Connect session account does not own this device connection.");
    }
    if (deviceAttachment.accessExpiresAtMs <= nowMs) {
      device.close(4003, "device access expired");
      throw new ConnectHttpError(409, "connect_device_offline", "Connect device authentication has expired.");
    }
    const existing = this.activeSession();
    if (existing) this.closeSession(existing.session_id, "replaced");
    this.ctx.storage.sql.exec(`
      INSERT INTO connect_sessions (
        session_id, account_id, ticket_hash, ticket_jti, expires_at_ms, ticket_used,
        status, device_sequence, browser_sequence, signal_count, signal_bytes, created_at_ms, closed_at_ms
      ) VALUES (?1, ?2, ?3, ?4, ?5, 0, 'active', 0, 0, 0, 0, ?6, NULL)
    `, input.sessionId, input.accountId, input.ticketHash, input.ticketJti, input.expiresAtMs, nowMs);
    const control: ConnectServerControlFrame = {
      schema: CONNECT_CONTROL_FRAME_SCHEMA,
      type: "connect.session",
      sessionId: input.sessionId,
      ticket: input.ticket,
      expiresAt: new Date(input.expiresAtMs).toISOString()
    };
    try {
      device.send(JSON.stringify(control));
    } catch {
      this.closeSession(input.sessionId, "peer_disconnected");
      throw new ConnectHttpError(409, "connect_device_offline", "Connect device disconnected before session delivery.");
    }
    await this.scheduleNextAlarm();
    return jsonResponse({ created: true });
  }

  private acceptDevice(request: Request): Response {
    requireWebSocketUpgrade(request);
    const deviceId = requiredInternalHeader(request, "x-connect-device-id", "cd_");
    const accountId = requiredInternalHeader(request, "x-connect-account-id", "ca_");
    const authEpoch = requiredIntegerHeader(request, "x-connect-auth-epoch");
    const accessExpiresAtMs = requiredIntegerHeader(request, "x-connect-access-expires-at-ms");
    if (accessExpiresAtMs <= Date.now()) {
      throw new ConnectHttpError(401, "connect_access_token_expired", "Device access token has expired.");
    }
    for (const existing of this.openSockets("device")) existing.close(4001, "device connection replaced");
    const active = this.activeSession();
    if (active) this.closeSession(active.session_id, "replaced");
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const attachment: ConnectSocketAttachment = {
      version: CONNECT_SOCKET_ATTACHMENT_VERSION,
      role: "device",
      deviceId,
      accountId,
      authEpoch,
      accessExpiresAtMs
    };
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server, ["device"]);
    const authenticated: ConnectServerControlFrame = {
      schema: CONNECT_CONTROL_FRAME_SCHEMA,
      type: "connect.authenticated",
      deviceId,
      accountId,
      expiresAt: new Date(accessExpiresAtMs).toISOString()
    };
    server.send(JSON.stringify(authenticated));
    this.ctx.waitUntil(this.scheduleNextAlarm());
    return new Response(null, { status: 101, webSocket: client });
  }

  private acceptBrowser(request: Request): Response {
    requireWebSocketUpgrade(request);
    const sessionId = requiredInternalHeader(request, "x-connect-session-id", "cs_");
    const accountId = requiredInternalHeader(request, "x-connect-account-id", "ca_");
    const ticketHash = requiredInternalHeader(request, "x-connect-ticket-hash", "");
    const active = this.activeSession();
    if (!active
      || active.session_id !== sessionId
      || active.account_id !== accountId
      || active.ticket_hash !== ticketHash
      || active.ticket_used !== 0
      || active.expires_at_ms <= Date.now()) {
      throw new ConnectHttpError(401, "connect_session_ticket_invalid", "Connect session ticket is invalid, expired, or already used.");
    }
    if (this.openSockets(`browser:${sessionId}`).length > 0) {
      throw new ConnectHttpError(409, "connect_session_in_use", "Connect browser session is already connected.");
    }
    this.ctx.storage.sql.exec(`
      UPDATE connect_sessions SET ticket_used = 1
      WHERE session_id = ?1 AND status = 'active' AND ticket_used = 0
    `, sessionId);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const attachment: ConnectSocketAttachment = {
      version: CONNECT_SOCKET_ATTACHMENT_VERSION,
      role: "browser",
      sessionId,
      accountId
    };
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server, [`browser:${sessionId}`]);
    const ready: ConnectServerControlFrame = {
      schema: CONNECT_CONTROL_FRAME_SCHEMA,
      type: "connect.ready",
      sessionId
    };
    server.send(JSON.stringify(ready));
    const device = this.openSockets("device")[0];
    if (device) device.send(JSON.stringify(ready));
    return new Response(null, { status: 101, webSocket: client });
  }

  private activeSession(): SessionRow | undefined {
    return this.ctx.storage.sql.exec<SessionRow>(`
      SELECT session_id, account_id, ticket_hash, ticket_jti, expires_at_ms, ticket_used,
             status, device_sequence, browser_sequence, signal_count, signal_bytes
      FROM connect_sessions WHERE status = 'active' ORDER BY created_at_ms DESC LIMIT 1
    `).toArray()[0];
  }

  private openSockets(tag: string): WebSocket[] {
    return this.ctx.getWebSockets(tag).filter(socket => socket.readyState === WebSocket.OPEN);
  }

  private closeSession(sessionId: string, reason: ConnectCloseReason): void {
    const active = this.ctx.storage.sql.exec<SessionRow>(`
      SELECT session_id, account_id, ticket_hash, ticket_jti, expires_at_ms, ticket_used,
             status, device_sequence, browser_sequence, signal_count, signal_bytes
      FROM connect_sessions WHERE session_id = ?1 AND status = 'active'
    `, sessionId).toArray()[0];
    if (!active) return;
    this.ctx.storage.sql.exec(`
      UPDATE connect_sessions SET status = 'closed', closed_at_ms = ?1
      WHERE session_id = ?2 AND status = 'active'
    `, Date.now(), sessionId);
    const control: ConnectServerControlFrame = {
      schema: CONNECT_CONTROL_FRAME_SCHEMA,
      type: "connect.closed",
      sessionId,
      reason
    };
    for (const socket of this.openSockets("device")) {
      try {
        socket.send(JSON.stringify(control));
      } catch {
        socket.close(1011, "connect control delivery failed");
      }
    }
    for (const socket of this.openSockets(`browser:${sessionId}`)) {
      try {
        socket.send(JSON.stringify(control));
      } finally {
        socket.close(reason === "revoked" ? 4003 : 1000, reason);
      }
    }
    this.ctx.waitUntil(this.scheduleNextAlarm());
  }

  private closeAll(reason: "revoked"): void {
    const active = this.activeSession();
    if (active) this.closeSession(active.session_id, reason);
    for (const socket of this.openSockets("device")) socket.close(4003, reason);
  }

  private async scheduleNextAlarm(): Promise<void> {
    const candidates: number[] = [];
    const active = this.activeSession();
    if (active) candidates.push(active.expires_at_ms);
    const device = this.openSockets("device")[0];
    const attachment = device ? decodeConnectSocketAttachment(device.deserializeAttachment()) : undefined;
    if (attachment?.role === "device") candidates.push(attachment.accessExpiresAtMs);
    if (candidates.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.min(...candidates));
  }

  private protocolFailure(socket: WebSocket, attachment: ConnectSocketAttachment, detail: string): void {
    console.warn(JSON.stringify({
      event: "connect.signal.rejected",
      role: attachment.role,
      reason: detail
    }));
    const sessionId = attachment.role === "browser" ? attachment.sessionId : this.activeSession()?.session_id;
    if (sessionId) this.closeSession(sessionId, "protocol_error");
    else socket.close(1008, "connect protocol error");
  }
}

function decodeCreateSessionInput(value: unknown): CreateSessionInput {
  if (!isRecord(value)
    || typeof value.sessionId !== "string"
    || typeof value.accountId !== "string"
    || typeof value.ticket !== "string"
    || typeof value.ticketHash !== "string"
    || typeof value.ticketJti !== "string"
    || !Number.isSafeInteger(value.expiresAtMs)) {
    throw new ConnectHttpError(400, "connect_session_invalid", "Internal Connect session request is invalid.");
  }
  return {
    sessionId: value.sessionId,
    accountId: value.accountId,
    ticket: value.ticket,
    ticketHash: value.ticketHash,
    ticketJti: value.ticketJti,
    expiresAtMs: Number(value.expiresAtMs)
  };
}

function requireWebSocketUpgrade(request: Request): void {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    throw new ConnectHttpError(426, "connect_upgrade_required", "WebSocket upgrade is required.");
  }
}

function requiredInternalHeader(request: Request, name: string, prefix: string): string {
  const value = request.headers.get(name);
  if (!value || value.length > 8_192 || (prefix && !value.startsWith(prefix))) {
    throw new ConnectHttpError(400, "connect_internal_request_invalid", `Internal header ${name} is invalid.`);
  }
  return value;
}

function requiredIntegerHeader(request: Request, name: string): number {
  const value = Number(request.headers.get(name));
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ConnectHttpError(400, "connect_internal_request_invalid", `Internal header ${name} is invalid.`);
  }
  return value;
}

function encoderByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function decodedBase64UrlLength(value: string): number {
  return Math.floor(value.length * 3 / 4);
}
