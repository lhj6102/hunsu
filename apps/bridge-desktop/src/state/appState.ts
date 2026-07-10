import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir, hostname, platform } from "node:os";
import { dirname, join } from "node:path";
import { currentProcessEnv } from "@hunsu/config";
import type {
  BridgePairingSession,
  RoadmapRegistryEntry,
  RuntimeProviderConfigField,
  RuntimeProviderMetadata,
  RuntimeProviderStatus,
  ModelAlias,
  ModelAliasOverride
} from "@hunsu/bridge";
import type { BridgeCommandScope, ProjectGrant } from "../relay.ts";

export const DEFAULT_APP_STATE_PATH = join(homedir(), ".config", "hunsu", "bridge-app.json");

export type BridgeProcessCommandIdentity = {
  kind: "start" | "supervise" | "daemon" | "remote-attach";
  executable: string;
  argv: string[];
  nonce: string;
};

export type BridgeProcessStartMetadata = {
  platform: NodeJS.Platform;
  source: "proc-stat" | "ps-lstart";
  value: string;
};

export type BridgeProcessRuntimeMetadata = {
  pid: number;
  processNonce?: string;
  commandIdentity: BridgeProcessCommandIdentity;
  startMetadata?: BridgeProcessStartMetadata;
  recordedAt: string;
};

export type CodexLoginProcessState = {
  kind: "chatgpt" | "device";
  pid?: number;
  startedAt: string;
  status: "starting" | "device_code" | "pending" | "completed" | "failed";
  verificationUri?: string;
  verificationUriComplete?: string;
  userCode?: string;
  lastOutput?: string;
  error?: string;
};

export type BridgeUiIntent = {
  id: string;
  tab: "provider" | "workspaces" | "connection" | "advanced" | "diagnostics" | "settings";
  focus?: "codex" | "remote";
  action?: "add-workspace";
  createdAt: string;
};

export type BridgeAccountState =
  | { status: "signed-out" }
  | { status: "signed-in"; userId: string; email?: string };

export type BridgeDeviceState = {
  name: string;
  id: string;
  registered: boolean;
};

export type BridgePendingAuthState = {
  state: string;
  codeVerifier: string;
  redirectUri: string;
  authBaseUrl: string;
  startedAt: string;
};

export type BridgeServiceState = {
  installed: boolean;
  manager: "systemd-user" | "launchd-user" | "windows-startup-user" | "manual";
  unitPath?: string;
  updatedAt?: string;
};

export type BridgeQuitBehavior = "keep-background" | "stop-background";

export type BridgeCodexSettings = {
  binaryPath?: string;
  codexHome?: string;
  appServerCommand?: string;
  appServerArgs?: string;
  installChannel?: "stable" | "latest" | "manual";
  authenticationPreference?: "chatgpt" | "api_key" | "device_code";
};

export type BridgeRuntimeProviderState = {
  currentProviderId: string;
  providers: Record<string, {
    enabled: boolean;
    settings: Record<string, unknown>;
  }>;
};

export type BridgeToolStatus = {
  installed: boolean;
  binaryPath?: string;
  version?: string;
  error?: string;
};

export type BridgeAppState = {
  schema: "hunsu.bridge-app-state.v1";
  supervisorPid?: number;
  pid?: number;
  supervisorProcess?: BridgeProcessRuntimeMetadata;
  bridgeProcess?: BridgeProcessRuntimeMetadata;
  bridgeApiUrl?: string;
  processNonce?: string;
  commandIdentity?: BridgeProcessCommandIdentity;
  authToken?: string;
  controlToken?: string;
  pairing?: BridgePairingSession;
  cwd?: string;
  webUrl?: string;
  startedAt?: string;
  account?: BridgeAccountState;
  pendingAuth?: BridgePendingAuthState;
  codex?: BridgeCodexSettings;
  codexLogin?: CodexLoginProcessState;
  runtimeProviders: BridgeRuntimeProviderState;
  device: BridgeDeviceState;
  remoteAccess: "off" | "on" | "registered-offline" | "unavailable";
  projectGrants: ProjectGrant[];
  modelAliases: ModelAlias[];
  modelAliasOverrides: ModelAliasOverride[];
  uiIntent?: BridgeUiIntent;
  service: BridgeServiceState;
  quitBehavior: BridgeQuitBehavior;
};

