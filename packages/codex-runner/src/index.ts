import {
  createDefaultManagerConfig,
  createDefaultHarness,
  createDefaultMemberConfig,
  DEFAULT_TEAM_PROMPT,
  getHarnessMember,
  getHarnessMemberConfig,
  harnessSnapshotForTeam,
  memberConfigFromMemberEntity,
  renderPromptTemplate
} from "@hunsu/protocol";
import type { BoardProjection, Harness, HubPackageLock, HarnessSnapshot, ManagerConfig, MemberConfig, MemberPath, Destination } from "@hunsu/protocol";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { Buffer } from "node:buffer";

export const DEFAULT_TEAM_INSTRUCTION = DEFAULT_TEAM_PROMPT;

const GOAL_ASSIGNEE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    executorId: { type: "string" },
    goal: { type: "string" }
  },
  required: ["executorId", "goal"],
  additionalProperties: false
} as const;

const GOAL_EVALUATOR_OUTPUT_SCHEMA = {
  type: ["object", "null"],
  properties: {
    executorId: { type: "string" },
    prompt: { type: "string" }
  },
  required: ["executorId", "prompt"],
  additionalProperties: false
} as const;

const PATH_REQUIRES_OUTPUT_SCHEMA = {
  type: ["string", "array"],
  items: { type: "string" }
} as const;

const GOAL_EXECUTION_PLAN_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["goal"] },
    stage: { type: "string", enum: ["needs_evaluation"] },
    id: { type: "string" },
    assignee: GOAL_ASSIGNEE_OUTPUT_SCHEMA,
    evaluator: GOAL_EVALUATOR_OUTPUT_SCHEMA,
    remainingAttempts: {
      type: "integer",
      minimum: 0
    },
    requires: PATH_REQUIRES_OUTPUT_SCHEMA
  },
  required: ["kind", "stage", "id", "assignee", "evaluator", "remainingAttempts", "requires"],
  additionalProperties: false
} as const;

export const TEAM_EXECUTION_PLAN_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["queue"] },
    id: { type: "string" },
    items: {
      type: "array",
      items: GOAL_EXECUTION_PLAN_OUTPUT_SCHEMA
    }
  },
  required: ["kind", "id", "items"],
  additionalProperties: false
} as const;

export const GOAL_EVALUATION_SCHEMA = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["pass", "fail"] },
    summary: { type: "string" },
    reason: { type: "string" },
    feedback: { type: "string" },
    nextGoal: { type: "string" },
    evidence: { type: "array", items: { type: "string" } }
  },
  required: ["type", "summary", "reason", "feedback", "nextGoal", "evidence"],
  additionalProperties: false
} as const;

export type CodexRunnerThreadOptions = {
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy?: "never" | "on-request" | "on-failure" | "untrusted";
  approvalsReviewer?: "user" | "auto_review";
  networkAccessEnabled?: boolean;
  additionalDirectories?: string[];
  model?: string;
  modelReasoningEffort?: string;
};

export type ProcessEnvironment = Record<string, string | undefined>;

export type JsonObject = Record<string, unknown>;
type JsonRpcId = string | number;
export type JsonRpcMessage = JsonObject & { id?: JsonRpcId; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } };
export type RawCodexEvent = { source: "codex.app-server"; message: JsonRpcMessage };

export type RunnerStatusPhase = "working" | "thinking" | "exploring" | "running" | "waiting" | "idle";
export type RunnerStatusChangedEvent = {
  type: "runner.status.changed";
  runId: string;
  phase: RunnerStatusPhase;
  headline: string;
  detail?: string;
  providerThreadId?: string;
  providerTurnId?: string;
  itemId?: string;
};
export type RunnerFinalEvent = { type: "runner.final"; runId: string; finalResponse: string };
export type RunnerErrorEvent = { type: "runner.error"; runId: string; error: string };
export type RunnerAppServerCommandAction =
  | { type: "read"; command?: string; name?: string; path?: string }
  | { type: "listFiles"; command?: string; path?: string }
  | { type: "search"; command?: string; query?: string; path?: string }
  | { type: "unknown"; command?: string };
export type RunnerAppServerItem = {
  id?: string;
  type: string;
  text?: string;
  summary?: string[];
  content?: string[];
  command?: string;
  cwd?: string;
  status?: string;
  commandActions?: RunnerAppServerCommandAction[];
  aggregatedOutput?: string;
  exitCode?: number;
  durationMs?: number;
  changes?: unknown;
  server?: string;
  tool?: string;
  query?: string;
  raw: JsonObject;
};
export type RunnerTurnStartedEvent = {
  type: "runner.turn.started";
  runId: string;
  providerThreadId: string;
  providerTurnId: string;
  turn?: JsonObject;
  startedAtMs?: number;
};
export type RunnerTurnCompletedEvent = {
  type: "runner.turn.completed";
  runId: string;
  providerThreadId: string;
  providerTurnId?: string;
  turn?: JsonObject;
  usage?: AppServerUsage;
  completedAtMs?: number;
};
export type RunnerItemStartedEvent = {
  type: "runner.item.started";
  runId: string;
  providerThreadId?: string;
  providerTurnId?: string;
  itemId: string;
  item: RunnerAppServerItem;
  startedAtMs?: number;
};
export type RunnerItemDeltaEvent = {
  type: "runner.item.delta";
  runId: string;
  providerThreadId?: string;
  providerTurnId?: string;
  itemId: string;
  deltaKind: "agentMessage" | "plan" | "reasoningText" | "reasoningSummary" | "commandOutput" | "fileChangeOutput";
  delta: string;
  contentIndex?: number;
};
export type RunnerItemCompletedEvent = {
  type: "runner.item.completed";
  runId: string;
  providerThreadId?: string;
  providerTurnId?: string;
  itemId: string;
  item: RunnerAppServerItem;
  completedAtMs?: number;
};
export type RunnerAppServerMessageEvent = {
  type: "runner.appServer.message";
  runId: string;
  direction: "server-notification" | "server-request";
  providerThreadId?: string;
  providerTurnId?: string;
  method?: string;
  message: JsonRpcMessage;
};

export type TeamRunEvent =
  | RunnerAppServerMessageEvent
  | RunnerStatusChangedEvent
  | RunnerTurnStartedEvent
  | RunnerTurnCompletedEvent
  | RunnerItemStartedEvent
  | RunnerItemDeltaEvent
  | RunnerItemCompletedEvent
  | RunnerFinalEvent
  | RunnerErrorEvent;

export type RunnerEvent = TeamRunEvent;

export type StartRunInput = {
  runId: string;
  executeId?: string;
  repositoryPath: string;
  worktreeHash?: string;
  sourceMoveId?: string;
  targetMoveOrdinal?: number;
  requestGoal: string;
  teamName?: string;
  harness?: HarnessSnapshot;
  harnessGraph?: Harness;
  teamScopeId?: string;
  harnessLock?: HubPackageLock;
  activeDestinations: Destination[];
  selectedDestinationIds?: string[];
  futureConstraints?: string[];
  attemptOrdinal?: number;
  maxAttemptCount?: number;
  previousMemberOutputs?: string[];
  conversationRef?: { conversationHash: string; worktreeHash?: string };
  codexThreadOptions?: CodexRunnerThreadOptions;
  board: BoardProjection;
};

export type TeamPlanningInput = StartRunInput;

export type MemberPathRunInput = StartRunInput & {
  memberPath: MemberPath;
  dependencyOutputs?: string[];
  worktreeStatus?: string;
  worktreeDiff?: string;
  attemptTranscript?: string;
  outputSchema?: unknown;
};

export type MoveFinalizerPathOutput = {
  pathId: string;
  executorId: string;
  goal: string;
  commit?: string;
  finalResponse?: string;
};

export type MoveFinalizerInput = StartRunInput & {
  moveId: string;
  sourceMoveCommit: string;
  terminalPathCommit: string;
  terminalMemberPathId?: string;
  pathCommits: Record<string, string>;
  pathOutputs: MoveFinalizerPathOutput[];
  completionSummary: string;
  diffStat?: string;
  diffNameStatus?: string;
  diffPatch?: string;
};

export type ResumeRunInput = TeamPlanningInput & {
  providerThreadId: string;
};

export type HunsuDraftConversationMessage = {
  role: "user" | "draft-agent" | "system";
  text: string;
  createdAt?: string;
};

export type HunsuDraftSourceSnapshot = {
  sourceLineId: string;
  sourceNodeId: string;
  sourceMoveId?: string;
  moveOrdinal?: number;
  teamName?: string;
  summary?: string;
  destinationSummaries: Array<{
    id: string;
    title: string;
    status: string;
  }>;
};

export type HunsuDraftTurnInput = StartRunInput & {
  draftSessionId: string;
  manager: ManagerConfig;
  sourceArtifactId?: string;
  baseArtifactId?: string;
  draftCheckCommand: string;
  sourceSnapshot: HunsuDraftSourceSnapshot;
  messages: HunsuDraftConversationMessage[];
  userMessage: string;
  providerThreadId?: string;
};

export type HunsuDraftSessionInput = Omit<HunsuDraftTurnInput, "userMessage">;

export type RunnerRun = {
  runId: string;
  provider: "codex";
  providerThreadId?: string;
  providerTurnId?: string;
  finalResponse?: string;
  rawResult?: unknown;
};

