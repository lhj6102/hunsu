#!/usr/bin/env node
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import type { Socket } from "node:net";
import { currentProcessEnv, endpointUrl, resolveRelayServerConfig, unwrapConfigResult, type RelayServerConfig } from "@hunsu/config";

export type RelayCommandName =
  | "health"
  | "bridge.status"
  | "connection.status"
  | "provider.inventory"
  | "modelAlias.validate"
  | "modelAlias.resolve"
  | "roadmap.registry.list"
  | "roadmap.registry.remove"
  | "roadmap.open"
  | "roadmap.port.inspect"
  | "roadmap.port.apply"
  | "roadmap.create"
  | "roadmap.board"
  | "roadmap.worktree"
  | "roadmap.skills"
  | "roadmap.commands"
  | "execute.start"
  | "execute.pause"
  | "execute.resume"
  | "execute.stop"
  | "execute.completeMove"
  | "execute.status"
  | "artifactAction.list"
  | "artifactAction.runs"
  | "artifactAction.start"
  | "artifactAction.stop"
  | "moveFile.tree"
  | "moveFile.blob"
  | "moveFile.diff"
  | "hunsuDraft.list"
  | "hunsuDraft.start"
  | "hunsuDraft.get"
  | "hunsuDraft.message"
  | "hunsuDraft.diffArtifact.create"
  | "hunsuDraft.diffArtifact.get"
  | "hunsuDraft.approve"
  | "hunsuDraft.discard"
  | "line.accept"
  | "line.reject"
  | "agentSession.list"
  | "agentSession.get"
  | "agentSession.events"
  | "live.events";

export type BridgeCommandScope =
  | "execute.start"
  | "artifactAction.run"
  | "env.read"
  | "hostAlias.expose"
  | "remoteRelay.access";

export type ProjectGrant = {
  path: string;
  grantedAt: string;
  scopes: BridgeCommandScope[];
  active?: boolean;
};

export type RemoteBridgeDevice = {
  deviceId: string;
  deviceName: string;
  userId: string;
  registeredAt: string;
  lastSeenAt?: string;
  status: "online" | "offline";
  remoteAccess?: "enabled" | "disabled";
  provider?: unknown;
  workspaces?: unknown[];
  projectGrants?: ProjectGrant[];
  lastSnapshotAt?: string;
  bridgeVersion?: string;
  bridgeAppVersion?: string;
  protocolVersion?: string;
};

export type RelayCommand = {
  command: RelayCommandName;
  deviceId: string;
  projectPath?: string;
  requestedScopes?: BridgeCommandScope[];
  payload?: unknown;
};

export type RelayCommandForwardResult =
  | { ok: true; status: number; body?: unknown }
  | { ok: false; status?: number; error: string };

export type RelayCommandDecision =
  | { ok: true; scopes: BridgeCommandScope[] }
  | { ok: false; reason: "device_not_registered" | "device_offline" | "account_mismatch" | "project_grant_denied" | "command_scope_denied"; message: string };

export type RelayCommandResult = RelayCommandForwardResult | RelayCommandDecision;

export type RemoteProjectGrantStatus = "granted" | "needs_grant" | "denied";

export type RemoteProjectGrantStatusResult = {
  projectAccess: RemoteProjectGrantStatus;
  missingScopes?: BridgeCommandScope[];
  message?: string;
};

export type RelayCommandEnvelope = {
  type: "command";
  commandId: string;
  userId: string;
  command: RelayCommand;
};

export type RelayServerOptions = {
  config?: RelayServerConfig;
  commandTimeoutMs?: number;
  now?: () => number;
};

type RelaySession = {
  accessToken: string;
  userId: string;
  email?: string;
  createdAt: string;
  expiresAt?: string;
};

type RelayAuthorizationCode = {
  code: string;
  userId: string;
  email?: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  expiresAtMs: number;
};

type RelayDeviceAuthorization = {
  deviceCode: string;
  userCode: string;
  deviceId: string;
  deviceName: string;
  scope?: string;
  expiresAtMs: number;
  approved: boolean;
  userId?: string;
  email?: string;
};

type StoredRelayDevice = RemoteBridgeDevice & {
  projectGrants: ProjectGrant[];
};

type RelayStateFile = {
  schema: "hunsu.relay-service.v1";
  sessions: RelaySession[];
  devices: StoredRelayDevice[];
};

type ConnectedDevice = {
  session: RelaySession;
  device: StoredRelayDevice;
  peer: WebSocketPeer;
};

