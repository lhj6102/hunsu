# Ubiquitous Language

Hunsu uses a small product language. These words are not generic UI labels.
They are the terms the product, CLI, protocol, Studio control plane, and design
documents should use consistently.

## Hunsu Product

Hunsu is the overall product.

Users install Codex and Hunsu locally, start Hunsu Bridge, and then use the Hunsu
web product to work in Studio or Hub. The web product can show Hub discovery
without a Bridge connection, but Studio actions require Bridge to be available.

## Studio

Studio is the Hunsu product area for Roadmap execution and Hunsu Draft work.

It owns the Roadmap, Destination, Execute, MOVE, HUNSU, Executor, and runtime
views. Studio can open Hub pickers or editors when the user wants to apply or
change a Team, Member, Manager, Skill, or Harness lock, but the resulting
Destination, Harness, Executor, Resource, or Manager changes are recorded
through the Hunsu runtime.

## Hub

Hub is the Hunsu product area for discovering, editing, forking, and publishing
marketplace packages.

Hub has three top-level areas:

- Executor Marketplace: Team and Member packages for Execute.
- Hunsu Marketplace: Manager packages for Hunsu Draft behavior.
- Skills & Plugins: independent Skill packages and Plugin requirement resources
  imported by Teams, Members, and Managers.

Hub is a marketplace and builder UX. It helps users understand reusable
Executors, Managers, and Skills & Plugins, modify them, and publish new
immutable versions. Hub is not the local runtime and does not directly control
Git, Codex, worktrees, or Action Runs.

## Bridge

Bridge is the installed localhost runtime started from the user's machine.

Hunsu Bridge App is the primary way to start Bridge for ordinary users. The
advanced `npx @hunsu/bridge@latest` launcher remains available for developers
and recovery. Once Bridge is running, it owns access to Git repositories, Codex
app-server, Route worktrees, Artifact Actions, and Bridge control APIs. Hunsu
Web checks Bridge readiness before enabling Studio actions that mutate a
Roadmap or start an Execute.

## Origin

Origin is the endpoint that stores and serves immutable Team, Member, Manager,
and Skill package versions.

Roadmap state records only minimal Origin reference metadata such as
`origin/key/version/integrity`. The Hunsu runtime resolves those references
before building the agent execution environment. Origin is not the Hub UX and
not the Bridge runtime.

## Roadmap

A Roadmap is the user's repository-level route map.

It contains one or more Team routes, each represented as a graph of MOVEs.
The Roadmap is reconstructed from reachable Git commits that contain encoded
Hunsu runtime state, not from mutable workspace files.

Studio should feel like a Roadmap app without hiding the active repository in
React-only state. The launcher lists recent Roadmaps and lets the user open or
create one. Once opened, the URL addresses the selected Roadmap through a stable
Roadmap id and the main canvas shows that Roadmap's route graph.

## Studio Launcher

The Studio Launcher is the start screen at `/`.

It is the place to:

- open an existing Roadmap folder
- create a new Roadmap in a new folder
- port an existing Git project into Hunsu
- reopen a recent Roadmap
- repair or remove missing local registry entries

The Launcher is local app state. It is not part of the Roadmap history and does
not create domain events until the user initializes or creates a Roadmap.

## Hunsu Port

Hunsu Port is the onboarding action that turns an existing Git project into a
Hunsu-ready Roadmap.

Opening a Git folder only inspects or registers the folder. Porting is the
explicit migration step that creates the contracts Hunsu needs to evaluate the
project:

- encoded Hunsu runtime bundle under `.hunsu/*.hunsu`
- Initial Team and Destination state
- optional Artifact Action definitions in later Hunsu transitions
- declared environment variables for any configured action
- host aliases and check commands when the Roadmap needs them

Porting should be safe and reviewable. It may propose changes to project files
when ports, hosts, or proxy targets are hardcoded, but those changes are part of
the port plan and should be applied explicitly.

Create Roadmap uses the same end state as Port, but starts from a new managed
project folder instead of adapting an existing repository.

## Roadmap Registry

The Roadmap Registry is a local user-level index of Roadmaps Hunsu Web can
reopen.

It maps a stable `roadmapId` to a canonical repository path and display
metadata. The registry exists so URLs, browser refresh, remote tunnels, and
multiple windows can reopen the same Roadmap without depending on in-memory
React state.

