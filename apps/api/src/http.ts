import { handleMcpRequest } from "@hunsu/plugin-contract";
import { createHash, randomUUID } from "node:crypto";
import type { HunsuApplicationService } from "./application-service.ts";
import type { GitHubOAuthClient, GitHubOAuthFailure, GitHubOAuthProviderCode } from "./auth/github.ts";
import { McpOAuthService, OAuthProtocolError } from "./auth/oauth-resource.ts";
import type { SessionManager } from "./auth/session.ts";
import type { ApiError, ApiResult, AuthContext } from "./types.ts";
import type { GitHubWebhookProcessor } from "./webhook.ts";

type JsonRecord = Record<string, unknown>;

const MAX_JSON_BYTES = 1_048_576;
const MAX_WEBHOOK_BYTES = 2_097_152;
const OAUTH_STATE_COOKIE = "hunsu_oauth_state";
const OAUTH_PKCE_COOKIE = "hunsu_oauth_pkce";

export type HunsuHttpAppOptions = {
  service: HunsuApplicationService;
  sessions: SessionManager;
  githubOAuth: GitHubOAuthClient;
  mcpOAuth: McpOAuthService;
  webhooks: GitHubWebhookProcessor;
  publicApiUrl: string;
  webUrl: string;
  githubAppSlug: string;
};

export class HunsuHttpApp {
  readonly #service: HunsuApplicationService;
  readonly #sessions: SessionManager;
  readonly #githubOAuth: GitHubOAuthClient;
  readonly #mcpOAuth: McpOAuthService;
  readonly #webhooks: GitHubWebhookProcessor;
  readonly #publicApiUrl: string;
  readonly #apiOrigin: string;
  readonly #webUrl: string;
  readonly #webOrigin: string;
  readonly #githubAppSlug: string;

  constructor(options: HunsuHttpAppOptions) {
    this.#service = options.service;
    this.#sessions = options.sessions;
    this.#githubOAuth = options.githubOAuth;
    this.#mcpOAuth = options.mcpOAuth;
    this.#webhooks = options.webhooks;
    this.#publicApiUrl = options.publicApiUrl.replace(/\/$/u, "");
    this.#apiOrigin = new URL(options.publicApiUrl).origin;
    this.#webUrl = options.webUrl.replace(/\/$/u, "");
    this.#webOrigin = new URL(options.webUrl).origin;
    this.#githubAppSlug = options.githubAppSlug;
  }

  handle = async (request: Request): Promise<Response> => {
    try {
      const response = await this.#route(request);
      return this.#withBrowserHeaders(request, response);
    } catch (error) {
      if (error instanceof HttpInputError) return this.#withBrowserHeaders(request, problem(error.error));
      if (error instanceof OAuthProtocolError) return oauthProblem(error);
      return this.#withBrowserHeaders(request, problem({ code: "temporarily_unavailable", message: "The Hunsu API could not complete the request.", status: 500, retryable: true }));
    }
  };

  async #route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return this.#preflight(request);