type PendingCommand = {
  resolve: (result: RelayCommandResult) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type PendingCommandStream = {
  response: ServerResponse;
  timeout: ReturnType<typeof setTimeout>;
  closed: boolean;
};

export type HunsuRelayServer = {
  server: Server;
  config: RelayServerConfig;
  listen(): Promise<{ apiUrl: string; wsUrl: string }>;
  close(): Promise<void>;
  listDevices(userId?: string): RemoteBridgeDevice[];
};

export function createHunsuRelayServer(options: RelayServerOptions = {}): HunsuRelayServer {
  const config = options.config ?? unwrapConfigResult(resolveRelayServerConfig(currentProcessEnv()));
  const now = options.now ?? Date.now;
  const sessions = new Map<string, RelaySession>();
  const authCodes = new Map<string, RelayAuthorizationCode>();
  const deviceAuthorizations = new Map<string, RelayDeviceAuthorization>();
  const devices = new Map<string, StoredRelayDevice>();
  const connected = new Map<string, ConnectedDevice>();
  const pendingCommands = new Map<string, PendingCommand>();
  const pendingCommandStreams = new Map<string, PendingCommandStream>();

  readState(config.storagePath).sessions.forEach(session => sessions.set(session.accessToken, session));
  readState(config.storagePath).devices.forEach(device => devices.set(device.deviceId, { ...device, status: "offline" }));

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", config.publicApiUrl);
      if (request.method === "OPTIONS") {
        sendJson(response, 204, {});
        return;
      }
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { ok: true, service: "hunsu-relay", issuer: config.issuer });
        return;
      }
      if (request.method === "GET" && url.pathname === "/oauth/authorize") {
        const redirectUri = requiredQuery(url, "redirect_uri");
        const codeChallenge = requiredQuery(url, "code_challenge");
        const codeChallengeMethod = url.searchParams.get("code_challenge_method") ?? "";
        if (codeChallengeMethod !== "S256") {
          sendJson(response, 400, { error: "invalid_request", error_description: "Relay requires PKCE S256 code_challenge_method." });
          return;
        }
        const state = url.searchParams.get("state") ?? "";
        const userId = url.searchParams.get("user_id")?.trim() || "local-relay-user";
        const email = url.searchParams.get("email")?.trim() || (userId.includes("@") ? userId : "relay-user@hunsu.test");
        const code = `relay_code_${randomBytes(20).toString("base64url")}`;
        authCodes.set(code, {
          code,
          userId,
          email,
          codeChallenge,
          codeChallengeMethod: "S256",
          expiresAtMs: now() + 10 * 60 * 1000
        });
        const redirect = new URL(redirectUri);
        redirect.searchParams.set("code", code);
        if (state) redirect.searchParams.set("state", state);
        response.statusCode = 302;
        response.setHeader("location", redirect.toString());
        response.end();
        return;
      }
      if (request.method === "POST" && url.pathname === "/oauth/device/code") {
        const form = await readFormBody(request);
        const deviceCode = `relay_device_${randomBytes(24).toString("base64url")}`;
        const userCode = readableUserCode();
        const expiresIn = 15 * 60;
        deviceAuthorizations.set(deviceCode, {
          deviceCode,
          userCode,
          deviceId: form.get("device_id") ?? "device_unknown",
          deviceName: form.get("device_name") ?? "Hunsu Bridge",
          scope: form.get("scope") ?? undefined,
          expiresAtMs: now() + expiresIn * 1000,
          approved: false
        });
        sendJson(response, 200, {
          device_code: deviceCode,
          user_code: userCode,
          verification_uri: new URL("/device", config.publicApiUrl).toString(),
          verification_uri_complete: `${new URL("/device", config.publicApiUrl).toString()}?user_code=${encodeURIComponent(userCode)}`,
          expires_in: expiresIn,
          interval: 1
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/device") {
        const userCode = url.searchParams.get("user_code")?.trim().toUpperCase();
        const pending = [...deviceAuthorizations.values()].find(candidate => candidate.userCode === userCode);
        if (!pending || pending.expiresAtMs <= now()) {
          sendText(response, 404, "Unknown or expired Hunsu Bridge device code.\n");
          return;
        }
        pending.approved = true;
        pending.userId = url.searchParams.get("user_id")?.trim() || "local-relay-user";
        pending.email = url.searchParams.get("email")?.trim() || "relay-user@hunsu.test";
        sendText(response, 200, `Hunsu Bridge device approved for ${pending.email}.\n`);
        return;
      }
      if (request.method === "POST" && url.pathname === "/oauth/token") {
        const form = await readFormBody(request);
        const grantType = form.get("grant_type");
        if (grantType === "authorization_code") {
          const code = form.get("code") ?? "";
          const stored = authCodes.get(code);
          if (!stored || stored.expiresAtMs <= now()) {
            sendJson(response, 400, { error: "invalid_grant", error_description: "Authorization code expired or was not found." });
            return;
          }
          const codeVerifier = form.get("code_verifier") ?? "";
          if (!verifyPkceCodeVerifier(stored, codeVerifier)) {
            sendJson(response, 400, { error: "invalid_grant", error_description: "PKCE code verifier did not match the authorization request." });
            return;
          }
          authCodes.delete(code);
          sendJson(response, 200, tokenResponse(createSession(stored.userId, stored.email)));
          return;
        }
        if (grantType === "urn:ietf:params:oauth:grant-type:device_code") {
          const deviceCode = form.get("device_code") ?? "";
          const pending = deviceAuthorizations.get(deviceCode);
          if (!pending || pending.expiresAtMs <= now()) {
            sendJson(response, 400, { error: "expired_token" });
            return;
          }
          if (!pending.approved) {
            sendJson(response, 400, { error: "authorization_pending" });
            return;
          }
          deviceAuthorizations.delete(deviceCode);
          sendJson(response, 200, tokenResponse(createSession(pending.userId ?? "local-relay-user", pending.email)));
          return;
        }
        sendJson(response, 400, { error: "unsupported_grant_type" });
        return;
      }

      const session = requireBearerSession(request);
      if (request.method === "GET" && url.pathname === "/v1/devices") {
        sendJson(response, 200, { devices: publicDevices(session.userId) });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/devices") {
        const body = await readJson(request);
        const registered = registerDeviceFromBody(session, body, { connected: false });
        persistState();
        sendJson(response, 202, { device: publicDevice(registered) });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/project-grants/status") {
        const body = await readJson(request);
        sendJson(response, 200, projectGrantStatusFromBody(session, body));
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/commands") {
        const body = await readJson(request);
        const command = parseRelayCommand(body);
        if (!command) {
          sendJson(response, 400, { ok: false, error: "Relay command payload is invalid." });
          return;
        }
        const result = await routeCommand(session, command);
        sendJson(response, result.ok ? ("status" in result ? result.status : 202) : relayStatusForFailure(result), result);
        return;
      }
      if ((request.method === "POST" || request.method === "GET") && url.pathname === "/v1/commands/events") {
        const body = request.method === "GET" ? relayCommandFromQuery(url) : await readJson(request);
        const command = parseRelayCommand(body);
        if (!command) {
          sendJson(response, 400, { ok: false, error: "Relay command payload is invalid." });
          return;
        }
        routeCommandStream(session, command, response);
        return;
      }

      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      const status = error instanceof ResponseError ? error.status : 500;
      sendJson(response, status, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  server.on("upgrade", (request, socket, head) => {
    try {
      const url = new URL(request.url ?? "/", config.publicApiUrl);
      if (url.pathname !== "/v1/device/connect") {
        socket.destroy();
        return;
      }
      const token = url.searchParams.get("access_token") ?? bearerToken(request);
      const session = token ? sessions.get(token) : undefined;
      if (!session) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      const key = request.headers["sec-websocket-key"];
      if (typeof key !== "string") {
        socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
        socket.destroy();
        return;
      }
      const accept = createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      socket.write([
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "",
        ""
      ].join("\r\n"));
      const peer = new WebSocketPeer(socket as Socket, head);
      peer.onMessage = text => {
        const message = parseJsonObject(text);
        if (!message) {
          return;
        }
        if (message.type === "device.register") {
          const device = registerDeviceFromBody(session, message, { connected: true });
          connected.set(device.deviceId, { session, device, peer });
          persistState();
          return;
        }
        if (message.type === "device.heartbeat" && typeof message.deviceId === "string") {
          const device = devices.get(message.deviceId);
          if (device && device.userId === session.userId) {
            devices.set(device.deviceId, { ...device, status: "online", lastSeenAt: new Date(now()).toISOString() });
            persistState();
          }
          return;
        }
        if (message.type === "command.result" && typeof message.commandId === "string") {
          const pendingStream = pendingCommandStreams.get(message.commandId);
          if (pendingStream) {
            finishPendingCommandStream(message.commandId, isRelayCommandResult(message.result) ? message.result : { ok: false, error: "Relay device returned an invalid command result." });
            return;
          }
          const pending = pendingCommands.get(message.commandId);
          if (pending) {
            pendingCommands.delete(message.commandId);
            clearTimeout(pending.timeout);
            pending.resolve(isRelayCommandResult(message.result) ? message.result : { ok: false, error: "Relay device returned an invalid command result." });
          }
          return;
        }
        if (message.type === "command.stream.event" && typeof message.commandId === "string") {
          const pending = pendingCommandStreams.get(message.commandId);
          if (pending && !pending.closed) {
            writeSseEvent(pending.response, optionalString(message.event), optionalString(message.data));
          }
        }
      };
      peer.onClose = () => {
        for (const [deviceId, value] of connected.entries()) {
          if (value.peer === peer) {
            connected.delete(deviceId);
            const device = devices.get(deviceId);
            if (device) {
              devices.set(deviceId, { ...device, status: "offline" });
            }
            for (const [commandId, pending] of pendingCommandStreams.entries()) {
              if (!pending.closed) {
                writeSseEvent(pending.response, "relay.error", JSON.stringify({ error: "Bridge device disconnected from Relay." }));
              }
              finishPendingCommandStream(commandId);
            }
          }
        }
        persistState();
      };
    } catch (_error) {
      socket.destroy();
    }
  });

  function createSession(userId: string, email?: string): RelaySession {
    const session: RelaySession = {
      accessToken: `relay_access_${randomBytes(24).toString("base64url")}`,
      userId,
      email,
      createdAt: new Date(now()).toISOString(),
      expiresAt: new Date(now() + 24 * 60 * 60 * 1000).toISOString()
    };
    sessions.set(session.accessToken, session);
    persistState();
    return session;
  }

  function requireBearerSession(request: IncomingMessage): RelaySession {
    const token = bearerToken(request);
    const session = token ? sessions.get(token) : undefined;
    if (!session) {
      throw new ResponseError("Relay request is not authenticated.", 401);
    }
    if (session.expiresAt && Date.parse(session.expiresAt) <= now()) {
      sessions.delete(session.accessToken);
      persistState();
      throw new ResponseError("Relay session expired.", 401);
    }
    return session;
  }

  function registerDeviceFromBody(session: RelaySession, body: unknown, options: { connected: boolean }): StoredRelayDevice {
    const object = parseJsonObject(body);
    const candidate = parseJsonObject(object?.device) ?? object;
    if (!candidate) {
      throw new ResponseError("Relay device registration payload is invalid.", 400);
    }
    const deviceId = requiredBodyString(candidate, "deviceId");
    const deviceName = requiredBodyString(candidate, "deviceName");
    const userId = requiredBodyString(candidate, "userId");
    if (userId !== session.userId) {
      throw new ResponseError("Relay device user does not match the authenticated session.", 403);
    }
    const existing = devices.get(deviceId);
    const explicitProjectGrants = bodyProjectGrantsValue(object, candidate);
    const projectGrants = explicitProjectGrants === undefined
      ? existing?.projectGrants ?? []
      : parseProjectGrants(explicitProjectGrants);
    const explicitWorkspaces = bodyWorkspacesValue(object, candidate);
    const workspaces = explicitWorkspaces === undefined
      ? existing?.workspaces ?? []
      : parseWorkspaceSnapshots(explicitWorkspaces);
    const nowIso = new Date(now()).toISOString();
    const connectedDevice = options.connected || connected.has(deviceId);
    const remoteAccess = parseRemoteAccess(candidate.remoteAccess) ?? (connectedDevice ? "enabled" : existing?.remoteAccess ?? "enabled");
    const lastSnapshotAt = optionalString(candidate.lastSnapshotAt)
      ?? optionalString(object?.lastSnapshotAt)
      ?? (explicitWorkspaces === undefined ? existing?.lastSnapshotAt : nowIso);
    const device: StoredRelayDevice = {
      deviceId,
      deviceName,
      userId,
      registeredAt: existing?.registeredAt ?? nowIso,
      lastSeenAt: connectedDevice ? nowIso : existing?.lastSeenAt,
      status: connectedDevice ? "online" : "offline",
      remoteAccess,
      provider: parseJsonObject(candidate.provider),
      workspaces,
      lastSnapshotAt,
      bridgeVersion: optionalString(candidate.bridgeVersion),
      bridgeAppVersion: optionalString(candidate.bridgeAppVersion),
      protocolVersion: optionalString(candidate.protocolVersion),
      projectGrants
    };
    devices.set(deviceId, device);
    return device;
  }

  async function routeCommand(session: RelaySession, command: RelayCommand): Promise<RelayCommandResult> {
    const device = devices.get(command.deviceId);
    const connectedDevice = connected.get(command.deviceId);
    const decision = evaluateRelayCommand({
      device,
      command,
      requestUserId: session.userId
    });
    if (!decision.ok) {
      return decision;
    }
    if (!connectedDevice) {
      return { ok: false, reason: "device_offline", message: "Bridge device does not have an active Relay connection." };
    }
    const commandId = `relay_command_${randomBytes(16).toString("base64url")}`;
    const envelope: RelayCommandEnvelope = {
      type: "command",
      commandId,
      userId: session.userId,
      command
    };
    return new Promise<RelayCommandResult>(resolve => {
      const timeout = setTimeout(() => {
        pendingCommands.delete(commandId);
        resolve({ ok: false, status: 504, error: "Relay command timed out waiting for Bridge device." });
      }, options.commandTimeoutMs ?? 10_000);
      pendingCommands.set(commandId, { resolve, timeout });
      connectedDevice.peer.send(envelope);
    });
  }

  function routeCommandStream(session: RelaySession, command: RelayCommand, response: ServerResponse): void {
    const device = devices.get(command.deviceId);
    const connectedDevice = connected.get(command.deviceId);
    const decision = evaluateRelayCommand({
      device,
      command,
      requestUserId: session.userId
    });
    if (!decision.ok) {
      sendJson(response, relayStatusForFailure(decision), decision);
      return;
    }
    if (!connectedDevice) {
      sendJson(response, 503, { ok: false, reason: "device_offline", message: "Bridge device does not have an active Relay connection." });
      return;
    }
    const commandId = `relay_stream_${randomBytes(16).toString("base64url")}`;
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "connection": "keep-alive"
    });
    response.write(": connected\n\n");
    const timeout = setTimeout(() => {
      const pending = pendingCommandStreams.get(commandId);
      if (pending && !pending.closed) {
        writeSseEvent(pending.response, "relay.error", JSON.stringify({ error: "Relay command timed out waiting for Bridge device." }));
      }
      finishPendingCommandStream(commandId);
    }, options.commandTimeoutMs ?? 10_000);
    pendingCommandStreams.set(commandId, { response, timeout, closed: false });
    response.on("close", () => finishPendingCommandStream(commandId, { keepResponseOpen: false }));
    connectedDevice.peer.send({
      type: "command",
      commandId,
      userId: session.userId,
      command
    });
  }

  function finishPendingCommandStream(
    commandId: string,
    resultOrOptions?: RelayCommandResult | { keepResponseOpen?: boolean }
  ): void {
    const pending = pendingCommandStreams.get(commandId);
    if (!pending) {
      return;
    }
    pendingCommandStreams.delete(commandId);
    clearTimeout(pending.timeout);
    const optionsValue = isRelayCommandResult(resultOrOptions) ? undefined : resultOrOptions;
    const result = isRelayCommandResult(resultOrOptions) ? resultOrOptions : undefined;
    if (result && !result.ok && !pending.closed) {
      writeSseEvent(pending.response, "relay.error", JSON.stringify(result));
    }
    pending.closed = true;
    if (optionsValue?.keepResponseOpen !== false && !pending.response.destroyed) {
      pending.response.end();
    }
  }

  function evaluateRelayCommand(input: {
    device: StoredRelayDevice | undefined;
    command: RelayCommand;
    requestUserId?: string;
  }): RelayCommandDecision {
    if (!input.device) {
      return { ok: false, reason: "device_not_registered", message: "Bridge device is not registered with Relay." };
    }
    if (input.requestUserId && input.device.userId !== input.requestUserId) {
      return { ok: false, reason: "account_mismatch", message: "Web session and Bridge device belong to different accounts." };
    }
    if (input.device.remoteAccess === "disabled") {
      return { ok: false, reason: "device_offline", message: "Remote Bridge is disabled for this device." };
    }
    if (input.device.status !== "online") {
      return { ok: false, reason: "device_offline", message: "Bridge device is offline." };
    }
    const requiredScopes = requiredScopesForRelayCommand(input.command);
    if (requiredScopes.length === 0) {
      return { ok: true, scopes: [] };
    }
    const projectPath = input.command.projectPath?.trim();
    if (!projectPath) {
      return { ok: false, reason: "project_grant_denied", message: "Relay command requires an explicit project path." };
    }
    const normalizedProjectPath = normalizeRelayProjectPath(projectPath);
    const grant = input.device.projectGrants.find(candidate => candidate.active !== false && normalizeRelayProjectPath(candidate.path) === normalizedProjectPath);
    if (!grant) {
      return { ok: false, reason: "project_grant_denied", message: "Project Grant is required for this Relay command." };
    }
    const missingScope = requiredScopes.find(scope => !grant.scopes.includes(scope));
    if (missingScope) {
      return { ok: false, reason: "command_scope_denied", message: `Project Grant does not allow ${missingScope}.` };
    }
    return { ok: true, scopes: requiredScopes };
  }

  function projectGrantStatusFromBody(session: RelaySession, value: unknown): RemoteProjectGrantStatusResult {
    const object = parseJsonObject(value);
    const deviceId = optionalString(object?.deviceId);
    const projectPath = optionalString(object?.projectPath);
    const requestedScopes = Array.isArray(object?.requestedScopes)
      ? object.requestedScopes.filter(isBridgeCommandScope)
      : ["remoteRelay.access" as const];
    if (!deviceId) {
      return { projectAccess: "denied", message: "Choose a Remote Bridge device before checking Project Grant status." };
    }
    if (!projectPath) {
      return { projectAccess: "needs_grant", message: "Project Grant status requires a project path." };
    }
    const device = devices.get(deviceId);
    if (!device || device.userId !== session.userId) {
      return { projectAccess: "denied", message: "Remote Bridge device is not registered for this account." };
    }
    const normalizedProjectPath = normalizeRelayProjectPath(projectPath);
    const grant = device.projectGrants.find(candidate => candidate.active !== false && normalizeRelayProjectPath(candidate.path) === normalizedProjectPath);
    if (!grant) {
      return { projectAccess: "needs_grant", message: "Project Grant is required for this Remote Bridge." };
    }
    const missingScopes = requestedScopes.filter(scope => !grant.scopes.includes(scope));
    if (missingScopes.length > 0) {
      return {
        projectAccess: "denied",
        missingScopes,
        message: `Project Grant does not allow ${missingScopes.join(", ")}.`
      };
    }
    return { projectAccess: "granted" };
  }

  function publicDevices(userId?: string): RemoteBridgeDevice[] {
    return [...devices.values()]
      .filter(device => userId === undefined || device.userId === userId)
      .filter(device => device.remoteAccess !== "disabled")
      .map(publicDevice);
  }

  function persistState(): void {
    const state: RelayStateFile = {
      schema: "hunsu.relay-service.v1",
      sessions: [...sessions.values()],
      devices: [...devices.values()]
    };
    mkdirSync(dirname(config.storagePath), { recursive: true });
    writeFileSync(config.storagePath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  return {
    server,
    config,
    listen: () => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.relay.port, config.relay.host, () => {
        server.off("error", reject);
        const address = server.address();
        const apiUrl = typeof address === "object" && address
          ? `http://${config.relay.host}:${address.port}`
          : endpointUrl(config.relay);
        const wsUrl = apiUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:") + "/v1/device/connect";
        config.publicApiUrl = apiUrl;
        config.publicWsUrl = wsUrl;
        config.issuer = apiUrl;
        resolve({ apiUrl, wsUrl });
      });
    }),
    close: () => new Promise((resolve, reject) => {
      for (const value of connected.values()) {
        value.peer.close();
      }
      for (const pending of pendingCommands.values()) {
        clearTimeout(pending.timeout);
        pending.resolve({ ok: false, status: 503, error: "Relay server is shutting down." });
      }
      for (const [commandId, pending] of pendingCommandStreams.entries()) {
        if (!pending.closed) {
          writeSseEvent(pending.response, "relay.error", JSON.stringify({ error: "Relay server is shutting down." }));
        }
        finishPendingCommandStream(commandId);
      }
      server.close(error => error ? reject(error) : resolve());
    }),
    listDevices: publicDevices
  };
}

