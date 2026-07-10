import type { RuntimeProviderRegistry, RuntimeProviderStatus } from "../runtime-providers/types.ts";
import type { BridgeBackendStatus } from "../connections/localConnection.ts";
import type { ModelAlias, ModelSelection, ProviderInventoryResult } from "@hunsu/protocol";
import {
  executePreflightErrorFromModelError,
  modelSelectionResolutionFromInventoryError,
  providerInventoryBackendUnavailable,
  providerInventoryForBridgeStatus,
  resolveModelSelection
} from "../model-aliases/modelAliasStore.ts";
import {
  workspaceSummaryFromRoadmap,
  type ConnectedWorkspaceSummary,
  type RoadmapRegistryWorkspaceEntry
} from "../workspaces/workspaceRegistry.ts";

export type ExecuteStartBackendSelection = {
  backendId?: string;
  connectionMode?: "local" | "remote";
  modelSelection?: ModelSelection;
  aliases?: ModelAlias[];
  workspace?: {
    workspaceId?: string;
    backendId?: string;
    connectionMode?: "local" | "remote";
  };
};

export type ExecutePreflightBridgeStatus = {
  account: {
    signedIn: boolean;
  };
  connections: BridgeBackendStatus[];
};

export type ExecuteModelSelectionCandidate = {
  selection?: ModelSelection;
  aliases?: ModelAlias[];
};

export type ExecutePreflightAction = {
  type:
    | "open_bridge_app"
    | "open_provider_setup"
    | "open_workspaces"
    | "open_connection"
    | "install_provider"
    | "login_provider"
    | "recheck_provider"
    | "activate_workspace"
    | "edit_model_alias";
  label: string;
  href?: string;
  workspaceId?: string;
  providerId?: string;
};

export type ProviderAwareExecutePreflightError =
  | {
      area: "provider";
      providerId: string;
      error:
        | "PROVIDER_MISSING"
        | "PROVIDER_LOGIN_REQUIRED"
        | "PROVIDER_AUTH_EXPIRED"
        | "PROVIDER_UNAVAILABLE"
        | "PROVIDER_RATE_LIMITED"
        | "PROVIDER_CAPABILITY_MISSING";
      message: string;
      actions: ExecutePreflightAction[];
    }
  | {
      area: "workspace";
      workspaceId?: string;
      error:
        | "WORKSPACE_INACTIVE"
        | "WORKSPACE_MISSING"
        | "WORKSPACE_NEEDS_UPGRADE"
        | "WORKSPACE_UNHEALTHY";
      message: string;
      actions: ExecutePreflightAction[];
    }
  | {
      area: "connection";
      backendId?: string;
      error:
        | "BRIDGE_NOT_CONNECTED"
        | "REMOTE_NOT_CONNECTED"
        | "REMOTE_LOGIN_REQUIRED";
      message: string;
      actions: ExecutePreflightAction[];
    }
  | {
      area: "model";
      backendId: string;
      providerId?: string;
      aliasId?: string;
      model?: string;
      error:
        | "MODEL_ALIAS_NOT_FOUND"
        | "PROVIDER_INVENTORY_UNAVAILABLE"
        | "PROVIDER_NOT_READY"
        | "PROVIDER_LOGIN_REQUIRED"
        | "MODEL_UNSUPPORTED"
        | "REASONING_UNSUPPORTED"
        | "SERVICE_TIER_UNSUPPORTED";
      message: string;
      actions: ExecutePreflightAction[];
    };

