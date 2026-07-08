#!/usr/bin/env node
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname, platform } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isSea } from "node:sea";
import { BridgeSidecarSupervisor } from "./sidecar-supervisor.ts";
import {
  createDefaultCredentialStore,
  createPkceAuthorizationRequest,
  exchangeAuthorizationCode,
  pollDeviceAuthorization,
  startDeviceAuthorization,
  startLocalDevAuthServer,
  type BridgeAccountCredentials
} from "./auth.ts";
import {
  chooseNativeFolder,
  installLinuxProtocolHandler,
  protocolRegistrationPlan
} from "./native-shell.ts";
import {
  evaluateRelayCommand,
  FileRelayRegistry,
  registerRelayDevice,
  RelayOutboundClient,
  type BridgeCommandScope,
  type ProjectGrant,
  type RelayCommandName
} from "./relay.ts";
import {
  applyStudioPort,
  bridgeVersionInfo,
  createBridgeSupervisor,
  createStudioRoadmap,
  createStudioState,
  inspectProject,
  listRoadmapRegistry,
  openStudioInBrowser,
  openStudioRoadmap,
  removeRoadmapRegistryEntry,
  resolveRoadmapRepositoryPath,
  resolveStudioBridgeWebUrl,
  type BridgePairingSession,
  type BridgeRuntimeHandle,
  type ProjectInspection
} from "@hunsu/bridge";
import { currentProcessEnv, endpointUrl, resolveBridgeRuntimeConfig, resolveRelayClientConfig, unwrapConfigResult } from "@hunsu/config";

type ParsedArgs = {
  command: string;
  rest: string[];
  flags: Map<string, string | boolean>;
};

type BridgeAppState = {
  schema: "hunsu.bridge-app-state.v1";
  supervisorPid?: number;
  pid?: number;
  bridgeApiUrl?: string;
  authToken?: string;
  controlToken?: string;
  pairing?: BridgePairingSession;
  cwd?: string;
  webUrl?: string;
  startedAt?: string;
  account?: BridgeAccountState;
  pendingAuth?: BridgePendingAuthState;
  device: BridgeDeviceState;
  remoteAccess: "off" | "on" | "registered-offline" | "unavailable";
  projectGrants: ProjectGrant[];
  service: BridgeServiceState;
};

type BridgeAccountState =
  | { status: "signed-out" }
  | { status: "signed-in"; userId: string; email?: string };

type BridgeDeviceState = {
  name: string;
  id: string;
  registered: boolean;
};

type BridgePendingAuthState = {
  state: string;
  codeVerifier: string;
  redirectUri: string;
  authBaseUrl: string;
  startedAt: string;
};

type BridgeServiceState = {
  installed: boolean;
  manager: "systemd-user" | "launchd-user" | "windows-service" | "manual";
  unitPath?: string;
  updatedAt?: string;
};

type BridgeAppSnapshot = {
  schema: "hunsu.bridge-app-snapshot.v1";
  status: {
    localBridge: "connected" | "not-running" | "starting" | "error";
    account: string;
    remoteAccess: "Off" | "On" | "Registered but offline" | "Unavailable";
    device: BridgeDeviceState;
    service: BridgeServiceState;
    supervisorPid?: number;
    pid?: number;
    bridgeApiUrl?: string;
    startedAt?: string;
    healthError?: string;
  };
  recentProjects: ReturnType<typeof listRoadmapRegistry>;
  diagnostics: unknown;
  logLines: string[];
};

const DEFAULT_APP_STATE_PATH = join(homedir(), ".config", "hunsu", "bridge-app.json");
const DEFAULT_CREDENTIAL_PATH = join(homedir(), ".config", "hunsu", "bridge-credentials.json");
const DEFAULT_RELAY_REGISTRY_PATH = join(homedir(), ".config", "hunsu", "relay-devices.json");
const DEFAULT_APP_LOG_PATH = join(homedir(), ".cache", "hunsu", "bridge-app.log");
const DEFAULT_SYSTEMD_USER_UNIT_PATH = join(homedir(), ".config", "systemd", "user", "hunsu-bridge.service");
const DEFAULT_PROJECT_GRANT_SCOPES: BridgeCommandScope[] = ["execute.start", "artifactAction.run", "hostAlias.expose"];
const HUNSU_BRIDGE_APP_VERSION = "0.1.0";