export function scopesForRelayCommand(command: RelayCommandName): BridgeCommandScope[] {
  switch (command) {
    case "execute.start":
    case "execute.pause":
    case "execute.resume":
    case "execute.stop":
    case "execute.completeMove":
      return ["execute.start", "remoteRelay.access"];
    case "execute.status":
    case "roadmap.board":
    case "roadmap.worktree":
    case "roadmap.skills":
    case "roadmap.commands":
    case "moveFile.tree":
    case "moveFile.blob":
    case "moveFile.diff":
    case "hunsuDraft.list":
    case "hunsuDraft.start":
    case "hunsuDraft.get":
    case "hunsuDraft.message":
    case "hunsuDraft.diffArtifact.create":
    case "hunsuDraft.diffArtifact.get":
    case "hunsuDraft.approve":
    case "hunsuDraft.discard":
    case "line.accept":
    case "line.reject":
    case "agentSession.list":
    case "agentSession.get":
    case "agentSession.events":
    case "live.events":
      return ["remoteRelay.access"];
    case "artifactAction.list":
    case "artifactAction.runs":
      return ["env.read", "hostAlias.expose", "remoteRelay.access"];
    case "artifactAction.start":
    case "artifactAction.stop":
      return ["artifactAction.run", "env.read", "hostAlias.expose", "remoteRelay.access"];
    case "roadmap.open":
    case "roadmap.port.inspect":
    case "roadmap.port.apply":
    case "roadmap.create":
    case "roadmap.registry.remove":
      return ["remoteRelay.access"];
    case "health":
    case "bridge.status":
    case "connection.status":
    case "provider.inventory":
    case "modelAlias.validate":
    case "modelAlias.resolve":
    case "roadmap.registry.list":
      return [];
  }
}

