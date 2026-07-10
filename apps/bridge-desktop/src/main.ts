#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isSea } from "node:sea";
import { fileURLToPath } from "node:url";
import {
  startLocalDevAuthServer,
  type BridgeAccountCredentials
} from "./auth.ts";
import {
  chooseNativeFolder,
  installLinuxProtocolHandler,
  protocolRegistrationPlan
} from "./native-shell.ts";
import { normalizeBridgeAppArgv } from "./ui-intents/deepLinks.ts";
import {
  parseCodexAuthenticationPreference,
  parseCodexInstallChannel,
  providerStatusSummary,
  runProviderCommand
} from "./commands/providerCommands.ts";
import {
  reconcileCodexLoginFromStatus,
  runCodexApiKeyLoginCli as runCodexApiKeyLoginCliAction,
  runCodexChatGptLoginCli as runCodexChatGptLoginCliAction,
  runCodexCli as runCodexCliAction,
  runCodexCommand,
  runCodexDeviceLoginCli as runCodexDeviceLoginCliAction
} from "./commands/codexCommands.ts";
import { runAuthCallbackCommand, runLoginCommand, runLogoutCommand } from "./commands/authCommands.ts";
import {
  buildDiagnostics,
  currentNodeRuntimeStatus,
  packageManagerStatus,
  runDiagnosticsCommand,
  toolStatus
} from "./commands/diagnosticsCommands.ts";
import {
  activeManagedProjectGrantsForRoadmaps,
  projectGrantsWithRemoteRelay,
  projectGrantsWithoutRemoteRelay,
  roadmapAccessSnapshots,
  runProjectsCommand,
  runRoadmapsCommand,
  snapshotProjectGrants
} from "./commands/workspaceCommands.ts";
import {
  enableRemoteAccessIfSignedIn,
  localBridgeStatusFromProcessState,
  publishProjectGrantsToRelay,
  runRemoteCommand,
  startRelayIfConfigured,
  waitForRelayConnection,
  writeRemoteAccessState
} from "./commands/connectionCommands.ts";
import {
  BRIDGE_PROCESS_NONCE_ENV,
  bridgeNodeExecArgs,
  bridgeProcessRuntimeMetadata,
  commandLineLooksLikeBridgeApp,
  createBridgeAppSidecarSupervisor as createBridgeAppSidecarSupervisorFromProcess,
  currentBridgeCommandInvocation,
  currentBridgeProcessCommandIdentity,
  handleToRuntimeState,
  processCommandLine,
  processEnvironmentValue,
  processIsAlive,
  processStartMetadata,
  sameProcessStartMetadata
} from "./processes/backgroundSpawn.ts";
import {
  canonicalBridgeUiIntentTab,
  bridgeAppStatePath as appStatePath,
  createBridgeAppSnapshot,
  defaultBridgeServiceManager,
  formatBridgeRemoteAccess,
  hashBridgeDeviceSeed,
  isBridgeUiIntentTab,
  parseBridgeQuitBehavior,
  readBridgeAppState as readAppState,
  recordBridgeUiIntent,
  writeBridgeAppState as writeAppState,
  type BridgeAppSnapshot,
  type BridgeAppState,
  type BridgeProcessCommandIdentity,
  type BridgeQuitBehavior,
  type BridgeProcessRuntimeMetadata,
  type BridgeRoadmapAccessSnapshot,
  type BridgeServiceState,
  type BridgeUiIntent,
  bridgeCodexProviderSettings
} from "./state/appState.ts";
import {
  type BridgeCommandScope,
  type ProjectGrant,
  type RelayCommandName
} from "./relay.ts";
import {
  applyStudioPort,
  createBridgeSupervisor,
  createRuntimeProviderRegistry,
  createStudioRoadmap,
  createStudioState,
  codexEffectiveEnvSummary,
  codexProviderEnv,
  getCodexRuntimeStatus,
  defaultModelAliases,
  modelSelectionResolutionFromInventoryError,
  providerInventoryForBridgeStatus,
  resolveModelSelection,
  inspectProject,
  listManagedRoadmapRegistry,
  listRoadmapRegistry,
  openStudioInBrowser,
  openStudioRoadmap,
  removeRoadmapRegistryEntry,
  resolveRoadmapRepositoryPath,
  resolveStudioBridgeWebUrl,
  sanitizeDiagnostics,
  setRoadmapLifecycle,
  setRoadmapRemoteAccess,
  type BridgePairingSession,
  type DirectProviderModelSelection,
  type RuntimeProviderStatus,
  type BridgeRuntimeHandle,
  type ProjectInspection,
  type ModelAlias,
  type ModelAliasOverride
} from "@hunsu/bridge";
import { currentProcessEnv, endpointUrl, resolveBridgeRuntimeConfig, unwrapConfigResult } from "@hunsu/config";

type ParsedArgs = {
  command: string;
  rest: string[];
  flags: Map<string, string | boolean>;
};

const DEFAULT_CREDENTIAL_PATH = join(homedir(), ".config", "hunsu", "bridge-credentials.json");
const DEFAULT_RELAY_REGISTRY_PATH = join(homedir(), ".config", "hunsu", "relay-devices.json");
const DEFAULT_APP_LOG_PATH = join(homedir(), ".cache", "hunsu", "bridge-app.log");
const DEFAULT_SYSTEMD_USER_UNIT_PATH = join(homedir(), ".config", "systemd", "user", "hunsu-bridge.service");
const DEFAULT_LAUNCHD_USER_PLIST_PATH = join(homedir(), "Library", "LaunchAgents", "app.hunsu.bridge.plist");
const WINDOWS_USER_TASK_NAME = "Hunsu Bridge";
const PROJECT_GRANT_SCOPE_VALUES = ["execute.start", "artifactAction.run", "env.read", "hostAlias.expose", "remoteRelay.access"] as const satisfies readonly BridgeCommandScope[];
const DEFAULT_PROJECT_GRANT_SCOPES: BridgeCommandScope[] = ["execute.start", "artifactAction.run", "env.read", "hostAlias.expose"];
const HUNSU_BRIDGE_APP_VERSION = "0.1.0";
const BRIDGE_STARTING_GRACE_MS = 15_000;

