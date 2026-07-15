# GitHub-backed Commit Node architecture

## Durable state

Each repository with Hunsu Projects has one application-managed branch:

```text
refs/heads/hunsu/state
```

The v2 runtime reads only the breaking v2 root:

```text
.hunsu/v2/
  workspace.json
  projects/<project-id>/
    project.json
    events/<year>/<month>/<event-id>.json
    indexes/events/latest.json
    indexes/events/shards/<shard>.json
    indexes/events/by-domain/<event-id>.json
    nodes/<full-sha>/node.hunsu
    graph/latest.json
    graph/pages/<page>.json
    graph/nodes/<full-sha>.json
    snapshots/latest.json
    snapshots/nodes/<full-sha>/latest.json
    snapshots/nodes/<full-sha>/<activity-kind>/pages/<page>.json
    snapshots/nodes/<full-sha>/{reviews,coaching,comparisons}/by-id/<activity-id>.json
    snapshots/runs/<run-id>.json
```

Event files are authoritative and append-only. Every other file is a deterministic materialization. `project.json`, `graph/latest.json`, `snapshots/latest.json`, and `indexes/events/latest.json` are compact manifests; bounded pages and key-addressed shards live beneath them. Read-model materializations are strict, digest-bound deterministic gzip/base64 envelopes tied to an exact event-log checkpoint; they never contain a complete Node Plan or Runner payload. Existing v1 paths remain untouched but are not decoded, projected, migrated, or dual-written.

The outer GitHub stored-event envelope remains the exact `hunsu.project-event.v2` transport shape. Its opaque payload contains a separate canonical Domain Event envelope: new writes use `hunsu.project-event.v3`, while the decoder accepts only the frozen historical `hunsu.project-event.v2` shapes emitted by origin/main and normalizes them deterministically into the current domain variants. This is narrow event replay compatibility, not v1 state support or a permissive legacy decoder. Reconstruction retains each verified encoded payload in memory so event-log checkpoints continue to bind the authoritative historical digest rather than a v3 re-encoding.

`node.hunsu` is an ASCII envelope containing deterministic gzip plus base64 of the full canonical Node payload: Project id, commit SHA, tree SHA, and Node Plan. The envelope records schema, codec, decoded and encoded size, and decoded SHA-256 digest. Encoding provides opacity and compactness, not confidentiality.

## Node identity and reachability

A Node is identified by `(ProjectId, full commit SHA)`. Every registered Node is anchored by an immutable lightweight tag:

```text
refs/tags/hunsu/node/<project-id>/<full-sha>
```

Root and Run-result Nodes reuse verified repository commits. Confirmed Coaching creates a deterministic metadata-only child commit with the source as its sole parent and the exact same tree. Managed tags and Run branches never move main or a user source branch.

Every non-root Node has one Hunsu structural parent. The state rejects a second incoming edge, self-edge, cycle, missing source, reused result SHA, or mismatched payload digest. A verified Run result may be an ordinary Git merge commit, but it still has one Hunsu parent. Comparisons and decisions decorate completed result Nodes without changing parentage or creating convergence edges.

## Mutation protocol

Every mutation carries an idempotency key and expected state-head SHA. The store:

1. reads the exact `hunsu/state` head;
2. rejects a mismatched expected head with a typed stale-state error;
3. replays authoritative event files and validates the command in core;
4. derives deterministic event identifiers from the idempotency key and command digest;
5. rejects reuse of a key with another command digest;
6. writes new events and regenerated materializations in one tree;
7. creates a commit whose parent is the expected state head;
8. advances `hunsu/state` through a non-forced fast-forward update.

Node commit/ref preparation happens before the state CAS. A CAS failure leaves an unregistered managed ref that is invisible to Graph reconstruction. Repeating the same operation verifies and reuses that commit/ref; it never creates a second Node.

Repository discovery exposes the exact CAS base needed for bootstrap. If `hunsu/state` does not exist, `expectedStateSha` is the current full default-branch head from which the store will create it. If the branch exists but has no `.hunsu/v2` root, v2 reports the repository as uninitialized and uses that existing state head without decoding or migrating v1 content. Once v2 exists, the current state head is both the reconstruction head and the next expected mutation head.

## Reconstruction and projections

Each `node.hunsu` encodes the full canonical Node payload—Project id, commit SHA, tree SHA, and Node Plan—using deterministic gzip and base64. Binding the Plan to its Git identities prevents copying a valid Plan envelope onto another Node.

Reconstruction reads authoritative events from one exact state head, validates envelope ordering and command identity, replays them through core, and regenerates Node payloads and disposable projections. It never trusts an application database or cached snapshot.

Ordinary Project, Graph, Node, Event, and Run reads never replay the event stream. They resolve the exact state head, read `workspace.json` first, and request only `project.json`, a bounded Graph/Event page, or one Node/Run shard at that commit. A missing or invalid v2 materialization is an integrity error; explicit rebuild is the recovery boundary, not a silent replay fallback. Project discovery verifies only the root anchor, Graph cards report topology/materialization integrity, and a selected Node verifies its exact managed tag and commit through a bounded batched boundary.

