import { expect, test } from "./fixtures";

test.describe("Hub Marketplace", () => {
  test("shows Executor Marketplace, Hunsu Marketplace, and Skills & Plugins separately", async ({ page }) => {
    await page.route("http://127.0.0.1:8787/api/hub/packages", route => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        packages: [
          packageSummary("team", "team.superloopy.crew", "Superloopy Crew", { memberCount: 6, skillCount: 0, pluginRequirementCount: 0 }),
          packageSummary("member", "member.reviewer", "Reviewer", { skillCount: 1, pluginRequirementCount: 0 }),
          packageSummary("manager", "manager.idea-helper", "Idea Helper", { promptTemplateEngine: "hunsu-template-v1", skillCount: 0, pluginRequirementCount: 0 }),
          packageSummary("skill", "skills.repo-audit", "repo-audit")
        ]
      })
    }));
    await page.route("http://127.0.0.1:8787/api/hub/resources", route => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        resources: [{
          origin: "motorhome",
          resourceKind: "plugin",
          resourceKey: "manager:manager.researcher:github@openai-curated",
          title: "github@openai-curated",
          packageKind: "manager",
          packageKey: "manager.researcher",
          version: "1.0.0"
        }]
      })
    }));

    await page.goto("/hub");
    await expect(page.getByRole("button", { name: "Executor Marketplace" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Hunsu Marketplace" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Skills & Plugins" })).toBeVisible();

    await expect(page.getByText("Superloopy Crew", { exact: true })).toBeVisible();
    await expect(page.getByText("Reviewer", { exact: true })).toBeVisible();
    await expect(page.getByText("Idea Helper", { exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "Hunsu Marketplace" }).click();
    await expect(page.getByText("Idea Helper", { exact: true })).toBeVisible();
    await expect(page.getByText("Superloopy Crew", { exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "Skills & Plugins" }).click();
    await expect(page.getByText("repo-audit", { exact: true })).toBeVisible();
    await expect(page.getByText("manager:manager.researcher:github@openai-curated", { exact: true })).toBeVisible();
    await expect(page.getByText("Plugin Requirement")).toBeVisible();
  });
});

function packageSummary(kind: string, key: string, label: string, extras: Record<string, unknown> = {}) {
  return {
    origin: "motorhome",
    kind,
    key,
    version: "1.0.0",
    integrity: "hunsu-json-c14n-v1+sha256:0000000000000000000000000000000000000000000000000000000000000000",
    label,
    ...extras
  };
}
