import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createConnection } from "node:net";
import {
  currentProcessEnv,
  endpointUrl,
  resolveBridgeApiServerConfig
} from "@hunsu/config";
import {
  bridgeAppStatePath,
  readBridgeAppState,
  writeBridgeAppState,
  type BridgeAppState
} from "../state/appState.ts";

const CONTROL_TOKEN_HEADER = "x-hunsu-bridge-control-token";

export type ManagedBridgeDiscovery =
  | ({ state: "running-managed" } & ManagedBridgeIdentity)
  | {
      state: "running-unmanaged";
      bridgeApiUrl: string;
      instanceId?: string;
      reason: string;
    }
  | {
      state: "port-conflict";
      bridgeApiUrl: string;
      reason: string;
    }
  | {
      state: "starting";
      reason?: string;
    }
  | {
      state: "stale";
      reason: string;
    }
  | { state: "not-running" };

export type ManagedBridgeIdentity = {
  bridgeApiUrl: string;
  instanceId: string;
  daemonPid: number;
  supervisorPid?: number;
  startedAt?: string;
  bridgeVersion: string;
  protocolVersion: string;
};

export type ManagedBridgeErrorCode =
  | "BRIDGE_ALREADY_RUNNING_UNMANAGED"
  | "BRIDGE_PORT_IN_USE"
  | "BRIDGE_START_COORDINATION_TIMEOUT"
  | "BRIDGE_START_TIMEOUT"
  | "BRIDGE_CONTROL_UNAVAILABLE"
  | "BRIDGE_NOT_OWNED"
  | "BRIDGE_STOP_TIMEOUT"
  | "PAIRING_ROTATION_FAILED"
  | "BROWSER_OPEN_FAILED"
  | "ROADMAP_NOT_FOUND";

export type ManagedBridgeOperationError = {
  code: ManagedBridgeErrorCode;
  message: string;
  canForceStop?: false;
};

export type ManagedBridgeResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ManagedBridgeOperationError };

export type ManagedBridgeEnsureResult = ManagedBridgeResult<ManagedBridgeIdentity & {
  state: "running-managed";
  transition: "reused" | "started";
}>;

export type ManagedBridgeStopResult = ManagedBridgeResult<{
  previousState: "running-managed" | "not-running";
  state: "stopped";
}>;

export type ManagedBridgeBrowserResult = ManagedBridgeResult<{
  action: "pair" | "open-roadmap";
  bridgeApiUrl: string;
  instanceId: string;
  roadmapId?: string;
  browserOpened: boolean;
}>;

export type ManagedBridgeEnsureInput = {
  cwd?: string;
  webUrl?: string;
};

export type ManagedBridgePairingInput = ManagedBridgeEnsureInput & {
  roadmapId?: string;
  openBrowser?: boolean;
};

export type ManagedBridgeStartContext = ManagedBridgeEnsureInput & {
  attemptId: string;
  canonicalBridgeApiUrl: string;
};

export type ManagedBridgeFetch = (
  input: string,
  init?: RequestInit
) => Promise<Response>;

export type ManagedBridgeRuntimeOptions = {
  env?: Record<string, string | undefined>;
  statePath?: string;
  lockPath?: string;
  canonicalBridgeApiUrl?: string;
  readState?: () => BridgeAppState;
  writeState?: (state: BridgeAppState) => void;
  startSupervisor?: (context: ManagedBridgeStartContext) => Promise<void>;
  openUrl?: (url: string) => Promise<void>;
  fetch?: ManagedBridgeFetch;
  probeTcpEndpoint?: (bridgeApiUrl: string) => Promise<boolean>;
  processIsAlive?: (pid: number) => boolean;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  createAttemptId?: () => string;
  currentPid?: number;
  probeTimeoutMs?: number;
  coordinationTimeoutMs?: number;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  pollIntervalMs?: number;
  writeStructuredLog?: (event: Record<string, unknown>) => void;
};