Graph summary queries do not decode every Node payload. `graph/latest.json` binds deterministic pages of at most 300 Nodes; each page descriptor commits both the exact envelope digest and a Merkle root over its topology identities. Each structural edge is stored with its target page. A child whose parent is on an earlier page carries one bounded membership proof, so a continuation can verify the parent's exact ordinal, SHA, lineage, Project-scoped managed ref, and page commitment without fetching that parent page. A keyed Node shard likewise proves its own identity, its one parent, and every exposed outgoing target against the manifest roots. Its unique `graph/nodes/<full-sha>.json` path is also the authoritative SHA-to-ordinal locator: a Graph-page read batch-fetches at most 300 such shards and requires every card to match its one keyed locator exactly. Consequently the same full SHA cannot validate at two page ordinals, and rebuild materialization rejects a duplicate before writing any locator. Graph cursors are bound to the exact state head. A Graph response's `integrity: valid` means its checkpoint, manifest topology digest, selected page envelope and identity root, keyed SHA locators, membership proofs, and single-parent topology all validate; missing, duplicate, unused, or foreign proofs fail closed. Project discovery verifies the root managed ref, while selecting a Node additionally verifies that Node's exact managed ref and commit before returning its payload.

Events use append-stable chronological shards of at most 256 entries and scan at most four shards per filtered request. A continuation is returned even when a bounded filtered scan finds fewer than 50 matches, and the cursor is bound to the exact state head. Event detail resolves a key-addressed locator, reads exactly one authoritative Event file, strictly decodes its envelope, and cross-checks its path and indexed metadata.

Node activity is physically partitioned by Node, activity kind, and pages of at most 50 entries. `snapshots/nodes/<sha>/latest.json` remains constant-size as activity grows: each kind stores only its exact entry count, derived page count, and one checkpoint-bound Merkle root. Every deterministic page path carries the membership proof for its exact checkpoint, kind, offset, and entries; proofs have a fixed safe-depth bound. List cursors are exact-head offsets and fetch only the one or two pages intersecting a request. The Node inspector fetches only the newest non-empty page for each kind, while active Runs remain available from the bounded Graph Node shard. Coach reviews, Coaching proposals, and alternative comparisons also have key-addressed `by-id` records, so `get` reads never scan lifetime pages. Each keyed record contains one required page/entry locator; `get` Merkle-verifies that page and requires the record to equal its committed slot before checking the complete record against its authoritative Event. Run detail continues to use `snapshots/runs/<run-id>.json`. These reads expose recorded state only and never reconstruct a mutation from an abbreviated Node card. Exact-head files and decoded manifests are cached by repository and state SHA; GitHub state-ref webhooks invalidate caches and bounded polling recovers missed deliveries without bypassing provider cooldowns.

## Run branches and verification

Every Run starts from the source Node SHA and uses exactly one Goal plus the Node's Runner value. The API creates the managed Run branch and returns `RunContract v2`. Completion is accepted only when repository identity, branch existence, result existence, ancestry, branch reachability, non-self result, and immutable evidence all verify.

An active, failed, or canceled Run creates no structural edge. A completed Run atomically records its terminal event, result Node, Run edge, and evidence. The result Node inherits the source Runner and all Goals except the consumed Goal.

## Comparison cohorts and decisions

Comparison is a non-structural event with one required discriminant:

- `sibling_runs` contains at least two completed Run results whose actual Run records bind them to one shared source Node. Its cohort key is the Project and structural parent.
- `coached_how_experiment` contains at least two completed Run results produced from distinct sources. Every source is either the declared anchor or one of its direct, confirmed Coaching children; each Coaching source preserves the anchor tree. All candidate Runs bind the same canonical Goal digest, and all source Node Plans are canonical-byte-identical except for How. Its cohort key is the Project, anchor, and Goal digest.

Every finding summarizes every included result Node exactly once. Candidate sets may be compared repeatedly under the same cohort key, but overlapping candidate sets cannot claim different cohort identities and a cohort can have at most one selected result. Recording a comparison changes no Node or edge. Selection and rejection are separate, explicitly confirmed events that decorate included result Nodes; they never move a source ref, merge Git commits, add a second parent, or converge graph branches.

## Runner capability discovery

Runner capabilities come from the trusted deployed registry and executor runtime, not from repository state. The read-only, repository-scoped `hunsu.runner_capabilities.list` operation returns a cursor/limit-bounded catalog; `hunsu.runner_capabilities.get` resolves one exact `RunnerTypeLock`. Results expose only the lock, display name, schema digest, native schema AST, and `runContractResolution: { status: "available" }`. They expose no executor, code, credential, or mutable runtime handle. Bootstrap and Coaching must resolve a capability before accepting an initial or changed How; Player and Team remain bundled examples rather than a closed type set.

## Authentication and secrets

The service uses short-lived Contents-write GitHub App installation tokens. GitHub login and MCP OAuth retain only scoped grants in secure sessions. MCP access tokens are short-lived and audience-bound; refresh grants use fixed-lifetime, server-side families with atomic rotation and replay revocation. Durable refresh state stores only strict authorization context plus token digests, never raw tokens. Private keys, client secrets, webhook secrets, OAuth tokens, installation tokens, Codex credentials, and mutable local paths never enter Node payloads, Events, logs, or plugin files.
