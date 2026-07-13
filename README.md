# Hunsu

Hunsu is GitHub-backed divergent project management for Codex. It combines familiar Project and Goal views with an execution model that preserves several possible futures until a user compares the evidence and chooses one.

GitHub owns durable Project truth. The Hunsu API validates commands and builds disposable query projections. The repository-scoped Codex plugin supplies the execution workflow, and Hunsu Web presents Project, Goal, Runner, Run, Coach, and comparison views.

## Product loop

```text
authorize GitHub
  -> create a Hunsu Project for a repository
  -> define an outcome-oriented Goal
  -> assign a Player or Team Runner
  -> start a Run through the Codex plugin
  -> push a result commit and attach evidence
  -> let the API verify the GitHub branch and commit
  -> review the completed Run in Web
  -> create and compare a same-base alternative
  -> explicitly select the future that continues
```

No local daemon, pairing ceremony, command-line setup, or workflow job is part of product execution.

## Domain

- A **Project** is one initiative in one GitHub repository.
- A **Goal** is a desired outcome with acceptance criteria and constraints.
- A **Runner** is exactly a **Player** or **Team**.
- A **Run** is one immutable execution of a Runner against a Goal snapshot.
- A **Coach** reviews evidence and proposes changes; it cannot confirm consequential choices.
- **Hunsu** creates an intentional sibling future from the same base commit.
- A **Decision** records the user's explicit selection or rejection after comparison.

See [Domain language](docs/domain-language.md) for the complete contract.

## Durable state

Each authorized repository can have an application-managed `hunsu/state` branch. Append-only events under `.hunsu/projects/<project-id>/events/` are authoritative. Materialized JSON and Web query projections are derived and may be rebuilt.

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
packages/protocol-registry exact versioned Runner, Coach, Skill, and resource locks
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

## Codex plugin

The repository marketplace at `.agents/plugins/marketplace.json` exposes `plugins/hunsu`. The plugin bundles five focused skills and an OAuth-authenticated MCP server definition. It never holds permanent GitHub credentials and never mutates `hunsu/state` directly.

Validate it with:

```bash
pnpm plugin:validate
```

See [Codex plugin architecture](docs/architecture/codex-plugin.md).

## Product evidence

[Product transition](docs/product-transition.md) records the hypothesis, measurable gates, observed vertical-slice evidence, and the `Proceed`, `Adjust`, or `Reject` decision for this branch.

## License

Apache-2.0. See [LICENSE](LICENSE).