export type ManagedBridgeRuntime = {
  discoverManagedBridge(): Promise<ManagedBridgeDiscovery>;
  ensureManagedBridgeRunning(input?: ManagedBridgeEnsureInput): Promise<ManagedBridgeEnsureResult>;
  stopManagedBridge(): Promise<ManagedBridgeStopResult>;
  createManagedPairing(input?: ManagedBridgePairingInput): Promise<ManagedBridgeBrowserResult>;
  openManagedRoadmap(roadmapId: string, input?: Omit<ManagedBridgePairingInput, "roadmapId">): Promise<ManagedBridgeBrowserResult>;
};

type EndpointProbe =
  | { kind: "offline"; bridgeApiUrl: string }
  | { kind: "conflict"; bridgeApiUrl: string }
  | { kind: "hunsu-unmanaged"; bridgeApiUrl: string; reason: string }
  | ({ kind: "managed" } & ManagedBridgeIdentity);

type BridgeHealthResponse = {
  ok: true;
  service: "hunsu-bridge";
  version: {
    bridgeVersion: string;
    protocolVersion: string;
  };
};

type BridgeControlStatusResponse = {
  ok: true;
  instanceId: string;
  protocolVersion: string;
  bridgeVersion: string;
  daemonPid: number;
  supervisorPid?: number;
  startedAt: string;
  state: "running";
};

type StartupLockMetadata = {
  pid: number;
  startedAt: string;
  instanceAttemptId: string;
};

type StartupLockAcquisition =
  | { acquired: true; metadata: StartupLockMetadata }
  | { acquired: false; reason: "active" | "unavailable" };