async function main(argv = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(normalizeBridgeAppArgv(argv));
  try {
    switch (parsed.command) {
      case "start":
        await supervisedStartCommand(parsed);
        return 0;
      case "pair":
        await pairCommand(parsed);
        return 0;
      case "open":
      case "open-project":
        await openProjectCommand(parsed, "open");
        return 0;
      case "open-roadmap":
        await openRoadmapCommand(parsed);
        return 0;
      case "port":
        await openProjectCommand(parsed, "port");
        return 0;
      case "create":
        await openProjectCommand(parsed, "create");
        return 0;
      case "inspect":
        inspectCommand(parsed);
        return 0;
      case "choose-folder":
        await chooseFolderCommand();
        return 0;
      case "status":
        await statusCommand();
        return 0;
      case "stop":
        await stopCommand();
        return 0;
      case "diagnostics":
        await diagnosticsCommand();
        return 0;
      case "snapshot":
        await snapshotCommand();
        return 0;
      case "login":
        await loginCommand(parsed);
        return 0;
      case "auth-callback":
        await authCallbackCommand(parsed);
        return 0;
      case "logout":
        logoutCommand();
        return 0;
      case "remote":
        await remoteCommand(parsed);
        return 0;
      case "protocol":
        protocolCommand(parsed);
        return 0;
      case "service":
        serviceCommand(parsed);
        return 0;
      case "supervise":
        await superviseCommand(parsed);
        return 0;
      case "daemon":
        await daemonCommand(parsed);
        return 0;
      case "auth-dev-server":
        await authDevServerCommand(parsed);
        return 0;
      case "projects":
        projectsCommand(parsed);
        return 0;
      case "help":
        printHelp();
        return 0;
      default:
        printHelp();
        return 1;
    }
  } catch (error) {
    writeStructuredLog({ event: "command.failed", command: parsed.command, error: error instanceof Error ? error.message : String(error) });
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function supervisedStartCommand(parsed: ParsedArgs): Promise<void> {
  const supervisor = createBridgeAppSidecarSupervisor(parsed);
  const cwd = resolve(getFlag(parsed, "cwd") ?? process.cwd());
  writeAppState({
    ...readAppState(),
    supervisorPid: process.pid,
    cwd,
    webUrl: getFlag(parsed, "web-url"),
    startedAt: new Date().toISOString()
  });
  supervisor.start();
  writeStructuredLog({ event: "bridge.supervisor.started", status: supervisor.status() });
  console.log("Hunsu Bridge supervisor started.");
  console.log(JSON.stringify(supervisor.status(), null, 2));
  try {
    await waitForShutdown(async () => {
      await supervisor.stop();
    });
  } finally {
    clearSupervisorProcessState();
  }
}

async function daemonCommand(parsed: ParsedArgs): Promise<void> {
  const cwd = resolve(getFlag(parsed, "cwd") ?? process.cwd());
  const remote = hasFlag(parsed, "remote");
  const supervisor = createBridgeSupervisor();
  const handle = await supervisor.start({
    cwd,
    webUrl: getFlag(parsed, "web-url"),
    noOpen: hasFlag(parsed, "no-open"),
    mode: remote ? "remote-ready" : "local"
  });
  let relayClient: RelayOutboundClient | undefined;
  if (remote) {
    await enableRemoteAccessIfSignedIn();
    relayClient = startRelayIfConfigured(handle);
  writeRemoteAccessState(relayClient && await waitForRelayConnection(relayClient) ? "on" : "registered-offline");
  }
  rememberRunningBridge(handle, cwd, getFlag(parsed, "web-url"));
  printAppStatus(handle);
  await waitForShutdown(async () => {
    relayClient?.stop();
    await supervisor.stop();
  });
  clearManagedProcessState();
}

async function pairCommand(parsed: ParsedArgs): Promise<void> {
  const cwd = resolve(getFlag(parsed, "cwd") ?? process.cwd());
  const next = safeStudioNext(getFlag(parsed, "next") ?? "/studio");
  const webUrl = studioWebUrlForNext(getFlag(parsed, "web-url"), next);
  const running = await rotateRunningBridgePairing({ webUrl });
  if (running.ok) {
    if (hasFlag(parsed, "no-open")) {
      console.log(running.pairingUrl);
    } else {
      await openStudioManagedUrl(running.pairingUrl);
    }
    console.log("Hunsu Bridge pairing refreshed on the running managed Bridge.");
    return;
  }
  const supervisor = createBridgeSupervisor();
  const handle = await supervisor.start({
    cwd,
    webUrl,
    noOpen: true,
    mode: "local"
  });
  rememberRunningBridge(handle, cwd, webUrl);
  const pairingUrl = await supervisor.createPairingUrl({ webUrl });
  if (hasFlag(parsed, "no-open")) {
    console.log(pairingUrl);
  } else {
    await supervisor.openStudio({ url: pairingUrl });
  }
  printAppStatus({ ...handle, studioUrl: pairingUrl });
  await waitForShutdown(supervisor.stop);
  clearManagedProcessState();
}

async function rotateRunningBridgePairing(input: {
  webUrl: string;
  roadmapId?: string;
}): Promise<
  | { ok: true; pairingUrl: string; handle: BridgeRuntimeHandle }
  | { ok: false; error: string }
> {
  const state = readAppState();
  if (!state.bridgeApiUrl || !state.controlToken) {
    return { ok: false, error: "No running managed Bridge control endpoint is known." };
  }
  try {
    const response = await fetch(new URL("/api/bridge/pairing/rotate", state.bridgeApiUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hunsu-bridge-control-token": state.controlToken
      },
      body: JSON.stringify({
        webUrl: input.webUrl,
        roadmapId: input.roadmapId
      })
    });
    const body = await response.json().catch(() => undefined) as Partial<BridgeRuntimeHandle> & { studioUrl?: string; error?: string } | undefined;
    if (!response.ok || !body?.authToken || !body.pairing || !body.studioUrl) {
      return { ok: false, error: body?.error ?? `Bridge pairing refresh failed with HTTP ${response.status}.` };
    }
    const handle: BridgeRuntimeHandle = {
      bridgeApiUrl: body.bridgeApiUrl ?? state.bridgeApiUrl,
      studioUrl: body.studioUrl,
      allowedOrigin: new URL(input.webUrl).origin,
      authToken: body.authToken,
      controlToken: state.controlToken,
      pairing: body.pairing,
      status: "running",
      startedAt: state.startedAt
    };
    writeAppState({
      ...state,
      bridgeApiUrl: handle.bridgeApiUrl,
      authToken: handle.authToken,
      pairing: handle.pairing
    });
    writeStructuredLog({ event: "bridge.pairing.rotated", bridgeApiUrl: handle.bridgeApiUrl, issuedAt: handle.pairing.issuedAt });
    return { ok: true, pairingUrl: body.studioUrl, handle };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unable to reach running managed Bridge." };
  }
}

async function revokeRunningBridgePairing(): Promise<boolean> {
  const state = readAppState();
  if (!state.bridgeApiUrl || !state.controlToken) {
    return false;
  }
  try {
    const response = await fetch(new URL("/api/bridge/pairing/revoke", state.bridgeApiUrl), {
      method: "POST",
      headers: {
        "x-hunsu-bridge-control-token": state.controlToken
      }
    });
    if (!response.ok) {
      return false;
    }
    const body = await response.json().catch(() => undefined) as { pairing?: BridgePairingSession } | undefined;
    writeAppState({
      ...state,
      authToken: undefined,
      pairing: body?.pairing ?? state.pairing
    });
    writeStructuredLog({ event: "bridge.pairing.revoked", bridgeApiUrl: state.bridgeApiUrl });
    return true;
  } catch (_error) {
    return false;
  }
}

async function openProjectCommand(parsed: ParsedArgs, forcedAction: "open" | "port" | "create"): Promise<void> {
  const path = await resolveChosenProjectPath(parsed);
  const project = inspectProject({ path }, roadmapRegistryOptions());
  if (project.kind === "unsupported") {
    throw new Error(project.reason);
  }

  const state = createStudioState();
  const result = forcedAction === "create" || project.kind === "new-project"
    ? createStudioRoadmap({ path, title: basename(path) }, state)
    : forcedAction === "port" || project.kind === "git-project"
      ? applyStudioPort({ path, title: basename(project.path), goal: `Port ${basename(project.path)} into Hunsu.` }, state)
      : openStudioRoadmap({ path: project.path }, state);

  const supervisor = createBridgeSupervisor();
  const handle = await supervisor.start({
    cwd: result.repository.root,
    webUrl: getFlag(parsed, "web-url"),
    noOpen: true
  });
  rememberRunningBridge(handle, result.repository.root, getFlag(parsed, "web-url"));
  await supervisor.openStudio({ roadmapId: result.roadmap.roadmapId });
  printProjectAction(project, result.roadmap.roadmapId);
  printAppStatus(handle);
  await waitForShutdown(supervisor.stop);
  clearManagedProcessState();
}

async function resolveChosenProjectPath(parsed: ParsedArgs): Promise<string> {
  const explicitPath = parsed.rest[0] ?? getFlag(parsed, "path") ?? getFlag(parsed, "cwd");
  if (explicitPath?.trim()) {
    return resolve(explicitPath);
  }
  const selected = await chooseNativeFolder();
  if (!selected.ok) {
    throw new Error(selected.message);
  }
  return resolve(selected.path);
}

async function openRoadmapCommand(parsed: ParsedArgs): Promise<void> {
  const roadmapId = getFlag(parsed, "roadmap-id") ?? parsed.rest[0];
  if (!roadmapId?.trim()) {
    throw new Error("Roadmap ID is required.");
  }
  const repositoryPath = resolveRoadmapRepositoryPath(roadmapId.trim(), roadmapRegistryOptions());
  const supervisor = createBridgeSupervisor();
  const handle = await supervisor.start({
    cwd: repositoryPath,
    webUrl: getFlag(parsed, "web-url"),
    noOpen: true
  });
  rememberRunningBridge(handle, repositoryPath, getFlag(parsed, "web-url"));
  await supervisor.openStudio({ roadmapId: roadmapId.trim() });
  printAppStatus(handle);
  await waitForShutdown(supervisor.stop);
  clearManagedProcessState();
}

function inspectCommand(parsed: ParsedArgs): void {
  const path = resolve(parsed.rest[0] ?? getFlag(parsed, "cwd") ?? process.cwd());
  const project = inspectProject({ path }, roadmapRegistryOptions());
  if (hasFlag(parsed, "json")) {
    console.log(JSON.stringify({ project }, null, 2));
    return;
  }
  printProjectInspection(project);
}

async function chooseFolderCommand(): Promise<void> {
  const selected = await chooseNativeFolder();
  if (!selected.ok) {
    throw new Error(selected.message);
  }
  printProjectInspection(inspectProject({ path: selected.path }, roadmapRegistryOptions()));
}

async function statusCommand(): Promise<void> {
  const snapshot = await readAppSnapshot();
  if (currentProcessEnv().HUNSU_BRIDGE_APP_JSON === "1") {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }
  console.log("Hunsu Bridge");
  console.log("");
  console.log("Status:");
  console.log(`  Local Bridge: ${snapshot.status.localBridge === "connected" ? "Connected" : snapshot.status.localBridge === "starting" ? "Starting" : snapshot.status.localBridge === "error" ? "Error" : "Not Running"}`);
  console.log(`  Account: ${snapshot.status.account}`);
  console.log(`  Remote Access: ${snapshot.status.remoteAccess}`);
  console.log(`  Device: ${snapshot.status.device.name}${snapshot.status.device.registered ? " (registered)" : ""}`);
  console.log(`  Service: ${snapshot.status.service.installed ? `Installed (${snapshot.status.service.manager})` : "Not installed"}`);
  console.log("");
  console.log("Projects:");
  for (const project of snapshot.recentProjects.slice(0, 8)) {
    console.log(`  ${project.displayName} (${project.health === "ok" ? "Roadmap" : "Missing"})`);
    console.log(`    ${project.repositoryPath}`);
  }
  console.log("");
  console.log("Actions:");
  console.log("  Open in Studio");
  console.log("  Start Bridge");
  console.log("  Stop Bridge");
  console.log("  Copy Diagnostics");
}

async function stopCommand(): Promise<void> {
  const state = readAppState();
  const targetPid = state.supervisorPid ?? state.pid;
  if (!targetPid) {
    console.log("Hunsu Bridge is not managed by this Bridge App process.");
    return;
  }
  let stopped = false;
  let stopError: unknown;
  try {
    process.kill(targetPid, "SIGTERM");
    stopped = true;
  } catch (error) {
    stopError = error;
    if (state.supervisorPid && state.pid && state.pid !== targetPid) {
      try {
        process.kill(state.pid, "SIGTERM");
        stopped = true;
      } catch (fallbackError) {
        stopError = fallbackError;
      }
    }
  }
  writeAppState({
    ...state,
    supervisorPid: undefined,
    pid: undefined,
    bridgeApiUrl: undefined,
    authToken: undefined,
    controlToken: undefined,
    pairing: undefined,
    startedAt: undefined
  });
  if (!stopped) {
    throw new Error(stopError instanceof Error ? stopError.message : "Unable to stop Hunsu Bridge.");
  }
  console.log("Hunsu Bridge stopped.");
}

async function diagnosticsCommand(): Promise<void> {
  console.log(JSON.stringify(await buildDiagnostics(), null, 2));
}

async function snapshotCommand(): Promise<void> {
  console.log(JSON.stringify(await readAppSnapshot(), null, 2));
}

async function buildDiagnostics(): Promise<unknown> {
  const runtimeConfig = unwrapConfigResult(resolveBridgeRuntimeConfig(currentProcessEnv(), { cwd: process.cwd() }));
  const health = await readBridgeHealth();
  const state = readAppState();
  const credentialStore = createDefaultCredentialStore({ path: credentialPath() });
  const relayRegistry = new FileRelayRegistry(relayRegistryPath());
  return {
    app: {
      statePath: appStatePath(),
      logPath: appLogPath(),
      supervisorPid: state.supervisorPid,
      pid: state.pid,
      device: state.device,
      controlTokenPresent: Boolean(state.controlToken),
      pairing: state.pairing ? {
        issuedAt: state.pairing.issuedAt,
        expiresAt: state.pairing.expiresAt,
        revokedAt: state.pairing.revokedAt
      } : undefined,
      account: state.account ?? { status: "signed-out" },
      pendingAuth: state.pendingAuth ? { state: state.pendingAuth.state, startedAt: state.pendingAuth.startedAt } : undefined,
      credentialBackend: credentialStore.backend,
      credentialsPresent: credentialStore.read() !== undefined,
      remoteAccess: state.remoteAccess,
      projectGrantCount: state.projectGrants.length,
      service: state.service
    },
    bridge: {
      health,
      apiUrl: endpointUrl(runtimeConfig.bridgeApi),
      version: bridgeVersionInfo()
    },
    recentProjects: listRoadmapRegistry(roadmapRegistryOptions()).map(project => ({
      roadmapId: project.roadmapId,
      displayName: project.displayName,
      repositoryPath: project.repositoryPath,
      health: project.health,
      type: project.type,
      primaryAction: project.primaryAction
    })),
    relay: relayRegistry.listDevices(state.account?.status === "signed-in" ? state.account.userId : undefined).map(device => ({
      deviceId: device.deviceId,
      deviceName: device.deviceName,
      status: device.status,
      lastSeenAt: device.lastSeenAt
    }))
  };
}

async function loginCommand(parsed: ParsedArgs = { command: "login", rest: [], flags: new Map() }): Promise<void> {
  const state = readAppState();
  const credentialStore = createDefaultCredentialStore({ path: credentialPath() });
  const devUser = nonEmptyFlagValue(currentProcessEnv().HUNSU_BRIDGE_DEV_USER);
  if (devUser) {
    credentialStore.write(credentialsForDevUser(devUser, state));
    writeAppState({
      ...state,
      account: { status: "signed-in", userId: devUser, email: devUser.includes("@") ? devUser : undefined },
      device: { ...state.device, registered: true }
    });
    console.log(`Signed in as ${devUser}.`);
    return;
  }
  if (hasFlag(parsed, "gui")) {
    const authBaseUrl = unwrapConfigResult(resolveRelayClientConfig(currentProcessEnv())).authBaseUrl;
    const request = createPkceAuthorizationRequest({
      authBaseUrl,
      clientId: "hunsu-bridge-app",
      redirectUri: "hunsu://pair",
      scope: "bridge device relay"
    });
    writeAppState({
      ...state,
      pendingAuth: {
        state: request.state,
        codeVerifier: request.codeVerifier,
        redirectUri: request.redirectUri,
        authBaseUrl,
        startedAt: new Date().toISOString()
      }
    });
    console.log("Open this URL in your browser:");
    console.log(request.authorizationUrl);
    console.log("");
    console.log("Authorization Code + PKCE is ready for the GUI Bridge App callback.");
    if (!hasFlag(parsed, "no-open")) {
      openStudioInBrowser(request.authorizationUrl);
    }
    return;
  }
  const configuredAuthBaseUrl = getFlag(parsed, "auth-url") ?? unwrapConfigResult(resolveRelayClientConfig(currentProcessEnv())).authBaseUrl;
  const localDev = configuredAuthBaseUrl === "local-dev" || hasFlag(parsed, "local-dev");
  const localDevServer = localDev
    ? await startLocalDevAuthServer({
        userId: getFlag(parsed, "user") ?? "local-dev@example.test",
        email: getFlag(parsed, "email") ?? getFlag(parsed, "user") ?? "local-dev@example.test"
      })
    : undefined;
  const authBaseUrl = localDevServer?.authBaseUrl ?? configuredAuthBaseUrl;
  try {
    const request = await startDeviceAuthorization({
      authBaseUrl,
      clientId: "hunsu-bridge-headless",
      scope: "bridge device relay",
      deviceId: state.device.id,
      deviceName: state.device.name
    });
    console.log("Open this URL on another device:");
    console.log(request.verificationUriComplete ?? request.verificationUri);
    console.log("");
    console.log("Enter code:");
    console.log(request.userCode);
    console.log("");
    if (localDevServer && (hasFlag(parsed, "auto-approve") || currentProcessEnv().HUNSU_BRIDGE_AUTH_LOCAL_DEV_AUTO_APPROVE === "1")) {
      await fetch(request.verificationUriComplete ?? `${request.verificationUri}?user_code=${encodeURIComponent(request.userCode)}`);
    }
    const credentials = await pollDeviceAuthorization({
      authBaseUrl,
      clientId: "hunsu-bridge-headless",
      deviceCode: request.deviceCode,
      deviceId: state.device.id,
      deviceName: state.device.name,
      intervalSeconds: request.intervalSeconds,
      expiresAt: request.expiresAt,
      maxWaitMs: numericFlag(parsed, "poll-timeout-ms")
    });
    credentialStore.write(credentials);
    writeAppState({
      ...state,
      account: { status: "signed-in", userId: credentials.userId, email: credentials.email },
      device: { ...state.device, registered: true },
      pendingAuth: undefined
    });
    console.log(`Signed in as ${credentials.email ?? credentials.userId}.`);
  } finally {
    await localDevServer?.close();
  }
}

async function authCallbackCommand(parsed: ParsedArgs): Promise<void> {
  const code = getFlag(parsed, "code") ?? parsed.rest[0];
  const stateParam = getFlag(parsed, "state");
  if (!code?.trim() || !stateParam?.trim()) {
    throw new Error("Authorization callback requires code and state.");
  }
  const state = readAppState();
  if (!state.pendingAuth) {
    throw new Error("No pending Bridge App sign-in request was found.");
  }
  if (state.pendingAuth.state !== stateParam) {
    throw new Error("Authorization callback state did not match the pending Bridge App sign-in.");
  }
  const credentials = await exchangeAuthorizationCode({
    authBaseUrl: state.pendingAuth.authBaseUrl,
    clientId: "hunsu-bridge-app",
    code,
    codeVerifier: state.pendingAuth.codeVerifier,
    redirectUri: state.pendingAuth.redirectUri,
    deviceId: state.device.id,
    deviceName: state.device.name
  });
  createDefaultCredentialStore({ path: credentialPath() }).write(credentials);
  writeAppState({
    ...state,
    pendingAuth: undefined,
    account: { status: "signed-in", userId: credentials.userId, email: credentials.email },
    device: { ...state.device, registered: true }
  });
  console.log(`Signed in as ${credentials.email ?? credentials.userId}.`);
}

function logoutCommand(): void {
  const state = readAppState();
  createDefaultCredentialStore({ path: credentialPath() }).clear();
  writeAppState({
    ...state,
    account: { status: "signed-out" },
    pendingAuth: undefined,
    remoteAccess: "off"
  });
  console.log("Signed out. Local Bridge remains available.");
}

async function remoteCommand(parsed: ParsedArgs): Promise<void> {
  const subcommand = parsed.rest[0] ?? "status";
  const state = readAppState();
  const relayRegistry = new FileRelayRegistry(relayRegistryPath());
  if (subcommand === "status") {
    console.log(`Remote Access: ${formatRemoteAccess(state.remoteAccess)}`);
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
    await attachRemoteAccessCommand();
    return;
  }
  if (subcommand === "enable") {
    if (state.account?.status !== "signed-in") {
      writeAppState({ ...state, remoteAccess: "unavailable" });
      console.log("Remote Access is unavailable until this device is signed in.");
      console.log("Run `hunsu-bridge login` to start device login.");
      return;
    }
    const device = {
      deviceId: state.device.id,
      deviceName: state.device.name,
      userId: state.account.userId,
      bridgeVersion: bridgeVersionInfo().bridgeVersion,
      bridgeAppVersion: HUNSU_BRIDGE_APP_VERSION,
      protocolVersion: bridgeVersionInfo().protocolVersion
    };
    const nextGrants = state.projectGrants.map(grant => ({
      ...grant,
      scopes: grant.scopes.includes("remoteRelay.access") ? grant.scopes : uniqueScopeList([...grant.scopes, "remoteRelay.access"])
    }));
    const credentials = createDefaultCredentialStore({ path: credentialPath() }).read();
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
        projectGrants: nextGrants
      });
      writeStructuredLog({ event: "relay.device.registered", relayApiUrl: relayConfig.relayApiUrl, deviceId: state.device.id });
    } else {
      relayRegistry.registerDevice(device);
      writeStructuredLog({ event: "relay.device.registered-local", deviceId: state.device.id });
    }
    writeAppState({
      ...state,
      remoteAccess: "registered-offline",
      device: { ...state.device, registered: true },
      projectGrants: nextGrants
    });
    const started = startRemoteAccessProcessIfPossible(parsed);
    console.log("Remote Access registered for this signed-in device.");
    console.log(started
      ? "Starting outbound Relay connection."
      : "Remote Access is registered but offline until Bridge can connect to Relay.");
    return;
  }
  if (subcommand === "disable") {
    await revokeRunningBridgePairing();
    relayRegistry.updateDeviceStatus(state.device.id, "offline");
    writeAppState({ ...state, remoteAccess: "off" });
    console.log("Remote Access disabled.");
    return;
  }
  if (subcommand === "check") {
    const command = parsed.rest[1] ?? "health";
    if (!isRelayCommandName(command)) {
      throw new Error(`Unknown Relay command: ${command}`);
    }
    const projectPath = parsed.rest[2] ? resolve(parsed.rest[2]) : undefined;
    const decision = evaluateRelayCommand({
      device: relayRegistry.listDevices().find(device => device.deviceId === state.device.id),
      command: {
        deviceId: state.device.id,
        command,
        projectPath
      },
      projectGrants: state.projectGrants
    });
    if (!decision.ok) {
      throw new Error(decision.message);
    }
    console.log(`Relay command allowed: ${command}`);
    return;
  }
  throw new Error(`Unknown remote command: ${subcommand}`);
}

