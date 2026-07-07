# Executable Runtime State

Hunsu treats a Git commit as an executable runtime state, not only as a file
snapshot.

```text
next commit = Hunsu runtime(current commit)
```

In practice the runtime is not purely deterministic because it can call an
agent, run tests, and observe external tooling. Hunsu still normalizes the
result into the next Git commit. The commit is the durable state transition.

## Commit Shape

A Hunsu-managed commit contains:

- product files
- opaque Hunsu runtime files under `.hunsu/`

The opaque runtime bundle is the source of truth for Roadmap runtime state. The
current split bundle contains pending Destinations, completed Destination
digests, Harness state, Executor definitions, Resource bindings, Artifact Action
definitions, an optional current execution continuation, an optional previous
execution record, and route-local Hunsu Draft metadata:

```text
.hunsu/destinations.hunsu
.hunsu/completed-destinations.hunsu
.hunsu/harness.hunsu
.hunsu/executors.hunsu
.hunsu/resources.hunsu
.hunsu/artifact-actions.hunsu
.hunsu/current-execution.hunsu
.hunsu/previous-execution.hunsu
.hunsu/hunsu-draft.hunsu
```

`.hunsu/current-execution.hunsu` exists only on execution NODE commits. It
stores a closure-free `ExecutionPlan` value that Hunsu Bridge can interpret:
`QueueExecutionPlan` for ordered composition and `GoalExecutionPlan` for an
executor/evaluator loop. Goal executions are staged so one interpreter step
dispatches at most one agent turn before returning the next continuation,
terminal success, or failure. It stores data, not JavaScript source or closures.
It does not pre-create Member Path records; those records are created only
when Bridge actually dispatches the next evaluator or executor turn.

`.hunsu/previous-execution.hunsu` exists only on completed MOVE commits. It is
metadata-only: Team plan lifecycle, Member Path lifecycle, provider session
ids, Path commits, terminal Path commit, and finalizer session reference. It
does not store full Agent transcripts or message bodies.

`.hunsu/hunsu-draft.hunsu` exists only on Hunsu Draft Route commits. It stores
compact route metadata: Draft route id, source line/node/MOVE, source/current
artifact ids, the resolved Manager snapshot, optional Manager package lock,
status, latest check state, ready Draft data when available, and confirmed
Hunsu/node ids after approval. Raw chat messages remain AgentSession/provider
operational data.

Hunsu Draft Route commits may also contain decoded draft surfaces outside the
encoded runtime bundle:

```text
.hunsu-prev/
.hunsu-request/
```

`.hunsu-prev` is Bridge-owned baseline state decoded from the selected source
runtime. `.hunsu-request` is the editable request runtime copy used by the
Draft agent. Both folders contain readable JSON copies of the runtime files
that are editable in v1: `destinations.json`, `harness.json`,
`executors.json`, `resources.json`, and `artifact-actions.json`.
Executor definitions are sourced only from `executors.json`. Resource
requirements and bindings are sourced only from `resources.json`.
`harness.json` stores the locked root Team, route policy, guardrails, package
locks, and Artifact Action references without embedded Executor definitions.
Bridge composes `harness.json`, `executors.json`, and `resources.json` into the
resolved `HarnessSnapshot` only at run, check, and Team snapshot boundaries.

These folders are committed only on the Draft Route branch so the requested
changes can be inspected and resumed; they are not durable Roadmap runtime
state. Draft agents edit `.hunsu-request/*` only. Product files, encoded
`.hunsu/*`, and `.hunsu-prev/*` are Bridge-owned and must not be edited by the
Draft agent. The Draft agent creates a DiffArtifact by asking Bridge to validate
`.hunsu-prev` and `.hunsu-request` against the runtime schemas and compare their
decoded contents. Confirm Hunsu requires a passing, non-stale DiffArtifact,
records the changed files and request Team snapshot, and regenerates encoded
`.hunsu/*` runtime files through the confirmed Hunsu transition.

The legacy monolithic `.hunsu/state.hunsu` may be decoded during migration, but
new commits write the split runtime bundle.

