import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { resolve } from "node:path";
import type {
  ConfigStore,
  CredentialStore,
  StoredAccountCredential,
  StoredRelayCredential
} from "../state/index.ts";
import type { Workspace, WorkspaceService } from "../workspaces/workspaceService.ts";
import { BridgeError } from "../client/cliResult.ts";
import {
  isRelayCommandName,
  scopesForRemoteBridgeCommand,
  type BridgeCommandScope,
  type RemoteBridgeCommandRequest,
  type RemoteBridgeCommandResult
} from "../connections/remoteConnection.ts";
import { HUNSU_BRIDGE_VERSION } from "../version.ts";

export type RemoteConnectionState = "disabled" | "signed_out" | "connecting" | "connected" | "offline";

export type RemoteStatus = {
  enabled: boolean;
  signedIn: boolean;
  accountId?: string;
  connection: RemoteConnectionState;
  deviceId?: string;
  grantedWorkspaceIds: string[];
  protocolVersion: "local-bridge-v1";
};

export type SafeDeviceLogin = {
  state: "pending";
  verificationUri: string;
  verificationUriComplete?: string;
  userCode: string;
  expiresAt: string;
  browserOpened: boolean;
};

export type RelaySocket = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "close" | "error" | "message", listener: (event: { data?: unknown }) => void): void;
};

export type RelaySocketFactory = (url: string) => RelaySocket;

type PendingDeviceLogin = {
  deviceCode: string;
  expiresAt: string;
  intervalSeconds: number;
  canceled: boolean;
};

type GrantedWorkspace = {
  workspaceId: string;
  displayName: string;
  repositoryPath: string;
  scopes: BridgeCommandScope[];
};

export type RemoteService = {
  status(): Promise<RemoteStatus>;
  login(input?: { openBrowser?: boolean }): Promise<SafeDeviceLogin>;
  logout(): Promise<void>;
  enable(): Promise<RemoteStatus>;
  disable(): Promise<RemoteStatus>;
  stop(): void;
};

