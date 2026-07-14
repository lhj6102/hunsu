import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Check, ChevronRight, Lightbulb, RefreshCw, X } from "lucide-react";
import { goalPath, pushAppPath, runPath } from "@/app/routes";
import { apiErrorMessage } from "@/shared/api/client";
import {
  confirmCoachProposal,
  fetchCoach,
  rejectCoachProposal,
  requestCoachReview
} from "@/shared/api/projectApi";
import { invalidateProjectQueries, pollingQueryOptions } from "@/shared/api/polling";
import type {
  CoachResponse,
  CoachComparisonRecommendation,
  CoachProposal,
  CoachSelectionRecommendation,
  GoalAssignmentChange,
  GoalPatchChange,
  RunnerAssignmentChange
} from "@/shared/api/types";
import { useLogicalSubmissionKey } from "@/shared/api/useLogicalSubmissionKey";
import { formatTimestamp } from "@/shared/format";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { ConfirmActionDialog } from "@/shared/ui/confirm-action-dialog";
import { GoalStatusBadge, RunStatusBadge, humanize } from "@/shared/ui/domain-badge";
import { EmptyState, PageError, PageLoading, PageRefreshWarning } from "@/shared/ui/page-state";
import { PageHeading } from "@/shared/ui/page-heading";

type ProposalDecision = { kind: "confirm" | "reject"; proposal: CoachProposal };

