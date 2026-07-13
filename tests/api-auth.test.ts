import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";
import {
  GitHubAppTokenProvider,
  GitHubOAuthClient,
  InMemoryEphemeralStateStore,
  McpOAuthService,
  OAuthProtocolError,
  SessionManager,
  SignedTokenService,
  type AuthContext,
  type GitHubOAuthFailure
} from "../apps/api/src/index.ts";

const sessionConfig = {
  secret: "test-session-secret-that-is-at-least-thirty-two-bytes",
  ttlSeconds: 3600,
  cookieName: "hunsu_session" as const,
  secure: true
};

const context: AuthContext = {
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

test("signed Web sessions are HttpOnly, expiring, and tamper evident", () => {
  let now = Date.UTC(2026, 6, 13, 0, 0, 0);
  const sessions = new SessionManager(sessionConfig, () => now);
  const issued = sessions.issue({ user: context.user, installations: context.installations, selectedInstallationId: 17 });
  assert.match(issued.cookie, /^hunsu_session=/u);
  assert.match(issued.cookie, /HttpOnly/u);
  assert.match(issued.cookie, /Secure/u);
  assert.match(issued.cookie, /SameSite=Lax/u);
  assert.match(issued.cookie, /Max-Age=3600/u);
  const authenticated = sessions.authenticate(new Request("https://api.example.test/api/session", {
    headers: { cookie: `hunsu_session=${encodeURIComponent(issued.token)}` }
  }));
  assert.equal(authenticated?.client, "web");
  assert.equal(authenticated?.subject, "github:7");
  assert.equal(authenticated?.user.login, "octocat");
  assert.equal(authenticated?.selectedInstallationId, 17);
  assert.deepEqual(authenticated?.installations[0]?.repositories, context.installations[0]?.repositories);

  const invalidAuthorization = sessions.tokens.issue({
    ...issued.claims,
    installations: [{ id: 17, accountLogin: "acme", accountType: "organization" }]
  } as unknown as Record<string, unknown>);
  assert.equal(sessions.authenticate(new Request("https://api.example.test", {
    headers: { cookie: `hunsu_session=${encodeURIComponent(invalidAuthorization)}` }
  })), undefined);

  const [payload, signature] = issued.token.split(".");
  assert.ok(payload);
  assert.ok(signature);
  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  const tamperedPayload = Buffer.from(JSON.stringify({ ...decoded, exp: Number(decoded.exp) + 86_400 }), "utf8").toString("base64url");
  assert.equal(sessions.authenticate(new Request("https://api.example.test", {
    headers: { cookie: `hunsu_session=${encodeURIComponent(`${tamperedPayload}.${signature}`)}` }
  })), undefined);

  now += 3_599_999;
  assert.equal(sessions.authenticate(new Request("https://api.example.test", {
    headers: { cookie: `hunsu_session=${encodeURIComponent(issued.token)}` }
  }))?.user.id, "7");
  now += 1;
  assert.equal(sessions.authenticate(new Request("https://api.example.test", {
    headers: { cookie: `hunsu_session=${encodeURIComponent(issued.token)}` }
  })), undefined);
});

test("MCP OAuth uses explicit consent, PKCE, shared one-time state, and audience-bound bearer tokens", async () => {
  const now = Date.UTC(2026, 6, 13);
  const stateStore = new InMemoryEphemeralStateStore({ now: () => Math.floor(now / 1000) });
  const oauth = new McpOAuthService({
    baseUrl: "https://api.example.test",
    secret: sessionConfig.secret,
    stateStore,
    now: () => now
  });
  const registration = oauth.register({ redirect_uris: ["https://client.example.test/callback"] });
  const clientId = registration.client_id as string;
  assert.ok(clientId);
  assert.equal(registration.token_endpoint_auth_method, "none");
  assert.deepEqual(registration.redirect_uris, ["https://client.example.test/callback"]);
  const verifier = "v".repeat(43);
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  const authorize = new URL("https://api.example.test/oauth/authorize");
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", "https://client.example.test/callback");
  authorize.searchParams.set("state", "client-state");
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  const sessionToken = "bound-web-session";
  const consent = await oauth.createConsentRequest(authorize, context, sessionToken);
  assert.equal(consent.clientOrigin, "https://client.example.test");
  assert.equal(new URL(authorize).searchParams.has("code"), false);
  await assert.rejects(() => oauth.decideConsent(new URLSearchParams({
    decision: "approve",
    consent_request: `${consent.token}tampered`
  }), context, sessionToken), (error: unknown) => error instanceof OAuthProtocolError && error.code === "invalid_request");
  const restartedForConsent = new McpOAuthService({
    baseUrl: "https://api.example.test",
    secret: sessionConfig.secret,
    stateStore,
    now: () => now
  });
  const redirected = new URL(await restartedForConsent.decideConsent(new URLSearchParams({
    decision: "approve",
    consent_request: consent.token
  }), context, sessionToken));
  assert.equal(redirected.searchParams.get("state"), "client-state");
  const code = redirected.searchParams.get("code");
  assert.ok(code);
  await assert.rejects(() => oauth.decideConsent(new URLSearchParams({
    decision: "approve",
    consent_request: consent.token
  }), context, sessionToken), (error: unknown) => error instanceof OAuthProtocolError && error.code === "invalid_request");
  const restartedBeforeExchange = new McpOAuthService({
    baseUrl: "https://api.example.test",
    secret: sessionConfig.secret,
    stateStore,
    now: () => now
  });
  await assert.rejects(() => restartedBeforeExchange.exchange(new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: "https://client.example.test/callback",
    code_verifier: "too-short"
  })), (error: unknown) => error instanceof OAuthProtocolError && error.code === "invalid_grant");
  const token = await restartedBeforeExchange.exchange(new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: "https://client.example.test/callback",
    code_verifier: verifier
  }));
  const authenticated = oauth.authenticate(new Request("https://api.example.test/mcp", {
    headers: { authorization: `Bearer ${String(token.access_token)}` }
  }));
  assert.equal(authenticated?.client, "mcp");
  assert.equal(authenticated?.user.id, "7");
  assert.equal(authenticated?.selectedInstallationId, 17);
  assert.deepEqual(authenticated?.installations[0]?.repositories, context.installations[0]?.repositories);
  const invalidContextToken = new SignedTokenService(
    sessionConfig.secret,
    () => Date.UTC(2026, 6, 13)
  ).issue({
    purpose: "mcp-access",
    context: {
      ...context,
      installations: [{ id: 17, accountLogin: "acme", accountType: "organization" }],
      client: "mcp"
    },
    scope: "hunsu",
    aud: "https://api.example.test/mcp",
    iat: Math.floor(Date.UTC(2026, 6, 13) / 1000),
    exp: Math.floor(Date.UTC(2026, 6, 13) / 1000) + 3600
  });
  assert.equal(oauth.authenticate(new Request("https://api.example.test/mcp", {
    headers: { authorization: `Bearer ${invalidContextToken}` }
  })), undefined);
  const restartedAfterExchange = new McpOAuthService({
    baseUrl: "https://api.example.test",
    secret: sessionConfig.secret,
    stateStore: new InMemoryEphemeralStateStore({ now: () => Math.floor(now / 1000) }),
    now: () => now
  });
  assert.equal(restartedAfterExchange.authenticate(new Request("https://api.example.test/mcp", {
    headers: { authorization: `Bearer ${String(token.access_token)}` }
  }))?.user.id, "7");
  await assert.rejects(() => oauth.exchange(new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: "https://client.example.test/callback",
    code_verifier: verifier
  })), (error: unknown) => error instanceof OAuthProtocolError && error.code === "invalid_grant");

  const differentAudience = new McpOAuthService({
    baseUrl: "https://other-api.example.test",
    secret: sessionConfig.secret,
    stateStore: new InMemoryEphemeralStateStore({ now: () => Math.floor(now / 1000) }),
    now: () => now
  });
  assert.equal(differentAudience.authenticate(new Request("https://other-api.example.test/mcp", {
    headers: { authorization: `Bearer ${String(token.access_token)}` }
  })), undefined);
  assert.equal(oauth.authenticate(new Request("https://api.example.test/mcp", {
    headers: { authorization: `Bearer ${String(token.access_token)}tampered` }
  })), undefined);
});

