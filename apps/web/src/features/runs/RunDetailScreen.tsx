import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ExternalLink, GitBranch, GitCommit, Milestone, Timer, Users } from "lucide-react";
import { apiErrorMessage } from "@/shared/api/client";
import { pollingQueryOptions } from "@/shared/api/polling";
import { fetchRun } from "@/shared/api/projectApi";
import type { RunResponse } from "@/shared/api/types";
import { formatTimestamp, safeHttpHref, shortSha } from "@/shared/format";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { RunStatusBadge } from "@/shared/ui/domain-badge";
import { EmptyState, PageError, PageLoading, PageRefreshWarning } from "@/shared/ui/page-state";
import { PageHeading } from "@/shared/ui/page-heading";
import { EvidenceList } from "@/features/projects/ProjectComponents";

export function RunDetailScreen({ projectId, runId }: { projectId: string; runId: string }) {
  const query = useQuery({
    queryKey: ["projects", projectId, "runs", runId],
    queryFn: ({ signal }) => fetchRun(projectId, runId, signal),
    ...pollingQueryOptions<RunResponse>({
      activeIntervalMs: 5_000,
      stableIntervalMs: false,
      isActive: data => data.run.status === "running"
    })
  });
  if (query.isLoading) return <PageLoading label="Loading Run…" />;
  if (!query.data) return <PageError message={apiErrorMessage(query.error, "Run is unavailable.")} onRetry={() => void query.refetch()} />;
  const run = query.data.run;
  const resultHref = safeHttpHref(run.resultUrl);
  return (
    <main className="apple-page min-h-screen overflow-y-auto">
      <div className="mx-auto w-full max-w-[1120px] px-6 py-8 lg:px-10 lg:py-12">
        <PageHeading
          eyebrow="Run"
          title={run.goalTitle}
          description={`One ${run.runner.kind} Runner working from an immutable Goal and base commit contract.`}
          actions={resultHref ? <Button asChild variant="outline"><a href={resultHref} target="_blank" rel="noreferrer"><ExternalLink />Result commit</a></Button> : undefined}
        />
        {query.isError ? (
          <PageRefreshWarning
            message={apiErrorMessage(query.error, "Run state could not be refreshed.")}
            retrying={query.isFetching}
            onRetry={() => void query.refetch()}
          />
        ) : null}
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <RunStatusBadge status={run.status} />
          <Badge variant="outline"><Users />{run.runner.name}</Badge>
          <Badge variant="outline"><GitBranch />{run.branch}</Badge>
          <Badge variant="outline"><GitCommit />base {shortSha(run.baseSha)}</Badge>
          {run.resultSha ? <Badge variant="success">result {shortSha(run.resultSha)}</Badge> : null}
        </div>

        {run.failure ? (
          <div className="mt-6 flex gap-3 rounded-[18px] border border-red-200 bg-red-50/72 p-4 text-red-900">
            <AlertTriangle className="mt-0.5 size-5 shrink-0" />
            <div><h2 className="text-sm font-semibold">{run.failure.code}</h2><p className="mt-1 text-[12px] leading-5">{run.failure.message}</p><p className="mt-1 text-[11px] opacity-72">{run.failure.retryable ? "The plugin may retry from the recorded base commit." : "Review the Goal or Runner before another attempt."}</p></div>
          </div>
        ) : null}

        <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1.4fr)_minmax(280px,0.7fr)]">
          <div className="space-y-8">
            <Section title="Progress" icon={<Milestone />}>
              {run.checkpoints.length > 0 ? (
                <ol className="relative ml-3 border-l pl-6">
                  {run.checkpoints.map((checkpoint, index) => (
                    <li key={checkpoint.id} className="relative pb-6 last:pb-0">
                      <span className="absolute -left-[31px] top-0.5 flex size-3 rounded-full border-2 border-white bg-[color:var(--apple-blue)]" />
                      <div className="flex flex-wrap items-center gap-2"><p className="text-[13px] font-semibold">Checkpoint {index + 1}</p>{checkpoint.commitSha ? <Badge variant="outline">{shortSha(checkpoint.commitSha)}</Badge> : null}</div>
                      <p className="mt-1 text-[12px] leading-5 text-muted-foreground">{checkpoint.summary}</p>
                      <p className="mt-1 text-[10px] text-muted-foreground">{formatTimestamp(checkpoint.createdAt)}</p>
                    </li>
                  ))}
                </ol>
              ) : <EmptyState title="No checkpoints reported" body="The plugin can report bounded progress without changing the immutable Run contract." />}
            </Section>
            <Section title="Evidence" icon={<GitCommit />}><EvidenceList evidence={run.evidence} /></Section>
            <Section title="Instructions" icon={<Timer />}><div className="rounded-[16px] border bg-white/64 p-4 whitespace-pre-wrap text-[12px] leading-5">{run.instructions}</div></Section>
          </div>

          <aside className="space-y-8">
            <Section title="Goal snapshot">
              <Snapshot title={run.goalSnapshot.title} body={run.goalSnapshot.desiredOutcome} />
              <SmallList title="Acceptance criteria" items={run.goalSnapshot.acceptanceCriteria} />
              <SmallList title="Constraints" items={run.goalSnapshot.constraints} />
            </Section>
            <Section title="Runner snapshot">
              <Snapshot title={run.runnerSnapshot.name} body={run.runnerSnapshot.description ?? `${run.runnerSnapshot.kind} Runner`} />
              {run.runnerSnapshot.kind === "team" ? <SmallList title="Players" items={run.runnerSnapshot.players.map(link => `${link.playerName} · ${link.role}`)} /> : <SmallList title="Resources" items={run.runnerSnapshot.resources.map(resource => resource.name)} />}
            </Section>
            <Section title="Timing">
              <dl className="grid gap-2 rounded-[16px] border bg-white/64 p-4 text-[11px]"><TimeValue label="Started" value={formatTimestamp(run.startedAt)} /><TimeValue label="Updated" value={formatTimestamp(run.updatedAt)} /><TimeValue label="Completed" value={formatTimestamp(run.completedAt)} /></dl>
            </Section>
          </aside>
        </div>
      </div>
    </main>
  );
}

function Section({ title, icon, children }: { title: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return <section><h2 className="flex items-center gap-2 text-lg font-semibold">{icon}{title}</h2><div className="mt-3">{children}</div></section>;
}

function Snapshot({ title, body }: { title: string; body: string }) {
  return <div className="rounded-[16px] border bg-white/64 p-4"><h3 className="text-[14px] font-semibold">{title}</h3><p className="mt-2 text-[12px] leading-5 text-muted-foreground">{body}</p></div>;
}

function SmallList({ title, items }: { title: string; items: string[] }) {
  return <div className="mt-4"><h3 className="text-[11px] font-semibold uppercase text-muted-foreground">{title}</h3>{items.length > 0 ? <ul className="mt-2 grid list-disc gap-1 pl-4 text-[12px] leading-5">{items.map(item => <li key={item}>{item}</li>)}</ul> : <p className="mt-2 text-[11px] text-muted-foreground">None recorded.</p>}</div>;
}

function TimeValue({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{label}</dt><dd className="text-right font-medium">{value}</dd></div>;
}