The payload may be encoded as `gzip + base64url` during the first implementation.
That is not security encryption; it is an anti-context-contamination boundary so
agents do not casually parse old TODOs, digests, or Harness details from plain text.
If Hunsu ever needs confidentiality, the same wrapper can move to real
encryption such as `age`.

## Ownership

Hunsu app owns `.hunsu/*` runtime files.

Agents should not inspect, decode, edit, or infer work from `.hunsu` runtime
files.
The app decodes it, computes the current TODO and Harness bundle, renders the
provider prompt, runs the agent, then updates and re-encodes the state after the
agent stops.

The exception is a Hunsu Draft agent operating in a Draft Route worktree: it may
edit files under `.hunsu-request/` when Bridge explicitly provides a file-backed
Draft surface. It still must not edit `.hunsu/` encoded runtime files,
`.hunsu-prev/`, or product files for that Draft turn.

```text
Hunsu app
  -> decode commit:.hunsu/* runtime bundle
  -> compute current TODO + Harness bundle
  -> prepare the Member Codex Environment in the worktree
  -> clear provider goal context for schema-bound agent turns
  -> plan or interpret current ExecutionPlan

Agent
  -> transform product worktree only
  -> use prepared Skill and Plugin resources when relevant
  -> do not read .hunsu files
  -> stop when the task is ready for validation

Hunsu app
  -> validate worktree
  -> collect transcript, checks, diff, evidence, and digest
  -> write, replace, or remove .hunsu/current-execution.hunsu
  -> update encoded Hunsu runtime files
  -> commit product diff + .hunsu runtime files
```

This keeps the convergent executor from treating historical TODOs or digests as
current instructions.

## MOVE And HUNSU

A MOVE is convergent execution:

```text
commit N -> agent run -> commit N+1
```

A HUNSU is divergent intervention. It changes the runtime state before the next
convergent run:

```text
commit K
  -> HUNSU changes TODO, Execution Instructions, prompt, constraints, Skills, or Team config
  -> intervention commit H
  -> Hunsu runtime continues from H
```

So HUNSU is not merely feedback. It is a state transition that changes how
future MOVEs are produced.

## Branches And Refs

The target model does not require custom Git refs.

Normal Git branches are enough to point at route heads:

```text
refs/heads/hunsu/main
refs/heads/hunsu/routes/route-h001
refs/heads/hunsu/routes/route-h002
```

Given a commit SHA, decoding the `.hunsu` runtime bundle always produces the
same Hunsu state. Therefore MOVE, HUNSU, TODO, Harness, and run indexes
can be rebuilt by walking branch history and decoding commits lazily.

`previous-execution.hunsu` forms a reverse linked list for completed MOVEs. The
current MOVE commit stores the Execute execution metadata that produced it and
points at the source MOVE commit. Hunsu can follow:

```text
MOVE N+1 commit
  -> .hunsu/previous-execution.hunsu.sourceMoveCommit
  -> MOVE N commit
  -> .hunsu/previous-execution.hunsu.sourceMoveCommit
  -> ...
```

A HUNSU commit is a divergent transition and removes
`.hunsu/previous-execution.hunsu`. That intentionally cuts the previous Execute
execution chain for the new route state.

Custom refs such as `refs/hunsu/*` may exist during migration or as optional
markers, but they are not the source of truth in the target model. If a marker
ref is missing, the app must be able to rebuild its view from commits.

## Bridge Cache

Hunsu may keep a local app cache for speed:

```text
~/.cache/hunsu/<repo-id>/index.sqlite
```

The cache can map:

- commit SHA to decoded state hash
- MOVE id to commit SHA
- HUNSU id to commit SHA
- route id to branch/head commit
- TODO id to latest relevant commit
- run id to base and result commits

This cache is an optimization only. Deleting it must not delete or corrupt the
Roadmap. Hunsu rebuilds it by scanning reachable commits and decoding
`.hunsu` runtime files.

## Commit Messages

Commit messages should not leak current or historical TODO text. Prefer stable
opaque summaries:

```text
Hunsu move M000124
path: verify (keria)
Hunsu intervention H000017
```

