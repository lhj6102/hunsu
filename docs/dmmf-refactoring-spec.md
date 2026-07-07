# DMMF Refactoring Spec

## Purpose

Refactor the Hunsu/Kibitz domain model toward Scott Wlaschin's Domain Modeling Made Functional style.

The goal is not to rewrite the product model. The existing Roadmap language is useful and should remain. The refactor should make that language harder to misuse by moving more domain rules into TypeScript types and explicit workflow results.

## Current Shape

The project already has a meaningful domain layer:

- `docs/domain-model.md` and `docs/ubiquitous-language.md` define the product language.
- `packages/protocol/src/model.ts` models many domain choices as discriminated unions, including `Command`, `DomainEvent`, `HarnessSnapshot`, `HunsuTarget`, `BoardEdge`, and artifact ownership.
- `packages/protocol/src/workflow.ts` centralizes command handling, event projection, invariant checks, and protocol validation.
- `packages/core/src/domain-store.ts` persists append-only Git-backed domain events.

The DMMF gaps are mostly around unsafe primitive values, optional-field state encoding, and exception-based workflow failure.

## Refactoring Objectives

1. Make impossible Roadmap states unrepresentable where practical.
2. Replace broad primitive aliases with branded domain primitives and smart constructors.
3. Represent lifecycle states with OR types instead of status strings plus optional fields.
4. Separate unvalidated input, validated commands, durable events, and projected records.
5. Return explicit `Result` values from validation and workflow boundaries before throwing at CLI/server edges.
6. Remove legacy compatibility shims instead of preserving old APIs by default.
7. Preserve append-only event semantics and current Roadmap vocabulary.

## Breaking Change Policy

Legacy compatibility is not required for this refactor. This refactor may make
breaking changes intentionally, and it does not need a transitional compatibility
path.

Breaking changes are allowed when they make the domain model more explicit,
remove invalid states, or eliminate compatibility-only APIs. When a breaking
change is made, update the in-repo callers, tests, and docs in the same change.

The only compatibility boundary to preserve is the product/domain meaning of
Roadmap, Team, Member, Manager, Hunsu, MOVE, Destination, Skill Draft, Harness,
and Skills & Plugins.
Code-level APIs, intermediate projections, command shapes, and test fixtures may
change as needed.

Compatibility-only constructs should be deleted during the refactor instead of
kept as deprecated aliases, throwing wrappers, adapter functions, or dual API
paths.

## Non Goals

- Do not redesign the Roadmap, Team, Hunsu, MOVE, or Artifact Actions concepts.
- Do not change Git-backed event storage format unless there is a dedicated migration path.
- Do not introduce a large functional programming library unless the local code genuinely needs it.
- Do not refactor Studio UI styling or unrelated runtime code as part of the domain modeling pass.
- Do not preserve old public APIs, type aliases, optional fields, projection aliases, throwing wrappers, adapter functions, or dual API paths solely for compatibility.

## Domain Modeling Rules

### Type-Based Thinking

Domain values should say what they are, not only how they are stored.

Replace raw aliases such as:

```ts
export type RequestId = string;
export type DestinationId = string;
export type MoveId = string;
```

with branded domain primitives:

```ts
export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type RequestId = Brand<string, "RequestId">;
export type DestinationId = Brand<string, "DestinationId">;
export type MoveId = Brand<string, "MoveId">;
```

Create smart constructors for values with constraints:

- IDs: `makeRequestId`, `makeDestinationId`, `makeMoveId`, `makeLineId`, `makeNodeId`, `makeHunsuId`.
- text fields: `makeNonEmptyText`, or specific `DestinationTitle`, `RequestGoal`, `Summary`, `EvidenceText`.
- counts and budgets: `makePositiveInt`, `makeMoveOrdinal`, `makeMaxAttemptCount`.
- timestamps: either keep ISO strings as serialized values or introduce `IsoTimestamp` with parsing.

Raw external data may remain `unknown` or unvalidated DTOs. It should become domain data only after construction succeeds.

### AND Types

Use object types for values that require all fields together.

Good examples to keep or strengthen:

- `HarnessSnapshot` values for Team ExecutionPlan runs
- `MemberConfig`
- `ManagerConfig`
- `SkillBinding`
- `AgentConversationRef`
- `WorktreeRef`
- `ArtifactActionDefinition`

Avoid vague transport names such as `data`, `payload`, or broad records with many unrelated optional fields.

