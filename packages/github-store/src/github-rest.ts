import { resolveStateFileSelections, type ResolvedStateFileSelection } from "./state-files.ts";
import type {
  BranchSnapshot,
  CommitSnapshot,
  CompareStatus,
  FileUpdate,
  GitHubTransport,
  GitHubTransportError,
  ManagedNodeAnchorSnapshot,
  RepositoryGrant,
  RepositoryLocator,
  StateFileSelection,
  StateFileSnapshot,
  TransportResult
} from "./types.ts";
import { GitHubAuthorityError, HUNSU_STATE_BRANCH } from "./types.ts";

const GITHUB_API_VERSION = "2026-03-10";
const GITHUB_USER_AGENT = "hunsu-plugin-production";
const GRAPHQL_BLOB_BATCH_SIZE = 500;
const GRAPHQL_REF_PAGE_SIZE = 100;
const GRAPHQL_EXACT_MANAGED_REF_BATCH_SIZE = 50;
const MAX_MANAGED_REF_PAGES = 100;
const MAX_STATE_BLOB_REQUESTS_PER_READ = 13;
const EXACT_STATE_METADATA_BATCH_SIZE = 50;
const MAX_EXACT_STATE_REST_FALLBACKS = 4;
const MAX_EXACT_STATE_AGGREGATE_BYTES = 128 * 1024 * 1024;
const MAX_WORKSPACE_BYTES = 1 * 1024 * 1024;
const MAX_NODE_PAYLOAD_BYTES = 2 * 1024 * 1024;
const MAX_EVENT_BYTES = 7 * 1024 * 1024;
const MAX_READ_MODEL_BYTES = 50 * 1024 * 1024;
const MAX_EXACT_STATE_CACHE_ENTRIES = 128;
const MAX_EXACT_STATE_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_INSTALLATION_COOLDOWNS = 128;
const TRANSIENT_FAILURE_COOLDOWN_SECONDS = 5;
const AUTHORITY_FORBIDDEN_COOLDOWN_SECONDS = 30;
const DEFAULT_GITHUB_REQUEST_TIMEOUT_MS = 15_000;
const MAX_TIMER_TIMEOUT_MS = 2_147_483_647;
const SAFE_PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type StateTreeBlob = { path: string; sha: string; size?: number };
type ExactStateBlob = { path: string; sha: string; size: number };
type ExactStateCacheEntry = { snapshot: StateFileSnapshot; byteSize: number };

export type ContentsWriteInstallationAuthority = {
  token: string;
  permissions: { contents: "write" };
};

export type InstallationAuthorityProvider = (
  installationId: number
) => Promise<ContentsWriteInstallationAuthority>;

export type InstallationAuthorityInvalidator = (installationId: number, rejectedToken: string) => void;

export type GitHubRestTransportOptions = {
  authorityProvider: InstallationAuthorityProvider;
  invalidateAuthority?: InstallationAuthorityInvalidator;
  fetch?: FetchLike;
  apiBaseUrl?: string;
  now?: () => number;
  requestTimeoutMs?: number;
};

type InstallationCooldown = {
  retryAt: number;
  error: GitHubTransportError;
};

class GitHubRequestTimeoutError extends Error {
  constructor() {
    super("GitHub request exceeded its deadline.");
    this.name = "GitHubRequestTimeoutError";
  }
}

export class GitHubRestTransport implements GitHubTransport {
  readonly #authorityProvider: InstallationAuthorityProvider;
  readonly #invalidateAuthority: InstallationAuthorityInvalidator | undefined;
  readonly #fetch: FetchLike;
  readonly #apiBaseUrl: string;
  readonly #now: () => number;
  readonly #requestTimeoutMs: number;
  readonly #installationRequestTails = new Map<number, Promise<void>>();
  readonly #installationCooldowns = new Map<number, InstallationCooldown>();
  readonly #exactStateReadFlights = new Map<string, Promise<TransportResult<StateFileSnapshot>>>();
  readonly #exactStateReadCache = new Map<string, ExactStateCacheEntry>();
  #exactStateReadCacheBytes = 0;

  constructor(options: GitHubRestTransportOptions) {
    this.#authorityProvider = options.authorityProvider;
    this.#invalidateAuthority = options.invalidateAuthority;
    const fetch = options.fetch;
    this.#fetch = fetch
      ? (request, init) => fetch(request, init)
      : (request, init) => globalThis.fetch(request, init);
    this.#apiBaseUrl = (options.apiBaseUrl ?? "https://api.github.com").replace(/\/$/u, "");
    this.#now = options.now ?? (() => Date.now());
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_GITHUB_REQUEST_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.#requestTimeoutMs) || this.#requestTimeoutMs < 1
      || this.#requestTimeoutMs > MAX_TIMER_TIMEOUT_MS
    ) {
      throw new Error(`GitHub request timeout must be between 1 and ${MAX_TIMER_TIMEOUT_MS} milliseconds.`);
    }
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

