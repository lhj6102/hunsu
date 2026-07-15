export type AppRoute =
  | { kind: "projects" }
  | { kind: "graph"; projectId: string; nodeSha: string | null }
  | { kind: "events"; projectId: string; eventId: string | null }
  | { kind: "not_found" };

export function parseAppRoute(location: Pick<Location, "pathname">): AppRoute {
  const rawParts = location.pathname.split("/").filter(Boolean);
  const parts: string[] = [];
  for (const part of rawParts) {
    try {
      parts.push(decodeURIComponent(part));
    } catch {
      return { kind: "not_found" };
    }
  }
  if (parts.length === 1 && parts[0] === "projects") {
    return { kind: "projects" };
  }
  if (parts[0] !== "projects" || !parts[1]) {
    return { kind: "not_found" };
  }

  const projectId = parts[1];
  if (parts.length === 2 || (parts.length === 3 && parts[2] === "graph")) {
    return { kind: "graph", projectId, nodeSha: null };
  }
  if (parts.length === 5 && parts[2] === "graph" && parts[3] === "nodes" && parts[4]) {
    return { kind: "graph", projectId, nodeSha: parts[4] };
  }
  if (parts.length === 3 && parts[2] === "events") {
    return { kind: "events", projectId, eventId: null };
  }
  if (parts.length === 4 && parts[2] === "events" && parts[3]) {
    return { kind: "events", projectId, eventId: parts[3] };
  }
  return { kind: "not_found" };
}

export function canonicalPathForRoute(route: AppRoute): string | null {
  if (route.kind === "graph" && route.nodeSha === null) {
    return projectGraphPath(route.projectId);
  }
  return null;
}

export function projectGraphPath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/graph`;
}

export function projectNodePath(projectId: string, nodeSha: string): string {
  return `${projectGraphPath(projectId)}/nodes/${encodeURIComponent(nodeSha)}`;
}

export function projectEventsPath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/events`;
}

export function projectEventPath(projectId: string, eventId: string): string {
  return `${projectEventsPath(projectId)}/${encodeURIComponent(eventId)}`;
}

export function pushAppPath(path: string): void {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function replaceAppPath(path: string): void {
  window.history.replaceState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