function requiredScopesForRelayCommand(command: RelayCommand): BridgeCommandScope[] {
  return uniqueRelayScopes([
    ...scopesForRelayCommand(command.command),
    ...(command.requestedScopes ?? [])
  ]);
}

function uniqueRelayScopes(scopes: BridgeCommandScope[]): BridgeCommandScope[] {
  return [...new Set(scopes)];
}

function readState(path: string): RelayStateFile {
  if (!existsSync(path)) {
    return { schema: "hunsu.relay-service.v1", sessions: [], devices: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RelayStateFile>;
    return {
      schema: "hunsu.relay-service.v1",
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions.filter(isRelaySession) : [],
      devices: Array.isArray(parsed.devices) ? parsed.devices.filter(isStoredRelayDevice) : []
    };
  } catch (_error) {
    return { schema: "hunsu.relay-service.v1", sessions: [], devices: [] };
  }
}

function tokenResponse(session: RelaySession): Record<string, unknown> {
  const expiresIn = session.expiresAt ? Math.max(1, Math.floor((Date.parse(session.expiresAt) - Date.now()) / 1000)) : 3600;
  return {
    access_token: session.accessToken,
    token_type: "Bearer",
    expires_in: expiresIn,
    user_id: session.userId,
    email: session.email
  };
}

function parseRelayCommand(value: unknown): RelayCommand | undefined {
  const object = parseJsonObject(value);
  if (!object) {
    return undefined;
  }
  const command = object?.command;
  const deviceId = object?.deviceId;
  if (typeof command !== "string" || !isRelayCommandName(command) || typeof deviceId !== "string" || !deviceId.trim()) {
    return undefined;
  }
  return {
    command,
    deviceId: deviceId.trim(),
    projectPath: optionalString(object.projectPath),
    requestedScopes: Array.isArray(object.requestedScopes) ? object.requestedScopes.filter(isBridgeCommandScope) : undefined,
    payload: object.payload
  };
}

function bodyProjectGrantsValue(
  object: Record<string, unknown> | undefined,
  candidate: Record<string, unknown> | undefined
): unknown {
  if (hasOwnJsonField(object, "projectGrants")) {
    return object.projectGrants;
  }
  if (hasOwnJsonField(candidate, "projectGrants")) {
    return candidate.projectGrants;
  }
  return undefined;
}

function bodyWorkspacesValue(
  object: Record<string, unknown> | undefined,
  candidate: Record<string, unknown> | undefined
): unknown {
  if (hasOwnJsonField(object, "workspaces")) {
    return object.workspaces;
  }
  if (hasOwnJsonField(candidate, "workspaces")) {
    return candidate.workspaces;
  }
  return undefined;
}

function hasOwnJsonField(object: Record<string, unknown> | undefined, field: string): object is Record<string, unknown> {
  return Boolean(object && Object.prototype.hasOwnProperty.call(object, field));
}

function parseProjectGrants(value: unknown): ProjectGrant[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is ProjectGrant => {
    const object = parseJsonObject(item);
    return typeof object?.path === "string"
      && typeof object.grantedAt === "string"
      && Array.isArray(object.scopes)
      && object.scopes.every(isBridgeCommandScope);
  }).map(grant => ({
    path: normalizeRelayProjectPath(grant.path),
    grantedAt: grant.grantedAt,
    scopes: [...grant.scopes],
    active: grant.active === false ? false : undefined
  }));
}