function serviceCommand(parsed: ParsedArgs): void {
  const subcommand = parsed.rest[0] ?? "status";
  const state = readAppState();
  if (subcommand === "status") {
    console.log(`Service: ${state.service.installed ? `Installed (${state.service.manager})` : "Not installed"}`);
    if (state.service.unitPath) {
      console.log(`Unit: ${state.service.unitPath}`);
    }
    return;
  }
  if (subcommand === "install") {
    const service = installServiceArtifact(parsed);
    writeAppState({
      ...state,
      service: { ...service, installed: true, updatedAt: new Date().toISOString() }
    });
    console.log(`Installed Hunsu Bridge service artifact for ${service.manager}.`);
    if (service.unitPath) {
      console.log(`Unit: ${service.unitPath}`);
    }
    return;
  }
  if (subcommand === "start") {
    runServiceManagerCommand("start", state.service);
    return;
  }
  if (subcommand === "stop") {
    runServiceManagerCommand("stop", state.service);
    return;
  }
  throw new Error(`Unknown service command: ${subcommand}`);
}

function protocolCommand(parsed: ParsedArgs): void {
  const subcommand = parsed.rest[0] ?? "status";
  const commandPath = process.argv[1] ? resolve(process.argv[1]) : "hunsu-bridge";
  if (subcommand === "status") {
    console.log(JSON.stringify(protocolRegistrationPlan(commandPath), null, 2));
    return;
  }
  if (subcommand === "install") {
    const plan = installLinuxProtocolHandler(commandPath);
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  throw new Error(`Unknown protocol command: ${subcommand}`);
}

async function superviseCommand(parsed: ParsedArgs): Promise<void> {
  const cwd = resolve(getFlag(parsed, "cwd") ?? process.cwd());
  const supervisor = new BridgeSidecarSupervisor({
    command: process.execPath,
    args: [...bridgeNodeExecArgs(), process.argv[1] ?? "hunsu-bridge", "daemon", "--cwd", cwd, "--no-open"],
    cwd,
    env: currentProcessEnv(),
    logPath: appLogPath(),
    restartLimit: Number(getFlag(parsed, "restart-limit") ?? 3),
    restartDelayMs: 750
  });
  writeAppState({
    ...readAppState(),
    supervisorPid: process.pid,
    cwd,
    webUrl: getFlag(parsed, "web-url"),
    startedAt: new Date().toISOString()
  });
  supervisor.start();
  console.log("Hunsu Bridge sidecar supervisor started.");
  console.log(JSON.stringify(supervisor.status(), null, 2));
  try {
    await waitForShutdown(async () => {
      await supervisor.stop();
    });
  } finally {
    clearSupervisorProcessState();
  }
}

function projectsCommand(parsed: ParsedArgs): void {
  const subcommand = parsed.rest[0] ?? "list";
  if (subcommand === "list") {
    for (const project of listRoadmapRegistry(roadmapRegistryOptions())) {
      console.log(`${project.displayName}\t${project.health}\t${project.repositoryPath}`);
    }
    return;
  }
  if (subcommand === "remove") {
    const target = parsed.rest[1];
    const explicitRoadmapId = getFlag(parsed, "roadmap-id");
    const explicitPath = getFlag(parsed, "path");
    const inferredPath = target && looksLikeProjectPath(target) ? target : undefined;
    const inferredRoadmapId = target && !looksLikeProjectPath(target) ? target : undefined;
    const roadmapId = explicitRoadmapId ?? inferredRoadmapId;
    const path = explicitPath ?? inferredPath;
    if (!roadmapId && !path) {
      throw new Error("Roadmap ID or project path is required.");
    }
    const result = removeRoadmapRegistryEntry({
      roadmapId,
      path: path ? resolve(path) : undefined
    }, roadmapRegistryOptions());
    console.log(result.removed ? "Removed from recent Roadmaps." : "No matching recent Roadmap was found.");
    return;
  }
  const targetPath = parsed.rest[1] ? resolve(parsed.rest[1]) : undefined;
  if (!targetPath) {
    throw new Error("Project path is required.");
  }
  const state = readAppState();
  if (subcommand === "grant") {
    const scopes = state.remoteAccess !== "off"
      ? uniqueScopeList([...DEFAULT_PROJECT_GRANT_SCOPES, "remoteRelay.access"])
      : [...DEFAULT_PROJECT_GRANT_SCOPES];
    const grant: ProjectGrant = {
      path: targetPath,
      grantedAt: new Date().toISOString(),
      scopes
    };
    writeAppState({
      ...state,
      projectGrants: [grant, ...state.projectGrants.filter(item => item.path !== targetPath)]
    });
    console.log(`Granted project access: ${targetPath}`);
    return;
  }
  if (subcommand === "revoke") {
    writeAppState({
      ...state,
      projectGrants: state.projectGrants.filter(item => item.path !== targetPath)
    });
    console.log(`Revoked project access: ${targetPath}`);
    return;
  }
  throw new Error(`Unknown projects command: ${subcommand}`);
}

function looksLikeProjectPath(value: string): boolean {
  return value.startsWith("/")
    || value.startsWith(".")
    || value.startsWith("~")
    || value.includes("\\")
    || value.includes("/");
}

function printAppStatus(handle: BridgeRuntimeHandle): void {
  const state = readAppState();
  const account = state.account?.status === "signed-in" ? `Signed in as ${state.account.email ?? state.account.userId}` : "Signed out";
  console.log("Hunsu Bridge");
  console.log("");
  console.log("Status:");
  console.log(`  Local Bridge: ${formatRuntimeStatus(handle.status)}`);
  console.log(`  Account: ${account}`);
  console.log(`  Remote Access: ${formatRemoteAccess(state.remoteAccess)}`);
  console.log("");
  console.log("Actions:");
  console.log(`  Open in Studio: ${handle.studioUrl ?? "Unavailable"}`);
  console.log(`  Local API: ${handle.bridgeApiUrl}`);
}

function printProjectInspection(project: ProjectInspection): void {
  console.log("Project Finder");
  console.log(`  Path: ${project.path || "None"}`);
  console.log(`  Type: ${formatProjectKind(project.kind)}`);
  console.log(`  Primary action: ${project.recommendedAction}`);
  if (project.kind === "hunsu-roadmap") {
    console.log(`  Roadmap: ${project.displayName}`);
    console.log(`  Health: ${project.health}`);
  }
  if (project.kind === "git-project") {
    console.log(`  Branch: ${project.branch ?? "unknown"}`);
    console.log(`  Clean: ${project.clean === undefined ? "unknown" : String(project.clean)}`);
  }
  if (project.kind === "unsupported") {
    console.log(`  Problem: ${project.reason}`);
  }
  if (project.kind === "missing-roadmap") {
    console.log(`  Roadmap: ${project.displayName}`);
    console.log(`  Health: ${project.health}`);
    console.log(`  Problem: ${project.reason}`);
  }
  if ("stackHints" in project && project.stackHints.length > 0) {
    console.log(`  Stack: ${project.stackHints.join(", ")}`);
  }
}

function printProjectAction(project: ProjectInspection, roadmapId: string): void {
  console.log(`Project action: ${project.recommendedAction}`);
  console.log(`Roadmap: ${roadmapId}`);
}

function formatRuntimeStatus(status: BridgeRuntimeHandle["status"]): string {
  switch (status) {
    case "running":
      return "Connected";
    case "starting":
      return "Starting";
    case "stopping":
      return "Stopping";
    case "stopped":
      return "Not Running";
    case "error":
      return "Error";
  }
}

function formatProjectKind(kind: ProjectInspection["kind"]): string {
  switch (kind) {
    case "hunsu-roadmap":
      return "Existing Hunsu Roadmap";
    case "git-project":
      return "Git project not yet ported to Hunsu";
    case "new-project":
      return "Empty or new project folder";
    case "missing-roadmap":
      return "Missing or unhealthy Roadmap";
    case "unsupported":
      return "Unsupported folder";
  }
}

async function readBridgeHealth(): Promise<{ ok: true; body: unknown } | { ok: false; error: string }> {
  const runtimeConfig = unwrapConfigResult(resolveBridgeRuntimeConfig(currentProcessEnv(), { cwd: process.cwd() }));
  try {
    const response = await fetch(new URL("/health", endpointUrl(runtimeConfig.bridgeApi)));
    if (!response.ok) {
      return { ok: false, error: `Bridge returned ${response.status}` };
    }
    return { ok: true, body: await response.json() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Bridge is not reachable" };
  }
}

async function readAppSnapshot(): Promise<BridgeAppSnapshot> {
  const state = readAppState();
  const health = await readBridgeHealth();
  const account = state.account?.status === "signed-in" ? `Signed in as ${state.account.email ?? state.account.userId}` : "Signed out";
  const localBridge = health.ok
    ? "connected"
    : state.pid || state.supervisorPid
      ? "starting"
      : "not-running";
  return {
    schema: "hunsu.bridge-app-snapshot.v1",
    status: {
      localBridge,
      account,
      remoteAccess: formatRemoteAccess(state.remoteAccess),
      device: state.device,
      service: state.service,
      supervisorPid: state.supervisorPid,
      pid: state.pid,
      bridgeApiUrl: state.bridgeApiUrl,
      startedAt: state.startedAt,
      healthError: health.ok ? undefined : health.error
    },
    recentProjects: listRoadmapRegistry(roadmapRegistryOptions()).slice(0, 12),
    diagnostics: await buildDiagnostics(),
    logLines: readLogTail(appLogPath(), 80)
  };
}

function rememberRunningBridge(handle: BridgeRuntimeHandle, cwd: string, webUrl: string | undefined): void {
  const state = readAppState();
  writeAppState({
    ...state,
    pid: process.pid,
    bridgeApiUrl: handle.bridgeApiUrl,
    authToken: handle.authToken,
    controlToken: handle.controlToken,
    pairing: handle.pairing,
    cwd,
    webUrl,
    startedAt: handle.startedAt,
    remoteAccess: state.remoteAccess
  });
  writeStructuredLog({ event: "bridge.started", pid: process.pid, cwd, bridgeApiUrl: handle.bridgeApiUrl, startedAt: handle.startedAt });
}

function clearSupervisorProcessState(): void {
  const state = readAppState();
  if (state.supervisorPid === process.pid) {
    writeAppState({
      ...state,
      supervisorPid: undefined
    });
    writeStructuredLog({ event: "bridge.supervisor.stopped", pid: process.pid });
  }
}

function clearManagedProcessState(): void {
  const state = readAppState();
  if (state.pid === process.pid) {
    writeAppState({
      ...state,
      pid: undefined,
      bridgeApiUrl: undefined,
      authToken: undefined,
      controlToken: undefined,
      pairing: undefined,
      startedAt: undefined
    });
    writeStructuredLog({ event: "bridge.stopped", pid: process.pid });
  }
}

function readAppState(): BridgeAppState {
  const statePath = appStatePath();
  if (!existsSync(statePath)) {
    return defaultAppState();
  }
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Partial<BridgeAppState>;
    return {
      ...defaultAppState(),
      ...parsed,
      account: parsed.account ?? { status: "signed-out" },
      device: parsed.device ?? defaultDeviceState(),
      remoteAccess: parseRemoteAccessState(parsed.remoteAccess),
      projectGrants: Array.isArray(parsed.projectGrants) ? parsed.projectGrants : [],
      service: parsed.service ?? defaultServiceState()
    };
  } catch (_error) {
    return defaultAppState();
  }
}

function writeAppState(state: BridgeAppState): void {
  const statePath = appStatePath();
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function defaultAppState(): BridgeAppState {
  return {
    schema: "hunsu.bridge-app-state.v1",
    account: { status: "signed-out" },
    device: defaultDeviceState(),
    remoteAccess: "off",
    projectGrants: [],
    service: defaultServiceState()
  };
}

function defaultDeviceState(): BridgeDeviceState {
  const name = hostname() || "Hunsu Bridge Device";
  return {
    name,
    id: `device_${hashForDevice(name).slice(0, 16)}`,
    registered: false
  };
}

function defaultServiceState(): BridgeServiceState {
  return {
    installed: false,
    manager: defaultServiceManager()
  };
}

function defaultServiceManager(): BridgeServiceState["manager"] {
  const os = platform();
  if (os === "darwin") return "launchd-user";
  if (os === "win32") return "windows-service";
  if (os === "linux") return "systemd-user";
  return "manual";
}

function installServiceArtifact(parsed: ParsedArgs): BridgeServiceState {
  const manager = defaultServiceManager();
  if (manager === "systemd-user") {
    const unitPath = currentProcessEnv().HUNSU_BRIDGE_SERVICE_UNIT_PATH?.trim() || DEFAULT_SYSTEMD_USER_UNIT_PATH;
    const cwd = resolve(getFlag(parsed, "cwd") ?? readAppState().cwd ?? process.cwd());
    mkdirSync(dirname(unitPath), { recursive: true });
    writeFileSync(unitPath, systemdUserUnitText(cwd), "utf8");
    writeStructuredLog({ event: "service.installed", manager, unitPath, cwd });
    console.log("Run `systemctl --user daemon-reload` if your desktop session does not pick up the new unit automatically.");
    return { installed: true, manager, unitPath };
  }
  writeStructuredLog({ event: "service.install-intent", manager });
  return { installed: true, manager };
}

function runServiceManagerCommand(action: "start" | "stop", service: BridgeServiceState): void {
  if (service.manager === "systemd-user") {
    const command = ["systemctl", "--user", action, "hunsu-bridge.service"];
    if (currentProcessEnv().HUNSU_BRIDGE_SERVICE_DRY_RUN === "1" || !commandAvailable("systemctl")) {
      console.log(`Run: ${command.join(" ")}`);
      writeStructuredLog({ event: `service.${action}.dry-run`, manager: service.manager, command: command.join(" ") });
      return;
    }
    try {
      const output = execFileSync(command[0], command.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      console.log(`Hunsu Bridge service ${action} requested through systemd user service.`);
      writeStructuredLog({ event: `service.${action}.completed`, manager: service.manager, command: command.join(" "), output: output.trim() || undefined });
    } catch (error) {
      const message = error instanceof Error ? error.message : `Unable to ${action} systemd user service.`;
      writeStructuredLog({ event: `service.${action}.failed`, manager: service.manager, command: command.join(" "), error: message });
      throw new Error(message);
    }
    return;
  }
  console.log(`Use your OS service manager to ${action} Hunsu Bridge, or run \`hunsu-bridge ${action === "start" ? "start --remote" : "stop"}\`.`);
  writeStructuredLog({ event: `service.${action}.requested`, manager: service.manager });
}

function systemdUserUnitText(cwd: string): string {
  const command = process.argv[1] ? resolve(process.argv[1]) : "hunsu-bridge";
  return [
    "[Unit]",
    "Description=Hunsu Bridge daemon",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${cwd}`,
    `ExecStart=${process.execPath} ${command} supervise --cwd ${cwd}`,
    "Restart=on-failure",
    "RestartSec=2",
    "Environment=HUNSU_BRIDGE_HEADLESS=1",
    "",
    "[Install]",
    "WantedBy=default.target",
    ""
  ].join("\n");
}

function createBridgeAppSidecarSupervisor(parsed: ParsedArgs): BridgeSidecarSupervisor {
  const cwd = resolve(getFlag(parsed, "cwd") ?? process.cwd());
  return new BridgeSidecarSupervisor({
    command: process.execPath,
    args: [
      ...bridgeNodeExecArgs(),
      process.argv[1] ?? "hunsu-bridge",
      "daemon",
      "--cwd",
      cwd,
      ...(getFlag(parsed, "web-url") ? ["--web-url", getFlag(parsed, "web-url") as string] : []),
      ...(hasFlag(parsed, "remote") ? ["--remote"] : []),
      ...(hasFlag(parsed, "no-open") ? ["--no-open"] : [])
    ],
    cwd,
    env: currentProcessEnv(),
    logPath: appLogPath(),
    restartLimit: Number(getFlag(parsed, "restart-limit") ?? 3),
    restartDelayMs: 750
  });
}

function appStatePath(): string {
  return currentProcessEnv().HUNSU_BRIDGE_APP_STATE_PATH?.trim() || DEFAULT_APP_STATE_PATH;
}

function bridgeNodeExecArgs(): string[] {
  return process.execArgv.filter(arg => !arg.startsWith("--inspect"));
}

function credentialPath(): string {
  return currentProcessEnv().HUNSU_BRIDGE_CREDENTIAL_PATH?.trim() || DEFAULT_CREDENTIAL_PATH;
}

function relayRegistryPath(): string {
  return currentProcessEnv().HUNSU_RELAY_REGISTRY_PATH?.trim() || DEFAULT_RELAY_REGISTRY_PATH;
}

function appLogPath(): string {
  return currentProcessEnv().HUNSU_BRIDGE_APP_LOG_PATH?.trim() || DEFAULT_APP_LOG_PATH;
}

function roadmapRegistryOptions(): { roadmapRegistryPath?: string } {
  try {
    return {
      roadmapRegistryPath: unwrapConfigResult(resolveBridgeRuntimeConfig(currentProcessEnv(), { cwd: process.cwd() })).roadmapRegistryPath
    };
  } catch (_error) {
    return {};
  }
}

function writeStructuredLog(value: Record<string, unknown>): void {
  const path = appLogPath();
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify({ ...value, at: new Date().toISOString() })}\n`, "utf8");
}

async function authDevServerCommand(parsed: ParsedArgs): Promise<void> {
  const server = await startLocalDevAuthServer({
    userId: getFlag(parsed, "user") ?? "local-dev@example.test",
    email: getFlag(parsed, "email") ?? getFlag(parsed, "user") ?? "local-dev@example.test"
  });
  console.log(`Hunsu local-dev auth provider: ${server.authBaseUrl}`);
  console.log(`Run: hunsu-bridge login --auth-url ${server.authBaseUrl}`);
  await waitForShutdown(server.close);
}

function readLogTail(path: string, maxLines: number): string[] {
  if (!existsSync(path)) {
    return [];
  }
  try {
    return readFileSync(path, "utf8").trimEnd().split("\n").slice(-maxLines);
  } catch (_error) {
    return [];
  }
}

function credentialsForDevUser(userId: string, state: BridgeAppState): BridgeAccountCredentials {
  return {
    schema: "hunsu.bridge-credentials.v1",
    accessToken: `dev_access_${hashForDevice(`${userId}:access`)}`,
    refreshToken: `dev_refresh_${hashForDevice(`${userId}:refresh`)}`,
    userId,
    email: userId.includes("@") ? userId : undefined,
    deviceId: state.device.id,
    deviceName: state.device.name,
    savedAt: new Date().toISOString()
  };
}

function hashForDevice(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
  }
  return Math.abs(hash).toString(16).padStart(8, "0");
}

async function waitForShutdown(stop: () => Promise<void>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const shutdown = () => {
      stop().then(resolve, reject);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | boolean>();
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith("--")) {
      const [name, inlineValue] = arg.slice(2).split("=", 2);
      if (inlineValue !== undefined) {
        flags.set(name, inlineValue);
        continue;
      }
      const next = argv[index + 1];
      if (next && !next.startsWith("-")) {
        flags.set(name, next);
        index += 1;
      } else {
        flags.set(name, true);
      }
      continue;
    }
    rest.push(arg);
  }
  const [command = "start", ...commandRest] = rest;
  return {
    command,
    rest: commandRest,
    flags
  };
}

function numericFlag(parsed: ParsedArgs, name: string): number | undefined {
  const value = getFlag(parsed, name);
  if (value === undefined) {
    return undefined;
  }
  const parsedNumber = Number(value);
  if (!Number.isFinite(parsedNumber) || parsedNumber < 1) {
    throw new Error(`Invalid --${name}: ${value}`);
  }
  return parsedNumber;
}

export function normalizeBridgeAppArgv(argv: string[]): string[] {
  const [first, ...rest] = argv;
  if (!first?.startsWith("hunsu://")) {
    return argv;
  }
  const url = new URL(first);
  const action = url.hostname || url.pathname.replace(/^\/+/, "");
  const pathFromUrl = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  const nextArgs: string[] = [];
  switch (action) {
    case "open":
      nextArgs.push("status");
      break;
    case "open-project": {
      nextArgs.push("open-project");
      const path = url.searchParams.get("path") ?? (pathFromUrl && pathFromUrl !== "open-project" ? pathFromUrl : undefined);
      if (path) nextArgs.push(path);
      break;
    }
    case "pair":
      if (url.searchParams.has("code") && url.searchParams.has("state")) {
        nextArgs.push("auth-callback", "--code", url.searchParams.get("code") ?? "", "--state", url.searchParams.get("state") ?? "");
      } else {
        nextArgs.push("pair");
        if (url.searchParams.has("next")) nextArgs.push("--next", url.searchParams.get("next") ?? "/studio");
      }
      break;
    case "open-roadmap":
      nextArgs.push("open-roadmap");
      if (url.searchParams.has("roadmapId")) nextArgs.push("--roadmap-id", url.searchParams.get("roadmapId") ?? "");
      break;
    case "remote-disable":
      nextArgs.push("remote", "disable");
      break;
    case "sign-in":
      nextArgs.push("login", "--gui");
      break;
    case "sign-out":
      nextArgs.push("logout");
      break;
    default:
      nextArgs.push("status");
      break;
  }
  return [...nextArgs, ...rest];
}

function getFlag(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function hasFlag(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags.get(name) === true;
}

function printHelp(): void {
  console.log(`Hunsu Bridge

Usage:
  hunsu-bridge start [--cwd <path>] [--web-url <url>] [--no-open] [--remote]
  hunsu-bridge pair [--next /studio] [--web-url <url>]
  hunsu-bridge open-project <path>
  hunsu-bridge open-roadmap <roadmap-id>
  hunsu-bridge choose-folder
  hunsu-bridge inspect <path>
  hunsu-bridge status
  hunsu-bridge stop
  hunsu-bridge diagnostics

Headless:
  hunsu-bridge login
  hunsu-bridge login --auth-url <url>
  hunsu-bridge login --local-dev --auto-approve
  hunsu-bridge login --gui
  hunsu-bridge logout
  hunsu-bridge remote status|enable|disable|devices|check
  hunsu-bridge protocol status|install
  hunsu-bridge supervise [--cwd <path>]
  hunsu-bridge service install|start|stop|status
  hunsu-bridge auth-dev-server
  hunsu-bridge projects list
  hunsu-bridge projects grant <path>
  hunsu-bridge projects revoke <path>
  hunsu-bridge projects remove --roadmap-id <id>

Deep links:
  hunsu://open
  hunsu://pair?next=/studio
  hunsu://open-project?path=/path/to/project
  hunsu://open-roadmap?roadmapId=<id>
`);
}

if (isBridgeAppEntrypoint()) {
  main().then(code => {
    process.exitCode = code;
  });
}

function isBridgeAppEntrypoint(): boolean {
  return isSea() || import.meta.url === `file://${process.argv[1]}`;
}

function studioWebUrlForNext(webUrl: string | undefined, next: string): string {
  const base = new URL(resolveStudioBridgeWebUrl(webUrl, currentProcessEnv()));
  const safeNextPath = safeStudioNext(next);
  const nextUrl = new URL(safeNextPath, base.origin);
  base.pathname = nextUrl.pathname;
  base.search = nextUrl.search;
  base.hash = nextUrl.hash;
  return base.toString();
}

function safeStudioNext(next: string): string {
  if (!next.startsWith("/studio") || next.startsWith("//")) {
    return "/studio";
  }
  return next;
}

async function enableRemoteAccessIfSignedIn(): Promise<void> {
  const state = readAppState();
  if (state.account?.status !== "signed-in") {
    writeAppState({ ...state, remoteAccess: "unavailable" });
    return;
  }
  const nextGrants = state.projectGrants.map(grant => ({
    ...grant,
    scopes: grant.scopes.includes("remoteRelay.access") ? grant.scopes : uniqueScopeList([...grant.scopes, "remoteRelay.access"])
  }));
  const device = {
    deviceId: state.device.id,
    deviceName: state.device.name,
    userId: state.account.userId,
    bridgeVersion: bridgeVersionInfo().bridgeVersion,
    bridgeAppVersion: HUNSU_BRIDGE_APP_VERSION,
    protocolVersion: bridgeVersionInfo().protocolVersion
  };
  const credentials = createDefaultCredentialStore({ path: credentialPath() }).read();
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
      projectGrants: nextGrants
    });
    writeStructuredLog({ event: "relay.device.registered", relayApiUrl: relayConfig.relayApiUrl, deviceId: state.device.id });
  } else {
    const relayRegistry = new FileRelayRegistry(relayRegistryPath());
    relayRegistry.registerDevice(device);
    writeStructuredLog({ event: "relay.device.registered-local", deviceId: state.device.id });
  }
  writeAppState({
    ...state,
    remoteAccess: "registered-offline",
    device: { ...state.device, registered: true },
    projectGrants: nextGrants
  });
}

