# Hunsu

Hunsu is a GitHub-backed Commit-Node graph for Codex. Each immutable commit Node owns its next Goals and one Runner Value, while Runs and Coaching create explicit child Nodes and preserve alternative futures until a user compares their evidence.

GitHub owns durable Project truth. The Hunsu API validates commands and builds disposable Graph and Events projections. The repository-scoped Codex plugin supplies Run, Coaching, and alternative-decision workflows, and Hunsu Web presents only the Node graph and append-only Events.

## Product loop

```text
authorize GitHub
  -> create a Hunsu Project for a repository
  -> confirm a root commit, its next Goals, and one Runner Value
  -> start a singular-Goal Run from a Node
  -> push a result commit and attach evidence
  -> register the verified result as a Run child Node
  -> propose and separately confirm Coaching changes as a same-tree child Node
  -> compare either structural sibling Runs or an exact coached-How experiment cohort
  -> explicitly reject and select alternatives
```

No local daemon, pairing ceremony, command-line setup, or workflow job is part of product execution.

## Domain

- A **Project** defines one repository boundary and exactly one Graph root.
- A **Node** is identified by its full commit SHA and owns `nextGoals[]` plus exactly one `How`.
- A **Runner Value** is immutable and integrity-locked; Player and Team are bundled examples, not an exhaustive union.
- A **Run** digests exactly one Goal and creates a child Node only after verified completion.
- **Coaching** proposes a full replacement Node Plan and creates a metadata-only child commit only after separate confirmation.
- Every non-root Node has one structural parent. Branching is allowed; merging is not.
- A **Comparison** is either structural `sibling_runs` or a non-structural `coached_how_experiment`; neither creates an edge.
- A **Decision** decorates a comparison cohort without creating convergence edges.

See [Domain language](docs/domain-language.md) for the complete contract.

## Durable state

Each authorized repository can have an application-managed `hunsu/state` branch. Append-only events under `.hunsu/v2/projects/<project-id>/events/` are authoritative. Encoded Node payloads, Graph snapshots, and Web projections are derived and may be rebuilt. The v2 runtime never decodes or converts v1 state.

Every write uses an idempotency key and compare-and-swap against the observed state head. Run completion additionally verifies that the reported result commit exists, descends from the recorded base, and is reachable from the expected Run branch.

Credentials and secrets are never repository state. GitHub Actions may run ordinary CI, but cannot start, evaluate, or transition a Hunsu Run.

See [GitHub-backed architecture](docs/architecture/github-backed-projects.md).

## Workspace

```text
apps/api                 HTTP, MCP, authentication, webhook, reconciliation
apps/web                 React presentation and user interaction
packages/protocol        explicit domain commands, events, and codecs
packages/core            pure decisions, transitions, and invariants
packages/github-store    GitHub refs, append-only writes, CAS, reconstruction
packages/projections     disposable Web query models
packages/plugin-contract MCP schemas and immutable RunContract
packages/protocol-registry exact Runner type locks, payload decoders, and trusted executors
packages/config          validated environment configuration
plugins/hunsu            repository-scoped Codex plugin and skills
```

The boundary rules are documented in [Workspace structure](docs/workspace-structure.md).

## Development

Requirements: Node.js 24.18 or newer and pnpm 10.30.2.

```bash
pnpm install
pnpm check
pnpm build
```

Run the services separately:

```bash
pnpm dev:api
pnpm dev:web
```

The API defaults to `127.0.0.1:19687`; Web defaults to `127.0.0.1:19688` and proxies `/api`, `/auth`, `/mcp`, and webhook development traffic to the API. Ports and public URLs are resolved through `@hunsu/config`.

Production API startup requires GitHub App configuration and a session signing secret:

```text
HUNSU_GITHUB_APP_ID
HUNSU_GITHUB_CLIENT_ID
HUNSU_GITHUB_CLIENT_SECRET
HUNSU_GITHUB_PRIVATE_KEY
HUNSU_GITHUB_WEBHOOK_SECRET
HUNSU_GITHUB_APP_SLUG
HUNSU_SESSION_SECRET
HUNSU_PUBLIC_API_URL
HUNSU_WEB_URL
```

Optional endpoint settings are documented in [Local development](docs/local-development.md). Never commit these values.

Production is delivered as one Cloudflare Worker serving Web, API, OAuth, and MCP on `plugin.hunsu.app`. See the [production delivery runbook](docs/deployment/plugin-production.md) for the protected environment contract, CI gate, deployment evidence, smoke tests, rollback, and manual external stops.

## Codex plugin

The repository marketplace at `.agents/plugins/marketplace.json` exposes `plugins/hunsu`. The plugin bundles four focused v2 skills and an OAuth-authenticated MCP server definition. It never holds permanent GitHub credentials and never mutates `hunsu/state` directly.

Validate it with:

```bash
pnpm plugin:validate
```

See [Codex plugin architecture](docs/architecture/codex-plugin.md).

## Product evidence

[Product transition](docs/product-transition.md) records the hypothesis, measurable gates, observed vertical-slice evidence, and the `Proceed`, `Adjust`, or `Reject` decision for this branch.

## License

Apache-2.0. See [LICENSE](LICENSE).
