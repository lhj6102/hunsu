import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { parseAppRoute, replaceAppPath, type AppRoute } from "@/app/routes";
import { ProjectAppShell } from "@/features/app-shell/ProjectAppShell";
import { GitHubConnectionScreen } from "@/features/auth/GitHubConnectionScreen";
import { CoachScreen } from "@/features/coach/CoachScreen";
import { GoalDetailScreen } from "@/features/goals/GoalDetailScreen";
import { ProjectListScreen } from "@/features/projects/ProjectListScreen";
import { ProjectOverviewScreen } from "@/features/projects/ProjectOverviewScreen";
import { RunDetailScreen } from "@/features/runs/RunDetailScreen";
import { RunnerDirectoryScreen } from "@/features/runners/RunnerDirectoryScreen";
import { apiErrorMessage } from "@/shared/api/client";
import { fetchSession } from "@/shared/api/projectApi";
import { PageError, PageLoading } from "@/shared/ui/page-state";

export function App() {
  const [route, setRoute] = useState<AppRoute>(() => parseAppRoute(window.location));
  const sessionQuery = useQuery({
    queryKey: ["session"],
    queryFn: ({ signal }) => fetchSession(signal),
    staleTime: 30_000,
    retry: 1
  });

  useEffect(() => {
    if (window.location.pathname === "/" || !window.location.pathname.startsWith("/projects")) {
      replaceAppPath("/projects");
    }
    const onPopState = () => setRoute(parseAppRoute(window.location));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

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
      <RouteScreen route={route} />
    </ProjectAppShell>
  );
}

function RouteScreen({ route }: { route: AppRoute }) {
  switch (route.kind) {
    case "projects":
      return <ProjectListScreen />;
    case "project":
      return <ProjectOverviewScreen projectId={route.projectId} />;
    case "goal":
      return <GoalDetailScreen projectId={route.projectId} goalId={route.goalId} />;
    case "runners":
      return <RunnerDirectoryScreen projectId={route.projectId} />;
    case "coach":
      return <CoachScreen projectId={route.projectId} />;
    case "run":
      return <RunDetailScreen projectId={route.projectId} runId={route.runId} />;
  }
}
