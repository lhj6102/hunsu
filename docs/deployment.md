# Preview And Production Deployment

Hunsu deploys from this repository. `hunsu-ops` and developer machines are not
part of the release path.

## Release Flow

```text
push/merge into preview
  -> validate source
  -> build one neutral Web bundle plus exact Hub and Connect Worker modules
  -> wait for the exact-SHA @hunsu/bridge candidate publication
  -> verify candidate tarball, npm registry integrity, and candidate-next
  -> retain the release manifest, exact files, and migration digests
  -> apply preview Hub and Connect migrations
  -> deploy preview Hub, Connect, and Web
  -> verify release identity at preview.hunsu.app, Hub, and Connect
  -> retain preview evidence
  -> automatically open or retain the preview -> main promotion PR

QA leader approves the exact preview branch head on the preview -> main PR
  -> merge PR into main
  -> verify main tree equals the QA-approved preview tree
  -> download the retained preview release; do not rebuild it
  -> verify preview evidence and manifest digest
  -> record production Time Travel bookmarks for both D1 databases
  -> apply the same retained Hub and Connect forward migrations
  -> deploy the same retained Hub and Connect Worker modules
  -> deploy the same neutral Web files with only the production runtime overlay
  -> verify production release identity
```

Any source change, dependency change, migration change, or failed preview fix
requires a new preview deployment and a fresh QA approval. Production never
falls back to building from `main`.

The preview workflow is [deploy-preview.yml](../.github/workflows/deploy-preview.yml).
The production workflow is
[deploy-production.yml](../.github/workflows/deploy-production.yml). Both call
the same retained-release procedure in
[deploy-cloudflare.yml](../.github/workflows/deploy-cloudflare.yml).
Code-only rollback uses
[rollback-cloudflare.yml](../.github/workflows/rollback-cloudflare.yml).

## GitHub Environments

Create these environments and restrict their deployment branches:

| Environment | Allowed branch | Secret |
| --- | --- | --- |
| `hunsu-preview` | `preview` | `CLOUDFLARE_API_TOKEN`, `HUNSU_CONNECT_SIGNING_PRIVATE_JWK` |
| `hunsu-production` | `main` | `CLOUDFLARE_API_TOKEN`, `HUNSU_CONNECT_SIGNING_PRIVATE_JWK` |

Use separate least-privilege Cloudflare tokens for preview and production,
stored under the same secret name. Each token needs Account-level Edit for
Cloudflare Pages, Workers Scripts, D1, and Workers R2 Storage. Do not register
the broad local deployment token or an npm token.

The reusable deployment job selects the protected environment itself, so these
remain environment secrets and are not inherited or passed by the caller
workflow. This keeps preview callers unable to receive production credentials.

Add these non-secret variables to both environments. The names are identical;
the values select isolated resources:

```text
CLOUDFLARE_ACCOUNT_ID
HUNSU_WEB_PAGES_PROJECT
HUNSU_WEB_PUBLIC_URL
HUNSU_BRIDGE_API_BASE_URL
HUNSU_CONNECT_API_BASE_URL
HUNSU_CONNECT_WORKER_NAME
HUNSU_CONNECT_D1_DATABASE_NAME
HUNSU_CONNECT_D1_DATABASE_ID
HUNSU_CONNECT_ACCESS_ISSUER
HUNSU_CONNECT_ACCESS_AUD
HUNSU_CONNECT_SIGNING_PUBLIC_JWK
HUNSU_CONNECT_SIGNING_KEY_ID
HUNSU_HUB_WORKER_NAME
HUNSU_HUB_ORIGIN_NAME
HUNSU_HUB_PUBLIC_API_URL
HUNSU_HUB_D1_DATABASE_NAME
HUNSU_HUB_D1_DATABASE_ID
HUNSU_HUB_R2_BUCKET_NAME
```

Required exact values:

| Variable | Preview | Production |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | `a5e99f3b23c16ac20da1d55d34504e28` | `a5e99f3b23c16ac20da1d55d34504e28` |
| `HUNSU_WEB_PAGES_PROJECT` | `hunsu-web-preview` | `hunsu-web` |
| `HUNSU_WEB_PUBLIC_URL` | `https://preview.hunsu.app` | `https://hunsu.app` |
| `HUNSU_BRIDGE_API_BASE_URL` | `http://127.0.0.1:19687` | `http://127.0.0.1:19687` |
| `HUNSU_CONNECT_API_BASE_URL` | `https://connect.preview.hunsu.app` | `https://connect.hunsu.app` |
| `HUNSU_CONNECT_WORKER_NAME` | `hunsu-connect-preview` | `hunsu-connect` |
| `HUNSU_CONNECT_D1_DATABASE_NAME` | `hunsu_connect_preview` | `hunsu_connect` |
| `HUNSU_CONNECT_D1_DATABASE_ID` | `38cc819b-2405-47a6-925e-0d5d7de731c4` | `c71aed30-29ff-48aa-ba76-866add7f8198` |
| `HUNSU_CONNECT_ACCESS_ISSUER` | exact `https://<team>.cloudflareaccess.com` issuer | same exact team issuer |
| `HUNSU_CONNECT_ACCESS_AUD` | preview Access application AUD | production Access application AUD |
| `HUNSU_CONNECT_SIGNING_PUBLIC_JWK` | preview public P-256 JWK | production public P-256 JWK |
| `HUNSU_CONNECT_SIGNING_KEY_ID` | `connect-vd_GiPDTK2lPIDS3Y2dDIEck` | `connect-Ea21pgXVRp5WfId1kXKSeyea` |
| `HUNSU_HUB_WORKER_NAME` | `hunsu-hub-api-preview` | `hunsu-hub-api` |
| `HUNSU_HUB_ORIGIN_NAME` | `hunsu` | `hunsu` |
| `HUNSU_HUB_PUBLIC_API_URL` | `https://api.preview.hunsu.app` | `https://api.hunsu.app` |
| `HUNSU_HUB_D1_DATABASE_NAME` | `hunsu_hub_preview` | `hunsu_hub` |
| `HUNSU_HUB_D1_DATABASE_ID` | `348e2174-ddf2-4126-be51-603e6e986f08` | `4523fd88-b827-4015-9aa4-e05c0499ece7` |
| `HUNSU_HUB_R2_BUCKET_NAME` | `hunsu-hub-packages-preview` | `hunsu-hub-packages` |

The deploy procedure rejects preview resource names in production and requires
all mutable preview resource names to contain a `preview` segment. The Origin
name is a public package-provider identity, so it remains `hunsu` in both
environments; resource isolation does not require a second Origin identity.
Every value, including account and D1 IDs, must also equal the committed
[`cloudflare-resources.json`](../scripts/deployment/cloudflare-resources.json)
allowlist before a credentialed mutation can run.

Create the Pages projects, both D1 databases, and R2 buckets before the first
deployment. The workflow idempotently associates the exact
`HUNSU_WEB_PUBLIC_URL` hostname with its Pages project through Cloudflare's
[Pages domain API](https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/domains/)
and waits for `active` before smoke testing. The retained
Wrangler configuration creates or updates the Hub Worker and attaches
`HUNSU_HUB_PUBLIC_API_URL` as its Worker Custom Domain using the environment's
Workers Scripts token. The Connect configuration similarly attaches only the
exact `HUNSU_CONNECT_API_BASE_URL` custom domain and disables `workers.dev` and
preview URLs. Production deployment deliberately never auto-creates or renames
storage resources.

## Cloudflare Access Login Boundary

Cloudflare Access protects only Connect's interactive identity routes. Connect
still validates every `Cf-Access-Jwt-Assertion` itself with the exact team
issuer and application AUD before creating its own HttpOnly browser session.
The Web sign-in button performs a top-level navigation to `/auth/login`; after
Access succeeds, Connect creates that session and redirects only to the exact
environment Web origin at `/studio`. It does not accept a caller-controlled
return URL.
Device authorization polling, token rotation, and the device WebSocket remain
public endpoints with their own proof-of-possession credentials; putting Access
in front of all Connect routes would break
those headless clients.

Create two **Self-hosted** Access applications:

| Environment | Application domain | Path | Audience |
| --- | --- | --- | --- |
| Preview | `connect.preview.hunsu.app` | `/auth/*` | distinct preview AUD |
| Production | `connect.hunsu.app` | `/auth/*` | distinct production AUD |

For each application, add an Allow policy whose Include rule is **Cloudflare
Account Member**. Use Cloudflare as the identity provider with account-member
restriction enabled. This initially limits login/approval to members of the
Cloudflare account, including `lhj6102`; a broader QA identity policy can be
introduced later as a separately reviewed change.

Enable the binding cookie and HttpOnly cookie attributes, keep SameSite=Lax,
disable the app launcher entry, and leave preflight bypass off. Create separate
applications rather than combining both hostnames in one Access application.

Copy the Zero Trust team issuer into `HUNSU_CONNECT_ACCESS_ISSUER` in both
GitHub environments, and copy each application's distinct AUD into its matching
`HUNSU_CONNECT_ACCESS_AUD`. These identifiers are non-secret, but they are exact
authentication identity locks validated before deployment. Never store an
Access admin token in GitHub. The routine
preview and production deployment tokens do not need Access application or
policy permissions.

