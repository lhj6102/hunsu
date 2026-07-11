# Releasing Hunsu Bridge

Bridge releases are tag-bound, provenance-bearing npm publications. The
publish workflow accepts an exact Git tag and refuses a tag that does not match
`apps/bridge/package.json` or lacks a successful Bridge Headless run for the
same commit.

## One-time repository and npm setup

Create the GitHub environment `bridge-npm-release` and configure its required
reviewers. Then configure the existing npm package with this trusted publisher:

~~~text
package:      @hunsu/bridge
provider:     GitHub Actions
owner:        lhj6102
repository:   hunsu
workflow:     publish-bridge.yml
environment:  bridge-npm-release
allowed:      npm publish
~~~

Also protect the `bridge-production-promotion` environment with required
reviewers. Stable publication requires successful service-smoke and production
integration-attestation runs for the exact release SHA; a confirmation input
alone cannot promote `latest`. The retained evidence URL must itself be public
and credential-free: HTTPS with no userinfo, query string, fragment, or secret
path segment.

The package manifest's repository URL must remain the exact public GitHub
repository. Publishing uses GitHub OIDC with npm 11.5.1 or newer; no long-lived
write token belongs in repository or environment secrets.

An npm package owner can configure the same trust relationship from the
npmjs.com package settings UI. If using the CLI, authenticate with npm 11.18.0
or newer (the allowed-action flags were added after the publishing minimum):

~~~sh
npm install --global npm@11.18.0
npm trust github @hunsu/bridge \
  --file publish-bridge.yml \
  --repo lhj6102/hunsu \
  --env bridge-npm-release \
  --allow-publish \
  --yes
~~~

## Prerelease

After the final commit is merged to `main` and passes the normal headless
push workflow:

~~~sh
git tag -a v0.2.0-next.0 -m "Release @hunsu/bridge 0.2.0-next.0"
git push origin v0.2.0-next.0
gh workflow run publish-bridge.yml \
  --ref main \
  -f version_tag=v0.2.0-next.0 \
  -f dist_tag=next \
  -f confirm_stable=false
~~~

The protected workflow definition always runs from `main`, checks out the
selected immutable tag, and verifies that its commit is already in `main`.
Approve the protected environment only after the verification and clean
tarball jobs pass. The workflow publishes the checksum-pinned,
pnpm-normalized tarball that passed the package job, not a newly packed source
directory. Confirm the registry version and `next` dist-tag after the publish
job completes.

## Stable promotion

Do not publish under `latest` until real hunsu.app pairing, Hunsu login, Relay,
Codex, one explicitly granted Workspace, and the Windows/macOS/Linux service
matrix pass. Dispatch stable publication only from the exact stable version
tag with `confirm_stable=true`.

After `0.2.0` is stable, deprecate the prototype line without unpublishing any
version:

~~~sh
npm deprecate "@hunsu/bridge@<0.2.0" \
  "Deprecated prototype runtime contract. Upgrade to @hunsu/bridge >=0.2.0."
~~~
