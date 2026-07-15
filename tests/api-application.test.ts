import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  HunsuApplicationService,
  bundledRunnerTypes,
  projectStateCodec,
  type AuthContext
} from "../apps/api/src/index.ts";
import {
  GitHubProjectStore,
  HUNSU_STATE_BRANCH,
  MemoryGitHubTransport,
  exactStateFilePath,
  type RepositoryGrant,
  type RepositoryLocator,
  type TransportResult
} from "../packages/github-store/src/index.ts";
import { canonicalJson, computeGoalDigest, decodeNodePlan } from "../packages/protocol/src/index.ts";
import {
  decodeNodeActivityIndex,
  decodeNodeActivityRecord,
  decodeRunActivityShard
} from "../apps/api/src/sharded-read-models.ts";

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

const repositoryInput = {
  owner: repository.owner,
  name: repository.name
};

const auth: AuthContext = {
  subject: "github:7",
  user: { id: "7", login: "octocat" },
  installations: [{
    id: repository.installationId,
    accountLogin: repository.owner,
    accountType: "organization",
    repositories: [{ repositoryId: repository.repositoryId, permissions: { contents: "write" } }]
  }],
  selectedInstallationId: repository.installationId,
  client: "mcp"
};

const playerType = bundledRunnerTypes.find(item => item.type.key === "runner.player")?.type;
if (!playerType) throw new Error("Bundled Player Runner type is missing.");

const initialPlan = {
  schema: "hunsu.node-plan.v1" as const,
  nextGoals: [
    {
      key: "goal-one",
      title: "Validate the first implementation",
      desiredOutcome: "The first result is reconstructed as a Commit Node.",
      acceptanceCriteria: ["The first result is verified"],
      constraints: ["Do not move main"],
      priority: 90
    },
    {
      key: "goal-two",
      title: "Validate the sibling implementation",
      desiredOutcome: "A second completed Run is recorded as a sibling Node.",
      acceptanceCriteria: ["The sibling result is verified"],
      constraints: ["Do not move main"],
      priority: 80
    }
  ],
  how: {
    schema: "hunsu.runner-value.v1" as const,
    type: playerType,
    name: "Production Player",
    value: {
      promptTemplate: "Implement exactly one Goal and attach criterion-linked evidence.",
      resources: [],
      runtimePolicy: { filesystem: "worktree_write", network: "enabled", approvals: "on_request" }
    }
  }
};

const decodedInitialPlanResult = decodeNodePlan(initialPlan, bundledRunnerTypes);
const decodedInitialPlan = decodedInitialPlanResult.ok
  ? decodedInitialPlanResult.value
  : (() => { throw new Error(decodedInitialPlanResult.error.message); })();

test("Project discovery periodically revalidates the root managed Node anchor at an unchanged state head", async () => {
  class TrackingMemoryTransport extends MemoryGitHubTransport {
    exactAnchorReads = 0;

    override async readManagedNodeAnchors(...args: Parameters<MemoryGitHubTransport["readManagedNodeAnchors"]>) {
      this.exactAnchorReads += 1;
      return super.readManagedNodeAnchors(...args);
    }
  }
  const transport = new TrackingMemoryTransport([{ repository, initialSha: INITIAL_SHA }]);
  let cacheNow = 0;
  const service = new HunsuApplicationService({
    transport,
    cacheNow: () => cacheNow,
    projectionCachePolicy: { projectTtlMs: 10 }
  });
  await mutation(service, "hunsu.projects.create", {
    repository: repositoryInput,
    projectId: "project-anchor-cache",
    title: "Managed anchor cache trial",
    rootNodeSha: INITIAL_SHA,
    initialPlan,
    idempotencyKey: "create-project-anchor-cache",
    expectedStateSha: INITIAL_SHA,
    confirmedByUser: true
  });

  const first = await service.call("hunsu.projects.list", {}, auth);
  assert.equal(first.ok, true);
  assert.equal(transport.exactAnchorReads, 1);
  const cached = await service.call("hunsu.projects.list", {}, auth);
  assert.equal(cached.ok, true);
  assert.equal(transport.exactAnchorReads, 1);

  cacheNow = 11;
  const revalidated = await service.call("hunsu.projects.list", {}, auth);
  assert.equal(revalidated.ok, true);
  assert.equal(transport.exactAnchorReads, 2);
});

test("stable Node inspector reads reuse bounded Project and selected-anchor verification caches", async () => {
  class TrackingMemoryTransport extends MemoryGitHubTransport {
    branchHeadReads = 0;
    exactAnchorReads = 0;

    override async readBranchHead(...args: Parameters<MemoryGitHubTransport["readBranchHead"]>) {
      this.branchHeadReads += 1;
      return super.readBranchHead(...args);
    }

    override async readManagedNodeAnchors(...args: Parameters<MemoryGitHubTransport["readManagedNodeAnchors"]>) {
      this.exactAnchorReads += 1;
      return super.readManagedNodeAnchors(...args);
    }
  }

  const transport = new TrackingMemoryTransport([{ repository, initialSha: INITIAL_SHA }]);
  let cacheNow = 0;
  const service = new HunsuApplicationService({
    transport,
    cacheNow: () => cacheNow,
    projectionCachePolicy: { projectTtlMs: 10, nodeAnchorTtlMs: 20 }
  });
  await mutation(service, "hunsu.projects.create", {
    repository: repositoryInput,
    projectId: "project-node-inspector-cache",
    title: "Node inspector cache trial",
    rootNodeSha: INITIAL_SHA,
    initialPlan,
    idempotencyKey: "create-project-node-inspector-cache",
    expectedStateSha: INITIAL_SHA,
    confirmedByUser: true
  });

  service.invalidateAll();
  transport.branchHeadReads = 0;
  transport.exactAnchorReads = 0;
  const readNode = () => service.call("hunsu.nodes.get", {
    repository: repositoryInput,
    projectId: "project-node-inspector-cache",
    nodeSha: INITIAL_SHA
  }, auth);

  const first = await readNode();
  if (!first.ok) assert.fail(first.error.message);
  assert.equal(transport.branchHeadReads, 1);
  assert.equal(transport.exactAnchorReads, 2, "the first read verifies the root catalog and selected Node independently");

  const cached = await readNode();
  if (!cached.ok) assert.fail(cached.error.message);
  assert.equal(transport.branchHeadReads, 1, "a fresh Project cache avoids even the state-head lookup");
  assert.equal(transport.exactAnchorReads, 2, "a fresh selected-anchor cache avoids another managed-ref lookup");

  cacheNow = 11;
  const projectRevalidated = await readNode();
  if (!projectRevalidated.ok) assert.fail(projectRevalidated.error.message);
  assert.equal(transport.branchHeadReads, 2);
  assert.equal(transport.exactAnchorReads, 3, "Project TTL expiry revalidates only the root while the selected anchor remains fresh");

  cacheNow = 21;
  const allRevalidated = await readNode();
  if (!allRevalidated.ok) assert.fail(allRevalidated.error.message);
  assert.equal(transport.branchHeadReads, 3);
  assert.equal(transport.exactAnchorReads, 5, "both root and selected anchor are revalidated after their bounded TTLs");

  service.invalidateRepository(repository);
  const invalidated = await readNode();
  if (!invalidated.ok) assert.fail(invalidated.error.message);
  assert.equal(transport.branchHeadReads, 4);
  assert.equal(transport.exactAnchorReads, 7, "repository invalidation clears both authority caches immediately");
});

test("an invalidated selected-anchor flight cannot republish a stale verification", async () => {
  let releaseDeferred!: () => void;
  let markDeferredStarted!: () => void;
  const deferred = new Promise<void>(resolve => {
    releaseDeferred = resolve;
  });
  const deferredStarted = new Promise<void>(resolve => {
    markDeferredStarted = resolve;
  });
  class DeferredAnchorTransport extends MemoryGitHubTransport {
    exactAnchorReads = 0;
    deferredCall = Number.POSITIVE_INFINITY;

    override async readManagedNodeAnchors(...args: Parameters<MemoryGitHubTransport["readManagedNodeAnchors"]>) {
      const call = ++this.exactAnchorReads;
      const result = await super.readManagedNodeAnchors(...args);
      if (call === this.deferredCall) {
        markDeferredStarted();
        await deferred;
      }
      return result;
    }
  }

  const transport = new DeferredAnchorTransport([{ repository, initialSha: INITIAL_SHA }]);
  const service = new HunsuApplicationService({ transport });
  await mutation(service, "hunsu.projects.create", {
    repository: repositoryInput,
    projectId: "project-invalidated-anchor-flight",
    title: "Invalidated anchor flight trial",
    rootNodeSha: INITIAL_SHA,
    initialPlan,
    idempotencyKey: "create-project-invalidated-anchor-flight",
    expectedStateSha: INITIAL_SHA,
    confirmedByUser: true
  });

  service.invalidateAll();
  transport.exactAnchorReads = 0;
  transport.deferredCall = 2;
  const readNode = () => service.call("hunsu.nodes.get", {
    repository: repositoryInput,
    projectId: "project-invalidated-anchor-flight",
    nodeSha: INITIAL_SHA
  }, auth);

  const stale = readNode();
  await deferredStarted;
  assert.equal(transport.exactAnchorReads, 2, "the selected-anchor verification is the deferred second lookup");
  service.invalidateRepository(repository);
  releaseDeferred();
  const staleResult = await stale;
  if (!staleResult.ok) assert.fail(staleResult.error.message);

  const current = await readNode();
  if (!current.ok) assert.fail(current.error.message);
  assert.equal(
    transport.exactAnchorReads,
    4,
    "the invalidated flight cannot satisfy either authority lookup after repository invalidation"
  );
});

test("concurrent Project shell and Graph reads share installation and repository projection flights", async () => {
  class TrackingMemoryTransport extends MemoryGitHubTransport {
    installationLists = 0;
    branchHeadReads = 0;
    exactAnchorReads = 0;

    override async listInstallationRepositories(...args: Parameters<MemoryGitHubTransport["listInstallationRepositories"]>) {
      this.installationLists += 1;
      await new Promise(resolve => setTimeout(resolve, 5));
      return super.listInstallationRepositories(...args);
    }

    override async readBranchHead(...args: Parameters<MemoryGitHubTransport["readBranchHead"]>) {
      this.branchHeadReads += 1;
      await new Promise(resolve => setTimeout(resolve, 5));
      return super.readBranchHead(...args);
    }

    override async readManagedNodeAnchors(...args: Parameters<MemoryGitHubTransport["readManagedNodeAnchors"]>) {
      this.exactAnchorReads += 1;
      return super.readManagedNodeAnchors(...args);
    }
  }
  const transport = new TrackingMemoryTransport([{ repository, initialSha: INITIAL_SHA }]);
  const service = new HunsuApplicationService({ transport });
  await mutation(service, "hunsu.projects.create", {
    repository: repositoryInput,
    projectId: "project-concurrent-read",
    title: "Concurrent Project read trial",
    rootNodeSha: INITIAL_SHA,
    initialPlan,
    idempotencyKey: "create-project-concurrent-read",
    expectedStateSha: INITIAL_SHA,
    confirmedByUser: true
  });
  service.invalidateAll();
  transport.installationLists = 0;
  transport.branchHeadReads = 0;
  transport.exactAnchorReads = 0;

  const [projects, graph] = await Promise.all([
    service.webProjects(auth),
    service.webGraph(auth, "project-concurrent-read", {})
  ]);
  assert.equal(projects.ok, true);
  assert.equal(graph.ok, true);
  assert.equal(transport.installationLists, 1);
  assert.equal(transport.branchHeadReads, 1);
  assert.equal(transport.exactAnchorReads, 1);
});

