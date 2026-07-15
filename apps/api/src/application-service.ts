import { createHash } from "node:crypto";
import { applyProjectCommand, emptyProjectState, inheritRunChildPlan, type ProjectIntegrityBoundary } from "@hunsu/core";
import {
  decodeNodeEnvelope,
  decodeStoredProjectEventEnvelope,
  encodeNodeEnvelope,
  exactStateFilePath,
  GitHubProjectStore,
  HUNSU_STATE_BRANCH,
  type GitHubTransport,
  type GitHubTransportError,
  type ReconstructedProject,
  type RepositoryGrant,
  type RepositoryLocator,
  type StateActor,
  type StateFileSelection,
  type StoreError,
  type StoredProjectEvent
} from "@hunsu/github-store";
import {
  findHunsuTool,
  isRetiredHunsuV1Tool,
  type HunsuToolName,
  type McpToolDispatcher,
  type PluginSafeError,
  type RunContract,
  type ToolResponse
} from "@hunsu/plugin-contract";
import {
  eventListProjection,
  nodeDetailProjection,
  projectGraphProjection,
  projectListProjection,
  runDetailProjection,
  type ProjectionContext,
  type ProjectionResult,
  type SequencedDomainEvent
} from "@hunsu/projections";
import {
  NODE_PAYLOAD_SCHEMA,
  canonicalJson,
  computeGoalDigest,
  computeNodePayloadDigest,
  computeNodePlanDigest,
  computeRunnerDigest,
  decodeNodePayload,
  decodeNodePlan,
  makeAcceptanceCriterion,
  makeAtLeastTwo,
  makeCheckpointId,
  makeCoachReviewId,
  makeCoachingProposalId,
  makeCommandFingerprint,
  makeComparisonId,
  makeDecisionId,
  makeEventId,
  makeEvidenceId,
  makeEvidenceSummary,
  makeGitBranchName,
  makeGitCommitSha,
  makeGitRef,
  makeGitTreePath,
  makeGitTreeSha,
  makeGoalDigest,
  makeIdempotencyKey,
  makeIsoTimestamp,
  makeNodePayloadDigest,
  makeNodePlanDigest,
  makeNonEmptyArray,
  makeNonEmptyText,
  makeProjectId,
  makeProjectTitle,
  makeReason,
  makeRepositoryName,
  makeRepositoryOwner,
  makeRunId,
  makeWorkspaceId,
  managedNodeRef,
  runBranchName,
  type CommandMetadata,
  type ComparisonFinding,
  type CoachingChildNode,
  type DomainActor,
  type DomainEvent,
  type EvidenceRef,
  type GitCommitSha,
  type Node,
  type NodePayload,
  type NodePlan,
  type Project,
  type ProjectCommand,
  type ProjectState,
  type RootNode,
  type Run,
  type RunChildNode,
  type RunnerValue,
  type RunnerValueTypeRegistry
} from "@hunsu/protocol";
import { createProjectCodec } from "./project-codec.ts";
import type {
  EventLogCheckpoint,
  EventIndexEntryReadModel,
  EvidenceActivityReadModel,
  ProjectGraphEdge,
  ProjectGraphNode,
  RunActivityReadModel
} from "./project-read-models.ts";
import {
  EVENT_INDEX_SHARD_SIZE,
  GRAPH_PAGE_SIZE,
  MAX_EVENT_SHARDS_PER_PAGE,
  SHARDED_READ_MODEL_PATHS,
  decodeActivityManifest,
  decodeEventLocator,
  decodeEventManifest,
  decodeEventShard,
  decodeGraphManifest,
  decodeGraphNodeShard,
  decodeGraphPage,
  decodeNodeActivityShard,
  decodeRunActivityShard,
  decodeShardedProjectCatalog,
  scanReverseEventShards,
  type NodeActivityShardReadModel,
  type ProjectActivityManifestReadModel,
  type ProjectEventManifestReadModel,
  type ProjectEventShardReadModel,
  type ProjectGraphManifestReadModel,
  type ProjectGraphNodeReadModel,
  type ProjectGraphPageReadModel,
  type RunActivityShardReadModel,
  type ShardedProjectCatalogReadModel
} from "./sharded-read-models.ts";
import {
  apiFailure,
  apiOk,
  invalidRequest,
  type ApiError,
  type ApiResult,
  type AuthContext,
  type RepositoryV2InitializationState
} from "./types.ts";
import {
  bundledRunnerRuntime,
  type RunnerExecution,
  type TrustedRunnerRuntime
} from "./runner-runtime.ts";

type JsonRecord = Record<string, unknown>;

type LoadedProject = {
  repository: RepositoryGrant;
  state: ProjectState;
  stateHeadSha: string;
  synchronizedAt: string;
  events: ReconstructedProject<ProjectState, DomainEvent>["events"];
};

type ReadProject = {
  repository: RepositoryGrant;
  stateHeadSha: string;
  synchronizedAt: string;
  catalog: ShardedProjectCatalogReadModel;
};

type TimedCache<T> = {
  value: T;
  cachedAt: number;
};

type ReadProjectCache = TimedCache<readonly ReadProject[]> & {
  stateHeadSha: string | undefined;
};

type InstallationCacheGeneration = {
  global: number;
  installation: number;
};

type ReadProjectCacheGeneration = InstallationCacheGeneration & {
  repository: number;
};

type MutationApplied = {
  state: ProjectState;
  stateHeadSha: string;
  synchronizedAt: string;
  idempotentReplay: boolean;
};

type MutationFactory = (state: ProjectState, meta: CommandMetadata) => ProjectCommand;

export type ProjectionCachePolicy = {
  projectTtlMs: number;
  installationTtlMs: number;
};

const DEFAULT_CACHE_POLICY: ProjectionCachePolicy = {
  projectTtlMs: 4_000,
  installationTtlMs: 60_000
};

const FULL_SHA = /^[0-9a-f]{40}$/u;
const EVENT_CURSOR = /^[1-9][0-9]*$/u;
const EXACT_EVENT_CURSOR = /^([0-9a-f]{40}):([1-9][0-9]*)$/u;
const EXACT_GRAPH_CURSOR = /^([0-9a-f]{40}):(0|[1-9][0-9]*)$/u;

export class HunsuApplicationService implements McpToolDispatcher<AuthContext> {
  readonly #transport: GitHubTransport;
  readonly #store: GitHubProjectStore<DomainEvent, ProjectState>;
  readonly #runnerRuntime: TrustedRunnerRuntime;
  readonly #projectIntegrityBoundary: ProjectIntegrityBoundary;
  readonly #projectStateCodec: ReturnType<typeof createProjectCodec>["projectStateCodec"];
  readonly #now: () => Date;
  readonly #cacheNow: () => number;
  readonly #cachePolicy: ProjectionCachePolicy;
  readonly #projects = new Map<string, TimedCache<readonly LoadedProject[]>>();
  readonly #readProjects = new Map<string, ReadProjectCache>();
  readonly #readProjectFlights = new Map<string, Promise<ApiResult<readonly ReadProject[]>>>();
  readonly #readStateFilesByHead = new Map<string, string>();
  readonly #installations = new Map<number, TimedCache<readonly RepositoryGrant[]>>();
  readonly #installationFlights = new Map<number, ReturnType<GitHubTransport["listInstallationRepositories"]>>();
  readonly #installationCacheGenerations = new Map<number, number>();
  readonly #repositoryCacheGenerations = new Map<string, number>();
  #globalCacheGeneration = 0;

