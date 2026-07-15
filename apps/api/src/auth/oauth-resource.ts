import { createHash } from "node:crypto";
import type { AuthContext } from "../types.ts";
import {
  authContextDigest,
  isExactAuthContext,
  type EphemeralStateStore
} from "./ephemeral-store.ts";
import { SignedTokenService } from "./session.ts";

type JsonRecord = Record<string, unknown>;

const ACCESS_TOKEN_TTL_SECONDS = 3_600;
const DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_OAUTH_REDIRECT_URI_BYTES = 2_048;
const MAX_OAUTH_REDIRECT_URI_COUNT = 16;
const MAX_OAUTH_REDIRECT_URIS_TOTAL_BYTES = 4_096;
const OAUTH_SCOPE = "hunsu";
const REFRESH_FAMILY_CREATION_ATTEMPTS = 3;
const REFRESH_TOKEN_PURPOSE = "mcp-refresh";

export type OAuthConsentRequest = {
  token: string;
  clientOrigin: string;
};

export class OAuthProtocolError extends Error {
  readonly code: "invalid_request" | "invalid_client" | "invalid_grant" | "invalid_scope" | "invalid_target" | "server_error" | "unsupported_grant_type";
  readonly status: number;
  readonly wwwAuthenticate: string | null;

  constructor(
    code: "invalid_request" | "invalid_client" | "invalid_grant" | "invalid_scope" | "invalid_target" | "server_error" | "unsupported_grant_type",
    message: string,
    status = 400,
    wwwAuthenticate: string | null = null
  ) {
    super(message);
    this.name = "OAuthProtocolError";
    this.code = code;
    this.status = status;
    this.wwwAuthenticate = wwwAuthenticate;
  }
}

export class McpOAuthService {
  readonly #baseUrl: string;
  readonly #tokens: SignedTokenService;
  readonly #now: () => number;
  readonly #refreshTokenTtlSeconds: number;
  readonly #stateStore: EphemeralStateStore;

