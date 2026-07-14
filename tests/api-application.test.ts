import assert from "node:assert/strict";
import test from "node:test";
import { HunsuApplicationService, type AuthContext } from "../apps/api/src/index.ts";
import { MemoryGitHubTransport, type RepositoryGrant } from "../packages/github-store/src/index.ts";

const INITIAL_SHA = "1".repeat(40);

const repository: RepositoryGrant = {
  installationId: 17,
  repositoryId: 29,
  owner: "acme",
  name: "product",
  defaultBranch: "main",
  private: true,
  permissions: { contents: "write" }
};

const auth: AuthContext = {
  subject: "github:7",
  user: { id: "7", login: "octocat" },
  installations: [{
    id: 17,
    accountLogin: "acme",
    accountType: "organization",
    repositories: [{ repositoryId: 29, permissions: { contents: "write" } }]
  }],
  selectedInstallationId: 17,
  client: "mcp"
};

test("application service completes and reconstructs the GitHub-backed divergent product loop", async () => {
  const transport = new MemoryGitHubTransport([{ repository, initialSha: INITIAL_SHA }]);
  let tick = 0;
  const service = new HunsuApplicationService({
    transport,
    now: () => new Date(Date.UTC(2026, 6, 13, 1, 0, tick++))
  });
  const repo = {
    installationId: 17,
    repositoryId: 29,
    owner: "acme",
    name: "product",
    defaultBranch: "main"
  };

  const projectCreateInput = {
    repository: repo,
    projectId: "project-one",
    title: "Product transition",
    objective: "Validate a GitHub-backed Hunsu workflow",
    baseRef: "main",
    coachId: "coach-one",
    idempotencyKey: "project-create"
  };
  const projectCreated = await mutation(service, "hunsu.projects.create", projectCreateInput);
  let stateHeadSha = projectCreated.stateHeadSha;
  const projectRetried = await mutation(service, "hunsu.projects.create", projectCreateInput);
  assert.equal(projectRetried.stateHeadSha, stateHeadSha);
  const missingBaseRef = await service.call("hunsu.projects.update", {
    repository: repo,
    projectId: "project-one",
    baseRef: "missing-branch",
    idempotencyKey: "project-missing-base",
    expectedStateSha: stateHeadSha
  }, auth);
  if (missingBaseRef.ok) assert.fail("A missing Project base ref was accepted.");
  assert.equal(missingBaseRef.error.code, "stale_base");

  const playerCreateInput = {
    repository: repo,
    projectId: "project-one",
    runnerId: "player-one",
    promptTemplate: "Implement the Goal and report evidence.",
    resources: [],
    runtimePolicy: { filesystem: "read_only", network: "disabled", approvals: "never" },
    idempotencyKey: "player-create",
    expectedStateSha: stateHeadSha
  };
  const playerCreated = await mutation(service, "hunsu.runners.create_player", playerCreateInput);
  stateHeadSha = playerCreated.stateHeadSha;
  const playerRetried = await mutation(service, "hunsu.runners.create_player", playerCreateInput);
  assert.equal(playerRetried.stateHeadSha, stateHeadSha);

  stateHeadSha = (await mutation(service, "hunsu.runners.create_player", {
    repository: repo,
    projectId: "project-one",
    runnerId: "player-two",
    promptTemplate: "Review the implementation and report risks.",
    resources: [],
    runtimePolicy: { filesystem: "read_only", network: "disabled", approvals: "never" },
    idempotencyKey: "player-two-create",
    expectedStateSha: stateHeadSha
  })).stateHeadSha;

  const teamCreateInput = {
    repository: repo,
    projectId: "project-one",
    runnerId: "team-one",
    strategy: { mode: "sequence", promptTemplate: "Coordinate the Player in sequence.", maxRounds: 2 },
    players: [{ playerId: "player-one", role: "implementation", order: 1 }],
    idempotencyKey: "team-create",
    expectedStateSha: stateHeadSha
  };
  const teamCreated = await mutation(service, "hunsu.runners.create_team", teamCreateInput);
  stateHeadSha = teamCreated.stateHeadSha;
  const teamRetried = await mutation(service, "hunsu.runners.create_team", teamCreateInput);
  assert.equal(teamRetried.stateHeadSha, stateHeadSha);

  for (const [label, runnerId, definition, expectedCode] of [
    ["empty", "team-one", { kind: "team" }, "invalid_request"],
    ["cross-kind", "team-one", { kind: "player", promptTemplate: "Wrong kind." }, "invalid_request"],
    ["unknown-field", "team-one", { kind: "team", strategy: { mode: "parallel", description: "ignored" } }, "invalid_request"],
    ["unknown-runner", "team-missing", { kind: "team", strategy: { mode: "parallel" } }, "not_found"]
  ] as const) {
    const rejected = await service.call("hunsu.runners.update", {
      repository: repo,
      projectId: "project-one",
      runnerId,
      definition,
      idempotencyKey: `runner-update-${label}`,
      expectedStateSha: stateHeadSha
    }, auth);
    if (rejected.ok) assert.fail(`${label} Runner update unexpectedly succeeded.`);
    assert.equal(rejected.error.code, expectedCode);
  }

  const goalCreateInput = {
    repository: repo,
    projectId: "project-one",
    goalId: "goal-one",
    title: "Ship the vertical slice",
    desiredOutcome: "The full loop reconstructs from GitHub.",
    acceptanceCriteria: ["The result commit is verified", "State rebuild preserves the decision"],
    constraints: ["Do not use local durable state"],
    priority: 90,
    runnerId: "player-one",
    idempotencyKey: "goal-create",
    expectedStateSha: stateHeadSha
  };
  const goalCreated = await mutation(service, "hunsu.goals.create", goalCreateInput);
  stateHeadSha = goalCreated.stateHeadSha;
  const goalRetried = await mutation(service, "hunsu.goals.create", goalCreateInput);
  assert.equal(goalRetried.stateHeadSha, stateHeadSha);
  const invalidStart = await service.call("hunsu.runs.start", {
    repository: repo,
    projectId: "project-one",
    goalId: "goal-one",
    runnerId: "player-missing",
    runId: "run-invalid-runner",
    baseSha: INITIAL_SHA,
    idempotencyKey: "invalid-runner-start",
    expectedStateSha: stateHeadSha
  }, auth);
  if (invalidStart.ok) assert.fail("A Run with an unknown Runner was accepted.");
  assert.equal(invalidStart.error.code, "not_found");
  const invalidBranch = await transport.readBranch(repository, "hunsu/run/project-one/goal-one/run-invalid-runner");
  if (!invalidBranch.ok) assert.fail(invalidBranch.error.message);
  assert.equal(invalidBranch.value, undefined, "domain preflight must run before creating a Run branch");

  stateHeadSha = (await mutation(service, "hunsu.goals.create", {
    repository: repo,
    projectId: "project-one",
    goalId: "goal-team",
    title: "Exercise the Team Runner",
    desiredOutcome: "A Team Run captures its strategy and Player membership.",
    acceptanceCriteria: ["The Team Run contract contains its immutable snapshot"],
    constraints: [],
    priority: 50,
    runnerId: "team-one",
    idempotencyKey: "team-goal-create",
    expectedStateSha: stateHeadSha
  })).stateHeadSha;
  const teamStartInput = {
    repository: repo,
    projectId: "project-one",
    goalId: "goal-team",
    runnerId: "team-one",
    runId: "run-team",
    baseSha: INITIAL_SHA,
    idempotencyKey: "team-run-start",
    expectedStateSha: stateHeadSha
  };
  const teamStart = await mutation(service, "hunsu.runs.start", teamStartInput);
  stateHeadSha = teamStart.stateHeadSha;
  const teamContract = teamStart.data as {
    runner: {
      kind: string;
      strategy: { mode: string; promptTemplate: string; maxRounds: number };
      players: Array<{
        id: string;
        role: string;
        order: number;
        promptTemplate: string;
        resources: unknown[];
        runtimePolicy: { filesystem: string; network: string; approvals: string };
      }>;
    };
    toolPolicy: { filesystem: string; network: string; approvals: string };
  };
  assert.equal(teamContract.runner.kind, "team");
  assert.deepEqual(teamContract.runner.strategy, {
    mode: "sequence",
    promptTemplate: "Coordinate the Player in sequence.",
    maxRounds: 2
  });
  assert.deepEqual(teamContract.runner.players, [{
    id: "player-one",
    role: "implementation",
    order: 1,
    promptTemplate: "Implement the Goal and report evidence.",
    resources: [],
    runtimePolicy: { filesystem: "read_only", network: "disabled", approvals: "never" }
  }]);
  assert.deepEqual(teamContract.toolPolicy, { filesystem: "read_only", network: "disabled", approvals: "never" });
  stateHeadSha = (await mutation(service, "hunsu.runners.update", {
    repository: repo,
    projectId: "project-one",
    runnerId: "player-one",
    definition: {
      kind: "player",
      promptTemplate: "Implement the refined Goal and report criterion-linked evidence.",
      resources: [{ kind: "skill", name: "verification", reference: "skill://verification" }],
      runtimePolicy: { filesystem: "worktree_write", network: "enabled", approvals: "on_request" }
    },
    idempotencyKey: "player-update-after-start",
    expectedStateSha: stateHeadSha
  })).stateHeadSha;
  const playerRead = await service.call("hunsu.runners.get", {
    repository: repo,
    projectId: "project-one",
    runnerId: "player-one"
  }, auth);
  if (!playerRead.ok) assert.fail(playerRead.error.message);
  assert.equal(playerRead.stateHeadSha, stateHeadSha);
  assert.deepEqual(playerRead.data, {
    kind: "player",
    id: "player-one",
    name: "player-one",
    promptTemplate: "Implement the refined Goal and report criterion-linked evidence.",
    resources: [{
      id: "skill:verification",
      kind: "skill",
      name: "verification",
      reference: "skill://verification"
    }],
    runtimePolicy: { filesystem: "worktree_write", network: "enabled", approvals: "on_request" },
    goalCount: 0,
    recentResults: []
  });
  const beforeTeamUpdate = stateHeadSha;
  stateHeadSha = (await mutation(service, "hunsu.runners.update", {
    repository: repo,
    projectId: "project-one",
    runnerId: "team-one",
    definition: {
      kind: "team",
      strategy: {
        mode: "parallel",
        promptTemplate: "Coordinate implementation and review in parallel.",
        maxRounds: 4
      },
      players: [
        { playerId: "player-one", role: "implementation", order: 1 },
        { playerId: "player-two", role: "review", order: 2 }
      ]
    },
    idempotencyKey: "team-update-after-start",
    expectedStateSha: beforeTeamUpdate
  })).stateHeadSha;
  const semanticConflict = await service.call("hunsu.runners.update", {
    repository: repo,
    projectId: "project-one",
    runnerId: "team-one",
    definition: { kind: "team", strategy: { maxRounds: 5 } },
    idempotencyKey: "team-update-after-start",
    expectedStateSha: beforeTeamUpdate
  }, auth);
  if (semanticConflict.ok) assert.fail("A changed Team definition reused an idempotency key without conflict.");
  assert.equal(semanticConflict.error.code, "conflict");

  const replayedTeamStart = await mutation(service, "hunsu.runs.start", teamStartInput);
  assert.equal(replayedTeamStart.stateHeadSha, stateHeadSha);
  const replayedContract = replayedTeamStart.data as typeof teamContract;
  assert.deepEqual(replayedContract.runner.strategy, {
    mode: "sequence",
    promptTemplate: "Coordinate the Player in sequence.",
    maxRounds: 2
  });
  assert.deepEqual(replayedContract.runner.players, [{
    id: "player-one",
    role: "implementation",
    order: 1,
    promptTemplate: "Implement the Goal and report evidence.",
    resources: [],
    runtimePolicy: { filesystem: "read_only", network: "disabled", approvals: "never" }
  }]);
  const snapshottedRun = await service.webRun({ ...auth, client: "web" }, "project-one", "run-team");
  if (!snapshottedRun.ok) assert.fail(snapshottedRun.error.message);
  const teamSnapshot = (snapshottedRun.value.run as { runnerSnapshot: { strategy: { mode: string; promptTemplate: string; maxRounds: number }; players: Array<{ playerId: string }> } }).runnerSnapshot;
  assert.deepEqual(teamSnapshot.strategy, {
    mode: "sequence",
    promptTemplate: "Coordinate the Player in sequence.",
    maxRounds: 2
  });
  assert.deepEqual(teamSnapshot.players.map(player => player.playerId), ["player-one"]);
  stateHeadSha = (await mutation(service, "hunsu.runs.cancel", {
    repository: repo,
    projectId: "project-one",
    runId: "run-team",
    reason: "Focused Team contract verification completed.",
    idempotencyKey: "team-run-cancel",
    expectedStateSha: stateHeadSha
  })).stateHeadSha;

  const beforeFirstStart = stateHeadSha;
  const firstStartInput = {
    repository: repo,
    projectId: "project-one",
    goalId: "goal-one",
    runnerId: "player-one",
    runId: "run-one",
    baseSha: INITIAL_SHA,
    idempotencyKey: "run-one-start",
    expectedStateSha: beforeFirstStart
  };
  const firstStart = await mutation(service, "hunsu.runs.start", firstStartInput);
  stateHeadSha = firstStart.stateHeadSha;
  assert.equal((firstStart.data as { schema: string }).schema, "hunsu.run-contract.v1");
  const startedRunRead = await service.call("hunsu.runs.get", {
    repository: repo,
    projectId: "project-one",
    runId: "run-one"
  }, auth);
  if (!startedRunRead.ok) assert.fail(startedRunRead.error.message);
  assert.equal(startedRunRead.stateHeadSha, stateHeadSha);
  const startedRunSnapshot = (startedRunRead.data as {
    runnerSnapshot: {
      kind: string;
      resources: Array<{ id: string; kind: string; name: string; reference: string }>;
      runtimePolicy: { filesystem: string; network: string; approvals: string };
    };
  }).runnerSnapshot;
  assert.equal(startedRunSnapshot.kind, "player");
  assert.deepEqual(startedRunSnapshot.resources, [{
    id: "skill:verification",
    kind: "skill",
    name: "verification",
    reference: "skill://verification"
  }]);
  assert.deepEqual(startedRunSnapshot.runtimePolicy, {
    filesystem: "worktree_write",
    network: "enabled",
    approvals: "on_request"
  });
  const firstCommit = transport.addCommit({
    repository,
    branch: "hunsu/run/project-one/goal-one/run-one",
    parentSha: INITIAL_SHA,
    files: { "result-one.txt": "first" }
  });
  if (!firstCommit.ok) assert.fail(firstCommit.error.message);

  const advancedMain = transport.addCommit({
    repository,
    branch: "main",
    parentSha: INITIAL_SHA,
    files: { "main-advanced.txt": "new base" }
  });
  assert.equal(advancedMain.ok, true);
  const firstStartRetried = await mutation(service, "hunsu.runs.start", firstStartInput);
  assert.equal(firstStartRetried.stateHeadSha, stateHeadSha);

  const checkpointInput = {
    repository: repo,
    projectId: "project-one",
    runId: "run-one",
    summary: "Result pushed and ready for verification.",
    commitSha: firstCommit.value,
    idempotencyKey: "run-one-checkpoint",
    expectedStateSha: stateHeadSha
  };
  const checkpointed = await mutation(service, "hunsu.runs.checkpoint", checkpointInput);
  stateHeadSha = checkpointed.stateHeadSha;
  const checkpointRetried = await mutation(service, "hunsu.runs.checkpoint", checkpointInput);
  assert.equal(checkpointRetried.stateHeadSha, stateHeadSha);

  const evidenceAttachInput = {
    repository: repo,
    projectId: "project-one",
    runId: "run-one",
    evidence: { kind: "commit", summary: "First result", sha: firstCommit.value, criterion: "The result commit is verified" },
    idempotencyKey: "run-one-evidence",
    expectedStateSha: stateHeadSha
  };
  const attached = await mutation(service, "hunsu.runs.attach_evidence", evidenceAttachInput);
  stateHeadSha = attached.stateHeadSha;
  const attachedRetried = await mutation(service, "hunsu.runs.attach_evidence", evidenceAttachInput);
  assert.equal(attachedRetried.stateHeadSha, stateHeadSha);

  const beforeFirstComplete = stateHeadSha;
  const firstCompleteInput = {
    repository: repo,
    projectId: "project-one",
    runId: "run-one",
    resultSha: firstCommit.value,
    evidence: [{
      kind: "check",
      summary: "Reconstruction retains the completed source Run.",
      criterion: "State rebuild preserves the decision"
    }],
    idempotencyKey: "run-one-complete",
    expectedStateSha: beforeFirstComplete
  };
  const firstCompleted = await mutation(service, "hunsu.runs.complete", firstCompleteInput);
  stateHeadSha = firstCompleted.stateHeadSha;
  const firstCompleteRetried = await mutation(service, "hunsu.runs.complete", firstCompleteInput);
  assert.equal(firstCompleteRetried.stateHeadSha, stateHeadSha);

  stateHeadSha = (await mutation(service, "hunsu.coach.review", {
    repository: repo,
    projectId: "project-one",
    runId: "run-one",
    assessment: "The first result works but another future may be stronger.",
    findings: ["The evidence supports the first criterion."],
    recommendation: "Compare a deliberate alternative.",
    idempotencyKey: "coach-review",
    expectedStateSha: stateHeadSha
  })).stateHeadSha;

  const ambiguousHunsuProposal = await service.call("hunsu.coach.propose_hunsu", {
    repository: repo,
    projectId: "project-one",
    proposalId: "proposal-ambiguous",
    sourceRunId: "run-one",
    goalId: "goal-one",
    changedGoalPatch: { priority: 91 },
    changedRunnerId: "team-one",
    rationale: "This invalid proposal supplies two alternative changes.",
    idempotencyKey: "coach-hunsu-proposal-ambiguous",
    expectedStateSha: stateHeadSha
  }, auth);
  if (ambiguousHunsuProposal.ok) assert.fail("Ambiguous Hunsu proposal unexpectedly succeeded.");
  assert.equal(ambiguousHunsuProposal.error.code, "invalid_request");

  stateHeadSha = (await mutation(service, "hunsu.coach.propose_hunsu", {
    repository: repo,
    projectId: "project-one",
    proposalId: "proposal-one",
    sourceRunId: "run-one",
    goalId: "goal-one",
    changedRunnerId: "team-one",
    rationale: "Test a competing implementation from the same base.",
    idempotencyKey: "coach-hunsu-proposal",
    expectedStateSha: stateHeadSha
  })).stateHeadSha;
  const coachRead = await service.call("hunsu.coach.get", {
    repository: repo,
    projectId: "project-one"
  }, auth);
  if (!coachRead.ok) assert.fail(coachRead.error.message);
  assert.equal(coachRead.stateHeadSha, stateHeadSha);
  const coachProjection = coachRead.data as {
    assessment: { summary: string };
    proposals: Array<{ id: string; kind: string; status: string }>;
  };
  assert.equal(coachProjection.assessment.summary, "The first result works but another future may be stronger.");
  assert.deepEqual(coachProjection.proposals.map(proposal => ({
    id: proposal.id,
    kind: proposal.kind,
    status: proposal.status
  })), [{ id: "proposal-one", kind: "hunsu", status: "proposed" }]);

  const webAuth = { ...auth, client: "web" as const };
  const unconfirmedStartInput = {
    repository: repo,
    projectId: "project-one",
    goalId: "goal-one",
    runnerId: "team-one",
    runId: "run-two",
    baseSha: INITIAL_SHA,
    alternativeOfRunId: "run-one",
    coachProposalId: "proposal-one",
    idempotencyKey: "run-two-start",
    expectedStateSha: stateHeadSha
  };
  const unconfirmedStart = await service.call("hunsu.runs.start", unconfirmedStartInput, auth);
  if (unconfirmedStart.ok) assert.fail("An unconfirmed Coach-proposed sibling start unexpectedly succeeded.");
  assert.equal(unconfirmedStart.error.code, "confirmation_required");
  const afterUnconfirmed = await service.webProject(webAuth, "project-one");
  if (!afterUnconfirmed.ok) assert.fail(afterUnconfirmed.error.message);
  assert.equal(afterUnconfirmed.value.stateHeadSha, stateHeadSha, "missing confirmation must not mutate Project state");

  const mismatchedStart = await service.call("hunsu.runs.start", {
    ...unconfirmedStartInput,
    runnerId: "player-one",
    runId: "run-mismatch",
    idempotencyKey: "run-mismatch-start",
    confirmedByUser: true
  }, auth);
  if (mismatchedStart.ok) assert.fail("A sibling start that did not match the Coach proposal unexpectedly succeeded.");
  assert.equal(mismatchedStart.error.code, "invalid_request");

  const secondStartInput = { ...unconfirmedStartInput, confirmedByUser: true };
  const secondStart = await mutation(service, "hunsu.runs.start", secondStartInput);
  stateHeadSha = secondStart.stateHeadSha;
  const secondStartRetried = await mutation(service, "hunsu.runs.start", secondStartInput);
  assert.equal(secondStartRetried.stateHeadSha, stateHeadSha);
  const stateBranchAfterStart = await transport.readBranch(repository, "hunsu/state");
  if (!stateBranchAfterStart.ok || !stateBranchAfterStart.value) assert.fail("Expected the Hunsu state branch after sibling start.");
  const siblingStartEvents = Object.values(stateBranchAfterStart.value.files)
    .filter(text => text.includes('"event":'))
    .map(text => JSON.parse(text) as { event: { type: string; meta: { actor: { type: string } }; decision?: { proposalId?: string }; run?: { id?: string } } })
    .map(entry => entry.event);
  const acceptedProposalEvent = siblingStartEvents.find(event => event.type === "CoachProposalAccepted" && event.decision?.proposalId === "proposal-one");
  const startedSiblingEvent = siblingStartEvents.find(event => event.type === "RunStarted" && event.run?.id === "run-two");
  assert.equal(acceptedProposalEvent?.meta.actor.type, "user");
  assert.equal(startedSiblingEvent?.meta.actor.type, "plugin");
  const secondContract = secondStart.data as {
    runner: {
      kind: string;
      strategy: { mode: string; promptTemplate: string; maxRounds: number };
      players: Array<{
        id: string;
        role: string;
        order: number;
        promptTemplate: string;
        resources: Array<{ name: string }>;
        runtimePolicy: { filesystem: string; network: string; approvals: string };
      }>;
    };
    repository: { baseSha: string };
  };
  assert.equal(secondContract.runner.kind, "team");
  assert.deepEqual(secondContract.runner.strategy, {
    mode: "parallel",
    promptTemplate: "Coordinate implementation and review in parallel.",
    maxRounds: 4
  });
  assert.deepEqual(secondContract.runner.players.map(player => ({
    id: player.id,
    role: player.role,
    order: player.order,
    promptTemplate: player.promptTemplate,
    resources: player.resources.map(resource => resource.name),
    runtimePolicy: player.runtimePolicy
  })), [
    {
      id: "player-one",
      role: "implementation",
      order: 1,
      promptTemplate: "Implement the refined Goal and report criterion-linked evidence.",
      resources: ["verification"],
      runtimePolicy: { filesystem: "worktree_write", network: "enabled", approvals: "on_request" }
    },
    {
      id: "player-two",
      role: "review",
      order: 2,
      promptTemplate: "Review the implementation and report risks.",
      resources: [],
      runtimePolicy: { filesystem: "read_only", network: "disabled", approvals: "never" }
    }
  ]);
  assert.equal(secondContract.repository.baseSha, INITIAL_SHA);
  const secondCommit = transport.addCommit({
    repository,
    branch: "hunsu/run/project-one/goal-one/run-two",
    parentSha: INITIAL_SHA,
    files: { "result-two.txt": "second" }
  });
  if (!secondCommit.ok) assert.fail(secondCommit.error.message);

  stateHeadSha = (await mutation(service, "hunsu.runs.complete", {
    repository: repo,
    projectId: "project-one",
    runId: "run-two",
    resultSha: secondCommit.value,
    evidence: [
      { kind: "commit", summary: "Second result commit", sha: secondCommit.value, criterion: "The result commit is verified" },
      { kind: "check", summary: "Second result reconstruction", criterion: "State rebuild preserves the decision" }
    ],
    idempotencyKey: "run-two-complete",
    expectedStateSha: stateHeadSha
  })).stateHeadSha;

  const overviewBeforeComparison = await service.webProject(webAuth, "project-one");
  if (!overviewBeforeComparison.ok) assert.fail(overviewBeforeComparison.error.message);
  const divergenceId = (overviewBeforeComparison.value.project as { alternatives: Array<{ id: string }> }).alternatives[0].id;

  stateHeadSha = (await mutation(service, "hunsu.alternatives.compare", {
    repository: repo,
    projectId: "project-one",
    comparisonId: "comparison-one",
    divergenceId,
    goalId: "goal-one",
    runIds: ["run-one", "run-two"],
    findings: [
      {
        criterion: "The result commit is verified",
        summaries: [
          { runId: "run-one", summary: "First commit verified." },
          { runId: "run-two", summary: "Second commit verified." }
        ]
      },
      {
        criterion: "State rebuild preserves the decision",
        summaries: [
          { runId: "run-one", summary: "First Run reconstruction is recorded." },
          { runId: "run-two", summary: "Second Run reconstruction is recorded." }
        ]
      }
    ],
    summary: "Both same-base alternatives are GitHub-verifiable.",
    idempotencyKey: "alternatives-compare",
    expectedStateSha: stateHeadSha
  })).stateHeadSha;

  const comparisonRequired = await service.webDecideAlternative(webAuth, "project-one", "goal-one", "run-two", "select", {
    idempotencyKey: "web-selection-without-comparison",
    expectedStateSha: stateHeadSha
  });
  if (comparisonRequired.ok) assert.fail("Web selected an alternative without a recorded comparison id.");
  assert.equal(comparisonRequired.error.code, "invalid_request");

  stateHeadSha = (await mutation(service, "hunsu.alternatives.select", {
    repository: repo,
    projectId: "project-one",
    runId: "run-two",
    comparisonId: "comparison-one",
    rationale: "The second alternative better preserves reconstruction evidence.",
    confirmedByUser: true,
    idempotencyKey: "alternative-select",
    expectedStateSha: stateHeadSha
  })).stateHeadSha;

  stateHeadSha = (await mutation(service, "hunsu.goals.complete", {
    repository: repo,
    projectId: "project-one",
    goalId: "goal-one",
    selectedRunId: "run-two",
    evidenceSummary: "The selected Run has GitHub-backed commit evidence.",
    idempotencyKey: "goal-complete",
    expectedStateSha: stateHeadSha
  })).stateHeadSha;

  service.dropProjectionCache();
  const rebuilt = await service.webGoal(webAuth, "project-one", "goal-one");
  if (!rebuilt.ok) assert.fail(rebuilt.error.message);
  assert.equal(rebuilt.value.stateHeadSha, stateHeadSha);
  const goal = rebuilt.value.goal as { status: string; decision?: { recommendedRunId?: string }; runs: unknown[]; evidence: unknown[] };
  assert.equal(goal.status, "completed");
  assert.equal(goal.decision?.recommendedRunId, "run-two");
  assert.equal(goal.runs.length, 2);
  assert.equal(goal.evidence.length, 4);
});

