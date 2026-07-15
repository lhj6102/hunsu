import type { EventReferenceProjection } from "@hunsu/projections";
import type { DomainEvent } from "@hunsu/protocol";

/** Shared DTO value types used by the bounded v2 read-model shards. */
export type EventLogCheckpoint = {
  readonly schema: "hunsu.event-log-checkpoint.v2";
  readonly eventCount: number;
  readonly lastSequence: number;
  readonly lastStoredEventId: string;
  readonly lastDomainEventId: string;
  readonly chainDigest: string;
};

export type ProjectGraphNode = {
  readonly type: "root" | "run_child" | "coaching_child";
  readonly sha: string;
  readonly treeSha: string;
  readonly managedRef: string;
  readonly commitTitle: string;
  readonly registeredAt: string;
  readonly planDigest: string;
  readonly payloadDigest: string;
  readonly runner: {
    readonly name: string;
    readonly origin: string;
    readonly typeKey: string;
    readonly schemaVersion: string;
    readonly digest: string;
  };
  readonly nextGoalCount: number;
  readonly status: "available" | "current" | "selected" | "rejected";
  readonly lineage:
    | { readonly type: "root" }
    | { readonly type: "run"; readonly parentSha: string; readonly runId: string; readonly consumedGoalDigest: string }
    | { readonly type: "coaching"; readonly parentSha: string; readonly proposalId: string };
};

export type ProjectGraphEdge =
  | {
      readonly type: "run";
      readonly sourceSha: string;
      readonly targetSha: string;
      readonly runId: string;
      readonly goalDigest: string;
      readonly goalTitle: string;
      readonly completedAt: string;
    }
  | {
      readonly type: "coaching";
      readonly sourceSha: string;
      readonly targetSha: string;
      readonly proposalId: string;
      readonly summary: string;
      readonly confirmedAt: string;
    };

export type ActiveRunReadModel = {
  readonly id: string;
  readonly sourceNodeSha: string;
  readonly goalDigest: string;
  readonly goalTitle: string;
  readonly runnerName: string;
  readonly startedAt: string;
};

export type RunActivityReadModel = ActiveRunReadModel & {
  readonly runnerDigest: string;
  readonly branch: string;
  readonly checkpoints: readonly {
    readonly id: string;
    readonly summary: string;
    readonly location: { readonly type: "observation" } | { readonly type: "commit"; readonly commitSha: string };
    readonly recordedAt: string;
  }[];
  readonly evidenceIds: readonly string[];
  readonly outcome:
    | { readonly type: "running" }
    | { readonly type: "completed"; readonly nodeSha: string; readonly verifiedAt: string; readonly completedAt: string }
    | { readonly type: "failed"; readonly failedAt: string; readonly reason: string }
    | { readonly type: "canceled"; readonly canceledAt: string; readonly reason: string };
};

export type EvidenceActivityReadModel = {
  readonly id: string;
  readonly runId: string;
  readonly kind: "diff" | "check" | "screenshot" | "report" | "note";
  readonly summary: string;
  readonly target: { readonly type: "run" } | { readonly type: "criterion"; readonly criterion: string };
  readonly location:
    | { readonly type: "git"; readonly commitSha: string; readonly path: string }
    | { readonly type: "url"; readonly url: string }
    | { readonly type: "text"; readonly text: string };
  readonly recordedAt: string;
};

export type ComparisonActivityReadModel = {
  readonly id: string;
  readonly parentNodeSha: string;
  readonly nodeShas: readonly string[];
  readonly summary: string;
  readonly recordedAt: string;
};

export type DecisionActivityReadModel = {
  readonly id: string;
  readonly type: "selection" | "rejection";
  readonly comparisonId: string;
  readonly nodeShas: readonly string[];
  readonly rationale: string;
  readonly decidedAt: string;
};

export type CoachingActivityReadModel = {
  readonly id: string;
  readonly sourceNodeSha: string;
  readonly sourcePayloadDigest: string;
  readonly proposedPlanDigest: string;
  readonly proposedAt: string;
  readonly reason: string;
  readonly disposition:
    | { readonly type: "pending" }
    | { readonly type: "confirmed"; readonly childNodeSha: string; readonly decidedAt: string }
    | { readonly type: "rejected"; readonly decidedAt: string };
};

export type ReviewActivityReadModel = {
  readonly id: string;
  readonly targetType: "node" | "run" | "comparison";
  readonly targetId: string;
  readonly assessment: string;
  readonly recommendations: readonly string[];
  readonly recordedAt: string;
};

export type EventIndexEntryReadModel = {
  readonly sequence: number;
  readonly storedEventId: string;
  readonly domainEventId: string;
  readonly eventType: DomainEvent["type"];
  readonly summary: string;
  readonly actor: { readonly id: string; readonly label: string };
  readonly occurredAt: string;
  readonly path: string;
  readonly reference: EventReferenceProjection;
};
