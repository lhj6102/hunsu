# Provider Management

Hunsu Bridge uses a runtime provider facade instead of treating Execute as
permanently Codex-only.

Codex is the default and first supported provider. Bridge detects the Codex CLI,
checks whether the app-server can initialize, asks Codex for safe account and
usage summaries, and exposes that as `RuntimeProviderStatus`.

## Provider States

The primary Provider view shows one current provider:

- Not found: install Codex, select an existing binary, or recheck.
- Login required: sign in with ChatGPT, use device code, or recheck.
- Ready: show safe access and version details, with Recheck and Change provider
  as the primary actions.
- Needs attention: recheck, select an existing binary, or Show details.

Raw credential payloads, app-server JSON-RPC details, environment variables,
API-key configuration, and discovery candidates belong in diagnostics or
Advanced views.

## Provider Registry

Bridge exposes a provider registry with Codex plus hidden placeholders for
future providers such as Claude Code, Gemini CLI, OpenHands, ACP Agent, LiteLLM
Gateway, and OpenRouter Gateway.

Default UI shows only the current provider. Advanced UI consumes the registry
API and may list future providers as Coming later.

Codex installation is an explicit provider action. Bridge returns an install
plan first, then runs the fixed Codex npm installer only after confirmation,
and rechecks provider status after completion. Tests and no-GUI flows may use
the dry-run install hook; Bridge does not run shell pipes or user-supplied
installer commands.

On Windows, Codex detection checks the process `PATH`, Windows `Path`, and
captured User PATH and Machine PATH snapshots when available, then known
OpenAI Codex install directories such as LocalAppData OpenAI Codex and roaming
npm locations. WindowsApps execution aliases produce a Select Binary recovery
action instead of being treated as a valid Codex install.

Execute preflight is provider-aware. Missing binaries, expired auth, provider
rate limits, or app-server failures return `area: "provider"` with actions that
open `hunsu://provider` or `hunsu://provider/codex`. Workspace and connection
problems are reported separately so Web does not send users to provider setup
for an inactive workspace or offline Bridge.

## API

Provider APIs:

```text
GET  /api/providers
GET  /api/providers?advanced=1
GET  /api/providers/current
POST /api/providers/current/recheck
POST /api/providers/current/install
POST /api/providers/current/login
POST /api/providers/current/configure
```

`/api/providers/current/login` runs the current provider adapter. For Codex it
starts `codex login`, `codex login --device-auth`, or the API-key
configuration path `codex login --api-key`, and records the safe pending or
device-code state for Bridge App where available.

`/api/providers/current/configure` runs the current provider adapter. For Codex
it accepts `binaryPath` or `selectBinaryPath`, validates that binary through the
runtime status probe, and stores the selected binary for subsequent provider
checks when valid. `clearBinaryPath` removes the override.

Codex compatibility endpoints remain available under
`/api/runtimes/codex/*` and `/api/codex/status`.
