import { createHash } from "node:crypto";
import type { AuthContext } from "../types.ts";
import type { EphemeralStateStore } from "./ephemeral-store.ts";
import { SignedTokenService } from "./session.ts";

type JsonRecord = Record<string, unknown>;

export type OAuthConsentRequest = {
  token: string;
  clientOrigin: string;
};

export class OAuthProtocolError extends Error {
  readonly code: "invalid_request" | "invalid_client" | "invalid_grant" | "unsupported_grant_type";
  readonly status: number;

  constructor(
    code: "invalid_request" | "invalid_client" | "invalid_grant" | "unsupported_grant_type",
    message: string,
    status = 400
  ) {
    super(message);
    this.name = "OAuthProtocolError";
    this.code = code;
    this.status = status;
  }
}

export class McpOAuthService {
  readonly #baseUrl: string;
  readonly #tokens: SignedTokenService;
  readonly #now: () => number;
  readonly #stateStore: EphemeralStateStore;

  constructor(input: {
    baseUrl: string;
    secret: string;
    stateStore: EphemeralStateStore;
    now?: () => number;
  }) {
    this.#baseUrl = input.baseUrl.replace(/\/$/u, "");
    this.#now = input.now ?? (() => Date.now());
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
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["hunsu"]
    };
  }

  register(input: unknown): JsonRecord {
    if (!isRecord(input) || !Array.isArray(input.redirect_uris) || input.redirect_uris.length === 0) {
      throw new OAuthProtocolError("invalid_request", "redirect_uris must contain at least one redirect URI.");
    }
    const redirectUris = input.redirect_uris.map(value => {
      if (typeof value !== "string" || !isSafeRedirectUri(value)) throw new OAuthProtocolError("invalid_request", "A redirect URI is invalid.");
      return value;
    });
    const now = seconds(this.#now);
    const clientId = this.#tokens.issue({
      purpose: "oauth-client",
      redirectUris,
      iat: now,
      exp: now + 365 * 24 * 60 * 60
    });
    return {
      client_id: clientId,
      client_id_issued_at: now,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"]
    };
  }

  async createConsentRequest(url: URL, context: AuthContext, sessionToken: string): Promise<OAuthConsentRequest> {
    if (!sessionToken || context.client !== "web") throw new OAuthProtocolError("invalid_request", "The Web session is missing or expired.", 401);
    if (url.searchParams.get("response_type") !== "code") throw new OAuthProtocolError("invalid_request", "Only response_type=code is supported.");
    const clientId = requiredParam(url, "client_id");
    const redirectUri = requiredParam(url, "redirect_uri");
    const state = url.searchParams.get("state");
    const challenge = requiredParam(url, "code_challenge");
    if (url.searchParams.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/u.test(challenge)) {
      throw new OAuthProtocolError("invalid_request", "OAuth authorization requires PKCE S256.");
    }
    const client = this.#tokens.verify(clientId, "oauth-client");
    if (!client || !Array.isArray(client.redirectUris) || !client.redirectUris.includes(redirectUri)) {
      throw new OAuthProtocolError("invalid_client", "The OAuth client or redirect URI is not registered.", 401);
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
      || typeof claims.contextDigest !== "string"
      || typeof claims.sessionDigest !== "string"
      || (claims.state !== undefined && typeof claims.state !== "string")
      || claims.contextDigest !== authContextDigest(context)
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
      context: cloneAuthContext(context),
      expiresAt: now + 300
    });
    redirect.searchParams.set("code", code);
    return redirect.toString();
  }

  async exchange(input: URLSearchParams): Promise<JsonRecord> {
    if (input.get("grant_type") !== "authorization_code") throw new OAuthProtocolError("unsupported_grant_type", "Only authorization_code is supported.");
    const code = requiredForm(input, "code");
    const clientId = requiredForm(input, "client_id");
    const redirectUri = requiredForm(input, "redirect_uri");
    const verifier = requiredForm(input, "code_verifier");
    if (!/^[A-Za-z0-9._~-]{43,128}$/u.test(verifier)) throw new OAuthProtocolError("invalid_grant", "The PKCE verifier is invalid.");
    const now = seconds(this.#now);
    const pending = await this.#stateStore.consumeAuthorizationCode(code);
    if (!pending
      || pending.clientId !== clientId
      || pending.redirectUri !== redirectUri
      || !constantTextEqual(pkceChallenge(verifier), pending.challenge)
    ) {
      throw new OAuthProtocolError("invalid_grant", "The authorization code is invalid, expired, or already used.");
    }
    const accessToken = this.#tokens.issue({
      purpose: "mcp-access",
      context: { ...pending.context, client: "mcp" },
      scope: "hunsu",
      aud: `${this.#baseUrl}/mcp`,
      iat: now,
      exp: now + 3600
    });
    return { access_token: accessToken, token_type: "Bearer", expires_in: 3600, scope: "hunsu" };
  }

  authenticate(request: Request): AuthContext | undefined {
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ")) return undefined;
    const claims = this.#tokens.verify(authorization.slice(7), "mcp-access");
    return claims && claims.aud === `${this.#baseUrl}/mcp` && isAuthContext(claims.context)
      ? { ...claims.context, client: "mcp" }
      : undefined;
  }

  #registeredRedirect(clientId: string, redirectUri: string): boolean {
    const client = this.#tokens.verify(clientId, "oauth-client");
    return Boolean(client && Array.isArray(client.redirectUris) && client.redirectUris.includes(redirectUri));
  }

}