export function CoachScreen({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const reviewSubmission = useLogicalSubmissionKey("coach.review");
  const proposalSubmission = useLogicalSubmissionKey("coach.proposal.decision");
  const queryKey = ["projects", projectId, "coach"] as const;
  const [decision, setDecision] = useState<ProposalDecision>();
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => fetchCoach(projectId, signal),
    ...pollingQueryOptions<CoachResponse>({
      activeIntervalMs: 10_000,
      stableIntervalMs: 60_000,
      isActive: data => data.coach.stalledRuns.some(run => run.status === "running")
    })
  });
  const reviewMutation = useMutation({
    mutationFn: () => {
      const command = { projectId, action: "review" } as const;
      return requestCoachReview(projectId, query.data!.stateHeadSha, reviewSubmission.keyFor(command));
    },
    onSuccess: () => {
      reviewSubmission.succeeded();
      void queryClient.invalidateQueries({ queryKey });
    }
  });
  const decisionMutation = useMutation({
    mutationFn: (decisionInput: ProposalDecision) => {
      const command = {
        projectId,
        kind: decisionInput.kind,
        proposalId: decisionInput.proposal.id
      };
      const key = proposalSubmission.keyFor(command);
      return decisionInput.kind === "confirm"
        ? confirmCoachProposal(projectId, command.proposalId, query.data!.stateHeadSha, key)
        : rejectCoachProposal(projectId, command.proposalId, query.data!.stateHeadSha, key);
    },
    onSuccess: () => {
      proposalSubmission.succeeded();
      setDecision(undefined);
      void invalidateProjectQueries(queryClient);
    }
  });
  if (query.isLoading) return <PageLoading label="Loading Coach…" />;
  if (!query.data) return <PageError message={apiErrorMessage(query.error, "Coach view is unavailable.")} onRetry={() => void query.refetch()} />;
  const coach = query.data.coach;
  const openProposals = coach.proposals.filter(proposal => proposal.status === "proposed");
  return (
    <main className="apple-page min-h-screen overflow-y-auto">
      <div className="mx-auto w-full max-w-[1180px] px-6 py-8 lg:px-10 lg:py-12">
        <PageHeading
          eyebrow="Project steering"
          title={coach.name}
          description="The Coach reviews Goals, Runs, evidence, and alternatives. Recommendations never confirm consequential changes without a person."
          actions={<Button type="button" disabled={reviewMutation.isPending} onClick={() => reviewMutation.mutate()}><RefreshCw className={reviewMutation.isPending ? "animate-spin" : ""} />{reviewMutation.isPending ? "Reviewing…" : "Request review"}</Button>}
        />
        {query.isError ? (
          <PageRefreshWarning
            message={apiErrorMessage(query.error, "Coach state could not be refreshed.")}
            retrying={query.isFetching}
            onRetry={() => void query.refetch()}
          />
        ) : null}

        <section className="mt-8 rounded-[22px] border bg-white/64 p-5 sm:p-6">
          <div className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[color:var(--apple-blue-soft)] text-[color:var(--apple-blue)]"><Bot className="size-5" /></span>
            <div className="min-w-0"><h2 className="text-lg font-semibold">Current assessment</h2><p className="mt-2 text-[14px] leading-6 text-[color:var(--apple-body)]">{coach.assessment.summary}</p><p className="mt-2 text-[10px] text-muted-foreground">Updated {formatTimestamp(coach.assessment.updatedAt)}</p></div>
          </div>
        </section>

        {(reviewMutation.isError || decisionMutation.isError) ? <p className="mt-4 rounded-[14px] border bg-red-50 px-4 py-3 text-sm text-destructive">{apiErrorMessage(reviewMutation.error ?? decisionMutation.error, "Coach action failed.")}</p> : null}

        <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1.25fr)_minmax(300px,0.75fr)]">
          <section>
            <div className="flex items-end justify-between gap-4"><div><h2 className="text-xl font-semibold">Proposals</h2><p className="mt-1 text-[12px] leading-5 text-muted-foreground">Review rationale before confirming or rejecting any change.</p></div><Badge variant={openProposals.length > 0 ? "warning" : "outline"}>{openProposals.length} open</Badge></div>
            <div className="mt-4 grid gap-3">
              {openProposals.length > 0 ? openProposals.map(proposal => (
                <ProposalCard
                  key={proposal.id}
                  proposal={proposal}
                  busy={decisionMutation.isPending}
                  onConfirm={() => setDecision({ kind: "confirm", proposal })}
                  onReject={() => setDecision({ kind: "reject", proposal })}
                />
              )) : <EmptyState title="No open proposals" body="Request a Coach review after Runs report enough evidence for a useful recommendation." />}
            </div>
          </section>

          <aside className="space-y-8">
            <section>
              <h2 className="text-lg font-semibold">Goals needing attention</h2>
              <div className="mt-3 grid gap-2">
                {coach.weakGoals.length > 0 ? coach.weakGoals.map(goal => (
                  <button key={goal.id} type="button" className="rounded-[16px] border bg-white/62 p-4 text-left hover:bg-white" onClick={() => pushAppPath(goalPath(projectId, goal.id))}>
                    <div className="flex items-start justify-between gap-3"><p className="min-w-0 truncate text-[13px] font-semibold">{goal.title}</p><ChevronRight className="size-4 shrink-0 text-muted-foreground" /></div>
                    <div className="mt-2 flex flex-wrap items-center gap-2"><GoalStatusBadge status={goal.status} /><span className="text-[10px] text-muted-foreground">{goal.runCount} Runs</span></div>
                  </button>
                )) : <EmptyState title="No weak Goals" body="The Coach has not identified a Goal conflict or evidence gap." />}
              </div>
            </section>
            <section>
              <h2 className="text-lg font-semibold">Stalled Runs</h2>
              <div className="mt-3 grid gap-2">
                {coach.stalledRuns.length > 0 ? coach.stalledRuns.map(run => (
                  <button key={run.id} type="button" className="rounded-[16px] border bg-white/62 p-4 text-left hover:bg-white" onClick={() => pushAppPath(runPath(projectId, run.id))}>
                    <div className="flex items-start justify-between gap-3"><p className="min-w-0 truncate text-[13px] font-semibold">{run.goalTitle}</p><ChevronRight className="size-4 shrink-0 text-muted-foreground" /></div>
                    <div className="mt-2 flex items-center gap-2"><RunStatusBadge status={run.status} /><span className="truncate text-[10px] text-muted-foreground">{run.runner.name}</span></div>
                  </button>
                )) : <EmptyState title="No stalled Runs" body="Active work is progressing or has reached a terminal state." />}
              </div>
            </section>
          </aside>
        </div>

        <section className="mt-10" aria-labelledby="comparison-recommendations-heading">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 id="comparison-recommendations-heading" className="text-xl font-semibold">Comparison recommendations</h2>
              <p className="mt-1 text-[12px] leading-5 text-muted-foreground">The Coach identifies when same-base sibling Runs need evidence or a recorded comparison.</p>
            </div>
            <Badge variant="outline">Advisory</Badge>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {coach.comparisonRecommendations.length > 0 ? coach.comparisonRecommendations.map(recommendation => (
              <ComparisonRecommendationCard
                key={recommendation.id}
                projectId={projectId}
                recommendation={recommendation}
              />
            )) : <EmptyState title="No comparison recommendations" body="Create a confirmed Hunsu divergence to begin a same-base comparison workflow." />}
          </div>
        </section>

        <section className="mt-10" aria-labelledby="selection-recommendations-heading">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 id="selection-recommendations-heading" className="text-xl font-semibold">Selection recommendations</h2>
              <p className="mt-1 text-[12px] leading-5 text-muted-foreground">Recommendations can suggest a selection review or another experiment. Only a person can confirm the consequential decision.</p>
            </div>
            <Badge variant="warning">User confirmation required</Badge>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {coach.selectionRecommendations.length > 0 ? coach.selectionRecommendations.map(recommendation => (
              <SelectionRecommendationCard
                key={recommendation.id}
                projectId={projectId}
                recommendation={recommendation}
              />
            )) : <EmptyState title="No selection recommendations" body="A criterion-by-criterion comparison must be recorded before the Coach can prepare a selection review." />}
          </div>
        </section>
      </div>

      <ConfirmActionDialog
        open={Boolean(decision)}
        onOpenChange={open => !open && setDecision(undefined)}
        title={decision?.kind === "confirm" ? "Confirm Coach proposal?" : "Reject Coach proposal?"}
        description={decision?.kind === "confirm"
          ? `${decision ? proposalChangeDescription(decision.proposal) : ""} Confirming applies this exact change and records it in GitHub. The Coach cannot make this decision silently.`
          : `${decision ? proposalChangeDescription(decision.proposal) : ""} Rejecting keeps the current Project state.`}
        confirmLabel={decision?.kind === "confirm" ? "Confirm proposal" : "Reject proposal"}
        destructive={decision?.kind === "reject"}
        busy={decisionMutation.isPending}
        onConfirm={() => decision && decisionMutation.mutate(decision)}
      />
    </main>
  );
}

