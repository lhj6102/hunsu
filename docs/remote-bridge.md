# Remote Bridge

Remote access remains a capability of the single local Bridge daemon:

~~~text
local enabled  -> authenticated loopback Bridge API
remote enabled -> loopback API + outbound Connect signaling + direct browser peer
~~~

There is no second daemon, command proxy, hosted command service, or product
supervisor.

## Connect boundary

`connect.preview.hunsu.app` and `connect.hunsu.app` provide only:

- Cloudflare Access-backed browser authentication;
- headless device enrollment and rotating device credentials;
- device presence;
- short-lived, one-use P2P session tickets; and
- bounded opaque WebRTC signaling between an authenticated browser and device.

Browser sign-in navigates to Connect's Access-protected `/auth/login` endpoint.
Connect verifies the Access assertion, creates an HttpOnly session, and returns
only to the configured Web `/studio` URL.

Connect never receives a Workspace ID or name, grant, command, result, stream,
SDP, or ICE candidate in plaintext. It has no offline mailbox and does not
forward DataChannel traffic.

## Direct peer session

The browser learns the selected device's public signing and agreement keys from
Connect. A session ticket binds the account, device, browser ephemeral P-256
agreement key, environment, session, expiry, and one-use nonce. Signaling SDP
and ICE frames are encrypted before they reach Connect using a key derived from
the browser ephemeral key and the device's long-term agreement key.

Bridge verifies the ticket against the public key pinned in its deployment
profile, creates a fresh ephemeral agreement key, and signs the complete peer
transcript with its device signing key. Browser and Bridge then derive separate
AES-256-GCM keys for each direction of two reliable ordered DataChannels:

~~~text
hunsu.control.v1  commands and finite responses
hunsu.stream.v1   bounded chunks and streaming events
~~~

Every encrypted frame has a strictly increasing directional sequence number.
Replay, reordering, oversized frames, expired leases, fingerprint mismatch, and
unknown message variants fail closed. Sessions use the free Cloudflare STUN
endpoint `stun:stun.cloudflare.com:3478` only. Hunsu does not configure TURN or
a hosted fallback path; a peer that cannot establish a direct connection stays
offline.

## Login and device credentials

Login uses a headless-compatible device flow. The Bridge device owns separate
P-256 signing and agreement keys, proves possession when enrolling and
refreshing, and stores its rotating refresh credential in the user-only Bridge
credential store. Opening a browser is optional; when it fails, the CLI prints
the exact verification URL and a short user code. Raw account, device, refresh,
ticket, and peer keys never appear in diagnostics or logs.

## Workspace authority

Remote access requires a signed-in account, a registered device, an explicit
Workspace grant, and an authenticated direct peer. Connect knows none of those
local grants. After the peer handshake, Bridge sends only stable Workspace IDs
and path-free metadata for currently granted Workspaces.

Grant or revoke access through the authenticated local control API:

~~~sh
hunsu-bridge workspace grant <workspace-id> \
  --scopes remote.access,execute.start
hunsu-bridge workspace revoke <workspace-id>
~~~

New Workspaces are ungranted. Bridge remains the final authority that maps a
Workspace ID to its canonical local path and rechecks every scope immediately
before dispatch. Payloads cannot provide or replace a local path. Revocation,
Remote disable, lease expiry, logout, or device revocation closes the peer and
causes subsequent access to fail.

Normal integration tests use deterministic in-process Connect and peer
adapters and require no Cloudflare credential. Candidate promotion additionally
requires a real browser-to-Bridge P2P round trip, ungranted access rejection,
grant revocation, STUN-only evidence, and proof that hosted Connect carried no
command or Workspace data.