export function createRemoteService(input: {
  configStore: ConfigStore;
  credentialStore: CredentialStore;
  workspaceService: WorkspaceService;
  authBaseUrl?: string;
  relayApiUrl?: string;
  relayWsUrl?: string;
  fetchImpl?: typeof fetch;
  socketFactory?: RelaySocketFactory;
  openBrowser?: (url: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  deviceName?: string;
  now?: () => Date;
  onCommand?: (command: RemoteBridgeCommandRequest) => Promise<RemoteBridgeCommandResult>;
}): RemoteService {
  const fetchImpl = input.fetchImpl ?? fetch;
  const sleep = input.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const now = input.now ?? (() => new Date());
  const authBaseUrl = safeApiBaseUrl(input.authBaseUrl ?? "https://hunsu.app");
  const relayApiUrl = safeApiBaseUrl(input.relayApiUrl ?? "https://relay.hunsu.app");
  const relayWsUrl = safeRelayUrl(input.relayWsUrl ?? "wss://relay.hunsu.app/v1/bridge");
  let pendingLogin: PendingDeviceLogin | undefined;
  let relay: RelayOutboundClient | undefined;
  let connection: RemoteConnectionState = "disabled";
  let serviceStopped = false;
  let mutationQueue = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const task = mutationQueue.then(operation, operation);
    mutationQueue = task.then(() => undefined, () => undefined);
    return task;
  };

  const remoteStatus = async (): Promise<RemoteStatus> => {
    const [config, credentials, workspaces] = await Promise.all([
      input.configStore.read(),
      input.credentialStore.read(),
      input.workspaceService.list()
    ]);
    const granted = workspaces.ok ? workspaces.value.filter(isRemotelyGrantedWorkspace) : [];
    const signedIn = Boolean(credentials?.account && !credentialExpired(credentials.account, now()));
    const enabled = config.remote.enabled;
    return {
      enabled,
      signedIn,
      ...(credentials?.account?.accountId ? { accountId: credentials.account.accountId } : {}),
      connection: !signedIn ? "signed_out" : enabled ? connection : "disabled",
      ...(credentials?.relay?.deviceId ? { deviceId: credentials.relay.deviceId } : {}),
      grantedWorkspaceIds: enabled && signedIn ? granted.map(workspace => workspace.workspaceId) : [],
      protocolVersion: "local-bridge-v1"
    };
  };

  return {
    status: remoteStatus,
    async login(loginInput = {}) {
      return serialize(async () => {
      pendingLogin && (pendingLogin.canceled = true);
      const credentials = await input.credentialStore.ensure();
      const deviceId = credentials.relay?.deviceId ?? `device_${randomBytes(16).toString("base64url")}`;
      const endpoint = new URL("/oauth/device/code", authBaseUrl);
      const requestBody = new URLSearchParams({
        client_id: "hunsu-bridge",
        scope: "bridge remote",
        device_id: deviceId,
        device_name: input.deviceName ?? hostname()
      });
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: requestBody
      });
      if (!response.ok) {
        throw new BridgeError("REMOTE_CONNECTION_FAILED", `Hunsu login could not start (HTTP ${response.status}).`);
      }
      const value = await response.json() as Record<string, unknown>;
      const deviceCode = requiredString(value.device_code, "device_code");
      const userCode = requiredString(value.user_code, "user_code");
      const verificationUri = safePublicUrl(requiredString(value.verification_uri, "verification_uri"));
      const verificationUriComplete = optionalString(value.verification_uri_complete);
      const expiresIn = finitePositive(value.expires_in, 900);
      const intervalSeconds = finitePositive(value.interval, 5);
      pendingLogin = {
        deviceCode,
        expiresAt: new Date(now().getTime() + expiresIn * 1_000).toISOString(),
        intervalSeconds,
        canceled: false
      };
      const activeLogin = pendingLogin;
      let browserOpened = false;
      const browserUrl = verificationUriComplete ? safePublicUrl(verificationUriComplete) : verificationUri;
      if (loginInput.openBrowser !== false && input.openBrowser) {
        try {
          await input.openBrowser(browserUrl);
          browserOpened = true;
        } catch (_error) {
          browserOpened = false;
        }
      }
      void pollDeviceLogin({
        pending: activeLogin,
        authBaseUrl,
        deviceId,
        commitAccount: async account => serialize(async () => {
          if (!activeLogin.canceled && !serviceStopped) await input.credentialStore.write({ account });
        }),
        fetchImpl,
        sleep,
        now
      }).catch(() => undefined);
      return {
        state: "pending",
        verificationUri,
        ...(verificationUriComplete ? { verificationUriComplete: safePublicUrl(verificationUriComplete) } : {}),
        userCode,
        expiresAt: activeLogin.expiresAt,
        browserOpened
      };
      });
    },
    async logout() {
      return serialize(async () => {
      if (pendingLogin) pendingLogin.canceled = true;
      pendingLogin = undefined;
      relay?.stop();
      relay = undefined;
      connection = "disabled";
      await input.configStore.update(config => ({ ...config, remote: { enabled: false } }));
      await input.credentialStore.write({ account: null, relay: null });
      });
    },
    async enable() {
      return serialize(async () => {
      const credentials = await input.credentialStore.read();
      if (!credentials?.account || credentialExpired(credentials.account, now())) {
        throw new BridgeError("ACCOUNT_LOGIN_REQUIRED", "Sign in to Hunsu before enabling Remote Bridge.");
      }
      const workspaces = await input.workspaceService.list();
      if (!workspaces.ok) {
        throw new BridgeError("REMOTE_ENABLE_FAILED", workspaces.error.message);
      }
      const granted = workspaces.value.filter(isRemotelyGrantedWorkspace);
      connection = "connecting";
      try {
        const registration = await registerRelayDevice({
          relayApiUrl,
          account: credentials.account,
          existingRelay: credentials.relay,
          workspaces: granted.map(workspace => ({
            workspaceId: workspace.workspaceId,
            displayName: workspace.displayName,
            repositoryPath: workspace.repositoryPath,
            scopes: workspace.remoteAccess.scopes
          })),
          deviceName: input.deviceName ?? hostname(),
          fetchImpl
        });
        if (serviceStopped) throw new BridgeError("REMOTE_ENABLE_FAILED", "Remote Bridge stopped while enabling.");
        await input.credentialStore.write({ relay: registration.credential });
        await input.configStore.update(config => ({ ...config, remote: { enabled: true } }));
        relay?.stop();
        relay = new RelayOutboundClient({
          url: registration.wsUrl ?? relayWsUrl,
          credential: registration.credential,
          socketFactory: input.socketFactory,
          onState: state => { connection = state; },
          onCommand: input.onCommand
            ? async command => {
                const current = await input.credentialStore.read();
                if (!current?.account || credentialExpired(current.account, now())) {
                  return { ok: false, status: 401, error: "Remote command requires an active Hunsu sign-in." };
                }
                return input.onCommand!(command);
              }
            : undefined,
          accountId: credentials.account.accountId,
          deviceName: input.deviceName ?? hostname(),
          workspaces: granted.map(workspace => ({
            workspaceId: workspace.workspaceId,
            displayName: workspace.displayName,
            repositoryPath: workspace.repositoryPath,
            scopes: workspace.remoteAccess.scopes
          }))
        });
        relay.start();
      } catch (error) {
        connection = "offline";
        await input.configStore.update(config => ({ ...config, remote: { enabled: false } }));
        throw error instanceof BridgeError
          ? error
          : new BridgeError("REMOTE_ENABLE_FAILED", "Remote Bridge could not be enabled.", { cause: error });
      }
      return remoteStatus();
      });
    },
    async disable() {
      return serialize(async () => {
      relay?.stop();
      relay = undefined;
      connection = "disabled";
      await input.configStore.update(config => ({ ...config, remote: { enabled: false } }));
      return remoteStatus();
      });
    },
    stop() {
      serviceStopped = true;
      if (pendingLogin) pendingLogin.canceled = true;
      relay?.stop();
      relay = undefined;
    }
  };
}