export function createManagedBridgeRuntime(options: ManagedBridgeRuntimeOptions = {}): ManagedBridgeRuntime {
  const env = options.env ?? currentProcessEnv();
  const statePath = options.statePath ?? bridgeAppStatePath(env);
  const lockPath = options.lockPath ?? join(dirname(statePath), "bridge-start.lock");
  const readState = options.readState ?? (() => readBridgeAppState(statePath));
  const writeState = options.writeState ?? (state => writeBridgeAppState(state, statePath));
  const fetchBridge = options.fetch ?? ((input, init) => fetch(input, init));
  const probeTcpEndpoint = options.probeTcpEndpoint
    ?? (bridgeApiUrl => defaultTcpEndpointProbe(bridgeApiUrl, probeTimeoutMs));
  const processIsAlive = options.processIsAlive ?? defaultProcessIsAlive;
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const createAttemptId = options.createAttemptId ?? (() => `bridge_attempt_${randomBytes(12).toString("base64url")}`);
  const currentPid = options.currentPid ?? process.pid;
  const probeTimeoutMs = options.probeTimeoutMs ?? 1_500;
  const coordinationTimeoutMs = options.coordinationTimeoutMs ?? 8_000;
  const startTimeoutMs = options.startTimeoutMs ?? 12_000;
  const stopTimeoutMs = options.stopTimeoutMs ?? 8_000;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const configuredEndpoint = resolveBridgeApiServerConfig(env);
  const canonicalBridgeApiUrl = normalizeBridgeApiUrl(
    options.canonicalBridgeApiUrl
      ?? (configuredEndpoint.ok ? endpointUrl(configuredEndpoint.value.bridgeApi) : undefined)
  );

  async function discoverInternal(ignoreLockAttemptId?: string): Promise<ManagedBridgeDiscovery> {
    const stateRead = safelyReadState(readState);
    if (!stateRead.ok) {
      return { state: "stale", reason: "Bridge App state could not be read." };
    }
    const state = stateRead.value;
    const candidates = uniqueBridgeApiUrls([state.bridgeApiUrl, canonicalBridgeApiUrl]);
    const probes = await Promise.all(candidates.map(bridgeApiUrl => probeEndpoint(bridgeApiUrl, state.controlToken)));
    const managed = probes.find((probe): probe is Extract<EndpointProbe, { kind: "managed" }> => probe.kind === "managed");
    if (managed) {
      const discovery: ManagedBridgeDiscovery = {
        state: "running-managed",
        bridgeApiUrl: managed.bridgeApiUrl,
        instanceId: managed.instanceId,
        daemonPid: managed.daemonPid,
        supervisorPid: managed.supervisorPid,
        startedAt: managed.startedAt,
        bridgeVersion: managed.bridgeVersion,
        protocolVersion: managed.protocolVersion
      };
      options.writeStructuredLog?.({
        event: "bridge.discovery.completed",
        state: discovery.state,
        bridgeApiUrl: discovery.bridgeApiUrl,
        instanceId: discovery.instanceId
      });
      return discovery;
    }
    const hunsu = probes.find((probe): probe is Extract<EndpointProbe, { kind: "hunsu-unmanaged" }> => probe.kind === "hunsu-unmanaged");
    if (hunsu) {
      const discovery: ManagedBridgeDiscovery = {
        state: "running-unmanaged",
        bridgeApiUrl: hunsu.bridgeApiUrl,
        reason: hunsu.reason
      };
      options.writeStructuredLog?.({ event: "bridge.discovery.completed", state: discovery.state, bridgeApiUrl: discovery.bridgeApiUrl });
      return discovery;
    }
    const conflict = probes.find((probe): probe is Extract<EndpointProbe, { kind: "conflict" }> => probe.kind === "conflict");
    if (conflict) {
      const discovery: ManagedBridgeDiscovery = {
        state: "port-conflict",
        bridgeApiUrl: conflict.bridgeApiUrl,
        reason: "The configured Bridge endpoint is owned by another service."
      };
      options.writeStructuredLog?.({ event: "bridge.discovery.completed", state: discovery.state, bridgeApiUrl: discovery.bridgeApiUrl });
      return discovery;
    }

    const activeLock = readActiveStartupLock(lockPath, processIsAlive);
    if (activeLock && activeLock.instanceAttemptId !== ignoreLockAttemptId) {
      return { state: "starting", reason: "Another Bridge startup attempt is in progress." };
    }

    if (hasPersistedRuntimeEvidence(state)) {
      safelyWriteState(writeState, clearManagedBridgeRuntimeState(state));
      return { state: "stale", reason: "Persisted Bridge runtime state no longer identifies a reachable daemon." };
    }
    if (!canonicalBridgeApiUrl) {
      return { state: "stale", reason: "The configured Bridge endpoint is invalid." };
    }
    return { state: "not-running" };
  }

  async function probeEndpoint(bridgeApiUrl: string, controlToken: string | undefined): Promise<EndpointProbe> {
    const healthResponse = await safeFetch(new URL("/health", bridgeApiUrl).toString(), { method: "GET" });
    if (!healthResponse) {
      return await probeTcpEndpoint(bridgeApiUrl)
        ? { kind: "conflict", bridgeApiUrl }
        : { kind: "offline", bridgeApiUrl };
    }
    const healthBody = await safeJson(healthResponse);
    if (!healthResponse.ok || !isBridgeHealthResponse(healthBody)) {
      return { kind: "conflict", bridgeApiUrl };
    }
    if (!controlToken?.trim()) {
      return {
        kind: "hunsu-unmanaged",
        bridgeApiUrl,
        reason: "A Hunsu Bridge is running, but this Bridge App has no control credential for it."
      };
    }
    const statusResponse = await safeFetch(new URL("/api/bridge/control/status", bridgeApiUrl).toString(), {
      method: "GET",
      headers: { [CONTROL_TOKEN_HEADER]: controlToken }
    });
    if (!statusResponse) {
      return {
        kind: "hunsu-unmanaged",
        bridgeApiUrl,
        reason: "The Hunsu Bridge control endpoint is unavailable."
      };
    }
    const statusBody = await safeJson(statusResponse);
    if (!statusResponse.ok || !isBridgeControlStatusResponse(statusBody)) {
      return {
        kind: "hunsu-unmanaged",
        bridgeApiUrl,
        reason: statusResponse.status === 401
          ? "The running Hunsu Bridge is not owned by this Bridge App."
          : "The running Hunsu Bridge did not provide authenticated lifecycle identity."
      };
    }
    return {
      kind: "managed",
      bridgeApiUrl,
      instanceId: statusBody.instanceId,
      daemonPid: statusBody.daemonPid,
      supervisorPid: statusBody.supervisorPid,
      startedAt: statusBody.startedAt,
      bridgeVersion: statusBody.bridgeVersion,
      protocolVersion: statusBody.protocolVersion
    };
  }

  async function safeFetch(url: string, init: RequestInit): Promise<Response | undefined> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), probeTimeoutMs);
    try {
      return await fetchBridge(url, { ...init, signal: controller.signal });
    } catch (_error) {
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function waitForCoordination(): Promise<ManagedBridgeDiscovery | undefined> {
    const deadline = now().getTime() + coordinationTimeoutMs;
    while (now().getTime() <= deadline) {
      const discovery = await discoverInternal();
      if (discovery.state !== "starting") {
        return discovery;
      }
      await sleep(pollIntervalMs);
    }
    return undefined;
  }

  async function waitForStartedRuntime(attemptId: string): Promise<ManagedBridgeDiscovery> {
    const deadline = now().getTime() + startTimeoutMs;
    let last: ManagedBridgeDiscovery = { state: "not-running" };
    while (now().getTime() <= deadline) {
      last = await discoverInternal(attemptId);
      if (last.state === "running-managed") {
        return last;
      }
      await sleep(pollIntervalMs);
    }
    return last;
  }

  function loggedEnsureFailureForDiscovery(
    discovery: ManagedBridgeDiscovery
  ): Extract<ManagedBridgeEnsureResult, { ok: false }> | undefined {
    const result = ensureFailureForDiscovery(discovery);
    if (!result) {
      return undefined;
    }
    options.writeStructuredLog?.({
      event: discovery.state === "running-unmanaged"
        ? "bridge.ensure-running.unmanaged"
        : "bridge.ensure-running.port-conflict",
      state: discovery.state,
      bridgeApiUrl: "bridgeApiUrl" in discovery ? discovery.bridgeApiUrl : undefined,
      code: result.error.code
    });
    return result;
  }

  async function ensureManagedBridgeRunning(input: ManagedBridgeEnsureInput = {}): Promise<ManagedBridgeEnsureResult> {
    let discovery = await discoverInternal();
    if (discovery.state === "running-managed") {
      options.writeStructuredLog?.({ event: "bridge.ensure-running.reused", instanceId: discovery.instanceId, bridgeApiUrl: discovery.bridgeApiUrl });
      return managedEnsureSuccess(discovery, "reused");
    }
    const immediateFailure = loggedEnsureFailureForDiscovery(discovery);
    if (immediateFailure) {
      return immediateFailure;
    }
    if (discovery.state === "starting") {
      const coordinated = await waitForCoordination();
      if (!coordinated) {
        return fail("BRIDGE_START_COORDINATION_TIMEOUT", "Timed out waiting for another Bridge startup attempt.");
      }
      discovery = coordinated;
      if (discovery.state === "running-managed") {
        options.writeStructuredLog?.({ event: "bridge.ensure-running.reused", instanceId: discovery.instanceId, bridgeApiUrl: discovery.bridgeApiUrl });
        return managedEnsureSuccess(discovery, "reused");
      }
      const coordinatedFailure = loggedEnsureFailureForDiscovery(discovery);
      if (coordinatedFailure) {
        return coordinatedFailure;
      }
    }

    if (!canonicalBridgeApiUrl) {
      return fail("BRIDGE_CONTROL_UNAVAILABLE", "The local Bridge endpoint configuration is invalid.");
    }
    const attemptId = createAttemptId();
    const lock = acquireStartupLock(lockPath, {
      pid: currentPid,
      startedAt: now().toISOString(),
      instanceAttemptId: attemptId
    }, processIsAlive);
    if (!lock.acquired) {
      if (lock.reason === "active") {
        const coordinated = await waitForCoordination();
        if (coordinated?.state === "running-managed") {
          options.writeStructuredLog?.({ event: "bridge.ensure-running.reused", instanceId: coordinated.instanceId, bridgeApiUrl: coordinated.bridgeApiUrl });
          return managedEnsureSuccess(coordinated, "reused");
        }
        const coordinatedFailure = coordinated && loggedEnsureFailureForDiscovery(coordinated);
        return coordinatedFailure
          ?? fail("BRIDGE_START_COORDINATION_TIMEOUT", "Timed out waiting for the coordinated Bridge startup.");
      }
      return fail("BRIDGE_START_COORDINATION_TIMEOUT", "Bridge startup coordination is unavailable.");
    }

    try {
      discovery = await discoverInternal(attemptId);
      if (discovery.state === "running-managed") {
        options.writeStructuredLog?.({ event: "bridge.ensure-running.reused", instanceId: discovery.instanceId, bridgeApiUrl: discovery.bridgeApiUrl });
        return managedEnsureSuccess(discovery, "reused");
      }
      const lockedFailure = loggedEnsureFailureForDiscovery(discovery);
      if (lockedFailure) {
        return lockedFailure;
      }
      if (!options.startSupervisor) {
        return fail("BRIDGE_START_TIMEOUT", "No managed Bridge supervisor starter is configured.");
      }
      try {
        await options.startSupervisor({
          attemptId,
          canonicalBridgeApiUrl,
          cwd: input.cwd,
          webUrl: input.webUrl
        });
      } catch (_error) {
        const raced = await discoverInternal(attemptId);
        if (raced.state === "running-managed") {
          options.writeStructuredLog?.({ event: "bridge.ensure-running.reused", instanceId: raced.instanceId, bridgeApiUrl: raced.bridgeApiUrl });
          return managedEnsureSuccess(raced, "reused");
        }
        const racedFailure = loggedEnsureFailureForDiscovery(raced);
        return racedFailure ?? fail("BRIDGE_START_TIMEOUT", "The managed Bridge supervisor could not be started.");
      }

      const started = await waitForStartedRuntime(attemptId);
      if (started.state === "running-managed") {
        options.writeStructuredLog?.({ event: "bridge.ensure-running.started", instanceId: started.instanceId, bridgeApiUrl: started.bridgeApiUrl });
        return managedEnsureSuccess(started, "started");
      }
      return loggedEnsureFailureForDiscovery(started)
        ?? fail("BRIDGE_START_TIMEOUT", "Timed out waiting for authenticated Bridge startup.");
    } finally {
      releaseStartupLock(lockPath, attemptId);
    }
  }

  async function stopManagedBridge(): Promise<ManagedBridgeStopResult> {
    const discovery = await discoverInternal();
    if (discovery.state === "not-running" || discovery.state === "stale") {
      return success({ previousState: "not-running", state: "stopped" });
    }
    if (discovery.state === "running-unmanaged" || discovery.state === "port-conflict") {
      return fail("BRIDGE_NOT_OWNED", "The running process is not managed by this Bridge App.", false);
    }
    if (discovery.state === "starting") {
      return fail("BRIDGE_CONTROL_UNAVAILABLE", "Bridge ownership is still being established.", false);
    }
    const stateRead = safelyReadState(readState);
    const controlToken = stateRead.ok ? stateRead.value.controlToken : undefined;
    if (!controlToken) {
      return fail("BRIDGE_NOT_OWNED", "The managed Bridge control credential is unavailable.", false);
    }
    options.writeStructuredLog?.({ event: "bridge.stop.requested", instanceId: discovery.instanceId, bridgeApiUrl: discovery.bridgeApiUrl });
    const response = await safeFetch(new URL("/api/bridge/control/shutdown", discovery.bridgeApiUrl).toString(), {
      method: "POST",
      headers: { [CONTROL_TOKEN_HEADER]: controlToken }
    });
    if (!response?.ok) {
      options.writeStructuredLog?.({ event: "bridge.stop.failed", instanceId: discovery.instanceId, reason: "control-unavailable" });
      return fail("BRIDGE_CONTROL_UNAVAILABLE", "The managed Bridge did not accept the shutdown request.", false);
    }
    const deadline = now().getTime() + stopTimeoutMs;
    while (now().getTime() <= deadline) {
      const current = await discoverInternal();
      const daemonExited = !processIsAlive(discovery.daemonPid);
      const supervisorExited = discovery.supervisorPid === undefined || !processIsAlive(discovery.supervisorPid);
      if ((current.state === "not-running" || current.state === "stale") && daemonExited && supervisorExited) {
        const latest = safelyReadState(readState);
        if (latest.ok) {
          safelyWriteState(writeState, clearManagedBridgeRuntimeState(latest.value));
        }
        options.writeStructuredLog?.({ event: "bridge.stop.completed", instanceId: discovery.instanceId });
        return success({ previousState: "running-managed", state: "stopped" });
      }
      await sleep(pollIntervalMs);
    }
    options.writeStructuredLog?.({ event: "bridge.stop.failed", instanceId: discovery.instanceId, reason: "timeout" });
    return fail("BRIDGE_STOP_TIMEOUT", "Timed out waiting for the managed Bridge to stop.", false);
  }

  async function pairingOperation(
    action: "pair" | "open-roadmap",
    input: ManagedBridgePairingInput
  ): Promise<ManagedBridgeBrowserResult> {
    const ensured = await ensureManagedBridgeRunning({ cwd: input.cwd, webUrl: input.webUrl });
    if (!ensured.ok) {
      logOpenRoadmapFailure(action, input.roadmapId, ensured.error);
      return ensured;
    }
    const stateRead = safelyReadState(readState);
    const controlToken = stateRead.ok ? stateRead.value.controlToken : undefined;
    if (!controlToken) {
      const result = fail("BRIDGE_CONTROL_UNAVAILABLE", "The managed Bridge control credential is unavailable.");
      logOpenRoadmapFailure(action, input.roadmapId, result.error);
      return result;
    }
    const response = await safeFetch(new URL("/api/bridge/pairing/rotate", ensured.value.bridgeApiUrl).toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [CONTROL_TOKEN_HEADER]: controlToken
      },
      body: JSON.stringify({
        webUrl: input.webUrl,
        roadmapId: input.roadmapId
      })
    });
    const body = response ? await safeJson(response) : undefined;
    const studioUrl = response?.ok && isRecord(body) && typeof body.studioUrl === "string"
      ? safeBrowserUrl(body.studioUrl)
      : undefined;
    if (!studioUrl) {
      const result = fail("PAIRING_ROTATION_FAILED", "The managed Bridge could not create a fresh browser pairing.");
      logOpenRoadmapFailure(action, input.roadmapId, result.error);
      return result;
    }
    options.writeStructuredLog?.({
      event: "bridge.pairing.rotated",
      bridgeApiUrl: ensured.value.bridgeApiUrl,
      instanceId: ensured.value.instanceId,
      roadmapId: input.roadmapId
    });
    const openBrowser = input.openBrowser ?? true;
    if (openBrowser) {
      if (!options.openUrl) {
        const result = fail("BROWSER_OPEN_FAILED", "No browser opener is configured for this Bridge operation.");
        logOpenRoadmapFailure(action, input.roadmapId, result.error);
        return result;
      }
      try {
        await options.openUrl(studioUrl);
      } catch (_error) {
        const result = fail("BROWSER_OPEN_FAILED", "The paired Hunsu Web page could not be opened.");
        logOpenRoadmapFailure(action, input.roadmapId, result.error);
        return result;
      }
    }
    const value: Extract<ManagedBridgeBrowserResult, { ok: true }>["value"] = {
      action,
      bridgeApiUrl: ensured.value.bridgeApiUrl,
      instanceId: ensured.value.instanceId,
      roadmapId: input.roadmapId,
      browserOpened: openBrowser
    };
    options.writeStructuredLog?.({
      event: action === "open-roadmap" ? "bridge.open-roadmap.completed" : "ui.operation.completed",
      action,
      instanceId: ensured.value.instanceId,
      roadmapId: input.roadmapId
    });
    return success(value);
  }

  function logOpenRoadmapFailure(
    action: "pair" | "open-roadmap",
    roadmapId: string | undefined,
    error: ManagedBridgeOperationError
  ): void {
    if (action !== "open-roadmap") {
      return;
    }
    options.writeStructuredLog?.({
      event: "bridge.open-roadmap.failed",
      roadmapId,
      code: error.code
    });
  }

  return {
    discoverManagedBridge: () => discoverInternal(),
    ensureManagedBridgeRunning,
    stopManagedBridge,
    createManagedPairing: (input = {}) => pairingOperation("pair", input),
    openManagedRoadmap: (roadmapId, input = {}) => {
      const normalizedRoadmapId = roadmapId.trim();
      if (!normalizedRoadmapId) {
        const result = fail("ROADMAP_NOT_FOUND", "A Roadmap ID is required.");
        logOpenRoadmapFailure("open-roadmap", undefined, result.error);
        return Promise.resolve(result);
      }
      return pairingOperation("open-roadmap", { ...input, roadmapId: normalizedRoadmapId });
    }
  };
}