  constructor(input: {
    transport: GitHubTransport;
    now?: () => Date;
    cacheNow?: () => number;
    projectionCachePolicy?: Partial<ProjectionCachePolicy>;
    runnerRuntime?: TrustedRunnerRuntime;
  }) {
    this.#transport = input.transport;
    this.#runnerRuntime = input.runnerRuntime ?? bundledRunnerRuntime;
    const codec = createProjectCodec(this.#runnerRuntime);
    this.#projectIntegrityBoundary = codec.projectIntegrityBoundary;
    this.#projectStateCodec = codec.projectStateCodec;
    this.#store = new GitHubProjectStore(input.transport, codec.projectStateCodec);
    this.#now = input.now ?? (() => new Date());
    this.#cacheNow = input.cacheNow ?? (() => Date.now());
    this.#cachePolicy = cachePolicy(input.projectionCachePolicy);
  }

  async call(name: HunsuToolName, argumentsValue: JsonRecord, context: AuthContext): Promise<ToolResponse<unknown>> {
    const result = await this.invoke(name, argumentsValue, context);
    return result.ok
      ? {
          ok: true,
          data: result.value.data,
          ...(result.value.stateHeadSha === undefined ? {} : { stateHeadSha: result.value.stateHeadSha })
        }
      : { ok: false, error: pluginError(result.error) };
  }

  async invoke(name: string, input: JsonRecord, context: AuthContext): Promise<ApiResult<{ data: unknown; stateHeadSha?: string }>> {
    try {
      assertExactToolMutationInput(name, input);
      switch (name) {
        case "hunsu.projects.list": {
          const installationId = optionalPositiveInteger(input, "installationId");
          const loaded = await this.#loadAllReadProjects(context, installationId);
          if (!loaded.ok) return loaded;
          const repositoryFilter = optionalString(input, "repository")?.toLowerCase();
          const projects = repositoryFilter
            ? loaded.value.filter(item => `${item.repository.owner}/${item.repository.name}`.toLowerCase() === repositoryFilter)
            : loaded.value;
          const repositories = await this.#readRepositoryContexts(context, installationId, repositoryFilter);
          if (!repositories.ok) return repositories;
          return apiOk({ data: { ...this.#readProjectList(projects), repositories: repositories.value } });
        }
        case "hunsu.projects.get": {
          const loaded = await this.#loadToolReadProject(input, context);
          if (!loaded.ok) return loaded;
          return apiOk({ data: this.#readProjectContext(loaded.value), stateHeadSha: loaded.value.stateHeadSha });
        }
        case "hunsu.projects.create": {
          const repository = await this.#repositoryFromInput(context, record(input, "repository"), true);
          if (!repository.ok) return repository;
          const created = await this.#createProject(repository.value, context, input);
          return created.ok
            ? apiOk({ data: created.value, stateHeadSha: created.value.stateHeadSha })
            : created;
        }
        case "hunsu.projects.rebuild": {
          const repository = await this.#repositoryFromInput(context, record(input, "repository"), true);
          return repository.ok
            ? this.#toolMutation(await this.#rebuildProjectMaterializations(repository.value, context, input))
            : repository;
        }
        case "hunsu.nodes.graph": {
          const loaded = await this.#loadToolReadProject(input, context);
          if (!loaded.ok) return loaded;
          const graph = await this.#readGraph(loaded.value, {
            limit: optionalPositiveInteger(input, "limit") ?? 300,
            cursor: optionalString(input, "cursor") ?? null
          });
          return graph.ok ? apiOk({ data: graph.value, stateHeadSha: loaded.value.stateHeadSha }) : graph;
        }
        case "hunsu.nodes.get": {
          const loaded = await this.#loadToolReadProject(input, context);
          if (!loaded.ok) return loaded;
          const detail = await this.#readNode(loaded.value, requiredSha(input, "nodeSha"));
          return detail.ok ? apiOk({ data: detail.value.node, stateHeadSha: loaded.value.stateHeadSha }) : detail;
        }
        case "hunsu.events.list": {
          const loaded = await this.#loadToolReadProject(input, context);
          if (!loaded.ok) return loaded;
          const events = await this.#readEvents(loaded.value, input);
          return events.ok ? apiOk({ data: events.value, stateHeadSha: loaded.value.stateHeadSha }) : events;
        }
        case "hunsu.events.get": {
          const loaded = await this.#loadToolReadProject(input, context);
          if (!loaded.ok) return loaded;
          const event = await this.#readEvent(loaded.value, requiredString(input, "eventId"));
          return event.ok ? apiOk({ data: event.value, stateHeadSha: loaded.value.stateHeadSha }) : event;
        }
        case "hunsu.runs.get": {
          const loaded = await this.#loadToolReadProject(input, context);
          if (!loaded.ok) return loaded;
          const run = await this.#readRun(loaded.value, requiredString(input, "runId"));
          return run.ok ? apiOk({ data: run.value.run, stateHeadSha: loaded.value.stateHeadSha }) : run;
        }
        case "hunsu.runs.start": {
          const repository = await this.#repositoryFromInput(context, record(input, "repository"), true);
          if (!repository.ok) return repository;
          const started = await this.#startRun(repository.value, context, input);
          return started.ok
            ? apiOk({ data: started.value.contract, stateHeadSha: started.value.stateHeadSha })
            : started;
        }
        case "hunsu.runs.checkpoint": return this.#toolMutation(await this.#checkpointRunFromTool(context, input));
        case "hunsu.runs.attach_evidence": return this.#toolMutation(await this.#attachEvidenceFromTool(context, input));
        case "hunsu.runs.complete": return this.#toolMutation(await this.#completeRunFromTool(context, input));
        case "hunsu.runs.fail": return this.#toolMutation(await this.#failRunFromTool(context, input));
        case "hunsu.runs.cancel": return this.#toolMutation(await this.#cancelRunFromTool(context, input));
        case "hunsu.coach.review": return this.#toolMutation(await this.#reviewFromTool(context, input));
        case "hunsu.coach.propose_transition": return this.#toolMutation(await this.#proposalFromTool(context, input));
        case "hunsu.coach.confirm_transition": return this.#toolMutation(await this.#confirmProposalFromTool(context, input));
        case "hunsu.coach.reject_transition": return this.#toolMutation(await this.#rejectProposalFromTool(context, input));
        case "hunsu.alternatives.compare": return this.#toolMutation(await this.#compareFromTool(context, input));
        case "hunsu.alternatives.select": return this.#toolMutation(await this.#selectFromTool(context, input));
        case "hunsu.alternatives.reject": return this.#toolMutation(await this.#rejectAlternativeFromTool(context, input));
        default:
          return isRetiredHunsuV1Tool(name)
            ? apiFailure({
                code: "unsupported_protocol_version",
                message: `Hunsu v2 does not support retired tool ${name}.`,
                status: 400,
                retryable: false
              })
            : invalidRequest(`Unknown Hunsu tool ${name}.`);
      }
    } catch (error) {
      if (error instanceof BoundaryError) return apiFailure(error.apiError);
      return apiFailure({
        code: "temporarily_unavailable",
        message: "The Hunsu application service could not complete the request.",
        status: 503,
        retryable: true
      });
    }
  }

  async sessionRepositories(context: AuthContext): Promise<ApiResult<{ repositories: unknown[] }>> {
    const repositories = await this.#authorizedRepositories(context);
    if (!repositories.ok) return repositories;
    const rows = await Promise.all(repositories.value.map(async repository => {
      const state = await this.#repositoryV2State(repository);
      if (!state.ok) return state;
      return apiOk({
        installationId: repository.installationId,
        repositoryId: repository.repositoryId,
        owner: repository.owner,
        name: repository.name,
        defaultBranch: repository.defaultBranch,
        private: repository.private,
        permissions: repository.permissions,
        state: state.value
      });
    }));
    const failure = rows.find(row => !row.ok);
    if (failure && !failure.ok) return failure;
    return apiOk({ repositories: rows.flatMap(row => row.ok ? [row.value] : []) });
  }

  async #readRepositoryContexts(
    context: AuthContext,
    installationId: number | undefined,
    repositoryFilter: string | undefined
  ): Promise<ApiResult<unknown[]>> {
    const repositories = await this.#authorizedRepositories(context, installationId);
    if (!repositories.ok) return repositories;
    const filtered = repositoryFilter
      ? repositories.value.filter(repository => `${repository.owner}/${repository.name}`.toLowerCase() === repositoryFilter)
      : repositories.value;
    const rows = await Promise.all(filtered.map(async repository => {
      const state = await this.#repositoryV2State(repository);
      if (!state.ok) return state;
      return apiOk({
        installationId: repository.installationId,
        repositoryId: repository.repositoryId,
        owner: repository.owner,
        name: repository.name,
        defaultBranch: repository.defaultBranch,
        state: state.value
      });
    }));
    const failure = rows.find(row => !row.ok);
    if (failure && !failure.ok) return failure;
    return apiOk(rows.flatMap(row => row.ok ? [row.value] : []));
  }

  async webProjects(context: AuthContext): Promise<ApiResult<unknown>> {
    const loaded = await this.#loadAllReadProjects(context);
    return loaded.ok ? apiOk(this.#readProjectList(loaded.value)) : loaded;
  }

  async webProjectContext(context: AuthContext, projectId: string): Promise<ApiResult<unknown>> {
    const loaded = await this.#findReadProject(context, projectId);
    return loaded.ok ? apiOk(this.#readProjectContext(loaded.value)) : loaded;
  }

  async webGraph(context: AuthContext, projectId: string, query: JsonRecord): Promise<ApiResult<unknown>> {
    const loaded = await this.#findReadProject(context, projectId);
    if (!loaded.ok) return loaded;
    return this.#readGraph(loaded.value, {
      limit: optionalPositiveInteger(query, "limit") ?? 300,
      cursor: optionalString(query, "cursor") ?? null
    });
  }

  async webNode(context: AuthContext, projectId: string, nodeSha: string): Promise<ApiResult<unknown>> {
    const loaded = await this.#findReadProject(context, projectId);
    if (!loaded.ok) return loaded;
    return this.#readNode(loaded.value, requiredFullSha(nodeSha, "nodeSha"));
  }

  async webEvents(context: AuthContext, projectId: string, query: JsonRecord): Promise<ApiResult<unknown>> {
    const loaded = await this.#findReadProject(context, projectId);
    if (!loaded.ok) return loaded;
    return this.#readEvents(loaded.value, query);
  }

  async webEvent(context: AuthContext, projectId: string, eventId: string): Promise<ApiResult<unknown>> {
    const loaded = await this.#findReadProject(context, projectId);
    return loaded.ok ? this.#readEvent(loaded.value, eventId) : loaded;
  }

  async webRun(context: AuthContext, projectId: string, runId: string): Promise<ApiResult<unknown>> {
    const loaded = await this.#findReadProject(context, projectId);
    if (!loaded.ok) return loaded;
    return this.#readRun(loaded.value, runId);
  }

  async webCreateProject(context: AuthContext, input: JsonRecord): Promise<ApiResult<unknown>> {
    return webMutationBoundary(async () => {
      assertExactRecord(input, "request body", [
        "repository", "projectId", "title", "rootNodeSha", "initialPlan",
        "idempotencyKey", "expectedStateSha", "confirmedByUser"
      ]);
      const repository = await this.#repositoryFromInput(context, record(input, "repository"), true);
      return repository.ok ? this.#createProject(repository.value, context, input) : repository;
    });
  }

  async webStartRun(context: AuthContext, projectId: string, sourceNodeSha: string, input: JsonRecord): Promise<ApiResult<unknown>> {
    return webMutationBoundary(async () => {
      assertExactRecord(input, "request body", ["goalDigest", "runId", "idempotencyKey", "expectedStateSha"]);
      const loaded = await this.#findProject(context, projectId, true);
      if (!loaded.ok) return loaded;
      const started = await this.#startRun(loaded.value.repository, context, { ...input, projectId, sourceNodeSha });
      return started.ok
        ? apiOk({
            schema: "hunsu.web.run-started.v2",
            runId: started.value.contract.runId,
            stateHeadSha: started.value.stateHeadSha,
            synchronizedAt: started.value.synchronizedAt
          })
        : started;
    });
  }

  async webCheckpointRun(context: AuthContext, projectId: string, runId: string, input: JsonRecord): Promise<ApiResult<unknown>> {
    return webMutationBoundary(async () => {
      assertExactRecord(input, "request body", ["summary", "location", "idempotencyKey", "expectedStateSha"]);
      const loaded = await this.#findProject(context, projectId, true);
      return loaded.ok ? this.#checkpointRun(loaded.value.repository, context, { ...input, projectId, runId }) : loaded;
    });
  }

  async webAttachRunEvidence(context: AuthContext, projectId: string, runId: string, input: JsonRecord): Promise<ApiResult<unknown>> {
    return webMutationBoundary(async () => {
      assertExactRecord(input, "request body", ["evidence", "idempotencyKey", "expectedStateSha"]);
      const loaded = await this.#findProject(context, projectId, true);
      return loaded.ok ? this.#attachEvidence(loaded.value.repository, context, { ...input, projectId, runId }) : loaded;
    });
  }

  async webCompleteRun(context: AuthContext, projectId: string, runId: string, input: JsonRecord): Promise<ApiResult<unknown>> {
    return webMutationBoundary(async () => {
      assertExactRecord(input, "request body", ["resultSha", "evidence", "idempotencyKey", "expectedStateSha"]);
      const loaded = await this.#findProject(context, projectId, true);
      return loaded.ok ? this.#completeRun(loaded.value.repository, context, { ...input, projectId, runId }) : loaded;
    });
  }

  async webFailRun(context: AuthContext, projectId: string, runId: string, input: JsonRecord): Promise<ApiResult<unknown>> {
    return webMutationBoundary(async () => {
      assertExactRecord(input, "request body", ["reason", "idempotencyKey", "expectedStateSha"]);
      const loaded = await this.#findProject(context, projectId, true);
      return loaded.ok ? this.#terminalRun(loaded.value.repository, context, { ...input, projectId, runId }, "fail") : loaded;
    });
  }

  async webCancelRun(context: AuthContext, projectId: string, runId: string, input: JsonRecord): Promise<ApiResult<unknown>> {
    return webMutationBoundary(async () => {
      assertExactRecord(input, "request body", ["reason", "idempotencyKey", "expectedStateSha"]);
      const loaded = await this.#findProject(context, projectId, true);
      return loaded.ok ? this.#terminalRun(loaded.value.repository, context, { ...input, projectId, runId }, "cancel") : loaded;
    });
  }

  async webCreateCoachingProposal(context: AuthContext, projectId: string, sourceNodeSha: string, input: JsonRecord): Promise<ApiResult<unknown>> {
    return webMutationBoundary(async () => {
      assertExactRecord(input, "request body", [
        "sourcePayloadDigest", "proposalId", "proposedPlan", "summary", "rationale",
        "idempotencyKey", "expectedStateSha"
      ]);
      const loaded = await this.#findProject(context, projectId, true);
      return loaded.ok ? this.#proposeTransition(loaded.value.repository, context, { ...input, projectId, sourceNodeSha }) : loaded;
    });
  }

  async webConfirmCoachingProposal(context: AuthContext, projectId: string, proposalId: string, input: JsonRecord): Promise<ApiResult<unknown>> {
    return webMutationBoundary(async () => {
      assertExactRecord(input, "request body", ["idempotencyKey", "expectedStateSha", "confirmedByUser"]);
      const loaded = await this.#findProject(context, projectId, true);
      return loaded.ok ? this.#confirmProposal(loaded.value.repository, context, { ...input, projectId, proposalId }) : loaded;
    });
  }

  async webRejectCoachingProposal(context: AuthContext, projectId: string, proposalId: string, input: JsonRecord): Promise<ApiResult<unknown>> {
    return webMutationBoundary(async () => {
      assertExactRecord(input, "request body", ["reason", "idempotencyKey", "expectedStateSha", "confirmedByUser"]);
      const loaded = await this.#findProject(context, projectId, true);
      return loaded.ok ? this.#rejectProposal(loaded.value.repository, context, { ...input, projectId, proposalId }) : loaded;
    });
  }

  async webCompareAlternatives(context: AuthContext, projectId: string, input: JsonRecord): Promise<ApiResult<unknown>> {
    return webMutationBoundary(async () => {
      assertExactRecord(input, "request body", [
        "sourceNodeSha", "comparisonId", "nodeShas", "findings", "summary", "idempotencyKey", "expectedStateSha"
      ]);
      const loaded = await this.#findProject(context, projectId, true);
      return loaded.ok ? this.#compareAlternatives(loaded.value.repository, context, { ...input, projectId }) : loaded;
    });
  }

  async webSelectAlternative(context: AuthContext, projectId: string, input: JsonRecord): Promise<ApiResult<unknown>> {
    return webMutationBoundary(async () => {
      assertExactRecord(input, "request body", [
        "comparisonId", "nodeSha", "rationale", "idempotencyKey", "expectedStateSha", "confirmedByUser"
      ]);
      const loaded = await this.#findProject(context, projectId, true);
      return loaded.ok ? this.#decideAlternative(loaded.value.repository, context, { ...input, projectId }, "select") : loaded;
    });
  }

  async webRejectAlternative(context: AuthContext, projectId: string, input: JsonRecord): Promise<ApiResult<unknown>> {
    return webMutationBoundary(async () => {
      assertExactRecord(input, "request body", [
        "comparisonId", "nodeSha", "rationale", "idempotencyKey", "expectedStateSha", "confirmedByUser"
      ]);
      const loaded = await this.#findProject(context, projectId, true);
      return loaded.ok ? this.#decideAlternative(loaded.value.repository, context, { ...input, projectId }, "reject") : loaded;
    });
  }

  invalidateAll(): void {
    this.#globalCacheGeneration = nextCacheGeneration(this.#globalCacheGeneration);
    this.#projects.clear();
    this.#readProjects.clear();
    this.#readProjectFlights.clear();
    this.#readStateFilesByHead.clear();
    this.#installations.clear();
    this.#installationFlights.clear();
    this.#installationCacheGenerations.clear();
    this.#repositoryCacheGenerations.clear();
  }

  invalidateRepository(repository: Pick<RepositoryLocator, "installationId" | "repositoryId">): void {
    const key = repositoryKey(repository);
    this.#repositoryCacheGenerations.set(key, nextCacheGeneration(this.#repositoryCacheGenerations.get(key) ?? 0));
    this.#projects.delete(key);
    this.#readProjects.delete(key);
    this.#readProjectFlights.delete(key);
    this.#readStateFilesByHead.clear();
  }

  invalidateInstallation(installationId: number): void {
    this.#installationCacheGenerations.set(
      installationId,
      nextCacheGeneration(this.#installationCacheGenerations.get(installationId) ?? 0)
    );
    this.#installations.delete(installationId);
    this.#installationFlights.delete(installationId);
    for (const key of this.#projects.keys()) if (key.startsWith(`${installationId}:`)) this.#projects.delete(key);
    for (const key of this.#readProjects.keys()) if (key.startsWith(`${installationId}:`)) this.#readProjects.delete(key);
    for (const key of this.#readProjectFlights.keys()) if (key.startsWith(`${installationId}:`)) this.#readProjectFlights.delete(key);
    for (const key of this.#repositoryCacheGenerations.keys()) {
      if (key.startsWith(`${installationId}:`)) this.#repositoryCacheGenerations.delete(key);
    }
    this.#readStateFilesByHead.clear();
  }

  async #createProject(repository: RepositoryGrant, context: AuthContext, input: JsonRecord): Promise<ApiResult<{
    schema: "hunsu.web.project-created.v2";
    projectId: string;
    rootNodeSha: string;
    stateHeadSha: string;
    synchronizedAt: string;
  }>> {
    requireConfirmation(input);
    const projectId = requiredString(input, "projectId");
    const rootSha = requiredSha(input, "rootNodeSha");
    const expectedStateSha = requiredStateSha(input);
    const idempotencyKey = requiredIdempotencyKey(input);
    const plan = decodePlan(input.initialPlan, this.#runnerRuntime.runnerTypes);
    const commit = await this.#transport.readCommit(repository, rootSha);
    if (!commit.ok) return transportFailure(commit.error);
    if (!commit.value) return staleBase(`Root commit ${rootSha} does not exist in ${repository.owner}/${repository.name}.`);
    const anchored = await this.#store.anchorNode({ repository, projectId, nodeSha: rootSha });
    if (!anchored.ok) return storeFailure(anchored.error);
    const at = this.#timestamp();
    const project: Project = {
      id: asProjectId(projectId),
      workspaceId: asWorkspaceId(`workspace-${repository.installationId}`),
      repository: { owner: asRepositoryOwner(repository.owner), name: asRepositoryName(repository.name) },
      baseRef: asGitRef(`refs/heads/${repository.defaultBranch}`),
      title: asProjectTitle(requiredString(input, "title")),
      rootNodeSha: asGitSha(rootSha),
      createdAt: asTimestamp(at)
    };
    const node = buildNode({
      type: "root",
      projectId,
      commitSha: rootSha,
      treeSha: commit.value.treeSha,
      commitTitle: firstCommitMessageLine(commit.value.message),
      plan,
      registeredAt: at
    });
    const envelope = encodeNode(node);
    const semantic = { type: "CreateProject", projectId, rootSha, plan };
    const applied = await this.#mutate({
      repository,
      projectId,
      context,
      idempotencyKey,
      expectedStateSha,
      semantic,
      occurredAt: at,
      domainActor: userActor(context),
      factories: [(_state, meta) => ({
        type: "CreateProject",
        meta,
        rootNodeEventId: asEventId(domainEventId(idempotencyKey, semantic, 1)),
        project,
        rootNode: node,
        payload: envelope
      })]
    });
    return applied.ok ? apiOk({
      schema: "hunsu.web.project-created.v2",
      projectId,
      rootNodeSha: rootSha,
      stateHeadSha: applied.value.stateHeadSha,
      synchronizedAt: applied.value.synchronizedAt
    }) : applied;
  }

  async #rebuildProjectMaterializations(
    repository: RepositoryGrant,
    context: AuthContext,
    input: JsonRecord
  ): Promise<ApiResult<unknown>> {
    requireConfirmation(input);
    const projectId = requiredString(input, "projectId");
    const idempotencyKey = requiredIdempotencyKey(input);
    const expectedStateSha = requiredStateSha(input);
    const at = this.#timestamp();
    const semantic = { type: "RebuildProjectMaterializations", projectId };
    const applied = await this.#mutate({
      repository,
      projectId,
      context,
      idempotencyKey,
      expectedStateSha,
      semantic,
      occurredAt: at,
      domainActor: userActor(context),
      factories: [(_state, meta) => ({
        type: "RebuildProjectMaterializations",
        meta,
        projectId: asProjectId(projectId)
      })]
    });
    return mutationResponse(applied, "hunsu.web.project-materializations-rebuilt.v2", { projectId });
  }

  async #startRun(repository: RepositoryGrant, context: AuthContext, input: JsonRecord): Promise<ApiResult<{
    contract: RunContract;
    stateHeadSha: string;
    synchronizedAt: string;
  }>> {
    const projectId = requiredString(input, "projectId");
    const sourceNodeSha = requiredSha(input, "sourceNodeSha");
    const goalDigest = requiredString(input, "goalDigest");
    const runId = requiredString(input, "runId");
    const expectedStateSha = requiredStateSha(input);
    const idempotencyKey = requiredIdempotencyKey(input);
    const loaded = await this.#loadProject(repository, projectId, true);
    if (!loaded.ok) return loaded;
    const source = loaded.value.state.nodes.find(node => node.projectId === projectId && node.commitSha === sourceNodeSha);
    if (!source) return notFound(`Node ${sourceNodeSha} was not found.`);
    const goal = source.plan.nextGoals.find(item => computeGoalDigest(item) === goalDigest);
    if (!goal) return invalidRequest("goalDigest must identify exactly one next Goal on the source Node.");
    const execution = this.#runnerRuntime.execute(source.plan.how);
    if (!execution.ok) {
      return integrityFailure(`Runner runtime rejected ${source.plan.how.type.origin}/${source.plan.how.type.key}@${source.plan.how.type.schemaVersion}: ${execution.error.message}`);
    }
    const branch = String(runBranchName(asProjectId(projectId), asGitSha(sourceNodeSha), asRunId(runId)));
    const at = this.#timestamp();
    const semantic = { type: "StartRun", projectId, sourceNodeSha, goalDigest, runId };
    const meta = commandMetadata(idempotencyKey, semantic, 0, at, requestActor(context), expectedStateSha);
    const preflight = applyProjectCommand(loaded.value.state, {
      type: "StartRun",
      meta,
      runId: asRunId(runId),
      projectId: asProjectId(projectId),
      sourceNodeSha: asGitSha(sourceNodeSha),
      goalDigest: asGoalDigest(goalDigest),
      branch: asGitBranch(branch)
    }, this.#projectIntegrityBoundary);
    if (!preflight.ok) return domainFailure(preflight.error.code, preflight.error.message);
    const branchResult = await this.#store.createRunBranch({ repository, projectId, sourceNodeSha, runId });
    if (!branchResult.ok) return storeFailure(branchResult.error);
    const applied = await this.#mutate({
      repository,
      projectId,
      context,
      idempotencyKey,
      expectedStateSha,
      semantic,
      occurredAt: at,
      factories: [(_state, commandMeta) => ({
        type: "StartRun",
        meta: commandMeta,
        runId: asRunId(runId),
        projectId: asProjectId(projectId),
        sourceNodeSha: asGitSha(sourceNodeSha),
        goalDigest: asGoalDigest(goalDigest),
        branch: asGitBranch(branchResult.value)
      })]
    });
    if (!applied.ok) return applied;
    const run = applied.value.state.runs.find(item => item.id === runId);
    if (!run) return integrityFailure(`Run ${runId} was not reconstructed after start.`);
    return apiOk({
      contract: runContract(run, repository, this.#now(), execution.value),
      stateHeadSha: applied.value.stateHeadSha,
      synchronizedAt: applied.value.synchronizedAt
    });
  }