class RelayOutboundClient {
  private readonly input: {
    url: string;
    credential: StoredRelayCredential;
    socketFactory?: RelaySocketFactory;
    onState: (state: RemoteConnectionState) => void;
    onCommand?: (command: RemoteBridgeCommandRequest) => Promise<RemoteBridgeCommandResult>;
    accountId: string;
    deviceName: string;
    workspaces: GrantedWorkspace[];
  };
  private socket?: RelaySocket;
  private stopped = true;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempt = 0;

  constructor(input: {
    url: string;
    credential: StoredRelayCredential;
    socketFactory?: RelaySocketFactory;
    onState: (state: RemoteConnectionState) => void;
    onCommand?: (command: RemoteBridgeCommandRequest) => Promise<RemoteBridgeCommandResult>;
    accountId: string;
    deviceName: string;
    workspaces: GrantedWorkspace[];
  }) {
    this.input = input;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.socket?.close(1000, "Remote Bridge disabled");
    this.socket = undefined;
  }

  private connect(): void {
    if (this.stopped) return;
    if (!this.input.socketFactory) {
      this.input.onState("offline");
      return;
    }
    this.input.onState("connecting");
    const socket = this.input.socketFactory(this.input.url);
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.reconnectAttempt = 0;
      socket.send(JSON.stringify({
        type: "authenticate",
        protocolVersion: "local-bridge-v1",
        deviceId: this.input.credential.deviceId,
        token: this.input.credential.token
      }));
      socket.send(JSON.stringify({
        type: "device.register",
        device: relayDeviceSnapshot({
          deviceId: this.input.credential.deviceId,
          accountId: this.input.accountId,
          deviceName: this.input.deviceName,
          workspaces: this.input.workspaces
        }),
        workspaces: safeWorkspaceSnapshots(this.input.workspaces),
        projectGrants: projectGrants(this.input.workspaces)
      }));
      this.input.onState("connected");
    });
    socket.addEventListener("message", event => {
      void this.handleMessage(socket, event.data);
    });
    socket.addEventListener("close", () => this.reconnect(socket));
    socket.addEventListener("error", () => this.reconnect(socket));
  }

  private reconnect(socket: RelaySocket): void {
    if (this.stopped || this.reconnectTimer || this.socket !== socket) return;
    this.socket = undefined;
    this.input.onState("offline");
    const delay = Math.min(30_000, 250 * (2 ** this.reconnectAttempt));
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private async handleMessage(socket: RelaySocket, raw: unknown): Promise<void> {
    if (typeof raw !== "string" || !this.input.onCommand) return;
    let value: { type?: unknown; commandId?: unknown; command?: unknown };
    try {
      value = JSON.parse(raw) as { type?: unknown; commandId?: unknown; command?: unknown };
    } catch (_error) {
      return;
    }
    if (value.type !== "command" || typeof value.commandId !== "string") return;
    const command = parseRemoteCommand(value.command);
    if (!command || command.deviceId !== this.input.credential.deviceId) {
      socket.send(JSON.stringify({
        type: "command.result",
        commandId: value.commandId,
        result: { ok: false, status: 400, error: "Remote command payload is invalid." }
      }));
      return;
    }
    const grantFailure = validateCommandGrant(command, this.input.workspaces);
    if (grantFailure) {
      socket.send(JSON.stringify({ type: "command.result", commandId: value.commandId, result: grantFailure }));
      return;
    }
    try {
      const result = await this.input.onCommand(command);
      socket.send(JSON.stringify({ type: "command.result", commandId: value.commandId, result }));
    } catch (_error) {
      socket.send(JSON.stringify({
        type: "command.result",
        commandId: value.commandId,
        result: { ok: false, status: 500, error: "Remote command failed." }
      }));
    }
  }
}

