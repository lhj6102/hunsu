import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ConnectedWorkspaceSummary, RuntimeProviderStatus } from "@hunsu/bridge";

export type RelayCommandName =
  | "health"
  | "bridge.status"
  | "connection.status"
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
  provider?: RuntimeProviderStatus;
  workspaces?: ConnectedWorkspaceSummary[];
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

export type RelayCommandDecision =
  | { ok: true; scopes: BridgeCommandScope[] }
  | { ok: false; reason: "device_not_registered" | "device_offline" | "account_mismatch" | "project_grant_denied" | "command_scope_denied"; message: string };

export type RelayConnectionStatus =
  | { status: "idle" }
  | { status: "connecting"; relayUrl: string }
  | { status: "connected"; relayUrl: string; connectedAt: string }
  | { status: "closed"; relayUrl: string; closedAt: string }
  | { status: "error"; relayUrl: string; error: string };

export type RelayHttpRequest = {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  stream?: true;
};

export type RelayCommandForwardResult =
  | { ok: true; status: number; body?: unknown }
  | { ok: false; status?: number; error: string };

export type RelayCommandEnvelope = {
  type: "command";
  commandId: string;
  userId: string;
  command: RelayCommand;
};

export type RelayClientMessage =
  | { type: "device.register"; device: RemoteBridgeDevice; projectGrants?: ProjectGrant[]; workspaces?: ConnectedWorkspaceSummary[]; lastSnapshotAt?: string }
  | { type: "device.heartbeat"; deviceId: string; at: string }
  | { type: "command.stream.event"; commandId: string; event?: string; data?: string }
  | { type: "command.result"; commandId: string; result: RelayCommandForwardResult | RelayCommandDecision };

type RelayWebSocket = {
  readyState?: number;
  send(message: string): void;
  close(): void;
  addEventListener?: (event: "open" | "message" | "close" | "error", listener: (event: unknown) => void) => void;
  onopen?: () => void;
  onmessage?: (event: { data: unknown }) => void;
  onclose?: () => void;
  onerror?: (event: unknown) => void;
};

type RelayWebSocketConstructor = new (url: string, protocols?: string | string[]) => RelayWebSocket;

export type RelayOutboundClientOptions = {
  relayUrl: string;
  accessToken?: string;
  device: RemoteBridgeDevice;
  projectGrants: ProjectGrant[] | (() => ProjectGrant[]);
  bridgeApiUrl?: string;
  bridgeAuthToken?: string;
  websocketFactory?: (url: string) => RelayWebSocket;
  fetchImpl?: typeof fetch;
  heartbeatIntervalMs?: number;
  reconnectInitialDelayMs?: number;
  reconnectMaxDelayMs?: number;
  reconnectBackoffFactor?: number;
};

export type RelayRegistryStore = {
  schema: "hunsu.relay-registry.v1";
  devices: RemoteBridgeDevice[];
};

export type RelayServiceSession = {
  accessToken: string;
  userId: string;
  email?: string;
};

export type RelayCommandHandler = (envelope: RelayCommandEnvelope) => Promise<RelayCommandForwardResult | RelayCommandDecision>;

export type RelayStreamEvent = {
  event?: string;
  data?: string;
};

type RoadmapRegistryEntry = {
  roadmapId: string;
  repositoryPath: string;
};

export type LocalDevRelayCommandResult =
  | RelayCommandForwardResult
  | RelayCommandDecision;

export class FileRelayRegistry {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  listDevices(userId?: string): RemoteBridgeDevice[] {
    const devices = this.read().devices.filter(device => device.remoteAccess !== "disabled");
    return userId ? devices.filter(device => device.userId === userId) : devices;
  }

  registerDevice(device: Omit<RemoteBridgeDevice, "registeredAt" | "status"> & { status?: RemoteBridgeDevice["status"] }): RemoteBridgeDevice {
    const store = this.read();
    const existing = store.devices.find(candidate => candidate.deviceId === device.deviceId);
    const registered: RemoteBridgeDevice = {
      ...device,
      registeredAt: existing?.registeredAt ?? new Date().toISOString(),
      lastSeenAt: device.status === "online" ? new Date().toISOString() : existing?.lastSeenAt,
      status: device.status ?? "offline",
      remoteAccess: device.remoteAccess ?? (device.status === "online" ? "enabled" : existing?.remoteAccess ?? "enabled")
    };
    this.write({
      schema: "hunsu.relay-registry.v1",
      devices: [registered, ...store.devices.filter(candidate => candidate.deviceId !== device.deviceId)]
    });
    return registered;
  }

  updateDeviceStatus(deviceId: string, status: RemoteBridgeDevice["status"], remoteAccess?: RemoteBridgeDevice["remoteAccess"]): RemoteBridgeDevice | undefined {
    const store = this.read();
    let updated: RemoteBridgeDevice | undefined;
    const devices = store.devices.map(device => {
      if (device.deviceId !== deviceId) {
        return device;
      }
      updated = {
        ...device,
        status,
        remoteAccess: remoteAccess ?? device.remoteAccess,
        lastSeenAt: status === "online" ? new Date().toISOString() : device.lastSeenAt
      };
      return updated;
    });
    if (updated) {
      this.write({ schema: "hunsu.relay-registry.v1", devices });
    }
    return updated;
  }

