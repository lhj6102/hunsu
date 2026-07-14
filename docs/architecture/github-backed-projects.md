# GitHub-backed Project architecture

## Durable state

Each repository that contains Hunsu Projects has an application-managed branch:

```text
refs/heads/hunsu/state
```

The branch stores only non-secret product state:

```text
.hunsu/
  workspace.json
  projects/<project-id>/
    project.json
    coach.json
    goals/<goal-id>.json
    runners/<runner-id>.json
    runs/<run-id>.json
    events/<year>/<month>/<event-id>.json
    snapshots/latest.json
```

Event files are authoritative and append-only. The other files are deterministic materializations that can be deleted and regenerated. User source branches do not receive routine product metadata.

## Mutation protocol

Every mutation carries an idempotency key and an expected state-head SHA. The store:

1. reads the exact `hunsu/state` head;
2. rejects a mismatched expected head with a structured stale-state error;
3. replays authoritative events and validates the command in core;
4. derives deterministic event identifiers from the idempotency key and command digest;
5. rejects reuse of a key with a different command digest;
6. writes new event blobs plus regenerated materializations in one tree;
7. creates a commit whose parent is the expected head;
8. advances the ref with a non-forced fast-forward update.

Only one of two sibling commits can advance the ref. A rejected update is a compare-and-swap conflict, never a reason to force the branch.

Stored event envelopes include schema version, event ID, command digest, hashed idempotency key, repository and Project identity, previous state SHA, sequence, actor, timestamp, and the typed domain event. Secrets and raw credentials are rejected before serialization.

## Reconstruction and projections

Reconstruction reads event files from the exact state head, validates ordering and command identity, replays them through core, and regenerates snapshots and disposable query projections. Rebuild does not trust an application database or cached snapshot.

A repository may contain several Projects. The Project Index scans only the intersection of repositories granted to the GitHub App installation and repositories the authenticated user can access. User read/write permission is overlaid on the App grant, and missing or corrupt state is reported explicitly.

Web projections are cacheable and disposable. GitHub state-ref webhooks invalidate them without eagerly reconstructing the repository, while a four-second cache bound lets normal Web polling recover delayed or missed deliveries across API instances. The raw repository grants for one GitHub App installation may be cached for up to sixty seconds and are invalidated by installation or repository-grant webhooks; the authenticated user's current repository permissions are still intersected on every request. GitHub requests are serialized per installation within an API isolate. A primary or secondary rate-limit response establishes an in-memory cooldown for the exact provider retry boundary, while transient or forbidden installation-token failures use short bounded cooldowns to suppress queued retries. Deleting either cache never deletes Project data.

## Run branches and verification

Every Run uses:

```text
hunsu/run/<project-id>/<goal-id>/<run-id>
```

Run start creates the branch at the recorded full base SHA and returns an immutable contract containing Goal and Runner snapshots. Completion is accepted only when the API confirms all of the following:

- repository identity matches the Project;
- the expected Run branch still exists;
- the reported full result SHA exists;
- the result descends from the recorded base SHA;
- the result is reachable from the expected Run branch;
- evidence contains immutable references rather than local paths.

The plugin cannot make a Run complete by assertion alone.

## Authentication and secrets

The service exchanges a short-lived, Contents-write-scoped GitHub App installation token for authorized operations. GitHub App login uses state binding and PKCE, then retains only the user's repository grants in a signed, secure, HttpOnly, SameSite session. MCP uses OAuth with explicit consent and PKCE. Webhook handlers verify the raw request body with the configured HMAC secret and deduplicate delivery identifiers.

Private keys, client secrets, webhook secrets, session secrets, OAuth tokens, installation tokens, and Codex credentials live only in secret storage or short-lived memory. They are never written to GitHub state, evidence, runtime configuration, logs, or plugin files.