async function pollDeviceLogin(input: {
  pending: PendingDeviceLogin;
  authBaseUrl: string;
  deviceId: string;
  commitAccount: (account: StoredAccountCredential) => Promise<void>;
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
}): Promise<void> {
  let intervalMs = Math.max(1, input.pending.intervalSeconds) * 1_000;
  while (!input.pending.canceled && input.now().getTime() < Date.parse(input.pending.expiresAt)) {
    const response = await input.fetchImpl(new URL("/oauth/token", input.authBaseUrl), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: "hunsu-bridge",
        device_code: input.pending.deviceCode,
        device_id: input.deviceId
      })
    });
    const value = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (input.pending.canceled) return;
    if (response.ok) {
      const accessToken = requiredString(value.access_token, "access_token");
      const account: StoredAccountCredential = {
        accountId: optionalString(value.user_id) ?? optionalString(value.account_id) ?? "hunsu-account",
        accessToken,
        refreshToken: optionalString(value.refresh_token) ?? null,
        expiresAt: typeof value.expires_in === "number"
          ? new Date(input.now().getTime() + value.expires_in * 1_000).toISOString()
          : null
      };
      await input.commitAccount(account);
      return;
    }
    const code = optionalString(value.error);
    if (code === "authorization_pending") {
      await input.sleep(intervalMs);
      continue;
    }
    if (code === "slow_down") {
      intervalMs += 5_000;
      await input.sleep(intervalMs);
      continue;
    }
    return;
  }
}

async function registerRelayDevice(input: {
  relayApiUrl: string;
  account: StoredAccountCredential;
  existingRelay: StoredRelayCredential | null;
  workspaces: GrantedWorkspace[];
  deviceName: string;
  fetchImpl: typeof fetch;
}): Promise<{ credential: StoredRelayCredential; wsUrl?: string }> {
  const deviceId = input.existingRelay?.deviceId ?? `device_${randomBytes(16).toString("base64url")}`;
  const device = relayDeviceSnapshot({
    deviceId,
    accountId: input.account.accountId,
    deviceName: input.deviceName,
    workspaces: input.workspaces
  });
  const response = await input.fetchImpl(new URL("/v1/devices", input.relayApiUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.account.accessToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      device,
      workspaces: safeWorkspaceSnapshots(input.workspaces),
      projectGrants: projectGrants(input.workspaces),
      lastSnapshotAt: new Date().toISOString()
    })
  });
  if (!response.ok) {
    throw new BridgeError("REMOTE_ENABLE_FAILED", `Relay device registration failed (HTTP ${response.status}).`);
  }
  const value = await response.json() as Record<string, unknown>;
  const registeredDevice = isRecord(value.device) ? value.device : undefined;
  if (!registeredDevice || registeredDevice.deviceId !== deviceId) {
    throw new BridgeError("REMOTE_ENABLE_FAILED", "Relay device registration returned an invalid device identity.");
  }
  return {
    credential: {
      deviceId,
      token: input.account.accessToken
    }
  };
}

function credentialExpired(credential: StoredAccountCredential, now: Date): boolean {
  if (credential.expiresAt === null) return false;
  const expiresAt = Date.parse(credential.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= now.getTime();
}

function safeApiBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHostname(url.hostname))) {
    throw new BridgeError("REMOTE_CONNECTION_FAILED", "Remote service URLs must use HTTPS, except for loopback development fixtures.");
  }
  if (url.username || url.password) {
    throw new BridgeError("REMOTE_CONNECTION_FAILED", "Remote service URLs must not contain credentials.");
  }
  return url.toString();
}

function safePublicUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHostname(url.hostname))) {
    throw new BridgeError("REMOTE_CONNECTION_FAILED", "Hunsu login returned an unsafe verification URL.");
  }
  return url.toString();
}

function safeRelayUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && isLoopbackHostname(url.hostname))) {
    throw new BridgeError("REMOTE_CONNECTION_FAILED", "Relay returned an unsafe WebSocket URL.");
  }
  if (url.username || url.password || url.search) {
    throw new BridgeError("REMOTE_CONNECTION_FAILED", "Relay WebSocket URLs must not contain credentials.");
  }
  return url.toString();
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

