# Domain Model

This document describes the intended Roadmap model in domain terms. Concrete
TypeScript names may lag during migration, but product and planning documents
should use the language below.

## Aggregates

### Roadmap

The Roadmap is the root projection for one managed repository.

It contains:

- requests or project briefs
- Team routes
- MOVEs
- Hunsus
- Skill Draft records
- artifact records
- Artifact Action definitions
- Action Run summaries
- Action Evidence records
- future route constraints

The Roadmap is reconstructed from reachable Git commits that contain the encoded
`.hunsu/` runtime bundle. Given a commit, decoding that bundle should produce
the same Roadmap state every time. Bridge caches and optional refs may accelerate
reconstruction, but they are not the source of truth.

The Roadmap is selected through a local Roadmap Registry entry in Studio, but
the registry is not part of the Roadmap aggregate.

### Team Route

A Team Route is one named line through the Roadmap graph.

It contains:

- route id
- Roadmap id
- Team name
- status
- root MOVE id
- current MOVE id
- recorded MOVE ids
- parent route id when created by Hunsu
- source MOVE id when forked

A route advances only through recorded MOVEs. A route fork never mutates its
source route.

### Route Node

A Route Node is the graph step between MOVEs. The graph shape is:

```text
MOVE -> Route -> MOVE
```

Every Route Node owns an AgentSession. Route kinds are:

- `Plan`: `PlanComp + AgentSessionRead`
- `Path`: `PathComp + AgentSessionRead`
- `HunsuDraft`: `HunsuDraftComp + AgentSessionRead + AgentSessionChat`

Execute progress is represented as:

```text
{T1} MOVE N -> Route(Plan) -> Route(Path)* -> {T1} MOVE N+1
```

Hunsu progress is represented as:

```text
{T1} MOVE N -> Route(HunsuDraft) -> {Gen.G} MOVE N
```

`Plan` and `Path` AgentSessions are read-only inspection surfaces. A
`HunsuDraft` AgentSession is interactive while the Draft is active. Approval
completes the Draft AgentSession, records the durable Hunsu-created Team
Route, and keeps the HunsuDraft Route node visible as the route log between the
source MOVE and the new Team MOVE.

### Team Snapshot

A Team Snapshot is immutable.

It contains:

- Team name
- MOVE count
- Destination snapshot
- Harness snapshot
- Member roster/config snapshot

Every MOVE owns one Team Snapshot. Hunsu creates a new Team Snapshot at
the same MOVE count.

### Destination

A Destination is a typed objective in a Team Snapshot.

Fields:

- id
- title
- acceptance criteria
- constraints
- priority
- notes
- status
- source
- created and updated metadata

Destination status values:

- pending
- claimed
- in progress
- reached
- blocked
- superseded
- canceled

Destination changes are snapshot changes. They should not be stored as mutable
global state.

Open Destinations form a queue for a Team Snapshot. The queue head is the
only Destination that an Execute may digest. Changing which Destination is next is
a Hunsu change, normally by reprioritizing or rewriting the Team Snapshot; the
Execute UI must not expose arbitrary queue reordering.

### Harness

A Harness is the immutable execution model for a Team Snapshot.

Common fields:

- kind
- budget
- guardrails
- Team orchestration prompt
- Members

Built-in kinds:

- `team_execution_plan`
- `role_squad`
- `council_vote`
- `court_debate`

Only `team_execution_plan` is executable in the first runtime. Its executable
contract is a closure-free `ExecutionPlan` format.
Planned Harness kinds can be represented in snapshots but must be rejected
before Execute start until ExecutionPlan dispatchers exist.

### Member

A Member defines one executable capability available to a Team.

Fields:

- id
- prompt and instructions
- Skills
- model
- reasoning setting
- service tier
- execution constraint
- approval constraint

Member-targeted commands must reject unknown Member ids before writing
events.

### ExecutionPlan

An ExecutionPlan is a closure-free executable continuation emitted by the Team
for an Execute. It is data that Hunsu Bridge interprets, not JavaScript source and
not an agent-owned closure.

