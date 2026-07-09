import type { RuntimeProviderStatus } from "../runtime-providers/types.ts";

export type WorkspaceConnectionMode = "local" | "remote";

export type ConnectedWorkspaceSummary = {
  workspaceId: string;
  roadmapId: string;
  displayName: string;
  path?: string;
  pathRedacted?: boolean;
  lifecycle: "active" | "inactive" | "missing" | "needs_upgrade" | "error";
  health: "ok" | "missing" | "needs_upgrade" | "error" | "unknown";
  backendId: string;
  connectionMode: WorkspaceConnectionMode;
  provider: {
    providerId: string;
    label: string;
    readyForExecute: boolean;
  };
  actions: Array<"open_studio" | "activate" | "deactivate" | "remove" | "repair">;
};

export type RoadmapRegistryWorkspaceEntry = {
  roadmapId: string;
  displayName: string;
  repositoryPath: string;
  lifecycle?: "active" | "inactive" | "missing" | "needs_upgrade" | "error";
  health: "ok" | "missing" | "missing-runtime" | "needs-upgrade" | "git-dirty" | "unknown";
  primaryAction?: "open" | "port" | "repair" | "remove";
  remoteAccess?: {
    enabled: boolean;
    scopes: string[];
  };
};

export function workspaceSummaryFromRoadmap(
  roadmap: RoadmapRegistryWorkspaceEntry,
  input: {
    backendId?: string;
    connectionMode?: WorkspaceConnectionMode;
    provider: RuntimeProviderStatus;
    redactPath?: boolean;
  }
): ConnectedWorkspaceSummary {
  const lifecycle = workspaceLifecycle(roadmap.lifecycle);
  const path = input.redactPath ? undefined : roadmap.repositoryPath;
  return {
    workspaceId: roadmap.roadmapId,
    roadmapId: roadmap.roadmapId,
    displayName: roadmap.displayName,
    path,
    pathRedacted: input.redactPath || undefined,
    lifecycle,
    health: workspaceHealth(roadmap),
    backendId: input.backendId ?? "local",
    connectionMode: input.connectionMode ?? "local",
    provider: {
      providerId: input.provider.providerId,
      label: input.provider.label,
      readyForExecute: input.provider.ready
    },
    actions: workspaceActions(lifecycle, roadmap.primaryAction)
  };
}

export function workspaceSummariesFromRoadmaps(
  roadmaps: RoadmapRegistryWorkspaceEntry[],
  input: {
    provider: RuntimeProviderStatus;
    backendId?: string;
    connectionMode?: WorkspaceConnectionMode;
    activeOnly?: boolean;
    remoteOnly?: boolean;
    redactPath?: boolean;
  }
): ConnectedWorkspaceSummary[] {
  return roadmaps
    .filter(roadmap => input.activeOnly !== true || workspaceLifecycle(roadmap.lifecycle) === "active")
    .filter(roadmap => input.remoteOnly !== true || (roadmap.remoteAccess?.enabled === true && workspaceLifecycle(roadmap.lifecycle) === "active"))
    .map(roadmap => workspaceSummaryFromRoadmap(roadmap, input));
}

export function workspaceLifecycle(
  lifecycle: RoadmapRegistryWorkspaceEntry["lifecycle"] | undefined
): ConnectedWorkspaceSummary["lifecycle"] {
  if (lifecycle === "inactive" || lifecycle === "missing" || lifecycle === "needs_upgrade" || lifecycle === "error") {
    return lifecycle;
  }
  return "active";
}

function workspaceHealth(roadmap: RoadmapRegistryWorkspaceEntry): ConnectedWorkspaceSummary["health"] {
  if (roadmap.lifecycle === "missing" || roadmap.health === "missing") return "missing";
  if (roadmap.lifecycle === "needs_upgrade" || roadmap.health === "needs-upgrade" || roadmap.health === "missing-runtime") return "needs_upgrade";
  if (roadmap.lifecycle === "error") return "error";
  if (roadmap.health === "ok" || roadmap.health === "git-dirty") return "ok";
  return "unknown";
}

function workspaceActions(
  lifecycle: ConnectedWorkspaceSummary["lifecycle"],
  primaryAction?: RoadmapRegistryWorkspaceEntry["primaryAction"]
): ConnectedWorkspaceSummary["actions"] {
  const actions: ConnectedWorkspaceSummary["actions"] = [];
  if (lifecycle === "active") {
    actions.push("open_studio", "deactivate");
  } else if (lifecycle === "inactive") {
    actions.push("activate", "remove");
  } else {
    actions.push(primaryAction === "repair" ? "repair" : "remove");
  }
  return actions;
}
