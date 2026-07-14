import { lazy, Suspense, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { canonicalPathForRoute, parseAppRoute, replaceAppPath, type AppRoute } from "@/app/routes";
import { ProjectAppShell } from "@/features/app-shell/ProjectAppShell";
import { GitHubConnectionScreen } from "@/features/auth/GitHubConnectionScreen";
import { ProjectListScreen } from "@/features/projects/ProjectListScreen";
import { apiErrorMessage } from "@/shared/api/client";
import { fetchSession } from "@/shared/api/projectApi";
import { PageError, PageLoading } from "@/shared/ui/page-state";

const NodeGraphScreen = lazy(() => import("@/features/node-graph/NodeGraphScreen").then(module => ({ default: module.NodeGraphScreen })));
const EventsScreen = lazy(() => import("@/features/events/EventsScreen").then(module => ({ default: module.EventsScreen })));

export function App() {
  const [route, setRoute] = useState<AppRoute>(() => parseAppRoute(window.location));
  const sessionQuery = useQuery({
    queryKey: ["session"],
    queryFn: ({ signal }) => fetchSession(signal),
    staleTime: 30_000,
    retry: 1
  });

  useEffect(() => {
    const onPopState = () => setRoute(parseAppRoute(window.location));
    window.addEventListener("popstate", onPopState);
    if (window.location.pathname === "/") {
      replaceAppPath("/projects");
    }
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    const canonicalPath = canonicalPathForRoute(route);
    if (canonicalPath && canonicalPath !== window.location.pathname) replaceAppPath(canonicalPath);
  }, [route]);

  if (sessionQuery.isLoading) {
    return <main className="apple-page min-h-screen"><PageLoading label="Connecting to Hunsu…" /></main>;
  }
  if (sessionQuery.isError) {
    return (
      <main className="apple-page min-h-screen">
        <PageError message={apiErrorMessage(sessionQuery.error, "Hunsu could not verify this session.")} onRetry={() => void sessionQuery.refetch()} />
      </main>
    );
  }

  const session = sessionQuery.data;
  if (!session || !session.authenticated || !session.github.connected) {
    return <GitHubConnectionScreen session={session} onRefresh={() => void sessionQuery.refetch()} />;
  }

  return (
    <ProjectAppShell route={route} session={session}>
      <Suspense fallback={<PageLoading label="Loading Project view…" />}>
        <RouteScreen route={route} />
      </Suspense>
    </ProjectAppShell>
  );
}

function RouteScreen({ route }: { route: AppRoute }) {
  switch (route.kind) {
    case "projects":
      return <ProjectListScreen />;
    case "graph":
      return <NodeGraphScreen projectId={route.projectId} selectedNodeSha={route.nodeSha} />;
    case "events":
      return <EventsScreen projectId={route.projectId} selectedEventId={route.eventId} />;
    case "not_found":
      return <NotFoundScreen />;
  }
}

function NotFoundScreen() {
  return (
    <main className="apple-page flex min-h-screen items-center justify-center px-6">
      <div className="max-w-md text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Not found</p>
        <h1 className="mt-3 text-2xl font-semibold">This Hunsu view does not exist.</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">Legacy Goal, Runner, Coach, and Run routes are not available in the Commit Node Graph protocol.</p>
        <button type="button" className="mt-5 text-sm font-semibold text-[color:var(--apple-blue)]" onClick={() => replaceAppPath("/projects")}>Open Projects</button>
      </div>
    </main>
  );
}