function parseWorkspaceSnapshots(value: unknown): unknown[] {
  return Array.isArray(value)
    ? value.filter(isWorkspaceSnapshotLike)
    : [];
}

function isWorkspaceSnapshotLike(value: unknown): boolean {
  const object = parseJsonObject(value);
  return typeof object?.workspaceId === "string"
    && typeof object.roadmapId === "string"
    && typeof object.displayName === "string"
    && typeof object.backendId === "string"
    && (object.connectionMode === "local" || object.connectionMode === "remote")
    && typeof object.provider === "object"
    && object.provider !== null
    && Array.isArray(object.actions);
}

function publicDevice(device: StoredRelayDevice): RemoteBridgeDevice {
  return {
    deviceId: device.deviceId,
    deviceName: device.deviceName,
    userId: device.userId,
    registeredAt: device.registeredAt,
    lastSeenAt: device.lastSeenAt,
    status: device.status,
    remoteAccess: device.remoteAccess,
    provider: device.provider,
    workspaces: device.workspaces,
    projectGrants: device.projectGrants,
    lastSnapshotAt: device.lastSnapshotAt,
    bridgeVersion: device.bridgeVersion,
    bridgeAppVersion: device.bridgeAppVersion,
    protocolVersion: device.protocolVersion
  };
}