test("GitHub App installation tokens are short-lived and cached without exposing App credentials", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let now = Date.UTC(2026, 6, 13);
  let calls = 0;
  const requests: Array<{ url: string; init: RequestInit; appJwt: string }> = [];
  const provider = new GitHubAppTokenProvider({
    appId: 42,
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    apiBaseUrl: "https://github-api.example.test",
    now: () => now,
    fetch: async (input, init = {}) => {
      calls += 1;
      const appJwt = new Headers(init.headers).get("authorization")?.replace(/^Bearer /u, "") ?? "";
      requests.push({ url: String(input), init, appJwt });
      return new Response(JSON.stringify({
        token: `installation-token-${calls}`,
        expires_at: new Date(now + 3_600_000).toISOString(),
        permissions: { contents: "write" }
      }), {
        status: 201,
        headers: { "content-type": "application/json" }
      });
    }
  });
  assert.equal(await provider.getToken(17), "installation-token-1");
  assert.equal(await provider.getToken(17), "installation-token-1");
  assert.equal(calls, 1);

  const request = requests[0];
  assert.ok(request);
  assert.equal(request.url, "https://github-api.example.test/app/installations/17/access_tokens");
  assert.equal(request.init.method, "POST");
  assert.deepEqual(JSON.parse(String(request.init.body)), { permissions: { contents: "write" } });
  const headers = new Headers(request.init.headers);
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("x-github-api-version"), "2026-03-10");
  const [encodedHeader, encodedClaims, encodedSignature, extra] = request.appJwt.split(".");
  assert.ok(encodedHeader);
  assert.ok(encodedClaims);
  assert.ok(encodedSignature);
  assert.equal(extra, undefined);
  const jwtHeader = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as { alg: string; typ: string };
  assert.deepEqual(jwtHeader, { alg: "RS256", typ: "JWT" });
  const claims = JSON.parse(Buffer.from(encodedClaims, "base64url").toString("utf8")) as { iss: string; exp: number; iat: number };
  assert.equal(claims.iss, "42");
  assert.equal(claims.iat, Math.floor(now / 1000) - 60);
  assert.equal(claims.exp, Math.floor(now / 1000) + 540);
  assert.equal(verify(
    "RSA-SHA256",
    Buffer.from(`${encodedHeader}.${encodedClaims}`, "utf8"),
    publicKey,
    Buffer.from(encodedSignature, "base64url")
  ), true);

  now += 3_541_000;
  assert.equal(await provider.getToken(17), "installation-token-2");
  assert.equal(calls, 2);
});