export type BridgeRoadmapAccessSnapshot = Omit<RoadmapRegistryEntry, "codex" | "remoteAccess"> & {
  provider: {
    providerId: string;
    label: string;
    readyForExecute: boolean;
  };
  codex: {
    readyForExecute: boolean;
  };
  projectGrant?: ProjectGrant;
  remoteAccess: {
    available: boolean;
    enabled: boolean;
    reason?: string;
    scopes: BridgeCommandScope[];
    scopeState: Record<BridgeCommandScope, boolean>;
  };
};

export type BridgeAppSnapshot = {
  schema: "hunsu.bridge-app-snapshot.v1";
  status: {
    localBridge: "connected" | "not-running" | "starting" | "error";
    account: string;
    remoteAccess: "Off" | "On" | "Registered but offline" | "Unavailable";
    device: BridgeDeviceState;
    service: BridgeServiceState;
    quitBehavior: BridgeQuitBehavior;
    supervisorPid?: number;
    pid?: number;
    bridgeApiUrl?: string;
    startedAt?: string;
    healthError?: string;
  };
  providers: {
    currentProviderId: string;
    current: RuntimeProviderStatus;
    providers: RuntimeProviderStatus[];
  };
  providerConfig: {
    providerId: string;
    metadata: RuntimeProviderMetadata;
    fields: RuntimeProviderConfigField[];
  };
  workspaces: {
    active: BridgeRoadmapAccessSnapshot[];
    inactive: BridgeRoadmapAccessSnapshot[];
    managed: BridgeRoadmapAccessSnapshot[];
  };
  connections: {
    local: {
      label: string;
      state: "connected" | "not-running" | "starting" | "error";
    };
    remote: {
      label: string;
      state: "signed-out" | "off" | "on" | "registered-offline" | "unavailable";
      device: BridgeDeviceState;
    };
  };
  projectGrants: ProjectGrant[];
  activeProjectGrants: ProjectGrant[];
  recentProjects: RoadmapRegistryEntry[];
  managedRoadmaps: BridgeRoadmapAccessSnapshot[];
  prerequisites: {
    codex: unknown;
    tools: {
      git: BridgeToolStatus;
      node: BridgeToolStatus;
      packageManager: BridgeToolStatus;
    };
  };
  codexSettings: BridgeCodexSettings & {
    environment: {
      HUNSU_CODEX_BINARY_PATH?: string | null;
      CODEX_HOME?: string | null;
      HUNSU_CODEX_APP_SERVER_COMMAND?: string | null;
      HUNSU_CODEX_APP_SERVER_ARGS?: string | null;
    };
  };
  codexLogin?: CodexLoginProcessState;
  runtimeProviders: {
    currentProviderId: string;
    providers: RuntimeProviderStatus[];
  };
  diagnostics: unknown;
  logLines: string[];
  uiIntent?: BridgeUiIntent;
};

export function defaultBridgeAppState(): BridgeAppState {
  return {
    schema: "hunsu.bridge-app-state.v1",
    account: { status: "signed-out" },
    codex: defaultBridgeCodexSettings(),
    runtimeProviders: defaultBridgeRuntimeProviderState(),
    device: defaultBridgeDeviceState(),
    remoteAccess: "off",
    projectGrants: [],
    modelAliases: [],
    modelAliasOverrides: [],
    service: defaultBridgeServiceState(),
    quitBehavior: "keep-background"
  };
}

export function bridgeAppStatePath(env: Record<string, string | undefined> = currentProcessEnv()): string {
  return env.HUNSU_BRIDGE_APP_STATE_PATH?.trim() || DEFAULT_APP_STATE_PATH;
}