test("equivalent Web and MCP Goal updates emit the same domain event payload", async () => {
  const left = await parityHarness();
  const right = await parityHarness();
  const web = await left.service.webUpdateGoal({ ...auth, client: "web" }, "project-parity", "goal-parity", {
    title: "One shared event",
    idempotencyKey: "parity-goal-update",
    expectedStateSha: left.stateHeadSha
  });
  if (!web.ok) assert.fail(web.error.message);
  const mcp = await right.service.call("hunsu.goals.update", {
    repository: { owner: "acme", name: "product" },
    projectId: "project-parity",
    goalId: "goal-parity",
    title: "One shared event",
    idempotencyKey: "parity-goal-update",
    expectedStateSha: right.stateHeadSha
  }, auth);
  if (!mcp.ok) assert.fail(mcp.error.message);
  assert.deepEqual(await goalUpdatedPayload(left.transport), await goalUpdatedPayload(right.transport));
});

test("repository authorization intersects App grants with user access and preserves read-only access", async () => {
  const hiddenRepository: RepositoryGrant = {
    ...repository,
    repositoryId: 30,
    name: "hidden-product"
  };
  const transport = new MemoryGitHubTransport([
    { repository, initialSha: INITIAL_SHA },
    { repository: hiddenRepository, initialSha: INITIAL_SHA }
  ]);
  const service = new HunsuApplicationService({
    transport,
    now: () => new Date("2026-07-13T04:00:00.000Z")
  });
  const writable = await service.webCreateProject({ ...auth, client: "web" }, {
    repository: { owner: repository.owner, name: repository.name },
    title: "Authorized product",
    objective: "Keep GitHub App authority within the signed-in user's repository grants",
    baseRef: "main",
    idempotencyKey: "authorized-project-create"
  });
  if (!writable.ok) assert.fail(writable.error.message);
  const projectId = writable.value.value.projectId;
  const readOnly: AuthContext = {
    ...auth,
    client: "web",
    installations: [{
      id: 17,
      accountLogin: "acme",
      accountType: "organization",
      repositories: [{ repositoryId: repository.repositoryId, permissions: { contents: "read" } }]
    }]
  };

  const listed = await service.sessionRepositories(readOnly);
  if (!listed.ok) assert.fail(listed.error.message);
  assert.deepEqual(
    listed.value.repositories.map(item => (item as { name: string }).name),
    [repository.name]
  );
  const readOnlyProject = await service.webProject(readOnly, projectId);
  if (!readOnlyProject.ok) assert.fail(readOnlyProject.error.message);
  assert.equal((readOnlyProject.value.project as { health: { repositoryAccess: string } }).health.repositoryAccess, "read_only");

  const webMutation = await service.webCreateGoal(readOnly, projectId, {
    title: "Must not be created",
    desiredOutcome: "Read-only users cannot append state",
    acceptanceCriteria: ["No state mutation is written"],
    constraints: [],
    priority: 50,
    idempotencyKey: "read-only-web-mutation"
  });
  if (webMutation.ok) assert.fail("A read-only user mutated a Project through Web.");
  assert.equal(webMutation.error.code, "forbidden");

  const mcpMutation = await service.call("hunsu.projects.update", {
    repository: { owner: repository.owner, name: repository.name },
    projectId,
    title: "Must not be updated",
    idempotencyKey: "read-only-mcp-mutation",
    expectedStateSha: writable.value.stateHeadSha
  }, { ...readOnly, client: "mcp" });
  if (mcpMutation.ok) assert.fail("A read-only user mutated a Project through MCP.");
  assert.equal(mcpMutation.error.code, "forbidden");

  const hidden = await service.call("hunsu.projects.create", {
    repository: { owner: hiddenRepository.owner, name: hiddenRepository.name },
    projectId: "hidden-project",
    title: "Hidden",
    objective: "Must remain outside user authority",
    baseRef: "main",
    coachId: "hidden-coach",
    idempotencyKey: "hidden-project-create"
  }, { ...readOnly, client: "mcp" });
  if (hidden.ok) assert.fail("A user accessed another repository granted only to the App installation.");
  assert.equal(hidden.error.code, "forbidden");
});

