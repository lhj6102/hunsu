# Hub, Origin, And Package Registry

Hub is the Hunsu product area for discovering, editing, forking, and publishing
marketplace packages:

```text
Hub
- Executor Marketplace
  - Team
  - Member

- Hunsu Marketplace
  - Manager

- Skills & Plugins
  - shared independent resource catalog
```

Execute uses Executors. Hunsu uses Managers. Both import Skills & Plugins.
Origin is the immutable read endpoint that serves package versions.
`@hunsu/protocol-registry` defines the package manifest format, integrity
rules, and resolver behavior used by Bridge and the Cloudflare Hub API.

## Cloudflare-Native Hub

The hosted Hub target is Cloudflare native:

```text
apps/web      -> Cloudflare Pages SPA
apps/hub-api  -> Cloudflare Worker
Hub state     -> D1 metadata + R2 immutable blobs
```

`apps/hub-api` is stateless. D1 stores package catalog metadata, immutable
version records, lineage, jobs, and audit log. R2 stores canonical manifest JSON
and package files. There is no always-on Node Hub server or local Hub service
port in the final model.

## Package Manifest V1

```ts
type HubPackageKind = "team" | "member" | "manager" | "skill";

type HubPackageLock = {
  origin: string;
  kind: HubPackageKind;
  key: string;
  version: string;
  integrity: string;
};

type HubPackageManifest =
  | { schema: "hunsu.hub-package-manifest.v1"; kind: "team"; key: string; version: string; team: Harness; integrity?: string }
  | { schema: "hunsu.hub-package-manifest.v1"; kind: "member"; key: string; version: string; member: MemberConfig; integrity?: string }
  | { schema: "hunsu.hub-package-manifest.v1"; kind: "manager"; key: string; version: string; manager: ManagerConfig; integrity?: string }
  | { schema: "hunsu.hub-package-manifest.v1"; kind: "skill"; key: string; version: string; skill: { name: string; contentHash: string; files?: SkillSnapshotFile[] }; integrity?: string };

type Harness = {
  rootTeamId: ExecutorId;
  executors: ExecutorEntity[];
  resources: ResourceEntity[];
  guardrails: GuardrailConfig[];
  artifactActions: ArtifactActionDefinition[];
};

type ManagerConfig = {
  id: ManagerId;
  promptTemplate: PromptTemplate;
  skills: SkillBinding[];
  plugins: PluginRequirement[];
};
```

Plugin references remain requirements on Team, Member, and Manager packages.
Hub does not distribute plugin payloads and does not define a `plugin` package
kind.

## Hub Entities

Hub registrations are entities, not value-object-only manifests. The durable
catalog model has stable identities for:

- package rows
- package version rows
- Team entities
- Member entities
- Team Membership entities
- Manager entities
- Resource entities

Immutable manifests remain version snapshots. They are not the primary domain
identity for Teams, Members, Managers, or Resources.

Team package manifests store a `Harness` Executor graph. A Team Membership is a
directed edge from a parent Team Executor to a direct child Executor. Hub and
runtime validation reject unknown Executor references, visible-profile kind
mismatches, duplicate Memberships, and cyclic Team Memberships.

The Hub UI groups catalog entries as:

- Executor Marketplace
    - Team
    - Member
- Hunsu Marketplace
    - Manager
- Skills & Plugins

`Skills & Plugins` lists immutable Skill package payloads and Plugin
requirement Resource entries. It is a shared resource catalog, not an Execute
or Hunsu scoped package family.

Executor Marketplace cards are entity projections, not a direct dump of package
version rows. Publishing a Team package registers Team entities, Member
entities, and Team Membership edges from the Harness graph. The marketplace
lists those Team and Member entities so a Member inside `team.superloopy.crew`
is searchable as a Member Executor even though its immutable source manifest is
the Team package. Team member counts are derived from Team Membership edges at
read time; they are not stored as independent package summary state.

