import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const projectId = "production-trial";
const rootSha = "1".repeat(40);
const runSha = "2".repeat(40);
const coachingSha = "3".repeat(40);
const stateHeadSha = "a".repeat(40);
const treeSha = "b".repeat(40);
const goalDigest = `hunsu-goal-v1:sha256:${"c".repeat(64)}`;
const runnerDigest = `hunsu-runner-v1:sha256:${"d".repeat(64)}`;
const typeIntegrity = `hunsu-runner-type-v1:sha256:${"e".repeat(64)}`;
const browserErrors = new WeakMap<Page, Error[]>();
const browserDiagnostics = new WeakMap<Page, string[]>();
const apiRequests = new WeakMap<Page, string[]>();
const graphPageOverrides = new WeakMap<Page, (cursor: string | null) => unknown>();

const repository = {
  owner: "lhj6102",
  name: "hunsu-production-trial",
  url: "https://github.com/lhj6102/hunsu-production-trial",
  defaultBranch: "main"
};

const project = {
  id: projectId,
  title: "Production Trial",
  repository,
  rootNodeSha: rootSha
};

const runner = {
  name: "Release Train",
  typeKey: "release-train",
  schemaVersion: "1.0.0",
  digest: runnerDigest
};

const nodes = [
  { sha: rootSha, title: "Base Node", status: "current", runner, nextGoalCount: 2, integrity: "valid" },
  { sha: runSha, title: "Run result", status: "available", runner, nextGoalCount: 1, integrity: "valid" },
  { sha: coachingSha, title: "Coached plan", status: "available", runner, nextGoalCount: 2, integrity: "valid" }
] as const;

const edges = [
  {
    kind: "run",
    id: "edge-run",
    sourceSha: rootSha,
    targetSha: runSha,
    runId: "run-browser",
    goal: { digest: goalDigest, title: "Verify production evidence" },
    completedAt: "2026-07-14T00:01:00Z"
  },
  {
    kind: "coaching",
    id: "edge-coaching",
    sourceSha: rootSha,
    targetSha: coachingSha,
    proposalId: "proposal-browser",
    summary: "Refine the release policy",
    confirmedAt: "2026-07-14T00:02:00Z"
  }
] as const;

const events = [
  {
    sequence: 2,
    id: "22222222222222222222222222222222",
    type: "RunCompleted",
    summary: "Run completed and its child Node was registered.",
    actor: { id: "actor-browser", label: "Browser QA" },
    occurredAt: "2026-07-14T00:02:00Z",
    reference: { kind: "run", runId: "run-browser", sourceNodeSha: rootSha, target: { kind: "registered", nodeSha: runSha } }
  },
  {
    sequence: 1,
    id: "11111111111111111111111111111111",
    type: "ProjectCreated",
    summary: "Project and root Node were initialized.",
    actor: { id: "actor-browser", label: "Browser QA" },
    occurredAt: "2026-07-14T00:00:00Z",
    reference: { kind: "project" }
  }
] as const;

test.beforeEach(async ({ page }) => {
  const errors: Error[] = [];
  const diagnostics: string[] = [];
  browserErrors.set(page, errors);
  browserDiagnostics.set(page, diagnostics);
  apiRequests.set(page, []);
  graphPageOverrides.delete(page);
  page.on("pageerror", error => errors.push(error));
  page.on("console", message => {
    if (message.type() === "error") diagnostics.push(`console: ${message.text()}`);
  });
  page.on("requestfailed", request => diagnostics.push(`request: ${request.url()} (${request.failure()?.errorText ?? "failed"})`));
  await installMockApi(page);
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page)?.map(error => error.message) ?? []).toEqual([]);
});

test("shows only Node graph and Events and persists the collapsed desktop rail", async ({ page }) => {
  await page.goto(`/projects/${projectId}/graph`);
  await expectAppMounted(page);
  await expect(page.getByRole("main", { name: "Production Trial Node graph" })).toBeVisible();

  const navigation = page.getByRole("navigation", { name: "Project navigation" });
  await expect(navigation.getByRole("button")).toHaveCount(2);
  await expect(navigation.getByRole("button", { name: "Node graph" })).toBeVisible();
  await expect(navigation.getByRole("button", { name: "Events" })).toBeVisible();
  await expect(navigation).not.toContainText(/Goals|Runners|Coach|Runs/u);

  await page.getByRole("button", { name: "Collapse navigation" }).click();
  await expect(page.getByRole("button", { name: "Expand navigation" })).toBeVisible();
  await expect(navigation.getByRole("button")).toHaveCount(2);
  await expect(navigation.getByRole("button", { name: "Node graph" })).toBeVisible();
  await expect(navigation.getByRole("button", { name: "Events" })).toBeVisible();
  await navigation.getByRole("button", { name: "Events" }).hover();
  await expect(page.getByRole("tooltip")).toHaveText("Events");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("hunsu.project-navigation.v2"))).toBe("collapsed");
  await page.reload();
  await expect(page.getByRole("button", { name: "Expand navigation" })).toBeVisible();
});