Path commits include Path id, Member id, Path goal, dependency trailers, and
other opaque orchestration metadata. A Path commit can be empty when the Path
only verifies or records evidence; empty does not mean the Member violated its
execution contract. The final MOVE commit is written after the terminal Path
commit, contains the finalizer-written message, and commits the updated `.hunsu`
runtime bundle including `previous-execution.hunsu`. Human-readable detail
belongs in that MOVE commit, decoded Hunsu state, and Studio views, not in the
automated Path commit text that agents may inspect during normal coding.

## Provider Goal

When the provider supports a goal API, Hunsu may mirror the current runtime
objective into the provider thread for turns without a structured output
contract. For Codex app-server schema-bound turns, Hunsu clears provider goal
state and relies on the `turn/start` prompt plus `outputSchema` instead:

```text
thread/start or thread/resume
thread/goal/clear
turn/start
```

Provider goal state is not Hunsu state. It can be a useful runtime mirror for
focus, token usage, goal status, and completion state, but it must not become a
second instruction channel for schema-bound Team or Member turns. The
durable source of truth remains the Git commit plus `.hunsu` runtime files.

## Hub Package Registry

Reusable Teams, Members, Managers, and Skills may be resolved from a registered
Origin. Origin is the immutable endpoint for published Hub package versions.
Hub is the web UX for discovering, editing, forking, and publishing those
packages through Executor Marketplace, Hunsu Marketplace, and Skills & Plugins.
The Roadmap commit is the source of truth for the resolved
`origin/kind/key/version/integrity` used by a specific run or draft session.

This lock lets the runtime verify the manifest before rendering prompts or
materializing skills. It also gives later readers a package-lock-style record
for reproducibility, tamper detection, debugging, and audit.

Codex Environment Preparation is a runtime step before Codex starts a thread.
Bridge writes Hunsu-managed `.agents/skills/<skill-name>/` folders and a
worktree-local `.codex/config.toml`, enabling only the Skills and Plugins
requested by the active Member Path or Hunsu Draft Manager. Team planning and
MOVE finalizer currently request no Skills or Plugins.
`local-snapshot` entries use stored snapshot files; APM `registry-package`
entries fetch and verify the exact locked package; `local-root-installed`
entries copy an already-installed local Codex Skill after Bridge verifies that
the name or source path resolves unambiguously; `skillMeta` entries install one
Codex Skill with `npx skills add <source> --skill <name> --agent codex` in a
staging workspace before Bridge copies the installed files into the managed
runtime environment. Missing local-root-installed resources or failed
`skillMeta` installs fail preparation before Codex starts, so Execute records an
Accident or Hunsu Draft records a failed Draft route instead of running with an
ambient environment. Skill content should not be copied into Member Path or
Manager prompts. The prompt nudges the execution agent with only Member or
Manager guidance, a focused goal, and minimal constraints; Hunsu orchestration
metadata stays in Bridge.

Member execution and approval permissions are part of the Harness
snapshot, not runtime heuristics. `read_only`, `worktree_write`, and
`unrestricted` constraints declare sandbox shape and network access. The
separate approval constraint declares whether sandbox-boundary requests are
blocked, sent to the user, or delegated to Codex app-server auto-review. Team
planning and MOVE finalizer turns remain read-only/never; only Member Paths can
receive worktree-write or unrestricted execution, and the Route worktree is the
only writable root for worktree-write mode.

Team planning is nudged the same way. The Team receives a thin planning
manifest with role instructions, the selected goal, and Member profiles, then
returns a structured ExecutionPlan. Hunsu runtime names, locks, path metadata,
provider goal context, and encoded state stay outside the agent-facing prompt.

Artifact Action setup is similarly explicit runtime state. Default Roadmap
creation does not create host/check actions. Those definitions are introduced by
accepted Hunsu transitions when the Roadmap needs hosting, checks, reports,
exports, or deploy-candidate work.

Origin bindings are committed runtime metadata. Environment variables may
provide local credentials or process settings, but they must not silently
redirect a Roadmap to a different origin. Changing origin, kind, key, version,
or integrity is a HUNSU transition because it changes how future Teams execute
or how future Hunsu Draft Managers run.

Registry authentication, SSH transport, and advanced publish flows are future
work. They do not change the rule that older commits must remain verifiable by the
schema-specific integrity algorithm they recorded.