  async #checkpointRun(repository: RepositoryGrant, context: AuthContext, input: JsonRecord): Promise<ApiResult<unknown>> {
    const projectId = requiredString(input, "projectId");
    const runId = requiredString(input, "runId");
    const idempotencyKey = requiredIdempotencyKey(input);
    const expectedStateSha = requiredStateSha(input);
    const at = this.#timestamp();
    const location = parseCheckpointLocation(record(input, "location"));
    const semantic = { type: "CheckpointRun", projectId, runId, summary: requiredString(input, "summary"), location };
    const applied = await this.#mutate({
      repository, projectId, context, idempotencyKey, expectedStateSha, semantic, occurredAt: at,
      factories: [(_state, meta) => ({
        type: "CheckpointRun",
        meta,
        checkpoint: {
          id: asCheckpointId(generatedId("checkpoint", idempotencyKey)),
          runId: asRunId(runId),
          summary: asEvidenceSummary(requiredString(input, "summary")),
          location,
          recordedAt: asTimestamp(at)
        }
      })]
    });
    return mutationResponse(applied, "hunsu.web.run-checkpointed.v2", { runId });
  }

  async #attachEvidence(repository: RepositoryGrant, context: AuthContext, input: JsonRecord): Promise<ApiResult<unknown>> {
    const projectId = requiredString(input, "projectId");
    const runId = requiredString(input, "runId");
    const idempotencyKey = requiredIdempotencyKey(input);
    const expectedStateSha = requiredStateSha(input);
    const at = this.#timestamp();
    const evidence = evidenceRef(projectId, runId, input.evidence, generatedId("evidence", idempotencyKey), at);
    const semantic = { type: "AttachRunEvidence", projectId, runId, evidence: input.evidence };
    const applied = await this.#mutate({
      repository, projectId, context, idempotencyKey, expectedStateSha, semantic, occurredAt: at,
      factories: [(_state, meta) => ({ type: "AttachRunEvidence", meta, evidence })]
    });
    return mutationResponse(applied, "hunsu.web.run-evidence-attached.v2", { runId, evidenceId: String(evidence.id) });
  }

  async #completeRun(repository: RepositoryGrant, context: AuthContext, input: JsonRecord): Promise<ApiResult<unknown>> {
    const projectId = requiredString(input, "projectId");
    const runId = requiredString(input, "runId");
    const resultSha = requiredSha(input, "resultSha");
    const idempotencyKey = requiredIdempotencyKey(input);
    const expectedStateSha = requiredStateSha(input);
    const evidenceInputs = array(input, "evidence", true);
    const loaded = await this.#loadProject(repository, projectId, true);
    if (!loaded.ok) return loaded;
    const run = loaded.value.state.runs.find(item => item.id === runId);
    if (!run) return notFound(`Run ${runId} was not found.`);
    if (run.status !== "running") {
      if (run.status === "completed" && run.resultNodeSha === resultSha) {
        const replay = await this.#mutateReplay(repository, context, projectId, input, { type: "CompleteRun", projectId, runId, resultSha, evidence: evidenceInputs });
        return mutationResponse(replay, "hunsu.web.run-completed.v2", { runId, resultNodeSha: resultSha });
      }
      return conflict(`Run ${runId} is already ${run.status}.`);
    }
    const verified = await this.#store.verifyRunResult({ repository, branch: String(run.branch), baseSha: String(run.sourceNodeSha), resultSha });
    if (!verified.ok) {
      if (verified.error.code === "invalid_event" || verified.error.code === "state_not_found") {
        return apiFailure({ code: "result_unreachable", message: verified.error.message, status: 412, retryable: true });
      }
      return storeFailure(verified.error);
    }
    const commit = await this.#transport.readCommit(repository, resultSha);
    if (!commit.ok) return transportFailure(commit.error);
    if (!commit.value) return apiFailure({ code: "result_unreachable", message: `Result commit ${resultSha} was not found.`, status: 412, retryable: true });
    const anchored = await this.#store.anchorNode({ repository, projectId, nodeSha: resultSha });
    if (!anchored.ok) return storeFailure(anchored.error);
    const source = loaded.value.state.nodes.find(node => node.projectId === projectId && node.commitSha === run.sourceNodeSha);
    if (!source) return integrityFailure(`Run ${runId} references a missing source Node.`);
    const inherited = inheritRunChildPlan(source, run.goalDigest);
    if (!inherited.ok) return domainFailure(inherited.error.code, inherited.error.message);
    const at = this.#timestamp();
    const node = buildNode({
      type: "run_child",
      projectId,
      commitSha: resultSha,
      treeSha: commit.value.treeSha,
      commitTitle: firstCommitMessageLine(commit.value.message),
      plan: inherited.value,
      registeredAt: at,
      parentSha: String(run.sourceNodeSha),
      runId,
      consumedGoalDigest: String(run.goalDigest)
    });
    const envelope = encodeNode(node);
    const evidence = evidenceInputs.map((item, index) => evidenceRef(
      projectId,
      runId,
      item,
      generatedId(`evidence-${index + 1}`, idempotencyKey),
      at
    ));
    const semantic = { type: "CompleteRun", projectId, runId, resultSha, evidence: evidenceInputs };
    const factories: MutationFactory[] = [
      ...evidence.map(item => (_state: ProjectState, meta: CommandMetadata): ProjectCommand => ({ type: "AttachRunEvidence", meta, evidence: item })),
      (_state, meta) => ({
        type: "CompleteRun",
        meta,
        nodeEventId: asEventId(domainEventId(idempotencyKey, semantic, evidence.length + 1)),
        result: { runId: asRunId(runId), branch: run.branch, resultSha: asGitSha(resultSha), verifiedAt: asTimestamp(at) },
        node,
        payload: envelope
      })
    ];
    const applied = await this.#mutate({
      repository, projectId, context, idempotencyKey, expectedStateSha, semantic, occurredAt: at, factories
    });
    return mutationResponse(applied, "hunsu.web.run-completed.v2", { runId, resultNodeSha: resultSha });
  }

  async #terminalRun(
    repository: RepositoryGrant,
    context: AuthContext,
    input: JsonRecord,
    kind: "fail" | "cancel"
  ): Promise<ApiResult<unknown>> {
    const projectId = requiredString(input, "projectId");
    const runId = requiredString(input, "runId");
    const reason = requiredString(input, "reason");
    const idempotencyKey = requiredIdempotencyKey(input);
    const expectedStateSha = requiredStateSha(input);
    const at = this.#timestamp();
    const semantic = { type: kind === "fail" ? "FailRun" : "CancelRun", projectId, runId, reason };
    const applied = await this.#mutate({
      repository, projectId, context, idempotencyKey, expectedStateSha, semantic, occurredAt: at,
      factories: [(_state, meta) => kind === "fail"
        ? { type: "FailRun", meta, runId: asRunId(runId), reason: asReason(reason) }
        : { type: "CancelRun", meta, runId: asRunId(runId), reason: asReason(reason) }]
    });
    return mutationResponse(applied, kind === "fail" ? "hunsu.web.run-failed.v2" : "hunsu.web.run-canceled.v2", { runId });
  }

  async #recordReview(repository: RepositoryGrant, context: AuthContext, input: JsonRecord): Promise<ApiResult<unknown>> {
    const projectId = requiredString(input, "projectId");
    const nodeSha = requiredSha(input, "nodeSha");
    const reviewId = requiredString(input, "reviewId");
    const idempotencyKey = requiredIdempotencyKey(input);
    const expectedStateSha = requiredStateSha(input);
    const at = this.#timestamp();
    const recommendations = [
      ...optionalStringArray(input, "findings"),
      requiredString(input, "recommendation")
    ];
    const semantic = { type: "RecordCoachReview", projectId, nodeSha, reviewId, assessment: requiredString(input, "assessment"), recommendations };
    const applied = await this.#mutate({
      repository, projectId, context, idempotencyKey, expectedStateSha, semantic, occurredAt: at,
      domainActor: coachActor(context),
      factories: [(_state, meta) => ({
        type: "RecordCoachReview",
        meta,
        review: {
          id: asCoachReviewId(reviewId),
          projectId: asProjectId(projectId),
          target: { type: "node", nodeSha: asGitSha(nodeSha) },
          assessment: asText(requiredString(input, "assessment")),
          recommendations: recommendations.map(item => asText(item)),
          recordedAt: asTimestamp(at)
        }
      })]
    });
    return mutationResponse(applied, "hunsu.web.coach-review-recorded.v2", { reviewId });
  }

  async #proposeTransition(repository: RepositoryGrant, context: AuthContext, input: JsonRecord): Promise<ApiResult<unknown>> {
    const projectId = requiredString(input, "projectId");
    const sourceNodeSha = requiredSha(input, "sourceNodeSha");
    const proposalId = requiredString(input, "proposalId");
    const sourcePayloadDigest = requiredString(input, "sourcePayloadDigest");
    const proposedPlan = decodePlan(input.proposedPlan, this.#runnerRuntime.runnerTypes);
    const idempotencyKey = requiredIdempotencyKey(input);
    const expectedStateSha = requiredStateSha(input);
    const loaded = await this.#loadProject(repository, projectId, true);
    if (!loaded.ok) return loaded;
    const source = loaded.value.state.nodes.find(node => node.projectId === projectId && node.commitSha === sourceNodeSha);
    if (!source) return notFound(`Node ${sourceNodeSha} was not found.`);
    if (source.payloadDigest !== sourcePayloadDigest) return conflict("The Coaching proposal source payload digest is stale.");
    const at = this.#timestamp();
    const proposedPlanDigest = computeNodePlanDigest(proposedPlan);
    const rationale = optionalString(input, "rationale") ?? optionalString(input, "summary") ?? "Coach proposed a Node plan transition.";
    const semantic = { type: "RecordCoachingProposal", projectId, sourceNodeSha, sourcePayloadDigest, proposalId, proposedPlan, rationale };
    const applied = await this.#mutate({
      repository, projectId, context, idempotencyKey, expectedStateSha, semantic, occurredAt: at,
      domainActor: coachActor(context),
      factories: [(_state, meta) => ({
        type: "RecordCoachingProposal",
        meta,
        proposal: {
          id: asProposalId(proposalId),
          projectId: asProjectId(projectId),
          sourceNodeSha: asGitSha(sourceNodeSha),
          sourcePayloadDigest: asNodePayloadDigest(sourcePayloadDigest),
          sourcePlanDigest: source.planDigest,
          proposedPlan,
          proposedPlanDigest,
          expectedStateSha: asGitSha(expectedStateSha),
          reason: asReason(rationale),
          proposedAt: asTimestamp(at)
        }
      })]
    });
    return mutationResponse(applied, "hunsu.web.coaching-proposal-recorded.v2", {
      proposalId,
      sourceNodeSha,
      sourcePayloadDigest,
      proposedPlanDigest: String(proposedPlanDigest)
    });
  }

  async #confirmProposal(repository: RepositoryGrant, context: AuthContext, input: JsonRecord): Promise<ApiResult<unknown>> {
    requireConfirmation(input);
    const projectId = requiredString(input, "projectId");
    const proposalId = requiredString(input, "proposalId");
    const idempotencyKey = requiredIdempotencyKey(input);
    const expectedStateSha = requiredStateSha(input);
    const loaded = await this.#loadProject(repository, projectId, true);
    if (!loaded.ok) return loaded;
    const proposal = loaded.value.state.coachingProposals.find(item => item.id === proposalId);
    if (!proposal) return notFound(`Coaching proposal ${proposalId} was not found.`);
    const created = await this.#store.createCoachingNode({
      repository,
      projectId,
      sourceSha: String(proposal.sourceNodeSha),
      proposalId,
      planDigest: String(proposal.proposedPlanDigest),
      proposedAt: String(proposal.proposedAt)
    });
    if (!created.ok) return storeFailure(created.error);
    const at = this.#timestamp();
    const node = buildNode({
      type: "coaching_child",
      projectId,
      commitSha: created.value.nodeSha,
      treeSha: created.value.treeSha,
      commitTitle: created.value.commitTitle,
      plan: proposal.proposedPlan,
      registeredAt: at,
      parentSha: String(proposal.sourceNodeSha),
      proposalId
    });
    const envelope = encodeNode(node);
    const semantic = { type: "ConfirmCoachingProposal", projectId, proposalId, childNodeSha: created.value.nodeSha };
    const applied = await this.#mutate({
      repository, projectId, context, idempotencyKey, expectedStateSha, semantic, occurredAt: at,
      domainActor: userActor(context),
      factories: [(_state, meta) => ({
        type: "ConfirmCoachingProposal",
        meta,
        nodeEventId: asEventId(domainEventId(idempotencyKey, semantic, 1)),
        decisionId: asDecisionId(generatedId("decision", idempotencyKey)),
        proposalId: asProposalId(proposalId),
        reason: asReason(optionalString(input, "reason") ?? "User confirmed the Coaching transition."),
        node,
        payload: envelope
      })]
    });
    return mutationResponse(applied, "hunsu.web.coaching-proposal-confirmed.v2", { proposalId, childNodeSha: created.value.nodeSha });
  }

  async #rejectProposal(repository: RepositoryGrant, context: AuthContext, input: JsonRecord): Promise<ApiResult<unknown>> {
    requireConfirmation(input);
    const projectId = requiredString(input, "projectId");
    const proposalId = requiredString(input, "proposalId");
    const idempotencyKey = requiredIdempotencyKey(input);
    const expectedStateSha = requiredStateSha(input);
    const reason = requiredString(input, "reason");
    const at = this.#timestamp();
    const semantic = { type: "RejectCoachingProposal", projectId, proposalId, reason };
    const applied = await this.#mutate({
      repository, projectId, context, idempotencyKey, expectedStateSha, semantic, occurredAt: at,
      domainActor: userActor(context),
      factories: [(_state, meta) => ({
        type: "RejectCoachingProposal",
        meta,
        decisionId: asDecisionId(generatedId("decision", idempotencyKey)),
        proposalId: asProposalId(proposalId),
        reason: asReason(reason)
      })]
    });
    return mutationResponse(applied, "hunsu.web.coaching-proposal-rejected.v2", { proposalId });
  }

  async #compareAlternatives(repository: RepositoryGrant, context: AuthContext, input: JsonRecord): Promise<ApiResult<unknown>> {
    const projectId = requiredString(input, "projectId");
    const sourceNodeSha = requiredSha(input, "sourceNodeSha");
    const comparisonId = requiredString(input, "comparisonId");
    const nodeShas = requiredShaArray(input, "nodeShas", 2);
    const findings = parseComparisonFindings(input.findings);
    const summary = requiredString(input, "summary");
    const idempotencyKey = requiredIdempotencyKey(input);
    const expectedStateSha = requiredStateSha(input);
    const loaded = await this.#loadProject(repository, projectId, true);
    if (!loaded.ok) return loaded;
    const compared = loaded.value.state.nodes.filter(node => nodeShas.includes(String(node.commitSha)));
    if (compared.length !== nodeShas.length || compared.some(node => node.type !== "run_child" || node.parentSha !== sourceNodeSha)) {
      return invalidRequest("Compared Nodes must be completed Run siblings of sourceNodeSha.");
    }
    const at = this.#timestamp();
    const semantic = { type: "CompareAlternatives", projectId, sourceNodeSha, comparisonId, nodeShas, findings, summary };
    const applied = await this.#mutate({
      repository, projectId, context, idempotencyKey, expectedStateSha, semantic, occurredAt: at,
      domainActor: coachActor(context),
      factories: [(_state, meta) => ({
        type: "CompareAlternatives",
        meta,
        comparisonId: asComparisonId(comparisonId),
        projectId: asProjectId(projectId),
        nodeShas: asAtLeastTwo(nodeShas.map(asGitSha), "nodeShas"),
        findings,
        summary: asEvidenceSummary(summary)
      })]
    });
    return mutationResponse(applied, "hunsu.web.alternatives-compared.v2", { comparisonId, sourceNodeSha, nodeShas });
  }

  async #decideAlternative(
    repository: RepositoryGrant,
    context: AuthContext,
    input: JsonRecord,
    kind: "select" | "reject"
  ): Promise<ApiResult<unknown>> {
    requireConfirmation(input);
    const projectId = requiredString(input, "projectId");
    const comparisonId = requiredString(input, "comparisonId");
    const nodeSha = requiredSha(input, "nodeSha");
    const rationale = requiredString(input, "rationale");
    const idempotencyKey = requiredIdempotencyKey(input);
    const expectedStateSha = requiredStateSha(input);
    const at = this.#timestamp();
    const semantic = { type: kind === "select" ? "SelectAlternative" : "RejectAlternatives", projectId, comparisonId, nodeSha, rationale };
    const applied = await this.#mutate({
      repository, projectId, context, idempotencyKey, expectedStateSha, semantic, occurredAt: at,
      domainActor: userActor(context),
      factories: [(_state, meta) => kind === "select"
        ? {
            type: "SelectAlternative",
            meta,
            decisionId: asDecisionId(generatedId("decision", idempotencyKey)),
            projectId: asProjectId(projectId),
            comparisonId: asComparisonId(comparisonId),
            selectedNodeSha: asGitSha(nodeSha),
            rationale: asReason(rationale)
          }
        : {
            type: "RejectAlternatives",
            meta,
            decisionId: asDecisionId(generatedId("decision", idempotencyKey)),
            projectId: asProjectId(projectId),
            comparisonId: asComparisonId(comparisonId),
            rejectedNodeShas: asNonEmpty([asGitSha(nodeSha)], "nodeShas"),
            rationale: asReason(rationale)
          }]
    });
    return mutationResponse(applied, kind === "select" ? "hunsu.web.alternative-selected.v2" : "hunsu.web.alternative-rejected.v2", { comparisonId, nodeSha });
  }

  async #mutate(input: {
    repository: RepositoryGrant;
    projectId: string;
    context: AuthContext;
    idempotencyKey: string;
    expectedStateSha: string;
    semantic: unknown;
    occurredAt: string;
    factories: readonly MutationFactory[];
    domainActor?: DomainActor;
  }): Promise<ApiResult<MutationApplied>> {
    const base = await this.#transport.readBranchHead(input.repository, input.repository.defaultBranch);
    if (!base.ok) return transportFailure(base.error);
    if (!base.value) return staleBase(`Default branch ${input.repository.defaultBranch} is unavailable.`);
    const actor = input.domainActor ?? requestActor(input.context);
    const appended = await this.#store.append({
      repository: input.repository,
      projectId: input.projectId,
      baseSha: base.value,
      expectedHeadSha: input.expectedStateSha,
      idempotencyKey: input.idempotencyKey,
      occurredAt: input.occurredAt,
      actor: stateActor(input.context),
      command: input.semantic,
      decide: current => {
        let state = current ?? emptyProjectState();
        const events: DomainEvent[] = [];
        for (let index = 0; index < input.factories.length; index += 1) {
          const meta = commandMetadata(
            input.idempotencyKey,
            input.semantic,
            index,
            input.occurredAt,
            actor,
            input.expectedStateSha
          );
          const applied = applyProjectCommand(state, input.factories[index]!(state, meta), this.#projectIntegrityBoundary);
          if (!applied.ok) return {
            ok: false as const,
            error: { code: "invalid_event" as const, message: `DOMAIN:${applied.error.code}:${applied.error.message}` }
          };
          state = applied.value.state;
          events.push(...applied.value.emittedEvents);
        }
        return { ok: true as const, value: events };
      }
    });
    if (!appended.ok) return storeFailure(appended.error);
    this.invalidateRepository(input.repository);
    return apiOk({
      state: appended.value.state,
      stateHeadSha: appended.value.stateHeadSha,
      synchronizedAt: this.#timestamp(),
      idempotentReplay: appended.value.idempotentReplay
    });
  }

  async #mutateReplay(
    repository: RepositoryGrant,
    context: AuthContext,
    projectId: string,
    input: JsonRecord,
    semantic: unknown
  ): Promise<ApiResult<MutationApplied>> {
    return this.#mutate({
      repository,
      projectId,
      context,
      idempotencyKey: requiredIdempotencyKey(input),
      expectedStateSha: requiredStateSha(input),
      semantic,
      occurredAt: this.#timestamp(),
      // The Store resolves a genuine lost-response retry before this factory is
      // evaluated. A different idempotency key reaches Core and is rejected as
      // an invalid terminal transition without appending an event.
      factories: [(_state, meta) => ({
        type: "FailRun",
        meta,
        runId: asRunId(requiredString(input, "runId")),
        reason: asReason("Run completion is already terminal.")
      })]
    });
  }

  #readProjectList(loaded: readonly ReadProject[]) {
    return {
      schema: "hunsu.web.project-list.v2" as const,
      projects: loaded.map(item => ({
        ...readProjectSummary(item),
        nodeCount: item.catalog.counts.nodes,
        activeRunCount: item.catalog.counts.activeRuns,
        unresolvedDivergenceCount: item.catalog.counts.unresolvedDivergences,
        integrity: { status: "valid" as const },
        synchronizedAt: item.synchronizedAt
      }))
    };
  }

  #readProjectContext(loaded: ReadProject) {
    return {
      schema: "hunsu.web.project-context.v2" as const,
      project: readProjectSummary(loaded),
      stateHeadSha: loaded.stateHeadSha,
      repositoryState: initializedRepositoryV2State(loaded.stateHeadSha),
      integrity: { status: "valid" as const },
      activeRunCount: loaded.catalog.counts.activeRuns
    };
  }

  async #readGraph(loaded: ReadProject, options: { limit: number; cursor: string | null }): Promise<ApiResult<unknown>> {
    const limit = Math.max(1, Math.min(GRAPH_PAGE_SIZE, Math.trunc(options.limit)));
    const cursorMatch = options.cursor === null ? undefined : options.cursor.match(EXACT_GRAPH_CURSOR);
    if (options.cursor !== null && (!cursorMatch || cursorMatch[1] !== loaded.stateHeadSha)) {
      return invalidRequest("Graph continuation cursor is not bound to this exact state head.");
    }
    const offset = cursorMatch?.[2] === undefined ? 0 : Number(cursorMatch[2]);
    if (!Number.isSafeInteger(offset) || offset < 0) return invalidRequest("Graph continuation cursor is invalid.");
    const pageIndexes = [Math.floor(offset / GRAPH_PAGE_SIZE)];
    const window = await this.#loadGraphWindow(loaded, pageIndexes);
    if (!window.ok) return window;
    if (offset > window.value.manifest.nodeCount) return integrityFailure("Graph continuation cursor is outside the current projection.");
    const end = Math.min(window.value.manifest.nodeCount, offset + limit, (pageIndexes[0]! + 1) * GRAPH_PAGE_SIZE);
    const nodes = window.value.pages.flatMap(page => page.nodes).filter(node => node.ordinal >= offset && node.ordinal < end);
    const visibleTargets = new Set(nodes.map(node => node.sha));
    const edges = window.value.pages.flatMap(page => page.edges).filter(edge => visibleTargets.has(edge.targetSha));
    const activeRuns = window.value.pages.flatMap(page => page.activeRuns).filter(run => visibleTargets.has(run.sourceNodeSha));
    const hasMore = end < window.value.manifest.nodeCount;
    return apiOk({
      schema: "hunsu.web.project-graph.v2",
      project: readProjectSummary(loaded),
      stateHeadSha: loaded.stateHeadSha,
      integrity: { status: "valid" },
      nodes: nodes.map(readGraphNode),
      edges: edges.map(readGraphEdge),
      activeRuns,
      window: {
        limit,
        hasMore,
        continuationCursor: hasMore ? `${loaded.stateHeadSha}:${end}` : null
      }
    });
  }

  async #readNode(loaded: ReadProject, nodeSha: string): Promise<ApiResult<{ schema: "hunsu.web.node-detail.v2"; stateHeadSha: string; node: unknown }>> {
    const bundle = await this.#loadNodeReadBundle(loaded, nodeSha);
    if (!bundle.ok) return bundle;
    const { graphNode, activity, payload } = bundle.value;
    const card = graphNode.node;
    const payloadError = nodePayloadIntegrityError(loaded, card, payload);
    if (payloadError) return integrityFailure(payloadError);
    const nodeRunIds = new Set(activity.runs.map(run => run.id));
    const outgoingEdges = graphNode.outgoingEdges.map(readGraphEdge);
    return apiOk({
      schema: "hunsu.web.node-detail.v2",
      stateHeadSha: loaded.stateHeadSha,
      node: {
        sha: card.sha,
        title: card.commitTitle,
        commitUrl: `https://github.com/${loaded.repository.owner}/${loaded.repository.name}/commit/${card.sha}`,
        treeSha: card.treeSha,
        managedRef: card.managedRef,
        integrity: { status: "valid" },
        status: card.status,
        lineage: readNodeLineage(card),
        plan: {
          schema: payload.plan.schema,
          nextGoals: payload.plan.nextGoals.map(goal => ({
            digest: String(computeGoalDigest(goal)), key: String(goal.key), title: String(goal.title),
            desiredOutcome: String(goal.desiredOutcome), acceptanceCriteria: goal.acceptanceCriteria.map(String),
            constraints: goal.constraints.map(String), priority: Number(goal.priority)
          })),
          how: {
            schema: payload.plan.how.schema,
            name: String(payload.plan.how.name),
            typeKey: String(payload.plan.how.type.key),
            schemaVersion: String(payload.plan.how.type.schemaVersion),
            digest: String(computeRunnerDigest(payload.plan.how)),
            type: {
              origin: String(payload.plan.how.type.origin), key: String(payload.plan.how.type.key),
              schemaVersion: String(payload.plan.how.type.schemaVersion), integrity: String(payload.plan.how.type.integrity)
            },
            value: payload.plan.how.value
          }
        },
        outgoingEdges,
        activeRuns: graphNode.activeRuns,
        evidence: activity.evidence.filter(item => nodeRunIds.has(item.runId)).map(item => readEvidenceSummary(loaded, activity, item)),
        comparisons: activity.comparisons.filter(item => item.parentNodeSha === nodeSha || item.nodeShas.includes(nodeSha)).map(item => ({
          id: item.id, summary: item.summary, siblingNodeShas: item.nodeShas, recordedAt: item.recordedAt
        })),
        decisions: activity.decisions.flatMap(decision => decision.nodeShas.includes(nodeSha)
          ? [{
              kind: decision.type === "selection" ? "selected" : "rejected",
              id: decision.id, nodeSha, reason: decision.rationale, recordedAt: decision.decidedAt
            }]
          : [])
      }
    });
  }

  async #readEvents(loaded: ReadProject, query: JsonRecord): Promise<ApiResult<unknown>> {
    const manifest = await this.#loadEventManifest(loaded);
    if (!manifest.ok) return manifest;
    const limit = optionalPositiveInteger(query, "limit") ?? 50;
    if (limit > 50) return invalidRequest("Events limit cannot exceed 50.");
    const rawCursor = optionalString(query, "cursor");
    const cursorMatch = rawCursor === undefined ? undefined : rawCursor.match(EXACT_EVENT_CURSOR);
    if (rawCursor !== undefined && (!cursorMatch || cursorMatch[1] !== loaded.stateHeadSha)) {
      return invalidRequest("Events cursor must be bound to this exact state head and a positive sequence number.");
    }
    const cursor = cursorMatch?.[2] === undefined ? manifest.value.checkpoint.lastSequence + 1 : Number(cursorMatch[2]);
    if (!Number.isSafeInteger(cursor) || cursor < 1 || cursor > manifest.value.checkpoint.lastSequence + 1) {
      return invalidRequest("Events cursor is outside the current exact-head Event index.");
    }
    const eventType = optionalString(query, "eventType") ?? optionalString(query, "type");
    const nodeSha = optionalString(query, "nodeSha");
    if (nodeSha !== undefined) requiredFullSha(nodeSha, "nodeSha");
    const actor = optionalString(query, "actor")?.toLowerCase();
    const from = optionalString(query, "occurredFrom") ?? optionalString(query, "from");
    const to = optionalString(query, "occurredTo") ?? optionalString(query, "to");
    const search = optionalString(query, "search")?.toLowerCase();
    if (from !== undefined) asTimestamp(from);
    if (to !== undefined) asTimestamp(to);
    const fromEpoch = from === undefined ? undefined : Date.parse(from);
    const toEpoch = to === undefined ? undefined : Date.parse(to);
    if (fromEpoch !== undefined && toEpoch !== undefined && fromEpoch > toEpoch) {
      return invalidRequest("Events from timestamp cannot be later than the to timestamp.");
    }
    const newestSequence = Math.min(cursor - 1, manifest.value.checkpoint.lastSequence);
    const newestShard = newestSequence === 0 ? -1 : Math.floor((newestSequence - 1) / EVENT_INDEX_SHARD_SIZE);
    const shardIndexes: number[] = [];
    for (let index = newestShard; index >= 0 && shardIndexes.length < MAX_EVENT_SHARDS_PER_PAGE; index -= 1) shardIndexes.push(index);
    const shards = await this.#loadEventShards(loaded, manifest.value, shardIndexes);
    if (!shards.ok) return shards;
    const scanned = scanReverseEventShards(shards.value, cursor, limit, item => {
        if (eventType !== undefined && item.eventType !== eventType) return false;
        if (nodeSha !== undefined && !eventReferencesNode(item.reference as Parameters<typeof eventReferencesNode>[0], nodeSha)) return false;
        if (actor !== undefined && !item.actor.id.toLowerCase().includes(actor) && !item.actor.label.toLowerCase().includes(actor)) return false;
        const occurredAt = Date.parse(item.occurredAt);
        if (fromEpoch !== undefined && occurredAt < fromEpoch) return false;
        if (toEpoch !== undefined && occurredAt > toEpoch) return false;
        if (search !== undefined && !`${item.eventType} ${item.summary}`.toLowerCase().includes(search)) return false;
        return true;
      });
    return apiOk({
      schema: "hunsu.web.events.v2",
      project: readProjectSummary(loaded),
      stateHeadSha: loaded.stateHeadSha,
      events: scanned.entries.map(readEventIndexEntry),
      nextCursor: scanned.hasOlder ? `${loaded.stateHeadSha}:${scanned.lastInspectedSequence}` : null
    });
  }

  async #readEvent(loaded: ReadProject, eventId: string): Promise<ApiResult<unknown>> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(eventId) || eventId.includes("..")) return invalidRequest("Event id is invalid.");
    const indexed = await this.#loadEventLocator(loaded, eventId);
    if (!indexed.ok) return indexed;
    const event = indexed.value.entry;
    const path = parseAuthoritativeEventPath(loaded.catalog.project.id, event.path);
    if (!path.ok) return path;
    const files = await this.#readStateFiles(loaded, [{ kind: "event", projectId: loaded.catalog.project.id, ...path.value }]);
    if (!files.ok) return files;
    const raw = parseJsonFile(files.value, event.path, "Authoritative Event");
    if (!raw.ok) return raw;
    const authoritative = decodeStoredProjectEventEnvelope(raw.value, this.#projectStateCodec);
    if (!authoritative.ok) return integrityFailure(`${event.path}: ${authoritative.error.message}`);
    const mismatch = authoritativeEventMismatch(loaded, event, authoritative.value);
    if (mismatch) return integrityFailure(mismatch);
    return apiOk({
      schema: "hunsu.web.event-detail.v2",
      project: readProjectSummary(loaded),
      stateHeadSha: loaded.stateHeadSha,
      event: readEventIndexEntry(event)
    });
  }

  async #readRun(loaded: ReadProject, runId: string): Promise<ApiResult<{ schema: "hunsu.web.run-detail.v2"; stateHeadSha: string; run: unknown }>> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(runId) || runId.includes("..")) return invalidRequest("Run id is invalid.");
    const activity = await this.#loadRunActivity(loaded, runId);
    if (!activity.ok) return activity;
    const run = activity.value.run;
    const source = await this.#loadGraphNodeAndPayload(loaded, run.sourceNodeSha);
    if (!source.ok) return source;
    const goal = source.value.payload.plan.nextGoals.find(item => String(computeGoalDigest(item)) === run.goalDigest);
    if (!goal || String(goal.title) !== run.goalTitle || String(computeRunnerDigest(source.value.payload.plan.how)) !== run.runnerDigest) {
      return integrityFailure(`Run ${runId} does not match its source Node Goal and Runner payload.`);
    }
    const domainRun = readDomainRun(loaded, run, goal, source.value.payload.plan.how);
    return apiOk({
      schema: "hunsu.web.run-detail.v2",
      stateHeadSha: loaded.stateHeadSha,
      run: {
        run: domainRun,
        evidence: activity.value.evidence.map(item => readDomainEvidence(loaded, item)),
        sourceNodeTitle: source.value.graphNode.node.commitTitle
      }
    });
  }

  async #loadGraphWindow(loaded: ReadProject, requestedIndexes: readonly number[]): Promise<ApiResult<{ manifest: ProjectGraphManifestReadModel; pages: readonly ProjectGraphPageReadModel[] }>> {
    const indexes = [...new Set(requestedIndexes)].filter(index => index >= 0);
    const files = await this.#readStateFiles(loaded, [
      { kind: "project_read_model", projectId: loaded.catalog.project.id, model: "graph" },
      ...indexes.map(page => ({ kind: "graph_page" as const, projectId: loaded.catalog.project.id, page }))
    ]);
    if (!files.ok) return files;
    const manifest = decodeMaterialized(files.value, readModelPath(loaded, SHARDED_READ_MODEL_PATHS.graphManifest), decodeGraphManifest);
    if (!manifest.ok) return manifest;
    const manifestError = graphManifestIntegrityError(loaded, manifest.value);
    if (manifestError) return integrityFailure(manifestError);
    const pages: ProjectGraphPageReadModel[] = [];
    for (const index of indexes) {
      const descriptor = manifest.value.pages[index];
      if (!descriptor) return integrityFailure(`Graph page ${index} is missing from its exact-head manifest.`);
      const path = readModelPath(loaded, descriptor.path);
      const page = decodeMaterialized(files.value, path, decodeGraphPage);
      if (!page.ok) return page;
      if (page.value.index !== index || page.value.projectId !== loaded.catalog.project.id || !sameCheckpoint(page.value.checkpoint, manifest.value.checkpoint)
        || page.value.nodes.length !== descriptor.nodeCount || page.value.edges.length !== descriptor.edgeCount
        || materializedEnvelopeDigest(files.value, path) !== descriptor.digest
      ) return integrityFailure(`Graph page ${index} does not match its exact-head manifest.`);
      pages.push(page.value);
    }
    return apiOk({ manifest: manifest.value, pages });
  }

  async #loadNodeReadBundle(loaded: ReadProject, nodeSha: string): Promise<ApiResult<{ graphNode: ProjectGraphNodeReadModel; activity: NodeActivityShardReadModel; payload: NodePayload }>> {
    const files = await this.#readStateFiles(loaded, [
      { kind: "project_read_model", projectId: loaded.catalog.project.id, model: "graph" },
      { kind: "project_read_model", projectId: loaded.catalog.project.id, model: "activity" },
      { kind: "graph_node", projectId: loaded.catalog.project.id, nodeSha },
      { kind: "node_activity", projectId: loaded.catalog.project.id, nodeSha },
      { kind: "node_payload", projectId: loaded.catalog.project.id, nodeSha }
    ]);
    if (!files.ok) return files;
    const graphManifest = decodeMaterialized(files.value, readModelPath(loaded, SHARDED_READ_MODEL_PATHS.graphManifest), decodeGraphManifest);
    if (!graphManifest.ok) return graphManifest;
    const activityManifest = decodeMaterialized(files.value, readModelPath(loaded, SHARDED_READ_MODEL_PATHS.activityManifest), decodeActivityManifest);
    if (!activityManifest.ok) return activityManifest;
    const graphNode = decodeMaterialized(files.value, readModelPath(loaded, `graph/nodes/${nodeSha}.json`), decodeGraphNodeShard);
    if (!graphNode.ok) return graphNode;
    const activity = decodeMaterialized(files.value, readModelPath(loaded, `snapshots/nodes/${nodeSha}.json`), decodeNodeActivityShard);
    if (!activity.ok) return activity;
    const manifestError = graphManifestIntegrityError(loaded, graphManifest.value)
      ?? activityManifestIntegrityError(loaded, activityManifest.value)
      ?? graphNodeIntegrityError(loaded, graphManifest.value, graphNode.value, nodeSha)
      ?? activityShardIntegrityError(loaded, activityManifest.value, activity.value, nodeSha);
    if (manifestError) return integrityFailure(manifestError);
    const payload = decodeNodePayloadFile(files.value, nodePayloadPath(loaded, nodeSha), this.#runnerRuntime.runnerTypes);
    if (!payload.ok) return payload;
    const payloadError = nodePayloadIntegrityError(loaded, graphNode.value.node, payload.value);
    if (payloadError) return integrityFailure(payloadError);
    const anchor = await this.#verifyNodeAnchor(loaded, graphNode.value.node);
    return anchor.ok ? apiOk({ graphNode: graphNode.value, activity: activity.value, payload: payload.value }) : anchor;
  }

  async #loadGraphNodeAndPayload(loaded: ReadProject, nodeSha: string): Promise<ApiResult<{ graphNode: ProjectGraphNodeReadModel; payload: NodePayload }>> {
    const files = await this.#readStateFiles(loaded, [
      { kind: "project_read_model", projectId: loaded.catalog.project.id, model: "graph" },
      { kind: "graph_node", projectId: loaded.catalog.project.id, nodeSha },
      { kind: "node_payload", projectId: loaded.catalog.project.id, nodeSha }
    ]);
    if (!files.ok) return files;
    const manifest = decodeMaterialized(files.value, readModelPath(loaded, SHARDED_READ_MODEL_PATHS.graphManifest), decodeGraphManifest);
    if (!manifest.ok) return manifest;
    const graphNode = decodeMaterialized(files.value, readModelPath(loaded, `graph/nodes/${nodeSha}.json`), decodeGraphNodeShard);
    if (!graphNode.ok) return graphNode;
    const error = graphManifestIntegrityError(loaded, manifest.value) ?? graphNodeIntegrityError(loaded, manifest.value, graphNode.value, nodeSha);
    if (error) return integrityFailure(error);
    const payload = decodeNodePayloadFile(files.value, nodePayloadPath(loaded, nodeSha), this.#runnerRuntime.runnerTypes);
    if (!payload.ok) return payload;
    const payloadError = nodePayloadIntegrityError(loaded, graphNode.value.node, payload.value);
    if (payloadError) return integrityFailure(payloadError);
    const anchor = await this.#verifyNodeAnchor(loaded, graphNode.value.node);
    return anchor.ok ? apiOk({ graphNode: graphNode.value, payload: payload.value }) : anchor;
  }

  async #loadRunActivity(loaded: ReadProject, runId: string): Promise<ApiResult<RunActivityShardReadModel>> {
    const files = await this.#readStateFiles(loaded, [
      { kind: "project_read_model", projectId: loaded.catalog.project.id, model: "activity" },
      { kind: "run_activity", projectId: loaded.catalog.project.id, runId }
    ]);
    if (!files.ok) return files;
    const manifest = decodeMaterialized(files.value, readModelPath(loaded, SHARDED_READ_MODEL_PATHS.activityManifest), decodeActivityManifest);
    if (!manifest.ok) return manifest;
    const activity = decodeMaterialized(files.value, readModelPath(loaded, `snapshots/runs/${runId}.json`), decodeRunActivityShard);
    if (!activity.ok) return activity;
    const error = activityManifestIntegrityError(loaded, manifest.value);
    if (error || activity.value.projectId !== loaded.catalog.project.id || activity.value.run.id !== runId || !sameCheckpoint(activity.value.checkpoint, manifest.value.checkpoint)) {
      return integrityFailure(error ?? `Run activity ${runId} does not match its exact-head snapshot manifest.`);
    }
    return activity;
  }

  async #loadEventManifest(loaded: ReadProject): Promise<ApiResult<ProjectEventManifestReadModel>> {
    const files = await this.#readStateFiles(loaded, [{ kind: "project_read_model", projectId: loaded.catalog.project.id, model: "event_index" }]);
    if (!files.ok) return files;
    const indexed = decodeMaterialized(files.value, readModelPath(loaded, SHARDED_READ_MODEL_PATHS.eventManifest), decodeEventManifest);
    if (!indexed.ok) return indexed;
    return indexed.value.projectId === loaded.catalog.project.id && sameCheckpoint(indexed.value.checkpoint, loaded.catalog.checkpoint)
      ? indexed
      : integrityFailure("Project Event manifest does not match its exact-head catalog checkpoint.");
  }

  async #loadEventShards(loaded: ReadProject, manifest: ProjectEventManifestReadModel, indexes: readonly number[]) {
    if (indexes.length === 0) return apiOk<readonly import("./sharded-read-models.ts").ProjectEventShardReadModel[]>([]);
    const files = await this.#readStateFiles(loaded, indexes.map(shard => ({ kind: "event_index_shard" as const, projectId: loaded.catalog.project.id, shard })));
    if (!files.ok) return files;
    const shards = [];
    for (const index of indexes) {
      const descriptor = manifest.shards[index];
      if (!descriptor) return integrityFailure(`Event shard ${index} is missing from its exact-head manifest.`);
      const path = readModelPath(loaded, descriptor.path);
      const shard = decodeMaterialized(files.value, path, decodeEventShard);
      if (!shard.ok) return shard;
      if (shard.value.projectId !== loaded.catalog.project.id || shard.value.index !== index || !sameCheckpoint(shard.value.checkpoint, manifest.checkpoint)
        || shard.value.sequenceStart !== descriptor.sequenceStart || shard.value.sequenceEnd !== descriptor.sequenceEnd
        || shard.value.entries.length !== descriptor.count || materializedEnvelopeDigest(files.value, path) !== descriptor.digest
        || shard.value.entries[0]?.storedEventId !== descriptor.firstStoredEventId
        || shard.value.entries.at(-1)?.storedEventId !== descriptor.lastStoredEventId
        || shard.value.entries[0]?.domainEventId !== descriptor.firstDomainEventId
        || shard.value.entries.at(-1)?.domainEventId !== descriptor.lastDomainEventId
      ) return integrityFailure(`Event shard ${index} does not match its exact-head manifest.`);
      shards.push(shard.value);
    }
    return apiOk(shards);
  }

  async #loadEventLocator(loaded: ReadProject, eventId: string) {
    const files = await this.#readStateFiles(loaded, [
      { kind: "project_read_model", projectId: loaded.catalog.project.id, model: "event_index" },
      { kind: "event_locator", projectId: loaded.catalog.project.id, eventId }
    ]);
    if (!files.ok) return files;
    const manifest = decodeMaterialized(files.value, readModelPath(loaded, SHARDED_READ_MODEL_PATHS.eventManifest), decodeEventManifest);
    if (!manifest.ok) return manifest;
    if (manifest.value.projectId !== loaded.catalog.project.id || !sameCheckpoint(manifest.value.checkpoint, loaded.catalog.checkpoint)) {
      return integrityFailure("Project Event manifest does not match its exact-head catalog checkpoint.");
    }
    const locator = decodeMaterialized(files.value, readModelPath(loaded, `indexes/events/by-domain/${eventId}.json`), decodeEventLocator);
    if (!locator.ok) return locator;
    return locator.value.projectId === loaded.catalog.project.id && locator.value.eventId === eventId && sameCheckpoint(locator.value.checkpoint, manifest.value.checkpoint)
      ? locator
      : integrityFailure(`Event locator ${eventId} does not match its exact-head Event manifest.`);
  }

  async #verifyNodeAnchor(loaded: ReadProject, card: ProjectGraphNode): Promise<ApiResult<true>> {
    return this.#verifyNodeAnchors(loaded, [card]);
  }

  async #verifyNodeAnchors(loaded: ReadProject, cards: readonly ProjectGraphNode[]): Promise<ApiResult<true>> {
    if (cards.length === 0) return apiOk(true);
    const anchors = await this.#transport.readManagedNodeAnchors(loaded.repository, loaded.catalog.project.id, cards.map(card => card.sha));
    if (!anchors.ok) return transportFailure(anchors.error);
    const bySha = new Map(anchors.value.map(anchor => [anchor.nodeSha, anchor]));
    if (bySha.size !== cards.length) return integrityFailure("Exact managed Node verification returned duplicate or missing anchors.");
    for (const card of cards) {
      const anchor = bySha.get(card.sha);
      if (!anchor || anchor.managedRef !== card.managedRef || anchor.treeSha !== card.treeSha || commitTitle(anchor.commitMessage) !== card.commitTitle) {
        return integrityFailure(`Managed Node ref ${card.managedRef} does not match its Graph registration metadata.`);
      }
    }
    return apiOk(true);
  }

  async #readStateFiles(
    loaded: ReadProject,
    selections: readonly StateFileSelection[]
  ): Promise<ApiResult<Readonly<Record<string, string>>>> {
    const requested = selections.map(selection => ({ selection, path: exactStateFilePath(selection) }));
    const missing = requested.filter(item => !this.#readStateFilesByHead.has(readFileCacheKey(loaded, item.path)));
    if (missing.length > 0) {
      const read = await this.#transport.readStateFilesAtHead(loaded.repository, loaded.stateHeadSha, missing.map(item => item.selection));
      if (!read.ok) return read.error.code === "not_found" ? integrityFailure(read.error.message) : transportFailure(read.error);
      if (read.value.stateHeadSha !== loaded.stateHeadSha) return integrityFailure("Targeted state read returned a different state head.");
      if (read.value.v2State !== "present") return integrityFailure("Targeted Project read resolved an absent Hunsu v2 state tree.");
      const returned = Object.keys(read.value.files).sort();
      const expected = missing.map(item => item.path).sort();
      if (returned.length !== expected.length || returned.some((path, index) => path !== expected[index])) {
        return integrityFailure("Targeted state read returned missing or unrequested resources.");
      }
      for (const [path, content] of Object.entries(read.value.files)) {
        this.#readStateFilesByHead.set(readFileCacheKey(loaded, path), content);
      }
    }
    const files: Record<string, string> = {};
    for (const item of requested) {
      const content = this.#readStateFilesByHead.get(readFileCacheKey(loaded, item.path));
      if (content === undefined) return integrityFailure(`Targeted state cache is missing ${item.path}.`);
      Object.defineProperty(files, item.path, { value: content, enumerable: true, configurable: true, writable: true });
    }
    return apiOk(files);
  }

  #projectList(loaded: readonly LoadedProject[]) {
    return {
      schema: "hunsu.web.project-list.v2" as const,
      projects: projectListProjection(loaded.map(item => ({ state: item.state, context: projectionContext(item) })))
    };
  }

  #projectContext(loaded: LoadedProject) {
    const graph = projectGraphProjection(loaded.state, projectIdOf(loaded.state), projectionContext(loaded), { limit: 1, cursor: null });
    if (!graph.ok) throw new BoundaryError(projectionApiError(graph.error));
    return {
      schema: "hunsu.web.project-context.v2" as const,
      project: graph.value.project,
      stateHeadSha: loaded.stateHeadSha,
      repositoryState: initializedRepositoryV2State(loaded.stateHeadSha),
      integrity: graph.value.integrity,
      activeRunCount: loaded.state.runs.filter(run => run.status === "running").length
    };
  }

  #graph(loaded: LoadedProject, options: { limit: number; cursor: string | null }): ApiResult<unknown> {
    const projected = projectGraphProjection(loaded.state, projectIdOf(loaded.state), projectionContext(loaded), options);
    return projected.ok
      ? apiOk({ schema: "hunsu.web.project-graph.v2", ...projected.value })
      : projectionFailure(projected);
  }

  #events(loaded: LoadedProject, query: JsonRecord): ApiResult<unknown> {
    const projectId = projectIdOf(loaded.state);
    const limit = optionalPositiveInteger(query, "limit") ?? 50;
    if (limit > 50) return invalidRequest("Events limit cannot exceed 50.");
    const rawCursor = optionalString(query, "cursor");
    if (rawCursor !== undefined && !EVENT_CURSOR.test(rawCursor)) return invalidRequest("Events cursor must be a positive sequence number.");
    const cursor = rawCursor === undefined ? Number.POSITIVE_INFINITY : Number(rawCursor);
    const eventType = optionalString(query, "eventType") ?? optionalString(query, "type");
    const nodeSha = optionalString(query, "nodeSha");
    if (nodeSha !== undefined) requiredFullSha(nodeSha, "nodeSha");
    const actor = optionalString(query, "actor")?.toLowerCase();
    const from = optionalString(query, "occurredFrom") ?? optionalString(query, "from");
    const to = optionalString(query, "occurredTo") ?? optionalString(query, "to");
    const search = optionalString(query, "search")?.toLowerCase();
    if (from !== undefined) asTimestamp(from);
    if (to !== undefined) asTimestamp(to);
    const fromEpoch = from === undefined ? undefined : Date.parse(from);
    const toEpoch = to === undefined ? undefined : Date.parse(to);
    if (fromEpoch !== undefined && toEpoch !== undefined && fromEpoch > toEpoch) {
      return invalidRequest("Events from timestamp cannot be later than the to timestamp.");
    }
    const sequenced: SequencedDomainEvent[] = loaded.events
      .map(entry => ({ sequence: entry.sequence, event: entry.event, actor: entry.event.meta.actor }))
      .filter(entry => entry.sequence < cursor)
      .sort((left, right) => right.sequence - left.sequence);
    const projected = eventListProjection(loaded.state, sequenced).filter(item => {
      if (eventType !== undefined && item.type !== eventType) return false;
      if (nodeSha !== undefined && !eventReferencesNode(item.reference, nodeSha)) return false;
      if (actor !== undefined && !item.actor.id.toLowerCase().includes(actor) && !item.actor.label.toLowerCase().includes(actor)) return false;
      const occurredAt = Date.parse(item.occurredAt);
      if (fromEpoch !== undefined && occurredAt < fromEpoch) return false;
      if (toEpoch !== undefined && occurredAt > toEpoch) return false;
      if (search !== undefined && !`${item.type} ${item.summary}`.toLowerCase().includes(search)) return false;
      return true;
    });
    const page = projected.slice(0, limit);
    const nextCursor = projected.length > page.length && page.length > 0 ? String(page[page.length - 1]!.sequence) : null;
    const graph = projectGraphProjection(loaded.state, projectId, projectionContext(loaded), { limit: 1, cursor: null });
    if (!graph.ok) return projectionFailure(graph);
    return apiOk({
      schema: "hunsu.web.events.v2",
      project: graph.value.project,
      stateHeadSha: loaded.stateHeadSha,
      events: page,
      nextCursor
    });
  }

  #event(loaded: LoadedProject, eventId: string): ApiResult<unknown> {
    const entry = loaded.events.find(item => item.event.meta.eventId === eventId);
    if (!entry) return notFound(`Event ${eventId} was not found.`);
    const event = eventListProjection(loaded.state, [{ sequence: entry.sequence, event: entry.event, actor: entry.event.meta.actor }])[0]!;
    const graph = projectGraphProjection(loaded.state, projectIdOf(loaded.state), projectionContext(loaded), { limit: 1, cursor: null });
    if (!graph.ok) return projectionFailure(graph);
    return apiOk({
      schema: "hunsu.web.event-detail.v2",
      project: graph.value.project,
      stateHeadSha: loaded.stateHeadSha,
      event
    });
  }

  async #checkpointRunFromTool(context: AuthContext, input: JsonRecord) {
    const repository = await this.#repositoryFromInput(context, record(input, "repository"), true);
    return repository.ok ? this.#checkpointRun(repository.value, context, input) : repository;
  }

  async #attachEvidenceFromTool(context: AuthContext, input: JsonRecord) {
    const repository = await this.#repositoryFromInput(context, record(input, "repository"), true);
    return repository.ok ? this.#attachEvidence(repository.value, context, input) : repository;
  }

  async #completeRunFromTool(context: AuthContext, input: JsonRecord) {
    const repository = await this.#repositoryFromInput(context, record(input, "repository"), true);
    return repository.ok ? this.#completeRun(repository.value, context, input) : repository;
  }

  async #failRunFromTool(context: AuthContext, input: JsonRecord) {
    const repository = await this.#repositoryFromInput(context, record(input, "repository"), true);
    return repository.ok ? this.#terminalRun(repository.value, context, input, "fail") : repository;
  }

  async #cancelRunFromTool(context: AuthContext, input: JsonRecord) {
    const repository = await this.#repositoryFromInput(context, record(input, "repository"), true);
    return repository.ok ? this.#terminalRun(repository.value, context, input, "cancel") : repository;
  }

  async #reviewFromTool(context: AuthContext, input: JsonRecord) {
    const repository = await this.#repositoryFromInput(context, record(input, "repository"), true);
    return repository.ok ? this.#recordReview(repository.value, context, input) : repository;
  }

  async #proposalFromTool(context: AuthContext, input: JsonRecord) {
    const repository = await this.#repositoryFromInput(context, record(input, "repository"), true);
    return repository.ok ? this.#proposeTransition(repository.value, context, input) : repository;
  }

  async #confirmProposalFromTool(context: AuthContext, input: JsonRecord) {
    const repository = await this.#repositoryFromInput(context, record(input, "repository"), true);
    return repository.ok ? this.#confirmProposal(repository.value, context, input) : repository;
  }

  async #rejectProposalFromTool(context: AuthContext, input: JsonRecord) {
    const repository = await this.#repositoryFromInput(context, record(input, "repository"), true);
    return repository.ok ? this.#rejectProposal(repository.value, context, input) : repository;
  }

  async #compareFromTool(context: AuthContext, input: JsonRecord) {
    const repository = await this.#repositoryFromInput(context, record(input, "repository"), true);
    return repository.ok ? this.#compareAlternatives(repository.value, context, input) : repository;
  }

  async #selectFromTool(context: AuthContext, input: JsonRecord) {
    const repository = await this.#repositoryFromInput(context, record(input, "repository"), true);
    return repository.ok ? this.#decideAlternative(repository.value, context, input, "select") : repository;
  }

  async #rejectAlternativeFromTool(context: AuthContext, input: JsonRecord) {
    const repository = await this.#repositoryFromInput(context, record(input, "repository"), true);
    return repository.ok ? this.#decideAlternative(repository.value, context, input, "reject") : repository;
  }

  #toolMutation(result: ApiResult<unknown>): ApiResult<{ data: unknown; stateHeadSha?: string }> {
    if (!result.ok) return result;
    const value = assertRecord(result.value, "mutation result");
    const stateHeadSha = optionalString(value, "stateHeadSha");
    return apiOk({ data: result.value, ...(stateHeadSha === undefined ? {} : { stateHeadSha }) });
  }

  async #loadToolProject(input: JsonRecord, context: AuthContext, write: boolean): Promise<ApiResult<LoadedProject>> {
    const repository = await this.#repositoryFromInput(context, record(input, "repository"), write);
    return repository.ok ? this.#loadProject(repository.value, requiredString(input, "projectId")) : repository;
  }

  async #loadToolReadProject(input: JsonRecord, context: AuthContext): Promise<ApiResult<ReadProject>> {
    const repository = await this.#repositoryFromInput(context, record(input, "repository"), false);
    return repository.ok ? this.#loadReadProject(repository.value, requiredString(input, "projectId")) : repository;
  }

  async #findReadProject(context: AuthContext, projectId: string): Promise<ApiResult<ReadProject>> {
    asProjectId(projectId);
    const repositories = await this.#authorizedRepositories(context);
    if (!repositories.ok) return repositories;
    const matches: ReadProject[] = [];
    for (const repository of repositories.value) {
      const loaded = await this.#loadRepositoryReadProjects(repository);
      if (!loaded.ok) return loaded;
      matches.push(...loaded.value.filter(item => item.catalog.project.id === projectId));
    }
    if (matches.length === 0) return notFound(`Project ${projectId} was not found.`);
    if (matches.length > 1) return conflict(`Project id ${projectId} exists in more than one authorized repository; use an MCP repository-qualified request.`);
    return apiOk(matches[0]!);
  }

  async #loadAllReadProjects(context: AuthContext, installationId?: number): Promise<ApiResult<ReadProject[]>> {
    const repositories = await this.#authorizedRepositories(context, installationId);
    if (!repositories.ok) return repositories;
    const loaded = await Promise.all(repositories.value.map(repository => this.#loadRepositoryReadProjects(repository)));
    const failure = loaded.find(item => !item.ok);
    if (failure && !failure.ok) return failure;
    return apiOk(loaded.flatMap(item => item.ok ? [...item.value] : []));
  }

  async #loadReadProject(repository: RepositoryGrant, projectId: string): Promise<ApiResult<ReadProject>> {
    const loaded = await this.#loadRepositoryReadProjects(repository);
    if (!loaded.ok) return loaded;
    const project = loaded.value.find(item => item.catalog.project.id === projectId);
    return project ? apiOk(project) : notFound(`Project ${projectId} was not found in ${repository.owner}/${repository.name}.`);
  }

  async #loadRepositoryReadProjects(repository: RepositoryGrant): Promise<ApiResult<readonly ReadProject[]>> {
    const key = repositoryKey(repository);
    const active = this.#readProjectFlights.get(key);
    if (active) return active;
    const generation = this.#readProjectCacheGeneration(repository);
    const flight = this.#loadRepositoryReadProjectsUncoalesced(repository, generation);
    this.#readProjectFlights.set(key, flight);
    try {
      return await flight;
    } finally {
      if (this.#readProjectFlights.get(key) === flight) this.#readProjectFlights.delete(key);
    }
  }

  async #loadRepositoryReadProjectsUncoalesced(
    repository: RepositoryGrant,
    generation: ReadProjectCacheGeneration
  ): Promise<ApiResult<readonly ReadProject[]>> {
    const key = repositoryKey(repository);
    const stateHead = await this.#transport.readBranchHead(repository, HUNSU_STATE_BRANCH);
    if (!stateHead.ok) return transportFailure(stateHead.error);
    if (stateHead.value === undefined) {
      this.#publishReadProjectCache(repository, key, generation, { value: [], stateHeadSha: undefined, cachedAt: this.#cacheNow() });
      return apiOk([]);
    }
    const cached = this.#readProjects.get(key);
    // State blobs are immutable at an exact head, but managed Node refs are a
    // separate GitHub authority boundary. Revalidate the root anchor after the
    // bounded Project TTL even when hunsu/state itself has not moved.
    if (cached?.stateHeadSha === stateHead.value
      && fresh(cached.cachedAt, this.#cacheNow(), this.#cachePolicy.projectTtlMs)
    ) return apiOk(cached.value);
    const workspaceSnapshot = await this.#transport.readStateFilesAtHead(repository, stateHead.value, [{ kind: "workspace" }]);
    if (!workspaceSnapshot.ok) {
      return workspaceSnapshot.error.code === "not_found"
        ? integrityFailure(workspaceSnapshot.error.message)
        : transportFailure(workspaceSnapshot.error);
    }
    if (workspaceSnapshot.value.stateHeadSha !== stateHead.value) return integrityFailure("Hunsu workspace was read from a different state head.");
    if (workspaceSnapshot.value.v2State === "absent") {
      this.#publishReadProjectCache(repository, key, generation, { value: [], stateHeadSha: stateHead.value, cachedAt: this.#cacheNow() });
      return apiOk([]);
    }
    const workspace = decodeWorkspace(
      workspaceSnapshot.value.files[".hunsu/v2/workspace.json"],
      repository
    );
    if (!workspace.ok) return workspace;
    if (workspace.value.projectIds.length === 0) {
      this.#publishReadProjectCache(repository, key, generation, { value: [], stateHeadSha: stateHead.value, cachedAt: this.#cacheNow() });
      return apiOk([]);
    }
    const snapshot = await this.#transport.readStateFilesAtHead(repository, stateHead.value, workspace.value.projectIds.map(projectId => ({
      kind: "project_read_model" as const,
      projectId,
      model: "catalog" as const
    })));
    if (!snapshot.ok) return snapshot.error.code === "not_found" ? integrityFailure(snapshot.error.message) : transportFailure(snapshot.error);
    if (snapshot.value.stateHeadSha !== stateHead.value) return integrityFailure("Project catalogs were read from a different state head.");
    if (snapshot.value.v2State !== "present") return integrityFailure("Hunsu v2 workspace references catalogs in an absent v2 state tree.");
    const synchronizedAt = this.#timestamp();
    const projects: ReadProject[] = [];
    for (const [path, content] of Object.entries(snapshot.value.files).sort(([left], [right]) => left.localeCompare(right))) {
      const match = path.match(/^\.hunsu\/v2\/projects\/([^/]+)\/project\.json$/u);
      if (!match?.[1]) return integrityFailure(`Targeted catalog read returned an unsupported path ${path}.`);
      let input: unknown;
      try {
        input = JSON.parse(content);
      } catch {
        return integrityFailure(`Project catalog ${path} is not valid JSON.`);
      }
      const decoded = decodeShardedProjectCatalog(input);
      if (!decoded.ok) return integrityFailure(decoded.error.message);
      if (decoded.value.project.id !== match[1]
        || decoded.value.project.repository.owner.toLowerCase() !== repository.owner.toLowerCase()
        || decoded.value.project.repository.name.toLowerCase() !== repository.name.toLowerCase()
      ) return integrityFailure(`Project catalog ${path} does not match its repository or Project path.`);
      const anchor = decoded.value.rootAnchor;
      const verified = await this.#transport.readManagedNodeAnchors(repository, decoded.value.project.id, [anchor.nodeSha]);
      if (!verified.ok) return transportFailure(verified.error);
      const actual = verified.value[0];
      if (!actual || actual.managedRef !== anchor.managedRef || actual.nodeSha !== anchor.nodeSha
        || actual.treeSha !== anchor.treeSha || commitTitle(actual.commitMessage) !== anchor.commitTitle) {
        return integrityFailure(`Root managed Node ref ${anchor.managedRef} does not match its exact-head Project catalog.`);
      }
      projects.push({ repository, stateHeadSha: stateHead.value, synchronizedAt, catalog: decoded.value });
    }
    if (projects.length !== workspace.value.projectIds.length
      || projects.some((project, index) => project.catalog.project.id !== workspace.value.projectIds[index])
    ) return integrityFailure("Hunsu workspace Project ids do not exactly match the catalog materializations.");
    this.#publishReadProjectCache(repository, key, generation, {
      value: projects,
      stateHeadSha: stateHead.value,
      cachedAt: this.#cacheNow()
    });
    return apiOk(projects);
  }

  async #findProject(context: AuthContext, projectId: string, write = false): Promise<ApiResult<LoadedProject>> {
    asProjectId(projectId);
    const repositories = await this.#authorizedRepositories(context);
    if (!repositories.ok) return repositories;
    const matches: LoadedProject[] = [];
    for (const repository of repositories.value) {
      const loaded = await this.#loadRepositoryProjects(repository);
      if (!loaded.ok) return loaded;
      matches.push(...loaded.value.filter(item => projectIdOf(item.state) === projectId));
    }
    if (matches.length === 0) return notFound(`Project ${projectId} was not found.`);
    if (matches.length > 1) return conflict(`Project id ${projectId} exists in more than one authorized repository; use an MCP repository-qualified request.`);
    if (write && matches[0]!.repository.permissions.contents !== "write") return forbidden("This repository grant does not allow Hunsu state writes.");
    return apiOk(matches[0]!);
  }

  async #loadAllProjects(context: AuthContext, installationId?: number): Promise<ApiResult<LoadedProject[]>> {
    const repositories = await this.#authorizedRepositories(context, installationId);
    if (!repositories.ok) return repositories;
    const loaded = await Promise.all(repositories.value.map(repository => this.#loadRepositoryProjects(repository)));
    const failure = loaded.find(item => !item.ok);
    if (failure && !failure.ok) return failure;
    return apiOk(loaded.flatMap(item => item.ok ? [...item.value] : []));
  }

  async #loadProject(repository: RepositoryGrant, projectId: string, force = false): Promise<ApiResult<LoadedProject>> {
    const loaded = await this.#loadRepositoryProjects(repository, force);
    if (!loaded.ok) return loaded;
    const project = loaded.value.find(item => projectIdOf(item.state) === projectId);
    return project ? apiOk(project) : notFound(`Project ${projectId} was not found in ${repository.owner}/${repository.name}.`);
  }

  async #loadRepositoryProjects(repository: RepositoryGrant, force = false): Promise<ApiResult<readonly LoadedProject[]>> {
    const key = repositoryKey(repository);
    const cached = this.#projects.get(key);
    if (!force && cached && fresh(cached.cachedAt, this.#cacheNow(), this.#cachePolicy.projectTtlMs)) return apiOk(cached.value);
    const reconstructed = await this.#store.reconstructRepository(repository);
    if (!reconstructed.ok) return storeFailure(reconstructed.error);
    const synchronizedAt = this.#timestamp();
    const value: LoadedProject[] = reconstructed.value.kind === "state_branch_missing"
      ? []
      : reconstructed.value.projects.map(project => ({
          repository,
          state: project.state,
          stateHeadSha: project.stateHeadSha,
          synchronizedAt,
          events: project.events
        }));
    this.#projects.set(key, { value, cachedAt: this.#cacheNow() });
    return apiOk(value);
  }

  async #repositoryFromInput(context: AuthContext, input: JsonRecord, write: boolean): Promise<ApiResult<RepositoryGrant>> {
    assertExactRecord(input, "repository", ["installationId", "repositoryId", "owner", "name", "defaultBranch"]);
    const owner = requiredString(input, "owner");
    const name = requiredString(input, "name");
    const installationId = optionalPositiveInteger(input, "installationId");
    const repositoryId = optionalPositiveInteger(input, "repositoryId");
    const repositories = await this.#authorizedRepositories(context, installationId);
    if (!repositories.ok) return repositories;
    const match = repositories.value.find(repository =>
      repository.owner.toLowerCase() === owner.toLowerCase()
      && repository.name.toLowerCase() === name.toLowerCase()
      && (repositoryId === undefined || repository.repositoryId === repositoryId));
    if (!match) return forbidden(`Repository ${owner}/${name} is not granted to this session.`);
    if (write && match.permissions.contents !== "write") return forbidden(`Repository ${owner}/${name} does not grant Contents write access.`);
    return apiOk(match);
  }

  async #repositoryV2State(repository: RepositoryGrant): Promise<ApiResult<RepositoryV2InitializationState>> {
    const stateHead = await this.#transport.readBranchHead(repository, HUNSU_STATE_BRANCH);
    if (!stateHead.ok) return transportFailure(stateHead.error);
    if (stateHead.value === undefined) {
      const defaultHead = await this.#transport.readBranchHead(repository, repository.defaultBranch);
      if (!defaultHead.ok) return transportFailure(defaultHead.error);
      if (defaultHead.value === undefined || !FULL_SHA.test(defaultHead.value)) {
        return integrityFailure(`Default branch ${repository.defaultBranch} does not resolve to a full commit SHA.`);
      }
      return apiOk({
        status: "uninitialized",
        expectedStateSource: "default_branch_head",
        expectedStateSha: defaultHead.value
      });
    }
    if (!FULL_SHA.test(stateHead.value)) return integrityFailure("hunsu/state does not resolve to a full commit SHA.");
    const snapshot = await this.#transport.readStateFilesAtHead(repository, stateHead.value, [{ kind: "workspace" }]);
    if (!snapshot.ok) {
      return snapshot.error.code === "not_found"
        ? integrityFailure(snapshot.error.message)
        : transportFailure(snapshot.error);
    }
    if (snapshot.value.stateHeadSha !== stateHead.value) {
      return integrityFailure("Hunsu v2 initialization status was read from a different state head.");
    }
    if (snapshot.value.v2State === "absent") {
      return apiOk({
        status: "uninitialized",
        expectedStateSource: "state_branch_head",
        stateHeadSha: stateHead.value,
        expectedStateSha: stateHead.value
      });
    }
    const workspace = decodeWorkspace(snapshot.value.files[".hunsu/v2/workspace.json"], repository);
    if (!workspace.ok) return workspace;
    return apiOk(initializedRepositoryV2State(stateHead.value));
  }

  async #authorizedRepositories(context: AuthContext, onlyInstallationId?: number): Promise<ApiResult<readonly RepositoryGrant[]>> {
    const installations = context.installations.filter(item => onlyInstallationId === undefined || item.id === onlyInstallationId);
    if (onlyInstallationId !== undefined && installations.length === 0) return forbidden(`Installation ${onlyInstallationId} is not authorized for this session.`);
    const collected: RepositoryGrant[] = [];
    for (const installation of installations) {
      let repositories = this.#installations.get(installation.id);
      if (!repositories || !fresh(repositories.cachedAt, this.#cacheNow(), this.#cachePolicy.installationTtlMs)) {
        const generation = this.#installationCacheGeneration(installation.id);
        const listed = await this.#listInstallationRepositories(installation.id);
        if (!listed.ok) return transportFailure(listed.error);
        repositories = { value: listed.value, cachedAt: this.#cacheNow() };
        if (this.#isCurrentInstallationCacheGeneration(installation.id, generation)) {
          this.#installations.set(installation.id, repositories);
        }
      }
      const authorized = new Map(installation.repositories.map(item => [item.repositoryId, item.permissions.contents]));
      for (const repository of repositories.value) {
        const contents = authorized.get(repository.repositoryId);
        if (!contents) continue;
        collected.push({ ...repository, permissions: { contents } });
      }
    }
    return apiOk(collected);
  }

  async #listInstallationRepositories(installationId: number) {
    const active = this.#installationFlights.get(installationId);
    if (active) return active;
    const flight = this.#transport.listInstallationRepositories(installationId);
    this.#installationFlights.set(installationId, flight);
    try {
      return await flight;
    } finally {
      if (this.#installationFlights.get(installationId) === flight) this.#installationFlights.delete(installationId);
    }
  }

  #installationCacheGeneration(installationId: number): InstallationCacheGeneration {
    return {
      global: this.#globalCacheGeneration,
      installation: this.#installationCacheGenerations.get(installationId) ?? 0
    };
  }

  #readProjectCacheGeneration(repository: RepositoryGrant): ReadProjectCacheGeneration {
    return {
      ...this.#installationCacheGeneration(repository.installationId),
      repository: this.#repositoryCacheGenerations.get(repositoryKey(repository)) ?? 0
    };
  }

  #isCurrentInstallationCacheGeneration(
    installationId: number,
    generation: InstallationCacheGeneration
  ): boolean {
    return generation.global === this.#globalCacheGeneration
      && generation.installation === (this.#installationCacheGenerations.get(installationId) ?? 0);
  }

  #publishReadProjectCache(
    repository: RepositoryGrant,
    key: string,
    generation: ReadProjectCacheGeneration,
    cache: ReadProjectCache
  ): void {
    if (this.#isCurrentInstallationCacheGeneration(repository.installationId, generation)
      && generation.repository === (this.#repositoryCacheGenerations.get(key) ?? 0)
    ) this.#readProjects.set(key, cache);
  }

  #timestamp(): string {
    const value = this.#now();
    if (!Number.isFinite(value.valueOf())) throw new Error("Clock returned an invalid timestamp.");
    return value.toISOString();
  }
}

