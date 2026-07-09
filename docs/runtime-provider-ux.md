# Runtime Provider UX

Bridge App should feel like a friendly setup app:

```text
Provider
Workspaces
Connection
```

The Provider tab is intentionally not a provider dashboard yet. It shows Codex,
its readiness, safe access information, and a small set of recovery actions.
The first screen summarizes Provider, Workspaces, and Connection; account,
device, service, grant, and raw provider details stay secondary.

Advanced provider details are secondary:

- future provider placeholders
- raw binary discovery
- app-server diagnostics
- environment-derived settings
- rate-limit and account probe errors

Advanced Runtime Providers consumes the provider registry API, lists Codex as
the current provider, and marks Claude Code, Gemini CLI, OpenHands Agent
Server, ACP Agent, LiteLLM Gateway, and OpenRouter Gateway as Coming later.
These placeholders are hidden from the default Provider tab so first-run setup
stays focused.

The Provider tab hides Codex source, binary path, raw usage/rate-limit payloads,
and other low-level details. Those remain in Advanced or Diagnostics.
Ready provider cards show Recheck and Change provider. API-key configuration
belongs in Advanced provider details. Error cards show Show details instead of
placing raw diagnostics in the primary Provider tab.

Install actions require confirmation. The primary UI does not expose raw shell
pipelines; it invokes the provider install action, which can dry-run for tests
or run the fixed Codex npm installer after confirmation and then recheck
status.

Web renders provider problems as provider problems. Missing Codex, expired
auth, or rate limits should route users to `hunsu://provider` or
`hunsu://provider/codex`, not to Roadmap or Relay internals.

Execute preflight uses three neighboring areas: provider, workspace, and
connection. Workspace activation or missing-folder problems open Workspaces;
offline/local-vs-remote problems open Connection; provider setup opens Provider.

Future providers should be addable by registering another provider adapter,
not by changing Web workspace connection components.
