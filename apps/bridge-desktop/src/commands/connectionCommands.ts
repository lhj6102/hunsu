import type { BridgeAppSnapshot, BridgeAppState } from "../state/appState.ts";
import { bridgeVersionInfo, type BridgeRuntimeHandle } from "@hunsu/bridge";
import { currentProcessEnv, resolveRelayClientConfig, unwrapConfigResult } from "@hunsu/config";
import { createDefaultCredentialStore } from "../auth.ts";
import { startDetachedRemoteAccessProcess } from "../processes/backgroundSpawn.ts";
import {
  evaluateRelayCommand,
  FileRelayRegistry,
  registerRelayDevice,
  RelayOutboundClient,
  type ProjectGrant,
  type RelayCommandName
} from "../relay.ts";

type ParsedConnectionArgs = {
  rest: string[];
  flags: Map<string, string | boolean>;
};

export type RemoteAccessRuntimeContext = {
  appVersion: string;
  credentialPath: () => string;
  relayRegistryPath: () => string;
  readState: () => BridgeAppState;
  writeState: (state: BridgeAppState) => void;
  projectGrantsWithRemoteRelay: (projectGrants: ProjectGrant[]) => ProjectGrant[];
  activeManagedProjectGrants: (projectGrants: ProjectGrant[]) => ProjectGrant[];
  getFlag: (parsed: ParsedConnectionArgs, name: string) => string | undefined;
  hasFlag: (parsed: ParsedConnectionArgs, name: string) => boolean;
  resolvePath: (path: string) => string;
  waitForShutdown: (cleanup: () => void | Promise<void>) => Promise<void>;
  writeStructuredLog: (value: Record<string, unknown>) => void;
};

type RemoteCommandContext = RemoteAccessRuntimeContext & {
  formatRemoteAccess: (value: BridgeAppState["remoteAccess"]) => string;
  projectGrantsWithoutRemoteRelay: (projectGrants: ProjectGrant[]) => ProjectGrant[];
  disableAllManagedRoadmapRemoteAccess: () => void;
  revokeRunningBridgePairing: () => Promise<boolean>;
  isRelayCommandName: (value: string) => value is RelayCommandName;
};

export function remoteConnectionSnapshotState(state: BridgeAppState): BridgeAppSnapshot["connections"]["remote"]["state"] {
  if (state.account?.status !== "signed-in") {
    return "signed-out";
  }
  return state.remoteAccess;
}

export function localBridgeStatusFromProcessState(
  state: BridgeAppState,
  health: { ok: true } | { ok: false },
  options: {
    processIsAlive: (pid: number) => boolean;
    startingGraceMs: number;
    nowMs?: number;
  }
): BridgeAppSnapshot["status"]["localBridge"] {
  if (health.ok) {
    return "connected";
  }
  const pids = uniqueNumberList([state.supervisorPid, state.pid]);
  if (pids.length === 0 || pids.every(pid => !options.processIsAlive(pid))) {
    return "not-running";
  }
  const startedAtMs = state.startedAt ? Date.parse(state.startedAt) : Number.NaN;
  if (Number.isFinite(startedAtMs) && (options.nowMs ?? Date.now()) - startedAtMs <= options.startingGraceMs) {
    return "starting";
  }
  return "error";
}