export function providerExecutePreflightError(provider: RuntimeProviderStatus): ProviderAwareExecutePreflightError | undefined {
  if (!provider.installed) {
    const action: ExecutePreflightAction = provider.recommendedAction === "select_binary"
      ? { type: "open_provider_setup", label: `Select ${provider.label} Binary`, href: `hunsu://provider/${provider.providerId}`, providerId: provider.providerId }
      : { type: "install_provider", label: `Install ${provider.label}`, href: `hunsu://provider/${provider.providerId}`, providerId: provider.providerId };
    return providerError(provider, "PROVIDER_MISSING", provider.safeMessage ?? `${provider.label} is not installed or could not be found.`, [action]);
  }
  if (!provider.configured) {
    return providerError(provider, "PROVIDER_UNAVAILABLE", `${provider.label} is installed but unavailable.`, [
      { type: "recheck_provider", label: `Recheck ${provider.label}`, href: `hunsu://provider/${provider.providerId}`, providerId: provider.providerId }
    ]);
  }
  if (provider.auth.state === "not_authenticated") {
    return providerError(provider, "PROVIDER_LOGIN_REQUIRED", `${provider.label} login is required before Execute can start.`, [
      { type: "login_provider", label: `Sign in to ${provider.label}`, href: `hunsu://provider/${provider.providerId}`, providerId: provider.providerId }
    ]);
  }
  if (provider.auth.state === "expired" || provider.auth.state === "invalid") {
    return providerError(provider, "PROVIDER_AUTH_EXPIRED", `${provider.label} authentication needs to be refreshed.`, [
      { type: "login_provider", label: `Sign in to ${provider.label}`, href: `hunsu://provider/${provider.providerId}`, providerId: provider.providerId },
      { type: "recheck_provider", label: `Recheck ${provider.label}`, href: `hunsu://provider/${provider.providerId}`, providerId: provider.providerId }
    ]);
  }
  if (provider.usage?.rateLimited) {
    return providerError(provider, "PROVIDER_RATE_LIMITED", `${provider.label} is temporarily rate limited.`, [
      { type: "recheck_provider", label: `Recheck ${provider.label}`, href: `hunsu://provider/${provider.providerId}`, providerId: provider.providerId }
    ]);
  }
  if (!provider.capabilities.canExecute) {
    return providerError(provider, "PROVIDER_CAPABILITY_MISSING", `${provider.label} cannot execute Hunsu workspaces.`, [
      { type: "open_provider_setup", label: "Open Provider Setup", href: "hunsu://provider" }
    ]);
  }
  return undefined;
}

export function workspaceExecutePreflightError(workspace: ConnectedWorkspaceSummary | undefined): ProviderAwareExecutePreflightError | undefined {
  if (!workspace) {
    return workspaceError(undefined, "WORKSPACE_MISSING", "Choose an active Workspace before starting Execute.");
  }
  if (workspace.lifecycle === "inactive") {
    return workspaceError(workspace.workspaceId, "WORKSPACE_INACTIVE", "This Workspace is inactive. Activate it in Hunsu Bridge before starting Execute.");
  }
  if (workspace.lifecycle === "missing") {
    return workspaceError(workspace.workspaceId, "WORKSPACE_MISSING", "This Workspace path is missing. Repair or remove it in Hunsu Bridge.");
  }
  if (workspace.lifecycle === "needs_upgrade") {
    return workspaceError(workspace.workspaceId, "WORKSPACE_NEEDS_UPGRADE", "This Workspace needs an upgrade before Execute can start.");
  }
  if (workspace.lifecycle === "error" || workspace.health === "error" || workspace.health === "unknown") {
    return workspaceError(workspace.workspaceId, "WORKSPACE_UNHEALTHY", "This Workspace needs attention before Execute can start.");
  }
  return undefined;
}

export function workspaceExecutePreflightErrorFromRoadmap(
  roadmap: RoadmapRegistryWorkspaceEntry | undefined,
  provider: RuntimeProviderStatus
): ProviderAwareExecutePreflightError | undefined {
  return workspaceExecutePreflightError(roadmap ? workspaceSummaryFromRoadmap(roadmap, { provider }) : undefined);
}