function ComparisonRecommendationCard({
  projectId,
  recommendation
}: {
  projectId: string;
  recommendation: CoachComparisonRecommendation;
}) {
  return (
    <article className="rounded-[18px] border bg-white/68 p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate text-[15px] font-semibold">{recommendation.goalTitle}</h3>
        <Badge variant={recommendation.status === "ready_to_compare" ? "warning" : recommendation.status === "comparison_recorded" ? "success" : "muted"}>{humanize(recommendation.status)}</Badge>
      </div>
      <p className="mt-3 text-[13px] leading-5">{recommendation.recommendation}</p>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
        <span>{recommendation.completedRunCount}/{recommendation.runIds.length} Runs completed</span>
        <span className="font-mono">base {recommendation.baseSha.slice(0, 7)}</span>
        {recommendation.comparisonId ? <span>comparison {recommendation.comparisonId}</span> : null}
      </div>
      <Button type="button" size="sm" variant="outline" className="mt-4" onClick={() => pushAppPath(goalPath(projectId, recommendation.goalId))}>
        Review Goal <ChevronRight />
      </Button>
    </article>
  );
}

function SelectionRecommendationCard({
  projectId,
  recommendation
}: {
  projectId: string;
  recommendation: CoachSelectionRecommendation;
}) {
  return (
    <article className="rounded-[18px] border bg-white/68 p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate text-[15px] font-semibold">{recommendation.goalTitle}</h3>
        <Badge variant={recommendation.status === "decision_recorded" ? "success" : "warning"}>{humanize(recommendation.status)}</Badge>
        <Badge variant="outline">{humanize(recommendation.action)}</Badge>
      </div>
      <p className="mt-3 text-[13px] leading-5">{recommendation.recommendation}</p>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
        <span>{recommendation.runIds.length} compared Runs</span>
        <span>{humanize(recommendation.basis)}</span>
        {recommendation.recommendedRunId ? <span>candidate {recommendation.recommendedRunId}</span> : null}
      </div>
      <p className="mt-3 text-[10px] font-semibold text-[#8a4b00]">
        {recommendation.status === "decision_recorded" ? "The recorded decision was explicitly confirmed by a user." : "No decision is applied from this recommendation."}
      </p>
      <Button type="button" size="sm" variant="outline" className="mt-4" onClick={() => pushAppPath(goalPath(projectId, recommendation.goalId))}>
        {recommendation.status === "decision_recorded" ? "Review decision" : "Review and decide"} <ChevronRight />
      </Button>
    </article>
  );
}

