import { createHash } from "node:crypto";
import { applyProjectCommand, emptyProjectState } from "@hunsu/core";
import {
  GitHubProjectStore,
  HUNSU_STATE_BRANCH,
  type GitHubTransport,
  type GitHubTransportError,
  type RepositoryGrant,
  type RepositoryLocator,
  type StateActor,
  type StoreError,
  type StoreResult
} from "@hunsu/github-store";
import type {
  EvidenceInput,
  McpToolDispatcher,
  PluginSafeError,
  RunContract,
  ToolResponse
} from "@hunsu/plugin-contract";
import {
  alternativeComparisonProjection,
  coachViewProjection,
  goalDetailProjection,
  projectListProjection,
  projectOverviewProjection,
  runDetailProjection,
  runnerDirectoryProjection,
  type ProjectionContext,
  type ProjectionResult
} from "@hunsu/projections";
import {
  canonicalJson,
  makeAcceptanceCriterion,
  makeCheckpointId,
  makeCoachId,
  makeCoachProposalId,
  makeCoachReviewId,
  makeCommandFingerprint,
  makeComparisonId,
  makeDecisionId,
  makeDesiredOutcome,
  makeDivergenceId,
  makeEventId,
  makeEvidenceId,
  makeEvidenceSummary,
  makeGitBranchName,
  makeGitCommitSha,
  makeGitRef,
  makeGoalConstraint,
  makeGoalId,
  makeGoalTitle,
  makeIdempotencyKey,
  makeIsoTimestamp,
  makeNonEmptyArray,
  makeNonEmptyText,
  makeNonNegativeInteger,
  makePositiveInteger,
  makeProjectId,
  makeProjectObjective,
  makeProjectTitle,
  makePromptTemplate,
  makeReason,
  makeRepositoryName,
  makeRepositoryOwner,
  makeResourceName,
  makeRunId,
  makeRunnerId,
  makeWorkspaceId,
  runBranchName,
  type ActiveGoal,
  type Coach,
  type CoachProposal,
  type CommandMetadata,
  type DomainActor,
  type DomainEvent,
  type EvidenceRef,
  type Goal,
  type GoalPatch,
  type HunsuProposal,
  type Player,
  type Project,
  type ProjectCommand,
  type ProjectPatch,
  type ProjectState,
  type ResourceBinding,
  type Run,
  type Runner,
  type RuntimePolicy,
  type Team
} from "@hunsu/protocol";
import { projectStateCodec } from "./project-codec.ts";
import {
  apiFailure,
  apiOk,
  invalidRequest,
  type ApiError,
  type ApiResult,
  type AuthContext,
  type MutationResult
} from "./types.ts";

type JsonRecord = Record<string, unknown>;

type CachedProject = {
  repository: RepositoryLocator;
  state: ProjectState;
  stateHeadSha: string;
  synchronizedAt: string;
  cachedAt: number;
  lastAccessedAt: number;
  lastAccessOrder: number;
  sizeBytes: number;
};

type AuthorizedProject = {
  repository: RepositoryGrant;
  state: ProjectState;
  stateHeadSha: string;
  synchronizedAt: string;
  cachedAt: number;
};

type CachedRepositoryCatalog = {
  repository: RepositoryLocator;
  stateHeadSha: string | undefined;
  projectIds: readonly string[];
  synchronizedAt: string;
  cachedAt: number;
  lastAccessedAt: number;
  lastAccessOrder: number;
  sizeBytes: number;
};

type CachedInstallationRepositories = {
  installationId: number;
  repositories: readonly RepositoryGrant[];
  cachedAt: number;
  lastAccessedAt: number;
  lastAccessOrder: number;
  sizeBytes: number;
};

type CacheGeneration = {
  generation: number;
  lastAccessedAt: number;
  lastAccessOrder: number;
};

type CacheGenerationToken = {
  repositoryKey: string;
  generation: number;
};

type InstallationCacheGenerationToken = {
  installationKey: string;
  generation: number;
};

type InstallationRepositoryFlight = {
  generation: number;
  promise: Promise<ApiResult<readonly RepositoryGrant[]>>;
};

export type ProjectionCachePolicy = {
  idleTtlMs: number;
  maxProjectEntries: number;
  maxProjectBytes: number;
  maxCatalogEntries: number;
  maxCatalogBytes: number;
  installationTtlMs: number;
  maxInstallationEntries: number;
  maxInstallationBytes: number;
  maxGenerationEntries: number;
};

const PROJECTION_CACHE_TTL_MS = 4_000;
const UTF8_ENCODER = new TextEncoder();
const DEFAULT_PROJECTION_CACHE_POLICY: ProjectionCachePolicy = {
  idleTtlMs: 5 * 60_000,
  maxProjectEntries: 128,
  maxProjectBytes: 16 * 1024 * 1024,
  maxCatalogEntries: 256,
  maxCatalogBytes: 2 * 1024 * 1024,
  installationTtlMs: 60_000,
  maxInstallationEntries: 128,
  maxInstallationBytes: 4 * 1024 * 1024,
  maxGenerationEntries: 512
};

type MutationCommandFactory = (state: ProjectState, meta: CommandMetadata) => ProjectCommand;

export class HunsuApplicationService implements McpToolDispatcher<AuthContext> {
  readonly #transport: GitHubTransport;
  readonly #store: GitHubProjectStore<DomainEvent, ProjectState>;
  readonly #now: () => Date;
  readonly #cacheNow: () => number;
  readonly #cachePolicy: ProjectionCachePolicy;
  readonly #cache = new Map<string, CachedProject>();
  readonly #catalogCache = new Map<string, CachedRepositoryCatalog>();
  readonly #installationCache = new Map<string, CachedInstallationRepositories>();
  readonly #cacheGenerations = new Map<string, CacheGeneration>();
  readonly #installationCacheGenerations = new Map<string, CacheGeneration>();
  readonly #installationRepositoryFlights = new Map<string, InstallationRepositoryFlight>();
  #nextCacheGeneration = 1;
  #nextCacheAccessOrder = 1;

  constructor(input: {
    transport: GitHubTransport;
    now?: () => Date;
    cacheNow?: () => number;
    projectionCachePolicy?: Partial<ProjectionCachePolicy>;
  }) {
    this.#transport = input.transport;
    this.#store = new GitHubProjectStore(input.transport, projectStateCodec);
    this.#now = input.now ?? (() => new Date());
    this.#cacheNow = input.cacheNow ?? (() => Date.now());
    this.#cachePolicy = projectionCachePolicy(input.projectionCachePolicy);
  }

  async call(name: string, argumentsValue: JsonRecord, context: AuthContext): Promise<ToolResponse<unknown>> {
    const result = await this.invoke(name, argumentsValue, context);
    return result.ok
      ? { ok: true, data: result.value.data, ...(result.value.stateHeadSha ? { stateHeadSha: result.value.stateHeadSha } : {}) }
      : { ok: false, error: pluginError(result.error) };
  }

  async invoke(name: string, input: JsonRecord, context: AuthContext): Promise<ApiResult<{ data: unknown; stateHeadSha?: string }>> {
    try {
      switch (name) {
        case "hunsu.projects.list": return await this.#listProjectsTool(input, context);
        case "hunsu.projects.get": return await this.#getProjectTool(input, context);
        case "hunsu.projects.create": return await this.#createProjectTool(input, context);
        case "hunsu.projects.update": return await this.#updateProjectTool(input, context);
        case "hunsu.projects.rebuild": return await this.#rebuildProjectTool(input, context);
        case "hunsu.goals.list": return await this.#listGoalsTool(input, context);
        case "hunsu.goals.get": return await this.#getGoalTool(input, context);
        case "hunsu.goals.create": return await this.#createGoalTool(input, context);
        case "hunsu.goals.update": return await this.#updateGoalTool(input, context);
        case "hunsu.goals.pause": return await this.#pauseGoalTool(input, context);
        case "hunsu.goals.complete": return await this.#completeGoalTool(input, context);
        case "hunsu.runners.list": return await this.#listRunnersTool(input, context);
        case "hunsu.runners.get": return await this.#getRunnerTool(input, context);
        case "hunsu.runners.create_player": return await this.#createPlayerTool(input, context);
        case "hunsu.runners.create_team": return await this.#createTeamTool(input, context);
        case "hunsu.runners.update": return await this.#updateRunnerTool(input, context);
        case "hunsu.runs.get": return await this.#getRunTool(input, context);
        case "hunsu.runs.start": return await this.#startRunTool(input, context);
        case "hunsu.runs.checkpoint": return await this.#checkpointRunTool(input, context);
        case "hunsu.runs.attach_evidence": return await this.#attachEvidenceTool(input, context);
        case "hunsu.runs.complete": return await this.#completeRunTool(input, context);
        case "hunsu.runs.fail": return await this.#failRunTool(input, context);
        case "hunsu.runs.cancel": return await this.#cancelRunTool(input, context);
        case "hunsu.coach.get": return await this.#getCoachTool(input, context);
        case "hunsu.coach.review": return await this.#coachReviewTool(input, context);
        case "hunsu.coach.propose_change": return await this.#coachProposeChangeTool(input, context);
        case "hunsu.coach.propose_hunsu": return await this.#coachProposeHunsuTool(input, context);
        case "hunsu.alternatives.compare": return await this.#compareAlternativesTool(input, context);
        case "hunsu.alternatives.select": return await this.#selectAlternativeTool(input, context);
        case "hunsu.alternatives.reject": return await this.#rejectAlternativeTool(input, context);
        default: return invalidRequest(`Unknown Hunsu tool ${name}.`);
      }
    } catch (error) {
      if (error instanceof BoundaryError) return apiFailure(error.apiError);
      return apiFailure({ code: "temporarily_unavailable", message: "The Hunsu service could not complete the request.", status: 503, retryable: true });
    }
  }

  async sessionRepositories(context: AuthContext): Promise<ApiResult<{ repositories: unknown[] }>> {
    const grants = await this.#authorizedRepositories(context);
    if (!grants.ok) return grants;
    const synchronizedAt = this.#timestamp();
    const repositories: unknown[] = [];
    for (const repository of grants.value) {
      const state = await this.#transport.readBranchHead(repository, HUNSU_STATE_BRANCH);
      if (!state.ok) return transportFailure(state.error);
      const stateHeadSha = state.value ?? "";
      repositories.push({
        owner: repository.owner,
        name: repository.name,
        url: `https://github.com/${repository.owner}/${repository.name}`,
        defaultBranch: repository.defaultBranch,
        installationId: repository.installationId,
        private: repository.private,
        granted: true,
        stateHeadSha,
        updatedAt: synchronizedAt
      });
    }
    return apiOk({ repositories });
  }

  async webProjects(context: AuthContext): Promise<ApiResult<{ projects: unknown[] }>> {
    const loaded = await this.#loadAllProjects(context);
    if (!loaded.ok) return loaded;
    return apiOk({ projects: projectListProjection(loaded.value.map(entry => ({ state: entry.state, context: projectionContext(entry) }))) });
  }

  async webProject(context: AuthContext, projectId: string): Promise<ApiResult<{ project: unknown; stateHeadSha: string }>> {
    const loaded = await this.#findProject(context, projectId);
    if (!loaded.ok) return loaded;
    const projection = projectOverviewProjection(loaded.value.state, projectId, projectionContext(loaded.value));
    return projection.ok ? apiOk({ project: projection.value, stateHeadSha: loaded.value.stateHeadSha }) : projectionFailure(projection);
  }

  async webGoal(context: AuthContext, projectId: string, goalId: string): Promise<ApiResult<{ goal: unknown; stateHeadSha: string }>> {
    const loaded = await this.#findProject(context, projectId);
    if (!loaded.ok) return loaded;
    const projection = goalDetailProjection(loaded.value.state, projectId, goalId);
    return projection.ok ? apiOk({ goal: projection.value, stateHeadSha: loaded.value.stateHeadSha }) : projectionFailure(projection);
  }

  async webRunners(context: AuthContext, projectId: string): Promise<ApiResult<{ runners: unknown[] }>> {
    const loaded = await this.#findProject(context, projectId);
    if (!loaded.ok) return loaded;
    const projection = runnerDirectoryProjection(loaded.value.state, projectId);
    return projection.ok ? apiOk({ runners: projection.value }) : projectionFailure(projection);
  }

  async webRun(context: AuthContext, projectId: string, runId: string): Promise<ApiResult<{ run: unknown }>> {
    const loaded = await this.#findProject(context, projectId);
    if (!loaded.ok) return loaded;
    const projection = runDetailProjection(loaded.value.state, projectId, runId);
    return projection.ok ? apiOk({ run: projection.value }) : projectionFailure(projection);
  }

  async webCoach(context: AuthContext, projectId: string): Promise<ApiResult<{ coach: unknown; stateHeadSha: string }>> {
    const loaded = await this.#findProject(context, projectId);
    if (!loaded.ok) return loaded;
    const projection = coachViewProjection(loaded.value.state, projectId);
    return projection.ok ? apiOk({ coach: projection.value, stateHeadSha: loaded.value.stateHeadSha }) : projectionFailure(projection);
  }

  dropProjectionCache(): void {
    this.#cache.clear();
    this.#catalogCache.clear();
    this.#cacheGenerations.clear();
  }

  invalidateRepository(repository: Pick<RepositoryLocator, "installationId" | "repositoryId">): void {
    this.#advanceCacheGeneration(repository);
    for (const [key, entry] of this.#cache) {
      if (entry.repository.installationId === repository.installationId && entry.repository.repositoryId === repository.repositoryId) this.#cache.delete(key);
    }
    this.#catalogCache.delete(repositoryCacheKey(repository));
  }