Hub marketplace list URLs stop at the marketplace root. Kind filters are tag
queries, not path segments:

```text
/hub/executor
/hub/executor?tag=team
/hub/executor?tag=member
/hub/hunsu?tag=manager
/hub/resources?tag=skill
/hub/resources?tag=plugin
```

Detail URLs include the provider-qualified entity or package identity. Public
identity is written as `@provider/entityName`; version identity is
`@provider/entityName@version`.

```text
/hub/executor/team/@hunsu-local/team.superloopy.crew/executors/root-team/versions/1.0.2
/hub/executor/member/@hunsu-local/team.superloopy.crew/executors/build/versions/1.0.2
/hub/hunsu/manager/@hunsu-local/manager.researcher/versions/1.0.0
/hub/resources/skill/@hunsu-local/skill.researcher/versions/1.0.0
/hub/resources/plugin/manager/@hunsu-local/manager.researcher/resources/manager%3Amanager.researcher%3Agithub%40openai-curated/versions/1.0.0
```

## Seed Examples

Seed Hub examples are illustrative package records, not runtime dependencies of
Hunsu itself.

`team.superloopy.crew` is based on `beefiker/superloopy`. It is represented as
a Team package with a root Team planner and direct Members for build, review,
test, gate, audit, and navigation lanes. If a lane needs its own internal
workflow, it may be modeled as a child Team; the parent Team still sees only
that child Team's visible Membership profile.

`team.skills-curation` is based on `vercel-labs/skills`. It is represented as a
Team package whose `discover` Member imports a `skillMeta` resource installed
before runtime with:

```sh
npx skills add <source> --skill <name> --agent codex
```

The package demonstrates how Skills can be curated through Hub while Plugin
requirements remain Resource bindings rather than distributed payloads.

Manager seeds are Hunsu Marketplace examples:

- `manager.hunsu.default`: the built-in HUNSU Draft behavior as a publishable
  Manager config.
- `manager.idea-helper`: divergent ideation and option generation before a
  file-backed Hunsu Draft edit.
- `manager.researcher`: evidence gathering and context synthesis for Hunsu
  Draft work, including `skillMeta` resources from `vercel-labs/skills`.

## Integrity

Manifest integrity uses:

```text
hunsu-json-c14n-v1+sha256:<hex>
```

The canonicalization rule is immutable:

- `schema`, `kind`, `key`, `version`, and execution-affecting payload fields are
  included.
- top-level `integrity` is excluded from its own hash input.
- object keys are sorted recursively.
- arrays preserve order.
- `undefined` object values are omitted.

Publishing computes integrity server-side in the Hub API. Duplicate
`kind/key/version` publishes are rejected. Once published, a package version is
append-only and its manifest R2 key and integrity must not change.

## Origin And Runtime Locks

Roadmap state records only registered Origins and package locks. `origin` is a
committed alias, not an environment variable. Bridge resolves the alias, fetches
`/v1/packages/:kind/:encodedKey/versions/:version`, verifies integrity, and
fails closed on missing package, wrong kind, or mismatch.

Human package links use provider-qualified refs and do not expose the manifest
integrity hash:

```text
/hub/:marketplace/:kind/@:provider/:entityName/versions/:version
/hub/executor/:kind/@:provider/:sourcePackageKey/executors/:executorId/versions/:version
```

Human Plugin requirement Resource links identify the Resource and its owning
package snapshot. They do not include integrity because Plugin requirements are
Resource entities, not immutable package payloads:

```text
/hub/resources/plugin/:packageKind/@:provider/:packageKey/resources/:resourceKey/versions/:version
```

Runtime locks still store `origin`, `kind`, `key`, `version`, and `integrity`.
The integrity hash is verification material for replay and audit, not the
public identity users copy around.

Raw immutable manifests use:

```text
/v1/packages/:kind/:encodedKey/versions/:version
```