  async readStateFilesAtHead(
    repository: RepositoryLocator,
    stateHeadSha: string,
    selections: readonly StateFileSelection[]
  ): Promise<TransportResult<StateFileSnapshot>> {
    if (!isFullSha(stateHeadSha)) return invalidResponse("Exact state reads require a full lowercase Git SHA.");
    const resolved = resolveStateFileSelections(selections);
    if (!resolved.ok) return resolved;
    const cacheKey = exactStateReadCacheKey(repository, stateHeadSha, resolved.value);
    const cached = this.#exactStateReadCache.get(cacheKey);
    if (cached) {
      this.#exactStateReadCache.delete(cacheKey);
      this.#exactStateReadCache.set(cacheKey, cached);
      return ok(cloneStateFileSnapshot(cached.snapshot));
    }

    const active = this.#exactStateReadFlights.get(cacheKey);
    if (active) return cloneStateFileResult(await active);

    const flight = this.#readExactStateFilesAtHead(repository, stateHeadSha, resolved.value);
    this.#exactStateReadFlights.set(cacheKey, flight);
    try {
      const result = await flight;
      if (result.ok) this.#cacheExactStateRead(cacheKey, result.value);
      return cloneStateFileResult(result);
    } finally {
      if (this.#exactStateReadFlights.get(cacheKey) === flight) this.#exactStateReadFlights.delete(cacheKey);
    }
  }

  async #readExactStateFilesAtHead(
    repository: RepositoryLocator,
    stateHeadSha: string,
    selections: readonly ResolvedStateFileSelection[]
  ): Promise<TransportResult<StateFileSnapshot>> {
    const blobs: ExactStateBlob[] = [];
    let aggregateBytes = 0;
    let v2TreeOid: string | undefined;

    for (let offset = 0; offset < selections.length; offset += EXACT_STATE_METADATA_BATCH_SIZE) {
      const batch = selections.slice(offset, offset + EXACT_STATE_METADATA_BATCH_SIZE);
      const response = await this.#request<Record<string, unknown>>(repository.installationId, "/graphql", {
        method: "POST",
        body: JSON.stringify(graphqlExactStateObjectsRequest(repository, stateHeadSha, batch))
      });
      if (!response.ok) return response;
      if (Array.isArray(response.value.errors) && response.value.errors.length > 0) {
        return invalidResponse("GitHub GraphQL returned errors while resolving exact Hunsu state paths.");
      }
      const data = response.value.data;
      const repositoryData = isRecord(data) ? data.repository : undefined;
      if (!isRecord(repositoryData)) {
        return invalidResponse("GitHub GraphQL exact state response is missing the repository.");
      }

      const head = repositoryData.head;
      if (head === null) return notFound(`State commit ${stateHeadSha} does not exist.`);
      if (!isRecord(head) || head.__typename !== "Commit" || head.oid !== stateHeadSha) {
        return invalidResponse("GitHub GraphQL exact state response did not resolve the requested commit.");
      }

      const v2 = repositoryData.v2;
      if (v2 === null) {
        return selections.every(({ selection }) => selection.kind === "workspace")
          ? ok({ stateHeadSha, v2State: "absent", files: {} })
          : notFound(`Hunsu v2 state does not exist at commit ${stateHeadSha}.`);
      }
      if (!isRecord(v2) || v2.__typename !== "Tree" || typeof v2.oid !== "string" || !isFullSha(v2.oid)) {
        return invalidResponse("GitHub GraphQL exact state response contains an invalid v2 state root.");
      }
      if (v2TreeOid !== undefined && v2TreeOid !== v2.oid) {
        return invalidResponse("GitHub GraphQL returned inconsistent v2 state roots for one exact commit.");
      }
      v2TreeOid = v2.oid;