test("repository authorization preserves multi-installation ambiguity checks", async () => {
  const duplicateName: RepositoryGrant = {
    ...repository,
    installationId: 18,
    repositoryId: 31
  };
  const transport = new MemoryGitHubTransport([
    { repository, initialSha: INITIAL_SHA },
    { repository: duplicateName, initialSha: INITIAL_SHA }
  ]);
  const service = new HunsuApplicationService({ transport });
  const multiInstallation: AuthContext = {
    ...auth,
    installations: [
      ...auth.installations,
      {
        id: 18,
        accountLogin: "acme",
        accountType: "organization",
        repositories: [{ repositoryId: 31, permissions: { contents: "write" } }]
      }
    ]
  };
  const result = await service.call("hunsu.projects.create", {
    repository: { owner: repository.owner, name: repository.name },
    projectId: "ambiguous-project",
    title: "Ambiguous",
    objective: "Require exact repository identity",
    baseRef: "main",
    coachId: "ambiguous-coach",
    idempotencyKey: "ambiguous-repository-create"
  }, multiInstallation);
  if (result.ok) assert.fail("An ambiguous repository name was accepted across installations.");
  assert.equal(result.error.code, "conflict");
});

test("bounded projection polling recovers a missed webhook across API instances", async () => {
  const transport = new MemoryGitHubTransport([{ repository, initialSha: INITIAL_SHA }]);
  let cacheNow = 0;
  let tick = 0;
  const writer = new HunsuApplicationService({
    transport,
    now: () => new Date(Date.UTC(2026, 6, 13, 5, 0, tick++)),
    cacheNow: () => cacheNow
  });
  const reader = new HunsuApplicationService({
    transport,
    now: () => new Date("2026-07-13T05:10:00.000Z"),
    cacheNow: () => cacheNow
  });
  const created = await mutation(writer, "hunsu.projects.create", {
    repository: { owner: repository.owner, name: repository.name },
    projectId: "project-polling",
    title: "Before polling",
    objective: "Refresh a disposable projection without relying on webhook delivery",
    baseRef: "main",
    coachId: "coach-polling",
    idempotencyKey: "project-polling-create"
  });
  const webAuth = { ...auth, client: "web" as const };
  const first = await reader.webProject(webAuth, "project-polling");
  if (!first.ok) assert.fail(first.error.message);
  assert.equal((first.value.project as { title: string }).title, "Before polling");

  await mutation(writer, "hunsu.projects.update", {
    repository: { owner: repository.owner, name: repository.name },
    projectId: "project-polling",
    title: "After polling",
    idempotencyKey: "project-polling-update",
    expectedStateSha: created.stateHeadSha
  });
  const stillCached = await reader.webProject(webAuth, "project-polling");
  if (!stillCached.ok) assert.fail(stillCached.error.message);
  assert.equal((stillCached.value.project as { title: string }).title, "Before polling");

  cacheNow = 4_001;
  const refreshed = await reader.webProject(webAuth, "project-polling");
  if (!refreshed.ok) assert.fail(refreshed.error.message);
  assert.equal((refreshed.value.project as { title: string }).title, "After polling");
  assert.notEqual(refreshed.value.stateHeadSha, first.value.stateHeadSha);
});