export function discoverManagedBridge(options: ManagedBridgeRuntimeOptions = {}): Promise<ManagedBridgeDiscovery> {
  return createManagedBridgeRuntime(options).discoverManagedBridge();
}

export function ensureManagedBridgeRunning(
  options: ManagedBridgeRuntimeOptions,
  input: ManagedBridgeEnsureInput = {}
): Promise<ManagedBridgeEnsureResult> {
  return createManagedBridgeRuntime(options).ensureManagedBridgeRunning(input);
}

export function stopManagedBridge(options: ManagedBridgeRuntimeOptions = {}): Promise<ManagedBridgeStopResult> {
  return createManagedBridgeRuntime(options).stopManagedBridge();
}

export function createManagedPairing(
  options: ManagedBridgeRuntimeOptions,
  input: ManagedBridgePairingInput = {}
): Promise<ManagedBridgeBrowserResult> {
  return createManagedBridgeRuntime(options).createManagedPairing(input);
}

export function openManagedRoadmap(
  roadmapId: string,
  options: ManagedBridgeRuntimeOptions,
  input: Omit<ManagedBridgePairingInput, "roadmapId"> = {}
): Promise<ManagedBridgeBrowserResult> {
  return createManagedBridgeRuntime(options).openManagedRoadmap(roadmapId, input);
}