For Artifact Actions, keep runner, environment, alias, and evidence settings as
validated domain values. Do not encode half-valid settings such as
`required: false`, empty aliases, or aliases that mix mutually exclusive target
and service fields.

### OR Types

Use discriminated unions for mutually exclusive states.

Current good examples:

- `HarnessSnapshot`
- `HunsuChangedFileKind`
- `HunsuTarget`
- `BoardEdge`
- `ArtifactRecord["owner"]`
- `ArtifactActionEnvValue`
- `ArtifactActionAlias`
- `RouteRecord` with explicit `Plan`, `Path`, and `HunsuDraft` variants

Patch-shaped Hunsu commands are intentionally not preserved. Hunsu Draft edits
decoded request runtime files, Local validates those files as full runtime
state, and `ConfirmHunsuDraft` records the changed files plus request Team
snapshot.

For Route records, keep the graph-level reference shape shared: `routeId`,
`kind`, source line/node, optional target node, and worktree. Put capability
differences in the variant: Plan and Path are read-only; HunsuDraft is
interactive and may carry check/confirmation state. Do not model interactive
chat as optional fields on Plan or Path.

Priority improvements:

0. Hub Package Domain

The final Hub model is marketplace-based:

```text
HubPackageKind = "team" | "member" | "manager" | "skill"

Executor Marketplace = Team | Member
Hunsu Marketplace = Manager
Skills & Plugins = Skill package payloads + Plugin requirement Resource entries
```

Manager is not an Executor and must not appear in `ExecutionPlan` assignee or
evaluator targets. Manager config is a Hunsu Draft agent configuration:
promptTemplate plus Skill and Plugin requirements. DMMF cleanup should remove
any old assumptions that Hub has only Team/Member/Skill package kinds, that
Skills & Plugins is scoped to Execute, or that plugin package payloads exist.
Represent package rows, package versions, Team entities, Member entities, Team
Membership entities, Manager entities, and Resource entities as stable entities.
Team package manifests carry a `Harness` Executor graph, not a legacy
`HarnessSnapshot` payload with sidecar Skills. Immutable manifests remain
version snapshots. Validation rejects unknown Membership targets, mismatched
visible-profile kinds, duplicate Memberships, and cyclic Team Memberships.
Executor Marketplace listings should be entity projections over those tables:
Team and Member cards are derived from `team_entities`, `member_entities`, and
`team_membership_entities`, while immutable package manifests remain the source
snapshots. Do not persist redundant Team member counts; derive them from direct
Membership edges.
Public Hub identity should use provider-qualified refs:
`@provider/entityName` for the entity and `@provider/entityName@version` for
the immutable version. Manifest integrity hashes stay in runtime locks and
audit/debug surfaces as verification material; they should not become the
human-facing identity or default copied URL.

1. `Destination`

Current shape allows status-dependent optional fields:

```ts
type Destination = DestinationSeed & {
  status: DestinationStatus;
  claimedBy?: string;
  reachedByMoveId?: MoveId;
  blockedReason?: string;
  canceledReason?: string;
  supersededByDestinationId?: DestinationId;
};
```

Refactor toward:

```ts
type Destination =
  | PendingDestination
  | ClaimedDestination
  | InProgressDestination
  | ReachedDestination
  | BlockedDestination
  | SupersededDestination
  | CanceledDestination;
```

Each variant should carry only the fields that are valid for that state.

2. `LineRecord`

Current `status` plus `currentNodeId`, `parentLineId`, and `forkedFromMoveId` can encode invalid combinations.

Refactor toward variants such as:

- `ActiveLine`
- `PausedLine`
- `CompleteLine`
- `FailedLine`
- `AbandonedLine`

Keep shared route identity in a base type and put status-specific fields in variants only when needed.

3. `MoveRecord`

Current `outcome?: "arrived" | "accident"` and optional `failureReason` allows invalid states.

Refactor toward:

```ts
type MoveRecord =
  | ArrivedMoveRecord
  | AccidentMoveRecord;
```

`ArrivedMoveRecord` must have exactly one `reachedDestinationIds` entry. `AccidentMoveRecord` must have `failureReason` and no reached destinations.

4. `SkillDraftRecord`

Current `status: "draft" | "accepted" | "discarded"` plus `acceptedSnapshot?` allows accepted drafts without snapshots and draft drafts with snapshots.

Refactor toward:

- `DraftSkillDraft`
- `AcceptedSkillDraft`
- `DiscardedSkillDraft`

### Result and Option

Introduce a small local result module in `packages/protocol`, for example `result.ts`:

```ts
export type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export type Option<T> =
  | { type: "some"; value: T }
  | { type: "none" };
```

Add helpers only as needed:

- `ok`
- `err`
- `map`
- `flatMap`
- `fromNullable`

Use `Result` first in validation and command workflow seams:

- `validateHarness`
- smart constructors
- `tryHandleCommand`
- `tryApplyCommand`
- domain event decoding from Git objects

Protocol workflow APIs should expose `Result` directly. CLI/server boundaries may unwrap and throw user-facing errors, but the protocol package should not keep public throwing wrappers solely for legacy compatibility.

## Proposed Module Layout

Public exports may change. Split the model into smaller domain-focused files when doing so clarifies ownership or removes invalid states:

- `packages/protocol/src/result.ts`
- `packages/protocol/src/primitives.ts`
- `packages/protocol/src/destination.ts`
- `packages/protocol/src/line.ts`
- `packages/protocol/src/move.ts`
- `packages/protocol/src/protocol.ts`
- `packages/protocol/src/command.ts`
- `packages/protocol/src/event.ts`
- `packages/protocol/src/projection.ts`
- `packages/protocol/src/model.ts` as the primary type model during migration

Do not split everything in one commit if that makes behavior hard to review. Start with primitives and lifecycle types, then move workflow code.

## Migration Plan

### Phase 1: Add DMMF Infrastructure

- Add `Result`, `Option`, and small helpers.
- Add branded primitive types and smart constructors.
- Add tests for constructor success and failure.
- Export the new modules from `index.ts`.

Acceptance:

- Updated tests pass.
- New tests show invalid IDs, empty required text, and invalid counts fail through `Result`.

### Phase 2: Model Lifecycle OR Types

- Convert `Destination` to status variants.
- Convert `MoveRecord` to `ArrivedMoveRecord | AccidentMoveRecord`.
- Convert `SkillDraftRecord` to lifecycle variants.
- Consider `LineRecord` variants after Destination and Move are stable.

Acceptance:

- Roadmap semantics remain unchanged. Projection shape may break when callers and tests are updated in the same change.
- TypeScript should reject invalid combinations such as reached destination without `reachedByMoveId`, accident move without `failureReason`, or accepted skill draft without snapshot.

### Phase 3: Separate Input DTOs from Domain Commands

- Keep external command input permissive enough for CLI/server parsing.
- Add validated command types that use branded IDs and constrained values.
- Add `validateCommand(input): Result<Command, CommandValidationError>`.
- Route server/CLI parsing through validation before `tryApplyCommand`.

Acceptance:

- Raw JSON events and HTTP/CLI inputs do not become domain commands without validation.
- Error messages remain user-readable at the CLI/server boundary.

### Phase 4: Convert Workflow Failures to Result

- Add `tryHandleCommand` and `tryApplyCommand`.
- Convert invariant helpers from throwing-only to result-producing helpers where the workflow composes several checks.
- Remove public throwing workflow wrappers after callers migrate to `Result`.

Acceptance:

- Tests cover result-returning APIs and boundary-level unwrapping where needed.
- Workflow code no longer depends on exceptions for ordinary invalid command paths.

### Phase 5: Tighten Core Git Trailer Board Parsing

- Replace `status: string` in `packages/core/src/model.ts` `MoveEvent` with a typed outcome/status where the trailer format supports it.
- Add parser functions for trailer values instead of trusting raw trailer text.
- Keep Git trailer events distinct from protocol `DomainEvent`.

Acceptance:

- Trailer parsing tests reject unknown event types and invalid statuses.
- `commitToBoardEvent` returns typed events or explicit parse errors at the appropriate boundary.

## Testing Strategy

Run after each phase:

```sh
pnpm run typecheck
pnpm test
```

Add focused tests in `tests/protocol.test.ts` or a new `tests/domain-primitives.test.ts`:

- smart constructors reject empty or malformed values
- `Destination` transitions preserve snapshot immutability
- invalid lifecycle combinations are impossible or rejected before projection
- `tryApplyCommand` returns `Result` errors without throwing

## Review Checklist

- Does the type name use product language from `docs/ubiquitous-language.md`?
- Can this state be represented with an OR type instead of optional fields?
- Are all required fields grouped as an AND type?
- Is this raw external input, validated domain data, durable event data, or projected state?
- Does this function signature reveal success, failure, absence, and async behavior?
- Are `null`, `undefined`, magic strings, and broad `string` values kept out of core domain types?
- Did the change preserve append-only event semantics?
