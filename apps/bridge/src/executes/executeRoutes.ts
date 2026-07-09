import type { IncomingMessage, ServerResponse } from "node:http";
import type { RuntimeProviderRegistry } from "../runtime-providers/types.ts";
import type { BridgeStatusResponse } from "../server/bridgeStatus.ts";
import type { RoadmapRegistryWorkspaceEntry } from "../workspaces/workspaceRegistry.ts";
import {
  connectionExecutePreflightErrorForSelection,
  executeStartHasExplicitBackendSelection,
  modelExecutePreflightErrorForSelection,
  normalizeExecuteStartSelectionForLocalBridge,
  providerAwareExecutePreflightForRoadmap,
  providerAwareExecutePreflightForRepository,
  type ExecuteStartBackendSelection,
  type ProviderAwareExecutePreflightError
} from "./executePreflight.ts";

type ExecuteRouteContext = {
  repositoryPath: string;
  roadmapId?: string;
  providerRegistry: RuntimeProviderRegistry;
  env: Record<string, string | undefined>;
  managedRoadmaps: () => RoadmapRegistryWorkspaceEntry[];
  bridgeStatus: () => Promise<BridgeStatusResponse>;
  localBridgeTokenPresent: () => boolean;
  runSummaries: () => unknown[];
  executeView: (run: unknown) => unknown;
  modelPreflight?: (body: ExecuteStartBackendSelection) => Promise<ProviderAwareExecutePreflightError | undefined> | ProviderAwareExecutePreflightError | undefined;
  startRun: (body: unknown) => Promise<unknown> | unknown;
  pauseRun: (body: unknown) => Promise<unknown> | unknown;
  resumeRun: (body: unknown) => Promise<unknown> | unknown;
  stopRun: (body: unknown) => Promise<unknown> | unknown;
  completeMove: (body: unknown) => Promise<unknown> | unknown;
  streamLiveEvents: () => void;
  agentSessions: () => unknown[];
  findAgentSession: (sessionId: string) => unknown | undefined;
  streamAgentSessionEvents: (sessionId?: string) => void;
  readJson: <T>(request: IncomingMessage) => Promise<T>;
  sendJson: (response: ServerResponse, status: number, body: unknown) => void;
};

export async function handleExecuteRoute(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  context: ExecuteRouteContext
): Promise<boolean> {
  return handleExecuteRouteWithPath(request, response, pathname, context, "/api");
}

export async function handleRoadmapExecuteRoute(
  request: IncomingMessage,
  response: ServerResponse,
  suffix: string,
  context: ExecuteRouteContext
): Promise<boolean> {
  return handleExecuteRouteWithPath(request, response, suffix, context, "");
}

async function handleExecuteRouteWithPath(
  request: IncomingMessage,
  response: ServerResponse,
  routePath: string,
  context: ExecuteRouteContext,
  apiPrefix: "/api" | ""
): Promise<boolean> {
  if (request.method === "GET" && (routePath === `${apiPrefix}/runs` || routePath === `${apiPrefix}/executes`)) {
    const runs = context.runSummaries();
    context.sendJson(response, 200, { runs, executes: runs.map(context.executeView) });
    return true;
  }

  if (request.method === "GET" && (routePath === `${apiPrefix}/runs/events` || routePath === `${apiPrefix}/executes/events`)) {
    context.streamLiveEvents();
    return true;
  }

  if (request.method === "POST" && (routePath === `${apiPrefix}/runs/start` || routePath === `${apiPrefix}/executes/start`)) {
    const body = await context.readJson<ExecuteStartBackendSelection>(request);
    const preflightError = await executeStartPreflight(body, context);
    if (preflightError) {
      context.sendJson(response, 409, preflightError);
      return true;
    }
    context.sendJson(response, 202, await context.startRun(body));
    return true;
  }

  if (request.method === "POST" && (routePath === `${apiPrefix}/runs/pause` || routePath === `${apiPrefix}/executes/pause`)) {
    context.sendJson(response, 202, await context.pauseRun(await context.readJson(request)));
    return true;
  }

  if (request.method === "POST" && (routePath === `${apiPrefix}/runs/resume` || routePath === `${apiPrefix}/executes/resume`)) {
    context.sendJson(response, 202, await context.resumeRun(await context.readJson(request)));
    return true;
  }

  if (request.method === "POST" && (routePath === `${apiPrefix}/runs/stop` || routePath === `${apiPrefix}/executes/stop`)) {
    context.sendJson(response, 202, await context.stopRun(await context.readJson(request)));
    return true;
  }

  if (request.method === "POST" && (routePath === `${apiPrefix}/runs/complete-move` || routePath === `${apiPrefix}/executes/complete-move`)) {
    context.sendJson(response, 202, await context.completeMove(await context.readJson(request)));
    return true;
  }

  return handleAgentSessionRoute(request, response, routePath, context, apiPrefix);
}

