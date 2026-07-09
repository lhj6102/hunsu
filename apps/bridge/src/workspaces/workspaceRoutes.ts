import type { IncomingMessage, ServerResponse } from "node:http";
import type { RuntimeProviderStatus } from "../runtime-providers/types.ts";
import {
  workspaceSummariesFromRoadmaps,
  workspaceSummaryFromRoadmap,
  type RoadmapRegistryWorkspaceEntry
} from "./workspaceRegistry.ts";

type WorkspaceRouteContext = {
  bridgeStatus: () => Promise<{
    workspaces: {
      active: unknown[];
      managed: unknown[];
    };
  }>;
  currentProvider: () => Promise<RuntimeProviderStatus>;
  managedRoadmaps: () => RoadmapRegistryWorkspaceEntry[];
  addWorkspace: (body: unknown) => Promise<{
    roadmap: RoadmapRegistryWorkspaceEntry;
    repository?: { root?: string };
  }> | {
    roadmap: RoadmapRegistryWorkspaceEntry;
    repository?: { root?: string };
  };
  setWorkspaceLifecycle: (body: unknown, lifecycle: "active" | "inactive") => Promise<{
    roadmap?: RoadmapRegistryWorkspaceEntry;
    roadmaps: RoadmapRegistryWorkspaceEntry[];
  }> | {
    roadmap?: RoadmapRegistryWorkspaceEntry;
    roadmaps: RoadmapRegistryWorkspaceEntry[];
  };
  removeWorkspace: (body: unknown) => Promise<{
    removed: boolean;
    roadmaps: RoadmapRegistryWorkspaceEntry[];
  }> | {
    removed: boolean;
    roadmaps: RoadmapRegistryWorkspaceEntry[];
  };
  recentRoadmaps: () => unknown[];
  removeRoadmap: (body: unknown) => Promise<unknown> | unknown;
  activateRoadmap: (body: unknown) => Promise<unknown> | unknown;
  deactivateRoadmap: (body: unknown) => Promise<unknown> | unknown;
  inspectProject: (body: unknown) => Promise<unknown> | unknown;
  openRoadmap: (body: unknown) => Promise<{ repository?: { root?: string } } | unknown> | { repository?: { root?: string } } | unknown;
  inspectRoadmapPort: (body: unknown) => Promise<unknown> | unknown;
  applyRoadmapPort: (body: unknown) => Promise<{ repository?: { root?: string } } | unknown> | { repository?: { root?: string } } | unknown;
  createRoadmap: (body: unknown) => Promise<{ repository?: { root?: string } } | unknown> | { repository?: { root?: string } } | unknown;
  selectRepository?: (repositoryPath: string) => void;
  readJson: <T>(request: IncomingMessage) => Promise<T>;
  sendJson: (response: ServerResponse, status: number, body: unknown) => void;
};

export async function handleWorkspaceRoute(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  context: WorkspaceRouteContext
): Promise<boolean> {
  if (await handleRoadmapCompatibilityRoute(request, response, pathname, context)) {
    return true;
  }

  if (request.method === "GET" && pathname === "/api/workspaces") {
    const status = await context.bridgeStatus();
    context.sendJson(response, 200, status.workspaces);
    return true;
  }

  if (request.method === "GET" && pathname === "/api/workspaces/active") {
    const status = await context.bridgeStatus();
    context.sendJson(response, 200, { workspaces: status.workspaces.active });
    return true;
  }

  if (request.method === "GET" && pathname === "/api/workspaces/managed") {
    const status = await context.bridgeStatus();
    context.sendJson(response, 200, { workspaces: status.workspaces.managed });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/workspaces/add") {
    context.sendJson(response, 202, await addWorkspaceRoute(await context.readJson(request), context));
    return true;
  }

  if (request.method === "POST" && pathname === "/api/workspaces/activate") {
    context.sendJson(response, 202, await setWorkspaceLifecycleRoute(await context.readJson(request), "active", context));
    return true;
  }

  if (request.method === "POST" && pathname === "/api/workspaces/deactivate") {
    context.sendJson(response, 202, await setWorkspaceLifecycleRoute(await context.readJson(request), "inactive", context));
    return true;
  }

  if (request.method === "POST" && pathname === "/api/workspaces/remove") {
    context.sendJson(response, 202, await removeWorkspaceRoute(await context.readJson(request), context));
    return true;
  }

  return false;
}