Changing origin, kind, key, version, or integrity is a HUNSU transition because
it changes future execution or future Hunsu Draft behavior.

## Deployment

Cloudflare deployment is managed through generated Wrangler config. The source
of truth is the `@hunsu/config/cloudflare` environment contract; generated
files such as `apps/hub-api/.wrangler/generated.toml` are ignored artifacts and
must not be edited or committed.

```sh
HUNSU_DEPLOY_TARGET=local pnpm --filter @hunsu/hub-api config:print
HUNSU_DEPLOY_TARGET=local pnpm --filter @hunsu/hub-api db:migrate:local
HUNSU_DEPLOY_TARGET=local pnpm --filter @hunsu/hub-api dev

HUNSU_DEPLOY_TARGET=production pnpm --filter @hunsu/hub-api db:migrate:remote
HUNSU_DEPLOY_TARGET=production pnpm --filter @hunsu/hub-api deploy
```

The deploy contract is:

```text
HUNSU_DEPLOY_TARGET=local|dev|preview|production
HUNSU_RELEASE_SHA=... # complete Git commit SHA; required outside local
HUNSU_HUB_WORKER_NAME=...
HUNSU_HUB_ORIGIN_NAME=...
HUNSU_HUB_PUBLIC_API_URL=...
HUNSU_HUB_D1_DATABASE_NAME=...
HUNSU_HUB_D1_DATABASE_ID=...
HUNSU_HUB_R2_BUCKET_NAME=...
HUNSU_HUB_PUBLISH_QUEUE_NAME=... # optional
```

`local` has deterministic defaults so developers can print, migrate, and run a
local Worker without provisioning Cloudflare resources first. `dev`, `preview`,
and `production` require an immutable release SHA plus explicit resource names
and IDs so a deployment cannot silently point at the wrong D1 database or R2
bucket. The Worker exposes the configured service, target, origin, and release
identity from the credential-free, non-cacheable `/health` endpoint.

Cloudflare Pages loads `/hunsu-runtime-config.js` before the Web module bundle.
The deployment-specific file is not part of the hashed application assets, so
the same build output can move from preview to production with only this
credential-free overlay changed. It assigns
`window.__HUNSU_WEB_RUNTIME_CONFIG__` using schema
`hunsu.web-runtime-config.v1` and supplies the deploy target, source SHA, exact
Bridge package version, and Bridge, Hub, and Connect API base URLs. Hosted
runtime config rejects mutable npm selectors and incomplete source SHAs.

Bridge Hub development seeds the built-in Team and Manager examples after the Worker becomes
reachable. `pnpm run dev` runs the Hub package `dev` script through Turbo; for
the local target that script applies local D1 migrations, starts Wrangler with a
local-only admin token, and publishes `hubSeedPackageManifests()` through the
same package publish API used by hosted environments. Set
`HUNSU_HUB_SEED_ON_DEV=false` to disable local auto-seeding.

`HUNSU_HUB_ADMIN_TOKEN` is a secret, not generated plaintext Wrangler config.
For local development it may be supplied through `.dev.vars` or the shell
environment. For hosted environments use Cloudflare secrets or equivalent CI
secret injection:

```sh
wrangler secret put HUNSU_HUB_ADMIN_TOKEN --env production
```

Cloudflare Worker vars and secrets are runtime environment values. D1, R2, and
Queue bindings are deployment config. Wrangler environment bindings and vars are
environment-specific, so Hunsu generates the full config for each target instead
of relying on inherited handwritten Wrangler blocks.

Cloudflare Pages hosts `apps/web`. The Web build receives
`VITE_HUNSU_HUB_API_URL` so `/hub` can call the hosted Worker. Bridge Web dev
defaults to `http://127.0.0.1:8787`, or `HUNSU_HUB_PUBLIC_API_URL` when
provided, so root `pnpm run dev` can show local Hub seeds without a separate
Web env file. Bridge remains an npm-distributed runtime and never embeds Hub
secrets.
