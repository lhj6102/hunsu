import type {
  DirectModelSelection,
  DirectProviderModelSelection,
  ModelAlias,
  ModelAliasOverride,
  ModelSelection,
  ProviderInventory,
  ProviderModelDescriptor,
  ProviderModelInventory,
  ReasoningEffort,
  RuntimeProviderId,
  ServiceTier
} from "@hunsu/protocol";
import { makeNonEmptyText, unwrapDomainModelResult } from "@hunsu/protocol";
import type { RuntimeProviderStatus } from "../runtime-providers/types.ts";
import type { BridgeBackendStatus } from "../connections/localConnection.ts";
import type { ExecutePreflightAction, ProviderAwareExecutePreflightError } from "../executes/executePreflight.ts";

export type ModelAliasValidationErrorCode =
  | "MODEL_ALIAS_NOT_FOUND"
  | "PROVIDER_NOT_READY"
  | "PROVIDER_LOGIN_REQUIRED"
  | "MODEL_UNSUPPORTED"
  | "REASONING_UNSUPPORTED"
  | "SERVICE_TIER_UNSUPPORTED";

export type ModelAliasValidationError = {
  error: ModelAliasValidationErrorCode;
  message: string;
  providerId?: string;
  aliasId?: string;
  model?: string;
  actions: ExecutePreflightAction[];
};

export type ModelSelectionResolution =
  | {
      ok: true;
      backendId: string;
      selection: DirectModelSelection;
      resolved: DirectProviderModelSelection;
      provider: {
        providerId: RuntimeProviderId;
        ready: boolean;
      };
      model: ProviderModelDescriptor | { providerId: RuntimeProviderId; model: string; experimental: true };
    }
  | { ok: false; error: ModelAliasValidationError };

const MODEL_ALIAS_SETTINGS_HREF = "/studio/settings/model-aliases";
const MODEL_ALIAS_DEFAULT_TIMESTAMP = "1970-01-01T00:00:00.000Z";

export const DEFAULT_MODEL_ALIAS_IDS = {
  primary: "PrimaryModel",
  fast: "FastModel",
  reviewer: "ReviewerModel",
  cheap: "CheapModel"
} as const;

export function defaultModelAliases(now = MODEL_ALIAS_DEFAULT_TIMESTAMP): ModelAlias[] {
  return [
    modelAlias(DEFAULT_MODEL_ALIAS_IDS.primary, "Primary Model", {
      kind: "direct",
      provider: { providerId: "codex", model: "gpt-5.5-thinking", reasoningEffort: "high", serviceTier: "default" }
    }, now),
    modelAlias(DEFAULT_MODEL_ALIAS_IDS.fast, "Fast Model", {
      kind: "direct",
      provider: { providerId: "codex", model: "gpt-5.5", reasoningEffort: "medium", serviceTier: "fast" }
    }, now),
    modelAlias(DEFAULT_MODEL_ALIAS_IDS.reviewer, "Reviewer Model", {
      kind: "direct",
      provider: { providerId: "codex", model: "gpt-5.5-thinking", reasoningEffort: "xhigh", serviceTier: "default" }
    }, now),
    modelAlias(DEFAULT_MODEL_ALIAS_IDS.cheap, "Cheap Model", {
      kind: "direct",
      provider: { providerId: "codex", model: "gpt-5.5", reasoningEffort: "low", serviceTier: "default" }
    }, now)
  ];
}

export function providerInventoryForStatus(provider: RuntimeProviderStatus): ProviderModelInventory {
  return {
    providerId: provider.providerId as RuntimeProviderId,
    label: nonEmpty(provider.label, "providerInventory.label"),
    ready: provider.ready,
    authState: provider.auth.state,
    models: provider.providerId === "codex" ? codexModelInventory() : []
  };
}