export function readBridgeAppState(path = bridgeAppStatePath()): BridgeAppState {
  if (!existsSync(path)) {
    return defaultBridgeAppState();
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<BridgeAppState>;
    return normalizeBridgeAppState(parsed);
  } catch (_error) {
    return defaultBridgeAppState();
  }
}

export function writeBridgeAppState(state: BridgeAppState, path = bridgeAppStatePath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function recordBridgeUiIntent(
  intent: Omit<BridgeUiIntent, "id" | "createdAt">,
  options: {
    readState?: () => BridgeAppState;
    writeState?: (state: BridgeAppState) => void;
    createId?: () => string;
    now?: () => Date;
  } = {}
): BridgeUiIntent {
  const readState = options.readState ?? readBridgeAppState;
  const writeState = options.writeState ?? writeBridgeAppState;
  const state = readState();
  const uiIntent: BridgeUiIntent = {
    ...intent,
    id: options.createId?.() ?? `intent_${randomBytes(12).toString("base64url")}`,
    createdAt: (options.now?.() ?? new Date()).toISOString()
  };
  writeState({ ...state, uiIntent });
  return uiIntent;
}

export function createBridgeAppSnapshot(input: {
  state: BridgeAppState;
  localBridge: BridgeAppSnapshot["status"]["localBridge"];
  accountLabel: string;
  remoteAccessLabel: BridgeAppSnapshot["status"]["remoteAccess"];
  bridgeApiUrl?: string;
  healthError?: string;
  runtimeProviders: BridgeAppSnapshot["providers"] & BridgeAppSnapshot["runtimeProviders"];
  providerConfig: BridgeAppSnapshot["providerConfig"];
  managedRoadmaps: BridgeRoadmapAccessSnapshot[];
  projectGrants: ProjectGrant[];
  activeProjectGrants: ProjectGrant[];
  recentProjects: RoadmapRegistryEntry[];
  codex: unknown;
  tools: BridgeAppSnapshot["prerequisites"]["tools"];
  codexSettings: BridgeAppSnapshot["codexSettings"];
  diagnostics: unknown;
  logLines: string[];
}): BridgeAppSnapshot {
  return {
    schema: "hunsu.bridge-app-snapshot.v1",
    status: {
      localBridge: input.localBridge,
      account: input.accountLabel,
      remoteAccess: input.remoteAccessLabel,
      device: input.state.device,
      service: input.state.service,
      quitBehavior: input.state.quitBehavior,
      supervisorPid: input.state.supervisorPid,
      pid: input.state.pid,
      bridgeApiUrl: input.bridgeApiUrl,
      startedAt: input.state.startedAt,
      healthError: input.healthError
    },
    providers: input.runtimeProviders,
    providerConfig: input.providerConfig,
    workspaces: {
      active: input.managedRoadmaps.filter(roadmap => roadmap.lifecycle === "active"),
      inactive: input.managedRoadmaps.filter(roadmap => roadmap.lifecycle !== "active"),
      managed: input.managedRoadmaps
    },
    connections: {
      local: {
        label: "This computer",
        state: input.localBridge
      },
      remote: {
        label: input.state.device.name,
        state: input.state.account?.status === "signed-in" ? input.state.remoteAccess : "signed-out",
        device: input.state.device
      }
    },
    projectGrants: input.projectGrants,
    activeProjectGrants: input.activeProjectGrants,
    recentProjects: input.recentProjects,
    managedRoadmaps: input.managedRoadmaps,
    prerequisites: {
      codex: input.codex,
      tools: input.tools
    },
    codexSettings: input.codexSettings,
    codexLogin: input.state.codexLogin,
    runtimeProviders: input.runtimeProviders,
    diagnostics: input.diagnostics,
    logLines: input.logLines,
    uiIntent: input.state.uiIntent
  };
}

export function normalizeBridgeAppState(parsed: Partial<BridgeAppState>): BridgeAppState {
  const runtimeProviders = normalizeBridgeRuntimeProviderState(parsed.runtimeProviders);
  const legacyCodex = parsed.codex as (BridgeCodexSettings & { environment?: unknown }) | undefined;
  const legacyBinaryPath = typeof legacyCodex?.binaryPath === "string" && legacyCodex.binaryPath.trim()
    ? legacyCodex.binaryPath.trim()
    : undefined;
  const legacyEnvironment = typeof legacyCodex?.environment === "object" && legacyCodex.environment !== null && !Array.isArray(legacyCodex.environment)
    ? legacyCodex.environment as Record<string, unknown>
    : undefined;
  const currentSettings = codexSettingsFromRecord(runtimeProviders.providers.codex?.settings ?? {});
  const migratedRuntimeProviders = withBridgeCodexProviderSettings({
    ...defaultBridgeAppState(),
    runtimeProviders
  }, {
    ...(legacyBinaryPath && !currentSettings.binaryPath ? { binaryPath: legacyBinaryPath } : {}),
    ...legacyCodexEnvironmentSettings(legacyEnvironment, currentSettings),
    ...(legacyCodex?.installChannel === "stable" || legacyCodex?.installChannel === "latest" || legacyCodex?.installChannel === "manual"
      ? { installChannel: legacyCodex.installChannel }
      : {}),
    ...(legacyCodex?.authenticationPreference === "chatgpt" || legacyCodex?.authenticationPreference === "api_key" || legacyCodex?.authenticationPreference === "device_code"
      ? { authenticationPreference: legacyCodex.authenticationPreference }
      : {})
  }).runtimeProviders;
  return {
    ...defaultBridgeAppState(),
    ...parsed,
    account: parsed.account ?? { status: "signed-out" },
    codex: stripLegacyCodexSettings(parsed.codex ?? defaultBridgeCodexSettings()),
    runtimeProviders: migratedRuntimeProviders,
    device: parsed.device ?? defaultBridgeDeviceState(),
    remoteAccess: parseBridgeRemoteAccessState(parsed.remoteAccess),
    projectGrants: Array.isArray(parsed.projectGrants) ? parsed.projectGrants : [],
    modelAliases: Array.isArray(parsed.modelAliases) ? parsed.modelAliases : [],
    modelAliasOverrides: Array.isArray(parsed.modelAliasOverrides) ? parsed.modelAliasOverrides : [],
    service: parsed.service ?? defaultBridgeServiceState(),
    quitBehavior: parseBridgeQuitBehavior(parsed.quitBehavior)
  };
}

export function defaultBridgeCodexSettings(): BridgeCodexSettings {
  return {
    installChannel: "stable",
    authenticationPreference: "chatgpt"
  };
}

export function bridgeCodexProviderSettings(state: BridgeAppState): BridgeCodexSettings {
  const providerSettings = state.runtimeProviders.providers.codex?.settings ?? {};
  return {
    ...defaultBridgeCodexSettings(),
    ...state.codex,
    ...codexSettingsFromRecord(providerSettings)
  };
}

export function withBridgeCodexProviderSettings(state: BridgeAppState, patch: Partial<BridgeCodexSettings>): BridgeAppState {
  const currentSettings = state.runtimeProviders.providers.codex?.settings ?? {};
  const nextSettings: Record<string, unknown> = { ...currentSettings };
  if ("binaryPath" in patch) {
    setOptionalStringSetting(nextSettings, "binaryPath", patch.binaryPath);
  }
  if ("codexHome" in patch) {
    setOptionalStringSetting(nextSettings, "codexHome", patch.codexHome);
  }
  if ("appServerCommand" in patch) {
    setOptionalStringSetting(nextSettings, "appServerCommand", patch.appServerCommand);
  }
  if ("appServerArgs" in patch) {
    setOptionalStringSetting(nextSettings, "appServerArgs", patch.appServerArgs);
  }
  if ("installChannel" in patch) {
    setOptionalStringSetting(nextSettings, "installChannel", patch.installChannel);
  }
  if ("authenticationPreference" in patch) {
    setOptionalStringSetting(nextSettings, "authenticationPreference", patch.authenticationPreference);
  }
  const legacyCodex = { ...(state.codex ?? defaultBridgeCodexSettings()) };
  delete legacyCodex.binaryPath;
  delete legacyCodex.codexHome;
  delete legacyCodex.appServerCommand;
  delete legacyCodex.appServerArgs;
  delete (legacyCodex as BridgeCodexSettings & { environment?: unknown }).environment;
  delete legacyCodex.installChannel;
  delete legacyCodex.authenticationPreference;
  return {
    ...state,
    codex: legacyCodex,
    runtimeProviders: normalizeBridgeRuntimeProviderState({
      ...state.runtimeProviders,
      providers: {
        ...state.runtimeProviders.providers,
        codex: {
          enabled: true,
          settings: nextSettings
        }
      }
    })
  };
}

export function defaultBridgeRuntimeProviderState(): BridgeRuntimeProviderState {
  return {
    currentProviderId: "codex",
    providers: {
      codex: {
        enabled: true,
        settings: {}
      }
    }
  };
}

export function normalizeBridgeRuntimeProviderState(value: unknown): BridgeRuntimeProviderState {
  const defaults = defaultBridgeRuntimeProviderState();
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return defaults;
  }
  const object = value as Partial<BridgeRuntimeProviderState>;
  const providers = typeof object.providers === "object" && object.providers !== null && !Array.isArray(object.providers)
    ? Object.fromEntries(Object.entries(object.providers).map(([providerId, provider]) => {
        const providerObject = typeof provider === "object" && provider !== null && !Array.isArray(provider)
          ? provider as { enabled?: unknown; settings?: unknown }
          : {};
        const settings = typeof providerObject.settings === "object" && providerObject.settings !== null && !Array.isArray(providerObject.settings)
          ? providerObject.settings as Record<string, unknown>
          : {};
        return [providerId, {
          enabled: providerObject.enabled === false ? false : providerId === "codex",
          settings
        }];
      }))
    : {};
  providers.codex = {
    enabled: true,
    settings: typeof providers.codex?.settings === "object" ? providers.codex.settings : {}
  };
  return {
    currentProviderId: typeof object.currentProviderId === "string" && object.currentProviderId.trim()
      ? object.currentProviderId.trim()
      : defaults.currentProviderId,
    providers
  };
}

