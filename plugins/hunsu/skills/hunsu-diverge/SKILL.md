---
name: hunsu-diverge
description: Create, compare, select, or reject Hunsu Run-result alternatives through an explicit sibling_runs or coached_how_experiment cohort. Use for competing executions from one parent, same-Goal experiments across confirmed How variants, comparison recovery, or evidence-based result decisions.
---

# Hunsu Diverge

1. Load the relevant Node with `hunsu.nodes.get` and topology with `hunsu.nodes.graph`. Recover prior work first with `hunsu.alternatives.list`; when a comparison may already exist, call `hunsu.alternatives.get` with its exact `comparisonType`, anchor field, and id before retrying.
2. Choose and state exactly one comparison variant. Never infer or silently change it:

   - `sibling_runs`: every candidate is an actual completed Run result with the same `sourceNodeSha` as its single structural parent. Sibling identity is the shared parent; candidates need not share a Goal digest.
   - `coached_how_experiment`: every candidate is an actual completed Run result from a distinct source that is either `anchorNodeSha` itself or one direct confirmed Coaching child of that anchor. Every candidate Run consumes the same canonical Goal digest. Every Coaching source preserves the anchor tree, and all source Node Plans are byte-identical except for How.

3. For `sibling_runs`, start independent singular-Goal Runs from the same source. Each Run uses that source's immutable Runner Value. Do not branch from a result Node merely to imitate a sibling.
4. For `coached_how_experiment`, inspect candidate Coaching state with `hunsu.coach.proposals.list` followed by `hunsu.coach.proposals.get`. If a new How is needed, first resolve its exact available type and native schema through repository-scoped `hunsu.runner_capabilities.list` followed by `hunsu.runner_capabilities.get`, then use the Coaching workflow and its separate confirmation boundary. Start one same-Goal Run from each distinct eligible source. Player and Team are bundled Runner examples, not fixed experiment lanes.
5. After every result completes with sufficient evidence, call `hunsu.alternatives.compare` with the required `comparisonType`, the matching `sourceNodeSha` or `anchorNodeSha`, and at least two unique result `nodeShas`. For every finding, provide exactly one criterion-by-criterion summary for every included result Node, plus relevant checks, risks, constraints, and result commits.
6. Present the advisory comparison without applying a decision. Reload it with `hunsu.alternatives.get` if the response or state head is uncertain.
7. Present each proposed rejection separately and obtain a fresh explicit confirmation before each `hunsu.alternatives.reject` call with `confirmedByUser: true`.
8. After showing the updated disposition, ask separately for explicit confirmation of the one result Node to select; only then call `hunsu.alternatives.select` with `confirmedByUser: true`. Never reuse a rejection confirmation for selection.
9. Keep rejected Nodes readable but do not continue Run or Coaching work from them. Repeated comparisons in one cohort do not authorize another selection. Comparisons and decisions never change structural parents, create merge commits, or add convergence edges.

Never pass coached-How candidates to `sibling_runs`, compare unrelated Coaching branches, infer a selection from Coach authority, or reuse one confirmation for both selection and rejection.