function buildNode(input: {
  type: "root";
  projectId: string;
  commitSha: string;
  treeSha: string;
  commitTitle: string;
  plan: NodePlan;
  registeredAt: string;
}): RootNode;
function buildNode(input: {
  type: "run_child";
  projectId: string;
  commitSha: string;
  treeSha: string;
  commitTitle: string;
  plan: NodePlan;
  registeredAt: string;
  parentSha: string;
  runId: string;
  consumedGoalDigest: string;
}): RunChildNode;
function buildNode(input: {
  type: "coaching_child";
  projectId: string;
  commitSha: string;
  treeSha: string;
  commitTitle: string;
  plan: NodePlan;
  registeredAt: string;
  parentSha: string;
  proposalId: string;
}): CoachingChildNode;
function buildNode(input: {
  type: "root";
  projectId: string;
  commitSha: string;
  treeSha: string;
  commitTitle: string;
  plan: NodePlan;
  registeredAt: string;
} | {
  type: "run_child";
  projectId: string;
  commitSha: string;
  treeSha: string;
  commitTitle: string;
  plan: NodePlan;
  registeredAt: string;
  parentSha: string;
  runId: string;
  consumedGoalDigest: string;
} | {
  type: "coaching_child";
  projectId: string;
  commitSha: string;
  treeSha: string;
  commitTitle: string;
  plan: NodePlan;
  registeredAt: string;
  parentSha: string;
  proposalId: string;
}): Node {
  const projectId = asProjectId(input.projectId);
  const commitSha = asGitSha(input.commitSha);
  const base = {
    projectId,
    commitSha,
    treeSha: asTreeSha(input.treeSha),
    managedRef: managedNodeRef(projectId, commitSha),
    commitTitle: asText(input.commitTitle),
    plan: input.plan,
    planDigest: computeNodePlanDigest(input.plan),
    payloadDigest: asNodePayloadDigest("hunsu-node-payload-v1:sha256:" + "0".repeat(64)),
    registeredAt: asTimestamp(input.registeredAt)
  };
  const provisional: Node = input.type === "root"
    ? { ...base, type: "root" }
    : input.type === "run_child"
      ? {
          ...base,
          type: "run_child",
          parentSha: asGitSha(input.parentSha),
          runId: asRunId(input.runId),
          consumedGoalDigest: asGoalDigest(input.consumedGoalDigest)
        }
      : {
          ...base,
          type: "coaching_child",
          parentSha: asGitSha(input.parentSha),
          proposalId: asProposalId(input.proposalId)
        };
  const payload: NodePayload = {
    schema: NODE_PAYLOAD_SCHEMA,
    projectId,
    commitSha,
    treeSha: base.treeSha,
    plan: input.plan
  };
  return { ...provisional, payloadDigest: computeNodePayloadDigest(payload) };
}

