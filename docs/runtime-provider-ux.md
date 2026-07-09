# Runtime Provider UX

Hunsu Bridge App is a local readiness companion, not a provider dashboard. Its
first job is to make the current runtime usable enough for Execute, then hand
the user to an active workspace in Studio.

## What Hunsu Can Learn From OpenCode

OpenCode treats provider connection as a first-class setup step. Its `/connect`
flow makes the current provider state visible, offers one obvious next action,
and keeps credential setup separate from editing or running work.

Hunsu should borrow that clarity:

- show runtime readiness before workspace actions that require it
- use direct state labels such as `Ready`, `Login required`, and `Not found`
- keep setup actions close to the state that needs them
- hide diagnostic payloads and implementation details until the user asks

Hunsu should not copy OpenCode into the runtime layer in this branch. The
immediate product problem is Codex readiness and local workspace activation.

## Why Codex Remains First

Codex is the first Hunsu runtime because the current Execute and Hunsu Draft
flows are built around `codex app-server --stdio`:

- Bridge can probe Codex readiness with a local CLI and app-server process.
- Execute permissions map to Codex app-server sandbox and approval settings.
- Team planning, Member Path execution, MOVE finalization, and Hunsu Draft
  turns already share Codex event and session semantics.
- Studio receives normalized runner events through Bridge instead of talking to
  a provider directly.

Adding another runtime before this path is simple would add provider choice to a
setup experience that still needs to become smaller.

## Future Runtime Shape

Future runtimes can fit behind the existing Bridge-owned runner boundary:

- `Codex`: default local runtime, backed by `codex app-server --stdio`.
- `OpenCode`: possible future provider UX/runtime reference, not integrated now.
- `Claude Code`: possible future local coding runtime if it can expose a stable
  process, permission, and event contract.
- `local runner`: possible deterministic runner for tests, checks, or scripted
  workflow steps that do not need an LLM provider.

The Bridge App UI should not become a multi-provider switcher until at least two
runtimes can satisfy the same Hunsu runner contract. Until then, the UI should
say what the user can act on: Codex setup and workspace activation.

## Credential Ownership

Bridge App should not own third-party provider credentials. It may start a
provider login flow, probe readiness, and report safe account summaries, but it
must not inspect credential files or store raw provider tokens.

Provider credentials should stay with the provider's own CLI or credential
store. Hunsu-owned credentials are limited to Hunsu account, device, Relay, and
local pairing state. This keeps Bridge focused on orchestration and avoids
turning it into a credential broker for unrelated services.

## Current Decision

Do not integrate OpenCode as a runtime in this branch.

Do not add a multi-provider UI in this branch.

Use OpenCode only as UX inspiration for clear provider connection states and
action-oriented setup.
