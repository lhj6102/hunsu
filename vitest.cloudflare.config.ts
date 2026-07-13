import { execFileSync } from "node:child_process";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8"
}).trim();

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: "./wrangler.jsonc"
      },
      miniflare: {
        bindings: {
          HUNSU_GITHUB_APP_ID: "123",
          HUNSU_GITHUB_CLIENT_ID: "test-github-client-id",
          HUNSU_GITHUB_APP_SLUG: "hunsu-test",
          HUNSU_GITHUB_CLIENT_SECRET: "test-github-client-secret",
          HUNSU_GITHUB_PRIVATE_KEY: [
            "-----BEGIN PRIVATE KEY-----",
            "test-private-key-material",
            "-----END PRIVATE KEY-----"
          ].join("\n"),
          HUNSU_GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
          HUNSU_SESSION_SECRET: "test-session-secret-that-is-at-least-thirty-two-bytes",
          TEST_SOURCE_SHA: sourceSha
        }
      }
    })
  ],
  test: {
    include: ["tests/cloudflare/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000
  }
});