function encodeNode(node: Node) {
  const encoded = encodeNodeEnvelope({
    schema: NODE_PAYLOAD_SCHEMA,
    projectId: node.projectId,
    commitSha: node.commitSha,
    treeSha: node.treeSha,
    plan: node.plan
  });
  if (!encoded.ok) throw boundaryInvalid(encoded.error.message);
  return encoded.value;
}

function runContract(run: Run, repository: RepositoryGrant, now: Date, execution: RunnerExecution): RunContract {
  const runner = plainRunner(run.runner);
  const goal = {
    key: String(run.goal.key),
    title: String(run.goal.title),
    desiredOutcome: String(run.goal.desiredOutcome),
    acceptanceCriteria: run.goal.acceptanceCriteria.map(String) as [string, ...string[]],
    constraints: run.goal.constraints.map(String),
    priority: Number(run.goal.priority)
  };
  return {
    schema: "hunsu.run-contract.v2",
    runId: String(run.id),
    projectId: String(run.projectId),
    sourceNodeSha: String(run.sourceNodeSha),
    goal,
    goalDigest: String(run.goalDigest) as RunContract["goalDigest"],
    runner,
    runnerDigest: String(run.runnerDigest) as RunContract["runnerDigest"],
    repository: {
      installationId: repository.installationId,
      repositoryId: repository.repositoryId,
      owner: repository.owner,
      name: repository.name,
      branch: String(run.branch)
    },
    instructions: execution.instructions,
    requiredEvidence: goal.acceptanceCriteria.map(criterion => ({
      criterion,
      kind: "check" as const,
      description: `Provide immutable evidence that satisfies: ${criterion}`,
      required: true
    })),
    toolPolicy: execution.toolPolicy,
    lease: {
      expiresAt: new Date(now.valueOf() + 60 * 60 * 1_000).toISOString(),
      checkpointAfterSeconds: 300
    }
  };
}