function codexSettingsFromRecord(record: Record<string, unknown>): Partial<BridgeCodexSettings> {
  const binaryPath = typeof record.binaryPath === "string" && record.binaryPath.trim() ? record.binaryPath.trim() : undefined;
  const codexHome = typeof record.codexHome === "string" && record.codexHome.trim() ? record.codexHome.trim() : undefined;
  const appServerCommand = typeof record.appServerCommand === "string" && record.appServerCommand.trim() ? record.appServerCommand.trim() : undefined;
  const appServerArgs = typeof record.appServerArgs === "string" && record.appServerArgs.trim() ? record.appServerArgs.trim() : undefined;
  const installChannel = record.installChannel === "stable" || record.installChannel === "latest" || record.installChannel === "manual"
    ? record.installChannel
    : undefined;
  const authenticationPreference = record.authenticationPreference === "chatgpt" || record.authenticationPreference === "api_key" || record.authenticationPreference === "device_code"
    ? record.authenticationPreference
    : undefined;
  return {
    ...(binaryPath ? { binaryPath } : {}),
    ...(codexHome ? { codexHome } : {}),
    ...(appServerCommand ? { appServerCommand } : {}),
    ...(appServerArgs ? { appServerArgs } : {}),
    ...(installChannel ? { installChannel } : {}),
    ...(authenticationPreference ? { authenticationPreference } : {})
  };
}

