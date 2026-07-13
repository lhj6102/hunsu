import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GitHubAppTokenProvider, GitHubOAuthClient } from "../../apps/api/src/auth/github.ts";
import { GitHubRestTransport } from "../../packages/github-store/src/github-rest.ts";

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

  it("sends the fixed REST User-Agent when creating an installation token", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const provider = new GitHubAppTokenProvider({
      appId: 42,
      privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      apiBaseUrl: "https://github-api.test",
      now: () => Date.UTC(2026, 6, 13)
    });

    await expect(provider.getAuthority(17)).resolves.toEqual({
      token: "github-installation-token",
      permissions: { contents: "write" }
    });
  });

  it("sends the fixed REST User-Agent for installation-scoped repository access", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const provider = new GitHubAppTokenProvider({
      appId: 42,
      privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      apiBaseUrl: "https://github-api.test",
      now: () => Date.UTC(2026, 6, 13)
    });
    const transport = new GitHubRestTransport({
      authorityProvider: provider.getAuthority,
      apiBaseUrl: "https://github-api.test"
    });

    await expect(transport.listInstallationRepositories(17)).resolves.toEqual({
      ok: true,
      value: [{
        installationId: 17,
        repositoryId: 29,
        owner: "acme",
        name: "sample",
        defaultBranch: "main",
        private: true,
        permissions: { contents: "write" }
      }]
    });
  });
});
