# Codex Runner

The Codex runner uses `codex app-server` as the provider boundary for Team
planning turns and Member Path turns.

The runner owns provider-specific execution. Studio and protocol packages own
Roadmap state. Raw app-server messages are provider evidence for debugging and
resume; they are not Roadmap/Core state and do not directly mutate Destinations,
MOVEs, Hunsus, or Team Snapshots.

## Responsibility

The runner should:

- start a Codex thread
- create or receive a Route worktree
- run focused Team planning turns
- run Member Path turns inside the worktree
- stream typed app-server lifecycle events
- resume a prior thread
- stop or pause when Studio requests it
- surface final output and failure state
- return an Agent Conversation reference

It should not own Roadmap mutation. Destinations, Harnesses, MOVEs,
Hunsus, Team Snapshots, and Skill Snapshots belong to the protocol and core
layers.

## Runner Interface

Studio talks to a runner boundary rather than direct provider calls.

Target shape:

```ts
export type Runner = {
  runTeamPlanning(input: TeamPlanningInput): Promise<RunnerRun>;
  runMemberPath(input: MemberPathRunInput): Promise<RunnerRun>;
  runMoveFinalizer(input: MoveFinalizerInput): Promise<RunnerRun>;
  prepareHunsuDraftSession?(input: HunsuDraftSessionInput): Promise<RunnerRun>;
  runHunsuDraftTurn(input: HunsuDraftTurnInput): Promise<RunnerRun>;
  resumeRun(input: ResumeRunInput): Promise<RunnerRun>;
  pauseRun(runId: string): Promise<void>;
  stopRun(runId: string): Promise<void>;
  events(runId: string): AsyncIterable<RunnerEvent>;
};
```

The web app does not call the runner directly.

## App-Server Boundary

Hunsu Local constructs the default runner with `createDefaultCodexRunner()`.
That factory always creates a `CodexAppServerRunner`.

The app-server client manages a local `codex app-server --stdio` process. The
wire format is one JSON-RPC object per line on stdio. Hunsu Web does not expose
a browser-direct websocket to Codex. Unix sockets are an acceptable future
transport for Hunsu Local, but browser clients must continue to talk through
Hunsu Local APIs.

Lifecycle:

- start process and send `initialize`
- send `initialized` after the initialize response
- start or resume a provider thread with `thread/start` or `thread/resume`
- set the provider thread goal with `thread/goal/set` only for turns that do
  not already have a structured output contract
- clear any provider thread goal with `thread/goal/clear` before schema-bound
  turns
- start each provider turn with `turn/start`
- map app-server notifications into `RunnerEvent`
- capture final assistant text, token usage, provider thread id, and provider
  turn id
- interrupt active turns with `turn/interrupt`
- reject timed-out requests, clear pending requests on process exit, and restart
  the app-server process on the next request

The process command defaults to `codex app-server --stdio`. Deployments can set
`HUNSU_CODEX_APP_SERVER_COMMAND` and can override args with JSON or whitespace
syntax in `HUNSU_CODEX_APP_SERVER_ARGS`.

## Route Worktree

Studio creates an isolated Git worktree when a Route starts. The runner uses
that worktree as the execution surface for Team Plans, Member Paths, and
Hunsu Drafts.

The Route worktree has:

- source MOVE
- base ref: the selected MOVE position's recorded commit, or HEAD for MOVE 0
- target MOVE count
- Harness kind
- current ExecutionPlan
- worktree path
- worktree branch
- worktree hash
- Agent Conversation reference
- attempt count
- Member Path status and output log

Member Paths can edit files only in the Route worktree when their Member
config allows it. The source checkout stays available to Studio as the control
plane. When the Execute finishes, Studio records exactly one result:

- Arrived: the ExecutionPlan reaches the Harness's terminal contract,
  then a finalizer agent writes the MOVE commit message from the source MOVE to
  terminal Path diff, and Studio commits and records the successful target MOVE.