function startRelayIfConfigured(handle: Pick<BridgeRuntimeHandle, "bridgeApiUrl" | "authToken">): RelayOutboundClient | undefined {
  const state = readAppState();
  const relayConfig = unwrapConfigResult(resolveRelayClientConfig(currentProcessEnv()));
  const credentials = createDefaultCredentialStore({ path: credentialPath() }).read();
  const relayUrl = relayConfig.relayWsUrl;
  if (!relayUrl || state.account?.status !== "signed-in" || !credentials) {
    writeStructuredLog({ event: "relay.not-started", reason: relayUrl ? credentials ? "signed-out" : "credentials-missing" : "relay-url-missing" });
    return undefined;
  }
  const device = {
    deviceId: state.device.id,
    deviceName: state.device.name,
    userId: state.account.userId,
    registeredAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    status: "online" as const,
    bridgeVersion: bridgeVersionInfo().bridgeVersion,
    bridgeAppVersion: HUNSU_BRIDGE_APP_VERSION,
    protocolVersion: bridgeVersionInfo().protocolVersion
  };
  const relayClient = new RelayOutboundClient({
    relayUrl,
    accessToken: credentials.accessToken,
    device,
    projectGrants: state.projectGrants,
    bridgeApiUrl: handle.bridgeApiUrl,
    bridgeAuthToken: handle.authToken
  });
  relayClient.start();
  writeStructuredLog({ event: "relay.started", relayUrl, deviceId: state.device.id });
  return relayClient;
}