function plainRunner(runner: RunnerValue): RunContract["runner"] {
  return {
    schema: "hunsu.runner-value.v1",
    type: {
      origin: String(runner.type.origin),
      key: String(runner.type.key),
      schemaVersion: String(runner.type.schemaVersion),
      integrity: String(runner.type.integrity) as RunContract["runner"]["type"]["integrity"]
    },
    name: String(runner.name),
    value: runner.value
  };
}

function evidenceRef(projectId: string, runId: string, value: unknown, evidenceId: string, at: string): EvidenceRef {
  const input = assertExactRecord(value, "evidence", ["kind", "summary", "target", "location"]);
  const kind = requiredString(input, "kind");
  if (kind !== "diff" && kind !== "check" && kind !== "screenshot" && kind !== "report" && kind !== "note") {
    throw boundaryInvalid("evidence.kind is invalid.");
  }
  const targetRecord = assertRecord(input.target, "evidence.target");
  const targetType = requiredString(targetRecord, "type");
  const targetInput = assertExactRecord(
    targetRecord,
    "evidence.target",
    targetType === "criterion" ? ["type", "criterion"] : ["type"]
  );
  const target = targetType === "run"
    ? { type: "run" as const }
    : targetType === "criterion"
      ? { type: "criterion" as const, criterion: asAcceptanceCriterion(requiredString(targetInput, "criterion"), "evidence.target.criterion") }
      : (() => { throw boundaryInvalid("evidence.target.type is invalid."); })();
  const locationRecord = assertRecord(input.location, "evidence.location");
  const locationType = requiredString(locationRecord, "type");
  const locationInput = assertExactRecord(
    locationRecord,
    "evidence.location",
    locationType === "git" ? ["type", "commitSha", "path"] : locationType === "url" ? ["type", "url"] : ["type", "text"]
  );
  const location = locationType === "git"
    ? {
        type: "git" as const,
        commitSha: asGitSha(requiredSha(locationInput, "commitSha")),
        path: asGitTreePath(requiredString(locationInput, "path"), "evidence.location.path")
      }
    : locationType === "url"
      ? { type: "url" as const, url: asText(safeHttpUrl(requiredString(locationInput, "url")), "evidence.location.url") }
      : locationType === "text"
        ? { type: "text" as const, text: asText(requiredString(locationInput, "text"), "evidence.location.text") }
        : (() => { throw boundaryInvalid("evidence.location.type is invalid."); })();
  return {
    id: asEvidenceId(evidenceId),
    projectId: asProjectId(projectId),
    runId: asRunId(runId),
    target,
    kind,
    summary: asEvidenceSummary(requiredString(input, "summary")),
    location,
    recordedAt: asTimestamp(at)
  };
}

