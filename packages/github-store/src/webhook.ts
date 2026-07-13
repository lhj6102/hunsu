import type { RepositoryLocator } from "./types.ts";

export type GitHubWebhookSignal =
  | {
      kind: "state_ref_changed";
      repository: RepositoryLocator;
      previousHeadSha: string;
      stateHeadSha: string;
    }
  | {
      kind: "installation_changed";
      installationId: number;
      action: "created" | "deleted" | "suspend" | "unsuspend" | "new_permissions_accepted";
    }
  | {
      kind: "repository_grant_changed";
      installationId: number;
      action: "added" | "removed";
      repositoryIds: number[];
    }
  | { kind: "ignored"; eventName: string };

export type WebhookNormalizationError = {
  code: "invalid_webhook";
  message: string;
};

export type WebhookNormalizationResult =
  | { ok: true; value: GitHubWebhookSignal }
  | { ok: false; error: WebhookNormalizationError };

type DecodeResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: WebhookNormalizationError };

const FULL_SHA = /^[0-9a-f]{40}$/u;

export function normalizeGitHubWebhook(eventName: string, payload: unknown): WebhookNormalizationResult {
  if (!eventName.trim()) return failure("GitHub webhook event name is required.");
  if (!isRecord(payload)) return failure("GitHub webhook payload must be an object.");

  if (eventName === "push") {
    if (payload.ref !== "refs/heads/hunsu/state") return success({ kind: "ignored", eventName });
    const repository = decodeRepository(payload.repository, payload.installation);
    if (!repository.ok) return repository;
    if (typeof payload.before !== "string" || !FULL_SHA.test(payload.before)
      || typeof payload.after !== "string" || !FULL_SHA.test(payload.after)) {
      return failure("State-ref webhook requires full before and after Git SHAs.");
    }
    return success({
      kind: "state_ref_changed",
      repository: repository.value,
      previousHeadSha: payload.before,
      stateHeadSha: payload.after
    });
  }

  if (eventName === "installation") {
    const installationId = nestedPositiveInteger(payload.installation, "id");
    if (!installationId || !isInstallationAction(payload.action)) {
      return failure("Installation webhook has an invalid installation or action.");
    }
    return success({ kind: "installation_changed", installationId, action: payload.action });
  }

  if (eventName === "installation_repositories") {
    const installationId = nestedPositiveInteger(payload.installation, "id");
    if (!installationId || (payload.action !== "added" && payload.action !== "removed")) {
      return failure("Repository-grant webhook has an invalid installation or action.");
    }
    const key = payload.action === "added" ? "repositories_added" : "repositories_removed";
    const repositories = payload[key];
    if (!Array.isArray(repositories)) return failure("Repository-grant webhook is missing its repository list.");
    const repositoryIds = repositories.map(repository => nestedPositiveInteger(repository, "id"));
    if (repositoryIds.some(id => id === undefined)) return failure("Repository-grant webhook contains an invalid repository id.");
    return success({
      kind: "repository_grant_changed",
      installationId,
      action: payload.action,
      repositoryIds: repositoryIds as number[]
    });
  }

  return success({ kind: "ignored", eventName });
}

function decodeRepository(repository: unknown, installation: unknown): DecodeResult<RepositoryLocator> {
  if (!isRecord(repository)
    || !isRecord(repository.owner)
    || typeof repository.owner.login !== "string"
    || typeof repository.name !== "string"
    || typeof repository.default_branch !== "string") {
    return failure("State-ref webhook contains an invalid repository.");
  }
  const installationId = nestedPositiveInteger(installation, "id");
  const repositoryId = nestedPositiveInteger(repository, "id");
  if (!installationId || !repositoryId) return failure("State-ref webhook is missing installation-scoped repository identity.");
  return decoded({
    installationId,
    repositoryId,
    owner: repository.owner.login,
    name: repository.name,
    defaultBranch: repository.default_branch
  });
}

function nestedPositiveInteger(input: unknown, key: string): number | undefined {
  if (!isRecord(input)) return undefined;
  const value = input[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function isInstallationAction(value: unknown): value is Extract<GitHubWebhookSignal, { kind: "installation_changed" }>["action"] {
  return value === "created" || value === "deleted" || value === "suspend" || value === "unsuspend" || value === "new_permissions_accepted";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function success<T extends GitHubWebhookSignal>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

function decoded<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

function failure(message: string): { ok: false; error: WebhookNormalizationError } {
  return { ok: false, error: { code: "invalid_webhook", message } };
}