function ProposalCard({ proposal, busy, onConfirm, onReject }: { proposal: CoachProposal; busy: boolean; onConfirm: () => void; onReject: () => void }) {
  return (
    <article className="rounded-[18px] border bg-white/68 p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><Lightbulb className="size-4 text-[color:var(--apple-blue)]" /><h3 className="text-[15px] font-semibold">{proposal.title}</h3><Badge variant="outline">{humanize(proposal.kind)}</Badge>{proposal.consequential ? <Badge variant="warning">Confirmation required</Badge> : null}</div><p className="mt-3 text-[13px] leading-5">{proposal.summary}</p><p className="mt-2 text-[12px] leading-5 text-muted-foreground">{proposal.rationale}</p></div>
      </div>
      <ProposalChangeDetails proposal={proposal} />
      <div className="mt-4 flex flex-wrap gap-2 border-t pt-3">
        <Button type="button" size="sm" disabled={busy} onClick={onConfirm}><Check />Review and confirm</Button>
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onReject}><X />Reject</Button>
      </div>
    </article>
  );
}

function ProposalChangeDetails({ proposal }: { proposal: CoachProposal }) {
  if (proposal.kind === "goal_change") {
    return <ChangePanel title="Exact Goal change"><GoalPatchDetails change={proposal.change} /></ChangePanel>;
  }
  if (proposal.kind === "runner_change") {
    return <ChangePanel title="Exact Runner assignment"><RunnerChangeDetails change={proposal.change} /></ChangePanel>;
  }
  return (
    <div className="mt-4 space-y-3" aria-label="Exact Hunsu alternative">
      <ChangePanel title="Completed source Run">
        <dl className="grid gap-2 text-[11px] sm:grid-cols-2">
          <Definition label="Run" value={proposal.sourceRun.id} />
          <Definition label="Status" value={humanize(proposal.sourceRun.status)} />
          <Definition label="Runner" value={`${proposal.sourceRun.runner.name} (${proposal.sourceRun.runner.kind})`} />
          <Definition label="Base SHA" value={proposal.sourceRun.baseSha} mono />
          <Definition label="Result SHA" value={proposal.sourceRun.resultSha} mono />
        </dl>
      </ChangePanel>
      <ChangePanel title={proposal.alternative.type === "goal_change" ? "Alternative Goal change" : "Alternative Runner assignment"}>
        {proposal.alternative.type === "goal_change"
          ? <GoalPatchDetails change={proposal.alternative.change} />
          : <RunnerChangeDetails change={proposal.alternative.change} />}
      </ChangePanel>
    </div>
  );
}

