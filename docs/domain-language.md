# Hunsu domain language

## Core concepts

**Workspace** is the authorization boundary created by one GitHub App installation. It contains granted repositories, authorized users, a derived Project Index, and non-repository preferences.

**Project** is the repository and graph boundary for one product initiative. A Project identifies one GitHub repository and exactly one root Node. It does not own mutable Goals, Runners, Runs, or a second execution authority.

**Node** is a Hunsu-managed view of one real Git commit. Its identity is the pair `(ProjectId, full commit SHA)`. A root Node has no structural parent. Every other Node is explicitly either a Run child or a Coaching child and has exactly one structural parent.

**Node Plan** is the immutable payload logically owned by a Node. It contains zero or more next Goal values and exactly one Runner value as its How.

**Goal Value** is an immutable desired product outcome with acceptance criteria and constraints. It is not a Project entity or granular task. A Run selects exactly one Goal value from one Node Plan.

**Runner Value** is an immutable, content-addressed value object. Its type is locked to an exact registered schema and executor integrity. Player and Team are bundled Runner types, not an exhaustive domain union. Runner values never name processes, adapters, sessions, queue consumers, or background services.

**Run** is one execution of the source Node's Runner value against exactly one Goal value from that Node. A running, failed, or canceled Run creates no structural edge. A completed and GitHub-verified Run registers a new result Node and a Run edge.

**Coaching** proposes a complete replacement Node Plan with a required evidence summary and rationale without mutating its source Node. A confirmed proposal creates a same-tree, metadata-only child commit and a Coaching edge. Proposal recording and user confirmation are separate lifecycle states.

**Evidence** is an immutable reference or observation used to assess a Run against a Goal criterion. Credentials and mutable local paths are not evidence.

**Alternative Comparison** is an advisory, non-structural decoration over completed Run result Nodes. It is always one exact variant: `sibling_runs` compares results with one shared structural parent, while `coached_how_experiment` compares one result per distinct source drawn from an anchor Node and its directly confirmed same-tree Coaching children. The coached variant binds one canonical Goal digest and permits source Node Plans to differ only in How. Selection and rejection decorate only included result Nodes, require independent explicit user confirmations, and never create a convergence edge.

**Event** is an authoritative append-only record on `hunsu/state`. Node Graph and Events are two projections of the same exact state head: Graph shows the current lineage and Events shows how it was produced.

## Invariants

- One Project belongs to one repository and has exactly one root Node.
- Node identity is `(ProjectId, full commit SHA)` and cannot be reused with another payload.
- Every non-root Node has exactly one Hunsu structural parent; branching is allowed and structural merging or convergence is forbidden. An underlying verified Run result may be a normal Git merge commit without gaining a second Hunsu parent.
- Every Node Plan has `nextGoals[]` and exactly one Runner value.
- Player and Team are registered Runner types, not a closed `Runner` union.
- A Run consumes exactly one Goal and cannot override its source Node's Runner value or base SHA.
- A completed Run removes only its consumed Goal and otherwise inherits the source Node Plan deterministically.
- Only confirmed Coaching changes Goals or How deliberately.
- Failed and canceled Runs create no Node or edge.
- `sibling_runs` and `coached_how_experiment` are separate exact comparison variants; callers must never infer one from candidate topology.
- Every coached-How candidate is an actual completed Run result. Candidate Runs have the same canonical Goal digest, distinct eligible source Nodes, and source Node Plans that are byte-identical except for How.
- A coached-How source is the anchor itself or one of its direct confirmed Coaching children; every such child preserves the anchor tree.
- Every comparison finding summarizes every included result Node exactly once. Overlapping candidate sets must share one cohort key, repeated comparisons cannot create another selection, and an undecided coached-How cohort contributes one unresolved divergence.
- Comparison, selection, and rejection are non-structural decorations. They cannot add a parent, merge lineages, or create convergence.
- Coach proposals, comparisons, and user decisions remain separate explicit variants and confirmations.
- Durable mutations are idempotent, append-only, branch-verified, and compare-and-swap protected.
- Source workspaces and normal source branches never receive Hunsu state files.
