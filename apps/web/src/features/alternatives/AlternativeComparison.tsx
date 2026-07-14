import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, GitBranch, GitCommit, Scale, X } from "lucide-react";
import { apiErrorMessage } from "@/shared/api/client";
import { invalidateProjectQueries } from "@/shared/api/polling";
import { rejectAlternative, selectAlternative } from "@/shared/api/projectApi";
import type { AlternativeComparison as RecordedAlternativeComparison, GoalAlternative } from "@/shared/api/types";
import { useLogicalSubmissionKey } from "@/shared/api/useLogicalSubmissionKey";
import { formatTimestamp, shortSha } from "@/shared/format";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { ConfirmActionDialog } from "@/shared/ui/confirm-action-dialog";
import { RunStatusBadge } from "@/shared/ui/domain-badge";
import { canRecordAlternativeDecision } from "@/features/alternatives/comparisonModel";

type PendingDecision = { kind: "select" | "reject"; alternative: GoalAlternative; comparisonId: string };

export function AlternativeComparison({
  projectId,
  goalId,
  expectedStateSha,
  alternatives,
  comparisons
}: {
  projectId: string;
  goalId: string;
  expectedStateSha: string;
  alternatives: GoalAlternative[];
  comparisons: RecordedAlternativeComparison[];
}) {
  const queryClient = useQueryClient();
  const submission = useLogicalSubmissionKey("alternative.decision");
  const [pending, setPending] = useState<PendingDecision>();
  const comparedRunIds = new Set(comparisons.flatMap(comparison => comparison.runIds));
  const awaitingComparison = alternatives.filter(alternative => !comparedRunIds.has(alternative.run.id));
  const mutation = useMutation({
    mutationFn: (decision: PendingDecision) => {
      const command = {
        projectId,
        goalId,
        kind: decision.kind,
        runId: decision.alternative.run.id,
        comparisonId: decision.comparisonId
      };
      const key = submission.keyFor(command);
      return decision.kind === "select"
        ? selectAlternative(projectId, goalId, command.runId, command.comparisonId, expectedStateSha, key)
        : rejectAlternative(projectId, goalId, command.runId, command.comparisonId, expectedStateSha, key);
    },
    onSuccess: () => {
      submission.succeeded();
      setPending(undefined);
      void invalidateProjectQueries(queryClient);
    }
  });
  if (alternatives.length < 2 && comparisons.length === 0) {
    return null;
  }
  return (
    <section className="rounded-[22px] border bg-white/58 p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[color:var(--apple-blue-soft)] text-[color:var(--apple-blue)]"><Scale className="size-5" /></span>
        <div>
          <h2 className="text-xl font-semibold">Compare alternatives</h2>
          <p className="mt-1 text-[13px] leading-5 text-muted-foreground">Sibling Runs are grouped by shared base commit. Evidence and tradeoffs remain visible before a person selects the future that continues.</p>
        </div>
      </div>

      <div className="mt-6 grid gap-6">
        {comparisons.map(comparison => (
          <div key={comparison.id} className="relative rounded-[18px] border bg-white/54 p-4">
            <div className="mb-4 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <GitCommit className="size-3.5" />
              Recorded comparison <span className="font-mono font-semibold text-foreground">{comparison.id}</span>
              <span>· {formatTimestamp(comparison.recordedAt)}</span>
            </div>
            <div className="mb-5 rounded-[16px] border bg-white/76 p-4">
              <h3 className="text-[13px] font-semibold">Comparison summary</h3>
              <p className="mt-2 text-[12px] leading-5 text-muted-foreground">{comparison.summary}</p>
              <ComparisonFindings comparison={comparison} />
            </div>
            <AlternativeRouteGraph baseSha={comparison.baseSha} alternatives={comparison.alternatives} />
            <div className="grid gap-4 xl:grid-cols-2">
              {comparison.alternatives.map(alternative => (
                <AlternativeCard
                  key={alternative.run.id}
                  alternative={alternative}
                  comparisonId={comparison.id}
                  disabled={mutation.isPending}
                  onSelect={() => setPending({ kind: "select", alternative, comparisonId: comparison.id })}
                  onReject={() => setPending({ kind: "reject", alternative, comparisonId: comparison.id })}
                />
              ))}
            </div>
          </div>
        ))}
        {groupByBase(awaitingComparison).map(group => (
          <div key={`awaiting:${group.baseSha}`} className="relative rounded-[18px] border bg-white/54 p-4">
            <div className="mb-4 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <GitCommit className="size-3.5" />
              Shared base <span className="font-mono font-semibold text-foreground">{shortSha(group.baseSha)}</span>
              <Badge variant="outline">Awaiting recorded comparison</Badge>
            </div>
            <p className="mb-4 text-[12px] leading-5 text-muted-foreground">Record a criterion-by-criterion comparison of completed sibling Runs before selecting or rejecting a future.</p>
            <AlternativeRouteGraph baseSha={group.baseSha} alternatives={group.items} />
            <div className="grid gap-4 xl:grid-cols-2">
              {group.items.map(alternative => (
                <AlternativeCard key={alternative.run.id} alternative={alternative} disabled={mutation.isPending} onSelect={() => {}} onReject={() => {}} />
              ))}
            </div>
          </div>
        ))}
      </div>
      {mutation.isError ? <p className="mt-4 text-sm text-destructive">{apiErrorMessage(mutation.error, "The alternative decision failed.")}</p> : null}
      <ConfirmActionDialog
        open={Boolean(pending)}
        onOpenChange={open => !open && setPending(undefined)}
        title={pending?.kind === "select" ? "Select this future?" : "Reject this alternative?"}
        description={pending?.kind === "select"
          ? `This confirms ${pending.alternative.label} as the future that should continue. Hunsu will record the decision in GitHub; sibling history remains intact.`
          : `This records ${pending?.alternative.label ?? "this Run"} as rejected. Its branch, evidence, and history remain available for review.`}
        confirmLabel={pending?.kind === "select" ? "Select future" : "Reject alternative"}
        destructive={pending?.kind === "reject"}
        busy={mutation.isPending}
        onConfirm={() => pending && mutation.mutate(pending)}
      />
    </section>
  );
}

