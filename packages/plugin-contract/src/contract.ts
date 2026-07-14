export type EvidenceRequirement = {
  criterion: string;
  kind: "check" | "commit" | "artifact" | "observation";
  description: string;
  required: boolean;
};

export type EvidenceInput = {
  kind: "check" | "commit" | "artifact" | "observation";
  summary: string;
  url?: string;
  sha?: string;
  criterion?: string;
};

export type GoalSnapshot = {
  id: string;
  title: string;
  desiredOutcome: string;
  acceptanceCriteria: string[];
  constraints: string[];
};

export type PlayerSnapshot = {
  kind: "player";
  id: string;
  promptTemplate: string;
  resources: Array<{ kind: string; name: string; reference: string }>;
  runtimePolicy: {
    filesystem: "read_only" | "worktree_write";
    network: "disabled" | "enabled";
    approvals: "never" | "on_request";
  };
};

export type TeamSnapshot = {
  kind: "team";
  id: string;
  strategy: {
    mode: "sequence" | "parallel" | "coordinated";
    promptTemplate: string;
    maxRounds: number;
  };
  players: Array<{
    id: string;
    role: string;
    order: number;
    promptTemplate: string;
    resources: PlayerSnapshot["resources"];
    runtimePolicy: PlayerSnapshot["runtimePolicy"];
  }>;
};

export type RunnerSnapshot = PlayerSnapshot | TeamSnapshot;

export type RunContract = {
  schema: "hunsu.run-contract.v1";
  runId: string;
  projectId: string;
  goal: GoalSnapshot;
  runner: RunnerSnapshot;
  repository: {
    installationId: number;
    repositoryId: number;
    owner: string;
    name: string;
    baseSha: string;
    branch: string;
  };
  instructions: string;
  acceptanceCriteria: string[];
  constraints: string[];
  requiredEvidence: EvidenceRequirement[];
  toolPolicy: {
    filesystem: "read_only" | "worktree_write";
    network: "disabled" | "enabled";
    approvals: "never" | "on_request";
  };
  lease: {
    expiresAt: string;
    checkpointAfterSeconds: number;
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
  | "confirmation_required"
  | "temporarily_unavailable";

export type PluginSafeError = {
  code: PluginErrorCode;
  message: string;
  retryable: boolean;
  retryAfterSeconds?: number;
  requestId?: string;
  recovery?: string;
  expectedStateSha?: string;
  actualStateSha?: string;
};

export type ToolResponse<T> =
  | { ok: true; data: T; stateHeadSha?: string }
  | { ok: false; error: PluginSafeError };
