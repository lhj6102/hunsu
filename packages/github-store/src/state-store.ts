import { canonicalJson, sha256 } from "./canonical-json.ts";
import type {
  AppendProjectCommand,
  AppendProjectResult,
  BranchSnapshot,
  GitHubTransport,
  ProjectStateCodec,
  ReconstructedProject,
  RepositoryLocator,
  StateActor,
  StoreError,
  StoredProjectEvent,
  StoreResult
} from "./types.ts";
import { HUNSU_STATE_BRANCH } from "./types.ts";

const STATE_ROOT = ".hunsu";
const EVENT_SCHEMA = "hunsu.project-event.v1";
const FULL_SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const STORED_EVENT_ID = /^[0-9a-f]{32}$/u;
const SAFE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;
const STATE_BRANCH_VISIBILITY_DELAYS_MS = [0, 50, 150] as const;

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

  async readProject(repository: RepositoryLocator, projectId: string): Promise<StoreResult<ReconstructedProject<State>>> {
    const branch = await this.#transport.readBranch(repository, HUNSU_STATE_BRANCH);
    if (!branch.ok) return transportFailure(branch.error);
    if (!branch.value) return failure({ code: "state_not_found", message: `Repository ${repository.owner}/${repository.name} has no Hunsu state branch.` });
    return this.#reconstructProject(branch.value, repository, projectId);
  }

  async reconstructRepository(repository: RepositoryLocator): Promise<StoreResult<ReconstructedProject<State>[]>> {
    const branch = await this.#transport.readBranch(repository, HUNSU_STATE_BRANCH);
    if (!branch.ok) return transportFailure(branch.error);
    if (!branch.value) return ok([]);
    const projectIds = projectIdsFromFiles(branch.value.files);
    const projects: ReconstructedProject<State>[] = [];
    for (const projectId of projectIds) {
      const project = this.#reconstructProject(branch.value, repository, projectId);
      if (!project.ok) return project;
      projects.push(project.value);
    }
    return ok(projects);
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

    if (command.expectedHeadSha && command.expectedHeadSha !== branch.headSha) {
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
      sequence: decoded.value.length + index + 1,
      actor: structuredClone(command.actor),
      occurredAt: command.occurredAt,
      event
    }));
    for (const entry of stored) {
      const safeEvent = ensureSafeValue(entry, "event");
      if (!safeEvent.ok) return safeEvent;
    }

    const allEvents = [...decoded.value, ...stored];
    const next = this.#replay(allEvents);
    if (!next.ok) return next;
    if (this.#codec.projectId(next.value) !== command.projectId) {
      return failure({ code: "invalid_event", message: "Projected Project identity does not match the command." });
    }
    const materialized = this.#codec.materialize(next.value);
    const safeMaterialized = ensureSafeValue(materialized, "materialized state");
    if (!safeMaterialized.ok) return safeMaterialized;

    const updates = [];
    for (const entry of stored) {
      const path = eventPath(entry);
      if (branch.files[path] !== undefined) return failure({ code: "invalid_event", message: `Event path ${path} already exists.` });
      updates.push({ path, content: `${canonicalJson(entry)}\n` });
    }
    const prefix = projectRoot(command.projectId);
    for (const [relativePath, value] of Object.entries(materialized)) {
      const pathValidation = safeMaterializedPath(relativePath);
      if (!pathValidation.ok) return pathValidation;
      updates.push({ path: `${prefix}/${relativePath}`, content: `${canonicalJson(value)}\n` });
    }
    const knownProjectIds = new Set([...projectIdsFromFiles(branch.files), command.projectId]);
    updates.push({
      path: `${STATE_ROOT}/workspace.json`,
      content: `${canonicalJson({
        schema: "hunsu.workspace.v1",
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
    goalId: string;
    runId: string;
    baseSha: string;
  }): Promise<StoreResult<string>> {
    for (const [label, value] of [["Project", input.projectId], ["Goal", input.goalId], ["Run", input.runId]] as const) {
      if (!SAFE_ID.test(value)) return failure({ code: "invalid_event", message: `${label} id is not safe for a Git branch.` });
    }
    if (!FULL_SHA.test(input.baseSha)) return failure({ code: "invalid_event", message: "Run base SHA must be a full lowercase Git SHA." });
    const branch = `hunsu/run/${input.projectId}/${input.goalId}/${input.runId}`;
    const existing = await this.#transport.readBranch(input.repository, branch);
    if (!existing.ok) return transportFailure(existing.error);
    if (existing.value) {
      const relationship = await this.#transport.compareCommits(input.repository, input.baseSha, existing.value.headSha);
      if (!relationship.ok) return transportFailure(relationship.error);
      if (relationship.value !== "ahead" && relationship.value !== "identical") {
        return failure({ code: "stale_state", message: `Run branch ${branch} does not descend from the expected base commit.` });
      }
      return ok(branch);
    }
    const created = await this.#transport.createBranch(input.repository, branch, input.baseSha);
    return created.ok ? ok(branch) : transportFailure(created.error);
  }

  async verifyRunResult(input: {
    repository: RepositoryLocator;
    branch: string;
    baseSha: string;
    resultSha: string;
  }): Promise<StoreResult<{ branchHeadSha: string; resultSha: string }>> {
    if (!input.branch.startsWith("hunsu/run/") || !FULL_SHA.test(input.baseSha) || !FULL_SHA.test(input.resultSha)) {
      return failure({ code: "invalid_event", message: "Run verification requires the expected branch and full lowercase Git SHAs." });
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

  #reconstructProject(
    branch: BranchSnapshot,
    repository: RepositoryLocator,
    projectId: string
  ): StoreResult<ReconstructedProject<State>> {
    const decoded = this.#decodeStoredEvents(branch.files, repository, projectId);
    if (!decoded.ok) return decoded;
    if (decoded.value.length === 0) return failure({ code: "project_not_found", message: `Project ${projectId} was not found in GitHub state.` });
    const state = this.#replay(decoded.value);
    return state.ok ? ok({ state: state.value, stateHeadSha: branch.headSha, eventCount: decoded.value.length }) : state;
  }

  #decodeStoredEvents(
    files: Readonly<Record<string, string>>,
    repository: RepositoryLocator,
    projectId: string
  ): StoreResult<StoredProjectEvent<Event>[]> {
    const prefix = `${projectRoot(projectId)}/events/`;
    const events: StoredProjectEvent<Event>[] = [];
    for (const path of Object.keys(files).filter(path => path.startsWith(prefix)).sort()) {
      let input: unknown;
      try {
        input = JSON.parse(files[path]);
      } catch {
        return failure({ code: "invalid_event", message: `Event file ${path} is not valid JSON.` });
      }
      const envelope = decodeEnvelope(input, this.#codec);
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

function decodeEnvelope<Event, State>(input: unknown, codec: ProjectStateCodec<Event, State>): StoreResult<StoredProjectEvent<Event>> {
  if (!isRecord(input)
    || input.schema !== EVENT_SCHEMA
    || typeof input.eventId !== "string"
    || !STORED_EVENT_ID.test(input.eventId)
    || typeof input.projectId !== "string"
    || !SAFE_ID.test(input.projectId)
    || !isRecord(input.repository)
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
    sequence: input.sequence as number,
    actor: input.actor,
    occurredAt: input.occurredAt,
    event: event.value
  });
}

function validateAppendInput<Event, State>(command: AppendProjectCommand<Event, State>): StoreResult<void> {
  if (!SAFE_ID.test(command.projectId)) return failure({ code: "invalid_event", message: "Project id is not safe for GitHub state paths." });
  if (!FULL_SHA.test(command.baseSha)) return failure({ code: "invalid_event", message: "Base SHA must be a full lowercase Git SHA." });
  if (command.expectedHeadSha && !FULL_SHA.test(command.expectedHeadSha)) return failure({ code: "invalid_event", message: "Expected state SHA must be a full lowercase Git SHA." });
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
        eventCount: 1
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
    ) {
      return failure({ code: "invalid_event", message: `Project ${projectId} contains inconsistent command event batch metadata.` });
    }
    batch.lastSequence = event.sequence;
    batch.eventCount += 1;
  }

  return ok(undefined);
}

function projectRoot(projectId: string): string {
  return `${STATE_ROOT}/projects/${projectId}`;
}

function projectIdsFromFiles(files: Readonly<Record<string, string>>): string[] {
  const ids = new Set<string>();
  for (const path of Object.keys(files)) {
    const match = path.match(/^\.hunsu\/projects\/([^/]+)\/events\//u);
    if (match?.[1]) ids.add(match[1]);
  }
  return [...ids].sort();
}

function safeMaterializedPath(path: string): StoreResult<void> {
  if (!path || path.startsWith("/") || path.includes("..") || path.includes("\\") || path.startsWith("events/")) {
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
  if (value.kind === "user") return typeof value.id === "string" && value.id.trim().length > 0;
  if (value.kind === "plugin") return typeof value.userId === "string" && value.userId.trim().length > 0 && typeof value.clientId === "string" && value.clientId.trim().length > 0;
  return value.kind === "system" && (value.operation === "reconcile" || value.operation === "rebuild");
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
