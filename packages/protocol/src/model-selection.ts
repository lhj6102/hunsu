import type {
  DirectModelSelection,
  DirectProviderModelSelection,
  ManagerConfig,
  MemberConfig,
  MemberModelName,
  ModelSelection,
  ReasoningEffort,
  RuntimePolicy,
  ServiceTier
} from "./model.ts";
import { makeNonEmptyText } from "./primitives.ts";
import { unwrapDomainModelResult } from "./errors.ts";

export type NormalizedRuntimePolicy = RuntimePolicy & {
  modelSelection: ModelSelection;
  model: MemberModelName;
  reasoningEffort: ReasoningEffort;
  serviceTier: ServiceTier;
};

export function directCodexModelSelectionFromLegacy(input: {
  model?: MemberModelName | string;
  reasoningEffort?: ReasoningEffort;
  serviceTier?: ServiceTier;
}): DirectModelSelection {
  return {
    kind: "direct",
    provider: {
      providerId: "codex",
      model: memberModelName(input.model ?? "codex-default"),
      reasoningEffort: input.reasoningEffort ?? "default",
      serviceTier: input.serviceTier ?? "default",
      experimental: true
    }
  };
}

export function normalizeRuntimePolicy(policy: RuntimePolicy): NormalizedRuntimePolicy {
  const model = policy.model ?? legacyModelFromSelection(policy.modelSelection);
  const reasoningEffort = policy.reasoningEffort ?? legacyReasoningEffortFromSelection(policy.modelSelection);
  const serviceTier = policy.serviceTier ?? legacyServiceTierFromSelection(policy.modelSelection);
  return {
    ...policy,
    model,
    reasoningEffort,
    serviceTier,
    modelSelection: policy.modelSelection ?? directCodexModelSelectionFromLegacy({ model, reasoningEffort, serviceTier })
  };
}

export function modelSelectionFromMemberConfig(member: MemberConfig): ModelSelection {
  return member.modelSelection ?? directCodexModelSelectionFromLegacy({
    model: member.model,
    reasoningEffort: member.reasoningEffort,
    serviceTier: member.serviceTier
  });
}

export function modelSelectionFromManagerConfig(manager: ManagerConfig): ModelSelection | undefined {
  return manager.modelSelection;
}

export function directProviderSelectionFromModelSelection(selection: ModelSelection): DirectProviderModelSelection | undefined {
  return selection.kind === "direct" ? selection.provider : undefined;
}

function legacyModelFromSelection(selection: ModelSelection | undefined): MemberModelName {
  if (selection?.kind === "direct") {
    return memberModelName(selection.provider.model);
  }
  return memberModelName("codex-default");
}

function legacyReasoningEffortFromSelection(selection: ModelSelection | undefined): ReasoningEffort {
  return selection?.kind === "direct" ? selection.provider.reasoningEffort ?? "default" : "default";
}

function legacyServiceTierFromSelection(selection: ModelSelection | undefined): ServiceTier {
  return selection?.kind === "direct" ? selection.provider.serviceTier ?? "default" : "default";
}

function memberModelName(value: string): MemberModelName {
  return unwrapDomainModelResult(makeNonEmptyText(value, "modelSelection.provider.model"));
}