test("GitHub App installation tokens fail closed without Contents write permission", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const now = Date.UTC(2026, 6, 13);
  const provider = new GitHubAppTokenProvider({
    appId: 42,
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    apiBaseUrl: "https://github-api.example.test",
    now: () => now,
    fetch: async () => jsonResponse({
      token: "underprivileged-installation-token",
      expires_at: new Date(now + 3_600_000).toISOString(),
      permissions: { metadata: "read" }
    }, 201)
  });
  await assert.rejects(
    provider.getToken(17),
    /missing the required Contents write permission/u
  );
});

test("GitHub OAuth resolves the user and granted App installations through authenticated API lookups", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const oauth = new GitHubOAuthClient({
    clientId: "github-client-id",
    clientSecret: "github-client-secret",
    publicApiUrl: "https://api.example.test/",
    apiBaseUrl: "https://github-api.example.test/",
    webBaseUrl: "https://github.example.test/",
    fetch: async (input, init = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === "https://github.example.test/login/oauth/access_token") {
        return jsonResponse({ access_token: "github-user-token", token_type: "bearer" });
      }
      if (url === "https://github-api.example.test/user") {
        return jsonResponse({ id: 7, login: "octocat", name: "The Octocat", avatar_url: "https://avatars.example.test/7" });
      }
      if (url === "https://github-api.example.test/user/installations?per_page=100&page=1") {
        return jsonResponse({
          installations: [
            { id: 17, account: { login: "acme", type: "Organization" } },
            { id: 19, account: { login: "octocat", type: "User" } }
          ]
        });
      }
      if (url === "https://github-api.example.test/user/installations/17/repositories?per_page=100&page=1") {
        return jsonResponse({ repositories: [githubRepository(29, { pull: true, push: false, admin: false })] });
      }
      if (url === "https://github-api.example.test/user/installations/19/repositories?per_page=100&page=1") {
        return jsonResponse({ repositories: [githubRepository(31, { pull: true, push: true, admin: false })] });
      }
      return new Response("not found", { status: 404 });
    }
  });

  const verifier = "v".repeat(43);
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  const authorizationUrl = new URL(oauth.authorizationUrl("oauth-state", challenge));
  assert.equal(authorizationUrl.origin, "https://github.example.test");
  assert.equal(authorizationUrl.pathname, "/login/oauth/authorize");
  assert.equal(authorizationUrl.searchParams.get("client_id"), "github-client-id");
  assert.equal(authorizationUrl.searchParams.get("redirect_uri"), "https://api.example.test/api/auth/github/callback");
  assert.equal(authorizationUrl.searchParams.get("state"), "oauth-state");
  assert.equal(authorizationUrl.searchParams.get("scope"), null);
  assert.equal(authorizationUrl.searchParams.get("code_challenge"), challenge);
  assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");

  const identityResult = await oauth.authenticate("github-code", verifier);
  assert.equal(identityResult.ok, true);
  if (!identityResult.ok) assert.fail("GitHub OAuth unexpectedly failed.");
  const identity = identityResult.value;
  assert.deepEqual(identity, {
    user: {
      id: "7",
      login: "octocat",
      name: "The Octocat",
      avatarUrl: "https://avatars.example.test/7"
    },
    installations: [
      {
        id: 17,
        accountLogin: "acme",
        accountType: "organization",
        repositories: [{ repositoryId: 29, permissions: { contents: "read" } }]
      },
      {
        id: 19,
        accountLogin: "octocat",
        accountType: "user",
        repositories: [{ repositoryId: 31, permissions: { contents: "write" } }]
      }
    ]
  });
  assert.doesNotMatch(JSON.stringify(identity), /github-user-token/u);

  assert.equal(calls.length, 5);
  const tokenExchange = calls.find(call => call.url.endsWith("/login/oauth/access_token"));
  assert.ok(tokenExchange);
  assert.equal(tokenExchange.init.method, "POST");
  assert.equal(new Headers(tokenExchange.init.headers).get("content-type"), "application/x-www-form-urlencoded");
  const tokenForm = new URLSearchParams(String(tokenExchange.init.body));
  assert.equal(tokenForm.get("client_id"), "github-client-id");
  assert.equal(tokenForm.get("client_secret"), "github-client-secret");
  assert.equal(tokenForm.get("code"), "github-code");
  assert.equal(tokenForm.get("redirect_uri"), "https://api.example.test/api/auth/github/callback");
  assert.equal(tokenForm.get("code_verifier"), verifier);

  const identityLookups = calls.filter(call => call.url.startsWith("https://github-api.example.test/"));
  assert.equal(identityLookups.length, 4);
  for (const lookup of identityLookups) {
    const lookupHeaders = new Headers(lookup.init.headers);
    assert.equal(lookupHeaders.get("authorization"), "Bearer github-user-token");
    assert.equal(lookupHeaders.get("x-github-api-version"), "2026-03-10");
    assert.equal(String(lookup.init.body), "undefined");
  }
});

