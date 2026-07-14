import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowRight, Check, ExternalLink, GitCommit, Play, Sparkles, X } from "lucide-react";
import { apiErrorMessage } from "@/shared/api/client";
import { invalidateProjectQueries, pollingQueryOptions } from "@/shared/api/polling";
import { fetchNode, startNodeRun } from "@/shared/api/projectApi";
import type { GoalValue, NodeDetailResponse } from "@/shared/api/types";
import { useLogicalSubmissionKey } from "@/shared/api/useLogicalSubmissionKey";
import { formatTimestamp, safeHttpHref, shortSha } from "@/shared/format";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { PageError, PageLoading } from "@/shared/ui/page-state";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/shared/ui/sheet";
import { useMediaQuery } from "@/shared/useMediaQuery";

type StartRunCommand = {
  goalDigest: string;
  runId: string;
};

export function NodeInspector({ projectId, nodeSha, onClose }: { projectId: string; nodeSha: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const submission = useLogicalSubmissionKey("node.run.start");
  const [coachCopied, setCoachCopied] = useState(false);
  const mobile = useMediaQuery("(max-width: 767px)");
  const queryKey = ["projects", projectId, "nodes", nodeSha] as const;
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => fetchNode(projectId, nodeSha, signal),
    ...pollingQueryOptions<NodeDetailResponse>({
      activeIntervalMs: 10_000,
      stableIntervalMs: 60_000,
      isActive: data => data.node.activeRuns.length > 0
    })
  });
  useEffect(() => () => {
    window.setTimeout(() => {
      queryClient.removeQueries({ queryKey, exact: true, type: "inactive" });
    }, 0);
  }, [nodeSha, projectId, queryClient]);
  const startMutation = useMutation({
    mutationFn: (command: StartRunCommand) => startNodeRun(projectId, nodeSha, {
      ...command,
      expectedStateSha: query.data!.stateHeadSha,
      idempotencyKey: submission.keyFor({ projectId, nodeSha, ...command })
    }),
    onSuccess: () => {
      submission.succeeded();
      void queryClient.invalidateQueries({ queryKey });
      void invalidateProjectQueries(queryClient);
    }
  });

  async function copyCoachPrompt() {
    const title = query.data?.node.title ?? shortSha(nodeSha);
    await navigator.clipboard.writeText(`Coach Hunsu Node ${nodeSha} (${title}). Review its exact NodePlan and propose a new single-parent Coaching child for explicit confirmation.`);
    setCoachCopied(true);
    window.setTimeout(() => setCoachCopied(false), 1_800);
  }

  const content = query.isLoading ? (
    <PageLoading label="Decoding Node…" />
  ) : !query.data ? (
    <PageError message={apiErrorMessage(query.error, "The selected Node is unavailable.")} onRetry={() => void query.refetch()} />
  ) : (
    <InspectorContent
      data={query.data}
      coachCopied={coachCopied}
      startingGoalDigest={startMutation.isPending ? startMutation.variables?.goalDigest : undefined}
      startError={startMutation.isError ? apiErrorMessage(startMutation.error, "The Run could not be started.") : undefined}
      onCopyCoach={() => void copyCoachPrompt()}
      onStartGoal={goal => startMutation.mutate({ goalDigest: goal.digest, runId: crypto.randomUUID() })}
      onRetryStart={() => {
        if (startMutation.variables) startMutation.mutate(startMutation.variables);
      }}
    />
  );

  if (!mobile) {
    return (
      <aside aria-label="Selected Node" className="absolute inset-y-4 right-4 z-20 hidden w-[390px] overflow-hidden rounded-[18px] border bg-white/92 shadow-[var(--apple-node-shadow)] backdrop-blur-xl md:flex md:flex-col">
        <div className="flex h-12 items-center justify-between border-b px-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Node details</p>
          <Button type="button" variant="ghost" size="icon" className="size-8" aria-label="Close Node details" onClick={onClose}><X /></Button>
        </div>
        <ScrollArea className="min-h-0 flex-1"><div className="p-5">{content}</div></ScrollArea>
      </aside>
    );
  }
  return (
      <Sheet open onOpenChange={open => { if (!open) onClose(); }}>
        <SheetContent side="bottom" className="max-h-[88vh] overflow-y-auto bg-[color:var(--apple-canvas-alt)] md:hidden">
          <SheetHeader>
            <SheetTitle>Node details</SheetTitle>
            <SheetDescription>Decoded from the exact Hunsu state head.</SheetDescription>
          </SheetHeader>
          <div className="mt-5">{content}</div>
        </SheetContent>
      </Sheet>
  );
}

