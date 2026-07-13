import { describe, expect, it } from "vitest";
import { GitHubOAuthClient } from "../../apps/api/src/auth/github.ts";

describe("GitHubOAuthClient in workerd", () => {
  it("uses the Workers global fetch with its valid receiver", async () => {
    const oauth = new GitHubOAuthClient({
      clientId: "github-client-id",
      clientSecret: "github-client-secret",
      publicApiUrl: "https://plugin.hunsu.app",
      webBaseUrl: "https://github-web.test",
      apiBaseUrl: "https://github-api.test"
    });

    const result = await oauth.authenticate("github-code", "v".repeat(43));

    expect(result).toEqual({
      ok: true,
      value: {
        user: { id: "7", login: "octocat" },
        installations: [{
          id: 17,
          accountLogin: "acme",
          accountType: "organization",
          repositories: [{ repositoryId: 29, permissions: { contents: "write" } }]
        }]
      }
    });
  });
});
