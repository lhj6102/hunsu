# GitHub-backed Hunsu product hypothesis

## Hypothesis

Hunsu can make deliberate product divergence accessible when it combines familiar project-management concepts with GitHub-owned durable state and a Codex plugin that performs work. A user should move from GitHub connection to a completed, evidence-backed Run without installing a daemon or learning a command-line control plane.

The product is intentionally narrow: Project, Goal, Runner, Run, Coach, evidence, divergence, comparison, and selection. It is not a general issue tracker.

## Product loop

```text
Connect GitHub
  -> create a Project
  -> define an outcome-oriented Goal
  -> select a Player or Team Runner
  -> start a Run from the Codex plugin
  -> push a result commit and evidence
  -> verify the result in GitHub
  -> review it in Web with the Coach
  -> continue or create a Hunsu alternative
  -> compare sibling futures
  -> explicitly select one future
```

## Authority boundaries

- GitHub refs and commits own durable Project truth.
- The API validates commands, performs compare-and-swap writes, verifies Run results, and rebuilds disposable projections.
- The Codex plugin owns the execution interaction; Codex is the worker.
- Web owns presentation and explicit user confirmation for consequential decisions.
- Neither the plugin nor Web writes the state ref directly.
- GitHub Actions may run ordinary repository CI, but never starts, evaluates, or transitions a Hunsu Run.

This branch is a clean cutover. It intentionally carries no compatibility API, local-daemon operating mode, migration reader, or alternate state authority.

## Success measures

The vertical slice records:

- time from GitHub connection to first Project;
- time from plugin installation to first Run;
- completed Runs visible in Web without a manual reload;
- complete reconstruction after deleting disposable projections;
- compare-and-swap conflict and idempotent-replay behavior;
- Goals with criterion-linked evidence;
- Goals with independently executed same-base alternatives;
- Coach proposals accepted or rejected by users;
- workflows requiring a CLI or manual state-branch edit.

The hypothesis fails if GitHub cannot reconstruct every durable object, if the plugin is only a shortcut, if users cannot distinguish Runner from Run or Player from Team, or if divergent futures cannot be compared and explicitly selected.

## Evaluation decision

**Decision: Adjust**

The engineering hypothesis is supported in a controlled GitHub commit-graph harness, but the product hypothesis still needs an authorized live pilot before it can proceed. The adjustment is to keep the GitHub-backed architecture and run one installation/onboarding study against a real granted repository before treating the interaction model as validated.

### Phase 9 execution status

On 2026-07-13, a read-only preflight was attempted for the prescribed live-repository study. It could not advance into usage: this environment has no configured Hunsu GitHub App installation context, installation-backed session, webhook/public URL configuration, or Web/API/MCP deployment serving this branch. The deployed endpoints available to the environment are not this branch and therefore cannot provide evidence for it.

The preflight did not create or update any remote ref, application state, installation, webhook, or repository content. All results below come from controlled automated tests that use in-memory GitHub implementations or mocked HTTP, session, webhook, and MCP transports. They demonstrate implementation behavior, not real GitHub traffic, onboarding, or user usage.

### Observed evidence

| Measure | Observed result | Evidence boundary |
| --- | --- | --- |
| Completed Runs reflected in Web | 2/2 completed same-base Runs, including evidence and result SHAs | Application-service vertical test and rebuilt Goal projection |
| Project reconstruction | 1/1 complete vertical state rebuild after dropping the projection cache; lower-level reconstruction also ignores a damaged derived snapshot | Application-service and GitHub-store tests |
| Idempotent lost-response retries | 8/8 representative retries preserved the state head, including start after both the Run branch and Project base advanced | Application-service vertical test |
| Web logical submissions | All 8 Web mutation paths retain one semantic-command key across a lost response, including when polling refreshes the expected state head; focused tests cover retry, changed input, success, and abandonment | Web mutation-key tests and production typecheck |
| Concurrent stale write handling | 1/1 forced stale write returned a structured conflict with the actual state head | HTTP and GitHub-store tests |
| GitHub result verification | Both completed alternatives required an existing commit, base ancestry, and expected Run-branch reachability | Vertical test and Run verification tests |
| Evidence quality gate | 1/1 completed Goal retained evidence for every immutable acceptance criterion; Run completion rejects missing criterion coverage | Vertical, core, and application-service tests |
| Meaningful divergence | 1 Goal produced a Player result and a changed Team alternative from the same base, followed by comparison and explicit selection | Vertical test |
| Coach decisions | 1 accepted Team-change proposal applied only after a user decision; acceptance and rejection behavior are both covered, and the Coach projection displays advisory comparison and selection recommendations | Vertical, core, and projection tests |
| Web/MCP command parity | Equivalent Goal updates produced identical domain event payloads after metadata normalization | Application-service parity test |
| Plugin package | Manifest, repository marketplace, OAuth MCP binding, and 5/5 bundled Skills passed both repository and Codex validators | Plugin validation commands |
| Product runtime independence | 0 repository workflow files can operate the Hunsu lifecycle; the Web and API production builds complete without a local daemon or local durable authority | Boundary tests and nine-package build |