test("an invalidated installation flight cannot republish stale repository grants", async () => {
  let resolveFirst!: (result: TransportResult<RepositoryGrant[]>) => void;
  let resolveSecond!: (result: TransportResult<RepositoryGrant[]>) => void;
  const firstResponse = new Promise<TransportResult<RepositoryGrant[]>>(resolve => {
    resolveFirst = resolve;
  });
  const secondResponse = new Promise<TransportResult<RepositoryGrant[]>>(resolve => {
    resolveSecond = resolve;
  });
  class DeferredInstallationTransport extends MemoryGitHubTransport {
    installationLists = 0;

    override async listInstallationRepositories(): Promise<TransportResult<RepositoryGrant[]>> {
      this.installationLists += 1;
      if (this.installationLists === 1) return firstResponse;
      if (this.installationLists === 2) return secondResponse;
      throw new Error("A stale installation flight forced an unexpected third repository listing.");
    }
  }
  const transport = new DeferredInstallationTransport([{ repository, initialSha: INITIAL_SHA }]);
  const service = new HunsuApplicationService({ transport });

  const stale = service.sessionRepositories(auth);
  await Promise.resolve();
  assert.equal(transport.installationLists, 1);
  service.invalidateInstallation(repository.installationId);
  const fresh = service.sessionRepositories(auth);
  await Promise.resolve();
  assert.equal(transport.installationLists, 2);

  resolveSecond({ ok: true, value: [] });
  const freshResult = await fresh;
  assert.equal(freshResult.ok, true);
  if (freshResult.ok) assert.deepEqual(freshResult.value.repositories, []);

  resolveFirst({ ok: true, value: [repository] });
  const staleResult = await stale;
  assert.equal(staleResult.ok, true);
  if (staleResult.ok) assert.equal(staleResult.value.repositories.length, 1);

  const current = await service.sessionRepositories(auth);
  assert.equal(current.ok, true);
  if (current.ok) assert.deepEqual(current.value.repositories, []);
  assert.equal(transport.installationLists, 2);
});

