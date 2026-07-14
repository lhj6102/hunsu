import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  GitHubWebhookProcessor,
  HunsuApplicationService,
  HunsuHttpApp,
  InMemoryEphemeralStateStore,
  McpOAuthService,
  SessionManager,
  type AuthContext,
  type GitHubOAuthClient,
  type GitHubOAuthFailure
} from "../apps/api/src/index.ts";
import { MemoryGitHubTransport, type RepositoryGrant, type TransportResult } from "../packages/github-store/src/index.ts";

const API = "https://api.example.test";
const WEB = "https://web.example.test";
const INITIAL_SHA = "1".repeat(40);
const WEBHOOK_SECRET = "webhook-secret";

const repository: RepositoryGrant = {
  installationId: 17,
  repositoryId: 29,
  owner: "acme",
  name: "product",
  defaultBranch: "main",
  private: true,
  permissions: { contents: "write" }
};

const webContext: AuthContext = {
  subject: "github:7",
  user: { id: "7", login: "octocat" },
  installations: [{
    id: 17,
    accountLogin: "acme",
    accountType: "organization",
    repositories: [{ repositoryId: 29, permissions: { contents: "write" } }]
  }],
  selectedInstallationId: 17,
  client: "web"
};

test("GitHub App login uses PKCE and binds the callback to both transient cookies", async () => {
  const transport = new MemoryGitHubTransport([{ repository, initialSha: INITIAL_SHA }]);
  const service = new HunsuApplicationService({ transport });
  const sessions = new SessionManager({
    secret: "test-session-secret-that-is-at-least-thirty-two-bytes",
    ttlSeconds: 3600,
    cookieName: "hunsu_session",
    secure: true
  });
  const stateStore = new InMemoryEphemeralStateStore();
  const mcpOAuth = new McpOAuthService({ baseUrl: API, secret: sessions.config.secret, stateStore });
  let authorization: { state: string; challenge: string } | undefined;
  let exchanged: { code: string; verifier: string } | undefined;
  const githubOAuth = {
    authorizationUrl: (state: string, challenge: string) => {
      authorization = { state, challenge };
      const url = new URL("https://github.example.test/login/oauth/authorize");
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", challenge);
      url.searchParams.set("code_challenge_method", "S256");
      return url.toString();
    },
    authenticate: async (code: string, verifier: string) => {
      exchanged = { code, verifier };
      return { ok: true, value: { user: webContext.user, installations: [...webContext.installations] } };
    }
  } as unknown as GitHubOAuthClient;
  const app = new HunsuHttpApp({
    service,
    sessions,
    githubOAuth,
    mcpOAuth,
    webhooks: new GitHubWebhookProcessor({ secret: WEBHOOK_SECRET, service, stateStore }),
    publicApiUrl: API,
    webUrl: WEB,
    githubAppSlug: "hunsu-test"
  });

  const start = await app.handle(new Request(`${API}/api/auth/github?return_to=/projects`));
  assert.equal(start.status, 302);
  assert.ok(authorization);
  const setCookie = start.headers.get("set-cookie") ?? "";
  const stateCookie = setCookie.match(/hunsu_oauth_state=([^;,]+)/u)?.[1];
  const pkceCookie = setCookie.match(/hunsu_oauth_pkce=([^;,]+)/u)?.[1];
  assert.ok(stateCookie);
  assert.ok(pkceCookie);
  const verifier = decodeURIComponent(pkceCookie);
  assert.equal(createHash("sha256").update(verifier, "ascii").digest("base64url"), authorization.challenge);
  assert.doesNotMatch(start.headers.get("location") ?? "", new RegExp(verifier, "u"));

  const callback = `${API}/api/auth/github/callback?state=${encodeURIComponent(authorization.state)}&code=github-code`;
  const missingVerifier = await app.handle(new Request(callback, {
    headers: { cookie: `hunsu_oauth_state=${stateCookie}` }
  }));
  assert.equal(missingVerifier.status, 400);
  assert.equal(missingVerifier.headers.get("referrer-policy"), "no-referrer");
  assert.equal(exchanged, undefined);

  const completed = await app.handle(new Request(callback, {
    headers: { cookie: `hunsu_oauth_state=${stateCookie}; hunsu_oauth_pkce=${pkceCookie}` }
  }));
  assert.equal(completed.status, 302);
  assert.equal(completed.headers.get("location"), `${WEB}/projects`);
  assert.equal(completed.headers.get("referrer-policy"), "no-referrer");
  assert.deepEqual(exchanged, { code: "github-code", verifier });
  const completedCookies = completed.headers.get("set-cookie") ?? "";
  assert.match(completedCookies, /hunsu_session=/u);
  assert.match(completedCookies, /hunsu_oauth_state=; Max-Age=0/u);
  assert.match(completedCookies, /hunsu_oauth_pkce=; Max-Age=0/u);
});

