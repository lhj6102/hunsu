# Bridge Security

Hunsu Bridge is a loopback-local privileged process. It is never a public HTTP
proxy, and the browser, CLI, Relay, and provider boundaries use distinct
credentials with distinct lifecycles.

## Credential boundaries

- The control credential authenticates finite CLI requests to `/v1/control/*`.
  It lives only in `credentials.json`, is never accepted in a URL, and rotation
  immediately revokes the previous value.
- Browser pairing uses a separate short-lived, rotatable, revocable credential.
  The browser consumes it once, removes it from the address bar, and persists
  only the scoped browser session material it needs. Browser credentials are
  never written to Bridge state.
- Hunsu account and Relay credentials are created by headless device login and
  stored in the same protected credential document under separate fields. They
  are used only for the outbound Relay connection. No custom device protocol is
  required.
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
evidence must exclude control, pairing, account, refresh, and Relay tokens;
Authorization headers; token-bearing URLs; credential file contents; and
private repository paths. Expected product failures return one safe JSON
result without diagnostic stderr. Release evidence uses opaque Workspace IDs
and credential-free HTTPS URLs without userinfo, queries, or fragments.

Remote responses expose stable Workspace IDs and safe metadata. Local paths
remain redacted unless an explicit persisted grant permits the requested
scope. Revocation is persisted before a subsequent command is authorized.

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
version, Relay environment, and an opaque disposable Workspace fixture ID.
The record never contains a control, pairing, account, Relay, or Authorization
credential. A candidate stays off `next` or `latest` until registry setup and
production attestations for the same immutable version succeed.