export function clearManagedBridgeRuntimeState(state: BridgeAppState): BridgeAppState {
  return {
    ...state,
    supervisorPid: undefined,
    pid: undefined,
    supervisorProcess: undefined,
    bridgeProcess: undefined,
    bridgeApiUrl: undefined,
    instanceId: undefined,
    processNonce: undefined,
    commandIdentity: undefined,
    controlToken: undefined,
    pairing: undefined,
    startedAt: undefined
  };
}

function managedEnsureSuccess(
  discovery: Extract<ManagedBridgeDiscovery, { state: "running-managed" }>,
  transition: "reused" | "started"
): ManagedBridgeEnsureResult {
  return success({ ...discovery, transition });
}

function ensureFailureForDiscovery(
  discovery: ManagedBridgeDiscovery
): Extract<ManagedBridgeEnsureResult, { ok: false }> | undefined {
  if (discovery.state === "running-unmanaged") {
    return fail("BRIDGE_ALREADY_RUNNING_UNMANAGED", "A Hunsu Bridge is already running but is not managed by this Bridge App.");
  }
  if (discovery.state === "port-conflict") {
    return fail("BRIDGE_PORT_IN_USE", "The configured Hunsu Bridge port is already in use by another service.");
  }
  return undefined;
}

function success<T>(value: T): ManagedBridgeResult<T> {
  return { ok: true, value };
}

