// spec: specs/studio-functional-e2e.plan.md
import { basename } from "node:path";
import { expect, test } from "./fixtures";

test.describe("Studio Launcher", () => {
  test("creates a managed Roadmap through Folder Browser", async ({ page, roadmapPath }) => {
    const pageErrors: string[] = [];
    const apiFailures: string[] = [];

    page.on("console", message => {
      if (message.type() === "error") {
        pageErrors.push(message.text());
      }
    });
    page.on("pageerror", error => pageErrors.push(error.message));
    page.on("response", response => {
      const pathname = new URL(response.url()).pathname;
      if (pathname.startsWith("/api/") && response.status() >= 500) {
        apiFailures.push(`${response.status()} ${pathname}`);
      }
    });

    await page.goto("/studio");
    await expect(page.getByRole("heading", { name: "Project Finder" })).toBeVisible();
    await page.getByLabel("Repository path").fill(roadmapPath);
    await expect(page.getByRole("button", { name: /^Create Roadmap\b/ })).toBeVisible();
    await page.getByRole("button", { name: /^Create Roadmap\b/ }).click();
    await expect(page).toHaveURL(/\/studio\/roadmaps\/[^/?#]+/);
    await expect(page.locator("aside").getByText(basename(roadmapPath))).toBeVisible();
    await expect(page.getByRole("button", { name: /Start Execute for Create a runnable Hello World web app/ })).toBeVisible();
    await expect(page.getByText(/EROFS|roadmaps\.json|Unable to create Roadmap/)).toHaveCount(0);
    expect(apiFailures).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
