import {
  resolveGitHubAppConfig,
  resolveSessionConfig,
  unwrapConfigResult,
  type Env
} from "@hunsu/config";
import { GitHubRestTransport } from "@hunsu/github-store";
import { HunsuApplicationService } from "./application-service.ts";
import type { EphemeralStateStore } from "./auth/ephemeral-store.ts";
import { createGitHubAuth } from "./auth/github.ts";
import { McpOAuthService } from "./auth/oauth-resource.ts";
import { SessionManager } from "./auth/session.ts";
import { HunsuHttpApp } from "./http.ts";
import { GitHubWebhookProcessor } from "./webhook.ts";

export function createHunsuRuntime(env: Env, stateStore: EphemeralStateStore) {
  const githubConfig = unwrapConfigResult(resolveGitHubAppConfig(env));
  const sessionConfig = unwrapConfigResult(resolveSessionConfig(env));
  const githubAuth = createGitHubAuth(githubConfig);
  const transport = new GitHubRestTransport({ authorityProvider: githubAuth.tokenProvider.getAuthority });
  const service = new HunsuApplicationService({ transport });
  const sessions = new SessionManager(sessionConfig);
  const mcpOAuth = new McpOAuthService({
    baseUrl: githubConfig.publicApiUrl,
    secret: sessionConfig.secret,
    stateStore
  });
  const webhooks = new GitHubWebhookProcessor({
    secret: githubConfig.webhookSecret,
    service,
    stateStore
  });
  const app = new HunsuHttpApp({
    service,
    sessions,
    githubOAuth: githubAuth.oauthClient,
    mcpOAuth,
    webhooks,
    publicApiUrl: githubConfig.publicApiUrl,
    webUrl: githubConfig.webUrl,
    githubAppSlug: githubConfig.appSlug
  });
  return { githubConfig, sessionConfig, service, sessions, mcpOAuth, webhooks, app };
}
