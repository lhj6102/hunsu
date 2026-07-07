// spec: specs/studio-functional-e2e.plan.md
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./fixtures";

test.describe("HUNSU Draft Route", () => {
  test("hunsu-draft-streams-agent-session-and-confirms-diff-artifact", async ({ createManagedRoadmap, page }) => {
    // 1. Open Studio and create a managed Roadmap in a unique `/tmp/hunsu-e2e-*` folder.
    const roadmapId = await createManagedRoadmap();
    await page.getByRole("button", { name: /T1 M0000/ }).click({ force: true });

    // 2. Start a HUNSU Draft from the current MOVE.
    await expect(page.getByRole("button", { name: "Chat" })).toHaveCount(0);
    await page.getByRole("button", { name: "Start Hunsu Draft" }).click();
    const detailDialog = page.getByRole("dialog", { name: "Roadmap details" });
    await expect(detailDialog).toBeVisible({ timeout: 2 * 60 * 1000 });
    await expect(detailDialog.getByRole("button", { name: "Details" })).toBeVisible();
    await expect(detailDialog.getByRole("button", { name: "Chat" })).toBeVisible();
    await expect(page.getByPlaceholder("HUNSU request")).toHaveCount(0);
    await detailDialog.getByRole("button", { name: "Chat" }).click();
    await expect(page.getByPlaceholder("HUNSU request")).toBeVisible();
    await expect(page.locator("h2").filter({ hasText: "HUNSU Draft" })).toBeVisible();
    const detailPanel = detailDialog.locator("aside").last();
    const detailPanelBox = await detailPanel.boundingBox();
    expect(detailPanelBox?.width ?? 0).toBeGreaterThan(700);
    expect(detailPanelBox?.width ?? 0).toBeLessThanOrEqual(800);

    // 3. HUNSU Draft chat renders the shared AgentSession item stream.
    await page.getByPlaceholder("HUNSU request").fill("할일 추가: 한국시간 표시");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(detailPanel.getByText("Reasoning").first()).toBeVisible({ timeout: 60 * 1000 });
    await expect(detailPanel.getByText("Inspecting decoded request runtime files.").first()).toBeVisible();
    await expect(detailPanel.getByText("Mapping the request to the editable Hunsu runtime surface.").first()).toBeVisible();
    const commandRow = detailPanel.locator("article").filter({ hasText: "Running command" }).first();
    await expect(commandRow).toBeVisible();
    await commandRow.locator("summary").click();
    await expect(commandRow.getByText("Draft check command completed.").first()).toBeVisible();
    await expect(detailPanel.getByText("File changes").first()).toBeVisible();
    await expect(detailPanel.getByText("Updated decoded Hunsu request files.").first()).toBeVisible();

    // 4. Edit the decoded request surface the Draft route owns.
    const draftsResponse = await page.request.get(`/api/roadmaps/${encodeURIComponent(roadmapId)}/hunsu/drafts`);
    expect(draftsResponse.ok()).toBe(true);
    const draftsBody = await draftsResponse.json() as { drafts: Array<{ draftSessionId: string; worktree?: { path: string } }> };
    const draft = draftsBody.drafts[0];
    expect(draft?.worktree?.path).toBeTruthy();
    writeFileSync(join(draft.worktree!.path, ".hunsu-request/artifact-actions.json"), JSON.stringify({
      schema: "hunsu.artifact-actions.v1",
      order: "display-order",
      actions: [{
        id: "typecheck",
        title: "Typecheck",
        kind: "check",
        sourceScope: "move-or-commit",
        runner: { type: "command", command: "echo typecheck" },
        displayOrder: 0
      }]
    }, null, 2) + "\n", "utf8");

    // 5. Create a DiffArtifact and confirm from the HUNSU Change review card.
    const diffArtifactResponse = await page.request.post(`/api/roadmaps/${encodeURIComponent(roadmapId)}/hunsu/drafts/${encodeURIComponent(draft.draftSessionId)}/diff-artifacts`, {
      data: {}
    });
    expect(diffArtifactResponse.ok()).toBe(true);
    const diffArtifactBody = await diffArtifactResponse.json() as { diffArtifact: { status: string; diffArtifactId: string } };
    expect(diffArtifactBody.diffArtifact.status).toBe("pass");
    await expect(page.getByRole("tab", { name: "Current Changes" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Check" })).toHaveCount(0);
    await page.reload();
    const reloadedDetailDialog = page.getByRole("dialog", { name: "Roadmap details" });
    await expect(reloadedDetailDialog).toBeVisible();
    await reloadedDetailDialog.getByRole("button", { name: "HUNSU Change" }).click();
    const reloadedDetailPanel = reloadedDetailDialog.locator("aside").last();
    await expect(reloadedDetailPanel.getByRole("heading", { name: "HUNSU DiffArtifact" })).toBeVisible({ timeout: 60 * 1000 });
    await expect(reloadedDetailPanel.getByText(".hunsu-request/artifact-actions.json").first()).toBeVisible();
    const diffBlock = reloadedDetailPanel.getByRole("region", { name: "Diff for .hunsu-request/artifact-actions.json" });
    await expect(diffBlock).toBeVisible();
    await expect(diffBlock).toContainText("diff --git a/.hunsu-prev/artifact-actions.json b/.hunsu-request/artifact-actions.json");
    await expect(diffBlock).toContainText('"id": "typecheck"');
    const diffBlockBox = await diffBlock.boundingBox();
    expect(diffBlockBox?.width ?? 0).toBeGreaterThan(600);
    const horizontalOverflow = await diffBlock.evaluate(element => element.scrollWidth > element.clientWidth + 1);
    expect(horizontalOverflow).toBe(false);
    const teamNameInput = reloadedDetailPanel.getByLabel("Team name");
    await expect(teamNameInput).toBeEnabled();
    await teamNameInput.fill("Gen.G");
    const confirmButton = reloadedDetailPanel.getByRole("button", { name: "Confirm Hunsu" });
    await expect(confirmButton).toBeEnabled();
    await confirmButton.click();

    // 6. Studio selects the HUNSU-created node and shows the recorded runtime file change.
    await expect(page.getByText("Runtime Changes")).toBeVisible({ timeout: 60 * 1000 });
    await expect(page.getByText("Changed Files")).toBeVisible();
    await expect(page.getByText(".hunsu-request/artifact-actions.json (updated)").first()).toBeVisible();
  });
});