function requiredParam(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (!value) throw new OAuthProtocolError("invalid_request", `${name} is required.`);
  return value;
}

function requiredForm(input: URLSearchParams, name: string): string {
  const value = input.get(name);
  if (!value) throw new OAuthProtocolError("invalid_request", `${name} is required.`);
  return value;
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

function isAuthContext(value: unknown): value is AuthContext {
  return isRecord(value)
    && typeof value.subject === "string"
    && value.subject.length > 0
    && (value.client === "web" || value.client === "mcp")
    && isRecord(value.user)
    && typeof value.user.id === "string"
    && value.user.id.length > 0
    && typeof value.user.login === "string"
    && value.user.login.length > 0
    && (value.user.name === undefined || typeof value.user.name === "string")
    && (value.user.avatarUrl === undefined || typeof value.user.avatarUrl === "string")
    && Array.isArray(value.installations)
    && value.installations.every(isInstallation)
    && uniqueIds(value.installations, "id")
    && (value.selectedInstallationId === undefined
      || (Number.isSafeInteger(value.selectedInstallationId)
        && Number(value.selectedInstallationId) > 0
        && value.installations.some(item => isRecord(item) && item.id === value.selectedInstallationId)));
}

function isInstallation(value: unknown): boolean {
  return isRecord(value)
    && Number.isSafeInteger(value.id)
    && Number(value.id) > 0
    && typeof value.accountLogin === "string"
    && value.accountLogin.length > 0
    && (value.accountType === "organization" || value.accountType === "user")
    && Array.isArray(value.repositories)
    && value.repositories.every(repository => isRecord(repository)
      && Number.isSafeInteger(repository.repositoryId)
      && Number(repository.repositoryId) > 0
      && isRecord(repository.permissions)
      && (repository.permissions.contents === "read" || repository.permissions.contents === "write"))
    && uniqueIds(value.repositories, "repositoryId");
}

function uniqueIds(values: readonly unknown[], key: "id" | "repositoryId"): boolean {
  const ids = values.flatMap(value => isRecord(value) && Number.isSafeInteger(value[key]) ? [Number(value[key])] : []);
  return ids.length === values.length && new Set(ids).size === ids.length;
}

function constantTextEqual(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left, "utf8").digest();
  const rightHash = createHash("sha256").update(right, "utf8").digest();
  return leftHash.equals(rightHash);
}

function authContextDigest(context: AuthContext): string {
  return textDigest(JSON.stringify({
    subject: context.subject,
    user: context.user,
    installations: [...context.installations]
      .map(item => ({
        id: item.id,
        accountLogin: item.accountLogin,
        accountType: item.accountType,
        repositories: [...item.repositories]
          .map(repository => ({
            repositoryId: repository.repositoryId,
            permissions: { contents: repository.permissions.contents }
          }))
          .sort((left, right) => left.repositoryId - right.repositoryId)
      }))
      .sort((left, right) => left.id - right.id || left.accountLogin.localeCompare(right.accountLogin)),
    ...(context.selectedInstallationId === undefined ? {} : { selectedInstallationId: context.selectedInstallationId }),
    client: context.client
  }));
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