export function defaultLocalProviderInventory(): ProviderInventory {
  return {
    backendId: nonEmpty("local", "providerInventory.backendId"),
    providers: [{
      providerId: "codex",
      label: nonEmpty("Codex", "providerInventory.label"),
      ready: true,
      authState: "authenticated",
      models: codexModelInventory()
    }]
  };
}

export function defaultLocalProviderModelInventories(): ProviderModelInventory[] {
  return defaultLocalProviderInventory().providers;
}

export function providerInventoryForBridgeStatus(input: {
  provider: RuntimeProviderStatus;
  connections?: BridgeBackendStatus[];
  backendId?: string;
}): ProviderInventory {
  const selectedBackendId = input.backendId?.trim();
  const selectedConnection = selectedBackendId
    ? input.connections?.find(connection => connection.backendId === selectedBackendId)
    : input.connections?.find(connection => connection.mode === "local") ?? input.connections?.[0];
  const backendId = selectedConnection?.backendId ?? selectedBackendId ?? "local";
  const provider = selectedConnection?.provider ?? input.provider;
  return {
    backendId: nonEmpty(backendId, "providerInventory.backendId"),
    providers: [providerInventoryForStatus(provider)]
  };
}

export function providerInventoriesForBridgeStatus(input: {
  provider: RuntimeProviderStatus;
  connections?: BridgeBackendStatus[];
  backendId?: string;
}): ProviderModelInventory[] {
  return providerInventoryForBridgeStatus(input).providers;
}

export function resolveModelSelection(input: {
  selection?: ModelSelection;
  aliases?: ModelAlias[];
  overrides?: ModelAliasOverride[];
  backendId?: string;
  inventories: ProviderModelInventory[];
}): ModelSelectionResolution {
  const selection = input.selection ?? { kind: "alias", aliasId: DEFAULT_MODEL_ALIAS_IDS.primary };
  const aliases = input.aliases === undefined ? defaultModelAliases() : input.aliases;
  if (selection.kind === "direct") {
    return validateDirectModelSelection(selection, input.inventories, input.backendId);
  }
  const alias = aliases.find(candidate => candidate.aliasId === selection.aliasId);
  if (!alias) {
    return { ok: false, error: modelError("MODEL_ALIAS_NOT_FOUND", `Model alias ${selection.aliasId} does not exist.`, {
      aliasId: selection.aliasId,
      actions: [editModelAliasAction()]
    }) };
  }
  const override = input.overrides?.find(candidate =>
    candidate.aliasId === alias.aliasId && candidate.backendId === input.backendId
  );
  return validateDirectModelSelection(override?.selection ?? alias.selection, input.inventories, input.backendId);
}