test("GitHub OAuth callback diagnostics are response-only, closed, and credential-free", async t => {
  const typed = await runOAuthCallbackFailure(() => ({
    ok: false,
    error: {
      type: "GitHubOAuthFailure",
      stage: "code_exchange",
      reason: "upstream_response",
      upstreamStatus: 200,
      providerCode: "incorrect_client_credentials"
    } satisfies GitHubOAuthFailure
  }));
  assertOAuthDiagnostic(typed, {
    retryable: false,
    stage: "code_exchange",
    reason: "upstream_response",
    upstreamStatus: 200,
    providerCode: "incorrect_client_credentials"
  });

  await t.test("transport failures remain retryable", async () => {
    const transportFailure = await runOAuthCallbackFailure(() => ({
      ok: false,
      error: {
        type: "GitHubOAuthFailure",
        stage: "code_exchange",
        reason: "transport",
        upstreamStatus: null,
        providerCode: null
      } satisfies GitHubOAuthFailure
    }));
    assertOAuthDiagnostic(transportFailure, {
      retryable: true,
      stage: "code_exchange",
      reason: "transport",
      upstreamStatus: null,
      providerCode: null
    });
  });

  await t.test("unknown callback failures use a fixed local diagnostic", async () => {
    const unknown = await runOAuthCallbackFailure(() => { throw new Error("raw-callback-error-sentinel"); });
    assertOAuthDiagnostic(unknown, {
      retryable: false,
      stage: "callback_internal",
      reason: "local_failure",
      upstreamStatus: null,
      providerCode: null
    });
  });

  await t.test("session issuance failures use a fixed local diagnostic", async () => {
    const session = await runOAuthCallbackFailure(async () => ({ ok: true, value: {
      user: webContext.user,
      installations: [...webContext.installations]
    } }), true);
    assertOAuthDiagnostic(session, {
      retryable: false,
      stage: "session_issue",
      reason: "local_failure",
      upstreamStatus: null,
      providerCode: null
    });
  });
});

test("rate-limited API responses expose an exact Retry-After boundary", async () => {
  const transport = new class extends MemoryGitHubTransport {
    override async listInstallationRepositories(): Promise<TransportResult<RepositoryGrant[]>> {
      return {
        ok: false,
        error: {
          code: "rate_limited",
          message: "API rate limit exceeded for installation ID 17.",
          status: 429,
          retryAfterSeconds: 137,
          requestId: "RATE:HTTP"
        }
      };
    }
  }([{ repository, initialSha: INITIAL_SHA }]);
  const service = new HunsuApplicationService({ transport });
  const sessions = new SessionManager({
    secret: "test-session-secret-that-is-at-least-thirty-two-bytes",
    ttlSeconds: 3600,
    cookieName: "hunsu_session",
    secure: true
  });
  const stateStore = new InMemoryEphemeralStateStore();
  const app = new HunsuHttpApp({
    service,
    sessions,
    githubOAuth: {
      authorizationUrl: () => "https://github.example.test/authorize",
      authenticate: async () => ({ ok: true, value: { user: webContext.user, installations: [...webContext.installations] } })
    } as unknown as GitHubOAuthClient,
    mcpOAuth: new McpOAuthService({ baseUrl: API, secret: sessions.config.secret, stateStore }),
    webhooks: new GitHubWebhookProcessor({ secret: WEBHOOK_SECRET, service, stateStore }),
    publicApiUrl: API,
    webUrl: WEB,
    githubAppSlug: "hunsu-test"
  });
  const issued = sessions.issue({ user: webContext.user, installations: webContext.installations, selectedInstallationId: 17 });
  const response = await app.handle(new Request(`${API}/api/projects`, {
    headers: { cookie: `hunsu_session=${encodeURIComponent(issued.token)}` }
  }));

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "137");
  assert.deepEqual(await response.json(), {
    error: {
      code: "temporarily_unavailable",
      message: "GitHub is temporarily rate limiting this installation. Retry after at least 137 seconds.",
      retryable: true,
      retryAfterSeconds: 137,
      requestId: "RATE:HTTP"
    }
  });
});

