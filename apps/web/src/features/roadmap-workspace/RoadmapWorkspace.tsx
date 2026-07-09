import { useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Settings2 } from "lucide-react";
import { pushStudioPath } from "@/app/routes";
import { BridgeRequestError, fetchHunsuDraftDiffArtifact, fetchModelInventory, postArtifactActionRun, postHunsuDraftApprove, postHunsuDraftDiscard, postHunsuDraftMessage, postHunsuDraftStart, postRunAction } from "@/shared/api/bridgeClient";
import type { DirectProviderModelSelection, ExecutePreflightAction, ExecutePreflightError, ModelAlias, ModelSelection, ProviderInventory, StudioHunsuDraftDiffArtifact, StudioHunsuDraftSession } from "@/shared/api/bridgeTypes";
import { useRoadmapWorkspace } from "@/shared/api/useStudioData";
import { Button } from "@/shared/ui/button";
import type { RoadmapActionModel, RoadmapDetailPanel, RoadmapSelection } from "@/shared/domain/roadmapViewModel";
import { NodeDetailPanel } from "@/features/inspector/NodeDetailPanel";
import { RoadmapGraph } from "@/features/roadmap-graph/RoadmapGraph";
import { bridgeActionHref } from "./preflightActions.js";
import { readWebModelAliases } from "@/features/model-aliases/modelAliasStorage";

type ExecuteActionState = {
  status: "idle" | "starting" | "started" | "error";
  message?: string;
  preflight?: ExecutePreflightError;
};

type HunsuDraftActionState = {
  status: "idle" | "starting" | "sending" | "approving" | "discarding" | "error";
  message?: string;
};

type ArtifactActionState = {
  status: "idle" | "starting" | "started" | "error";
  actionId?: string;
  message?: string;
};

