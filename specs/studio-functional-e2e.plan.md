# Studio Functional E2E Test Plan

## Application Overview

These local-only QA scenarios exercise Hunsu Studio through the browser against an already-running Studio server. They intentionally use real Codex execution, create disposable Roadmap repositories under `/tmp`, and leave those repositories in place for debugging.

Run with:

```sh
HUNSU_E2E_BASE_URL=http://127.0.0.1:19688 pnpm e2e:local
```

Use `pnpm e2e:local:headed` when observing the browser is useful.

## Test Scenarios

### 1. Execute Flow

**Seed:** `e2e-tests/fixtures.ts`

#### 1.1. move-plan-path-arrives

**File:** `e2e-tests/studio-execute.spec.ts`

**Steps:**

1. Open Studio and create a managed Roadmap in a unique `/tmp/hunsu-e2e-*` folder.
    - expect: Studio navigates to the Roadmap workspace.
    - expect: the initial Destination queue contains `Create a runnable Hello World web app`.
2. Start Execute for the first Destination from the browser UI.
    - expect: an Execute run is created.
    - expect: a Team Plan route appears for Execute.
3. Wait for Execute to finish through Plan, Member Path execution, and MOVE finalization.
    - expect: Execute records an Arrived MOVE.
    - expect: the Roadmap shows `MOVE 1`.
    - expect: the Destination count shows `1 / 1 reached`.

### 2. HUNSU Draft Route

**Seed:** `e2e-tests/fixtures.ts`

#### 2.1. hunsu-draft-copy-team-then-execute

**File:** `e2e-tests/studio-hunsu-draft.spec.ts`

**Steps:**

1. Open Studio and create a managed Roadmap in a unique `/tmp/hunsu-e2e-*` folder.
    - expect: Studio navigates to the Roadmap workspace.
    - expect: the initial MOVE is selectable for route intervention.
2. Start a HUNSU Draft from the current MOVE.
    - expect: the HUNSU Draft route panel opens.
    - expect: the draft is ready to receive a HUNSU request.
3. Ask the draft agent to copy the current Team route exactly into another Team.
    - expect: the draft agent creates an approval-ready proposal.
    - expect: the proposal can be approved.
4. Approve the HUNSU Draft.
    - expect: the Roadmap records one HUNSU route change.
    - expect: the copied Team route can start Execute for the same pending Destination.
5. Start Execute from the copied Team route and wait for it to finish.
    - expect: the copied route records an Arrived MOVE.
    - expect: the Roadmap shows `MOVE 1`.
    - expect: the Destination count shows `1 / 1 reached`.