- Accident: the Execute exceeds its budget or cannot produce an acceptable
  result, then Studio records the failed target MOVE with evidence and failure
  reason.

Retry does not reuse that Execute. It requires Hunsu from the parent MOVE into a
new Team route.

## Harness Dispatch

The runner should dispatch by Harness kind.

The first executable implementation is `team_execution_plan`:

```text
Team planning turn
  -> uses Team orchestration prompt
  -> receives the selected Destination queue head and available Members
  -> emits ExecutionPlan

Hunsu engine
  -> validates the closure-free ExecutionPlan format
  -> materializes .hunsu/current-execution.hunsu on execution NODE commits
  -> interprets QueueExecutionPlan and staged GoalExecutionPlan continuations
  -> removes .hunsu/current-execution.hunsu when execution is finalizer-ready
```

Later built-in Harness kinds can use the same boundary:

```text
role_squad
  -> coordinating Team planner shapes the local plan
  -> implementer Member edits the worktree
  -> reviewer Member checks the result
  -> integrator Member prepares the finish state

council_vote
  -> voter Members produce independent verdicts or candidates
  -> coordinator Member applies the vote rule

court_debate
  -> builder Member argues that the result satisfies the Destination
  -> breaker Member challenges the result
  -> judge Member decides whether to continue or finish
```

Planned Harness kinds are data shapes until ExecutionPlan dispatchers exist.
Studio must reject them before creating an Execute.

## Codex Permissions

The app-server runner starts threads and turns with explicit permissions so
Hunsu does not depend on ambient Codex CLI defaults:

- Team planning and MOVE finalizer turns use app-server `readOnly`.
- Member turns use the sandbox mode declared by `MemberConfig.execution`.
  `worktree_write` keeps broader filesystem access constrained to the selected
  Route worktree.
- Member turns use the approval mode declared by `MemberConfig.approval`.
  `on_request` can ask the user or delegate to Codex app-server
  `auto_review`; `never` cannot cross the configured sandbox boundary.
- `networkAccessEnabled: false` keeps network access off unless a run or Local
  setting explicitly enables it.

Member Path turns use sandboxing and approval review from the Member config.
Studio does not infer sandbox policy from goal text. The execution constraint
declares filesystem and network reach:

```ts
type MemberExecutionConstraint =
  | { kind: "read_only"; network: "disabled" | "enabled" }
  | { kind: "worktree_write"; network: "disabled" | "enabled" }
  | { kind: "unrestricted"; network: "disabled" | "enabled" };
```

The approval constraint declares how Codex handles requests outside that reach:

```ts
type MemberApprovalConstraint =
  | { policy: "never" }
  | { policy: "on_request"; reviewer: "user" | "auto_review" };
```

`read_only` maps to app-server `readOnly`, `worktree_write` maps to
`workspaceWrite` with only the Route worktree writable, and `unrestricted` maps
to `dangerFullAccess`. `on_request/auto_review` maps to
`approvalPolicy: "on-request"` and `approvalsReviewer: "auto_review"`.
Team planning and MOVE finalizer turns remain read-only with
`approvalPolicy: "never"` regardless of Member config. The default Member
config is read-only/never; the empty-project Faker seed is worktree-write,
network disabled, and on-request with auto-review. Keria is also seeded with
worktree-write and network disabled so verification commands can write local
build artifacts without network access. Full access is available via
`unrestricted`, but it is never the default seed.
Studio creates and owns Route worktrees; the runner only executes provider
turns inside the supplied path.

Per-run options can override low-level runner values for local experiments, but
Member config is the durable source of truth for Member Path turns.

Model, reasoning setting, and service tier are not ambient runner settings.
They belong to the immutable Team or Member config for the current Harness.
The app-server runner maps config `model` to thread/turn `model`,
non-default reasoning setting to turn `effort`, and fast service tier to
app-server `serviceTier: "fast"`.

