# Hunsu Codex plugin

## Package

The repository marketplace exposes `plugins/hunsu`. Its required manifest is `.codex-plugin/plugin.json`; `.mcp.json` binds the authenticated streamable-HTTP service. Bundled skills cover Project bootstrap, Node-scoped Runs, Coaching transitions, Events inspection, and sibling comparison/decisions.

The plugin authenticates through MCP OAuth, stores no permanent GitHub credential, and never writes `hunsu/state` directly.

## Project bootstrap context

`hunsu.projects.list` returns each authorized repository's v2 initialization status and an exact `expectedStateSha`. When `hunsu/state` is absent, that SHA is the current full default-branch head because the first CAS mutation creates the state branch from it. When `hunsu/state` exists without `.hunsu/v2`, the repository is still v2-uninitialized and the expected SHA is the existing state-branch head. No v1 file is decoded or migrated. For an initialized repository, Project context returns the current state head as both `stateHeadSha` and `repositoryState.expectedStateSha`.

Project initialization still requires an independently verified full root commit SHA, one exact initial Node Plan, a fresh logical idempotency key, the returned expected state SHA, and separate explicit user confirmation.

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

The Coach records a complete proposed Node Plan bound to the source SHA, source payload digest, proposed digest, and observed state head. Recording the proposal changes no Graph state. After separate explicit confirmation, the API verifies or creates the deterministic same-tree child commit and managed tag, then appends the confirmed Coaching child through state CAS.

## Recovery

- Stale state head: reload Graph context and reconcile the intended mutation; never overwrite the state ref.
- Stale or rejected Node: stop before editing and request a new source choice.
- Interrupted work: resume from the last checkpoint and existing Run branch.
- Push failure: keep the Run active and report the Git error; never claim completion.
- Result verification failure: inspect repository, branch, full SHA, and ancestry, then push the intended commit or fail the Run with evidence.
- Prepared Coaching ref with failed CAS: retry the same confirmation key and reuse the deterministic commit/ref.
- Lost webhook: bounded polling reconstructs the same projection from GitHub.

## Decision safety

Coach tools may record reviews, transition proposals, and comparisons. They cannot confirm a transition or apply selection/rejection. A comparison is advisory. Selection and rejection are independent user-confirmed mutations, operate on sibling result Nodes, and never create a merge edge.

The v2 plugin exposes no Goal or Runner directory tools and accepts no v1 aliases.