export type CodexProviderStatus = {
  backend: "app-server";
  available: boolean;
  initialized?: unknown;
  account?: unknown;
  rateLimits?: unknown;
  accountError?: string;
  rateLimitsError?: string;
  error?: string;
};

export type Runner = {
  runTeamPlanning(input: TeamPlanningInput): Promise<RunnerRun>;
  runMemberPath(input: MemberPathRunInput): Promise<RunnerRun>;
  runMoveFinalizer(input: MoveFinalizerInput): Promise<RunnerRun>;
  prepareHunsuDraftSession?(input: HunsuDraftSessionInput): Promise<RunnerRun>;
  runHunsuDraftTurn(input: HunsuDraftTurnInput): Promise<RunnerRun>;
  resumeRun(input: ResumeRunInput): Promise<RunnerRun>;
  pauseRun(runId: string): Promise<void>;
  stopRun(runId: string): Promise<void>;
  providerStatus?(): Promise<CodexProviderStatus>;
  events(runId: string): AsyncIterable<RunnerEvent>;
};

export const DEFAULT_CODEX_THREAD_OPTIONS = {
  sandboxMode: "workspace-write",
  approvalPolicy: "never",
  approvalsReviewer: "user",
  networkAccessEnabled: false
} satisfies CodexRunnerThreadOptions;

type RunnerEventSubscriber = {
  queue: RunnerEvent[];
  resolve?: () => void;
  closed: boolean;
};

class RunnerEventBus {
  private readonly subscribers = new Map<string, Set<RunnerEventSubscriber>>();

  push(event: RunnerEvent): void {
    const subscribers = this.subscribers.get(event.runId);
    if (!subscribers) {
      return;
    }
    for (const subscriber of subscribers) {
      if (subscriber.closed) {
        continue;
      }
      subscriber.queue.push(event);
      subscriber.resolve?.();
      subscriber.resolve = undefined;
    }
  }

  close(runId: string): void {
    const subscribers = this.subscribers.get(runId);
    if (!subscribers) {
      return;
    }
    for (const subscriber of subscribers) {
      subscriber.closed = true;
      subscriber.resolve?.();
      subscriber.resolve = undefined;
    }
  }

  async *events(runId: string): AsyncIterable<RunnerEvent> {
    const subscriber: RunnerEventSubscriber = { queue: [], closed: false };
    let subscribers = this.subscribers.get(runId);
    if (!subscribers) {
      subscribers = new Set();
      this.subscribers.set(runId, subscribers);
    }
    subscribers.add(subscriber);
    try {
      while (true) {
        const event = subscriber.queue.shift();
        if (event) {
          yield event;
          continue;
        }
        if (subscriber.closed) {
          return;
        }
        await new Promise<void>(resolve => {
          subscriber.resolve = resolve;
        });
      }
    } finally {
      subscribers.delete(subscriber);
      if (subscribers.size === 0) {
        this.subscribers.delete(runId);
      }
    }
  }
}

type JsonRpcRequestHandler = (message: JsonRpcMessage) => Promise<unknown> | unknown;
type JsonRpcNotificationHandler = (message: JsonRpcMessage) => void;

export type CodexAppServerTransport = {
  send(message: JsonObject): void;
  close(): void;
  onMessage(handler: (message: JsonRpcMessage) => void): () => void;
  onError(handler: (error: Error) => void): () => void;
  onClose(handler: () => void): () => void;
};

export type CodexAppServerClientOptions = {
  command?: string;
  args?: string[];
  cwd?: string;
  environment?: ProcessEnvironment;
  requestTimeoutMs?: number;
  clientInfo?: { name: string; title: string | null; version: string };
  transportFactory?: () => CodexAppServerTransport;
  handleServerRequest?: JsonRpcRequestHandler;
};

export type CodexAppServerRunnerOptions = {
  client?: CodexAppServerClient;
  clientOptions?: CodexAppServerClientOptions;
  threadOptions?: CodexRunnerThreadOptions;
  environment?: ProcessEnvironment;
};

export type AppServerUsage = {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
};

type ActiveAppServerTurn = {
  runId: string;
  threadId: string;
  turnId?: string;
  finalResponse?: string;
  usage?: AppServerUsage;
  rawEvents: RawCodexEvent[];
  activeCommandExecutionIds: Set<string>;
  backgroundTerminalCleanupRequested: boolean;
  finalEmitted: boolean;
  completed: boolean;
  resolve: (run: RunnerRun) => void;
  reject: (error: Error) => void;
};

class CodexAppServerRequestError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

