import type {
  DirectModelSelection,
  DirectProviderModelSelection,
  ModelAlias,
  ModelAliasOverride,
  ModelSelection,
  ProviderInventory,
  ProviderInventoryError,
  ProviderInventoryResult,
  ProviderModelDescriptor,
  ProviderModelInventory,
  Result,
  RuntimeProviderId,
  ServiceTier
} from "@hunsu/protocol";
import { err, makeNonEmptyText, ok, unwrapDomainModelResult } from "@hunsu/protocol";
import type { RuntimeProviderStatus } from "../runtime-providers/types.ts";
import type { BridgeBackendStatus } from "../connections/localConnection.ts";
import type { ExecutePreflightAction, ProviderAwareExecutePreflightError } from "../executes/executePreflight.ts";
import { codexProviderModelInventory } from "../runtime-providers/codex/codexModelInventory.ts";

export type ModelAliasValidationErrorCode =
  | "BACKEND_UNAVAILABLE"
  | "MODEL_ALIAS_NOT_FOUND"
  | "PROVIDER_INVENTORY_UNAVAILABLE"
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
  | { ok: false; backendId: string; error: ModelAliasValidationError };

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

export function providerInventoryForStatus(
  provider: RuntimeProviderStatus,
  backendId = "local"
): Result<ProviderModelInventory, ProviderInventoryError> {
  const selectedBackendId = nonEmpty(backendId.trim() || "local", "providerInventory.backendId");
  if (provider.modelInventory.state === "unavailable") {
    return err({
      code: "PROVIDER_INVENTORY_UNAVAILABLE",
      backendId: selectedBackendId,
      providerId: provider.providerId,
      message: provider.modelInventory.message
    });
  }
  return ok({
    providerId: provider.providerId as RuntimeProviderId,
    label: nonEmpty(provider.label, "providerInventory.label"),
    ready: provider.ready,
    authState: provider.auth.state,
    models: provider.modelInventory.models
  });
}

export function defaultLocalProviderInventory(): ProviderInventory {
  return {
    backendId: nonEmpty("local", "providerInventory.backendId"),
    providers: [{
      providerId: "codex",
      label: nonEmpty("Codex", "providerInventory.label"),
      ready: true,
      authState: "authenticated",
      models: codexProviderModelInventory()
    }]
  };
}

export function providerInventoryForBridgeStatus(input: {
  provider?: RuntimeProviderStatus;
  connections?: BridgeBackendStatus[];
  backendId?: string;
}): ProviderInventoryResult {
  const selectedBackendId = input.backendId?.trim();
  const selectedConnection = selectedBackendId
    ? input.connections?.find(connection => connection.backendId === selectedBackendId)
    : input.connections?.find(connection => connection.mode === "local");
  if (selectedBackendId && !selectedConnection) {
    return providerInventoryBackendUnavailable(selectedBackendId);
  }
  const backendId = selectedConnection?.backendId ?? "local";
  const provider = selectedConnection?.provider ?? input.provider;
  if (!provider) {
    return providerInventoryBackendUnavailable(backendId);
  }
  const providerInventory = providerInventoryForStatus(provider, backendId);
  if (!providerInventory.ok) {
    return providerInventory;
  }
  return ok({
    backendId: nonEmpty(backendId, "providerInventory.backendId"),
    providers: [providerInventory.value]
  });
}

export function providerInventoryBackendUnavailable(
  backendId: string,
  message = `Backend ${backendId.trim() || "local"} is not available on this Bridge.`
): ProviderInventoryResult {
  return err({
    code: "BACKEND_UNAVAILABLE",
    backendId: nonEmpty(backendId.trim() || "local", "providerInventory.backendId"),
    message
  });
}

export function providerInventoryUnavailable(
  backendId: string,
  providerId: string,
  message: string
): ProviderInventoryResult {
  return err({
    code: "PROVIDER_INVENTORY_UNAVAILABLE",
    backendId: nonEmpty(backendId.trim() || "local", "providerInventory.backendId"),
    providerId,
    message
  });
}

export function resolveModelSelection(input: {
  selection?: ModelSelection;
  aliases?: ModelAlias[];
  overrides?: ModelAliasOverride[];
  backendId?: string;
  inventories: ProviderModelInventory[];
}): ModelSelectionResolution {
  const backendId = input.backendId?.trim() || "local";
  const selection = input.selection ?? { kind: "alias", aliasId: DEFAULT_MODEL_ALIAS_IDS.primary };
  const aliases = input.aliases === undefined ? defaultModelAliases() : input.aliases;
  if (selection.kind === "direct") {
    return validateDirectModelSelection(selection, input.inventories, backendId);
  }
  const alias = aliases.find(candidate => candidate.aliasId === selection.aliasId);
  if (!alias) {
    return { ok: false, backendId, error: modelError("MODEL_ALIAS_NOT_FOUND", `Model alias ${selection.aliasId} does not exist.`, {
      aliasId: selection.aliasId,
      actions: [editModelAliasAction()]
    }) };
  }
  const override = input.overrides?.find(candidate =>
    candidate.aliasId === alias.aliasId && candidate.backendId === backendId
  );
  return validateDirectModelSelection(override?.selection ?? alias.selection, input.inventories, backendId);
}

