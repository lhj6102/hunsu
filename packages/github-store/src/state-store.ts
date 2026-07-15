import { canonicalJson, sha256 } from "./canonical-json.ts";
import type {
  AppendProjectCommand,
  AppendProjectResult,
  BranchSnapshot,
  GitHubTransport,
  ProjectStateCodec,
  ReconstructedProject,
  ReconstructedRepository,
  RepositoryLocator,
  StateActor,
  StoreError,
  StoredProjectEvent,
  StoreResult
} from "./types.ts";
import { HUNSU_STATE_BRANCH } from "./types.ts";

const STATE_ROOT = ".hunsu/v2";
const EVENT_SCHEMA = "hunsu.project-event.v2";
const FULL_SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const NODE_PLAN_DIGEST = /^hunsu-node-plan-v1:sha256:[0-9a-f]{64}$/u;
const STORED_EVENT_ID = /^[0-9a-f]{32}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const RUN_BRANCH = /^hunsu\/run\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/([0-9a-f]{40})\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/u;
const STATE_BRANCH_VISIBILITY_DELAYS_MS = [0, 50, 150] as const;
const STORED_EVENT_KEYS = [
  "schema",
  "eventId",
  "projectId",
  "repository",
  "idempotencyKeyHash",
  "commandHash",
  "previousStateSha",
  "commandEventCount",
  "sequence",
  "actor",
  "occurredAt",
  "event"
] as const;
const STORED_REPOSITORY_KEYS = ["installationId", "repositoryId", "owner", "name"] as const;
const USER_ACTOR_KEYS = ["kind", "id"] as const;
const PLUGIN_ACTOR_KEYS = ["kind", "userId", "clientId"] as const;
const SYSTEM_ACTOR_KEYS = ["kind", "operation"] as const;

export class GitHubProjectStore<Event, State> {
  readonly #transport: GitHubTransport;
  readonly #codec: ProjectStateCodec<Event, State>;
  readonly #wait: (delayMs: number) => Promise<void>;

  constructor(
    transport: GitHubTransport,
    codec: ProjectStateCodec<Event, State>,
    options: { wait?: (delayMs: number) => Promise<void> } = {}
  ) {
    this.#transport = transport;
    this.#codec = codec;
    this.#wait = options.wait ?? (delayMs => new Promise(resolve => setTimeout(resolve, delayMs)));
  }

  async readProject(repository: RepositoryLocator, projectId: string): Promise<StoreResult<ReconstructedProject<State, Event>>> {
    const branch = await this.#transport.readBranch(repository, HUNSU_STATE_BRANCH);
    if (!branch.ok) return transportFailure(branch.error);
    if (!branch.value) return failure({ code: "state_not_found", message: `Repository ${repository.owner}/${repository.name} has no Hunsu state branch.` });
    return await this.#reconstructProject(branch.value, repository, projectId);
  }

  async reconstructRepository(repository: RepositoryLocator): Promise<StoreResult<ReconstructedRepository<State, Event>>> {
    const branch = await this.#transport.readBranch(repository, HUNSU_STATE_BRANCH);
    if (!branch.ok) return transportFailure(branch.error);
    if (!branch.value) return ok({ kind: "state_branch_missing", projects: [] });
    const projectIds = projectIdsFromFiles(branch.value.files);
    const projects: ReconstructedProject<State, Event>[] = [];
    for (const projectId of projectIds) {
      const project = await this.#reconstructProject(branch.value, repository, projectId);
      if (!project.ok) return project;
      projects.push(project.value);
    }
    return ok({ kind: "state_branch", stateHeadSha: branch.value.headSha, projects });
  }