test("application service executes the v2 Node lifecycle with idempotent GitHub-backed mutations", async () => {
  const transport = new MemoryGitHubTransport([{ repository, initialSha: INITIAL_SHA }]);
  let tick = 0;
  const service = new HunsuApplicationService({
    transport,
    now: () => new Date(Date.UTC(2026, 6, 15, 1, 0, tick++))
  });

  const createInput = {
    repository: repositoryInput,
    projectId: "project-one",
    title: "Commit Node production trial",
    rootNodeSha: INITIAL_SHA,
    initialPlan,
    idempotencyKey: "create-project-one",
    expectedStateSha: INITIAL_SHA,
    confirmedByUser: true
  };

  const confirmationMissing = await service.call("hunsu.projects.create", {
    ...createInput,
    confirmedByUser: false
  }, auth);
  assert.equal(confirmationMissing.ok, false);
  if (confirmationMissing.ok) assert.fail("Unconfirmed Project initialization succeeded.");
  assert.equal(confirmationMissing.error.code, "confirmation_required");
  const stateBeforeConfirmation = await transport.readBranch(repository, HUNSU_STATE_BRANCH);
  if (!stateBeforeConfirmation.ok) assert.fail(stateBeforeConfirmation.error.message);
  assert.equal(stateBeforeConfirmation.value, undefined);

  const legacyObjective = await service.call("hunsu.projects.create", {
    ...createInput,
    objective: "Legacy Project-owned intent"
  }, auth);
  assert.equal(legacyObjective.ok, false);
  if (legacyObjective.ok) assert.fail("Project initialization accepted a Project objective.");
  assert.equal(legacyObjective.error.code, "invalid_request");
  assert.match(legacyObjective.error.message, /objective/u);

  const invalidRoot = await service.call("hunsu.projects.create", {
    ...createInput,
    rootNodeSha: "1".repeat(39)
  }, auth);
  assert.equal(invalidRoot.ok, false);
  if (invalidRoot.ok) assert.fail("Project initialization accepted a non-full root SHA.");
  assert.equal(invalidRoot.error.code, "invalid_request");

  const invalidExpectedHead = await service.call("hunsu.projects.create", {
    ...createInput,
    expectedStateSha: "1".repeat(39)
  }, auth);
  assert.equal(invalidExpectedHead.ok, false);
  if (invalidExpectedHead.ok) assert.fail("Project initialization accepted a non-full expected state SHA.");
  assert.equal(invalidExpectedHead.error.code, "invalid_request");

  const invalidPlan = await service.call("hunsu.projects.create", {
    ...createInput,
    initialPlan: { ...initialPlan, legacyRunnerId: "runner-one" }
  }, auth);
  assert.equal(invalidPlan.ok, false);
  if (invalidPlan.ok) assert.fail("Project initialization accepted a non-exact Node Plan.");
  assert.equal(invalidPlan.error.code, "invalid_request");

  const created = await mutation(service, "hunsu.projects.create", createInput);
  let stateHeadSha = created.stateHeadSha;
  assert.equal((created.data as { projectId: string }).projectId, "project-one");
  assert.equal(await refValue(transport, `refs/tags/hunsu/node/project-one/${INITIAL_SHA}`), INITIAL_SHA);

  const retriedCreate = await mutation(service, "hunsu.projects.create", createInput);
  assert.equal(retriedCreate.stateHeadSha, stateHeadSha);

  const staleStart = await service.call("hunsu.runs.start", {
    repository: repositoryInput,
    projectId: "project-one",
    sourceNodeSha: INITIAL_SHA,
    goalDigest: goalDigestAt(0),
    runId: "run-stale-cas",
    idempotencyKey: "run-stale-cas-start",
    expectedStateSha: INITIAL_SHA
  }, auth);
  assert.equal(staleStart.ok, false);
  if (staleStart.ok) assert.fail("A stale state-head mutation succeeded.");
  assert.equal(staleStart.error.code, "stale_state");
  assert.equal((await projectContext(service)).stateHeadSha, stateHeadSha);

  const first = await completeRun({
    service,
    transport,
    stateHeadSha,
    runId: "run-one",
    goalIndex: 0,
    resultFile: "first.txt",
    resultContent: "first result"
  });
  stateHeadSha = first.stateHeadSha;

  const firstRetry = await mutation(service, "hunsu.runs.complete", first.completeInput);
  assert.equal(firstRetry.stateHeadSha, stateHeadSha);
  assert.equal((firstRetry.data as { resultNodeSha: string }).resultNodeSha, first.resultSha);
  const duplicateCompletion = await service.call("hunsu.runs.complete", {
    ...first.completeInput,
    idempotencyKey: "run-one-complete-again",
    expectedStateSha: stateHeadSha
  }, auth);
  assert.equal(duplicateCompletion.ok, false);
  if (duplicateCompletion.ok) assert.fail("A terminal Run was completed with a new idempotency key.");
  assert.equal(duplicateCompletion.error.code, "conflict");

  const second = await completeRun({
    service,
    transport,
    stateHeadSha,
    runId: "run-two",
    goalIndex: 1,
    resultFile: "second.txt",
    resultContent: "second result"
  });
  stateHeadSha = second.stateHeadSha;

  const store = new GitHubProjectStore(transport, projectStateCodec);
  const reconstructedBeforeCoaching = await store.readProject(repository, "project-one");
  if (!reconstructedBeforeCoaching.ok) assert.fail(reconstructedBeforeCoaching.error.message);
  const root = reconstructedBeforeCoaching.value.state.nodes.find(node => node.commitSha === INITIAL_SHA);
  if (!root) assert.fail("Root Node was not reconstructed.");

  stateHeadSha = (await mutation(service, "hunsu.coach.review", {
    repository: repositoryInput,
    projectId: "project-one",
    nodeSha: INITIAL_SHA,
    reviewId: "review-one",
    assessment: "Both completed Runs have immutable criterion evidence.",
    findings: ["The result Nodes preserve the source How."],
    recommendation: "Compare the two completed alternatives.",
    idempotencyKey: "review-one-create",
    expectedStateSha: stateHeadSha
  })).stateHeadSha;

  const reviewList = await service.call("hunsu.coach.reviews.list", {
    repository: repositoryInput, projectId: "project-one", nodeSha: INITIAL_SHA, limit: 1
  }, auth);
  if (!reviewList.ok) assert.fail(reviewList.error.message);
  const listedReviews = reviewList.data as { reviews: Array<{ id: string; recommendations: string[] }>; window: { hasMore: boolean } };
  assert.deepEqual(listedReviews.reviews.map(item => item.id), ["review-one"]);
  assert.equal(listedReviews.reviews[0]?.recommendations.length, 2);
  assert.equal(listedReviews.window.hasMore, false);
  const staleReviewCursor = await service.call("hunsu.coach.reviews.list", {
    repository: repositoryInput,
    projectId: "project-one",
    nodeSha: INITIAL_SHA,
    cursor: `${"f".repeat(40)}:0`,
    limit: 1
  }, auth);
  assert.equal(staleReviewCursor.ok, false);
  if (!staleReviewCursor.ok) assert.equal(staleReviewCursor.error.code, "invalid_request");
  const reviewDetail = await service.call("hunsu.coach.reviews.get", {
    repository: repositoryInput, projectId: "project-one", nodeSha: INITIAL_SHA, reviewId: "review-one"
  }, auth);
  if (!reviewDetail.ok) assert.fail(reviewDetail.error.message);
  assert.equal((reviewDetail.data as { review: { assessment: string } }).review.assessment, "Both completed Runs have immutable criterion evidence.");

  const proposedPlan = {
    ...initialPlan,
    how: { ...initialPlan.how, name: "Coached Production Player" }
  };
  const proposalInput = {
    repository: repositoryInput,
    projectId: "project-one",
    sourceNodeSha: INITIAL_SHA,
    sourcePayloadDigest: String(root.payloadDigest),
    proposalId: "proposal-one",
    proposedPlan,
    summary: "Clarify the Runner identity.",
    rationale: "Make the selected How explicit without changing the source tree.",
    idempotencyKey: "proposal-one-create",
    expectedStateSha: stateHeadSha
  };
  stateHeadSha = (await mutation(service, "hunsu.coach.propose_transition", proposalInput)).stateHeadSha;

  const proposalList = await service.call("hunsu.coach.proposals.list", {
    repository: repositoryInput, projectId: "project-one", sourceNodeSha: INITIAL_SHA, limit: 50
  }, auth);
  if (!proposalList.ok) assert.fail(proposalList.error.message);
  const listedProposal = (proposalList.data as { proposals: Array<Record<string, any>> }).proposals[0];
  assert.equal(listedProposal?.summary, proposalInput.summary);
  assert.equal(listedProposal?.rationale, proposalInput.rationale);
  assert.equal(listedProposal?.sourcePayloadDigest, root.payloadDigest);
  assert.equal(listedProposal?.sourcePlanDigest, root.planDigest);
  assert.equal(listedProposal?.disposition.type, "pending");
  assert.equal(listedProposal?.proposedPlan, undefined, "opaque list materialization must not contain the proposed plan");

  const proposalDetail = await service.call("hunsu.coach.proposals.get", {
    repository: repositoryInput, projectId: "project-one", sourceNodeSha: INITIAL_SHA, proposalId: "proposal-one"
  }, auth);
  if (!proposalDetail.ok) assert.fail(proposalDetail.error.message);
  const detailedProposal = (proposalDetail.data as { proposal: Record<string, any> }).proposal;
  assert.equal(detailedProposal.source.payloadDigest, root.payloadDigest);
  assert.equal(detailedProposal.source.plan.how.name, initialPlan.how.name);
  assert.equal(detailedProposal.proposed.plan.how.name, "Coached Production Player");
  assert.equal(detailedProposal.summary, proposalInput.summary);
  assert.equal(detailedProposal.rationale, proposalInput.rationale);

  const completedResultNode = await service.call("hunsu.nodes.get", {
    repository: repositoryInput, projectId: "project-one", nodeSha: first.resultSha
  }, auth);
  if (!completedResultNode.ok) assert.fail(completedResultNode.error.message);
  const completedResultDetail = completedResultNode.data as { payloadDigest: string; evidence: Array<{ id: string }> };
  assert.match(completedResultDetail.payloadDigest, /^hunsu-node-payload-v1:sha256:[0-9a-f]{64}$/u);
  assert.ok(completedResultDetail.evidence.length > 0, "result Node detail must include incoming Run evidence");

  const unconfirmedHead = stateHeadSha;
  const unconfirmed = await service.call("hunsu.coach.confirm_transition", {
    repository: repositoryInput,
    projectId: "project-one",
    proposalId: "proposal-one",
    idempotencyKey: "proposal-one-confirm",
    expectedStateSha: stateHeadSha,
    confirmedByUser: false
  }, auth);
  assert.equal(unconfirmed.ok, false);
  if (unconfirmed.ok) assert.fail("Unconfirmed Coaching transition succeeded.");
  assert.equal(unconfirmed.error.code, "confirmation_required");
  assert.equal((await projectContext(service)).stateHeadSha, unconfirmedHead);

  const confirmed = await mutation(service, "hunsu.coach.confirm_transition", {
    repository: repositoryInput,
    projectId: "project-one",
    proposalId: "proposal-one",
    idempotencyKey: "proposal-one-confirm",
    expectedStateSha: stateHeadSha,
    confirmedByUser: true
  });
  stateHeadSha = confirmed.stateHeadSha;
  const coachingSha = (confirmed.data as { childNodeSha: string }).childNodeSha;
  const rootCommit = await transport.readCommit(repository, INITIAL_SHA);
  const coachingCommit = await transport.readCommit(repository, coachingSha);
  if (!rootCommit.ok || !rootCommit.value || !coachingCommit.ok || !coachingCommit.value) assert.fail("Coaching commits are unavailable.");
  assert.deepEqual(coachingCommit.value.parentShas, [INITIAL_SHA]);
  assert.equal(coachingCommit.value.treeSha, rootCommit.value.treeSha);
  assert.equal(await refValue(transport, `refs/tags/hunsu/node/project-one/${coachingSha}`), coachingSha);

  const confirmedProposal = await service.call("hunsu.coach.proposals.get", {
    repository: repositoryInput,
    projectId: "project-one",
    sourceNodeSha: INITIAL_SHA,
    proposalId: "proposal-one"
  }, auth);
  if (!confirmedProposal.ok) assert.fail(confirmedProposal.error.message);
  const confirmedDisposition = (confirmedProposal.data as {
    proposal: { disposition: Record<string, unknown> };
  }).proposal.disposition;
  assert.equal(confirmedDisposition.type, "confirmed");
  assert.match(String(confirmedDisposition.decisionId), /^decision-[0-9a-f]{20}$/u);
  assert.equal(confirmedDisposition.childNodeSha, coachingSha);
  assert.equal(confirmedDisposition.reason, "User confirmed the Coaching transition.");
  assert.match(String(confirmedDisposition.decidedAt), /^2026-07-15T01:00:[0-9]{2}\.000Z$/u);
  assert.equal(confirmedDisposition.decisionEventId, undefined);
  assert.equal(confirmedDisposition.childRegistrationEventId, undefined);

  const rejectedProposal = await mutation(service, "hunsu.coach.propose_transition", {
    repository: repositoryInput,
    projectId: "project-one",
    sourceNodeSha: INITIAL_SHA,
    sourcePayloadDigest: String(root.payloadDigest),
    proposalId: "proposal-rejected",
    proposedPlan: {
      ...initialPlan,
      how: { ...initialPlan.how, name: "Rejected Production Player" }
    },
    summary: "Consider another Runner identity.",
    rationale: "Exercise authoritative rejection recovery.",
    idempotencyKey: "proposal-rejected-create",
    expectedStateSha: stateHeadSha
  });
  stateHeadSha = rejectedProposal.stateHeadSha;
  const rejectedDecision = await mutation(service, "hunsu.coach.reject_transition", {
    repository: repositoryInput,
    projectId: "project-one",
    proposalId: "proposal-rejected",
    reason: "Keep the confirmed Coaching child.",
    idempotencyKey: "proposal-rejected-reject",
    expectedStateSha: stateHeadSha,
    confirmedByUser: true
  });
  stateHeadSha = rejectedDecision.stateHeadSha;
  const rejectedProposalDetail = await service.call("hunsu.coach.proposals.get", {
    repository: repositoryInput,
    projectId: "project-one",
    sourceNodeSha: INITIAL_SHA,
    proposalId: "proposal-rejected"
  }, auth);
  if (!rejectedProposalDetail.ok) assert.fail(rejectedProposalDetail.error.message);
  assert.equal(
    (rejectedProposalDetail.data as { proposal: { disposition: { type: string } } }).proposal.disposition.type,
    "rejected"
  );

  const comparison = await mutation(service, "hunsu.alternatives.compare", {
    repository: repositoryInput,
    projectId: "project-one",
    comparisonType: "sibling_runs",
    sourceNodeSha: INITIAL_SHA,
    comparisonId: "comparison-one",
    nodeShas: [first.resultSha, second.resultSha],
    findings: [{
      criterion: "Production evidence",
      summaries: [
        { nodeSha: first.resultSha, summary: "The first Node satisfies its criterion." },
        { nodeSha: second.resultSha, summary: "The second Node satisfies its criterion." }
      ]
    }],
    summary: "Both sibling Nodes are valid; the second is preferred.",
    idempotencyKey: "comparison-one-create",
    expectedStateSha: stateHeadSha
  });
  stateHeadSha = comparison.stateHeadSha;

  const comparisonList = await service.call("hunsu.alternatives.list", {
    repository: repositoryInput, projectId: "project-one", nodeSha: INITIAL_SHA, limit: 50
  }, auth);
  if (!comparisonList.ok) assert.fail(comparisonList.error.message);
  const listedComparison = (comparisonList.data as { comparisons: Array<Record<string, any>> }).comparisons[0];
  assert.equal(listedComparison?.type, "sibling_runs");
  assert.equal(listedComparison?.parentNodeSha, INITIAL_SHA);
  assert.equal(listedComparison?.summary, "Both sibling Nodes are valid; the second is preferred.");
  assert.equal(listedComparison?.findings, undefined, "comparison list must not duplicate authoritative findings");
  assert.equal(listedComparison?.disposition.type, "undecided");
  const comparisonDetail = await service.call("hunsu.alternatives.get", {
    repository: repositoryInput,
    projectId: "project-one",
    comparisonType: "sibling_runs",
    sourceNodeSha: INITIAL_SHA,
    comparisonId: "comparison-one"
  }, auth);
  if (!comparisonDetail.ok) assert.fail(comparisonDetail.error.message);
  const detailedComparison = (comparisonDetail.data as { comparison: Record<string, any> }).comparison;
  assert.equal(detailedComparison.findings[0]?.subject, "Production evidence");
  assert.equal(detailedComparison.findings[0]?.summaries.length, 2);

  const rejectWithoutConfirmation = await service.call("hunsu.alternatives.reject", {
    repository: repositoryInput,
    projectId: "project-one",
    comparisonId: "comparison-one",
    nodeSha: first.resultSha,
    rationale: "Prefer the sibling result.",
    idempotencyKey: "reject-first",
    expectedStateSha: stateHeadSha,
    confirmedByUser: false
  }, auth);
  assert.equal(rejectWithoutConfirmation.ok, false);
  if (rejectWithoutConfirmation.ok) assert.fail("Unconfirmed alternative rejection succeeded.");
  assert.equal(rejectWithoutConfirmation.error.code, "confirmation_required");

  stateHeadSha = (await mutation(service, "hunsu.alternatives.reject", {
    repository: repositoryInput,
    projectId: "project-one",
    comparisonId: "comparison-one",
    nodeSha: first.resultSha,
    rationale: "Prefer the sibling result.",
    idempotencyKey: "reject-first",
    expectedStateSha: stateHeadSha,
    confirmedByUser: true
  })).stateHeadSha;

  const selectWithoutConfirmation = await service.call("hunsu.alternatives.select", {
    repository: repositoryInput,
    projectId: "project-one",
    comparisonId: "comparison-one",
    nodeSha: second.resultSha,
    rationale: "The second result is the selected future.",
    idempotencyKey: "select-second",
    expectedStateSha: stateHeadSha,
    confirmedByUser: false
  }, auth);
  assert.equal(selectWithoutConfirmation.ok, false);
  if (selectWithoutConfirmation.ok) assert.fail("Unconfirmed alternative selection succeeded.");
  assert.equal(selectWithoutConfirmation.error.code, "confirmation_required");

  stateHeadSha = (await mutation(service, "hunsu.alternatives.select", {
    repository: repositoryInput,
    projectId: "project-one",
    comparisonId: "comparison-one",
    nodeSha: second.resultSha,
    rationale: "The second result is the selected future.",
    idempotencyKey: "select-second",
    expectedStateSha: stateHeadSha,
    confirmedByUser: true
  })).stateHeadSha;

  const decidedComparison = await service.call("hunsu.alternatives.get", {
    repository: repositoryInput,
    projectId: "project-one",
    comparisonType: "sibling_runs",
    sourceNodeSha: INITIAL_SHA,
    comparisonId: "comparison-one"
  }, auth);
  if (!decidedComparison.ok) assert.fail(decidedComparison.error.message);
  const decidedDisposition = (decidedComparison.data as {
    comparison: { disposition: { type: string; decisions: Array<{ type: string; nodeShas: string[] }> } }
  }).comparison.disposition;
  assert.equal(decidedDisposition.type, "decisions_recorded");
  assert.deepEqual(decidedDisposition.decisions.map(item => item.type).sort(), ["rejection", "selection"]);
  assert.equal(decidedDisposition.decisions.every(item => (item as { eventId?: string }).eventId === undefined), true);

  const rejectedContinuation = await service.call("hunsu.runs.start", {
    repository: repositoryInput,
    projectId: "project-one",
    sourceNodeSha: first.resultSha,
    goalDigest: goalDigestAt(1),
    runId: "run-rejected",
    idempotencyKey: "run-rejected-start",
    expectedStateSha: stateHeadSha
  }, auth);
  assert.equal(rejectedContinuation.ok, false);
  if (rejectedContinuation.ok) assert.fail("A rejected Node started a Run.");
  assert.equal(rejectedContinuation.error.code, "conflict");

  const graphResult = await service.call("hunsu.nodes.graph", {
    repository: repositoryInput,
    projectId: "project-one",
    limit: 300
  }, auth);
  if (!graphResult.ok) assert.fail(graphResult.error.message);
  const graph = graphResult.data as {
    nodes: Array<{ sha: string; status: string }>;
    edges: Array<{ kind: string; sourceSha: string; targetSha: string }>;
    activeRuns: unknown[];
  };
  assert.equal(graph.nodes.length, 4);
  assert.equal(graph.edges.filter(edge => edge.kind === "run").length, 2);
  assert.equal(graph.edges.filter(edge => edge.kind === "coaching").length, 1);
  assert.equal(graph.nodes.find(node => node.sha === first.resultSha)?.status, "rejected");
  assert.equal(graph.nodes.find(node => node.sha === second.resultSha)?.status, "selected");
  assert.equal(graph.activeRuns.length, 0);

  const firstGraphWindow = await service.call("hunsu.nodes.graph", {
    repository: repositoryInput, projectId: "project-one", limit: 2
  }, auth);
  if (!firstGraphWindow.ok) assert.fail(firstGraphWindow.error.message);
  const firstWindow = firstGraphWindow.data as { nodes: Array<{ sha: string }>; window: { continuationCursor: string | null } };
  assert.equal(firstWindow.nodes.length, 2);
  assert.equal(firstWindow.window.continuationCursor, `${stateHeadSha}:2`);
  const secondGraphWindow = await service.call("hunsu.nodes.graph", {
    repository: repositoryInput, projectId: "project-one", limit: 2, cursor: firstWindow.window.continuationCursor!
  }, auth);
  if (!secondGraphWindow.ok) assert.fail(secondGraphWindow.error.message);
  const secondWindow = secondGraphWindow.data as {
    nodes: Array<{ sha: string }>;
    edges: Array<{ sourceSha: string; targetSha: string }>;
    window: { continuationCursor: string | null };
  };
  assert.equal(secondWindow.nodes.length, 2);
  assert.equal(secondWindow.window.continuationCursor, null);
  assert.equal(new Set([...firstWindow.nodes, ...secondWindow.nodes].map(node => node.sha)).size, 4);
  const secondNodeShas = new Set(secondWindow.nodes.map(node => node.sha));
  assert.equal(secondWindow.edges.every(edge => secondNodeShas.has(edge.targetSha)), true);
  assert.equal(secondWindow.edges.some(edge => !secondNodeShas.has(edge.sourceSha)), true, "continuation retains its target edge back to an earlier page");
  const staleGraphCursor = await service.call("hunsu.nodes.graph", {
    repository: repositoryInput, projectId: "project-one", limit: 2, cursor: `${"f".repeat(40)}:2`
  }, auth);
  assert.equal(staleGraphCursor.ok, false);
  if (!staleGraphCursor.ok) assert.equal(staleGraphCursor.error.code, "invalid_request");

  const projectList = await service.webProjects({ ...auth, client: "web" });
  if (!projectList.ok) assert.fail(projectList.error.message);
  const project = (projectList.value as { projects: Array<{ activeRunCount: number; unresolvedDivergenceCount: number; integrity: { status: string } }> }).projects[0];
  assert.equal(project?.activeRunCount, 0);
  assert.equal(project?.unresolvedDivergenceCount, 0);
  assert.equal(project?.integrity.status, "valid");

  const events = await service.webEvents({ ...auth, client: "web" }, "project-one", { limit: 50 });
  if (!events.ok) assert.fail(events.error.message);
  const eventPage = events.value as { events: Array<{ sequence: number }>; stateHeadSha: string; nextCursor: string | null };
  assert.equal(eventPage.stateHeadSha, stateHeadSha);
  assert.ok(eventPage.events.length >= 15);
  assert.deepEqual(eventPage.events.map(item => item.sequence), [...eventPage.events].map(item => item.sequence).sort((a, b) => b - a));
  assert.equal(eventPage.nextCursor, null);

  const firstEventWindow = await service.webEvents({ ...auth, client: "web" }, "project-one", { limit: 5 });
  if (!firstEventWindow.ok) assert.fail(firstEventWindow.error.message);
  const firstEvents = firstEventWindow.value as { events: Array<{ sequence: number }>; nextCursor: string | null };
  assert.equal(firstEvents.events.length, 5);
  assert.match(firstEvents.nextCursor ?? "", new RegExp(`^${stateHeadSha}:[1-9][0-9]*$`, "u"));
  const resumedEvents = await service.webEvents({ ...auth, client: "web" }, "project-one", { limit: 5, cursor: firstEvents.nextCursor! });
  if (!resumedEvents.ok) assert.fail(resumedEvents.error.message);
  const secondEvents = resumedEvents.value as { events: Array<{ sequence: number }> };
  assert.equal(new Set([...firstEvents.events, ...secondEvents.events].map(item => item.sequence)).size, 10);
  const staleEventCursor = await service.webEvents({ ...auth, client: "web" }, "project-one", { limit: 5, cursor: `${"f".repeat(40)}:5` });
  assert.equal(staleEventCursor.ok, false);
  if (!staleEventCursor.ok) assert.equal(staleEventCursor.error.code, "invalid_request");

  const stateBranch = await transport.readBranch(repository, HUNSU_STATE_BRANCH);
  const mainBranch = await transport.readBranch(repository, "main");
  if (!stateBranch.ok || !stateBranch.value || !mainBranch.ok || !mainBranch.value) assert.fail("Repository branches are unavailable.");
  assert.equal(mainBranch.value.headSha, INITIAL_SHA);
  assert.equal(Object.keys(mainBranch.value.files).some(path => path.startsWith(".hunsu/")), false);
  assert.equal(Object.keys(stateBranch.value.files).some(path => path.startsWith(".hunsu/v2/")), true);
  assert.equal(Object.keys(stateBranch.value.files).some(path => path === ".hunsu/state.hunsu"), false);

  const finalState = await store.readProject(repository, "project-one");
  if (!finalState.ok) assert.fail(finalState.error.message);
  assert.equal(finalState.value.state.runs.filter(run => run.status === "running").length, 0);
  assert.equal(finalState.value.state.nodes.filter(node => node.type !== "root" && !node.parentSha).length, 0);
  assert.equal(finalState.value.state.nodes.length, new Set(finalState.value.state.nodes.map(node => node.commitSha)).size);

  const exactState = await transport.readBranch(repository, HUNSU_STATE_BRANCH);
  if (!exactState.ok || !exactState.value) assert.fail("Exact state is unavailable for authoritative recovery tampering.");
  const confirmedProposalPath = `.hunsu/v2/projects/project-one/snapshots/nodes/${INITIAL_SHA}/coaching/by-id/proposal-one.json`;
  const rejectedProposalPath = `.hunsu/v2/projects/project-one/snapshots/nodes/${INITIAL_SHA}/coaching/by-id/proposal-rejected.json`;
  const comparisonPath = `.hunsu/v2/projects/project-one/snapshots/nodes/${INITIAL_SHA}/comparisons/by-id/comparison-one.json`;
  const runActivityPath = ".hunsu/v2/projects/project-one/snapshots/runs/run-one.json";
  let comparisonEventId = "";
  const forgedComparisonActivity = mutateReadModelEnvelope(
    exactState.value.files[comparisonPath]!,
    "nodeActivityRecord",
    payload => {
      const comparison = payload.value;
      assert.equal(comparison.disposition.type, "decisions_recorded");
      comparisonEventId = comparison.eventId;
      for (const decision of comparison.disposition.decisions) {
        decision.rationale = "Forged materialized comparison rationale.";
      }
    }
  );
  const forgedConfirmedProposal = mutateReadModelEnvelope(
    exactState.value.files[confirmedProposalPath]!,
    "nodeActivityRecord",
    payload => {
      assert.equal(payload.value.disposition.type, "confirmed");
      payload.value.disposition.childRegistrationEventId = comparisonEventId;
    }
  );
  const forgedRejectedProposalRecord = mutateReadModelEnvelope(
    exactState.value.files[rejectedProposalPath]!,
    "nodeActivityRecord",
    payload => {
      assert.equal(payload.value.disposition.type, "rejected");
      payload.value.disposition.reason = "Forged materialized rejection rationale.";
    }
  );
  const forgedRunActivity = mutateReadModelEnvelope(
    exactState.value.files[runActivityPath]!,
    "runActivity",
    payload => {
      const evidence = payload.evidence.find((item: any) => item.target.type === "criterion");
      assert.ok(evidence);
      evidence.target.criterion = "A criterion outside the selected Goal";
    }
  );
  assert.equal(decodeNodeActivityRecord(JSON.parse(forgedConfirmedProposal)).ok, true);
  assert.equal(decodeNodeActivityRecord(JSON.parse(forgedRejectedProposalRecord)).ok, true);
  assert.equal(decodeNodeActivityRecord(JSON.parse(forgedComparisonActivity)).ok, true);
  assert.equal(decodeRunActivityShard(JSON.parse(forgedRunActivity)).ok, true);
  const forged = await transport.commitFiles({
    repository,
    branch: HUNSU_STATE_BRANCH,
    expectedHeadSha: exactState.value.headSha,
    message: "Forge disposable activity materializations for recovery QA",
    updates: [
      { path: confirmedProposalPath, content: forgedConfirmedProposal },
      { path: rejectedProposalPath, content: forgedRejectedProposalRecord },
      { path: comparisonPath, content: forgedComparisonActivity },
      { path: runActivityPath, content: forgedRunActivity }
    ]
  });
  if (!forged.ok) assert.fail(forged.error.message);
  service.invalidateAll();

  const forgedProposal = await service.call("hunsu.coach.proposals.get", {
    repository: repositoryInput,
    projectId: "project-one",
    sourceNodeSha: INITIAL_SHA,
    proposalId: "proposal-one"
  }, auth);
  assert.equal(forgedProposal.ok, false);
  if (!forgedProposal.ok) assert.equal(forgedProposal.error.code, "integrity_error");
  const forgedRejectedProposal = await service.call("hunsu.coach.proposals.get", {
    repository: repositoryInput,
    projectId: "project-one",
    sourceNodeSha: INITIAL_SHA,
    proposalId: "proposal-rejected"
  }, auth);
  assert.equal(forgedRejectedProposal.ok, false);
  if (!forgedRejectedProposal.ok) assert.equal(forgedRejectedProposal.error.code, "integrity_error");
  const forgedComparison = await service.call("hunsu.alternatives.get", {
    repository: repositoryInput,
    projectId: "project-one",
    comparisonType: "sibling_runs",
    sourceNodeSha: INITIAL_SHA,
    comparisonId: "comparison-one"
  }, auth);
  assert.equal(forgedComparison.ok, false);
  if (!forgedComparison.ok) assert.equal(forgedComparison.error.code, "integrity_error");
  const forgedRun = await service.call("hunsu.runs.get", {
    repository: repositoryInput,
    projectId: "project-one",
    runId: "run-one"
  }, auth);
  assert.equal(forgedRun.ok, false);
  if (!forgedRun.ok) assert.equal(forgedRun.error.code, "integrity_error");
  const unchangedMain = await transport.readBranchHead(repository, repository.defaultBranch);
  if (!unchangedMain.ok) assert.fail(unchangedMain.error.message);
  assert.equal(unchangedMain.value, INITIAL_SHA);
});