function parseCheckpointLocation(input: JsonRecord) {
  const type = requiredString(input, "type");
  if (type === "observation") {
    assertExactRecord(input, "location", ["type"]);
    return { type: "observation" as const };
  }
  if (type === "commit") {
    assertExactRecord(input, "location", ["type", "commitSha"]);
    return { type: "commit" as const, commitSha: asGitSha(requiredSha(input, "commitSha")) };
  }
  throw boundaryInvalid("location.type must be observation or commit.");
}

function parseComparisonFindings(value: unknown): readonly ComparisonFinding[] {
  if (!Array.isArray(value)) throw boundaryInvalid("findings must be an array.");
  return value.map((item, index) => {
    const finding = assertExactRecord(item, `findings[${index}]`, ["criterion", "summaries"]);
    const summariesInput = array(finding, "summaries", true);
    const summaries = summariesInput.map((summary, summaryIndex) => {
      const row = assertExactRecord(summary, `findings[${index}].summaries[${summaryIndex}]`, ["nodeSha", "summary"]);
      return {
        nodeSha: asGitSha(requiredSha(row, "nodeSha")),
        summary: asEvidenceSummary(requiredString(row, "summary"))
      };
    });
    return {
      subject: asText(requiredString(finding, "criterion")),
      summaries: asNonEmpty(summaries, `findings[${index}].summaries`)
    };
  });
}

function decodePlan(value: unknown, runnerTypes: RunnerValueTypeRegistry): NodePlan {
  const decoded = decodeNodePlan(value, runnerTypes, "nodePlan");
  if (!decoded.ok) throw boundaryInvalid(`${decoded.error.path}: ${decoded.error.message}`);
  return decoded.value;
}

function decodeWorkspace(
  content: string | undefined,
  repository: RepositoryGrant
): ApiResult<{ projectIds: readonly string[] }> {
  if (content === undefined) return integrityFailure("Exact Hunsu workspace read did not return workspace.json.");
  let input: unknown;
  try {
    input = JSON.parse(content);
  } catch {
    return integrityFailure("Hunsu workspace is not valid JSON.");
  }
  if (!isRecord(input)) return integrityFailure("Hunsu workspace must be an object.");
  const keys = Object.keys(input).sort();
  const expected = ["installationId", "projectIds", "repository", "repositoryId", "schema"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    return integrityFailure("Hunsu workspace contains missing or unsupported fields.");
  }
  if (input.schema !== "hunsu.workspace.v2"
    || input.installationId !== repository.installationId
    || input.repositoryId !== repository.repositoryId
    || typeof input.repository !== "string"
    || input.repository.toLowerCase() !== `${repository.owner}/${repository.name}`.toLowerCase()
    || !Array.isArray(input.projectIds)
    || input.projectIds.some(projectId => typeof projectId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(projectId))
  ) return integrityFailure("Hunsu workspace does not match its authorized repository identity.");
  const projectIds = input.projectIds as string[];
  if (new Set(projectIds).size !== projectIds.length
    || projectIds.some((projectId, index) => index > 0 && projectIds[index - 1]!.localeCompare(projectId) >= 0)
  ) return integrityFailure("Hunsu workspace Project ids must be unique and canonically ordered.");
  return apiOk({ projectIds });
}

function readProjectSummary(loaded: ReadProject) {
  const project = loaded.catalog.project;
  return {
    id: project.id,
    title: project.title,
    repository: {
      owner: loaded.repository.owner,
      name: loaded.repository.name,
      url: `https://github.com/${loaded.repository.owner}/${loaded.repository.name}`,
      defaultBranch: loaded.repository.defaultBranch
    },
    rootNodeSha: project.rootNodeSha
  };
}

function initializedRepositoryV2State(stateHeadSha: string): RepositoryV2InitializationState {
  if (!FULL_SHA.test(stateHeadSha)) throw new Error("Initialized repository state requires a full state-head SHA.");
  return {
    status: "initialized",
    expectedStateSource: "state_branch_head",
    stateHeadSha,
    expectedStateSha: stateHeadSha
  };
}

function readGraphNode(node: ProjectGraphNode) {
  return {
    sha: node.sha,
    title: node.commitTitle,
    status: node.status,
    runner: {
      name: node.runner.name,
      typeKey: node.runner.typeKey,
      schemaVersion: node.runner.schemaVersion,
      digest: node.runner.digest
    },
    nextGoalCount: node.nextGoalCount,
    integrity: "valid" as const
  };
}

function readGraphEdge(edge: ProjectGraphEdge) {
  return edge.type === "run"
    ? {
        kind: "run" as const, id: `run:${edge.runId}`, sourceSha: edge.sourceSha, targetSha: edge.targetSha,
        runId: edge.runId, goal: { digest: edge.goalDigest, title: edge.goalTitle }, completedAt: edge.completedAt
      }
    : {
        kind: "coaching" as const, id: `coaching:${edge.proposalId}`, sourceSha: edge.sourceSha, targetSha: edge.targetSha,
        proposalId: edge.proposalId, summary: edge.summary, confirmedAt: edge.confirmedAt
      };
}

function readNodeLineage(node: ProjectGraphNode) {
  return node.lineage.type === "root"
    ? { kind: "root" as const }
    : node.lineage.type === "run"
      ? { kind: "run_child" as const, parentSha: node.lineage.parentSha, runId: node.lineage.runId, goalDigest: node.lineage.consumedGoalDigest }
      : { kind: "coaching_child" as const, parentSha: node.lineage.parentSha, proposalId: node.lineage.proposalId };
}

function readEvidenceSummary(loaded: ReadProject, activity: Pick<NodeActivityShardReadModel, "runs">, evidence: EvidenceActivityReadModel) {
  const run = activity.runs.find(item => item.id === evidence.runId);
  const kind = evidence.kind === "diff" ? "commit"
    : evidence.kind === "check" ? "check"
      : evidence.kind === "report" ? "report"
        : evidence.kind === "screenshot" ? "artifact" : "link";
  return {
    id: evidence.id,
    kind,
    title: evidence.summary,
    summary: evidence.summary,
    criterion: evidence.target.type === "criterion" && run
      ? { kind: "linked" as const, goalDigest: run.goalDigest, criterion: evidence.target.criterion }
      : { kind: "unlinked" as const },
    location: evidence.location.type === "url"
      ? { kind: "url" as const, url: evidence.location.url }
      : evidence.location.type === "git"
        ? { kind: "url" as const, url: `https://github.com/${loaded.repository.owner}/${loaded.repository.name}/blob/${evidence.location.commitSha}/${evidence.location.path}` }
        : { kind: "none" as const },
    createdAt: evidence.recordedAt
  };
}

function readEventIndexEntry(entry: EventIndexEntryReadModel) {
  return {
    sequence: entry.sequence,
    id: entry.domainEventId,
    type: entry.eventType,
    summary: entry.summary,
    actor: entry.actor,
    occurredAt: entry.occurredAt,
    reference: entry.reference
  };
}

function readDomainRun(
  loaded: ReadProject,
  run: RunActivityReadModel,
  goal: NodePlan["nextGoals"][number],
  runner: RunnerValue
): Record<string, unknown> {
  const base = {
    id: run.id,
    projectId: loaded.catalog.project.id,
    sourceNodeSha: run.sourceNodeSha,
    goal,
    goalDigest: run.goalDigest,
    runner,
    runnerDigest: run.runnerDigest,
    branch: run.branch,
    checkpoints: run.checkpoints,
    evidenceIds: run.evidenceIds,
    startedAt: run.startedAt
  };
  switch (run.outcome.type) {
    case "running": return { ...base, status: "running" };
    case "completed": return { ...base, status: "completed", resultNodeSha: run.outcome.nodeSha, verifiedAt: run.outcome.verifiedAt, completedAt: run.outcome.completedAt };
    case "failed": return { ...base, status: "failed", failedAt: run.outcome.failedAt, failureReason: run.outcome.reason };
    case "canceled": return { ...base, status: "canceled", canceledAt: run.outcome.canceledAt, cancellationReason: run.outcome.reason };
  }
}

function readDomainEvidence(loaded: ReadProject, evidence: EvidenceActivityReadModel) {
  return {
    id: evidence.id,
    projectId: loaded.catalog.project.id,
    runId: evidence.runId,
    target: evidence.target,
    kind: evidence.kind,
    summary: evidence.summary,
    location: evidence.location,
    recordedAt: evidence.recordedAt
  };
}

function readModelPath(loaded: ReadProject, relativePath: string): string {
  return `.hunsu/v2/projects/${loaded.catalog.project.id}/${relativePath}`;
}

function nodePayloadPath(loaded: ReadProject, nodeSha: string): string {
  return `.hunsu/v2/projects/${loaded.catalog.project.id}/nodes/${nodeSha}/node.hunsu`;
}

function readFileCacheKey(loaded: ReadProject, path: string): string {
  return `${repositoryKey(loaded.repository)}:${loaded.stateHeadSha}:${path}`;
}

function decodeMaterialized<T>(
  files: Readonly<Record<string, string>>,
  path: string,
  decoder: (input: unknown) => { ok: true; value: T } | { ok: false; error: { message: string } }
): ApiResult<T> {
  const content = files[path];
  if (content === undefined) return integrityFailure(`Required materialization ${path} is missing.`);
  let input: unknown;
  try {
    input = JSON.parse(content);
  } catch {
    return integrityFailure(`Materialization ${path} is not valid JSON.`);
  }
  const decoded = decoder(input);
  return decoded.ok ? apiOk(decoded.value) : integrityFailure(`${path}: ${decoded.error.message}`);
}

function materializedEnvelopeDigest(files: Readonly<Record<string, string>>, path: string): string | undefined {
  const parsed = parseJsonFile(files, path, "Materialization");
  return parsed.ok && isRecord(parsed.value) && typeof parsed.value.digest === "string" ? parsed.value.digest : undefined;
}

function parseJsonFile(
  files: Readonly<Record<string, string>>,
  path: string,
  label: string
): ApiResult<unknown> {
  const content = files[path];
  if (content === undefined) return integrityFailure(`${label} ${path} is missing.`);
  try {
    return apiOk(JSON.parse(content) as unknown);
  } catch {
    return integrityFailure(`${label} ${path} is not valid JSON.`);
  }
}

function parseAuthoritativeEventPath(
  projectId: string,
  path: string
): ApiResult<{ year: number; month: number; eventId: string }> {
  const escapedProjectId = projectId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = path.match(new RegExp(`^\\.hunsu/v2/projects/${escapedProjectId}/events/(\\d{4})/(\\d{2})/([0-9a-f]{32})\\.json$`, "u"));
  if (!match) return integrityFailure("Event locator contains an invalid authoritative Event path.");
  return apiOk({ year: Number(match[1]), month: Number(match[2]), eventId: match[3]! });
}

function authoritativeEventMismatch(
  loaded: ReadProject,
  indexed: EventIndexEntryReadModel,
  stored: StoredProjectEvent<DomainEvent>
): string | undefined {
  const event = stored.event;
  const actor = event.meta.actor.type === "system"
    ? { id: "system", label: "System" }
    : { id: String(event.meta.actor.id), label: event.meta.actor.type === "coach" ? "Coach" : event.meta.actor.type === "plugin" ? "Plugin" : "User" };
  if (stored.projectId !== loaded.catalog.project.id
    || stored.repository.installationId !== loaded.repository.installationId
    || stored.repository.repositoryId !== loaded.repository.repositoryId
    || stored.repository.owner.toLowerCase() !== loaded.repository.owner.toLowerCase()
    || stored.repository.name.toLowerCase() !== loaded.repository.name.toLowerCase()
    || stored.eventId !== indexed.storedEventId
    || stored.sequence !== indexed.sequence
    || stored.occurredAt !== indexed.occurredAt
    || String(event.meta.recordedAt) !== indexed.occurredAt
    || String(event.meta.eventId) !== indexed.domainEventId
    || event.type !== indexed.eventType
    || authoritativeEventSummary(event) !== indexed.summary
    || actor.id !== indexed.actor.id
    || actor.label !== indexed.actor.label
    || !eventReferenceMatchesAuthoritative(indexed, event)
  ) return `Authoritative Event ${stored.eventId} does not match its exact-head Event locator metadata.`;
  return undefined;
}

function authoritativeEventSummary(event: DomainEvent): string {
  switch (event.type) {
    case "ProjectCreated": return `Created Project ${event.project.title}`;
    case "ProjectMaterializationsRebuilt": return `Rebuilt Project ${event.projectId} materializations`;
    case "RootNodeRegistered": return `Registered root Node ${String(event.node.commitSha).slice(0, 8)}`;
    case "RunStarted": return `Started Run ${event.run.id} for ${event.run.goal.title}`;
    case "RunCheckpointed": return `Recorded checkpoint for Run ${event.checkpoint.runId}`;
    case "RunEvidenceAttached": return `Attached evidence to Run ${event.evidence.runId}`;
    case "RunCompleted": return `Completed Run ${event.result.runId}`;
    case "RunChildNodeRegistered": return `Registered Run child Node ${String(event.node.commitSha).slice(0, 8)}`;
    case "RunFailed": return `Failed Run ${event.runId}`;
    case "RunCanceled": return `Canceled Run ${event.runId}`;
    case "CoachReviewRecorded": return `Recorded Coach review ${event.review.id}`;
    case "CoachingProposalRecorded": return `Proposed Coaching transition ${event.proposal.id}`;
    case "CoachingProposalConfirmed": return `Confirmed Coaching transition ${event.decision.proposalId}`;
    case "CoachingChildNodeRegistered": return `Registered Coaching child Node ${String(event.node.commitSha).slice(0, 8)}`;
    case "CoachingProposalRejected": return `Rejected Coaching transition ${event.decision.proposalId}`;
    case "AlternativesCompared": return `Compared ${event.comparison.nodeShas.length} sibling Nodes`;
    case "AlternativeSelected": return `Selected Node ${String(event.decision.selectedNodeSha).slice(0, 8)}`;
    case "AlternativesRejected": return `Rejected ${event.decision.rejectedNodeShas.length} Node alternative(s)`;
  }
}

function eventReferenceMatchesAuthoritative(indexed: EventIndexEntryReadModel, event: DomainEvent): boolean {
  const reference = indexed.reference;
  switch (event.type) {
    case "ProjectCreated": return reference.kind === "project";
    case "ProjectMaterializationsRebuilt": return reference.kind === "project";
    case "RootNodeRegistered":
    case "RunChildNodeRegistered":
    case "CoachingChildNodeRegistered": return reference.kind === "node" && reference.nodeSha === String(event.node.commitSha);
    case "RunStarted": return reference.kind === "run" && reference.runId === String(event.run.id)
      && reference.sourceNodeSha === String(event.run.sourceNodeSha) && reference.target.kind === "pending";
    case "RunCheckpointed": return reference.kind === "run" && reference.runId === String(event.checkpoint.runId);
    case "RunEvidenceAttached": return reference.kind === "run" && reference.runId === String(event.evidence.runId);
    case "RunCompleted": return reference.kind === "run" && reference.runId === String(event.result.runId)
      && reference.target.kind === "registered" && reference.target.nodeSha === String(event.result.resultSha);
    case "RunFailed":
    case "RunCanceled": return reference.kind === "run" && reference.runId === String(event.runId);
    case "CoachReviewRecorded": {
      if (event.review.target.type === "node") return reference.kind === "node" && reference.nodeSha === String(event.review.target.nodeSha);
      if (event.review.target.type === "run") return reference.kind === "run" && reference.runId === String(event.review.target.runId);
      return reference.kind === "node" || reference.kind === "project";
    }
    case "CoachingProposalRecorded": return reference.kind === "node" && reference.nodeSha === String(event.proposal.sourceNodeSha);
    case "CoachingProposalConfirmed": return reference.kind === "node" && reference.nodeSha === String(event.decision.childNodeSha);
    case "CoachingProposalRejected": return reference.kind === "node" || reference.kind === "project";
    case "AlternativesCompared": return reference.kind === "node" && reference.nodeSha === String(event.comparison.parentNodeSha);
    case "AlternativeSelected": return reference.kind === "node" && reference.nodeSha === String(event.decision.selectedNodeSha);
    case "AlternativesRejected": return reference.kind === "node" && reference.nodeSha === String(event.decision.rejectedNodeShas[0]);
  }
}

function decodeNodePayloadFile(
  files: Readonly<Record<string, string>>,
  path: string,
  runnerTypes: RunnerValueTypeRegistry
): ApiResult<NodePayload> {
  const content = files[path];
  if (content === undefined) return integrityFailure(`Required Node payload ${path} is missing.`);
  let input: unknown;
  try {
    input = JSON.parse(content);
  } catch {
    return integrityFailure(`Node payload ${path} is not valid JSON.`);
  }
  const envelope = decodeNodeEnvelope(input);
  if (!envelope.ok) return integrityFailure(`${path}: ${envelope.error.message}`);
  const decoded = decodeNodePayload(envelope.value.value, runnerTypes, path);
  return decoded.ok ? apiOk(decoded.value) : integrityFailure(`${decoded.error.path}: ${decoded.error.message}`);
}