  async append(command: AppendProjectCommand<Event, State>): Promise<StoreResult<AppendProjectResult<State>>> {
    const inputValidation = validateAppendInput(command);
    if (!inputValidation.ok) return inputValidation;
    const safeCommand = ensureSafeValue(command.command, "command");
    if (!safeCommand.ok) return safeCommand;

    const branchResult = await this.#transport.readBranch(command.repository, HUNSU_STATE_BRANCH);
    if (!branchResult.ok) return transportFailure(branchResult.error);
    let branch = branchResult.value;
    if (!branch) {
      // Bootstrap is itself part of the CAS boundary. A stale caller must not
      // create hunsu/state and only then discover that its confirmed head was
      // wrong.
      if (command.expectedHeadSha !== command.baseSha) {
        return failure({
          code: "stale_state",
          message: "The repository default branch changed before Hunsu v2 initialization.",
          expectedHeadSha: command.expectedHeadSha,
          actualHeadSha: command.baseSha
        });
      }
      const created = await this.#transport.createBranch(command.repository, HUNSU_STATE_BRANCH, command.baseSha);
      if (!created.ok && created.error.code !== "conflict") return transportFailure(created.error);
      if (created.ok) {
        branch = created.value;
      } else {
        const concurrentBranch = await this.#readConcurrentStateBranch(command.repository);
        if (!concurrentBranch.ok) return concurrentBranch;
        branch = concurrentBranch.value;
      }
    }
    const decoded = this.#decodeStoredEvents(branch.files, command.repository, command.projectId);
    if (!decoded.ok) return decoded;

    const idempotencyKeyHash = sha256(command.idempotencyKey);
    const commandHash = sha256(canonicalJson(command.command));
    const replay = decoded.value.find(entry => entry.idempotencyKeyHash === idempotencyKeyHash);
    if (replay) {
      if (replay.commandHash !== commandHash) {
        return failure({ code: "idempotency_conflict", message: "The idempotency key was already used for a different command." });
      }
      const reconstructed = this.#replay(decoded.value);
      if (!reconstructed.ok) return reconstructed;
      return ok({ state: reconstructed.value, stateHeadSha: branch.headSha, idempotentReplay: true });
    }

    if (command.expectedHeadSha !== branch.headSha) {
      return failure({
        code: "stale_state",
        message: "Project state changed since it was loaded.",
        expectedHeadSha: command.expectedHeadSha,
        actualHeadSha: branch.headSha
      });
    }

    const current = decoded.value.length === 0 ? ok<State | undefined>(undefined) : this.#replay(decoded.value);
    if (!current.ok) return current;
    const decision = command.decide(current.value);
    if (!decision.ok) return decision;
    if (decision.value.length === 0) return failure({ code: "invalid_event", message: "A mutation must emit at least one event." });

    const stored = decision.value.map((event, index): StoredProjectEvent<Event> => ({
      schema: EVENT_SCHEMA,
      eventId: storedEventId(command.projectId, idempotencyKeyHash, commandHash, index),
      projectId: command.projectId,
      repository: {
        installationId: command.repository.installationId,
        repositoryId: command.repository.repositoryId,
        owner: command.repository.owner,
        name: command.repository.name
      },
      idempotencyKeyHash,
      commandHash,
      previousStateSha: branch.headSha,
      commandEventCount: decision.value.length,
      sequence: decoded.value.length + index + 1,
      actor: structuredClone(command.actor),
      occurredAt: command.occurredAt,
      event
    }));
    const encodedEvents: unknown[] = [];
    for (const entry of stored) {
      const encoded = this.#codec.encodeEvent(entry.event);
      if (!encoded.ok) return encoded;
      const safeEvent = ensureSafeValue(encoded.value, "event");
      if (!safeEvent.ok) return safeEvent;
      encodedEvents.push(encoded.value);
    }

    const allEvents = [...decoded.value, ...stored];
    const next = this.#replay(allEvents);
    if (!next.ok) return next;
    if (this.#codec.projectId(next.value) !== command.projectId) {
      return failure({ code: "invalid_event", message: "Projected Project identity does not match the command." });
    }
    const materialized = this.#codec.materialize(next.value, allEvents);
    if (!materialized.ok) return materialized;
    const safeMaterialized = ensureSafeValue(materialized.value, "materialized state");
    if (!safeMaterialized.ok) return safeMaterialized;

    const updates = [];
    for (const [index, entry] of stored.entries()) {
      const path = eventPath(entry);
      if (branch.files[path] !== undefined) return failure({ code: "invalid_event", message: `Event path ${path} already exists.` });
      updates.push({ path, content: `${canonicalJson({ ...entry, event: encodedEvents[index] })}\n` });
    }
    const prefix = projectRoot(command.projectId);
    for (const [relativePath, value] of Object.entries(materialized.value)) {
      const pathValidation = safeMaterializedPath(relativePath);
      if (!pathValidation.ok) return pathValidation;
      updates.push({ path: `${prefix}/${relativePath}`, content: `${canonicalJson(value)}\n` });
    }
    const knownProjectIds = new Set([...projectIdsFromFiles(branch.files), command.projectId]);
    updates.push({
      path: `${STATE_ROOT}/workspace.json`,
      content: `${canonicalJson({
        schema: "hunsu.workspace.v2",
        installationId: command.repository.installationId,
        repositoryId: command.repository.repositoryId,
        repository: `${command.repository.owner}/${command.repository.name}`,
        projectIds: [...knownProjectIds].sort()
      })}\n`
    });

    const committed = await this.#transport.commitFiles({
      repository: command.repository,
      branch: HUNSU_STATE_BRANCH,
      expectedHeadSha: branch.headSha,
      message: `Hunsu project state ${command.projectId}`,
      updates
    });
    if (!committed.ok) {
      if (committed.error.code === "conflict") {
        const actual = await this.#transport.readBranch(command.repository, HUNSU_STATE_BRANCH);
        return failure({
          code: "stale_state",
          message: "A concurrent Project mutation advanced the state branch.",
          expectedHeadSha: branch.headSha,
          actualHeadSha: actual.ok ? actual.value?.headSha : undefined,
          cause: committed.error
        });
      }
      return transportFailure(committed.error);
    }
    return ok({ state: next.value, stateHeadSha: committed.value, idempotentReplay: false });
  }

  async #readConcurrentStateBranch(repository: RepositoryLocator): Promise<StoreResult<BranchSnapshot>> {
    for (const delayMs of STATE_BRANCH_VISIBILITY_DELAYS_MS) {
      if (delayMs > 0) await this.#wait(delayMs);
      const branch = await this.#transport.readBranch(repository, HUNSU_STATE_BRANCH);
      if (!branch.ok) return transportFailure(branch.error);
      if (branch.value) return ok(branch.value);
    }
    return transportFailure({
      code: "not_found",
      message: "The concurrently created Hunsu state branch is not yet visible."
    });
  }

  async createRunBranch(input: {
    repository: RepositoryLocator;
    projectId: string;
    sourceNodeSha: string;
    runId: string;
  }): Promise<StoreResult<string>> {
    for (const [label, value] of [["Project", input.projectId], ["Run", input.runId]] as const) {
      if (!SAFE_ID.test(value)) return failure({ code: "invalid_event", message: `${label} id is not safe for a Git branch.` });
    }
    if (!FULL_SHA.test(input.sourceNodeSha)) return failure({ code: "invalid_event", message: "Run source Node SHA must be a full lowercase Git SHA." });
    const branch = `hunsu/run/${input.projectId}/${input.sourceNodeSha}/${input.runId}`;
    const existing = await this.#transport.readBranch(input.repository, branch);
    if (!existing.ok) return transportFailure(existing.error);
    if (existing.value) return this.#verifyRunBranchBase(input.repository, branch, input.sourceNodeSha, existing.value.headSha);
    const created = await this.#transport.createBranch(input.repository, branch, input.sourceNodeSha);
    if (created.ok) {
      return created.value.headSha === input.sourceNodeSha
        ? ok(branch)
        : failure({ code: "integrity", message: `Created Run branch ${branch} did not start at its source Node.` });
    }
    if (created.error.code !== "conflict") return transportFailure(created.error);
    const raced = await this.#transport.readBranch(input.repository, branch);
    if (!raced.ok) return transportFailure(raced.error);
    return raced.value
      ? this.#verifyRunBranchBase(input.repository, branch, input.sourceNodeSha, raced.value.headSha)
      : transportFailure(created.error);
  }

  async #verifyRunBranchBase(
    repository: RepositoryLocator,
    branch: string,
    sourceNodeSha: string,
    branchHeadSha: string
  ): Promise<StoreResult<string>> {
    const relationship = await this.#transport.compareCommits(repository, sourceNodeSha, branchHeadSha);
    if (!relationship.ok) return transportFailure(relationship.error);
    return relationship.value === "ahead" || relationship.value === "identical"
      ? ok(branch)
      : failure({ code: "stale_state", message: `Run branch ${branch} does not descend from the expected base commit.` });
  }

  async anchorNode(input: {
    repository: RepositoryLocator;
    projectId: string;
    nodeSha: string;
  }): Promise<StoreResult<string>> {
    if (!SAFE_ID.test(input.projectId) || !FULL_SHA.test(input.nodeSha)) {
      return failure({ code: "invalid_event", message: "Node anchoring requires a safe Project id and full lowercase Git SHA." });
    }
    const exists = await this.#transport.commitExists(input.repository, input.nodeSha);
    if (!exists.ok) return transportFailure(exists.error);
    if (!exists.value) return failure({ code: "integrity", message: `Node commit ${input.nodeSha} does not exist.` });
    const ref = nodeTagRef(input.projectId, input.nodeSha);
    const current = await this.#transport.readRef(input.repository, ref);
    if (!current.ok) return transportFailure(current.error);
    if (current.value !== undefined) {
      return current.value === input.nodeSha
        ? ok(ref)
        : failure({ code: "integrity", message: `Managed Node ref ${ref} points to an unexpected commit.` });
    }
    const created = await this.#transport.createRef(input.repository, ref, input.nodeSha);
    if (created.ok) return ok(ref);
    if (created.error.code !== "conflict") return transportFailure(created.error);
    const raced = await this.#transport.readRef(input.repository, ref);
    if (!raced.ok) return transportFailure(raced.error);
    return raced.value === input.nodeSha
      ? ok(ref)
      : failure({ code: "integrity", message: `Managed Node ref ${ref} was concurrently created for another commit.` });
  }

  async createCoachingNode(input: {
    repository: RepositoryLocator;
    projectId: string;
    sourceSha: string;
    proposalId: string;
    planDigest: string;
    proposedAt: string;
  }): Promise<StoreResult<{ nodeSha: string; treeSha: string; anchorRef: string; commitMessage: string; commitTitle: string }>> {
    if (!SAFE_ID.test(input.projectId) || !SAFE_ID.test(input.proposalId) || !FULL_SHA.test(input.sourceSha) || !NODE_PLAN_DIGEST.test(input.planDigest)) {
      return failure({ code: "invalid_event", message: "Coaching Node creation received an invalid identity or digest." });
    }
    if (!isCanonicalTimestamp(input.proposedAt)) {
      return failure({ code: "invalid_event", message: "Coaching Node creation requires a canonical proposal timestamp." });
    }
    const source = await this.#transport.readCommit(input.repository, input.sourceSha);
    if (!source.ok) return transportFailure(source.error);
    if (!source.value) return failure({ code: "integrity", message: `Coaching source commit ${input.sourceSha} does not exist.` });
    const message = `Hunsu coaching ${input.projectId}/${input.proposalId}\n\nNode-Plan-Digest: ${input.planDigest}`;
    const created = await this.#transport.createCommit({
      repository: input.repository,
      parentSha: input.sourceSha,
      treeSha: source.value.treeSha,
      message,
      timestamp: input.proposedAt
    });
    if (!created.ok) return transportFailure(created.error);
    if (created.value.parentShas.length !== 1
      || created.value.parentShas[0] !== input.sourceSha
      || created.value.treeSha !== source.value.treeSha
      || created.value.message !== message
    ) {
      return failure({ code: "integrity", message: "GitHub created a Coaching commit that does not preserve the required parent, tree, and metadata." });
    }
    const anchored = await this.anchorNode({
      repository: input.repository,
      projectId: input.projectId,
      nodeSha: created.value.sha
    });
    return anchored.ok
      ? ok({
          nodeSha: created.value.sha,
          treeSha: created.value.treeSha,
          anchorRef: anchored.value,
          commitMessage: created.value.message,
          commitTitle: commitTitle(created.value.message)
        })
      : anchored;
  }

  async verifyRunResult(input: {
    repository: RepositoryLocator;
    branch: string;
    baseSha: string;
    resultSha: string;
  }): Promise<StoreResult<{ branchHeadSha: string; resultSha: string }>> {
    const branchIdentity = input.branch.match(RUN_BRANCH);
    if (!branchIdentity || branchIdentity[2] !== input.baseSha || !FULL_SHA.test(input.baseSha) || !FULL_SHA.test(input.resultSha)) {
      return failure({ code: "invalid_event", message: "Run verification requires the expected branch and full lowercase Git SHAs." });
    }
    if (input.baseSha === input.resultSha) {
      return failure({ code: "invalid_event", message: "A completed Run must create a result commit distinct from its source Node." });
    }
    const branch = await this.#transport.readBranch(input.repository, input.branch);
    if (!branch.ok) return transportFailure(branch.error);
    if (!branch.value) return failure({ code: "state_not_found", message: `Run branch ${input.branch} does not exist.` });
    const exists = await this.#transport.commitExists(input.repository, input.resultSha);
    if (!exists.ok) return transportFailure(exists.error);
    if (!exists.value) return failure({ code: "invalid_event", message: "Reported result commit does not exist in the Project repository." });
    const baseToResult = await this.#transport.compareCommits(input.repository, input.baseSha, input.resultSha);
    if (!baseToResult.ok) return transportFailure(baseToResult.error);
    if (baseToResult.value !== "ahead" && baseToResult.value !== "identical") {
      return failure({ code: "invalid_event", message: "Reported result does not descend from the Run base SHA." });
    }
    const resultToHead = await this.#transport.compareCommits(input.repository, input.resultSha, branch.value.headSha);
    if (!resultToHead.ok) return transportFailure(resultToHead.error);
    if (resultToHead.value !== "ahead" && resultToHead.value !== "identical") {
      return failure({ code: "invalid_event", message: "Reported result is not reachable from the expected Run branch." });
    }
    return ok({ branchHeadSha: branch.value.headSha, resultSha: input.resultSha });
  }

  async #reconstructProject(
    branch: BranchSnapshot,
    repository: RepositoryLocator,
    projectId: string
  ): Promise<StoreResult<ReconstructedProject<State, Event>>> {
    const decoded = this.#decodeStoredEvents(branch.files, repository, projectId);
    if (!decoded.ok) return decoded;
    if (decoded.value.length === 0) return failure({ code: "project_not_found", message: `Project ${projectId} was not found in GitHub state.` });
    const state = this.#replay(decoded.value);
    if (!state.ok) return state;
    const anchors = await this.#verifyNodeAnchors(repository, projectId, state.value);
    return anchors.ok
      ? ok({ state: state.value, stateHeadSha: branch.headSha, eventCount: decoded.value.length, events: decoded.value })
      : anchors;
  }

  async #verifyNodeAnchors(repository: RepositoryLocator, projectId: string, state: State): Promise<StoreResult<void>> {
    const listed = await this.#transport.listManagedNodeAnchors(repository, projectId);
    if (!listed.ok) return transportFailure(listed.error);
    const actualByRef = new Map(listed.value.map(anchor => [anchor.managedRef, anchor]));
    if (actualByRef.size !== listed.value.length) {
      return failure({ code: "integrity", message: `Project ${projectId} contains duplicate managed Node refs.` });
    }
    const expected = this.#codec.nodeAnchors(state);
    const seen = new Set<string>();
    for (const anchor of expected) {
      if (anchor.projectId !== projectId
        || !FULL_SHA.test(anchor.nodeSha)
        || !FULL_SHA.test(anchor.treeSha)
        || anchor.managedRef !== nodeTagRef(projectId, anchor.nodeSha)
        || !anchor.commitTitle.trim()
        || seen.has(anchor.nodeSha)
      ) {
        return failure({ code: "integrity", message: `Project ${projectId} contains an invalid or duplicate Node anchor.` });
      }
      seen.add(anchor.nodeSha);
      const actual = actualByRef.get(anchor.managedRef);
      if (!actual || actual.nodeSha !== anchor.nodeSha) {
        return failure({ code: "integrity", message: `Managed Node ref ${anchor.managedRef} is missing or points to another commit.` });
      }
      if (actual.treeSha !== anchor.treeSha) {
        return failure({ code: "integrity", message: `Node commit ${anchor.nodeSha} is missing or has an unexpected tree SHA.` });
      }
      if (commitTitle(actual.commitMessage) !== anchor.commitTitle) {
        return failure({ code: "integrity", message: `Node commit ${anchor.nodeSha} has an unexpected commit title.` });
      }
    }
    return ok(undefined);
  }

  #decodeStoredEvents(
    files: Readonly<Record<string, string>>,
    repository: RepositoryLocator,
    projectId: string
  ): StoreResult<StoredProjectEvent<Event>[]> {
    const prefix = `${projectRoot(projectId)}/events/`;
    const events: StoredProjectEvent<Event>[] = [];
    for (const path of Object.keys(files).filter(path => {
      if (!path.startsWith(prefix)) return false;
      return /^\d{4}\/\d{2}\/[0-9a-f]{32}\.json$/u.test(path.slice(prefix.length));
    }).sort()) {
      let input: unknown;
      try {
        input = JSON.parse(files[path]);
      } catch {
        return failure({ code: "invalid_event", message: `Event file ${path} is not valid JSON.` });
      }
      const envelope = decodeStoredProjectEventEnvelope(input, this.#codec);
      if (!envelope.ok) return envelope;
      if (envelope.value.projectId !== projectId) return failure({ code: "invalid_event", message: `Event file ${path} has the wrong Project id.` });
      if (!sameRepository(envelope.value.repository, repository)) {
        return failure({ code: "invalid_event", message: `Event file ${path} belongs to a different GitHub repository.` });
      }
      if (eventPath(envelope.value) !== path) {
        return failure({ code: "invalid_event", message: `Event file ${path} does not match its envelope path.` });
      }
      events.push(envelope.value);
    }
    events.sort((left, right) => left.sequence - right.sequence || left.eventId.localeCompare(right.eventId));
    for (let index = 0; index < events.length; index += 1) {
      if (events[index].sequence !== index + 1) return failure({ code: "invalid_event", message: `Project ${projectId} has a non-contiguous event sequence.` });
    }
    const batches = validateCommandBatches(events, projectId);
    return batches.ok ? ok(events) : batches;
  }

  #replay(events: readonly StoredProjectEvent<Event>[]): StoreResult<State> {
    return this.#codec.replay(events.map(entry => entry.event));
  }
}

