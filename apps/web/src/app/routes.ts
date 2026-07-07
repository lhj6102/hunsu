export type StudioRoute =
  | { kind: "hub" }
  | { kind: "launcher" }
  | { kind: "open"; path: string | undefined; browseToken?: string; rootId?: string }
  | { kind: "port"; path: string | undefined; browseToken?: string; rootId?: string }
  | { kind: "roadmap"; roadmapId: string };

export function parseStudioRoute(location: Location): StudioRoute {
  if (location.pathname === "/hub" || location.pathname.startsWith("/hub/")) {
    return { kind: "hub" };
  }
  if (location.pathname === "/" || location.pathname === "" || location.pathname === "/studio") {
    return { kind: "launcher" };
  }
  if (location.pathname === "/studio/open") {
    const params = new URLSearchParams(location.search);
    return { kind: "open", path: params.get("path") ?? undefined, browseToken: params.get("browseToken") ?? undefined, rootId: params.get("rootId") ?? undefined };
  }
  if (location.pathname === "/studio/port") {
    const params = new URLSearchParams(location.search);
    return { kind: "port", path: params.get("path") ?? undefined, browseToken: params.get("browseToken") ?? undefined, rootId: params.get("rootId") ?? undefined };
  }
  const roadmapMatch = location.pathname.match(/^\/studio\/roadmaps\/([^/]+)$/);
  if (roadmapMatch?.[1]) {
    return { kind: "roadmap", roadmapId: decodeURIComponent(roadmapMatch[1]) };
  }
  return { kind: "launcher" };
}

export function roadmapApiPath(roadmapId: string, suffix: string): string {
  return `/api/roadmaps/${encodeURIComponent(roadmapId)}${suffix}`;
}

export function studioRoadmapPath(roadmapId: string): string {
  return `/studio/roadmaps/${encodeURIComponent(roadmapId)}`;
}

export function pushStudioPath(path: string): void {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
