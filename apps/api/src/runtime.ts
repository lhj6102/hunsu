import {
  currentProcessEnv,
  resolveApiServerConfig,
  resolveGitHubAppConfig,
  resolveSessionConfig,
  unwrapConfigResult,
  type Env
} from "@hunsu/config";
import { GitHubRestTransport } from "@hunsu/github-store";
import { HunsuApplicationService } from "./application-service.ts";
import { createGitHubAuth } from "./auth/github.ts";
import { McpOAuthService } from "./auth/oauth-resource.ts";
import { SessionManager } from "./auth/session.ts";
import { HunsuHttpApp } from "./http.ts";
import { createHunsuNodeServer } from "./server.ts";
import { GitHubWebhookProcessor } from "./webhook.ts";

export function createProductionRuntime(env: Env = currentProcessEnv()) {
  const apiConfig = unwrapConfigResult(resolveApiServerConfig(env));
  const githubConfig = unwrapConfigResult(resolveGitHubAppConfig(env));
  const sessionConfig = unwrapConfigResult(resolveSessionConfig(env));
  const githubAuth = createGitHubAuth(githubConfig);
  const transport = new GitHubRestTransport({ tokenProvider: githubAuth.tokenProvider.getToken });
  const service = new HunsuApplicationService({ transport });
  const sessions = new SessionManager(sessionConfig);
  const mcpOAuth = new McpOAuthService({ baseUrl: githubConfig.publicApiUrl, secret: sessionConfig.secret });
  const webhooks = new GitHubWebhookProcessor({ secret: githubConfig.webhookSecret, service });
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
  const server = createHunsuNodeServer(app, githubConfig.publicApiUrl);
  return { apiConfig, githubConfig, sessionConfig, service, sessions, mcpOAuth, webhooks, app, server };
}