Hunsu uses app-server per-turn structured output for Team ExecutionPlan output,
Goal evaluator pass/fail output, and other Member outputs whose prompt requires
a schema.

## Nudge The Execution Agent

Member Path turns should nudge the execution agent toward focused work, not
teach it the Hunsu runtime model. Local keeps Member Path ids, Member ids,
dependencies, Harness locks, and Hunsu runtime state as orchestration
metadata. Those fields are not part of the Member Path prompt.

The Member Path prompt is a thin manifest:

```xml
<member>
{Member Prompt}
</member>

<goal>
{Focused execution goal}
</goal>

<constraints>
Do not read .hunsu files.
Do not create commits.
</constraints>
```

The prompt manifest is the primary contract. When a turn already has an
app-server `outputSchema`, Hunsu clears any provider thread goal before
starting the turn; goal context can create a second instruction surface that
competes with the schema-bound turn. Team planning remains the place where
Local asks for an ExecutionPlan; execution turns receive the already-selected
work.

## Member Codex Environment Preparation

Skills and Plugins are Codex runtime resources, not prompt text. Before each
Codex thread starts, Local prepares a worktree-local Member Codex Environment
for that phase:

- Team planning uses the default no-skill/no-plugin environment.
- Member Path turns use the active `MemberConfig.skills` and
  `MemberConfig.plugins` bindings.
- MOVE finalizer turns use the default no-skill/no-plugin environment.

Preparation writes Hunsu-managed Codex resources into the execution worktree
under:

```text
.agents/skills/<skill-name>/
.codex/config.toml
```

For `local-snapshot` skills, each `snapshotFiles[]` entry is written into that
skill folder after path validation. For `registry-package` APM skills, Local
fetches the exact `package@version`, verifies the `integrity`/`contentHash`
lock, then writes the fetched files. For `skillMeta` skills, Local runs
`npx skills add <source> --skill <name> --agent codex --copy --yes` in a
staging workspace, reads the installed Codex Skill files, and writes those
files into the Route worktree. For `local-root-installed` skills, Local resolves
the Skill from allowed local Codex skill roots and copies the resolved files
into the worktree. Missing, duplicated, path-ambiguous `local-root-installed`
Skills or failed `skillMeta` installs fail environment preparation before Codex
starts.

The generated `.codex/config.toml` enables only requested materialized Skills
and requested Plugins. Other discovered environment-affecting Skills and
Plugins are written with `enabled = false`. Local overwrites only files with
the Hunsu-managed marker; a user-authored worktree `.codex/config.toml` fails
closed instead of being merged. Local adds `.agents/skills/` and
`.codex/config.toml` to the worktree's Git exclude file so runtime preparation
does not enter Path or MOVE commits. The runner must not inline Skill files
into Member Path prompts.

## Provider Goal

Codex app-server exposes thread goal methods:

```text
thread/goal/set
thread/goal/get
thread/goal/clear
```

Hunsu should use `thread/goal/set` only for provider turns without a structured
output schema. Schema-bound turns first call `thread/goal/clear`, then use their
`turn/start` prompt and `outputSchema` as the whole agent-facing contract. This
keeps Team planning neutral: the Team receives the XML planning manifest and
returns the configured ExecutionPlan, without an additional persistent goal context
nudging it to inspect or execute the worktree.

Provider goal state is not Roadmap state. It is a runtime mirror for focus,
status, token usage, and completion tracking. The durable source of truth
remains the Git commit plus encoded Hunsu state.

## Approvals

Studio must not hang on provider approval prompts. Member config supports four
practical modes:

```text
read_only + never
worktree_write + never
worktree_write + on_request/auto_review
unrestricted + never
```