function requiredString(value: unknown, field: string): string {
  const parsed = optionalString(value);
  if (!parsed) throw new BridgeError("REMOTE_CONNECTION_FAILED", `Remote response is missing ${field}.`);
  return parsed;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finitePositive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function isRemotelyGrantedWorkspace(workspace: Workspace): boolean {
  return workspace.lifecycle === "active"
    && workspace.remoteAccess.enabled
    && workspace.remoteAccess.scopes.includes("remoteRelay.access");
}

function relayDeviceSnapshot(input: {
  deviceId: string;
  accountId: string;
  deviceName: string;
  workspaces: GrantedWorkspace[];
}): Record<string, unknown> {
  const timestamp = new Date().toISOString();
  return {
    deviceId: input.deviceId,
    deviceName: input.deviceName,
    userId: input.accountId,
    registeredAt: timestamp,
    status: "online",
    remoteAccess: "enabled",
    bridgeVersion: HUNSU_BRIDGE_VERSION,
    protocolVersion: "local-bridge-v1",
    workspaces: safeWorkspaceSnapshots(input.workspaces),
    projectGrants: projectGrants(input.workspaces),
    lastSnapshotAt: timestamp
  };
}

function safeWorkspaceSnapshots(workspaces: GrantedWorkspace[]): Array<Record<string, unknown>> {
  return workspaces.map(workspace => ({
    workspaceId: workspace.workspaceId,
    roadmapId: workspace.workspaceId,
    displayName: workspace.displayName,
    pathRedacted: true,
    lifecycle: "active",
    health: "ok",
    backendId: "local",
    connectionMode: "local",
    provider: { providerId: "codex", label: "Codex", readyForExecute: false },
    actions: ["open_studio", "deactivate"]
  }));
}

function projectGrants(workspaces: GrantedWorkspace[]): Array<Record<string, unknown>> {
  const grantedAt = new Date().toISOString();
  return workspaces.map(workspace => ({
    path: workspace.repositoryPath,
    grantedAt,
    scopes: workspace.scopes,
    active: true
  }));
}

function parseRemoteCommand(value: unknown): RemoteBridgeCommandRequest | undefined {
  if (!isRecord(value)
    || typeof value.deviceId !== "string"
    || !value.deviceId.trim()
    || typeof value.command !== "string"
    || !isRelayCommandName(value.command)) {
    return undefined;
  }
  const requestedScopes = value.requestedScopes === undefined
    ? undefined
    : Array.isArray(value.requestedScopes) && value.requestedScopes.every(isBridgeCommandScope)
      ? [...new Set(value.requestedScopes)]
      : undefined;
  if (value.requestedScopes !== undefined && requestedScopes === undefined) return undefined;
  return {
    deviceId: value.deviceId.trim(),
    command: value.command,
    ...(typeof value.projectPath === "string" && value.projectPath.trim() ? { projectPath: value.projectPath.trim() } : {}),
    ...(requestedScopes ? { requestedScopes } : {}),
    ...(Object.prototype.hasOwnProperty.call(value, "payload") ? { payload: value.payload } : {})
  };
}

function validateCommandGrant(
  command: RemoteBridgeCommandRequest,
  workspaces: GrantedWorkspace[]
): RemoteBridgeCommandResult | undefined {
  const requiredScopes = [...new Set([
    ...scopesForRemoteBridgeCommand(command.command),
    ...(command.requestedScopes ?? [])
  ])];
  if (requiredScopes.length === 0 && !command.projectPath) return undefined;
  if (!command.projectPath) {
    return { ok: false, status: 403, error: "Remote command requires an explicit Workspace grant." };
  }
  const normalizedPath = comparableLocalPath(command.projectPath);
  const workspace = workspaces.find(candidate => comparableLocalPath(candidate.repositoryPath) === normalizedPath);
  if (!workspace) {
    return { ok: false, status: 403, error: "Remote command Workspace is not granted." };
  }
  const missing = requiredScopes.find(scope => !workspace.scopes.includes(scope));
  return missing
    ? { ok: false, status: 403, error: "Remote command scope is not granted." }
    : undefined;
}

function isBridgeCommandScope(value: unknown): value is BridgeCommandScope {
  return value === "remoteRelay.access"
    || value === "execute.start"
    || value === "artifactAction.run"
    || value === "env.read"
    || value === "hostAlias.expose";
}

function comparableLocalPath(value: string): string {
  const normalized = resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
