# Commit-Node Graph v2 product transition

## Hypothesis

Hunsu can make implementation strategy visible and coachable when every Git commit Node carries one immutable `How` and a set of next Goals, and when Runs and Coaching form a single-parent lineage graph backed by GitHub state.

The product succeeds when users can understand the graph without learning an internal CRUD model, execute one Goal at a time from Codex, preserve explicit sibling-Run and coached-How alternatives, and make evidence-backed decisions without Hunsu changing the repository's main branch.

## Product loop

```text
Connect GitHub
  -> discover one available Runner capability
  -> create a Project from one existing root commit
  -> confirm the root Node Plan
  -> run one Goal from a Node
  -> attach criterion-linked evidence and verify the result commit
  -> register a Run child Node to the right
  -> propose and separately confirm Coaching below a Node
  -> execute either sibling Runs or same-Goal Runs from coached How sources
  -> compare their evidence under an explicit comparison variant
  -> separately confirm rejection and selection decisions
```

## Authority boundaries

- GitHub's `hunsu/state` branch owns append-only `.hunsu/v2` events and replayable materializations.
- Immutable managed tags anchor every registered Node commit.
- The API validates exact commands, performs compare-and-swap writes, verifies commits and refs, and reconstructs projections.
- The Codex plugin owns the execution interaction; callers cannot override a Node's Goal source, base SHA, or Runner Value.
- The trusted registry/runtime advertises repository-scoped Runner capabilities through read-only bounded discovery. Bootstrap and Coaching resolve an exact capability before accepting How.
- Web presents the Node graph and Events and collects explicit confirmations. It never writes state refs directly.
- GitHub Actions may run ordinary repository CI, but never starts, evaluates, or transitions a Hunsu Run.
- No v2 component decodes v1 state or offers a compatibility route.

## Production QA gate

The v2 release is accepted only after one authorized live repository completes this sequence from the same deployed source SHA:

1. list available Runner capabilities, resolve the chosen exact `RunnerTypeLock`, initialize a fresh Project from a full root commit SHA using the exact repository-context `expectedStateSha`, and retry the lost response idempotently;
2. start a Run for exactly one Goal, attach criterion-linked evidence, complete it, and retry completion without duplication;
3. propose a changed-How Node Plan with a required summary and rationale, preserving every non-How byte, and verify that no commit or edge exists before confirmation;
4. explicitly confirm Coaching and verify a direct same-tree child with one Git parent and a managed tag;
5. complete one same-Goal Run result from the coached source so the baseline and coached candidates bind distinct eligible sources;
6. recover the complete proposal and review through bounded list reads followed by exact get reads, request Coach review, and record an advisory `coached_how_experiment` comparison whose findings cover every result;
7. show the comparison before obtaining one explicit confirmation for rejection and, after applying it, a separate explicit confirmation for selection;
8. reconstruct the exact final state and verify zero active Runs, zero unresolved divergence, valid payload/ref/event integrity, and an unchanged main branch.

The deployment must come from the exact protected `main` SHA described in the production runbook. A branch build or locally installed plugin is controlled engineering evidence, not production evidence.

## Required evidence

| Gate | Required observation |
| --- | --- |
| State opacity | Source branches and the main tree contain no `.hunsu` files; Node and event bodies in `hunsu/state` are deterministic encoded envelopes without secrets. |
| Exact reconstruction | Graph, selected Node, and Events agree at one exact state head; malformed or stale materializations return an integrity error rather than silently repairing data. |
| Efficient reads | Project list and Graph reads do not download or decode all authoritative event or Node payload files; a Node detail reads only its selected payload. |
| Single-parent graph | One root exists; every non-root Node has exactly one incoming Hunsu edge; no self-edge, cycle, target reuse, or convergence edge is accepted. |
| Run singularity | Each Run contract contains exactly one Goal and the source Node's immutable Runner Value. Failed or canceled Runs create no Node. |
| Coaching authority | A proposal is non-mutating; only a separately confirmed proposal creates its deterministic same-tree child. |
| Runner discovery | Bootstrap and How changes resolve one exact advertised capability; discovery exposes schemas and availability but no executable code or credentials. |
| Comparison variants | `sibling_runs` requires one shared structural parent. `coached_how_experiment` requires the anchor or direct confirmed same-tree Coaching sources, one canonical Goal digest, and source plans identical except How. |
| Decision authority | Comparison is advisory. Selection and rejection are separate confirmed commands over result Nodes and remain decorations, not structural edges. |
| Recovery reads | Review, proposal, and comparison list reads followed by exact get reads reconstruct complete exact-head context before a retry; Node cards are not treated as mutation recovery records. |
| Idempotency | Lost-response retries duplicate no Node, edge, event, evidence, proposal, comparison, or decision. |
| Bootstrap context | Repository discovery identifies v2 as initialized or uninitialized and returns the exact default-branch or state-branch CAS base without decoding v1 files. |
| Web surface | Project navigation contains only Node graph and Events; Run edges move right and Coaching edges move down; integrity faults are visible. |
| Accessibility | The same Graph data is usable through keyboard and screen-reader Outline navigation, and Events form a semantic ordered list. |
| Repository safety | Production QA leaves the repository's main ref unchanged until an independently authorized merge. |

## Decision rule

- **Proceed** only when all production QA gates pass and the final exact-head reconstruction reports active Runs `0`, unresolved divergence `0`, and valid state integrity.
- **Adjust** when the state model remains sound but latency, onboarding, graph comprehension, accessibility, or plugin guidance needs another implementation loop.
- **Reject** when GitHub cannot reconstruct authoritative truth, a retry duplicates durable state, a Node can acquire multiple structural parents, or a consequential mutation bypasses explicit confirmation.

Until the protected deployment and live lifecycle are complete, automated tests and local browser checks must be reported as controlled engineering evidence rather than production validation.