function parseRemoteAccess(value: unknown): RemoteBridgeDevice["remoteAccess"] | undefined {
  return value === "enabled" || value === "disabled" ? value : undefined;
}

function normalizeRelayProjectPath(path: string): string {
  return resolve(path);
}

function relayStatusForFailure(result: RelayCommandResult): number {
  if ("status" in result && typeof result.status === "number") {
    return result.status;
  }
  if ("reason" in result) {
    switch (result.reason) {
      case "device_not_registered":
        return 404;
      case "device_offline":
        return 409;
      case "account_mismatch":
      case "project_grant_denied":
      case "command_scope_denied":
        return 403;
    }
  }
  return 502;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? JSON.parse(text) : {};
}

async function readFormBody(request: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-headers", "authorization,content-type");
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  response.setHeader("content-type", "application/json");
  response.end(status === 204 ? "" : `${JSON.stringify(body)}\n`);
}

function sendText(response: ServerResponse, status: number, body: string): void {
  response.statusCode = status;
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.end(body);
}

function writeSseEvent(response: ServerResponse, event: string | undefined, data: string | undefined): void {
  if (event) {
    response.write(`event: ${event}\n`);
  }
  if (data !== undefined) {
    for (const line of data.split(/\r?\n/)) {
      response.write(`data: ${line}\n`);
    }
  }
  response.write("\n");
}