function fail(
  code: ManagedBridgeErrorCode,
  message: string,
  canForceStop?: false
): { ok: false; error: ManagedBridgeOperationError } {
  return { ok: false, error: { code, message, canForceStop } };
}

function safelyReadState(readState: () => BridgeAppState): ManagedBridgeResult<BridgeAppState> {
  try {
    return success(readState());
  } catch (_error) {
    return fail("BRIDGE_CONTROL_UNAVAILABLE", "Bridge App state could not be read.");
  }
}

function safelyWriteState(writeState: (state: BridgeAppState) => void, state: BridgeAppState): boolean {
  try {
    writeState(state);
    return true;
  } catch (_error) {
    return false;
  }
}

function hasPersistedRuntimeEvidence(state: BridgeAppState): boolean {
  return Boolean(
    state.supervisorPid
      || state.pid
      || state.bridgeApiUrl
      || state.controlToken
      || state.pairing
      || state.startedAt
  );
}

function normalizeBridgeApiUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    return url.origin;
  } catch (_error) {
    return undefined;
  }
}

function uniqueBridgeApiUrls(values: Array<string | undefined>): string[] {
  return [...new Set(values.map(normalizeBridgeApiUrl).filter((value): value is string => value !== undefined))];
}

function isBridgeHealthResponse(value: unknown): value is BridgeHealthResponse {
  return isRecord(value)
    && value.ok === true
    && value.service === "hunsu-bridge"
    && isRecord(value.version)
    && typeof value.version.bridgeVersion === "string"
    && typeof value.version.protocolVersion === "string";
}

