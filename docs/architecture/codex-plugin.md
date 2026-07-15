# Hunsu Codex plugin

## Package

The repository marketplace exposes `plugins/hunsu`. Its required manifest is `.codex-plugin/plugin.json`; `.mcp.json` binds the authenticated streamable-HTTP service. Bundled skills cover Project bootstrap, Node-scoped Runs, Coaching transitions, Events inspection, recovery reads, Runner capability discovery, sibling-Run comparison, and coached-How experiments.

The plugin authenticates through MCP OAuth, stores no permanent GitHub credential, and never writes `hunsu/state` directly.

The OAuth grant is bound to the canonical MCP resource URI and the exact public client. Access tokens are short-lived. A refresh token belongs to one server-side family with a fixed session-lifetime expiry; every successful refresh atomically rotates it, and reuse of an older signed generation revokes the family. Refresh state stores the authorized context and token digests, never raw access or refresh tokens.

## Project bootstrap context

`hunsu.projects.list` returns each authorized repository's v2 initialization status and an exact `expectedStateSha`. When `hunsu/state` is absent, that SHA is the current full default-branch head because the first CAS mutation creates the state branch from it. When `hunsu/state` exists without `.hunsu/v2`, the repository is still v2-uninitialized and the expected SHA is the existing state-branch head. No v1 file is decoded or migrated. For an initialized repository, Project context returns the current state head as both `stateHeadSha` and `repositoryState.expectedStateSha`.

Before constructing the initial How, call the repository-scoped `hunsu.runner_capabilities.list` and then `hunsu.runner_capabilities.get` for the chosen exact `RunnerTypeLock`. Capability reads expose only display/schema metadata and availability, never executable code. Project initialization still requires an independently verified full root commit SHA, one exact initial Node Plan using that resolved capability, a fresh logical idempotency key, the returned expected state SHA, and separate explicit user confirmation. Player and Team are bundled capability examples, not the complete Runner type set.

## Runner capability reads

`hunsu.runner_capabilities.list` accepts repository scope plus bounded cursor/limit pagination. `hunsu.runner_capabilities.get` accepts repository scope and one complete `RunnerTypeLock`; it does not resolve partial keys or aliases. Results contain only the exact lock, display name, schema digest, native schema AST, and `runContractResolution: { status: "available" }`. They contain no executor contract, code, credential, session, or mutable handle. The same discovery boundary applies before any Coaching proposal changes How.

## Run handshake

```text
plugin calls hunsu.runs.start(sourceNodeSha, goalDigest)
  -> API resolves exactly one Goal and the source Node's Runner value
  -> API verifies Node integrity and creates the Run branch at sourceNodeSha
  -> API appends RunStarted
  -> plugin receives immutable RunContract v2
  -> Codex verifies repository, source SHA, branch, Runner contract, and tool policy
  -> Codex performs work, checkpoints, commits, and pushes
  -> plugin reports the full result SHA and criterion-linked evidence
  -> API verifies non-self ancestry and branch reachability
  -> API appends RunCompleted, the Run child Node, edge, and evidence atomically
  -> webhook/polling refreshes Graph and Events projections
```

`RunContract v2` contains the Project and Run identifiers, source Node SHA, exactly one immutable Goal value, the full immutable Runner value, repository owner/name, Run branch, resolved instructions, criteria, constraints, required evidence, tool policy, and lease. The caller cannot override the source SHA or Runner.

## Coaching handshake

The Coach records a complete proposed Node Plan bound to the source SHA, source payload digest, proposed digest, observed state head, required summary, and required rationale. Recording the proposal changes no Graph state. If How changes, the plugin first resolves its exact lock through `hunsu.runner_capabilities.list` and `hunsu.runner_capabilities.get`; it never copies an unverified payload or assumes Player/Team are exhaustive. After separate explicit confirmation, the API verifies or creates the deterministic same-tree child commit and managed tag, then appends the confirmed Coaching child through state CAS.

## Recovery

Coach and comparison recovery follows a bounded-list-then-exact-get contract. Review reads are `hunsu.coach.reviews.list` and `hunsu.coach.reviews.get`; proposal reads are `hunsu.coach.proposals.list` and `hunsu.coach.proposals.get`; comparison reads are `hunsu.alternatives.list` and `hunsu.alternatives.get`. List results locate recorded activity at one state head. Get results return the complete typed record and disposition. Alternative get requires the exact comparison discriminant plus `sourceNodeSha` for `sibling_runs` or `anchorNodeSha` for `coached_how_experiment`.

- Stale state head: reload Graph context and reconcile the intended mutation; never overwrite the state ref.
- Stale or rejected Node: stop before editing and request a new source choice.
- Interrupted work: resume from the last checkpoint and existing Run branch.
- Push failure: keep the Run active and report the Git error; never claim completion.
- Result verification failure: inspect repository, branch, full SHA, and ancestry, then push the intended commit or fail the Run with evidence.
- Prepared Coaching ref with failed CAS: retry the same confirmation key and reuse the deterministic commit/ref.
- Lost Coach response: use `hunsu.coach.reviews.list` followed by `hunsu.coach.reviews.get`, or `hunsu.coach.proposals.list` followed by `hunsu.coach.proposals.get`, at the latest exact state head before deciding whether the logical mutation needs a retry.
- Lost comparison response: use `hunsu.alternatives.list` followed by `hunsu.alternatives.get` with the explicit comparison type and anchor before retrying; never infer a comparison from Node cards alone.
- Lost webhook: bounded polling reconstructs the same projection from GitHub.

## Decision safety

Coach tools may record reviews, transition proposals, and comparisons. They cannot confirm a transition or apply selection/rejection. Every comparison is advisory and explicitly either:

- `sibling_runs`, for completed result Nodes with one shared structural parent; or
- `coached_how_experiment`, for completed results of the same Goal from an anchor and its direct confirmed same-tree Coaching children, whose source plans differ only in How.

The caller supplies the discriminant; the plugin never guesses it from topology. Every finding covers every included result Node. Selection and rejection are independent user-confirmed mutations over result Nodes, cannot share one confirmation, and never create a merge or convergence edge. Repeating a comparison under one cohort key does not authorize another selection.

The v2 plugin exposes no Goal or Runner directory tools and accepts no v1 aliases.