test("REST mutation boundaries reject unsupported top-level lifecycle fields", async () => {
  const transport = new MemoryGitHubTransport([{ repository, initialSha: INITIAL_SHA }]);
  const service = new HunsuApplicationService({ transport });
  const sessions = new SessionManager({
    secret: "test-session-secret-that-is-at-least-thirty-two-bytes",
    ttlSeconds: 3600,
    cookieName: "hunsu_session",
    secure: true
  });
  const stateStore = new InMemoryEphemeralStateStore();
  const app = new HunsuHttpApp({
    service,
    sessions,
    githubOAuth: {
      authorizationUrl: () => "https://github.example.test/authorize",
      authenticate: async () => ({ ok: true, value: { user: webContext.user, installations: [...webContext.installations] } })
    } as unknown as GitHubOAuthClient,
    mcpOAuth: new McpOAuthService({ baseUrl: API, secret: sessions.config.secret, stateStore }),
    webhooks: new GitHubWebhookProcessor({ secret: WEBHOOK_SECRET, service, stateStore }),
    publicApiUrl: API,
    webUrl: WEB,
    githubAppSlug: "hunsu-test"
  });
  const issued = sessions.issue({
    user: webContext.user,
    installations: webContext.installations,
    selectedInstallationId: 17
  });
  const cookie = `hunsu_session=${encodeURIComponent(issued.token)}`;
  const nodeSha = "a".repeat(40);
  const routes = [
    "/api/projects",
    `/api/projects/project-v2/nodes/${nodeSha}/runs`,
    "/api/projects/project-v2/runs/run-1/complete",
    `/api/projects/project-v2/nodes/${nodeSha}/coaching/proposals`,
    "/api/projects/project-v2/coaching/proposals/proposal-1/confirm",
    "/api/projects/project-v2/comparisons",
    "/api/projects/project-v2/decisions/select",
    "/api/projects/project-v2/decisions/reject"
  ];

  for (const [index, path] of routes.entries()) {
    const idempotencyKey = `strict-input-${index}`;
    const response = await app.handle(jsonRequest(`${API}${path}`, {
      expectedStateSha: "b".repeat(40),
      idempotencyKey,
      unsupportedLifecycleField: true
    }, { cookie, origin: WEB, "idempotency-key": idempotencyKey }));
    assert.equal(response.status, 400, path);
    const body = await response.json() as { error: { code: string; message: string } };
    assert.equal(body.error.code, "invalid_request", path);
    assert.match(body.error.message, /unsupportedLifecycleField/u, path);
  }
});

