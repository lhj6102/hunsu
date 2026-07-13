# Hunsu Codex plugin

## Package

The repository marketplace exposes `plugins/hunsu`. Its required manifest is `plugins/hunsu/.codex-plugin/plugin.json`; `.mcp.json` binds the authenticated streamable-HTTP service; bundled skills cover Project, Goal, Run, Coach, and divergence workflows.

The plugin includes the valid `.app.json` scaffold required by the transition structure, but its `apps` map is intentionally empty because no registry-issued Hunsu app ID exists. The working authenticated integration is the direct MCP server binding; the repository never invents an external connector identity.

The plugin authenticates through MCP OAuth. It stores no permanent GitHub credential and never writes `hunsu/state` directly.

## Run handshake

```text
plugin calls hunsu.runs.start
  -> API validates Project, Goal, Runner, base SHA, and idempotency
  -> API creates the Run branch
  -> API appends RunStarted to GitHub state
  -> plugin receives immutable RunContract
  -> Codex verifies repository, base SHA, branch, and tool policy
  -> Codex performs work, checkpoints, commits, and pushes
  -> plugin reports the full result SHA and evidence
  -> API verifies branch reachability and base ancestry
  -> API appends the terminal event
  -> webhook/polling refreshes Web projections
```

`RunContract` contains the Project and Run identifiers, immutable Goal and Runner snapshots, repository owner/name, base SHA, Run branch, instructions, criteria, constraints, required evidence, and tool policy. A later Goal or Runner edit cannot change an active contract.

## Recovery

- Stale state head: reload the Project and reconcile the intended mutation; never overwrite the state ref.
- Stale base SHA: stop before editing and ask whether to start a new Run.
- Interrupted work: resume from the last recorded checkpoint and the existing Run branch.
- Push failure: keep the Run active and report the Git error; never claim completion.
- Result verification failure: inspect repository, branch, full SHA, and ancestry, then push the intended commit or fail the Run with evidence.
- Lost webhook: reconciliation and bounded Web polling rebuild the same projection from GitHub.

## Decision safety

Coach tools may record reviews and proposals. They cannot confirm a Hunsu operation or select/reject an alternative. The divergence skill displays the proposed difference, requires explicit user confirmation, starts each sibling from the same base SHA, and records a comparison before a user-authorized selection.