async function attachRemoteAccessCommand(): Promise<void> {
  const state = readAppState();
  if (state.account?.status !== "signed-in") {
    writeAppState({ ...state, remoteAccess: "unavailable" });
    throw new Error("Remote Access is unavailable until this device is signed in.");
  }
  if (!state.bridgeApiUrl || !state.authToken) {
    writeAppState({ ...state, remoteAccess: "registered-offline" });
    throw new Error("No running managed Bridge is available for Relay attachment.");
  }
  const relayClient = startRelayIfConfigured({
    bridgeApiUrl: state.bridgeApiUrl,
    authToken: state.authToken
  });
  if (!relayClient) {
    writeRemoteAccessState("registered-offline");
    console.log("Remote Access is registered but offline because Relay is not configured.");
    return;
  }
  const connected = await waitForRelayConnection(relayClient);
  writeRemoteAccessState(connected ? "on" : "registered-offline");
  console.log(connected ? "Remote Access is On." : "Remote Access is registered but offline.");
  await waitForShutdown(async () => {
    relayClient.stop();
    new FileRelayRegistry(relayRegistryPath()).updateDeviceStatus(state.device.id, "offline");
    writeRemoteAccessState("registered-offline");
  });
}

function startRemoteAccessProcessIfPossible(parsed: ParsedArgs): boolean {
  if (hasFlag(parsed, "no-start") || currentProcessEnv().HUNSU_BRIDGE_REMOTE_ENABLE_NO_START === "1") {
    return false;
  }
  const state = readAppState();
  const relayConfig = unwrapConfigResult(resolveRelayClientConfig(currentProcessEnv()));
  const credentials = createDefaultCredentialStore({ path: credentialPath() }).read();
  if (!relayConfig.relayWsUrl || !credentials || state.account?.status !== "signed-in") {
    return false;
  }
  const cwd = resolve(getFlag(parsed, "cwd") ?? state.cwd ?? process.cwd());
  const args = state.bridgeApiUrl && state.authToken
    ? ["remote", "attach"]
    : [
        "daemon",
        "--remote",
        "--no-open",
        "--cwd",
        cwd,
        ...(getFlag(parsed, "web-url") ? ["--web-url", getFlag(parsed, "web-url") as string] : [])
      ];
  try {
    const child = spawn(process.execPath, [
      ...bridgeNodeExecArgs(),
      process.argv[1] ?? "hunsu-bridge",
      ...args
    ], {
      cwd,
      env: currentProcessEnv(),
      detached: true,
      stdio: "ignore"
    });
    child.unref();
    writeStructuredLog({ event: "relay.process.started", pid: child.pid, args });
    writeAppState({
      ...readAppState(),
      pid: child.pid,
      cwd,
      remoteAccess: "registered-offline"
    });
    return true;
  } catch (error) {
    writeStructuredLog({ event: "relay.process.start-failed", error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

async function waitForRelayConnection(client: RelayOutboundClient, timeoutMs = 2_000): Promise<boolean> {
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

function writeRemoteAccessState(remoteAccess: BridgeAppState["remoteAccess"]): void {
  const state = readAppState();
  writeAppState({ ...state, remoteAccess });
}

function parseRemoteAccessState(value: unknown): BridgeAppState["remoteAccess"] {
  return value === "on" || value === "registered-offline" || value === "unavailable" || value === "off"
    ? value
    : "off";
}

function formatRemoteAccess(value: BridgeAppState["remoteAccess"]): BridgeAppSnapshot["status"]["remoteAccess"] {
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

async function openStudioManagedUrl(url: string): Promise<void> {
  openStudioInBrowser(url);
}

function nonEmptyFlagValue(value: string | undefined): string | undefined {
  return value?.trim() ? value.trim() : undefined;
}

function uniqueScopeList(scopes: BridgeCommandScope[]): BridgeCommandScope[] {
  return [...new Set(scopes)];
}

function commandAvailable(command: string): boolean {
  const result = spawnSync(command, ["--version"], { stdio: "ignore", windowsHide: true });
  return result.status === 0 || result.status === 1;
}

function isRelayCommandName(value: string): value is RelayCommandName {
  return [
    "health",
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

export { main };