/** Strictly decode one authoritative event file without replaying its Project stream. */
export function decodeStoredProjectEventEnvelope<Event, State>(
  input: unknown,
  codec: ProjectStateCodec<Event, State>
): StoreResult<StoredProjectEvent<Event>> {
  if (!isRecord(input)
    || !hasExactKeys(input, STORED_EVENT_KEYS)
    || input.schema !== EVENT_SCHEMA
    || typeof input.eventId !== "string"
    || !STORED_EVENT_ID.test(input.eventId)
    || typeof input.projectId !== "string"
    || !SAFE_ID.test(input.projectId)
    || !isRecord(input.repository)
    || !hasExactKeys(input.repository, STORED_REPOSITORY_KEYS)
    || !Number.isSafeInteger(input.repository.installationId)
    || (input.repository.installationId as number) <= 0
    || !Number.isSafeInteger(input.repository.repositoryId)
    || (input.repository.repositoryId as number) <= 0
    || typeof input.repository.owner !== "string"
    || input.repository.owner.trim() === ""
    || typeof input.repository.name !== "string"
    || input.repository.name.trim() === ""
    || typeof input.idempotencyKeyHash !== "string"
    || !SHA256.test(input.idempotencyKeyHash)
    || typeof input.commandHash !== "string"
    || !SHA256.test(input.commandHash)
    || typeof input.previousStateSha !== "string"
    || !FULL_SHA.test(input.previousStateSha)
    || !Number.isSafeInteger(input.commandEventCount)
    || (input.commandEventCount as number) <= 0
    || !Number.isSafeInteger(input.sequence)
    || (input.sequence as number) <= 0
    || !isStateActor(input.actor)
    || typeof input.occurredAt !== "string"
    || !isCanonicalTimestamp(input.occurredAt)
  ) {
    return failure({ code: "invalid_event", message: "GitHub state contains an invalid event envelope." });
  }
  const event = codec.decodeEvent(input.event);
  if (!event.ok) return event;
  return ok({
    schema: EVENT_SCHEMA,
    eventId: input.eventId,
    projectId: input.projectId,
    repository: {
      installationId: input.repository.installationId as number,
      repositoryId: input.repository.repositoryId as number,
      owner: input.repository.owner,
      name: input.repository.name
    },
    idempotencyKeyHash: input.idempotencyKeyHash,
    commandHash: input.commandHash,
    previousStateSha: input.previousStateSha,
    commandEventCount: input.commandEventCount as number,
    sequence: input.sequence as number,
    actor: input.actor,
    occurredAt: input.occurredAt,
    event: event.value
  });
}

