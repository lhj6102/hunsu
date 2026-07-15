# Product vision

Hunsu makes the implementation history itself coachable. A Project identifies a repository and one root commit, while each immutable commit Node owns the Goals that may be run next and one integrity-locked Runner Value describing how work should be executed.

The primary workflow is a sparse lineage graph:

1. Select an existing commit as the Project root and explicitly confirm its initial Node Plan.
2. Run exactly one Node-owned Goal with that Node's Runner Value, producing a child Node to the right only after GitHub result and evidence verification.
3. Coach a Node by proposing a replacement Node Plan and, after a separate confirmation, producing a same-tree metadata child below it.
4. Compare completed sibling Run Nodes and explicitly select or reject alternatives without merging their structural lineage.

Four commitments shape the product:

1. GitHub events, commits, and managed tags are durable truth, so the Graph survives application-cache loss.
2. Every non-root Node has one structural parent. Branching preserves alternatives; Hunsu never invents convergence edges.
3. Codex performs work through a repository-scoped plugin. Hunsu stores no executable Runner code and operates no second execution runtime.
4. Coaching, comparison, selection, and rejection preserve explicit human authority. A proposal or recommendation never mutates the Graph by itself.

The dashboard stays intentionally small. After choosing a Project, users see only the Node graph and append-only Events. Node details expose Goals, the actual Runner Value, active Runs, evidence, Coaching, comparisons, and decisions in context instead of recreating standalone Goal, Runner, Coach, or Run directories.

Hunsu v2 is a clean protocol break. It reads only `.hunsu/v2`, leaves v1 state untouched, and provides no decoder, migration, alias, redirect, or dual-write compatibility path.