`on_request/user` is also valid when a Member should ask the human before
crossing its sandbox. `on_request/auto_review` is not a Hunsu approval engine;
it passes `approvalsReviewer: "auto_review"` to Codex app-server so Codex can
review eligible escalation prompts. If a server-initiated approval request still
reaches Hunsu directly, the client handles it defensively:

- command approvals are surfaced as status/error events and declined
- file-change and patch approvals are surfaced as status/error events and declined
- broad permission requests are surfaced, granted no new permissions, and the
  active turn is interrupted
- unsupported tool-input, MCP elicitation, auth-token refresh, dynamic-tool, or
  attestation requests receive a JSON-RPC error rather than waiting forever

This keeps approvals visible in the Execute event stream while preserving the
rule that Studio confirms domain transactions and the runner only executes
provider turns.

## Provider Status

Studio exposes app-server provider status through `GET /api/codex/status`.
For the app-server backend the runner initializes the client and calls:

- `account/read` with `refreshToken: false`
- `account/rateLimits/read`

The response is intentionally provider-shaped so Studio can explain auth and
rate-limit failures without treating account data as Roadmap state. If
app-server initializes but `account/read` or `account/rateLimits/read` fails,
the response remains available and includes `accountError`, `rateLimitsError`,
and a combined `error` field with the provider message.

## Team Prompt Contract

Team prompts should be intentionally thin. The Team plans a closure-free
`ExecutionPlan` from a goal and Member profiles. It does not need Hunsu runtime
locks, integrity hashes, prompt template dumps, or recording rules.

The Harness Team prompt is a `PromptTemplate`. The runner renders it
with request, selected Destination, future constraint, and Member profile
context before placing it in the Team prompt manifest:

```xml
<role>
  <purpose>
    Plan a closure-free executable ExecutionPlan.
  </purpose>

  <instructions>
    {render(Harness.rootTeam.planner.promptTemplate) || DefaultInstruction}
  </instructions>
</role>

<goal>
  {Selected goal, acceptance criteria, and relevant constraints}
</goal>

<member_profiles>
  <member id="{member.id}">
    <profile>{member.promptTemplate.template}</profile>
  </member>
</member_profiles>

<rules>
  Return one structured ExecutionPlan object.
  Use kind queue to run ExecutionPlan items in order.
  Use kind goal with stage needs_evaluation to delegate one assignee Executor.
  A goal assignee must name executorId and a standalone goal.
  A goal evaluator, when present, must name executorId and a prompt that can return pass or fail.
  Set remainingAttempts to the configured attempt budget unless a smaller bound is clearly enough.
  Set requires to PrevMove unless this goal intentionally depends on earlier Path ids.
</rules>
```

Member Path prompts also use `MemberConfig.promptTemplate`. The runner renders
that template with the Path goal, dependency outputs, worktree status/diff,
attempt transcript, selected Destination, and future constraint context before
starting the Member turn.

The Team turn uses app-server structured output, not inline schema prose. That
schema is the complete turn contract, so Team turns clear provider goal state
and do not call `thread/goal/set`. The agent-facing output is an object root
because Codex app-server rejects root array response schemas:

```ts
type ExecutionPlan =
  | QueueExecutionPlan
  | GoalExecutionPlan;

type QueueExecutionPlan = {
  kind: "queue";
  id: PathId;
  items: ExecutionPlan[];
};

type GoalExecutionPlan =
  | {
      kind: "goal";
      stage: "needs_evaluation";
      id: PathId;
      assignee: { executorId: string; goal: string };
      evaluator?: { executorId: string; prompt: string };
      remainingAttempts: number;
      requires: PathId[] | "PrevMove";
    }
  | {
      kind: "goal";
      stage: "needs_execution";
      id: PathId;
      assignee: { executorId: string; goal: string };
      evaluator?: { executorId: string; prompt: string };
      remainingAttempts: number;
      evaluationPathId: PathId;
      evaluation: { type: "fail"; reason: string; feedback: string; nextGoal?: string };
      requires: PathId[];
    };
```

