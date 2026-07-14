export type AppRoute =
  | { kind: "projects" }
  | { kind: "project"; projectId: string }
  | { kind: "goal"; projectId: string; goalId: string }
  | { kind: "runners"; projectId: string }
  | { kind: "coach"; projectId: string }
  | { kind: "run"; projectId: string; runId: string };

export function shouldFetchProjectList(route: AppRoute): boolean {
  return route.kind === "projects";
}

export function parseAppRoute(location: Pick<Location, "pathname">): AppRoute {
  const parts = location.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts.length === 1 && parts[0] === "projects") {
    return { kind: "projects" };
  }
  if (parts[0] !== "projects" || !parts[1]) {
    return { kind: "projects" };
  }
  const projectId = parts[1];
  if (parts.length === 2) {
    return { kind: "project", projectId };
  }
  if (parts.length === 4 && parts[2] === "goals" && parts[3]) {
    return { kind: "goal", projectId, goalId: parts[3] };
  }
  if (parts.length === 3 && parts[2] === "runners") {
    return { kind: "runners", projectId };
  }
  if (parts.length === 3 && parts[2] === "coach") {
    return { kind: "coach", projectId };
  }
  if (parts.length === 4 && parts[2] === "runs" && parts[3]) {
    return { kind: "run", projectId, runId: parts[3] };
  }
  return { kind: "project", projectId };
}

export function projectPath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}`;
}

export function goalPath(projectId: string, goalId: string): string {
  return `${projectPath(projectId)}/goals/${encodeURIComponent(goalId)}`;
}

export function runnersPath(projectId: string): string {
  return `${projectPath(projectId)}/runners`;
}

export function coachPath(projectId: string): string {
  return `${projectPath(projectId)}/coach`;
}

export function runPath(projectId: string, runId: string): string {
  return `${projectPath(projectId)}/runs/${encodeURIComponent(runId)}`;
}

export function pushAppPath(path: string): void {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function replaceAppPath(path: string): void {
  window.history.replaceState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
