# Releasing Hunsu Bridge

Bridge follows the repository's `preview` to `main` promotion path. Preview
publishes the canonical `@hunsu/bridge` package under `candidate-next`; it does
not publish a second preview package. Production promotion refers to the same
immutable npm version and integrity that QA used.

~~~text
feature PR -> preview
  -> Bridge Headless for the preview SHA
  -> exact @hunsu/bridge prerelease -> candidate-next
  -> preview deployment and QA
  -> manual immutable Git tag for the approved preview SHA
preview PR -> main
  -> production deployment and exact-version gates
  -> an npm owner manually moves next or latest
~~~

## One-time repository and npm setup

Protect `preview` and `main`. The GitHub environment `bridge-npm-release` is
the OIDC boundary used by `.github/workflows/publish-bridge.yml`. The existing
npm package must trust this publisher:

For automatic preview publication, its deployment-branch rules must allow
`preview`, and it must not require an additional environment approval. The
protected-branch merge is the publication authorization; QA approval remains
the later `preview` to `main` gate. Keep `bridge-production-promotion`
separately protected for the manual promotion proof.

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
no long-lived npm write token belongs in repository or environment secrets. An
npm owner can configure the relationship from npmjs.com or with an interactive
owner session:

~~~sh
npm trust github @hunsu/bridge \
  --file publish-bridge.yml \
  --repo lhj6102/hunsu \
  --env bridge-npm-release \
  --yes
~~~

Trusted-publisher OIDC authorizes `npm publish`, not `npm dist-tag`. The
workflows therefore never automate `npm dist-tag`, and no long-lived token is
added to bypass that proof-of-presence boundary.

## Automatic preview candidate

Before merging a change that affects packed Bridge bytes into `preview`, bump
`apps/bridge/package.json` to a new explicit prerelease such as
`0.2.0-next.8`. npm versions are immutable. CI never invents or rewrites a
version.

A push to protected `preview` starts both `bridge-headless.yml` and
`publish-bridge.yml`. Publication waits for the successful Bridge Headless run
for that exact preview SHA, builds and smoke-tests one pnpm-normalized tarball,
and calculates both its SHA-256 and npm sha512 integrity.

The publisher then applies these rules:

- If the exact npm version is absent, publish it as public under
  `candidate-next` with OIDC provenance.
- If the exact version exists, reuse it only when registry integrity exactly
  matches the locally built tarball, `candidate-next` already identifies that
  version, and its signed provenance identifies this same protected preview
  push and Git SHA.
- If the bytes differ, or an old version would require moving
  `candidate-next` with `npm dist-tag`, fail and require a version bump.

The retained `bridge-candidate-<preview-sha>` artifact contains the tarball,
checksums, and `candidate-evidence.json`. The evidence binds:

~~~text
repository
preview SHA
exact npm version
registry sha512 integrity
tarball SHA-256
expected immutable Git tag
publish/reuse result
workflow run identity
npm-verified SLSA provenance for refs/heads/preview and the exact SHA
~~~

Automatic preview publication does not create or move a Git tag. A failed
candidate remains an immutable diagnostic record and must never be unpublished.

## Preview QA and the immutable tag

Preview devices install the exact version recorded in candidate evidence, for
example:

~~~sh
npx @hunsu/bridge@0.2.0-next.8 setup --profile preview
~~~

Do not use only the movable `candidate-next` name in a QA record. Record the
exact version, integrity, preview SHA, and preview deployment evidence.

After QA approves that exact preview candidate, create the expected tag
manually on the recorded preview SHA and push it. Never move or reuse a release
tag:

~~~sh
git tag -a v0.2.0-next.8 <approved-preview-sha> \
  -m "Release @hunsu/bridge 0.2.0-next.8 candidate"
git push origin v0.2.0-next.8
~~~

The tag starts the cross-platform local-tarball service workflow. Dispatch the
exact registry setup from the same tag:

~~~sh
gh workflow run bridge-registry-smoke.yml \
  --ref v0.2.0-next.8 \
  -f version_tag=v0.2.0-next.8
~~~

The registry workflow proves that the tag, source SHA, exact version,
`candidate-next`, and registry integrity agree. Windows, macOS, and Linux then
invoke the exact registry package through `npx`, run real setup, verify the OS
user service, fake Codex provider, Workspace, pairing, idempotent setup,
stop/port release, removal, and service uninstallation.

## Main and production gates

The successful preview deployment opens the promotion PR from `preview` to
`main`; the QA leader reviews and approves that exact head only after QA. Do not
add new Bridge changes to that PR. The exact tagged preview tree must occur in `main`;
normal merge commits retain the SHA directly, while squash or rebase promotion
retains the same reviewed tree identity.

The production deployment uses the approved release evidence and the same
exact package version. Existing production QA additionally covers:

- real Codex installed, configured, authenticated, and ready;
- production pairing in existing and fresh/InPrivate browser profiles, URL
  cleanup, Workspace list/open, and SSE/streaming;
- headless Hunsu device login, persisted account, Remote status, and logout;
- one granted disposable Workspace, direct encrypted WebRTC command, rejection
  of an ungranted Workspace, revocation, and Remote disable;
- STUN-only ICE and proof that Connect carried no command or Workspace data;
- local path redaction before and after grant changes.

Dispatch `bridge-production-integration.yml` and retain its redacted,
credential-free QA record. The workflow verifies the record digest, registry
signature, SLSA provenance, npm integrity, protected preview publication ref,
publisher workflow, candidate Git SHA, separately verified immutable Git tag,
service managers, deployed Web identity, Codex version, Connect environment,
and opaque Workspace fixture ID. The later Git tag cannot and does not rewrite
the already-published npm provenance; both identities converge on the same Git
SHA instead.

Never include a control, pairing, account, refresh, Connect, or session token;
Authorization header; token-bearing URL; or private repository path.

## Promotion

After the exact registry, production deployment, and production attestation
gates pass, authorize promotion from the immutable candidate tag:

~~~sh
gh workflow run publish-bridge.yml \
  --ref v0.2.0-next.8 \
  -f version_tag=v0.2.0-next.8 \
  -f operation=promote-next \
  -f confirm_promotion=true
~~~

The workflow verifies that the tagged candidate source or exact tree occurs in `main`,
requires the successful exact-tag registry and production gates, and confirms
that `candidate-next` still identifies the attested version. It records—but
does not execute—the proof-of-presence command. An npm owner then runs:

~~~sh
npm dist-tag add @hunsu/bridge@0.2.0-next.8 next
npm dist-tag rm @hunsu/bridge candidate-next
~~~

Removing `candidate-next` is optional if it is immediately advanced by the
next new candidate publication. Verify the registry after any manual mutation.
If a gate fails, leave `next` on the previous verified version and create a new
prerelease for every code or packed-byte change.

Stable `latest` promotion uses the same process with a stable version tag and
`operation=promote-latest`. Do not authorize it until all stable-line service
and production gates pass.
