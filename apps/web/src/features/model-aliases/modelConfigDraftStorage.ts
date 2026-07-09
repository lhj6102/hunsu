import type { ExecutorEntity, ManagerConfig, MemberConfig } from "@/shared/api/bridgeTypes";
import {
  assignExecutorModelSelection,
  assignManagerModelSelection,
  assignMemberModelSelection,
  type ModelSelectionAssignment
} from "./modelSelectionAssignment.js";

export const MODEL_CONFIG_DRAFT_STORAGE_KEY = "hunsu.modelConfigDraft.v1";

export type WebModelConfigTarget = "manager" | "member" | "executor";

export type WebModelConfigDraft = {
  manager: ManagerConfig;
  member: MemberConfig;
  executor: Extract<ExecutorEntity, { kind: "member" }>;
  updatedAt: string;
};

export function createDefaultWebModelConfigDraft(now = "1970-01-01T00:00:00.000Z"): WebModelConfigDraft {
  const manager = assignManagerModelSelection({
    id: "manager.web-draft" as ManagerConfig["id"],
    promptTemplate: { engine: "hunsu-template-v1", template: "Guide HUNSU Draft changes for this Roadmap." },
    skills: [],
    plugins: []
  }, { mode: "alias", aliasId: "PrimaryModel" });

  const member = assignMemberModelSelection({
    id: "member.web-draft" as MemberConfig["id"],
    promptTemplate: { engine: "hunsu-template-v1", template: "Execute the focused Destination." },
    skills: [],
    plugins: [],
    model: "codex-default" as MemberConfig["model"],
    reasoningEffort: "default",
    serviceTier: "default",
    execution: { kind: "worktree_write", network: "disabled" },
    approval: { policy: "on_request", reviewer: "auto_review" }
  }, { mode: "alias", aliasId: "PrimaryModel" });

  const executor = assignExecutorModelSelection({
    kind: "member",
    id: "executor.web-draft" as Extract<ExecutorEntity, { kind: "member" }>["id"],
    promptTemplate: { engine: "hunsu-template-v1", template: "Run the selected Executor task." },
    resources: [],
    runtimePolicy: {
      model: "codex-default" as NonNullable<Extract<ExecutorEntity, { kind: "member" }>["runtimePolicy"]["model"]>,
      reasoningEffort: "default",
      serviceTier: "default",
      execution: { kind: "worktree_write", network: "disabled" },
      approval: { policy: "on_request", reviewer: "auto_review" }
    }
  }, { mode: "alias", aliasId: "PrimaryModel" }) as Extract<ExecutorEntity, { kind: "member" }>;

  return { manager, member, executor, updatedAt: now };
}

export function readWebModelConfigDraft(): WebModelConfigDraft {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(MODEL_CONFIG_DRAFT_STORAGE_KEY) ?? "null") as unknown;
    if (isWebModelConfigDraftLike(parsed)) {
      return parsed;
    }
  } catch (_error) {
    return createDefaultWebModelConfigDraft();
  }
  return createDefaultWebModelConfigDraft();
}

export function writeWebModelConfigDraft(draft: WebModelConfigDraft): void {
  window.localStorage.setItem(MODEL_CONFIG_DRAFT_STORAGE_KEY, JSON.stringify(draft));
}

export function assignWebModelConfigDraft(
  draft: WebModelConfigDraft,
  target: WebModelConfigTarget,
  assignment: ModelSelectionAssignment,
  now = new Date().toISOString()
): WebModelConfigDraft {
  if (target === "manager") {
    return {
      ...draft,
      manager: assignManagerModelSelection(draft.manager, assignment),
      updatedAt: now
    };
  }
  if (target === "member") {
    return {
      ...draft,
      member: assignMemberModelSelection(draft.member, assignment),
      updatedAt: now
    };
  }
  return {
    ...draft,
    executor: assignExecutorModelSelection(draft.executor, assignment) as Extract<ExecutorEntity, { kind: "member" }>,
    updatedAt: now
  };
}

function isWebModelConfigDraftLike(value: unknown): value is WebModelConfigDraft {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<WebModelConfigDraft>;
  return isManagerConfigLike(candidate.manager)
    && isMemberConfigLike(candidate.member)
    && candidate.executor?.kind === "member"
    && typeof candidate.executor.id === "string"
    && typeof candidate.executor.runtimePolicy === "object"
    && typeof candidate.updatedAt === "string";
}

function isManagerConfigLike(value: unknown): value is ManagerConfig {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<ManagerConfig>;
  return typeof candidate.id === "string"
    && typeof candidate.promptTemplate === "object"
    && Array.isArray(candidate.skills)
    && Array.isArray(candidate.plugins);
}

function isMemberConfigLike(value: unknown): value is MemberConfig {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<MemberConfig>;
  return typeof candidate.id === "string"
    && typeof candidate.promptTemplate === "object"
    && Array.isArray(candidate.skills)
    && Array.isArray(candidate.plugins)
    && typeof candidate.model === "string"
    && typeof candidate.reasoningEffort === "string"
    && typeof candidate.execution === "object"
    && typeof candidate.approval === "object";
}