export function validateDirectModelSelection(
  selection: DirectModelSelection,
  inventories: ProviderModelInventory[],
  backendId = "local"
): ModelSelectionResolution {
  const selectedBackendId = backendId.trim() || "local";
  const provider = selection.provider;
  const inventory = inventories.find(candidate => candidate.providerId === provider.providerId);
  if (!inventory) {
    return { ok: false, backendId: selectedBackendId, error: modelError("PROVIDER_NOT_READY", `Provider ${provider.providerId} is not available for model selection.`, {
      providerId: provider.providerId,
      actions: [openProviderSetupAction(provider.providerId)]
    }) };
  }
  if (inventory.authState === "not_authenticated" || inventory.authState === "expired" || inventory.authState === "invalid") {
    return { ok: false, backendId: selectedBackendId, error: modelError("PROVIDER_LOGIN_REQUIRED", `${inventory.label} login is required before this model can run.`, {
      providerId: provider.providerId,
      actions: [loginProviderAction(provider.providerId, inventory.label)]
    }) };
  }
  if (!inventory.ready) {
    return { ok: false, backendId: selectedBackendId, error: modelError("PROVIDER_NOT_READY", `${inventory.label} is not ready for Execute.`, {
      providerId: provider.providerId,
      actions: [openProviderSetupAction(provider.providerId)]
    }) };
  }
  const model = inventory.models.find(candidate => candidate.model === provider.model);
  if (!model) {
    if (provider.experimental === true) {
      return {
        ok: true,
        backendId: selectedBackendId,
        selection,
        resolved: provider,
        provider: { providerId: provider.providerId, ready: inventory.ready },
        model: { providerId: provider.providerId, model: provider.model, experimental: true }
      };
    }
    return { ok: false, backendId: selectedBackendId, error: modelError("MODEL_UNSUPPORTED", `${inventory.label} does not advertise model ${provider.model}.`, {
      providerId: provider.providerId,
      model: provider.model,
      actions: [editModelAliasAction()]
    }) };
  }
  const reasoningEfforts = model.capabilities.reasoningEfforts ?? [];
  const reasoningEffort = provider.reasoningEffort ?? model.defaultConfig?.reasoningEffort;
  if (reasoningEffort && reasoningEfforts.length > 0 && !reasoningEfforts.includes(reasoningEffort)) {
    return { ok: false, backendId: selectedBackendId, error: modelError("REASONING_UNSUPPORTED", `${model.label} does not support ${reasoningEffort} reasoning.`, {
      providerId: provider.providerId,
      model: provider.model,
      actions: [editModelAliasAction()]
    }) };
  }
  const serviceTiers = model.capabilities.serviceTiers ?? [];
  const serviceTier = provider.serviceTier ?? model.defaultConfig?.serviceTier;
  if (serviceTier && serviceTiers.length > 0 && !serviceTiers.includes(serviceTier)) {
    return { ok: false, backendId: selectedBackendId, error: modelError("SERVICE_TIER_UNSUPPORTED", `${model.label} does not support the ${serviceTier} service tier.`, {
      providerId: provider.providerId,
      model: provider.model,
      actions: [editModelAliasAction()]
    }) };
  }
  return {
    ok: true,
    backendId: selectedBackendId,
    selection,
    resolved: provider,
    provider: { providerId: provider.providerId, ready: inventory.ready },
    model
  };
}

export function modelSelectionResolutionFromInventoryError(
  error: ProviderInventoryError
): Extract<ModelSelectionResolution, { ok: false }> {
  return {
    ok: false,
    backendId: error.backendId,
    error: error.code === "BACKEND_UNAVAILABLE"
      ? modelError(error.code, error.message, {
          actions: [openConnectionAction(error.backendId)]
        })
      : modelError(error.code, error.message, {
          providerId: error.providerId,
          actions: [recheckProviderAction(error.providerId)]
        })
  };
}

export function executePreflightErrorFromModelError(
  error: ModelAliasValidationError,
  backendId: string
): ProviderAwareExecutePreflightError {
  if (error.error === "BACKEND_UNAVAILABLE") {
    const remote = backendId.startsWith("remote:") || backendId === "remote";
    return {
      area: "connection",
      backendId,
      error: remote ? "REMOTE_NOT_CONNECTED" : "BRIDGE_NOT_CONNECTED",
      message: error.message,
      actions: error.actions
    };
  }
  return {
    area: "model",
    backendId,
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

function recheckProviderAction(providerId: string): ExecutePreflightAction {
  return { type: "recheck_provider", label: "Recheck Provider", href: `hunsu://provider/${providerId}`, providerId };
}

function openConnectionAction(backendId: string): ExecutePreflightAction {
  const remote = backendId.startsWith("remote:") || backendId === "remote";
  return { type: "open_connection", label: "Open Connection", href: remote ? "hunsu://connection/remote" : "hunsu://connection" };
}

function editModelAliasAction(): ExecutePreflightAction {
  return { type: "edit_model_alias", label: "Edit Model Alias", href: MODEL_ALIAS_SETTINGS_HREF };
}

function nonEmpty(value: string, path: string) {
  return unwrapDomainModelResult(makeNonEmptyText(value, path));
}
