---
name: hunsu-diverge
description: Create, compare, select, or reject sibling Hunsu Run-result Nodes from one structural parent. Use when a source Node needs competing executions of one Goal, a user asks to create alternatives, or completed sibling futures need an evidence-based decision.
---

# Hunsu Diverge

1. Load the source with `hunsu.nodes.get` and its topology with `hunsu.nodes.graph`. Alternatives must be completed Run child Nodes with that exact source as their single structural parent.
2. Create alternatives by starting independent singular-Goal Runs from the same `sourceNodeSha`. Like-for-like experiments normally consume the same Goal, but sibling identity is defined by the shared parent, not by a fixed Goal digest. Each Run uses the source Node's immutable Runner Value. Do not branch from another result Node or use Coaching as a Run alternative.
3. After every candidate completes with sufficient evidence, call `hunsu.alternatives.compare` with at least two unique sibling `nodeShas`. Record criterion-by-criterion summaries for every included Node, plus checks, risks, constraints, and result commits.
4. Present the comparison without applying a decision. Ask for a separate explicit confirmation of the Node to select; only then call `hunsu.alternatives.select` with `confirmedByUser: true`.
5. Present each proposed rejection separately and obtain another explicit confirmation before each `hunsu.alternatives.reject` call with `confirmedByUser: true`.
6. Keep rejected Nodes readable but do not continue Run or Coaching work from them. Selection and rejection never create merge commits or convergence edges.

Never compare Nodes with different structural parents, infer a selection from Coach authority, or reuse one confirmation for both selection and rejection.