Local interprets that value directly. `QueueExecutionPlan` pops completed heads
or replaces the head with a returned `NextExecution`; `GoalExecutionPlan`
separates evaluator and executor Members into agent-unit stages. The evaluator
stage runs one evaluator turn and writes `needs_execution` on fail. The executor
stage runs one executor turn and writes the next `needs_evaluation`
continuation. Every dispatcher must dispatch at most one agent turn per
interpreter step before returning `next`, `done`, or `fail`; future multi-agent
flows should add explicit stages instead of hidden closures.
Local does not expand the Team plan into concrete Member Paths up front.
Each Member Path is created only at the moment the interpreter chooses and
dispatches that evaluator or executor turn.

## Member Prompt Contract

Member prompts should be focused on one scheduled execution goal. The default
Member prompt is a thin manifest:

```xml
<member>
{Member Prompt}
</member>

<goal>
{Focused execution goal}
</goal>

<constraints>
Do not read .hunsu files.
Do not create commits.
</constraints>
```

Member Codex Environment resources are prepared in `.agents/skills/*` and
`.codex/config.toml`, not copied into the prompt. Path ids, dependency outputs,
worktree diffs, and retry transcripts are orchestration state unless a future
Member contract explicitly adds them.

The Member must not mutate Roadmap state or create Git commits. Hunsu records
the Path commit after the Member turn returns, including an empty Path commit
when the Member only inspected, verified, or produced evidence. Member
execution constraints are permissions, not obligations: `worktree_write` means
the Member may edit the Route worktree, not that every Path must change the
product tree. The terminal Member Path is the final execution boundary, not a
verdict contract. It does not receive a PASS/RETRY structured output schema,
and natural-language terminal output remains the Path output. Local derives
MOVE completion facts from the terminal Path run, provider session, Path commit,
selected Destination, and the source-MOVE-to-terminal-Path diff. If the
terminal Path leaves no product diff from the source MOVE to the terminal Path
commit, Local cannot promote it into an Arrived MOVE and records an Accident at
MOVE promotion time. Verification is represented as a Member Path, not as a
separate required Inspector role.

Studio records each Member Path output, provider thread or turn id, status,
and Path commit in the Execute log. Evidence and risks recorded on MOVEs are
Roadmap/Local/finalizer facts, not executor-supplied verdict fields.

## MOVE Finalizer Contract

The MOVE finalizer is a separate agent turn after all Member Paths complete
and Local validates that the terminal Path can become an Arrived MOVE. It
receives the source MOVE commit, terminal Path commit, changed paths, diff
summary, Path outputs, completion summary, and the selected Destination title
and acceptance details. It must return only the commit message content for MOVE
N+1. It must not edit files or create Git commits; Studio creates the MOVE
commit after the terminal Path commit and records that commit on the Roadmap.

Before the MOVE finalizer provider turn begins, Local prepares the default
Member Codex Environment with no requested Skills or Plugins. Member-specific
Skill and Plugin bindings apply only to Member Path turns.

## Hunsu Draft Prompt Contract

The runner can instruct Codex to act as the conversational Hunsu Draft agent
configured by a resolved Manager.

Local records the Draft agent turn in an `AgentSession(owner=HunsuDraft,
routeRef=Route, routeKind=HunsuDraft)`. That session is the Route inspector's
interactive chat log. Studio renders the app-server item lifecycle from that
AgentSession directly, including `reasoning`, `agentMessage`,
`commandExecution`, `fileChange`, `mcpToolCall`, and `webSearch` items. The
user-facing label for reasoning activity is `Reasoning`, and running items stay
visible with elapsed time so the Draft route does not look idle while the
provider is working.

The Draft agent receives the Hunsu Draft Route worktree path. It does not
operate in the control checkout. Local writes compact Draft Route
metadata to `.hunsu/hunsu-draft.hunsu` and commits only Local-owned `.hunsu`
runtime files in that route worktree after meaningful state transitions. The
route metadata includes the selected Manager snapshot and optional Manager
package lock. Raw chat message bodies remain AgentSession/provider operational
data.