function InspectorContent({
  data,
  coachCopied,
  startingGoalDigest,
  startError,
  onCopyCoach,
  onStartGoal,
  onRetryStart
}: {
  data: NodeDetailResponse;
  coachCopied: boolean;
  startingGoalDigest: string | undefined;
  startError: string | undefined;
  onCopyCoach: () => void;
  onStartGoal: (goal: GoalValue) => void;
  onRetryStart: () => void;
}) {
  const { node } = data;
  const commitHref = safeHttpHref(node.commitUrl);
  const rejected = node.status === "rejected";
  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="font-mono text-lg font-semibold">{shortSha(node.sha)}</h2>
            <NodeStatus status={node.status} />
          </div>
          <p className="mt-1 text-sm font-medium leading-5">{node.title}</p>
          <p className="mt-2 break-all font-mono text-[9px] leading-4 text-muted-foreground">{node.sha}</p>
        </div>
        {commitHref ? (
          <Button asChild variant="ghost" size="icon" className="size-8 shrink-0">
            <a href={commitHref} target="_blank" rel="noreferrer" aria-label="Open commit on GitHub"><ExternalLink /></a>
          </Button>
        ) : null}
      </div>

      <Button type="button" variant="outline" className="mt-5 w-full justify-center" disabled={rejected} onClick={onCopyCoach}>
        {coachCopied ? <Check /> : <Sparkles />}{coachCopied ? "Coaching prompt copied" : "Coach this node"}
      </Button>

      {node.integrity.status === "invalid" ? (
        <div role="alert" className="mt-4 rounded-[12px] border border-red-200 bg-red-50 p-3 text-xs leading-5 text-red-900">{node.integrity.message}</div>
      ) : <p className="mt-4 flex items-center gap-2 text-[10px] text-[color:var(--apple-green)]"><Check className="size-3.5" />Payload, topology, and managed-ref integrity verified</p>}
      {startError ? (
        <div role="alert" className="mt-4 rounded-[12px] border border-red-200 bg-red-50 p-3 text-xs leading-5 text-red-900">
          <p>{startError}</p>
          <Button type="button" variant="outline" size="sm" className="mt-2" onClick={onRetryStart}>Retry same request</Button>
        </div>
      ) : null}

      <InspectorSection title="Next goals" count={node.plan.nextGoals.length}>
        {node.plan.nextGoals.length > 0 ? (
          <div className="grid gap-2">
            {node.plan.nextGoals.map(goal => {
              const active = node.activeRuns.some(run => run.goalDigest === goal.digest);
              const starting = startingGoalDigest === goal.digest;
              return (
                <article key={goal.digest} className="rounded-[12px] border bg-white/72 p-3">
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-[12px] font-semibold leading-5">{goal.title}</p>
                      <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">{goal.desiredOutcome}</p>
                      <details className="mt-2 text-[10px] text-muted-foreground">
                        <summary className="cursor-pointer font-medium text-foreground">Goal contract</summary>
                        <div className="mt-2 space-y-2 border-l pl-2 leading-4">
                          <p>Priority {goal.priority}</p>
                          <div><p className="font-medium text-foreground">Acceptance criteria</p><ul className="mt-1 list-disc pl-4">{goal.acceptanceCriteria.map(criterion => <li key={criterion}>{criterion}</li>)}</ul></div>
                          {goal.constraints.length > 0 ? <div><p className="font-medium text-foreground">Constraints</p><ul className="mt-1 list-disc pl-4">{goal.constraints.map(constraint => <li key={constraint}>{constraint}</li>)}</ul></div> : null}
                        </div>
                      </details>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="shrink-0 text-[color:var(--apple-blue)]"
                      disabled={rejected || active || startingGoalDigest !== undefined}
                      onClick={() => onStartGoal(goal)}
                    >
                      <Play />{starting ? "Starting…" : active ? "Running" : "Run"}
                    </Button>
                  </div>
                </article>
              );
            })}
          </div>
        ) : <p className="text-xs leading-5 text-muted-foreground">This Node has no remaining Goals.</p>}
      </InspectorSection>

      <InspectorSection title="How">
        <div className="rounded-[12px] border bg-white/72 p-3">
          <p className="text-[13px] font-semibold">{node.plan.how.name}</p>
          <p className="mt-1 text-[10px] text-muted-foreground">{node.plan.how.type.origin} · {node.plan.how.type.key} · schema {node.plan.how.type.schemaVersion}</p>
          <p className="mt-2 truncate font-mono text-[10px] text-muted-foreground" title={node.plan.how.digest}>{node.plan.how.digest}</p>
          <details className="mt-3 border-t pt-3 text-[10px] text-muted-foreground">
            <summary className="cursor-pointer font-medium text-foreground">Runner Value</summary>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-[8px] bg-[color:var(--apple-canvas-alt)] p-2 font-mono text-[9px] leading-4 text-[color:var(--apple-body)]">{JSON.stringify(node.plan.how.value, null, 2)}</pre>
            <p className="mt-2 break-all font-mono text-[9px]" title={node.plan.how.type.integrity}>type integrity · {node.plan.how.type.integrity}</p>
          </details>
        </div>
      </InspectorSection>

      {node.activeRuns.length > 0 ? (
        <InspectorSection title="Active Runs" count={node.activeRuns.length}>
          <div className="grid gap-2">
            {node.activeRuns.map(run => (
              <div key={run.id} className="rounded-[12px] border border-blue-200 bg-blue-50/72 p-3">
                <p className="text-[12px] font-semibold">{run.goalTitle}</p>
                <p className="mt-1 text-[10px] text-muted-foreground">{run.runnerName} · started {formatTimestamp(run.startedAt)}</p>
              </div>
            ))}
          </div>
        </InspectorSection>
      ) : null}

      <InspectorSection title="Lineage">
        <div className="space-y-2 text-[11px] text-muted-foreground">
          <div className="flex items-start gap-2"><GitCommit className="mt-0.5 size-3.5 shrink-0" /><div className="min-w-0"><p>tree SHA</p><p className="mt-1 break-all font-mono text-[9px] text-[color:var(--apple-body)]">{node.treeSha}</p></div></div>
          <p className="truncate font-mono text-[10px]" title={node.managedRef}>{node.managedRef}</p>
          {node.lineage.kind === "root" ? <Badge variant="outline">Root Node</Badge> : (
            <div className="rounded-[10px] border bg-white/58 p-2.5">
              <p className="flex items-center gap-2">
                {node.lineage.kind === "run_child" ? <ArrowRight className="size-3.5 text-[color:var(--apple-blue)]" /> : <ArrowDown className="size-3.5 text-emerald-600" />}
                {node.lineage.kind === "run_child" ? "Run child" : "Coaching child"}
                <span className="ml-auto font-mono">{shortSha(node.lineage.parentSha)}</span>
              </p>
              <p className="mt-2 break-all font-mono text-[9px]">{node.lineage.kind === "run_child" ? `run ${node.lineage.runId} · goal ${node.lineage.goalDigest}` : `proposal ${node.lineage.proposalId}`}</p>
            </div>
          )}
        </div>
      </InspectorSection>

      {node.outgoingEdges.length > 0 ? (
        <InspectorSection title="Outgoing" count={node.outgoingEdges.length}>
          <div className="grid gap-2">
            {node.outgoingEdges.map(edge => (
              <div key={edge.id} className="flex items-center gap-2 rounded-[12px] border bg-white/72 p-3 text-[11px]">
                {edge.kind === "run" ? <ArrowRight className="size-3.5 shrink-0 text-[color:var(--apple-blue)]" /> : <ArrowDown className="size-3.5 shrink-0 text-emerald-600" />}
                <span className="min-w-0 flex-1 truncate">{edge.kind === "run" ? edge.goal.title : edge.summary}</span>
                <span className="shrink-0 font-mono text-[9px] text-muted-foreground">{shortSha(edge.targetSha)}</span>
              </div>
            ))}
          </div>
        </InspectorSection>
      ) : null}

      {node.evidence.length > 0 ? (
        <InspectorSection title="Evidence" count={node.evidence.length}>
          <div className="grid gap-2">
            {node.evidence.map(evidence => (
              <div key={evidence.id} className="rounded-[12px] border bg-white/72 p-3">
                <p className="text-[12px] font-semibold">{evidence.title}</p>
                <p className="mt-1 text-[11px] leading-4 text-muted-foreground">{evidence.summary}</p>
                <p className="mt-2 text-[9px] leading-4 text-muted-foreground">{evidence.criterion.kind === "linked" ? `Criterion · ${evidence.criterion.criterion}` : "Unlinked evidence"}</p>
                {evidence.location.kind === "url" && safeHttpHref(evidence.location.url) ? <a className="mt-2 inline-flex items-center gap-1 text-[10px] text-[color:var(--apple-blue)] hover:underline" href={safeHttpHref(evidence.location.url)!} target="_blank" rel="noreferrer">Open evidence<ExternalLink className="size-3" /></a> : null}
              </div>
            ))}
          </div>
        </InspectorSection>
      ) : null}

      {node.comparisons.length > 0 || node.decisions.length > 0 ? (
        <InspectorSection title="Alternatives">
          <div className="grid gap-2 text-[11px]">
            {node.comparisons.map(comparison => <p key={comparison.id} className="rounded-[12px] border bg-white/72 p-3 leading-4">{comparison.summary}</p>)}
            {node.decisions.map(decision => <p key={decision.id} className="rounded-[12px] border bg-white/72 p-3 leading-4"><strong>{decision.kind === "selected" ? "Selected" : "Rejected"}</strong> · {decision.reason}</p>)}
          </div>
        </InspectorSection>
      ) : null}

      <p className="mt-6 truncate font-mono text-[9px] text-muted-foreground" title={data.stateHeadSha}>State {data.stateHeadSha}</p>
    </div>
  );
}

function InspectorSection({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section className="mt-6 border-t pt-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{title}</h3>
        {count !== undefined ? <span className="text-[10px] text-muted-foreground">{count}</span> : null}
      </div>
      {children}
    </section>
  );
}

function NodeStatus({ status }: { status: NodeDetailResponse["node"]["status"] }) {
  if (status === "rejected") return <Badge variant="muted">Rejected</Badge>;
  if (status === "selected") return <Badge variant="success">Selected</Badge>;
  if (status === "current") return <Badge variant="success">Current</Badge>;
  return <Badge variant="outline">Available</Badge>;
}
