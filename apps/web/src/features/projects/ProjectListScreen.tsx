import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, GitCommit, Github, Network, Play } from "lucide-react";
import { projectGraphPath, pushAppPath } from "@/app/routes";
import { apiErrorMessage } from "@/shared/api/client";
import { pollingQueryOptions } from "@/shared/api/polling";
import { fetchProjects, PROJECT_LIST_QUERY_KEY } from "@/shared/api/projectApi";
import type { ProjectListItem, ProjectListResponse } from "@/shared/api/types";
import { relativeTimestamp, repositoryLabel, shortSha } from "@/shared/format";
import { Badge } from "@/shared/ui/badge";
import { Card, CardContent } from "@/shared/ui/card";
import { EmptyState, PageError, PageLoading, PageRefreshWarning } from "@/shared/ui/page-state";
import { PageHeading } from "@/shared/ui/page-heading";

export function ProjectListScreen() {
  const query = useQuery({
    queryKey: PROJECT_LIST_QUERY_KEY,
    queryFn: ({ signal }) => fetchProjects(signal),
    ...pollingQueryOptions<ProjectListResponse>({
      activeIntervalMs: 10_000,
      stableIntervalMs: 60_000,
      isActive: data => data.projects.some(project => project.activeRunCount > 0)
    })
  });

  if (query.isLoading) return <PageLoading label="Loading Projects…" />;
  if (!query.data) return <PageError message={apiErrorMessage(query.error, "Projects are unavailable.")} onRetry={() => void query.refetch()} />;

  return (
    <main className="apple-page min-h-screen overflow-y-auto">
      <div className="mx-auto w-full max-w-[1160px] px-6 py-10 lg:px-12 lg:py-14">
        <PageHeading
          eyebrow="Workspace"
          title="Projects"
          description="Choose a Project to inspect its commit lineage. Each graph is reconstructed from the repository's append-only Hunsu state."
        />

        {query.isError ? (
          <PageRefreshWarning
            message={apiErrorMessage(query.error, "Projects could not be refreshed.")}
            retrying={query.isFetching}
            onRetry={() => void query.refetch()}
          />
        ) : null}

        <div className="mt-8">
          {query.data.projects.length > 0 ? (
            <div className="grid gap-4 lg:grid-cols-2">
              {query.data.projects.map(project => <ProjectCard key={project.id} project={project} />)}
            </div>
          ) : (
            <EmptyState
              title="No Commit Node graphs yet"
              body="Initialize a v2 Project through the Hunsu plugin after choosing its root commit, initial Goals, and immutable Runner value."
            />
          )}
        </div>
      </div>
    </main>
  );
}

function ProjectCard({ project }: { project: ProjectListItem }) {
  return (
    <Card className="overflow-hidden transition hover:-translate-y-0.5 hover:bg-white/88">
      <CardContent className="p-0">
        <button type="button" className="w-full p-5 text-left" onClick={() => pushAppPath(projectGraphPath(project.id))}>
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="truncate text-xl font-semibold">{project.title}</h2>
              <p className="mt-1 inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
                <Github className="size-3.5" />
                {repositoryLabel(project.repository.owner, project.repository.name)}
              </p>
            </div>
            <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
          </div>

          <dl className="mt-5 grid grid-cols-3 gap-2">
            <Metric icon={<Network />} label="Nodes" value={project.nodeCount} />
            <Metric icon={<Play />} label="Active Runs" value={project.activeRunCount} />
            <Metric icon={<AlertTriangle />} label="Divergences" value={project.unresolvedDivergenceCount} />
          </dl>

          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t pt-4">
            <Badge variant={project.integrity.status === "valid" ? "success" : "destructive"}>
              {project.integrity.status === "valid" ? "State current" : "Integrity error"}
            </Badge>
            <span className="text-[10px] text-muted-foreground">Synced {relativeTimestamp(project.synchronizedAt)}</span>
          </div>

          <p className="mt-3 flex items-center gap-2 truncate rounded-[12px] bg-white/56 px-3 py-2 text-[11px] text-muted-foreground">
            <GitCommit className="size-3" />
            <span>Root Node</span>
            <span className="ml-auto font-mono">{shortSha(project.rootNodeSha)}</span>
          </p>
        </button>
      </CardContent>
    </Card>
  );
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="rounded-[12px] bg-white/62 px-3 py-3">
      <dt className="flex items-center gap-1.5 text-[10px] text-muted-foreground [&_svg]:size-3">{icon}{label}</dt>
      <dd className="mt-1 text-lg font-semibold">{value}</dd>
    </div>
  );
}
