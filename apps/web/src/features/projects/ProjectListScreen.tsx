import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, GitBranch, Github, Plus, Sparkles } from "lucide-react";
import { projectPath, pushAppPath } from "@/app/routes";
import { apiErrorMessage } from "@/shared/api/client";
import { invalidateProjectQueries, pollingQueryOptions, readQueryOptions } from "@/shared/api/polling";
import { createProject, fetchProjects, fetchRepositories, PROJECT_LIST_QUERY_KEY } from "@/shared/api/projectApi";
import type { ProjectListItem, ProjectListResponse, RepositorySummary } from "@/shared/api/types";
import { useLogicalSubmissionKey } from "@/shared/api/useLogicalSubmissionKey";
import { relativeTimestamp, repositoryLabel, shortSha } from "@/shared/format";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Card, CardContent } from "@/shared/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";
import { Label } from "@/shared/ui/label";
import { PageError, PageLoading, PageRefreshWarning, EmptyState } from "@/shared/ui/page-state";
import { PageHeading } from "@/shared/ui/page-heading";
import { ReviewStatusBadge, RunStatusBadge } from "@/shared/ui/domain-badge";
import { Textarea } from "@/shared/ui/textarea";

export function ProjectListScreen() {
  const [createOpen, setCreateOpen] = useState(false);
  const query = useQuery({
    queryKey: PROJECT_LIST_QUERY_KEY,
    queryFn: ({ signal }) => fetchProjects(signal),
    ...pollingQueryOptions<ProjectListResponse>({
      activeIntervalMs: 15_000,
      stableIntervalMs: 60_000,
      isActive: data => data.projects.some(project => project.activeRunCount > 0)
    })
  });
  if (query.isLoading) return <PageLoading label="Loading Projects…" />;
  if (!query.data) return <PageError message={apiErrorMessage(query.error, "Projects are unavailable.")} onRetry={() => void query.refetch()} />;
  const projects = query.data.projects;
  return (
    <main className="apple-page min-h-screen overflow-y-auto">
      <div className="mx-auto w-full max-w-[1240px] px-6 py-8 lg:px-10 lg:py-12">
        <PageHeading
          eyebrow="Workspace"
          title="Projects"
          description="Each Hunsu Project is backed by one GitHub repository and preserves Goals, Runs, evidence, decisions, and alternative futures."
          actions={<Button type="button" size="lg" onClick={() => setCreateOpen(true)}><Plus />New Project</Button>}
        />
        {query.isError ? (
          <PageRefreshWarning
            message={apiErrorMessage(query.error, "Projects could not be refreshed.")}
            retrying={query.isFetching}
            onRetry={() => void query.refetch()}
          />
        ) : null}
        <div className="mt-8">
          {projects.length > 0 ? (
            <div className="grid gap-4 lg:grid-cols-2">
              {projects.map(project => <ProjectCard key={project.id} project={project} />)}
            </div>
          ) : (
            <EmptyState
              title="Create the first Project"
              body="Choose a repository granted to the Hunsu GitHub App. Project state will be committed to its protected hunsu/state ref."
              action={<Button type="button" onClick={() => setCreateOpen(true)}><Plus />New Project</Button>}
            />
          )}
        </div>
      </div>
      <CreateProjectDialog open={createOpen} onOpenChange={setCreateOpen} />
    </main>
  );
}

function ProjectCard({ project }: { project: ProjectListItem }) {
  return (
    <Card className="overflow-hidden transition hover:-translate-y-0.5 hover:bg-white/88">
      <CardContent className="p-0">
        <button type="button" className="w-full p-5 text-left" onClick={() => pushAppPath(projectPath(project.id))}>
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="truncate text-xl font-semibold">{project.title}</h2>
              <p className="mt-1 inline-flex items-center gap-1.5 text-[12px] text-muted-foreground"><Github className="size-3.5" />{repositoryLabel(project.repository.owner, project.repository.name)}</p>
            </div>
            <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
          </div>
          <p className="mt-4 line-clamp-2 min-h-10 text-[13px] leading-5 text-[color:var(--apple-body)]">{project.objective}</p>
          <dl className="mt-5 grid grid-cols-3 gap-2">
            <Metric label="Active Goals" value={project.activeGoalCount} />
            <Metric label="Active Runs" value={project.activeRunCount} />
            <Metric label="Open alternatives" value={project.unresolvedAlternativeCount} />
          </dl>
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t pt-4">
            <div className="flex flex-wrap items-center gap-2">
              <ReviewStatusBadge status={project.coachReviewStatus} />
              {project.latestResult ? <RunStatusBadge status={project.latestResult.status} /> : <Badge variant="outline">No results yet</Badge>}
            </div>
            <span className="text-[10px] text-muted-foreground">Synced {relativeTimestamp(project.synchronizedAt)}</span>
          </div>
          {project.latestResult ? (
            <p className="mt-3 flex items-center gap-2 truncate rounded-[12px] bg-white/56 px-3 py-2 text-[11px] text-muted-foreground">
              <GitBranch className="size-3" />
              <span className="truncate">{project.latestResult.goalTitle}</span>
              <span className="ml-auto font-mono">{shortSha(project.latestResult.resultSha)}</span>
            </p>
          ) : null}
        </button>
      </CardContent>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-[12px] bg-white/62 px-3 py-3">
      <dt className="text-[10px] text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-lg font-semibold">{value}</dd>
    </div>
  );
}

function CreateProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const submission = useLogicalSubmissionKey("project.create");
  const repositoriesQuery = useQuery({
    queryKey: ["repositories"],
    queryFn: ({ signal }) => fetchRepositories(signal),
    enabled: open,
    staleTime: 30_000,
    ...readQueryOptions()
  });
  const repositories = repositoriesQuery.data?.repositories.filter(repository => repository.granted) ?? [];
  const [repositoryKey, setRepositoryKey] = useState("");
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [baseRef, setBaseRef] = useState("");
  const [error, setError] = useState<string>();
  const selected = repositories.find(repository => keyForRepository(repository) === repositoryKey);
  const mutation = useMutation({
    mutationFn: () => {
      const command = {
        repository: { owner: selected!.owner, name: selected!.name },
        title: title.trim(),
        objective: objective.trim(),
        baseRef: baseRef.trim() || selected!.defaultBranch
      };
      return createProject({
        ...command,
        expectedStateSha: selected!.stateHeadSha,
        idempotencyKey: submission.keyFor(command)
      });
    },
    onSuccess: result => {
      submission.succeeded();
      void invalidateProjectQueries(queryClient);
      onOpenChange(false);
      pushAppPath(projectPath(result.value.projectId));
    },
    onError: nextError => setError(apiErrorMessage(nextError, "Project creation failed."))
  });

  function selectRepository(key: string) {
    setRepositoryKey(key);
    const repository = repositories.find(item => keyForRepository(item) === key);
    if (repository) {
      setTitle(current => current || repository.name);
      setBaseRef(repository.defaultBranch);
    }
  }

  function changeOpen(nextOpen: boolean) {
    if (!nextOpen && !mutation.isPending) submission.abandon();
    onOpenChange(nextOpen);
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a Hunsu Project</DialogTitle>
          <DialogDescription>Select a GitHub repository and describe the product outcome this Project owns.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          {repositoriesQuery.isError ? (
            <PageRefreshWarning
              message={apiErrorMessage(repositoriesQuery.error, "Repositories are unavailable.")}
              retrying={repositoriesQuery.isFetching}
              onRetry={() => void repositoriesQuery.refetch()}
            />
          ) : null}
          <div className="grid gap-2">
            <Label htmlFor="project-repository">Repository</Label>
            <select id="project-repository" className="h-10 rounded-md border bg-white/72 px-3 text-sm" value={repositoryKey} onChange={event => selectRepository(event.target.value)}>
              <option value="">Select a granted repository</option>
              {repositories.map(repository => <option key={keyForRepository(repository)} value={keyForRepository(repository)}>{repositoryLabel(repository.owner, repository.name)}</option>)}
            </select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="project-title">Title</Label>
            <Input id="project-title" value={title} onChange={event => setTitle(event.target.value)} placeholder="Authentication redesign" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="project-objective">Objective</Label>
            <Textarea id="project-objective" value={objective} onChange={event => setObjective(event.target.value)} placeholder="Make account access safer and easier to understand." />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="project-base-ref">Base ref</Label>
            <Input id="project-base-ref" value={baseRef} onChange={event => setBaseRef(event.target.value)} placeholder="main" />
          </div>
          {repositoriesQuery.isError ? <p className="text-sm text-destructive">{apiErrorMessage(repositoriesQuery.error, "Repositories are unavailable.")}</p> : null}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => changeOpen(false)}>Cancel</Button>
          <Button type="button" disabled={!selected || !title.trim() || !objective.trim() || mutation.isPending} onClick={() => mutation.mutate()}>
            <Sparkles />{mutation.isPending ? "Creating…" : "Create Project"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function keyForRepository(repository: RepositorySummary): string {
  return `${repository.owner}/${repository.name}`;
}