test("coached How comparison detail and Event detail verify the authoritative variant summary", async () => {
  const transport = new MemoryGitHubTransport([{ repository, initialSha: INITIAL_SHA }]);
  let tick = 0;
  const service = new HunsuApplicationService({
    transport,
    now: () => new Date(Date.UTC(2026, 6, 15, 2, 30, tick++))
  });
  const projectId = "coached-event-read";
  const created = await mutation(service, "hunsu.projects.create", {
    repository: repositoryInput,
    projectId,
    title: "Coached Event Read",
    rootNodeSha: INITIAL_SHA,
    initialPlan,
    idempotencyKey: "coached-event-create",
    expectedStateSha: INITIAL_SHA,
    confirmedByUser: true
  });

  const completeCoachedCandidate = async (input: {
    sourceNodeSha: string;
    runId: string;
    resultFile: string;
    expectedStateSha: string;
  }) => {
    const started = await mutation(service, "hunsu.runs.start", {
      repository: repositoryInput,
      projectId,
      sourceNodeSha: input.sourceNodeSha,
      goalDigest: goalDigestAt(0),
      runId: input.runId,
      idempotencyKey: `${input.runId}-start`,
      expectedStateSha: input.expectedStateSha
    });
    const contract = started.data as { repository: { branch: string } };
    const result = transport.addCommit({
      repository,
      branch: contract.repository.branch,
      parentSha: input.sourceNodeSha,
      files: { [input.resultFile]: `${input.runId} result\n` },
      message: `${input.runId} result`
    });
    if (!result.ok) assert.fail(result.error.message);
    const completed = await mutation(service, "hunsu.runs.complete", {
      repository: repositoryInput,
      projectId,
      runId: input.runId,
      resultSha: result.value,
      evidence: [{
        kind: "check",
        summary: `${input.runId} satisfies the shared Goal.`,
        target: { type: "criterion", criterion: initialPlan.nextGoals[0]!.acceptanceCriteria[0]! },
        location: { type: "git", commitSha: result.value, path: input.resultFile }
      }],
      idempotencyKey: `${input.runId}-complete`,
      expectedStateSha: started.stateHeadSha
    });
    return { stateHeadSha: completed.stateHeadSha, resultNodeSha: result.value };
  };

  const baseline = await completeCoachedCandidate({
    sourceNodeSha: INITIAL_SHA,
    runId: "coached-event-baseline",
    resultFile: "baseline.txt",
    expectedStateSha: created.stateHeadSha
  });
  const rootDetail = await service.call("hunsu.nodes.get", {
    repository: repositoryInput,
    projectId,
    nodeSha: INITIAL_SHA
  }, auth);
  if (!rootDetail.ok) assert.fail(rootDetail.error.message);
  const sourcePayloadDigest = (rootDetail.data as { payloadDigest: string }).payloadDigest;
  const proposal = await mutation(service, "hunsu.coach.propose_transition", {
    repository: repositoryInput,
    projectId,
    sourceNodeSha: INITIAL_SHA,
    sourcePayloadDigest,
    proposalId: "coached-event-proposal",
    proposedPlan: {
      ...initialPlan,
      how: { ...initialPlan.how, name: "Coached Event Player" }
    },
    summary: "Change only the How for the controlled experiment.",
    rationale: "Compare the baseline and coached Runner on the same Goal.",
    idempotencyKey: "coached-event-proposal-create",
    expectedStateSha: baseline.stateHeadSha
  });
  const confirmed = await mutation(service, "hunsu.coach.confirm_transition", {
    repository: repositoryInput,
    projectId,
    proposalId: "coached-event-proposal",
    idempotencyKey: "coached-event-proposal-confirm",
    expectedStateSha: proposal.stateHeadSha,
    confirmedByUser: true
  });
  const coachingNodeSha = (confirmed.data as { childNodeSha: string }).childNodeSha;
  const coached = await completeCoachedCandidate({
    sourceNodeSha: coachingNodeSha,
    runId: "coached-event-candidate",
    resultFile: "coached.txt",
    expectedStateSha: confirmed.stateHeadSha
  });

  const compared = await mutation(service, "hunsu.alternatives.compare", {
    repository: repositoryInput,
    projectId,
    comparisonType: "coached_how_experiment",
    anchorNodeSha: INITIAL_SHA,
    comparisonId: "coached-event-comparison",
    nodeShas: [baseline.resultNodeSha, coached.resultNodeSha],
    findings: [{
      criterion: "Shared Goal evidence",
      summaries: [
        { nodeSha: baseline.resultNodeSha, summary: "The baseline result satisfies the shared Goal." },
        { nodeSha: coached.resultNodeSha, summary: "The coached result satisfies the shared Goal." }
      ]
    }],
    summary: "The baseline and coached How results are both verified.",
    idempotencyKey: "coached-event-comparison-create",
    expectedStateSha: coached.stateHeadSha
  });

  const comparison = await service.call("hunsu.alternatives.get", {
    repository: repositoryInput,
    projectId,
    comparisonType: "coached_how_experiment",
    anchorNodeSha: INITIAL_SHA,
    comparisonId: "coached-event-comparison"
  }, auth);
  if (!comparison.ok) assert.fail(comparison.error.message);
  assert.equal(
    (comparison.data as { comparison: { type: string; summary: string } }).comparison.type,
    "coached_how_experiment"
  );

  const events = await service.call("hunsu.events.list", {
    repository: repositoryInput,
    projectId,
    eventType: "AlternativesCompared",
    limit: 50
  }, auth);
  if (!events.ok) assert.fail(events.error.message);
  const comparisonEvent = (events.data as {
    events: Array<{ id: string; type: string; summary: string }>;
  }).events.find(event => event.type === "AlternativesCompared");
  assert.ok(comparisonEvent);
  assert.equal(comparisonEvent.summary, "Compared 2 coached How experiment Nodes");
  const event = await service.call("hunsu.events.get", {
    repository: repositoryInput,
    projectId,
    eventId: comparisonEvent.id
  }, auth);
  if (!event.ok) assert.fail(event.error.message);
  const eventDetail = event.data as {
    stateHeadSha: string;
    event: { type: string; summary: string; reference: { kind: string; nodeSha?: string } };
  };
  assert.equal(eventDetail.stateHeadSha, compared.stateHeadSha);
  assert.equal(eventDetail.event.type, "AlternativesCompared");
  assert.equal(eventDetail.event.summary, "Compared 2 coached How experiment Nodes");
  assert.deepEqual(eventDetail.event.reference, { kind: "node", nodeSha: INITIAL_SHA });
});