function isBridgeControlStatusResponse(value: unknown): value is BridgeControlStatusResponse {
  return isRecord(value)
    && value.ok === true
    && value.state === "running"
    && typeof value.instanceId === "string"
    && value.instanceId.startsWith("bridge_instance_")
    && typeof value.protocolVersion === "string"
    && typeof value.bridgeVersion === "string"
    && isPositiveProcessId(value.daemonPid)
    && (value.supervisorPid === undefined || isPositiveProcessId(value.supervisorPid))
    && typeof value.startedAt === "string";
}

function isPositiveProcessId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (_error) {
    return undefined;
  }
}

function safeBrowserUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch (_error) {
    return undefined;
  }
}

function defaultProcessIsAlive(pid: number): boolean {
  if (!isPositiveProcessId(pid)) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error
      && "code" in error
      && (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function defaultTcpEndpointProbe(bridgeApiUrl: string, timeoutMs: number): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(bridgeApiUrl);
  } catch (_error) {
    return Promise.resolve(false);
  }
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    return Promise.resolve(false);
  }
  return new Promise(resolve => {
    const socket = createConnection({ host: url.hostname, port });
    let settled = false;
    const finish = (reachable: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function acquireStartupLock(
  path: string,
  metadata: StartupLockMetadata,
  processIsAlive: (pid: number) => boolean
): StartupLockAcquisition {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(path, "wx", 0o600);
      writeFileSync(descriptor, `${JSON.stringify(metadata)}\n`, "utf8");
      closeSync(descriptor);
      return { acquired: true, metadata };
    } catch (error) {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch (_closeError) {
          // The descriptor is already closed or unusable.
        }
      }
      if (!isAlreadyExistsError(error)) {
        return { acquired: false, reason: "unavailable" };
      }
      const existing = readStartupLock(path);
      if (existing && processIsAlive(existing.pid)) {
        return { acquired: false, reason: "active" };
      }
      try {
        rmSync(path, { force: true });
      } catch (_removeError) {
        return { acquired: false, reason: "unavailable" };
      }
    }
  }
  return { acquired: false, reason: "unavailable" };
}