  constructor(input: {
    baseUrl: string;
    secret: string;
    stateStore: EphemeralStateStore;
    refreshTokenTtlSeconds?: number;
    now?: () => number;
  }) {
    this.#baseUrl = input.baseUrl.replace(/\/$/u, "");
    this.#now = input.now ?? (() => Date.now());
    this.#refreshTokenTtlSeconds = input.refreshTokenTtlSeconds ?? DEFAULT_REFRESH_TOKEN_TTL_SECONDS;
    if (!Number.isSafeInteger(this.#refreshTokenTtlSeconds) || this.#refreshTokenTtlSeconds <= 0) {
      throw new Error("OAuth refresh-token TTL must be a positive integer number of seconds.");
    }
    this.#stateStore = input.stateStore;
    this.#tokens = new SignedTokenService(input.secret, this.#now);
  }

  protectedResourceMetadata(): JsonRecord {
    return {
      resource: `${this.#baseUrl}/mcp`,
      authorization_servers: [this.#baseUrl],
      bearer_methods_supported: ["header"],
      scopes_supported: ["hunsu"]
    };
  }

  authorizationServerMetadata(): JsonRecord {
    return {
      issuer: this.#baseUrl,
      authorization_endpoint: `${this.#baseUrl}/oauth/authorize`,
      token_endpoint: `${this.#baseUrl}/oauth/token`,
      registration_endpoint: `${this.#baseUrl}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["hunsu"]
    };
  }

  register(input: unknown): JsonRecord {
    if (!isRecord(input) || !Array.isArray(input.redirect_uris) || input.redirect_uris.length === 0) {
      throw new OAuthProtocolError("invalid_request", "redirect_uris must contain at least one redirect URI.");
    }
    if (input.redirect_uris.length > MAX_OAUTH_REDIRECT_URI_COUNT) {
      throw new OAuthProtocolError("invalid_request", `redirect_uris must contain at most ${MAX_OAUTH_REDIRECT_URI_COUNT} entries.`);
    }
    const redirectUris = input.redirect_uris.map(value => {
      if (typeof value !== "string"
        || utf8ByteLength(value) > MAX_OAUTH_REDIRECT_URI_BYTES
        || !isSafeRedirectUri(value)) {
        throw new OAuthProtocolError("invalid_request", "A redirect URI is invalid or too long.");
      }
      return value;
    });
    if (redirectUris.reduce((total, value) => total + utf8ByteLength(value), 0) > MAX_OAUTH_REDIRECT_URIS_TOTAL_BYTES) {
      throw new OAuthProtocolError("invalid_request", "The combined redirect_uris value is too large.");
    }
    if (new Set(redirectUris).size !== redirectUris.length) {
      throw new OAuthProtocolError("invalid_request", "redirect_uris must not contain duplicates.");
    }
    validateRegistrationValues(input);
    const now = seconds(this.#now);
    const clientId = this.#tokens.issue({
      purpose: "oauth-client",
      redirectUris,
      grantTypes: ["authorization_code", "refresh_token"],
      iat: now,
      exp: now + 365 * 24 * 60 * 60
    });
    return {
      client_id: clientId,
      client_id_issued_at: now,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"]
    };
  }

  async createConsentRequest(url: URL, context: AuthContext, sessionToken: string): Promise<OAuthConsentRequest> {
    if (!sessionToken || context.client !== "web") throw new OAuthProtocolError("invalid_request", "The Web session is missing or expired.", 401);
    if (requiredParam(url, "response_type") !== "code") throw new OAuthProtocolError("invalid_request", "Only response_type=code is supported.");
    validateScope(optionalParam(url, "scope"));
    const audience = this.#requiredResource(url.searchParams);
    const clientId = requiredParam(url, "client_id");
    const redirectUri = requiredParam(url, "redirect_uri");
    const state = optionalParam(url, "state");
    const challenge = requiredParam(url, "code_challenge");
    if (requiredParam(url, "code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/u.test(challenge)) {
      throw new OAuthProtocolError("invalid_request", "OAuth authorization requires PKCE S256.");
    }
    const client = this.#tokens.verify(clientId, "oauth-client");
    if (!isOAuthClientClaims(client) || !client.redirectUris.includes(redirectUri)) {
      throw new OAuthProtocolError("invalid_client", "The OAuth client or redirect URI is not registered.");
    }
    const now = seconds(this.#now);
    const jti = this.#tokens.nonce(18);
    const expiresAt = now + 300;
    const token = this.#tokens.issue({
      purpose: "oauth-consent",
      jti,
      clientId,
      redirectUri,
      challenge,
      audience,
      contextDigest: authContextDigest(context),
      sessionDigest: textDigest(sessionToken),
      ...(state ? { state } : {}),
      iat: now,
      exp: expiresAt
    });
    await this.#stateStore.createConsent({ id: jti, expiresAt });
    return { token, clientOrigin: new URL(redirectUri).origin };
  }

  async decideConsent(input: URLSearchParams, context: AuthContext, sessionToken: string): Promise<string> {
    if (!sessionToken || context.client !== "web") throw new OAuthProtocolError("invalid_request", "The Web session is missing or expired.", 401);
    const decision = requiredForm(input, "decision");
    if (decision !== "approve" && decision !== "deny") {
      throw new OAuthProtocolError("invalid_request", "The authorization decision must be approve or deny.");
    }
    const consentToken = requiredForm(input, "consent_request");
    const claims = this.#tokens.verify(consentToken, "oauth-consent");
    const now = seconds(this.#now);
    if (!claims
      || typeof claims.jti !== "string"
      || typeof claims.clientId !== "string"
      || typeof claims.redirectUri !== "string"
      || typeof claims.challenge !== "string"
      || typeof claims.audience !== "string"
      || typeof claims.contextDigest !== "string"
      || typeof claims.sessionDigest !== "string"
      || (claims.state !== undefined && typeof claims.state !== "string")
      || claims.contextDigest !== authContextDigest(context)
      || claims.audience !== this.#audience()
      || !constantTextEqual(claims.sessionDigest, textDigest(sessionToken))
      || !this.#registeredRedirect(claims.clientId, claims.redirectUri)
    ) {
      throw new OAuthProtocolError("invalid_request", "The consent request is invalid, expired, already used, or belongs to another session.");
    }

    if (!await this.#stateStore.consumeConsent(claims.jti)) {
      throw new OAuthProtocolError("invalid_request", "The consent request is invalid, expired, already used, or belongs to another session.");
    }
    const redirect = new URL(claims.redirectUri);
    if (typeof claims.state === "string") redirect.searchParams.set("state", claims.state);
    if (decision === "deny") {
      redirect.searchParams.set("error", "access_denied");
      redirect.searchParams.set("error_description", "The resource owner denied the authorization request.");
      return redirect.toString();
    }

    const code = this.#tokens.nonce(32);
    await this.#stateStore.createAuthorizationCode(code, {
      clientId: claims.clientId,
      redirectUri: claims.redirectUri,
      challenge: claims.challenge,
      audience: claims.audience,
      context: cloneAuthContext(context),
      expiresAt: now + 300
    });
    redirect.searchParams.set("code", code);
    return redirect.toString();
  }

  async exchange(input: URLSearchParams, authorization?: string | null): Promise<JsonRecord> {
    rejectConfidentialClientAuthentication(input, authorization);
    const grantType = requiredForm(input, "grant_type");
    this.#requiredResource(input);
    switch (grantType) {
      case "authorization_code":
        return this.#exchangeAuthorizationCode(input);
      case "refresh_token":
        return this.#exchangeRefreshToken(input);
      default:
        throw new OAuthProtocolError("unsupported_grant_type", "Only authorization_code and refresh_token are supported.");
    }
  }

  async #exchangeAuthorizationCode(input: URLSearchParams): Promise<JsonRecord> {
    const code = requiredForm(input, "code");
    const clientId = requiredForm(input, "client_id");
    const redirectUri = requiredForm(input, "redirect_uri");
    const verifier = requiredForm(input, "code_verifier");
    validateScope(optionalForm(input, "scope"));
    if (!this.#registeredClient(clientId)) throw new OAuthProtocolError("invalid_client", "The OAuth client is not registered.");
    if (!/^[A-Za-z0-9._~-]{43,128}$/u.test(verifier)) throw new OAuthProtocolError("invalid_grant", "The PKCE verifier is invalid.");
    const now = seconds(this.#now);
    const pending = await this.#stateStore.consumeAuthorizationCode(code);
    if (!pending
      || pending.clientId !== clientId
      || pending.redirectUri !== redirectUri
      || pending.audience !== this.#audience()
      || !constantTextEqual(pkceChallenge(verifier), pending.challenge)
    ) {
      throw new OAuthProtocolError("invalid_grant", "The authorization code is invalid, expired, or already used.");
    }
    const context = cloneAuthContext({ ...pending.context, client: "mcp" });
    const refreshGrant = await this.#createRefreshToken(clientId, context, now);
    return this.#tokenResponse(
      context,
      clientId,
      refreshGrant.token,
      now,
      refreshGrant.expiresAt
    );
  }

  async #exchangeRefreshToken(input: URLSearchParams): Promise<JsonRecord> {
    const refreshToken = requiredForm(input, "refresh_token");
    const clientId = requiredForm(input, "client_id");
    validateScope(optionalForm(input, "scope"));
    if (!this.#registeredClient(clientId)) throw invalidRefreshGrant();
    const claims = this.#tokens.verify(refreshToken, REFRESH_TOKEN_PURPOSE);
    if (!isRefreshTokenClaims(claims)) throw invalidRefreshGrant();
    const nextGeneration = claims.generation + 1;
    if (!Number.isSafeInteger(nextGeneration)) throw invalidRefreshGrant();
    const now = seconds(this.#now);
    const nextRefreshToken = this.#issueRefreshToken({
      familyId: claims.familyId,
      generation: nextGeneration,
      issuedAt: now,
      expiresAt: claims.exp
    });
    const rotation = await this.#stateStore.rotateRefreshGrant({
      familyId: claims.familyId,
      clientDigest: textDigest(clientId),
      scope: OAUTH_SCOPE,
      audience: this.#audience(),
      presentedGeneration: claims.generation,
      presentedTokenDigest: textDigest(refreshToken),
      nextGeneration,
      nextTokenDigest: textDigest(nextRefreshToken)
    });
    if (rotation.status === "corrupt") {
      throw new OAuthProtocolError(
        "server_error",
        "The OAuth token service could not validate stored grant state.",
        500
      );
    }
    if (rotation.status !== "rotated") throw invalidRefreshGrant();
    const grant = rotation.grant;
    if (grant.status !== "active"
      || grant.familyId !== claims.familyId
      || grant.clientDigest !== textDigest(clientId)
      || grant.contextDigest !== authContextDigest(grant.context)
      || grant.scope !== OAUTH_SCOPE
      || grant.audience !== this.#audience()
      || grant.currentGeneration !== nextGeneration
      || grant.currentTokenDigest !== textDigest(nextRefreshToken)
      || grant.expiresAt !== claims.exp
      || !isExactAuthContext(grant.context, "mcp")) {
      throw invalidRefreshGrant();
    }
    return this.#tokenResponse(grant.context, clientId, nextRefreshToken, now, grant.expiresAt);
  }

  async #createRefreshToken(
    clientId: string,
    context: AuthContext,
    now: number
  ): Promise<Readonly<{ token: string; expiresAt: number }>> {
    const expiresAt = now + this.#refreshTokenTtlSeconds;
    for (let attempt = 0; attempt < REFRESH_FAMILY_CREATION_ATTEMPTS; attempt += 1) {
      const familyId = this.#tokens.nonce(18);
      const refreshToken = this.#issueRefreshToken({
        familyId,
        generation: 0,
        issuedAt: now,
        expiresAt
      });
      const created = await this.#stateStore.createRefreshGrant({
        familyId,
        clientDigest: textDigest(clientId),
        context: cloneAuthContext(context),
        contextDigest: authContextDigest(context),
        scope: OAUTH_SCOPE,
        audience: this.#audience(),
        currentGeneration: 0,
        currentTokenDigest: textDigest(refreshToken),
        status: "active",
        expiresAt
      });
      if (created) return { token: refreshToken, expiresAt };
    }
    throw new OAuthProtocolError("server_error", "The OAuth token service could not allocate a grant.", 500);
  }

  #issueRefreshToken(input: {
    familyId: string;
    generation: number;
    issuedAt: number;
    expiresAt: number;
  }): string {
    return this.#tokens.issue({
      v: 1,
      purpose: REFRESH_TOKEN_PURPOSE,
      familyId: input.familyId,
      generation: input.generation,
      jti: this.#tokens.nonce(24),
      iat: input.issuedAt,
      exp: input.expiresAt
    });
  }

  #tokenResponse(
    context: AuthContext,
    clientId: string,
    refreshToken: string,
    now: number,
    refreshExpiresAt: number
  ): JsonRecord {
    const accessTokenTtlSeconds = Math.min(
      ACCESS_TOKEN_TTL_SECONDS,
      refreshExpiresAt - now
    );
    if (!Number.isSafeInteger(accessTokenTtlSeconds) || accessTokenTtlSeconds <= 0) {
      throw invalidRefreshGrant();
    }
    const accessToken = this.#tokens.issue({
      v: 1,
      purpose: "mcp-access",
      clientDigest: textDigest(clientId),
      context: cloneAuthContext({ ...context, client: "mcp" }),
      scope: OAUTH_SCOPE,
      aud: this.#audience(),
      iat: now,
      exp: now + accessTokenTtlSeconds
    });
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: accessTokenTtlSeconds,
      refresh_token: refreshToken,
      scope: OAUTH_SCOPE
    };
  }

  authenticate(request: Request): AuthContext | undefined {
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ")) return undefined;
    const claims = this.#tokens.verify(authorization.slice(7), "mcp-access");
    return isAccessTokenClaims(claims)
      && claims.aud === this.#audience()
      && claims.scope === OAUTH_SCOPE
      && isExactAuthContext(claims.context, "mcp")
      ? cloneAuthContext(claims.context)
      : undefined;
  }

  #registeredRedirect(clientId: string, redirectUri: string): boolean {
    const client = this.#tokens.verify(clientId, "oauth-client");
    return isOAuthClientClaims(client) && client.redirectUris.includes(redirectUri);
  }

  #registeredClient(clientId: string): boolean {
    const client = this.#tokens.verify(clientId, "oauth-client");
    return isOAuthClientClaims(client);
  }

  #requiredResource(input: URLSearchParams): string {
    const resources = input.getAll("resource");
    const audience = this.#audience();
    if (resources.length === 0 || resources.some(resource => resource !== audience)) {
      throw new OAuthProtocolError("invalid_target", "The OAuth resource must identify this MCP endpoint.");
    }
    return audience;
  }

  #audience(): string {
    return `${this.#baseUrl}/mcp`;
  }

}

function validateRegistrationValues(input: JsonRecord): void {
  if (input.grant_types !== undefined) {
    if (!Array.isArray(input.grant_types)
      || input.grant_types.length !== 2
      || !input.grant_types.includes("authorization_code")
      || !input.grant_types.includes("refresh_token")
      || new Set(input.grant_types).size !== 2) {
      throw new OAuthProtocolError("invalid_request", "grant_types must contain authorization_code and refresh_token exactly once.");
    }
  }
  if (input.response_types !== undefined
    && (!Array.isArray(input.response_types)
      || input.response_types.length !== 1
      || input.response_types[0] !== "code")) {
    throw new OAuthProtocolError("invalid_request", "Only response_type code is supported.");
  }
  if (input.token_endpoint_auth_method !== undefined && input.token_endpoint_auth_method !== "none") {
    throw new OAuthProtocolError("invalid_request", "Only public OAuth clients are supported.");
  }
}

function isOAuthClientClaims(value: JsonRecord | undefined): value is JsonRecord & {
  purpose: "oauth-client";
  redirectUris: string[];
  grantTypes: ["authorization_code", "refresh_token"];
  iat: number;
  exp: number;
} {
  return hasExactKeys(value, ["purpose", "redirectUris", "grantTypes", "iat", "exp"])
    && value.purpose === "oauth-client"
    && Array.isArray(value.redirectUris)
    && value.redirectUris.length > 0
    && value.redirectUris.length <= MAX_OAUTH_REDIRECT_URI_COUNT
    && value.redirectUris.every(item => typeof item === "string"
      && utf8ByteLength(item) <= MAX_OAUTH_REDIRECT_URI_BYTES
      && isSafeRedirectUri(item))
    && value.redirectUris.reduce((total, item) => total + utf8ByteLength(String(item)), 0) <= MAX_OAUTH_REDIRECT_URIS_TOTAL_BYTES
    && new Set(value.redirectUris).size === value.redirectUris.length
    && Array.isArray(value.grantTypes)
    && value.grantTypes.length === 2
    && value.grantTypes[0] === "authorization_code"
    && value.grantTypes[1] === "refresh_token"
    && Number.isSafeInteger(value.iat)
    && Number(value.iat) > 0
    && Number.isSafeInteger(value.exp)
    && Number(value.exp) > Number(value.iat);
}

function validateScope(value: string | null): void {
  if (value === null) return;
  const scopes = value.trim().split(/\s+/u).filter(Boolean);
  if (scopes.length !== 1 || scopes[0] !== OAUTH_SCOPE) {
    throw new OAuthProtocolError("invalid_scope", "Only the hunsu scope is supported.");
  }
}

function isRefreshTokenClaims(value: JsonRecord | undefined): value is JsonRecord & {
  v: 1;
  purpose: typeof REFRESH_TOKEN_PURPOSE;
  familyId: string;
  generation: number;
  jti: string;
  iat: number;
  exp: number;
} {
  return hasExactKeys(value, ["v", "purpose", "familyId", "generation", "jti", "iat", "exp"])
    && value.v === 1
    && value.purpose === REFRESH_TOKEN_PURPOSE
    && typeof value.familyId === "string"
    && /^[A-Za-z0-9_-]{24}$/u.test(value.familyId)
    && Number.isSafeInteger(value.generation)
    && Number(value.generation) >= 0
    && typeof value.jti === "string"
    && /^[A-Za-z0-9_-]{32}$/u.test(value.jti)
    && Number.isSafeInteger(value.iat)
    && Number(value.iat) > 0
    && Number.isSafeInteger(value.exp)
    && Number(value.exp) > Number(value.iat);
}

function isAccessTokenClaims(value: JsonRecord | undefined): value is JsonRecord & {
  v: 1;
  purpose: "mcp-access";
  clientDigest: string;
  context: AuthContext;
  scope: typeof OAUTH_SCOPE;
  aud: string;
  iat: number;
  exp: number;
} {
  return hasExactKeys(value, ["v", "purpose", "clientDigest", "context", "scope", "aud", "iat", "exp"])
    && value.v === 1
    && value.purpose === "mcp-access"
    && typeof value.clientDigest === "string"
    && /^[A-Za-z0-9_-]{43}$/u.test(value.clientDigest)
    && isExactAuthContext(value.context, "mcp")
    && value.scope === OAUTH_SCOPE
    && typeof value.aud === "string"
    && Number.isSafeInteger(value.iat)
    && Number(value.iat) > 0
    && Number.isSafeInteger(value.exp)
    && Number(value.exp) > Number(value.iat);
}

function invalidRefreshGrant(): OAuthProtocolError {
  return new OAuthProtocolError("invalid_grant", "The refresh token is invalid, expired, revoked, or already used.");
}

function requiredParam(url: URL, name: string): string {
  const values = url.searchParams.getAll(name);
  if (values.length !== 1 || !values[0]) {
    throw new OAuthProtocolError("invalid_request", `${name} must occur exactly once.`);
  }
  return values[0];
}

function optionalParam(url: URL, name: string): string | null {
  const values = url.searchParams.getAll(name);
  if (values.length > 1) throw new OAuthProtocolError("invalid_request", `${name} must not be duplicated.`);
  return values[0] ?? null;
}

function requiredForm(input: URLSearchParams, name: string): string {
  const values = input.getAll(name);
  if (values.length !== 1 || !values[0]) {
    throw new OAuthProtocolError("invalid_request", `${name} must occur exactly once.`);
  }
  return values[0];
}

function optionalForm(input: URLSearchParams, name: string): string | null {
  const values = input.getAll(name);
  if (values.length > 1) throw new OAuthProtocolError("invalid_request", `${name} must not be duplicated.`);
  return values[0] ?? null;
}

function rejectConfidentialClientAuthentication(input: URLSearchParams, authorization?: string | null): void {
  const credentialParameters = ["client_secret", "client_assertion", "client_assertion_type"] as const;
  if (credentialParameters.some(name => input.getAll(name).length > 1)
    || (authorization !== undefined
      && authorization !== null
      && credentialParameters.some(name => input.has(name)))) {
    throw new OAuthProtocolError("invalid_request", "The token request must use exactly one client authentication method.");
  }
  if (authorization !== undefined && authorization !== null) {
    const scheme = authorizationScheme(authorization);
    if (scheme === undefined) {
      throw new OAuthProtocolError("invalid_request", "The client Authorization header is malformed.");
    }
    throw new OAuthProtocolError(
      "invalid_client",
      "The token endpoint accepts public clients only.",
      401,
      `${scheme} realm="hunsu-oauth"`
    );
  }
  if (credentialParameters.some(name => input.has(name))) {
    throw new OAuthProtocolError("invalid_client", "Client-secret authentication is not supported.");
  }
}

function authorizationScheme(value: string): string | undefined {
  const match = value.trimStart().match(/^([!#$%&'*+\-.^_`|~0-9A-Za-z]+)(?:[ \t]|$)/u);
  return match?.[1];
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

function isSafeRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.hash || url.username || url.password) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "localhost");
  } catch {
    return false;
  }
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function constantTextEqual(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left, "utf8").digest();
  const rightHash = createHash("sha256").update(right, "utf8").digest();
  return leftHash.equals(rightHash);
}

function textDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

function cloneAuthContext(context: AuthContext): AuthContext {
  return {
    subject: context.subject,
    user: { ...context.user },
    installations: context.installations.map(item => ({
      id: item.id,
      accountLogin: item.accountLogin,
      accountType: item.accountType,
      repositories: item.repositories.map(repository => ({
        repositoryId: repository.repositoryId,
        permissions: { contents: repository.permissions.contents }
      }))
    })),
    ...(context.selectedInstallationId === undefined ? {} : { selectedInstallationId: context.selectedInstallationId }),
    client: context.client
  };
}

function seconds(now: () => number): number {
  return Math.floor(now() / 1000);
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: unknown, required: readonly string[]): value is JsonRecord {
  return isRecord(value)
    && Object.keys(value).length === required.length
    && required.every(key => Object.hasOwn(value, key));
}