function validateAppendInput<Event, State>(command: AppendProjectCommand<Event, State>): StoreResult<void> {
  if (!SAFE_ID.test(command.projectId)) return failure({ code: "invalid_event", message: "Project id is not safe for GitHub state paths." });
  if (!FULL_SHA.test(command.baseSha)) return failure({ code: "invalid_event", message: "Base SHA must be a full lowercase Git SHA." });
  if (!FULL_SHA.test(command.expectedHeadSha)) return failure({ code: "invalid_event", message: "Expected state SHA must be a full lowercase Git SHA." });
  if (!command.idempotencyKey.trim() || command.idempotencyKey.length > 256) return failure({ code: "invalid_event", message: "Idempotency key must contain 1 to 256 characters." });
  if (!isCanonicalTimestamp(command.occurredAt)) return failure({ code: "invalid_event", message: "Mutation timestamp must be a canonical ISO timestamp." });
  if (!isStateActor(command.actor)) return failure({ code: "invalid_event", message: "Mutation actor is invalid." });
  return ok(undefined);
}

function eventPath<Event>(event: StoredProjectEvent<Event>): string {
  const date = new Date(event.occurredAt);
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${projectRoot(event.projectId)}/events/${year}/${month}/${event.eventId}.json`;
}

function storedEventId(projectId: string, idempotencyKeyHash: string, commandHash: string, index: number): string {
  return sha256(`${projectId}:${idempotencyKeyHash}:${commandHash}:${index}`).slice(0, 32);
}

function sameRepository(
  stored: StoredProjectEvent<unknown>["repository"],
  requested: RepositoryLocator
): boolean {
  return stored.installationId === requested.installationId
    && stored.repositoryId === requested.repositoryId
    && githubNameEquals(stored.owner, requested.owner)
    && githubNameEquals(stored.name, requested.name);
}

function githubNameEquals(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function validateCommandBatches<Event>(
  events: readonly StoredProjectEvent<Event>[],
  projectId: string
): StoreResult<void> {
  const batches = new Map<string, {
    commandHash: string;
    previousStateSha: string;
    actor: string;
    occurredAt: string;
    lastSequence: number;
    eventCount: number;
    expectedEventCount: number;
  }>();
  const eventIds = new Set<string>();

  for (const event of events) {
    if (eventIds.has(event.eventId)) {
      return failure({ code: "invalid_event", message: `Project ${projectId} contains a duplicate event id.` });
    }
    eventIds.add(event.eventId);

    const batch = batches.get(event.idempotencyKeyHash);
    if (batch && batch.commandHash !== event.commandHash) {
      return failure({ code: "idempotency_conflict", message: `Project ${projectId} reuses an idempotency key hash for different commands.` });
    }

    const index = batch?.eventCount ?? 0;
    const expectedEventId = storedEventId(projectId, event.idempotencyKeyHash, event.commandHash, index);
    if (event.eventId !== expectedEventId) {
      return failure({ code: "invalid_event", message: `Project ${projectId} contains an event with a non-deterministic event id.` });
    }

    if (!batch) {
      batches.set(event.idempotencyKeyHash, {
        commandHash: event.commandHash,
        previousStateSha: event.previousStateSha,
        actor: canonicalJson(event.actor),
        occurredAt: event.occurredAt,
        lastSequence: event.sequence,
        eventCount: 1,
        expectedEventCount: event.commandEventCount
      });
      continue;
    }

    if (event.sequence !== batch.lastSequence + 1) {
      return failure({ code: "invalid_event", message: `Project ${projectId} contains a non-contiguous command event batch.` });
    }
    // A tree snapshot cannot prove historical commit ancestry. It can still bind every
    // envelope written by one append batch to the same recorded pre-append metadata.
    if (event.previousStateSha !== batch.previousStateSha
      || canonicalJson(event.actor) !== batch.actor
      || event.occurredAt !== batch.occurredAt
      || event.commandEventCount !== batch.expectedEventCount
    ) {
      return failure({ code: "invalid_event", message: `Project ${projectId} contains inconsistent command event batch metadata.` });
    }
    batch.lastSequence = event.sequence;
    batch.eventCount += 1;
  }

  for (const batch of batches.values()) {
    if (batch.eventCount !== batch.expectedEventCount) {
      return failure({ code: "invalid_event", message: `Project ${projectId} contains an incomplete command event batch.` });
    }
  }

  return ok(undefined);
}

function projectRoot(projectId: string): string {
  return `${STATE_ROOT}/projects/${projectId}`;
}

function nodeTagRef(projectId: string, nodeSha: string): string {
  return `refs/tags/hunsu/node/${projectId}/${nodeSha}`;
}

function commitTitle(message: string): string {
  return message.split(/\r?\n/u, 1)[0]!.trim();
}

function projectIdsFromFiles(files: Readonly<Record<string, string>>): string[] {
  const ids = new Set<string>();
  for (const path of Object.keys(files)) {
    const match = path.match(/^\.hunsu\/v2\/projects\/([^/]+)\/events\/\d{4}\/\d{2}\/[0-9a-f]{32}\.json$/u);
    if (match?.[1]) ids.add(match[1]);
  }
  return [...ids].sort();
}

function safeMaterializedPath(path: string): StoreResult<void> {
  if (!path
    || path.startsWith("/")
    || path.includes("..")
    || path.includes("\\")
    || path.startsWith("events/")
  ) {
    return failure({ code: "invalid_event", message: `Unsafe materialized state path: ${path}` });
  }
  return ok(undefined);
}

function ensureSafeValue(value: unknown, label: string, keyPath = label): StoreResult<void> {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const nested = ensureSafeValue(value[index], label, `${keyPath}[${index}]`);
      if (!nested.ok) return nested;
    }
    return ok(undefined);
  }
  if (isRecord(value)) {
    for (const [key, nestedValue] of Object.entries(value)) {
      if (/(?:token|secret|password|private.?key|credential)/iu.test(key)) {
        return failure({ code: "unsafe_state", message: `${label} contains forbidden credential field ${keyPath}.${key}.` });
      }
      const nested = ensureSafeValue(nestedValue, label, `${keyPath}.${key}`);
      if (!nested.ok) return nested;
    }
    return ok(undefined);
  }
  if (typeof value === "string" && (/(?:^|\s)(?:github_pat_|gh[opusr]_|sk-)[A-Za-z0-9_-]+/u.test(value) || /-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(value))) {
    return failure({ code: "unsafe_state", message: `${label} contains credential-like material at ${keyPath}.` });
  }
  return ok(undefined);
}

function isStateActor(value: unknown): value is StateActor {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "user") {
    return hasExactKeys(value, USER_ACTOR_KEYS)
      && typeof value.id === "string"
      && value.id.trim().length > 0;
  }
  if (value.kind === "plugin") {
    return hasExactKeys(value, PLUGIN_ACTOR_KEYS)
      && typeof value.userId === "string"
      && value.userId.trim().length > 0
      && typeof value.clientId === "string"
      && value.clientId.trim().length > 0;
  }
  return value.kind === "system"
    && hasExactKeys(value, SYSTEM_ACTOR_KEYS)
    && (value.operation === "reconcile" || value.operation === "rebuild");
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every(key => Object.prototype.hasOwnProperty.call(value, key));
}

function isCanonicalTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function ok<T>(value: T): StoreResult<T> {
  return { ok: true, value };
}

function failure(error: StoreError): StoreResult<never> {
  return { ok: false, error };
}

function transportFailure(cause: StoreError["cause"]): StoreResult<never> {
  return failure({ code: "transport", message: cause?.message ?? "GitHub transport failed.", cause });
}
