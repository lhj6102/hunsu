import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Check, Clipboard, Pause, Play, RotateCcw, Sparkles } from "lucide-react";
import { apiErrorMessage } from "@/shared/api/client";
import { fetchGoal, requestHunsu, updateGoal } from "@/shared/api/projectApi";
import { useLogicalSubmissionKey } from "@/shared/api/useLogicalSubmissionKey";
import { formatTimestamp, shortSha } from "@/shared/format";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { ConfirmActionDialog } from "@/shared/ui/confirm-action-dialog";
import { GoalStatusBadge, ReviewStatusBadge } from "@/shared/ui/domain-badge";
import { EmptyState, PageError, PageLoading } from "@/shared/ui/page-state";
import { PageHeading } from "@/shared/ui/page-heading";
import { AlternativeComparison } from "@/features/alternatives/AlternativeComparison";
import { latestCompletedRun } from "@/features/goals/goalActionModel";
import { EvidenceList, RunList } from "@/features/projects/ProjectComponents";

export function GoalDetailScreen({ projectId, goalId }: { projectId: string; goalId: string }) {
  const queryClient = useQueryClient();
  const lifecycleSubmission = useLogicalSubmissionKey("goal.lifecycle");
  const hunsuSubmission = useLogicalSubmissionKey("hunsu.propose");
  const queryKey = ["projects", projectId, "goals", goalId] as const;
  const [hunsuOpen, setHunsuOpen] = useState(false);
  const [completeOpen, setCompleteOpen] = useState(false);
  const [copied, setCopied] = useState<string>();
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => fetchGoal(projectId, goalId, signal),
    refetchInterval: 5_000,
    refetchIntervalInBackground: false
  });
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey });
    void queryClient.invalidateQueries({ queryKey: ["projects", projectId] });
    void queryClient.invalidateQueries({ queryKey: ["projects"] });
  };
  const lifecycleMutation = useMutation({
    mutationFn: ({ status, selectedRunId }: { status: "active" | "paused" | "completed"; selectedRunId?: string }) => {
      const command = {
        status,
        ...(selectedRunId ? { selectedRunId } : {})
      };
      return updateGoal(projectId, goalId, {
        ...command,
        expectedStateSha: query.data!.stateHeadSha,
        idempotencyKey: lifecycleSubmission.keyFor({ projectId, goalId, ...command })
      });
    },
    onSuccess: () => {
      lifecycleSubmission.succeeded();
      setCompleteOpen(false);
      invalidate();
    }
  });
  const hunsuMutation = useMutation({
    mutationFn: (sourceRunId: string) => {
      const command = { projectId, goalId, sourceRunId };
      return requestHunsu(projectId, goalId, {
        sourceRunId,
        expectedStateSha: query.data!.stateHeadSha,
        idempotencyKey: hunsuSubmission.keyFor(command)
      });
    },
    onSuccess: () => {
      hunsuSubmission.succeeded();
      setHunsuOpen(false);
      invalidate();
    }
  });
  if (query.isLoading) return <PageLoading label="Loading Goal…" />;
  if (query.isError || !query.data) return <PageError message={apiErrorMessage(query.error, "Goal is unavailable.")} onRetry={() => void query.refetch()} />;
  const goal = query.data.goal;
  const sourceRun = latestCompletedRun(goal.runs);
  const selectedRunId = goal.decision?.recommendedRunId ?? (sourceRun?.status === "completed" ? sourceRun.id : undefined);

  async function copyPluginPrompt(kind: "continue" | "retry") {
    const prompt = kind === "continue"
      ? `Continue the Hunsu Goal “${goal.title}” in Project ${projectId}. Show me the available Runners before starting a Run.`
      : `Retry the latest Run for Hunsu Goal “${goal.title}” in Project ${projectId} from its original base commit.`;
    await navigator.clipboard.writeText(prompt);
    setCopied(kind);
    window.setTimeout(() => setCopied(undefined), 1_600);
  }

  return (
    <main className="apple-page min-h-screen overflow-y-auto">
      <div className="mx-auto w-full max-w-[1180px] px-6 py-8 lg:px-10 lg:py-12">
        <PageHeading
          eyebrow="Goal"
          title={goal.title}
          description={goal.desiredOutcome}
          actions={(
            <>
              <Button type="button" variant="outline" onClick={() => void copyPluginPrompt("continue")}>
                {copied === "continue" ? <Check /> : <Clipboard />}{copied === "continue" ? "Copied" : "Continue in plugin"}
              </Button>
              <Button type="button" variant="outline" disabled={goal.runs.length === 0} onClick={() => void copyPluginPrompt("retry")}>
                {copied === "retry" ? <Check /> : <RotateCcw />}{copied === "retry" ? "Copied" : "Retry in plugin"}
              </Button>
              <Button type="button" disabled={!sourceRun} onClick={() => setHunsuOpen(true)}><Sparkles />Give Hunsu</Button>
            </>
          )}
        />
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <GoalStatusBadge status={goal.status} />
          <Badge variant="outline">{goal.priority ?? "normal"} priority</Badge>
          <Badge variant="outline">{goal.runner?.name ?? "Runner not assigned"}</Badge>
          <span className="text-[11px] text-muted-foreground">Updated {formatTimestamp(goal.updatedAt)}</span>
        </div>

        <div className="mt-6 flex flex-wrap gap-2 border-y py-3">
          {goal.status === "paused" ? <Button type="button" size="sm" variant="outline" disabled={lifecycleMutation.isPending} onClick={() => lifecycleMutation.mutate({ status: "active" })}><Play />Resume Goal</Button> : null}
          {goal.status === "active" ? <Button type="button" size="sm" variant="outline" disabled={lifecycleMutation.isPending} onClick={() => lifecycleMutation.mutate({ status: "paused" })}><Pause />Pause Goal</Button> : null}
          {goal.status !== "completed" ? <Button type="button" size="sm" variant="outline" disabled={lifecycleMutation.isPending || !selectedRunId} onClick={() => setCompleteOpen(true)}><Check />Mark complete</Button> : null}
          {lifecycleMutation.isError ? <p className="self-center text-sm text-destructive">{apiErrorMessage(lifecycleMutation.error, "Goal update failed.")}</p> : null}
        </div>

        <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1.45fr)_minmax(280px,0.75fr)]">
          <div className="space-y-8">
            <DetailSection title="Acceptance criteria">
              <CheckList items={goal.acceptanceCriteria} empty="No acceptance criteria recorded." />
            </DetailSection>
            <DetailSection title="Run history" subtitle="This view polls while open, so plugin checkpoints and completion appear without a page refresh.">
              <RunList projectId={projectId} runs={goal.runs} />
            </DetailSection>
            <DetailSection title="Evidence">
              <EvidenceList evidence={goal.evidence} />
            </DetailSection>
          </div>
          <aside className="space-y-8">
            <DetailSection title="Constraints"><CheckList items={goal.constraints} empty="No constraints recorded." /></DetailSection>
            <DetailSection title="Runner">
              {goal.runner ? (
                <div className="rounded-[16px] border bg-white/64 p-4">
                  <p className="text-[14px] font-semibold">{goal.runner.name}</p>
                  <p className="mt-1 text-[11px] capitalize text-muted-foreground">{goal.runner.kind}</p>
                </div>
              ) : <EmptyState title="Runner not assigned" body="Choose a Player or Team through the plugin before starting work." />}
            </DetailSection>
            <DetailSection title="Coach review">
              {goal.coachReview ? (
                <div className="rounded-[16px] border bg-white/64 p-4">
                  <div className="flex items-center justify-between gap-3"><span className="flex items-center gap-2 text-[13px] font-semibold"><Bot className="size-4" />Assessment</span><ReviewStatusBadge status={goal.coachReview.status} /></div>
                  <p className="mt-3 text-[12px] leading-5 text-muted-foreground">{goal.coachReview.summary}</p>
                  {goal.coachReview.recommendation ? <p className="mt-3 border-l-2 border-[color:var(--apple-blue)] pl-3 text-[12px] leading-5">{goal.coachReview.recommendation}</p> : null}
                </div>
              ) : <EmptyState title="No Coach review" body="Ask the Coach to assess evidence after a Run reports a result." />}
            </DetailSection>
          </aside>
        </div>

        <div className="mt-10">
          <AlternativeComparison
            projectId={projectId}
            goalId={goalId}
            expectedStateSha={query.data.stateHeadSha}
            alternatives={goal.alternatives}
            comparisons={goal.comparisons}
          />
        </div>
      </div>

      <ConfirmActionDialog
        open={hunsuOpen}
        onOpenChange={setHunsuOpen}
        title="Create an alternative future?"
        description={sourceRun
          ? `Hunsu will use the latest completed Run, ${sourceRun.id}, and record a sibling alternative from base ${shortSha(sourceRun.baseSha)}. Before the plugin starts it, its Goal or Runner must change from the source. Nothing is selected automatically; completed siblings must be compared before a person confirms a decision.`
          : "A completed Run is required before Hunsu can create a sibling alternative. Retry or finish the current work first."}
        confirmLabel="Confirm Hunsu"
        busy={hunsuMutation.isPending}
        onConfirm={() => sourceRun && hunsuMutation.mutate(sourceRun.id)}
      />
      <ConfirmActionDialog
        open={completeOpen}
        onOpenChange={setCompleteOpen}
        title="Mark this Goal complete?"
        description={selectedRunId ? `This completes the Goal with Run ${selectedRunId} as the selected evidence-backed result. Existing alternatives and decisions remain available.` : "A completed Run must be selected before this Goal can be completed."}
        confirmLabel="Mark complete"
        busy={lifecycleMutation.isPending}
        onConfirm={() => selectedRunId && lifecycleMutation.mutate({ status: "completed", selectedRunId })}
      />
      {hunsuMutation.isError ? <div className="fixed bottom-5 right-5 z-50 max-w-sm rounded-[14px] border bg-white p-4 text-sm text-destructive shadow-lg">{apiErrorMessage(hunsuMutation.error, "Hunsu proposal failed.")}</div> : null}
    </main>
  );
}

function DetailSection({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return <section><h2 className="text-lg font-semibold">{title}</h2>{subtitle ? <p className="mt-1 text-[12px] leading-5 text-muted-foreground">{subtitle}</p> : null}<div className="mt-3">{children}</div></section>;
}

function CheckList({ items, empty }: { items: string[]; empty: string }) {
  return items.length > 0 ? (
    <ul className="grid gap-2">
      {items.map(item => <li key={item} className="flex gap-3 rounded-[14px] border bg-white/60 px-4 py-3 text-[13px] leading-5"><Check className="mt-0.5 size-4 shrink-0 text-[color:var(--apple-green)]" />{item}</li>)}
    </ul>
  ) : <p className="text-sm text-muted-foreground">{empty}</p>;
}
