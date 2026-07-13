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
        outboundService(request) {
          const url = new URL(request.url);
          if (url.origin === "https://github-web.test" && url.pathname === "/login/oauth/access_token") {
            return Response.json({ access_token: "github-user-token" });
          }
          if (url.href === "https://github-api.test/user") {
            return Response.json({ id: 7, login: "octocat" });
          }
          if (url.href === "https://github-api.test/user/installations?per_page=100&page=1") {
            return Response.json({
              installations: [{ id: 17, account: { login: "acme", type: "Organization" } }]
            });
          }
          if (url.href === "https://github-api.test/user/installations/17/repositories?per_page=100&page=1") {
            return Response.json({
              repositories: [{ id: 29, permissions: { pull: true, push: true, admin: false } }]
            });
          }
          return new Response("Unexpected outbound request.", { status: 599 });
        },
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
