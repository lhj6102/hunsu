# Hunsu domain language

## Core concepts

**Workspace** is the authorization boundary created by one GitHub App installation. It contains granted repositories, authorized users, a derived Project Index, and non-repository preferences.

**Project** is the repository and graph boundary for one product initiative. A Project identifies one GitHub repository and exactly one root Node. It does not own mutable Goals, Runners, Runs, or a second execution authority.

**Node** is a Hunsu-managed view of one real Git commit. Its identity is the pair `(ProjectId, full commit SHA)`. A root Node has no structural parent. Every other Node is explicitly either a Run child or a Coaching child and has exactly one structural parent.

**Node Plan** is the immutable payload logically owned by a Node. It contains zero or more next Goal values and exactly one Runner value as its How.

**Goal Value** is an immutable desired product outcome with acceptance criteria and constraints. It is not a Project entity or granular task. A Run selects exactly one Goal value from one Node Plan.

**Runner Value** is an immutable, content-addressed value object. Its type is locked to an exact registered schema and executor integrity. Player and Team are bundled Runner types, not an exhaustive domain union. Runner values never name processes, adapters, sessions, queue consumers, or background services.

**Run** is one execution of the source Node's Runner value against exactly one Goal value from that Node. A running, failed, or canceled Run creates no structural edge. A completed and GitHub-verified Run registers a new result Node and a Run edge.

**Coaching** proposes a complete replacement Node Plan without mutating its source Node. A confirmed proposal creates a same-tree, metadata-only child commit and a Coaching edge. Proposal recording and user confirmation are separate lifecycle states.

**Evidence** is an immutable reference or observation used to assess a Run against a Goal criterion. Credentials and mutable local paths are not evidence.

**Alternative** is a completed Run child that shares its source Node with at least one sibling result. Comparison is advisory. Selection and rejection require independent explicit user confirmations and never create a convergence edge.

**Event** is an authoritative append-only record on `hunsu/state`. Node Graph and Events are two projections of the same exact state head: Graph shows the current lineage and Events shows how it was produced.

## Invariants

- One Project belongs to one repository and has exactly one root Node.
- Node identity is `(ProjectId, full commit SHA)` and cannot be reused with another payload.
- Every non-root Node has exactly one structural parent; branching is allowed and merging is forbidden.
- Every Node Plan has `nextGoals[]` and exactly one Runner value.
- Player and Team are registered Runner types, not a closed `Runner` union.
- A Run consumes exactly one Goal and cannot override its source Node's Runner value or base SHA.
- A completed Run removes only its consumed Goal and otherwise inherits the source Node Plan deterministically.
- Only confirmed Coaching changes Goals or How deliberately.
- Failed and canceled Runs create no Node or edge.
- Coach proposals, comparisons, and user decisions remain separate explicit variants.
- Durable mutations are idempotent, append-only, branch-verified, and compare-and-swap protected.
- Source workspaces and normal source branches never receive Hunsu state files.
