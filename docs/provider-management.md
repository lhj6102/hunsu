# Provider Management

Hunsu Bridge exposes one internal provider interface and one provider in the
first 0.2 prerelease: Codex.

The daemon owns provider configuration and readiness state. The CLI reads and
mutates that state through the authenticated control API:

~~~sh
hunsu-bridge provider list --json
hunsu-bridge provider status --json
hunsu-bridge provider set codex \
  --binary <path> \
  --codex-home <codex-path> \
  --home <hunsu-home> \
  --json
hunsu-bridge provider check codex --json
hunsu-bridge provider reset codex --json
~~~

Provider configuration is stored in config.json under HUNSU_HOME. Client-only
code never writes it directly.

## Codex readiness

The Codex adapter validates:

- the configured or discovered executable
- Codex version output
- app-server startup
- authentication readiness
- the selected model when required

Stable failures include PROVIDER_NOT_CONFIGURED, PROVIDER_BINARY_NOT_FOUND,
PROVIDER_LOGIN_REQUIRED, and PROVIDER_CHECK_FAILED. Results expose safe status
and recovery commands, not raw app-server payloads, environment dumps, or
credential files.

`--home` always means `HUNSU_HOME`; it has no provider-specific meaning.
`--codex-home` is the explicit Codex Home setting, and both options may be used
together. The prerelease rejects the old ambiguous provider use of `--home`
with guidance to use `--codex-home`.

Codex Home and binary overrides are explicit settings. The daemon applies the
same effective provider configuration to status checks, login, local Execute,
and outbound Remote Relay commands.

The provider interface remains extensible, but additional providers and
speculative provider-selection UI are outside the first prerelease.

## Browser compatibility

Existing /api/providers and Codex compatibility routes remain adapters for the
first 0.2 line. New CLI commands use /v1/control/provider and
/v1/control/provider/check instead.
