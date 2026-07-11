# Web Pairing

hunsu.app is the primary graphical client during headless stabilization. It
connects to the existing daemon; browser actions never start or manage it.

## Credential separation

The local control token authenticates the CLI only. Browser pairing uses a
separate credential that is short-lived, rotatable, revocable, and scoped to
local browser API access.

hunsu-bridge pair rotates a pairing session and returns safe metadata.
hunsu-bridge open performs the same rotation and opens the browser. JSON output
never includes the raw URL.

The browser consumes the credential once, persists only the scoped browser
session material it needs, and removes the credential from the address bar.
Pairing URLs, Authorization values, and tokens are sanitized before any log or
diagnostic write.

## Browser compatibility API

The 0.2 prerelease preserves the production browser-facing /api routes and
payloads as adapters over the new provider, Workspace, pairing, and Remote
services. This permits candidate validation without first deploying a new
hunsu.app build.

Fast development uses a same-origin proxy. Direct-localhost tests separately
cover CORS, Private Network Access behavior, streaming transports, pairing
expiry and revocation, and Workspace Open.

If Bridge is offline, Web presents the recovery command
hunsu-bridge service start. It does not invoke a local application protocol or
attempt to own a daemon process.
