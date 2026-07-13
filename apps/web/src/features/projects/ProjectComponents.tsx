import { AlertTriangle, CheckCircle2, ExternalLink, GitBranch, GitCommit, RefreshCw, ShieldCheck } from "lucide-react";
import { goalPath, pushAppPath, runPath } from "@/app/routes";
import type { EvidenceRef, GoalSummary, RepositoryHealth, RunSummary } from "@/shared/api/types";
import { formatTimestamp, safeHttpHref, shortSha } from "@/shared/format";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { EmptyState } from "@/shared/ui/page-state";
import { GoalStatusBadge, RunStatusBadge, humanize } from "@/shared/ui/domain-badge";

export function GoalGrid({ projectId, goals }: { projectId: string; goals: GoalSummary[] }) {
  if (goals.length === 0) {
    return <EmptyState title="No Goals yet" body="Create an outcome-focused Goal with acceptance criteria, then choose a Player or Team through the Hunsu plugin." />;
  }
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {goals.map(goal => (
        <button
          key={goal.id}
          type="button"
          className="rounded-[18px] border bg-white/68 p-4 text-left transition hover:-translate-y-0.5 hover:bg-white focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/24"
          onClick={() => pushAppPath(goalPath(projectId, goal.id))}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="truncate text-[15px] font-semibold">{goal.title}</h3>
              <p className="mt-1 line-clamp-2 text-[13px] leading-5 text-muted-foreground">{goal.desiredOutcome}</p>
            </div>
            <GoalStatusBadge status={goal.status} />
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] text-muted-foreground">
            <span>{goal.runner?.name ?? "Runner not assigned"}</span>
            <span>{goal.runCount} Runs</span>
            {goal.alternativeCount > 1 ? <span className="font-semibold text-[color:var(--apple-blue)]">{goal.alternativeCount} alternatives</span> : null}
          </div>
        </button>
      ))}
    </div>
  );
}

export function RunList({ projectId, runs, emptyBody = "Runs started through the Hunsu plugin will appear here automatically." }: { projectId: string; runs: RunSummary[]; emptyBody?: string }) {
  if (runs.length === 0) {
    return <EmptyState title="No Runs yet" body={emptyBody} />;
  }
  return (
    <div className="divide-y rounded-[18px] border bg-white/64">
      {runs.map(run => (
        <button
          key={run.id}
          type="button"
          className="grid w-full gap-3 px-4 py-4 text-left transition hover:bg-white/72 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
          onClick={() => pushAppPath(runPath(projectId, run.id))}
        >
          <span className="min-w-0">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-[14px] font-semibold">{run.goalTitle}</span>
              <RunStatusBadge status={run.status} />
            </span>
            <span className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
              <span>{run.runner.name}</span>
              <span className="inline-flex items-center gap-1"><GitBranch className="size-3" />{run.branch}</span>
              <span>base {shortSha(run.baseSha)}</span>
              {run.resultSha ? <span className="inline-flex items-center gap-1"><GitCommit className="size-3" />result {shortSha(run.resultSha)}</span> : null}
            </span>
          </span>
          <span className="text-[11px] text-muted-foreground">{formatTimestamp(run.updatedAt)}</span>
        </button>
      ))}
    </div>
  );
}

export function EvidenceList({ evidence }: { evidence: EvidenceRef[] }) {
  if (evidence.length === 0) {
    return <EmptyState title="No evidence attached" body="Plugin checkpoints, checks, reports, artifacts, and result commits will collect here." />;
  }
  return (
    <div className="grid gap-2">
      {evidence.map(item => {
        const href = safeHttpHref(item.url);
        return <div key={item.id} className="flex items-start gap-3 rounded-[16px] border bg-white/60 px-4 py-3">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-[color:var(--apple-blue-soft)] text-[color:var(--apple-blue)]">
            {item.kind === "commit" ? <GitCommit className="size-4" /> : <CheckCircle2 className="size-4" />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="truncate text-[13px] font-semibold">{item.title}</p>
              <Badge variant="outline">{humanize(item.kind)}</Badge>
            </div>
            {item.criterion ? <p className="mt-1 text-[11px] font-medium leading-5 text-foreground">Criterion: {item.criterion}</p> : null}
            {item.summary ? <p className="mt-1 text-[12px] leading-5 text-muted-foreground">{item.summary}</p> : null}
            <p className="mt-1 font-mono text-[10px] text-muted-foreground">{item.commitSha ? shortSha(item.commitSha) : formatTimestamp(item.createdAt)}</p>
          </div>
          {href ? (
            <Button asChild size="icon" variant="ghost">
              <a href={href} target="_blank" rel="noreferrer" aria-label={`Open ${item.title}`}><ExternalLink /></a>
            </Button>
          ) : null}
        </div>;
      })}
    </div>
  );
}

export function RepositoryHealthCard({ health, onRebuild, rebuilding }: { health: RepositoryHealth; onRebuild: () => void; rebuilding: boolean }) {
  const healthy = health.repositoryAccess === "healthy" && health.stateRef === "healthy" && health.projection === "current";
  return (
    <section className="rounded-[18px] border bg-white/64 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 gap-3">
          <span className={`flex size-9 shrink-0 items-center justify-center rounded-full ${healthy ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
            {healthy ? <ShieldCheck className="size-4" /> : <AlertTriangle className="size-4" />}
          </span>
          <div className="min-w-0">
            <h3 className="text-[14px] font-semibold">Repository and state ref</h3>
            <p className="mt-1 text-[12px] leading-5 text-muted-foreground">{health.message ?? (healthy ? "GitHub state and the Web projection agree." : "Hunsu needs to reconcile durable state from GitHub.")}</p>
          </div>
        </div>
        {!healthy ? (
          <Button type="button" size="sm" variant="outline" disabled={rebuilding} onClick={onRebuild}>
            <RefreshCw className={rebuilding ? "animate-spin" : ""} />
            Rebuild
          </Button>
        ) : null}
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-3 text-[11px] sm:grid-cols-4">
        <HealthValue label="Repository" value={humanize(health.repositoryAccess)} />
        <HealthValue label={health.stateRefName || "State ref"} value={humanize(health.stateRef)} />
        <HealthValue label="Projection" value={humanize(health.projection)} />
        <HealthValue label="Last sync" value={formatTimestamp(health.synchronizedAt)} />
      </dl>
    </section>
  );
}

function HealthValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[12px] bg-white/68 px-3 py-2">
      <dt className="truncate text-muted-foreground">{label}</dt>
      <dd className="mt-1 truncate font-semibold">{value}</dd>
    </div>
  );
}
