# `plugin.hunsu.app` production delivery

Hunsu production is one Cloudflare Worker named `hunsu-plugin-production`. It serves the Web assets and the API, OAuth, webhook, and MCP routes from `https://plugin.hunsu.app`. GitHub Actions performs repository CI and application delivery only. It never starts or transitions a Hunsu Run and never writes `hunsu/state`.

The active delivery loop is:

```text
pull request to main
  -> CI / validate
  -> squash merge
  -> deploy the exact main SHA
  -> custom-domain smoke tests
  -> completion, a code-fix PR, or a manual external stop
```

The retired `preview` promotion workflow is not a production gate. Old Pages, Worker, D1, R2, and domain resources are historical rollback evidence until they are deliberately removed; this workflow does not delete them.

The final inactive delivery state is preserved by the protected annotated tag
[`archive/preview-final-2026-07-13`](https://github.com/lhj6102/hunsu/releases/tag/archive/preview-final-2026-07-13)
and its GitHub Release. The remote `preview` branch and its promotion pull request were closed only after that Release was verified. The active `Immutable archive tags` repository ruleset prevents matching archive tags from being updated or deleted while still allowing future archive tags to be created.

## GitHub environment contract

The deployment job is attached to the existing `hunsu-production` environment. Keep existing entries during the initial cutover and configure these entries before running it.

| Kind | Name | Contract |
| --- | --- | --- |
| Variable | `CLOUDFLARE_ACCOUNT_ID` | 32-character account ID for the account that owns the active `hunsu.app` zone |
| Secret | `CLOUDFLARE_API_TOKEN` | Token scoped to deploy this Worker, its secrets and Durable Object migration, and its custom domain |
| Variable | `HUNSU_GITHUB_APP_ID` | Positive numeric GitHub App ID |
| Variable | `HUNSU_GITHUB_CLIENT_ID` | GitHub App OAuth client ID |
| Variable | `HUNSU_GITHUB_APP_SLUG` | Lower-case GitHub App slug |
| Secret | `HUNSU_GITHUB_CLIENT_SECRET` | OAuth code-exchange secret |
| Secret | `HUNSU_GITHUB_PRIVATE_KEY` | PEM installation-token signing key |
| Secret | `HUNSU_GITHUB_WEBHOOK_SECRET` | Webhook HMAC secret |
| Secret | `HUNSU_SESSION_SECRET` | At least 32 characters |

Repository-owned constants are not environment values:

```text
HUNSU_PUBLIC_API_URL=https://plugin.hunsu.app
HUNSU_WEB_URL=https://plugin.hunsu.app
Worker name=hunsu-plugin-production
```

The first production script validates the environment name, requires `refs/heads/main`, verifies that the checked-out commit and fetched `origin/main` head both equal the event's exact main SHA, checks every required entry, and checks the value formats that can be validated locally. This rejects a `workflow_dispatch` request aimed at any branch or tag other than `main`, and it rejects rerunning a stale workflow after `main` has advanced, even if environment policy is later changed. It receives the protected values only for validation and emits names, never values. A missing or invalid entry stops before dependency installation and before any Cloudflare API call. Missing configuration uses this exact stop summary:

```text
MANUAL_EXTERNAL_CONFIGURATION_REQUIRED

Missing:
- hunsu-production secret HUNSU_GITHUB_PRIVATE_KEY
- hunsu-production variable HUNSU_GITHUB_APP_SLUG

No Cloudflare mutation was attempted.
Current main SHA: <sha>
Safe to rerun after configuration: yes
```

Invalid entries appear in a separate `Invalid:` list with the same heading and footer. Fix the GitHub environment, then use **Deploy plugin.hunsu.app → Run workflow** to redeploy the same main SHA. Do not create a placeholder commit.

## CI contract

[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) runs for pull requests to `main` and pushes to `main`. Its required check is `CI / validate`. It uses Node.js 24.18.0 and pnpm 10.30.2, installs the frozen lockfile, runs `pnpm check` and `pnpm build`, validates the generated Worker environment types plus the Plugin and production contracts, writes a credential-free test-SHA runtime overlay, dry-runs the Worker bundle, verifies that the Node server entrypoint is absent, and runs the Cloudflare adapter and OAuth Durable Object suite.

CI has only `contents: read`. It does not reference `hunsu-production`, receive Cloudflare or GitHub App credentials, call a mutating Wrangler command, create GitHub Project state, or modify `hunsu/state`.

Useful local commands are:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm build
node scripts/deployment/validate-production-contract.mjs
node scripts/deployment/write-web-runtime-config.mjs --source-sha 0123456789abcdef0123456789abcdef01234567
mkdir -p .artifacts
pnpm exec wrangler deploy --dry-run --outdir .artifacts/worker-bundle --metafile .artifacts/worker-bundle-meta.json
node scripts/deployment/validate-worker-bundle.mjs --bundle-dir .artifacts/worker-bundle --metafile .artifacts/worker-bundle-meta.json
pnpm run test:cloudflare
```

The runtime overlay written to `apps/web/dist/hunsu-runtime-config.js` is exact and credential-free:

```js
window.__HUNSU_WEB_RUNTIME_CONFIG__ = Object.freeze({
  schema: "hunsu.web-runtime-config.v3",
  target: "production",
  sourceSha: "<exact-main-sha>",
  apiBaseUrl: ""
});
```

## Production deployment

[`.github/workflows/deploy-plugin-production.yml`](../../.github/workflows/deploy-plugin-production.yml) runs on pushes to `main` and by `workflow_dispatch`. Its concurrency group is `hunsu-plugin-production` with `cancel-in-progress: false`; a newer run never cancels an in-progress production deployment. Checkout uses the exact event SHA and full Git history.

After repeating the full CI gate, the workflow reads the current production deployment and runs a one-attempt custom-domain smoke suite. Only a deployment that passes becomes a rollback candidate. Failure to establish a candidate does not block a first deployment or a repair deployment, but means automatic rollback is not feasible.

Runtime secrets are written to a mode-`0600` file in `RUNNER_TEMP`, never printed, and removed by a shell trap. One pinned Wrangler invocation performs the atomic upload:

```text
wrangler deploy --secrets-file <temporary-file>
```

The same deploy uploads code and static assets, supplies the three non-secret GitHub App variables, applies the Durable Object migration, and attaches the configured `plugin.hunsu.app` custom domain. It does not run separate `wrangler secret put` commands. `WRANGLER_OUTPUT_FILE_PATH` captures Wrangler's NDJSON deploy record, including the Worker version ID. A subsequent credentialed read matches that version to the Cloudflare deployment ID.

The custom domain is configuration-as-code in `wrangler.jsonc`. Cloudflare requires an active zone and cannot create a Custom Domain over an existing CNAME. Wrangler applies the domain during deploy and Cloudflare creates the DNS record and certificate. See [Cloudflare Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) and [Cloudflare's GitHub Actions deployment guidance](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/).

## Production smoke suite

All smoke requests go to `https://plugin.hunsu.app`, never a `workers.dev` URL:

| Check | Required observation |
| --- | --- |
| `GET /` | `200`, HTML, title `Hunsu Projects`, SPA root |
| `GET /projects` | `200` and the SPA shell, not a `404` |
| `GET /hunsu-runtime-config.js` | exact production overlay, empty API base, exact main SHA |
| `GET /api/session` without cookies | `200` JSON with `authenticated=false`, not SPA HTML |
| protected-resource metadata | `200`, MCP resource `https://plugin.hunsu.app/mcp` |
| authorization-server metadata | `200`, issuer and endpoints on `plugin.hunsu.app` |
| unauthenticated `POST /mcp` | `401` and the production protected-resource challenge |
| `GET /api/auth/github?return_to=/` | `302` to GitHub with the production callback and PKCE |

The suite runs the eight independent checks concurrently within each bounded polling attempt, and bounds response bodies, request time, and retries so a failed deployment still leaves time for rollback verification. Its JSON contains only check names, HTTP status, timing, and concise credential-free messages. It never persists response bodies, cookies, authorization headers, OAuth state, codes, PKCE material, or redirect query values.

## Evidence and success

The job succeeds—and GitHub marks the environment deployment successful—only after every smoke check passes. It uploads this artifact:

```text
plugin-production-evidence-<main-sha>
```

The JSON records the exact source SHA, fixed Worker and domain, Cloudflare deployment ID, Worker version ID, deployment timestamp, pinned Wrangler version, eight sanitized smoke results, Plugin endpoint, and observed Web runtime SHA. The evidence writer rejects incomplete smoke output and credential-shaped content. Tokens, private keys, session or webhook secrets, cookies, OAuth state, and OAuth codes are never artifacts.

## Rollback and retry

If upload succeeds but smoke tests fail, the job fails. When the pre-deploy version passed the full suite, the workflow rolls back explicitly to that Worker version and verifies the restored custom domain with its recorded source SHA. Rollback changes only Worker code and assets; it never rolls back GitHub Project data. If this is the first deployment, the previous deployment was already unhealthy, or restoration fails, the job reports that automatic rollback was unavailable or unsuccessful and remains failed.

For a repository-owned failure—TypeScript, tests, bundling, Worker routing, overlay generation, Plugin endpoint, response contract, or smoke implementation—make the smallest complete fix on a new `codex/plugin-production-fix-<sequence>` branch, open a PR to `main`, wait for `CI / validate`, squash merge, and observe the next deployment.

For Cloudflare account, DNS, certificate, billing, resource-limit, or token-permission failures, do not make a speculative code change. Common manual actions are:

- Missing active zone: Cloudflare Dashboard → add or activate `hunsu.app` in the configured account.
- DNS conflict: Cloudflare Dashboard → `hunsu.app` → DNS → remove or rename an existing `plugin.hunsu.app` CNAME/A/AAAA record. The workflow never deletes it.
- Old Pages domain: Cloudflare Dashboard → Workers & Pages → old Pages project → Custom domains → detach `plugin.hunsu.app`.
- Token failure: replace or expand `CLOUDFLARE_API_TOKEN` in `hunsu-production` so it can deploy the Worker, secrets, Durable Object migration, and custom domain.
- Pending certificate: inspect Workers & Pages → `hunsu-plugin-production` → Settings → Domains & Routes and SSL/TLS → Edge Certificates. Retry after the hostname is active.

Production GitHub App registration must be:

```text
Homepage: https://plugin.hunsu.app
Callback: https://plugin.hunsu.app/api/auth/github/callback
Webhook: https://plugin.hunsu.app/api/github/webhooks
Repository permission: Contents read and write
Webhook events: Push, Installation, Installation repositories
```

Do not weaken OAuth or redirect validation to compensate for an incorrect registration.

When external configuration blocks delivery, report it exactly as:

```text
MANUAL EXTERNAL ACTION REQUIRED

Current main SHA:
<sha>

Workflow run:
<run reference>

Failed step:
<step>

External system:
Cloudflare | GitHub App | GitHub Environment

Reason:
<precise error>

Required manual action:
1. <exact dashboard path>
2. <exact value or setting>
3. <verification step>

Repository changes required:
no

Safe to rerun the current main SHA:
yes

Rerun method:
Deploy plugin.hunsu.app -> Run workflow
```
