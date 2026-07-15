import { defineConfig, devices } from "@playwright/test";

const port = 19_689;

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? [["line"]] : [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ],
  webServer: {
    command: `pnpm --filter @hunsu/web dev --host 127.0.0.1 --port ${port}`,
    url: `http://127.0.0.1:${port}/projects`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  }
});
