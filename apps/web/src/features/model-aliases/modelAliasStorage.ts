import type { DirectModelSelection, DirectProviderModelSelection, ModelAlias } from "@/shared/api/bridgeTypes";

export const MODEL_ALIAS_STORAGE_KEY = "hunsu.modelAliases.v1";

export function defaultWebModelAliases(now = "1970-01-01T00:00:00.000Z"): ModelAlias[] {
  return [
    alias("PrimaryModel", "Primary Model", "gpt-5.5-thinking", "high", "default", now),
    alias("FastModel", "Fast Model", "gpt-5.5", "medium", "fast", now),
    alias("ReviewerModel", "Reviewer Model", "gpt-5.5-thinking", "xhigh", "default", now),
    alias("CheapModel", "Cheap Model", "gpt-5.5", "low", "default", now)
  ];
}

export function readWebModelAliases(): ModelAlias[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(MODEL_ALIAS_STORAGE_KEY) ?? "null") as unknown;
    if (Array.isArray(parsed) && parsed.every(isModelAliasLike)) {
      return parsed as ModelAlias[];
    }
  } catch (_error) {
    return defaultWebModelAliases();
  }
  return defaultWebModelAliases();
}

export function writeWebModelAliases(aliases: ModelAlias[]): void {
  window.localStorage.setItem(MODEL_ALIAS_STORAGE_KEY, JSON.stringify(aliases));
}

function alias(
  aliasId: string,
  displayName: string,
  model: string,
  reasoningEffort: string,
  serviceTier: string,
  now: string
): ModelAlias {
  return {
    aliasId: aliasId as ModelAlias["aliasId"],
    displayName: displayName as ModelAlias["displayName"],
    selection: {
      kind: "direct",
      provider: {
        providerId: "codex",
        model: model as ModelAlias["aliasId"],
        reasoningEffort: reasoningEffort as DirectModelSelection["provider"]["reasoningEffort"],
        serviceTier: serviceTier as DirectModelSelection["provider"]["serviceTier"]
      } as DirectProviderModelSelection
    },
    scope: { kind: "user" },
    createdAt: now,
    updatedAt: now
  };
}

function isModelAliasLike(value: unknown): value is ModelAlias {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<ModelAlias>;
  return typeof candidate.aliasId === "string"
    && typeof candidate.displayName === "string"
    && candidate.selection?.kind === "direct"
    && typeof candidate.selection.provider?.providerId === "string"
    && typeof candidate.selection.provider?.model === "string";
}
