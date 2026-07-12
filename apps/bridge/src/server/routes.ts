import type { IncomingMessage, ServerResponse } from "node:http";

type StudioResourceRouteContext = {
  readJson: <T>(request: IncomingMessage) => Promise<T>;
  sendJson: (response: ServerResponse, status: number, body: unknown) => void;
  board: () => unknown;
  roadmapView: () => unknown;
  events: () => unknown[];
  repository: () => unknown;
  selectRepository: (body: unknown) => Promise<unknown> | unknown;
  worktree: () => unknown;
  artifacts: () => unknown[];
  artifact: (artifactId: string) => unknown | undefined;
  artifactActions: (routePath: string) => Promise<boolean>;
  skills: () => unknown[];
  moveDiff: (moveId: string) => unknown;
  executeCommands: (body: unknown) => Promise<unknown> | unknown;
  decideLine: (decision: "accept" | "reject", body: unknown) => Promise<unknown> | unknown;
};

type ScopedRoadmapRouteContext = {
  readJson: <T>(request: IncomingMessage) => Promise<T>;
  sendJson: (response: ServerResponse, status: number, body: unknown) => void;
  repositoryPath: (roadmapId: string) => string;
  loadRoadmap: (roadmapId: string, cwd: string) => unknown;
  board: (roadmapId: string, cwd: string) => unknown;
  roadmapView: (roadmapId: string, cwd: string) => unknown;
  events: (roadmapId: string, cwd: string) => unknown[];
  repository: (roadmapId: string, cwd: string) => unknown;
  worktree: (roadmapId: string, cwd: string) => unknown;
  artifacts: (roadmapId: string, cwd: string) => unknown[];
  artifact: (roadmapId: string, cwd: string, artifactId: string) => unknown | undefined;
  artifactActions: (suffix: string, roadmapId: string, cwd: string) => Promise<boolean>;
  hunsuDrafts: (draftSuffix: string, roadmapId: string, cwd: string) => Promise<boolean>;
  executes: (suffix: string, roadmapId: string, cwd: string) => Promise<boolean>;
  skills: (roadmapId: string, cwd: string) => unknown[];
  moveFileTree: (roadmapId: string, cwd: string, moveId: string, path?: string) => unknown;
  moveFileBlob: (roadmapId: string, cwd: string, moveId: string, path: string) => unknown;
  moveDiff: (roadmapId: string, cwd: string, moveId: string) => unknown;
  executeCommands: (roadmapId: string, cwd: string, body: unknown) => Promise<unknown> | unknown;
  decideLine: (roadmapId: string, cwd: string, decision: "accept" | "reject", body: unknown) => Promise<unknown> | unknown;
};

type RoadmapApiRoute = {
  roadmapId: string;
  suffix: string;
};

type MoveFilesApiRoute =
  | { action: "tree"; moveId: string }
  | { action: "blob"; moveId: string }
  | { action: "diff"; moveId: string };

export function isHealthRoute(pathname: string): boolean {
  return pathname === "/health";
}

export function isPublicBridgeRoute(pathname: string): boolean {
  return isHealthRoute(pathname);
}

export function isBridgeControlRoute(pathname: string): boolean {
  return pathname === "/api/bridge/control/status"
    || pathname === "/api/bridge/pairing/rotate"
    || pathname === "/api/bridge/pairing/revoke"
    || pathname === "/api/bridge/control/shutdown";
}