function bearerToken(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization;
  const match = typeof authorization === "string" ? authorization.match(/^Bearer\s+(.+)$/i) : undefined;
  if (match?.[1]?.trim()) {
    return match[1].trim();
  }
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    return url.searchParams.get("access_token")?.trim()
      || url.searchParams.get("hunsuRelayToken")?.trim()
      || undefined;
  } catch (_error) {
    return undefined;
  }
}

function relayCommandFromQuery(url: URL): unknown {
  const raw = url.searchParams.get("command");
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (_error) {
    return undefined;
  }
}

function requiredQuery(url: URL, name: string): string {
  const value = url.searchParams.get(name)?.trim();
  if (!value) {
    throw new ResponseError(`Missing required query parameter: ${name}.`, 400);
  }
  return value;
}

function requiredBodyString(value: Record<string, unknown> | undefined, name: string): string {
  const text = value?.[name];
  if (typeof text !== "string" || !text.trim()) {
    throw new ResponseError(`Missing required body field: ${name}.`, 400);
  }
  return text.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      return parseJsonObject(JSON.parse(value));
    } catch (_error) {
      return undefined;
    }
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isRelayCommandResult(value: unknown): value is RelayCommandResult {
  const object = parseJsonObject(value);
  return object?.ok === true || object?.ok === false;
}