Initial executable shapes:

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
  | GoalNeedsEvaluation
  | GoalNeedsExecution;

type GoalNeedsEvaluation = {
  kind: "goal";
  stage: "needs_evaluation";
  id: PathId;
  assignee: { executorId: ExecutorId; goal: string };
  evaluator?: { executorId: ExecutorId; prompt: string };
  remainingAttempts: number;
  requires: PathId[] | "PrevMove";
};

type GoalNeedsExecution = {
  kind: "goal";
  stage: "needs_execution";
  id: PathId;
  assignee: { executorId: ExecutorId; goal: string };
  evaluator?: { executorId: ExecutorId; prompt: string };
  remainingAttempts: number;
  evaluationPathId: PathId;
  evaluation: { type: "fail"; reason: string; feedback: string; nextGoal?: string };
  requires: PathId[];
};
```

`QueueExecutionPlan` composes other executions in order. `GoalExecutionPlan`
delegates to one assignee Executor and may include one evaluator Executor.
If the assignee is a Team, Bridge creates a Plan route and asks that Team planner
to emit the next scoped ExecutionPlan using only direct Membership profiles. If
the assignee is a Member, Bridge creates a Path route and runs one Codex turn in
that Member's prepared environment. `needs_evaluation` dispatches exactly one
evaluator turn when an evaluator is present. A failed evaluation writes
`needs_execution` with evaluator feedback captured as explicit data.
`needs_execution` dispatches exactly one assignee turn, then writes the next
`needs_evaluation` continuation with the decremented `remainingAttempts`.

Every ExecutionPlan dispatcher must follow this agent-unit rule: one
interpreter step may dispatch at most one agent turn before returning
`next`, `done`, or `fail`. If a future ExecutionPlan kind needs multiple agent
turns, model each turn as an explicit stage or OR-type continuation instead of
storing a JavaScript closure or opaque agent state.

Member Paths still appear as the provider-turn and Path-commit record shape:
each evaluator or executor turn receives a focused Member Path prompt, and
Hunsu records a Path commit after Bridge has written the next
`.hunsu/current-execution.hunsu` state or removed it for finalizer-ready state.
Path commits are automated execution commits. They record the Path id, Member
id, Path goal, and dependencies so the direct Git history remains debuggable.
They may be empty-tree commits when a Path only verifies, inspects, or records
evidence after an earlier Path changed the product tree.

### Skill Snapshot

A Member Skill Metadata entry is immutable skill binding data on a Member.

Variants:

- `local-snapshot`: existing immutable skill-folder content with `name`,
  `sourcePath`, `contentHash`, `snapshotRef`, and optional `snapshotFiles`.
- `registry-package`: a locked registry package. v1 supports
  `registryKind: "apm"` with `registry`, `package`, exact `version`,
  `integrity`, and `contentHash`.
- `skillMeta`: metadata for installing one Codex Skill with
  `npx skills add <source> --skill <name> --agent codex` before runtime
  materialization.

Runtime materializes Member Skill Metadata into `.agents/skills/<skill-name>/`
before a Path starts. Bridge snapshots use stored `snapshotFiles`; APM registry
packages are fetched by exact version and verified against the lock. `skillMeta`
entries are installed into a staging workspace, then copied through the same
Hunsu-managed materialization path as other Member Skills.

### Skill Draft

A Skill Draft is mutable authoring state before Skill Snapshot acceptance.

It can be created, reviewed, accepted, or discarded. Accepting a draft happens
through Hunsu and creates a new Team Snapshot with the accepted Skill
Snapshot bound to a Member.

### MOVE

A MOVE is a durable Roadmap position.

Fields:

- id
- route id
- source MOVE id
- target MOVE id
- Team name
- MOVE count
- Team Snapshot
- outcome
- commit
- reached Destination ids (`reachedDestinationIds` wire array; exactly one for
  `Arrived`, empty for `Accident`)
- evidence
- risks
- failure reason when applicable
- conversation reference
- worktree reference
- action evidence references

Outcomes:

- `Arrived`
- `Accident`

`Arrived` advances the route and marks exactly one selected Destination as
reached. A MOVE digests the current queue-head Destination. If several
Destinations are open on the same Team Snapshot, Studio may display the queue
for context, but only the queue head can be started as an Execute. Reordering the
queue requires Hunsu.
`Accident` records a terminal failed result for that route position.

For Arrived MOVEs, `commit` points to the MOVE N+1 commit created after the
terminal Path commit, not to the terminal Path commit itself. The MOVE commit
may have the same tree as the terminal Path commit; its role is to preserve a
human-readable summary, evidence, risks, and metadata-only previous execution
record while keeping the Path commits in the direct parent history for
debugging.

### Execute

An Execute is runtime state, not the durable Roadmap result.

Fields:

- Execute id
- route id
- source MOVE
- target MOVE count
- selected Destination ids (`selectedDestinationIds` wire array; exactly one)
- status
- current ExecutionPlan
- Member Path statuses and outputs
- Path commit map
- terminal Path commit
- finalizer output
- worktree reference
- conversation reference
- attempt count
- budget

Execute statuses are UI/runtime statuses. The durable result is the resulting
MOVE.

An Execute must have exactly one selected Destination: the current open
Destination queue head. Bridge may auto-select that queue head when the start
request omits an explicit selection. Explicit multi-Destination starts and
explicit starts for any non-head Destination are invalid.

The worktree reference includes the base ref used to create the Route worktree.
That base ref is part of the route semantics: the next Execute after `MOVE N`
starts from `MOVE N`'s recorded commit, not from the control checkout's current
branch tip.

### Artifact Action

An Artifact Action is a durable Hunsu definition for derived work against one
MOVE or commit. It is encoded in `.hunsu/artifact-actions.hunsu`; changing it
requires a Hunsu transition.

Fields:

- action id
- title
- kind (`host` or `check` in v1)
- source scope
- declared environment variables
- runner command
- aliases for host actions
- optional evidence settings
- display order

Action Runs are local operational state. They record the selected source
commit, detached worktree, status, logs, exit code, alias URLs, and generated
evidence. Runs do not mutate the source artifact.

### Artifact Action Alias

An Artifact Action Alias is a stable name for an externally visible surface
created by a `host` action.

Examples:

- `web`
- `api`
- `storybook`
- `admin`

Users and E2E tests should address aliases rather than host ports. Concrete
ports are debug details.

### Artifact Action Evidence

Artifact Action Evidence records what happened when Hunsu hosted, checked, or
tested a selected source artifact.

Fields:

- evidence id
- Action Run id
- source MOVE id when available
- source commit
- alias URLs when available
- command and exit code
- health or check results
- screenshots, traces, reports, logs, or generated files
- created time

Durable evidence should be attached to the MOVE or commit that was exercised.
It is the basis for human comparison and Hunsu when a derived result is wrong.

### Hunsu

A Hunsu is a divergent intervention.

It always creates a new Team route at the same MOVE count as the source
snapshot. It records the checked request runtime snapshot and a list of changed
decoded runtime files. The request snapshot can change Destinations, Harness
configuration, Executors, Resources, and Artifact Actions because those are the
Draft-editable runtime files.

Executable TODOs, tasks, work items, follow-up work, and next steps are
Destinations. A user request such as "show Korea time on the main screen" should
be represented by editing `.hunsu-request/destinations.json`.

### HUNSU Draft

A HUNSU Draft is an interactive Route execution surface created from a selected
MOVE position. It uses the same Route graph concept as Plan and Path, but adds
chat and approval controls. The source artifact remains immutable; the Draft
Route records derived check and confirmation state in its own route worktree.

The session has one agent role: the Draft agent, configured by the resolved
Manager. It is conversational, explains, asks follow-up questions, and may edit
decoded request files in the Draft Route worktree.

Bridge creates two decoded top-level folders in the HUNSU Draft Route worktree:

- `.hunsu-prev/`: read-only decoded snapshot of the selected source node.
- `.hunsu-request/`: editable decoded request state.

The file-backed scope writes the same five runtime files to both folders:
`destinations.json`, `harness.json`, `executors.json`, `resources.json`, and
`artifact-actions.json`. The files use the same schema as the encoded runtime
files, but are readable JSON. `executors.json` is the source of truth for
Team and Member definitions. `resources.json` is the source of truth for
Skill bindings and Plugin requirements. `harness.json` stores locked root Team,
budget, guardrails, package locks, and route policy without embedding Executor
definitions. Bridge composes Harness, Executor, and Resource runtime state into
the resolved Team Snapshot at check, approval, and run boundaries. The Draft
agent asks Bridge to create a
DiffArtifact after editing `.hunsu-request`; Bridge validates both decoded
bundles, compares `.hunsu-prev` and `.hunsu-request`, records changed files with
git-style unified file diffs, records the request Team snapshot, and
regenerates the final encoded `.hunsu/*` state through the
confirmed Hunsu transition. The decoded request folders are
route-worktree draft surfaces, not durable Roadmap runtime files.

Draft Route fields:

- Draft session id
- Draft route id
- source Team route id
- source node id
- source MOVE id when the source is a recorded MOVE
- route worktree reference
- Draft agent session id
- agent session ids created by the Draft route
- source Harness artifact id
- current base artifact id
- resolved Manager snapshot
- optional Manager package lock
- provider thread id for the Draft agent conversation when available
- chat messages in the AgentSession/provider operational log
- latest DiffArtifact id when available
- ready Draft data for passing DiffArtifacts
- status

Studio displays the Draft as a compact Route node between the source MOVE and
the Hunsu-created MOVE position. Before approval the target MOVE does not exist;
after approval the same Route node remains as a completed route log connected to
the new Hunsu-created MOVE. The Route node has AgentSession chat. Raw chat
bodies remain AgentSession/provider operational data; compact Draft Route
metadata is encoded in `.hunsu/hunsu-draft.hunsu` and committed in the route
worktree after meaningful Draft state transitions.

At Draft start, Bridge stores the source Harness snapshot in a
content-addressed artifact cache and assigns a hash id. Bridge resolves the
selected Manager lock or built-in default Manager, records that Manager
snapshot in route runtime state, materializes only the Manager's Skills and
Plugins in the Draft worktree, writes the decoded baseline and request files
into the route worktree, writes the encoded route runtime state, and commits
only Bridge-owned `.hunsu`, `.hunsu-prev`, and `.hunsu-request` Draft files.

An approval-ready HUNSU Draft additionally has:

- HUNSU Draft id
- HUNSU id
- new route id
- target
- new Team name
- summary
- changed runtime files
- request Team snapshot
- conversation reference

HUNSU Draft statuses:

- draft
- ready
- confirmed
- discarded
- failed

Only approval records a Hunsu. Approval turns a passing, non-stale DiffArtifact
into a `ConfirmHunsuDraft` command in the main Roadmap runtime bundle. Discarding or
failing a Draft records terminal Draft Route state but creates no Hunsu, fork,
MOVE, or Team route.

### AgentSession

An AgentSession is the normalized Studio log for one Route node.

Fields:

- session id
- owner (`TeamPlan`, `ExecutionPlan`, `MoveFinalizer`, or `HunsuDraft`)
- route reference (`Route`) with route id, kind, source line/node, optional
  target node, and optional worktree
- provider thread or turn ids when available
- state
- normalized messages
- active item ids
- revision and timestamps

Execute runs and Hunsu Draft sessions reference AgentSessions by id. Bridge keeps a
common `agentSessions` registry so `/agent-sessions` can return Execute Plan/Path
and Hunsu Draft/Create sessions through the same API.

### Agent Conversation

An Agent Conversation is a reference to provider conversation state.

Fields:

- provider
- conversation hash
- provider thread id
- context hash
- worktree hash
- start and end times
- access modes

Access modes:

- `READ`
- `CONVERSE`
- `TRANSACT`

Team conversations expose read-only inspection to the user. Hunsu Draft agent
conversations can allow conversation and transaction while active.

## Bridge App Models

These models are local Studio state, not Roadmap history.

### Roadmap Registry Entry

A Roadmap Registry Entry lets Studio reopen a Roadmap by stable id.

Fields:

- Roadmap id
- display name
- canonical repository path
- last opened time
- last known branch
- health summary
- missing-path state

The Roadmap Registry Entry does not contain Team routes, MOVEs, Hunsus,
Team Snapshots, Skill Snapshots, Action Evidence, or conversation
transcripts. Those are loaded from decoded Hunsu commit state or artifact
records.

### Roadmap Session

A Roadmap Session is the runtime view of an opened Roadmap page.

Fields:

- Roadmap id
- loaded repository path
- loaded Roadmap projection
- selected MOVE id
- selected Execute id
- selected Artifact Action or Action Run id
- selected panel
- live stream connection state

Session fields are safe to encode in URL path or query parameters when useful,
but they are not durable protocol events.

## Invariants

- A MOVE is immutable after recording.
- A Team Snapshot is immutable after recording.
- A Hunsu never rewrites the source MOVE.
- A Hunsu always creates a new Team route.
- A route cannot record two outcomes for the same target MOVE count.
- A planned Harness kind cannot start an Execute until an ExecutionPlan
  dispatcher exists.
- Member request runtime changes must reference Members that exist in the
  request Harness snapshot.
- Skill Snapshot content must be immutable once attached to a Team Snapshot.
- Roadmap reconstruction must come from reachable Git commits and decoded Hunsu
  state.
- Roadmap Registry deletion must not delete Roadmap history.
- Roadmap View selection must be recoverable from URL plus Roadmap Registry,
  not only from React in-memory state.
- Artifact Action Runs are scoped to immutable source commits, not moving
  branch names.
- E2E evidence must identify the Action Run and alias URL it exercised.
- Host ports are implementation details; Artifact Action aliases are the
  product contract.

## Runtime State Storage

Roadmap state should be append-only and Git-backed, but the target storage model
is commit-local encoded state rather than required custom refs.

Each executable commit should contain:

```text
product files
.hunsu/destinations.hunsu
.hunsu/completed-destinations.hunsu
.hunsu/harness.hunsu
.hunsu/executors.hunsu
.hunsu/resources.hunsu
.hunsu/artifact-actions.hunsu
.hunsu/current-execution.hunsu
.hunsu/previous-execution.hunsu
```

`.hunsu/*` runtime files are app-owned opaque state. They may encode structured
JSON as `gzip + base64url` for the first implementation. The goal is not
secrecy; the goal is to prevent historical TODOs, digests, Harness
details, and execution metadata from becoming plain-text agent context. The app
decodes them to render the current prompt and updates them after agent-owned
turns end.

`.hunsu/previous-execution.hunsu` is metadata-only and belongs only to completed
MOVE commits. It records the Execute execution that produced the current MOVE:
ExecutionPlan lifecycle, session ids, Path commits, terminal Path
commit, and finalizer session reference. It does not store full Agent logs. A
HUNSU commit removes this file so divergent route state does not inherit the
previous MOVE's execution chain.

`.hunsu/current-execution.hunsu` belongs only to execution NODE commits. MOVE
commits and finalizer-ready NODE commits do not carry it.

`.hunsu/hunsu-draft.hunsu` belongs only to HUNSU Draft Route commits. It stores
compact Draft Route metadata, source/current artifact ids, Manager snapshot and
optional lock, status, latest check state, ready Draft data when available, and
confirmed ids after approval. It does not store raw chat message bodies.

Route branches should use ordinary branch refs:

```text
refs/heads/hunsu/main
refs/heads/hunsu/routes/...
```

Custom refs such as `refs/hunsu/events/...` or `refs/hunsu/moves/...` may exist
as migration aids or optional markers. They are not required in the target
model. The app should be able to rebuild MOVE, HUNSU, TODO, Harness,
run, and route indexes by scanning commits and decoding `.hunsu` runtime files.

The mutable repository checkout should not be treated as the durable Roadmap
database by itself. A committed tree containing `.hunsu` runtime files is the
durable unit.