  private read(): RelayRegistryStore {
    if (!existsSync(this.path)) {
      return { schema: "hunsu.relay-registry.v1", devices: [] };
    }
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<RelayRegistryStore>;
      return {
        schema: "hunsu.relay-registry.v1",
        devices: Array.isArray(parsed.devices) ? parsed.devices.filter(isRemoteBridgeDevice) : []
      };
    } catch (_error) {
      return { schema: "hunsu.relay-registry.v1", devices: [] };
    }
  }

  private write(store: RelayRegistryStore): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  }
}

export class RelayOutboundClient {
  private readonly options: RelayOutboundClientOptions;
  private socket: RelayWebSocket | undefined;
  private statusValue: RelayConnectionStatus = { status: "idle" };
  private stopping = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: RelayOutboundClientOptions) {
    this.options = options;
  }

  status(): RelayConnectionStatus {
    return this.statusValue;
  }

  updateProjectGrants(projectGrants: ProjectGrant[]): void {
    this.options.projectGrants = projectGrants;
    this.sendDeviceRegistration();
  }

  start(): RelayConnectionStatus {
    this.stopping = false;
    if (this.socket || this.reconnectTimer) {
      return this.statusValue;
    }
    this.connect();
    return this.statusValue;
  }

  stop(): RelayConnectionStatus {
    this.stopping = true;
    this.clearReconnectTimer();
    this.clearHeartbeatTimer();
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
    this.statusValue = { status: "closed", relayUrl: this.options.relayUrl, closedAt: new Date().toISOString() };
    return this.statusValue;
  }

  private connect(): void {
    if (this.stopping) {
      return;
    }
    this.statusValue = { status: "connecting", relayUrl: this.options.relayUrl };
    const relayUrl = relayUrlWithAccessToken(this.options.relayUrl, this.options.accessToken);
    const socket = this.options.websocketFactory
      ? this.options.websocketFactory(relayUrl)
      : new (defaultWebSocketConstructor())(relayUrl);
    this.socket = socket;
    const onOpen = () => {
      this.reconnectAttempt = 0;
      this.statusValue = { status: "connected", relayUrl: this.options.relayUrl, connectedAt: new Date().toISOString() };
      this.sendDeviceRegistration();
      this.sendHeartbeat();
      this.startHeartbeatTimer();
    };
    const onMessage = (event: { data: unknown }) => {
      void this.handleMessage(event.data);
    };
    const onClose = () => {
      if (this.socket === socket) {
        this.socket = undefined;
      }
      this.clearHeartbeatTimer();
      this.statusValue = { status: "closed", relayUrl: this.options.relayUrl, closedAt: new Date().toISOString() };
      this.scheduleReconnect();
    };
    const onError = (event: unknown) => {
      this.statusValue = { status: "error", relayUrl: this.options.relayUrl, error: event instanceof Error ? event.message : "Relay connection error" };
      this.scheduleReconnect();
    };
    if (socket.addEventListener) {
      socket.addEventListener("open", onOpen);
      socket.addEventListener("message", event => onMessage(event as { data: unknown }));
      socket.addEventListener("close", onClose);
      socket.addEventListener("error", onError);
    } else {
      socket.onopen = onOpen;
      socket.onmessage = onMessage;
      socket.onclose = onClose;
      socket.onerror = onError;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer) {
      return;
    }
    this.clearHeartbeatTimer();
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
    const initialDelay = this.options.reconnectInitialDelayMs ?? 1_000;
    const maxDelay = this.options.reconnectMaxDelayMs ?? 30_000;
    const factor = this.options.reconnectBackoffFactor ?? 2;
    const delay = Math.min(maxDelay, Math.round(initialDelay * Math.max(1, factor) ** this.reconnectAttempt));
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  private startHeartbeatTimer(): void {
    this.clearHeartbeatTimer();
    const intervalMs = this.options.heartbeatIntervalMs ?? 30_000;
    if (intervalMs <= 0) {
      return;
    }
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), intervalMs);
  }

  private sendHeartbeat(): void {
    const device = this.options.device;
    this.send({
      type: "device.heartbeat",
      deviceId: device.deviceId,
      at: new Date().toISOString()
    });
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private async handleMessage(data: unknown): Promise<void> {
    const envelope = parseRelayCommandEnvelope(data);
    if (!envelope) {
      return;
    }
    const projectGrants = this.currentProjectGrants();
    const decision = evaluateRelayCommand({
      device: envelope.command.deviceId === this.options.device.deviceId ? this.options.device : undefined,
      command: envelope.command,
      projectGrants,
      requestUserId: envelope.userId
    });
    if (!decision.ok) {
      this.send({ type: "command.result", commandId: envelope.commandId, result: decision });
      return;
    }
    if (!this.options.bridgeApiUrl) {
      this.send({
        type: "command.result",
        commandId: envelope.commandId,
        result: { ok: false, error: "Local Bridge API URL is not available for Relay forwarding." }
      });
      return;
    }
    const request = relayHttpRequestForCommand(envelope.command);
    const result = request?.stream
      ? await forwardRelayCommandStream({
          bridgeApiUrl: this.options.bridgeApiUrl,
          bridgeAuthToken: this.options.bridgeAuthToken,
          command: envelope.command,
          projectGrants,
          fetchImpl: this.options.fetchImpl,
          onEvent: event => this.send({
            type: "command.stream.event",
            commandId: envelope.commandId,
            event: event.event,
            data: event.data
          })
        })
      : await forwardRelayCommand({
      bridgeApiUrl: this.options.bridgeApiUrl,
      bridgeAuthToken: this.options.bridgeAuthToken,
      command: envelope.command,
      projectGrants,
      fetchImpl: this.options.fetchImpl
    });
    this.send({ type: "command.result", commandId: envelope.commandId, result });
  }

  private currentProjectGrants(): ProjectGrant[] {
    const source = this.options.projectGrants;
    return typeof source === "function" ? source() : source;
  }

  private sendDeviceRegistration(): void {
    const projectGrants = this.currentProjectGrants();
    const device: RemoteBridgeDevice = {
      ...this.options.device,
      status: "online",
      lastSeenAt: new Date().toISOString(),
      projectGrants
    };
    this.send({
      type: "device.register",
      device,
      projectGrants,
      workspaces: device.workspaces ?? [],
      lastSnapshotAt: device.lastSnapshotAt
    });
  }

  private send(message: RelayClientMessage): void {
    this.socket?.send(JSON.stringify(message));
  }
}