export function providerWorkspaceExecutePreflightErrorForSelection(
  input: ExecuteStartBackendSelection,
  status: ExecutePreflightBridgeStatus,
  fallback: {
    provider: RuntimeProviderStatus;
    workspace?: ConnectedWorkspaceSummary;
  }
): ProviderAwareExecutePreflightError | undefined {
  const selection = selectedExecuteBackend(input);
  const backend = selectedBridgeBackend(status.connections, selection);
  const provider = backend?.provider ?? fallback.provider;
  const workspaceId = firstNonEmpty(input.workspace?.workspaceId, fallback.workspace?.workspaceId);
  const selectedWorkspace = backend?.workspaces.find(candidate =>
    candidate.workspaceId === workspaceId || candidate.roadmapId === workspaceId
  );
  const workspace = backend?.mode === "remote" ? selectedWorkspace : selectedWorkspace ?? fallback.workspace;
  return workspaceExecutePreflightError(workspace) ?? providerExecutePreflightError(provider);
}

export function modelExecutePreflightErrorForSelection(
  input: ExecuteStartBackendSelection,
  status: ExecutePreflightBridgeStatus
): ProviderAwareExecutePreflightError | undefined {
  const aliases = input.aliases;
  if (!input.modelSelection && !aliases?.length) {
    return undefined;
  }
  const inventoryResult = providerInventoryForExecuteSelection(input, status);
  if (!inventoryResult.ok) {
    const resolution = modelSelectionResolutionFromInventoryError(inventoryResult.error);
    return executePreflightErrorFromModelError(resolution.error, resolution.backendId);
  }
  const inventory = inventoryResult.value;
  const resolution = resolveModelSelection({
    selection: input.modelSelection,
    aliases,
    backendId: inventory.backendId,
    inventories: inventory.providers
  });
  return resolution.ok ? undefined : executePreflightErrorFromModelError(resolution.error, resolution.backendId);
}

export function providerInventoryForExecuteSelection(
  input: ExecuteStartBackendSelection,
  status: ExecutePreflightBridgeStatus
): ProviderInventoryResult {
  const selection = selectedExecuteBackend(input);
  const backend = selectedBridgeBackend(status.connections, selection);
  if (selection.backendId && !backend) {
    return providerInventoryBackendUnavailable(
      selection.backendId,
      `Backend ${selection.backendId} is not connected to this Bridge.`
    );
  }
  if (selection.remoteRequested && !backend) {
    return providerInventoryBackendUnavailable(
      "remote",
      "No Remote Bridge backend is connected."
    );
  }
  const localBackend = status.connections.find(connection => connection.mode === "local");
  const selectedBackend = backend ?? localBackend;
  return providerInventoryForBridgeStatus({
    connections: status.connections,
    backendId: selection.backendId ?? selectedBackend?.backendId ?? "local"
  });
}

export async function resumeExecutePreflightErrorForSelection(
  input: ExecuteStartBackendSelection,
  status: ExecutePreflightBridgeStatus,
  options: {
    providerInventory: () => Promise<ProviderInventoryResult> | ProviderInventoryResult;
    modelSelections: () => Promise<ExecuteModelSelectionCandidate[]> | ExecuteModelSelectionCandidate[];
  }
): Promise<ProviderAwareExecutePreflightError | undefined> {
  const connectionError = connectionExecutePreflightErrorForSelection(input, status);
  if (connectionError) {
    return connectionError;
  }

  const selection = selectedExecuteBackend(input);
  const selectedBackend = selectedBridgeBackend(status.connections, selection)
    ?? (selection.remoteRequested ? undefined : status.connections.find(connection => connection.mode === "local"));
  const providerError = selectedBackend ? providerExecutePreflightError(selectedBackend.provider) : undefined;
  if (providerError) {
    return providerError;
  }

  const inventoryResult = await options.providerInventory();
  if (!inventoryResult.ok) {
    const resolution = modelSelectionResolutionFromInventoryError(inventoryResult.error);
    return executePreflightErrorFromModelError(resolution.error, resolution.backendId);
  }

  const seen = new Set<string>();
  for (const candidate of await options.modelSelections()) {
    if (!candidate.selection && !candidate.aliases?.length) {
      continue;
    }
    const key = JSON.stringify(candidate);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const resolution = resolveModelSelection({
      selection: candidate.selection,
      aliases: candidate.aliases,
      backendId: inventoryResult.value.backendId,
      inventories: inventoryResult.value.providers
    });
    if (!resolution.ok) {
      return executePreflightErrorFromModelError(resolution.error, resolution.backendId);
    }
  }
  return undefined;
}