test("shows exactly the two Project destinations in the mobile navigation Sheet", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/projects/${projectId}/graph`);
  await page.getByRole("button", { name: "Open navigation" }).click();

  const navigation = page.getByRole("navigation", { name: "Mobile Project navigation" });
  await expect(navigation).toBeVisible();
  await expect(navigation.getByRole("button")).toHaveCount(2);
  await expect(navigation.getByRole("button", { name: "Node graph" })).toBeVisible();
  await expect(navigation.getByRole("button", { name: "Events" })).toBeVisible();
  await expect(navigation).not.toContainText(/Goals|Runners|Coach|Runs/u);
});

test("canonicalizes only the Project root and leaves legacy lifecycle routes unavailable", async ({ page }) => {
  await page.goto(`/projects/${projectId}`);
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/graph$`, "u"));

  await page.goto(`/projects/${projectId}/goals/legacy-goal`);
  await expect(page.getByRole("heading", { name: "This Hunsu view does not exist." })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/goals/legacy-goal$`, "u"));
});

test("lays Run children to the right and Coaching children below", async ({ page }) => {
  await page.goto(`/projects/${projectId}/graph`);
  const root = graphNode(page, rootSha);
  const run = graphNode(page, runSha);
  const coaching = graphNode(page, coachingSha);
  await expect(root).toBeVisible();
  await expect(run).toBeVisible();
  await expect(coaching).toBeVisible();
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
  await expect(root).toContainText("Release Train");

  const [rootBox, runBox, coachingBox] = await Promise.all([root.boundingBox(), run.boundingBox(), coaching.boundingBox()]);
  expect(rootBox).not.toBeNull();
  expect(runBox).not.toBeNull();
  expect(coachingBox).not.toBeNull();
  expect(runBox!.x).toBeGreaterThan(rootBox!.x + rootBox!.width / 2);
  expect(coachingBox!.y).toBeGreaterThan(rootBox!.y + rootBox!.height / 2);
});

test("requests at most 300 initial summaries and loads continuation branches without losing page integrity", async ({ page }) => {
  graphPageOverrides.set(page, cursor => {
    if (cursor === null) {
      return {
        schema: "hunsu.web.project-graph.v2",
        project,
        stateHeadSha,
        integrity: { status: "valid" },
        nodes: [nodes[0]],
        edges: [],
        activeRuns: [],
        window: { limit: 1, hasMore: true, continuationCursor: "1" }
      };
    }
    if (cursor === "1") {
      return {
        schema: "hunsu.web.project-graph.v2",
        project,
        stateHeadSha,
        integrity: { status: "valid" },
        nodes: [nodes[1]],
        edges: [edges[0]],
        activeRuns: [],
        window: { limit: 1, hasMore: true, continuationCursor: "2" }
      };
    }
    return {
      schema: "hunsu.web.project-graph.v2",
      project,
      stateHeadSha,
      integrity: { status: "invalid", code: "managed_ref_mismatch", message: "A continuation Node tag does not match its commit." },
      nodes: [nodes[2]],
      edges: [edges[1]],
      activeRuns: [],
      window: { limit: 1, hasMore: false, continuationCursor: null }
    };
  });

  await page.goto(`/projects/${projectId}/graph`);
  await expect(graphNode(page, rootSha)).toBeVisible();
  await expect(page.getByRole("button", { name: "Load more branches" })).toBeVisible();
  await expect.poll(() => apiRequests.get(page)?.find(request => request.startsWith(`/api/projects/${projectId}/graph?`)) ?? "")
    .toContain("limit=300");

  await page.getByRole("button", { name: "Load more branches" }).click();
  await expect(graphNode(page, runSha)).toBeVisible();
  await page.getByRole("button", { name: "Load more branches" }).click();
  await expect(page.getByRole("alert")).toContainText("managed_ref_mismatch");
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
});

for (const invalidGraph of [
  {
    name: "multiple structural parents",
    code: "multiple_parents",
    edges: [edges[0], edges[1], { ...edges[1], id: "edge-second-parent", sourceSha: runSha }]
  },
  {
    name: "a structural cycle",
    code: "cycle",
    edges: [
      { ...edges[0], sourceSha: runSha, targetSha: coachingSha },
      { ...edges[0], id: "edge-cycle", sourceSha: coachingSha, targetSha: runSha }
    ]
  }
] as const) {
  test(`fails closed without rendering Graph or Outline data for ${invalidGraph.name}`, async ({ page }) => {
    graphPageOverrides.set(page, () => ({
      schema: "hunsu.web.project-graph.v2",
      project,
      stateHeadSha,
      integrity: { status: "valid" },
      nodes,
      edges: invalidGraph.edges,
      activeRuns: [],
      window: { limit: 300, hasMore: false, continuationCursor: null }
    }));

    await page.goto(`/projects/${projectId}/graph`);
    await expect(page.getByRole("alert")).toContainText(invalidGraph.code);
    await expect(page.locator(".react-flow__node")).toHaveCount(0);
    await page.getByRole("button", { name: "Show Outline" }).click();
    await expect(page.getByRole("list", { name: "Node lineage outline" })).toHaveCount(0);
    await expect(page.getByRole("alert")).toContainText("Hunsu will not repair or merge this topology in the browser.");
  });
}

test("decodes full Node plans only after selecting one Node", async ({ page }) => {
  await page.goto(`/projects/${projectId}/graph`);
  await expect(graphNode(page, rootSha)).toBeVisible();
  expect((apiRequests.get(page) ?? []).filter(request => request.includes("/nodes/"))).toEqual([]);

  await page.getByRole("button", { name: "Show Outline" }).click();
  const outline = page.getByRole("list", { name: "Node lineage outline" });
  await outline.getByRole("button").first().click();
  await expect(page.getByRole("complementary", { name: "Selected Node" })).toContainText("release-train");
  await page.getByRole("button", { name: "Close Node details" }).click();
  await outline.getByRole("button").nth(1).click();
  await expect(page.getByRole("complementary", { name: "Selected Node" })).toBeVisible();

  await expect.poll(() => new Set((apiRequests.get(page) ?? [])
    .filter(request => request.includes("/nodes/"))
    .map(request => request.slice(request.lastIndexOf("/") + 1))).size).toBe(2);
  const decodedNodeShas = new Set((apiRequests.get(page) ?? [])
    .filter(request => request.includes("/nodes/"))
    .map(request => request.slice(request.lastIndexOf("/") + 1)));
  expect(decodedNodeShas).toEqual(new Set([rootSha, coachingSha]));
});

test("supports keyboard Outline inspection and restores focus after the mobile Sheet closes", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/projects/${projectId}/graph`);
  await page.getByRole("button", { name: "Show Outline" }).click();
  const rootButton = page.getByRole("list", { name: "Node lineage outline" }).getByRole("button").first();
  await rootButton.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Node details" })).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("dialog", { name: "Node details" })).toBeHidden();
  await expect(rootButton).toBeFocused();
});