Each Connect deployment validates that the protected private P-256 JWK matches
the environment's committed public JWK, then supplies it to the same atomic
Wrangler deployment as the retained Worker module. The short-lived secret file
is current-user-only on the ephemeral runner and is removed immediately after
the upload, so a signing-key rotation cannot expose a mismatched public/private
deployment window.

After each Hub Worker deployment, the workflow generates a fresh high-entropy
admin token in runner memory, sends it to `wrangler secret put` over standard
input, seeds the immutable built-in examples, and then drops the local token.
The token is never an argument, GitHub output, environment registration, or
artifact. Existing seed versions return `409` and are intentionally skipped.

Set the `hunsu-web-preview` Pages project's production branch to `preview` and
the `hunsu-web` project's production branch to `main`; this makes each custom
domain point at the deployment created with the workflow's exact branch.

## QA Gate

Add the repository variable:

```text
HUNSU_QA_LEADERS=github-login-1,github-login-2
```

A production push is authorized only when all of these hold:

- the push is the merge result of exactly one `preview` to `main` PR;
- the PR's exact head SHA has a current `APPROVED` review from a configured QA
  leader who is not the PR author, submitted after the successful preview run
  completed;
- the corresponding preview workflow completed successfully;
- its unexpired retained release and preview-evidence artifacts exist; and
- the `main` tree is byte-for-byte the same Git tree as the preview PR head.

The successful preview workflow opens the promotion PR with
`github-actions[bot]` as its author. This lets `lhj6102` act as the configured
QA leader: GitHub does not allow a PR author to approve their own PR. If a
maintainer manually authored an existing promotion PR, close it and rerun the
preview workflow so the automation can open the reviewable PR.

The four headless checks run on the protected `preview` push. The successful
preview deployment itself publishes the required `Promotion candidate ready`
check on that same exact SHA, then opens the PR. The main promotion PR therefore
does not need a second `pull_request` workflow or an automation credential. The
QA leader submits the one human PR approval only after the exact preview
deployment has completed and QA has passed.

If `main` advanced, merge `main` into `preview`, wait for a new preview deploy,
repeat QA, and then merge the refreshed PR.

The `Promotion candidate ready` check succeeds only when the exact preview
deploy job has completed its retained release, preview evidence, and
Bridge-candidate verification; `always()` makes the check fail explicitly when
that deploy fails instead of becoming a skipped required job.

## Artifact Identity

`scripts/deployment/build-release.mjs` writes
`hunsu.deployment-release.v3`. It binds the source commit and tree, exact Bridge
package version, build tool versions, every Web/Worker/migration file hash, and
the neutral runtime-config contract. A valid release must contain both prebuilt
Worker modules and both retained migration inventories. Production verifies
the whole file set and every digest before deployment.

Preview also waits for the successful `publish-bridge.yml` push run for the
same SHA. It downloads `bridge-candidate-<sha>`, recomputes the tarball SHA-256
and SHA-512 integrity, verifies the exact npm registry record and
`candidate-next`, and binds that identity into preview evidence. Production
rechecks the exact immutable npm version and integrity from that evidence; it
does not depend on the movable tag still pointing at the version later.

The Web output is built once with a null `hunsu-runtime-config.js` placeholder.
The shared deployment procedure overwrites only that credential-free file with
the selected target, source SHA, exact Bridge package version, and API bases.
The compiled Web modules and Worker modules are never rebuilt during promotion.
The hosted runtime overlay requires an explicit local Bridge API base and
Connect API base. This prevents a missing value from silently sending Bridge
`/health` requests to Cloudflare Pages or disabling the intended environment.

## Database Safety And Rollback

Preview and production have separate Hub and Connect D1 data. Data is never
copied or promoted; only the retained, hashed migration files are applied
independently. Migrations must use expand/contract compatibility so both the
previous and new Workers can operate during rollback.

Before production migrations, the workflow stores Time Travel bookmarks for
both D1 databases in an immediate dedicated recovery artifact before any
migration begins. A normal
rollback accepts only an exact successful preview run; production rollback also
requires an unexpired success artifact proving that release was previously
deployed to production. Rollback executes current `main` deployment tooling,
redeploys the previous retained Web/Worker release, and does **not** reverse
migrations. Use a forward fix by default. A Time Travel restore is destructive
and must be performed as a separate, explicitly approved incident action after
assessing data loss.

Cloudflare credentials are injected only into the individual D1, Worker,
Pages-domain, and Pages mutation steps. Checkout, dependency installation,
build, artifact verification, and smoke scripts do not receive the token.
