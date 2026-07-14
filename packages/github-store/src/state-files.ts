import type {
  GitHubTransportError,
  ProjectReadModelName,
  StateFileSelection,
  TransportResult
} from "./types.ts";

const STATE_ROOT = ".hunsu/v2";
const SAFE_PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const FULL_SHA = /^[0-9a-f]{40}$/u;
const EVENT_ID = /^[0-9a-f]{32}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const SHARD_INDEX_LIMIT = 9_999_999;
const MAX_SELECTIONS = 256;

const READ_MODEL_PATHS: Readonly<Record<ProjectReadModelName, string>> = {
  catalog: "project.json",
  graph: "graph/latest.json",
  activity: "snapshots/latest.json",
  event_index: "indexes/events/latest.json"
};

export type ResolvedStateFileSelection = {
  readonly path: string;
  readonly selection: StateFileSelection;
};

/**
 * Validate and resolve the closed selection language without discovering a Git
 * tree. Every selection maps to exactly one path at the caller-supplied commit.
 */
export function resolveStateFileSelections(
  selections: readonly StateFileSelection[]
): TransportResult<readonly ResolvedStateFileSelection[]> {
  if (selections.length === 0 || selections.length > MAX_SELECTIONS) {
    return invalid(`Targeted state reads require 1 to ${MAX_SELECTIONS} selections.`);
  }

  const resolved = new Map<string, ResolvedStateFileSelection>();
  for (const selection of selections) {
    const validated = validateSelection(selection);
    if (!validated.ok) return validated;
    const path = exactStateFilePath(selection);
    if (!resolved.has(path)) resolved.set(path, { path, selection });
  }
  return { ok: true, value: [...resolved.values()].sort((left, right) => left.path.localeCompare(right.path)) };
}

export function exactStateFilePath(selection: StateFileSelection): string {
  switch (selection.kind) {
    case "workspace":
      return `${STATE_ROOT}/workspace.json`;
    case "project_read_model":
      return `${STATE_ROOT}/projects/${selection.projectId}/${READ_MODEL_PATHS[selection.model]}`;
    case "node_payload":
      return `${STATE_ROOT}/projects/${selection.projectId}/nodes/${selection.nodeSha}/node.hunsu`;
    case "graph_page":
      return `${STATE_ROOT}/projects/${selection.projectId}/graph/pages/${String(selection.page).padStart(7, "0")}.json`;
    case "graph_node":
      return `${STATE_ROOT}/projects/${selection.projectId}/graph/nodes/${selection.nodeSha}.json`;
    case "node_activity":
      return `${STATE_ROOT}/projects/${selection.projectId}/snapshots/nodes/${selection.nodeSha}.json`;
    case "run_activity":
      return `${STATE_ROOT}/projects/${selection.projectId}/snapshots/runs/${selection.runId}.json`;
    case "event_index_shard":
      return `${STATE_ROOT}/projects/${selection.projectId}/indexes/events/shards/${String(selection.shard).padStart(7, "0")}.json`;
    case "event_locator":
      return `${STATE_ROOT}/projects/${selection.projectId}/indexes/events/by-domain/${selection.eventId}.json`;
    case "event":
      return `${STATE_ROOT}/projects/${selection.projectId}/events/${String(selection.year).padStart(4, "0")}/${String(selection.month).padStart(2, "0")}/${selection.eventId}.json`;
  }
}

function validateSelection(selection: StateFileSelection): TransportResult<void> {
  if (selection.kind === "workspace") return { ok: true, value: undefined };
  if (!SAFE_PROJECT_ID.test(selection.projectId)) return invalid("Targeted state read contains an unsafe Project id.");
  if (selection.kind === "project_read_model") {
    return Object.hasOwn(READ_MODEL_PATHS, selection.model)
      ? { ok: true, value: undefined }
      : invalid("Targeted state read contains an unsupported read-model name.");
  }
  if (selection.kind === "node_payload" || selection.kind === "graph_node" || selection.kind === "node_activity") {
    return FULL_SHA.test(selection.nodeSha)
      ? { ok: true, value: undefined }
      : invalid("Targeted Node payload read requires a full lowercase Git SHA.");
  }
  if (selection.kind === "graph_page" || selection.kind === "event_index_shard") {
    const index = selection.kind === "graph_page" ? selection.page : selection.shard;
    return Number.isSafeInteger(index) && index >= 0 && index <= SHARD_INDEX_LIMIT
      ? { ok: true, value: undefined }
      : invalid("Targeted shard read requires a bounded non-negative index.");
  }
  if (selection.kind === "run_activity") {
    return SAFE_ID.test(selection.runId) && !selection.runId.includes("..")
      ? { ok: true, value: undefined }
      : invalid("Targeted Run activity read requires a branch-safe Run id.");
  }
  if (selection.kind === "event_locator") {
    return SAFE_ID.test(selection.eventId) && !selection.eventId.includes("..")
      ? { ok: true, value: undefined }
      : invalid("Targeted Event locator read requires a branch-safe domain Event id.");
  }
  return Number.isSafeInteger(selection.year)
      && selection.year >= 0
      && selection.year <= 9_999
      && Number.isSafeInteger(selection.month)
      && selection.month >= 1
      && selection.month <= 12
      && EVENT_ID.test(selection.eventId)
    ? { ok: true, value: undefined }
    : invalid("Targeted event read contains an invalid date or event id.");
}

function invalid(message: string): TransportResult<never> {
  return failure({ code: "invalid_response", message });
}

function failure(error: GitHubTransportError): TransportResult<never> {
  return { ok: false, error };
}
