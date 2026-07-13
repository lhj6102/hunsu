import { expect, test, type Page } from "@playwright/test";
import { startHeadlessBrowserHarness, type HeadlessBrowserHarness, type HeadlessBrowserMode } from "./headlessBridgeHarness";

const EXPECTED_HEALTH = {
  ok: true,
  service: "hunsu-bridge",
  version: "0.2.0-next.10",
  protocolVersion: "local-bridge-v1",
  deploymentProfile: "production"
};

test.describe.serial("headless Bridge browser contract", () => {
  for (const mode of ["proxy", "direct"] as const satisfies readonly HeadlessBrowserMode[]) {
    test(`${mode} mode pairs through the CLI, authenticates, streams, and opens a disposable Workspace`, async ({ page, request }) => {
      const harness = await startHeadlessBrowserHarness(mode);
      try {
        await page.goto(harness.pairingUrl, { waitUntil: "domcontentloaded" });
        await expect.poll(() => new URL(page.url()).searchParams.has("hunsuBridgeToken")).toBe(false);
        await expect.poll(() => page.evaluate(() =>
          Boolean(window.localStorage.getItem("hunsu.bridgeApiToken"))
        )).toBe(true);
        await expect(page.getByRole("heading", { name: "Active workspaces" })).toBeVisible();

        const apiBase = mode === "direct" ? harness.bridgeUrl : harness.webUrl;
        const health = await browserJsonRequest(page, apiBase, "/health", false);
        expect(health.status).toBe(200);
        expect(health.body).toEqual(EXPECTED_HEALTH);
        expect(new URL(health.responseUrl).origin).toBe(mode === "direct" ? harness.bridgeUrl : harness.webUrl);

        const connection = await browserJsonRequest(page, apiBase, "/api/connection/status", true);
        expect(connection.status).toBe(200);
        expect(connection.body).toMatchObject({
          mode: "local",
          transport: "direct",
          health: "connected",
          auth: "paired",
          version: {
            bridgeVersion: "0.2.0-next.10",
            protocolVersion: "local-bridge-v1"
          }
        });
        expect(JSON.stringify(connection.body)).not.toMatch(/hunsu_(?:bridge|control|pairing|connect)_[A-Za-z0-9_-]+/iu);

        const preflight = await request.fetch(`${harness.bridgeUrl}/api/bridge/status`, {
          method: "OPTIONS",
          headers: {
            origin: harness.webUrl,
            "access-control-request-method": "GET",
            "access-control-request-headers": "authorization",
            "access-control-request-private-network": "true"
          },
          failOnStatusCode: false
        });
        expect(preflight.status()).toBe(204);
        expect(preflight.headers()["access-control-allow-origin"]).toBe(harness.webUrl);
        expect(preflight.headers()["access-control-allow-private-network"]).toBe("true");
        expect(preflight.headers()["access-control-allow-headers"]).toContain("authorization");
        expect(preflight.headers()["access-control-allow-methods"]).toContain("GET");
        expect(preflight.headers().vary).toContain("access-control-request-private-network");

        const rejectedOrigin = await request.fetch(`${harness.bridgeUrl}/api/bridge/status`, {
          method: "OPTIONS",
          headers: {
            origin: "https://untrusted.example",
            "access-control-request-method": "GET",
            "access-control-request-headers": "authorization"
          },
          failOnStatusCode: false
        });
        expect(rejectedOrigin.status()).toBe(403);
        expect(rejectedOrigin.headers()["access-control-allow-origin"]).toBeUndefined();

        const stream = await readSseHandshake(page, apiBase);
        expect(stream.status).toBe(200);
        expect(stream.contentType).toContain("text/event-stream");
        expect(stream.firstChunk).toContain(": connected");
        expect(new URL(stream.responseUrl).origin).toBe(mode === "direct" ? harness.bridgeUrl : harness.webUrl);

        await page.getByText("Advanced", { exact: true }).click();
        await page.getByLabel("Repository path").fill(harness.workspacePath);
        await page.getByRole("button", { name: /^Create Roadmap\b/ }).click();
        await expect(page).toHaveURL(/\/studio\/roadmaps\/[^/?#]+$/u);
        const roadmapUrl = page.url();
        await expect.poll(async () => {
          const registry = await browserJsonRequest(page, apiBase, "/api/roadmaps/recent", true);
          return (registry.body as { roadmaps?: Array<{ displayName?: string }> }).roadmaps?.map(roadmap => roadmap.displayName) ?? [];
        }).toContain(harness.workspaceName);

        await page.goto(`${harness.webUrl}/studio`);
        await expect(page.getByText(harness.workspaceName, { exact: true }).first()).toBeVisible();
        await page.getByRole("button", { name: "Open", exact: true }).click();
        await expect(page).toHaveURL(roadmapUrl);

        const status = await browserJsonRequest(page, apiBase, "/api/bridge/status", true);
        expect(status.status).toBe(200);
        expect(status.body).toMatchObject({
          provider: {
            providerId: "codex",
            label: "Codex",
            ready: true
          }
        });
        expect((status.body as { workspaces?: { active?: Array<{ displayName?: string }> } }).workspaces?.active)
          .toEqual(expect.arrayContaining([expect.objectContaining({ displayName: harness.workspaceName })]));

        await page.goto(`${harness.webUrl}/studio`);
        const connectionButton = page.getByRole("button", { name: /^Local Bridge .*Codex/iu });
        await expect(connectionButton).toBeVisible();
        await connectionButton.click();
        await expect(page.getByRole("heading", { name: "Connection Center" })).toBeVisible();
        await expect(page.getByText("Codex · Ready", { exact: true }).first()).toBeVisible();
        await expect(page.getByText(harness.workspaceName, { exact: true }).first()).toBeVisible();

        await harness.assertNoCredentialLeaks();
        expect(page.url()).not.toContain("hunsuBridgeToken");
      } finally {
        await harness.stop();
      }
    });
  }
});

async function browserJsonRequest(
  page: Page,
  baseUrl: string,
  path: string,
  authenticated: boolean
): Promise<{
  status: number;
  body: unknown;
  responseUrl: string;
}> {
  return page.evaluate(async ({ baseUrl, path, authenticated }) => {
    const headers = new Headers();
    if (authenticated) {
      const token = window.localStorage.getItem("hunsu.bridgeApiToken");
      if (!token) throw new Error("Browser pairing credential is missing.");
      headers.set("authorization", `Bearer ${token}`);
    }
    const response = await fetch(new URL(path, baseUrl), {
      headers,
      cache: "no-store"
    });
    return {
      status: response.status,
      body: await response.json(),
      responseUrl: response.url
    };
  }, { baseUrl, path, authenticated });
}

async function readSseHandshake(page: Page, baseUrl: string): Promise<{
  status: number;
  contentType: string | null;
  firstChunk: string;
  responseUrl: string;
}> {
  return page.evaluate(async baseUrl => {
    const token = window.localStorage.getItem("hunsu.bridgeApiToken");
    if (!token) throw new Error("Browser pairing credential is missing.");
    const controller = new AbortController();
    const response = await fetch(new URL("/api/runs/events", baseUrl), {
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: controller.signal
    });
    const first = await response.body?.getReader().read();
    controller.abort();
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      firstChunk: first?.value ? new TextDecoder().decode(first.value) : "",
      responseUrl: response.url
    };
  }, baseUrl);
}