function ComparisonFindings({ comparison }: { comparison: RecordedAlternativeComparison }) {
  if (comparison.findings.length === 0) {
    return <p className="mt-4 text-[11px] text-muted-foreground">No criterion findings were recorded.</p>;
  }
  const labels = new Map(comparison.alternatives.map(alternative => [alternative.run.id, alternative.label]));
  return (
    <div className="mt-4 grid gap-3 border-t pt-4">
      {comparison.findings.map((finding, index) => (
        <section key={`${finding.criterion}:${index}`} className="rounded-[12px] bg-[color:var(--apple-canvas-alt)]/72 p-3">
          <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Criterion</h4>
          <p className="mt-1 text-[12px] font-semibold leading-5">{finding.criterion}</p>
          <dl className="mt-3 grid gap-2">
            {finding.summaries.map(summary => (
              <div key={summary.runId} className="grid gap-1 sm:grid-cols-[minmax(110px,0.35fr)_minmax(0,1fr)]">
                <dt className="font-mono text-[10px] text-muted-foreground">{labels.get(summary.runId) ?? summary.runId}</dt>
                <dd className="text-[12px] leading-5">{summary.summary}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}

function AlternativeRouteGraph({ baseSha, alternatives }: { baseSha: string; alternatives: GoalAlternative[] }) {
  const minimumWidth = Math.max(520, alternatives.length * 230);
  const firstCenter = 50 / alternatives.length;
  const lastCenter = 100 - firstCenter;
  return (
    <div className="mb-5 overflow-x-auto rounded-[16px] border bg-[color:var(--apple-canvas-alt)]/72 px-3 py-4" aria-label={`Run route graph from base ${shortSha(baseSha)}`}>
      <div style={{ minWidth: `${minimumWidth}px` }}>
        <div className="mx-auto w-fit max-w-[240px] rounded-[12px] border bg-white px-4 py-2 text-center shadow-sm">
          <p className="text-[10px] font-semibold uppercase text-muted-foreground">Shared base</p>
          <p className="mt-1 font-mono text-[11px] font-semibold">{shortSha(baseSha)}</p>
        </div>
        <div className="relative h-10" aria-hidden="true">
          <span className="absolute left-1/2 top-0 h-1/2 w-px -translate-x-1/2 bg-border" />
          <span className="absolute top-1/2 h-px bg-border" style={{ left: `${firstCenter}%`, right: `${100 - lastCenter}%` }} />
          {alternatives.map((alternative, index) => (
            <span
              key={alternative.run.id}
              className="absolute bottom-0 top-1/2 w-px -translate-x-1/2 bg-border"
              style={{ left: `${((index + 0.5) / alternatives.length) * 100}%` }}
            />
          ))}
        </div>
        <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${alternatives.length}, minmax(190px, 1fr))` }}>
          {alternatives.map(alternative => (
            <div key={alternative.run.id} className="min-w-0 rounded-[12px] border bg-white/86 px-3 py-2 text-center">
              <div className="flex items-center justify-center gap-2">
                <p className="truncate text-[11px] font-semibold">{alternative.label}</p>
                {alternative.selected ? <Badge variant="success">Selected</Badge> : alternative.rejected ? <Badge variant="muted">Rejected</Badge> : null}
              </div>
              <p className="mt-1 truncate text-[10px] text-muted-foreground">{alternative.run.branch}</p>
              <p className="mt-1 font-mono text-[10px] text-muted-foreground">{alternative.run.resultSha ? shortSha(alternative.run.resultSha) : "Result pending"}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function AlternativeCard({ alternative, comparisonId, disabled, onSelect, onReject }: { alternative: GoalAlternative; comparisonId?: string; disabled: boolean; onSelect: () => void; onReject: () => void }) {
  const canDecide = canRecordAlternativeDecision(alternative.run, comparisonId);
  return (
    <article className={`rounded-[16px] border p-4 ${alternative.selected ? "border-emerald-300 bg-emerald-50/70" : alternative.rejected ? "bg-slate-50 opacity-72" : "bg-white/76"}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-[15px] font-semibold">{alternative.label}</h3>
            <RunStatusBadge status={alternative.run.status} />
            {alternative.selected ? <Badge variant="success">Selected</Badge> : null}
            {alternative.rejected ? <Badge variant="muted">Rejected</Badge> : null}
          </div>
          <p className="mt-2 text-[12px] leading-5 text-muted-foreground">{alternative.summary}</p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
        <span className="inline-flex items-center gap-1"><GitBranch className="size-3" />{alternative.run.branch}</span>
        <span className="inline-flex items-center gap-1"><GitCommit className="size-3" />{shortSha(alternative.run.resultSha)}</span>
        <span>{alternative.run.runner.name}</span>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <ComparisonList title="Strengths" items={alternative.strengths} empty="No strengths recorded." />
        <ComparisonList title="Tradeoffs" items={alternative.tradeoffs} empty="No tradeoffs recorded." />
      </div>
      <p className="mt-3 text-[11px] text-muted-foreground">{alternative.evidence.length} evidence items</p>
      {!alternative.selected && !alternative.rejected && canDecide ? (
        <div className="mt-4 flex flex-wrap gap-2 border-t pt-3">
          <Button type="button" size="sm" disabled={disabled} onClick={onSelect}><Check />Select</Button>
          <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={onReject}><X />Reject</Button>
        </div>
      ) : !alternative.selected && !alternative.rejected ? (
        <p className="mt-4 border-t pt-3 text-[11px] leading-5 text-muted-foreground">
          {comparisonId ? "This Run must be completed before a decision can be recorded." : "A recorded criterion-by-criterion comparison is required before a decision can be recorded."}
        </p>
      ) : null}
    </article>
  );
}

function ComparisonList({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return (
    <div>
      <h4 className="text-[11px] font-semibold uppercase text-muted-foreground">{title}</h4>
      {items.length > 0 ? <ul className="mt-2 grid list-disc gap-1 pl-4 text-[12px] leading-5">{items.map(item => <li key={item}>{item}</li>)}</ul> : <p className="mt-2 text-[11px] text-muted-foreground">{empty}</p>}
    </div>
  );
}

function groupByBase(alternatives: GoalAlternative[]): Array<{ baseSha: string; items: GoalAlternative[] }> {
  const groups = new Map<string, GoalAlternative[]>();
  for (const alternative of alternatives) {
    groups.set(alternative.run.baseSha, [...(groups.get(alternative.run.baseSha) ?? []), alternative]);
  }
  return [...groups.entries()].map(([baseSha, items]) => ({ baseSha, items }));
}
