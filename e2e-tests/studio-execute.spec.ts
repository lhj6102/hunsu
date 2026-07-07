// spec: specs/studio-functional-e2e.plan.md
import { expect, test } from "./fixtures";

test.describe("Execute Execution", () => {
  test("move-plan-path-arrives", async ({ createManagedRoadmap, page, readRuns, startFirstDestinationExecute, waitForNextArrivedRun }) => {
    // 1. Open Studio and create a managed Roadmap in a unique `/tmp/hunsu-e2e-*` folder.
    await createManagedRoadmap();
    await expect(page.getByRole("button", { name: /Start Execute for Create a runnable Hello World web app/ })).toBeVisible();

    // 2. Start the Execute for the first Destination from the browser UI.
    const baselineRuns = (await readRuns()).length;
    await startFirstDestinationExecute();

    // 3. Wait for the Execute to finish through Plan, Member Path run, and MOVE finalization.
    const arrived = await waitForNextArrivedRun(baselineRuns);
    expect(arrived.status).toBe("arrived");
    await expect(page.getByText(/ARRIVED/i)).toBeVisible();
    await expect(page.getByText("0 left")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Achieved" })).toBeVisible();
  });
});