The Roadmap Registry can store:

- Roadmap id
- display name
- canonical repository path
- last opened time
- last known health summary
- missing-path state

The Roadmap Registry must not store the durable Roadmap graph. Selecting a
Roadmap causes Hunsu Bridge to read reachable commits, decode Hunsu state, and
reconstruct the Roadmap.

## Roadmap View

The Roadmap View is the URL-addressed Studio page for one opened Roadmap.

Canonical routes:

```text
/studio                         # Studio Launcher
/studio/open?path=<encoded-path> # resolve or register a folder, then redirect
/studio/roadmaps/<roadmapId>     # selected Roadmap UX
```

The Roadmap View can use query parameters for view state such as selected MOVE,
selected Execute, or visible panel. It must not use query parameters as the
durable Roadmap database.

## Execute Runtime

Execute is the convergent runtime.

Execute starts from a locked Harness and one selected Destination. It walks the
Harness's root Team, asks Teams to plan within their direct scope, asks Members
to perform focused work, and records the result as Plan routes, Path routes,
and finally a MOVE. Execute must not change Destinations, Harnesses, Executors,
Resource bindings, prompts, package locks, or Artifact Actions. Those changes
belong to Hunsu.

## Executor

An Executor is a unit that can receive delegated work.

```ts
type Executor = Team | Member;
```

Executors are Hub-publishable entities. A Team is a composite Executor. A
Member is a leaf Executor. Parent Teams see only direct Membership profiles;
they do not see grandchildren or inspect a child Team's internal Executor graph.

## Team

A Team is a composite Executor with a planner and direct Memberships.

The root Team is the Team bound to a Roadmap route by the active Harness. Nested
Teams are ordinary child Executors. A Team receives a goal plus the visible
profiles of its direct Memberships, then emits a closure-free ExecutionPlan
that delegates only to those direct Memberships.

Team display names are automatically assigned from a static pro-team seed list
when a Roadmap needs a human-facing route label. The name is a display label,
not a semantic capability.

Allowed Team behavior:

- digest the selected goal into an ExecutionPlan
- delegate only to direct Memberships visible in its planner scope
- split work into queued goals with assignee/evaluator Executors
- declare bounded execution and evaluation strategy
- report that a Destination is blocked or underspecified

Disallowed Team behavior:

- delegate to a grandchild Executor
- silently change Destinations
- silently change the Harness
- silently change Executor prompts or Resource bindings
- redefine the route objective
- remove requirements without Hunsu
- perform hidden work outside the emitted ExecutionPlan
- record final route outcomes directly

## Member

A Member is a leaf Executor inside a Harness.

Examples can use memorable names such as `Faker`, `Keria`, `Oner`, `Gumayusi`,
or `Ezreal`, but the name is only a label. The durable meaning comes from the
Member Config: prompt, instructions, Resource bindings, Plugin requirements,
model settings, reasoning setting, service tier, execution constraints, and
approval constraints.

A Member can implement, plan, test, review, integrate, verify acceptance, or do
any other work allowed by its config. An Inspector is not a required top-level
role. Inspection is a pattern: a Team may emit a Member Path whose goal is
to verify whether earlier Paths satisfy the selected Destination.

## Manager

A Manager is the Hub-publishable Hunsu Draft agent configuration.

Managers are not Executors and cannot be assigned in an ExecutionPlan. Hunsu
Draft resolves exactly one Manager for a draft session, records the Manager
snapshot and optional package lock in the Hunsu Draft route runtime, renders
the Manager promptTemplate into the actual draft prompt, and materializes only
that Manager's Skills and Plugins in the draft worktree.

Managers are used for divergent Hunsu work such as ideation, research, runtime
editing, and option synthesis. Execute remains convergent and uses only Teams
and Members.

## ExecutionPlan

