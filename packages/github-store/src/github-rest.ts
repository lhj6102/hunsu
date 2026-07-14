import type {
  BranchSnapshot,
  CompareStatus,
  FileUpdate,
  GitHubTransport,
  GitHubTransportError,
  RepositoryGrant,
  RepositoryLocator,
  TransportResult
} from "./types.ts";
import { HUNSU_STATE_BRANCH } from "./types.ts";

const GITHUB_API_VERSION = "2026-03-10";
const GITHUB_USER_AGENT = "hunsu-plugin-production";
const GRAPHQL_BLOB_BATCH_SIZE = 500;
const MAX_STATE_BLOB_REQUESTS_PER_READ = 13;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type ContentsWriteInstallationAuthority = {
  token: string;
  permissions: { contents: "write" };
};

export type InstallationAuthorityProvider = (
  installationId: number
) => Promise<ContentsWriteInstallationAuthority>;

export type GitHubRestTransportOptions = {
  authorityProvider: InstallationAuthorityProvider;
  fetch?: FetchLike;
  apiBaseUrl?: string;
};

export class GitHubRestTransport implements GitHubTransport {
  readonly #authorityProvider: InstallationAuthorityProvider;
  readonly #fetch: FetchLike;
  readonly #apiBaseUrl: string;

  constructor(options: GitHubRestTransportOptions) {
    this.#authorityProvider = options.authorityProvider;
    const fetch = options.fetch;
    this.#fetch = fetch
      ? (request, init) => fetch(request, init)
      : (request, init) => globalThis.fetch(request, init);
    this.#apiBaseUrl = (options.apiBaseUrl ?? "https://api.github.com").replace(/\/$/u, "");
  }

  async listInstallationRepositories(installationId: number): Promise<TransportResult<RepositoryGrant[]>> {
    const repositories: RepositoryGrant[] = [];
    for (let page = 1; ; page += 1) {
      const response = await this.#request<Record<string, unknown>>(installationId, `/installation/repositories?per_page=100&page=${page}`);
      if (!response.ok) return response;
      const rows = Array.isArray(response.value.repositories) ? response.value.repositories : undefined;
      if (!rows) return invalidResponse("GitHub repository list is missing repositories.");
      for (const row of rows) {
        const decoded = decodeRepositoryGrant(row, installationId);
        if (!decoded.ok) return decoded;
        repositories.push(decoded.value);
      }
      if (rows.length < 100) return ok(repositories);
    }
  }

  async readBranch(repository: RepositoryLocator, branch: string): Promise<TransportResult<BranchSnapshot | undefined>> {
    const ref = await this.#reference(repository, branch);
    if (!ref.ok) return ref;
    if (ref.value === undefined) return ok(undefined);
    return this.#branchSnapshot(repository, branch, ref.value);
  }

  async readBranchHead(repository: RepositoryLocator, branch: string): Promise<TransportResult<string | undefined>> {
    return this.#reference(repository, branch);
  }

