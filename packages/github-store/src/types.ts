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

export type ProjectReadModelName = "catalog" | "graph" | "activity" | "event_index";

/**
 * A closed set of state resources that ordinary read paths may request. Keeping
 * this structural (rather than accepting arbitrary paths or prefixes) prevents a
 * dashboard read from accidentally turning into a full event-stream download.
 */
export type StateFileSelection =
  | { readonly kind: "workspace" }
  | {
      readonly kind: "project_read_model";
      readonly projectId: string;
      readonly model: ProjectReadModelName;
    }
  | {
      readonly kind: "node_payload";
      readonly projectId: string;
      readonly nodeSha: string;
    }
  | {
      readonly kind: "graph_page";
      readonly projectId: string;
      readonly page: number;
    }
  | {
      readonly kind: "graph_node";
      readonly projectId: string;
      readonly nodeSha: string;
    }
  | {
      readonly kind: "node_activity";
      readonly projectId: string;
      readonly nodeSha: string;
    }
  | {
      readonly kind: "run_activity";
      readonly projectId: string;
      readonly runId: string;
    }
  | {
      readonly kind: "event_index_shard";
      readonly projectId: string;
      readonly shard: number;
    }
  | {
      readonly kind: "event_locator";
      readonly projectId: string;
      readonly eventId: string;
    }
  | {
      readonly kind: "event";
      readonly projectId: string;
      readonly year: number;
      readonly month: number;
      readonly eventId: string;
    };

export type StateFileSnapshot = {
  /** The exact commit supplied by the caller; this API never resolves latest. */
  readonly stateHeadSha: string;
  /** Whether this exact commit contains the v2 state root. */
  readonly v2State: "absent" | "present";
  readonly files: Readonly<Record<string, string>>;
};

export type CommitSnapshot = {
  sha: string;
  treeSha: string;
  parentShas: readonly string[];
  message: string;
};

export type ManagedNodeAnchorSnapshot = {
  managedRef: string;
  nodeSha: string;
  treeSha: string;
  commitMessage: string;
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
  readStateFilesAtHead(
    repository: RepositoryLocator,
    stateHeadSha: string,
    selections: readonly StateFileSelection[]
  ): Promise<TransportResult<StateFileSnapshot>>;
  createBranch(repository: RepositoryLocator, branch: string, fromSha: string): Promise<TransportResult<BranchSnapshot>>;
  listManagedNodeAnchors(repository: RepositoryLocator, projectId: string): Promise<TransportResult<ManagedNodeAnchorSnapshot[]>>;
  readManagedNodeAnchors(
    repository: RepositoryLocator,
    projectId: string,
    nodeShas: readonly string[]
  ): Promise<TransportResult<ManagedNodeAnchorSnapshot[]>>;
  readRef(repository: RepositoryLocator, ref: string): Promise<TransportResult<string | undefined>>;
  createRef(repository: RepositoryLocator, ref: string, sha: string): Promise<TransportResult<string>>;
  readCommit(repository: RepositoryLocator, sha: string): Promise<TransportResult<CommitSnapshot | undefined>>;
  createCommit(input: {
    repository: RepositoryLocator;
    parentSha: string;
    treeSha: string;
    message: string;
    timestamp: string;
  }): Promise<TransportResult<CommitSnapshot>>;
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
  schema: "hunsu.project-event.v2";
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
  commandEventCount: number;
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
    | "integrity"
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

export type NodeStateAnchor = {
  projectId: string;
  nodeSha: string;
  treeSha: string;
  managedRef: string;
  commitTitle: string;
};

export type ProjectStateCodec<Event, State> = {
  projectId(state: State): string;
  nodeAnchors(state: State): readonly NodeStateAnchor[];
  encodeEvent(event: Event): StoreResult<unknown>;
  decodeEvent(input: unknown): StoreResult<Event>;
  replay(events: readonly Event[]): StoreResult<State>;
  materialize(
    state: State,
    events: readonly StoredProjectEvent<Event>[]
  ): StoreResult<Readonly<Record<string, unknown>>>;
};

export type AppendProjectCommand<Event, State> = {
  repository: RepositoryLocator;
  projectId: string;
  baseSha: string;
  expectedHeadSha: string;
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

export type ReconstructedProject<State, Event = unknown> = {
  state: State;
  stateHeadSha: string;
  eventCount: number;
  events: readonly StoredProjectEvent<Event>[];
};

export type ReconstructedRepository<State, Event = unknown> =
  | {
      kind: "state_branch_missing";
      projects: readonly [];
    }
  | {
      kind: "state_branch";
      stateHeadSha: string;
      projects: readonly ReconstructedProject<State, Event>[];
    };