async function main(argv = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(normalizeBridgeAppArgv(argv));
  try {
    if (parsed.flags.has("version")) {
      console.log(`Hunsu Bridge ${HUNSU_BRIDGE_APP_VERSION}`);
      return 0;
    }
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
        await runDiagnosticsCommand(diagnosticsCommandContext());
        return 0;
      case "snapshot":
        await snapshotCommand();
        return 0;
      case "prerequisites":
        await prerequisitesCommand(parsed);
        return 0;
      case "codex":
        await codexCommand(parsed);
        return 0;
      case "provider":
        await providerCommand(parsed);
        return 0;
      case "login":
        await runLoginCommand(parsed, authCommandContext());
        return 0;
      case "auth-callback":
        await runAuthCallbackCommand(parsed, authCommandContext());
        return 0;
      case "logout":
        runLogoutCommand(authCommandContext());
        return 0;
      case "remote":
        await remoteCommand(parsed);
        return 0;
      case "protocol":
        protocolCommand(parsed);
        return 0;
      case "settings":
        settingsCommand(parsed);
        return 0;
      case "service":
        serviceCommand(parsed);
        return 0;
      case "model-alias":
        await modelAliasCommand(parsed);
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
        await projectsCommand(parsed);
        return 0;
      case "roadmaps":
        await roadmapsCommand(parsed);
        return 0;
      case "activate-roadmap":
        activateRoadmapIntentCommand(parsed);
        return 0;
      case "ui-intent":
        uiIntentCommand(parsed);
        return 0;
      case "protocol-error":
        throw new Error(parsed.rest[0] ?? "Unsupported hunsu:// URL.");
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
  const cwd = resolve(getFlag(parsed, "cwd") ?? process.cwd());
  const state = readAppState();
  const supervisor = createBridgeAppSidecarSupervisorFromProcess({
    cwd,
    webUrl: getFlag(parsed, "web-url"),
    remote: hasFlag(parsed, "remote"),
    noOpen: hasFlag(parsed, "no-open"),
    restartLimit: Number(getFlag(parsed, "restart-limit") ?? 3),
    appLogPath: appLogPath(),
    state,
    activeProjectGrants: activeManagedProjectGrants(state.projectGrants)
  });
  const commandIdentity = currentBridgeProcessCommandIdentity("start");
  writeAppState({
    ...state,
    supervisorPid: process.pid,
    supervisorProcess: bridgeProcessRuntimeMetadata(process.pid, commandIdentity),
    processNonce: commandIdentity.nonce,
    commandIdentity,
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
  let relayClient: Awaited<ReturnType<typeof startRelayIfConfigured>> | undefined;
  if (remote) {
    const remoteContext = remoteAccessRuntimeContext();
    await enableRemoteAccessIfSignedIn(remoteContext);
    relayClient = await startRelayIfConfigured(handle, remoteContext);
    writeRemoteAccessState(relayClient && await waitForRelayConnection(relayClient) ? "on" : "registered-offline", remoteContext);
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
  console.log(`  Quit Behavior: ${formatQuitBehavior(snapshot.status.quitBehavior)}`);
  console.log("");
  console.log("Provider:");
  console.log(`  ${snapshot.providers.current.label}: ${providerStatusSummary(snapshot.providers.current)}`);
  console.log(`  Git: ${snapshot.prerequisites.tools.git.installed ? "Ready" : "Missing"}`);
  console.log(`  Node: ${snapshot.prerequisites.tools.node.installed ? "Ready" : "Missing"}`);
  console.log("");
  const activeRoadmaps = snapshot.managedRoadmaps.filter(roadmap => roadmap.lifecycle === "active");
  const inactiveRoadmaps = snapshot.managedRoadmaps.filter(roadmap => roadmap.lifecycle !== "active");
  console.log("Active Workspaces:");
  for (const roadmap of activeRoadmaps) {
    console.log(`  ${roadmap.displayName}`);
    console.log(`    ${roadmap.repositoryPath}`);
    console.log(`    Provider: ${roadmap.provider.label} ${roadmap.provider.readyForExecute ? "Ready" : "Not Ready"}`);
    console.log(`    Remote Access: ${roadmap.remoteAccess.enabled ? "On" : "Off"}`);
  }
  if (activeRoadmaps.length === 0) {
    console.log("  None");
  }
  console.log("");
  console.log("Inactive Workspaces:");
  for (const roadmap of inactiveRoadmaps) {
    console.log(`  ${roadmap.displayName}`);
    console.log(`    ${roadmap.repositoryPath}`);
  }
  if (inactiveRoadmaps.length === 0) {
    console.log("  None");
  }
  console.log("");
  console.log("Actions:");
  console.log("  Open in Studio");
  console.log("  Start Bridge");
  console.log("  Stop Bridge");
  console.log("  Copy Diagnostics");
}

function codexStatusLabel(codex: Awaited<ReturnType<typeof getCodexRuntimeStatus>>): string {
  if (codex.ready) return "Ready";
  if (!codex.cli.installed) return "Missing";
  if (codex.auth.state === "not_authenticated" || codex.auth.state === "expired" || codex.auth.state === "invalid") return "Login required";
  if (codex.usage.rateLimited) return "Rate limited";
  return "Not Ready";
}

async function stopCommand(): Promise<void> {
  const state = readAppState();
  const controlStop = await stopBridgeThroughControlEndpoint(state);
  if (controlStop.ok) {
    for (const targetPid of uniqueNumberList([state.supervisorPid, state.pid])) {
      const verification = verifyManagedBridgePid(targetPid, state);
      if (verification.ok) {
        try {
          process.kill(targetPid, "SIGTERM");
        } catch (error) {
          writeStructuredLog({
            event: "bridge.stop.post-control-signal-failed",
            pid: targetPid,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }
    writeAppState(clearBridgeProcessRuntimeState(readAppState()));
    console.log("Hunsu Bridge stopped.");
    return;
  }
  const targetPids = uniqueNumberList([state.supervisorPid, state.pid]);
  if (targetPids.length === 0) {
    console.log("Hunsu Bridge is not managed by this Bridge App process.");
    return;
  }
  let stopped = false;
  let stopError: unknown;
  let verifiedAny = false;
  for (const targetPid of targetPids) {
    const verification = verifyManagedBridgePid(targetPid, state);
    if (!verification.ok) {
      writeStructuredLog({ event: "bridge.stop.pid-verification-failed", pid: targetPid, reason: verification.reason });
      continue;
    }
    verifiedAny = true;
    try {
      process.kill(targetPid, "SIGTERM");
      stopped = true;
      break;
    } catch (error) {
      stopError = error;
    }
  }
  writeAppState(clearBridgeProcessRuntimeState(state));
  if (!verifiedAny) {
    console.log("Removed stale Hunsu Bridge process state. No PID was terminated.");
    return;
  }
  if (!stopped) {
    throw new Error(stopError instanceof Error ? stopError.message : "Unable to stop Hunsu Bridge.");
  }
  console.log("Hunsu Bridge stopped.");
}

function diagnosticsCommandContext() {
  return {
    appStatePath,
    appLogPath,
    credentialPath,
    relayRegistryPath,
    readState: readAppState,
    readBridgeHealth,
    snapshotProjectGrants,
    activeManagedProjectGrants,
    roadmapRegistryOptions,
    safeCodexDiagnostics,
    cwd: () => process.cwd()
  };
}

async function snapshotCommand(): Promise<void> {
  console.log(JSON.stringify(await readAppSnapshot(), null, 2));
}

async function prerequisitesCommand(parsed: ParsedArgs): Promise<void> {
  const action = parsed.rest[0] ?? "status";
  if (action !== "status") {
    throw new Error("Usage: hunsu-bridge prerequisites status");
  }
  const codex = await getCodexRuntimeStatus({ env: codexProbeEnv(), force: true });
  if (hasFlag(parsed, "json")) {
    console.log(JSON.stringify({ runtimes: { codex } }, null, 2));
    return;
  }
  printCodexStatus(codex);
}

async function codexCommand(parsed: ParsedArgs): Promise<void> {
  await runCodexCommand(parsed, {
    hasFlag,
    getFlag,
    resolvePath: path => resolve(path),
    getCodexStatus: getCodexRuntimeStatus,
    codexProbeEnv,
    reconcileCodexLoginFromStatus: codex => reconcileCodexLoginFromStatus(codex, codexCliActionContext()),
    runCodexInstallCli,
    providerStatusSummary,
    runCodexApiKeyLoginCli: () => runCodexApiKeyLoginCliAction(codexCliActionContext()),
    runCodexDeviceLoginCli: options => runCodexDeviceLoginCliAction(options, codexCliActionContext()),
    runCodexChatGptLoginCli: () => runCodexChatGptLoginCliAction(codexCliActionContext()),
    runCodexCli: args => runCodexCliAction(args, codexCliActionContext()),
    readState: readAppState,
    writeState: writeAppState,
    parseInstallChannel: parseCodexInstallChannel,
    parseAuthenticationPreference: parseCodexAuthenticationPreference,
    printCodexStatus
  });
}

async function providerCommand(parsed: ParsedArgs): Promise<void> {
  await runProviderCommand(parsed, {
    hasFlag,
    getFlag,
    providerRegistry: createBridgeDesktopRuntimeProviderRegistry
  });
}

async function modelAliasCommand(parsed: ParsedArgs): Promise<void> {
  const subcommand = parsed.rest[0] ?? "list";
  const state = readAppState();
  const aliases = modelAliasesForState(state);
  if (subcommand === "list") {
    printModelAliases(aliases, hasFlag(parsed, "json"));
    return;
  }
  if (subcommand === "get") {
    const aliasId = requiredModelAliasId(parsed, 1);
    const alias = aliases.find(candidate => candidate.aliasId === aliasId);
    if (!alias) {
      throw new Error(`Unknown model alias: ${aliasId}`);
    }
    console.log(JSON.stringify(alias, null, 2));
    return;
  }
  if (subcommand === "set") {
    const aliasId = requiredModelAliasId(parsed, 1);
    const now = new Date().toISOString();
    const existing = aliases.find(alias => alias.aliasId === aliasId);
    const nextAlias = modelAliasFromArgs(parsed, existing, aliasId, now);
    const nextAliases = [...aliases.filter(alias => alias.aliasId !== aliasId), nextAlias].sort(compareModelAlias);
    writeAppState({ ...state, modelAliases: nextAliases });
    console.log(`Saved model alias ${aliasId}.`);
    return;
  }
  if (subcommand === "delete") {
    const aliasId = requiredModelAliasId(parsed, 1);
    writeAppState({ ...state, modelAliases: aliases.filter(alias => alias.aliasId !== aliasId) });
    console.log(`Deleted model alias ${aliasId}.`);
    return;
  }
  if (subcommand === "validate") {
    const aliasId = parsed.rest[1];
    const selection = aliasId ? { kind: "alias" as const, aliasId: aliasId as ModelAlias["aliasId"] } : undefined;
    const result = await validateModelAliasSelection(selection, aliases, state.modelAliasOverrides);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    console.log(`Valid: ${result.resolved.providerId}/${result.resolved.model}`);
    return;
  }
  if (subcommand === "override") {
    const aliasId = requiredModelAliasId(parsed, 1);
    const backendId = getFlag(parsed, "backend") ?? getFlag(parsed, "backend-id");
    if (!backendId) {
      throw new Error("Usage: hunsu-bridge model-alias override <aliasId> --backend <backendId> --model <model> [--reasoning <effort>] [--service-tier default|fast]");
    }
    const now = new Date().toISOString();
    const alias = aliases.find(candidate => candidate.aliasId === aliasId);
    if (!alias) {
      throw new Error(`Unknown model alias: ${aliasId}`);
    }
    const override: ModelAliasOverride = {
      aliasId: aliasId as ModelAliasOverride["aliasId"],
      backendId: backendId as ModelAliasOverride["backendId"],
      selection: modelAliasFromArgs(parsed, alias, aliasId, now).selection,
      reason: getFlag(parsed, "reason") as ModelAliasOverride["reason"],
      updatedAt: now
    };
    writeAppState({
      ...state,
      modelAliases: aliases,
      modelAliasOverrides: [
        ...(state.modelAliasOverrides ?? []).filter(candidate => candidate.aliasId !== aliasId || candidate.backendId !== backendId),
        override
      ]
    });
    console.log(`Saved ${aliasId} override for ${backendId}.`);
    return;
  }
  throw new Error(`Unknown model-alias command: ${subcommand}`);
}

function modelAliasesForState(state: BridgeAppState): ModelAlias[] {
  const aliases = state.modelAliases.length
    ? state.modelAliases
    : defaultModelAliases(new Date().toISOString()).map(localScopedModelAlias);
  return aliases.map(normalizeModelAliasScope);
}

function normalizeModelAliasScope(alias: ModelAlias): ModelAlias {
  if (typeof alias.scope === "object" && alias.scope !== null && "kind" in alias.scope) {
    return alias;
  }
  return { ...alias, scope: { kind: "local" } };
}

function localScopedModelAlias(alias: ModelAlias): ModelAlias {
  return { ...alias, scope: { kind: "local" } };
}

function requiredModelAliasId(parsed: ParsedArgs, index: number): string {
  const aliasId = parsed.rest[index]?.trim();
  if (!aliasId) {
    throw new Error("Usage: hunsu-bridge model-alias list|get|set|delete|validate|override");
  }
  return aliasId;
}

function modelAliasFromArgs(parsed: ParsedArgs, existing: ModelAlias | undefined, aliasId: string, now: string): ModelAlias {
  const model = getFlag(parsed, "model") ?? existing?.selection.provider.model;
  if (!model) {
    throw new Error("Missing --model for model alias.");
  }
  const displayName = getFlag(parsed, "display-name") ?? existing?.displayName ?? aliasId;
  const experimental = hasFlag(parsed, "experimental")
    ? true
    : existing?.selection.provider.experimental === true
      ? true
      : undefined;
  return {
    aliasId: aliasId as ModelAlias["aliasId"],
    displayName: displayName as ModelAlias["displayName"],
    description: getFlag(parsed, "description") as ModelAlias["description"],
    selection: {
      kind: "direct",
      provider: {
        providerId: "codex",
        model: model as ModelAlias["aliasId"],
        reasoningEffort: (getFlag(parsed, "reasoning") ?? getFlag(parsed, "reasoning-effort") ?? existing?.selection.provider.reasoningEffort ?? "default") as ModelAlias["selection"]["provider"]["reasoningEffort"],
        serviceTier: (getFlag(parsed, "service-tier") ?? existing?.selection.provider.serviceTier ?? "default") as ModelAlias["selection"]["provider"]["serviceTier"],
        ...(experimental ? { experimental } : {})
      } as DirectProviderModelSelection
    },
    scope: { kind: "local" },
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };
}

async function validateModelAliasSelection(
  selection: { kind: "alias"; aliasId: ModelAlias["aliasId"] } | undefined,
  aliases: ModelAlias[],
  overrides: ModelAliasOverride[] | undefined
) {
  const snapshot = await runtimeProvidersSnapshot();
  const inventoryResult = providerInventoryForBridgeStatus({ provider: snapshot.current });
  if (!inventoryResult.ok) {
    return modelSelectionResolutionFromInventoryError(inventoryResult.error);
  }
  return resolveModelSelection({
    selection,
    aliases,
    overrides,
    backendId: inventoryResult.value.backendId,
    inventories: inventoryResult.value.providers
  });
}

function printModelAliases(aliases: ModelAlias[], json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ aliases }, null, 2));
    return;
  }
  for (const alias of aliases) {
    const provider = alias.selection.provider;
    console.log(`${alias.aliasId}: ${alias.displayName}`);
    console.log(`  ${provider.providerId}/${provider.model} reasoning=${provider.reasoningEffort ?? "default"} serviceTier=${provider.serviceTier ?? "default"}`);
    console.log(`  scope=${alias.scope.kind}${alias.selection.provider.experimental ? " experimental" : ""}`);
  }
}

function compareModelAlias(left: ModelAlias, right: ModelAlias): number {
  return String(left.aliasId).localeCompare(String(right.aliasId));
}

async function roadmapsCommand(parsed: ParsedArgs): Promise<void> {
  await runRoadmapsCommand(parsed, workspaceCommandContext());
}

function workspaceCommandContext() {
  return {
    hasFlag,
    getFlag,
    resolvePath: (path: string) => resolve(path),
    basename,
    readState: readAppState,
    writeState: writeAppState,
    createStudioState,
    runtimeProvidersSnapshot,
    roadmapRegistryOptions,
    listManagedRoadmaps: listManagedRoadmapRegistry,
    listRecentRoadmaps: listRoadmapRegistry,
    inspectProject,
    openStudioRoadmap,
    applyStudioPort,
    createStudioRoadmap,
    setRoadmapLifecycle,
    removeRoadmapRegistryEntry,
    setRoadmapRemoteAccessCommand,
    publishProjectGrantsToRelay: (state: BridgeAppState) => publishProjectGrantsToRelay(state, remoteAccessRuntimeContext()),
    printManagedRoadmaps,
    normalizeGrantPath,
    looksLikeProjectPath,
    projectGrantScopesForCommand
  };
}

function activateRoadmapIntentCommand(parsed: ParsedArgs): void {
  const roadmapId = parsed.rest[0] ?? getFlag(parsed, "roadmap-id");
  if (!roadmapId?.trim()) {
    writeBridgeUiIntent({ tab: "workspaces" });
    console.log("Roadmap ID is required. Showing Workspaces.");
    return;
  }
  try {
    const result = setRoadmapLifecycle({ roadmapId: roadmapId.trim() }, "active", roadmapRegistryOptions());
    console.log(`Activated Roadmap: ${result.roadmap?.displayName ?? roadmapId.trim()}`);
  } catch (_error) {
    writeBridgeUiIntent({ tab: "workspaces" });
    console.log("Roadmap was not registered. Showing Workspaces.");
  }
}

function uiIntentCommand(parsed: ParsedArgs): void {
  const tab = canonicalBridgeUiIntentTab(parsed.rest[0]);
  if (!isBridgeUiIntentTab(tab)) {
    throw new Error("Usage: hunsu-bridge ui-intent provider|workspaces|connection|advanced|diagnostics|settings [codex|add-workspace]");
  }
  const detail = parsed.rest[1];
  writeBridgeUiIntent({
    tab,
    focus: tab === "connection" && detail === "remote" ? "remote" : tab === "provider" && detail === "codex" ? "codex" : undefined,
    action: tab === "workspaces" && (detail === "add-roadmap" || detail === "add-workspace") ? "add-workspace" : undefined
  });
  console.log(`Bridge App intent recorded: ${tab}`);
}

function writeBridgeUiIntent(intent: Omit<BridgeUiIntent, "id" | "createdAt">): BridgeUiIntent {
  return recordBridgeUiIntent(intent, {
    readState: readAppState,
    writeState: writeAppState
  });
}

function authCommandContext() {
  return {
    hasFlag,
    getFlag,
    numericFlag,
    credentialPath,
    readState: readAppState,
    writeState: writeAppState,
    credentialsForDevUser,
    openBrowser: openStudioInBrowser,
    disableAllManagedRoadmapRemoteAccess,
    projectGrantsWithoutRemoteRelay
  };
}

async function remoteCommand(parsed: ParsedArgs): Promise<void> {
  await runRemoteCommand(parsed, {
    ...remoteAccessRuntimeContext(),
    formatRemoteAccess: formatBridgeRemoteAccess,
    projectGrantsWithoutRemoteRelay,
    disableAllManagedRoadmapRemoteAccess,
    revokeRunningBridgePairing,
    isRelayCommandName
  });
}

function remoteAccessRuntimeContext() {
  return {
    appVersion: HUNSU_BRIDGE_APP_VERSION,
    credentialPath,
    relayRegistryPath,
    readState: readAppState,
    writeState: writeAppState,
    projectGrantsWithRemoteRelay,
    activeManagedProjectGrants,
    currentProviderStatus: async () => (await runtimeProvidersSnapshot()).current,
    listManagedRoadmaps: () => listManagedRoadmapRegistry(roadmapRegistryOptions()),
    normalizeGrantPath,
    getFlag: (parsed: { flags: Map<string, string | boolean> }, name: string) => {
      const value = parsed.flags.get(name);
      return typeof value === "string" ? value : undefined;
    },
    hasFlag: (parsed: { flags: Map<string, string | boolean> }, name: string) => parsed.flags.has(name),
    resolvePath: (path: string) => resolve(path),
    waitForShutdown: (cleanup: () => void | Promise<void>) => waitForShutdown(async () => {
      await cleanup();
    }),
    writeStructuredLog
  };
}

function serviceCommand(parsed: ParsedArgs): void {
  const subcommand = parsed.rest[0] ?? "status";
  const state = readAppState();
  if (subcommand === "status") {
    printServiceStatus(state.service);
    return;
  }
  if (subcommand === "install") {
    const service = installServiceArtifact(parsed);
    if (!service.installed) {
      console.log(`Dry run: Hunsu Bridge service artifact for ${service.manager} was not installed.`);
      if (service.unitPath) {
        console.log(`Target: ${service.unitPath}`);
      }
      return;
    }
    writeAppState({
      ...state,
      service: { ...service, updatedAt: new Date().toISOString() }
    });
    console.log(`Installed Hunsu Bridge service artifact for ${service.manager}.`);
    if (service.unitPath) {
      console.log(`Unit: ${service.unitPath}`);
    }
    return;
  }
  if (subcommand === "uninstall") {
    const dryRun = hasFlag(parsed, "dry-run");
    uninstallServiceArtifact(state.service, dryRun);
    if (state.service.unitPath) {
      if (dryRun) {
        console.log(`Dry run: would remove Hunsu Bridge service artifact at ${state.service.unitPath}.`);
      } else if (existsSync(state.service.unitPath)) {
        rmSync(state.service.unitPath, { force: true });
      }
    }
    if (!dryRun) {
      writeAppState({
        ...state,
        service: { installed: false, manager: defaultBridgeServiceManager(), updatedAt: new Date().toISOString() }
      });
    }
    console.log("Hunsu Bridge service artifact uninstalled.");
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
  const invocation = currentBridgeCommandInvocation();
  if (subcommand === "status") {
    console.log(JSON.stringify(protocolRegistrationPlan(invocation.command, invocation.args), null, 2));
    return;
  }
  if (subcommand === "install") {
    const plan = installLinuxProtocolHandler(invocation.command, invocation.args);
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  throw new Error(`Unknown protocol command: ${subcommand}`);
}

function settingsCommand(parsed: ParsedArgs): void {
  const setting = parsed.rest[0];
  if (setting !== "quit-behavior") {
    throw new Error("Usage: hunsu-bridge settings quit-behavior get|set keep-background|stop-background");
  }
  const action = parsed.rest[1] ?? "get";
  const state = readAppState();
  if (action === "get") {
    console.log(state.quitBehavior);
    return;
  }
  if (action === "set") {
    const behavior = parseBridgeQuitBehavior(parsed.rest[2]);
    if (behavior !== parsed.rest[2]) {
      throw new Error("Quit behavior must be keep-background or stop-background.");
    }
    writeAppState({ ...state, quitBehavior: behavior });
    console.log(`Saved quit behavior: ${formatQuitBehavior(behavior)}.`);
    return;
  }
  throw new Error("Usage: hunsu-bridge settings quit-behavior get|set keep-background|stop-background");
}

function formatQuitBehavior(value: BridgeQuitBehavior): string {
  return value === "stop-background" ? "Stop background service on quit" : "Keep background service running";
}

async function superviseCommand(parsed: ParsedArgs): Promise<void> {
  const cwd = resolve(getFlag(parsed, "cwd") ?? process.cwd());
  const state = readAppState();
  const supervisor = createBridgeAppSidecarSupervisorFromProcess({
    cwd,
    webUrl: getFlag(parsed, "web-url"),
    noOpen: true,
    restartLimit: Number(getFlag(parsed, "restart-limit") ?? 3),
    appLogPath: appLogPath(),
    state,
    activeProjectGrants: activeManagedProjectGrants(state.projectGrants)
  });
  const commandIdentity = currentBridgeProcessCommandIdentity("supervise");
  writeAppState({
    ...state,
    supervisorPid: process.pid,
    supervisorProcess: bridgeProcessRuntimeMetadata(process.pid, commandIdentity),
    processNonce: commandIdentity.nonce,
    commandIdentity,
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

async function projectsCommand(parsed: ParsedArgs): Promise<void> {
  await runProjectsCommand(parsed, workspaceCommandContext());
}

async function setRoadmapRemoteAccessCommand(roadmapId: string, enabled: boolean, parsed: ParsedArgs): Promise<void> {
  const state = readAppState();
  const roadmap = listManagedRoadmapRegistry(roadmapRegistryOptions()).find(candidate => candidate.roadmapId === roadmapId.trim());
  if (!roadmap) {
    throw new Error(`Unknown Roadmap: ${roadmapId}`);
  }
  if (enabled && roadmap.lifecycle !== "active") {
    throw new Error(`Inactive Roadmap cannot be exposed over Remote Access: ${roadmap.displayName}`);
  }
  const targetPath = normalizeGrantPath(roadmap.repositoryPath);
  const existingGrant = state.projectGrants.find(grant => normalizeGrantPath(grant.path) === targetPath);
  const explicitScopes = parseExplicitProjectGrantScopes(parsed);
  const enabledScopes = uniqueScopeList([
    ...(explicitScopes.length > 0 ? explicitScopes : existingGrant?.scopes ?? DEFAULT_PROJECT_GRANT_SCOPES),
    "remoteRelay.access"
  ]);
  const disabledScopes = (existingGrant?.scopes ?? roadmap.remoteAccess?.scopes ?? []).filter(scope => scope !== "remoteRelay.access");
  const scopes = enabled ? enabledScopes : disabledScopes;
  setRoadmapRemoteAccess({ roadmapId: roadmap.roadmapId }, { enabled, scopes }, roadmapRegistryOptions());
  const nextGrants = enabled
    ? [
        { path: targetPath, grantedAt: existingGrant?.grantedAt ?? new Date().toISOString(), scopes },
        ...state.projectGrants.filter(grant => normalizeGrantPath(grant.path) !== targetPath)
      ]
    : disabledScopes.length > 0
      ? [
          { path: targetPath, grantedAt: existingGrant?.grantedAt ?? new Date().toISOString(), scopes: disabledScopes },
          ...state.projectGrants.filter(grant => normalizeGrantPath(grant.path) !== targetPath)
        ]
      : state.projectGrants.filter(grant => normalizeGrantPath(grant.path) !== targetPath);
  const nextState = { ...state, projectGrants: nextGrants };
  writeAppState(nextState);
  await publishProjectGrantsToRelay(nextState, remoteAccessRuntimeContext());
  console.log(`${enabled ? "Enabled" : "Disabled"} Remote Access for Roadmap: ${roadmap.displayName}`);
}

function looksLikeProjectPath(value: string): boolean {
  return value.startsWith("/")
    || value.startsWith(".")
    || value.startsWith("~")
    || value.includes("\\")
    || value.includes("/");
}

function activeManagedProjectGrants(projectGrants: ProjectGrant[]): ProjectGrant[] {
  return activeManagedProjectGrantsForRoadmaps(
    listManagedRoadmapRegistry(roadmapRegistryOptions()),
    projectGrants,
    normalizeGrantPath
  );
}

function disableAllManagedRoadmapRemoteAccess(): void {
  for (const roadmap of listManagedRoadmapRegistry(roadmapRegistryOptions())) {
    const scopes = roadmap.remoteAccess?.scopes ?? [];
    if (roadmap.remoteAccess?.enabled !== true && !scopes.includes("remoteRelay.access")) {
      continue;
    }
    setRoadmapRemoteAccess({ roadmapId: roadmap.roadmapId }, {
      enabled: false,
      scopes: scopes.filter(scope => scope !== "remoteRelay.access")
    }, roadmapRegistryOptions());
  }
}

function normalizeGrantPath(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync(resolved);
  } catch (_error) {
    return resolved;
  }
}

function projectGrantScopesForCommand(parsed: ParsedArgs, state: BridgeAppState): BridgeCommandScope[] {
  const explicitScopes = parseExplicitProjectGrantScopes(parsed);
  if (explicitScopes.length > 0) {
    return explicitScopes;
  }
  return state.remoteAccess !== "off"
    ? uniqueScopeList([...DEFAULT_PROJECT_GRANT_SCOPES, "remoteRelay.access"])
    : [...DEFAULT_PROJECT_GRANT_SCOPES];
}

function parseExplicitProjectGrantScopes(parsed: ParsedArgs): BridgeCommandScope[] {
  const raw = getFlag(parsed, "scope") ?? getFlag(parsed, "scopes");
  if (!raw) {
    return [];
  }
  const values = raw.split(",").map(value => value.trim()).filter(Boolean);
  if (values.includes("all")) {
    return [...PROJECT_GRANT_SCOPE_VALUES];
  }
  const scopes: BridgeCommandScope[] = [];
  for (const value of values) {
    if (!isProjectGrantScope(value)) {
      throw new Error(`Unknown Project Grant scope: ${value}`);
    }
    scopes.push(value);
  }
  return uniqueScopeList(scopes);
}

function isProjectGrantScope(value: unknown): value is BridgeCommandScope {
  return typeof value === "string" && (PROJECT_GRANT_SCOPE_VALUES as readonly string[]).includes(value);
}

function printAppStatus(handle: BridgeRuntimeHandle): void {
  const state = readAppState();
  const account = state.account?.status === "signed-in" ? `Signed in as ${state.account.email ?? state.account.userId}` : "Signed out";
  console.log("Hunsu Bridge");
  console.log("");
  console.log("Status:");
  console.log(`  Local Bridge: ${formatRuntimeStatus(handle.status)}`);
  console.log(`  Account: ${account}`);
  console.log(`  Remote Access: ${formatBridgeRemoteAccess(state.remoteAccess)}`);
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

async function readBridgeHealth(state = readAppState()): Promise<
  | { ok: true; body: unknown; bridgeApiUrl: string }
  | { ok: false; error: string; attemptedUrls: string[] }
> {
  const configuredUrl = configuredBridgeApiUrl();
  const attemptedUrls = uniqueStringList([
    state.bridgeApiUrl,
    configuredUrl
  ].filter((value): value is string => Boolean(value?.trim())));
  for (const bridgeApiUrl of attemptedUrls) {
    try {
      const response = await fetch(new URL("/health", bridgeApiUrl));
      if (!response.ok) {
        continue;
      }
      const body = await response.json().catch(() => undefined);
      if (!isHunsuBridgeHealthBody(body)) {
        continue;
      }
      return { ok: true, body, bridgeApiUrl };
    } catch (_error) {
      continue;
    }
  }
  return {
    ok: false,
    error: attemptedUrls.length > 0 ? `Bridge is not reachable at ${attemptedUrls.join(", ")}` : "Bridge API endpoint is not configured.",
    attemptedUrls
  };
}

function isHunsuBridgeHealthBody(body: unknown): body is { ok: true; service: "hunsu-bridge" } {
  return typeof body === "object"
    && body !== null
    && (body as { ok?: unknown }).ok === true
    && (body as { service?: unknown }).service === "hunsu-bridge";
}

async function readAppSnapshot(): Promise<BridgeAppSnapshot> {
  let state = readAppState();
  const health = await readBridgeHealth(state);
  state = reconcileBridgeProcessState(state, health);
  const account = state.account?.status === "signed-in" ? `Signed in as ${state.account.email ?? state.account.userId}` : "Signed out";
  const localBridge = localBridgeStatusFromProcessState(state, health, {
    processIsAlive,
    startingGraceMs: BRIDGE_STARTING_GRACE_MS
  });
  const codex = await getCodexRuntimeStatus({ env: codexProbeEnv() });
  state = reconcileCodexLoginFromStatus(codex, codexCliActionContext());
  const runtimeProviders = await runtimeProvidersSnapshot();
  const providerConfig = await providerConfigSnapshot();
  const managedRoadmaps = roadmapAccessSnapshots(listManagedRoadmapRegistry(roadmapRegistryOptions()), state.projectGrants, runtimeProviders.current, {
    scopeValues: PROJECT_GRANT_SCOPE_VALUES,
    normalizeGrantPath
  });
  return createBridgeAppSnapshot({
    state,
    localBridge,
    accountLabel: account,
    remoteAccessLabel: formatBridgeRemoteAccess(state.remoteAccess),
    bridgeApiUrl: health.ok ? health.bridgeApiUrl : state.bridgeApiUrl,
    healthError: health.ok ? undefined : health.error,
    runtimeProviders,
    providerConfig,
    managedRoadmaps,
    projectGrants: snapshotProjectGrants(state.projectGrants),
    activeProjectGrants: activeManagedProjectGrants(state.projectGrants),
    recentProjects: listRoadmapRegistry(roadmapRegistryOptions()).slice(0, 12),
    codex,
    tools: {
      git: toolStatus("git", ["--version"]),
      node: currentNodeRuntimeStatus(),
      packageManager: packageManagerStatus()
    },
    codexSettings: snapshotCodexSettings(state),
    diagnostics: await buildDiagnostics(diagnosticsCommandContext()),
    logLines: readLogTail(appLogPath(), 80)
  });
}

async function providerConfigSnapshot(): Promise<BridgeAppSnapshot["providerConfig"]> {
  const registry = createBridgeDesktopRuntimeProviderRegistry();
  const provider = registry.current();
  return {
    providerId: provider.providerId,
    metadata: provider.metadata(),
    fields: await provider.readConfig()
  };
}

async function runtimeProvidersSnapshot(): Promise<BridgeAppSnapshot["providers"] & BridgeAppSnapshot["runtimeProviders"]> {
  const registry = createBridgeDesktopRuntimeProviderRegistry();
  const providers = await Promise.all(registry.list().map(provider => provider.status()));
  const currentProviderId = registry.current().providerId;
  const current = providers.find(provider => provider.providerId === currentProviderId) ?? providers[0];
  if (!current) {
    throw new Error("No runtime providers are available.");
  }
  return {
    currentProviderId,
    current,
    providers
  };
}

function createBridgeDesktopRuntimeProviderRegistry() {
  return createRuntimeProviderRegistry({
    providerStateStore: {
      read: () => readAppState().runtimeProviders,
      write: runtimeProviders => {
        const state = readAppState();
        writeAppState({ ...state, runtimeProviders });
      }
    },
    codex: {
      env: codexProbeEnv
    }
  });
}

async function runCodexInstallCli(options: { confirmed: boolean; dryRun: boolean }) {
  const registry = createBridgeDesktopRuntimeProviderRegistry();
  const provider = registry.get("codex") ?? registry.current();
  if (!provider.install) {
    throw new Error("Current provider does not support installation.");
  }
  return provider.install({
    confirmed: options.confirmed,
    dryRun: options.dryRun,
    env: codexProbeEnv()
  });
}

function codexCliActionContext() {
  return {
    getCodexStatus: getCodexRuntimeStatus,
    codexProbeEnv,
    readState: readAppState,
    writeState: writeAppState,
    bridgeNodeExecArgs,
    bridgeCommandPath: () => process.argv[1] ?? "hunsu-bridge"
  };
}

function codexProbeEnv(): Record<string, string | undefined> {
  const state = readAppState();
  return codexProviderEnv({
    baseEnv: currentProcessEnv(),
    settings: bridgeCodexProviderSettings(state)
  });
}

function snapshotCodexSettings(state: BridgeAppState): BridgeAppSnapshot["codexSettings"] {
  const env = codexProbeEnv();
  const settings = bridgeCodexProviderSettings(state);
  return {
    ...settings,
    environment: sanitizeDiagnostics(codexEffectiveEnvSummary(env)) as BridgeAppSnapshot["codexSettings"]["environment"]
  };
}

async function safeCodexDiagnostics(): Promise<unknown> {
  const env = codexProbeEnv();
  const status = await getCodexRuntimeStatus({ env });
  return {
    codexInstalled: status.cli.installed,
    codexVersion: status.cli.version,
    codexBinarySource: status.cli.source,
    codexAppServerAvailable: status.appServer.available,
    codexAuthState: status.auth.state,
    codexAuthMethod: status.auth.method,
    codexAccessType: status.auth.access,
    rateLimitsAvailable: status.usage.rateLimitsAvailable,
    rateLimited: status.usage.rateLimited,
    lastRunUsage: status.usage.lastRunUsage,
    effectiveEnv: codexEffectiveEnvSummary(env),
    codexHome: status.auth.homeDiagnostic,
    lastCodexError: status.cli.error ?? status.appServer.error ?? status.auth.error ?? status.usage.error
  };
}

function printCodexStatus(codex: Awaited<ReturnType<typeof getCodexRuntimeStatus>>): void {
  console.log("Codex");
  console.log(`  CLI: ${codex.cli.installed ? "Installed" : "Missing"}`);
  if (codex.cli.binaryPath) console.log(`  Binary: ${codex.cli.binaryPath}`);
  if (codex.cli.version) console.log(`  Version: ${codex.cli.version}`);
  console.log(`  App Server: ${codex.appServer.available ? "Available" : "Unavailable"}`);
  console.log(`  Auth: ${codex.auth.state}`);
  if (codex.auth.homeDiagnostic?.effectiveCodexHome) console.log(`  Codex Home: ${codex.auth.homeDiagnostic.effectiveCodexHome}`);
  if (codex.auth.homeDiagnostic) {
    console.log(`  Auth File: ${codex.auth.homeDiagnostic.authFileExistsAtEffectiveHome ? "Present" : "Missing"} at effective Codex Home`);
    if (codex.auth.homeDiagnostic.likelyHomeMismatch) {
      console.log(`  Home Mismatch: ${codex.auth.homeDiagnostic.remediation?.message ?? "Saved CODEX_HOME does not match the Codex home that has auth.json."}`);
    }
  }
  if (codex.auth.method) console.log(`  Method: ${codex.auth.method}`);
  if (codex.auth.access) console.log(`  Access: ${codex.auth.access}`);
  if (codex.usage.rateLimitsAvailable) {
    console.log(`  Rate Limits: ${codex.usage.rateLimitSummary?.label ?? "Available"}`);
    if (codex.usage.rateLimitSummary?.remainingLabel) console.log(`  Remaining: ${codex.usage.rateLimitSummary.remainingLabel}`);
    if (codex.usage.rateLimitSummary?.resetAt) console.log(`  Reset: ${codex.usage.rateLimitSummary.resetAt}`);
  } else {
    console.log("  Rate Limits: Unavailable");
  }
  if (codex.usage.rateLimited) console.log("  Rate Limited: Yes");
  if (codex.usage.lastRunUsage) {
    console.log(`  Last Run Usage: input ${codex.usage.lastRunUsage.inputTokens}, cached ${codex.usage.lastRunUsage.cachedInputTokens}, output ${codex.usage.lastRunUsage.outputTokens}, reasoning ${codex.usage.lastRunUsage.reasoningTokens}`);
  }
  console.log(`  Ready: ${codex.ready ? "Yes" : "No"}`);
  if (codex.recommendedAction !== "none") console.log(`  Recommended Action: ${codex.recommendedAction}`);
  const error = codex.cli.error ?? codex.appServer.error ?? codex.auth.error ?? codex.usage.error;
  if (error) console.log(`  Error: ${error}`);
}

function printManagedRoadmaps(roadmaps: BridgeRoadmapAccessSnapshot[], provider: RuntimeProviderStatus): void {
  const active = roadmaps.filter(roadmap => roadmap.lifecycle === "active");
  const inactive = roadmaps.filter(roadmap => roadmap.lifecycle !== "active");
  console.log(`Provider ${provider.label}: ${provider.ready ? "Ready" : "Not Ready"}`);
  console.log("");
  console.log("Active Workspaces:");
  for (const roadmap of active) {
    console.log(`  ${roadmap.displayName} (${roadmap.roadmapId})`);
    console.log(`    ${roadmap.repositoryPath}`);
    printRoadmapAccessDetails(roadmap);
  }
  if (active.length === 0) {
    console.log("  None");
  }
  console.log("");
  console.log("Inactive Workspaces:");
  for (const roadmap of inactive) {
    console.log(`  ${roadmap.displayName} (${roadmap.roadmapId})`);
    console.log(`    ${roadmap.repositoryPath}`);
    printRoadmapAccessDetails(roadmap);
  }
  if (inactive.length === 0) {
    console.log("  None");
  }
}

function printRoadmapAccessDetails(roadmap: BridgeRoadmapAccessSnapshot): void {
  console.log(`    Local Access: ${roadmap.localAccess?.enabled === false || roadmap.lifecycle !== "active" ? "Unavailable" : "Active"}`);
  console.log(`    Provider: ${roadmap.provider.label} ${roadmap.provider.readyForExecute ? "Ready" : "Not Ready"}`);
  console.log(`    Remote Access: ${roadmap.remoteAccess.enabled ? "On" : roadmap.remoteAccess.available ? "Off" : `Unavailable (${roadmap.remoteAccess.reason})`}`);
  console.log("    Scopes:");
  for (const scope of PROJECT_GRANT_SCOPE_VALUES) {
    console.log(`      [${roadmap.remoteAccess.scopeState[scope] ? "x" : " "}] ${scope}`);
  }
}

function configuredBridgeApiUrl(): string | undefined {
  try {
    const runtimeConfig = unwrapConfigResult(resolveBridgeRuntimeConfig(currentProcessEnv(), { cwd: process.cwd() }));
    return endpointUrl(runtimeConfig.bridgeApi);
  } catch (_error) {
    return undefined;
  }
}

function reconcileBridgeProcessState(
  state: BridgeAppState,
  health: Awaited<ReturnType<typeof readBridgeHealth>>
): BridgeAppState {
  const pids = uniqueNumberList([state.supervisorPid, state.pid]);
  if (pids.length === 0) {
    return state;
  }
  const anyAlive = pids.some(pid => processIsAlive(pid));
  const staleUrl = health.ok && state.bridgeApiUrl ? normalizeUrl(health.bridgeApiUrl) !== normalizeUrl(state.bridgeApiUrl) : false;
  if (!anyAlive || staleUrl) {
    const next = clearBridgeProcessRuntimeState(state);
    writeAppState(next);
    writeStructuredLog({
      event: "bridge.state.stale-cleared",
      reason: !anyAlive ? "process-dead" : "bridge-url-changed",
      pids,
      previousBridgeApiUrl: state.bridgeApiUrl,
      healthBridgeApiUrl: health.ok ? health.bridgeApiUrl : undefined
    });
    return next;
  }
  return state;
}

async function stopBridgeThroughControlEndpoint(state: BridgeAppState): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!state.bridgeApiUrl || !state.controlToken) {
    return { ok: false, error: "No Bridge control endpoint is known." };
  }
  try {
    const response = await fetch(new URL("/api/bridge/control/shutdown", state.bridgeApiUrl), {
      method: "POST",
      headers: {
        "x-hunsu-bridge-control-token": state.controlToken
      }
    });
    if (!response.ok) {
      const body = await response.json().catch(() => undefined) as { error?: string } | undefined;
      return { ok: false, error: body?.error ?? `Bridge shutdown returned HTTP ${response.status}.` };
    }
    await new Promise(resolve => setTimeout(resolve, 150));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unable to reach Bridge control endpoint." };
  }
}

function clearBridgeProcessRuntimeState(state: BridgeAppState): BridgeAppState {
  return {
    ...state,
    supervisorPid: undefined,
    pid: undefined,
    supervisorProcess: undefined,
    bridgeProcess: undefined,
    bridgeApiUrl: undefined,
    processNonce: undefined,
    commandIdentity: undefined,
    authToken: undefined,
    controlToken: undefined,
    pairing: undefined,
    startedAt: undefined
  };
}

function verifyManagedBridgePid(pid: number, state: BridgeAppState): { ok: true } | { ok: false; reason: string } {
  if (!processIsAlive(pid)) {
    return { ok: false, reason: "process_not_alive" };
  }
  const metadata = storedProcessMetadataForPid(pid, state);
  if (!metadata?.startMetadata) {
    return { ok: false, reason: "process_metadata_unavailable" };
  }
  const currentStartMetadata = processStartMetadata(pid);
  if (!currentStartMetadata || !sameProcessStartMetadata(metadata.startMetadata, currentStartMetadata)) {
    return { ok: false, reason: "process_start_metadata_mismatch" };
  }
  if (metadata.processNonce) {
    const currentNonce = processEnvironmentValue(pid, BRIDGE_PROCESS_NONCE_ENV);
    if (currentNonce !== metadata.processNonce) {
      return { ok: false, reason: currentNonce ? "process_nonce_mismatch" : "process_nonce_unavailable" };
    }
  }
  const commandLine = processCommandLine(pid);
  if (!commandLine) {
    return { ok: false, reason: "process_command_unavailable" };
  }
  const expectedKinds: BridgeProcessCommandIdentity["kind"][] = [metadata.commandIdentity.kind];
  if (!commandLineLooksLikeBridgeApp(commandLine, expectedKinds)) {
    return { ok: false, reason: "process_command_mismatch" };
  }
  return { ok: true };
}

function storedProcessMetadataForPid(pid: number, state: BridgeAppState): BridgeProcessRuntimeMetadata | undefined {
  if (state.supervisorPid === pid && state.supervisorProcess?.pid === pid) {
    return state.supervisorProcess;
  }
  if (state.pid === pid && state.bridgeProcess?.pid === pid) {
    return state.bridgeProcess;
  }
  return undefined;
}

function uniqueNumberList(values: Array<number | undefined>): number[] {
  return [...new Set(values.filter((value): value is number => value !== undefined && Number.isInteger(value) && value > 0))];
}

function uniqueStringList(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizeUrl(value: string): string {
  try {
    return new URL(value).toString();
  } catch (_error) {
    return value;
  }
}

function rememberRunningBridge(handle: BridgeRuntimeHandle, cwd: string, webUrl: string | undefined): void {
  writeAppState(handleToRuntimeState(readAppState(), handle, cwd, webUrl));
  writeStructuredLog({ event: "bridge.started", pid: process.pid, cwd, bridgeApiUrl: handle.bridgeApiUrl, startedAt: handle.startedAt });
}

function clearSupervisorProcessState(): void {
  const state = readAppState();
  if (state.supervisorPid === process.pid) {
    writeAppState({
      ...state,
      supervisorPid: undefined,
      supervisorProcess: undefined,
      ...(state.pid ? {} : {
        processNonce: undefined,
        commandIdentity: undefined
      })
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
      bridgeProcess: undefined,
      bridgeApiUrl: undefined,
      processNonce: undefined,
      commandIdentity: undefined,
      authToken: undefined,
      controlToken: undefined,
      pairing: undefined,
      startedAt: undefined
    });
    writeStructuredLog({ event: "bridge.stopped", pid: process.pid });
  }
}

function installServiceArtifact(parsed: ParsedArgs): BridgeServiceState {
  const manager = hasFlag(parsed, "system") ? "manual" : defaultBridgeServiceManager();
  const state = readAppState();
  const serviceEnv = serviceEnvironmentSnapshot(state);
  const dryRun = hasFlag(parsed, "dry-run");
  if (manager === "systemd-user") {
    const unitPath = currentProcessEnv().HUNSU_BRIDGE_SERVICE_UNIT_PATH?.trim() || DEFAULT_SYSTEMD_USER_UNIT_PATH;
    const cwd = resolve(getFlag(parsed, "cwd") ?? state.cwd ?? process.cwd());
    const text = systemdUserUnitText(cwd, serviceEnv);
    if (dryRun) {
      console.log(`Dry run: would write Hunsu Bridge systemd user service artifact to ${unitPath}.`);
      console.log(text);
      return { installed: false, manager, unitPath };
    }
    mkdirSync(dirname(unitPath), { recursive: true });
    writeFileSync(unitPath, text, "utf8");
    writeStructuredLog({ event: "service.installed", manager, unitPath, cwd });
    runServiceManagerReload(manager);
    return { installed: true, manager, unitPath };
  }
  if (manager === "launchd-user") {
    const unitPath = currentProcessEnv().HUNSU_BRIDGE_SERVICE_UNIT_PATH?.trim() || DEFAULT_LAUNCHD_USER_PLIST_PATH;
    const cwd = resolve(getFlag(parsed, "cwd") ?? state.cwd ?? process.cwd());
    const text = launchdUserPlistText(cwd, serviceEnv);
    if (dryRun) {
      console.log(`Dry run: would write Hunsu Bridge launchd user service artifact to ${unitPath}.`);
      console.log(text);
      return { installed: false, manager, unitPath };
    }
    mkdirSync(dirname(unitPath), { recursive: true });
    writeFileSync(unitPath, text, "utf8");
    writeStructuredLog({ event: "service.installed", manager, unitPath, cwd });
    runServiceManagerCommand("start", { installed: true, manager, unitPath });
    return { installed: true, manager, unitPath };
  }
  if (manager === "windows-startup-user") {
    const unitPath = currentProcessEnv().HUNSU_BRIDGE_SERVICE_UNIT_PATH?.trim() || defaultWindowsUserStartupScriptPath();
    const cwd = resolve(getFlag(parsed, "cwd") ?? state.cwd ?? process.cwd());
    const text = windowsUserStartupScriptText(cwd, serviceEnv);
    const command = windowsScheduledTaskInstallCommand(unitPath);
    if (dryRun) {
      console.log(`Dry run: would write Hunsu Bridge Windows user startup script to ${unitPath}.`);
      console.log(text);
      console.log(command.join(" "));
      return { installed: false, manager, unitPath };
    }
    mkdirSync(dirname(unitPath), { recursive: true });
    writeFileSync(unitPath, text, "utf8");
    runServiceCommand(command, { event: "service.installed", manager, dryRun: false });
    writeStructuredLog({ event: "service.installed", manager, unitPath, cwd });
    return { installed: true, manager, unitPath };
  }
  if (hasFlag(parsed, "system")) {
    const command = systemServiceInstallCommand(resolve(getFlag(parsed, "cwd") ?? state.cwd ?? process.cwd()));
    console.log("Advanced system service command:");
    console.log(command);
    writeStructuredLog({ event: "service.install-intent.system", manager: "manual", command });
    return { installed: !dryRun, manager: "manual" };
  }
  if (dryRun) {
    console.log(`Dry run: no automatic service artifact is available for ${manager}.`);
    writeStructuredLog({ event: "service.install-intent.dry-run", manager });
    return { installed: false, manager };
  }
  writeStructuredLog({ event: "service.install-intent", manager });
  return { installed: true, manager };
}

function runServiceManagerCommand(action: "start" | "stop", service: BridgeServiceState): void {
  if (service.manager === "systemd-user") {
    const command = ["systemctl", "--user", action, "hunsu-bridge.service"];
    runServiceCommand(command, { event: `service.${action}`, manager: service.manager });
    console.log(`Hunsu Bridge service ${action} requested through systemd user service.`);
    return;
  }
  if (service.manager === "launchd-user") {
    const target = `gui/${currentUid()}/app.hunsu.bridge`;
    const command = action === "start"
      ? ["launchctl", "bootstrap", `gui/${currentUid()}`, service.unitPath ?? DEFAULT_LAUNCHD_USER_PLIST_PATH]
      : ["launchctl", "bootout", target];
    runServiceCommand(command, { event: `service.${action}`, manager: service.manager, allowFailure: action === "start" });
    if (action === "start") {
      runServiceCommand(["launchctl", "kickstart", "-k", target], { event: "service.start.kickstart", manager: service.manager });
    }
    console.log(`Hunsu Bridge service ${action} requested through launchd user agent.`);
    return;
  }
  if (service.manager === "windows-startup-user") {
    const command = action === "start"
      ? powershellCommand(`Start-ScheduledTask -TaskName ${powerShellQuote(WINDOWS_USER_TASK_NAME)}`)
      : powershellCommand(`Stop-ScheduledTask -TaskName ${powerShellQuote(WINDOWS_USER_TASK_NAME)}`);
    runServiceCommand(command, { event: `service.${action}`, manager: service.manager });
    console.log(`Hunsu Bridge service ${action} requested through Windows scheduled task.`);
    return;
  }
  console.log(`Use your OS service manager to ${action} Hunsu Bridge, or run \`hunsu-bridge ${action === "start" ? "start --remote" : "stop"}\`.`);
  writeStructuredLog({ event: `service.${action}.requested`, manager: service.manager });
}

function runServiceManagerReload(manager: BridgeServiceState["manager"]): void {
  if (manager === "systemd-user") {
    runServiceCommand(["systemctl", "--user", "daemon-reload"], { event: "service.reload", manager, allowFailure: true });
  }
}

function printServiceStatus(service: BridgeServiceState): void {
  console.log(`Service: ${service.installed ? `Installed (${service.manager})` : "Not installed"}`);
  if (service.unitPath) {
    console.log(`Unit: ${service.unitPath}`);
  }
  if (service.manager === "systemd-user") {
    runServiceCommand(["systemctl", "--user", "is-active", "hunsu-bridge.service"], { event: "service.status", manager: service.manager, allowFailure: true });
    return;
  }
  if (service.manager === "launchd-user") {
    runServiceCommand(["launchctl", "print", `gui/${currentUid()}/app.hunsu.bridge`], { event: "service.status", manager: service.manager, allowFailure: true });
    return;
  }
  if (service.manager === "windows-startup-user") {
    runServiceCommand(powershellCommand(`Get-ScheduledTask -TaskName ${powerShellQuote(WINDOWS_USER_TASK_NAME)} | Select-Object TaskName,State | Format-List`), {
      event: "service.status",
      manager: service.manager,
      allowFailure: true
    });
  }
}

function uninstallServiceArtifact(service: BridgeServiceState, dryRun: boolean): void {
  if (service.manager === "systemd-user") {
    const command = ["systemctl", "--user", "disable", "--now", "hunsu-bridge.service"];
    runServiceCommand(command, { event: "service.uninstall.disable", manager: service.manager, dryRun, allowFailure: true });
    return;
  }
  if (service.manager === "launchd-user") {
    runServiceCommand(["launchctl", "bootout", `gui/${currentUid()}/app.hunsu.bridge`], {
      event: "service.uninstall.bootout",
      manager: service.manager,
      dryRun,
      allowFailure: true
    });
    return;
  }
  if (service.manager === "windows-startup-user") {
    runServiceCommand(powershellCommand(`Unregister-ScheduledTask -TaskName ${powerShellQuote(WINDOWS_USER_TASK_NAME)} -Confirm:$false`), {
      event: "service.uninstall.unregister",
      manager: service.manager,
      dryRun,
      allowFailure: true
    });
  }
}

function runServiceCommand(command: string[], options: {
  event: string;
  manager: BridgeServiceState["manager"];
  dryRun?: boolean;
  allowFailure?: boolean;
}): void {
  const [program, ...args] = command;
  const commandLine = command.join(" ");
  if (options.dryRun || currentProcessEnv().HUNSU_BRIDGE_SERVICE_DRY_RUN === "1" || !program || !commandAvailable(program)) {
    console.log(`Run: ${commandLine}`);
    writeStructuredLog({ event: `${options.event}.dry-run`, manager: options.manager, command: commandLine });
    return;
  }
  try {
    const output = execFileSync(program, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (output.trim()) {
      console.log(output.trim());
    }
    writeStructuredLog({ event: `${options.event}.completed`, manager: options.manager, command: commandLine, output: output.trim() || undefined });
  } catch (error) {
    const message = error instanceof Error ? error.message : `Unable to run ${commandLine}.`;
    writeStructuredLog({ event: `${options.event}.failed`, manager: options.manager, command: commandLine, error: message });
    if (!options.allowFailure) {
      throw new Error(message);
    }
    console.log(`Run: ${commandLine}`);
  }
}

function serviceEnvironmentSnapshot(state: BridgeAppState): Record<string, string> {
  const env = codexProviderEnv({
    baseEnv: {
      HUNSU_BRIDGE_HEADLESS: "1",
      HUNSU_BRIDGE_APP_STATE_PATH: appStatePath(),
      HUNSU_ROADMAP_REGISTRY_PATH: roadmapRegistryOptions().roadmapRegistryPath,
      HUNSU_BRIDGE_APP_LOG_PATH: appLogPath()
    },
    settings: bridgeCodexProviderSettings(state)
  });
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim() !== ""));
}

function defaultWindowsUserStartupScriptPath(env: Record<string, string | undefined> = currentProcessEnv()): string {
  return join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Hunsu", "Bridge", "hunsu-bridge-startup.cmd");
}

function systemdUserUnitText(cwd: string, env: Record<string, string> = { HUNSU_BRIDGE_HEADLESS: "1" }): string {
  const invocation = currentBridgeCommandInvocation({ commandArgs: ["supervise", "--cwd", cwd] });
  return [
    "[Unit]",
    "Description=Hunsu Bridge daemon",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${systemdQuote(cwd)}`,
    `ExecStart=${[invocation.command, ...invocation.args].map(systemdQuote).join(" ")}`,
    "Restart=on-failure",
    "RestartSec=2",
    ...Object.entries(env).map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`),
    "",
    "[Install]",
    "WantedBy=default.target",
    ""
  ].join("\n");
}

function launchdUserPlistText(cwd: string, env: Record<string, string> = { HUNSU_BRIDGE_HEADLESS: "1" }): string {
  const invocation = currentBridgeCommandInvocation({ commandArgs: ["supervise", "--cwd", cwd] });
  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
    "<plist version=\"1.0\">",
    "<dict>",
    "  <key>Label</key>",
    "  <string>app.hunsu.bridge</string>",
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...[invocation.command, ...invocation.args].map(arg => `    <string>${xmlEscape(arg)}</string>`),
    "  </array>",
    "  <key>WorkingDirectory</key>",
    `  <string>${xmlEscape(cwd)}</string>`,
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    ...Object.entries(env).flatMap(([key, value]) => [
      `    <key>${xmlEscape(key)}</key>`,
      `    <string>${xmlEscape(value)}</string>`
    ]),
    "  </dict>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "</dict>",
    "</plist>",
    ""
  ].join("\n");
}

function windowsUserStartupScriptText(cwd: string, env: Record<string, string> = { HUNSU_BRIDGE_HEADLESS: "1" }): string {
  const invocation = currentBridgeCommandInvocation({ commandArgs: ["supervise", "--cwd", cwd] });
  return [
    "@echo off",
    "chcp 65001 >NUL",
    `cd /d ${windowsCommandQuote(cwd)}`,
    ...Object.entries(env).map(([key, value]) => `set "${key}=${windowsBatchValue(value)}"`),
    [invocation.command, ...invocation.args].map(windowsCommandQuote).join(" "),
    ""
  ].join("\r\n");
}

function windowsScheduledTaskInstallCommand(scriptPath: string): string[] {
  return powershellCommand([
    `$Action = New-ScheduledTaskAction -Execute ${powerShellQuote(scriptPath)}`,
    "$Trigger = New-ScheduledTaskTrigger -AtLogOn",
    `Register-ScheduledTask -TaskName ${powerShellQuote(WINDOWS_USER_TASK_NAME)} -Action $Action -Trigger $Trigger -Description ${powerShellQuote("Starts Hunsu Bridge for the signed-in user.")} -Force | Out-Null`
  ].join("; "));
}

function systemServiceInstallCommand(cwd: string): string {
  const invocation = currentBridgeCommandInvocation({ commandArgs: ["supervise", "--cwd", cwd] });
  return [
    "System services are advanced because Bridge provider credentials and CODEX_HOME are user-scoped.",
    "Manual fallback in the target user context:",
    `  ${[invocation.command, ...invocation.args].map(windowsCommandQuote).join(" ")}`
  ].join("\n");
}

function systemdQuote(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "\\\"")
    .replace(/%/g, "%%")
    .replace(/\n/g, "\\n")}"`;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function windowsCommandQuote(value: string): string {
  return `"${value.replace(/"/g, "\\\"")}"`;
}

function windowsBatchValue(value: string): string {
  return value.replace(/%/g, "%%").replace(/\r?\n/g, " ");
}

function powershellCommand(script: string): string[] {
  const command = commandAvailable("pwsh") ? "pwsh" : "powershell.exe";
  return [command, "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script];
}

function powerShellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function currentUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : 0;
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
    accessToken: `dev_access_${hashBridgeDeviceSeed(`${userId}:access`)}`,
    refreshToken: `dev_refresh_${hashBridgeDeviceSeed(`${userId}:refresh`)}`,
    userId,
    email: userId.includes("@") ? userId : undefined,
    deviceId: state.device.id,
    deviceName: state.device.name,
    savedAt: new Date().toISOString()
  };
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
  hunsu-bridge prerequisites status

Headless:
  hunsu-bridge codex status
  hunsu-bridge codex install
  hunsu-bridge codex login [--device]
  hunsu-bridge codex recheck
  hunsu-bridge codex logout
  hunsu-bridge codex path set /path/to/codex
  hunsu-bridge codex path reset
  hunsu-bridge login
  hunsu-bridge login --auth-url <url>
  hunsu-bridge login --local-dev --auto-approve
  hunsu-bridge login --gui
  hunsu-bridge logout
  hunsu-bridge remote status|enable|disable|devices|check
  hunsu-bridge protocol status|install
  hunsu-bridge supervise [--cwd <path>]
  hunsu-bridge service install|uninstall|start|stop|status [--user|--system]
  hunsu-bridge model-alias list|get|set|delete|validate|override
  hunsu-bridge model-alias set PrimaryModel --model gpt-5.5-thinking --reasoning high --service-tier default
  hunsu-bridge auth-dev-server
  hunsu-bridge roadmaps list
  hunsu-bridge roadmaps add /path/to/project
  hunsu-bridge roadmaps activate <roadmapId>
  hunsu-bridge roadmaps deactivate <roadmapId>
  hunsu-bridge roadmaps remote enable <roadmapId> [--scopes all|remoteRelay.access,execute.start,artifactAction.run,env.read,hostAlias.expose]
  hunsu-bridge roadmaps remote disable <roadmapId>
  hunsu-bridge roadmaps remove <roadmapId>
  hunsu-bridge ui-intent <tab> [codex|add-workspace]
  hunsu-bridge projects list
  hunsu-bridge projects recent
  hunsu-bridge projects grant <path> [--scopes all|remoteRelay.access,execute.start,artifactAction.run,env.read,hostAlias.expose]
  hunsu-bridge projects revoke <path>
  hunsu-bridge projects remove --roadmap-id <id>

Deep links:
  hunsu://open
  hunsu://pair?next=/studio
  hunsu://provider
  hunsu://provider/codex
  hunsu://workspaces
  hunsu://add-workspace
  hunsu://connection
  hunsu://connection/remote
  hunsu://diagnostics
  hunsu://open-workspace?workspaceId=<id>
  hunsu://codex
  hunsu://add-roadmap
  hunsu://roadmaps
  hunsu://prerequisites
  hunsu://prerequisites/codex
  hunsu://activate-roadmap?roadmapId=<id>
  hunsu://activate-workspace?workspaceId=<id>
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
  if (isSea()) {
    return true;
  }
  const entrypoint = process.argv[1];
  return Boolean(entrypoint) && resolve(fileURLToPath(import.meta.url)) === resolve(entrypoint);
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

async function openStudioManagedUrl(url: string): Promise<void> {
  openStudioInBrowser(url);
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
    "bridge.status",
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

export { main, normalizeBridgeAppArgv };
