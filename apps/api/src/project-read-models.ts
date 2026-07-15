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

/**
 * The topology-only identity committed by a Graph page Merkle root. Keep this
 * deliberately narrower than the card DTO: display metadata can change its
 * projection without weakening parent or outgoing-edge membership proofs.
 */
export type GraphNodeTopologyIdentity = {
  readonly type: ProjectGraphNode["type"];
  readonly sha: string;
  readonly managedRef: string;
  readonly ordinal: number;
  readonly parentOrdinal: number | null;
  readonly lineage: ProjectGraphNode["lineage"];
};

export type GraphNodeIdentityProofStep = {
  readonly side: "left" | "right";
  readonly digest: string;
};

export type GraphNodeIdentityProof = {
  readonly pageIndex: number;
  readonly leafIndex: number;
  readonly identity: GraphNodeTopologyIdentity;
  readonly siblings: readonly GraphNodeIdentityProofStep[];
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
  /** Canonical Goal digest copied from the immutable Run snapshot. */
  readonly goalDigest: string;
  readonly kind: "diff" | "check" | "screenshot" | "report" | "note";
  readonly summary: string;
  readonly target: { readonly type: "run" } | { readonly type: "criterion"; readonly criterion: string };
  readonly location:
    | { readonly type: "git"; readonly commitSha: string; readonly path: string }
    | { readonly type: "url"; readonly url: string }
    | { readonly type: "text"; readonly text: string };
  readonly recordedAt: string;
};

type ComparisonActivityBaseReadModel = {
  readonly id: string;
  readonly eventId: string;
  readonly nodeShas: readonly string[];
  readonly summary: string;
  readonly recordedAt: string;
  readonly disposition:
    | { readonly type: "undecided" }
    | { readonly type: "decisions_recorded"; readonly decisions: readonly DecisionActivityReadModel[] };
};

export type ComparisonActivityReadModel =
  | (ComparisonActivityBaseReadModel & {
      readonly type: "sibling_runs";
      readonly parentNodeSha: string;
    })
  | (ComparisonActivityBaseReadModel & {
      readonly type: "coached_how_experiment";
      readonly anchorNodeSha: string;
      readonly goalDigest: string;
    });

export type DecisionActivityReadModel = {
  readonly id: string;
  readonly eventId: string;
  readonly type: "selection" | "rejection";
  readonly comparisonId: string;
  readonly nodeShas: readonly string[];
  readonly rationale: string;
  readonly decidedAt: string;
};

export type CoachingActivityReadModel = {
  readonly id: string;
  readonly eventId: string;
  readonly sourceNodeSha: string;
  readonly sourcePayloadDigest: string;
  readonly sourcePlanDigest: string;
  readonly proposedPlanDigest: string;
  readonly expectedStateSha: string;
  readonly summary: string;
  readonly rationale: string;
  readonly proposedAt: string;
  readonly disposition:
    | { readonly type: "pending" }
    | {
      readonly type: "confirmed";
      readonly decisionId: string;
      readonly decisionEventId: string;
      readonly childRegistrationEventId: string;
      readonly childNodeSha: string;
        readonly reason: string;
        readonly decidedAt: string;
      }
    | {
        readonly type: "rejected";
        readonly decisionId: string;
        readonly decisionEventId: string;
        readonly reason: string;
        readonly decidedAt: string;
      };
};

export type ReviewActivityReadModel = {
  readonly id: string;
  readonly eventId: string;
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