export async function runRemoteCommand(parsed: ParsedConnectionArgs, context: RemoteCommandContext): Promise<void> {
  const subcommand = parsed.rest[0] ?? "status";
  const state = context.readState();
  const relayRegistry = new FileRelayRegistry(context.relayRegistryPath());
  if (subcommand === "status") {
    console.log(`Remote Access: ${context.formatRemoteAccess(state.remoteAccess)}`);
    console.log(`Device: ${state.device.name}${state.device.registered ? " (registered)" : ""}`);
    console.log(`Account: ${state.account?.status === "signed-in" ? `Signed in as ${state.account.email ?? state.account.userId}` : "Signed out"}`);
    return;
  }
  if (subcommand === "devices") {
    const userId = state.account?.status === "signed-in" ? state.account.userId : undefined;
    for (const device of relayRegistry.listDevices(userId)) {
      console.log(`${device.deviceName}\t${device.status}\t${device.deviceId}`);
    }
    return;
  }
  if (subcommand === "attach") {
    await attachRemoteAccessCommand(context);
    return;
  }
  if (subcommand === "enable") {
    if (state.account?.status !== "signed-in") {
      context.writeState({ ...state, remoteAccess: "unavailable" });
      console.log("Remote Access is unavailable until this device is signed in.");
      console.log("Run `hunsu-bridge login` to start device login.");
      return;
    }
    const version = bridgeVersionInfo();
    const device = {
      deviceId: state.device.id,
      deviceName: state.device.name,
      userId: state.account.userId,
      remoteAccess: "enabled" as const,
      bridgeVersion: version.bridgeVersion,
      bridgeAppVersion: context.appVersion,
      protocolVersion: version.protocolVersion
    };
    const nextGrants = context.projectGrantsWithRemoteRelay(state.projectGrants);
    const activeGrants = context.activeManagedProjectGrants(nextGrants);
    const credentials = createDefaultCredentialStore({ path: context.credentialPath() }).read();
    const relayConfig = unwrapConfigResult(resolveRelayClientConfig(currentProcessEnv()));
    if (credentials && relayConfig.relayApiUrl) {
      await registerRelayDevice({
        relayApiUrl: relayConfig.relayApiUrl,
        accessToken: credentials.accessToken,
        device: {
          ...device,
          registeredAt: new Date().toISOString(),
          status: "offline" as const
        },
        projectGrants: activeGrants
      });
      context.writeStructuredLog({ event: "relay.device.registered", relayApiUrl: relayConfig.relayApiUrl, deviceId: state.device.id });
    } else {
      relayRegistry.registerDevice(device);
      context.writeStructuredLog({ event: "relay.device.registered-local", deviceId: state.device.id });
    }
    context.writeState({
      ...state,
      remoteAccess: "registered-offline",
      device: { ...state.device, registered: true },
      projectGrants: nextGrants
    });
    const started = startRemoteAccessProcessIfPossible(parsed, context);
    console.log("Remote Access registered for this signed-in device.");
    console.log(started
      ? "Starting outbound Relay connection."
      : "Remote Access is registered but offline until Bridge can connect to Relay.");
    return;
  }
  if (subcommand === "disable") {
    await context.revokeRunningBridgePairing();
    relayRegistry.updateDeviceStatus(state.device.id, "offline", "disabled");
    context.disableAllManagedRoadmapRemoteAccess();
    const nextState = { ...state, remoteAccess: "off" as const, projectGrants: context.projectGrantsWithoutRemoteRelay(state.projectGrants) };
    context.writeState(nextState);
    await publishProjectGrantsToRelay(nextState, context);
    console.log("Remote Access disabled.");
    return;
  }
  if (subcommand === "check") {
    const command = parsed.rest[1] ?? "health";
    if (!context.isRelayCommandName(command)) {
      throw new Error(`Unknown Relay command: ${command}`);
    }
    const projectPath = parsed.rest[2] ? context.resolvePath(parsed.rest[2]) : undefined;
    const decision = evaluateRelayCommand({
      device: relayRegistry.listDevices().find(device => device.deviceId === state.device.id),
      command: {
        deviceId: state.device.id,
        command,
        projectPath
      },
      projectGrants: context.activeManagedProjectGrants(state.projectGrants)
    });
    if (!decision.ok) {
      throw new Error(decision.message);
    }
    console.log(`Relay command allowed: ${command}`);
    return;
  }
  throw new Error(`Unknown remote command: ${subcommand}`);
}