test("renders Events as immutable semantic history with graph deep links", async ({ page }) => {
  await page.goto(`/projects/${projectId}/events`);
  const history = page.getByRole("list", { name: "Append-only Hunsu Events" });
  await expect(history).toBeVisible();
  await expect(history.getByRole("listitem")).toHaveCount(2);
  await expect(history).toContainText("Run Completed");
  await expect(history).toContainText(`event ${events[0].id}`);
  await expect(history).toContainText("run run-browser");
  await expect(page.getByRole("button", { name: /Run Completed/u })).toBeVisible();
  await expect(page.getByRole("button", { name: /edit|delete|rollback/iu })).toHaveCount(0);

  await page.getByRole("button", { name: /Run Completed/u }).click();
  await expect(page.getByRole("complementary", { name: "Event details" })).toBeVisible();
  await page.getByRole("button", { name: "View in graph" }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/graph/nodes/${runSha}$`, "u"));
});

test("sends typed Event filters and restores Event-row focus after the mobile detail Sheet closes", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/projects/${projectId}/events`);

  await page.getByLabel("Type").selectOption("RunCompleted");
  await page.getByLabel("Node SHA").fill(runSha);
  await page.getByLabel("Actor").fill("actor-browser");
  await page.getByText("Date range", { exact: true }).click();
  await page.getByLabel("From").fill("2026-07-14");
  await page.getByLabel("To", { exact: true }).fill("2026-07-15");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect.poll(() => (apiRequests.get(page) ?? []).findLast(request => request.startsWith(`/api/projects/${projectId}/events?`)) ?? "")
    .toContain(`type=RunCompleted`);
  const filteredRequest = (apiRequests.get(page) ?? []).findLast(request => request.startsWith(`/api/projects/${projectId}/events?`)) ?? "";
  expect(filteredRequest).toContain(`nodeSha=${runSha}`);
  expect(filteredRequest).toContain("actor=actor-browser");
  expect(filteredRequest).toContain("from=2026-07-14T00%3A00%3A00.000Z");
  expect(filteredRequest).toContain("to=2026-07-15T23%3A59%3A59.999Z");

  const eventButton = page.getByRole("button", { name: /Run Completed/u });
  await eventButton.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Event details" })).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await expect(eventButton).toBeFocused();
});