function readActiveStartupLock(
  path: string,
  processIsAlive: (pid: number) => boolean
): StartupLockMetadata | undefined {
  const metadata = readStartupLock(path);
  if (!metadata) {
    try {
      rmSync(path, { force: true });
    } catch (_error) {
      // Discovery still proceeds; exclusive acquisition will report any real failure.
    }
    return undefined;
  }
  if (processIsAlive(metadata.pid)) {
    return metadata;
  }
  try {
    rmSync(path, { force: true });
  } catch (_error) {
    // Exclusive acquisition remains authoritative if cleanup fails.
  }
  return undefined;
}

function readStartupLock(path: string): StartupLockMetadata | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(value)
      || !isPositiveProcessId(value.pid)
      || typeof value.startedAt !== "string"
      || typeof value.instanceAttemptId !== "string"
      || !value.instanceAttemptId) {
      return undefined;
    }
    return {
      pid: value.pid,
      startedAt: value.startedAt,
      instanceAttemptId: value.instanceAttemptId
    };
  } catch (_error) {
    return undefined;
  }
}

function releaseStartupLock(path: string, attemptId: string): void {
  const metadata = readStartupLock(path);
  if (metadata?.instanceAttemptId !== attemptId) {
    return;
  }
  try {
    rmSync(path, { force: true });
  } catch (_error) {
    // A stale lock is recovered on the next ensure-running attempt.
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "EEXIST";
}