async function handleRoadmapCompatibilityRoute(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  context: WorkspaceRouteContext
): Promise<boolean> {
  if (request.method === "GET" && pathname === "/api/roadmaps/recent") {
    context.sendJson(response, 200, { roadmaps: context.recentRoadmaps() });
    return true;
  }

  if (request.method === "GET" && pathname === "/api/roadmaps/managed") {
    context.sendJson(response, 200, { roadmaps: context.managedRoadmaps() });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/roadmaps/recent/remove") {
    context.sendJson(response, 202, await context.removeRoadmap(await context.readJson(request)));
    return true;
  }

  if (request.method === "POST" && pathname === "/api/roadmaps/activate") {
    context.sendJson(response, 202, await context.activateRoadmap(await context.readJson(request)));
    return true;
  }

  if (request.method === "POST" && pathname === "/api/roadmaps/deactivate") {
    context.sendJson(response, 202, await context.deactivateRoadmap(await context.readJson(request)));
    return true;
  }

  if (request.method === "POST" && pathname === "/api/projects/inspect") {
    context.sendJson(response, 200, { project: await context.inspectProject(await context.readJson(request)) });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/roadmaps/open") {
    context.sendJson(response, 202, await roadmapOpenResultRoute(await context.readJson(request), context.openRoadmap, context));
    return true;
  }

  if (request.method === "POST" && pathname === "/api/roadmaps/port/inspect") {
    context.sendJson(response, 200, await context.inspectRoadmapPort(await context.readJson(request)));
    return true;
  }

  if (request.method === "POST" && pathname === "/api/roadmaps/port/apply") {
    context.sendJson(response, 202, await roadmapOpenResultRoute(await context.readJson(request), context.applyRoadmapPort, context));
    return true;
  }

  if (request.method === "POST" && pathname === "/api/roadmaps/create") {
    context.sendJson(response, 202, await roadmapOpenResultRoute(await context.readJson(request), context.createRoadmap, context));
    return true;
  }

  return false;
}

async function roadmapOpenResultRoute(
  body: unknown,
  action: (body: unknown) => Promise<{ repository?: { root?: string } } | unknown> | { repository?: { root?: string } } | unknown,
  context: WorkspaceRouteContext
): Promise<unknown> {
  const result = await action(body);
  const repositoryRoot = repositoryRootFromResult(result);
  if (repositoryRoot) {
    context.selectRepository?.(repositoryRoot);
  }
  return result;
}

function repositoryRootFromResult(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null) {
    return undefined;
  }
  const repository = (result as { repository?: unknown }).repository;
  if (typeof repository !== "object" || repository === null) {
    return undefined;
  }
  const root = (repository as { root?: unknown }).root;
  return typeof root === "string" && root.trim() ? root : undefined;
}

async function addWorkspaceRoute(body: unknown, context: WorkspaceRouteContext): Promise<unknown> {
  const result = await context.addWorkspace(body);
  if (result.repository?.root) {
    context.selectRepository?.(result.repository.root);
  }
  const provider = await context.currentProvider();
  return {
    workspace: workspaceSummaryFromRoadmap(result.roadmap, { provider }),
    workspaces: workspaceSummariesFromRoadmaps(context.managedRoadmaps(), { provider })
  };
}

async function setWorkspaceLifecycleRoute(
  body: unknown,
  lifecycle: "active" | "inactive",
  context: WorkspaceRouteContext
): Promise<unknown> {
  const result = await context.setWorkspaceLifecycle(body, lifecycle);
  const provider = await context.currentProvider();
  return {
    workspace: result.roadmap ? workspaceSummaryFromRoadmap(result.roadmap, { provider }) : undefined,
    workspaces: workspaceSummariesFromRoadmaps(result.roadmaps, { provider })
  };
}

async function removeWorkspaceRoute(body: unknown, context: WorkspaceRouteContext): Promise<unknown> {
  const result = await context.removeWorkspace(body);
  const provider = await context.currentProvider();
  return {
    removed: result.removed,
    workspaces: workspaceSummariesFromRoadmaps(result.roadmaps, { provider })
  };
}