      for (let index = 0; index < batch.length; index += 1) {
        const selected = batch[index];
        const value = repositoryData[`b${index}`];
        if (value === null) {
          return notFound(`Required Hunsu state resource ${selected.path} does not exist at the requested state head.`);
        }
        if (!isRecord(value)
          || value.__typename !== "Blob"
          || typeof value.oid !== "string"
          || !isFullSha(value.oid)
          || !Number.isSafeInteger(value.byteSize)
          || (value.byteSize as number) < 0
          || value.isBinary !== false
        ) {
          return invalidResponse(`GitHub returned an invalid UTF-8 blob for Hunsu state resource ${selected.path}.`);
        }
        const byteSize = value.byteSize as number;
        const limit = exactStateFileByteLimit(selected.selection);
        if (byteSize > limit) {
          return invalidResponse(`Hunsu state resource ${selected.path} exceeds its ${limit}-byte limit.`);
        }
        aggregateBytes += byteSize;
        if (!Number.isSafeInteger(aggregateBytes) || aggregateBytes > MAX_EXACT_STATE_AGGREGATE_BYTES) {
          return invalidResponse(`Targeted Hunsu state read exceeds the ${MAX_EXACT_STATE_AGGREGATE_BYTES}-byte aggregate limit.`);
        }
        blobs.push({ path: selected.path, sha: value.oid, size: byteSize });
      }
    }

    const contents = await this.#blobs(repository, blobs, { maxFallbacks: MAX_EXACT_STATE_REST_FALLBACKS });
    if (!contents.ok) return contents;
    const files: Record<string, string> = {};
    for (const blob of blobs) {
      const content = contents.value.get(blob.sha);
      if (content === undefined) return invalidResponse(`GitHub Hunsu state blob ${blob.sha} is missing content.`);
      Object.defineProperty(files, blob.path, {
        value: content,
        enumerable: true,
        configurable: true,
        writable: true
      });
    }
    return ok({ stateHeadSha, v2State: "present", files });
  }

  #cacheExactStateRead(cacheKey: string, snapshot: StateFileSnapshot): void {
    const byteSize = Object.values(snapshot.files).reduce((total, content) => total + Buffer.byteLength(content, "utf8"), 0);
    if (byteSize > MAX_EXACT_STATE_CACHE_BYTES) return;
    const existing = this.#exactStateReadCache.get(cacheKey);
    if (existing) {
      this.#exactStateReadCacheBytes -= existing.byteSize;
      this.#exactStateReadCache.delete(cacheKey);
    }
    this.#exactStateReadCache.set(cacheKey, { snapshot: cloneStateFileSnapshot(snapshot), byteSize });
    this.#exactStateReadCacheBytes += byteSize;
    while (this.#exactStateReadCache.size > MAX_EXACT_STATE_CACHE_ENTRIES
      || this.#exactStateReadCacheBytes > MAX_EXACT_STATE_CACHE_BYTES) {
      const oldestKey = this.#exactStateReadCache.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      const oldest = this.#exactStateReadCache.get(oldestKey);
      this.#exactStateReadCache.delete(oldestKey);
      this.#exactStateReadCacheBytes -= oldest?.byteSize ?? 0;
    }
  }

  async readBranchHead(repository: RepositoryLocator, branch: string): Promise<TransportResult<string | undefined>> {
    return this.#reference(repository, branch);
  }

  async createBranch(repository: RepositoryLocator, branch: string, fromSha: string): Promise<TransportResult<BranchSnapshot>> {
    if (!isFullSha(fromSha)) return invalidResponse("Branch creation requires a full lowercase base commit SHA.");
    const expectedRef = `refs/heads/${branch}`;
    const response = await this.#request<Record<string, unknown>>(repository.installationId, `${repositoryPath(repository)}/git/refs`, {
      method: "POST",
      body: JSON.stringify({ ref: expectedRef, sha: fromSha })
    });
    if (!response.ok) return response;
    const sha = readNestedString(response.value, "object", "sha");
    if (response.value.ref !== expectedRef || sha !== fromSha) {
      return invalidResponse("Created GitHub branch returned an unexpected ref or base commit SHA.");
    }
    return this.#branchSnapshot(repository, branch, sha);
  }

  async listManagedNodeAnchors(repository: RepositoryLocator, projectId: string): Promise<TransportResult<ManagedNodeAnchorSnapshot[]>> {
    if (!SAFE_PROJECT_ID.test(projectId)) {
      return invalidResponse("Managed Node anchor listing requires a safe Project id.");
    }
    const refPrefix = `refs/tags/hunsu/node/${projectId}/`;
    const anchors: ManagedNodeAnchorSnapshot[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_MANAGED_REF_PAGES; page += 1) {
      const response = await this.#request<Record<string, unknown>>(repository.installationId, "/graphql", {
        method: "POST",
        body: JSON.stringify(graphqlManagedNodeRefsRequest(repository, refPrefix, cursor))
      });
      if (!response.ok) return response;
      if (Array.isArray(response.value.errors) && response.value.errors.length > 0) {
        return invalidResponse("GitHub GraphQL returned errors while reading managed Node refs.");
      }
      const data = response.value.data;
      const repositoryData = isRecord(data) ? data.repository : undefined;
      const refs = isRecord(repositoryData) ? repositoryData.refs : undefined;
      if (!isRecord(refs) || !Array.isArray(refs.nodes) || !isRecord(refs.pageInfo)) {
        return invalidResponse("GitHub GraphQL managed Node ref response is incomplete.");
      }
      for (const node of refs.nodes) {
        const qualifiedName = isRecord(node) && typeof node.prefix === "string" && typeof node.name === "string"
          ? `${node.prefix}${node.name}`
          : undefined;
        const targetOid = isRecord(node) && isRecord(node.target) && typeof node.target.oid === "string"
          ? node.target.oid
          : undefined;
        const hasExactKnownRefSplit = isRecord(node) && typeof node.prefix === "string" && typeof node.name === "string"
          && targetOid !== undefined && (
            (node.prefix === "refs/tags/" && node.name === `hunsu/node/${projectId}/${targetOid}`)
            || (node.prefix === refPrefix && node.name === targetOid)
          );
        if (!isRecord(node) || typeof node.name !== "string" || !hasExactKnownRefSplit || !isRecord(node.target)
          || node.target.__typename !== "Commit" || typeof node.target.oid !== "string"
          || !isFullSha(node.target.oid) || typeof node.target.message !== "string" || node.target.message.trim() === ""
          || !isRecord(node.target.tree) || typeof node.target.tree.oid !== "string" || !isFullSha(node.target.tree.oid)
          || qualifiedName !== `${refPrefix}${node.target.oid}`
        ) {
          return invalidResponse("GitHub GraphQL returned an invalid managed Node ref or commit.");
        }
        anchors.push({
          managedRef: qualifiedName,
          nodeSha: node.target.oid,
          treeSha: node.target.tree.oid,
          commitMessage: node.target.message
        });
      }
      if (refs.pageInfo.hasNextPage === false) {
        anchors.sort((left, right) => left.managedRef.localeCompare(right.managedRef));
        return ok(anchors);
      }
      if (refs.pageInfo.hasNextPage !== true || typeof refs.pageInfo.endCursor !== "string" || refs.pageInfo.endCursor === "") {
        return invalidResponse("GitHub GraphQL managed Node ref pagination is invalid.");
      }
      cursor = refs.pageInfo.endCursor;
    }
    return invalidResponse(`GitHub managed Node refs exceed the supported ${GRAPHQL_REF_PAGE_SIZE * MAX_MANAGED_REF_PAGES} Node limit.`);
  }

  async readManagedNodeAnchors(
    repository: RepositoryLocator,
    projectId: string,
    nodeShas: readonly string[]
  ): Promise<TransportResult<ManagedNodeAnchorSnapshot[]>> {
    if (!SAFE_PROJECT_ID.test(projectId)
      || nodeShas.length === 0 || nodeShas.length > 300
      || new Set(nodeShas).size !== nodeShas.length
      || nodeShas.some(sha => !isFullSha(sha))
    ) return invalidResponse("Exact managed Node reads require 1 to 300 unique full SHAs and a safe Project id.");
    const anchors: ManagedNodeAnchorSnapshot[] = [];
    for (let offset = 0; offset < nodeShas.length; offset += GRAPHQL_EXACT_MANAGED_REF_BATCH_SIZE) {
      const batch = nodeShas.slice(offset, offset + GRAPHQL_EXACT_MANAGED_REF_BATCH_SIZE);
      const response = await this.#request<Record<string, unknown>>(repository.installationId, "/graphql", {
        method: "POST",
        body: JSON.stringify(graphqlExactManagedNodeRefsRequest(repository, projectId, batch))
      });
      if (!response.ok) return response;
      if (Array.isArray(response.value.errors) && response.value.errors.length > 0) {
        return invalidResponse("GitHub GraphQL returned errors while reading exact managed Node refs.");
      }
      const data = response.value.data;
      const repositoryData = isRecord(data) ? data.repository : undefined;
      if (!isRecord(repositoryData)) return invalidResponse("GitHub GraphQL exact managed Node response is missing the repository.");
      for (let index = 0; index < batch.length; index += 1) {
        const nodeSha = batch[index]!;
        const ref = repositoryData[`r${index}`];
        if (!isRecord(ref) || !isRecord(ref.target) || ref.target.__typename !== "Commit" || ref.target.oid !== nodeSha
          || typeof ref.target.message !== "string" || ref.target.message.trim() === ""
          || !isRecord(ref.target.tree) || typeof ref.target.tree.oid !== "string" || !isFullSha(ref.target.tree.oid)
        ) return invalidResponse(`Managed Node ref refs/tags/hunsu/node/${projectId}/${nodeSha} is missing or invalid.`);
        anchors.push({
          managedRef: `refs/tags/hunsu/node/${projectId}/${nodeSha}`,
          nodeSha,
          treeSha: ref.target.tree.oid,
          commitMessage: ref.target.message
        });
      }
    }
    return ok(anchors);
  }

  async readRef(repository: RepositoryLocator, ref: string): Promise<TransportResult<string | undefined>> {
    if (!isManagedRef(ref)) return invalidResponse("Only full Hunsu-managed refs may be read through this boundary.");
    return this.#referenceByName(repository, ref.slice("refs/".length));
  }

  async createRef(repository: RepositoryLocator, ref: string, sha: string): Promise<TransportResult<string>> {
    if (!isManagedRef(ref) || !isFullSha(sha)) return invalidResponse("Managed ref creation requires a valid full ref and commit SHA.");
    const response = await this.#request<Record<string, unknown>>(repository.installationId, `${repositoryPath(repository)}/git/refs`, {
      method: "POST",
      body: JSON.stringify({ ref, sha })
    }, true);
    if (!response.ok) return response;
    const created = readNestedString(response.value, "object", "sha");
    return response.value.ref === ref && created === sha
      ? ok(created)
      : invalidResponse("Created GitHub ref returned an unexpected ref or commit SHA.");
  }

  async readCommit(repository: RepositoryLocator, sha: string): Promise<TransportResult<CommitSnapshot | undefined>> {
    if (!isFullSha(sha)) return invalidResponse("Commit lookup requires a full lowercase Git SHA.");
    const response = await this.#request<Record<string, unknown>>(
      repository.installationId,
      `${repositoryPath(repository)}/git/commits/${encodeURIComponent(sha)}`,
      { cache: "no-store" },
      false,
      true
    );
    if (!response.ok && response.error.code === "not_found") return ok(undefined);
    return response.ok ? decodeCommit(response.value, sha) : response;
  }

  async createCommit(input: {
    repository: RepositoryLocator;
    parentSha: string;
    treeSha: string;
    message: string;
    timestamp: string;
  }): Promise<TransportResult<CommitSnapshot>> {
    if (!isFullSha(input.parentSha) || !isFullSha(input.treeSha) || !isCanonicalTimestamp(input.timestamp) || input.message.trim() === "") {
      return invalidResponse("Commit creation requires full SHAs, a canonical timestamp, and a non-empty message.");
    }
    const response = await this.#request<Record<string, unknown>>(input.repository.installationId, `${repositoryPath(input.repository)}/git/commits`, {
      method: "POST",
      body: JSON.stringify({
        message: input.message,
        tree: input.treeSha,
        parents: [input.parentSha],
        author: { name: "Hunsu", email: "noreply@hunsu.app", date: input.timestamp },
        committer: { name: "Hunsu", email: "noreply@hunsu.app", date: input.timestamp }
      })
    });
    if (!response.ok) return response;
    const decoded = decodeCommit(response.value);
    if (!decoded.ok) return decoded;
    return decoded.value.treeSha === input.treeSha
      && decoded.value.parentShas.length === 1
      && decoded.value.parentShas[0] === input.parentSha
      && decoded.value.message === input.message
      ? decoded
      : invalidResponse("Created GitHub commit does not exactly match its requested parent, tree, and message.");
  }

  async #branchSnapshot(
    repository: RepositoryLocator,
    branch: string,
    headSha: string
  ): Promise<TransportResult<BranchSnapshot>> {
    if (branch !== HUNSU_STATE_BRANCH) return ok({ headSha, files: {} });
    const stateTree = await this.#stateTreeBlobsAtHead(repository, headSha);
    if (!stateTree.ok) return stateTree;
    const blobs = stateTree.value.filter(blob => isReconstructionInputPath(blob.path.slice(".hunsu/".length)));
    const contents = await this.#blobs(repository, blobs);
    if (!contents.ok) return contents;
    const files: Record<string, string> = {};
    for (const blob of blobs) {
      const content = contents.value.get(blob.sha);
      if (content === undefined) return invalidResponse(`GitHub Hunsu state blob ${blob.sha} is missing content.`);
      Object.defineProperty(files, blob.path, {
        value: content,
        enumerable: true,
        configurable: true,
        writable: true
      });
    }
    return ok({ headSha, files });
  }

  async #stateTreeBlobsAtHead(
    repository: RepositoryLocator,
    headSha: string
  ): Promise<TransportResult<StateTreeBlob[]>> {
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
    if (!rootEntries || rootTree.value.truncated === true) {
      return invalidResponse("GitHub root tree response is missing entries or was truncated.");
    }
    const stateTreeSha = rootEntries.find(entry => isRecord(entry) && entry.path === ".hunsu" && entry.type === "tree" && typeof entry.sha === "string");
    if (!isRecord(stateTreeSha) || typeof stateTreeSha.sha !== "string") return ok([]);

    const stateRoot = await this.#request<Record<string, unknown>>(
      repository.installationId,
      `${repositoryPath(repository)}/git/trees/${encodeURIComponent(stateTreeSha.sha)}`
    );
    if (!stateRoot.ok) return stateRoot;
    const stateRootEntries = Array.isArray(stateRoot.value.tree) ? stateRoot.value.tree : undefined;
    if (!stateRootEntries || stateRoot.value.truncated === true) {
      return invalidResponse("GitHub Hunsu state root tree is missing entries or was truncated.");
    }
    const v2Tree = stateRootEntries.find(entry => isRecord(entry) && entry.path === "v2" && entry.type === "tree" && typeof entry.sha === "string");
    if (!isRecord(v2Tree) || typeof v2Tree.sha !== "string") return ok([]);

    const tree = await this.#request<Record<string, unknown>>(
      repository.installationId,
      `${repositoryPath(repository)}/git/trees/${encodeURIComponent(v2Tree.sha)}?recursive=1`
    );
    if (!tree.ok) return tree;
    const entries = Array.isArray(tree.value.tree) ? tree.value.tree : undefined;
    if (!entries || tree.value.truncated === true) return invalidResponse("GitHub Hunsu state tree is missing entries or was truncated.");

    const blobs: StateTreeBlob[] = [];
    for (const entry of entries) {
      if (!isRecord(entry) || entry.type !== "blob") continue;
      if (typeof entry.path !== "string" || typeof entry.sha !== "string") {
        return invalidResponse("GitHub Hunsu state tree contains an invalid blob entry.");
      }
      if (entry.size !== undefined && (!Number.isSafeInteger(entry.size) || (entry.size as number) < 0)) {
        return invalidResponse(`GitHub Hunsu state blob ${entry.path} has an invalid size.`);
      }
      blobs.push({
        path: `.hunsu/v2/${entry.path}`,
        sha: entry.sha,
        ...(typeof entry.size === "number" ? { size: entry.size } : {})
      });
    }
    return ok(blobs);
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
    return this.#referenceByName(repository, `heads/${branch}`);
  }

  async #referenceByName(repository: RepositoryLocator, refName: string): Promise<TransportResult<string | undefined>> {
    const response = await this.#request<Record<string, unknown>>(
      repository.installationId,
      `${repositoryPath(repository)}/git/ref/${encodeRef(refName)}`,
      { cache: "no-store" },
      false,
      true
    );
    if (!response.ok && response.error.code === "not_found") return ok(undefined);
    if (!response.ok) return response;
    const sha = readNestedString(response.value, "object", "sha");
    return sha && isFullSha(sha) ? ok(sha) : invalidResponse("GitHub ref is missing a valid full commit SHA.");
  }

  async #blob(repository: RepositoryLocator, sha: string, expectedSize: number): Promise<TransportResult<string>> {
    const response = await this.#request<Record<string, unknown>>(
      repository.installationId,
      `${repositoryPath(repository)}/git/blobs/${encodeURIComponent(sha)}`
    );
    if (!response.ok) return response;
    if (response.value.sha !== sha
      || response.value.size !== expectedSize
      || typeof response.value.content !== "string"
      || response.value.encoding !== "base64"
    ) {
      return invalidResponse(`GitHub REST returned the wrong object or size for Hunsu state blob ${sha}.`);
    }
    const compact = response.value.content.replace(/\s/gu, "");
    if (!isCanonicalBase64(compact)) return invalidResponse(`GitHub Hunsu state blob ${sha} is not canonical base64.`);
    const decoded = Buffer.from(compact, "base64");
    if (decoded.byteLength !== expectedSize || decoded.toString("base64") !== compact) {
      return invalidResponse(`GitHub Hunsu state blob ${sha} does not match its declared byte size.`);
    }
    const content = decoded.toString("utf8");
    return Buffer.from(content, "utf8").equals(decoded)
      ? ok(content)
      : invalidResponse(`GitHub Hunsu state blob ${sha} is not valid UTF-8 text.`);
  }

  async #blobs(
    repository: RepositoryLocator,
    blobs: readonly { sha: string; size?: number }[],
    options: { readonly maxFallbacks?: number } = {}
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
    const maxFallbackCount = Math.min(
      MAX_STATE_BLOB_REQUESTS_PER_READ - batchCount,
      options.maxFallbacks ?? Number.POSITIVE_INFINITY
    );
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
        if (!isRecord(value) || value.__typename !== "Blob" || value.oid !== expected.sha) {
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
          const fallback = await this.#blob(repository, expected.sha, value.byteSize as number);
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
    return this.#withInstallationRequestLock(
      installationId,
      () => this.#requestWithCooldown<T>(installationId, path, init, conflictOnValidation, allowNotFound)
    );
  }

  async #requestWithCooldown<T>(
    installationId: number,
    path: string,
    init: RequestInit,
    conflictOnValidation: boolean,
    allowNotFound: boolean
  ): Promise<TransportResult<T>> {
    const cooldown = this.#activeInstallationCooldown(installationId);
    if (cooldown) return failure(cooldown);
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const deadline = requestDeadline(init.signal, this.#requestTimeoutMs);
        try {
          const authority = await deadline.waitFor(this.#authorityProvider(installationId));
          const response = await deadline.waitFor(this.#fetch(`${this.#apiBaseUrl}${path}`, {
            ...init,
            signal: deadline.signal,
            headers: {
              accept: "application/vnd.github+json",
              authorization: `Bearer ${authority.token}`,
              "content-type": "application/json",
              "user-agent": GITHUB_USER_AGENT,
              "x-github-api-version": GITHUB_API_VERSION,
              ...init.headers
            }
          }));
          if (response.ok) {
            const body = await deadline.waitFor(response.json()) as T;
            const graphQlRateLimit = path === "/graphql" ? graphQlRateLimitMessage(body) : undefined;
            if (graphQlRateLimit) return this.#recordRateLimit(installationId, response, graphQlRateLimit);
            return ok(body);
          }

          if (response.status === 401 && attempt === 0 && this.#invalidateAuthority) {
            this.#invalidateAuthority(installationId, authority.token);
            continue;
          }

          const message = await deadline.waitFor(readErrorMessage(response));
          if (response.status === 404 && allowNotFound) return notFound(message);
          if (conflictOnValidation && (response.status === 409 || response.status === 422)) return conflict(message, response.status);
          if (isGitHubRateLimitResponse(response, message)) return this.#recordRateLimit(installationId, response, message);
          if (response.status === 401 || response.status === 403) return failure({ code: "forbidden", message, status: response.status });
          if (response.status === 404) return notFound(message);
          if (response.status === 409 || response.status === 422) return conflict(message, response.status);
          if (response.status >= 500) {
            const retryAfterSeconds = githubRetryAfterSeconds(
              response.headers,
              this.#now(),
              TRANSIENT_FAILURE_COOLDOWN_SECONDS
            );
            const requestId = response.headers.get("x-github-request-id");
            return this.#recordInstallationCooldown(
              installationId,
              {
                code: "invalid_response",
                message,
                status: response.status,
                retryAfterSeconds,
                ...(requestId ? { requestId } : {})
              },
              retryAfterSeconds
            );
          }
          return failure({ code: "invalid_response", message, status: response.status });
        } catch (error) {
          if (deadline.didTimeout()) throw new GitHubRequestTimeoutError();
          throw error;
        } finally {
          deadline.dispose();
        }
      }
      return invalidResponse("GitHub authority refresh did not produce a usable response.");
    } catch (error) {
      if (error instanceof GitHubAuthorityError) {
        const cooldownSeconds = error.transportError.retryAfterSeconds
          ?? (error.transportError.code === "forbidden"
            ? AUTHORITY_FORBIDDEN_COOLDOWN_SECONDS
            : TRANSIENT_FAILURE_COOLDOWN_SECONDS);
        return this.#recordInstallationCooldown(installationId, error.transportError, cooldownSeconds);
      }
      if (error instanceof GitHubRequestTimeoutError) {
        return this.#recordInstallationCooldown(
          installationId,
          {
            code: "network",
            message: "GitHub request timed out before receiving a complete response.",
            retryAfterSeconds: TRANSIENT_FAILURE_COOLDOWN_SECONDS
          },
          TRANSIENT_FAILURE_COOLDOWN_SECONDS
        );
      }
      const transportError: GitHubTransportError = {
        code: "network",
        message: "GitHub request failed before receiving a usable response.",
        retryAfterSeconds: TRANSIENT_FAILURE_COOLDOWN_SECONDS
      };
      return this.#recordInstallationCooldown(
        installationId,
        transportError,
        TRANSIENT_FAILURE_COOLDOWN_SECONDS
      );
    }
  }

  async #withInstallationRequestLock<T>(installationId: number, operation: () => Promise<T>): Promise<T> {
    const previous = this.#installationRequestTails.get(installationId) ?? Promise.resolve();
    let release = (): void => {};
    const current = new Promise<void>(resolve => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.#installationRequestTails.set(installationId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#installationRequestTails.get(installationId) === tail) {
        this.#installationRequestTails.delete(installationId);
      }
    }
  }

  #activeInstallationCooldown(installationId: number): GitHubTransportError | undefined {
    const now = this.#now();
    this.#pruneInstallationCooldowns(now);
    const cooldown = this.#installationCooldowns.get(installationId);
    if (!cooldown) return undefined;
    this.#installationCooldowns.delete(installationId);
    this.#installationCooldowns.set(installationId, cooldown);
    const error = cooldown.error;
    return {
      code: error.code,
      message: error.message,
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(error.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: Math.max(1, Math.ceil((cooldown.retryAt - now) / 1_000)) }),
      ...(error.requestId === undefined ? {} : { requestId: error.requestId })
    };
  }

  #recordRateLimit(
    installationId: number,
    response: Response,
    message: string
  ): TransportResult<never> {
    const error = githubRateLimitError(response, message, this.#now());
    return this.#recordInstallationCooldown(
      installationId,
      error,
      error.retryAfterSeconds ?? 60
    );
  }

  #recordInstallationCooldown(
    installationId: number,
    error: GitHubTransportError,
    cooldownSeconds: number
  ): TransportResult<never> {
    const now = this.#now();
    const retryAt = now + cooldownSeconds * 1_000;
    const current = this.#installationCooldowns.get(installationId);
    if (!current || current.retryAt <= retryAt) {
      this.#installationCooldowns.delete(installationId);
      this.#installationCooldowns.set(installationId, {
        retryAt,
        error: {
          code: error.code,
          message: error.message,
          ...(error.status === undefined ? {} : { status: error.status }),
          ...(error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds }),
          ...(error.requestId === undefined ? {} : { requestId: error.requestId })
        }
      });
    }
    this.#pruneInstallationCooldowns(now);
    while (this.#installationCooldowns.size > MAX_INSTALLATION_COOLDOWNS) {
      const oldest = this.#installationCooldowns.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      this.#installationCooldowns.delete(oldest);
    }
    return failure(error);
  }

  #pruneInstallationCooldowns(now: number): void {
    for (const [installationId, cooldown] of this.#installationCooldowns) {
      if (cooldown.retryAt <= now) this.#installationCooldowns.delete(installationId);
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
        __typename
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

function graphqlExactStateObjectsRequest(
  repository: RepositoryLocator,
  stateHeadSha: string,
  selections: readonly ResolvedStateFileSelection[]
): { query: string; variables: Record<string, string> } {
  const declarations = selections.map((_, index) => `$expr${index}: String!`).join(", ");
  const objects = selections.map((_, index) => `
    b${index}: object(expression: $expr${index}) {
      __typename
      oid
      ... on Blob {
        byteSize
        isBinary
      }
    }`).join("");
  return {
    query: `query ResolveExactHunsuState($owner: String!, $name: String!, $head: GitObjectID!, $v2: String!, ${declarations}) {
  repository(owner: $owner, name: $name) {
    head: object(oid: $head) { __typename oid }
    v2: object(expression: $v2) { __typename oid }${objects}
  }
}`,
    variables: {
      owner: repository.owner,
      name: repository.name,
      head: stateHeadSha,
      v2: `${stateHeadSha}:.hunsu/v2`,
      ...Object.fromEntries(selections.map((selection, index) => [
        `expr${index}`,
        `${stateHeadSha}:${selection.path}`
      ]))
    }
  };
}

function graphqlManagedNodeRefsRequest(
  repository: RepositoryLocator,
  refPrefix: string,
  cursor: string | undefined
): { query: string; variables: Record<string, string | number | null> } {
  return {
    query: `query ReadHunsuManagedNodeRefs($owner: String!, $name: String!, $refPrefix: String!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    refs(refPrefix: $refPrefix, first: $first, after: $after) {
      nodes {
        prefix
        name
        target {
          __typename
          ... on Commit {
            oid
            message
            tree { oid }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`,
    variables: {
      owner: repository.owner,
      name: repository.name,
      refPrefix,
      first: GRAPHQL_REF_PAGE_SIZE,
      after: cursor ?? null
    }
  };
}

function graphqlExactManagedNodeRefsRequest(
  repository: RepositoryLocator,
  projectId: string,
  nodeShas: readonly string[]
): { query: string; variables: Record<string, string> } {
  const declarations = nodeShas.map((_, index) => `$ref${index}: String!`).join(", ");
  const refs = nodeShas.map((_, index) => `
    r${index}: ref(qualifiedName: $ref${index}) {
      target {
        __typename
        ... on Commit { oid message tree { oid } }
      }
    }`).join("");
  return {
    query: `query ReadExactHunsuManagedNodeRefs($owner: String!, $name: String!, ${declarations}) {
  repository(owner: $owner, name: $name) {${refs}
  }
}`,
    variables: {
      owner: repository.owner,
      name: repository.name,
      ...Object.fromEntries(nodeShas.map((sha, index) => [`ref${index}`, `refs/tags/hunsu/node/${projectId}/${sha}`]))
    }
  };
}

function repositoryPath(repository: RepositoryLocator): string {
  return `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
}

function requestDeadline(source: AbortSignal | null | undefined, timeoutMs: number): {
  signal: AbortSignal;
  waitFor<T>(operation: Promise<T>): Promise<T>;
  didTimeout(): boolean;
  dispose(): void;
} {
  const controller = new AbortController();
  let timedOut = false;
  let rejectTimeout!: (reason: GitHubRequestTimeoutError) => void;
  const expired = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const forwardAbort = () => controller.abort(source?.reason);
  if (source?.aborted) forwardAbort();
  else source?.addEventListener("abort", forwardAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
    rejectTimeout(new GitHubRequestTimeoutError());
  }, timeoutMs);
  return {
    signal: controller.signal,
    waitFor: operation => Promise.race([operation, expired]),
    didTimeout: () => timedOut,
    dispose: () => {
      clearTimeout(timeout);
      source?.removeEventListener("abort", forwardAbort);
    }
  };
}

function encodeRef(ref: string): string {
  return ref.split("/").map(encodeURIComponent).join("/");
}

function isReconstructionInputPath(path: string): boolean {
  return /^v2\/projects\/[^/]+\/events\/\d{4}\/\d{2}\/[0-9a-f]{32}\.json$/u.test(path);
}

function decodeCommit(input: Record<string, unknown>, expectedSha?: string): TransportResult<CommitSnapshot> {
  if (typeof input.sha !== "string" || !isFullSha(input.sha) || (expectedSha !== undefined && input.sha !== expectedSha)) {
    return invalidResponse("GitHub commit response has an invalid SHA.");
  }
  const treeSha = readNestedString(input, "tree", "sha");
  const parents = Array.isArray(input.parents) ? input.parents : undefined;
  if (!treeSha || !isFullSha(treeSha) || !parents || typeof input.message !== "string" || input.message.trim() === "") {
    return invalidResponse("GitHub commit response is missing its tree, parents, or message.");
  }
  const parentShas: string[] = [];
  for (const parent of parents) {
    if (!isRecord(parent) || typeof parent.sha !== "string" || !isFullSha(parent.sha)) {
      return invalidResponse("GitHub commit response contains an invalid parent.");
    }
    parentShas.push(parent.sha);
  }
  return ok({ sha: input.sha, treeSha, parentShas, message: input.message });
}

function isManagedRef(ref: string): boolean {
  return /^refs\/(?:heads\/hunsu\/|tags\/hunsu\/)[A-Za-z0-9._/-]+$/u.test(ref) && !ref.includes("..") && !ref.includes("//");
}

function isFullSha(value: string): boolean {
  return /^[0-9a-f]{40}$/u.test(value);
}

function exactStateFileByteLimit(selection: StateFileSelection): number {
  switch (selection.kind) {
    case "workspace":
      return MAX_WORKSPACE_BYTES;
    case "project_read_model":
    case "graph_page":
    case "graph_node":
    case "node_activity_index":
    case "node_activity_page":
    case "node_activity_record":
    case "run_activity":
    case "event_index_shard":
    case "event_locator":
      return MAX_READ_MODEL_BYTES;
    case "node_payload":
      return MAX_NODE_PAYLOAD_BYTES;
    case "event":
      return MAX_EVENT_BYTES;
  }
}

function exactStateReadCacheKey(
  repository: RepositoryLocator,
  stateHeadSha: string,
  selections: readonly ResolvedStateFileSelection[]
): string {
  return JSON.stringify([
    repository.installationId,
    repository.repositoryId,
    repository.owner,
    repository.name,
    stateHeadSha,
    selections.map(selection => selection.path)
  ]);
}

function cloneStateFileSnapshot(snapshot: StateFileSnapshot): StateFileSnapshot {
  const files: Record<string, string> = {};
  for (const [path, content] of Object.entries(snapshot.files)) {
    Object.defineProperty(files, path, {
      value: content,
      enumerable: true,
      configurable: true,
      writable: true
    });
  }
  return { stateHeadSha: snapshot.stateHeadSha, v2State: snapshot.v2State, files };
}

function cloneStateFileResult(result: TransportResult<StateFileSnapshot>): TransportResult<StateFileSnapshot> {
  return result.ok ? ok(cloneStateFileSnapshot(result.value)) : result;
}

function isCanonicalBase64(value: string): boolean {
  return value.length % 4 === 0
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value);
}

function isCanonicalTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value;
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

export function isGitHubRateLimitResponse(response: Response, message: string): boolean {
  if (response.status !== 403 && response.status !== 429) return false;
  return response.status === 429
    || response.headers.get("x-ratelimit-remaining") === "0"
    || response.headers.has("retry-after")
    || /(?:secondary\s+)?rate\s+limit/iu.test(message);
}

function graphQlRateLimitMessage(body: unknown): string | undefined {
  if (!isRecord(body) || !Array.isArray(body.errors)) return undefined;
  const messages = body.errors.flatMap(error => isRecord(error) && typeof error.message === "string" ? [error.message] : []);
  return messages.find(message => /(?:secondary\s+)?rate\s+limit/iu.test(message));
}

export function githubRateLimitError(response: Response, message: string, now: number): GitHubTransportError {
  return {
    code: "rate_limited",
    message,
    status: response.status,
    retryAfterSeconds: githubRetryAfterSeconds(response.headers, now),
    ...(response.headers.get("x-github-request-id")
      ? { requestId: response.headers.get("x-github-request-id")! }
      : {})
  };
}

export function githubRetryAfterSeconds(headers: Headers, now: number, fallbackSeconds = 60): number {
  const declared = headers.get("retry-after");
  if (declared) {
    const seconds = Number(declared);
    if (Number.isSafeInteger(seconds) && seconds >= 0) return Math.max(1, seconds);
    const retryAt = Date.parse(declared);
    if (Number.isFinite(retryAt)) return Math.max(1, Math.ceil((retryAt - now) / 1_000));
  }
  if (headers.get("x-ratelimit-remaining") === "0") {
    const declaredReset = headers.get("x-ratelimit-reset");
    const resetAtSeconds = declaredReset === null || declaredReset.trim() === ""
      ? Number.NaN
      : Number(declaredReset);
    if (Number.isSafeInteger(resetAtSeconds) && resetAtSeconds >= 0) {
      return Math.max(1, Math.ceil((resetAtSeconds * 1_000 - now) / 1_000));
    }
  }
  return fallbackSeconds;
}

function conflict(message: string, status?: number): TransportResult<never> {
  return failure({ code: "conflict", message, status });
}

function notFound(message: string): TransportResult<never> {
  return failure({ code: "not_found", message, status: 404 });
}
