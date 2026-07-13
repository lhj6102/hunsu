import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitBranch, Github, Plus, Scale, Sparkles } from "lucide-react";
import { goalPath, pushAppPath } from "@/app/routes";
import { apiErrorMessage } from "@/shared/api/client";
import { createGoal, fetchProject, fetchRunners, rebuildProject } from "@/shared/api/projectApi";
import { useLogicalSubmissionKey } from "@/shared/api/useLogicalSubmissionKey";
import { formatTimestamp, repositoryLabel, safeHttpHref } from "@/shared/format";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";
import { Label } from "@/shared/ui/label";
import { PageError, PageLoading, EmptyState } from "@/shared/ui/page-state";
import { PageHeading } from "@/shared/ui/page-heading";
import { Textarea } from "@/shared/ui/textarea";
import { EvidenceList, GoalGrid, RepositoryHealthCard, RunList } from "@/features/projects/ProjectComponents";

export function ProjectOverviewScreen({ projectId }: { projectId: string }) {
  const [createGoalOpen, setCreateGoalOpen] = useState(false);
  const queryClient = useQueryClient();
  const queryKey = ["projects", projectId] as const;
  const rebuildSubmission = useLogicalSubmissionKey("project.rebuild");
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => fetchProject(projectId, signal),
    refetchInterval: 5_000,
    refetchIntervalInBackground: false
  });
  const rebuildMutation = useMutation({
    mutationFn: () => {
      const command = { projectId, action: "rebuild" } as const;
      return rebuildProject(projectId, query.data!.stateHeadSha, rebuildSubmission.keyFor(command));
    },
    onSuccess: () => {
      rebuildSubmission.succeeded();
      void queryClient.invalidateQueries({ queryKey });
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
    }
  });
  if (query.isLoading) return <PageLoading label="Loading Project…" />;
  if (query.isError || !query.data) return <PageError message={apiErrorMessage(query.error, "Project is unavailable.")} onRetry={() => void query.refetch()} />;
  const project = query.data.project;
  const activeRuns = project.runs.filter(run => run.status === "running");
  const repositoryHref = safeHttpHref(project.repository.url);
  return (
    <main className="apple-page min-h-screen overflow-y-auto">
      <div className="mx-auto w-full max-w-[1240px] px-6 py-8 lg:px-10 lg:py-12">
        <PageHeading
          eyebrow="Project overview"
          title={project.title}
          description={project.objective}
          actions={(
            <>
              {repositoryHref ? <Button asChild variant="outline"><a href={repositoryHref} target="_blank" rel="noreferrer"><Github />Repository</a></Button> : null}
              <Button type="button" onClick={() => setCreateGoalOpen(true)}><Plus />New Goal</Button>
            </>
          )}
        />

        <div className="mt-6 flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
          <Badge variant="outline"><Github />{repositoryLabel(project.repository.owner, project.repository.name)}</Badge>
          <Badge variant="outline"><GitBranch />{project.baseRef}</Badge>
          <span>Updated {formatTimestamp(project.updatedAt)}</span>
        </div>

        <div className="mt-8">
          <RepositoryHealthCard
            health={project.health}
            rebuilding={rebuildMutation.isPending}
            onRebuild={() => rebuildMutation.mutate()}
          />
          {rebuildMutation.isError ? <p className="mt-2 text-sm text-destructive">{apiErrorMessage(rebuildMutation.error, "Rebuild failed.")}</p> : null}
        </div>

        <div className="mt-8 grid gap-8 xl:grid-cols-[minmax(0,1.55fr)_minmax(300px,0.8fr)]">
          <div className="min-w-0 space-y-8">
            <Section title="Goals" subtitle="Desired outcomes come before implementation activity." action={<Button type="button" size="sm" variant="outline" onClick={() => setCreateGoalOpen(true)}><Plus />Add Goal</Button>}>
              <GoalGrid projectId={projectId} goals={project.goals} />
            </Section>
            <Section title="Current Runs" subtitle="Active plugin work refreshes automatically while this page is open.">
              <RunList projectId={projectId} runs={activeRuns} />
            </Section>
            <Section title="Recent evidence" subtitle="Evidence stays linked to GitHub commits and Project events.">
              <EvidenceList evidence={project.recentEvidence} />
            </Section>
          </div>

          <aside className="min-w-0 space-y-6">
            <Section title="Alternative futures" subtitle="Compare sibling Runs only when a Goal has diverged.">
              {project.alternatives.length > 0 ? (
                <div className="grid gap-2">
                  {project.alternatives.map(group => (
                    <button key={group.id} type="button" className="rounded-[16px] border bg-white/62 p-4 text-left hover:bg-white" onClick={() => pushAppPath(goalPath(projectId, group.goalId))}>
                      <div className="flex items-start gap-3">
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[color:var(--apple-blue-soft)] text-[color:var(--apple-blue)]"><Scale className="size-4" /></span>
                        <div className="min-w-0">
                          <p className="truncate text-[13px] font-semibold">{group.goalTitle}</p>
                          <p className="mt-1 text-[11px] text-muted-foreground">{group.runIds.length} sibling Runs · {group.status}</p>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              ) : <EmptyState title="No divergence yet" body="Alternative comparison appears after Hunsu creates sibling Runs from one base commit." />}
            </Section>
            <Section title="Decisions" subtitle="Consequential choices wait for a person to confirm them.">
              {project.decisions.length > 0 ? (
                <div className="grid gap-2">
                  {project.decisions.map(decision => (
                    <button key={decision.id} type="button" className="rounded-[16px] border bg-white/62 p-4 text-left hover:bg-white" onClick={() => pushAppPath(goalPath(projectId, decision.goalId))}>
                      <div className="flex items-center justify-between gap-3">
                        <p className="truncate text-[13px] font-semibold">{decision.title}</p>
                        <Badge variant={decision.status === "awaiting_confirmation" ? "warning" : "outline"}>{decision.status.replaceAll("_", " ")}</Badge>
                      </div>
                      {decision.reason ? <p className="mt-2 line-clamp-2 text-[11px] leading-4 text-muted-foreground">{decision.reason}</p> : null}
                    </button>
                  ))}
                </div>
              ) : <EmptyState title="No pending decisions" body="Coach recommendations and alternative selections will appear here." />}
            </Section>
          </aside>
        </div>
      </div>
      <CreateGoalDialog projectId={projectId} expectedStateSha={query.data.stateHeadSha} open={createGoalOpen} onOpenChange={setCreateGoalOpen} />
    </main>
  );
}

function Section({ title, subtitle, action, children }: { title: string; subtitle: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-4 flex items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">{title}</h2>
          <p className="mt-1 text-[12px] leading-5 text-muted-foreground">{subtitle}</p>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function CreateGoalDialog({ projectId, expectedStateSha, open, onOpenChange }: { projectId: string; expectedStateSha: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const submission = useLogicalSubmissionKey("goal.create");
  const [title, setTitle] = useState("");
  const [outcome, setOutcome] = useState("");
  const [criteria, setCriteria] = useState("");
  const [constraints, setConstraints] = useState("");
  const [priority, setPriority] = useState<"low" | "normal" | "high" | "urgent">("normal");
  const [runnerId, setRunnerId] = useState("");
  const runnersQuery = useQuery({
    queryKey: ["projects", projectId, "runners"],
    queryFn: ({ signal }) => fetchRunners(projectId, signal),
    enabled: open,
    staleTime: 30_000
  });
  const mutation = useMutation({
    mutationFn: () => {
      const command = {
        title: title.trim(),
        desiredOutcome: outcome.trim(),
        acceptanceCriteria: lines(criteria),
        constraints: lines(constraints),
        priority,
        runnerId: runnerId || undefined
      };
      return createGoal(projectId, {
        ...command,
        expectedStateSha,
        idempotencyKey: submission.keyFor({ projectId, ...command })
      });
    },
    onSuccess: result => {
      submission.succeeded();
      void queryClient.invalidateQueries({ queryKey: ["projects", projectId] });
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      onOpenChange(false);
      pushAppPath(goalPath(projectId, result.value.goalId));
    }
  });
  const runners = runnersQuery.data?.runners ?? [];

  function changeOpen(nextOpen: boolean) {
    if (!nextOpen && !mutation.isPending) submission.abandon();
    onOpenChange(nextOpen);
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a Goal</DialogTitle>
          <DialogDescription>Describe an outcome and how evidence will show it has been achieved.</DialogDescription>
        </DialogHeader>
        <div className="grid max-h-[62vh] gap-4 overflow-y-auto pr-1">
          <Field label="Title" htmlFor="goal-title"><Input id="goal-title" value={title} onChange={event => setTitle(event.target.value)} /></Field>
          <Field label="Desired outcome" htmlFor="goal-outcome"><Textarea id="goal-outcome" value={outcome} onChange={event => setOutcome(event.target.value)} /></Field>
          <Field label="Acceptance criteria" htmlFor="goal-criteria" hint="One criterion per line"><Textarea id="goal-criteria" value={criteria} onChange={event => setCriteria(event.target.value)} /></Field>
          <Field label="Constraints" htmlFor="goal-constraints" hint="One constraint per line"><Textarea id="goal-constraints" value={constraints} onChange={event => setConstraints(event.target.value)} /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Priority" htmlFor="goal-priority">
              <select id="goal-priority" className="h-10 rounded-md border bg-white/72 px-3 text-sm" value={priority} onChange={event => setPriority(event.target.value as typeof priority)}>
                <option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option>
              </select>
            </Field>
            <Field label="Runner" htmlFor="goal-runner" hint="Can also be chosen in the plugin">
              <select id="goal-runner" className="h-10 rounded-md border bg-white/72 px-3 text-sm" value={runnerId} onChange={event => setRunnerId(event.target.value)}>
                <option value="">Not assigned</option>
                {runners.map(runner => <option key={runner.id} value={runner.id}>{runner.name} · {runner.kind}</option>)}
              </select>
            </Field>
          </div>
          {mutation.isError ? <p className="text-sm text-destructive">{apiErrorMessage(mutation.error, "Goal creation failed.")}</p> : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => changeOpen(false)}>Cancel</Button>
          <Button type="button" disabled={!title.trim() || !outcome.trim() || lines(criteria).length === 0 || mutation.isPending} onClick={() => mutation.mutate()}>
            <Sparkles />{mutation.isPending ? "Creating…" : "Create Goal"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: string; children: React.ReactNode }) {
  return <div className="grid gap-2"><div className="flex items-center justify-between gap-3"><Label htmlFor={htmlFor}>{label}</Label>{hint ? <span className="text-[10px] text-muted-foreground">{hint}</span> : null}</div>{children}</div>;
}

function lines(value: string): string[] {
  return value.split("\n").map(line => line.trim()).filter(Boolean);
}