export async function publishProjectGrantsToRelay(state: BridgeAppState, context: RemoteAccessRuntimeContext): Promise<void> {
  if (state.account?.status !== "signed-in") {
    return;
  }
  const credentials = createDefaultCredentialStore({ path: context.credentialPath() }).read();
  const relayConfig = unwrapConfigResult(resolveRelayClientConfig(currentProcessEnv()));
  if (!credentials || !relayConfig.relayApiUrl) {
    return;
  }
  const activeGrants = context.activeManagedProjectGrants(state.projectGrants);
  const version = bridgeVersionInfo();
  try {
    await registerRelayDevice({
      relayApiUrl: relayConfig.relayApiUrl,
      accessToken: credentials.accessToken,
      device: {
        deviceId: state.device.id,
        deviceName: state.device.name,
        userId: state.account.userId,
        registeredAt: new Date().toISOString(),
        status: "offline",
        remoteAccess: "enabled",
        bridgeVersion: version.bridgeVersion,
        bridgeAppVersion: context.appVersion,
        protocolVersion: version.protocolVersion
      },
      projectGrants: activeGrants
    });
    context.writeStructuredLog({ event: "relay.project-grants.published", relayApiUrl: relayConfig.relayApiUrl, deviceId: state.device.id, projectGrantCount: activeGrants.length });
  } catch (error) {
    context.writeStructuredLog({ event: "relay.project-grants.publish-failed", error: error instanceof Error ? error.message : String(error) });
  }
}

export async function enableRemoteAccessIfSignedIn(context: RemoteAccessRuntimeContext): Promise<void> {
  const state = context.readState();
  if (state.account?.status !== "signed-in") {
    context.writeState({ ...state, remoteAccess: "unavailable" });
    return;
  }
  const nextGrants = context.projectGrantsWithRemoteRelay(state.projectGrants);
  const activeGrants = context.activeManagedProjectGrants(nextGrants);
  const version = bridgeVersionInfo();
  const device = {
    deviceId: state.device.id,
    deviceName: state.device.name,
    userId: state.account.userId,
    remoteAccess: "enabled" as const,
    bridgeVersion: version.bridgeVersion,
    bridgeAppVersion: context.appVersion,
    protocolVersion: version.protocolVersion
  };
  const credentials = createDefaultCredentialStore({ path: context.credentialPath() }).read();
  const relayConfig = unwrapConfigResult(resolveRelayClientConfig(currentProcessEnv()));
  if (credentials && relayConfig.relayApiUrl) {
    await registerRelayDevice({
      relayApiUrl: relayConfig.relayApiUrl,
      accessToken: credentials.accessToken,
      device: {
        ...device,
        registeredAt: new Date().toISOString(),
        status: "offline" as const
      },
      projectGrants: activeGrants
    });
    context.writeStructuredLog({ event: "relay.device.registered", relayApiUrl: relayConfig.relayApiUrl, deviceId: state.device.id });
  } else {
    const relayRegistry = new FileRelayRegistry(context.relayRegistryPath());
    relayRegistry.registerDevice(device);
    context.writeStructuredLog({ event: "relay.device.registered-local", deviceId: state.device.id });
  }
  context.writeState({
    ...state,
    remoteAccess: "registered-offline",
    device: { ...state.device, registered: true },
    projectGrants: nextGrants
  });
}

export function startRelayIfConfigured(
  handle: Pick<BridgeRuntimeHandle, "bridgeApiUrl" | "authToken">,
  context: RemoteAccessRuntimeContext
): RelayOutboundClient | undefined {
  const state = context.readState();
  const relayConfig = unwrapConfigResult(resolveRelayClientConfig(currentProcessEnv()));
  const credentials = createDefaultCredentialStore({ path: context.credentialPath() }).read();
  const relayUrl = relayConfig.relayWsUrl;
  if (!relayUrl || state.account?.status !== "signed-in" || !credentials) {
    context.writeStructuredLog({ event: "relay.not-started", reason: relayUrl ? credentials ? "signed-out" : "credentials-missing" : "relay-url-missing" });
    return undefined;
  }
  const version = bridgeVersionInfo();
  const device = {
    deviceId: state.device.id,
    deviceName: state.device.name,
    userId: state.account.userId,
    registeredAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    status: "online" as const,
    remoteAccess: "enabled" as const,
    bridgeVersion: version.bridgeVersion,
    bridgeAppVersion: context.appVersion,
    protocolVersion: version.protocolVersion
  };
  const relayClient = new RelayOutboundClient({
    relayUrl,
    accessToken: credentials.accessToken,
    device,
    projectGrants: () => context.activeManagedProjectGrants(context.readState().projectGrants),
    bridgeApiUrl: handle.bridgeApiUrl,
    bridgeAuthToken: handle.authToken
  });
  relayClient.start();
  context.writeStructuredLog({ event: "relay.started", relayUrl, deviceId: state.device.id });
  return relayClient;
}

