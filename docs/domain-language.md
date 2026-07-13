# Hunsu domain language

## Core concepts

**Workspace** is the authorization boundary created by one GitHub App installation. It contains granted repositories, authorized users, a derived Project Index, and non-repository preferences.

**Project** is a product initiative backed by one GitHub repository and one selected base ref. One repository may contain several Projects. A Project owns Goals, Runners, Runs, evidence, decisions, and one Coach.

**Goal** is a desired product outcome with acceptance criteria and constraints. It is not a granular task. A Goal may have several Runs and independently executed alternatives.

**Runner** is exactly one of:

```text
Runner
├── Player — an atomic reusable execution definition
└── Team   — a composite strategy over Players
```

Runner never names a process, adapter, session, queue consumer, or background service.

**Run** is one execution of a Runner against an immutable Goal snapshot from an exact GitHub base SHA. Run and Runner are distinct.

**Coach** steers a Project by reviewing evidence and proposing Goal changes, Runner changes, or deliberate divergence. A Coach cannot silently confirm a consequential decision.

**Hunsu** is both the product name and the operation that creates an intentional alternative future without rewriting its source future.

**Evidence** is an immutable reference or observation used to assess a Run against a Goal criterion. Credentials and mutable local paths are not evidence.

**Alternative** is a sibling Run in the same divergence group. Siblings begin at the same base SHA but may use a different Goal snapshot or Runner.

**Decision** records an explicit user selection or rejection after comparison. Comparison is advisory; selection determines which future continues.

**MOVE**, **Harness**, and **Artifact Action** remain specialized concepts only where they support this model. A MOVE is represented by a verified Run commit transition, a Harness by immutable Team strategy and Run tool policy, and an Artifact Action by a required-evidence instruction executed through the plugin. Their former runtime implementations depended on a separate local execution authority and therefore directly blocked the clean cutover; no duplicate lifecycle or state types remain. None creates a second execution authority.

## Invariants

- One Project belongs to one repository; one repository may hold multiple Projects.
- Runner is the closed union `Team | Player`.
- A Team references known Players and has no duplicate membership.
- A Run captures immutable Goal and Runner snapshots.
- Terminal Run variants carry exactly the data valid for that outcome.
- A completed Run has a GitHub-verifiable result SHA and criterion-linked evidence.
- Sibling alternatives share a base SHA.
- Coach proposals and user decisions are separate lifecycle states.
- Durable mutations are idempotent, append-only, and compare-and-swap protected.