async function mutation(service: HunsuApplicationService, name: string, input: Record<string, unknown>) {
  const response = await service.call(name, input, auth);
  if (!response.ok) assert.fail(response.error.message);
  assert.ok(response.stateHeadSha);
  return { data: response.data, stateHeadSha: response.stateHeadSha };
}

async function parityHarness() {
  const transport = new MemoryGitHubTransport([{ repository, initialSha: INITIAL_SHA }]);
  const service = new HunsuApplicationService({ transport, now: () => new Date("2026-07-13T03:00:00.000Z") });
  const project = await service.call("hunsu.projects.create", {
    repository: { owner: "acme", name: "product" },
    projectId: "project-parity",
    title: "Parity",
    objective: "Prove command surface parity",
    baseRef: "main",
    coachId: "coach-parity",
    idempotencyKey: "parity-project-create"
  }, auth);
  if (!project.ok || !project.stateHeadSha) assert.fail(project.ok ? "Missing Project state head." : project.error.message);
  const goal = await service.call("hunsu.goals.create", {
    repository: { owner: "acme", name: "product" },
    projectId: "project-parity",
    goalId: "goal-parity",
    title: "Original title",
    desiredOutcome: "Both surfaces agree",
    acceptanceCriteria: ["The event payload matches"],
    constraints: [],
    idempotencyKey: "parity-goal-create",
    expectedStateSha: project.stateHeadSha
  }, auth);
  if (!goal.ok || !goal.stateHeadSha) assert.fail(goal.ok ? "Missing Goal state head." : goal.error.message);
  return { service, transport, stateHeadSha: goal.stateHeadSha };
}

async function goalUpdatedPayload(transport: MemoryGitHubTransport): Promise<unknown> {
  const branch = await transport.readBranch(repository, "hunsu/state");
  if (!branch.ok || !branch.value) assert.fail(branch.ok ? "Missing state branch." : branch.error.message);
  const events = Object.entries(branch.value.files)
    .filter(([path]) => path.includes("/events/"))
    .map(([, text]) => JSON.parse(text) as { sequence: number; event: { type: string; meta: unknown; [key: string]: unknown } })
    .sort((left, right) => left.sequence - right.sequence);
  const updated = events.findLast(item => item.event.type === "GoalUpdated")?.event;
  if (!updated) assert.fail("GoalUpdated event not found.");
  const { meta: _meta, ...payload } = updated;
  return payload;
}