function legacyCodexEnvironmentSettings(
  environment: Record<string, unknown> | undefined,
  current: Partial<BridgeCodexSettings>
): Partial<BridgeCodexSettings> {
  const codexHome = typeof environment?.CODEX_HOME === "string" && environment.CODEX_HOME.trim() && !current.codexHome
    ? environment.CODEX_HOME.trim()
    : undefined;
  const appServerCommand = typeof environment?.HUNSU_CODEX_APP_SERVER_COMMAND === "string"
    && environment.HUNSU_CODEX_APP_SERVER_COMMAND.trim()
    && !current.appServerCommand
    ? environment.HUNSU_CODEX_APP_SERVER_COMMAND.trim()
    : undefined;
  const appServerArgs = typeof environment?.HUNSU_CODEX_APP_SERVER_ARGS === "string"
    && environment.HUNSU_CODEX_APP_SERVER_ARGS.trim()
    && !current.appServerArgs
    ? environment.HUNSU_CODEX_APP_SERVER_ARGS.trim()
    : undefined;
  return {
    ...(codexHome ? { codexHome } : {}),
    ...(appServerCommand ? { appServerCommand } : {}),
    ...(appServerArgs ? { appServerArgs } : {})
  };
}

function stripLegacyCodexSettings(settings: BridgeCodexSettings): BridgeCodexSettings {
  const next = { ...settings } as BridgeCodexSettings & { environment?: unknown };
  delete next.binaryPath;
  delete next.codexHome;
  delete next.appServerCommand;
  delete next.appServerArgs;
  delete next.installChannel;
  delete next.authenticationPreference;
  delete next.environment;
  return next;
}

