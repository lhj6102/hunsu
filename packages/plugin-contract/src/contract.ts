export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

export type GoalDigest = `hunsu-goal-v1:sha256:${string}`;
export type RunnerDigest = `hunsu-runner-v1:sha256:${string}`;
export type RunnerTypeIntegrity = `hunsu-runner-type-v1:sha256:${string}`;

export type EvidenceRequirement = {
  readonly criterion: string;
  readonly kind: "check" | "commit" | "artifact" | "observation";
  readonly description: string;
  readonly required: boolean;
};

export type EvidenceLocation =
  | { readonly type: "git"; readonly commitSha: string; readonly path: string }
  | { readonly type: "url"; readonly url: string }
  | { readonly type: "text"; readonly text: string };

export type EvidenceInput = {
  readonly kind: "diff" | "check" | "screenshot" | "report" | "note";
  readonly summary: string;
  readonly target:
    | { readonly type: "run" }
    | { readonly type: "criterion"; readonly criterion: string };
  readonly location: EvidenceLocation;
};

export type GoalValue = {
  readonly key: string;
  readonly title: string;
  readonly desiredOutcome: string;
  readonly acceptanceCriteria: readonly [string, ...string[]];
  readonly constraints: readonly string[];
  readonly priority: number;
};

export type RunnerTypeLock = {
  readonly origin: string;
  readonly key: string;
  readonly schemaVersion: string;
  readonly integrity: RunnerTypeIntegrity;
};

export type RunnerValue = {
  readonly schema: "hunsu.runner-value.v1";
  readonly type: RunnerTypeLock;
  readonly name: string;
  readonly value: CanonicalJsonValue;
};

export type NodePlan = {
  readonly schema: "hunsu.node-plan.v1";
  readonly nextGoals: readonly GoalValue[];
  readonly how: RunnerValue;
};

/**
 * The immutable execution handshake returned by hunsu.runs.start.
 * The contract contains exactly one Goal and the complete Runner Value copied
 * from the source Node. Callers cannot replace either value after Run start.
 */
export type RunContract = {
  readonly schema: "hunsu.run-contract.v2";
  readonly runId: string;
  readonly projectId: string;
  readonly sourceNodeSha: string;
  readonly goal: GoalValue;
  readonly goalDigest: GoalDigest;
  readonly runner: RunnerValue;
  readonly runnerDigest: RunnerDigest;
  readonly repository: {
    readonly installationId: number;
    readonly repositoryId: number;
    readonly owner: string;
    readonly name: string;
    readonly branch: string;
  };
  readonly instructions: string;
  readonly requiredEvidence: readonly EvidenceRequirement[];
  readonly toolPolicy: {
    readonly filesystem: "read_only" | "worktree_write";
    readonly network: "disabled" | "enabled";
    readonly approvals: "never" | "on_request";
  };
  readonly lease: {
    readonly expiresAt: string;
    readonly checkpointAfterSeconds: number;
  };
};

export type PluginErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "invalid_request"
  | "conflict"
  | "stale_state"
  | "stale_base"
  | "result_unreachable"
  | "integrity_error"
  | "confirmation_required"
  | "unsupported_protocol_version"
  | "temporarily_unavailable";

export type PluginSafeError = {
  readonly code: PluginErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
  readonly requestId?: string;
  readonly recovery?: string;
  readonly expectedStateSha?: string;
  readonly actualStateSha?: string;
};

export type ToolResponse<T> =
  | { readonly ok: true; readonly data: T; readonly stateHeadSha?: string }
  | { readonly ok: false; readonly error: PluginSafeError };
