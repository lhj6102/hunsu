import { expect, test as base } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

type StudioRunSummary = {
  runId: string;
  executeId: string;
  lineId: string;
  status: string;
  finalResponse?: string;
};

type Fixtures = {
  roadmapPath: string;
  createManagedRoadmap: () => Promise<string>;
  startFirstDestinationExecute: () => Promise<void>;
  waitForNextArrivedRun: (baselineRunCount?: number) => Promise<StudioRunSummary>;
  readRuns: () => Promise<StudioRunSummary[]>;
};

export { expect };

export const test = base.extend<Fixtures>({
  roadmapPath: async ({}, use, testInfo) => {
    const safeTitle = testInfo.title.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
    const path = join(tmpdir(), `hunsu-e2e-${Date.now()}-${process.pid}-${safeTitle}`);
    await testInfo.attach("roadmap-path", { body: `${path}\n`, contentType: "text/plain" });
    await use(path);
  },

  createManagedRoadmap: async ({ page, roadmapPath }, use) => {
    await use(async () => {
      await page.goto("/studio");
      await expect(page.getByRole("heading", { name: "Project Finder" })).toBeVisible();
      await page.getByLabel("Repository path").fill(roadmapPath);
      await page.getByRole("button", { name: /^Create Roadmap\b/ }).click();
      await expect(page).toHaveURL(/\/studio\/roadmaps\/[^/?#]+/);
      await expect(page.getByRole("button", { name: /Start Execute for Create a runnable Hello World web app/ })).toBeVisible();
      return currentRoadmapId(page.url());
    });
  },

  startFirstDestinationExecute: async ({ page, readRuns }, use) => {
    await use(async () => {
      const baselineRunCount = (await readRuns()).length;
      await page.getByRole("button", { name: /^Start Execute for Create a runnable Hello World web app$/ }).click();
      await expect.poll(async () => {
        const started = (await readRuns()).slice(baselineRunCount);
        return started.map(run => `${run.executeId}:${run.status}`).join(",");
      }, {
        timeout: 30 * 1000,
        intervals: [500, 1_000, 2_000]
      }).toMatch(/F0001:(running|arrived|accident|failed|stopped)/);
    });
  },

  readRuns: async ({ page }, use) => {
    await use(async () => {
      const roadmapId = currentRoadmapId(page.url());
      const response = await page.request.get(`/api/roadmaps/${encodeURIComponent(roadmapId)}/runs`);
      expect(response.ok()).toBe(true);
      const body = await response.json() as { runs?: StudioRunSummary[] };
      return body.runs ?? [];
    });
  },

  waitForNextArrivedRun: async ({ page, readRuns }, use) => {
    await use(async (baselineRunCount = 0) => {
      let arrivedRun: StudioRunSummary | undefined;
      const startedAt = Date.now();
      const timeoutMs = 2 * 60 * 1000;
      const terminalFailureStatuses = new Set(["accident", "failed", "stopped"]);
      while (Date.now() - startedAt < timeoutMs) {
        const runs = await readRuns();
        const candidates = runs.slice(baselineRunCount);
        const terminalFailure = candidates.find(run => terminalFailureStatuses.has(run.status));
        if (terminalFailure) {
          throw new Error(`Execute ${terminalFailure.executeId} ended as ${terminalFailure.status}: ${terminalFailure.finalResponse ?? terminalFailure.runId}`);
        }
        arrivedRun = candidates.find(run => run.status === "arrived");
        if (arrivedRun) {
          break;
        }
        await page.waitForTimeout(1_000);
      }
      expect(arrivedRun, "expected next Execute run to arrive").toBeDefined();
      if (arrivedRun) {
        expect(arrivedRun.finalResponse ?? `arrived:${arrivedRun.runId}`).toMatch(/Recorded MOVE .* Arrived|arrived:/);
      }

      const runs = await readRuns();
      const arrived = runs.slice(baselineRunCount).find(run => run.status === "arrived");
      expect(arrived).toBeDefined();
      const moveOneNode = page.getByRole("button", { name: /M0001\s*Create a runnable Hello World web app/ });
      await expect(moveOneNode).toBeVisible();
      await moveOneNode.click();
      await expect(page.locator("h2").filter({ hasText: "MOVE 1" })).toBeVisible();
      await expect(page.getByText("0 left")).toBeVisible();
      return arrived!;
    });
  }
});

function currentRoadmapId(url: string): string {
  const pathParts = new URL(url).pathname.split("/").filter(Boolean);
  const roadmapId = pathParts[pathParts.indexOf("roadmaps") + 1];
  if (!roadmapId) {
    throw new Error(`Cannot read Roadmap id from URL: ${url}`);
  }
  return decodeURIComponent(roadmapId);
}