test("OAuth authorization requires an explicit, same-session, single-use consent POST", async () => {
  let now = Date.UTC(2026, 6, 13, 1, 0, 0);
  const transport = new MemoryGitHubTransport([{ repository, initialSha: INITIAL_SHA }]);
  const service = new HunsuApplicationService({ transport });
  const sessions = new SessionManager({
    secret: "test-session-secret-that-is-at-least-thirty-two-bytes",
    ttlSeconds: 3600,
    cookieName: "hunsu_session",
    secure: true
  }, () => now);
  const stateStore = new InMemoryEphemeralStateStore({ now: () => Math.floor(now / 1000) });
  const mcpOAuth = new McpOAuthService({ baseUrl: API, secret: sessions.config.secret, stateStore, now: () => now });
  const app = new HunsuHttpApp({
    service,
    sessions,
    githubOAuth: {
      authorizationUrl: () => "https://github.example.test/authorize",
      authenticate: async () => ({ ok: true, value: { user: webContext.user, installations: [...webContext.installations] } })
    } as unknown as GitHubOAuthClient,
    mcpOAuth,
    webhooks: new GitHubWebhookProcessor({ secret: WEBHOOK_SECRET, service, stateStore }),
    publicApiUrl: API,
    webUrl: WEB,
    githubAppSlug: "hunsu-test"
  });
  const issued = sessions.issue({ user: webContext.user, installations: webContext.installations, selectedInstallationId: 17 });
  const cookie = `hunsu_session=${encodeURIComponent(issued.token)}`;
  const verifier = "v".repeat(43);
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  const redirectUri = "http://127.0.0.1:43123/callback";
  const redirectOrigin = new URL(redirectUri).origin;
  const registration = mcpOAuth.register({ redirect_uris: [redirectUri] });
  const clientId = String(registration.client_id);
  const authorizationUrl = new URL(`${API}/oauth/authorize`);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("client_id", clientId);
  authorizationUrl.searchParams.set("redirect_uri", redirectUri);
  authorizationUrl.searchParams.set("state", "<unsafe-client-state>");
  authorizationUrl.searchParams.set("code_challenge", challenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");

  const unauthenticated = await app.handle(new Request(authorizationUrl));
  assert.equal(unauthenticated.status, 302);
  assert.equal(unauthenticated.headers.get("location"), "https://github.example.test/authorize");

  const getConsent = async (): Promise<{ response: Response; token: string }> => {
    const response = await app.handle(new Request(authorizationUrl, { headers: { cookie } }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("location"), null);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("referrer-policy"), "same-origin");
    assert.equal(
      response.headers.get("content-security-policy"),
      `default-src 'none'; form-action 'self' ${redirectOrigin}; frame-ancestors 'none'; base-uri 'none'`
    );
    const body = await response.text();
    assert.doesNotMatch(body, /<unsafe-client-state>/u);
    assert.doesNotMatch(body, /name="code"/u);
    const token = body.match(/name="consent_request" value="([^"]+)"/u)?.[1];
    assert.ok(token);
    return { response, token };
  };
  const consent = await getConsent();

  const missing = await app.handle(consentRequest(cookie, new URLSearchParams({ decision: "approve" })));
  assert.equal(missing.status, 400);
  const forged = await app.handle(consentRequest(cookie, new URLSearchParams({
    decision: "approve",
    consent_request: `${consent.token}tampered`
  })));
  assert.equal(forged.status, 400);
  const crossSite = await app.handle(consentRequest(cookie, new URLSearchParams({
    decision: "approve",
    consent_request: consent.token
  }), "https://attacker.example.test"));
  assert.equal(crossSite.status, 403);
  const wrongConsentType = await app.handle(new Request(`${API}/oauth/authorize`, {
    method: "POST",
    headers: { cookie, origin: API, "sec-fetch-site": "same-origin", "content-type": "application/json" },
    body: JSON.stringify({ decision: "approve", consent_request: consent.token })
  }));
  assert.equal(wrongConsentType.status, 400);

  now += 1_000;
  const otherSession = sessions.issue({
    user: { id: "8", login: "mallory" },
    installations: webContext.installations,
    selectedInstallationId: 17
  });
  const wrongSession = await app.handle(consentRequest(
    `hunsu_session=${encodeURIComponent(otherSession.token)}`,
    new URLSearchParams({ decision: "approve", consent_request: consent.token })
  ));
  assert.equal(wrongSession.status, 400);

  const approved = await app.handle(consentRequest(cookie, new URLSearchParams({
    decision: "approve",
    consent_request: consent.token
  })));
  assert.equal(approved.status, 302);
  const approvedRedirect = new URL(approved.headers.get("location") ?? "");
  assert.equal(approvedRedirect.origin, redirectOrigin);
  assert.equal(approvedRedirect.searchParams.get("state"), "<unsafe-client-state>");
  const code = approvedRedirect.searchParams.get("code");
  assert.ok(code);

  const replay = await app.handle(consentRequest(cookie, new URLSearchParams({
    decision: "approve",
    consent_request: consent.token
  })));
  assert.equal(replay.status, 400);
  assert.equal(replay.headers.get("location"), null);

  const tokenResponse = await app.handle(new Request(`${API}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: verifier
    })
  }));
  assert.equal(tokenResponse.status, 200);
  assert.equal(typeof (await tokenResponse.json() as { access_token: unknown }).access_token, "string");

  const denialConsent = await getConsent();
  const denied = await app.handle(consentRequest(cookie, new URLSearchParams({
    decision: "deny",
    consent_request: denialConsent.token
  })));
  assert.equal(denied.status, 302);
  const deniedRedirect = new URL(denied.headers.get("location") ?? "");
  assert.equal(deniedRedirect.searchParams.get("error"), "access_denied");
  assert.equal(deniedRedirect.searchParams.get("state"), "<unsafe-client-state>");
  assert.equal(deniedRedirect.searchParams.has("code"), false);
});

test("HTTP exposes only the Commit Node v2 REST surface", async () => {
  const calls: Array<{ name: string; args: readonly unknown[] }> = [];
  const record = (name: string) => async (...args: readonly unknown[]) => {
    calls.push({ name, args });
    return { ok: true as const, value: { route: name } };
  };
  const service = {
    sessionRepositories: record("sessionRepositories"),
    webProjects: record("webProjects"),
    webProjectContext: record("webProjectContext"),
    webGraph: record("webGraph"),
    webNode: record("webNode"),
    webEvents: record("webEvents"),
    webEvent: record("webEvent"),
    webRun: record("webRun"),
    webCreateProject: record("webCreateProject"),
    webStartRun: record("webStartRun"),
    webCheckpointRun: record("webCheckpointRun"),
    webAttachRunEvidence: record("webAttachRunEvidence"),
    webCompleteRun: record("webCompleteRun"),
    webFailRun: record("webFailRun"),
    webCancelRun: record("webCancelRun"),
    webCreateCoachingProposal: record("webCreateCoachingProposal"),
    webConfirmCoachingProposal: record("webConfirmCoachingProposal"),
    webRejectCoachingProposal: record("webRejectCoachingProposal"),
    webCompareAlternatives: record("webCompareAlternatives"),
    webSelectAlternative: record("webSelectAlternative"),
    webRejectAlternative: record("webRejectAlternative")
  } as unknown as HunsuApplicationService;
  const sessions = new SessionManager({
    secret: "test-session-secret-that-is-at-least-thirty-two-bytes",
    ttlSeconds: 3600,
    cookieName: "hunsu_session",
    secure: true
  });
  const stateStore = new InMemoryEphemeralStateStore();
  const mcpOAuth = new McpOAuthService({ baseUrl: API, secret: sessions.config.secret, stateStore });
  const webhooks = {
    process: async () => ({ ok: true as const, value: { accepted: true, duplicate: false, signal: "state_ref_changed" } })
  } as unknown as GitHubWebhookProcessor;
  const githubOAuth = {
    authorizationUrl: () => "https://github.example.test/authorize",
    authenticate: async () => ({ ok: true, value: { user: webContext.user, installations: [...webContext.installations] } })
  } as unknown as GitHubOAuthClient;
  const app = new HunsuHttpApp({
    service,
    sessions,
    githubOAuth,
    mcpOAuth,
    webhooks,
    publicApiUrl: API,
    webUrl: WEB,
    githubAppSlug: "hunsu-test"
  });
  const issued = sessions.issue({ user: webContext.user, installations: webContext.installations, selectedInstallationId: 17 });
  const cookie = `hunsu_session=${encodeURIComponent(issued.token)}`;

  const sessionResponse = await app.handle(new Request(`${API}/api/session`, { headers: { cookie } }));
  assert.equal(sessionResponse.status, 200);
  assert.equal((await sessionResponse.json() as { authenticated: boolean }).authenticated, true);

  const nodeSha = "a".repeat(40);
  const readRoutes: ReadonlyArray<{
    path: string;
    name: string;
    args: readonly unknown[];
  }> = [
    { path: "/api/repositories", name: "sessionRepositories", args: [] },
    { path: "/api/projects", name: "webProjects", args: [] },
    { path: "/api/projects/project-v2/context", name: "webProjectContext", args: ["project-v2"] },
    {
      path: "/api/projects/project-v2/graph?limit=12&cursor=graph-cursor",
      name: "webGraph",
      args: ["project-v2", { limit: 12, cursor: "graph-cursor" }]
    },
    { path: `/api/projects/project-v2/nodes/${nodeSha}`, name: "webNode", args: ["project-v2", nodeSha] },
    {
      path: `/api/projects/project-v2/events?limit=25&type=RunCompleted&nodeSha=${nodeSha}&actor=user-7&from=2026-07-01T00%3A00%3A00.000Z&to=2026-07-15T00%3A00%3A00.000Z&search=evidence`,
      name: "webEvents",
      args: ["project-v2", {
        limit: 25,
        type: "RunCompleted",
        nodeSha,
        actor: "user-7",
        from: "2026-07-01T00:00:00.000Z",
        to: "2026-07-15T00:00:00.000Z",
        search: "evidence"
      }]
    },
    { path: "/api/projects/project-v2/events/event-1", name: "webEvent", args: ["project-v2", "event-1"] },
    { path: "/api/projects/project-v2/runs/run-1", name: "webRun", args: ["project-v2", "run-1"] }
  ];
  for (const route of readRoutes) {
    const before = calls.length;
    const response = await app.handle(new Request(`${API}${route.path}`, { headers: { cookie } }));
    assert.equal(response.status, 200, route.path);
    assert.equal(calls.length, before + 1, route.path);
    const call = calls.at(-1);
    assert.equal(call?.name, route.name);
    assert.deepEqual(call?.args.slice(1), route.args);
  }

  const mutationRoutes: ReadonlyArray<{ path: string; name: string; status: number; args: readonly unknown[] }> = [
    { path: "/api/projects", name: "webCreateProject", status: 201, args: [] },
    { path: `/api/projects/project-v2/nodes/${nodeSha}/runs`, name: "webStartRun", status: 201, args: ["project-v2", nodeSha] },
    { path: "/api/projects/project-v2/runs/run-1/checkpoints", name: "webCheckpointRun", status: 201, args: ["project-v2", "run-1"] },
    { path: "/api/projects/project-v2/runs/run-1/evidence", name: "webAttachRunEvidence", status: 201, args: ["project-v2", "run-1"] },
    { path: "/api/projects/project-v2/runs/run-1/complete", name: "webCompleteRun", status: 200, args: ["project-v2", "run-1"] },
    { path: "/api/projects/project-v2/runs/run-2/fail", name: "webFailRun", status: 200, args: ["project-v2", "run-2"] },
    { path: "/api/projects/project-v2/runs/run-3/cancel", name: "webCancelRun", status: 200, args: ["project-v2", "run-3"] },
    {
      path: `/api/projects/project-v2/nodes/${nodeSha}/coaching/proposals`,
      name: "webCreateCoachingProposal",
      status: 201,
      args: ["project-v2", nodeSha]
    },
    {
      path: "/api/projects/project-v2/coaching/proposals/proposal-1/confirm",
      name: "webConfirmCoachingProposal",
      status: 200,
      args: ["project-v2", "proposal-1"]
    },
    {
      path: "/api/projects/project-v2/coaching/proposals/proposal-2/reject",
      name: "webRejectCoachingProposal",
      status: 200,
      args: ["project-v2", "proposal-2"]
    },
    { path: "/api/projects/project-v2/comparisons", name: "webCompareAlternatives", status: 201, args: ["project-v2"] },
    { path: "/api/projects/project-v2/decisions/select", name: "webSelectAlternative", status: 200, args: ["project-v2"] },
    { path: "/api/projects/project-v2/decisions/reject", name: "webRejectAlternative", status: 200, args: ["project-v2"] }
  ];
  for (const [index, route] of mutationRoutes.entries()) {
    const body = { marker: route.name, expectedStateSha: "b".repeat(40), idempotencyKey: `mutation-${index}` };
    const before = calls.length;
    const response = await app.handle(jsonRequest(`${API}${route.path}`, body, {
      cookie,
      origin: WEB,
      "idempotency-key": `mutation-${index}`
    }));
    assert.equal(response.status, route.status, route.path);
    assert.equal(calls.length, before + 1, route.path);
    const call = calls.at(-1);
    assert.equal(call?.name, route.name);
    assert.deepEqual(call?.args.slice(1, -1), route.args);
    assert.deepEqual(call?.args.at(-1), body);
  }

  const forbiddenMutation = await app.handle(jsonRequest(`${API}/api/projects/project-v2/decisions/select`, {
    expectedStateSha: "b".repeat(40),
    idempotencyKey: "missing-origin"
  }, { cookie }));
  assert.equal(forbiddenMutation.status, 403);

  const wrongContentType = await app.handle(new Request(`${API}/api/projects/project-v2/comparisons`, {
    method: "POST",
    headers: { cookie, origin: WEB, "content-type": "text/plain", "idempotency-key": "wrong-type" },
    body: "not json"
  }));
  assert.equal(wrongContentType.status, 400);

  const mismatchedKey = await app.handle(jsonRequest(`${API}/api/projects/project-v2/comparisons`, {
    expectedStateSha: "b".repeat(40),
    idempotencyKey: "body-key"
  }, { cookie, origin: WEB, "idempotency-key": "header-key" }));
  assert.equal(mismatchedKey.status, 400);
  const missingExpectedState = await app.handle(jsonRequest(`${API}/api/projects/project-v2/comparisons`, {
    idempotencyKey: "missing-state"
  }, { cookie, origin: WEB }));
  assert.equal(missingExpectedState.status, 400);

  const invalidGraphLimit = await app.handle(new Request(`${API}/api/projects/project-v2/graph?limit=301`, { headers: { cookie } }));
  assert.equal(invalidGraphLimit.status, 400);
  const repeatedCursor = await app.handle(new Request(`${API}/api/projects/project-v2/events?cursor=1&cursor=2`, { headers: { cookie } }));
  assert.equal(repeatedCursor.status, 400);
  const unknownFilter = await app.handle(new Request(`${API}/api/projects/project-v2/events?rawPayload=true`, { headers: { cookie } }));
  assert.equal(unknownFilter.status, 400);

  for (const legacy of [
    { path: "/api/projects/project-v2", method: "GET" },
    { path: "/api/projects/project-v2/goals", method: "POST" },
    { path: "/api/projects/project-v2/goals/goal-1", method: "PATCH" },
    { path: "/api/projects/project-v2/runners", method: "GET" },
    { path: "/api/projects/project-v2/coach", method: "GET" },
    { path: "/api/projects/project-v2/coach/review", method: "POST" },
    { path: "/api/projects/project-v2/rebuild", method: "POST" }
  ]) {
    const response = await app.handle(new Request(`${API}${legacy.path}`, {
      method: legacy.method,
      headers: { cookie, origin: WEB }
    }));
    assert.equal(response.status, 404, legacy.path);
  }

  const unauthenticatedMcp = await app.handle(new Request(`${API}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })
  }));
  assert.equal(unauthenticatedMcp.status, 401);
  assert.match(unauthenticatedMcp.headers.get("www-authenticate") ?? "", /oauth-protected-resource/u);

  const webhook = await app.handle(new Request(`${API}/api/github/webhooks`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": "sha256=test",
      "x-github-delivery": "delivery-v2",
      "x-github-event": "push"
    },
    body: "{}"
  }));
  assert.equal(webhook.status, 202);
  assert.equal((await webhook.json() as { accepted: boolean }).accepted, true);

  const preflight = await app.handle(new Request(`${API}/api/projects/project-v2/graph`, {
    method: "OPTIONS",
    headers: { origin: WEB }
  }));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-methods"), "GET, POST, OPTIONS");
});

