import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { fetchModelInventory, validateModelAliases } from "@/shared/api/bridgeClient";
import type { DirectProviderModelSelection, ModelAlias, ModelSelection, ProviderInventory } from "@/shared/api/bridgeTypes";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Label } from "@/shared/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select";
import {
  assignWebModelConfigDraft,
  readWebModelConfigDraft,
  writeWebModelConfigDraft,
  type WebModelConfigDraft,
  type WebModelConfigTarget
} from "./modelConfigDraftStorage.js";
import { defaultWebModelAliases, readWebModelAliases, writeWebModelAliases } from "./modelAliasStorage.js";

export function ModelAliasSettings() {
  const [aliases, setAliases] = useState<ModelAlias[]>(() => readWebModelAliases());
  const [configDraft, setConfigDraft] = useState<WebModelConfigDraft>(() => readWebModelConfigDraft());
  const [selectedAliasId, setSelectedAliasId] = useState<string>(() => aliases[0]?.aliasId ?? "PrimaryModel");
  const [selectedConfigTarget, setSelectedConfigTarget] = useState<WebModelConfigTarget>("manager");
  const [inventory, setInventory] = useState<ProviderInventory | undefined>();
  const [status, setStatus] = useState<"idle" | "loading" | "saving" | "saved" | "error">("idle");
  const [message, setMessage] = useState<string | undefined>();
  const selectedAlias = useMemo(
    () => aliases.find(alias => alias.aliasId === selectedAliasId) ?? aliases[0],
    [aliases, selectedAliasId]
  );
  const codexInventory = inventory?.providers.find(provider => provider.providerId === "codex");
  const selectedProvider = selectedAlias?.selection.provider;
  const selectedModel = codexInventory?.models.find(model => model.model === selectedProvider?.model);
  const reasoningOptions = optionSet(selectedModel?.capabilities.reasoningEfforts, selectedProvider?.reasoningEffort);
  const serviceTierOptions = optionSet(selectedModel?.capabilities.serviceTiers, selectedProvider?.serviceTier);
  const selectedConfigSelection = modelSelectionForConfigTarget(configDraft, selectedConfigTarget);
  const selectedConfigMode = selectedConfigSelection?.kind === "alias" ? "alias" : "direct";
  const selectedConfigAliasId = selectedConfigSelection?.kind === "alias" ? selectedConfigSelection.aliasId : aliases[0]?.aliasId ?? "PrimaryModel";
  const configDirectProvider = directProviderFromSelection(
    selectedConfigSelection,
    aliases,
    codexInventory?.models[0]?.defaultConfig ?? selectedProvider
  );
  const configDirectModel = codexInventory?.models.find(model => model.model === configDirectProvider.model);
  const configReasoningOptions = optionSet(configDirectModel?.capabilities.reasoningEfforts, configDirectProvider.reasoningEffort);
  const configServiceTierOptions = optionSet(configDirectModel?.capabilities.serviceTiers, configDirectProvider.serviceTier);

  useEffect(() => {
    void refreshInventory();
  }, []);

  async function refreshInventory() {
    setStatus("loading");
    try {
      const result = await fetchModelInventory();
      setInventory(result);
      setAliases(current => current.length ? current : defaultWebModelAliases(new Date().toISOString()));
      setStatus("idle");
      setMessage(undefined);
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Could not load provider inventory.");
    }
  }

  function updateSelected(update: Partial<{ displayName: string; model: string; reasoningEffort: string; serviceTier: string }>) {
    if (!selectedAlias) return;
    const now = new Date().toISOString();
    const nextModel = update.model !== undefined
      ? codexInventory?.models.find(model => model.model === update.model)
      : undefined;
    const defaultProvider = nextModel?.defaultConfig;
    setAliases(current => current.map(alias => alias.aliasId === selectedAlias.aliasId
      ? {
          ...alias,
          displayName: update.displayName !== undefined ? update.displayName as ModelAlias["displayName"] : alias.displayName,
          updatedAt: now,
          selection: {
            kind: "direct",
            provider: {
              ...alias.selection.provider,
              model: update.model !== undefined ? update.model as ModelAlias["aliasId"] : alias.selection.provider.model as ModelAlias["aliasId"],
              reasoningEffort: (update.reasoningEffort ?? defaultProvider?.reasoningEffort ?? alias.selection.provider.reasoningEffort) as ModelAlias["selection"]["provider"]["reasoningEffort"],
              serviceTier: (update.serviceTier ?? defaultProvider?.serviceTier ?? alias.selection.provider.serviceTier) as ModelAlias["selection"]["provider"]["serviceTier"]
            } as DirectProviderModelSelection
          }
        }
      : alias));
  }

  function createAlias() {
    const now = new Date().toISOString();
    const aliasId = uniqueAliasId(aliases);
    const provider = defaultDirectProvider(codexInventory?.models[0]?.defaultConfig ?? selectedProvider);
    const next: ModelAlias = {
      aliasId: aliasId as ModelAlias["aliasId"],
      displayName: aliasId as ModelAlias["displayName"],
      selection: { kind: "direct", provider },
      scope: { kind: "user" },
      createdAt: now,
      updatedAt: now
    };
    setAliases(current => [...current, next]);
    setSelectedAliasId(aliasId);
    setMessage(`${aliasId} created.`);
    setStatus("idle");
  }

  function deleteSelectedAlias() {
    if (!selectedAlias) return;
    const nextAliases = aliases.filter(alias => alias.aliasId !== selectedAlias.aliasId);
    setAliases(nextAliases);
    setSelectedAliasId(nextAliases[0]?.aliasId ?? "");
    setMessage(`${selectedAlias.displayName} deleted.`);
    setStatus("idle");
  }

  function assignConfigAlias(aliasId: string) {
    setConfigDraft(current => assignWebModelConfigDraft(current, selectedConfigTarget, { mode: "alias", aliasId }));
    setStatus("idle");
    setMessage(`${targetLabel(selectedConfigTarget)} config draft updated.`);
  }

  function assignConfigDirect(provider: DirectProviderModelSelection) {
    setConfigDraft(current => assignWebModelConfigDraft(current, selectedConfigTarget, { mode: "direct", provider }));
    setStatus("idle");
    setMessage(`${targetLabel(selectedConfigTarget)} config draft updated.`);
  }

  function selectConfigDirectModel(modelName: string) {
    const descriptor = codexInventory?.models.find(model => model.model === modelName);
    assignConfigDirect(defaultDirectProvider({
      ...configDirectProvider,
      ...(descriptor?.defaultConfig ?? {}),
      providerId: "codex",
      model: modelName as DirectProviderModelSelection["model"]
    } as DirectProviderModelSelection));
  }

  async function saveSettings() {
    setStatus("saving");
    if (selectedAlias) {
      const result = await validateModelAliases({
        backendId: inventory?.backendId ?? "local",
        modelSelection: { kind: "alias", aliasId: selectedAliasId as ModelAlias["aliasId"] },
        aliases
      });
      if (!result.ok) {
        setStatus("error");
        setMessage(result.message);
        return;
      }
    }
    writeWebModelAliases(aliases);
    writeWebModelConfigDraft(configDraft);
    setStatus("saved");
    setMessage("Model aliases and Web config draft saved.");
  }

  function resetAliases() {
    const next = defaultWebModelAliases(new Date().toISOString());
    setAliases(next);
    setSelectedAliasId(next[0]?.aliasId ?? "PrimaryModel");
    setMessage("Default aliases restored.");
    setStatus("idle");
  }

  return (
    <main className="min-h-screen overflow-auto bg-[color:var(--studio-canvas-tint)] px-6 py-8 text-foreground">
      <div className="mx-auto grid w-full max-w-5xl gap-6">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-normal text-[color:var(--apple-ink)]">Model Aliases</h1>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">Configure the named models Web sends to Bridge before Execute starts.</p>
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={refreshInventory} disabled={status === "loading"}>
              <RefreshCw className={status === "loading" ? "animate-spin" : ""} />
              Refresh
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={createAlias}>
              <Plus />
              Create
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={deleteSelectedAlias} disabled={!selectedAlias}>
              <Trash2 />
              Delete
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={resetAliases}>Reset</Button>
            <Button type="button" size="sm" onClick={saveSettings} disabled={status === "saving"}>
              <CheckCircle2 />
              Save
            </Button>
          </div>
        </header>

        <section className="grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
          <div className="grid content-start gap-2">
            {aliases.map(alias => (
              <Button
                key={alias.aliasId}
                type="button"
                variant={alias.aliasId === selectedAliasId ? "default" : "outline"}
                className="justify-start"
                onClick={() => setSelectedAliasId(alias.aliasId)}
              >
                {alias.displayName}
              </Button>
            ))}
          </div>

          <div className="apple-glass grid gap-5 rounded-[14px] p-5">
            {selectedAlias && selectedProvider ? (
              <>
                <div className="grid gap-2">
                  <Label htmlFor="model-alias-name">Alias Name</Label>
                  <Input
                    id="model-alias-name"
                    value={selectedAlias.displayName}
                    onChange={event => updateSelected({ displayName: event.target.value })}
                  />
                </div>
                <div className="grid gap-2 sm:grid-cols-3">
                  <div className="grid gap-2">
                    <Label>Model</Label>
                    <Select value={selectedProvider.model} onValueChange={model => updateSelected({ model })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {(codexInventory?.models ?? []).map(model => (
                          <SelectItem key={model.model} value={model.model}>{model.label}</SelectItem>
                        ))}
                        {!codexInventory?.models.some(model => model.model === selectedProvider.model) ? (
                          <SelectItem value={selectedProvider.model}>{selectedProvider.model}</SelectItem>
                        ) : null}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-2">
                    <Label>Reasoning</Label>
                    <Select value={selectedProvider.reasoningEffort ?? "default"} onValueChange={reasoningEffort => updateSelected({ reasoningEffort })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {reasoningOptions.map(value => <SelectItem key={value} value={value}>{value}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-2">
                    <Label>Service Tier</Label>
                    <Select value={selectedProvider.serviceTier ?? "default"} onValueChange={serviceTier => updateSelected({ serviceTier })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {serviceTierOptions.map(value => <SelectItem key={value} value={value}>{value}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="rounded-md border bg-white/46 px-3 py-2 text-xs leading-5 text-muted-foreground">
                  Provider: {codexInventory?.label ?? "Codex"} · {codexInventory?.ready ? "ready" : "not ready"}
                </div>
              </>
            ) : null}
          </div>
        </section>

        <section className="apple-glass grid gap-5 rounded-[14px] p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold tracking-normal text-[color:var(--apple-ink)]">Web Config Draft</h2>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">Saved locally for Manager, Member, and Executor model configuration.</p>
            </div>
            <div className="rounded-md border bg-white/46 px-3 py-2 text-xs leading-5 text-muted-foreground">
              Updated {new Date(configDraft.updatedAt).toLocaleString()}
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
            <div className="grid content-start gap-2">
              {(["manager", "member", "executor"] as const).map(target => (
                <Button
                  key={target}
                  type="button"
                  variant={selectedConfigTarget === target ? "default" : "outline"}
                  className="justify-start"
                  onClick={() => setSelectedConfigTarget(target)}
                >
                  {targetLabel(target)}
                </Button>
              ))}
            </div>

            <div className="grid gap-4">
              <div className="grid gap-2 sm:grid-cols-2">
                <Button
                  type="button"
                  size="sm"
                  variant={selectedConfigMode === "alias" ? "default" : "outline"}
                  onClick={() => assignConfigAlias(selectedConfigAliasId)}
                >
                  Use alias
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={selectedConfigMode === "direct" ? "default" : "outline"}
                  onClick={() => assignConfigDirect(configDirectProvider)}
                >
                  Direct provider
                </Button>
              </div>

              {selectedConfigMode === "alias" ? (
                <div className="grid gap-2">
                  <Label>Alias</Label>
                  <Select value={selectedConfigAliasId} onValueChange={assignConfigAlias}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {aliases.map(alias => (
                        <SelectItem key={alias.aliasId} value={alias.aliasId}>{alias.displayName}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                <div className="grid gap-2 sm:grid-cols-3">
                  <div className="grid gap-2">
                    <Label>Model</Label>
                    <Select value={configDirectProvider.model} onValueChange={selectConfigDirectModel}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {(codexInventory?.models ?? []).map(model => (
                          <SelectItem key={model.model} value={model.model}>{model.label}</SelectItem>
                        ))}
                        {!codexInventory?.models.some(model => model.model === configDirectProvider.model) ? (
                          <SelectItem value={configDirectProvider.model}>{configDirectProvider.model}</SelectItem>
                        ) : null}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-2">
                    <Label>Reasoning</Label>
                    <Select
                      value={configDirectProvider.reasoningEffort ?? "default"}
                      onValueChange={reasoningEffort => assignConfigDirect({
                        ...configDirectProvider,
                        reasoningEffort: reasoningEffort as DirectProviderModelSelection["reasoningEffort"]
                      } as DirectProviderModelSelection)}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {configReasoningOptions.map(value => <SelectItem key={value} value={value}>{value}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-2">
                    <Label>Service Tier</Label>
                    <Select
                      value={configDirectProvider.serviceTier ?? "default"}
                      onValueChange={serviceTier => assignConfigDirect({
                        ...configDirectProvider,
                        serviceTier: serviceTier as DirectProviderModelSelection["serviceTier"]
                      } as DirectProviderModelSelection)}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {configServiceTierOptions.map(value => <SelectItem key={value} value={value}>{value}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}

              <div className="grid gap-2 rounded-md border bg-white/46 px-3 py-2 text-xs leading-5 text-muted-foreground">
                <div className="font-semibold text-[color:var(--apple-ink)]">{targetLabel(selectedConfigTarget)} config</div>
                <div>{modelSelectionSummary(selectedConfigSelection)}</div>
              </div>
            </div>
          </div>
        </section>

        {message ? (
          <div className={`rounded-md px-3 py-2 text-sm ${status === "error" ? "bg-destructive/10 text-destructive" : "bg-white/56 text-muted-foreground"}`}>
            {message}
          </div>
        ) : null}
      </div>
    </main>
  );
}

function optionSet(values: string[] | undefined, selected: string | undefined): string[] {
  return [...new Set([...(values ?? []), selected].filter((value): value is string => Boolean(value)))];
}

function uniqueAliasId(aliases: ModelAlias[]): string {
  const used = new Set(aliases.map(alias => alias.aliasId));
  for (let index = 1; index < 1000; index += 1) {
    const candidate = `CustomModel${index}`;
    if (!used.has(candidate as ModelAlias["aliasId"])) {
      return candidate;
    }
  }
  return `CustomModel${Date.now()}`;
}

function defaultDirectProvider(provider: DirectProviderModelSelection | undefined): DirectProviderModelSelection {
  return provider ?? {
    providerId: "codex",
    model: "codex-default",
    reasoningEffort: "default",
    serviceTier: "default",
    experimental: true
  } as DirectProviderModelSelection;
}

function modelSelectionForConfigTarget(draft: WebModelConfigDraft, target: WebModelConfigTarget): ModelSelection | undefined {
  if (target === "manager") {
    return draft.manager.modelSelection;
  }
  if (target === "member") {
    return draft.member.modelSelection;
  }
  return draft.executor.runtimePolicy.modelSelection;
}

function directProviderFromSelection(
  selection: ModelSelection | undefined,
  aliases: ModelAlias[],
  fallback: DirectProviderModelSelection | undefined
): DirectProviderModelSelection {
  if (selection?.kind === "direct") {
    return defaultDirectProvider(selection.provider);
  }
  if (selection?.kind === "alias") {
    return defaultDirectProvider(aliases.find(alias => alias.aliasId === selection.aliasId)?.selection.provider ?? fallback);
  }
  return defaultDirectProvider(fallback);
}

function modelSelectionSummary(selection: ModelSelection | undefined): string {
  if (!selection) {
    return "No modelSelection assigned.";
  }
  if (selection.kind === "alias") {
    return `Alias: ${selection.aliasId}`;
  }
  const provider = selection.provider;
  return `Direct: ${provider.providerId} / ${provider.model} / ${provider.reasoningEffort ?? "default"} / ${provider.serviceTier ?? "default"}`;
}

function targetLabel(target: WebModelConfigTarget): string {
  if (target === "manager") {
    return "Manager";
  }
  if (target === "member") {
    return "Member";
  }
  return "Executor";
}