function ChangePanel({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="mt-3 rounded-[12px] border bg-white/62 px-3 py-3"><h4 className="text-[11px] font-semibold">{title}</h4><div className="mt-2">{children}</div></section>;
}

function GoalPatchDetails({ change }: { change: GoalPatchChange }) {
  return (
    <dl className="grid gap-2 text-[11px]">
      {change.title !== undefined ? <Definition label="Title" value={change.title} /> : null}
      {change.desiredOutcome !== undefined ? <Definition label="Desired outcome" value={change.desiredOutcome} /> : null}
      {change.acceptanceCriteria !== undefined ? <Definition label="Acceptance criteria" value={change.acceptanceCriteria.length > 0 ? change.acceptanceCriteria.join(" · ") : "None"} /> : null}
      {change.constraints !== undefined ? <Definition label="Constraints" value={change.constraints.length > 0 ? change.constraints.join(" · ") : "None"} /> : null}
      {change.priority !== undefined ? <Definition label="Priority" value={String(change.priority)} /> : null}
      {change.assignment !== undefined ? <Definition label="Runner assignment" value={assignmentLabel(change.assignment)} /> : null}
      {change.relation !== undefined ? <Definition label="Goal relation" value={relationLabel(change.relation)} /> : null}
    </dl>
  );
}

function RunnerChangeDetails({ change }: { change: RunnerAssignmentChange }) {
  return (
    <dl className="grid gap-2 text-[11px] sm:grid-cols-2">
      <Definition label="Current Runner" value={assignmentLabel(change.from)} />
      <Definition label="Proposed Runner" value={assignmentLabel(change.to)} />
    </dl>
  );
}

function Definition({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div><dt className="font-semibold text-muted-foreground">{label}</dt><dd className={`mt-0.5 break-words ${mono ? "font-mono text-[10px]" : ""}`}>{value}</dd></div>;
}

function proposalChangeDescription(proposal: CoachProposal): string {
  if (proposal.kind === "goal_change") return `Goal ${proposal.goalId}: ${goalPatchDescription(proposal.change)}.`;
  if (proposal.kind === "runner_change") {
    return `Goal ${proposal.goalId}: change Runner from ${assignmentLabel(proposal.change.from)} to ${assignmentLabel(proposal.change.to)}.`;
  }
  const alternative = proposal.alternative.type === "goal_change"
    ? goalPatchDescription(proposal.alternative.change)
    : `change Runner from ${assignmentLabel(proposal.alternative.change.from)} to ${assignmentLabel(proposal.alternative.change.to)}`;
  return `Create an alternative from completed Run ${proposal.sourceRun.id} at base ${proposal.sourceRun.baseSha}; ${alternative}.`;
}

function goalPatchDescription(change: GoalPatchChange): string {
  const fields = [
    change.title === undefined ? undefined : `title → ${change.title}`,
    change.desiredOutcome === undefined ? undefined : `desired outcome → ${change.desiredOutcome}`,
    change.acceptanceCriteria === undefined ? undefined : `acceptance criteria → ${change.acceptanceCriteria.join("; ") || "none"}`,
    change.constraints === undefined ? undefined : `constraints → ${change.constraints.join("; ") || "none"}`,
    change.priority === undefined ? undefined : `priority → ${change.priority}`,
    change.assignment === undefined ? undefined : `Runner assignment → ${assignmentLabel(change.assignment)}`,
    change.relation === undefined ? undefined : `Goal relation → ${relationLabel(change.relation)}`
  ].filter((field): field is string => field !== undefined);
  return fields.join(", ");
}

function assignmentLabel(assignment: GoalAssignmentChange): string {
  return assignment.type === "unassigned"
    ? "unassigned"
    : `${assignment.runner.name} (${assignment.runner.kind}, ${assignment.runnerId})`;
}

function relationLabel(relation: NonNullable<GoalPatchChange["relation"]>): string {
  if (relation.type === "root") return "root";
  if (relation.type === "child") return `child of ${relation.parentGoalId}`;
  return `related to ${relation.goalIds.join(", ")}`;
}