export function normalizeExecuteStartSelectionForLocalBridge<T extends ExecuteStartBackendSelection>(
  input: T,
  options: { localBridgeTokenPresent: boolean }
): T {
  // Local pairing proves that this Bridge can answer the request, but it must
  // not override an explicit local/remote backend chosen by Web.
  void options;
  return input;
}

export function executeStartHasExplicitBackendSelection(input: ExecuteStartBackendSelection): boolean {
  return Boolean(
    input.backendId?.trim()
    || input.connectionMode
    || input.workspace?.backendId?.trim()
    || input.workspace?.connectionMode
  );
}

export async function providerAwareExecutePreflightForRoadmap(
  roadmap: RoadmapRegistryWorkspaceEntry | undefined,
  registry: RuntimeProviderRegistry,
  env: Record<string, string | undefined>,
  selected?: {
    body: ExecuteStartBackendSelection;
    status: ExecutePreflightBridgeStatus;
  }
): Promise<ProviderAwareExecutePreflightError | undefined> {
  const provider = await registry.current().status({ env, force: true });
  if (selected) {
    return providerWorkspaceExecutePreflightErrorForSelection(selected.body, selected.status, {
      provider,
      workspace: roadmap ? workspaceSummaryFromRoadmap(roadmap, { provider }) : undefined
    });
  }
  return workspaceExecutePreflightErrorFromRoadmap(roadmap, provider) ?? providerExecutePreflightError(provider);
}

export async function providerAwareExecutePreflightForRepository(input: {
  repositoryPath: string;
  roadmaps: RoadmapRegistryWorkspaceEntry[];
  registry: RuntimeProviderRegistry;
  env: Record<string, string | undefined>;
  selected?: {
    body: ExecuteStartBackendSelection;
    status: ExecutePreflightBridgeStatus;
  };
}): Promise<ProviderAwareExecutePreflightError | undefined> {
  const normalizedRepositoryPath = normalizeRepositoryPath(input.repositoryPath);
  const roadmap = input.roadmaps.find(candidate => normalizeRepositoryPath(candidate.repositoryPath) === normalizedRepositoryPath);
  return providerAwareExecutePreflightForRoadmap(roadmap, input.registry, input.env, input.selected);
}

export function selectedExecuteBackend(input: ExecuteStartBackendSelection): {
  backendId?: string;
  connectionMode?: "local" | "remote";
  remoteRequested: boolean;
} {
  const backendId = firstNonEmpty(input.backendId, input.workspace?.backendId);
  const connectionMode = backendId
    ? isRemoteBackendId(backendId) ? "remote" : "local"
    : input.connectionMode ?? input.workspace?.connectionMode;
  const remoteRequested = connectionMode === "remote";
  return {
    backendId,
    connectionMode,
    remoteRequested
  };
}

export function connectionExecutePreflightErrorForSelection(
  input: ExecuteStartBackendSelection,
  status: ExecutePreflightBridgeStatus
): ProviderAwareExecutePreflightError | undefined {
  const selection = selectedExecuteBackend(input);
  const backend = selectedBridgeBackend(status.connections, selection);
  return connectionExecutePreflightError({
    backend,
    backendId: selection.backendId,
    remoteRequested: selection.remoteRequested,
    accountSignedIn: status.account.signedIn,
    localBridgeConnected: status.connections.some(connection => connection.mode === "local" && connection.connection.state === "connected")
  });
}