  async createBranch(repository: RepositoryLocator, branch: string, fromSha: string): Promise<TransportResult<BranchSnapshot>> {
    const response = await this.#request<Record<string, unknown>>(repository.installationId, `${repositoryPath(repository)}/git/refs`, {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: fromSha })
    });
    if (!response.ok) return response;
    const sha = readNestedString(response.value, "object", "sha");
    if (!sha) return invalidResponse("Created GitHub ref is missing its commit SHA.");
    return this.#branchSnapshot(repository, branch, sha);
  }

  async #branchSnapshot(
    repository: RepositoryLocator,
    branch: string,
    headSha: string
  ): Promise<TransportResult<BranchSnapshot>> {
    if (branch !== HUNSU_STATE_BRANCH) return ok({ headSha, files: {} });
    const commit = await this.#request<Record<string, unknown>>(
      repository.installationId,
      `${repositoryPath(repository)}/git/commits/${encodeURIComponent(headSha)}`
    );
    if (!commit.ok) return commit;
    const treeSha = readNestedString(commit.value, "tree", "sha");
    if (!treeSha) return invalidResponse("GitHub commit is missing its tree SHA.");

    const rootTree = await this.#request<Record<string, unknown>>(
      repository.installationId,
      `${repositoryPath(repository)}/git/trees/${encodeURIComponent(treeSha)}`
    );
    if (!rootTree.ok) return rootTree;
    const rootEntries = Array.isArray(rootTree.value.tree) ? rootTree.value.tree : undefined;
    if (!rootEntries) return invalidResponse("GitHub root tree response is missing entries.");
    const stateTreeSha = rootEntries.find(entry => isRecord(entry) && entry.path === ".hunsu" && entry.type === "tree" && typeof entry.sha === "string");
    if (!isRecord(stateTreeSha) || typeof stateTreeSha.sha !== "string") return ok({ headSha, files: {} });

    const tree = await this.#request<Record<string, unknown>>(
      repository.installationId,
      `${repositoryPath(repository)}/git/trees/${encodeURIComponent(stateTreeSha.sha)}?recursive=1`
    );
    if (!tree.ok) return tree;
    const entries = Array.isArray(tree.value.tree) ? tree.value.tree : undefined;
    if (!entries || tree.value.truncated === true) return invalidResponse("GitHub Hunsu state tree is missing entries or was truncated.");

    const blobs: Array<{ path: string; sha: string; size?: number }> = [];
    for (const entry of entries) {
      if (!isRecord(entry) || entry.type !== "blob") continue;
      if (typeof entry.path !== "string" || typeof entry.sha !== "string") {
        return invalidResponse("GitHub Hunsu state tree contains an invalid blob entry.");
      }
      if (!isReconstructionInputPath(entry.path)) continue;
      if (entry.size !== undefined && (!Number.isSafeInteger(entry.size) || (entry.size as number) < 0)) {
        return invalidResponse(`GitHub Hunsu state blob ${entry.path} has an invalid size.`);
      }
      blobs.push({
        path: `.hunsu/${entry.path}`,
        sha: entry.sha,
        ...(typeof entry.size === "number" ? { size: entry.size } : {})
      });
    }
    const contents = await this.#blobs(repository, blobs);
    if (!contents.ok) return contents;
    const files: Record<string, string> = {};
    for (const blob of blobs) {
      const content = contents.value.get(blob.sha);
      if (content === undefined) return invalidResponse(`GitHub Hunsu state blob ${blob.sha} is missing content.`);
      files[blob.path] = content;
    }
    return ok({ headSha, files });
  }

  async commitFiles(input: {
    repository: RepositoryLocator;
    branch: string;
    expectedHeadSha: string;
    message: string;
    updates: readonly FileUpdate[];
  }): Promise<TransportResult<string>> {
    const current = await this.#reference(input.repository, input.branch);
    if (!current.ok) return current;
    if (current.value !== input.expectedHeadSha) {
      return conflict(`Expected ${input.branch} at ${input.expectedHeadSha}, found ${current.value ?? "no ref"}.`);
    }

    const parent = await this.#request<Record<string, unknown>>(
      input.repository.installationId,
      `${repositoryPath(input.repository)}/git/commits/${encodeURIComponent(input.expectedHeadSha)}`
    );
    if (!parent.ok) return parent;
    const baseTree = readNestedString(parent.value, "tree", "sha");
    if (!baseTree) return invalidResponse("Parent commit is missing its tree SHA.");

    const treeEntries = input.updates.map(update => ({
      path: update.path,
      mode: "100644" as const,
      type: "blob" as const,
      content: update.content
    }));

    const tree = await this.#request<Record<string, unknown>>(input.repository.installationId, `${repositoryPath(input.repository)}/git/trees`, {
      method: "POST",
      body: JSON.stringify({ base_tree: baseTree, tree: treeEntries })
    });
    if (!tree.ok) return tree;
    if (typeof tree.value.sha !== "string") return invalidResponse("Created tree is missing its SHA.");

    const commit = await this.#request<Record<string, unknown>>(input.repository.installationId, `${repositoryPath(input.repository)}/git/commits`, {
      method: "POST",
      body: JSON.stringify({ message: input.message, tree: tree.value.sha, parents: [input.expectedHeadSha] })
    });
    if (!commit.ok) return commit;
    if (typeof commit.value.sha !== "string") return invalidResponse("Created commit is missing its SHA.");

    const update = await this.#request<Record<string, unknown>>(
      input.repository.installationId,
      `${repositoryPath(input.repository)}/git/refs/${encodeRef(`heads/${input.branch}`)}`,
      { method: "PATCH", body: JSON.stringify({ sha: commit.value.sha, force: false }) },
      true
    );
    if (!update.ok) return update;
    return ok(commit.value.sha);
  }

  async compareCommits(repository: RepositoryLocator, baseSha: string, headSha: string): Promise<TransportResult<CompareStatus>> {
    const response = await this.#request<Record<string, unknown>>(
      repository.installationId,
      `${repositoryPath(repository)}/compare/${encodeURIComponent(baseSha)}...${encodeURIComponent(headSha)}`
    );
    if (!response.ok) return response;
    return isCompareStatus(response.value.status)
      ? ok(response.value.status)
      : invalidResponse("GitHub compare response has an unknown status.");
  }

  async commitExists(repository: RepositoryLocator, sha: string): Promise<TransportResult<boolean>> {
    const response = await this.#request<Record<string, unknown>>(
      repository.installationId,
      `${repositoryPath(repository)}/git/commits/${encodeURIComponent(sha)}`,
      undefined,
      false,
      true
    );
    if (!response.ok && response.error.code === "not_found") return ok(false);
    return response.ok ? ok(true) : response;
  }

  async #reference(repository: RepositoryLocator, branch: string): Promise<TransportResult<string | undefined>> {
    const response = await this.#request<Record<string, unknown>>(
      repository.installationId,
      `${repositoryPath(repository)}/git/ref/${encodeRef(`heads/${branch}`)}`,
      { cache: "no-store" },
      false,
      true
    );
    if (!response.ok && response.error.code === "not_found") return ok(undefined);
    if (!response.ok) return response;
    const sha = readNestedString(response.value, "object", "sha");
    return sha ? ok(sha) : invalidResponse("GitHub ref is missing its commit SHA.");
  }

  async #blob(repository: RepositoryLocator, sha: string): Promise<TransportResult<string>> {
    const response = await this.#request<Record<string, unknown>>(
      repository.installationId,
      `${repositoryPath(repository)}/git/blobs/${encodeURIComponent(sha)}`
    );
    if (!response.ok) return response;
    if (typeof response.value.content !== "string" || response.value.encoding !== "base64") {
      return invalidResponse("GitHub blob is not base64 encoded.");
    }
    return ok(Buffer.from(response.value.content.replace(/\s/gu, ""), "base64").toString("utf8"));
  }

  async #blobs(
    repository: RepositoryLocator,
    blobs: readonly { sha: string; size?: number }[]
  ): Promise<TransportResult<Map<string, string>>> {
    const unique = new Map<string, { sha: string; size?: number }>();
    for (const blob of blobs) {
      const existing = unique.get(blob.sha);
      if (existing?.size !== undefined && blob.size !== undefined && existing.size !== blob.size) {
        return invalidResponse(`GitHub Hunsu state blob ${blob.sha} has conflicting sizes.`);
      }
      if (!existing || (existing.size === undefined && blob.size !== undefined)) unique.set(blob.sha, blob);
    }

    const contents = new Map<string, string>();
    let fallbackCount = 0;
    const values = [...unique.values()];
    const batchCount = Math.ceil(values.length / GRAPHQL_BLOB_BATCH_SIZE);
    if (batchCount > MAX_STATE_BLOB_REQUESTS_PER_READ) {
      return invalidResponse(
        `GitHub Hunsu state exceeds the supported limit of ${GRAPHQL_BLOB_BATCH_SIZE * MAX_STATE_BLOB_REQUESTS_PER_READ} unique blobs.`
      );
    }
    const maxFallbackCount = MAX_STATE_BLOB_REQUESTS_PER_READ - batchCount;
    for (let offset = 0; offset < values.length; offset += GRAPHQL_BLOB_BATCH_SIZE) {
      const batch = values.slice(offset, offset + GRAPHQL_BLOB_BATCH_SIZE);
      const response = await this.#request<Record<string, unknown>>(repository.installationId, "/graphql", {
        method: "POST",
        body: JSON.stringify(graphqlBlobRequest(repository, batch))
      });
      if (!response.ok) return response;
      if (Array.isArray(response.value.errors) && response.value.errors.length > 0) {
        return invalidResponse("GitHub GraphQL returned errors while reading Hunsu state blobs.");
      }
      const data = response.value.data;
      if (!isRecord(data) || !isRecord(data.repository)) {
        return invalidResponse("GitHub GraphQL blob response is missing the repository.");
      }

      for (let index = 0; index < batch.length; index += 1) {
        const expected = batch[index];
        const value = data.repository[`b${index}`];
        if (!isRecord(value) || value.oid !== expected.sha) {
          return invalidResponse(`GitHub GraphQL returned the wrong object for Hunsu state blob ${expected.sha}.`);
        }
        if (!Number.isSafeInteger(value.byteSize) || (value.byteSize as number) < 0) {
          return invalidResponse(`GitHub GraphQL returned an invalid size for Hunsu state blob ${expected.sha}.`);
        }
        if (expected.size !== undefined && value.byteSize !== expected.size) {
          return invalidResponse(`GitHub Hunsu state blob ${expected.sha} does not match its tree size.`);
        }
        if (value.isBinary !== false || typeof value.isTruncated !== "boolean") {
          return invalidResponse(`GitHub Hunsu state blob ${expected.sha} is not complete UTF-8 text.`);
        }

        let content: string;
        if (value.isTruncated || typeof value.text !== "string") {
          fallbackCount += 1;
          if (fallbackCount > maxFallbackCount) {
            return invalidResponse("GitHub returned too many truncated Hunsu state blobs for the supported request budget.");
          }
          const fallback = await this.#blob(repository, expected.sha);
          if (!fallback.ok) return fallback;
          content = fallback.value;
        } else {
          content = value.text;
        }
        if (Buffer.byteLength(content, "utf8") !== value.byteSize) {
          return invalidResponse(`GitHub Hunsu state blob ${expected.sha} content does not match its byte size.`);
        }
        contents.set(expected.sha, content);
      }
    }
    return ok(contents);
  }

  async #request<T>(
    installationId: number,
    path: string,
    init: RequestInit = {},
    conflictOnValidation = false,
    allowNotFound = false
  ): Promise<TransportResult<T>> {
    try {
      const authority = await this.#authorityProvider(installationId);
      const response = await this.#fetch(`${this.#apiBaseUrl}${path}`, {
        ...init,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${authority.token}`,
          "content-type": "application/json",
          "user-agent": GITHUB_USER_AGENT,
          "x-github-api-version": GITHUB_API_VERSION,
          ...init.headers
        }
      });
      if (!response.ok) {
        const message = await readErrorMessage(response);
        if (response.status === 404 && allowNotFound) return notFound(message);
        if (conflictOnValidation && (response.status === 409 || response.status === 422)) return conflict(message, response.status);
        if (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") {
          return failure({ code: "rate_limited", message, status: response.status });
        }
        if (response.status === 401 || response.status === 403) return failure({ code: "forbidden", message, status: response.status });
        if (response.status === 404) return notFound(message);
        if (response.status === 409 || response.status === 422) return conflict(message, response.status);
        return failure({ code: "invalid_response", message, status: response.status });
      }
      return ok(await response.json() as T);
    } catch (error) {
      return failure({ code: "network", message: error instanceof Error ? error.message : "GitHub request failed." });
    }
  }
}

function graphqlBlobRequest(
  repository: RepositoryLocator,
  blobs: readonly { sha: string }[]
): { query: string; variables: Record<string, string> } {
  const declarations = blobs.map((_, index) => `$oid${index}: GitObjectID!`).join(", ");
  const selections = blobs.map((_, index) => `
      b${index}: object(oid: $oid${index}) {
        ... on Blob {
          oid
          byteSize
          isBinary
          isTruncated
          text
        }
      }`).join("");
  return {
    query: `query ReadHunsuBlobs($owner: String!, $name: String!, ${declarations}) {
  repository(owner: $owner, name: $name) {${selections}
  }
}`,
    variables: {
      owner: repository.owner,
      name: repository.name,
      ...Object.fromEntries(blobs.map((blob, index) => [`oid${index}`, blob.sha]))
    }
  };
}

function repositoryPath(repository: RepositoryLocator): string {
  return `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
}

function encodeRef(ref: string): string {
  return ref.split("/").map(encodeURIComponent).join("/");
}

function isReconstructionInputPath(path: string): boolean {
  return /^projects\/[^/]+\/events\//u.test(path);
}

function decodeRepositoryGrant(input: unknown, installationId: number): TransportResult<RepositoryGrant> {
  if (!isRecord(input)
    || typeof input.id !== "number"
    || typeof input.name !== "string"
    || typeof input.default_branch !== "string"
    || typeof input.private !== "boolean"
    || !isRecord(input.owner)
    || typeof input.owner.login !== "string"
    || (input.permissions !== undefined
      && (!isRecord(input.permissions) || typeof input.permissions.push !== "boolean"))
  ) {
    return invalidResponse("GitHub returned an invalid repository grant.");
  }
  // This endpoint establishes installation repository membership only. The
  // transport accepts a Contents-write authority that was verified when the
  // installation token was minted; user permissions are overlaid separately.
  return ok({
    installationId,
    repositoryId: input.id,
    owner: input.owner.login,
    name: input.name,
    defaultBranch: input.default_branch,
    private: input.private,
    permissions: { contents: "write" }
  });
}

function readNestedString(input: Record<string, unknown>, key: string, nested: string): string | undefined {
  const value = input[key];
  return isRecord(value) && typeof value[nested] === "string" ? value[nested] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCompareStatus(value: unknown): value is CompareStatus {
  return value === "ahead" || value === "behind" || value === "diverged" || value === "identical";
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = await response.json() as { message?: unknown };
    if (typeof body.message === "string") return body.message;
  } catch {
    // Ignore malformed error bodies; status remains useful and contains no credential material.
  }
  return `GitHub request failed with status ${response.status}.`;
}

function ok<T>(value: T): TransportResult<T> {
  return { ok: true, value };
}

function failure(error: GitHubTransportError): TransportResult<never> {
  return { ok: false, error };
}

function invalidResponse(message: string): TransportResult<never> {
  return failure({ code: "invalid_response", message });
}

function conflict(message: string, status?: number): TransportResult<never> {
  return failure({ code: "conflict", message, status });
}

function notFound(message: string): TransportResult<never> {
  return failure({ code: "not_found", message, status: 404 });
}