class CodexAppServerProcessTransport implements CodexAppServerTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly stdout: ReadlineInterface;
  private readonly messageHandlers = new Set<(message: JsonRpcMessage) => void>();
  private readonly errorHandlers = new Set<(error: Error) => void>();
  private readonly closeHandlers = new Set<() => void>();

  constructor(options: Required<Pick<CodexAppServerClientOptions, "command" | "args" | "environment">> & Pick<CodexAppServerClientOptions, "cwd">) {
    this.child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: createCodexEnvironment(options.environment)
    });
    this.stdout = createInterface({ input: this.child.stdout });
    this.stdout.on("line", line => this.handleLine(line));
    this.child.stderr.on("data", () => undefined);
    this.child.once("error", error => this.emitError(error));
    this.child.once("close", () => this.emitClose());
  }

  send(message: JsonObject): void {
    if (this.child.stdin.destroyed || !this.child.stdin.writable) {
      throw new Error("Codex app-server stdin is closed");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  close(): void {
    this.stdout.close();
    if (!this.child.killed) {
      this.child.kill("SIGTERM");
    }
  }

  onMessage(handler: (message: JsonRpcMessage) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onError(handler: (error: Error) => void): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  onClose(handler: () => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  private handleLine(line: string): void {
    if (!line.trim()) {
      return;
    }
    try {
      const message = JSON.parse(line) as JsonRpcMessage;
      for (const handler of this.messageHandlers) {
        handler(message);
      }
    } catch (error) {
      this.emitError(new Error(`Invalid Codex app-server JSON-RPC message: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  private emitError(error: Error): void {
    for (const handler of this.errorHandlers) {
      handler(error);
    }
  }

  private emitClose(): void {
    for (const handler of this.closeHandlers) {
      handler();
    }
  }
}

export class CodexAppServerClient {
  private readonly requestTimeoutMs: number;
  private readonly transportFactory: () => CodexAppServerTransport;
  private readonly clientInfo: { name: string; title: string | null; version: string };
  private serverRequestHandler: JsonRpcRequestHandler;
  private transport?: CodexAppServerTransport;
  private startPromise?: Promise<void>;
  private initialized?: unknown;
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, {
    method: string;
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private readonly notificationHandlers = new Set<JsonRpcNotificationHandler>();

  constructor(options: CodexAppServerClientOptions = {}) {
    const environment = options.environment ?? {};
    const command = options.command ?? "codex";
    const args = options.args ?? ["app-server", "--stdio"];
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
    this.clientInfo = options.clientInfo ?? { name: "hunsu-studio", title: "Hunsu Studio", version: "0.1.0" };
    this.transportFactory = options.transportFactory ?? (() => new CodexAppServerProcessTransport({
      command,
      args,
      environment,
      cwd: options.cwd
    }));
    this.serverRequestHandler = options.handleServerRequest ?? defaultAppServerRequestHandler;
  }

  setServerRequestHandler(handler: JsonRpcRequestHandler): void {
    this.serverRequestHandler = handler;
  }

  async initialize(): Promise<unknown> {
    await this.ensureStarted();
    return this.initialized;
  }

  async request(method: string, params?: unknown, options: { timeoutMs?: number } = {}): Promise<unknown> {
    await this.ensureStarted();
    return this.requestRaw(method, params, options.timeoutMs);
  }

  notify(method: string, params?: unknown): void {
    this.transport?.send(params === undefined ? { method } : { method, params });
  }

  onNotification(handler: JsonRpcNotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  close(): void {
    this.disposeTransport(new Error("Codex app-server client closed"), true);
  }

  private async ensureStarted(): Promise<void> {
    if (this.transport && this.initialized) {
      return;
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    this.startPromise = this.start();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  private async start(): Promise<void> {
    const transport = this.transportFactory();
    this.transport = transport;
    transport.onMessage(message => this.handleMessage(message));
    transport.onError(error => this.disposeTransport(error, true));
    transport.onClose(() => {
      this.disposeTransport(new Error("Codex app-server process exited"), false);
    });
    this.initialized = await this.requestRaw("initialize", {
      clientInfo: this.clientInfo,
      capabilities: null
    }, this.requestTimeoutMs);
    this.notify("initialized");
  }

  private requestRaw(method: string, params?: unknown, timeoutMs = this.requestTimeoutMs): Promise<unknown> {
    const transport = this.transport;
    if (!transport) {
      throw new Error("Codex app-server transport is not started");
    }
    const id = `hunsu-${this.nextId++}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`Codex app-server request timed out: ${method}`);
        reject(error);
        this.disposeTransport(error, true);
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        transport.send(params === undefined ? { id, method } : { id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private handleMessage(message: JsonRpcMessage): void {
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined) && !message.method) {
      this.handleResponse(message);
      return;
    }
    if (message.id !== undefined && typeof message.method === "string") {
      void this.handleServerRequest(message);
      return;
    }
    if (typeof message.method === "string") {
      for (const handler of this.notificationHandlers) {
        handler(message);
      }
    }
  }

  private handleResponse(message: JsonRpcMessage): void {
    const pending = this.pending.get(message.id as JsonRpcId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(message.id as JsonRpcId);
    if (message.error) {
      pending.reject(new Error(`Codex app-server ${pending.method} failed: ${message.error.message}`));
      return;
    }
    pending.resolve(message.result);
  }

  private async handleServerRequest(message: JsonRpcMessage): Promise<void> {
    try {
      const result = await this.serverRequestHandler(message);
      this.transport?.send({ id: message.id as JsonRpcId, result });
    } catch (error) {
      const requestError = error instanceof CodexAppServerRequestError
        ? error
        : new CodexAppServerRequestError(-32603, error instanceof Error ? error.message : String(error));
      this.transport?.send({
        id: message.id as JsonRpcId,
        error: {
          code: requestError.code,
          message: requestError.message,
          data: requestError.data
        }
      });
    }
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private disposeTransport(error: Error, closeTransport: boolean): void {
    const transport = this.transport;
    this.transport = undefined;
    this.initialized = undefined;
    this.rejectPending(error);
    if (closeTransport) {
      transport?.close();
    }
  }
}

export class CodexAppServerRunner implements Runner {
  private readonly eventBus = new RunnerEventBus();
  private readonly client: CodexAppServerClient;
  private readonly threadOptions: CodexRunnerThreadOptions;
  private readonly activeByRunId = new Map<string, ActiveAppServerTurn>();
  private readonly activeByThreadId = new Map<string, ActiveAppServerTurn>();
  private readonly activeByTurnId = new Map<string, ActiveAppServerTurn>();

  constructor(options: CodexAppServerRunnerOptions = {}) {
    this.threadOptions = {
      ...DEFAULT_CODEX_THREAD_OPTIONS,
      ...options.threadOptions
    };
    this.client = options.client ?? new CodexAppServerClient({
      ...options.clientOptions,
      environment: options.clientOptions?.environment ?? options.environment ?? {}
    });
    this.client.setServerRequestHandler(message => this.handleServerRequest(message));
    this.client.onNotification(message => this.handleNotification(message));
  }

  async runTeamPlanning(input: TeamPlanningInput): Promise<RunnerRun> {
    const config = teamPlanningConfigFor(input);
    return this.executeTurn(input, config, buildTeamPlanningPrompt(input), undefined, true, TEAM_EXECUTION_PLAN_SCHEMA);
  }

  async runMemberPath(input: MemberPathRunInput): Promise<RunnerRun> {
    const member = memberConfigFor(input, input.memberPath.executorId);
    return this.executeTurn(input, member, buildMemberPathPrompt(input), undefined, false, input.outputSchema);
  }

  async runMoveFinalizer(input: MoveFinalizerInput): Promise<RunnerRun> {
    const config = moveFinalizerConfigFor();
    return this.executeTurn(input, config, buildMoveFinalizerPrompt(input), undefined, true);
  }

  async runHunsuDraftTurn(input: HunsuDraftTurnInput): Promise<RunnerRun> {
    const config = hunsuDraftConfigFor(input.manager);
    return this.executeTurn(input, config, buildHunsuDraftPrompt(input), input.providerThreadId, false, undefined, { reusePreparedThread: true });
  }

  async prepareHunsuDraftSession(input: HunsuDraftSessionInput): Promise<RunnerRun> {
    const config = hunsuDraftConfigFor(input.manager);
    const providerThreadId = await this.prepareThread(input, config, input.providerThreadId, false);
    return {
      runId: input.runId,
      provider: "codex",
      providerThreadId
    };
  }

  async resumeRun(input: ResumeRunInput): Promise<RunnerRun> {
    const config = teamPlanningConfigFor(input);
    return this.executeTurn(input, config, buildTeamPlanningPrompt(input), input.providerThreadId, true, TEAM_EXECUTION_PLAN_SCHEMA);
  }

  async pauseRun(runId: string): Promise<void> {
    this.eventBus.push({ type: "runner.status.changed", runId, phase: "waiting", headline: "Pause requested", detail: "Codex app-server will stop after the current turn boundary." });
  }

  async stopRun(runId: string): Promise<void> {
    const active = this.activeByRunId.get(runId);
    this.eventBus.push({ type: "runner.status.changed", runId, phase: "waiting", headline: "Stop requested" });
    if (active?.threadId && active.turnId) {
      try {
        await this.client.request("turn/interrupt", { threadId: active.threadId, turnId: active.turnId }, { timeoutMs: 10_000 });
      } catch (error) {
        this.eventBus.push({ type: "runner.error", runId, error: `Codex app-server interrupt failed: ${error instanceof Error ? error.message : String(error)}` });
      }
      active.completed = true;
      active.reject(new Error("Codex turn interrupted by Studio"));
      return;
    }
    if (active) {
      active.completed = true;
      this.client.close();
      active.reject(new Error("Codex turn interrupted by Studio before app-server returned a turn id"));
      return;
    }
    this.eventBus.close(runId);
  }

  async providerStatus(): Promise<CodexProviderStatus> {
    try {
      const initialized = await this.client.initialize();
      const status: CodexProviderStatus = { backend: "app-server", available: true, initialized };
      try {
        status.account = await this.client.request("account/read", { refreshToken: false });
      } catch (error) {
        status.accountError = error instanceof Error ? error.message : String(error);
      }
      try {
        status.rateLimits = await this.client.request("account/rateLimits/read");
      } catch (error) {
        status.rateLimitsError = error instanceof Error ? error.message : String(error);
      }
      const errors = [status.accountError, status.rateLimitsError].filter(Boolean);
      if (errors.length > 0) {
        status.error = errors.join("; ");
      }
      return status;
    } catch (error) {
      return { backend: "app-server", available: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  events(runId: string): AsyncIterable<RunnerEvent> {
    return this.eventBus.events(runId);
  }

  private async executeTurn(
    input: StartRunInput,
    config: MemberConfig,
    prompt: string,
    providerThreadId?: string,
    readOnly = false,
    outputSchema?: unknown,
    options: { reusePreparedThread?: boolean } = {}
  ): Promise<RunnerRun> {
    const shouldReusePreparedThread = options.reusePreparedThread === true && providerThreadId !== undefined && !outputSchema;
    try {
      const threadId = shouldReusePreparedThread
        ? providerThreadId
        : await this.prepareThread(input, config, providerThreadId, readOnly, outputSchema);
      if (shouldReusePreparedThread) {
        this.eventBus.push({
          type: "runner.status.changed",
          runId: input.runId,
          phase: "working",
          headline: "Prepared thread reused",
          detail: threadId,
          providerThreadId: threadId
        });
      }

      try {
        return await this.startTurn(input, config, threadId, prompt, readOnly, outputSchema);
      } catch (error) {
        if (!shouldReusePreparedThread) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        this.eventBus.push({
          type: "runner.status.changed",
          runId: input.runId,
          phase: "working",
          headline: "Prepared thread reuse failed",
          detail: message,
          providerThreadId
        });
        const resumedThreadId = await this.prepareThread(input, config, providerThreadId, readOnly, outputSchema);
        return await this.startTurn(input, config, resumedThreadId, prompt, readOnly, outputSchema);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.eventBus.push({ type: "runner.error", runId: input.runId, error: message });
      throw error;
    } finally {
      this.eventBus.close(input.runId);
    }
  }

  private async startTurn(
    input: StartRunInput,
    config: MemberConfig,
    threadId: string,
    prompt: string,
    readOnly: boolean,
    outputSchema?: unknown
  ): Promise<RunnerRun> {
    let active: ActiveAppServerTurn | undefined;
    try {
      return await new Promise<RunnerRun>((resolve, reject) => {
        active = {
          runId: input.runId,
          threadId,
          rawEvents: [],
          activeCommandExecutionIds: new Set(),
          backgroundTerminalCleanupRequested: false,
          finalEmitted: false,
          completed: false,
          resolve,
          reject
        };
        this.trackActiveTurn(active);
        this.client.request("turn/start", this.turnStartParamsFor(input, config, threadId, prompt, readOnly, outputSchema), { timeoutMs: 60_000 })
          .then(turnResponse => {
            const turn = readRecord(turnResponse, "turn");
            if (!active || active.completed) {
              return;
            }
            const turnId = readString(turn, "id");
            if (turnId) {
              this.setActiveTurnId(active, turnId);
            }
            if (turn && readString(turn, "status") !== "inProgress") {
              this.completeActiveTurn(active, turn);
            }
          })
          .catch(error => {
            if (!active?.completed) {
              reject(error instanceof Error ? error : new Error(String(error)));
            }
          });
      });
    } finally {
      if (active) {
        this.untrackActiveTurn(active);
      }
    }
  }

  private async prepareThread(
    input: StartRunInput,
    config: MemberConfig,
    providerThreadId: string | undefined,
    readOnly: boolean,
    outputSchema?: unknown
  ): Promise<string> {
    const threadResponse = providerThreadId
      ? await this.client.request("thread/resume", this.threadResumeParamsFor(input, config, providerThreadId, readOnly))
      : await this.client.request("thread/start", this.threadStartParamsFor(input, config, readOnly));
    const threadId = readNestedString(threadResponse, ["thread", "id"]) ?? providerThreadId;
    if (!threadId) {
      throw new Error("Codex app-server did not return a thread id");
    }
    this.eventBus.push({
      type: "runner.status.changed",
      runId: input.runId,
      phase: "working",
      headline: "Thread ready",
      detail: threadId,
      providerThreadId: threadId
    });

    if (outputSchema) {
      await this.client.request("thread/goal/clear", { threadId }, { timeoutMs: 60_000 });
      this.eventBus.push({
        type: "runner.status.changed",
        runId: input.runId,
        phase: "working",
        headline: "Provider goal cleared",
        providerThreadId: threadId
      });
    } else {
      await this.client.request("thread/goal/set", this.threadGoalSetParamsFor(input, config, threadId), { timeoutMs: 60_000 });
      this.eventBus.push({
        type: "runner.status.changed",
        runId: input.runId,
        phase: "working",
        headline: "Provider goal set",
        providerThreadId: threadId
      });
    }
    return threadId;
  }

  private threadStartParamsFor(input: StartRunInput, config: MemberConfig, readOnly: boolean): JsonObject {
    const options = this.effectiveThreadOptions(input, config, readOnly);
    return {
      cwd: input.repositoryPath,
      approvalPolicy: options.approvalPolicy,
      approvalsReviewer: options.approvalsReviewer ?? "user",
      sandbox: options.sandboxMode,
      model: options.model ?? null,
      serviceTier: config.serviceTier === "fast" ? "fast" : null,
      ephemeral: false,
      threadSource: "user"
    };
  }

  private threadResumeParamsFor(input: StartRunInput, config: MemberConfig, providerThreadId: string, readOnly: boolean): JsonObject {
    const options = this.effectiveThreadOptions(input, config, readOnly);
    return {
      threadId: providerThreadId,
      cwd: input.repositoryPath,
      approvalPolicy: options.approvalPolicy,
      approvalsReviewer: options.approvalsReviewer ?? "user",
      sandbox: options.sandboxMode,
      model: options.model ?? null,
      serviceTier: config.serviceTier === "fast" ? "fast" : null
    };
  }

  private threadGoalSetParamsFor(input: StartRunInput, config: MemberConfig, threadId: string): JsonObject {
    return {
      threadId,
      objective: renderProviderGoal(input, config)
    };
  }

  private turnStartParamsFor(
    input: StartRunInput,
    config: MemberConfig,
    threadId: string,
    prompt: string,
    readOnly: boolean,
    outputSchema?: unknown
  ): JsonObject {
    const options = this.effectiveThreadOptions(input, config, readOnly);
    return {
      threadId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
      cwd: input.repositoryPath,
      approvalPolicy: options.approvalPolicy,
      approvalsReviewer: options.approvalsReviewer ?? "user",
      sandboxPolicy: appServerSandboxPolicyFor(input.repositoryPath, options, readOnly),
      model: options.model ?? null,
      serviceTier: config.serviceTier === "fast" ? "fast" : null,
      effort: options.modelReasoningEffort ?? null,
      outputSchema: outputSchema ?? null
    };
  }

  private effectiveThreadOptions(input: StartRunInput, config: MemberConfig, readOnly: boolean): CodexRunnerThreadOptions {
    const memberOptions = threadOptionsForMember(config);
    const options: CodexRunnerThreadOptions = {
      ...this.threadOptions,
      ...input.codexThreadOptions,
      ...memberOptions
    };
    if (readOnly) {
      options.networkAccessEnabled = input.codexThreadOptions?.networkAccessEnabled ?? this.threadOptions.networkAccessEnabled ?? memberOptions.networkAccessEnabled;
      options.sandboxMode = "read-only";
      options.approvalPolicy = "never";
      options.approvalsReviewer = "user";
    }
    return options;
  }

  private handleNotification(message: JsonRpcMessage): void {
    const active = activeTurnForMessage(message, this.activeByThreadId, this.activeByTurnId);
    if (!active) {
      return;
    }
    active.rawEvents.push(rawCodexEvent(message));
    const params = isRecord(message.params) ? message.params : {};
    const messageTurnId = readString(params, "turnId") ?? readNestedString(params, ["turn", "id"]);
    this.eventBus.push({
      type: "runner.appServer.message",
      runId: active.runId,
      direction: "server-notification",
      providerThreadId: active.threadId,
      providerTurnId: messageTurnId ?? active.turnId,
      method: message.method,
      message
    });
    if (messageTurnId && messageTurnId !== active.turnId) {
      this.setActiveTurnId(active, messageTurnId);
    }
    if (message.method === "item/started" || message.method === "item/completed") {
      this.trackCommandExecutionItem(active, message.method, readRecord(params, "item"));
    }
    const effects = interpretAppServerNotification({
      runId: active.runId,
      providerThreadId: active.threadId,
      providerTurnId: messageTurnId ?? active.turnId
    }, message);
    for (const effect of effects) {
      switch (effect.kind) {
        case "setTurnId":
          this.setActiveTurnId(active, effect.turnId);
          break;
        case "usage":
          active.usage = effect.usage;
          break;
        case "teamEvent":
          this.eventBus.push(effect.event);
          break;
        case "finalResponse":
          active.finalResponse = effect.finalResponse;
          this.requestBackgroundTerminalCleanupIfNeeded(active);
          break;
        case "completeTurn":
          this.completeActiveTurn(active, effect.turn);
          break;
      }
    }
  }

  private trackCommandExecutionItem(active: ActiveAppServerTurn, method: "item/started" | "item/completed", item: JsonObject | undefined): void {
    if (readString(item, "type") !== "commandExecution") {
      return;
    }
    const itemId = appServerItemId(item);
    if (!itemId) {
      return;
    }
    const status = readString(item, "status");
    if (method === "item/completed" || status === "completed" || status === "failed" || status === "declined") {
      active.activeCommandExecutionIds.delete(itemId);
      return;
    }
    active.activeCommandExecutionIds.add(itemId);
  }

  private requestBackgroundTerminalCleanupIfNeeded(active: ActiveAppServerTurn): void {
    if (active.backgroundTerminalCleanupRequested || active.activeCommandExecutionIds.size === 0) {
      return;
    }
    active.backgroundTerminalCleanupRequested = true;
    void this.client.request("thread/backgroundTerminals/clean", { threadId: active.threadId }, { timeoutMs: 10_000 }).catch(() => undefined);
  }

  private completeActiveTurn(active: ActiveAppServerTurn, turn: JsonObject | undefined): void {
    if (active.completed) {
      return;
    }
    active.completed = true;
    const turnId = readString(turn, "id") ?? active.turnId;
    if (turnId) {
      this.setActiveTurnId(active, turnId);
    }
    const status = readString(turn, "status");
    if (status === "failed") {
      const error = readRecord(turn, "error");
      const message = readString(error, "message") ?? "Codex app-server turn failed";
      this.eventBus.push({ type: "runner.error", runId: active.runId, error: message });
      active.reject(new Error(message));
      return;
    }
    if (status === "interrupted") {
      active.reject(new Error("Codex app-server turn interrupted"));
      return;
    }
    const finalResponse = active.finalResponse ?? finalResponseFromAppServerTurn(turn);
    if (finalResponse && !active.finalEmitted) {
      active.finalEmitted = true;
      this.eventBus.push({ type: "runner.final", runId: active.runId, finalResponse });
    }
    active.resolve({
      runId: active.runId,
      provider: "codex",
      providerThreadId: active.threadId,
      providerTurnId: active.turnId,
      finalResponse,
      rawResult: {
        rawEvents: active.rawEvents,
        finalResponse,
        usage: active.usage,
        turn
      }
    });
  }

  private trackActiveTurn(active: ActiveAppServerTurn): void {
    this.activeByRunId.set(active.runId, active);
    this.activeByThreadId.set(active.threadId, active);
    if (active.turnId) {
      this.activeByTurnId.set(active.turnId, active);
    }
  }

  private setActiveTurnId(active: ActiveAppServerTurn, turnId: string): void {
    if (active.turnId && active.turnId !== turnId) {
      this.activeByTurnId.delete(active.turnId);
    }
    active.turnId = turnId;
    this.activeByTurnId.set(turnId, active);
  }

  private untrackActiveTurn(active: ActiveAppServerTurn): void {
    this.activeByRunId.delete(active.runId);
    this.activeByThreadId.delete(active.threadId);
    if (active.turnId) {
      this.activeByTurnId.delete(active.turnId);
    }
  }

  private async handleServerRequest(message: JsonRpcMessage): Promise<unknown> {
    const params = isRecord(message.params) ? message.params : {};
    const active = activeTurnForMessage(message, this.activeByThreadId, this.activeByTurnId);
    active?.rawEvents.push(rawCodexEvent(message));
    const runId = active?.runId;
    if (runId) {
      this.eventBus.push({
        type: "runner.appServer.message",
        runId,
        direction: "server-request",
        providerThreadId: active?.threadId,
        providerTurnId: active?.turnId,
        method: message.method,
        message
      });
    }
    const approvalSummary = appServerApprovalSummary(message.method, params);
    if (runId && approvalSummary) {
      this.eventBus.push({ type: "runner.status.changed", runId, phase: "waiting", headline: "Approval requested", detail: approvalSummary, providerThreadId: active?.threadId, providerTurnId: active?.turnId });
    }
    if (message.method === "item/permissions/requestApproval") {
      if (active?.threadId && active.turnId) {
        void this.client.request("turn/interrupt", { threadId: active.threadId, turnId: active.turnId }, { timeoutMs: 10_000 }).catch(() => undefined);
      }
      if (runId) {
        this.eventBus.push({ type: "runner.error", runId, error: "Codex app-server requested additional permissions; Hunsu declined and interrupted the turn." });
      }
      if (active && !active.completed) {
        active.completed = true;
        active.reject(new Error("Codex app-server requested additional permissions; Hunsu declined and interrupted the turn."));
      }
    }
    return defaultAppServerRequestHandler(message);
  }
}

export function createDefaultCodexRunner(options: CodexAppServerRunnerOptions = {}): Runner {
  return new CodexAppServerRunner(options);
}

function defaultAppServerRequestHandler(message: JsonRpcMessage): unknown {
  switch (message.method) {
    case "item/commandExecution/requestApproval":
      return { decision: "decline" };
    case "item/fileChange/requestApproval":
      return { decision: "decline" };
    case "execCommandApproval":
    case "applyPatchApproval":
      return { decision: "denied" };
    case "item/permissions/requestApproval":
      return { permissions: {}, scope: "turn", strictAutoReview: true };
    default:
      throw new CodexAppServerRequestError(-32601, `Unsupported Codex app-server request: ${message.method ?? "unknown"}`);
  }
}

function appServerSandboxPolicyFor(repositoryPath: string, options: CodexRunnerThreadOptions, readOnly: boolean): JsonObject {
  const networkAccess = options.networkAccessEnabled === true;
  if (readOnly || options.sandboxMode === "read-only") {
    return { type: "readOnly", networkAccess };
  }
  if (options.sandboxMode === "danger-full-access") {
    return { type: "dangerFullAccess", networkAccess };
  }
  return {
    type: "workspaceWrite",
    writableRoots: [repositoryPath],
    networkAccess,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false
  };
}

function activeTurnForMessage(
  message: JsonRpcMessage,
  byThreadId: Map<string, ActiveAppServerTurn>,
  byTurnId: Map<string, ActiveAppServerTurn>
): ActiveAppServerTurn | undefined {
  const params = isRecord(message.params) ? message.params : {};
  const turnId = readString(params, "turnId") ?? readNestedString(params, ["turn", "id"]);
  if (turnId) {
    const active = byTurnId.get(turnId);
    if (active) {
      return active;
    }
  }
  const threadId = readString(params, "threadId") ?? readNestedString(params, ["thread", "id"]);
  return threadId ? byThreadId.get(threadId) : undefined;
}

type AppServerNotificationContext = {
  runId: string;
  providerThreadId: string;
  providerTurnId?: string;
};

type AppServerNotificationEffect =
  | { kind: "setTurnId"; turnId: string }
  | { kind: "usage"; usage: AppServerUsage | undefined }
  | { kind: "teamEvent"; event: TeamRunEvent }
  | { kind: "finalResponse"; finalResponse: string }
  | { kind: "completeTurn"; turn: JsonObject | undefined };

function rawCodexEvent(message: JsonRpcMessage): RawCodexEvent {
  return { source: "codex.app-server", message };
}

function interpretAppServerNotification(context: AppServerNotificationContext, message: JsonRpcMessage): AppServerNotificationEffect[] {
  const params = isRecord(message.params) ? message.params : {};
  switch (message.method) {
    case "turn/started": {
      const turn = readRecord(params, "turn");
      const turnId = readString(turn, "id") ?? readString(params, "turnId") ?? context.providerTurnId ?? "turn";
      return [
        ...(turnId ? [{ kind: "setTurnId" as const, turnId }] : []),
        {
          kind: "teamEvent",
          event: {
            type: "runner.turn.started",
            runId: context.runId,
            providerThreadId: context.providerThreadId,
            providerTurnId: turnId,
            turn,
            startedAtMs: readNumber(params, "startedAtMs")
          }
        },
        {
          kind: "teamEvent",
          event: {
            type: "runner.status.changed",
            runId: context.runId,
            phase: "working",
            headline: "Working",
            detail: turnId,
            providerThreadId: context.providerThreadId,
            providerTurnId: turnId
          }
        }
      ];
    }
    case "turn/completed": {
      const turn = readRecord(params, "turn");
      const turnId = readString(turn, "id") ?? readString(params, "turnId") ?? context.providerTurnId;
      return [
        {
          kind: "teamEvent",
          event: {
            type: "runner.turn.completed",
            runId: context.runId,
            providerThreadId: context.providerThreadId,
            providerTurnId: turnId,
            turn,
            completedAtMs: readNumber(params, "completedAtMs")
          }
        },
        { kind: "completeTurn", turn }
      ];
    }
    case "thread/tokenUsage/updated": {
      const usage = appServerUsageFromNotification(params);
      return [
        { kind: "usage", usage },
        {
          kind: "teamEvent",
          event: {
            type: "runner.status.changed",
            runId: context.runId,
            phase: "working",
            headline: "Working",
            detail: formatAppServerUsage(usage),
            providerThreadId: context.providerThreadId,
            providerTurnId: context.providerTurnId
          }
        }
      ];
    }
    case "item/started":
    case "item/completed":
      return mapAppServerThreadItemEvent(context, message.method, readRecord(params, "item"));
    case "item/agentMessage/delta":
    case "item/agentMessage/textDelta":
    case "item/agentMessage/outputDelta":
    case "item/assistantMessage/delta":
    case "item/assistantMessage/textDelta":
    case "item/assistantMessage/outputDelta": {
      const delta = readDeltaText(params);
      if (!delta) {
        return [];
      }
      const itemId = appServerItemId(params) ?? "agentMessage";
      const providerTurnId = readString(params, "turnId") ?? context.providerTurnId;
      return [{
        kind: "teamEvent",
        event: {
          type: "runner.item.delta",
          runId: context.runId,
          providerThreadId: context.providerThreadId,
          providerTurnId,
          itemId,
          deltaKind: "agentMessage",
          delta
        }
      }];
    }
    case "item/commandExecution/outputDelta":
    case "item/fileChange/outputDelta":
    case "item/plan/delta":
    case "item/reasoning/textDelta":
    case "item/reasoning/summaryTextDelta": {
      const delta = readDeltaText(params);
      if (!delta) {
        return [];
      }
      const deltaKind = appServerDeltaKind(message.method);
      const itemId = appServerItemId(params) ?? deltaKind;
      const providerTurnId = readString(params, "turnId") ?? context.providerTurnId;
      return [{
        kind: "teamEvent",
        event: {
          type: "runner.item.delta",
          runId: context.runId,
          providerThreadId: context.providerThreadId,
          providerTurnId,
          itemId,
          deltaKind,
          delta,
          contentIndex: readNumber(params, "contentIndex")
        }
      }];
    }
    case "turn/plan/updated": {
      const explanation = readString(params, "explanation");
      return [{
        kind: "teamEvent",
        event: {
          type: "runner.status.changed",
          runId: context.runId,
          phase: "thinking",
          headline: "Planning",
          detail: explanation ? truncateText(explanation, 500) : "Codex plan updated.",
          providerThreadId: context.providerThreadId,
          providerTurnId: context.providerTurnId
        }
      }];
    }
    case "error": {
      const error = readRecord(params, "error");
      return [{
        kind: "teamEvent",
        event: { type: "runner.error", runId: context.runId, error: readString(error, "message") ?? "Codex app-server error" }
      }];
    }
    default:
      return [];
  }
}

function appServerUsageFromNotification(params: JsonObject): AppServerUsage | undefined {
  const usage = readRecord(params, "tokenUsage");
  const last = readRecord(usage, "last");
  if (!last) {
    return undefined;
  }
  return {
    input_tokens: readNumber(last, "inputTokens") ?? 0,
    cached_input_tokens: readNumber(last, "cachedInputTokens") ?? 0,
    output_tokens: readNumber(last, "outputTokens") ?? 0,
    reasoning_output_tokens: readNumber(last, "reasoningOutputTokens") ?? 0
  };
}

function formatAppServerUsage(usage: AppServerUsage | undefined): string {
  if (!usage) {
    return "Codex app-server usage updated.";
  }
  return `Codex turn usage. Input ${usage.input_tokens}, output ${usage.output_tokens}, reasoning ${usage.reasoning_output_tokens}.`;
}

function appServerApprovalSummary(method: string | undefined, params: JsonObject): string | undefined {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return `Codex app-server requested command approval; Hunsu declined: ${readString(params, "command") ?? "unknown command"}`;
    case "item/fileChange/requestApproval":
      return `Codex app-server requested file-change approval; Hunsu declined${readString(params, "grantRoot") ? ` for ${readString(params, "grantRoot")}` : ""}.`;
    case "item/permissions/requestApproval":
      return "Codex app-server requested additional permissions; Hunsu declined.";
    case "execCommandApproval":
      return `Codex app-server requested command approval; Hunsu declined: ${(params.command as unknown[] | undefined)?.join(" ") ?? "unknown command"}`;
    case "applyPatchApproval":
      return "Codex app-server requested patch approval; Hunsu declined.";
    default:
      return undefined;
  }
}

function mapAppServerThreadItemEvent(
  context: AppServerNotificationContext,
  method: "item/started" | "item/completed",
  item: JsonObject | undefined
): AppServerNotificationEffect[] {
  const phase = method === "item/started" ? "started" : "completed";
  const normalized = normalizeAppServerThreadItem(item);
  if (!normalized) {
    return [];
  }
  const itemId = normalized.id ?? appServerItemId(item) ?? normalized.type;
  const lifecycleEffect: AppServerNotificationEffect = {
    kind: "teamEvent",
    event: phase === "started"
      ? {
          type: "runner.item.started",
          runId: context.runId,
          providerThreadId: context.providerThreadId,
          providerTurnId: context.providerTurnId,
          itemId,
          item: normalized
        }
      : {
          type: "runner.item.completed",
          runId: context.runId,
          providerThreadId: context.providerThreadId,
          providerTurnId: context.providerTurnId,
          itemId,
          item: normalized
        }
  };
  switch (normalized.type) {
    case "agentMessage": {
      const text = normalized.text;
      if (phase !== "completed" || !text) {
        return [lifecycleEffect];
      }
      return [
        lifecycleEffect,
        { kind: "finalResponse", finalResponse: text }
      ];
    }
    case "reasoning": {
      return [lifecycleEffect];
    }
    case "plan": {
      return [lifecycleEffect];
    }
    case "commandExecution": {
      return [lifecycleEffect];
    }
    case "fileChange": {
      return [lifecycleEffect];
    }
    case "mcpToolCall": {
      return [lifecycleEffect];
    }
    case "webSearch": {
      return [lifecycleEffect];
    }
    default:
      return [lifecycleEffect];
  }
}

function appServerDeltaKind(method: string | undefined): RunnerItemDeltaEvent["deltaKind"] {
  switch (method) {
    case "item/agentMessage/delta":
    case "item/agentMessage/textDelta":
    case "item/agentMessage/outputDelta":
    case "item/assistantMessage/delta":
    case "item/assistantMessage/textDelta":
    case "item/assistantMessage/outputDelta":
      return "agentMessage";
    case "item/plan/delta":
      return "plan";
    case "item/reasoning/textDelta":
      return "reasoningText";
    case "item/reasoning/summaryTextDelta":
      return "reasoningSummary";
    case "item/fileChange/outputDelta":
      return "fileChangeOutput";
    case "item/commandExecution/outputDelta":
    default:
      return "commandOutput";
  }
}

function normalizeAppServerThreadItem(item: JsonObject | undefined): RunnerAppServerItem | undefined {
  const type = readString(item, "type");
  if (!item || !type) {
    return undefined;
  }
  const normalized: RunnerAppServerItem = {
    id: appServerItemId(item),
    type,
    raw: item
  };
  const text = readString(item, "text");
  if (text !== undefined) {
    normalized.text = text;
  } else {
    const contentText = readAppServerContentText(item);
    if (contentText !== undefined) {
      normalized.text = contentText;
    }
  }
  const summary = readAppServerTextParts(item.summary);
  if (summary.length > 0) {
    normalized.summary = summary;
  }
  const content = readAppServerTextParts(item.content);
  if (content.length > 0) {
    normalized.content = content;
  }
  const command = readString(item, "command");
  if (command !== undefined) {
    normalized.command = command;
  }
  const cwd = readString(item, "cwd");
  if (cwd !== undefined) {
    normalized.cwd = cwd;
  }
  const status = readString(item, "status");
  if (status !== undefined) {
    normalized.status = status;
  }
  const commandActions = readAppServerCommandActions(item);
  if (commandActions.length > 0) {
    normalized.commandActions = commandActions;
  }
  const aggregatedOutput = readString(item, "aggregatedOutput");
  if (aggregatedOutput !== undefined) {
    normalized.aggregatedOutput = aggregatedOutput;
  }
  const exitCode = readNumber(item, "exitCode");
  if (exitCode !== undefined) {
    normalized.exitCode = exitCode;
  }
  const durationMs = readNumber(item, "durationMs");
  if (durationMs !== undefined) {
    normalized.durationMs = durationMs;
  }
  if ("changes" in item) {
    normalized.changes = item.changes;
  }
  const server = readString(item, "server");
  if (server !== undefined) {
    normalized.server = server;
  }
  const tool = readString(item, "tool");
  if (tool !== undefined) {
    normalized.tool = tool;
  }
  const query = readString(item, "query");
  if (query !== undefined) {
    normalized.query = query;
  }
  return normalized;
}

function readAppServerContentText(item: JsonObject): string | undefined {
  const content = readAppServerTextParts(item.content);
  if (content.length === 0) {
    return undefined;
  }
  return content.join("\n\n");
}

function readAppServerTextParts(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((part): string[] => {
    if (typeof part === "string") {
      return part ? [part] : [];
    }
    if (!isRecord(part)) {
      return [];
    }
    const text = readString(part, "text") ?? readString(part, "content") ?? readString(part, "summary");
    return text ? [text] : [];
  });
}

function readAppServerCommandActions(item: JsonObject): RunnerAppServerCommandAction[] {
  const value = item.commandActions;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((action): RunnerAppServerCommandAction[] => {
    if (!isRecord(action)) {
      return [];
    }
    const type = readString(action, "type");
    switch (type) {
      case "read":
        return [{ type, command: readString(action, "command"), name: readString(action, "name"), path: readString(action, "path") }];
      case "listFiles":
        return [{ type, command: readString(action, "command"), path: readString(action, "path") }];
      case "search":
        return [{ type, command: readString(action, "command"), query: readString(action, "query"), path: readString(action, "path") }];
      case "unknown":
        return [{ type, command: readString(action, "command") }];
      default:
        return [];
    }
  });
}

function finalResponseFromAppServerTurn(turn: JsonObject | undefined): string | undefined {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  for (const item of [...items].reverse()) {
    if (isRecord(item) && item.type === "agentMessage" && typeof item.text === "string") {
      return item.text;
    }
  }
  return undefined;
}

function appServerItemId(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return readString(value, "itemId") ?? readString(value, "id");
}

function readRecord(value: unknown, key: string): JsonObject | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const child = value[key];
  return isRecord(child) ? child : undefined;
}

function readString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const child = value[key];
  return typeof child === "string" ? child : undefined;
}

function readDeltaText(value: unknown): string | undefined {
  const delta = readString(value, "delta");
  if (delta !== undefined) {
    return delta;
  }
  const deltaBase64 = readString(value, "deltaBase64");
  if (!deltaBase64) {
    return undefined;
  }
  try {
    return Buffer.from(deltaBase64, deltaBase64.includes("-") || deltaBase64.includes("_") ? "base64url" : "base64").toString("utf8");
  } catch {
    return undefined;
  }
}

function readNumber(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const child = value[key];
  return typeof child === "number" ? child : undefined;
}

function readStringArray(value: unknown, key: string): string[] {
  if (!isRecord(value) || !Array.isArray(value[key])) {
    return [];
  }
  return value[key].filter((item): item is string => typeof item === "string");
}

function readNestedString(value: unknown, keys: string[]): string | undefined {
  let current = value;
  for (const key of keys) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return typeof current === "string" ? current : undefined;
}

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function buildTeamPlanningPrompt(input: StartRunInput): string {
  const protocol = teamHarnessForInput(input);
  return [
    "<role>",
    "  <purpose>",
    "    Plan a closure-free executable ExecutionPlan.",
    "  </purpose>",
    "",
    "  <instructions>",
    indentBlock(teamInstructionFor(input, protocol), 4),
    "  </instructions>",
    "</role>",
    "",
    "<goal>",
    indentBlock(formatTeamGoal(input), 2),
    "</goal>",
    "",
    "<member_profiles>",
    formatMemberProfiles(protocol.members),
    "</member_profiles>",
    "",
    "<rules>",
    "  Return one structured ExecutionPlan object with root kind queue.",
    "  Put each executable step in the queue items array as kind goal with stage needs_evaluation.",
    "  Use each goal item to delegate to one assignee Executor and optionally one evaluator Executor.",
    "  A goal assignee must name executorId and a standalone goal.",
    "  A goal evaluator, when present, must name executorId and a prompt that can return pass or fail with type, summary, reason, feedback, nextGoal, and evidence.",
    `  Set remainingAttempts to ${normalizePositiveInteger(input.maxAttemptCount) || maxAttemptCountForPrompt(protocol)} for each goal unless a smaller bound is clearly enough.`,
    "  Set requires to PrevMove unless this goal intentionally depends on earlier Path ids.",
    "</rules>"
  ].join("\n");
}

function maxAttemptCountForPrompt(protocol: HarnessSnapshot): number {
  switch (protocol.kind) {
    case "team_execution_plan":
      return protocol.maxAttemptCount;
    case "role_squad":
    case "council_vote":
    case "court_debate":
      return protocol.maxRoundCount;
  }
}

function normalizePositiveInteger(value: number | undefined): number | undefined {
  return Number.isInteger(value) && value && value > 0 ? value : undefined;
}

export function buildMemberPathPrompt(input: MemberPathRunInput): string {
  const member = memberConfigFor(input, input.memberPath.executorId);
  const renderedMemberPrompt = renderPromptTemplate(member.promptTemplate, memberPromptTemplateContext(input));
  return [
    "<member>",
    renderedMemberPrompt.trim() || "No additional Member prompt.",
    "</member>",
    "",
    "<goal>",
    input.memberPath.goal.trim(),
    "</goal>",
    "",
    "<constraints>",
    "Do not read .hunsu files.",
    "Do not create commits.",
    "Use bounded commands for verification; do not run preview servers, dev servers, watchers, or other long-running processes in the foreground.",
    "If you start a preview server, dev server, watcher, or any other long-running command, stop it before your final response.",
    "Do not leave running command sessions, local listeners, or background processes open at the end of the turn.",
    "</constraints>"
  ].join("\n");
}

export function buildMoveFinalizerPrompt(input: MoveFinalizerInput): string {
  const selectedDestination = selectedDestinationForPrompt(input);
  const pathOutputs = input.pathOutputs.map(output => [
    `- ${output.pathId} (${output.executorId})`,
    `  goal: ${output.goal}`,
    output.commit ? `  commit: ${output.commit}` : undefined,
    output.finalResponse ? `  output: ${truncateText(output.finalResponse, 2000)}` : undefined
  ].filter(Boolean).join("\n")).join("\n");

  return [
    "You are the MOVE finalizer for a completed Hunsu Execute.",
    "Write the Git commit message for MOVE N+1 from the source MOVE to terminal Path diff.",
    "Do not edit files. Do not create Git commits. Return only the commit message content.",
    "",
    `MOVE id: ${input.moveId}`,
    `Source MOVE commit: ${input.sourceMoveCommit}`,
    `Terminal Path commit: ${input.terminalPathCommit}`,
    input.terminalMemberPathId ? `Terminal Path id: ${input.terminalMemberPathId}` : undefined,
    "",
    "Destination:",
    selectedDestination ? formatDestinationForPrompt(selectedDestination) : `- ${input.requestGoal}`,
    "",
    "Completion summary:",
    input.completionSummary || "Not provided.",
    "",
    "Path commits:",
    Object.entries(input.pathCommits).map(([pathId, commit]) => `- ${pathId}: ${commit}`).join("\n") || "- none",
    "",
    "Path outputs:",
    pathOutputs || "- none",
    "",
    "Diff stat:",
    input.diffStat?.trim() || "Not provided.",
    "",
    "Diff name-status:",
    input.diffNameStatus?.trim() || "Not provided.",
    "",
    "Diff patch:",
    input.diffPatch?.trim() || "Not provided.",
    "",
    "Commit message requirements:",
    "- First line: concise imperative subject for the MOVE result.",
    "- Body: summarize the product changes and relevant Path outputs.",
    "- Do not include Hunsu trailers; Studio appends system trailers."
  ].filter((line): line is string => line !== undefined).join("\n");
}

export function buildHunsuDraftPrompt(input: HunsuDraftTurnInput): string {
  const managerInstructions = renderPromptTemplate(input.manager.promptTemplate, providerPromptTemplateContext(input)).trim();
  return [
    "<role>",
    "You are the Hunsu Draft agent for a local Hunsu Studio session.",
    "Help the user refine a proposed HUNSU intervention conversationally.",
    "You may edit decoded draft request files under .hunsu-request/ in the supplied Route worktree.",
    "Do not edit .hunsu/ encoded runtime files, .hunsu-prev/, product files, or create commits.",
    "Available request runtime files are .hunsu-request/destinations.json, .hunsu-request/harness.json, .hunsu-request/executors.json, .hunsu-request/resources.json, and .hunsu-request/artifact-actions.json.",
    "Edit only the files required by the user's explicit request.",
    "Use destinations.json for Destination/TODO changes and artifact-actions.json for Artifact Action changes.",
    "For a simple TODO/Destination addition, edit only .hunsu-request/destinations.json.",
    ".hunsu-request/executors.json is the source of truth for Member definitions.",
    ".hunsu-request/resources.json is the source of truth for Skill, Plugin, and Resource bindings.",
    ".hunsu-request/harness.json stores Harness policy only; it must not contain a members field.",
    "Do not edit .hunsu-request/harness.json unless the user explicitly asks to change root Team or Harness policy.",
    "Do not edit .hunsu-request/executors.json unless the user explicitly asks to change Member definitions or Member config.",
    "Do not edit .hunsu-request/resources.json unless the user explicitly asks to change Resource bindings or requirements.",
    "Do not create, copy, or update Resource bindings or assignment entries for newly added Destinations; Team-planner routing and binding are handled outside Destination edits.",
    "After editing .hunsu-request files, run the supplied Draft check command. It creates a DiffArtifact in Hunsu Local.",
    "If the DiffArtifact passes, include this exact marker in your final reply: ::hunsu-diff{draftSessionId=\"<draftSessionId>\" diffArtifactId=\"<diffArtifactId>\" status=\"pass\"}",
    "If the DiffArtifact fails, include the same marker with status=\"failed\" and explain the validation error briefly.",
    "Confirmation is handled by Hunsu Local from the DiffArtifact id.",
    "</role>",
    "",
    "<manager>",
    `id: ${input.manager.id}`,
    "instructions:",
    indentBlock(managerInstructions || "No Manager-specific instructions.", 2),
    "</manager>",
    "",
    "<draft_check_command>",
    indentBlock(input.draftCheckCommand, 2),
    "</draft_check_command>",
    "",
    "<source_snapshot>",
    indentBlock(formatHunsuSourceSnapshot(input.sourceSnapshot), 2),
    "</source_snapshot>",
    "",
    "<request_goal>",
    indentBlock(input.requestGoal, 2),
    "</request_goal>",
    "",
    "<conversation>",
    indentBlock(formatHunsuDraftConversation(input.messages), 2),
    "</conversation>",
    "",
    "<latest_user_message>",
    indentBlock(input.userMessage, 2),
    "</latest_user_message>",
    "",
    "<response_rules>",
    "Answer naturally and briefly.",
    "If you edited .hunsu-request files, summarize the changed files and the intended runtime change after running the Draft check command.",
    "If the requested change cannot be represented in the provided .hunsu-request runtime files, say which runtime file or schema is missing.",
    "If more detail is needed, ask a focused follow-up question.",
    "Do not output JSON unless the user explicitly asks for an example.",
    "</response_rules>"
  ].join("\n");
}

function renderProviderGoal(input: StartRunInput, config: MemberConfig): string {
  const renderedPrompt = renderPromptTemplate(config.promptTemplate, providerPromptTemplateContext(input));
  if (isHunsuDraftInput(input)) {
    return truncateText([
      "Objective: discuss a HUNSU draft with the user.",
      `Source: ${input.sourceSnapshot.teamName ?? "Team"} ${input.sourceSnapshot.moveOrdinal !== undefined ? `M${String(input.sourceSnapshot.moveOrdinal).padStart(4, "0")}` : input.sourceSnapshot.sourceNodeId}`,
      isHunsuDraftTurnInput(input) ? `User request: ${input.userMessage}` : "Status: preparing the Draft chat session before the first user message.",
      renderedPrompt.trim() ? `Instructions:\n${renderedPrompt.trim()}` : undefined
    ].filter(Boolean).join("\n\n"), 4000);
  }
  if (isMemberPathRunInput(input)) {
    const parts = [
      `Objective: ${input.memberPath.goal}`,
      renderedPrompt.trim() ? `Member:\n${renderedPrompt.trim()}` : undefined
    ].filter(Boolean);
    return truncateText(parts.join("\n\n"), 4000);
  }
  const parts = [
    `Objective:\n${formatTeamGoal(input)}`,
    `Instructions:\n${renderedPrompt.trim() || DEFAULT_TEAM_INSTRUCTION}`
  ].filter(Boolean);
  return truncateText(parts.join("\n\n"), 4000);
}

function teamInstructionFor(input: StartRunInput, protocol: HarnessSnapshot): string {
  const prompt = renderPromptTemplate(protocol.team.promptTemplate, teamPromptTemplateContext(input, protocol)).trim();
  if (!prompt) {
    return DEFAULT_TEAM_INSTRUCTION;
  }
  return prompt;
}

function teamPromptTemplateContext(input: StartRunInput, protocol: HarnessSnapshot): Record<string, unknown> {
  const selectedDestinations = selectedDestinationsForPrompt(input);
  return {
    requestGoal: input.requestGoal,
    currentDestination: selectedDestinations[0] ?? selectedDestinationForPrompt(input),
    currentDestinations: selectedDestinations,
    selectedDestinations,
    activeDestinations: input.activeDestinations,
    constraints: futureConstraintsForPrompt(input),
    members: protocol.members.map(member => ({
      id: member.id,
      promptTemplate: member.promptTemplate.template,
      model: member.model,
      reasoningEffort: member.reasoningEffort,
      serviceTier: member.serviceTier,
      skills: member.skills.map(skill => skill.name),
      plugins: member.plugins.map(plugin => plugin.id)
    }))
  };
}

function memberPromptTemplateContext(input: MemberPathRunInput): Record<string, unknown> {
  const selectedDestinations = selectedDestinationsForPrompt(input);
  return {
    requestGoal: input.requestGoal,
    pathGoal: input.memberPath.goal,
    memberPath: input.memberPath,
    dependencyOutputs: input.dependencyOutputs ?? [],
    worktreeStatus: input.worktreeStatus,
    worktreeDiff: input.worktreeDiff,
    attemptTranscript: input.attemptTranscript,
    evaluationFeedback: input.attemptTranscript,
    currentDestination: selectedDestinations[0] ?? selectedDestinationForPrompt(input),
    currentDestinations: selectedDestinations,
    selectedDestinations,
    activeDestinations: input.activeDestinations,
    constraints: futureConstraintsForPrompt(input),
    sourceMoveId: input.sourceMoveId,
    targetMoveOrdinal: input.targetMoveOrdinal
  };
}

function providerPromptTemplateContext(input: StartRunInput): Record<string, unknown> {
  if (isMemberPathRunInput(input)) {
    return memberPromptTemplateContext(input);
  }
  if (isHunsuDraftInput(input)) {
    return {
      requestGoal: input.requestGoal,
      sourceSnapshot: input.sourceSnapshot,
      userMessage: isHunsuDraftTurnInput(input) ? input.userMessage : undefined,
      messages: isHunsuDraftTurnInput(input) ? input.messages : []
    };
  }
  return teamPromptTemplateContext(input, teamHarnessForInput(input));
}

function formatTeamGoal(input: StartRunInput): string {
  const selectedDestination = selectedDestinationForPrompt(input);
  const constraints = futureConstraintsForPrompt(input)
    .map(item => `- ${item}`)
    .join("\n");
  return [
    selectedDestination ? formatDestinationGoalForPrompt(selectedDestination) : `- ${input.requestGoal}`,
    constraints ? `Relevant constraints:\n${constraints}` : undefined
  ].filter((line): line is string => line !== undefined).join("\n\n");
}

function selectedDestinationForPrompt(input: Pick<StartRunInput, "selectedDestinationIds" | "activeDestinations">): Destination | undefined {
  const selectedId = input.selectedDestinationIds?.[0];
  if (selectedId) {
    return input.activeDestinations.find(destination => destination.id === selectedId);
  }
  return [...input.activeDestinations].sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0))[0];
}

function selectedDestinationsForPrompt(input: Pick<StartRunInput, "selectedDestinationIds" | "activeDestinations">): Destination[] {
  const selectedIds = input.selectedDestinationIds ?? [];
  if (selectedIds.length === 0) {
    const selected = selectedDestinationForPrompt(input);
    return selected ? [selected] : [];
  }
  const selected = new Set(selectedIds);
  return input.activeDestinations.filter(destination => selected.has(destination.id));
}

function futureConstraintsForPrompt(input: Pick<StartRunInput, "futureConstraints" | "board">): string[] {
  return input.futureConstraints && input.futureConstraints.length > 0
    ? input.futureConstraints
    : input.board.futureConstraints.map(constraint => constraint.constraint);
}

function formatDestinationGoalForPrompt(destination: Destination): string {
  const parts = [`- ${destination.title}`];
  if (destination.acceptanceCriteria && destination.acceptanceCriteria.length > 0) {
    parts.push(`  Acceptance: ${destination.acceptanceCriteria.join("; ")}`);
  }
  if (destination.constraints && destination.constraints.length > 0) {
    parts.push(`  Constraints: ${destination.constraints.join("; ")}`);
  }
  if (destination.notes?.trim()) {
    parts.push(`  Notes: ${destination.notes.trim()}`);
  }
  return parts.join("\n");
}

function formatMemberProfiles(members: MemberConfig[]): string {
  return members.map(member => [
    `  <member id="${xmlAttribute(member.id)}">`,
    "    <profile>",
    indentBlock(member.promptTemplate.template.trim() || "No profile.", 6),
    "    </profile>",
    "  </member>"
  ].join("\n")).join("\n\n") || "  <member id=\"default\">\n    <profile>\n      No profile.\n    </profile>\n  </member>";
}

function indentBlock(text: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return text.split("\n").map(line => line ? `${prefix}${line}` : "").join("\n");
}

function xmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatDestinationForPrompt(destination: Destination): string {
  const parts = [`- ${destination.title}`];
  if (destination.acceptanceCriteria && destination.acceptanceCriteria.length > 0) {
    parts.push(`  Acceptance: ${destination.acceptanceCriteria.join("; ")}`);
  }
  if (destination.constraints && destination.constraints.length > 0) {
    parts.push(`  Constraints: ${destination.constraints.join("; ")}`);
  }
  if (destination.notes?.trim()) {
    parts.push(`  Notes: ${destination.notes.trim()}`);
  }
  return parts.join("\n");
}

function formatHunsuSourceSnapshot(snapshot: HunsuDraftSourceSnapshot): string {
  return [
    `draftSessionId source line: ${snapshot.sourceLineId}`,
    `source node: ${snapshot.sourceNodeId}`,
    snapshot.sourceMoveId ? `source move: ${snapshot.sourceMoveId}` : undefined,
    snapshot.moveOrdinal !== undefined ? `position: M${String(snapshot.moveOrdinal).padStart(4, "0")}` : undefined,
    snapshot.teamName ? `team: ${snapshot.teamName}` : undefined,
    snapshot.summary ? `summary: ${snapshot.summary}` : undefined,
    "destinations:",
    snapshot.destinationSummaries.length > 0
      ? snapshot.destinationSummaries.map(destination => `- ${destination.id} [${destination.status}] ${destination.title}`).join("\n")
      : "- none"
  ].filter((line): line is string => line !== undefined).join("\n");
}

function formatHunsuDraftConversation(messages: HunsuDraftConversationMessage[]): string {
  if (messages.length === 0) {
    return "No prior draft conversation.";
  }
  return messages.map(message => {
    const label = message.role === "draft-agent" ? "Draft Agent" : message.role === "user" ? "User" : "System";
    return `${label}: ${truncateText(message.text, 1200)}`;
  }).join("\n\n");
}

function teamPlanningConfigFor(input: StartRunInput): MemberConfig {
  const protocol = teamHarnessForInput(input);
  return createDefaultMemberConfig("team", teamInstructionFor(input, protocol), []);
}

function moveFinalizerConfigFor(): MemberConfig {
  return createDefaultMemberConfig("move-finalizer", "Write a precise final MOVE commit message from the completed Execute diff and evidence.", []);
}

function hunsuDraftConfigFor(manager: ManagerConfig = createDefaultManagerConfig()): MemberConfig {
  const config = createDefaultMemberConfig(String(manager.id), manager.promptTemplate.template, manager.skills);
  return {
    ...config,
    promptTemplate: { ...manager.promptTemplate },
    plugins: manager.plugins.map(plugin => ({ ...plugin })),
    execution: { kind: "worktree_write", network: "enabled" },
    approval: { policy: "never" }
  };
}

function memberConfigFor(input: StartRunInput, executorId: string): MemberConfig {
  if (input.harnessGraph) {
    const member = getHarnessMember(input.harnessGraph, executorId);
    if (!member) {
      throw new Error(`Harness does not define required Member ${executorId}`);
    }
    return memberConfigFromMemberEntity(member);
  }
  const protocol = teamHarnessForInput(input);
  const member = getHarnessMemberConfig(protocol, executorId);
  if (!member) {
    throw new Error(`Harness ${protocol.kind} does not define required Member ${executorId}`);
  }
  return member;
}

function teamHarnessForInput(input: StartRunInput): HarnessSnapshot {
  if (input.harnessGraph) {
    return harnessSnapshotForTeam(input.harnessGraph, input.teamScopeId ?? input.harnessGraph.rootTeamId);
  }
  return input.harness ?? createDefaultHarness();
}

function threadOptionsForMember(member: MemberConfig): CodexRunnerThreadOptions {
  const options: CodexRunnerThreadOptions = {
    approvalPolicy: member.approval.policy === "on_request" ? "on-request" : "never",
    approvalsReviewer: member.approval.policy === "on_request" ? member.approval.reviewer : "user",
    networkAccessEnabled: member.execution.network === "enabled"
  };
  switch (member.execution.kind) {
    case "read_only":
      options.sandboxMode = "read-only";
      break;
    case "worktree_write":
      options.sandboxMode = "workspace-write";
      break;
    case "unrestricted":
      options.sandboxMode = "danger-full-access";
      break;
  }
  if (member.model && member.model !== "codex-default") {
    options.model = member.model;
  }
  if (member.reasoningEffort && member.reasoningEffort !== "default") {
    options.modelReasoningEffort = member.reasoningEffort;
  }
  return options;
}

function isMemberPathRunInput(input: StartRunInput): input is MemberPathRunInput {
  return "memberPath" in input;
}

function isHunsuDraftTurnInput(input: StartRunInput): input is HunsuDraftTurnInput {
  return "draftSessionId" in input && "sourceSnapshot" in input && "userMessage" in input;
}

function isHunsuDraftInput(input: StartRunInput): input is HunsuDraftSessionInput | HunsuDraftTurnInput {
  return "draftSessionId" in input && "sourceSnapshot" in input;
}

function createCodexEnvironment(env: ProcessEnvironment): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      next[key] = value;
    }
  }
  const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const workspaceBin = join(workspaceRoot, "node_modules", ".bin");
  next.PATH = [workspaceBin, env.PATH].filter(Boolean).join(delimiter);
  return next;
}

function truncateText(text: string, maxLength = 4000): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1)}...`;
}