function jsonRequest(url: string, body: unknown, headers: Record<string, string>, method = "POST"): Request {
  return new Request(url, { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

type OAuthDiagnosticResult = {
  response: Response;
  body: {
    error: {
      code: string;
      message: string;
      retryable: boolean;
      diagnostic: {
        schema: string;
        id: string;
        stage: string;
        reason: string;
        upstreamStatus: number | null;
        providerCode: string | null;
      };
    };
  };
  forbidden: string[];
};

async function runOAuthCallbackFailure(
  authenticate: (code: string, verifier: string) => Promise<unknown> | unknown,
  failSessionIssue = false
): Promise<OAuthDiagnosticResult> {
  const transport = new MemoryGitHubTransport([{ repository, initialSha: INITIAL_SHA }]);
  const service = new HunsuApplicationService({ transport });
  const sessions = new SessionManager({
    secret: "test-session-secret-that-is-at-least-thirty-two-bytes",
    ttlSeconds: 3600,
    cookieName: "hunsu_session",
    secure: true
  });
  if (failSessionIssue) sessions.issue = () => { throw new Error("raw-session-error-sentinel"); };
  const stateStore = new InMemoryEphemeralStateStore();
  let state = "";
  const app = new HunsuHttpApp({
    service,
    sessions,
    githubOAuth: {
      authorizationUrl: (value: string) => {
        state = value;
        return "https://github.example.test/authorize";
      },
      authenticate
    } as unknown as GitHubOAuthClient,
    mcpOAuth: new McpOAuthService({ baseUrl: API, secret: sessions.config.secret, stateStore }),
    webhooks: new GitHubWebhookProcessor({ secret: WEBHOOK_SECRET, service, stateStore }),
    publicApiUrl: API,
    webUrl: WEB,
    githubAppSlug: "hunsu-test"
  });
  const start = await app.handle(new Request(`${API}/api/auth/github`));
  const cookies = start.headers.get("set-cookie") ?? "";
  const stateCookie = cookies.match(/hunsu_oauth_state=([^;,]+)/u)?.[1];
  const pkceCookie = cookies.match(/hunsu_oauth_pkce=([^;,]+)/u)?.[1];
  assert.ok(stateCookie);
  assert.ok(pkceCookie);
  const callbackCode = "callback-code-sentinel";
  const response = await app.handle(new Request(
    `${API}/api/auth/github/callback?state=${encodeURIComponent(state)}&code=${callbackCode}`,
    { headers: { cookie: `hunsu_oauth_state=${stateCookie}; hunsu_oauth_pkce=${pkceCookie}` } }
  ));
  const body = await response.json() as OAuthDiagnosticResult["body"];
  return {
    response,
    body,
    forbidden: [
      callbackCode,
      state,
      stateCookie,
      pkceCookie,
      decodeURIComponent(pkceCookie),
      "raw-callback-error-sentinel",
      "raw-session-error-sentinel"
    ]
  };
}

function assertOAuthDiagnostic(
  result: OAuthDiagnosticResult,
  expected: Omit<OAuthDiagnosticResult["body"]["error"]["diagnostic"], "schema" | "id"> & { retryable: boolean }
): void {
  assert.equal(result.response.status, 503);
  assert.equal(result.response.headers.get("cache-control"), "no-store");
  assert.equal(result.response.headers.get("referrer-policy"), "no-referrer");
  const clearedCookies = result.response.headers.get("set-cookie") ?? "";
  assert.match(clearedCookies, /hunsu_oauth_state=; Max-Age=0/u);
  assert.match(clearedCookies, /hunsu_oauth_pkce=; Max-Age=0/u);
  assert.match(result.body.error.diagnostic.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  const { retryable, ...diagnostic } = expected;
  assert.deepEqual({
    ...result.body,
    error: {
      ...result.body.error,
      diagnostic: { ...result.body.error.diagnostic, id: "<uuid>" }
    }
  }, {
    error: {
      code: "temporarily_unavailable",
      message: "GitHub sign-in could not be completed.",
      retryable,
      diagnostic: {
        schema: "hunsu.github-oauth-diagnostic.v1",
        id: "<uuid>",
        ...diagnostic
      }
    }
  });
  const serialized = JSON.stringify(result.body);
  for (const forbidden of result.forbidden) assert.doesNotMatch(serialized, new RegExp(forbidden, "u"));
}

function consentRequest(cookie: string, body: URLSearchParams, origin = API): Request {
  return new Request(`${API}/oauth/authorize`, {
    method: "POST",
    headers: {
      cookie,
      origin,
      "sec-fetch-site": origin === API ? "same-origin" : "cross-site",
      "content-type": "application/x-www-form-urlencoded"
    },
    body
  });
}
