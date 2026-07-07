import { defineConfig, devices } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

const baseURL = process.env.HUNSU_E2E_BASE_URL ?? "http://127.0.0.1:19789";
const baseUrl = new URL(baseURL);
const localHost = process.env.HUNSU_LOCAL_HOST ?? "127.0.0.1";
const localPort = parsePort(process.env.HUNSU_LOCAL_PORT, 19788);
const webHost = process.env.HUNSU_WEB_HOST ?? baseUrl.hostname;
const webPort = parsePort(process.env.HUNSU_WEB_PORT ?? baseUrl.port, 19688);
const localUrl = `http://${localHost}:${localPort}`;

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = value ? Number.parseInt(value, 10) : fallback;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envWith(overrides: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return { ...env, ...overrides };
}

export default defineConfig({
  testDir: "./e2e-tests",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 3 * 60 * 1000,
  reporter: [["list"]],
  expect: {
    timeout: 30 * 1000
  },
  webServer: [
    {
      name: "hunsu-local",
      command: "pnpm --filter @hunsu/local dev",
      port: localPort,
      timeout: 120 * 1000,
      reuseExistingServer: !process.env.CI,
      gracefulShutdown: { signal: "SIGINT", timeout: 1_000 },
      env: envWith({
        HUNSU_LOCAL_HOST: localHost,
        HUNSU_LOCAL_PORT: String(localPort),
        HUNSU_LOCAL_TEST_RUNNER: process.env.HUNSU_LOCAL_TEST_RUNNER ?? "deterministic",
        HUNSU_ROADMAP_REGISTRY_PATH: process.env.HUNSU_ROADMAP_REGISTRY_PATH ?? join(tmpdir(), `hunsu-e2e-roadmaps-${localPort}.json`)
      })
    },
    {
      name: "hunsu-web",
      command: "pnpm --filter @hunsu/web dev",
      url: baseURL,
      timeout: 120 * 1000,
      reuseExistingServer: !process.env.CI,
      gracefulShutdown: { signal: "SIGINT", timeout: 1_000 },
      env: envWith({
        HUNSU_LOCAL_HOST: localHost,
        HUNSU_LOCAL_PORT: String(localPort),
        HUNSU_WEB_HOST: webHost,
        HUNSU_WEB_PORT: String(webPort),
        VITE_HUNSU_LOCAL_URL: process.env.VITE_HUNSU_LOCAL_URL ?? localUrl,
        HUNSU_LOCAL_API_PROXY_TARGET: process.env.HUNSU_LOCAL_API_PROXY_TARGET ?? localUrl
      })
    }
  ],
  use: {
    ...devices["Desktop Chrome"],
    actionTimeout: 30 * 1000,
    baseURL,
    trace: "retain-on-failure",
    video: "retain-on-failure"
  }
});