The Draft agent runs with write access to the Draft Route worktree and may edit
only decoded request files under `.hunsu-request/`. It should still edit only
the file required by the user's explicit request. Destination/TODO changes use
`.hunsu-request/destinations.json`; Artifact Action changes use
`.hunsu-request/artifact-actions.json`. Harness changes use
`.hunsu-request/harness.json` only when the user explicitly asks to change the
Team planner, Harness policy, or root Executor graph. `harness.json` must not
contain Member definitions. Executor changes use `.hunsu-request/executors.json`
only when the user explicitly asks to change Team or Member definitions/config,
and that file is the Executor source of truth. Adding a Destination must not create,
copy, or update Executor bindings or assignment entries. The agent must not edit
`.hunsu/` encoded runtime files, `.hunsu-prev/`, product files, or create Git commits.
After editing request files, the agent runs the Local-provided Draft check
command to create a DiffArtifact.
That command uses a compact check-command response: it returns the
DiffArtifact id, final marker, changed file paths on success, and validation
errors on failure, not the full Draft, Board, or file diff payload. The Draft
Route worktree remains the source for raw request file inspection.

When a Hunsu Draft Route is created, Local may prewarm the Draft provider
thread before the first user message. That prewarm starts the thread, renders
the Manager promptTemplate into the provider goal, and sets the stable Draft
goal once. The first conversational turn should reuse the prepared
`providerThreadId` directly with `turn/start`; it should not perform a redundant
`thread/resume` or `thread/goal/set` unless direct reuse fails because the
provider thread is unavailable.

The Draft agent prompt should include:

- resolved Manager id and rendered Manager instructions
- selected MOVE id, Team name, MOVE count, and source commit
- selected MOVE's Destination and Harness snapshot
- evidence and risks from the selected MOVE
- current decoded request state and allowed request-file paths for file-backed
  Draft scopes
- current Roadmap context around parent, child, and sibling MOVEs
- Skill Draft status when the user is discussing Skills
- rule that the Draft agent must not mutate the Roadmap directly
- rule that `.hunsu-request/destinations.json`,
  `.hunsu-request/harness.json`, `.hunsu-request/executors.json`,
  `.hunsu-request/resources.json`, and `.hunsu-request/artifact-actions.json`
  are the editable decoded runtime files
- rule that simple TODO/Destination additions edit only
  `.hunsu-request/destinations.json`
- rule that `.hunsu-request/harness.json` is edited only for explicit
  Harness/root-Team policy requests and does not contain embedded Member config
- rule that `.hunsu-request/executors.json` is edited only for explicit Executor
  definition/config requests, not Team-planner assignment edits
- rule that `.hunsu-request/resources.json` is edited only for explicit
  Resource binding or requirement requests
- rule that new Destinations do not require Executor binding changes
- rule that encoded `.hunsu/*`, `.hunsu-prev/*`, and product files are
  Local-owned during a Hunsu Draft
- Local-provided Draft check command for creating a DiffArtifact
- rule that the final reply must include
  `::hunsu-diff{draftSessionId="..." diffArtifactId="..." status="pass|failed"}`
  after running the check command
- rule that confirmation is handled by Hunsu Local from the DiffArtifact id
- conversation permission mode

Local stores the original source Harness snapshot in an in-memory
content-addressed artifact cache when the Draft starts. Local also writes the
decoded `.hunsu-prev/` baseline and `.hunsu-request/` editable request surface
into the route worktree. Before provider startup, Local materializes only the
resolved Manager's Skills and Plugins into that Draft worktree. DiffArtifact
creation validates both decoded runtime bundles, compares `.hunsu-prev` and
`.hunsu-request`, builds `ReadyHunsuDraft` with changed files and the request
Harness snapshot, and dry-runs `ConfirmHunsuDraft`. Studio enables approval
only from a passing DiffArtifact card, and Local rejects approval if request
files changed after that artifact was created.
The confirmed transaction records Hunsu and leaves the HunsuDraft Route visible
as a completed route log between the source MOVE and the new Team MOVE.
Discarding leaves the Roadmap unchanged.

