# Roadmap

This file tracks product direction for the Team and Director model.

## Phase 1: Language Migration

- Rename product docs around Roadmaps, Teams, Destinations, Harness,
  Executes, Arrived, and Accident.
- Allow breaking code changes while the product is still pre-release.
- Add a work-temp migration note that prevents old vocabulary from returning to
  Markdown docs.

## Phase 2: Launcher and Roadmap Registry

- Add a user-level Roadmap registry for global Studio installs.
- Make `/studio` a launcher for recent Roadmaps, Open Folder, and Create
  Roadmap.
- Add `/studio/open?path=<encoded-path>` as the folder handoff route.
- Redirect opened folders to `/studio/roadmaps/<roadmapId>`.
- Support search, recent Roadmaps, missing-path state, and last-opened state.
- Keep registry metadata separate from Git-backed Roadmap state.
- Avoid making React in-memory state the authority for the active Roadmap.

## Phase 3: Repository Migration

- Add Hunsu Port as the explicit path for existing Git repositories.
- Detect whether encoded Hunsu runtime state already exists.
- Inspect package manager, scripts, Docker files, environment usage, and
  candidate Artifact Action surfaces.
- Generate a reviewable Port plan before changing files.
- Do not create host/check actions implicitly; propose Artifact Actions as
  explicit later Hunsu work when useful.
- Offer Initialize Roadmap only as part of Port or Create.
- Use the encoded `.hunsu/` runtime bundle and `hunsu/` work branches.
- Avoid changing ordinary repository branches.
- Make project file edits explicit in the accepted Port plan.

## Phase 3.5: Executable Runtime State

- Treat each Hunsu commit as an executable runtime state.
- Store completed Destination metadata, pending Destination queue state,
  Harness bundles, compatibility events, and optional previous execution
  metadata inside encoded `.hunsu/*.hunsu` runtime files.
- Keep `.hunsu/*.hunsu` runtime files app-owned; agents receive rendered prompts
  and must not decode or edit those files directly.
- Make route branches ordinary Git branches and remove required dependence on
  custom `refs/hunsu/*`.
- Keep local Hunsu indexes rebuildable from reachable commits.
- Keep commit messages free of natural-language TODO or Execution Instructions detail.

## Phase 4: Studio Graph

- Make the Roadmap View left panel show current Roadmap context, not the global
  Roadmap browser.
- Keep Roadmap switching in the launcher or explicit switcher.
- Show Team routes as solid route lines.
- Show active Executes as operational graph nodes.
- Show Hunsu route switches as dashed lines.
- Show Team Snapshot detail for every MOVE.
- Show Destination state inside MOVE detail.

## Phase 5: Execute Runtime

- Keep the Team prompt narrow and orchestration-focused.
- Mirror the current TODO and Harness bundle into provider goal state when the
  provider supports it.
- Execute Member Paths through the Team-emitted ExecutionPlan.
- Record one final outcome per Team route and target count.
- Preserve conversation and worktree hashes for debugging.
- Treat Route worktrees as execution surfaces, not human preview artifacts.

## Phase 6: Artifact Actions

- Add committed `.hunsu/artifact-actions.hunsu` definitions.
- Support multiple actions per MOVE or commit.
- Implement `host` actions for long-running product surfaces.
- Implement `check` actions for finite E2E, lint, typecheck, report, export, or
  deploy-candidate commands.
- Inject declared runtime environment variables from Hunsu instead of relying
  on hardcoded ports or project `.env` files.
- Expose host action aliases such as `web`, `api`, `storybook`, and `admin`.
- Run Artifact Actions from immutable MOVE or commit positions.
- Keep host ports as implementation details behind alias URLs.
- Retain or stop host Action Runs explicitly for human review.
- Add garbage collection for stale Action Runs.

## Phase 7: Action Evidence

- Run Playwright or other integration tests as check actions or against host
  action aliases.
- Target Artifact Action alias URLs, not internal service names or host ports.
- Capture screenshots, traces, console errors, network failures, and service
  logs.
- Attach Action Evidence to the exercised MOVE or commit.
- Show Action Run and E2E result markers in Studio MOVE detail.
- Make action result comparison a primary way to review sibling Team routes.

## Phase 8: Hunsu Manager

- Let the Director converse with a Manager from any MOVE.
- Let the Director start from Action Evidence or observed runtime behavior.
- Normalize conversation into a structured HUNSU Draft.
- Preview Team Snapshot changes before confirmation.
- Record confirmed HUNSU Drafts as Hunsu and new Team routes.

## Phase 9: Skill Drafts

- Query installed Codex skill folders.
- Create mutable Skill Draft folders.
- Let a skill-edit subagent work inside the draft.
- Review draft files and transcript.
- Accept drafts into immutable Skill Snapshots through Hunsu.

## Phase 10: Deployment Translation

- Use Docker Compose topology as the input for production deployment planning.
- Let agents translate validated host action topology into AWS, Google Cloud,
  Kubernetes, or similar deployment targets.
- Keep deployment as an explicit follow-up from validated Action Evidence,
  not as an implicit side effect of local E2E passing.
- Map Compose services to managed services, databases, secret stores, health
  checks, and routing rules.

## Phase 11: Additional Harnesses

- Keep planned Harness kinds visible but disabled until ExecutionPlan dispatchers
  exist.
- Add role-squad ExecutionPlan template and dispatcher.
- Add council-vote ExecutionPlan template and dispatcher.
- Add court-debate ExecutionPlan template and dispatcher.
- Keep all Harness choices immutable inside Team Snapshots.
