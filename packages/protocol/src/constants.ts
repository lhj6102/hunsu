import type {
  DestinationSource,
  DestinationStatus,
  ArtifactActionKind,
  ArtifactActionSourceScope,
  HunsuDraftStatus,
  LineStatus,
  MoveOutcome,
  ReasoningEffort,
  ServiceTier
} from "./model.ts";

export const REASONING_EFFORTS = ["default", "minimal", "low", "medium", "high", "xhigh"] as const satisfies readonly ReasoningEffort[];
export const SERVICE_TIERS = ["default", "fast"] as const satisfies readonly ServiceTier[];
export const DOMAIN_ROLES = ["TEAM", "DIRECTOR", "SYSTEM"] as const;
export const GUARDRAIL_SCOPES = ["input", "output", "context", "artifact", "final_evidence"] as const;
export const GUARDRAIL_SEVERITIES = ["warn", "block"] as const;
export const VOTE_RULES = ["majority", "unanimous", "weighted", "coordinator_decides"] as const;
export const DESTINATION_STATUSES = ["pending", "claimed", "in_progress", "reached", "blocked", "superseded", "canceled"] as const satisfies readonly DestinationStatus[];
export const DESTINATION_SOURCES = ["initial-execute-team", "initial-request", "hunsu"] as const satisfies readonly DestinationSource[];
export const LINE_STATUSES = ["active", "paused", "complete", "failed", "abandoned"] as const satisfies readonly LineStatus[];
export const MOVE_OUTCOMES = ["arrived", "accident"] as const satisfies readonly MoveOutcome[];
export const HUNSU_DRAFT_STATUSES = ["draft", "ready", "confirmed", "discarded"] as const satisfies readonly HunsuDraftStatus[];
export const SKILL_DRAFT_STATUSES = ["draft", "accepted", "discarded"] as const;
export const ARTIFACT_KINDS = ["transcript", "command-output", "test-log", "screenshot", "diff-summary", "note"] as const;
export const ARTIFACT_ACTION_KINDS = ["host", "check"] as const satisfies readonly ArtifactActionKind[];
export const ARTIFACT_ACTION_SOURCE_SCOPES = ["move", "commit", "move-or-commit"] as const satisfies readonly ArtifactActionSourceScope[];