test("has no serious accessibility violations and honors reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/projects/${projectId}/graph`);
  await expect(graphNode(page, rootSha)).toBeVisible();

  const transitionDuration = await page.getByRole("button", { name: "Collapse navigation" }).evaluate(element => getComputedStyle(element).transitionDuration);
  expect(Number.parseFloat(transitionDuration)).toBeLessThanOrEqual(0.001);

  await page.getByRole("button", { name: "Show Outline" }).click();
  await page.getByRole("list", { name: "Node lineage outline" }).getByRole("button").first().click();
  const inspector = page.getByRole("complementary", { name: "Selected Node" });
  await expect(inspector).toContainText("Coaching proposals");
  await expect(inspector).toContainText("Coach reviews");
  await expect(inspector).toContainText("Coached How experiment");

  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter(violation => violation.impact === "serious" || violation.impact === "critical");
  expect(serious, serious.map(item => `${item.id}: ${item.help}`).join("\n")).toEqual([]);
});

function graphNode(page: Page, sha: string) {
  return page.locator(".react-flow__node").filter({ hasText: sha.slice(0, 8) });
}

async function expectAppMounted(page: Page): Promise<void> {
  await page.waitForTimeout(250);
  const root = page.locator("#root");
  const html = await root.innerHTML();
  if (!html.trim()) {
    const diagnostics = browserDiagnostics.get(page) ?? [];
    throw new Error(`Hunsu Web did not mount. ${diagnostics.join(" | ") || "No browser diagnostic was emitted."}`);
  }
}

async function installMockApi(page: Page): Promise<void> {
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith("/api/")) return route.continue();
    apiRequests.get(page)?.push(`${url.pathname}${url.search}`);
    if (url.pathname === "/api/session") {
      return json(route, {
        authenticated: true,
        user: { id: "browser-user", login: "browser-qa", name: "Browser QA" },
        workspace: { id: "browser-workspace", accountLogin: "lhj6102", accountType: "user" },
        github: { connected: true, installationId: 1, connectUrl: "/api/auth/github" }
      });
    }
    if (url.pathname === "/api/projects") {
      return json(route, {
        schema: "hunsu.web.project-list.v2",
        projects: [{
          ...project,
          nodeCount: nodes.length,
          activeRunCount: 0,
          unresolvedDivergenceCount: 0,
          integrity: { status: "valid" },
          synchronizedAt: "2026-07-14T00:03:00Z"
        }]
      });
    }
    if (url.pathname === `/api/projects/${projectId}/graph`) {
      const override = graphPageOverrides.get(page);
      if (override) return json(route, override(url.searchParams.get("cursor")));
      return json(route, {
        schema: "hunsu.web.project-graph.v2",
        project,
        stateHeadSha,
        integrity: { status: "valid" },
        nodes,
        edges,
        activeRuns: [],
        window: { limit: 300, hasMore: false, continuationCursor: null }
      });
    }
    if (url.pathname.startsWith(`/api/projects/${projectId}/nodes/`)) {
      const sha = decodeURIComponent(url.pathname.slice(url.pathname.lastIndexOf("/") + 1));
      return json(route, nodeDetail(sha));
    }
    if (url.pathname === `/api/projects/${projectId}/events`) {
      return json(route, {
        schema: "hunsu.web.events.v2",
        project,
        stateHeadSha,
        events,
        nextCursor: null
      });
    }
    if (url.pathname.startsWith(`/api/projects/${projectId}/events/`)) {
      const eventId = decodeURIComponent(url.pathname.slice(url.pathname.lastIndexOf("/") + 1));
      const event = events.find(item => item.id === eventId);
      if (event) return json(route, { schema: "hunsu.web.event-detail.v2", project, stateHeadSha, event });
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "not_found", message: url.pathname } }) });
  });
}

