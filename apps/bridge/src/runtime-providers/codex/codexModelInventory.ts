import type {
  DirectProviderModelSelection,
  ProviderModelDescriptor,
  ReasoningEffort,
  ServiceTier
} from "@hunsu/protocol";
import { makeNonEmptyText, unwrapDomainModelResult } from "@hunsu/protocol";

export function codexProviderModelInventory(): ProviderModelDescriptor[] {
  return [
    codexModel("codex-default", "Codex Default", ["default", "low", "medium", "high"], ["default", "fast"], "default"),
    codexModel("gpt-5.5-thinking", "GPT-5.5 Thinking", ["high", "xhigh"], ["default", "fast"], "high"),
    codexModel("gpt-5.5", "GPT-5.5", ["default", "low", "medium", "high"], ["default", "fast"], "medium")
  ];
}

function codexModel(
  model: string,
  label: string,
  reasoningEfforts: ReasoningEffort[],
  serviceTiers: ServiceTier[],
  defaultReasoningEffort: ReasoningEffort
): ProviderModelDescriptor {
  return {
    model: nonEmpty(model, "providerInventory.model"),
    label: nonEmpty(label, "providerInventory.model.label"),
    capabilities: {
      reasoningEfforts,
      serviceTiers,
      supportsReasoning: reasoningEfforts.length > 0,
      supportsFastTier: serviceTiers.includes("fast")
    },
    defaultConfig: {
      providerId: "codex",
      model: nonEmpty(model, "providerInventory.model.defaultConfig.model"),
      reasoningEffort: defaultReasoningEffort,
      serviceTier: "default",
      ...(model === "codex-default" ? { experimental: true as const } : {})
    } as DirectProviderModelSelection
  };
}

function nonEmpty(value: string, path: string) {
  return unwrapDomainModelResult(makeNonEmptyText(value, path));
}