test("confirmed Project rebuild CAS-writes recovered materializations and retries idempotently", async () => {
  const transport = new MemoryGitHubTransport([{ repository, initialSha: INITIAL_SHA }]);
  let tick = 0;
  const service = new HunsuApplicationService({
    transport,
    now: () => new Date(Date.UTC(2026, 6, 15, 3, 0, tick++))
  });
  const created = await mutation(service, "hunsu.projects.create", {
    repository: repositoryInput,
    projectId: "rebuild-project",
    title: "Rebuild Project",
    rootNodeSha: INITIAL_SHA,
    initialPlan,
    idempotencyKey: "rebuild-project-create",
    expectedStateSha: INITIAL_SHA,
    confirmedByUser: true
  });
  const corrupt = await transport.commitFiles({
    repository,
    branch: HUNSU_STATE_BRANCH,
    expectedHeadSha: created.stateHeadSha,
    message: "Corrupt disposable Project materialization",
    updates: [{ path: ".hunsu/v2/projects/rebuild-project/project.json", content: "not-json\n" }]
  });
  if (!corrupt.ok) assert.fail(corrupt.error.message);
  service.invalidateRepository(repository);

  const broken = await service.call("hunsu.projects.get", {
    repository: repositoryInput,
    projectId: "rebuild-project"
  }, auth);
  assert.equal(broken.ok, false);
  if (broken.ok) assert.fail("A corrupt exact-head Project materialization was accepted.");
  assert.equal(broken.error.code, "integrity_error");

  const rebuildInput = {
    repository: repositoryInput,
    projectId: "rebuild-project",
    idempotencyKey: "rebuild-project-materializations",
    expectedStateSha: corrupt.value,
    confirmedByUser: false
  };
  const unconfirmed = await service.call("hunsu.projects.rebuild", rebuildInput, auth);
  assert.equal(unconfirmed.ok, false);
  if (unconfirmed.ok) assert.fail("An unconfirmed Project rebuild succeeded.");
  assert.equal(unconfirmed.error.code, "confirmation_required");
  assert.equal(await refValue(transport, "refs/heads/hunsu/state"), corrupt.value);

  const rebuilt = await mutation(service, "hunsu.projects.rebuild", {
    ...rebuildInput,
    confirmedByUser: true
  });
  assert.notEqual(rebuilt.stateHeadSha, corrupt.value);
  assert.equal((rebuilt.data as { schema: string }).schema, "hunsu.web.project-materializations-rebuilt.v2");

  const retry = await mutation(service, "hunsu.projects.rebuild", {
    ...rebuildInput,
    confirmedByUser: true
  });
  assert.equal(retry.stateHeadSha, rebuilt.stateHeadSha);

  const recovered = await service.call("hunsu.projects.get", {
    repository: repositoryInput,
    projectId: "rebuild-project"
  }, auth);
  if (!recovered.ok) assert.fail(recovered.error.message);
  const events = await service.call("hunsu.events.list", {
    repository: repositoryInput,
    projectId: "rebuild-project",
    limit: 50
  }, auth);
  if (!events.ok) assert.fail(events.error.message);
  assert.equal((events.data as { events: Array<{ type: string }> }).events.some(
    event => event.type === "ProjectMaterializationsRebuilt"
  ), true);

  const state = await transport.readBranch(repository, HUNSU_STATE_BRANCH);
  if (!state.ok || !state.value) assert.fail("Rebuilt state branch is unavailable.");
  assert.notEqual(state.value.files[".hunsu/v2/projects/rebuild-project/project.json"], "not-json\n");
  const main = await transport.readBranchHead(repository, repository.defaultBranch);
  if (!main.ok) assert.fail(main.error.message);
  assert.equal(main.value, INITIAL_SHA);
});