test("GitHub OAuth failures expose only closed diagnostic metadata", async t => {
  const callbackCode = "callback-code-sentinel";
  const verifier = "v".repeat(43);
  const clientSecret = "client-secret-sentinel";
  const rawFailure = "raw-upstream-failure-sentinel";
  const cases: Array<{
    name: string;
    fetch: NonNullable<ConstructorParameters<typeof GitHubOAuthClient>[0]["fetch"]>;
    expected: {
      stage: GitHubOAuthFailure["stage"];
      reason: GitHubOAuthFailure["reason"];
      upstreamStatus: number | null;
      providerCode: GitHubOAuthFailure["providerCode"];
    };
  }> = [
    {
      name: "token transport",
      fetch: async () => { throw new Error(rawFailure); },
      expected: { stage: "code_exchange", reason: "transport", upstreamStatus: null, providerCode: null }
    },
    {
      name: "token provider rejection",
      fetch: async () => jsonResponse({
        error: "incorrect_client_credentials",
        error_description: rawFailure
      }),
      expected: {
        stage: "code_exchange",
        reason: "upstream_response",
        upstreamStatus: 200,
        providerCode: "incorrect_client_credentials"
      }
    },
    {
      name: "token malformed payload",
      fetch: async () => new Response(rawFailure, { status: 200 }),
      expected: { stage: "code_exchange", reason: "invalid_payload", upstreamStatus: 200, providerCode: null }
    },
    {
      name: "user lookup",
      fetch: async input => {
        const url = String(input);
        if (url.endsWith("/login/oauth/access_token")) return jsonResponse({ access_token: "token-sentinel" });
        if (url.endsWith("/user")) return jsonResponse({ message: rawFailure }, 502);
        return jsonResponse({ installations: [] });
      },
      expected: { stage: "user_lookup", reason: "upstream_response", upstreamStatus: 502, providerCode: null }
    },
    {
      name: "installation lookup",
      fetch: async input => {
        const url = String(input);
        if (url.endsWith("/login/oauth/access_token")) return jsonResponse({ access_token: "token-sentinel" });
        if (url.endsWith("/user")) return jsonResponse({ id: 7, login: "octocat" });
        return jsonResponse({ message: rawFailure }, 403);
      },
      expected: { stage: "installation_lookup", reason: "upstream_response", upstreamStatus: 403, providerCode: null }
    },
    {
      name: "repository lookup",
      fetch: async input => {
        const url = String(input);
        if (url.endsWith("/login/oauth/access_token")) return jsonResponse({ access_token: "token-sentinel" });
        if (url.endsWith("/user")) return jsonResponse({ id: 7, login: "octocat" });
        if (url.includes("/user/installations?")) {
          return jsonResponse({ installations: [{ id: 17, account: { login: "acme", type: "Organization" } }] });
        }
        return jsonResponse({ message: rawFailure }, 403);
      },
      expected: { stage: "repository_lookup", reason: "upstream_response", upstreamStatus: 403, providerCode: null }
    }
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const oauth = new GitHubOAuthClient({
        clientId: "client-id-sentinel",
        clientSecret,
        publicApiUrl: "https://api.example.test",
        apiBaseUrl: "https://github-api.example.test",
        webBaseUrl: "https://github.example.test",
        fetch: fixture.fetch
      });
      const result = await oauth.authenticate(callbackCode, verifier);
      assert.equal(result.ok, false);
      if (result.ok) assert.fail("GitHub OAuth failure fixture unexpectedly succeeded.");
      const failure = result.error;
      assert.deepEqual({
        stage: failure.stage,
        reason: failure.reason,
        upstreamStatus: failure.upstreamStatus,
        providerCode: failure.providerCode
      }, fixture.expected);
      const serialized = JSON.stringify(failure);
      for (const forbidden of [callbackCode, verifier, clientSecret, rawFailure, "token-sentinel", "github.example.test"]) {
        assert.doesNotMatch(serialized, new RegExp(forbidden, "u"));
      }
    });
  }
});