export async function handleStudioResourceRoute(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  context: StudioResourceRouteContext
): Promise<boolean> {
  if (await handleTopLevelArtifactActionRoute(pathname, context)) {
    return true;
  }

  if (request.method === "GET" && pathname === "/api/board") {
    context.sendJson(response, 200, context.board());
    return true;
  }

  if (request.method === "GET" && pathname === "/api/roadmap") {
    context.sendJson(response, 200, context.roadmapView());
    return true;
  }

  if (request.method === "GET" && pathname === "/api/events") {
    context.sendJson(response, 200, { events: context.events() });
    return true;
  }

  if (request.method === "GET" && pathname === "/api/repository") {
    context.sendJson(response, 200, { repository: context.repository() });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/repository") {
    context.sendJson(response, 202, await context.selectRepository(await context.readJson(request)));
    return true;
  }

  if (request.method === "GET" && pathname === "/api/worktree") {
    context.sendJson(response, 200, context.worktree());
    return true;
  }

  if (request.method === "GET" && pathname === "/api/artifacts") {
    context.sendJson(response, 200, { artifacts: context.artifacts() });
    return true;
  }

  if (request.method === "GET" && pathname.startsWith("/api/artifacts/")) {
    const artifactId = decodeURIComponent(pathname.slice("/api/artifacts/".length));
    const artifact = context.artifact(artifactId);
    context.sendJson(response, artifact ? 200 : 404, artifact ? { artifact } : { error: `Unknown artifact: ${artifactId}` });
    return true;
  }

  if (request.method === "GET" && pathname === "/api/skills") {
    context.sendJson(response, 200, { skills: context.skills() });
    return true;
  }

  if (request.method === "GET" && pathname.startsWith("/api/moves/") && pathname.endsWith("/diff")) {
    const moveId = decodeURIComponent(pathname.slice("/api/moves/".length, -"/diff".length));
    context.sendJson(response, 200, { diff: context.moveDiff(moveId) });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/commands") {
    context.sendJson(response, 202, await context.executeCommands(await context.readJson(request)));
    return true;
  }

  if (request.method === "POST" && pathname === "/api/lines/accept") {
    context.sendJson(response, 202, await context.decideLine("accept", await context.readJson(request)));
    return true;
  }

  if (request.method === "POST" && pathname === "/api/lines/reject") {
    context.sendJson(response, 202, await context.decideLine("reject", await context.readJson(request)));
    return true;
  }

  return false;
}