export function RoadmapWorkspace({ roadmapId }: { roadmapId: string }) {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const [selection, setSelection] = useState<RoadmapSelection | undefined>(() => selectionFromQuery(params));
  const [activePanel, setActivePanel] = useState<RoadmapDetailPanel>(panelFromQuery(params.get("panel")));
  const [expandedConnections, setExpandedConnections] = useState<string[]>(() => expandedConnectionsFromQuery(params));
  const [executeAction, setExecuteAction] = useState<ExecuteActionState>({ status: "idle" });
  const [modelPanelOpen, setModelPanelOpen] = useState(false);
  const [modelAliases, setModelAliases] = useState<ModelAlias[]>(() => readWebModelAliases());
  const [executeModelMode, setExecuteModelMode] = useState<"alias" | "direct">(() => modelAliases.length ? "alias" : "direct");
  const [executeAliasId, setExecuteAliasId] = useState<string>(() => modelAliases[0]?.aliasId ?? "PrimaryModel");
  const [modelInventory, setModelInventory] = useState<ProviderInventory | undefined>();
  const [directProvider, setDirectProvider] = useState<DirectProviderModelSelection>(() => directProviderFromAlias(modelAliases[0]));
  const [artifactAction, setArtifactAction] = useState<ArtifactActionState>({ status: "idle" });
  const [hunsuDraft, setHunsuDraft] = useState<StudioHunsuDraftSession | undefined>();
  const [hunsuDraftDiffArtifacts, setHunsuDraftDiffArtifacts] = useState<Record<string, StudioHunsuDraftDiffArtifact>>({});
  const [hunsuDraftAction, setHunsuDraftAction] = useState<HunsuDraftActionState>({ status: "idle" });
  const { model, refresh } = useRoadmapWorkspace(roadmapId, selection, activePanel, { expandedConnectionIds: expandedConnections });
  const executeBusy = executeAction.status === "starting";
  const artifactActionBusy = artifactAction.status === "starting";
  const hunsuDraftBusy = hunsuDraftAction.status === "starting"
    || hunsuDraftAction.status === "sending"
    || hunsuDraftAction.status === "approving"
    || hunsuDraftAction.status === "discarding";
  const inspectorNodeId = model.inspector && "node" in model.inspector ? model.inspector.node.id : undefined;
  const inspectorExecuteActions = inspectorNodeId
    ? model.graph.playableMoves.filter(item => item.nodeId === inspectorNodeId)
    : [];
  const inspectorHunsuDraft = model.inspector?.kind === "hunsuDraftRoute" ? model.inspector.draft : undefined;
  const selectedHunsuDraft = selectCurrentHunsuDraft(hunsuDraft, inspectorHunsuDraft);
  const subtitle = model.repositoryPath ?? model.worktree?.root ?? `/studio/roadmaps/${model.roadmapId}`;
  const selectedInspector = selection !== undefined && selection.kind !== "none" ? model.inspector : undefined;
  const codexInventory = modelInventory?.providers.find(provider => provider.providerId === "codex");
  const directModel = codexInventory?.models.find(item => item.model === directProvider.model);
  const directReasoningOptions = optionSet(directModel?.capabilities.reasoningEfforts, directProvider.reasoningEffort);
  const directServiceTierOptions = optionSet(directModel?.capabilities.serviceTiers, directProvider.serviceTier);
  const hunsuDraftMessageMutation = useMutation({
    mutationFn: ({ draft, message }: { draft: StudioHunsuDraftSession; message: string }) =>
      postHunsuDraftMessage(roadmapId, draft.draftSessionId, message),
    onMutate: ({ draft, message }) => {
      const previousDraft = hunsuDraft;
      setHunsuDraftAction({ status: "sending" });
      setHunsuDraft(optimisticHunsuDraftForMessage(draft, message));
      return { previousDraft };
    },
    onSuccess: result => {
      setHunsuDraft(result.draft);
      mergeHunsuDraftDiffArtifacts(result.draft.diffArtifacts);
      setHunsuDraftAction({ status: "idle" });
      refresh();
    },
    onError: (nextError, _variables, context) => {
      setHunsuDraft(context?.previousDraft);
      setHunsuDraftAction({ status: "error", message: errorMessage(nextError, "HUNSU Draft message failed.") });
    }
  });

  useEffect(() => {
    let cancelled = false;
    fetchModelInventory()
      .then(result => {
        if (cancelled) return;
        setModelInventory(result);
        setDirectProvider(current => {
          const models = result.providers.find(provider => provider.providerId === "codex")?.models ?? [];
          return models.some(item => item.model === current.model)
            ? current
            : defaultDirectProvider(models[0]?.defaultConfig ?? current);
        });
      })
      .catch(() => {
        if (!cancelled) {
          setModelInventory(undefined);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function select(nextSelection: RoadmapSelection) {
    setSelection(nextSelection);
    const next = new URLSearchParams(window.location.search);
    writeSelectionQuery(next, nextSelection);
    const nextExpandedConnections = nextSelection.kind === "execute" || nextSelection.kind === "pathPoint"
      ? [nextSelection.executeId]
      : nextSelection.kind === "none"
        ? []
        : expandedConnections;
    setExpandedConnections(nextExpandedConnections);
    writeConnectionQuery(next, nextExpandedConnections);
    const nextPanel = panelForSelection(nextSelection, activePanel);
    setActivePanel(nextPanel);
    next.set("panel", nextPanel);
    next.delete("scenario");
    window.history.replaceState({}, "", `${window.location.pathname}?${next}`);
  }

  function selectMoveNode(nodeId: string, panel: RoadmapDetailPanel = "move") {
    const nextSelection: RoadmapSelection = { kind: "move", nodeId };
    setSelection(nextSelection);
    setActivePanel(panel);
    const next = new URLSearchParams(window.location.search);
    writeSelectionQuery(next, nextSelection);
    writeConnectionQuery(next, expandedConnections);
    next.set("panel", panel);
    next.delete("scenario");
    window.history.replaceState({}, "", `${window.location.pathname}?${next}`);
  }

  function toggleConnection(displayId: string) {
    const connection = model.graph.connections.find(item => item.display.displayId === displayId);
    if (!connection || !connection.display.canToggle) return;
    const key = connection.display.executeId ?? connection.display.displayId;
    const expanded = connection.display.connectDisplayType !== "Expand";
    const nextExpandedConnections = expanded ? [key] : expandedConnections.filter(item => item !== key);
    setExpandedConnections(nextExpandedConnections);
    const next = new URLSearchParams(window.location.search);
    writeConnectionQuery(next, nextExpandedConnections);
    if (!expanded && connection.display.executeId && selectionMatchesExecute(selection, connection.display.executeId)) {
      setSelection({ kind: "none" });
      writeSelectionQuery(next, { kind: "none" });
    }
    window.history.replaceState({}, "", `${window.location.pathname}?${next}`);
  }

  async function startExecute(action: RoadmapActionModel = model.actions) {
    if (!action.canStartExecute || !action.requestId || !action.lineId || executeBusy) {
      setExecuteAction({ status: "error", message: action.disabledReason ?? "Execute cannot start from the selected MOVE." });
      return;
    }
    if (action.destinationIds.length !== 1) {
      setExecuteAction({ status: "error", message: "Execute must select exactly one Destination." });
      return;
    }

    setExecuteAction({ status: "starting", message: "Starting Execute from the selected MOVE..." });
    try {
      await postRunAction(roadmapId, "start", {
        requestId: action.requestId,
        lineId: action.lineId,
        selectedDestinationIds: action.destinationIds,
        ...executeModelSelectionPayload({
          mode: executeModelMode,
          aliasId: executeAliasId,
          directProvider,
          aliases: readWebModelAliases()
        })
      });
      setExecuteAction({ status: "started", message: "Execute started. Waiting for live run events." });
      refresh();
    } catch (nextError) {
      const preflight = executePreflightError(nextError);
      setExecuteAction({
        status: "error",
        message: preflight?.message ?? (nextError instanceof Error ? nextError.message : "Execute start failed."),
        preflight
      });
    }
  }

  async function runArtifactAction(actionId: string, moveId?: string) {
    if (artifactActionBusy) return;
    setArtifactAction({ status: "starting", actionId });
    try {
      await postArtifactActionRun(roadmapId, actionId, { moveId });
      setArtifactAction({ status: "started", actionId });
      refresh();
    } catch (error) {
      setArtifactAction({ status: "error", actionId, message: error instanceof Error ? error.message : "Artifact Action failed to start." });
    }
  }

  async function startHunsuDraft() {
    if (model.inspector?.kind !== "move") {
      setHunsuDraftAction({ status: "error", message: "Select a MOVE before starting a HUNSU Draft." });
      return;
    }
    setHunsuDraftAction({ status: "starting" });
    try {
      const result = await postHunsuDraftStart(roadmapId, {
        sourceNodeId: model.inspector.node.id,
        sourceMoveId: model.inspector.move?.id,
        sourceLineId: model.inspector.action.lineId,
        aliases: modelAliases
      });
      setHunsuDraft(result.draft);
      mergeHunsuDraftDiffArtifacts(result.draft.diffArtifacts);
      setHunsuDraftAction({ status: "idle" });
      refresh();
      select({ kind: "hunsuDraftRoute", draftSessionId: result.draft.draftSessionId });
    } catch (nextError) {
      setHunsuDraftAction({ status: "error", message: errorMessage(nextError, "HUNSU Draft start failed.") });
    }
  }

  async function sendHunsuDraftMessage(message: string) {
    if (!selectedHunsuDraft) return;
    hunsuDraftMessageMutation.mutate({ draft: selectedHunsuDraft, message });
  }

  async function approveHunsuDraft(diffArtifactId: string, teamName: string) {
    if (!selectedHunsuDraft) return;
    setHunsuDraftAction({ status: "approving" });
    try {
      const result = await postHunsuDraftApprove(roadmapId, selectedHunsuDraft.draftSessionId, diffArtifactId, teamName);
      setHunsuDraft(result.draft);
      mergeHunsuDraftDiffArtifacts(result.draft.diffArtifacts);
      setHunsuDraftAction({ status: "idle" });
      refresh();
      if (result.hunsu?.toNodeId) {
        selectMoveNode(String(result.hunsu.toNodeId), "hunsu");
      }
    } catch (nextError) {
      setHunsuDraftAction({ status: "error", message: errorMessage(nextError, "HUNSU approval failed.") });
    }
  }

  async function discardHunsuDraft() {
    if (!selectedHunsuDraft) return;
    setHunsuDraftAction({ status: "discarding" });
    try {
      const result = await postHunsuDraftDiscard(roadmapId, selectedHunsuDraft.draftSessionId);
      setHunsuDraft(result.draft);
      mergeHunsuDraftDiffArtifacts(result.draft.diffArtifacts);
      setHunsuDraftAction({ status: "idle" });
      refresh();
    } catch (nextError) {
      setHunsuDraftAction({ status: "error", message: errorMessage(nextError, "HUNSU discard failed.") });
    }
  }

  async function loadHunsuDraftDiffArtifact(draftSessionId: string, diffArtifactId: string) {
    const key = hunsuDraftDiffArtifactKey(draftSessionId, diffArtifactId);
    if (hunsuDraftDiffArtifacts[key]) return hunsuDraftDiffArtifacts[key];
    const diffArtifact = await fetchHunsuDraftDiffArtifact(roadmapId, draftSessionId, diffArtifactId);
    setHunsuDraftDiffArtifacts(previous => ({ ...previous, [key]: diffArtifact }));
    return diffArtifact;
  }

  function mergeHunsuDraftDiffArtifacts(diffArtifacts: Record<string, StudioHunsuDraftDiffArtifact> | undefined) {
    if (!diffArtifacts) return;
    setHunsuDraftDiffArtifacts(previous => {
      const next = { ...previous };
      for (const diffArtifact of Object.values(diffArtifacts)) {
        next[hunsuDraftDiffArtifactKey(diffArtifact.draftSessionId, diffArtifact.diffArtifactId)] = diffArtifact;
      }
      return next;
    });
  }

  return (
    <main className="relative h-screen min-h-0 overflow-hidden bg-[color:var(--studio-canvas-tint)] text-foreground">
      <div className="pointer-events-none absolute left-5 right-5 top-5 z-30 flex justify-center">
        <div className="apple-glass pointer-events-auto min-w-0 max-w-[760px] rounded-full px-5 py-3 text-center">
          <p className="truncate text-[14px] font-semibold leading-5 text-[color:var(--apple-ink)]" title={model.title}>
            {model.title}
          </p>
          <p className="mt-0.5 truncate text-[11px] leading-4 text-muted-foreground" title={subtitle}>
            {subtitle}
          </p>
        </div>
      </div>
      <div className="pointer-events-none absolute right-5 top-5 z-30">
        <Button
          type="button"
          size="icon"
          variant="outline"
          className="apple-glass pointer-events-auto size-10"
          aria-label="Choose execute model"
          onClick={() => {
            setModelAliases(readWebModelAliases());
            setModelPanelOpen(open => !open);
          }}
        >
          <Settings2 className="size-4" />
        </Button>
        {modelPanelOpen ? (
          <div className="apple-glass pointer-events-auto mt-3 grid w-[320px] max-w-[calc(100vw-2.5rem)] gap-3 rounded-[8px] p-3">
            <div className="grid grid-cols-2 gap-2">
              <Button type="button" size="sm" variant={executeModelMode === "alias" ? "default" : "outline"} onClick={() => setExecuteModelMode("alias")}>Use alias</Button>
              <Button type="button" size="sm" variant={executeModelMode === "direct" ? "default" : "outline"} onClick={() => setExecuteModelMode("direct")}>Direct provider</Button>
            </div>
            {executeModelMode === "alias" ? (
              <div className="grid gap-2">
                <select className="h-9 rounded-md border bg-background px-2 text-sm" value={executeAliasId} onChange={event => setExecuteAliasId(event.target.value)}>
                  {modelAliases.map(alias => <option key={alias.aliasId} value={alias.aliasId}>{alias.displayName}</option>)}
                </select>
                <Button type="button" size="sm" variant="outline" onClick={() => pushStudioPath("/studio/settings/model-aliases")}>Edit aliases</Button>
              </div>
            ) : (
              <div className="grid gap-2">
                <select className="h-9 rounded-md border bg-background px-2 text-sm" value={directProvider.model} onChange={event => selectDirectModel(event.target.value, codexInventory?.models, setDirectProvider)}>
                  {(codexInventory?.models ?? []).map(item => <option key={item.model} value={item.model}>{item.label}</option>)}
                  {!codexInventory?.models.some(item => item.model === directProvider.model) ? <option value={directProvider.model}>{directProvider.model}</option> : null}
                </select>
                <select className="h-9 rounded-md border bg-background px-2 text-sm" value={directProvider.reasoningEffort ?? ""} onChange={event => setDirectProvider(current => ({ ...current, reasoningEffort: event.target.value as DirectProviderModelSelection["reasoningEffort"] } as DirectProviderModelSelection))}>
                  {directReasoningOptions.map(value => <option key={value} value={value}>{value}</option>)}
                </select>
                <select className="h-9 rounded-md border bg-background px-2 text-sm" value={directProvider.serviceTier ?? ""} onChange={event => setDirectProvider(current => ({ ...current, serviceTier: event.target.value as DirectProviderModelSelection["serviceTier"] } as DirectProviderModelSelection))}>
                  {directServiceTierOptions.map(value => <option key={value} value={value}>{value}</option>)}
                </select>
              </div>
            )}
          </div>
        ) : null}
      </div>
      {executeAction.status === "error" && executeAction.message ? (
        <div className="pointer-events-none absolute left-5 right-5 top-[92px] z-30 flex justify-center">
          <div className="apple-glass pointer-events-auto flex max-w-[720px] flex-wrap items-center justify-center gap-3 rounded-[14px] px-4 py-3 text-center">
            <p className="text-[13px] font-medium leading-5 text-[color:var(--apple-ink)]">{executeAction.message}</p>
            <RoadmapWorkspacePreflightActions preflight={executeAction.preflight} />
          </div>
        </div>
      ) : null}
      <RoadmapGraph
        model={model.graph}
        selection={model.selection.selection}
        onSelect={select}
        onToggleConnection={toggleConnection}
        onStartExecute={startExecute}
        detailPanel={selectedInspector ? (
          <NodeDetailPanel
            inspector={selectedInspector}
            roadmapId={roadmapId}
            artifactActionControls={selectedInspector.kind === "move" ? {
              busyActionId: artifactActionBusy ? artifactAction.actionId : undefined,
              error: artifactAction.status === "error" ? artifactAction.message : undefined,
              onRun: runArtifactAction
            } : undefined}
            actions={inspectorExecuteActions.length > 0 ? (
              <div className="grid gap-2">
                {inspectorExecuteActions.map(item => (
                  <Button
                    key={item.id}
                    type="button"
                    size="sm"
                    className="w-full justify-start"
                    onClick={() => startExecute(item.action)}
                    disabled={executeBusy}
                  >
                    Execute: {item.action.destinationLabels[0] ?? item.node.card.title}
                  </Button>
                ))}
              </div>
            ) : undefined}
            hunsuDraftControls={selectedInspector.kind === "move" || selectedInspector.kind === "hunsuDraftRoute" ? {
              draft: selectedInspector.kind === "hunsuDraftRoute" ? selectedHunsuDraft : undefined,
              busy: hunsuDraftBusy,
              error: hunsuDraftAction.status === "error" ? hunsuDraftAction.message : undefined,
              diffArtifacts: hunsuDraftDiffArtifacts,
              onStart: startHunsuDraft,
              onSendMessage: sendHunsuDraftMessage,
              onLoadDiffArtifact: loadHunsuDraftDiffArtifact,
              onApprove: approveHunsuDraft,
              onDiscard: discardHunsuDraft
            } : undefined}
            onClose={() => select({ kind: "none" })}
            className="h-full w-full"
          />
        ) : undefined}
      />
    </main>
  );
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function executePreflightError(error: unknown): ExecutePreflightError | undefined {
  if (!(error instanceof BridgeRequestError) || typeof error.body !== "object" || error.body === null) {
    return undefined;
  }
  const body = error.body as Partial<ExecutePreflightError>;
  return (body.area === "provider" || body.area === "workspace" || body.area === "connection" || body.area === "model")
    && typeof body.error === "string"
    && typeof body.message === "string"
    ? body as ExecutePreflightError
    : undefined;
}

function executeModelSelectionPayload(input: {
  mode: "alias" | "direct";
  aliasId: string;
  directProvider: DirectProviderModelSelection;
  aliases: ModelAlias[];
}): { modelSelection: ModelSelection; aliases: ModelAlias[] } {
  return {
    modelSelection: input.mode === "alias"
      ? { kind: "alias", aliasId: input.aliasId as Extract<ModelSelection, { kind: "alias" }>["aliasId"] }
      : { kind: "direct", provider: input.directProvider },
    aliases: input.aliases
  };
}

function directProviderFromAlias(alias: ModelAlias | undefined): DirectProviderModelSelection {
  return defaultDirectProvider(alias?.selection.provider);
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

function selectDirectModel(
  modelName: string,
  models: ProviderInventory["providers"][number]["models"] | undefined,
  setDirectProvider: (update: (current: DirectProviderModelSelection) => DirectProviderModelSelection) => void
): void {
  const descriptor = models?.find(model => model.model === modelName);
  setDirectProvider(current => defaultDirectProvider({
    ...current,
    ...(descriptor?.defaultConfig ?? {}),
    providerId: "codex",
    model: modelName as DirectProviderModelSelection["model"]
  } as DirectProviderModelSelection));
}

function optionSet(values: string[] | undefined, selected: string | undefined): string[] {
  return [...new Set([...(values ?? []), selected].filter((value): value is string => Boolean(value)))];
}

export function RoadmapWorkspacePreflightActions({ preflight, open = openBridgeLink }: { preflight: ExecutePreflightError | undefined; open?: (href: string) => void }) {
  return (
    <>
      {(preflight?.actions ?? fallbackPreflightActions(preflight)).map(action => (
        <Button
          key={`${action.type}:${action.href ?? action.workspaceId ?? action.providerId ?? ""}`}
          type="button"
          size="sm"
          variant={primaryAction(action) ? "default" : "outline"}
          onClick={() => open(bridgeActionHref(action))}
        >
          {action.label}
        </Button>
      ))}
    </>
  );
}

function fallbackPreflightActions(preflight: ExecutePreflightError | undefined): ExecutePreflightAction[] {
  if (preflight?.area === "workspace") {
    return [{ type: "open_workspaces", label: "Open Workspaces" }];
  }
  if (preflight?.area === "connection") {
    return [{ type: "open_connection", label: "Open Connection" }];
  }
  if (preflight?.area === "model") {
    return [{ type: "edit_model_alias", label: "Edit Model Alias" }];
  }
  return [{ type: "open_provider_setup", label: "Open Provider Setup" }];
}

function primaryAction(action: ExecutePreflightAction): boolean {
  return action.type === "open_provider_setup"
    || action.type === "install_provider"
    || action.type === "login_provider"
    || action.type === "open_workspaces"
    || action.type === "activate_workspace"
    || action.type === "open_connection"
    || action.type === "edit_model_alias";
}

function openBridgeLink(url: string): void {
  window.location.href = url;
}

function hunsuDraftDiffArtifactKey(draftSessionId: string, diffArtifactId: string): string {
  return `${draftSessionId}:${diffArtifactId}`;
}

function selectCurrentHunsuDraft(local: StudioHunsuDraftSession | undefined, inspector: StudioHunsuDraftSession | undefined): StudioHunsuDraftSession | undefined {
  if (!local) return inspector;
  if (!inspector) return local;
  if (local.draftSessionId !== inspector.draftSessionId) return inspector;
  return Date.parse(inspector.updatedAt) > Date.parse(local.updatedAt) ? inspector : local;
}

function optimisticHunsuDraftForMessage(draft: StudioHunsuDraftSession, message: string): StudioHunsuDraftSession {
  const now = new Date().toISOString();
  const token = `${now}:${draft.messages.length}`;
  return {
    ...draft,
    messages: [
      ...draft.messages,
      {
        messageId: `${draft.draftSessionId}:optimistic:user:${token}`,
        role: "user",
        text: message,
        createdAt: now
      },
      {
        messageId: `${draft.draftSessionId}:optimistic:reply:${token}`,
        role: "draft-agent",
        text: "Draft Agent 응답 중...",
        createdAt: now
      }
    ],
    status: draft.status === "failed" ? "draft" : draft.status,
    error: undefined,
    updatedAt: now
  };
}

function panelFromQuery(value: string | null): RoadmapDetailPanel {
  if (value === "execute" || value === "path" || value === "actions" || value === "hunsu") return value;
  return "move";
}

function selectionFromQuery(params: URLSearchParams): RoadmapSelection | undefined {
  const executeId = params.get("execute");
  const pathId = params.get("path");
  const moveId = params.get("move");
  const teamName = params.get("team");
  const routeId = params.get("route");
  if (routeId?.startsWith("hunsu-draft:")) return { kind: "hunsuDraftRoute", draftSessionId: routeId.slice("hunsu-draft:".length) };
  if (executeId && pathId) return { kind: "pathPoint", executeId, pointId: pathId };
  if (executeId) return { kind: "execute", executeId };
  if (teamName && moveId && /^\d+$/.test(moveId)) return { kind: "move", teamName, moveOrdinal: Number(moveId) };
  if (moveId) return { kind: "move", nodeId: moveId };
  return undefined;
}

function expandedConnectionsFromQuery(params: URLSearchParams): string[] {
  const value = params.get("connect");
  if (!value) return [];
  return value
    .split(",")
    .map(item => item.trim())
    .filter(Boolean)
    .flatMap(item => {
      const [executeId, mode] = item.split(":");
      return executeId && mode === "expand" ? [executeId] : [];
    });
}

function writeSelectionQuery(params: URLSearchParams, selection: RoadmapSelection): void {
  params.delete("move");
  params.delete("team");
  params.delete("execute");
  params.delete("path");
  params.delete("route");
  if (selection.kind === "move") {
    if (selection.teamName && selection.moveOrdinal !== undefined) {
      params.set("team", selection.teamName);
      params.set("move", String(selection.moveOrdinal));
    } else if (selection.nodeId) {
      params.set("move", selection.nodeId);
    } else if (selection.moveId) {
      params.set("move", selection.moveId);
    }
  }
  if (selection.kind === "execute") {
    params.set("execute", selection.executeId);
  }
  if (selection.kind === "pathPoint") {
    params.set("execute", selection.executeId);
    params.set("path", selection.pointId);
  }
  if (selection.kind === "hunsuDraftRoute") {
    params.set("route", `hunsu-draft:${selection.draftSessionId}`);
  }
}

function writeConnectionQuery(params: URLSearchParams, expandedConnectionIds: string[]): void {
  params.delete("connect");
  if (expandedConnectionIds.length > 0) {
    params.set("connect", expandedConnectionIds.map(id => `${id}:expand`).join(","));
  }
}

function selectionMatchesExecute(selection: RoadmapSelection | undefined, executeId: string): boolean {
  return selection?.kind === "execute" || selection?.kind === "pathPoint"
    ? selection.executeId === executeId
    : false;
}

function panelForSelection(selection: RoadmapSelection, fallback: RoadmapDetailPanel): RoadmapDetailPanel {
  if (selection.kind === "execute") return "execute";
  if (selection.kind === "pathPoint") return "path";
  if (selection.kind === "hunsuDraftRoute") return "hunsu";
  if (selection.kind === "move") return "move";
  return fallback;
}
