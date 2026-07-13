import { canonicalJson, sha256 } from "./canonical-json.ts";
import type {
  BranchSnapshot,
  CompareStatus,
  FileUpdate,
  GitHubTransport,
  RepositoryGrant,
  RepositoryLocator,
  TransportResult
} from "./types.ts";

type MemoryCommit = {
  sha: string;
  parents: string[];
  files: Record<string, string>;
};

type MemoryRepository = {
  grant: RepositoryGrant;
  branches: Map<string, string>;
  commits: Map<string, MemoryCommit>;
};

export type MemoryRepositorySeed = {
  repository: RepositoryGrant;
  initialSha: string;
  initialFiles?: Record<string, string>;
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
      parents: [],
      files: { ...(seed.initialFiles ?? {}) }
    });
    const branches = new Map<string, string>(Object.entries(seed.branches ?? {
      [seed.repository.defaultBranch]: seed.initialSha
    }));
    this.#repositories.set(repositoryKey(seed.repository), { grant: seed.repository, branches, commits });
  }

  async listInstallationRepositories(installationId: number): Promise<TransportResult<RepositoryGrant[]>> {
    return ok([...this.#repositories.values()]
      .map(value => value.grant)
      .filter(repository => repository.installationId === installationId)
      .map(repository => structuredClone(repository)));
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

  async createBranch(repository: RepositoryLocator, branch: string, fromSha: string): Promise<TransportResult<string>> {
    const found = this.#repository(repository);
    if (!found.ok) return found;
    if (found.value.branches.has(branch)) return conflict(`Branch ${branch} already exists.`);
    if (!found.value.commits.has(fromSha)) return notFound(`Commit ${fromSha} does not exist.`);
    found.value.branches.set(branch, fromSha);
    return ok(fromSha);
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
    found.value.commits.set(sha, { sha, parents: [input.expectedHeadSha], files });
    found.value.branches.set(input.branch, sha);
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
    found.value.commits.set(sha, { sha, parents: [input.parentSha], files });
    found.value.branches.set(input.branch, sha);
    return ok(sha);
  }

  setBranch(repository: RepositoryLocator, branch: string, sha: string): TransportResult<void> {
    const found = this.#repository(repository);
    if (!found.ok) return found;
    if (!found.value.commits.has(sha)) return notFound(`Commit ${sha} does not exist.`);
    found.value.branches.set(branch, sha);
    return ok(undefined);
  }

  #repository(repository: RepositoryLocator): TransportResult<MemoryRepository> {
    const value = this.#repositories.get(repositoryKey(repository));
    return value ? ok(value) : notFound(`Repository ${repository.owner}/${repository.name} is not granted.`);
  }
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