test("GitHub OAuth paginates every user-authorized repository for an installation", async () => {
  const repositoryCalls: string[] = [];
  const firstPage = Array.from({ length: 100 }, (_, index) => githubRepository(
    index + 1,
    { pull: true, push: false, admin: false }
  ));
  const oauth = new GitHubOAuthClient({
    clientId: "github-client-id",
    clientSecret: "github-client-secret",
    publicApiUrl: "https://api.example.test",
    apiBaseUrl: "https://github-api.example.test",
    webBaseUrl: "https://github.example.test",
    fetch: async input => {
      const url = String(input);
      if (url.endsWith("/login/oauth/access_token")) return jsonResponse({ access_token: "github-user-token" });
      if (url === "https://github-api.example.test/user") return jsonResponse({ id: 7, login: "octocat" });
      if (url === "https://github-api.example.test/user/installations?per_page=100&page=1") {
        return jsonResponse({ installations: [{ id: 17, account: { login: "acme", type: "Organization" } }] });
      }
      if (url.startsWith("https://github-api.example.test/user/installations/17/repositories?")) {
        repositoryCalls.push(url);
        return url.endsWith("page=1")
          ? jsonResponse({ repositories: firstPage })
          : jsonResponse({ repositories: [githubRepository(101, { pull: true, push: true, admin: false })] });
      }
      return jsonResponse({ message: "not found" }, 404);
    }
  });

  const identityResult = await oauth.authenticate("github-code", "v".repeat(43));
  assert.equal(identityResult.ok, true);
  if (!identityResult.ok) assert.fail("GitHub OAuth unexpectedly failed.");
  const identity = identityResult.value;
  assert.equal(identity.installations[0]?.repositories.length, 101);
  assert.deepEqual(identity.installations[0]?.repositories[0], {
    repositoryId: 1,
    permissions: { contents: "read" }
  });
  assert.deepEqual(identity.installations[0]?.repositories[100], {
    repositoryId: 101,
    permissions: { contents: "write" }
  });
  assert.deepEqual(repositoryCalls, [
    "https://github-api.example.test/user/installations/17/repositories?per_page=100&page=1",
    "https://github-api.example.test/user/installations/17/repositories?per_page=100&page=2"
  ]);
});

function githubRepository(
  id: number,
  permissions: { pull: boolean; push: boolean; admin: boolean }
): Record<string, unknown> {
  return { id, permissions };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}