  invalidateInstallation(installationId: number): void {
    this.#installationCache.delete(installationCacheKey(installationId));
    this.#advanceInstallationCacheGeneration(installationId);
    for (const [key, entry] of this.#cache) if (entry.repository.installationId === installationId) this.#cache.delete(key);
    for (const [key, entry] of this.#catalogCache) if (entry.repository.installationId === installationId) this.#catalogCache.delete(key);
    const prefix = `${installationId}:`;
    for (const key of this.#cacheGenerations.keys()) if (key.startsWith(prefix)) this.#cacheGenerations.delete(key);
  }

  async reconcileRepository(repository: RepositoryLocator): Promise<ApiResult<{ projectCount: number }>> {
    this.invalidateRepository(repository);
    const generation = this.#captureCacheGeneration(repository);
    const reconstructed = await this.#store.reconstructRepository(repository);
    if (!reconstructed.ok) return storeFailure(reconstructed.error);
    const projects = reconstructed.value.projects;
    const synchronizedAt = this.#timestamp();
    const cachedAt = this.#cacheNow();
    if (this.#cacheGenerationIsCurrent(generation)) {
      this.invalidateRepository(repository);
      for (const item of projects) {
        this.#putCachedProject(
          cacheKey(repository, projectIdOf(item.state)),
          cachedProject(repository, item.state, item.stateHeadSha, synchronizedAt, cachedAt)
        );
      }
      this.#putCachedCatalog(
        repositoryCacheKey(repository),
        cachedRepositoryCatalog(
          repository,
          reconstructed.value.kind === "state_branch" ? reconstructed.value.stateHeadSha : undefined,
          projects.map(item => projectIdOf(item.state)),
          synchronizedAt,
          cachedAt
        )
      );
    }
    return apiOk({ projectCount: projects.length });
  }

  async webCreateProject(context: AuthContext, input: JsonRecord): Promise<ApiResult<MutationResult<{ projectId: string }>>> {
    const idempotencyKey = requestIdempotency(input);
    const projectId = generatedId("project", idempotencyKey);
    const coachId = generatedId("coach", idempotencyKey);
    const repository = await this.#repositoryByName(context, requiredString(record(input, "repository"), "owner"), requiredString(record(input, "repository"), "name"), true);
    if (!repository.ok) return repository;
    const tool = await this.#createProject(repository.value, context, {
      projectId,
      coachId,
      title: requiredString(input, "title"),
      objective: requiredString(input, "objective"),
      baseRef: requiredString(input, "baseRef"),
      idempotencyKey,
      expectedStateSha: optionalString(input, "expectedStateSha")
    });
    return tool.ok ? apiOk(tool.value) : tool;
  }

  async webCreateGoal(context: AuthContext, projectId: string, input: JsonRecord): Promise<ApiResult<MutationResult<{ goalId: string }>>> {
    const idempotencyKey = requestIdempotency(input);
    const loaded = await this.#findProject(context, projectId, true);
    if (!loaded.ok) return loaded;
    return this.#createGoal(loaded.value.repository, context, {
      projectId,
      goalId: generatedId("goal", idempotencyKey),
      title: requiredString(input, "title"),
      desiredOutcome: requiredString(input, "desiredOutcome"),
      acceptanceCriteria: requiredStringArray(input, "acceptanceCriteria", true),
      constraints: requiredStringArray(input, "constraints", false),
      priority: priorityNumber(input.priority),
      runnerId: optionalString(input, "runnerId"),
      idempotencyKey,
      expectedStateSha: optionalString(input, "expectedStateSha")
    });
  }

  async webUpdateGoal(context: AuthContext, projectId: string, goalId: string, input: JsonRecord): Promise<ApiResult<MutationResult<{ goalId: string }>>> {
    const loaded = await this.#findProject(context, projectId, true);
    if (!loaded.ok) return loaded;
    const status = optionalString(input, "status");
    if (status === "paused") {
      return this.#pauseGoal(loaded.value.repository, context, projectId, goalId, requestIdempotency(input), optionalString(input, "expectedStateSha"), optionalString(input, "reason") ?? "Paused by the user");
    }
    if (status === "active") {
      return this.#resumeGoal(loaded.value.repository, context, projectId, goalId, requestIdempotency(input), optionalString(input, "expectedStateSha"));
    }
    if (status === "completed") {
      return this.#completeGoal(
        loaded.value.repository,
        context,
        projectId,
        goalId,
        requiredString(input, "selectedRunId"),
        requestIdempotency(input),
        optionalString(input, "expectedStateSha")
      );
    }
    return this.#updateGoal(loaded.value.repository, context, {
      ...input,
      projectId,
      goalId,
      idempotencyKey: requestIdempotency(input)
    });
  }

  async webConfirmHunsu(context: AuthContext, projectId: string, goalId: string, input: JsonRecord): Promise<ApiResult<MutationResult<{ alternativeId: string }>>> {
    const loaded = await this.#findProject(context, projectId, true);
    if (!loaded.ok) return loaded;
    const sourceRunId = requiredString(input, "sourceRunId");
    const idempotencyKey = requestIdempotency(input);
    const divergenceId = generatedId("divergence", idempotencyKey);
    const result = await this.#mutate({
      repository: loaded.value.repository,
      projectId,
      context,
      idempotencyKey,
      expectedStateSha: optionalString(input, "expectedStateSha"),
      semanticCommand: { type: "ConfirmHunsu", projectId, goalId, sourceRunId, divergenceId },
      factories: [(_state, meta) => ({
        type: "ConfirmHunsu",
        meta: withActor(meta, userActor(context)),
        divergenceId: asDivergenceId(divergenceId),
        projectId: asProjectId(projectId),
        goalId: asGoalId(goalId),
        sourceRunId: asRunId(sourceRunId),
        basis: { type: "user", reason: asReason(optionalString(input, "summary") ?? "User requested a deliberate alternative") }
      })]
    });
    return result.ok ? apiOk({ ...result.value, value: { alternativeId: divergenceId } }) : result;
  }

  async webDecideAlternative(
    context: AuthContext,
    projectId: string,
    goalId: string,
    runId: string,
    kind: "select" | "reject",
    input: JsonRecord
  ): Promise<ApiResult<MutationResult<{ decisionId: string }>>> {
    const loaded = await this.#findProject(context, projectId, true);
    if (!loaded.ok) return loaded;
    const idempotencyKey = requestIdempotency(input);
    const expectedStateSha = optionalString(input, "expectedStateSha");
    const decisionId = generatedId("decision", idempotencyKey);
    const comparisonId = optionalString(input, "comparisonId");
    if (!comparisonId) return invalidRequest("comparisonId is required before selecting or rejecting an alternative.");
    const comparison = loaded.value.state.comparisons.find(item => item.id === comparisonId);
    if (!comparison) return notFound(`Alternative comparison ${comparisonId} was not found.`);
    if (comparison.projectId !== projectId || comparison.goalId !== goalId || !comparison.runIds.includes(asRunId(runId))) {
      return invalidRequest("The selected Run does not belong to the supplied alternative comparison.");
    }
    const rationale = optionalString(input, "rationale")
      ?? (kind === "select" ? "User selected this alternative in Hunsu Web" : "User rejected this alternative in Hunsu Web");
    const result = await this.#mutate({
      repository: loaded.value.repository,
      projectId,
      context,
      idempotencyKey,
      expectedStateSha,
      semanticCommand: { type: kind === "select" ? "SelectAlternative" : "RejectAlternative", projectId, goalId, runId, comparisonId, rationale },
      factories: [(_state, meta) => kind === "select"
        ? {
            type: "SelectAlternative",
            meta: withActor(meta, userActor(context)),
            decisionId: asDecisionId(decisionId),
            comparisonId: comparison.id,
            selectedRunId: asRunId(runId),
            rationale: asReason(rationale)
          }
        : {
            type: "RejectAlternatives",
            meta: withActor(meta, userActor(context)),
            decisionId: asDecisionId(decisionId),
            comparisonId: comparison.id,
            rejectedRunIds: [asRunId(runId)] as readonly [ReturnType<typeof asRunId>],
            rationale: asReason(rationale)
          }]
    });
    return result.ok ? apiOk({ ...result.value, value: { decisionId } }) : result;
  }

  async webCoachReview(context: AuthContext, projectId: string, input: JsonRecord): Promise<ApiResult<MutationResult<{ reviewId: string }>>> {
    const loaded = await this.#findProject(context, projectId, true);
    if (!loaded.ok) return loaded;
    const idempotencyKey = requestIdempotency(input);
    const reviewId = generatedId("review", idempotencyKey);
    return this.#recordCoachReview(loaded.value.repository, context, {
      projectId,
      reviewId,
      assessment: "Reviewed current Goals, Runs, evidence, and unresolved alternatives.",
      findings: automaticCoachFindings(loaded.value.state),
      idempotencyKey,
      expectedStateSha: optionalString(input, "expectedStateSha")
    });
  }

  async webConfirmCoachProposal(context: AuthContext, projectId: string, proposalId: string, input: JsonRecord): Promise<ApiResult<MutationResult<{ proposalId: string }>>> {
    const loaded = await this.#findProject(context, projectId, true);
    if (!loaded.ok) return loaded;
    const proposal = loaded.value.state.coachProposals.find(item => item.id === proposalId);
    if (!proposal) return notFound(`Coach proposal ${proposalId} was not found.`);
    const idempotencyKey = requestIdempotency(input);
    const expectedStateSha = optionalString(input, "expectedStateSha");
    const divergenceId = generatedId("divergence", idempotencyKey);
    const factories: MutationCommandFactory[] = [(_state, meta) => ({
      type: "AcceptCoachProposal",
      meta: withActor(meta, userActor(context)),
      proposalId: proposal.id,
      reason: asReason("User accepted the Coach proposal in Hunsu Web"),
      application: proposal.type === "hunsu"
        ? { type: "hunsu", divergenceId: asDivergenceId(divergenceId) }
        : { type: "apply_change" }
    })];
    const result = await this.#mutate({
      repository: loaded.value.repository,
      projectId,
      context,
      idempotencyKey,
      expectedStateSha,
      semanticCommand: { type: "ConfirmCoachProposal", projectId, proposalId },
      factories
    });
    return result.ok ? apiOk({ ...result.value, value: { proposalId } }) : result;
  }

  async webRejectCoachProposal(context: AuthContext, projectId: string, proposalId: string, input: JsonRecord): Promise<ApiResult<MutationResult<{ proposalId: string }>>> {
    const loaded = await this.#findProject(context, projectId, true);
    if (!loaded.ok) return loaded;
    if (!loaded.value.state.coachProposals.some(item => item.id === proposalId)) return notFound(`Coach proposal ${proposalId} was not found.`);
    const result = await this.#mutate({
      repository: loaded.value.repository,
      projectId,
      context,
      idempotencyKey: requestIdempotency(input),
      expectedStateSha: optionalString(input, "expectedStateSha"),
      semanticCommand: { type: "RejectCoachProposal", proposalId },
      factories: [(_state, meta) => ({
        type: "RejectCoachProposal",
        meta: withActor(meta, userActor(context)),
        proposalId: asCoachProposalId(proposalId),
        reason: asReason(optionalString(input, "reason") ?? "User rejected the Coach proposal in Hunsu Web")
      })]
    });
    return result.ok ? apiOk({ ...result.value, value: { proposalId } }) : result;
  }

  async webRebuildProject(context: AuthContext, projectId: string): Promise<ApiResult<MutationResult<{ projectId: string }>>> {
    const located = await this.#findProject(context, projectId);
    if (!located.ok) return located;
    this.invalidateRepository(located.value.repository);
    const rebuilt = await this.#loadProject(located.value.repository, projectId, true);
    return rebuilt.ok
      ? apiOk({ value: { projectId }, stateHeadSha: rebuilt.value.stateHeadSha, synchronizedAt: rebuilt.value.synchronizedAt })
      : rebuilt;
  }

  async #listProjectsTool(input: JsonRecord, context: AuthContext): Promise<ApiResult<{ data: unknown }>> {
    const installationId = optionalPositiveInteger(input, "installationId");
    const loaded = await this.#loadAllProjects(context, false, installationId);
    if (!loaded.ok) return loaded;
    const filter = optionalString(input, "repository");
    const entries = filter ? loaded.value.filter(item => `${item.repository.owner}/${item.repository.name}` === filter) : loaded.value;
    return apiOk({ data: { projects: projectListProjection(entries.map(entry => ({ state: entry.state, context: projectionContext(entry) }))) } });
  }

  async #getProjectTool(input: JsonRecord, context: AuthContext): Promise<ApiResult<{ data: unknown; stateHeadSha: string }>> {
    const repository = await this.#repositoryFromInput(context, record(input, "repository"), false);
    if (!repository.ok) return repository;
    const projectId = requiredString(input, "projectId");
    const loaded = await this.#loadProject(repository.value, projectId);
    if (!loaded.ok) return loaded;
    const projected = projectOverviewProjection(loaded.value.state, projectId, projectionContext(loaded.value));
    return projected.ok ? apiOk({ data: projected.value, stateHeadSha: loaded.value.stateHeadSha }) : projectionFailure(projected);
  }

  async #createProjectTool(input: JsonRecord, context: AuthContext): Promise<ApiResult<{ data: unknown; stateHeadSha: string }>> {
    const repository = await this.#repositoryFromInput(context, record(input, "repository"), true);
    if (!repository.ok) return repository;
    const result = await this.#createProject(repository.value, context, {
      projectId: requiredString(input, "projectId"),
      coachId: requiredString(input, "coachId"),
      title: requiredString(input, "title"),
      objective: requiredString(input, "objective"),
      baseRef: requiredString(input, "baseRef"),
      idempotencyKey: requiredString(input, "idempotencyKey"),
      expectedStateSha: optionalString(input, "expectedStateSha")
    });
    return toolMutation(result);
  }

  async #updateProjectTool(input: JsonRecord, context: AuthContext): Promise<ApiResult<{ data: unknown; stateHeadSha: string }>> {
    const repository = await this.#repositoryFromInput(context, record(input, "repository"), true);
    if (!repository.ok) return repository;
    const projectId = requiredString(input, "projectId");
    const requestedBaseRef = optionalString(input, "baseRef");
    const normalizedBaseRef = requestedBaseRef ? normalizeRef(requestedBaseRef) : undefined;
    if (normalizedBaseRef) {
      const branch = normalizedBaseRef.replace(/^refs\/heads\//u, "");
      const exists = await this.#transport.readBranch(repository.value, branch);
      if (!exists.ok) return transportFailure(exists.error);
      if (!exists.value) return apiFailure({ code: "stale_base", message: `Selected base ref ${normalizedBaseRef} does not exist.`, status: 412, retryable: false });
    }
    const patch: ProjectPatch = {
      ...(optionalString(input, "title") ? { title: asProjectTitle(optionalString(input, "title")!) } : {}),
      ...(optionalString(input, "objective") ? { objective: asProjectObjective(optionalString(input, "objective")!) } : {}),
      ...(normalizedBaseRef ? { baseRef: asGitRef(normalizedBaseRef) } : {})
    };
    const result = await this.#mutate({
      repository: repository.value,
      projectId,
      context,
      idempotencyKey: requiredString(input, "idempotencyKey"),
      expectedStateSha: optionalString(input, "expectedStateSha"),
      semanticCommand: { type: "UpdateProject", projectId, patch },
      factories: [(_state, meta) => ({ type: "UpdateProject", meta, projectId: asProjectId(projectId), patch })]
    });
    return toolMutation(result, { projectId });
  }

  async #rebuildProjectTool(input: JsonRecord, context: AuthContext): Promise<ApiResult<{ data: unknown; stateHeadSha?: string }>> {
    const repository = await this.#repositoryFromInput(context, record(input, "repository"), false);
    if (!repository.ok) return repository;
    this.invalidateRepository(repository.value);
    const generation = this.#captureCacheGeneration(repository.value);
    const rebuilt = await this.#store.reconstructRepository(repository.value);
    if (!rebuilt.ok) return storeFailure(rebuilt.error);
    const projects = rebuilt.value.projects;
    const synchronizedAt = this.#timestamp();
    const cachedAt = this.#cacheNow();
    if (this.#cacheGenerationIsCurrent(generation)) {
      this.invalidateRepository(repository.value);
      for (const item of projects) {
        this.#putCachedProject(
          cacheKey(repository.value, projectIdOf(item.state)),
          cachedProject(repository.value, item.state, item.stateHeadSha, synchronizedAt, cachedAt)
        );
      }
      this.#putCachedCatalog(
        repositoryCacheKey(repository.value),
        cachedRepositoryCatalog(
          repository.value,
          rebuilt.value.kind === "state_branch" ? rebuilt.value.stateHeadSha : undefined,
          projects.map(item => projectIdOf(item.state)),
          synchronizedAt,
          cachedAt
        )
      );
    }
    const projectId = optionalString(input, "projectId");
    const match = projectId ? projects.find(item => projectIdOf(item.state) === projectId) : undefined;
    return apiOk({ data: { projectCount: projects.length, ...(projectId ? { projectId } : {}) }, ...(match ? { stateHeadSha: match.stateHeadSha } : {}) });
  }

  async #listGoalsTool(input: JsonRecord, context: AuthContext): Promise<ApiResult<{ data: unknown; stateHeadSha: string }>> {
    const loaded = await this.#loadToolProject(input, context, false);
    if (!loaded.ok) return loaded;
    const projected = projectOverviewProjection(loaded.value.state, requiredString(input, "projectId"), projectionContext(loaded.value));
    return projected.ok ? apiOk({ data: { goals: projected.value.goals }, stateHeadSha: loaded.value.stateHeadSha }) : projectionFailure(projected);
  }

  async #getGoalTool(input: JsonRecord, context: AuthContext): Promise<ApiResult<{ data: unknown; stateHeadSha: string }>> {
    const loaded = await this.#loadToolProject(input, context, false);
    if (!loaded.ok) return loaded;
    const projected = goalDetailProjection(loaded.value.state, requiredString(input, "projectId"), requiredString(input, "goalId"));
    return projected.ok ? apiOk({ data: projected.value, stateHeadSha: loaded.value.stateHeadSha }) : projectionFailure(projected);
  }

  async #createGoalTool(input: JsonRecord, context: AuthContext): Promise<ApiResult<{ data: unknown; stateHeadSha: string }>> {
    const repository = await this.#repositoryFromInput(context, record(input, "repository"), true);
    if (!repository.ok) return repository;
    const result = await this.#createGoal(repository.value, context, {
      projectId: requiredString(input, "projectId"),
      goalId: requiredString(input, "goalId"),
      title: requiredString(input, "title"),
      desiredOutcome: requiredString(input, "desiredOutcome"),
      acceptanceCriteria: requiredStringArray(input, "acceptanceCriteria", true),
      constraints: requiredStringArray(input, "constraints", false),
      priority: optionalNonNegativeInteger(input, "priority") ?? 50,
      runnerId: optionalString(input, "runnerId"),
      idempotencyKey: requiredString(input, "idempotencyKey"),
      expectedStateSha: optionalString(input, "expectedStateSha")
    });
    return toolMutation(result);
  }

  async #updateGoalTool(input: JsonRecord, context: AuthContext): Promise<ApiResult<{ data: unknown; stateHeadSha: string }>> {
    const repository = await this.#repositoryFromInput(context, record(input, "repository"), true);
    if (!repository.ok) return repository;
    return toolMutation(await this.#updateGoal(repository.value, context, input));
  }

  async #pauseGoalTool(input: JsonRecord, context: AuthContext): Promise<ApiResult<{ data: unknown; stateHeadSha: string }>> {
    const repository = await this.#repositoryFromInput(context, record(input, "repository"), true);
    if (!repository.ok) return repository;
    return toolMutation(await this.#pauseGoal(
      repository.value,
      context,
      requiredString(input, "projectId"),
      requiredString(input, "goalId"),
      requiredString(input, "idempotencyKey"),
      optionalString(input, "expectedStateSha"),
      requiredString(input, "reason")
    ));
  }

  async #completeGoalTool(input: JsonRecord, context: AuthContext): Promise<ApiResult<{ data: unknown; stateHeadSha: string }>> {
    const repository = await this.#repositoryFromInput(context, record(input, "repository"), true);
    if (!repository.ok) return repository;
    return toolMutation(await this.#completeGoal(
      repository.value,
      context,
      requiredString(input, "projectId"),
      requiredString(input, "goalId"),
      requiredString(input, "selectedRunId"),
      requiredString(input, "idempotencyKey"),
      optionalString(input, "expectedStateSha")
    ));
  }

  async #listRunnersTool(input: JsonRecord, context: AuthContext): Promise<ApiResult<{ data: unknown; stateHeadSha: string }>> {
    const loaded = await this.#loadToolProject(input, context, false);
    if (!loaded.ok) return loaded;
    const projected = runnerDirectoryProjection(loaded.value.state, requiredString(input, "projectId"));
    return projected.ok ? apiOk({ data: { runners: projected.value }, stateHeadSha: loaded.value.stateHeadSha }) : projectionFailure(projected);
  }

  async #getRunnerTool(input: JsonRecord, context: AuthContext): Promise<ApiResult<{ data: unknown; stateHeadSha: string }>> {
    const loaded = await this.#loadToolProject(input, context, false);
    if (!loaded.ok) return loaded;
    const projected = runnerDirectoryProjection(loaded.value.state, requiredString(input, "projectId"));
    if (!projected.ok) return projectionFailure(projected);
    const runnerId = requiredString(input, "runnerId");
    const runner = projected.value.find(item => item.id === runnerId);
    return runner ? apiOk({ data: runner, stateHeadSha: loaded.value.stateHeadSha }) : notFound(`Runner ${runnerId} was not found.`);
  }

  async #getRunTool(input: JsonRecord, context: AuthContext): Promise<ApiResult<{ data: unknown; stateHeadSha: string }>> {
    const loaded = await this.#loadToolProject(input, context, false);
    if (!loaded.ok) return loaded;
    const projected = runDetailProjection(
      loaded.value.state,
      requiredString(input, "projectId"),
      requiredString(input, "runId")
    );
    return projected.ok ? apiOk({ data: projected.value, stateHeadSha: loaded.value.stateHeadSha }) : projectionFailure(projected);
  }

  async #getCoachTool(input: JsonRecord, context: AuthContext): Promise<ApiResult<{ data: unknown; stateHeadSha: string }>> {
    const loaded = await this.#loadToolProject(input, context, false);
    if (!loaded.ok) return loaded;
    const projected = coachViewProjection(loaded.value.state, requiredString(input, "projectId"));
    return projected.ok ? apiOk({ data: projected.value, stateHeadSha: loaded.value.stateHeadSha }) : projectionFailure(projected);
  }

  async #createPlayerTool(input: JsonRecord, context: AuthContext): Promise<ApiResult<{ data: unknown; stateHeadSha: string }>> {
    if ("name" in input) return invalidRequest("Runner definitions do not have a name; use runnerId as their canonical identity.");
    const repository = await this.#repositoryFromInput(context, record(input, "repository"), true);
    if (!repository.ok) return repository;
    const projectId = requiredString(input, "projectId");
    const runnerId = requiredString(input, "runnerId");
    const at = this.#timestamp();
    const player: Player = {
      kind: "player",
      id: asRunnerId(runnerId),
      projectId: asProjectId(projectId),
      promptTemplate: asPromptTemplate(requiredString(input, "promptTemplate")),
      resources: parseResourceBindings(input.resources),
      runtimePolicy: parseRuntimePolicy(record(input, "runtimePolicy")),
      createdAt: asTimestamp(at),
      updatedAt: asTimestamp(at)
    };
    const result = await this.#mutate({
      repository: repository.value,
      projectId,
      context,
      idempotencyKey: requiredString(input, "idempotencyKey"),
      expectedStateSha: optionalString(input, "expectedStateSha"),
      semanticCommand: {
        type: "CreatePlayer",
        projectId,
        runnerId,
        promptTemplate: requiredString(input, "promptTemplate"),
        resources: input.resources,
        runtimePolicy: input.runtimePolicy
      },
      factories: [(_state, meta) => ({ type: "CreatePlayer", meta, player })]
    });
    return toolMutation(result, { runnerId });
  }

  async #createTeamTool(input: JsonRecord, context: AuthContext): Promise<ApiResult<{ data: unknown; stateHeadSha: string }>> {
    if ("name" in input) return invalidRequest("Runner definitions do not have a name; use runnerId as their canonical identity.");
    const repository = await this.#repositoryFromInput(context, record(input, "repository"), true);
    if (!repository.ok) return repository;
    const projectId = requiredString(input, "projectId");
    const runnerId = requiredString(input, "runnerId");
    const at = this.#timestamp();
    const playersInput = array(input, "players", true).map((item, index) => {
      const player = assertRecord(item, `players[${index}]`);
      return {
        playerId: asRunnerId(requiredString(player, "playerId")),
        role: asText(requiredString(player, "role")),
        order: asPositiveInteger(requiredPositiveInteger(player, "order"))
      };
    });
    const players = asNonEmpty(playersInput, "players");
    const strategyInput = record(input, "strategy");
    const mode = requiredString(strategyInput, "mode");
    const team: Team = {
      kind: "team",
      id: asRunnerId(runnerId),
      projectId: asProjectId(projectId),
      strategy: {
        mode: strategyMode(mode),
        promptTemplate: asPromptTemplate(requiredString(strategyInput, "promptTemplate")),
        maxRounds: asPositiveInteger(requiredPositiveInteger(strategyInput, "maxRounds"))
      },
      players,
      createdAt: asTimestamp(at),
      updatedAt: asTimestamp(at)
    };
    const result = await this.#mutate({
      repository: repository.value,
      projectId,
      context,
      idempotencyKey: requiredString(input, "idempotencyKey"),
      expectedStateSha: optionalString(input, "expectedStateSha"),
      semanticCommand: { type: "CreateTeam", projectId, runnerId, strategy: input.strategy, players: input.players },
      factories: [(_state, meta) => ({ type: "CreateTeam", meta, team })]
    });
    return toolMutation(result, { runnerId });
  }

  async #updateRunnerTool(input: JsonRecord, context: AuthContext): Promise<ApiResult<{ data: unknown; stateHeadSha: string }>> {
    const repository = await this.#repositoryFromInput(context, record(input, "repository"), true);
    if (!repository.ok) return repository;
    const projectId = requiredString(input, "projectId");
    const runnerId = requiredString(input, "runnerId");
    const definition = record(input, "definition");
    const assertOnlyFields = (value: JsonRecord, fields: readonly string[], path: string): void => {
      const unexpected = Object.keys(value).find(key => !fields.includes(key));
      if (unexpected) throw boundaryInvalid(`${path}.${unexpected} is not supported.`);
    };
    const strictResources = (value: unknown): ResourceBinding[] => {
      if (!Array.isArray(value)) throw boundaryInvalid("definition.resources must be an array.");
      value.forEach((item, index) => assertOnlyFields(
        assertRecord(item, `definition.resources[${index}]`),
        ["kind", "name", "reference"],
        `definition.resources[${index}]`
      ));
      return parseResourceBindings(value);
    };
    const strictRuntimePolicy = (value: unknown): RuntimePolicy => {
      const policy = assertRecord(value, "definition.runtimePolicy");
      assertOnlyFields(policy, ["filesystem", "network", "approvals"], "definition.runtimePolicy");
      return parseRuntimePolicy(policy);
    };
    const kind = requiredString(definition, "kind");
    let semanticDefinition: JsonRecord;
    let playerUpdate: {
      promptTemplate?: Player["promptTemplate"];
      resources?: ResourceBinding[];
      runtimePolicy?: RuntimePolicy;
    } | undefined;
    let teamUpdate: {
      strategy?: Partial<Team["strategy"]>;
      players?: Team["players"];
    } | undefined;

    if (kind === "player") {
      assertOnlyFields(definition, ["kind", "promptTemplate", "resources", "runtimePolicy"], "definition");
      const hasPromptTemplate = "promptTemplate" in definition;
      const hasResources = "resources" in definition;
      const hasRuntimePolicy = "runtimePolicy" in definition;
      if (!hasPromptTemplate && !hasResources && !hasRuntimePolicy) {
        return invalidRequest("A Player update must change promptTemplate, resources, or runtimePolicy.");
      }
      playerUpdate = {
        ...(hasPromptTemplate ? { promptTemplate: asPromptTemplate(requiredString(definition, "promptTemplate")) } : {}),
        ...(hasResources ? { resources: strictResources(definition.resources) } : {}),
        ...(hasRuntimePolicy ? { runtimePolicy: strictRuntimePolicy(definition.runtimePolicy) } : {})
      };
      semanticDefinition = { kind, ...playerUpdate };
    } else if (kind === "team") {
      assertOnlyFields(definition, ["kind", "strategy", "players"], "definition");
      const hasStrategy = "strategy" in definition;
      const hasPlayers = "players" in definition;
      if (!hasStrategy && !hasPlayers) return invalidRequest("A Team update must change strategy or Player membership.");
      let strategy: Partial<Team["strategy"]> | undefined;
      if (hasStrategy) {
        const strategyInput = assertRecord(definition.strategy, "definition.strategy");
        assertOnlyFields(strategyInput, ["mode", "promptTemplate", "maxRounds"], "definition.strategy");
        const hasMode = "mode" in strategyInput;
        const hasPromptTemplate = "promptTemplate" in strategyInput;
        const hasMaxRounds = "maxRounds" in strategyInput;
        if (!hasMode && !hasPromptTemplate && !hasMaxRounds) {
          return invalidRequest("A Team strategy update must change mode, promptTemplate, or maxRounds.");
        }
        strategy = {
          ...(hasMode ? { mode: strategyMode(requiredString(strategyInput, "mode")) } : {}),
          ...(hasPromptTemplate ? { promptTemplate: asPromptTemplate(requiredString(strategyInput, "promptTemplate")) } : {}),
          ...(hasMaxRounds ? { maxRounds: asPositiveInteger(requiredPositiveInteger(strategyInput, "maxRounds")) } : {})
        };
      }
      let players: Team["players"] | undefined;
      if (hasPlayers) {
        const parsedPlayers = array(definition, "players", true).map((item, index) => {
          const player = assertRecord(item, `definition.players[${index}]`);
          assertOnlyFields(player, ["playerId", "role", "order"], `definition.players[${index}]`);
          return {
            playerId: asRunnerId(requiredString(player, "playerId")),
            role: asText(requiredString(player, "role"), `definition.players[${index}].role`),
            order: asPositiveInteger(requiredPositiveInteger(player, "order"))
          };
        });
        players = asNonEmpty(parsedPlayers, "definition.players");
      }
      teamUpdate = { ...(strategy ? { strategy } : {}), ...(players ? { players } : {}) };
      semanticDefinition = { kind, ...teamUpdate };
    } else {
      return invalidRequest("definition.kind must be player or team.");
    }

    const result = await this.#mutate({
      repository: repository.value,
      projectId,
      context,
      idempotencyKey: requiredString(input, "idempotencyKey"),
      expectedStateSha: optionalString(input, "expectedStateSha"),
      semanticCommand: { type: "UpdateRunner", projectId, runnerId, definition: semanticDefinition },
      factories: [(state, meta) => {
        const current = state.runners.find(item => item.id === runnerId);
        if (!current) throw boundaryNotFound(`Runner ${runnerId} was not found.`);
        const updatedAt = asTimestamp(this.#timestamp());
        if (current.kind !== kind) {
          throw boundaryInvalid(`Runner ${runnerId} is a ${current.kind}; a ${kind} definition cannot update it.`);
        }
        if (current.kind === "player" && playerUpdate) {
          const player: Player = {
            ...current,
            ...playerUpdate,
            updatedAt
          };
          return { type: "UpdatePlayer", meta, player };
        }
        if (current.kind !== "team" || !teamUpdate) throw boundaryInvalid("Runner update definition does not match the stored Runner kind.");
        const team: Team = {
          ...current,
          ...(teamUpdate.strategy ? { strategy: { ...current.strategy, ...teamUpdate.strategy } } : {}),
          ...(teamUpdate.players ? { players: teamUpdate.players } : {}),
          updatedAt
        };
        return { type: "UpdateTeam", meta, team };
      }]
    });
    return toolMutation(result, { runnerId });
  }

  async #createProject(
    repository: RepositoryGrant,
    context: AuthContext,
    input: { projectId: string; coachId: string; title: string; objective: string; baseRef: string; idempotencyKey: string; expectedStateSha?: string }
  ): Promise<ApiResult<MutationResult<{ projectId: string }>>> {
    const selectedRef = normalizeRef(input.baseRef);
    const selectedBranch = selectedRef.replace(/^refs\/heads\//u, "");
    const exists = await this.#transport.readBranch(repository, selectedBranch);
    if (!exists.ok) return transportFailure(exists.error);
    if (!exists.value) return apiFailure({ code: "stale_base", message: `Selected base ref ${selectedRef} does not exist.`, status: 412, retryable: false });
    const at = this.#timestamp();
    const project: Project = {
      id: asProjectId(input.projectId),
      workspaceId: asWorkspaceId(`workspace-${repository.installationId}`),
      repository: { owner: asRepositoryOwner(repository.owner), name: asRepositoryName(repository.name) },
      baseRef: asGitRef(selectedRef),
      title: asProjectTitle(input.title),
      objective: asProjectObjective(input.objective),
      coachId: asCoachId(input.coachId),
      goalIds: [],
      runnerIds: [],
      createdAt: asTimestamp(at),
      updatedAt: asTimestamp(at)
    };
    const coach: Coach = {
      id: asCoachId(input.coachId),
      projectId: project.id,
      promptTemplate: asPromptTemplate("Review Goals, Runs, evidence, and alternatives; propose changes without making consequential user decisions."),
      resources: [],
      policy: { goalChanges: "propose_only", runnerChanges: "propose_only", hunsu: "propose_only", selection: "user_only" },
      createdAt: asTimestamp(at),
      updatedAt: asTimestamp(at)
    };
    const result = await this.#mutate({
      repository,
      projectId: input.projectId,
      context,
      idempotencyKey: input.idempotencyKey,
      expectedStateSha: input.expectedStateSha,
      semanticCommand: {
        type: "CreateProject",
        projectId: input.projectId,
        coachId: input.coachId,
        title: input.title,
        objective: input.objective,
        baseRef: selectedRef,
        repository: { installationId: repository.installationId, repositoryId: repository.repositoryId, owner: repository.owner, name: repository.name }
      },
      factories: [(_state, meta) => ({ type: "CreateProject", meta, project, coach })]
    });
    return result.ok ? apiOk({ ...result.value, value: { projectId: input.projectId } }) : result;
  }

  async #createGoal(
    repository: RepositoryLocator,
    context: AuthContext,
    input: { projectId: string; goalId: string; title: string; desiredOutcome: string; acceptanceCriteria: string[]; constraints: string[]; priority: number; runnerId?: string; idempotencyKey: string; expectedStateSha?: string }
  ): Promise<ApiResult<MutationResult<{ goalId: string }>>> {
    const at = this.#timestamp();
    const criteria = asNonEmpty(input.acceptanceCriteria.map((item, index) => asAcceptanceCriterion(item, `acceptanceCriteria[${index}]`)), "acceptanceCriteria");
    const goal: ActiveGoal = {
      id: asGoalId(input.goalId),
      projectId: asProjectId(input.projectId),
      title: asGoalTitle(input.title),
      desiredOutcome: asDesiredOutcome(input.desiredOutcome),
      acceptanceCriteria: criteria,
      constraints: input.constraints.map((item, index) => asGoalConstraint(item, `constraints[${index}]`)),
      priority: asNonNegativeInteger(input.priority),
      assignment: input.runnerId ? { type: "assigned", runnerId: asRunnerId(input.runnerId) } : { type: "unassigned" },
      relation: { type: "root" },
      status: "active",
      createdAt: asTimestamp(at),
      updatedAt: asTimestamp(at)
    };
    const result = await this.#mutate({
      repository,
      projectId: input.projectId,
      context,
      idempotencyKey: input.idempotencyKey,
      expectedStateSha: input.expectedStateSha,
      semanticCommand: {
        type: "CreateGoal",
        projectId: input.projectId,
        goalId: input.goalId,
        title: input.title,
        desiredOutcome: input.desiredOutcome,
        acceptanceCriteria: input.acceptanceCriteria,
        constraints: input.constraints,
        priority: input.priority,
        runnerId: input.runnerId ?? null
      },
      factories: [(_state, meta) => ({ type: "CreateGoal", meta, goal })]
    });
    return result.ok ? apiOk({ ...result.value, value: { goalId: input.goalId } }) : result;
  }

  async #updateGoal(repository: RepositoryLocator, context: AuthContext, input: JsonRecord): Promise<ApiResult<MutationResult<{ goalId: string }>>> {
    const projectId = requiredString(input, "projectId");
    const goalId = requiredString(input, "goalId");
    const patch: GoalPatch = {
      ...(optionalString(input, "title") ? { title: asGoalTitle(optionalString(input, "title")!) } : {}),
      ...(optionalString(input, "desiredOutcome") ? { desiredOutcome: asDesiredOutcome(optionalString(input, "desiredOutcome")!) } : {}),
      ...(input.acceptanceCriteria !== undefined ? {
        acceptanceCriteria: asNonEmpty(requiredStringArray(input, "acceptanceCriteria", true).map((item, index) => asAcceptanceCriterion(item, `acceptanceCriteria[${index}]`)), "acceptanceCriteria")
      } : {}),
      ...(input.constraints !== undefined ? {
        constraints: requiredStringArray(input, "constraints", false).map((item, index) => asGoalConstraint(item, `constraints[${index}]`))
      } : {}),
      ...(input.priority !== undefined ? { priority: asNonNegativeInteger(requiredNonNegativeInteger(input, "priority")) } : {}),
      ...(input.runnerId !== undefined ? {
        assignment: optionalString(input, "runnerId")
          ? { type: "assigned" as const, runnerId: asRunnerId(optionalString(input, "runnerId")!) }
          : { type: "unassigned" as const }
      } : {})
    };
    if (Object.keys(patch).length === 0) return invalidRequest("A Goal update must change at least one field.");
    const result = await this.#mutate({
      repository,
      projectId,
      context,
      idempotencyKey: requiredString(input, "idempotencyKey"),
      expectedStateSha: optionalString(input, "expectedStateSha"),
      semanticCommand: { type: "UpdateGoal", projectId, goalId, patch },
      factories: [(_state, meta) => ({ type: "UpdateGoal", meta, goalId: asGoalId(goalId), patch })]
    });
    return result.ok ? apiOk({ ...result.value, value: { goalId } }) : result;
  }

  async #pauseGoal(
    repository: RepositoryLocator,
    context: AuthContext,
    projectId: string,
    goalId: string,
    idempotencyKey: string,
    expectedStateSha: string | undefined,
    reason: string
  ): Promise<ApiResult<MutationResult<{ goalId: string }>>> {
    const result = await this.#mutate({
      repository,
      projectId,
      context,
      idempotencyKey,
      expectedStateSha,
      semanticCommand: { type: "PauseGoal", projectId, goalId, reason },
      factories: [(_state, meta) => ({ type: "PauseGoal", meta, goalId: asGoalId(goalId), reason: asReason(reason) })]
    });
    return result.ok ? apiOk({ ...result.value, value: { goalId } }) : result;
  }

  async #resumeGoal(
    repository: RepositoryLocator,
    context: AuthContext,
    projectId: string,
    goalId: string,
    idempotencyKey: string,
    expectedStateSha?: string
  ): Promise<ApiResult<MutationResult<{ goalId: string }>>> {
    const result = await this.#mutate({
      repository,
      projectId,
      context,
      idempotencyKey,
      expectedStateSha,
      semanticCommand: { type: "ResumeGoal", projectId, goalId },
      factories: [(_state, meta) => ({ type: "ResumeGoal", meta, goalId: asGoalId(goalId) })]
    });
    return result.ok ? apiOk({ ...result.value, value: { goalId } }) : result;
  }

  async #completeGoal(
    repository: RepositoryLocator,
    context: AuthContext,
    projectId: string,
    goalId: string,
    selectedRunId: string,
    idempotencyKey: string,
    expectedStateSha?: string
  ): Promise<ApiResult<MutationResult<{ goalId: string }>>> {
    const result = await this.#mutate({
      repository,
      projectId,
      context,
      idempotencyKey,
      expectedStateSha,
      semanticCommand: { type: "CompleteGoal", projectId, goalId, selectedRunId },
      factories: [(_state, meta) => ({ type: "CompleteGoal", meta, goalId: asGoalId(goalId), selectedRunId: asRunId(selectedRunId) })]
    });
    return result.ok ? apiOk({ ...result.value, value: { goalId } }) : result;
  }

  async #startRunTool(input: JsonRecord, context: AuthContext): Promise<ApiResult<{ data: unknown; stateHeadSha: string }>> {
    const repository = await this.#repositoryFromInput(context, record(input, "repository"), true);
    if (!repository.ok) return repository;
    const projectId = requiredString(input, "projectId");
    const goalId = requiredString(input, "goalId");
    const runnerId = requiredString(input, "runnerId");
    const runId = requiredString(input, "runId");
    const baseSha = requiredString(input, "baseSha");
    asGitSha(baseSha);
    const idempotencyKey = requiredString(input, "idempotencyKey");
    const alternativeOfRunId = optionalString(input, "alternativeOfRunId");
    const coachProposalId = optionalString(input, "coachProposalId");
    const confirmedByUser = input.confirmedByUser === true;
    if (input.confirmedByUser !== undefined && input.confirmedByUser !== true) {
      return invalidRequest("confirmedByUser must be true when supplied.");
    }
    if (coachProposalId && !alternativeOfRunId) {
      return invalidRequest("coachProposalId is valid only when starting a Hunsu alternative.");
    }
    if (confirmedByUser && !coachProposalId) {
      return invalidRequest("confirmedByUser requires the exact Coach proposal id being accepted.");
    }
    if (coachProposalId && !confirmedByUser) {
      return apiFailure({
        code: "confirmation_required",
        message: "Starting a Coach-proposed Hunsu alternative requires explicit user confirmation.",
        status: 409,
        retryable: false
      });
    }
    const loaded = await this.#loadProject(repository.value, projectId, true);
    if (!loaded.ok) return loaded;
    const existingRun = loaded.value.state.runs.find(item => item.id === runId);
    let proposalToAccept: HunsuProposal | undefined;
    let origin: Run["origin"] = existingRun?.origin ?? { type: "primary" };
    if (!existingRun && alternativeOfRunId) {
      let divergence = [...loaded.value.state.divergences].reverse().find(item => item.sourceRunId === alternativeOfRunId && item.goalId === goalId);
      if (divergence && coachProposalId
        && (divergence.basis.type !== "coach_proposal" || divergence.basis.proposalId !== coachProposalId)) {
        return invalidRequest("The confirmed Hunsu divergence does not match coachProposalId.");
      }
      if (!divergence) {
        if (!confirmedByUser || !coachProposalId) {
          return apiFailure({
            code: "confirmation_required",
            message: "Confirm the matching Coach Hunsu proposal before starting this alternative Run.",
            status: 409,
            retryable: false
          });
        }
        const proposal = loaded.value.state.coachProposals.find(item => item.id === coachProposalId);
        if (!proposal) return notFound(`Coach proposal ${coachProposalId} was not found.`);
        if (proposal.type !== "hunsu"
          || proposal.projectId !== projectId
          || proposal.goalId !== goalId
          || proposal.sourceRunId !== alternativeOfRunId) {
          return invalidRequest("coachProposalId does not identify the matching Hunsu proposal for this sibling Run.");
        }
        if (loaded.value.state.coachProposalDecisions.some(item => item.proposalId === proposal.id)
          || loaded.value.state.divergences.some(item => item.basis.type === "coach_proposal" && item.basis.proposalId === proposal.id)) {
          return conflict(`Coach proposal ${coachProposalId} already has a recorded disposition.`);
        }
        const sourceRun = loaded.value.state.runs.find(item => item.id === alternativeOfRunId);
        if (!sourceRun) return notFound(`Source Run ${alternativeOfRunId} was not found.`);
        if (sourceRun.status !== "completed") return conflict("A Coach-proposed Hunsu alternative requires a completed source Run.");
        if (sourceRun.baseSha !== baseSha) {
          return apiFailure({ code: "stale_base", message: "Alternative Runs must start from the source Run's exact base SHA.", status: 412, retryable: false });
        }
        if (!loaded.value.state.goals.some(item => item.id === goalId)) return notFound(`Goal ${goalId} was not found.`);
        const proposedRunnerId = proposal.alternative.type === "runner_change"
          ? proposal.alternative.runnerId
          : proposal.alternative.change.assignment?.type === "assigned"
            ? proposal.alternative.change.assignment.runnerId
            : sourceRun.runnerId;
        if (proposedRunnerId !== runnerId) {
          return invalidRequest("The requested Runner does not match the Coach-proposed Hunsu change.");
        }
        const divergenceId = asDivergenceId(generatedId("divergence", idempotencyKey));
        proposalToAccept = proposal;
        divergence = {
          id: divergenceId,
          projectId: asProjectId(projectId),
          goalId: asGoalId(goalId),
          sourceRunId: asRunId(alternativeOfRunId),
          baseSha: asGitSha(baseSha),
          basis: { type: "coach_proposal", proposalId: proposal.id },
          alternativeRunIds: [],
          confirmedAt: asTimestamp(this.#timestamp())
        };
      }
      if (divergence.baseSha !== baseSha) return apiFailure({ code: "stale_base", message: "Alternative Runs must start from the confirmed shared base SHA.", status: 412, retryable: false });
      origin = { type: "hunsu_alternative", divergenceId: divergence.id, sourceRunId: asRunId(alternativeOfRunId) };
    } else if (!existingRun) {
      const project = loaded.value.state.projects.find(item => item.id === projectId);
      if (!project) return notFound(`Project ${projectId} was not found.`);
      const branch = String(project.baseRef).replace(/^refs\/heads\//u, "");
      const currentBase = await this.#transport.readBranch(repository.value, branch);
      if (!currentBase.ok) return transportFailure(currentBase.error);
      if (!currentBase.value || currentBase.value.headSha !== baseSha) {
        return apiFailure({ code: "stale_base", message: "The selected Project base ref changed before the Run started.", status: 412, retryable: true, actualStateSha: currentBase.value?.headSha });
      }
    }
    const branch = existingRun?.branch ?? runBranchName(asProjectId(projectId), asGoalId(goalId), asRunId(runId));
    const factories: MutationCommandFactory[] = [];
    if (proposalToAccept) {
      const acceptedProposal = proposalToAccept;
      factories.push((_state, meta) => ({
        type: "AcceptCoachProposal",
        meta: withActor(meta, userActor(context)),
        proposalId: acceptedProposal.id,
        reason: asReason("User confirmed the Coach-proposed Hunsu alternative before starting its Run"),
        application: { type: "hunsu", divergenceId: origin.type === "hunsu_alternative" ? origin.divergenceId : asDivergenceId(generatedId("divergence", idempotencyKey)) }
      }));
    }
    factories.push((_state, meta) => ({
      type: "StartRun",
      meta: withActor(meta, pluginActor(context)),
      runId: asRunId(runId),
      projectId: asProjectId(projectId),
      goalId: asGoalId(goalId),
      runnerId: asRunnerId(runnerId),
      baseSha: asGitSha(baseSha),
      branch,
      origin
    }));
    const semanticCommand = {
      type: "StartRun",
      projectId,
      goalId,
      runnerId,
      runId,
      baseSha,
      branch,
      origin,
      alternativeOfRunId: alternativeOfRunId ?? null,
      coachProposalId: coachProposalId ?? null,
      confirmedByUser
    };
    const expectedStateSha = optionalString(input, "expectedStateSha");
    if (!existingRun && expectedStateSha && expectedStateSha !== loaded.value.stateHeadSha) {
      return apiFailure({
        code: "stale_state",
        message: "Project state changed since it was loaded.",
        status: 412,
        retryable: true,
        expectedStateSha,
        actualStateSha: loaded.value.stateHeadSha
      });
    }
    let preflightState = loaded.value.state;
    const preflightAt = this.#timestamp();
    for (let index = 0; index < factories.length; index += 1) {
      const meta = commandMetadata(idempotencyKey, semanticCommand, index, preflightAt, requestActor(context));
      const applied = applyProjectCommand(preflightState, factories[index](preflightState, meta));
      if (!applied.ok) {
        return storeFailure({ code: "invalid_event", message: `DOMAIN:${applied.error.code}:${applied.error.message}` });
      }
      preflightState = applied.value.state;
    }
    const branchCreated = await this.#store.createRunBranch({ repository: repository.value, projectId, goalId, runId, baseSha });
    if (!branchCreated.ok) return storeFailure(branchCreated.error);
    const result = await this.#mutate({
      repository: repository.value,
      projectId,
      context,
      idempotencyKey,
      expectedStateSha,
      semanticCommand,
      factories
    });
    if (!result.ok) return result;
    const run = result.value.state.runs.find(item => item.id === runId);
    if (!run) return apiFailure({ code: "temporarily_unavailable", message: "The started Run could not be projected.", status: 503, retryable: true });
    return apiOk({ data: runContract(repository.value, run), stateHeadSha: result.value.stateHeadSha });
  }

  async #checkpointRunTool(input: JsonRecord, context: AuthContext): Promise<ApiResult<{ data: unknown; stateHeadSha: string }>> {
    const repository = await this.#repositoryFromInput(context, record(input, "repository"), true);
    if (!repository.ok) return repository;
    const projectId = requiredString(input, "projectId");
    const runId = requiredString(input, "runId");
    const idempotencyKey = requiredString(input, "idempotencyKey");
    const checkpointId = generatedId("checkpoint", idempotencyKey);
    const checkpoint = {
      id: asCheckpointId(checkpointId),
      runId: asRunId(runId),
      summary: asEvidenceSummary(requiredString(input, "summary")),
      ...(optionalString(input, "commitSha") ? { commitSha: asGitSha(optionalString(input, "commitSha")!) } : {}),
      recordedAt: asTimestamp(this.#timestamp())
    };
    const result = await this.#mutate({
      repository: repository.value,
      projectId,
      context,
      idempotencyKey,
      expectedStateSha: optionalString(input, "expectedStateSha"),
      semanticCommand: {
        type: "CheckpointRun",
        projectId,
        runId,
        checkpointId,
        summary: requiredString(input, "summary"),
        commitSha: optionalString(input, "commitSha") ?? null
      },
      factories: [(_state, meta) => ({ type: "CheckpointRun", meta, checkpoint })]
    });
    return toolMutation(result, { checkpointId });
  }

  async #attachEvidenceTool(input: JsonRecord, context: AuthContext): Promise<ApiResult<{ data: unknown; stateHeadSha: string }>> {
    const repository = await this.#repositoryFromInput(context, record(input, "repository"), true);
    if (!repository.ok) return repository;
    const projectId = requiredString(input, "projectId");
    const runId = requiredString(input, "runId");
    const idempotencyKey = requiredString(input, "idempotencyKey");
    const evidence = evidenceRef(projectId, runId, parseEvidence(record(input, "evidence")), generatedId("evidence", idempotencyKey), this.#timestamp());
    const result = await this.#mutate({
      repository: repository.value,
      projectId,
      context,
      idempotencyKey,
      expectedStateSha: optionalString(input, "expectedStateSha"),
      semanticCommand: { type: "AttachRunEvidence", projectId, runId, evidenceId: evidence.id, evidence: stableEvidence(parseEvidence(record(input, "evidence"))) },
      factories: [(_state, meta) => ({ type: "AttachRunEvidence", meta, evidence })]
    });
    return toolMutation(result, { evidenceId: evidence.id });
  }

  async #completeRunTool(input: JsonRecord, context: AuthContext): Promise<ApiResult<{ data: unknown; stateHeadSha: string }>> {
    const repository = await this.#repositoryFromInput(context, record(input, "repository"), true);
    if (!repository.ok) return repository;
    const projectId = requiredString(input, "projectId");
    const runId = requiredString(input, "runId");
    const resultSha = requiredString(input, "resultSha");
    asGitSha(resultSha);
    const loaded = await this.#loadProject(repository.value, projectId, true);
    if (!loaded.ok) return loaded;
    const run = loaded.value.state.runs.find(item => item.id === runId);
    if (!run) return notFound(`Run ${runId} was not found.`);
    const idempotencyKey = requiredString(input, "idempotencyKey");
    const evidenceInputs = input.evidence === undefined ? [] : array(input, "evidence", false).map((item, index) => parseEvidence(assertRecord(item, `evidence[${index}]`), true));
    const evidence = evidenceInputs.map((item, index) => evidenceRef(projectId, runId, item, generatedId(`evidence-${index + 1}`, idempotencyKey), this.#timestamp()));
    if (run.evidenceIds.length + evidence.length === 0) return invalidRequest("A completed Run requires at least one evidence item.");
    if (run.status !== "running" && run.status !== "completed") return conflict(`Run ${runId} is already ${run.status}.`);
    if (run.status === "running") {
      const verified = await this.#store.verifyRunResult({ repository: repository.value, branch: run.branch, baseSha: run.baseSha, resultSha });
      if (!verified.ok) {
        return apiFailure({ code: "result_unreachable", message: verified.error.message, status: 412, retryable: false });
      }
    }
    const factories: MutationCommandFactory[] = [
      ...evidence.map(item => (_state: ProjectState, meta: CommandMetadata): ProjectCommand => ({ type: "AttachRunEvidence", meta, evidence: item })),
      (_state, meta) => ({
        type: "CompleteRun",
        meta,
        result: { runId: asRunId(runId), branch: asGitBranch(run.branch), resultSha: asGitSha(resultSha), verifiedAt: asTimestamp(this.#timestamp()) }
      })
    ];
    const result = await this.#mutate({
      repository: repository.value,
      projectId,
      context,
      idempotencyKey,
      expectedStateSha: optionalString(input, "expectedStateSha"),
      semanticCommand: { type: "CompleteRun", projectId, runId, resultSha, evidence: evidenceInputs.map(stableEvidence) },
      factories
    });
    return toolMutation(result, { runId, resultSha });
  }

  async #failRunTool(input: JsonRecord, context: AuthContext): Promise<ApiResult<{ data: unknown; stateHeadSha: string }>> {
    const repository = await this.#repositoryFromInput(context, record(input, "repository"), true);
    if (!repository.ok) return repository;
    const projectId = requiredString(input, "projectId");
    const runId = requiredString(input, "runId");
    const idempotencyKey = requiredString(input, "idempotencyKey");
    const inputs = array(input, "evidence", true).map((item, index) => parseEvidence(assertRecord(item, `evidence[${index}]`)));
    const evidence = inputs.map((item, index) => evidenceRef(projectId, runId, item, generatedId(`evidence-${index + 1}`, idempotencyKey), this.#timestamp()));
    const factories: MutationCommandFactory[] = [
      ...evidence.map(item => (_state: ProjectState, meta: CommandMetadata): ProjectCommand => ({ type: "AttachRunEvidence", meta, evidence: item })),
      (_state, meta) => ({ type: "FailRun", meta, runId: asRunId(runId), reason: asReason(requiredString(input, "reason")) })
    ];
    const result = await this.#mutate({
      repository: repository.value,
      projectId,
      context,
      idempotencyKey,
      expectedStateSha: optionalString(input, "expectedStateSha"),
      semanticCommand: { type: "FailRun", projectId, runId, reason: requiredString(input, "reason"), evidence: inputs.map(stableEvidence) },
      factories
    });
    return toolMutation(result, { runId });
  }

  async #cancelRunTool(input: JsonRecord, context: AuthContext): Promise<ApiResult<{ data: unknown; stateHeadSha: string }>> {
    const repository = await this.#repositoryFromInput(context, record(input, "repository"), true);
    if (!repository.ok) return repository;
    const projectId = requiredString(input, "projectId");
    const runId = requiredString(input, "runId");
    const result = await this.#mutate({
      repository: repository.value,
      projectId,
      context,
      idempotencyKey: requiredString(input, "idempotencyKey"),
      expectedStateSha: optionalString(input, "expectedStateSha"),
      semanticCommand: { type: "CancelRun", projectId, runId, reason: requiredString(input, "reason") },
      factories: [(_state, meta) => ({ type: "CancelRun", meta, runId: asRunId(runId), reason: asReason(requiredString(input, "reason")) })]
    });
    return toolMutation(result, { runId });
  }

  async #coachReviewTool(input: JsonRecord, context: AuthContext): Promise<ApiResult<{ data: unknown; stateHeadSha: string }>> {
    const repository = await this.#repositoryFromInput(context, record(input, "repository"), true);
    if (!repository.ok) return repository;
    const idempotencyKey = requiredString(input, "idempotencyKey");
    const result = await this.#recordCoachReview(repository.value, context, {
      projectId: requiredString(input, "projectId"),
      reviewId: generatedId("review", idempotencyKey),
      goalId: optionalString(input, "goalId"),
      runId: optionalString(input, "runId"),
      assessment: requiredString(input, "assessment"),
      findings: requiredStringArray(input, "findings", false),
      recommendation: requiredString(input, "recommendation"),
      idempotencyKey,
      expectedStateSha: optionalString(input, "expectedStateSha")
    });
    return toolMutation(result);
  }

  async #recordCoachReview(
    repository: RepositoryLocator,
    context: AuthContext,
    input: { projectId: string; reviewId: string; goalId?: string; runId?: string; assessment: string; findings: string[]; recommendation?: string; idempotencyKey: string; expectedStateSha?: string }
  ): Promise<ApiResult<MutationResult<{ reviewId: string }>>> {
    const result = await this.#mutate({
      repository,
      projectId: input.projectId,
      context,
      idempotencyKey: input.idempotencyKey,
      expectedStateSha: input.expectedStateSha,
      semanticCommand: {
        type: "RecordCoachReview",
        projectId: input.projectId,
        reviewId: input.reviewId,
        goalId: input.goalId ?? null,
        runId: input.runId ?? null,
        assessment: input.assessment,
        findings: input.findings,
        recommendation: input.recommendation ?? null
      },
      factories: [(state, meta) => {
        const project = state.projects.find(item => item.id === input.projectId);
        if (!project) throw boundaryNotFound(`Project ${input.projectId} was not found.`);
        const recommendations = [...input.findings, ...(input.recommendation ? [input.recommendation] : [])].map((item, index) => asText(item, `recommendations[${index}]`));
        return {
          type: "RecordCoachReview",
          meta: withActor(meta, { type: "coach", coachId: project.coachId }),
          review: {
            id: asCoachReviewId(input.reviewId),
            projectId: project.id,
            coachId: project.coachId,
            target: input.runId
              ? { type: "run", runId: asRunId(input.runId) }
              : input.goalId
                ? { type: "goal", goalId: asGoalId(input.goalId) }
                : { type: "project", projectId: project.id },
            assessment: asText(input.assessment),
            recommendations,
            recordedAt: asTimestamp(this.#timestamp())
          }
        };
      }]
    });
    return result.ok ? apiOk({ ...result.value, value: { reviewId: input.reviewId } }) : result;
  }

  async #coachProposeChangeTool(input: JsonRecord, context: AuthContext): Promise<ApiResult<{ data: unknown; stateHeadSha: string }>> {
    const repository = await this.#repositoryFromInput(context, record(input, "repository"), true);
    if (!repository.ok) return repository;
    const projectId = requiredString(input, "projectId");
    const proposalId = requiredString(input, "proposalId");
    const target = requiredString(input, "target");
    const goalId = requiredString(input, "goalId");
    if (target !== "goal" && target !== "runner") return invalidRequest("target must be goal or runner.");
    if (target === "goal" && input.goalPatch === undefined) return invalidRequest("goalPatch is required for a Goal change proposal.");
    if (target === "runner" && !optionalString(input, "runnerId")) return invalidRequest("runnerId is required for a Runner change proposal.");
    const result = await this.#mutate({
      repository: repository.value,
      projectId,
      context,
      idempotencyKey: requiredString(input, "idempotencyKey"),
      expectedStateSha: optionalString(input, "expectedStateSha"),
      semanticCommand: {
        type: "RecordCoachProposal",
        projectId,
        proposalId,
        target,
        goalId,
        goalPatch: input.goalPatch ?? null,
        runnerId: optionalString(input, "runnerId") ?? null,
        summary: requiredString(input, "summary"),
        rationale: requiredString(input, "rationale")
      },
      factories: [(state, meta) => {
        const project = state.projects.find(item => item.id === projectId);
        if (!project) throw boundaryNotFound(`Project ${projectId} was not found.`);
        const base = {
          id: asCoachProposalId(proposalId),
          projectId: project.id,
          coachId: project.coachId,
          reason: asReason(requiredString(input, "rationale")),
          proposedAt: asTimestamp(this.#timestamp())
        };
        const proposal: CoachProposal = target === "goal"
          ? { ...base, type: "goal_change", goalId: asGoalId(goalId), change: parseGoalPatch(record(input, "goalPatch")) }
          : { ...base, type: "runner_change", goalId: asGoalId(goalId), runnerId: asRunnerId(requiredString(input, "runnerId")) };
        return { type: "RecordCoachProposal", meta: withActor(meta, { type: "coach", coachId: project.coachId }), proposal };
      }]
    });
    return toolMutation(result, { proposalId });
  }

  async #coachProposeHunsuTool(input: JsonRecord, context: AuthContext): Promise<ApiResult<{ data: unknown; stateHeadSha: string }>> {
    const repository = await this.#repositoryFromInput(context, record(input, "repository"), true);
    if (!repository.ok) return repository;
    const projectId = requiredString(input, "projectId");
    const proposalId = requiredString(input, "proposalId");
    const sourceRunId = requiredString(input, "sourceRunId");
    const goalId = requiredString(input, "goalId");
    const changedRunnerId = optionalString(input, "changedRunnerId");
    const hasGoalChange = input.changedGoalPatch !== undefined;
    if (hasGoalChange === (changedRunnerId !== undefined)) {
      return invalidRequest("A Hunsu proposal must provide exactly one of changedGoalPatch or changedRunnerId.");
    }
    const alternative: HunsuProposal["alternative"] = hasGoalChange
      ? { type: "goal_change", change: parseGoalPatch(record(input, "changedGoalPatch")) }
      : { type: "runner_change", runnerId: asRunnerId(changedRunnerId!) };
    const result = await this.#mutate({
      repository: repository.value,
      projectId,
      context,
      idempotencyKey: requiredString(input, "idempotencyKey"),
      expectedStateSha: optionalString(input, "expectedStateSha"),
      semanticCommand: { type: "RecordHunsuProposal", projectId, proposalId, sourceRunId, goalId, alternative },
      factories: [(state, meta) => {
        const project = state.projects.find(item => item.id === projectId);
        if (!project) throw boundaryNotFound(`Project ${projectId} was not found.`);
        const proposal: CoachProposal = {
          type: "hunsu",
          id: asCoachProposalId(proposalId),
          projectId: project.id,
          coachId: project.coachId,
          goalId: asGoalId(goalId),
          sourceRunId: asRunId(sourceRunId),
          alternative,
          reason: asReason(requiredString(input, "rationale")),
          proposedAt: asTimestamp(this.#timestamp())
        };
        return { type: "RecordCoachProposal", meta: withActor(meta, { type: "coach", coachId: project.coachId }), proposal };
      }]
    });
    return toolMutation(result, { proposalId });
  }

  async #compareAlternativesTool(input: JsonRecord, context: AuthContext): Promise<ApiResult<{ data: unknown; stateHeadSha: string }>> {
    const repository = await this.#repositoryFromInput(context, record(input, "repository"), true);
    if (!repository.ok) return repository;
    const projectId = requiredString(input, "projectId");
    const comparisonId = requiredString(input, "comparisonId");
    const runIdsInput = requiredStringArray(input, "runIds", true);
    if (runIdsInput.length < 2) return invalidRequest("A comparison requires at least two Runs.");
    const runIds = runIdsInput.map(asRunId) as unknown as readonly [ReturnType<typeof asRunId>, ReturnType<typeof asRunId>, ...ReturnType<typeof asRunId>[]];
    const findings = array(input, "findings", false).map((item, findingIndex) => {
      const finding = assertRecord(item, `findings[${findingIndex}]`);
      const summariesInput = array(finding, "summaries", true);
      const summaries = summariesInput.map((summaryItem, summaryIndex) => {
        const summary = assertRecord(summaryItem, `findings[${findingIndex}].summaries[${summaryIndex}]`);
        return {
          runId: asRunId(requiredString(summary, "runId")),
          summary: asEvidenceSummary(requiredString(summary, "summary"))
        };
      });
      return {
        criterion: asAcceptanceCriterion(requiredString(finding, "criterion")),
        summaries: asNonEmpty(summaries, `findings[${findingIndex}].summaries`)
      };
    });
    const result = await this.#mutate({
      repository: repository.value,
      projectId,
      context,
      idempotencyKey: requiredString(input, "idempotencyKey"),
      expectedStateSha: optionalString(input, "expectedStateSha"),
      semanticCommand: {
        type: "CompareAlternatives",
        projectId,
        comparisonId,
        divergenceId: requiredString(input, "divergenceId"),
        goalId: requiredString(input, "goalId"),
        runIds: runIdsInput,
        findings: input.findings,
        summary: requiredString(input, "summary")
      },
      factories: [(_state, meta) => ({
        type: "CompareAlternatives",
        meta,
        comparisonId: asComparisonId(comparisonId),
        divergenceId: asDivergenceId(requiredString(input, "divergenceId")),
        runIds,
        findings,
        summary: asEvidenceSummary(requiredString(input, "summary"))
      })]
    });
    if (!result.ok) return result;
    const projection = alternativeComparisonProjection(result.value.state, projectId, comparisonId);
    return projection.ok
      ? apiOk({ data: projection.value, stateHeadSha: result.value.stateHeadSha })
      : projectionFailure(projection);
  }

  async #selectAlternativeTool(input: JsonRecord, context: AuthContext): Promise<ApiResult<{ data: unknown; stateHeadSha: string }>> {
    if (input.confirmedByUser !== true) return apiFailure({ code: "confirmation_required", message: "Alternative selection requires explicit user confirmation.", status: 409, retryable: false });
    const repository = await this.#repositoryFromInput(context, record(input, "repository"), true);
    if (!repository.ok) return repository;
    const projectId = requiredString(input, "projectId");
    const runId = requiredString(input, "runId");
    const idempotencyKey = requiredString(input, "idempotencyKey");
    const decisionId = generatedId("decision", idempotencyKey);
    const result = await this.#mutate({
      repository: repository.value,
      projectId,
      context,
      idempotencyKey,
      expectedStateSha: optionalString(input, "expectedStateSha"),
      semanticCommand: { type: "SelectAlternative", projectId, runId, comparisonId: requiredString(input, "comparisonId") },
      factories: [(_state, meta) => ({
        type: "SelectAlternative",
        meta: withActor(meta, userActor(context)),
        decisionId: asDecisionId(decisionId),
        comparisonId: asComparisonId(requiredString(input, "comparisonId")),
        selectedRunId: asRunId(runId),
        rationale: asReason(requiredString(input, "rationale"))
      })]
    });
    return toolMutation(result, { decisionId });
  }

  async #rejectAlternativeTool(input: JsonRecord, context: AuthContext): Promise<ApiResult<{ data: unknown; stateHeadSha: string }>> {
    if (input.confirmedByUser !== true) return apiFailure({ code: "confirmation_required", message: "Alternative rejection requires explicit user confirmation.", status: 409, retryable: false });
    const repository = await this.#repositoryFromInput(context, record(input, "repository"), true);
    if (!repository.ok) return repository;
    const projectId = requiredString(input, "projectId");
    const runId = requiredString(input, "runId");
    const idempotencyKey = requiredString(input, "idempotencyKey");
    const decisionId = generatedId("decision", idempotencyKey);
    const result = await this.#mutate({
      repository: repository.value,
      projectId,
      context,
      idempotencyKey,
      expectedStateSha: optionalString(input, "expectedStateSha"),
      semanticCommand: { type: "RejectAlternative", projectId, runId, comparisonId: requiredString(input, "comparisonId") },
      factories: [(_state, meta) => ({
        type: "RejectAlternatives",
        meta: withActor(meta, userActor(context)),
        decisionId: asDecisionId(decisionId),
        comparisonId: asComparisonId(requiredString(input, "comparisonId")),
        rejectedRunIds: [asRunId(runId)],
        rationale: asReason(requiredString(input, "rationale"))
      })]
    });
    return toolMutation(result, { decisionId });
  }

  async #mutate(input: {
    repository: RepositoryLocator;
    projectId: string;
    context: AuthContext;
    idempotencyKey: string;
    expectedStateSha?: string;
    semanticCommand: unknown;
    factories: readonly MutationCommandFactory[];
  }): Promise<ApiResult<{ state: ProjectState; stateHeadSha: string; synchronizedAt: string; value: unknown }>> {
    if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 256) return invalidRequest("An idempotency key containing 1 to 256 characters is required.");
    if (input.factories.length === 0) return invalidRequest("A mutation must contain at least one command.");
    const base = await this.#transport.readBranch(input.repository, input.repository.defaultBranch);
    if (!base.ok) return transportFailure(base.error);
    if (!base.value) return apiFailure({ code: "stale_base", message: "The repository default branch is unavailable.", status: 412, retryable: true });
    const at = this.#timestamp();
    const domainActor = requestActor(input.context);
    const appended = await this.#store.append({
      repository: input.repository,
      projectId: input.projectId,
      baseSha: base.value.headSha,
      ...(input.expectedStateSha ? { expectedHeadSha: input.expectedStateSha } : {}),
      idempotencyKey: input.idempotencyKey,
      occurredAt: at,
      actor: stateActor(input.context),
      command: input.semanticCommand,
      decide: current => {
        let state = current ?? emptyProjectState();
        const events: DomainEvent[] = [];
        for (let index = 0; index < input.factories.length; index += 1) {
          const meta = commandMetadata(input.idempotencyKey, input.semanticCommand, index, at, domainActor);
          const command = input.factories[index](state, meta);
          const applied = applyProjectCommand(state, command);
          if (!applied.ok) {
            return {
              ok: false,
              error: { code: "invalid_event", message: `DOMAIN:${applied.error.code}:${applied.error.message}` }
            };
          }
          state = applied.value.state;
          events.push(...applied.value.emittedEvents);
        }
        return { ok: true, value: events };
      }
    });
    if (!appended.ok) return storeFailure(appended.error);
    const synchronizedAt = this.#timestamp();
    this.invalidateRepository(input.repository);
    this.#putCachedProject(
      cacheKey(input.repository, input.projectId),
      cachedProject(input.repository, appended.value.state, appended.value.stateHeadSha, synchronizedAt, this.#cacheNow())
    );
    return apiOk({
      state: appended.value.state,
      stateHeadSha: appended.value.stateHeadSha,
      synchronizedAt,
      value: { idempotentReplay: appended.value.idempotentReplay }
    });
  }

  async #loadToolProject(input: JsonRecord, context: AuthContext, requireWrite: boolean): Promise<ApiResult<AuthorizedProject>> {
    const repository = await this.#repositoryFromInput(context, record(input, "repository"), requireWrite);
    return repository.ok ? this.#loadProject(repository.value, requiredString(input, "projectId")) : repository;
  }

  async #loadProject(repository: RepositoryGrant, projectId: string, force = false): Promise<ApiResult<AuthorizedProject>> {
    const key = cacheKey(repository, projectId);
    const cached = force ? undefined : this.#getCachedProject(key, this.#cacheNow());
    if (!force) {
      if (cached && cacheIsFresh(cached, this.#cacheNow())) return apiOk(authorizeProject(cached, repository));
    }

    let generation = this.#captureCacheGeneration(repository);
    if (cached) {
      const stateHead = await this.#stateHead(repository);
      if (!stateHead.ok) return stateHead;
      if (stateHead.value === cached.stateHeadSha) {
        if (!this.#cacheGenerationIsCurrent(generation)) return apiOk(authorizeProject(cached, repository));
        const cachedAt = this.#cacheNow();
        const refreshed = { ...cached, synchronizedAt: this.#timestamp(), cachedAt };
        this.#putCachedProject(key, refreshed);
        return apiOk(authorizeProject(refreshed, repository));
      }
      if (this.#cacheGenerationIsCurrent(generation)) {
        this.invalidateRepository(repository);
        generation = this.#captureCacheGeneration(repository);
      }
    }

    const read = await this.#store.readProject(repository, projectId);
    if (!read.ok) return storeFailure(read.error);
    const entry = cachedProject(repository, read.value.state, read.value.stateHeadSha, this.#timestamp(), this.#cacheNow());
    if (this.#cacheGenerationIsCurrent(generation)) {
      this.invalidateRepository(repository);
      this.#putCachedProject(key, entry);
    }
    return apiOk(authorizeProject(entry, repository));
  }

  async #loadAllProjects(context: AuthContext, force = false, installationId?: number): Promise<ApiResult<AuthorizedProject[]>> {
    const repositories = await this.#authorizedRepositories(context, installationId);
    if (!repositories.ok) return repositories;
    const entries: AuthorizedProject[] = [];
    for (const repository of repositories.value) {
      const loaded = await this.#loadRepositoryProjects(repository, force);
      if (!loaded.ok) return loaded;
      entries.push(...loaded.value);
    }
    return apiOk(entries);
  }

  async #findProject(context: AuthContext, projectId: string, requireWrite = false): Promise<ApiResult<AuthorizedProject>> {
    asProjectId(projectId);
    const repositories = await this.#authorizedRepositories(context);
    if (!repositories.ok) return repositories;
    const matches: AuthorizedProject[] = [];
    for (const repository of repositories.value) {
      const now = this.#cacheNow();
      const cached = this.#getCachedProject(cacheKey(repository, projectId), now);
      if (cached && cacheIsFresh(cached, now)) {
        matches.push(authorizeProject(cached, repository));
        continue;
      }

      const catalog = this.#getCachedCatalog(repositoryCacheKey(repository), now);
      if (catalog && cacheIsFresh(catalog, now)) {
        if (!catalog.projectIds.includes(projectId)) continue;
        const loaded = await this.#loadProject(repository, projectId);
        if (!loaded.ok) {
          if (loaded.error.code === "not_found") continue;
          return loaded;
        }
        matches.push(loaded.value);
        continue;
      }

      const loaded = await this.#loadRepositoryProjects(repository, false);
      if (!loaded.ok) return loaded;
      const match = loaded.value.find(entry => projectIdOf(entry.state) === projectId);
      if (match) matches.push(match);
    }
    if (matches.length === 0) return notFound(`Project ${projectId} was not found.`);
    if (matches.length > 1) return conflict(`Project id ${projectId} is ambiguous across the authorized repositories.`);
    const match = matches[0];
    if (requireWrite && match.repository.permissions.contents !== "write") {
      return forbidden("The user's repository access does not allow Hunsu state writes.");
    }
    return apiOk(match);
  }

  async #loadRepositoryProjects(repository: RepositoryGrant, force: boolean): Promise<ApiResult<AuthorizedProject[]>> {
    const key = repositoryCacheKey(repository);
    const cached = force ? undefined : this.#getCachedCatalog(key, this.#cacheNow());
    if (cached && cacheIsFresh(cached, this.#cacheNow())) {
      const entries = this.#projectsFromCatalog(cached, repository);
      if (entries) return apiOk(entries);
    }

    const generation = this.#captureCacheGeneration(repository);
    let observedHead: string | undefined;
    if (!force) {
      const stateHead = await this.#stateHead(repository);
      if (!stateHead.ok) return stateHead;
      observedHead = stateHead.value;
      if (cached && cached.stateHeadSha === observedHead && this.#cacheGenerationIsCurrent(generation)) {
        const synchronizedAt = this.#timestamp();
        const cachedAt = this.#cacheNow();
        const refreshed = { ...cached, synchronizedAt, cachedAt };
        const entries = this.#projectsFromCatalog(refreshed, repository, { synchronizedAt, cachedAt });
        if (entries) {
          this.#putCachedCatalog(key, refreshed);
          return apiOk(entries);
        }
      }
      if (observedHead === undefined) {
        if (this.#cacheGenerationIsCurrent(generation)) {
          this.invalidateRepository(repository);
          const cachedAt = this.#cacheNow();
          this.#putCachedCatalog(
            key,
            cachedRepositoryCatalog(repository, undefined, [], this.#timestamp(), cachedAt)
          );
        }
        return apiOk([]);
      }
    }

    const reconstructed = await this.#store.reconstructRepository(repository);
    if (!reconstructed.ok) return storeFailure(reconstructed.error);
    const projects = reconstructed.value.projects;
    const synchronizedAt = this.#timestamp();
    const cachedAt = this.#cacheNow();
    const loaded: AuthorizedProject[] = [];
    const entries: Array<{ key: string; entry: CachedProject }> = [];
    for (const item of projects) {
      const entry = cachedProject(repository, item.state, item.stateHeadSha, synchronizedAt, cachedAt);
      entries.push({ key: cacheKey(repository, projectIdOf(item.state)), entry });
      loaded.push(authorizeProject(entry, repository));
    }
    if (this.#cacheGenerationIsCurrent(generation)) {
      this.invalidateRepository(repository);
      for (const item of entries) this.#putCachedProject(item.key, item.entry);
      this.#putCachedCatalog(
        key,
        cachedRepositoryCatalog(
          repository,
          reconstructed.value.kind === "state_branch" ? reconstructed.value.stateHeadSha : undefined,
          projects.map(item => projectIdOf(item.state)),
          synchronizedAt,
          cachedAt
        )
      );
    }
    return apiOk(loaded);
  }

  #getCachedProject(key: string, now: number): CachedProject | undefined {
    this.#pruneProjectionCaches(now);
    const entry = this.#cache.get(key);
    if (!entry) return undefined;
    entry.lastAccessedAt = now;
    entry.lastAccessOrder = this.#cacheAccessOrder();
    return entry;
  }

  #putCachedProject(key: string, entry: CachedProject): void {
    const now = this.#cacheNow();
    this.#pruneProjectionCaches(now);
    if (entry.sizeBytes > this.#cachePolicy.maxProjectBytes) {
      this.#cache.delete(key);
      return;
    }
    entry.lastAccessedAt = now;
    entry.lastAccessOrder = this.#cacheAccessOrder();
    this.#cache.set(key, entry);
    this.#enforceProjectCacheBounds();
  }

  #getCachedCatalog(key: string, now: number): CachedRepositoryCatalog | undefined {
    this.#pruneProjectionCaches(now);
    const entry = this.#catalogCache.get(key);
    if (!entry) return undefined;
    entry.lastAccessedAt = now;
    entry.lastAccessOrder = this.#cacheAccessOrder();
    return entry;
  }

  #putCachedCatalog(key: string, entry: CachedRepositoryCatalog): void {
    const now = this.#cacheNow();
    this.#pruneProjectionCaches(now);
    if (entry.sizeBytes > this.#cachePolicy.maxCatalogBytes) {
      this.#catalogCache.delete(key);
      return;
    }
    entry.lastAccessedAt = now;
    entry.lastAccessOrder = this.#cacheAccessOrder();
    this.#catalogCache.set(key, entry);
    this.#enforceCatalogCacheBounds();
  }

  #getCachedInstallationRepositories(key: string, now: number): CachedInstallationRepositories | undefined {
    this.#pruneInstallationCache(now);
    const entry = this.#installationCache.get(key);
    if (!entry) return undefined;
    entry.lastAccessedAt = now;
    entry.lastAccessOrder = this.#cacheAccessOrder();
    return entry;
  }

  #putCachedInstallationRepositories(key: string, entry: CachedInstallationRepositories): void {
    const now = this.#cacheNow();
    this.#pruneInstallationCache(now);
    if (entry.sizeBytes > this.#cachePolicy.maxInstallationBytes) {
      this.#installationCache.delete(key);
      return;
    }
    entry.lastAccessedAt = now;
    entry.lastAccessOrder = this.#cacheAccessOrder();
    this.#installationCache.set(key, entry);
    this.#enforceInstallationCacheBounds();
  }

  #projectsFromCatalog(
    catalog: CachedRepositoryCatalog,
    repository: RepositoryGrant,
    refresh?: { synchronizedAt: string; cachedAt: number }
  ): AuthorizedProject[] | undefined {
    const entries: AuthorizedProject[] = [];
    for (const projectId of catalog.projectIds) {
      const key = cacheKey(repository, projectId);
      const cached = this.#getCachedProject(key, this.#cacheNow());
      if (!cached || cached.stateHeadSha !== catalog.stateHeadSha) return undefined;
      const entry = refresh ? { ...cached, ...refresh } : cached;
      if (refresh) this.#putCachedProject(key, entry);
      entries.push(authorizeProject(entry, repository));
    }
    return entries;
  }

  #captureCacheGeneration(
    repository: Pick<RepositoryLocator, "installationId" | "repositoryId">
  ): CacheGenerationToken {
    const now = this.#cacheNow();
    this.#pruneCacheGenerations(now);
    const repositoryKey = repositoryCacheKey(repository);
    const current = this.#cacheGenerations.get(repositoryKey);
    const generation = current?.generation ?? this.#cacheGeneration();
    this.#cacheGenerations.set(repositoryKey, {
      generation,
      lastAccessedAt: now,
      lastAccessOrder: this.#cacheAccessOrder()
    });
    this.#enforceGenerationCacheBounds();
    return { repositoryKey, generation };
  }

  #advanceCacheGeneration(repository: Pick<RepositoryLocator, "installationId" | "repositoryId">): void {
    const now = this.#cacheNow();
    this.#pruneCacheGenerations(now);
    this.#cacheGenerations.set(repositoryCacheKey(repository), {
      generation: this.#cacheGeneration(),
      lastAccessedAt: now,
      lastAccessOrder: this.#cacheAccessOrder()
    });
    this.#enforceGenerationCacheBounds();
  }

  #cacheGenerationIsCurrent(token: CacheGenerationToken): boolean {
    return this.#cacheGenerations.get(token.repositoryKey)?.generation === token.generation;
  }

  #captureInstallationCacheGeneration(installationId: number): InstallationCacheGenerationToken {
    const now = this.#cacheNow();
    this.#pruneCacheGenerations(now);
    const installationKey = installationCacheKey(installationId);
    const current = this.#installationCacheGenerations.get(installationKey);
    const generation = current?.generation ?? this.#cacheGeneration();
    this.#installationCacheGenerations.set(installationKey, {
      generation,
      lastAccessedAt: now,
      lastAccessOrder: this.#cacheAccessOrder()
    });
    this.#enforceInstallationGenerationCacheBounds();
    return { installationKey, generation };
  }

  #advanceInstallationCacheGeneration(installationId: number): void {
    const now = this.#cacheNow();
    this.#pruneCacheGenerations(now);
    this.#installationCacheGenerations.set(installationCacheKey(installationId), {
      generation: this.#cacheGeneration(),
      lastAccessedAt: now,
      lastAccessOrder: this.#cacheAccessOrder()
    });
    this.#enforceInstallationGenerationCacheBounds();
  }

  #installationCacheGenerationIsCurrent(token: InstallationCacheGenerationToken): boolean {
    return this.#installationCacheGenerations.get(token.installationKey)?.generation === token.generation;
  }

  #pruneProjectionCaches(now: number): void {
    for (const [key, entry] of this.#cache) {
      if (cacheEntryIsIdle(entry.lastAccessedAt, now, this.#cachePolicy.idleTtlMs)) this.#cache.delete(key);
    }
    for (const [key, entry] of this.#catalogCache) {
      if (cacheEntryIsIdle(entry.lastAccessedAt, now, this.#cachePolicy.idleTtlMs)) this.#catalogCache.delete(key);
    }
    this.#enforceProjectCacheBounds();
    this.#enforceCatalogCacheBounds();
  }

  #pruneInstallationCache(now: number): void {
    for (const [key, entry] of this.#installationCache) {
      if (cacheEntryIsIdle(entry.lastAccessedAt, now, this.#cachePolicy.idleTtlMs)) this.#installationCache.delete(key);
    }
    this.#enforceInstallationCacheBounds();
  }

  #pruneCacheGenerations(now: number): void {
    for (const [key, entry] of this.#cacheGenerations) {
      if (cacheEntryIsIdle(entry.lastAccessedAt, now, this.#cachePolicy.idleTtlMs)) this.#cacheGenerations.delete(key);
    }
    for (const [key, entry] of this.#installationCacheGenerations) {
      if (cacheEntryIsIdle(entry.lastAccessedAt, now, this.#cachePolicy.idleTtlMs)) this.#installationCacheGenerations.delete(key);
    }
    this.#enforceGenerationCacheBounds();
    this.#enforceInstallationGenerationCacheBounds();
  }

  #enforceProjectCacheBounds(): void {
    let totalBytes = 0;
    for (const entry of this.#cache.values()) totalBytes += entry.sizeBytes;
    if (this.#cache.size <= this.#cachePolicy.maxProjectEntries && totalBytes <= this.#cachePolicy.maxProjectBytes) return;
    const candidates = sortedCacheEntries(this.#cache);
    for (const [key, entry] of candidates) {
      if (this.#cache.size <= this.#cachePolicy.maxProjectEntries && totalBytes <= this.#cachePolicy.maxProjectBytes) break;
      if (this.#cache.delete(key)) totalBytes -= entry.sizeBytes;
    }
  }

  #enforceCatalogCacheBounds(): void {
    let totalBytes = 0;
    for (const entry of this.#catalogCache.values()) totalBytes += entry.sizeBytes;
    if (this.#catalogCache.size <= this.#cachePolicy.maxCatalogEntries && totalBytes <= this.#cachePolicy.maxCatalogBytes) return;
    const candidates = sortedCacheEntries(this.#catalogCache);
    for (const [key, entry] of candidates) {
      if (this.#catalogCache.size <= this.#cachePolicy.maxCatalogEntries && totalBytes <= this.#cachePolicy.maxCatalogBytes) break;
      if (this.#catalogCache.delete(key)) totalBytes -= entry.sizeBytes;
    }
  }

  #enforceInstallationCacheBounds(): void {
    let totalBytes = 0;
    for (const entry of this.#installationCache.values()) totalBytes += entry.sizeBytes;
    if (this.#installationCache.size <= this.#cachePolicy.maxInstallationEntries
      && totalBytes <= this.#cachePolicy.maxInstallationBytes) return;
    const candidates = sortedCacheEntries(this.#installationCache);
    for (const [key, entry] of candidates) {
      if (this.#installationCache.size <= this.#cachePolicy.maxInstallationEntries
        && totalBytes <= this.#cachePolicy.maxInstallationBytes) break;
      if (this.#installationCache.delete(key)) totalBytes -= entry.sizeBytes;
    }
  }

  #enforceGenerationCacheBounds(): void {
    if (this.#cacheGenerations.size <= this.#cachePolicy.maxGenerationEntries) return;
    const candidates = sortedCacheEntries(this.#cacheGenerations);
    for (const [key] of candidates) {
      if (this.#cacheGenerations.size <= this.#cachePolicy.maxGenerationEntries) break;
      this.#cacheGenerations.delete(key);
    }
  }

  #enforceInstallationGenerationCacheBounds(): void {
    if (this.#installationCacheGenerations.size <= this.#cachePolicy.maxGenerationEntries) return;
    const candidates = sortedCacheEntries(this.#installationCacheGenerations);
    for (const [key] of candidates) {
      if (this.#installationCacheGenerations.size <= this.#cachePolicy.maxGenerationEntries) break;
      this.#installationCacheGenerations.delete(key);
    }
  }

  #cacheGeneration(): number {
    const generation = this.#nextCacheGeneration;
    this.#nextCacheGeneration += 1;
    return generation;
  }

  #cacheAccessOrder(): number {
    const order = this.#nextCacheAccessOrder;
    this.#nextCacheAccessOrder += 1;
    return order;
  }

  async #stateHead(repository: RepositoryLocator): Promise<ApiResult<string | undefined>> {
    const result = await this.#transport.readBranchHead(repository, HUNSU_STATE_BRANCH);
    return result.ok ? apiOk(result.value) : transportFailure(result.error);
  }

  async #installationRepositories(installationId: number): Promise<ApiResult<readonly RepositoryGrant[]>> {
    const key = installationCacheKey(installationId);
    const now = this.#cacheNow();
    const cached = this.#getCachedInstallationRepositories(key, now);
    if (cached && installationCacheIsFresh(cached, now, this.#cachePolicy.installationTtlMs)) {
      return apiOk(cached.repositories);
    }

    const generation = this.#captureInstallationCacheGeneration(installationId);
    const inFlight = this.#installationRepositoryFlights.get(key);
    if (inFlight?.generation === generation.generation) return inFlight.promise;

    const promise = this.#fetchInstallationRepositories(installationId, generation);
    this.#installationRepositoryFlights.set(key, { generation: generation.generation, promise });
    try {
      return await promise;
    } finally {
      if (this.#installationRepositoryFlights.get(key)?.promise === promise) {
        this.#installationRepositoryFlights.delete(key);
      }
    }
  }

  async #fetchInstallationRepositories(
    installationId: number,
    generation: InstallationCacheGenerationToken
  ): Promise<ApiResult<readonly RepositoryGrant[]>> {
    const listed = await this.#transport.listInstallationRepositories(installationId);
    if (!listed.ok) return transportFailure(listed.error);
    const repositories = listed.value.map(cloneRepositoryGrant);
    if (this.#installationCacheGenerationIsCurrent(generation)) {
      const cachedAt = this.#cacheNow();
      this.#putCachedInstallationRepositories(
        generation.installationKey,
        cachedInstallationRepositories(installationId, repositories, cachedAt)
      );
    }
    return apiOk(repositories);
  }

  async #authorizedRepositories(context: AuthContext, requestedInstallationId?: number): Promise<ApiResult<RepositoryGrant[]>> {
    const installations = new Map(context.installations.map(item => [item.id, item] as const));
    if (installations.size !== context.installations.length) return forbidden("The GitHub authorization context contains duplicate installations.");
    const installationIds = [...installations.keys()];
    if (requestedInstallationId !== undefined && !installationIds.includes(requestedInstallationId)) {
      return forbidden("The GitHub installation is not authorized for this user.");
    }
    const selected = requestedInstallationId !== undefined
      ? [requestedInstallationId]
      : context.client === "web" && context.selectedInstallationId !== undefined
        ? [context.selectedInstallationId]
        : installationIds;
    const repositories: RepositoryGrant[] = [];
    for (const installationId of selected) {
      const installation = installations.get(installationId);
      if (!installation) return forbidden("The selected GitHub installation is not authorized for this user.");
      const userAccess = new Map(installation.repositories.map(repository => [repository.repositoryId, repository.permissions.contents] as const));
      if (userAccess.size !== installation.repositories.length) {
        return forbidden("The GitHub authorization context contains duplicate repositories.");
      }
      const listed = await this.#installationRepositories(installationId);
      if (!listed.ok) return listed;
      for (const repository of listed.value) {
        const userPermission = userAccess.get(repository.repositoryId);
        if (!userPermission) continue;
        repositories.push({
          ...repository,
          permissions: {
            contents: userPermission === "write" && repository.permissions.contents === "write" ? "write" : "read"
          }
        });
      }
    }
    return apiOk(repositories);
  }

  async #repositoryFromInput(context: AuthContext, input: JsonRecord, requireWrite: boolean): Promise<ApiResult<RepositoryGrant>> {
    const installationId = optionalPositiveInteger(input, "installationId");
    const repositoryId = optionalPositiveInteger(input, "repositoryId");
    if ((installationId === undefined) !== (repositoryId === undefined)) {
      return invalidRequest("installationId and repositoryId must be supplied together when selecting by numeric identity.");
    }
    const repositories = await this.#authorizedRepositories(context, installationId);
    if (!repositories.ok) return repositories;
    const owner = requiredString(input, "owner");
    const name = requiredString(input, "name");
    const matches = repositories.value.filter(item => (repositoryId === undefined || item.repositoryId === repositoryId)
      && item.owner.toLowerCase() === owner.toLowerCase()
      && item.name.toLowerCase() === name.toLowerCase());
    if (matches.length === 0) return forbidden("The repository is not granted to this GitHub App installation.");
    if (matches.length > 1) return conflict("The repository name is ambiguous across authorized GitHub App installations; include installationId and repositoryId.");
    const repository = matches[0];
    if (requireWrite && repository.permissions.contents !== "write") return forbidden("The repository grant does not allow Hunsu state writes.");
    return apiOk(repository);
  }

  async #repositoryByName(context: AuthContext, owner: string, name: string, requireWrite: boolean): Promise<ApiResult<RepositoryGrant>> {
    const repositories = await this.#authorizedRepositories(context);
    if (!repositories.ok) return repositories;
    const matches = repositories.value.filter(item => item.owner.toLowerCase() === owner.toLowerCase() && item.name.toLowerCase() === name.toLowerCase());
    if (matches.length === 0) return forbidden("The repository is not granted to an authorized GitHub App installation.");
    if (matches.length > 1) return conflict("The repository is granted through more than one selected installation.");
    if (requireWrite && matches[0].permissions.contents !== "write") return forbidden("The repository grant does not allow Hunsu state writes.");
    return apiOk(matches[0]);
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }
}

function runContract(repository: RepositoryLocator, run: Run): RunContract {
  const runner = run.runnerSnapshot.kind === "player"
    ? {
        kind: "player" as const,
        id: run.runnerSnapshot.id,
        promptTemplate: run.runnerSnapshot.promptTemplate,
        resources: run.runnerSnapshot.resources.map(resource => resource.type === "skill"
          ? { kind: "skill", name: resource.name, reference: resource.source }
          : { kind: "plugin", name: resource.name, reference: resource.version }),
        runtimePolicy: pluginRuntimePolicy(run.runnerSnapshot.runtimePolicy)
      }
    : {
        kind: "team" as const,
        id: run.runnerSnapshot.id,
        strategy: {
          mode: run.runnerSnapshot.strategy.mode,
          promptTemplate: run.runnerSnapshot.strategy.promptTemplate,
          maxRounds: run.runnerSnapshot.strategy.maxRounds
        },
        players: run.runnerSnapshot.players.map(item => ({
          id: item.player.id,
          role: item.slot.role,
          order: item.slot.order,
          promptTemplate: item.player.promptTemplate,
          resources: item.player.resources.map(resource => resource.type === "skill"
            ? { kind: "skill", name: resource.name, reference: resource.source }
            : { kind: "plugin", name: resource.name, reference: resource.version }),
          runtimePolicy: pluginRuntimePolicy(item.player.runtimePolicy)
        }))
      };
  const toolPolicy = run.runnerSnapshot.kind === "player"
    ? pluginRuntimePolicy(run.runnerSnapshot.runtimePolicy)
    : aggregateTeamRuntimePolicy(run.runnerSnapshot.players.map(item => item.player.runtimePolicy));
  const expiresAt = new Date(Date.parse(run.startedAt) + 4 * 60 * 60 * 1000).toISOString();
  return {
    schema: "hunsu.run-contract.v1",
    runId: run.id,
    projectId: run.projectId,
    goal: {
      id: run.goalSnapshot.id,
      title: run.goalSnapshot.title,
      desiredOutcome: run.goalSnapshot.desiredOutcome,
      acceptanceCriteria: [...run.goalSnapshot.acceptanceCriteria],
      constraints: [...run.goalSnapshot.constraints]
    },
    runner,
    repository: {
      installationId: repository.installationId,
      repositoryId: repository.repositoryId,
      owner: repository.owner,
      name: repository.name,
      baseSha: run.baseSha,
      branch: run.branch
    },
    instructions: run.runnerSnapshot.kind === "player" ? run.runnerSnapshot.promptTemplate : run.runnerSnapshot.strategy.promptTemplate,
    acceptanceCriteria: [...run.goalSnapshot.acceptanceCriteria],
    constraints: [...run.goalSnapshot.constraints],
    requiredEvidence: run.goalSnapshot.acceptanceCriteria.map(criterion => ({
      criterion,
      kind: "check",
      description: `Provide GitHub-verifiable evidence for: ${criterion}`,
      required: true
    })),
    toolPolicy,
    lease: { expiresAt, checkpointAfterSeconds: 900 }
  };
}

function pluginRuntimePolicy(policy: RuntimePolicy): RunContract["toolPolicy"] {
  return {
    filesystem: policy.fileAccess === "project_write" ? "worktree_write" : "read_only",
    network: policy.network === "allowed" ? "enabled" : "disabled",
    approvals: policy.approval === "user" ? "on_request" : "never"
  };
}

function aggregateTeamRuntimePolicy(policies: readonly RuntimePolicy[]): RunContract["toolPolicy"] {
  return {
    filesystem: policies.some(policy => policy.fileAccess === "project_write") ? "worktree_write" : "read_only",
    network: policies.some(policy => policy.network === "allowed") ? "enabled" : "disabled",
    approvals: policies.some(policy => policy.approval === "user") ? "on_request" : "never"
  };
}

function evidenceRef(projectId: string, runId: string, input: EvidenceInput, evidenceId: string, recordedAt: string): EvidenceRef {
  const location: EvidenceRef["location"] = input.url
    ? { type: "url", url: asText(input.url, "evidence.url") }
    : input.sha
      ? { type: "git", commitSha: asGitSha(input.sha), path: asText(".", "evidence.path") }
      : { type: "text", text: asText(input.summary, "evidence.summary") };
  return {
    id: asEvidenceId(evidenceId),
    projectId: asProjectId(projectId),
    runId: asRunId(runId),
    ...(input.criterion ? { criterion: asAcceptanceCriterion(input.criterion, "evidence.criterion") } : {}),
    kind: input.kind === "check" ? "check" : input.kind === "commit" ? "diff" : input.kind === "artifact" ? "report" : "note",
    summary: asEvidenceSummary(input.summary),
    location,
    recordedAt: asTimestamp(recordedAt)
  };
}

function parseEvidence(input: JsonRecord, requireCriterion = false): EvidenceInput {
  const kind = requiredString(input, "kind");
  if (kind !== "check" && kind !== "commit" && kind !== "artifact" && kind !== "observation") {
    throw boundaryInvalid("Evidence kind is invalid.");
  }
  const url = optionalString(input, "url");
  if (url) {
    try { new URL(url); } catch { throw boundaryInvalid("Evidence URL must be absolute."); }
  }
  const sha = optionalString(input, "sha");
  if (sha) asGitSha(sha);
  const criterion = optionalString(input, "criterion");
  if (requireCriterion && !criterion) throw boundaryInvalid("Completion evidence must identify its Goal acceptance criterion.");
  return {
    kind,
    summary: requiredString(input, "summary"),
    ...(url ? { url } : {}),
    ...(sha ? { sha } : {}),
    ...(criterion ? { criterion } : {})
  };
}

function stableEvidence(input: EvidenceInput): JsonRecord {
  return {
    kind: input.kind,
    summary: input.summary,
    ...(input.url ? { url: input.url } : {}),
    ...(input.sha ? { sha: input.sha } : {}),
    ...(input.criterion ? { criterion: input.criterion } : {})
  };
}

function parseResourceBindings(value: unknown): ResourceBinding[] {
  if (!Array.isArray(value)) throw boundaryInvalid("resources must be an array.");
  return value.map((item, index) => {
    const resource = assertRecord(item, `resources[${index}]`);
    const kind = requiredString(resource, "kind");
    if (kind === "skill") return {
      type: "skill",
      name: asResourceName(requiredString(resource, "name")),
      source: asText(requiredString(resource, "reference"), `resources[${index}].reference`)
    };
    if (kind === "plugin") return {
      type: "plugin",
      name: asResourceName(requiredString(resource, "name")),
      version: asText(requiredString(resource, "reference"), `resources[${index}].reference`)
    };
    throw boundaryInvalid(`resources[${index}].kind must be skill or plugin.`);
  });
}

function parseRuntimePolicy(value: JsonRecord): RuntimePolicy {
  const filesystem = requiredString(value, "filesystem");
  const network = requiredString(value, "network");
  const approvals = requiredString(value, "approvals");
  if (filesystem !== "read_only" && filesystem !== "worktree_write") throw boundaryInvalid("runtimePolicy.filesystem is invalid.");
  if (network !== "disabled" && network !== "enabled") throw boundaryInvalid("runtimePolicy.network is invalid.");
  if (approvals !== "never" && approvals !== "on_request") throw boundaryInvalid("runtimePolicy.approvals is invalid.");
  return {
    fileAccess: filesystem === "worktree_write" ? "project_write" : "read_only",
    network: network === "enabled" ? "allowed" : "denied",
    approval: approvals === "on_request" ? "user" : "automatic"
  };
}

function parseGoalPatch(input: JsonRecord): GoalPatch {
  const patch: GoalPatch = {
    ...(optionalString(input, "title") ? { title: asGoalTitle(optionalString(input, "title")!) } : {}),
    ...(optionalString(input, "desiredOutcome") ? { desiredOutcome: asDesiredOutcome(optionalString(input, "desiredOutcome")!) } : {}),
    ...(input.acceptanceCriteria !== undefined ? {
      acceptanceCriteria: asNonEmpty(requiredStringArray(input, "acceptanceCriteria", true).map((value, index) => asAcceptanceCriterion(value, `acceptanceCriteria[${index}]`)), "acceptanceCriteria")
    } : {}),
    ...(input.constraints !== undefined ? { constraints: requiredStringArray(input, "constraints", false).map((value, index) => asGoalConstraint(value, `constraints[${index}]`)) } : {}),
    ...(input.priority !== undefined ? { priority: asNonNegativeInteger(requiredNonNegativeInteger(input, "priority")) } : {})
  };
  if (Object.keys(patch).length === 0) throw boundaryInvalid("A proposed Goal patch must change at least one field.");
  return patch;
}

function automaticCoachFindings(state: ProjectState): string[] {
  const findings: string[] = [];
  const activeWithoutRuns = state.goals.filter(goal => goal.status === "active" && !state.runs.some(run => run.goalId === goal.id));
  if (activeWithoutRuns.length > 0) findings.push(`${activeWithoutRuns.length} active Goal(s) have no Run evidence.`);
  const runningWithoutCheckpoints = state.runs.filter(run => run.status === "running" && run.checkpoints.length === 0);
  if (runningWithoutCheckpoints.length > 0) findings.push(`${runningWithoutCheckpoints.length} Run(s) have not reported a checkpoint.`);
  const openDivergences = state.divergences.filter(divergence => !state.comparisons.some(comparison => comparison.divergenceId === divergence.id));
  if (openDivergences.length > 0) findings.push(`${openDivergences.length} Hunsu divergence(s) still need comparison evidence.`);
  return findings;
}

function projectIdOf(state: ProjectState): string {
  const project = state.projects[0];
  if (!project) throw new Error("Projected state has no Project.");
  return project.id;
}

function cacheKey(repository: Pick<RepositoryLocator, "installationId" | "repositoryId">, projectId: string): string {
  return `${repository.installationId}:${repository.repositoryId}:${projectId}`;
}

function repositoryCacheKey(repository: Pick<RepositoryLocator, "installationId" | "repositoryId">): string {
  return `${repository.installationId}:${repository.repositoryId}`;
}

function installationCacheKey(installationId: number): string {
  return String(installationId);
}

function repositoryLocator(repository: RepositoryLocator): RepositoryLocator {
  return {
    installationId: repository.installationId,
    repositoryId: repository.repositoryId,
    owner: repository.owner,
    name: repository.name,
    defaultBranch: repository.defaultBranch
  };
}

function cachedProject(
  repository: RepositoryLocator,
  state: ProjectState,
  stateHeadSha: string,
  synchronizedAt: string,
  cachedAt: number
): CachedProject {
  const locator = repositoryLocator(repository);
  return {
    repository: locator,
    state,
    stateHeadSha,
    synchronizedAt,
    cachedAt,
    lastAccessedAt: cachedAt,
    lastAccessOrder: 0,
    sizeBytes: encodedCacheSize({ repository: locator, state, stateHeadSha, synchronizedAt })
  };
}

function cachedRepositoryCatalog(
  repository: RepositoryLocator,
  stateHeadSha: string | undefined,
  projectIds: readonly string[],
  synchronizedAt: string,
  cachedAt: number
): CachedRepositoryCatalog {
  const locator = repositoryLocator(repository);
  return {
    repository: locator,
    stateHeadSha,
    projectIds: [...projectIds],
    synchronizedAt,
    cachedAt,
    lastAccessedAt: cachedAt,
    lastAccessOrder: 0,
    sizeBytes: encodedCacheSize({ repository: locator, stateHeadSha, projectIds, synchronizedAt })
  };
}

function cachedInstallationRepositories(
  installationId: number,
  repositories: readonly RepositoryGrant[],
  cachedAt: number
): CachedInstallationRepositories {
  const grants = repositories.map(cloneRepositoryGrant);
  return {
    installationId,
    repositories: grants,
    cachedAt,
    lastAccessedAt: cachedAt,
    lastAccessOrder: 0,
    sizeBytes: encodedCacheSize({ installationId, repositories: grants })
  };
}

function cloneRepositoryGrant(repository: RepositoryGrant): RepositoryGrant {
  return {
    installationId: repository.installationId,
    repositoryId: repository.repositoryId,
    owner: repository.owner,
    name: repository.name,
    defaultBranch: repository.defaultBranch,
    private: repository.private,
    permissions: { contents: repository.permissions.contents }
  };
}

function authorizeProject(entry: CachedProject, repository: RepositoryGrant): AuthorizedProject {
  return {
    repository,
    state: entry.state,
    stateHeadSha: entry.stateHeadSha,
    synchronizedAt: entry.synchronizedAt,
    cachedAt: entry.cachedAt
  };
}

function cacheIsFresh(entry: { cachedAt: number }, now: number): boolean {
  const age = now - entry.cachedAt;
  return age >= 0 && age < PROJECTION_CACHE_TTL_MS;
}

function installationCacheIsFresh(entry: { cachedAt: number }, now: number, ttlMs: number): boolean {
  const age = now - entry.cachedAt;
  return age >= 0 && age < ttlMs;
}

function projectionCachePolicy(overrides: Partial<ProjectionCachePolicy> | undefined): ProjectionCachePolicy {
  const policy = { ...DEFAULT_PROJECTION_CACHE_POLICY, ...overrides };
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return policy;
}

function encodedCacheSize(value: unknown): number {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? 0 : UTF8_ENCODER.encode(serialized).byteLength;
}

function cacheEntryIsIdle(lastAccessedAt: number, now: number, idleTtlMs: number): boolean {
  const idleFor = now - lastAccessedAt;
  return idleFor < 0 || idleFor >= idleTtlMs;
}

function sortedCacheEntries<T extends { lastAccessOrder: number }>(cache: Map<string, T>): Array<[string, T]> {
  return [...cache.entries()].sort(([leftKey, left], [rightKey, right]) =>
    left.lastAccessOrder - right.lastAccessOrder || (leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0));
}

function projectionContext(entry: Pick<AuthorizedProject, "repository" | "stateHeadSha" | "synchronizedAt">): ProjectionContext {
  return {
    health: {
      repositoryAccess: entry.repository.permissions.contents === "read" ? "read_only" : "healthy",
      stateRef: "healthy",
      stateRefName: HUNSU_STATE_BRANCH,
      stateHeadSha: entry.stateHeadSha,
      projection: "current",
      synchronizedAt: entry.synchronizedAt
    }
  };
}

function commandMetadata(rawIdempotencyKey: string, semantic: unknown, index: number, at: string, actor: DomainActor): CommandMetadata {
  return {
    eventId: unwrap(makeEventId(hashHex(`event:${rawIdempotencyKey}:${canonicalJson(semantic)}:${index}`).slice(0, 32))),
    idempotencyKey: unwrap(makeIdempotencyKey(hashHex(`domain-idempotency:${rawIdempotencyKey}:${index}`))),
    fingerprint: unwrap(makeCommandFingerprint(hashHex(`domain-fingerprint:${canonicalJson(semantic)}:${index}`))),
    actor,
    requestedAt: asTimestamp(at)
  };
}

function requestActor(context: AuthContext): DomainActor {
  return context.client === "mcp"
    ? pluginActor(context)
    : userActor(context);
}

function pluginActor(context: AuthContext): DomainActor & { type: "plugin" } {
  return { type: "plugin", id: asText(`mcp:${context.user.id}`) };
}

function userActor(context: AuthContext): DomainActor & { type: "user" } {
  return { type: "user", id: asText(context.user.id, "user.id") };
}

function withActor(meta: CommandMetadata, actor: DomainActor): CommandMetadata {
  return { ...meta, actor };
}

function stateActor(context: AuthContext): StateActor {
  return context.client === "mcp"
    ? { kind: "plugin", userId: context.user.id, clientId: "hunsu-mcp" }
    : { kind: "user", id: context.user.id };
}

function generatedId(prefix: string, idempotencyKey: string): string {
  const normalized = prefix.toLowerCase().replace(/[^a-z0-9-]/gu, "-").replace(/-+/gu, "-").replace(/^-|-$/gu, "") || "id";
  return `${normalized}-${hashHex(idempotencyKey).slice(0, 16)}`;
}

function hashHex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeRef(value: string): string {
  const ref = value.startsWith("refs/heads/") ? value : `refs/heads/${value}`;
  asGitRef(ref);
  return ref;
}

function strategyMode(value: string): Team["strategy"]["mode"] {
  if (value === "sequence" || value === "parallel" || value === "coordinated") return value;
  throw boundaryInvalid("Team strategy mode must be sequence, parallel, or coordinated.");
}

function priorityNumber(value: unknown): number {
  if (value === "low") return 10;
  if (value === "normal") return 50;
  if (value === "high") return 70;
  if (value === "urgent") return 100;
  if (Number.isSafeInteger(value) && Number(value) >= 0) return Number(value);
  throw boundaryInvalid("Goal priority is invalid.");
}

function requestIdempotency(input: JsonRecord): string {
  return requiredString(input, "idempotencyKey");
}

function toolMutation<T>(
  result: ApiResult<MutationResult<T> | { state: ProjectState; stateHeadSha: string; synchronizedAt: string; value: unknown }>,
  data?: unknown
): ApiResult<{ data: unknown; stateHeadSha: string }> {
  if (!result.ok) return result;
  return apiOk({ data: data ?? result.value.value, stateHeadSha: result.value.stateHeadSha });
}

function projectionFailure<T>(result: ProjectionResult<T>): ApiResult<never> {
  return result.ok ? apiFailure({ code: "temporarily_unavailable", message: "Projection failed unexpectedly.", status: 503, retryable: true }) : notFound(result.error.message);
}

function storeFailure(error: StoreError): ApiResult<never> {
  if (error.code === "stale_state") {
    return apiFailure({
      code: "stale_state",
      message: error.message,
      status: 412,
      retryable: true,
      ...(error.expectedHeadSha ? { expectedStateSha: error.expectedHeadSha } : {}),
      ...(error.actualHeadSha ? { actualStateSha: error.actualHeadSha } : {})
    });
  }
  if (error.code === "idempotency_conflict") return conflict(error.message);
  if (error.code === "state_not_found" || error.code === "project_not_found") return notFound(error.message);
  if (error.code === "unsafe_state") return invalidRequest(error.message);
  if (error.code === "invalid_event" && error.message.startsWith("DOMAIN:")) {
    const [, code, ...messageParts] = error.message.split(":");
    const message = messageParts.join(":");
    if (code === "USER_CONFIRMATION_REQUIRED") return apiFailure({ code: "confirmation_required", message, status: 409, retryable: false });
    if (code === "INVALID_TRANSITION" || code === "DUPLICATE_ID" || code === "IDEMPOTENCY_CONFLICT") return conflict(message);
    if (code === "NOT_FOUND") return notFound(message);
    return invalidRequest(message);
  }
  if (error.code === "transport" && error.cause) return transportFailure(error.cause);
  return apiFailure({ code: error.code === "invalid_event" ? "invalid_request" : "temporarily_unavailable", message: error.message, status: error.code === "invalid_event" ? 400 : 503, retryable: error.code !== "invalid_event" });
}

function transportFailure(error: GitHubTransportError): ApiResult<never> {
  if (error.code === "forbidden") {
    return apiFailure({
      code: "forbidden",
      message: error.message,
      status: 403,
      retryable: false,
      ...(error.requestId === undefined ? {} : { requestId: error.requestId })
    });
  }
  if (error.code === "rate_limited") {
    const retryAfterSeconds = Number.isSafeInteger(error.retryAfterSeconds) && (error.retryAfterSeconds ?? 0) > 0
      ? error.retryAfterSeconds!
      : 60;
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
    ...(error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
    ...(error.requestId !== undefined ? { requestId: error.requestId } : {}),
    ...(error.expectedStateSha ? { expectedStateSha: error.expectedStateSha } : {}),
    ...(error.actualStateSha ? { actualStateSha: error.actualStateSha } : {}),
    recovery: error.retryAfterSeconds !== undefined
      ? `Wait at least ${error.retryAfterSeconds} seconds before retrying. Continuing during the GitHub rate-limit window can extend the outage.`
      : error.retryable
        ? "Reload the Project state and retry with the new state SHA."
        : undefined
  };
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

function boundaryInvalid(message: string): BoundaryError {
  return new BoundaryError({ code: "invalid_request", message, status: 400, retryable: false });
}

function boundaryNotFound(message: string): BoundaryError {
  return new BoundaryError({ code: "not_found", message, status: 404, retryable: false });
}

function assertRecord(value: unknown, field: string): JsonRecord {
  if (!isRecord(value)) throw boundaryInvalid(`${field} must be an object.`);
  return value;
}

function record(input: JsonRecord, field: string): JsonRecord {
  return assertRecord(input[field], field);
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

function requiredPositiveInteger(input: JsonRecord, field: string): number {
  const value = input[field];
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw boundaryInvalid(`${field} must be a positive integer.`);
  return Number(value);
}

function requiredNonNegativeInteger(input: JsonRecord, field: string): number {
  const value = input[field];
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw boundaryInvalid(`${field} must be a non-negative integer.`);
  return Number(value);
}

function optionalNonNegativeInteger(input: JsonRecord, field: string): number | undefined {
  return input[field] === undefined ? undefined : requiredNonNegativeInteger(input, field);
}

function optionalPositiveInteger(input: JsonRecord, field: string): number | undefined {
  return input[field] === undefined ? undefined : requiredPositiveInteger(input, field);
}

function array(input: JsonRecord, field: string, nonEmpty: boolean): unknown[] {
  const value = input[field];
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) throw boundaryInvalid(`${field} must be ${nonEmpty ? "a non-empty" : "an"} array.`);
  return value;
}

function requiredStringArray(input: JsonRecord, field: string, nonEmpty: boolean): string[] {
  return array(input, field, nonEmpty).map((value, index) => {
    if (typeof value !== "string" || value.trim() === "") throw boundaryInvalid(`${field}[${index}] must be non-empty text.`);
    return value;
  });
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw boundaryInvalid(result.error.message);
  return result.value;
}

function asProjectId(value: string) { return unwrap(makeProjectId(value)); }
function asGoalId(value: string) { return unwrap(makeGoalId(value)); }
function asRunnerId(value: string) { return unwrap(makeRunnerId(value)); }
function asCoachId(value: string) { return unwrap(makeCoachId(value)); }
function asRunId(value: string) { return unwrap(makeRunId(value)); }
function asWorkspaceId(value: string) { return unwrap(makeWorkspaceId(value)); }
function asEvidenceId(value: string) { return unwrap(makeEvidenceId(value)); }
function asCheckpointId(value: string) { return unwrap(makeCheckpointId(value)); }
function asCoachReviewId(value: string) { return unwrap(makeCoachReviewId(value)); }
function asCoachProposalId(value: string) { return unwrap(makeCoachProposalId(value)); }
function asDivergenceId(value: string) { return unwrap(makeDivergenceId(value)); }
function asComparisonId(value: string) { return unwrap(makeComparisonId(value)); }
function asDecisionId(value: string) { return unwrap(makeDecisionId(value)); }
function asGitSha(value: string) { return unwrap(makeGitCommitSha(value)); }
function asGitRef(value: string) { return unwrap(makeGitRef(value)); }
function asGitBranch(value: string) { return unwrap(makeGitBranchName(value)); }
function asRepositoryOwner(value: string) { return unwrap(makeRepositoryOwner(value)); }
function asRepositoryName(value: string) { return unwrap(makeRepositoryName(value)); }
function asTimestamp(value: string) { return unwrap(makeIsoTimestamp(value)); }
function asText(value: string, field?: string) { return unwrap(makeNonEmptyText(value, field)); }
function asProjectTitle(value: string) { return unwrap(makeProjectTitle(value)); }
function asProjectObjective(value: string) { return unwrap(makeProjectObjective(value)); }
function asGoalTitle(value: string) { return unwrap(makeGoalTitle(value)); }
function asDesiredOutcome(value: string) { return unwrap(makeDesiredOutcome(value)); }
function asAcceptanceCriterion(value: string, field?: string) { return unwrap(makeAcceptanceCriterion(value, field)); }
function asGoalConstraint(value: string, field?: string) { return unwrap(makeGoalConstraint(value, field)); }
function asPromptTemplate(value: string) { return unwrap(makePromptTemplate(value)); }
function asEvidenceSummary(value: string) { return unwrap(makeEvidenceSummary(value)); }
function asResourceName(value: string) { return unwrap(makeResourceName(value)); }
function asReason(value: string) { return unwrap(makeReason(value)); }
function asPositiveInteger(value: number) { return unwrap(makePositiveInteger(value)); }
function asNonNegativeInteger(value: number) { return unwrap(makeNonNegativeInteger(value)); }
function asNonEmpty<T>(value: T[], field: string) { return unwrap(makeNonEmptyArray(value, field)); }