function isRelayCommandName(value: string): value is RelayCommandName {
  return [
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
  ].includes(value);
}

function isBridgeCommandScope(value: unknown): value is BridgeCommandScope {
  return typeof value === "string" && [
    "execute.start",
    "artifactAction.run",
    "env.read",
    "hostAlias.expose",
    "remoteRelay.access"
  ].includes(value);
}

function isRelaySession(value: unknown): value is RelaySession {
  const object = parseJsonObject(value);
  return typeof object?.accessToken === "string"
    && typeof object.userId === "string"
    && typeof object.createdAt === "string";
}

function isStoredRelayDevice(value: unknown): value is StoredRelayDevice {
  const object = parseJsonObject(value);
  return typeof object?.deviceId === "string"
    && typeof object.deviceName === "string"
    && typeof object.userId === "string"
    && typeof object.registeredAt === "string"
    && (object.status === "online" || object.status === "offline")
    && Array.isArray(object.projectGrants);
}

function readableUserCode(): string {
  const first = randomBytes(3).toString("base64url").replace(/[^A-Z0-9]/gi, "").slice(0, 4).toUpperCase().padEnd(4, "H");
  const second = randomBytes(3).toString("base64url").replace(/[^A-Z0-9]/gi, "").slice(0, 4).toUpperCase().padEnd(4, "U");
  return `${first}-${second}`;
}

function verifyPkceCodeVerifier(code: RelayAuthorizationCode, codeVerifier: string): boolean {
  if (!codeVerifier.trim()) {
    return false;
  }
  const expected = createHash("sha256").update(codeVerifier).digest("base64url");
  return safeCompare(expected, code.codeChallenge);
}

function safeCompare(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

class ResponseError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ResponseError";
    this.status = status;
  }
}

class WebSocketPeer {
  onMessage: ((text: string) => void) | undefined;
  onClose: (() => void) | undefined;
  private buffer = Buffer.alloc(0);
  private readonly socket: Socket;

  constructor(socket: Socket, head: Buffer) {
    this.socket = socket;
    if (head.length > 0) {
      this.buffer = Buffer.concat([this.buffer, head]);
    }
    socket.on("data", chunk => this.handleData(chunk));
    socket.once("close", () => this.onClose?.());
    socket.once("error", () => this.onClose?.());
  }

  send(value: unknown): void {
    const payload = Buffer.from(JSON.stringify(value), "utf8");
    const header = payload.length < 126
      ? Buffer.from([0x81, payload.length])
      : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
    this.socket.write(Buffer.concat([header, payload]));
  }

  close(): void {
    this.socket.end();
  }

  private handleData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < offset + 2) return;
        length = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        this.socket.destroy(new Error("Relay WebSocket frame is too large."));
        return;
      }
      const maskLength = masked ? 4 : 0;
      if (this.buffer.length < offset + maskLength + length) {
        return;
      }
      const mask = masked ? this.buffer.subarray(offset, offset + 4) : undefined;
      offset += maskLength;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      this.buffer = this.buffer.subarray(offset + length);
      if (opcode === 0x8) {
        this.close();
        return;
      }
      if (opcode !== 0x1) {
        continue;
      }
      if (mask) {
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] ^= mask[index % 4];
        }
      }
      this.onMessage?.(payload.toString("utf8"));
    }
  }
}

async function main(): Promise<void> {
  const relay = createHunsuRelayServer();
  const urls = await relay.listen();
  console.log(`Hunsu Relay: ${urls.apiUrl}`);
  console.log(`Hunsu Relay device WebSocket: ${urls.wsUrl}`);
  await new Promise<void>((resolve, reject) => {
    const shutdown = () => relay.close().then(resolve, reject);
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export { safeCompare };
