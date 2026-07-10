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

Provider setup is Bridge-owned and metadata-driven. The Provider tab Configure
button opens a Codex setup modal instead of sending users to generic Settings.
Codex exposes these config keys:

- `binaryPath`: optional path to the Codex executable.
- `codexHome`: optional `CODEX_HOME` directory.
- `appServerCommand`: optional command override for the Codex app-server.
- `appServerArgs`: optional app-server argument override.
- `authenticationPreference`: `chatgpt`, `device_code`, or `api_key`.

Primary fields are `binaryPath` and `codexHome`. Authentication preference is
shown separately. `appServerCommand` and `appServerArgs` stay collapsed under
Advanced.

Bridge persists Codex provider config only under
`runtimeProviders.providers.codex.settings`. Legacy Bridge App fields such as
`codex.binaryPath` and `codex.environment.CODEX_HOME` are migrated into that
provider settings object, then omitted from later writes.

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

Windows may have Codex installed and authenticated in the user's default
`%USERPROFILE%\.codex` while Bridge was launched with a different `CODEX_HOME`.
Bridge treats `codexHome` as a first-class provider setting and uses it for
status, app-server probes, login, device login, API-key login, recheck,
diagnostics, sidecar daemon launches, remote attach launches, and Execute. The
auth-home diagnostic only checks whether `auth.json` exists at the effective
and default Codex homes. It never reads `auth.json`, token contents, API keys,
or raw credential payloads.

Execute preflight is provider-aware. Missing binaries, expired auth, provider
rate limits, or app-server failures return `area: "provider"` with actions that
open `hunsu://provider` or `hunsu://provider/codex`. Workspace and connection
problems are reported separately so Web does not send users to provider setup
for an inactive workspace or offline Bridge.

Model-selection failures are reported separately as `area: "model"`. Bridge
validates Web and CLI aliases against the current provider inventory before
Execute starts; see [Model Aliases](model-aliases.md).

## API

Provider APIs:

```text
GET  /api/providers
GET  /api/providers?advanced=1
GET  /api/providers/current
GET  /api/providers/current/metadata
GET  /api/providers/current/config
POST /api/providers/current/recheck
POST /api/providers/current/install
POST /api/providers/current/login
POST /api/providers/current/authenticate
POST /api/providers/current/configure
POST /api/providers/current/validate
POST /api/providers/current/config
DELETE /api/providers/current/config
GET  /api/providers/inventory
POST /api/model-aliases/validate
POST /api/model-aliases/resolve
```

Every runtime-provider status publishes a required model-inventory state.
Codex publishes its provider-owned catalog even when its binary or login needs
attention; providers without an inventory publish an explicit unavailable
state. `GET /api/providers/inventory` returns
`{ ok: true, value: { backendId, providers } }` or a typed
`BACKEND_UNAVAILABLE` / `PROVIDER_INVENTORY_UNAVAILABLE` result. Model
descriptors expose capabilities such as `reasoningEfforts` and `serviceTiers`
so Web can render direct model controls without hardcoded reasoning choices.
An explicit backend never falls back to the local provider.
Alias resolve returns `{ ok: true, backendId, resolved, provider }` or one of
the documented model/provider errors with actions. Web sends custom aliases
with the public `aliases?: ModelAlias[]` request field; omitted aliases allow
Bridge defaults, while `aliases: []` is an explicit empty alias set.

`/api/providers/current/login` runs the current provider adapter. For Codex it
starts `codex login`, `codex login --device-auth`, or the API-key
configuration path `codex login --api-key`, and records the safe pending or
device-code state for Bridge App where available.

`/api/providers/current/configure` runs the current provider adapter. For Codex
it accepts `binaryPath` or `selectBinaryPath`, validates that binary through the
runtime status probe, and stores the selected binary for subsequent provider
checks when valid. `clearBinaryPath` removes the override.

`/api/providers/current/metadata` returns config metadata. Config get/save and
validate use `RuntimeProviderConfigField[]`. Codex save accepts "binary found,
app-server available, auth missing" so setup can save a valid binary and Codex
Home before sign-in. It rejects missing or unusable binaries and unavailable
app-server probes.

Headless Bridge App commands mirror the API:

```text
hunsu-bridge provider metadata
hunsu-bridge provider config get
hunsu-bridge provider config validate-json '<fields>'
hunsu-bridge provider config save-json '<fields>'
hunsu-bridge provider config reset
hunsu-bridge provider authenticate chatgpt|device|api_key
hunsu-bridge codex home set <path>
hunsu-bridge codex home reset
```

Diagnostics may show the effective provider env for
`HUNSU_CODEX_BINARY_PATH`, `CODEX_HOME`, `HUNSU_CODEX_APP_SERVER_COMMAND`, and
`HUNSU_CODEX_APP_SERVER_ARGS`, plus auth-file existence booleans for Codex
Home. Diagnostics must not include credential values.

Codex compatibility endpoints remain available under
`/api/runtimes/codex/*` and `/api/codex/status`.