The full automated suite passes 66/66 tests. Typechecking and production builds pass for all nine runtime packages; the Web build produces its six Project routes and embedded same-base comparison view. These are controlled engineering results and must not be reported as live Phase 9 results.

### Next real-repository experiment

Run a fresh study from one immutable commit of this branch. Before inviting participants:

1. Register a dedicated GitHub App with the documented minimum permissions, callback, session, and webhook configuration.
2. Deploy Web, API, and MCP from that same commit at public URLs, and pin the repository marketplace plugin source to the same commit SHA.
3. Grant the App only non-production study repositories and record the installation, repository, build SHA, and state-ref starting heads.
4. Instrument authoritative timestamps for authorization, Project creation, plugin installation, Run transitions, webhook receipt, projection visibility, comparisons, Coach decisions, conflicts, retries, and reconstruction. Do not infer these timestamps from test logs.

Use at least two first-time internal participants, each with a different granted repository. Without implementation coaching, each participant must:

1. authorize GitHub, create a Hunsu Project, define a Goal with acceptance criteria, and choose a Runner in Web;
2. install the repository plugin and use it to start, execute, checkpoint, and complete a Run with criterion-linked evidence and a pushed result commit;
3. observe the completed Run in Web through the normal webhook/projection path without manually refreshing state or editing the state ref;
4. accept or reject a Coach proposal, explicitly confirm a Hunsu alternative, and independently execute a same-base alternative with a changed Goal or Runner;
5. inspect the recorded comparison and explicitly select an alternative;
6. repeat reconstruction after the disposable projection is removed, and exercise one controlled concurrent write so conflict recovery can be observed without risking participant work; and
7. describe what Project, Goal, Runner, Player, Team, Run, and Coach mean, while the observer records every user-required CLI, daemon, and manual Git step. Git operations performed by Codex as part of execution are not counted as user-required manual Git.

Capture and report every Phase 9 measure with its denominator and raw observations:

| Required measure | Live-study definition |
| --- | --- |
| Time from GitHub connection to first Project | Elapsed time from successful installation authorization/session establishment to the first accepted Project-creation command, per participant. |
| Time from plugin installation to first Run | Elapsed time from confirmed marketplace installation to the first accepted plugin-driven Run start, per participant. |
| Runs successfully reflected in Web | Terminal Runs visible with matching status, result SHA, and evidence through the webhook/projection path divided by all terminal Runs; also report visibility latency. |
| Project reconstruction rate | Reconstruction attempts whose durable Projects, Goals, Runners, Runs, evidence, decisions, comparisons, and selections match the pre-deletion authoritative state divided by all attempts. |
| Stale or conflicting state-write rate | Structured stale/conflict responses divided by all mutation attempts; separately report successful retry count, recovery latency, and any lost or duplicated event. |
| Goals producing meaningful alternatives | Count and percentage of Goals with independently executed same-base Runs that differ by Goal or Runner and reach a recorded comparison and explicit selection. |
| Coach recommendation acceptance rate | User-accepted proposals divided by all proposals explicitly decided by users; report rejections and participant rationale as well, since a high acceptance rate alone is not success. |
| Terminology distinction | Count and percentage of participants who can correctly distinguish Runner from Run, Player from Team, and Coach from a Runner without implementation coaching; retain the teach-back notes. |
| Workflows requiring CLI or manual Git | Count every participant step that requires a CLI, daemon operation, direct ref edit, or manual Git command; report the workflow and reason. |
| Criterion-linked Goal evidence | Completed Goals whose every acceptance criterion is covered by persisted evidence divided by all completed Goals. |

For this small pilot, `Proceed` requires complete GitHub reconstruction, every terminal Run reflected in Web, no lost or duplicated durable event, no user-required daemon/CLI/direct-state workflow, successful meaningful divergence and selection in each repository, and correct terminology teach-back from every participant. Structured conflicts are acceptable only when they are visible and recover without data loss. Report the two elapsed-time distributions and Coach acceptance rate as baselines rather than inventing synthetic thresholds. Use `Adjust` when the architecture holds but onboarding, latency, execution friction, or terminology needs revision. Use `Reject` if GitHub cannot recover durable truth, the plugin is only a shortcut, or the product cannot execute, compare, and select divergent futures.

Until that experiment is run, there is no live evidence for authorization-to-Project time, plugin-to-Run time, webhook latency, real conflict frequency, terminology comprehension, or CLI-free usage. Reporting controlled timings or mock-transport behavior as user evidence would overstate the result.