export async function attachRemoteAccessCommand(context: RemoteAccessRuntimeContext): Promise<void> {
  const state = context.readState();
  if (state.account?.status !== "signed-in") {
    context.writeState({ ...state, remoteAccess: "unavailable" });
    throw new Error("Remote Access is unavailable until this device is signed in.");
  }
  if (!state.bridgeApiUrl || !state.authToken) {
    context.writeState({ ...state, remoteAccess: "registered-offline" });
    throw new Error("No running managed Bridge is available for Relay attachment.");
  }
  const relayClient = startRelayIfConfigured({
    bridgeApiUrl: state.bridgeApiUrl,
    authToken: state.authToken
  }, context);
  if (!relayClient) {
    writeRemoteAccessState("registered-offline", context);
    console.log("Remote Access is registered but offline because Relay is not configured.");
    return;
  }
  const connected = await waitForRelayConnection(relayClient);
  writeRemoteAccessState(connected ? "on" : "registered-offline", context);
  console.log(connected ? "Remote Access is On." : "Remote Access is registered but offline.");
  await context.waitForShutdown(async () => {
    relayClient.stop();
    new FileRelayRegistry(context.relayRegistryPath()).updateDeviceStatus(state.device.id, "offline");
    writeRemoteAccessState("registered-offline", context);
  });
}

export function startRemoteAccessProcessIfPossible(
  parsed: ParsedConnectionArgs,
  context: RemoteAccessRuntimeContext
): boolean {
  if (context.hasFlag(parsed, "no-start") || currentProcessEnv().HUNSU_BRIDGE_REMOTE_ENABLE_NO_START === "1") {
    return false;
  }
  const state = context.readState();
  const relayConfig = unwrapConfigResult(resolveRelayClientConfig(currentProcessEnv()));
  const credentials = createDefaultCredentialStore({ path: context.credentialPath() }).read();
  if (!relayConfig.relayWsUrl || !credentials || state.account?.status !== "signed-in") {
    return false;
  }
  const cwd = context.resolvePath(context.getFlag(parsed, "cwd") ?? state.cwd ?? process.cwd());
  const webUrl = context.getFlag(parsed, "web-url");
  const args = state.bridgeApiUrl && state.authToken
    ? ["remote", "attach"]
    : [
        "daemon",
        "--remote",
        "--no-open",
        "--cwd",
        cwd,
        ...(webUrl ? ["--web-url", webUrl] : [])
      ];
  return startDetachedRemoteAccessProcess({
    state,
    cwd,
    args,
    activeProjectGrants: context.activeManagedProjectGrants(state.projectGrants),
    writeState: context.writeState,
    writeStructuredLog: context.writeStructuredLog
  });
}

export async function waitForRelayConnection(client: RelayOutboundClient, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (client.status().status === "connected") {
      return true;
    }
    if (client.status().status === "error") {
      return false;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return client.status().status === "connected";
}

export function writeRemoteAccessState(remoteAccess: BridgeAppState["remoteAccess"], context: RemoteAccessRuntimeContext): void {
  const state = context.readState();
  context.writeState({ ...state, remoteAccess });
}

function uniqueNumberList(values: Array<number | undefined>): number[] {
  return [...new Set(values.filter((value): value is number => Number.isInteger(value)))];
}
