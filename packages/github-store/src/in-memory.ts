import { canonicalJson, sha256 } from "./canonical-json.ts";
import { resolveStateFileSelections } from "./state-files.ts";
import type {
  BranchSnapshot,
  CommitSnapshot,
  CompareStatus,
  FileUpdate,
  GitHubTransport,
  ManagedNodeAnchorSnapshot,
  RepositoryGrant,
  RepositoryLocator,
  StateFileSelection,
  StateFileSnapshot,
  TransportResult
} from "./types.ts";

type MemoryCommit = {
  sha: string;
  treeSha: string;
  parents: string[];
  message: string;
  files: Record<string, string>;
};

type MemoryRepository = {
  grant: RepositoryGrant;
  branches: Map<string, string>;
  refs: Map<string, string>;
  commits: Map<string, MemoryCommit>;
};

export type MemoryRepositorySeed = {
  repository: RepositoryGrant;
  initialSha: string;
  initialFiles?: Record<string, string>;
  initialMessage?: string;
  branches?: Record<string, string>;
};

export class MemoryGitHubTransport implements GitHubTransport {
  readonly #repositories = new Map<string, MemoryRepository>();

  constructor(seeds: readonly MemoryRepositorySeed[] = []) {
    for (const seed of seeds) this.addRepository(seed);
  }

  addRepository(seed: MemoryRepositorySeed): void {
    const commits = new Map<string, MemoryCommit>();
    commits.set(seed.initialSha, {
      sha: seed.initialSha,
      treeSha: treeSha(seed.initialFiles ?? {}),
      parents: [],
      message: seed.initialMessage ?? "Initial commit",
      files: { ...(seed.initialFiles ?? {}) }
    });
    const branches = new Map<string, string>(Object.entries(seed.branches ?? {
      [seed.repository.defaultBranch]: seed.initialSha
    }));
    const refs = new Map<string, string>([...branches].map(([branch, sha]) => [`refs/heads/${branch}`, sha]));
    this.#repositories.set(repositoryKey(seed.repository), { grant: seed.repository, branches, refs, commits });
  }

  async listInstallationRepositories(installationId: number): Promise<TransportResult<RepositoryGrant[]>> {
    return ok([...this.#repositories.values()]
      .map(value => value.grant)
      .filter(repository => repository.installationId === installationId)
      .map(repository => structuredClone(repository)));
  }

  async readBranchHead(repository: RepositoryLocator, branch: string): Promise<TransportResult<string | undefined>> {
    const found = this.#repository(repository);
    return found.ok ? ok(found.value.branches.get(branch)) : found;
  }

  async readBranch(repository: RepositoryLocator, branch: string): Promise<TransportResult<BranchSnapshot | undefined>> {
    const found = this.#repository(repository);
    if (!found.ok) return found;
    const sha = found.value.branches.get(branch);
    if (!sha) return ok(undefined);
    const commit = found.value.commits.get(sha);
    if (!commit) return invalid(`Branch ${branch} points to an unknown commit.`);
    return ok({ headSha: sha, files: { ...commit.files } });
  }

  async readStateFilesAtHead(
    repository: RepositoryLocator,
    stateHeadSha: string,
    selections: readonly StateFileSelection[]
  ): Promise<TransportResult<StateFileSnapshot>> {
    const found = this.#repository(repository);
    if (!found.ok) return found;
    if (!/^[0-9a-f]{40}$/u.test(stateHeadSha)) return invalid("Exact state reads require a full lowercase Git SHA.");
    const commit = found.value.commits.get(stateHeadSha);
    if (!commit) return notFound(`State commit ${stateHeadSha} does not exist.`);
    const selected = resolveStateFileSelections(selections);
    if (!selected.ok) return selected;
    const hasV2State = Object.keys(commit.files).some(path => path === ".hunsu/v2" || path.startsWith(".hunsu/v2/"));
    if (!hasV2State) {
      return selected.value.every(({ selection }) => selection.kind === "workspace")
        ? ok({ stateHeadSha, v2State: "absent", files: {} })
        : notFound(`Hunsu v2 state does not exist at commit ${stateHeadSha}.`);
    }
    const files: Record<string, string> = {};
    for (const { path } of selected.value) {
      const content = commit.files[path];
      if (content === undefined) return notFound(`Required Hunsu state resource ${path} does not exist at the requested state head.`);
      Object.defineProperty(files, path, {
        value: content,
        enumerable: true,
        configurable: true,
        writable: true
      });
    }
    return ok({ stateHeadSha, v2State: "present", files });
  }

  async createBranch(repository: RepositoryLocator, branch: string, fromSha: string): Promise<TransportResult<BranchSnapshot>> {
    const found = this.#repository(repository);
    if (!found.ok) return found;
    if (found.value.branches.has(branch)) return conflict(`Branch ${branch} already exists.`);
    const commit = found.value.commits.get(fromSha);
    if (!commit) return notFound(`Commit ${fromSha} does not exist.`);
    found.value.branches.set(branch, fromSha);
    found.value.refs.set(`refs/heads/${branch}`, fromSha);
    return ok({ headSha: fromSha, files: { ...commit.files } });
  }

  async listManagedNodeAnchors(repository: RepositoryLocator, projectId: string): Promise<TransportResult<ManagedNodeAnchorSnapshot[]>> {
    const found = this.#repository(repository);
    if (!found.ok) return found;
    const prefix = `refs/tags/hunsu/node/${projectId}/`;
    const anchors: ManagedNodeAnchorSnapshot[] = [];
    for (const [managedRef, nodeSha] of found.value.refs) {
      if (!managedRef.startsWith(prefix)) continue;
      const commit = found.value.commits.get(nodeSha);
      if (!commit) return invalid(`Managed Node ref ${managedRef} points to an unknown commit.`);
      anchors.push({ managedRef, nodeSha, treeSha: commit.treeSha, commitMessage: commit.message });
    }
    anchors.sort((left, right) => left.managedRef.localeCompare(right.managedRef));
    return ok(anchors);
  }

  async readManagedNodeAnchors(
    repository: RepositoryLocator,
    projectId: string,
    nodeShas: readonly string[]
  ): Promise<TransportResult<ManagedNodeAnchorSnapshot[]>> {
    const found = this.#repository(repository);
    if (!found.ok) return found;
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(projectId)
      || nodeShas.length === 0 || nodeShas.length > 300
      || new Set(nodeShas).size !== nodeShas.length
      || nodeShas.some(sha => !/^[0-9a-f]{40}$/u.test(sha))
    ) return invalid("Exact managed Node reads require 1 to 300 unique full SHAs and a safe Project id.");
    const anchors: ManagedNodeAnchorSnapshot[] = [];
    for (const nodeSha of nodeShas) {
      const managedRef = `refs/tags/hunsu/node/${projectId}/${nodeSha}`;
      const target = found.value.refs.get(managedRef);
      if (target !== nodeSha) return notFound(`Managed Node ref ${managedRef} does not resolve to ${nodeSha}.`);
      const commit = found.value.commits.get(nodeSha);
      if (!commit) return invalid(`Managed Node ref ${managedRef} points to an unknown commit.`);
      anchors.push({ managedRef, nodeSha, treeSha: commit.treeSha, commitMessage: commit.message });
    }
    return ok(anchors);
  }