test("Coaching confirmation reuses an orphan commit and tag after a state CAS failure", async () => {
  class OneStateCasFailureTransport extends MemoryGitHubTransport {
    failNextStateCas = false;

    override async commitFiles(
      input: Parameters<MemoryGitHubTransport["commitFiles"]>[0]
    ): Promise<TransportResult<string>> {
      if (this.failNextStateCas && input.branch === HUNSU_STATE_BRANCH) {
        this.failNextStateCas = false;
        return { ok: false, error: { code: "conflict", message: "simulated state CAS loss", status: 409 } };
      }
      return super.commitFiles(input);
    }
  }

  const transport = new OneStateCasFailureTransport([{ repository, initialSha: INITIAL_SHA }]);
  let tick = 0;
  const service = new HunsuApplicationService({
    transport,
    now: () => new Date(Date.UTC(2026, 6, 15, 4, 0, tick++))
  });
  const created = await mutation(service, "hunsu.projects.create", {
    repository: repositoryInput,
    projectId: "orphan-retry",
    title: "Orphan Retry",
    rootNodeSha: INITIAL_SHA,
    initialPlan,
    idempotencyKey: "orphan-retry-create",
    expectedStateSha: INITIAL_SHA,
    confirmedByUser: true
  });
  const store = new GitHubProjectStore(transport, projectStateCodec);
  const beforeProposal = await store.readProject(repository, "orphan-retry");
  if (!beforeProposal.ok) assert.fail(beforeProposal.error.message);
  const root = beforeProposal.value.state.nodes.find(node => node.commitSha === INITIAL_SHA);
  if (!root) assert.fail("Root Node is unavailable.");
  const proposedPlan = { ...initialPlan, how: { ...initialPlan.how, name: "Coached Orphan Retry" } };
  const proposed = await mutation(service, "hunsu.coach.propose_transition", {
    repository: repositoryInput,
    projectId: "orphan-retry",
    sourceNodeSha: INITIAL_SHA,
    sourcePayloadDigest: String(root.payloadDigest),
    proposalId: "proposal-orphan-retry",
    proposedPlan,
    summary: "Prepare a deterministic Coaching retry.",
    rationale: "Exercise the prepared-ref retry boundary.",
    idempotencyKey: "proposal-orphan-retry-create",
    expectedStateSha: created.stateHeadSha
  });
  const confirmationInput = {
    repository: repositoryInput,
    projectId: "orphan-retry",
    proposalId: "proposal-orphan-retry",
    idempotencyKey: "proposal-orphan-retry-confirm",
    expectedStateSha: proposed.stateHeadSha,
    confirmedByUser: true
  };

  transport.failNextStateCas = true;
  const failed = await service.call("hunsu.coach.confirm_transition", confirmationInput, auth);
  assert.equal(failed.ok, false);
  if (failed.ok) assert.fail("The simulated Coaching CAS failure succeeded.");
  assert.equal(failed.error.code, "stale_state");
  const orphanAnchors = await transport.listManagedNodeAnchors(repository, "orphan-retry");
  if (!orphanAnchors.ok) assert.fail(orphanAnchors.error.message);
  const orphan = orphanAnchors.value.find(anchor => anchor.nodeSha !== INITIAL_SHA);
  if (!orphan) assert.fail("The prepared Coaching tag was not left for retry.");
  const invisible = await store.readProject(repository, "orphan-retry");
  if (!invisible.ok) assert.fail(invisible.error.message);
  assert.equal(invisible.value.state.nodes.length, 1, "an orphan tag must remain invisible before CAS registration");

  const retried = await mutation(service, "hunsu.coach.confirm_transition", confirmationInput);
  assert.equal((retried.data as { childNodeSha: string }).childNodeSha, orphan.nodeSha);
  const registered = await store.readProject(repository, "orphan-retry");
  if (!registered.ok) assert.fail(registered.error.message);
  assert.equal(registered.value.state.nodes.length, 2);
  assert.equal(registered.value.state.nodes.filter(node => node.commitSha === orphan.nodeSha).length, 1);
  const main = await transport.readBranchHead(repository, repository.defaultBranch);
  if (!main.ok) assert.fail(main.error.message);
  assert.equal(main.value, INITIAL_SHA);
});

test("application service preserves GitHub rate-limit diagnostics", async () => {
  class RateLimitedTransport extends MemoryGitHubTransport {
    override async listInstallationRepositories(): Promise<TransportResult<RepositoryGrant[]>> {
      return {
        ok: false,
        error: {
          code: "rate_limited",
          message: "API rate limit exceeded",
          retryAfterSeconds: 73,
          requestId: "2749:343013:E1DD17:E97BFF:6A55EA12"
        }
      };
    }
  }
  const service = new HunsuApplicationService({ transport: new RateLimitedTransport([{ repository, initialSha: INITIAL_SHA }]) });
  const result = await service.call("hunsu.projects.list", {}, auth);
  assert.equal(result.ok, false);
  if (result.ok) assert.fail("Rate-limited Project list succeeded.");
  assert.equal(result.error.code, "temporarily_unavailable");
  assert.equal(result.error.retryAfterSeconds, 73);
  assert.equal(result.error.requestId, "2749:343013:E1DD17:E97BFF:6A55EA12");
  assert.match(result.error.recovery ?? "", /73 seconds/u);
});

