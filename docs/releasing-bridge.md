# Releasing Hunsu Bridge

Bridge releases are immutable, tag-bound, provenance-bearing npm
publications. `0.2.0-next.1` is published under `candidate-next` first. Neither
`next` nor `latest` moves until exact registry setup and production evidence
for the same Git SHA, tag, npm version, and integrity have passed.

## One-time repository and npm setup

The GitHub environments `bridge-npm-release` and
`bridge-production-promotion` must have required reviewers. Configure the
existing npm package with this trusted publisher:

~~~text
package:      @hunsu/bridge
provider:     GitHub Actions
owner:        lhj6102
repository:   hunsu
workflow:     publish-bridge.yml
environment:  bridge-npm-release
allowed:      npm publish
~~~

The package manifest repository URL must remain the exact public GitHub
repository. Candidate publication uses GitHub OIDC with npm 11.5.1 or newer;
no long-lived write token belongs in repository or environment secrets. An npm
owner can configure the trust relationship from npmjs.com or, with npm 11.18.0
or newer and an interactive owner session:

~~~sh
npm trust github @hunsu/bridge \
  --file publish-bridge.yml \
  --repo lhj6102/hunsu \
  --env bridge-npm-release \
  --allow-publish \
  --yes
~~~

Trusted-publisher OIDC authorizes `npm publish`, not `npm dist-tag`. Promotion
therefore keeps proof of presence: the protected workflow verifies every gate
and records the exact command, then an npm owner runs that command with an
interactive, 2FA-protected session. Do not add a long-lived automation token to
work around this boundary.

## Candidate publication

Only after Workstreams 1–7 and `pnpm verify:bridge` pass, merge the candidate
commit to `main`. Create a new immutable tag; never move or reuse an earlier
release tag:

~~~sh
git tag -a v0.2.0-next.1 -m "Release @hunsu/bridge 0.2.0-next.1 candidate"
git push origin v0.2.0-next.1
# Wait for bridge-service-smoke.yml on this exact tag to pass on all three OSes.
gh workflow run publish-bridge.yml \
  --ref main \
  -f version_tag=v0.2.0-next.1 \
  -f operation=publish-candidate \
  -f confirm_promotion=false
~~~

The protected workflow verifies that the tag matches `apps/bridge/package.json`,
resolves to a commit already merged into `main`, and has successful headless
main and cross-platform local-tarball service runs. It builds and tests one
pnpm-normalized tarball, retains its checksum, rechecks the tag and artifact,
then publishes the exact version under `candidate-next` with provenance. It
does not move `next` or `latest`.

The npm trusted-publisher settings are an external prerequisite. A publication
authentication failure leaves the immutable version unpublished and must be
fixed in npm package settings; do not change the tag to retry different source.

## Exact registry and production gates

Dispatch registry setup from the exact tag:

~~~sh
gh workflow run bridge-registry-smoke.yml \
  --ref v0.2.0-next.1 \
  -f version_tag=v0.2.0-next.1
~~~

The workflow first proves `candidate-next` and the exact npm version agree. Its
Windows, macOS, and Linux jobs invoke the exact registry package through `npx`,
run real `setup`, verify the stable service runtime, fake Codex provider,
Workspace, pairing, idempotent setup, stop/port release, removal, and service
uninstallation. A service path into npm cache, the bootstrap project, or the
repository fails the job.

Production QA then uses the same exact candidate on controlled devices. Test:

- real Codex installed, configured, authenticated, and ready;
- hunsu.app pairing in an existing and fresh/InPrivate profile, URL cleanup,
  Workspace list/open, and SSE/streaming;
- headless Hunsu device login, persisted account, Remote status, and logout;
- one explicitly granted disposable Workspace, outbound Relay command,
  rejection of an ungranted Workspace, revocation, and Remote disable;
- local path redaction before and after grant changes.

Dispatch `bridge-production-integration.yml` from the exact tag. Its inputs
bind a retained redacted HTTPS record to Git SHA/tag, npm version/integrity and
provenance, each OS/Node/service manager, hunsu.app deployment, Codex version,
Relay environment, and opaque Workspace fixture ID. It validates the registry
identity, rejects credential-like evidence, uploads a sanitized evidence
record, and requires explicit booleans for every real integration gate.

Never include a control, pairing, account, refresh, or Relay token;
Authorization header; token-bearing URL; or private repository path.

## Promotion

After both exact-version workflows succeed, authorize promotion from `main`:

~~~sh
gh workflow run publish-bridge.yml \
  --ref main \
  -f version_tag=v0.2.0-next.1 \
  -f operation=promote-next \
  -f confirm_promotion=true
~~~

The workflow requires successful registry-smoke and production-attestation
runs whose `head_sha` and tag match the candidate, confirms
`candidate-next=0.2.0-next.1`, and passes the protected promotion environment.
It records the proof-of-presence command. An npm owner then runs:

~~~sh
npm dist-tag add @hunsu/bridge@0.2.0-next.1 next
npm dist-tag rm @hunsu/bridge candidate-next
~~~

Removing `candidate-next` is optional if it is immediately advanced to the next
candidate instead. Verify the registry after the mutation. If registry setup or
production QA fails, leave `next` on the previous verified version, retain the
failed immutable prerelease for diagnosis, and never unpublish it.

Stable `latest` promotion uses the same sequence with a stable version tag and
`operation=promote-latest`. Do not authorize it until all stable-line service
and production gates pass.