async function executeStartPreflight(
  body: ExecuteStartBackendSelection,
  context: ExecuteRouteContext
) {
  const preflightBody = normalizeExecuteStartSelectionForLocalBridge(body, {
    localBridgeTokenPresent: context.localBridgeTokenPresent()
  });
  const selectedStatus = executeStartHasExplicitBackendSelection(preflightBody)
    || preflightBody.modelSelection
    || preflightBody.aliases?.length
    || Boolean(context.modelPreflight)
    ? await context.bridgeStatus()
    : undefined;
  const connectionPreflightError = selectedStatus
    ? connectionExecutePreflightErrorForSelection(preflightBody, selectedStatus)
    : undefined;
  if (connectionPreflightError) {
    return connectionPreflightError;
  }
  const modelPreflightError = selectedStatus
    ? modelExecutePreflightErrorForSelection(preflightBody, selectedStatus)
    : undefined;
  if (modelPreflightError) {
    return modelPreflightError;
  }
  const harnessModelPreflightError = context.modelPreflight
    ? await context.modelPreflight(preflightBody)
    : undefined;
  if (harnessModelPreflightError) {
    return harnessModelPreflightError;
  }

  if (context.roadmapId) {
    const roadmap = context.managedRoadmaps().find(candidate => candidate.roadmapId === context.roadmapId);
    return providerAwareExecutePreflightForRoadmap(
      roadmap,
      context.providerRegistry,
      context.env,
      selectedStatus ? { body: preflightBody, status: selectedStatus } : undefined
    );
  }

  return providerAwareExecutePreflightForRepository({
    repositoryPath: context.repositoryPath,
    registry: context.providerRegistry,
    roadmaps: context.managedRoadmaps(),
    env: context.env,
    selected: selectedStatus ? { body: preflightBody, status: selectedStatus } : undefined
  });
}

function handleAgentSessionRoute(
  request: IncomingMessage,
  response: ServerResponse,
  routePath: string,
  context: ExecuteRouteContext,
  apiPrefix: "/api" | ""
): boolean {
  if (request.method === "GET" && routePath === `${apiPrefix}/agent-sessions`) {
    context.sendJson(response, 200, { sessions: context.agentSessions() });
    return true;
  }

  if (request.method === "GET" && routePath === `${apiPrefix}/agent-sessions/events`) {
    context.streamAgentSessionEvents();
    return true;
  }

  if (request.method === "GET" && routePath.startsWith(`${apiPrefix}/agent-sessions/`)) {
    const route = parseAgentSessionRoute(routePath.slice(`${apiPrefix}/agent-sessions`.length));
    if (route?.action === "show") {
      const session = context.findAgentSession(route.sessionId);
      context.sendJson(response, session ? 200 : 404, session ? { session } : { error: `Unknown AgentSession: ${route.sessionId}` });
      return true;
    }
    if (route?.action === "events") {
      context.streamAgentSessionEvents(route.sessionId);
      return true;
    }
  }

  return false;
}

type AgentSessionApiRoute =
  | { action: "show"; sessionId: string }
  | { action: "events"; sessionId: string };

function parseAgentSessionRoute(suffix: string): AgentSessionApiRoute | undefined {
  if (!suffix.startsWith("/")) {
    return undefined;
  }
  if (suffix.endsWith("/events")) {
    const rawSessionId = suffix.slice(1, -"/events".length);
    return rawSessionId ? { action: "events", sessionId: decodeURIComponent(rawSessionId) } : undefined;
  }
  const rawSessionId = suffix.slice(1);
  return rawSessionId ? { action: "show", sessionId: decodeURIComponent(rawSessionId) } : undefined;
}