export async function handleScopedRoadmapRoute(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  context: ScopedRoadmapRouteContext
): Promise<boolean> {
  const scopedRoadmap = parseRoadmapApiPath(pathname);
  if (!scopedRoadmap) {
    return false;
  }
  const cwd = context.repositoryPath(scopedRoadmap.roadmapId);
  const suffix = scopedRoadmap.suffix;

  if (request.method === "GET" && suffix === "") {
    context.sendJson(response, 200, context.loadRoadmap(scopedRoadmap.roadmapId, cwd));
    return true;
  }

  if (request.method === "GET" && suffix === "/board") {
    context.sendJson(response, 200, context.board(scopedRoadmap.roadmapId, cwd));
    return true;
  }

  if (request.method === "GET" && suffix === "/roadmap") {
    context.sendJson(response, 200, context.roadmapView(scopedRoadmap.roadmapId, cwd));
    return true;
  }

  if (request.method === "GET" && suffix === "/events") {
    context.sendJson(response, 200, { events: context.events(scopedRoadmap.roadmapId, cwd) });
    return true;
  }

  if (request.method === "GET" && suffix === "/repository") {
    context.sendJson(response, 200, { repository: context.repository(scopedRoadmap.roadmapId, cwd) });
    return true;
  }

  if (request.method === "GET" && suffix === "/worktree") {
    context.sendJson(response, 200, context.worktree(scopedRoadmap.roadmapId, cwd));
    return true;
  }

  if (request.method === "GET" && suffix === "/artifacts") {
    context.sendJson(response, 200, { artifacts: context.artifacts(scopedRoadmap.roadmapId, cwd) });
    return true;
  }

  if (request.method === "GET" && suffix.startsWith("/artifacts/")) {
    const artifactId = decodeURIComponent(suffix.slice("/artifacts/".length));
    const artifact = context.artifact(scopedRoadmap.roadmapId, cwd, artifactId);
    context.sendJson(response, artifact ? 200 : 404, artifact ? { artifact } : { error: `Unknown artifact: ${artifactId}` });
    return true;
  }

  if (suffix === "/artifact-actions" || suffix.startsWith("/artifact-actions/") || suffix === "/action-runs" || suffix.startsWith("/action-runs/")) {
    return context.artifactActions(suffix, scopedRoadmap.roadmapId, cwd);
  }

  if (suffix === "/hunsu/drafts" || suffix.startsWith("/hunsu/drafts/")) {
    return context.hunsuDrafts(suffix.slice("/hunsu/drafts".length), scopedRoadmap.roadmapId, cwd);
  }

  if (await context.executes(suffix, scopedRoadmap.roadmapId, cwd)) {
    return true;
  }

  if (request.method === "GET" && suffix === "/skills") {
    context.sendJson(response, 200, { skills: context.skills(scopedRoadmap.roadmapId, cwd) });
    return true;
  }

  const moveFilesRoute = parseMoveFilesRoute(suffix);
  if (moveFilesRoute && request.method === "GET") {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    const filePath = requestUrl.searchParams.get("path") ?? undefined;
    if (moveFilesRoute.action === "tree") {
      context.sendJson(response, 200, { tree: context.moveFileTree(scopedRoadmap.roadmapId, cwd, moveFilesRoute.moveId, filePath) });
      return true;
    }
    if (moveFilesRoute.action === "blob") {
      context.sendJson(response, 200, { blob: context.moveFileBlob(scopedRoadmap.roadmapId, cwd, moveFilesRoute.moveId, filePath ?? "") });
      return true;
    }
    if (moveFilesRoute.action === "diff") {
      context.sendJson(response, 200, { diff: context.moveDiff(scopedRoadmap.roadmapId, cwd, moveFilesRoute.moveId) });
      return true;
    }
  }

  if (request.method === "GET" && suffix.startsWith("/moves/") && suffix.endsWith("/diff")) {
    const moveId = decodeURIComponent(suffix.slice("/moves/".length, -"/diff".length));
    context.sendJson(response, 200, { diff: context.moveDiff(scopedRoadmap.roadmapId, cwd, moveId) });
    return true;
  }

  if (request.method === "POST" && suffix === "/commands") {
    context.sendJson(response, 202, await context.executeCommands(scopedRoadmap.roadmapId, cwd, await context.readJson(request)));
    return true;
  }

  if (request.method === "POST" && suffix === "/lines/accept") {
    context.sendJson(response, 202, await context.decideLine(scopedRoadmap.roadmapId, cwd, "accept", await context.readJson(request)));
    return true;
  }

  if (request.method === "POST" && suffix === "/lines/reject") {
    context.sendJson(response, 202, await context.decideLine(scopedRoadmap.roadmapId, cwd, "reject", await context.readJson(request)));
    return true;
  }

  return false;
}

async function handleTopLevelArtifactActionRoute(
  pathname: string,
  context: StudioResourceRouteContext
): Promise<boolean> {
  if (pathname === "/api/artifact-actions" || pathname.startsWith("/api/artifact-actions/") || pathname === "/api/action-runs" || pathname.startsWith("/api/action-runs/")) {
    return context.artifactActions(pathname);
  }
  return false;
}

function parseRoadmapApiPath(pathname: string): RoadmapApiRoute | undefined {
  const prefix = "/api/roadmaps/";
  if (!pathname.startsWith(prefix)) {
    return undefined;
  }
  const rest = pathname.slice(prefix.length);
  const [rawRoadmapId, ...suffixParts] = rest.split("/");
  if (!rawRoadmapId) {
    return undefined;
  }
  return {
    roadmapId: decodeURIComponent(rawRoadmapId),
    suffix: suffixParts.length > 0 ? `/${suffixParts.join("/")}` : ""
  };
}

function parseMoveFilesRoute(suffix: string): MoveFilesApiRoute | undefined {
  if (!suffix.startsWith("/moves/")) {
    return undefined;
  }
  const parts = suffix.slice(1).split("/");
  if (parts.length < 4 || parts[0] !== "moves" || parts[2] !== "files") {
    return undefined;
  }
  const moveId = decodeURIComponent(parts[1] ?? "");
  if (parts[3] === "tree") {
    return { action: "tree", moveId };
  }
  if (parts[3] === "blob") {
    return { action: "blob", moveId };
  }
  if (parts[3] === "diff") {
    return { action: "diff", moveId };
  }
  return undefined;
}