    if (request.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource") {
      return json(this.#mcpOAuth.protectedResourceMetadata());
    }
    if (request.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
      return json(this.#mcpOAuth.authorizationServerMetadata());
    }
    if (request.method === "POST" && url.pathname === "/oauth/register") {
      return json(this.#mcpOAuth.register(await readJson(request, 65_536)), 201, { "cache-control": "no-store" });
    }
    if (request.method === "GET" && url.pathname === "/oauth/authorize") {
      const context = this.#sessions.authenticate(request);
      if (!context) return this.#beginGitHubAuth(`/oauth/authorize${url.search}`, true);
      if (context.installations.length === 0) return problem({ code: "forbidden", message: "Install the Hunsu GitHub App before authorizing the plugin.", status: 403, retryable: false });
      const consent = await this.#mcpOAuth.createConsentRequest(url, context, this.#webSessionToken(request));
      return oauthConsentPage(consent);
    }
    if (request.method === "POST" && url.pathname === "/oauth/authorize") {
      const context = this.#sessions.authenticate(request);
      if (!context) return problem({ code: "unauthenticated", message: "The Web session for this consent request is missing or expired.", status: 401, retryable: false });
      if (context.installations.length === 0) return problem({ code: "forbidden", message: "Install the Hunsu GitHub App before authorizing the plugin.", status: 403, retryable: false });
      this.#requireOAuthConsentMutation(request);
      const form = await readForm(request, 65_536);
      return redirect(await this.#mcpOAuth.decideConsent(form, context, this.#webSessionToken(request)));
    }
    if (request.method === "POST" && url.pathname === "/oauth/token") {
      const form = await readForm(request, 65_536);
      return json(await this.#mcpOAuth.exchange(form), 200, { "cache-control": "no-store" });
    }

    if (request.method === "GET" && url.pathname === "/api/auth/github") {
      const returnTo = safeReturnTo(url.searchParams.get("return_to"));
      return this.#beginGitHubAuth(returnTo, returnTo.startsWith("/oauth/authorize"));
    }
    if (request.method === "GET" && url.pathname === "/api/auth/github/callback") return this.#finishGitHubAuth(request, url);
    if (request.method === "POST" && url.pathname === "/api/logout") {
      this.#requireWebMutation(request);
      return json({ signedOut: true }, 200, { "set-cookie": this.#sessions.clearCookie() });
    }

    if (request.method === "POST" && url.pathname === "/api/github/webhooks") {
      const body = await readRaw(request, MAX_WEBHOOK_BYTES, "application/json");
      return resultResponse(await this.#webhooks.process(request.headers, body), 202);
    }

    if (url.pathname === "/mcp") {
      if (request.method !== "POST") return methodNotAllowed(["POST"]);
      const context = this.#mcpOAuth.authenticate(request);
      if (!context) {
        return problem(
          { code: "unauthenticated", message: "A valid OAuth bearer token is required.", status: 401, retryable: true },
          { "www-authenticate": `Bearer resource_metadata="${this.#publicApiUrl}/.well-known/oauth-protected-resource"` }
        );
      }
      const input = await readJson(request, MAX_JSON_BYTES);
      const response = await handleMcpRequest(input, this.#service, context);
      return response === undefined ? new Response(null, { status: 202 }) : json(response);
    }

    if (request.method === "GET" && url.pathname === "/api/session") return this.#session(request);
    const context = this.#sessions.authenticate(request);
    if (!context) return problem({ code: "unauthenticated", message: "Sign in with GitHub to continue.", status: 401, retryable: true });

    if (request.method === "GET" && url.pathname === "/api/repositories") return resultResponse(await this.#service.sessionRepositories(context));
    if (request.method === "GET" && url.pathname === "/api/projects") return resultResponse(await this.#service.webProjects(context));
    if (request.method === "POST" && url.pathname === "/api/projects") {
      this.#requireWebMutation(request);
      return resultResponse(await this.#service.webCreateProject(context, await mutationBody(request)), 201);
    }

    const project = matchPath(url.pathname, /^\/api\/projects\/([^/]+)$/u, ["projectId"]);
    if (project && request.method === "GET") return resultResponse(await this.#service.webProject(context, project.projectId));

    const rebuild = matchPath(url.pathname, /^\/api\/projects\/([^/]+)\/rebuild$/u, ["projectId"]);
    if (rebuild && request.method === "POST") {
      this.#requireWebMutation(request);
      await mutationBody(request);
      return resultResponse(await this.#service.webRebuildProject(context, rebuild.projectId));
    }

    const goals = matchPath(url.pathname, /^\/api\/projects\/([^/]+)\/goals$/u, ["projectId"]);
    if (goals && request.method === "POST") {
      this.#requireWebMutation(request);
      return resultResponse(await this.#service.webCreateGoal(context, goals.projectId, await mutationBody(request)), 201);
    }
    const goal = matchPath(url.pathname, /^\/api\/projects\/([^/]+)\/goals\/([^/]+)$/u, ["projectId", "goalId"]);
    if (goal && request.method === "GET") return resultResponse(await this.#service.webGoal(context, goal.projectId, goal.goalId));
    if (goal && request.method === "PATCH") {
      this.#requireWebMutation(request);
      return resultResponse(await this.#service.webUpdateGoal(context, goal.projectId, goal.goalId, await mutationBody(request)));
    }
    const hunsu = matchPath(url.pathname, /^\/api\/projects\/([^/]+)\/goals\/([^/]+)\/hunsu$/u, ["projectId", "goalId"]);
    if (hunsu && request.method === "POST") {
      this.#requireWebMutation(request);
      return resultResponse(await this.#service.webConfirmHunsu(context, hunsu.projectId, hunsu.goalId, await mutationBody(request)));
    }
    const alternative = matchPath(
      url.pathname,
      /^\/api\/projects\/([^/]+)\/goals\/([^/]+)\/alternatives\/([^/]+)\/(select|reject)$/u,
      ["projectId", "goalId", "runId", "kind"]
    );
    if (alternative && request.method === "POST") {
      this.#requireWebMutation(request);
      return resultResponse(await this.#service.webDecideAlternative(
        context,
        alternative.projectId,
        alternative.goalId,
        alternative.runId,
        alternative.kind as "select" | "reject",
        await mutationBody(request)
      ));
    }

    const runners = matchPath(url.pathname, /^\/api\/projects\/([^/]+)\/runners$/u, ["projectId"]);
    if (runners && request.method === "GET") return resultResponse(await this.#service.webRunners(context, runners.projectId));
    const run = matchPath(url.pathname, /^\/api\/projects\/([^/]+)\/runs\/([^/]+)$/u, ["projectId", "runId"]);
    if (run && request.method === "GET") return resultResponse(await this.#service.webRun(context, run.projectId, run.runId));
    const coach = matchPath(url.pathname, /^\/api\/projects\/([^/]+)\/coach$/u, ["projectId"]);
    if (coach && request.method === "GET") return resultResponse(await this.#service.webCoach(context, coach.projectId));
    const coachReview = matchPath(url.pathname, /^\/api\/projects\/([^/]+)\/coach\/review$/u, ["projectId"]);
    if (coachReview && request.method === "POST") {
      this.#requireWebMutation(request);
      return resultResponse(await this.#service.webCoachReview(context, coachReview.projectId, await mutationBody(request)));
    }
    const proposal = matchPath(
      url.pathname,
      /^\/api\/projects\/([^/]+)\/coach\/proposals\/([^/]+)\/(confirm|reject)$/u,
      ["projectId", "proposalId", "kind"]
    );
    if (proposal && request.method === "POST") {
      this.#requireWebMutation(request);
      const body = await mutationBody(request);
      return resultResponse(proposal.kind === "confirm"
        ? await this.#service.webConfirmCoachProposal(context, proposal.projectId, proposal.proposalId, body)
        : await this.#service.webRejectCoachProposal(context, proposal.projectId, proposal.proposalId, body));
    }

    return problem({ code: "not_found", message: "API route not found.", status: 404, retryable: false });
  }

  #session(request: Request): Response {
    const context = this.#sessions.authenticate(request);
    if (!context) {
      return json({ authenticated: false, github: { connected: false, connectUrl: "/api/auth/github" } });
    }
    const selected = context.installations.find(item => item.id === context.selectedInstallationId) ?? context.installations[0];
    return json({
      authenticated: true,
      user: context.user,
      ...(selected ? { workspace: { id: `workspace-${selected.id}`, accountLogin: selected.accountLogin, accountType: selected.accountType } } : {}),
      github: selected
        ? { connected: true, installationId: selected.id, connectUrl: `https://github.com/apps/${this.#githubAppSlug}/installations/new` }
        : { connected: false, connectUrl: `https://github.com/apps/${this.#githubAppSlug}/installations/new` }
    });
  }

  #beginGitHubAuth(returnTo: string, mcp: boolean): Response {
    const nonce = this.#sessions.tokens.nonce();
    const codeVerifier = this.#sessions.tokens.nonce(32);
    const codeChallenge = createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
    const now = Math.floor(Date.now() / 1000);
    const state = this.#sessions.tokens.issue({ purpose: "github-oauth-state", nonce, returnTo, mcp, iat: now, exp: now + 600 });
    const headers = new Headers({ "cache-control": "no-store" });
    headers.append("set-cookie", this.#sessions.transientCookie(OAUTH_STATE_COOKIE, nonce, 600));
    headers.append("set-cookie", this.#sessions.transientCookie(OAUTH_PKCE_COOKIE, codeVerifier, 600));
    return redirect(this.#githubOAuth.authorizationUrl(state, codeChallenge), headers);
  }

  async #finishGitHubAuth(request: Request, url: URL): Promise<Response> {
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code") ?? "";
    const claims = this.#sessions.tokens.verify(state, "github-oauth-state");
    const cookieNonce = this.#sessions.readCookie(request, OAUTH_STATE_COOKIE);
    const codeVerifier = this.#sessions.readCookie(request, OAUTH_PKCE_COOKIE);
    if (!claims || typeof claims.nonce !== "string" || claims.nonce !== cookieNonce || typeof claims.returnTo !== "string" || !code || !codeVerifier) {
      return problem(
        { code: "invalid_request", message: "GitHub OAuth state is invalid or expired.", status: 400, retryable: false },
        { "referrer-policy": "no-referrer" }
      );
    }
    try {
      const identityResult = await this.#githubOAuth.authenticate(code, codeVerifier);
      if (!identityResult.ok) {
        const failure = identityResult.error;
        return this.#githubOAuthFailure(failure.stage, failure.reason, failure.upstreamStatus, failure.providerCode);
      }
      const identity = identityResult.value;
      let session: ReturnType<SessionManager["issue"]>;
      try {
        session = this.#sessions.issue({
          user: identity.user,
          installations: identity.installations,
          ...(identity.installations[0] ? { selectedInstallationId: identity.installations[0].id } : {})
        });
      } catch {
        return this.#githubOAuthFailure("session_issue", "local_failure", null, null);
      }
      const target = claims.returnTo.startsWith("/oauth/authorize")
        ? `${this.#publicApiUrl}${claims.returnTo}`
        : `${this.#webUrl}${safeReturnTo(claims.returnTo)}`;
      const headers = new Headers({ location: target, "cache-control": "no-store", "referrer-policy": "no-referrer" });
      headers.append("set-cookie", session.cookie);
      headers.append("set-cookie", this.#sessions.transientCookie(OAUTH_STATE_COOKIE, "", 0));
      headers.append("set-cookie", this.#sessions.transientCookie(OAUTH_PKCE_COOKIE, "", 0));
      return new Response(null, { status: 302, headers });
    } catch {
      return this.#githubOAuthFailure("callback_internal", "local_failure", null, null);
    }
  }

  #githubOAuthFailure(
    stage: GitHubOAuthFailure["stage"] | "session_issue" | "callback_internal",
    reason: GitHubOAuthFailure["reason"] | "local_failure",
    upstreamStatus: number | null,
    providerCode: GitHubOAuthProviderCode | null
  ): Response {
    const retryable = githubOAuthRetryable({ stage, reason, upstreamStatus, providerCode });
    const response = json({
      error: {
        code: "temporarily_unavailable",
        message: "GitHub sign-in could not be completed.",
        retryable,
        diagnostic: {
          schema: "hunsu.github-oauth-diagnostic.v1",
          id: randomUUID(),
          stage,
          reason,
          upstreamStatus,
          providerCode
        }
      }
    }, 503, { "cache-control": "no-store", "referrer-policy": "no-referrer" });
    response.headers.append("set-cookie", this.#sessions.transientCookie(OAUTH_STATE_COOKIE, "", 0));
    response.headers.append("set-cookie", this.#sessions.transientCookie(OAUTH_PKCE_COOKIE, "", 0));
    return response;
  }

  #requireWebMutation(request: Request): void {
    const origin = request.headers.get("origin");
    if (origin !== this.#webOrigin) throw new HttpInputError({ code: "forbidden", message: "The request origin is not authorized.", status: 403, retryable: false });
  }

  #requireOAuthConsentMutation(request: Request): void {
    const origin = request.headers.get("origin");
    const fetchSite = request.headers.get("sec-fetch-site");
    if (origin !== this.#apiOrigin || (fetchSite !== null && fetchSite !== "same-origin")) {
      throw new OAuthProtocolError("invalid_request", "The consent form origin is not authorized.", 403);
    }
  }

  #webSessionToken(request: Request): string {
    const token = this.#sessions.readCookie(request, this.#sessions.config.cookieName);
    if (!token) throw new OAuthProtocolError("invalid_request", "The Web session is missing or expired.", 401);
    return token;
  }

  #preflight(request: Request): Response {
    if (request.headers.get("origin") !== this.#webOrigin) return problem({ code: "forbidden", message: "The request origin is not authorized.", status: 403, retryable: false });
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": this.#webOrigin,
        "access-control-allow-credentials": "true",
        "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
        "access-control-allow-headers": "content-type, idempotency-key",
        vary: "Origin"
      }
    });
  }

  #withBrowserHeaders(request: Request, response: Response): Response {
    if (request.headers.get("origin") !== this.#webOrigin) return response;
    const headers = new Headers(response.headers);
    headers.set("access-control-allow-origin", this.#webOrigin);
    headers.set("access-control-allow-credentials", "true");
    headers.append("vary", "Origin");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
}

type GitHubOAuthCallbackFailure = {
  stage: GitHubOAuthFailure["stage"] | "session_issue" | "callback_internal";
  reason: GitHubOAuthFailure["reason"] | "local_failure";
  upstreamStatus: number | null;
  providerCode: GitHubOAuthProviderCode | null;
};

function githubOAuthRetryable(failure: GitHubOAuthCallbackFailure): boolean {
  if (failure.providerCode !== null) return false;
  switch (failure.reason) {
    case "transport":
      return true;
    case "upstream_response":
      return failure.upstreamStatus === 429 || (failure.upstreamStatus !== null && failure.upstreamStatus >= 500);
    case "invalid_payload":
    case "local_failure":
      return false;
  }
}

async function mutationBody(request: Request): Promise<JsonRecord> {
  const body = assertRecord(await readJson(request, MAX_JSON_BYTES));
  const headerKey = request.headers.get("idempotency-key");
  const bodyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined;
  if (headerKey && bodyKey && headerKey !== bodyKey) throw inputProblem("Idempotency-Key header and body value must match.");
  const key = headerKey ?? bodyKey;
  if (!key) throw inputProblem("An Idempotency-Key header or idempotencyKey body field is required.");
  return { ...body, idempotencyKey: key };
}

async function readJson(request: Request, maximum: number): Promise<unknown> {
  const bytes = await readRaw(request, maximum, "application/json");
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  } catch {
    throw inputProblem("Request body is not valid JSON.");
  }
}

async function readForm(request: Request, maximum: number): Promise<URLSearchParams> {
  const bytes = await readRaw(request, maximum, "application/x-www-form-urlencoded");
  return new URLSearchParams(Buffer.from(bytes).toString("utf8"));
}

async function readRaw(request: Request, maximum: number, contentType: string): Promise<Uint8Array> {
  const actualType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (actualType !== contentType) throw inputProblem(`Content-Type must be ${contentType}.`);
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) throw new HttpInputError({ code: "invalid_request", message: "Request body is too large.", status: 413, retryable: false });
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maximum) throw new HttpInputError({ code: "invalid_request", message: "Request body is too large.", status: 413, retryable: false });
  return bytes;
}

function matchPath<const Keys extends readonly string[]>(path: string, pattern: RegExp, keys: Keys): Record<Keys[number], string> | undefined {
  const match = path.match(pattern);
  if (!match) return undefined;
  const result: Record<string, string> = {};
  keys.forEach((key, index) => {
    try {
      result[key] = decodeURIComponent(match[index + 1]);
    } catch {
      throw inputProblem("Path contains invalid percent encoding.");
    }
  });
  return result as Record<Keys[number], string>;
}

function safeReturnTo(value: string | null): string {
  if (!value) return "/";
  if (!value.startsWith("/") || value.startsWith("//") || value.length > 4096) return "/";
  return value;
}

function resultResponse<T>(result: ApiResult<T>, successStatus = 200): Response {
  return result.ok ? json(result.value, successStatus) : problem(result.error);
}

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(`${JSON.stringify(value)}\n`, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...Object.fromEntries(new Headers(headers))
    }
  });
}

function problem(error: ApiError, headers?: HeadersInit): Response {
  return json({ error: {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    ...(error.expectedStateSha ? { expectedStateSha: error.expectedStateSha } : {}),
    ...(error.actualStateSha ? { actualStateSha: error.actualStateSha } : {}),
    ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {})
  } }, error.status, headers);
}

function oauthProblem(error: OAuthProtocolError): Response {
  return json({ error: error.code, error_description: error.message }, error.status, { "cache-control": "no-store" });
}

function oauthConsentPage(input: { token: string; clientOrigin: string }): Response {
  const token = escapeHtml(input.token);
  const clientOrigin = escapeHtml(input.clientOrigin);
  const body = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize Hunsu MCP access</title>
</head>
<body>
  <main>
    <h1>Authorize Hunsu MCP access?</h1>
    <p>A client returning to <code>${clientOrigin}</code> is requesting access to your Hunsu Projects and granted GitHub repositories.</p>
    <p>Approve only if you initiated this connection and recognize the client.</p>
    <form action="/oauth/authorize" method="post" autocomplete="off">
      <input type="hidden" name="consent_request" value="${token}">
      <button type="submit" name="decision" value="approve">Approve</button>
      <button type="submit" name="decision" value="deny">Deny</button>
    </form>
  </main>
</body>
</html>
`;
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      pragma: "no-cache",
      "content-security-policy": "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY"
    }
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function redirect(location: string, headers?: HeadersInit): Response {
  const result = new Headers(headers);
  result.set("location", location);
  result.set("cache-control", "no-store");
  return new Response(null, { status: 302, headers: result });
}

function methodNotAllowed(methods: string[]): Response {
  return problem({ code: "invalid_request", message: "Method not allowed.", status: 405, retryable: false }, { allow: methods.join(", ") });
}

function inputProblem(message: string): HttpInputError {
  return new HttpInputError({ code: "invalid_request", message, status: 400, retryable: false });
}

function assertRecord(value: unknown): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw inputProblem("Request body must be a JSON object.");
  return value as JsonRecord;
}

class HttpInputError extends Error {
  readonly error: ApiError;

  constructor(error: ApiError) {
    super(error.message);
    this.name = "HttpInputError";
    this.error = error;
  }
}