function setOptionalStringSetting(settings: Record<string, unknown>, key: string, value: unknown): void {
  if (typeof value === "string" && value.trim()) {
    settings[key] = value.trim();
    return;
  }
  if (value === undefined) {
    delete settings[key];
  }
}

export function defaultBridgeDeviceState(): BridgeDeviceState {
  const name = hostname() || "Hunsu Bridge Device";
  return {
    name,
    id: `device_${hashBridgeDeviceSeed(name).slice(0, 16)}`,
    registered: false
  };
}

export function defaultBridgeServiceState(): BridgeServiceState {
  return {
    installed: false,
    manager: defaultBridgeServiceManager()
  };
}

export function defaultBridgeServiceManager(): BridgeServiceState["manager"] {
  const os = platform();
  if (os === "darwin") return "launchd-user";
  if (os === "win32") return "windows-startup-user";
  if (os === "linux") return "systemd-user";
  return "manual";
}

export function parseBridgeQuitBehavior(value: unknown): BridgeQuitBehavior {
  return value === "stop-background" || value === "keep-background"
    ? value
    : "keep-background";
}

export function parseBridgeRemoteAccessState(value: unknown): BridgeAppState["remoteAccess"] {
  return value === "on" || value === "registered-offline" || value === "unavailable" || value === "off"
    ? value
    : "off";
}

export function formatBridgeRemoteAccess(value: BridgeAppState["remoteAccess"]): BridgeAppSnapshot["status"]["remoteAccess"] {
  switch (value) {
    case "on":
      return "On";
    case "registered-offline":
      return "Registered but offline";
    case "unavailable":
      return "Unavailable";
    case "off":
      return "Off";
  }
}

export function isBridgeUiIntentTab(value: unknown): value is BridgeUiIntent["tab"] {
  return value === "provider"
    || value === "workspaces"
    || value === "connection"
    || value === "advanced"
    || value === "diagnostics"
    || value === "settings";
}

export function canonicalBridgeUiIntentTab(value: unknown): unknown {
  if (value === "prerequisites") return "provider";
  if (value === "roadmaps") return "workspaces";
  if (value === "remote") return "advanced";
  return value;
}

export function hashBridgeDeviceSeed(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
  }
  return Math.abs(hash).toString(16).padStart(8, "0");
}