export function validateDirectModelSelection(
  selection: DirectModelSelection,
  inventories: ProviderModelInventory[],
  backendId = "local"
): ModelSelectionResolution {
  const provider = selection.provider;
  const inventory = inventories.find(candidate => candidate.providerId === provider.providerId);
  if (!inventory) {
    return { ok: false, error: modelError("PROVIDER_NOT_READY", `Provider ${provider.providerId} is not available for model selection.`, {
      providerId: provider.providerId,
      actions: [openProviderSetupAction(provider.providerId)]
    }) };
  }
  if (inventory.authState === "not_authenticated" || inventory.authState === "expired" || inventory.authState === "invalid") {
    return { ok: false, error: modelError("PROVIDER_LOGIN_REQUIRED", `${inventory.label} login is required before this model can run.`, {
      providerId: provider.providerId,
      actions: [loginProviderAction(provider.providerId, inventory.label)]
    }) };
  }
  if (!inventory.ready) {
    return { ok: false, error: modelError("PROVIDER_NOT_READY", `${inventory.label} is not ready for Execute.`, {
      providerId: provider.providerId,
      actions: [openProviderSetupAction(provider.providerId)]
    }) };
  }
  const model = inventory.models.find(candidate => candidate.model === provider.model);
  if (!model) {
    if (provider.experimental === true) {
      return {
        ok: true,
        backendId,
        selection,
        resolved: provider,
        provider: { providerId: provider.providerId, ready: inventory.ready },
        model: { providerId: provider.providerId, model: provider.model, experimental: true }
      };
    }
    return { ok: false, error: modelError("MODEL_UNSUPPORTED", `${inventory.label} does not advertise model ${provider.model}.`, {
      providerId: provider.providerId,
      model: provider.model,
      actions: [editModelAliasAction()]
    }) };
  }
  const reasoningEfforts = model.capabilities.reasoningEfforts ?? [];
  const reasoningEffort = provider.reasoningEffort ?? model.defaultConfig?.reasoningEffort;
  if (reasoningEffort && reasoningEfforts.length > 0 && !reasoningEfforts.includes(reasoningEffort)) {
    return { ok: false, error: modelError("REASONING_UNSUPPORTED", `${model.label} does not support ${reasoningEffort} reasoning.`, {
      providerId: provider.providerId,
      model: provider.model,
      actions: [editModelAliasAction()]
    }) };
  }
  const serviceTiers = model.capabilities.serviceTiers ?? [];
  const serviceTier = provider.serviceTier ?? model.defaultConfig?.serviceTier;
  if (serviceTier && serviceTiers.length > 0 && !serviceTiers.includes(serviceTier)) {
    return { ok: false, error: modelError("SERVICE_TIER_UNSUPPORTED", `${model.label} does not support the ${serviceTier} service tier.`, {
      providerId: provider.providerId,
      model: provider.model,
      actions: [editModelAliasAction()]
    }) };
  }
  return {
    ok: true,
    backendId,
    selection,
    resolved: provider,
    provider: { providerId: provider.providerId, ready: inventory.ready },
    model
  };
}

export function executePreflightErrorFromModelError(error: ModelAliasValidationError): ProviderAwareExecutePreflightError {
  return {
    area: "model",
    providerId: error.providerId,
    aliasId: error.aliasId,
    model: error.model,
    error: error.error,
    message: error.message,
    actions: error.actions
  };
}

export function codexRunnerThreadOptionsForModelSelection(provider: DirectProviderModelSelection): {
  model?: string;
  modelReasoningEffort?: string;
  serviceTier?: ServiceTier;
} {
  return {
    model: provider.model === "codex-default" ? undefined : provider.model,
    modelReasoningEffort: provider.reasoningEffort && provider.reasoningEffort !== "default" ? provider.reasoningEffort : undefined,
    serviceTier: provider.serviceTier ?? "default"
  };
}

function codexModelInventory(): ProviderModelDescriptor[] {
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

function modelAlias(aliasId: string, displayName: string, selection: DirectModelSelection, now: string): ModelAlias {
  return {
    aliasId: nonEmpty(aliasId, "modelAlias.aliasId"),
    displayName: nonEmpty(displayName, "modelAlias.displayName"),
    selection,
    scope: { kind: "user" },
    createdAt: now,
    updatedAt: now
  };
}

function modelError(code: ModelAliasValidationErrorCode, message: string, details: {
  providerId?: string;
  aliasId?: string;
  model?: string;
  actions: ExecutePreflightAction[];
}): ModelAliasValidationError {
  return { error: code, message, ...details };
}

function openProviderSetupAction(providerId: string): ExecutePreflightAction {
  return { type: "open_provider_setup", label: "Open Provider Setup", href: `hunsu://provider/${providerId}`, providerId };
}

function loginProviderAction(providerId: string, label: string): ExecutePreflightAction {
  return { type: "login_provider", label: `Sign in to ${label}`, href: `hunsu://provider/${providerId}`, providerId };
}

function editModelAliasAction(): ExecutePreflightAction {
  return { type: "edit_model_alias", label: "Edit Model Alias", href: MODEL_ALIAS_SETTINGS_HREF };
}

function nonEmpty(value: string, path: string) {
  return unwrapDomainModelResult(makeNonEmptyText(value, path));
}