## Event Model

The runner maps app-server notifications into a small typed model behind its
adapter boundary. Studio keeps raw JSON-RPC notifications for debugging, but
the Execute Conversation renders from normalized turns, items, live status, and
assistant transcript state.

```text
thread/started or thread response       -> provider thread id evidence
turn/started                            -> runner.turn.started
turn/completed                          -> runner.turn.completed, runner.final, or runner.error
thread/tokenUsage/updated               -> usage evidence in raw app-server messages
item/started                            -> runner.item.started
item/delta                              -> runner.item.delta
item/completed                          -> runner.item.completed
app-server JSON-RPC notification        -> runner.appServer.message
error                                   -> runner.error
```

Codex app-server's generated schema is the source of truth for item timing.
`item/started` carries `startedAtMs`; `item/completed` carries
`completedAtMs`. Hunsu must treat that lifecycle timestamp pair as the canonical
elapsed-time source for every item. Some completed `ThreadItem` variants, such
as `commandExecution`, `mcpToolCall`, and `dynamicToolCall`, also carry
`durationMs`; that value is provider item metadata and is a secondary source
used only when a complete lifecycle timestamp pair is unavailable. Studio must
freeze the computed lifecycle duration when an item completes rather than
resetting the UI timer to `0s`.

The active event model is app-server shaped:

- `runner.status.changed`
- `runner.turn.started`
- `runner.turn.completed`
- `runner.item.started`
- `runner.item.delta`
- `runner.item.completed`
- `runner.appServer.message`
- `runner.final`
- `runner.error`

Assistant streaming comes from `runner.item.delta` where
`deltaKind: "agentMessage"`. The matching `runner.item.completed` event only
marks item completion; it must not create, append, or replace live transcript
body. If the provider sends only a completed full text without preceding delta
notifications, Studio treats that as reconcile metadata rather than fake
streaming.

Command items preserve app-server `commandActions`. Read, list, and search
commands are grouped as Exploring activity in Studio. Completion payloads may
omit metadata that was present on start, so Studio merges item lifecycle updates
without clearing `command`, `cwd`, `commandActions`, existing output, or raw item
evidence.

The target event store should normalize Team planning, Member Path, Hunsu
Draft agent, and Skill Draft conversation references without turning raw provider
notifications into Roadmap state.

## Conversation References

The runner returns provider thread and turn ids when app-server supplies them.
Studio stores Team planning and Member Path provider thread ids separately
in live run state, keeps the compatibility `providerThreadId`, appends provider
turn ids, and copies the primary Team provider thread id into the Execute
conversation reference for resume. Completed MOVE commits persist the same
metadata-only session references in `.hunsu/previous-execution.hunsu`; message
bodies remain provider/runtime data and are not replayed from Git.

The live Execute state also exposes the current ExecutionPlan, Path commit map,
terminal Path id, terminal Path commit, MOVE finalizer output, MOVE finalizer
commit, and per-Path run records. On MOVE completion, Studio writes a
metadata-only snapshot of those fields to `.hunsu/previous-execution.hunsu` so
server restart can rehydrate immutable Plan/Path UI without replaying Agent
transcripts.

## Limitations

- App-server protocol types are generated by Codex and can evolve. Hunsu keeps
  app-server parsing tolerant and stores raw notifications for debugging.
- Network remains off by default. Enabling it is explicit Member execution
  data or a local runner override. Approval review only decides whether to cross
  configured boundaries; it does not expand sandbox or network reach by itself.
