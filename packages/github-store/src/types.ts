export const HUNSU_STATE_BRANCH = "hunsu/state" as const;

export type RepositoryLocator = {
  installationId: number;
  repositoryId: number;
  owner: string;
  name: string;
  defaultBranch: string;
};

export type RepositoryGrant = RepositoryLocator & {
  private: boolean;
  permissions: {
    contents: "read" | "write";
  };
};

export type BranchSnapshot = {
  headSha: string;
  files: Readonly<Record<string, string>>;
};

export type FileUpdate = {
  path: string;
  content: string;
};

export type CompareStatus = "ahead" | "behind" | "diverged" | "identical";

export type GitHubTransportError = {
  code: "not_found" | "forbidden" | "conflict" | "invalid_response" | "rate_limited" | "network";
  message: string;
  status?: number;
  retryAfterSeconds?: number;
  requestId?: string;
};

export class GitHubAuthorityError extends Error {
  readonly transportError: GitHubTransportError;

  constructor(error: GitHubTransportError) {
    super(error.message);
    this.name = "GitHubAuthorityError";
    this.transportError = {
      code: error.code,
      message: error.message,
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds }),
      ...(error.requestId === undefined ? {} : { requestId: error.requestId })
    };
  }
}

export type TransportResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: GitHubTransportError };

export interface GitHubTransport {
  listInstallationRepositories(installationId: number): Promise<TransportResult<RepositoryGrant[]>>;
  readBranchHead(repository: RepositoryLocator, branch: string): Promise<TransportResult<string | undefined>>;
  readBranch(repository: RepositoryLocator, branch: string): Promise<TransportResult<BranchSnapshot | undefined>>;
  createBranch(repository: RepositoryLocator, branch: string, fromSha: string): Promise<TransportResult<BranchSnapshot>>;
  commitFiles(input: {
    repository: RepositoryLocator;
    branch: string;
    expectedHeadSha: string;
    message: string;
    updates: readonly FileUpdate[];
  }): Promise<TransportResult<string>>;
  compareCommits(repository: RepositoryLocator, baseSha: string, headSha: string): Promise<TransportResult<CompareStatus>>;
  commitExists(repository: RepositoryLocator, sha: string): Promise<TransportResult<boolean>>;
}

export type StateActor =
  | { kind: "user"; id: string }
  | { kind: "plugin"; userId: string; clientId: string }
  | { kind: "system"; operation: "reconcile" | "rebuild" };

export type StoredProjectEvent<Event> = {
  schema: "hunsu.project-event.v1";
  eventId: string;
  projectId: string;
  repository: {
    installationId: number;
    repositoryId: number;
    owner: string;
    name: string;
  };
  idempotencyKeyHash: string;
  commandHash: string;
  previousStateSha: string;
  sequence: number;
  actor: StateActor;
  occurredAt: string;
  event: Event;
};

export type StoreError = {
  code:
    | "state_not_found"
    | "project_not_found"
    | "stale_state"
    | "idempotency_conflict"
    | "invalid_event"
    | "unsafe_state"
    | "transport";
  message: string;
  expectedHeadSha?: string;
  actualHeadSha?: string;
  cause?: GitHubTransportError;
};

export type StoreResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: StoreError };

export type ProjectStateCodec<Event, State> = {
  projectId(state: State): string;
  decodeEvent(input: unknown): StoreResult<Event>;
  replay(events: readonly Event[]): StoreResult<State>;
  materialize(state: State): Readonly<Record<string, unknown>>;
};

export type AppendProjectCommand<Event, State> = {
  repository: RepositoryLocator;
  projectId: string;
  baseSha: string;
  expectedHeadSha?: string;
  idempotencyKey: string;
  occurredAt: string;
  actor: StateActor;
  command: unknown;
  decide: (current: State | undefined) => StoreResult<readonly Event[]>;
};

export type AppendProjectResult<State> = {
  state: State;
  stateHeadSha: string;
  idempotentReplay: boolean;
};

export type ReconstructedProject<State> = {
  state: State;
  stateHeadSha: string;
  eventCount: number;
};

export type ReconstructedRepository<State> =
  | {
      kind: "state_branch_missing";
      projects: readonly [];
    }
  | {
      kind: "state_branch";
      stateHeadSha: string;
      projects: readonly ReconstructedProject<State>[];
    };