export function connectionExecutePreflightError(input: {
  backend?: BridgeBackendStatus;
  backendId?: string;
  remoteRequested?: boolean;
  accountSignedIn?: boolean;
  localBridgeConnected?: boolean;
}): ProviderAwareExecutePreflightError | undefined {
  if (input.localBridgeConnected === false && !input.remoteRequested) {
    return connectionError(input.backendId ?? "local", "BRIDGE_NOT_CONNECTED", "Hunsu Bridge is not connected.", [
      { type: "open_connection", label: "Open Connection", href: "hunsu://connection" }
    ]);
  }
  if (input.remoteRequested && input.accountSignedIn === false) {
    return connectionError(input.backendId, "REMOTE_LOGIN_REQUIRED", "Sign in to Hunsu before using Remote Bridge.", [
      { type: "open_connection", label: "Open Connection", href: "hunsu://connection/remote" }
    ]);
  }
  if (!input.backend) {
    if (input.remoteRequested) {
      return connectionError(input.backendId, "REMOTE_NOT_CONNECTED", "Remote Bridge is not connected.", [
        { type: "open_connection", label: "Open Connection", href: "hunsu://connection/remote" }
      ]);
    }
    return input.backendId
      ? connectionError(input.backendId, "BRIDGE_NOT_CONNECTED", `Backend ${input.backendId} is not connected to this Bridge.`, [
          { type: "open_connection", label: "Open Connection", href: "hunsu://connection" }
        ])
      : undefined;
  }
  if (input.backend.connection.state === "connected") {
    return undefined;
  }
  if (input.backend.connection.state === "login_required") {
    return connectionError(input.backend.backendId, "REMOTE_LOGIN_REQUIRED", "Sign in to Hunsu before using Remote Bridge.", [
      { type: "open_connection", label: "Open Connection", href: "hunsu://connection/remote" }
    ]);
  }
  if (input.backend.mode === "remote") {
    return connectionError(input.backend.backendId, "REMOTE_NOT_CONNECTED", "Remote Bridge is offline or unavailable.", [
      { type: "open_connection", label: "Open Connection", href: "hunsu://connection/remote" }
    ]);
  }
  return connectionError(input.backend.backendId, "BRIDGE_NOT_CONNECTED", "Hunsu Bridge is not connected.", [
    { type: "open_connection", label: "Open Connection", href: "hunsu://connection" }
  ]);
}

function selectedBridgeBackend(
  connections: BridgeBackendStatus[],
  selection: ReturnType<typeof selectedExecuteBackend>
): BridgeBackendStatus | undefined {
  if (selection.backendId) {
    return connections.find(connection => connection.backendId === selection.backendId);
  }
  if (selection.connectionMode === "local") {
    return connections.find(connection => connection.mode === "local");
  }
  if (selection.remoteRequested) {
    return connections.find(connection => connection.mode === "remote" && connection.connection.state === "connected")
      ?? connections.find(connection => connection.mode === "remote");
  }
  return undefined;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find(value => value?.trim())?.trim();
}

function isRemoteBackendId(backendId: string): boolean {
  return backendId === "remote" || backendId.startsWith("remote:");
}

function normalizeRepositoryPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function providerError(
  provider: RuntimeProviderStatus,
  error: Extract<ProviderAwareExecutePreflightError, { area: "provider" }>["error"],
  message: string,
  actions: ExecutePreflightAction[]
): ProviderAwareExecutePreflightError {
  return {
    area: "provider",
    providerId: provider.providerId,
    error,
    message,
    actions: [{ type: "open_provider_setup", label: "Open Provider Setup", href: `hunsu://provider/${provider.providerId}` }, ...actions]
  };
}

function connectionError(
  backendId: string | undefined,
  error: Extract<ProviderAwareExecutePreflightError, { area: "connection" }>["error"],
  message: string,
  actions: ExecutePreflightAction[]
): ProviderAwareExecutePreflightError {
  return {
    area: "connection",
    backendId,
    error,
    message,
    actions
  };
}

function workspaceError(
  workspaceId: string | undefined,
  error: Extract<ProviderAwareExecutePreflightError, { area: "workspace" }>["error"],
  message: string
): ProviderAwareExecutePreflightError {
  return {
    area: "workspace",
    workspaceId,
    error,
    message,
    actions: [
      { type: "open_workspaces", label: "Open Workspaces", href: "hunsu://workspaces" },
      ...(workspaceId ? [{ type: "activate_workspace" as const, label: "Activate Workspace", href: `hunsu://activate-workspace?workspaceId=${encodeURIComponent(workspaceId)}`, workspaceId }] : [])
    ]
  };
}