test("ordinary REST and MCP reads use exact-head materializations without event replay", async () => {
  class TrackingTransport extends MemoryGitHubTransport {
    blockStateReplay = false;
    stateReplayReads = 0;
    managedAnchorReads = 0;
    readonly targetedSelections: Array<Parameters<MemoryGitHubTransport["readStateFilesAtHead"]>[2]> = [];

    override async readBranch(target: RepositoryLocator, branch: string) {
      if (this.blockStateReplay && branch === HUNSU_STATE_BRANCH) {
        this.stateReplayReads += 1;
        return { ok: false as const, error: { code: "network" as const, message: "Full state replay is forbidden for ordinary reads." } };
      }
      return super.readBranch(target, branch);
    }

    override async readStateFilesAtHead(
      target: RepositoryLocator,
      stateHeadSha: string,
      selections: Parameters<MemoryGitHubTransport["readStateFilesAtHead"]>[2]
    ) {
      this.targetedSelections.push(selections);
      return super.readStateFilesAtHead(target, stateHeadSha, selections);
    }

    override async readManagedNodeAnchors(...args: Parameters<MemoryGitHubTransport["readManagedNodeAnchors"]>) {
      this.managedAnchorReads += 1;
      return super.readManagedNodeAnchors(...args);
    }
  }

  const transport = new TrackingTransport([{ repository, initialSha: INITIAL_SHA }]);
  const service = new HunsuApplicationService({ transport, now: () => new Date("2026-07-15T03:00:00.000Z") });
  const created = await mutation(service, "hunsu.projects.create", {
    repository: repositoryInput,
    projectId: "project-one",
    title: "Fast read Project",
    rootNodeSha: INITIAL_SHA,
    initialPlan,
    idempotencyKey: "fast-read-create",
    expectedStateSha: INITIAL_SHA,
    confirmedByUser: true
  });
  const started = await mutation(service, "hunsu.runs.start", {
    repository: repositoryInput,
    projectId: "project-one",
    sourceNodeSha: INITIAL_SHA,
    goalDigest: goalDigestAt(0),
    runId: "run-fast-read",
    idempotencyKey: "fast-read-start",
    expectedStateSha: created.stateHeadSha
  });
  assert.ok(started.stateHeadSha);

  service.invalidateAll();
  transport.blockStateReplay = true;
  const projectList = await service.call("hunsu.projects.list", {}, auth);
  if (!projectList.ok) assert.fail(projectList.error.message);
  const listData = projectList.data as { repositories: Array<{ state: { stateHeadSha?: string } }> };
  assert.equal(listData.repositories[0]?.state.stateHeadSha, started.stateHeadSha);
  const project = await service.call("hunsu.projects.get", { repository: repositoryInput, projectId: "project-one" }, auth);
  if (!project.ok) assert.fail(project.error.message);
  const targetedBeforeActivityLists = transport.targetedSelections.length;
  const anchorsBeforeActivityLists = transport.managedAnchorReads;
  const [reviewList, proposalList, comparisonList] = await Promise.all([
    service.call("hunsu.coach.reviews.list", {
      repository: repositoryInput, projectId: "project-one", nodeSha: INITIAL_SHA, limit: 50
    }, auth),
    service.call("hunsu.coach.proposals.list", {
      repository: repositoryInput, projectId: "project-one", sourceNodeSha: INITIAL_SHA, limit: 50
    }, auth),
    service.call("hunsu.alternatives.list", {
      repository: repositoryInput, projectId: "project-one", nodeSha: INITIAL_SHA, limit: 50
    }, auth)
  ]);
  if (!reviewList.ok) assert.fail(reviewList.error.message);
  if (!proposalList.ok) assert.fail(proposalList.error.message);
  if (!comparisonList.ok) assert.fail(comparisonList.error.message);
  const activityListSelections = transport.targetedSelections.slice(targetedBeforeActivityLists).flat();
  assert.equal(activityListSelections.some(selection => selection.kind === "project_read_model" && selection.model === "activity"), true);
  assert.equal(activityListSelections.some(selection => selection.kind === "node_activity_index"), true);
  assert.equal(activityListSelections.some(selection => selection.kind === "node_payload" || selection.kind === "graph_node"), false);
  assert.equal(transport.managedAnchorReads, anchorsBeforeActivityLists);
  const targetedBeforeGraph = transport.targetedSelections.length;
  const graph = await service.call("hunsu.nodes.graph", { repository: repositoryInput, projectId: "project-one", limit: 300 }, auth);
  if (!graph.ok) assert.fail(graph.error.message);
  const targetedAfterGraph = transport.targetedSelections.length;
  assert.equal(targetedAfterGraph, targetedBeforeGraph + 2);
  const graphSelections = transport.targetedSelections.slice(targetedBeforeGraph);
  assert.deepEqual(graphSelections[0]?.map(selection => selection.kind).sort(), ["graph_page", "project_read_model"]);
  assert.deepEqual(graphSelections[1]?.map(selection => selection.kind), ["graph_node"]);
  assert.equal(graphSelections[1]!.length <= 300, true);
  const graphAgain = await service.call("hunsu.nodes.graph", { repository: repositoryInput, projectId: "project-one", limit: 300 }, auth);
  if (!graphAgain.ok) assert.fail(graphAgain.error.message);
  assert.equal(transport.targetedSelections.length, targetedAfterGraph);
  const node = await service.call("hunsu.nodes.get", { repository: repositoryInput, projectId: "project-one", nodeSha: INITIAL_SHA }, auth);
  if (!node.ok) assert.fail(node.error.message);
  const events = await service.call("hunsu.events.list", { repository: repositoryInput, projectId: "project-one", limit: 50 }, auth);
  if (!events.ok) assert.fail(events.error.message);
  const eventId = ((events.data as { events: Array<{ id: string }> }).events[0]?.id);
  assert.ok(eventId);
  const event = await service.call("hunsu.events.get", { repository: repositoryInput, projectId: "project-one", eventId }, auth);
  if (!event.ok) assert.fail(event.error.message);
  const run = await service.call("hunsu.runs.get", { repository: repositoryInput, projectId: "project-one", runId: "run-fast-read" }, auth);
  if (!run.ok) assert.fail(run.error.message);

  assert.equal(transport.stateReplayReads, 0);
  const nodePayloadSelections = transport.targetedSelections.flat().filter(selection => selection.kind === "node_payload");
  assert.equal(nodePayloadSelections.length, 1);
  assert.equal(nodePayloadSelections.every(selection => selection.kind === "node_payload" && selection.nodeSha === INITIAL_SHA), true);
  const selections = transport.targetedSelections.flat();
  assert.equal(selections.filter(selection => selection.kind === "graph_page").length, 1);
  assert.equal(selections.filter(selection => selection.kind === "graph_node").length >= 1, true);
  assert.equal(selections.filter(selection => selection.kind === "node_activity_index").length, 1);
  assert.equal(selections.filter(selection => selection.kind === "node_activity_page").length, 1);
  assert.equal(selections.filter(selection => selection.kind === "run_activity").length, 1);
  assert.equal(selections.filter(selection => selection.kind === "event_index_shard").length, 1);
  assert.equal(selections.filter(selection => selection.kind === "event_locator").length, 1);
  // Event detail validates exactly one authoritative append-only Event; list
  // reads only bounded derived index shards.
  assert.equal(selections.filter(selection => selection.kind === "event").length, 1);

  const authoritativeSelection = selections.find(selection => selection.kind === "event");
  if (!authoritativeSelection || authoritativeSelection.kind !== "event") assert.fail("Authoritative Event selection was not recorded.");
  transport.blockStateReplay = false;
  const stateBeforeTamper = await transport.readBranch(repository, HUNSU_STATE_BRANCH);
  if (!stateBeforeTamper.ok || !stateBeforeTamper.value) assert.fail("State branch is unavailable for the Event integrity test.");
  const authoritativePath = exactStateFilePath(authoritativeSelection);
  const stored = JSON.parse(stateBeforeTamper.value.files[authoritativePath]!) as Record<string, unknown>;
  const tampered = transport.addCommit({
    repository,
    branch: HUNSU_STATE_BRANCH,
    parentSha: stateBeforeTamper.value.headSha,
    files: { [authoritativePath]: `${JSON.stringify({ ...stored, sequence: Number(stored.sequence) + 1 })}\n` },
    message: "Tamper one authoritative Event for read-boundary QA"
  });
  if (!tampered.ok) assert.fail(tampered.error.message);
  transport.blockStateReplay = true;
  service.invalidateAll();
  const rejectedEvent = await service.call("hunsu.events.get", { repository: repositoryInput, projectId: "project-one", eventId }, auth);
  assert.equal(rejectedEvent.ok, false);
  if (!rejectedEvent.ok) assert.equal(rejectedEvent.error.code, "integrity_error");
});

test("Node activity lists fetch only the required physical pages and the inspector loads the newest page", async () => {
  class TrackingTransport extends MemoryGitHubTransport {
    readonly targetedSelections: Array<Parameters<MemoryGitHubTransport["readStateFilesAtHead"]>[2]> = [];

    override async readStateFilesAtHead(
      target: RepositoryLocator,
      stateHeadSha: string,
      selections: Parameters<MemoryGitHubTransport["readStateFilesAtHead"]>[2]
    ) {
      this.targetedSelections.push(selections);
      return super.readStateFilesAtHead(target, stateHeadSha, selections);
    }
  }

  const transport = new TrackingTransport([{ repository, initialSha: INITIAL_SHA }]);
  const service = new HunsuApplicationService({ transport, now: () => new Date("2026-07-15T04:00:00.000Z") });
  let stateHeadSha = (await mutation(service, "hunsu.projects.create", {
    repository: repositoryInput,
    projectId: "project-one",
    title: "Paged activity Project",
    rootNodeSha: INITIAL_SHA,
    initialPlan,
    idempotencyKey: "paged-activity-create",
    expectedStateSha: INITIAL_SHA,
    confirmedByUser: true
  })).stateHeadSha;
  for (let index = 0; index < 55; index += 1) {
    const suffix = String(index).padStart(3, "0");
    stateHeadSha = (await mutation(service, "hunsu.coach.review", {
      repository: repositoryInput,
      projectId: "project-one",
      nodeSha: INITIAL_SHA,
      reviewId: `review-${suffix}`,
      assessment: `Review ${suffix}`,
      findings: [`Finding ${suffix}`],
      recommendation: `Recommendation ${suffix}`,
      idempotencyKey: `review-${suffix}-create`,
      expectedStateSha: stateHeadSha
    })).stateHeadSha;
  }

  const materialized = await transport.readBranch(repository, HUNSU_STATE_BRANCH);
  if (!materialized.ok || !materialized.value) assert.fail("Paged activity state is unavailable.");
  const activityIndexPath = exactStateFilePath({
    kind: "node_activity_index", projectId: "project-one", nodeSha: INITIAL_SHA
  });
  const decodedActivityIndex = decodeNodeActivityIndex(JSON.parse(materialized.value.files[activityIndexPath]!));
  if (!decodedActivityIndex.ok) assert.fail(decodedActivityIndex.error.message);
  assert.deepEqual(decodedActivityIndex.value.categories.reviews, {
    count: 55,
    pageCount: 2,
    pageCommitmentRoot: decodedActivityIndex.value.categories.reviews.pageCommitmentRoot
  });
  assert.equal("pages" in decodedActivityIndex.value.categories.reviews, false);

  service.invalidateAll();
  transport.targetedSelections.length = 0;
  const crossing = await service.call("hunsu.coach.reviews.list", {
    repository: repositoryInput,
    projectId: "project-one",
    nodeSha: INITIAL_SHA,
    limit: 10,
    cursor: `${stateHeadSha}:45`
  }, auth);
  if (!crossing.ok) assert.fail(crossing.error.message);
  assert.deepEqual((crossing.data as { reviews: Array<{ id: string }> }).reviews.map(review => review.id),
    Array.from({ length: 10 }, (_, index) => `review-${String(index + 45).padStart(3, "0")}`));
  const crossingPages = transport.targetedSelections.flat().flatMap(selection =>
    selection.kind === "node_activity_page" ? [selection] : []
  );
  assert.equal(transport.targetedSelections.flat().filter(selection => selection.kind === "node_activity_index").length, 1);
  assert.deepEqual(crossingPages.map(selection => selection.page).sort((left, right) => left - right), [0, 1]);
  assert.equal(crossingPages.every(selection => selection.activityKind === "reviews"), true);

  service.invalidateAll();
  transport.targetedSelections.length = 0;
  const node = await service.call("hunsu.nodes.get", {
    repository: repositoryInput,
    projectId: "project-one",
    nodeSha: INITIAL_SHA
  }, auth);
  if (!node.ok) assert.fail(node.error.message);
  assert.deepEqual((node.data as { coachReviews: Array<{ id: string }> }).coachReviews.map(review => review.id),
    Array.from({ length: 5 }, (_, index) => `review-${String(index + 50).padStart(3, "0")}`));
  const inspectorPages = transport.targetedSelections.flat().flatMap(selection =>
    selection.kind === "node_activity_page" ? [selection] : []
  );
  assert.equal(transport.targetedSelections.flat().filter(selection => selection.kind === "node_activity_index").length, 1);
  assert.deepEqual(inspectorPages.map(selection => [selection.activityKind, selection.page]), [["reviews", 1]]);
});