function nodeDetail(sha: string) {
  const summary = nodes.find(node => node.sha === sha) ?? nodes[0];
  const parent = edges.find(edge => edge.targetSha === summary.sha);
  const lineage = parent?.kind === "run"
    ? { kind: "run_child", parentSha: parent.sourceSha, runId: parent.runId, goalDigest: parent.goal.digest }
    : parent?.kind === "coaching"
      ? { kind: "coaching_child", parentSha: parent.sourceSha, proposalId: parent.proposalId }
      : { kind: "root" };
  return {
    schema: "hunsu.web.node-detail.v2",
    stateHeadSha,
    node: {
      sha: summary.sha,
      payloadDigest: `hunsu-node-payload-v1:sha256:${"a".repeat(64)}`,
      planDigest: `hunsu-node-plan-v1:sha256:${"b".repeat(64)}`,
      title: summary.title,
      commitUrl: `https://github.com/${repository.owner}/${repository.name}/commit/${summary.sha}`,
      treeSha,
      managedRef: `refs/tags/hunsu/node/${projectId}/${summary.sha}`,
      integrity: { status: "valid" },
      status: summary.status,
      lineage,
      plan: {
        schema: "hunsu.node-plan.v1",
        nextGoals: [{
          digest: goalDigest,
          key: "verify-production",
          title: "Verify production evidence",
          desiredOutcome: "The production lifecycle is evidenced.",
          acceptanceCriteria: ["Evidence is immutable."],
          constraints: ["Do not mutate main."],
          priority: 0
        }],
        how: {
          schema: "hunsu.runner-value.v1",
          ...runner,
          type: { origin: "hunsu.bundled", key: runner.typeKey, schemaVersion: runner.schemaVersion, integrity: typeIntegrity },
          value: { sequence: ["check", "build", "smoke"] }
        }
      },
      outgoingEdges: edges.filter(edge => edge.sourceSha === summary.sha),
      activeRuns: [],
      evidence: [],
      comparisons: summary.sha === rootSha ? [{
        type: "coached_how_experiment",
        id: "comparison-browser",
        anchorNodeSha: rootSha,
        goalDigest,
        nodeShas: [runSha, coachingSha],
        summary: "Compare the same Goal under two verified How values.",
        disposition: { type: "undecided" },
        recordedAt: "2026-07-14T00:04:00Z"
      }] : [],
      decisions: [],
      coachingProposals: summary.sha === rootSha ? [{
        id: "proposal-browser",
        sourceNodeSha: rootSha,
        sourcePayloadDigest: `hunsu-node-payload-v1:sha256:${"a".repeat(64)}`,
        sourcePlanDigest: `hunsu-node-plan-v1:sha256:${"b".repeat(64)}`,
        proposedPlanDigest: `hunsu-node-plan-v1:sha256:${"f".repeat(64)}`,
        expectedStateSha: stateHeadSha,
        summary: "Use the Team How for the same Goal.",
        rationale: "Measure the Runner change without changing the Goal.",
        proposedAt: "2026-07-14T00:03:00Z",
        disposition: {
          type: "confirmed",
          decisionId: "decision-browser",
          childNodeSha: coachingSha,
          reason: "Approved for production QA.",
          decidedAt: "2026-07-14T00:03:30Z"
        }
      }] : [],
      coachReviews: summary.sha === rootSha ? [{
        id: "review-browser",
        target: { type: "comparison", comparisonId: "comparison-browser" },
        assessment: "The comparison is ready for an explicit decision.",
        recommendations: [],
        recordedAt: "2026-07-14T00:04:30Z"
      }] : []
    }
  };
}

function json(route: Route, body: unknown) {
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}