function sameCheckpoint(left: EventLogCheckpoint, right: EventLogCheckpoint): boolean {
  return left.schema === right.schema
    && left.eventCount === right.eventCount
    && left.lastSequence === right.lastSequence
    && left.lastStoredEventId === right.lastStoredEventId
    && left.lastDomainEventId === right.lastDomainEventId
    && left.chainDigest === right.chainDigest;
}

function graphManifestIntegrityError(loaded: ReadProject, graph: ProjectGraphManifestReadModel): string | undefined {
  const catalog = loaded.catalog;
  if (graph.projectId !== catalog.project.id || graph.rootNodeSha !== catalog.project.rootNodeSha || !sameCheckpoint(graph.checkpoint, catalog.checkpoint)) {
    return "Project Graph manifest does not match its exact-head Project checkpoint or identity.";
  }
  if (graph.nodeCount !== catalog.counts.nodes || graph.edgeCount !== graph.nodeCount - 1) {
    return "Project Graph manifest counts do not describe the catalog's single-root tree.";
  }
  return undefined;
}

function activityManifestIntegrityError(loaded: ReadProject, activity: ProjectActivityManifestReadModel): string | undefined {
  return activity.projectId !== loaded.catalog.project.id || !sameCheckpoint(activity.checkpoint, loaded.catalog.checkpoint)
    || activity.counts.nodes !== loaded.catalog.counts.nodes
    ? "Project snapshot manifest does not match its exact-head Project checkpoint or Node count."
    : undefined;
}

function graphNodeIntegrityError(
  loaded: ReadProject,
  manifest: ProjectGraphManifestReadModel,
  shard: ProjectGraphNodeReadModel,
  nodeSha: string
): string | undefined {
  if (shard.projectId !== loaded.catalog.project.id || shard.node.sha !== nodeSha || !sameCheckpoint(shard.checkpoint, manifest.checkpoint)
    || shard.node.ordinal >= manifest.nodeCount
    || shard.node.managedRef !== `refs/tags/hunsu/node/${loaded.catalog.project.id}/${nodeSha}`
  ) return `Graph Node shard ${nodeSha} does not match its exact-head Graph manifest.`;
  if ((shard.node.ordinal === 0) !== (shard.node.type === "root")
    || shard.node.type === "root" && shard.node.sha !== manifest.rootNodeSha
  ) return `Graph Node shard ${nodeSha} violates the single-root topology.`;
  return undefined;
}

function activityShardIntegrityError(
  loaded: ReadProject,
  manifest: ProjectActivityManifestReadModel,
  shard: NodeActivityShardReadModel,
  nodeSha: string
): string | undefined {
  return shard.projectId !== loaded.catalog.project.id || shard.nodeSha !== nodeSha || !sameCheckpoint(shard.checkpoint, manifest.checkpoint)
    ? `Node activity shard ${nodeSha} does not match its exact-head snapshot manifest.`
    : undefined;
}

function nodePayloadIntegrityError(loaded: ReadProject, card: ProjectGraphNode, payload: NodePayload): string | undefined {
  const digest = String(computeNodePayloadDigest(payload));
  if (String(payload.projectId) !== loaded.catalog.project.id
    || String(payload.commitSha) !== card.sha
    || String(payload.treeSha) !== card.treeSha
    || digest !== card.payloadDigest
    || String(computeNodePlanDigest(payload.plan)) !== card.planDigest
    || String(computeRunnerDigest(payload.plan.how)) !== card.runner.digest
  ) return `Node payload ${card.sha} does not match its exact-head Graph registration metadata.`;
  return undefined;
}

function commitTitle(message: string): string {
  return message.split(/\r?\n/u, 1)[0]!.trim();
}

function projectionContext(loaded: LoadedProject): ProjectionContext {
  return {
    defaultBranch: loaded.repository.defaultBranch,
    stateHeadSha: loaded.stateHeadSha,
    synchronizedAt: loaded.synchronizedAt,
    digestGoal: goal => String(computeGoalDigest(goal)),
    digestRunner: runner => String(computeRunnerDigest(runner))
  };
}

function commandMetadata(
  rawIdempotencyKey: string,
  semantic: unknown,
  index: number,
  at: string,
  actor: DomainActor,
  expectedStateSha: string
): CommandMetadata {
  return {
    eventId: asEventId(domainEventId(rawIdempotencyKey, semantic, index)),
    idempotencyKey: unwrap(makeIdempotencyKey(hashHex(`domain-idempotency:${rawIdempotencyKey}:${index}`))),
    fingerprint: unwrap(makeCommandFingerprint(hashHex(`domain-fingerprint:${canonicalJsonValue(semantic)}:${index}`))),
    expectedStateSha: asGitSha(expectedStateSha),
    actor,
    requestedAt: asTimestamp(at)
  };
}

function domainEventId(idempotencyKey: string, semantic: unknown, index: number): string {
  return `event-${hashHex(`${idempotencyKey}:${canonicalJsonValue(semantic)}:${index}`).slice(0, 24)}`;
}

function canonicalJsonValue(value: unknown): string {
  return canonicalJson(value as Parameters<typeof canonicalJson>[0]);
}

function requestActor(context: AuthContext): DomainActor {
  return context.client === "mcp"
    ? { type: "plugin", id: asText(`mcp:${context.user.id}`) }
    : userActor(context);
}

function userActor(context: AuthContext): DomainActor {
  return { type: "user", id: asText(context.user.id, "user.id") };
}

function coachActor(context: AuthContext): DomainActor {
  return { type: "coach", id: asText(`coach:${context.user.id}`) };
}

function stateActor(context: AuthContext): StateActor {
  return context.client === "mcp"
    ? { kind: "plugin", userId: context.user.id, clientId: "hunsu-mcp-v2" }
    : { kind: "user", id: context.user.id };
}

function mutationResponse(applied: ApiResult<MutationApplied>, schema: string, value: JsonRecord): ApiResult<unknown> {
  return applied.ok
    ? apiOk({ schema, ...value, stateHeadSha: applied.value.stateHeadSha, synchronizedAt: applied.value.synchronizedAt })
    : applied;
}

function eventReferencesNode(reference: ReturnType<typeof eventListProjection>[number]["reference"], sha: string): boolean {
  if (reference.kind === "node") return reference.nodeSha === sha;
  return reference.kind === "run"
    && (reference.sourceNodeSha === sha || (reference.target.kind === "registered" && reference.target.nodeSha === sha));
}

function projectIdOf(state: ProjectState): string {
  if (state.projects.length !== 1 || !state.projects[0]) throw new Error("A Project stream must contain exactly one Project.");
  return String(state.projects[0].id);
}

function repositoryKey(repository: Pick<RepositoryLocator, "installationId" | "repositoryId">): string {
  return `${repository.installationId}:${repository.repositoryId}`;
}

function nextCacheGeneration(value: number): number {
  return value === Number.MAX_SAFE_INTEGER ? 0 : value + 1;
}

function generatedId(prefix: string, idempotencyKey: string): string {
  return `${prefix}-${hashHex(idempotencyKey).slice(0, 20)}`;
}

function firstCommitMessageLine(message: string): string {
  const title = message.split(/\r?\n/u, 1)[0]?.trim();
  if (!title) throw new Error("GitHub returned a commit without a title.");
  return title;
}

function hashHex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function cachePolicy(overrides: Partial<ProjectionCachePolicy> | undefined): ProjectionCachePolicy {
  const value = { ...DEFAULT_CACHE_POLICY, ...overrides };
  for (const [key, item] of Object.entries(value)) {
    if (!Number.isSafeInteger(item) || item <= 0) throw new TypeError(`${key} must be a positive safe integer.`);
  }
  return value;
}

function fresh(cachedAt: number, now: number, ttl: number): boolean {
  const age = now - cachedAt;
  return age >= 0 && age < ttl;
}

function projectionFailure<T>(result: ProjectionResult<T>): ApiResult<never> {
  return result.ok
    ? integrityFailure("Projection failed without an error.")
    : apiFailure(projectionApiError(result.error));
}

function projectionApiError(error: { code: string; message: string }): ApiError {
  return error.code === "integrity_error"
    ? { code: "integrity_error", message: error.message, status: 409, retryable: false }
    : { code: "not_found", message: error.message, status: 404, retryable: false };
}

function storeFailure(error: StoreError): ApiResult<never> {
  if (error.code === "stale_state") return apiFailure({
    code: "stale_state",
    message: error.message,
    status: 412,
    retryable: true,
    ...(error.expectedHeadSha === undefined ? {} : { expectedStateSha: error.expectedHeadSha }),
    ...(error.actualHeadSha === undefined ? {} : { actualStateSha: error.actualHeadSha })
  });
  if (error.code === "idempotency_conflict") return conflict(error.message);
  if (error.code === "state_not_found" || error.code === "project_not_found") return notFound(error.message);
  if (error.code === "integrity") return integrityFailure(error.message);
  if (error.code === "unsafe_state") return invalidRequest(error.message);
  if (error.code === "invalid_event" && error.message.startsWith("DOMAIN:")) {
    const [, code, ...parts] = error.message.split(":");
    return domainFailure(code ?? "INVARIANT_VIOLATION", parts.join(":"));
  }
  if (error.code === "invalid_event") return invalidRequest(error.message);
  if (error.code === "transport" && error.cause) return transportFailure(error.cause);
  return apiFailure({ code: "temporarily_unavailable", message: error.message, status: 503, retryable: true });
}

function domainFailure(code: string, message: string): ApiResult<never> {
  if (code === "USER_CONFIRMATION_REQUIRED") return apiFailure({ code: "confirmation_required", message, status: 409, retryable: false });
  if (code === "NOT_FOUND") return notFound(message);
  if (code === "INVALID_TRANSITION" || code === "DUPLICATE_ID" || code === "IDEMPOTENCY_CONFLICT") return conflict(message);
  return invalidRequest(message);
}

function transportFailure(error: GitHubTransportError): ApiResult<never> {
  if (error.code === "forbidden") return apiFailure({
    code: "forbidden",
    message: error.message,
    status: 403,
    retryable: false,
    ...(error.requestId === undefined ? {} : { requestId: error.requestId })
  });
  if (error.code === "rate_limited") {
    const retryAfterSeconds = error.retryAfterSeconds && error.retryAfterSeconds > 0 ? error.retryAfterSeconds : 60;
    return apiFailure({
      code: "temporarily_unavailable",
      message: `GitHub is temporarily rate limiting this installation. Retry after at least ${retryAfterSeconds} seconds.`,
      status: 503,
      retryable: true,
      retryAfterSeconds,
      ...(error.requestId === undefined ? {} : { requestId: error.requestId })
    });
  }
  return apiFailure({
    code: "temporarily_unavailable",
    message: error.message,
    status: 503,
    retryable: true,
    ...(error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds }),
    ...(error.requestId === undefined ? {} : { requestId: error.requestId })
  });
}

function pluginError(error: ApiError): PluginSafeError {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    ...(error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds }),
    ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
    ...(error.expectedStateSha === undefined ? {} : { expectedStateSha: error.expectedStateSha }),
    ...(error.actualStateSha === undefined ? {} : { actualStateSha: error.actualStateSha }),
    ...(error.retryAfterSeconds === undefined ? {} : {
      recovery: `Wait at least ${error.retryAfterSeconds} seconds before retrying. Continuing during the GitHub rate-limit window can extend the outage.`
    })
  };
}

function staleBase(message: string): ApiResult<never> {
  return apiFailure({ code: "stale_base", message, status: 412, retryable: true });
}

function integrityFailure(message: string): ApiResult<never> {
  return apiFailure({ code: "integrity_error", message, status: 409, retryable: false });
}

function notFound(message: string): ApiResult<never> {
  return apiFailure({ code: "not_found", message, status: 404, retryable: false });
}

function forbidden(message: string): ApiResult<never> {
  return apiFailure({ code: "forbidden", message, status: 403, retryable: false });
}

function conflict(message: string): ApiResult<never> {
  return apiFailure({ code: "conflict", message, status: 409, retryable: false });
}

class BoundaryError extends Error {
  readonly apiError: ApiError;

  constructor(apiError: ApiError) {
    super(apiError.message);
    this.name = "BoundaryError";
    this.apiError = apiError;
  }
}

async function webMutationBoundary<T>(operation: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof BoundaryError) return apiFailure(error.apiError);
    throw error;
  }
}

function assertExactToolMutationInput(name: string, input: JsonRecord): void {
  const tool = findHunsuTool(name);
  if (!tool || tool.readOnly) return;
  const properties = tool.inputSchema.properties;
  if (!isRecord(properties)) throw new Error(`Tool ${name} has no object properties schema.`);
  assertExactRecord(input, "arguments", Object.keys(properties));
}

function boundaryInvalid(message: string): BoundaryError {
  return new BoundaryError({ code: "invalid_request", message, status: 400, retryable: false });
}

function requireConfirmation(input: JsonRecord): void {
  if (input.confirmedByUser !== true) throw new BoundaryError({
    code: "confirmation_required",
    message: "This mutation requires separate explicit user confirmation.",
    status: 409,
    retryable: true
  });
}

function assertRecord(value: unknown, field: string): JsonRecord {
  if (!isRecord(value)) throw boundaryInvalid(`${field} must be an object.`);
  return value;
}

function assertExactRecord(value: unknown, field: string, keys: readonly string[]): JsonRecord {
  const result = assertRecord(value, field);
  const allowed = new Set(keys);
  const unknown = Object.keys(result).filter(key => !allowed.has(key));
  if (unknown.length > 0) throw boundaryInvalid(`${field} contains unsupported fields: ${unknown.join(", ")}.`);
  return result;
}

function record(input: JsonRecord, field: string): JsonRecord {
  return assertRecord(input[field], field);
}

function recordAt(value: unknown, field: string, child: string): JsonRecord {
  return record(assertRecord(value, field), child);
}

function requiredString(input: JsonRecord, field: string): string {
  const value = input[field];
  if (typeof value !== "string" || value.trim() === "") throw boundaryInvalid(`${field} is required.`);
  return value;
}

function optionalString(input: JsonRecord, field: string): string | undefined {
  const value = input[field];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw boundaryInvalid(`${field} must be text.`);
  return value;
}

function optionalPositiveInteger(input: JsonRecord, field: string): number | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw boundaryInvalid(`${field} must be a positive integer.`);
  return Number(value);
}

function array(input: JsonRecord, field: string, nonEmpty: boolean): unknown[] {
  const value = input[field];
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) throw boundaryInvalid(`${field} must be ${nonEmpty ? "a non-empty" : "an"} array.`);
  return value;
}

function optionalStringArray(input: JsonRecord, field: string): string[] {
  if (input[field] === undefined) return [];
  return array(input, field, false).map((value, index) => {
    if (typeof value !== "string" || value.trim() === "") throw boundaryInvalid(`${field}[${index}] must be non-empty text.`);
    return value;
  });
}

function requiredSha(input: JsonRecord, field: string): string {
  return requiredFullSha(requiredString(input, field), field);
}

function requiredFullSha(value: string, field: string): string {
  if (!FULL_SHA.test(value)) throw boundaryInvalid(`${field} must be a full lowercase Git SHA.`);
  return value;
}

function requiredStateSha(input: JsonRecord): string {
  return requiredSha(input, "expectedStateSha");
}

function requiredIdempotencyKey(input: JsonRecord): string {
  const value = requiredString(input, "idempotencyKey");
  if (value.length > 256) throw boundaryInvalid("idempotencyKey must contain at most 256 characters.");
  return value;
}

function requiredShaArray(input: JsonRecord, field: string, minimum: number): string[] {
  const values = array(input, field, true).map((value, index) => {
    if (typeof value !== "string") throw boundaryInvalid(`${field}[${index}] must be a Git SHA.`);
    return requiredFullSha(value, `${field}[${index}]`);
  });
  if (values.length < minimum || new Set(values).size !== values.length) throw boundaryInvalid(`${field} must contain at least ${minimum} unique SHAs.`);
  return values;
}

function safeHttpUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw boundaryInvalid("Evidence URL is invalid.");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
    throw boundaryInvalid("Evidence URL must be a credential-free HTTP(S) URL.");
  }
  return value;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw boundaryInvalid(result.error.message);
  return result.value;
}

function asProjectId(value: string) { return unwrap(makeProjectId(value)); }
function asWorkspaceId(value: string) { return unwrap(makeWorkspaceId(value)); }
function asRunId(value: string) { return unwrap(makeRunId(value)); }
function asEvidenceId(value: string) { return unwrap(makeEvidenceId(value)); }
function asCheckpointId(value: string) { return unwrap(makeCheckpointId(value)); }
function asCoachReviewId(value: string) { return unwrap(makeCoachReviewId(value)); }
function asProposalId(value: string) { return unwrap(makeCoachingProposalId(value)); }
function asComparisonId(value: string) { return unwrap(makeComparisonId(value)); }
function asDecisionId(value: string) { return unwrap(makeDecisionId(value)); }
function asEventId(value: string) { return unwrap(makeEventId(value)); }
function asGitSha(value: string) { return unwrap(makeGitCommitSha(value)); }
function asTreeSha(value: string) { return unwrap(makeGitTreeSha(value)); }
function asGitTreePath(value: string, field?: string) { return unwrap(makeGitTreePath(value, field)); }
function asGitRef(value: string) { return unwrap(makeGitRef(value)); }
function asGitBranch(value: string) { return unwrap(makeGitBranchName(value)); }
function asRepositoryOwner(value: string) { return unwrap(makeRepositoryOwner(value)); }
function asRepositoryName(value: string) { return unwrap(makeRepositoryName(value)); }
function asTimestamp(value: string) { return unwrap(makeIsoTimestamp(value)); }
function asText(value: string, field?: string) { return unwrap(makeNonEmptyText(value, field)); }
function asProjectTitle(value: string) { return unwrap(makeProjectTitle(value)); }
function asGoalDigest(value: string) { return unwrap(makeGoalDigest(value)); }
function asNodePlanDigest(value: string) { return unwrap(makeNodePlanDigest(value)); }
function asNodePayloadDigest(value: string) { return unwrap(makeNodePayloadDigest(value)); }
function asEvidenceSummary(value: string) { return unwrap(makeEvidenceSummary(value)); }
function asAcceptanceCriterion(value: string, field?: string) { return unwrap(makeAcceptanceCriterion(value, field)); }
function asReason(value: string) { return unwrap(makeReason(value)); }
function asNonEmpty<T>(value: readonly T[], field: string) { return unwrap(makeNonEmptyArray([...value], field)); }
function asAtLeastTwo<T>(value: readonly T[], field: string) { return unwrap(makeAtLeastTwo([...value], field)); }