test("Project bootstrap contexts expose the exact default-branch CAS base and current initialized state head", async () => {
  const transport = new MemoryGitHubTransport([{ repository, initialSha: INITIAL_SHA }]);
  const advanced = transport.addCommit({
    repository,
    branch: repository.defaultBranch,
    parentSha: INITIAL_SHA,
    files: { "README.md": "The default branch advanced before Hunsu initialization.\n" },
    message: "Advance default branch"
  });
  if (!advanced.ok) assert.fail(advanced.error.message);
  assert.notEqual(advanced.value, INITIAL_SHA);
  const service = new HunsuApplicationService({ transport });

  const discovered = await service.call("hunsu.projects.list", {}, auth);
  if (!discovered.ok) assert.fail(discovered.error.message);
  const repositoryState = (discovered.data as {
    repositories: Array<{ state: Record<string, unknown> }>;
  }).repositories[0]?.state;
  assert.deepEqual(repositoryState, {
    status: "uninitialized",
    expectedStateSource: "default_branch_head",
    expectedStateSha: advanced.value
  });
  const session = await service.sessionRepositories(auth);
  if (!session.ok) assert.fail(session.error.message);
  assert.deepEqual((session.value.repositories[0] as { state: unknown }).state, repositoryState);

  const created = await mutation(service, "hunsu.projects.create", {
    repository: repositoryInput,
    projectId: "bootstrap-context",
    title: "Bootstrap Context",
    rootNodeSha: INITIAL_SHA,
    initialPlan,
    idempotencyKey: "bootstrap-context-create",
    expectedStateSha: advanced.value,
    confirmedByUser: true
  });
  const initializedState = {
    status: "initialized",
    expectedStateSource: "state_branch_head",
    stateHeadSha: created.stateHeadSha,
    expectedStateSha: created.stateHeadSha
  };
  const initializedList = await service.call("hunsu.projects.list", {}, auth);
  if (!initializedList.ok) assert.fail(initializedList.error.message);
  assert.deepEqual((initializedList.data as {
    repositories: Array<{ state: unknown }>;
  }).repositories[0]?.state, initializedState);
  const project = await service.call("hunsu.projects.get", {
    repository: repositoryInput,
    projectId: "bootstrap-context"
  }, auth);
  if (!project.ok) assert.fail(project.error.message);
  assert.deepEqual((project.data as { repositoryState: unknown }).repositoryState, initializedState);
  const initializedSession = await service.sessionRepositories(auth);
  if (!initializedSession.ok) assert.fail(initializedSession.error.message);
  assert.deepEqual((initializedSession.value.repositories[0] as { state: unknown }).state, initializedState);
  const mainHead = await transport.readBranchHead(repository, repository.defaultBranch);
  if (!mainHead.ok) assert.fail(mainHead.error.message);
  assert.equal(mainHead.value, advanced.value);
});

test("MCP Project discovery treats v1-only state as v2-uninitialized while exposing its exact state head", async () => {
  const transport = new MemoryGitHubTransport([{ repository, initialSha: INITIAL_SHA }]);
  const legacy = transport.addCommit({
    repository,
    branch: HUNSU_STATE_BRANCH,
    parentSha: INITIAL_SHA,
    files: { ".hunsu/state.hunsu": "legacy bytes must not be decoded" },
    message: "Legacy Hunsu state"
  });
  if (!legacy.ok) assert.fail(legacy.error.message);
  assert.notEqual(legacy.value, INITIAL_SHA);
  const service = new HunsuApplicationService({ transport });
  const result = await service.call("hunsu.projects.list", {}, auth);
  if (!result.ok) assert.fail(result.error.message);
  const data = result.data as {
    projects: unknown[];
    repositories: Array<{ state: Record<string, unknown> }>;
  };
  assert.deepEqual(data.projects, []);
  const expectedState = {
    status: "uninitialized",
    expectedStateSource: "state_branch_head",
    stateHeadSha: legacy.value,
    expectedStateSha: legacy.value
  };
  assert.deepEqual(data.repositories[0]?.state, expectedState);
  const session = await service.sessionRepositories(auth);
  if (!session.ok) assert.fail(session.error.message);
  assert.deepEqual((session.value.repositories[0] as { state: unknown }).state, expectedState);

  const created = await mutation(service, "hunsu.projects.create", {
    repository: repositoryInput,
    projectId: "v2-over-legacy",
    title: "Fresh v2 Project",
    rootNodeSha: INITIAL_SHA,
    initialPlan,
    idempotencyKey: "create-v2-over-legacy",
    expectedStateSha: legacy.value,
    confirmedByUser: true
  });
  assert.notEqual(created.stateHeadSha, legacy.value);
  const stateBranch = await transport.readBranch(repository, HUNSU_STATE_BRANCH);
  if (!stateBranch.ok || !stateBranch.value) assert.fail("Initialized Hunsu state branch is unavailable.");
  assert.equal(stateBranch.value.files[".hunsu/state.hunsu"], "legacy bytes must not be decoded");
  assert.ok(stateBranch.value.files[".hunsu/v2/workspace.json"]);
  const mainHead = await transport.readBranchHead(repository, repository.defaultBranch);
  if (!mainHead.ok) assert.fail(mainHead.error.message);
  assert.equal(mainHead.value, INITIAL_SHA);
});

test("MCP mutation boundaries reject unsupported top-level lifecycle fields", async () => {
  const service = new HunsuApplicationService({
    transport: new MemoryGitHubTransport([{ repository, initialSha: INITIAL_SHA }])
  });
  const mutations = [
    "hunsu.projects.create",
    "hunsu.runs.start",
    "hunsu.runs.complete",
    "hunsu.coach.propose_transition",
    "hunsu.coach.confirm_transition",
    "hunsu.alternatives.compare",
    "hunsu.alternatives.select",
    "hunsu.alternatives.reject"
  ] as const;

  for (const name of mutations) {
    const result = await service.call(name, { unsupportedLifecycleField: true }, auth);
    assert.equal(result.ok, false, name);
    if (result.ok) assert.fail(`${name} accepted an unsupported top-level field.`);
    assert.equal(result.error.code, "invalid_request", name);
    assert.match(result.error.message, /unsupportedLifecycleField/u, name);
  }
});

test("retired v1 tools fail with unsupported_protocol_version", async () => {
  const service = new HunsuApplicationService({ transport: new MemoryGitHubTransport([{ repository, initialSha: INITIAL_SHA }]) });
  const result = await service.invoke("hunsu.goals.create", {}, auth);
  assert.equal(result.ok, false);
  if (result.ok) assert.fail("A retired Goal tool succeeded.");
  assert.equal(result.error.code, "unsupported_protocol_version");
});

async function completeRun(input: {
  service: HunsuApplicationService;
  transport: MemoryGitHubTransport;
  stateHeadSha: string;
  runId: string;
  goalIndex: 0 | 1;
  resultFile: string;
  resultContent: string;
}) {
  const startInput = {
    repository: repositoryInput,
    projectId: "project-one",
    sourceNodeSha: INITIAL_SHA,
    goalDigest: goalDigestAt(input.goalIndex),
    runId: input.runId,
    idempotencyKey: `${input.runId}-start`,
    expectedStateSha: input.stateHeadSha
  };
  const started = await mutation(input.service, "hunsu.runs.start", startInput);
  const contract = started.data as {
    schema: string;
    goal: { key: string };
    runner: { name: string };
    repository: { branch: string };
  };
  assert.equal(contract.schema, "hunsu.run-contract.v2");
  assert.equal(contract.goal.key, initialPlan.nextGoals[input.goalIndex]!.key);
  assert.equal(contract.runner.name, initialPlan.how.name);
  const retriedStart = await mutation(input.service, "hunsu.runs.start", startInput);
  assert.equal(retriedStart.stateHeadSha, started.stateHeadSha);

  const invalidLocalEvidence = await input.service.call("hunsu.runs.attach_evidence", {
    repository: repositoryInput,
    projectId: "project-one",
    runId: input.runId,
    evidence: {
      kind: "report",
      summary: "A mutable local path must not enter durable evidence.",
      target: { type: "run" },
      location: { type: "git", commitSha: INITIAL_SHA, path: "/tmp/hunsu-report.json" }
    },
    idempotencyKey: `${input.runId}-invalid-local-evidence`,
    expectedStateSha: started.stateHeadSha
  }, auth);
  assert.equal(invalidLocalEvidence.ok, false);
  if (invalidLocalEvidence.ok) assert.fail("A mutable local path was accepted as Git evidence.");
  assert.equal(invalidLocalEvidence.error.code, "invalid_request");
  assert.equal((await projectContext(input.service)).stateHeadSha, started.stateHeadSha);

  const committed = input.transport.addCommit({
    repository,
    branch: contract.repository.branch,
    parentSha: INITIAL_SHA,
    files: { [input.resultFile]: input.resultContent }
  });
  if (!committed.ok) assert.fail(committed.error.message);
  const criterion = initialPlan.nextGoals[input.goalIndex]!.acceptanceCriteria[0]!;
  const completeInput = {
    repository: repositoryInput,
    projectId: "project-one",
    runId: input.runId,
    resultSha: committed.value,
    evidence: [{
      kind: "check",
      summary: `${input.runId} passed its production check.`,
      target: { type: "criterion", criterion },
      location: { type: "git", commitSha: committed.value, path: input.resultFile }
    }],
    idempotencyKey: `${input.runId}-complete`,
    expectedStateSha: started.stateHeadSha
  };
  const completed = await mutation(input.service, "hunsu.runs.complete", completeInput);
  assert.equal((completed.data as { resultNodeSha: string }).resultNodeSha, committed.value);
  return { stateHeadSha: completed.stateHeadSha, resultSha: committed.value, completeInput };
}

function goalDigestAt(index: 0 | 1): string {
  return String(computeGoalDigest(decodedInitialPlan.nextGoals[index]!));
}

async function mutation(
  service: HunsuApplicationService,
  name: Parameters<HunsuApplicationService["call"]>[0],
  input: Record<string, unknown>
): Promise<{ data: unknown; stateHeadSha: string }> {
  const result = await service.call(name, input, auth);
  if (!result.ok) assert.fail(`${name}: ${result.error.code}: ${result.error.message}`);
  if (!result.stateHeadSha) assert.fail(`${name} did not return a state head.`);
  return { data: result.data, stateHeadSha: result.stateHeadSha };
}

async function projectContext(service: HunsuApplicationService): Promise<{ stateHeadSha: string }> {
  const result = await service.webProjectContext({ ...auth, client: "web" }, "project-one");
  if (!result.ok) assert.fail(result.error.message);
  return result.value as { stateHeadSha: string };
}

async function refValue(transport: MemoryGitHubTransport, ref: string): Promise<string | undefined> {
  const result = await transport.readRef(repository as RepositoryLocator, ref);
  if (!result.ok) assert.fail(result.error.message);
  return result.value;
}

function mutateReadModelEnvelope(
  content: string,
  kind: "nodeActivityRecord" | "runActivity",
  mutate: (payload: any) => void
): string {
  const envelope = JSON.parse(content) as Record<string, any>;
  const payload = JSON.parse(gunzipSync(Buffer.from(String(envelope.data), "base64")).toString("utf8"));
  mutate(payload);
  const canonical = canonicalJson(payload);
  const decoded = Buffer.from(canonical, "utf8");
  const data = gzipSync(decoded, { level: 9 }).toString("base64");
  return `${JSON.stringify({
    ...envelope,
    decodedSize: decoded.byteLength,
    encodedSize: Buffer.byteLength(data, "utf8"),
    digest: `hunsu-${kind}-read-model-v2:sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`,
    data
  })}\n`;
}