  async readRef(repository: RepositoryLocator, ref: string): Promise<TransportResult<string | undefined>> {
    const found = this.#repository(repository);
    return found.ok ? ok(found.value.refs.get(ref)) : found;
  }

  async createRef(repository: RepositoryLocator, ref: string, sha: string): Promise<TransportResult<string>> {
    const found = this.#repository(repository);
    if (!found.ok) return found;
    if (found.value.refs.has(ref)) return conflict(`Ref ${ref} already exists.`);
    if (!found.value.commits.has(sha)) return notFound(`Commit ${sha} does not exist.`);
    found.value.refs.set(ref, sha);
    return ok(sha);
  }

  async readCommit(repository: RepositoryLocator, sha: string): Promise<TransportResult<CommitSnapshot | undefined>> {
    const found = this.#repository(repository);
    if (!found.ok) return found;
    const commit = found.value.commits.get(sha);
    return ok(commit ? { sha: commit.sha, treeSha: commit.treeSha, parentShas: [...commit.parents], message: commit.message } : undefined);
  }

  async createCommit(input: {
    repository: RepositoryLocator;
    parentSha: string;
    treeSha: string;
    message: string;
    timestamp: string;
  }): Promise<TransportResult<CommitSnapshot>> {
    const found = this.#repository(input.repository);
    if (!found.ok) return found;
    const parent = found.value.commits.get(input.parentSha);
    if (!parent) return notFound(`Parent commit ${input.parentSha} does not exist.`);
    if (parent.treeSha !== input.treeSha) return invalid("Metadata commit tree must match its source tree in memory transport.");
    const sha = sha256(canonicalJson({
      repository: repositoryKey(input.repository),
      parentSha: input.parentSha,
      treeSha: input.treeSha,
      message: input.message,
      timestamp: input.timestamp
    })).slice(0, 40);
    const commit = { sha, treeSha: input.treeSha, parents: [input.parentSha], message: input.message, files: { ...parent.files } };
    found.value.commits.set(sha, commit);
    return ok({ sha, treeSha: commit.treeSha, parentShas: [...commit.parents], message: commit.message });
  }

