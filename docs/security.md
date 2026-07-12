# Bridge Security

Hunsu Bridge is a loopback-local privileged process. It is never a public HTTP
proxy, and the browser, CLI, Connect, peer, and provider boundaries use distinct
credentials with distinct lifecycles.

## Credential boundaries

- The control credential authenticates finite CLI requests to `/v1/control/*`.
  It lives only in `credentials.json`, is never accepted in a URL, and rotation
  immediately revokes the previous value.
- Browser pairing uses a separate short-lived, rotatable, revocable credential.
  The browser consumes it once, removes it from the address bar, and persists
  only the scoped browser session material it needs. Browser credentials are
  never written to Bridge state.
- Hunsu account and Connect device credentials are created by headless device
  enrollment and stored in the protected credential document under separate
  fields. Device signing and agreement keys, a rotating refresh credential,
  and short-lived proof-of-possession access tokens are used only for outbound
  authentication and signaling.
- Codex remains an external authenticated runtime. Bridge stores a binary and
  optional Codex Home setting, but does not collect Codex credential files,
  OpenAI API keys, or Codex tokens.

`credentials.json`, the ownership marker, setup journal, runtime install
record, and structured logs are written with user-only permissions. On Windows
the credential ACL is protected and grants the current user only. Service
definitions run as the current user and contain stable runtime paths, not
credentials.

## Redaction

CLI JSON, human output, diagnostics, structured logs, CI summaries, and release
evidence must exclude control, pairing, account, refresh, Connect, and session tokens;
Authorization headers; token-bearing URLs; credential file contents; and
private repository paths. Expected product failures return one safe JSON
result without diagnostic stderr. Release evidence uses opaque Workspace IDs
and credential-free HTTPS URLs without userinfo, queries, or fragments.

Remote responses expose stable Workspace IDs and safe metadata. Local paths
remain redacted unless an explicit persisted grant permits the requested
scope. Revocation is persisted before a subsequent command is authorized.

## Remote peer boundary

Cloudflare Access protects only Connect's interactive `/auth/*` routes. Connect
validates the Access JWT issuer, signature, expiry, and exact environment AUD
before issuing its own HttpOnly, Secure, SameSite=Lax browser session. Bridge
device requests use rotating proof-of-possession credentials instead of a
browser cookie. First-time Web login is a top-level `/auth/login` navigation,
not a cross-origin credential fetch; Connect redirects only to its configured
Web origin and never accepts an arbitrary return URL.

Connect D1 stores account/device ownership, public device keys, hashed refresh
token families, authentication epochs, revocation, and minimal outcomes. A
hibernating Durable Object keeps only live device/browser signaling sockets.
The service has no Workspace, grant, command, result, or stream schema and no
offline queue.

Signaling SDP and ICE are AES-256-GCM ciphertext derived from browser ephemeral
and device long-term P-256 agreement keys. After WebRTC connects, Bridge signs
the ticket-bound ephemeral transcript and both peers derive distinct control
and stream keys for each direction. DataChannel frames use deterministic
nonces from a directional prefix plus a strictly increasing 64-bit sequence;
the schema, direction, channel, session, and sequence are authenticated data.
Replay, unexpected sequence, oversized input, bad fingerprint, unknown
variant, expired lease, and key mismatch close the session without fallback.

## Ownership-safe deletion

Setup creates `HUNSU_HOME/.hunsu-bridge-home.json` before service activation:

~~~json
{
  "schema": "hunsu.bridge.home-ownership.v1",
  "installationId": "install_...",
  "createdAt": "2026-07-12T00:00:00.000Z",
  "home": "/canonical/absolute/HUNSU_HOME"
}
~~~

The marker contains no credential. Its canonical home and installation ID must
match the selected home and `runtime/install.json` before destructive removal.
It proves ownership only of known Hunsu entries; it never makes the parent
directory or unknown content deletable.

`remove --delete-data --confirm-delete-data` considers only:

~~~text
config.json
workspaces.json
credentials.json
runtime.json
runtime/
logs/
.hunsu-bridge-home.json
~~~

Bridge never recursively removes `HUNSU_HOME`. Each entry is `lstat`-checked,
canonically contained, and type-checked. A symlink, Windows junction, or reparse
point is unlinked as an entry and its target is never traversed. Hunsu-owned
directories recursively delete only contained regular entries and fail closed
when containment or type cannot be established.

Unknown entries are always preserved and reported by basename. The home
directory is removed only if it is empty after allowlisted deletion. Filesystem
roots, the user's home, and the current repository and its ancestors are
protected. Missing/mismatched ownership, unsafe containment, filesystem
ambiguity, protected locations, and unknown installation identity return
`BRIDGE_DATA_DELETE_REFUSED`.

Installations created before the ownership marker may remove their service and
runtime while preserving user data. They cannot use destructive deletion, and
setup does not fabricate a marker immediately before a removal attempt.

## Release evidence

Candidate evidence binds the Git SHA and tag, exact npm version and integrity,
npm-verified signed provenance, the immutable digest and retained bytes of the
redacted QA record, OS/Node/service-manager matrix, hunsu.app deployment, Codex
version, Connect environment, direct STUN-only P2P result, and an opaque
disposable Workspace fixture ID. The record never contains a control, pairing,
account, Connect, session, peer-key, or Authorization
credential. A candidate stays off `next` or `latest` until registry setup and
production attestations for the same immutable version succeed.