An ExecutionPlan is the smallest durable execution continuation in an Execute. It
is stored as data under `.hunsu/current-execution.hunsu` on execution NODE
commits.

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
      assignee: { executorId: ExecutorId; goal: string };
      evaluator?: { executorId: ExecutorId; prompt: string };
      remainingAttempts: number;
      requires: PathId[] | "PrevMove";
    }
  | {
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

`QueueExecutionPlan` runs nested ExecutionPlans in order. `GoalExecutionPlan`
delegates a goal to one assignee Executor and may name an evaluator Executor.
When the assignee is a Team, Bridge creates a Plan route and runs that Team's
planner with only its direct Membership scope. When the assignee is a Member,
Bridge creates a Path route and runs one Member turn. Member Path records are not
created from the Team plan in advance. They are created only as Bridge interprets
the continuation and dispatches the next Team or Member turn.

Future ExecutionPlan kinds follow the same rule: one interpreter step dispatches
at most one agent turn, then returns `next`, `done`, or `fail`. Multi-agent
flows must be represented as explicit stages in closure-free data.

## Member Path

A Member Path is the provider-turn and Path-commit record created while
interpreting an ExecutionPlan.

```ts
type MemberPath = {
  id: PathId;
  executorId: string;
  goal: string;
  requires: PathId[] | PrevMove;
};
```

`requires` records local execution ordering for debugging. `PrevMove` means the
Path starts from the selected source MOVE instead of from another Member Path.
The Hunsu engine validates that every `executorId` exists in the active Harness
and is a Member before dispatching a Member Path.

The engine maintains a Path commit map while executing:

```ts
type PathCommitMap = Record<PathId | "PrevMove", Commit>;
```

`PrevMove` maps to the source MOVE commit. After each successful Member Path,
Hunsu records an automated Git commit for the Path and updates the map with
`path.id -> commit`. Path commits record the Path id, Member id, Path goal, and
dependencies as machine-readable trailers. Empty verification Paths still
receive a commit so execution progress remains inspectable.

A Member Path can create scratch work, run commands, produce evidence, and
return structured output according to the Member prompt. Hunsu records Path
status and outputs as Execute operational state. The final MOVE records durable
evidence and the resulting Team Snapshot, not hidden scratch state.

## Director

A Director is the divergent role that gives Hunsu.

The Director watches the Roadmap from the passenger seat. It can change
Destinations, Harness, route direction, Team prompts, Member
prompts, Skills, model settings, service tier, reasoning setting, or route
budget. A human is the primary Director. A trusted agent can act as Director
only when the system explicitly allows route-changing behavior.

Allowed Director behavior:

- add Destinations
- remove Destinations
- rewrite Destinations
- reprioritize Destinations
- change Harness
- rewrite Team or Member prompts
- add or remove Skills
- change model, reasoning setting, or service tier
- change attempt or round budgets
- create and accept Skill Drafts
- challenge a MOVE
- fork a Team route from a MOVE
- add future route constraints
- start a Hunsu Manager conversation
- confirm or discard a HUNSU Draft

The Director acts by creating a Hunsu, either directly through structured
controls or indirectly by confirming a HUNSU Draft prepared by a Hunsu Manager.
A conversation with a Hunsu Manager is not itself a Hunsu.

## Destination

A Destination is a typed objective the Team follows.

It is closer to a waypoint than a checkbox. A Destination can include
acceptance criteria, constraints, priority, and context. Destinations live
inside an immutable Team Snapshot. The active destination set is derived from
the selected Team's current MOVE.

A Destination can be:

- pending
- claimed
- in progress
- reached
- blocked
- superseded
- canceled

Destinations change through MOVE progress or Hunsu-created Team Snapshots,
not through hidden global mutation.

## Execution Instructions

Execution Instructions are sticky prompt text attached to a Team or Member in
a Harness.

They carry architecture notes, mistakes to avoid, domain rules, coding
preferences, evaluation rules, adversarial posture, and other guidance that
should persist across MOVEs. They are not Destinations and are not completed by
a MOVE. They change only through Hunsu.

## Skill

A Skill is a folder-level Codex skill resource.

A Skill is not merely a path string or prose field. Studio must be able to
query the folder contents, show the files, and pass the accepted Skill binding
to Bridge. A Harness binds Skills per Member by runtime metadata:
immutable `local-snapshot`, exact `registry-package`, `skillMeta` for
pre-runtime `npx skills add` installation, or `local-root-installed` for Skills
already installed in an allowed local Codex root. During execution, Bridge
prepares accepted Skills into the Route worktree as Codex skill folders,
normally under `.agents/skills/<skill-name>/`. Member Path prompts should not
inline Skill files.

## Member Codex Environment

A Member Codex Environment is the worktree-local Codex runtime surface Bridge
prepares before a Codex thread starts.

It includes Hunsu-managed `.agents/skills/<skill-name>/` folders and
`.codex/config.toml`. The config enables only the Skills and Plugins requested
for the current Team, Member Path, or MOVE finalizer phase and disables all
other discovered environment-affecting Skills and Plugins. It is runtime
preparation, not prompt text and not Roadmap state.

Team planning and MOVE finalizer phases currently use a no-skill/no-plugin
environment. Member Path phases use the active Member config.

## local-root-installed Skill

A local-root-installed Skill is a Member Skill binding that means: Bridge must
find an already-installed Codex Skill in an allowed local Codex root before the
session starts.

It does not permit the agent to install, discover, or choose a Skill during
execution. If the requested Skill is missing, duplicated by name, or ambiguous
by path, Bridge fails environment preparation before Codex starts.

## Member Plugin Binding

A Member Plugin Binding is a Member config entry that requests a Codex Plugin
by exact local config key, such as `github@openai-curated`.

Plugins are available only through `local-root-installed` bindings in v1. Bridge
enables requested Plugins in the worktree `.codex/config.toml` and disables all
other discovered Plugins before starting Codex.

## Environment Preparation Failure

An Environment Preparation Failure is a fail-closed Bridge runtime error before
Codex starts a thread.

Typical causes are a missing local-root-installed Skill, an ambiguous Skill
name, a missing Plugin, or a user-authored worktree `.codex/config.toml` that
Hunsu refuses to merge. The Execute records the failure as an Accident instead of
running with unpredictable ambient Codex resources.

## Skill Draft

A Skill Draft is a mutable workspace for editing a Skill before it becomes
history.

Skill Drafts are created when a Director wants to add or change a Skill. A
skill-edit subagent can work inside the draft, often using Codex's skill
creation workflow. The draft can be reviewed, edited, accepted, or discarded.
It is not part of the Roadmap until a Hunsu accepts it.

## Skill Snapshot

A Skill Snapshot is the immutable accepted form of a Skill folder.

It should be content-addressed by hash, Git tree, or equivalent snapshot
reference. Harness Member configs reference Skill Snapshots, not
mutable working folders.

## Harness

A Harness is the immutable execution model inside a Team Snapshot.

It answers "which locked root Team, Executor graph, Resources, and guardrails
should Execute use for this Destination?" rather than "where should the Team
go?" Destinations define the objective. The Harness defines the locked root
Team, Executor entities, Resource entities, Skill and Plugin requirements,
model/runtime policy, guardrails, budgets, and Artifact Actions used to turn a
Destination into a MOVE.

In Hub and Origin, Teams, Members, Managers, and Skills are versioned package
formats. In a Roadmap, a Harness locks Team, Member, and Skill package versions
and composes them into the immutable Execute model. Manager locks belong to
Hunsu Draft sessions, not ExecutionPlans.

Initial built-in Harness kinds:

- `team_execution_plan`: default Team plus ExecutionPlan interpretation.
- `role_squad`: Member cooperation with planner, implementer, reviewer, and
  integrator Members.
- `council_vote`: Member voting with voter Members and a coordinator Member.
- `court_debate`: Member debate with builder, breaker, and judge Members.

Guardrails are not a Harness kind. They are common immutable Harness
settings that validate inputs, outputs, context, artifacts, or final evidence
before they move between Member Paths or into the final MOVE record.

## Harness Lock

A Harness Lock connects runtime execution to Hub package locks and local
Resource locks.

```text
Destination -> Harness -> HubPackageLock[]
```

Each package lock records:

- origin
- key
- version
- integrity

Execute uses Harness locks to resolve exact Team, Member, and Skill package
versions before it starts. Hunsu Draft uses a Manager lock or built-in default
Manager outside the ExecutionPlan. Changing either kind of lock changes future
runtime behavior and must be a HUNSU state transition.

## Member Config

A Member Config is the Harness's immutable configuration for one
Member.

It contains:

- Member prompt and instructions
- Skills
- model
- reasoning setting
- service tier
- execution constraint:
  `read_only`, `worktree_write`, or `unrestricted`, each with network
  `disabled` or `enabled`
- approval constraint:
  `never`, `on_request/user`, or `on_request/auto_review`

Changing any of these fields is a Hunsu because it changes how future MOVEs
are produced.

## Worktree

A Worktree is the isolated filesystem workspace created for a Route.

Starting a Route creates a Git worktree and assigns it a stable worktree hash.
The source checkout remains the control plane. Team file edits happen inside
the Route worktree. Studio records only the resulting MOVE. The Route worktree
can be cleaned up after completion or retained for debugging.

The Worktree's Git base is the selected MOVE position. If the selected MOVE was
produced by a previous MOVE, the worktree starts from that previous MOVE's
recorded commit. If the selected MOVE was produced by HUNSU, the base resolves
through the copied source position. It must not default to the current main
branch once a previous MOVE commit exists.

## Executable Runtime State

Executable Runtime State is the Hunsu-owned state encoded inside a Git commit.

The target representation is a split `.hunsu/` runtime bundle. It contains
completed Destination metadata, pending Destination queue state, Harness
bundles, compatibility events, and optional completed MOVE execution metadata.
The app decodes it when it needs to compute the current task or rebuild the
Roadmap projection. Agents should not inspect, decode, edit, or infer work from
these files.

Given a commit SHA, decoding the `.hunsu/` runtime bundle should always return
the same state. That lets Hunsu treat Git commits as executable runtime inputs
and use a local rebuildable cache for fast lookup.

## Artifact Action

An Artifact Action is durable Hunsu state that declares derived work for one
MOVE or commit.

Hunsu creates it through an explicit Hunsu transition and stores it in
`.hunsu/artifact-actions.hunsu`. `host` actions start a long-running surface for
Studio, E2E, and human inspection. `check` actions run finite commands such as
E2E, lint, typecheck, security scans, reports, exports, or deploy candidates.

Artifact Action behavior:

- run from a specific MOVE or commit
- create a detached action worktree
- inject declared Hunsu-controlled environment variables
- expose named aliases for host actions
- run finite checks and collect exit status for check actions
- retain logs, screenshots, traces, reports, and status as Action Evidence
- stop or garbage collect operational Action Runs explicitly

An Action Run must not silently follow a moving branch or depend on a terminal
session's lifetime.

## Artifact Action Alias

An Artifact Action Alias is a stable name for an externally visible service in a
host action.

Examples:

- `web`
- `api`
- `storybook`
- `admin`

Users and tests address aliases, not host ports. Hunsu can map aliases to
random host ports internally, but Studio should present alias URLs as the
product contract.

## Artifact Action Evidence

Artifact Action Evidence is the recorded result of hosting, checking, or testing
a selected source artifact.

It can include:

- source MOVE or commit
- Action Run id
- alias URLs
- command, status, and exit code
- health or E2E status
- screenshots
- traces
- console errors
- network failures
- logs and generated reports

Action Evidence is the basis for human Hunsu when the derived product result
does not match the intended UX or behavior.

## MOVE

A MOVE is an immutable Team Snapshot at a MOVE count.

A MOVE is also the normal convergent state transition:

```text
commit N
  -> Team emits ExecutionPlan
  -> Hunsu interprets it through Member Path commits
  -> terminal Path commit is finalized into MOVE N+1
```

A normal route MOVE is produced by a completed Execute. Studio records one of two
outcomes:

- `Arrived`: successful convergent work; the MOVE reaches exactly one
  Destination.
- `Accident`: failed convergent work; the MOVE is terminal and cannot continue
  on that route.

Member Paths edit, inspect, test, or otherwise work in the Route worktree. A
Member Path can verify acceptance when the Harness requires that
shape. After all Paths complete, a MOVE finalizer agent compares the source MOVE
commit to the terminal Path commit and writes the MOVE N+1 commit message. The
control plane creates the MOVE commit after the terminal Path commit and records
the outcome. A MOVE appears on the Roadmap only after the MOVE commit has been
recorded.

Create Roadmap creates `MOVE 0`: the first immutable Team Snapshot without
reaching a Destination. A Hunsu can also create a same-position snapshot
without reaching a Destination. For example, a copy Hunsu from `T1 MOVE 2`
creates `Gen.G MOVE 2` with the same Destinations and Harness.

Every MOVE owns the full Team Snapshot at that point:

- Destination snapshot
- Harness snapshot
- Member roster/config snapshot
- Team name
- MOVE count

The MOVE count is local to the Team route. Normal execution advances by
starting an Execute for the next MOVE count. From `T1 MOVE 2`, the next attempt
is `T1 MOVE 3 Execute`. That Execute resolves to exactly one recorded outcome.

## Execute Run

An Execute is a running Team orchestration for a target MOVE count.

It starts from a selected MOVE, creates or receives a worktree, creates an Agent
Conversation, asks the Team to emit an ExecutionPlan, and interprets it through
Member Paths until the Harness reaches a terminal result or the budget is
exhausted.

An Execute has:

- Execute id
- source MOVE
- target MOVE count
- target Team name
- selected Destination queue head (`selectedDestinationIds` is a single-item
  wire array)
- Harness snapshot
- current ExecutionPlan
- Path commit map (`PrevMove` plus completed Path ids)
- Member Path status and output log
- Member Path agent session and provider turn references when available
- worktree hash
- Agent Conversation hash
- attempt or round budget

Execute is operational state. It is visible on the MOVE graph while active, but
the durable result is the resulting MOVE.

At most one Execute result can exist for a Team's target MOVE count. Once
`T1 MOVE 2` has a recorded outcome, Studio must not start another Execute for
that same Team route and count.

## Arrived

Arrived is the successful completion of an Execute.

The resulting MOVE carries forward the Harness, records concrete
evidence, and advances the Team route after all required Member Paths
complete, the Harness's terminal contract is satisfied, and the MOVE
finalizer has written the human-readable MOVE commit message.

## Accident

Accident is the failed completion of an Execute.

It records that the Team could not reach the selected Destination, or that
the Execute exceeded its budget before the ExecutionPlan reached the Harness's
terminal contract. The Accident MOVE can include evidence, failure
reason, Member Path outputs, and Agent Conversation reference for debugging,
but no further Execute may start from that route position. Retrying requires
Hunsu from the parent MOVE into a different Team route.

## Hunsu Intervention

A Hunsu is a divergent intervention that always creates a new Team.

It is not merely a comment. It clones a selected MOVE's immutable Team
Snapshot, optionally changes Destinations, Harness, or route direction,
and records a new Team at the same MOVE count. It does not rewrite the source
MOVE.

At the executable-state level, Hunsu changes the encoded runtime state before
future convergent execution. It can change the current TODO, prompt material,
Destinations, Harness, Execution Instructions, Team prompt, Member
configs, Skills, or route constraints. The source route is not rewritten; a new
route continues from the intervention state.

Examples:

```text
T1 MOVE 2
  -- Execute --> T1 MOVE 3 Execute
  -- Arrived --> T1 MOVE 3 Arrived

T1 MOVE 2
  -- Hunsu: add persistence destination --> Gen.G MOVE 2
                       -- Execute --> Gen.G MOVE 3 Execute
                       -- outcome --> Gen.G MOVE 3 Arrived or Accident
```

Retry is not a second Execute on the same recorded position. Retry means copy
Hunsu plus a new Execute. The copy Hunsu can contain no content delta; it still
creates a new Team so the repeated attempt has a separate route.

Hunsu can change:

- Destinations
- Harness
- Team orchestration prompt
- Member prompt or instructions
- Member model
- Member reasoning setting
- Member service tier
- Member Skills
- Skill Draft acceptance
- future route constraints
- route copy for retry
- MOVE challenge

## Hunsu Manager

A Hunsu Manager is an agent-assisted Director workflow.

The Manager starts from a selected MOVE and receives that MOVE's Team
Snapshot, Destinations, Harness, Team prompt, Member prompts,
Member Skills,
evidence, risks, and available Skill Snapshots. It talks with the user, prepares
a structured HUNSU Draft, and stops. It does not mutate the Roadmap directly.

The Manager's final response should say which new Team route would be created,
what changes are drafted, and whether the HUNSU Draft is ready for confirmation.
Studio performs the transaction after confirmation.

## Agent Conversation

An Agent Conversation is a provider conversation reference and debug view.

Teams, Hunsu Manager conversations, Skill Draft subagents, and future
agentic workflows all use Agent Conversations. The conversation hash lets
Studio show live logs, read-only replay, and later debugging without turning raw
chat logs into Roadmap state.

Access modes:

- `READ`: inspect transcript, events, and summaries.
- `CONVERSE`: append messages while active.
- `TRANSACT`: confirm or discard a prepared HUNSU Draft.

Team Execute conversations expose only `READ` to the user. Hunsu Manager
conversations expose `READ`, `CONVERSE`, and `TRANSACT` while active.