  async commitFiles(input: {
    repository: RepositoryLocator;
    branch: string;
    expectedHeadSha: string;
    message: string;
    updates: readonly FileUpdate[];
  }): Promise<TransportResult<string>> {
    const found = this.#repository(input.repository);
    if (!found.ok) return found;
    const head = found.value.branches.get(input.branch);
    if (head !== input.expectedHeadSha) {
      return conflict(`Expected ${input.branch} at ${input.expectedHeadSha}, found ${head ?? "no ref"}.`);
    }
    const parent = found.value.commits.get(input.expectedHeadSha);
    if (!parent) return notFound(`Parent commit ${input.expectedHeadSha} does not exist.`);
    const files = { ...parent.files };
    for (const update of input.updates) files[update.path] = update.content;
    const sha = sha256(canonicalJson({
      repository: repositoryKey(input.repository),
      parent: input.expectedHeadSha,
      message: input.message,
      files
    })).slice(0, 40);
    found.value.commits.set(sha, { sha, treeSha: treeSha(files), parents: [input.expectedHeadSha], message: input.message, files });
    found.value.branches.set(input.branch, sha);
    found.value.refs.set(`refs/heads/${input.branch}`, sha);
    return ok(sha);
  }

  async compareCommits(repository: RepositoryLocator, baseSha: string, headSha: string): Promise<TransportResult<CompareStatus>> {
    const found = this.#repository(repository);
    if (!found.ok) return found;
    if (!found.value.commits.has(baseSha) || !found.value.commits.has(headSha)) {
      return notFound("Cannot compare unknown commits.");
    }
    if (baseSha === headSha) return ok("identical");
    if (isAncestor(found.value, baseSha, headSha)) return ok("ahead");
    if (isAncestor(found.value, headSha, baseSha)) return ok("behind");
    return ok("diverged");
  }

  async commitExists(repository: RepositoryLocator, sha: string): Promise<TransportResult<boolean>> {
    const found = this.#repository(repository);
    return found.ok ? ok(found.value.commits.has(sha)) : found;
  }

  addCommit(input: {
    repository: RepositoryLocator;
    branch: string;
    parentSha: string;
    files?: Record<string, string>;
    message?: string;
  }): TransportResult<string> {
    const found = this.#repository(input.repository);
    if (!found.ok) return found;
    const parent = found.value.commits.get(input.parentSha);
    if (!parent) return notFound(`Parent commit ${input.parentSha} does not exist.`);
    const files = { ...parent.files, ...(input.files ?? {}) };
    const sha = sha256(canonicalJson({
      repository: repositoryKey(input.repository),
      branch: input.branch,
      parent: input.parentSha,
      message: input.message ?? "test commit",
      files,
      ordinal: found.value.commits.size
    })).slice(0, 40);
    found.value.commits.set(sha, { sha, treeSha: treeSha(files), parents: [input.parentSha], message: input.message ?? "test commit", files });
    found.value.branches.set(input.branch, sha);
    found.value.refs.set(`refs/heads/${input.branch}`, sha);
    return ok(sha);
  }

  setBranch(repository: RepositoryLocator, branch: string, sha: string): TransportResult<void> {
    const found = this.#repository(repository);
    if (!found.ok) return found;
    if (!found.value.commits.has(sha)) return notFound(`Commit ${sha} does not exist.`);
    found.value.branches.set(branch, sha);
    found.value.refs.set(`refs/heads/${branch}`, sha);
    return ok(undefined);
  }

  #repository(repository: RepositoryLocator): TransportResult<MemoryRepository> {
    const value = this.#repositories.get(repositoryKey(repository));
    return value ? ok(value) : notFound(`Repository ${repository.owner}/${repository.name} is not granted.`);
  }
}

function treeSha(files: Record<string, string>): string {
  return sha256(canonicalJson(Object.entries(files).sort(([left], [right]) => left.localeCompare(right)))).slice(0, 40);
}

function isAncestor(repository: MemoryRepository, ancestor: string, descendant: string): boolean {
  const pending = [descendant];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const sha = pending.pop();
    if (!sha || visited.has(sha)) continue;
    if (sha === ancestor) return true;
    visited.add(sha);
    pending.push(...(repository.commits.get(sha)?.parents ?? []));
  }
  return false;
}

function repositoryKey(repository: Pick<RepositoryLocator, "installationId" | "repositoryId">): string {
  return `${repository.installationId}:${repository.repositoryId}`;
}

function ok<T>(value: T): TransportResult<T> {
  return { ok: true, value };
}

function conflict(message: string): TransportResult<never> {
  return { ok: false, error: { code: "conflict", message, status: 409 } };
}

function notFound(message: string): TransportResult<never> {
  return { ok: false, error: { code: "not_found", message, status: 404 } };
}

function invalid(message: string): TransportResult<never> {
  return { ok: false, error: { code: "invalid_response", message } };
}