export async function registerRelayDevice(input: {
  relayApiUrl: string;
  accessToken: string;
  device: RemoteBridgeDevice;
  projectGrants?: ProjectGrant[];
  workspaces?: ConnectedWorkspaceSummary[];
  lastSnapshotAt?: string;
  fetchImpl?: typeof fetch;
}): Promise<RemoteBridgeDevice> {
  const fetcher = input.fetchImpl ?? fetch;
  const projectGrants = input.projectGrants ?? input.device.projectGrants ?? [];
  const workspaces = input.workspaces ?? input.device.workspaces ?? [];
  const lastSnapshotAt = input.lastSnapshotAt ?? input.device.lastSnapshotAt;
  const response = await fetcher(new URL("/v1/devices", input.relayApiUrl), {
    method: "POST",
    headers: {
      "authorization": `Bearer ${input.accessToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      device: {
        ...input.device,
        projectGrants,
        workspaces,
        lastSnapshotAt
      },
      projectGrants,
      workspaces,
      lastSnapshotAt
    })
  });
  const body = await response.json().catch(() => undefined) as { device?: RemoteBridgeDevice; error?: string } | undefined;
  if (!response.ok || !body?.device) {
    throw new Error(body?.error ?? `Relay device registration failed with HTTP ${response.status}.`);
  }
  return body.device;
}

export function evaluateRelayCommand(input: {
  device: RemoteBridgeDevice | undefined;
  command: RelayCommand;
  projectGrants: ProjectGrant[];
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
  const projectPath = input.command.projectPath ? normalizeLocalPath(input.command.projectPath) : undefined;
  if (!projectPath) {
    return { ok: false, reason: "project_grant_denied", message: "Relay command requires an explicit project path." };
  }
  const grant = input.projectGrants.find(candidate => candidate.active !== false && normalizeLocalPath(candidate.path) === projectPath);
  if (!grant) {
    return { ok: false, reason: "project_grant_denied", message: "Project Grant is required for this Relay command." };
  }
  const missingScope = requiredScopes.find(scope => !grant.scopes.includes(scope));
  if (missingScope) {
    return { ok: false, reason: "command_scope_denied", message: `Project Grant does not allow ${missingScope}.` };
  }
  return { ok: true, scopes: requiredScopes };
}

function requiredScopesForRelayCommand(command: RelayCommand): BridgeCommandScope[] {
  return uniqueRelayScopes([
    ...scopesForRelayCommand(command.command),
    ...(command.requestedScopes ?? [])
  ]);
}

export async function forwardRelayCommand(input: {
  bridgeApiUrl: string;
  bridgeAuthToken?: string;
  command: RelayCommand;
  projectGrants?: ProjectGrant[];
  fetchImpl?: typeof fetch;
}): Promise<RelayCommandForwardResult> {
  const request = relayHttpRequestForCommand(input.command);
  if (!request) {
    return { ok: false, error: `Relay command cannot be forwarded yet: ${input.command.command}` };
  }
  if (request.stream) {
    return { ok: false, error: `Relay command must be forwarded as a stream: ${input.command.command}` };
  }
  const fetcher = input.fetchImpl ?? fetch;
  const validation = await validateRelayCommandProjectGrant({
    bridgeApiUrl: input.bridgeApiUrl,
    bridgeAuthToken: input.bridgeAuthToken,
    command: input.command,
    fetchImpl: fetcher
  });
  if (!validation.ok) {
    return validation;
  }
  const headers: Record<string, string> = {};
  if (input.bridgeAuthToken) {
    headers["x-hunsu-bridge-token"] = input.bridgeAuthToken;
  }
  if (request.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  const response = await fetcher(new URL(request.path, input.bridgeApiUrl), {
    method: request.method,
    headers,
    body: request.body === undefined ? undefined : JSON.stringify(request.body)
  });
  const body = response.headers.get("content-type")?.includes("application/json")
    ? await response.json().catch(() => undefined)
    : await response.text().catch(() => undefined);
  if (!response.ok) {
    return { ok: false, status: response.status, error: typeof body === "object" && body !== null && "error" in body ? String((body as { error?: unknown }).error) : `Bridge API returned ${response.status}` };
  }
  return {
    ok: true,
    status: response.status,
    body: sanitizeRelayResponseBody(body, input.command, input.projectGrants ?? [])
  };
}

export async function forwardRelayCommandStream(input: {
  bridgeApiUrl: string;
  bridgeAuthToken?: string;
  command: RelayCommand;
  projectGrants?: ProjectGrant[];
  fetchImpl?: typeof fetch;
  onEvent: (event: RelayStreamEvent) => void;
}): Promise<RelayCommandForwardResult> {
  const request = relayHttpRequestForCommand(input.command);
  if (!request) {
    return { ok: false, error: `Relay command cannot be forwarded yet: ${input.command.command}` };
  }
  if (!request.stream) {
    return { ok: false, error: `Relay command is not an event stream: ${input.command.command}` };
  }
  const fetcher = input.fetchImpl ?? fetch;
  const validation = await validateRelayCommandProjectGrant({
    bridgeApiUrl: input.bridgeApiUrl,
    bridgeAuthToken: input.bridgeAuthToken,
    command: input.command,
    fetchImpl: fetcher
  });
  if (!validation.ok) {
    return validation;
  }
  const headers: Record<string, string> = {};
  if (input.bridgeAuthToken) {
    headers["x-hunsu-bridge-token"] = input.bridgeAuthToken;
  }
  const response = await fetcher(new URL(request.path, input.bridgeApiUrl), {
    method: request.method,
    headers
  });
  if (!response.ok) {
    const body = response.headers.get("content-type")?.includes("application/json")
      ? await response.json().catch(() => undefined)
      : await response.text().catch(() => undefined);
    return { ok: false, status: response.status, error: typeof body === "object" && body !== null && "error" in body ? String((body as { error?: unknown }).error) : `Bridge API returned ${response.status}` };
  }
  if (!response.body) {
    return { ok: false, status: response.status, error: "Bridge API did not return an event stream." };
  }
  await readSseStream(response.body, input.onEvent);
  return { ok: true, status: response.status };
}

async function validateRelayCommandProjectGrant(input: {
  bridgeApiUrl: string;
  bridgeAuthToken?: string;
  command: RelayCommand;
  fetchImpl: typeof fetch;
}): Promise<{ ok: true } | RelayCommandForwardResult> {
  if (!requiresProjectPathGrantValidation(input.command.command)) {
    return { ok: true };
  }
  const projectPath = input.command.projectPath?.trim();
  if (!projectPath) {
    return { ok: false, status: 403, error: "Remote command requires a projectPath for Project Grant validation." };
  }
  const payloadPathValidation = validateRelayCommandPayloadProjectPath(input.command, projectPath);
  if (!payloadPathValidation.ok) {
    return payloadPathValidation;
  }
  const roadmapId = relayCommandRoadmapId(input.command);
  if (!roadmapId) {
    return requiresRoadmapProjectValidation(input.command.command)
      ? { ok: false, status: 403, error: "Remote command requires a roadmapId for Project Grant validation." }
      : { ok: true };
  }
  const headers: Record<string, string> = {};
  if (input.bridgeAuthToken) {
    headers["x-hunsu-bridge-token"] = input.bridgeAuthToken;
  }
  const response = await input.fetchImpl(new URL("/api/roadmaps/recent", input.bridgeApiUrl), {
    method: "GET",
    headers
  });
  const body = await response.json().catch(() => undefined) as { roadmaps?: unknown; error?: string } | undefined;
  if (!response.ok) {
    return { ok: false, status: response.status, error: body?.error ?? `Bridge Roadmap registry returned ${response.status}.` };
  }
  const roadmaps = Array.isArray(body?.roadmaps) ? body.roadmaps.filter(isRoadmapRegistryEntry) : [];
  const roadmap = roadmaps.find(candidate => candidate.roadmapId === roadmapId);
  if (!roadmap) {
    return { ok: false, status: 403, error: `Roadmap is not registered on this Bridge: ${roadmapId}` };
  }
  if (normalizeLocalPath(roadmap.repositoryPath) !== normalizeLocalPath(projectPath)) {
    return { ok: false, status: 403, error: "Roadmap does not belong to the granted project path." };
  }
  return { ok: true };
}

function validateRelayCommandPayloadProjectPath(
  command: RelayCommand,
  projectPath: string
): { ok: true } | RelayCommandForwardResult {
  const projectPathFields = relayCommandProjectPathPayloadFields(command.command);
  if (projectPathFields.length === 0) {
    return { ok: true };
  }
  const payload = objectPayload(command.payload);
  if (!payload) {
    return { ok: true };
  }
  const normalizedProjectPath = normalizeLocalPath(projectPath);
  for (const field of projectPathFields) {
    const value = stringPayloadField(payload, field);
    if (value && normalizeLocalPath(value) !== normalizedProjectPath) {
      return { ok: false, status: 403, error: `Remote command payload ${field} does not match the granted project path.` };
    }
  }
  return { ok: true };
}

function relayCommandProjectPathPayloadFields(command: RelayCommandName): Array<"path" | "cwd"> {
  switch (command) {
    case "roadmap.open":
    case "roadmap.port.inspect":
    case "roadmap.port.apply":
    case "roadmap.create":
      return ["path", "cwd"];
    case "roadmap.registry.remove":
      return ["path", "cwd"];
    default:
      return [];
  }
}

function sanitizeRelayResponseBody(body: unknown, command: RelayCommand, projectGrants: ProjectGrant[]): unknown {
  if (command.command === "bridge.status") {
    return redactBridgeStatusBody(body, projectGrants);
  }
  if (command.command === "connection.status") {
    return redactConnectionStatusBody(body, command, projectGrants);
  }
  if (command.command === "roadmap.registry.list") {
    return filterRemoteRoadmapRegistryBody(body, projectGrants);
  }
  return body;
}

function redactBridgeStatusBody(body: unknown, projectGrants: ProjectGrant[]): unknown {
  const value = objectPayload(body);
  if (!value) {
    return body;
  }
  const redactWorkspace = (workspace: unknown): unknown => {
    const item = objectPayload(workspace);
    if (!item) return workspace;
    const path = typeof item.path === "string" ? item.path : undefined;
    if (!path || projectPathIsGranted(path, undefined, projectGrants)) {
      return item;
    }
    const next: Record<string, unknown> = { ...item, pathRedacted: true };
    delete next.path;
    return next;
  };
  const redactConnection = (connection: unknown): unknown => {
    const item = objectPayload(connection);
    if (!item || !Array.isArray(item.workspaces)) return connection;
    return {
      ...item,
      workspaces: item.workspaces.map(redactWorkspace)
    };
  };
  const workspaces = objectPayload(value.workspaces);
  return {
    ...value,
    connections: Array.isArray(value.connections) ? value.connections.map(redactConnection) : value.connections,
    workspaces: workspaces
      ? {
          ...workspaces,
          active: Array.isArray(workspaces.active) ? workspaces.active.map(redactWorkspace) : workspaces.active,
          managed: Array.isArray(workspaces.managed) ? workspaces.managed.map(redactWorkspace) : workspaces.managed
        }
      : value.workspaces
  };
}

function redactConnectionStatusBody(body: unknown, command: RelayCommand, projectGrants: ProjectGrant[]): unknown {
  const value = objectPayload(body);
  if (!value) {
    return body;
  }
  const project = objectPayload(value.project);
  if (!project || typeof project.repositoryPath !== "string") {
    return body;
  }
  if (projectPathIsGranted(project.repositoryPath, command.projectPath, projectGrants)) {
    return body;
  }
  const nextProject = { ...project };
  delete nextProject.repositoryPath;
  return {
    ...value,
    project: nextProject
  };
}

function filterRemoteRoadmapRegistryBody(body: unknown, projectGrants: ProjectGrant[]): unknown {
  const value = objectPayload(body);
  if (!value || !Array.isArray(value.roadmaps)) {
    return body;
  }
  return {
    ...value,
    roadmaps: value.roadmaps
      .filter(item => {
        const roadmap = objectPayload(item);
        return typeof roadmap?.repositoryPath === "string" && projectPathIsGranted(roadmap.repositoryPath, undefined, projectGrants);
      })
      .map(item => {
        const roadmap = objectPayload(item)!;
        return { ...roadmap };
      })
  };
}

function projectPathIsGranted(path: string, requestedPath: string | undefined, projectGrants: ProjectGrant[]): boolean {
  const normalizedPath = normalizeLocalPath(path);
  if (requestedPath && normalizeLocalPath(requestedPath) !== normalizedPath) {
    return false;
  }
  return projectGrants.some(grant =>
    normalizeLocalPath(grant.path) === normalizedPath
    && grant.scopes.includes("remoteRelay.access")
  );
}

export function relayHttpRequestForCommand(command: RelayCommand): RelayHttpRequest | undefined {
  const payload = objectPayload(command.payload);
  const roadmapId = stringPayloadField(payload, "roadmapId");
  const path = (suffix: string, query?: URLSearchParams) => {
    const base = roadmapId
      ? `/api/roadmaps/${encodeURIComponent(roadmapId)}${suffix}`
      : `/api${suffix}`;
    const queryString = query?.toString();
    return queryString ? `${base}?${queryString}` : base;
  };
  switch (command.command) {
    case "health":
      return { method: "GET", path: "/health" };
    case "bridge.status":
      return { method: "GET", path: "/api/bridge/status" };
    case "connection.status":
      return { method: "GET", path: "/api/connection/status" };
    case "roadmap.registry.list":
      return { method: "GET", path: "/api/roadmaps/recent" };
    case "roadmap.registry.remove":
      return { method: "POST", path: "/api/roadmaps/recent/remove", body: relayRegistryRemoveBody(command) };
    case "roadmap.open":
      return { method: "POST", path: "/api/roadmaps/open", body: relayProjectPathBody(command) };
    case "roadmap.port.inspect":
      return { method: "POST", path: "/api/roadmaps/port/inspect", body: relayProjectPathBody(command) };
    case "roadmap.port.apply":
      return { method: "POST", path: "/api/roadmaps/port/apply", body: relayProjectPathBody(command) };
    case "roadmap.create":
      return { method: "POST", path: "/api/roadmaps/create", body: relayProjectPathBody(command) };
    case "roadmap.board":
      return { method: "GET", path: path("/board") };
    case "roadmap.worktree":
      return { method: "GET", path: path("/worktree") };
    case "roadmap.skills":
      return { method: "GET", path: path("/skills") };
    case "roadmap.commands":
      return { method: "POST", path: path("/commands"), body: command.payload ?? {} };
    case "execute.status":
      return { method: "GET", path: path("/executes") };
    case "live.events":
      return { method: "GET", path: path("/executes/events"), stream: true };
    case "execute.start":
      return { method: "POST", path: path("/executes/start"), body: command.payload ?? {} };
    case "execute.pause":
      return { method: "POST", path: path("/executes/pause"), body: command.payload ?? {} };
    case "execute.resume":
      return { method: "POST", path: path("/executes/resume"), body: command.payload ?? {} };
    case "execute.stop":
      return { method: "POST", path: path("/executes/stop"), body: command.payload ?? {} };
    case "execute.completeMove":
      return { method: "POST", path: path("/executes/complete-move"), body: command.payload ?? {} };
    case "artifactAction.list":
      return { method: "GET", path: path("/artifact-actions") };
    case "artifactAction.runs":
      return { method: "GET", path: path("/action-runs") };
    case "artifactAction.start": {
      const actionId = stringPayloadField(payload, "actionId");
      if (!actionId) {
        return undefined;
      }
      return { method: "POST", path: path(`/artifact-actions/${encodeURIComponent(actionId)}/runs`), body: command.payload ?? { actionId } };
    }
    case "artifactAction.stop": {
      const runId = stringPayloadField(payload, "runId");
      if (!runId) {
        return undefined;
      }
      return { method: "POST", path: path(`/action-runs/${encodeURIComponent(runId)}/stop`), body: command.payload ?? { runId } };
    }
    case "moveFile.tree": {
      const moveId = stringPayloadField(payload, "moveId");
      if (!moveId) {
        return undefined;
      }
      return { method: "GET", path: path(`/moves/${encodeURIComponent(moveId)}/files/tree`, queryWithOptionalPath(payload)) };
    }
    case "moveFile.blob": {
      const moveId = stringPayloadField(payload, "moveId");
      if (!moveId) {
        return undefined;
      }
      return { method: "GET", path: path(`/moves/${encodeURIComponent(moveId)}/files/blob`, queryWithOptionalPath(payload)) };
    }
    case "moveFile.diff": {
      const moveId = stringPayloadField(payload, "moveId");
      if (!moveId) {
        return undefined;
      }
      return { method: "GET", path: path(`/moves/${encodeURIComponent(moveId)}/files/diff`) };
    }
    case "hunsuDraft.list":
      return { method: "GET", path: path("/hunsu/drafts") };
    case "hunsuDraft.start":
      return { method: "POST", path: path("/hunsu/drafts"), body: command.payload ?? {} };
    case "hunsuDraft.get": {
      const draftSessionId = stringPayloadField(payload, "draftSessionId");
      return draftSessionId ? { method: "GET", path: path(`/hunsu/drafts/${encodeURIComponent(draftSessionId)}`) } : undefined;
    }
    case "hunsuDraft.message": {
      const draftSessionId = stringPayloadField(payload, "draftSessionId");
      return draftSessionId ? { method: "POST", path: path(`/hunsu/drafts/${encodeURIComponent(draftSessionId)}/messages`), body: command.payload ?? {} } : undefined;
    }
    case "hunsuDraft.diffArtifact.create": {
      const draftSessionId = stringPayloadField(payload, "draftSessionId");
      return draftSessionId ? { method: "POST", path: path(`/hunsu/drafts/${encodeURIComponent(draftSessionId)}/diff-artifacts`), body: command.payload ?? {} } : undefined;
    }
    case "hunsuDraft.diffArtifact.get": {
      const draftSessionId = stringPayloadField(payload, "draftSessionId");
      const diffArtifactId = stringPayloadField(payload, "diffArtifactId");
      return draftSessionId && diffArtifactId
        ? { method: "GET", path: path(`/hunsu/drafts/${encodeURIComponent(draftSessionId)}/diff-artifacts/${encodeURIComponent(diffArtifactId)}`) }
        : undefined;
    }
    case "hunsuDraft.approve": {
      const draftSessionId = stringPayloadField(payload, "draftSessionId");
      return draftSessionId ? { method: "POST", path: path(`/hunsu/drafts/${encodeURIComponent(draftSessionId)}/approve`), body: command.payload ?? {} } : undefined;
    }
    case "hunsuDraft.discard": {
      const draftSessionId = stringPayloadField(payload, "draftSessionId");
      return draftSessionId ? { method: "POST", path: path(`/hunsu/drafts/${encodeURIComponent(draftSessionId)}/discard`), body: command.payload ?? {} } : undefined;
    }
    case "line.accept":
      return { method: "POST", path: path("/lines/accept"), body: command.payload ?? {} };
    case "line.reject":
      return { method: "POST", path: path("/lines/reject"), body: command.payload ?? {} };
    case "agentSession.list":
      return { method: "GET", path: path("/agent-sessions") };
    case "agentSession.get": {
      const sessionId = stringPayloadField(payload, "sessionId");
      return sessionId ? { method: "GET", path: path(`/agent-sessions/${encodeURIComponent(sessionId)}`) } : undefined;
    }
    case "agentSession.events": {
      const sessionId = stringPayloadField(payload, "sessionId");
      return { method: "GET", path: sessionId ? path(`/agent-sessions/${encodeURIComponent(sessionId)}/events`) : path("/agent-sessions/events"), stream: true };
    }
  }
}

function relayProjectPathBody(command: RelayCommand): Record<string, unknown> {
  const payload = objectPayload(command.payload);
  const { path: _path, cwd: _cwd, browseToken: _browseToken, ...rest } = payload ?? {};
  return {
    ...rest,
    path: command.projectPath
  };
}

function relayRegistryRemoveBody(command: RelayCommand): Record<string, unknown> {
  const payload = objectPayload(command.payload);
  const roadmapId = stringPayloadField(payload, "roadmapId");
  if (roadmapId) {
    return { roadmapId };
  }
  return { path: command.projectPath };
}

export class LocalDevRelayService {
  private readonly sessions = new Map<string, RelayServiceSession>();
  private readonly devices = new Map<string, RemoteBridgeDevice>();
  private readonly handlers = new Map<string, RelayCommandHandler>();

  registerSession(session: RelayServiceSession): RelayServiceSession {
    this.sessions.set(session.accessToken, session);
    return session;
  }

  registerDevice(accessToken: string, device: Omit<RemoteBridgeDevice, "registeredAt" | "status"> & { status?: RemoteBridgeDevice["status"] }): RemoteBridgeDevice {
    const session = this.requireSession(accessToken);
    if (device.userId !== session.userId) {
      throw new Error("Relay device registration user does not match the authenticated session.");
    }
    const existing = this.devices.get(device.deviceId);
    const registered: RemoteBridgeDevice = {
      ...device,
      registeredAt: existing?.registeredAt ?? new Date().toISOString(),
      lastSeenAt: device.status === "online" ? new Date().toISOString() : existing?.lastSeenAt,
      status: device.status ?? "offline",
      remoteAccess: device.remoteAccess ?? (device.status === "online" ? "enabled" : existing?.remoteAccess ?? "enabled")
    };
    this.devices.set(device.deviceId, registered);
    return registered;
  }

  connectDevice(accessToken: string, deviceId: string, handler: RelayCommandHandler): RemoteBridgeDevice {
    const session = this.requireSession(accessToken);
    const device = this.requireDeviceForSession(deviceId, session);
    this.devices.set(deviceId, { ...device, status: "online", remoteAccess: "enabled", lastSeenAt: new Date().toISOString() });
    this.handlers.set(deviceId, handler);
    return this.devices.get(deviceId)!;
  }

  markDeviceOffline(accessToken: string, deviceId: string): RemoteBridgeDevice {
    const session = this.requireSession(accessToken);
    const device = this.requireDeviceForSession(deviceId, session);
    const next = { ...device, status: "offline" as const };
    this.devices.set(deviceId, next);
    this.handlers.delete(deviceId);
    return next;
  }

  listDevices(accessToken: string): RemoteBridgeDevice[] {
    const session = this.requireSession(accessToken);
    return [...this.devices.values()].filter(device => device.userId === session.userId && device.remoteAccess !== "disabled");
  }

  async routeCommand(accessToken: string, command: RelayCommand): Promise<LocalDevRelayCommandResult> {
    const session = this.requireSession(accessToken);
    const device = this.requireDeviceForSession(command.deviceId, session);
    if (device.status !== "online") {
      return { ok: false, reason: "device_offline", message: "Bridge device is offline." };
    }
    const handler = this.handlers.get(command.deviceId);
    if (!handler) {
      return { ok: false, reason: "device_offline", message: "Bridge device does not have an active Relay connection." };
    }
    return handler({
      type: "command",
      commandId: `relay_command_${Date.now()}`,
      userId: session.userId,
      command
    });
  }

  private requireSession(accessToken: string): RelayServiceSession {
    const session = this.sessions.get(accessToken);
    if (!session) {
      throw new Error("Relay session is not authenticated.");
    }
    return session;
  }

  private requireDeviceForSession(deviceId: string, session: RelayServiceSession): RemoteBridgeDevice {
    const device = this.devices.get(deviceId);
    if (!device || device.userId !== session.userId) {
      throw new Error("Relay device is not registered for this authenticated session.");
    }
    return device;
  }
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
    case "roadmap.registry.list":
      return [];
  }
}

function uniqueRelayScopes(scopes: BridgeCommandScope[]): BridgeCommandScope[] {
  return [...new Set(scopes)];
}

async function readSseStream(body: ReadableStream<Uint8Array>, onEvent: (event: RelayStreamEvent) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    buffer = emitSseBlocks(buffer, onEvent);
  }
  buffer += decoder.decode();
  emitSseBlocks(`${buffer}\n\n`, onEvent);
}

function emitSseBlocks(buffer: string, onEvent: (event: RelayStreamEvent) => void): string {
  let next = buffer.replace(/\r\n/g, "\n");
  let index = next.indexOf("\n\n");
  while (index >= 0) {
    const block = next.slice(0, index);
    next = next.slice(index + 2);
    const event = parseSseBlock(block);
    if (event.data !== undefined) {
      onEvent(event);
    }
    index = next.indexOf("\n\n");
  }
  return next;
}

function parseSseBlock(block: string): RelayStreamEvent {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trimStart();
    } else if (line.startsWith("data:")) {
      data.push(line.slice("data:".length).trimStart());
    }
  }
  return {
    event,
    data: data.length > 0 ? data.join("\n") : undefined
  };
}

function requiresRoadmapProjectValidation(command: RelayCommandName): boolean {
  return command === "execute.start"
    || command === "execute.pause"
    || command === "execute.resume"
    || command === "execute.stop"
    || command === "execute.completeMove"
    || command === "execute.status"
    || command === "roadmap.board"
    || command === "roadmap.worktree"
    || command === "roadmap.skills"
    || command === "roadmap.commands"
    || command === "artifactAction.list"
    || command === "artifactAction.runs"
    || command === "artifactAction.start"
    || command === "artifactAction.stop"
    || command === "moveFile.tree"
    || command === "moveFile.blob"
    || command === "moveFile.diff"
    || command === "hunsuDraft.list"
    || command === "hunsuDraft.start"
    || command === "hunsuDraft.get"
    || command === "hunsuDraft.message"
    || command === "hunsuDraft.diffArtifact.create"
    || command === "hunsuDraft.diffArtifact.get"
    || command === "hunsuDraft.approve"
    || command === "hunsuDraft.discard"
    || command === "line.accept"
    || command === "line.reject"
    || command === "agentSession.list"
    || command === "agentSession.get"
    || command === "agentSession.events"
    || command === "live.events";
}

function requiresProjectPathGrantValidation(command: RelayCommandName): boolean {
  return requiresRoadmapProjectValidation(command)
    || command === "roadmap.registry.remove"
    || command === "roadmap.open"
    || command === "roadmap.port.inspect"
    || command === "roadmap.port.apply"
    || command === "roadmap.create";
}

function relayCommandRoadmapId(command: RelayCommand): string | undefined {
  return stringPayloadField(objectPayload(command.payload), "roadmapId");
}

function isRoadmapRegistryEntry(value: unknown): value is RoadmapRegistryEntry {
  const candidate = objectPayload(value);
  return typeof candidate?.roadmapId === "string" && typeof candidate.repositoryPath === "string";
}

function normalizeLocalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch (_error) {
    return resolve(path);
  }
}

function parseRelayCommandEnvelope(data: unknown): RelayCommandEnvelope | undefined {
  try {
    const parsed = typeof data === "string" ? JSON.parse(data) : data;
    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }
    const candidate = parsed as Partial<RelayCommandEnvelope>;
    if (candidate.type !== "command" || typeof candidate.commandId !== "string" || typeof candidate.userId !== "string") {
      return undefined;
    }
    if (!candidate.command || typeof candidate.command !== "object") {
      return undefined;
    }
    const command = candidate.command as Partial<RelayCommand>;
    return typeof command.deviceId === "string" && typeof command.command === "string" && isRelayCommandName(command.command)
      ? candidate as RelayCommandEnvelope
      : undefined;
  } catch (_error) {
    return undefined;
  }
}

function defaultWebSocketConstructor(): RelayWebSocketConstructor {
  const ctor = (globalThis as unknown as { WebSocket?: RelayWebSocketConstructor }).WebSocket;
  if (!ctor) {
    throw new Error("WebSocket is not available in this runtime.");
  }
  return ctor;
}

function isRemoteBridgeDevice(value: unknown): value is RemoteBridgeDevice {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<RemoteBridgeDevice>;
  return typeof candidate.deviceId === "string"
    && typeof candidate.deviceName === "string"
    && typeof candidate.userId === "string"
    && typeof candidate.registeredAt === "string"
    && (candidate.status === "online" || candidate.status === "offline");
}

function objectPayload(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringPayloadField(payload: Record<string, unknown> | undefined, field: string): string | undefined {
  const value = payload?.[field];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function queryWithOptionalPath(payload: Record<string, unknown> | undefined): URLSearchParams | undefined {
  const path = stringPayloadField(payload, "path");
  if (!path) {
    return undefined;
  }
  const query = new URLSearchParams();
  query.set("path", path);
  return query;
}

function isRelayCommandName(value: string): value is RelayCommandName {
  return [
    "health",
    "bridge.status",
    "connection.status",
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

function relayUrlWithAccessToken(relayUrl: string, accessToken: string | undefined): string {
  if (!accessToken?.trim()) {
    return relayUrl;
  }
  const url = new URL(relayUrl);
  url.searchParams.set("access_token", accessToken.trim());
  return url.toString();
}
