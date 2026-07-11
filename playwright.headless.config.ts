import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e-tests",
  testMatch: "headless-bridge-contract.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [["list"]],
  expect: {
    timeout: 15_000
  },
  use: {
    ...devices["Desktop Chrome"],
    actionTimeout: 15_000,
    navigationTimeout: 20_000,
    trace: "off",
    video: "off",
    screenshot: "only-on-failure"
  }
});
