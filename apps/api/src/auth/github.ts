import { createSign } from "node:crypto";
import type { GitHubAppConfig } from "@hunsu/config";
import { err, ok, type Result } from "@hunsu/protocol";
import type { AuthorizedInstallation, GitHubUser } from "../types.ts";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const GITHUB_API_VERSION = "2026-03-10";

export class GitHubAppTokenProvider {
  readonly #appId: number;
  readonly #privateKey: string;
  readonly #fetch: FetchLike;
  readonly #apiBaseUrl: string;
  readonly #now: () => number;
  readonly #cache = new Map<number, { token: string; expiresAt: number }>();

  constructor(input: {
    appId: number;
    privateKey: string;
    fetch?: FetchLike;
    apiBaseUrl?: string;
    now?: () => number;
  }) {
    this.#appId = input.appId;
    this.#privateKey = input.privateKey;
    this.#fetch = input.fetch ?? globalThis.fetch;
    this.#apiBaseUrl = (input.apiBaseUrl ?? "https://api.github.com").replace(/\/$/u, "");
    this.#now = input.now ?? (() => Date.now());
  }

  getToken = async (installationId: number): Promise<string> => {
    if (!Number.isSafeInteger(installationId) || installationId <= 0) throw new Error("Invalid GitHub installation id.");
    const now = Math.floor(this.#now() / 1000);
    const cached = this.#cache.get(installationId);
    if (cached && cached.expiresAt - 60 > now) return cached.token;

    const response = await this.#fetch(`${this.#apiBaseUrl}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.#appJwt(now)}`,
        "content-type": "application/json",
        "x-github-api-version": GITHUB_API_VERSION
      },
      body: JSON.stringify({ permissions: { contents: "write" } })
    });
    const body = await readJson(response);
    if (!response.ok
      || !isRecord(body)
      || typeof body.token !== "string"
      || body.token.length === 0
      || typeof body.expires_at !== "string") {
      throw new Error(`GitHub installation token request failed with ${response.status}.`);
    }
    if (!isRecord(body.permissions) || body.permissions.contents !== "write") {
      throw new Error("GitHub installation token is missing the required Contents write permission.");
    }
    const expiresAt = Math.floor(Date.parse(body.expires_at) / 1000);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) throw new Error("GitHub returned an already-expired installation token.");
    this.#cache.set(installationId, { token: body.token, expiresAt });
    return body.token;
  };

  invalidate(installationId: number): void {
    this.#cache.delete(installationId);
  }

  #appJwt(now: number): string {
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" }), "utf8").toString("base64url");
    const claims = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(this.#appId) }), "utf8").toString("base64url");
    const input = `${header}.${claims}`;
    const signer = createSign("RSA-SHA256");
    signer.update(input, "utf8");
    signer.end();
    return `${input}.${signer.sign(this.#privateKey).toString("base64url")}`;
  }
}

export type GitHubOAuthIdentity = {
  user: GitHubUser;
  installations: AuthorizedInstallation[];
};

export type GitHubOAuthFailureStage =
  | "code_exchange"
  | "user_lookup"
  | "installation_lookup"
  | "repository_lookup";

export type GitHubOAuthFailureReason = "transport" | "upstream_response" | "invalid_payload";

export type GitHubOAuthProviderCode =
  | "bad_verification_code"
  | "incorrect_client_credentials"
  | "redirect_uri_mismatch"
  | "unverified_user_email";

export type GitHubOAuthFailure = {
  type: "GitHubOAuthFailure";
  stage: GitHubOAuthFailureStage;
  reason: GitHubOAuthFailureReason;
  upstreamStatus: number | null;
  providerCode: GitHubOAuthProviderCode | null;
};

export type GitHubOAuthResult = Result<GitHubOAuthIdentity, GitHubOAuthFailure>;

export class GitHubOAuthClient {
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #publicApiUrl: string;
  readonly #fetch: FetchLike;
  readonly #apiBaseUrl: string;
  readonly #webBaseUrl: string;

  constructor(input: {
    clientId: string;
    clientSecret: string;
    publicApiUrl: string;
    fetch?: FetchLike;
    apiBaseUrl?: string;
    webBaseUrl?: string;
  }) {
    this.#clientId = input.clientId;
    this.#clientSecret = input.clientSecret;
    this.#publicApiUrl = input.publicApiUrl.replace(/\/$/u, "");
    this.#fetch = input.fetch ?? globalThis.fetch;
    this.#apiBaseUrl = (input.apiBaseUrl ?? "https://api.github.com").replace(/\/$/u, "");
    this.#webBaseUrl = (input.webBaseUrl ?? "https://github.com").replace(/\/$/u, "");
  }

  authorizationUrl(state: string, codeChallenge: string): string {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(codeChallenge)) throw new Error("GitHub OAuth PKCE challenge must be an S256 base64url value.");
    const url = new URL(`${this.#webBaseUrl}/login/oauth/authorize`);
    url.searchParams.set("client_id", this.#clientId);
    url.searchParams.set("redirect_uri", `${this.#publicApiUrl}/api/auth/github/callback`);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  async authenticate(code: string, codeVerifier: string): Promise<GitHubOAuthResult> {
    if (!/^[A-Za-z0-9_-]{43,128}$/u.test(codeVerifier)) {
      return err(oauthFailure({ stage: "code_exchange", reason: "invalid_payload", upstreamStatus: null }));
    }
    const tokenResponseResult = await this.#request("code_exchange", `${this.#webBaseUrl}/login/oauth/access_token`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.#clientId,
        client_secret: this.#clientSecret,
        code,
        redirect_uri: `${this.#publicApiUrl}/api/auth/github/callback`,
        code_verifier: codeVerifier
      }).toString()
    });
    if (!tokenResponseResult.ok) return tokenResponseResult;
    const tokenResponse = tokenResponseResult.value;
    const tokenBody = await readJson(tokenResponse);
    const providerRejected = isRecord(tokenBody) && typeof tokenBody.error === "string";
    const providerCode = decodeProviderCode(tokenBody);
    if (!tokenResponse.ok || providerRejected) {
      return err(oauthFailure({
        stage: "code_exchange",
        reason: "upstream_response",
        upstreamStatus: tokenResponse.status,
        providerCode
      }));
    }
    if (!isRecord(tokenBody)
      || typeof tokenBody.access_token !== "string"
      || tokenBody.access_token.length === 0) {
      return err(oauthFailure({
        stage: "code_exchange",
        reason: "invalid_payload",
        upstreamStatus: tokenResponse.status
      }));
    }
    const accessToken = tokenBody.access_token;
    const [userResponseResult, installationsResult] = await Promise.all([
      this.#githubRequest("user_lookup", "/user", accessToken),
      this.#listInstallations(accessToken)
    ]);
    if (!userResponseResult.ok) return userResponseResult;
    if (!installationsResult.ok) return installationsResult;
    const userResponse = userResponseResult.value;
    if (!userResponse.ok) {
      return err(oauthFailure({ stage: "user_lookup", reason: "upstream_response", upstreamStatus: userResponse.status }));
    }
    const userBody = await readJson(userResponse);
    const user = decodeUser(userBody);
    if (!user) {
      return err(oauthFailure({ stage: "user_lookup", reason: "invalid_payload", upstreamStatus: userResponse.status }));
    }
    const authorizedInstallations: AuthorizedInstallation[] = [];
    for (const installation of installationsResult.value) {
      const repositories = await this.#listUserInstallationRepositories(installation.id, accessToken);
      if (!repositories.ok) return repositories;
      authorizedInstallations.push({ ...installation, repositories: repositories.value });
    }
    return ok({ user, installations: authorizedInstallations });
  }

  async #listInstallations(token: string): Promise<Result<Array<Omit<AuthorizedInstallation, "repositories">>, GitHubOAuthFailure>> {
    const installations: Array<Omit<AuthorizedInstallation, "repositories">> = [];
    const seen = new Set<number>();
    for (let page = 1; ; page += 1) {
      const responseResult = await this.#githubRequest("installation_lookup", `/user/installations?per_page=100&page=${page}`, token);
      if (!responseResult.ok) return responseResult;
      const response = responseResult.value;
      if (!response.ok) {
        return err(oauthFailure({ stage: "installation_lookup", reason: "upstream_response", upstreamStatus: response.status }));
      }
      const body = await readJson(response);
      const decoded = decodeInstallations(body);
      if (!decoded) {
        return err(oauthFailure({ stage: "installation_lookup", reason: "invalid_payload", upstreamStatus: response.status }));
      }
      for (const installation of decoded) {
        if (seen.has(installation.id)) {
          return err(oauthFailure({ stage: "installation_lookup", reason: "invalid_payload", upstreamStatus: response.status }));
        }
        seen.add(installation.id);
        installations.push(installation);
      }
      if (decoded.length < 100) return ok(installations);
    }
  }

  async #listUserInstallationRepositories(
    installationId: number,
    token: string
  ): Promise<Result<AuthorizedInstallation["repositories"], GitHubOAuthFailure>> {
    const repositories: AuthorizedInstallation["repositories"][number][] = [];
    const seen = new Set<number>();
    for (let page = 1; ; page += 1) {
      const responseResult = await this.#githubRequest(
        "repository_lookup",
        `/user/installations/${installationId}/repositories?per_page=100&page=${page}`,
        token
      );
      if (!responseResult.ok) return responseResult;
      const response = responseResult.value;
      if (!response.ok) {
        return err(oauthFailure({ stage: "repository_lookup", reason: "upstream_response", upstreamStatus: response.status }));
      }
      const body = await readJson(response);
      const decoded = decodeRepositoryAccesses(body);
      if (!decoded) {
        return err(oauthFailure({ stage: "repository_lookup", reason: "invalid_payload", upstreamStatus: response.status }));
      }
      for (const repository of decoded) {
        if (seen.has(repository.repositoryId)) {
          return err(oauthFailure({ stage: "repository_lookup", reason: "invalid_payload", upstreamStatus: response.status }));
        }
        seen.add(repository.repositoryId);
        repositories.push(repository);
      }
      if (decoded.length < 100) return ok(repositories);
    }
  }

  #githubRequest(
    stage: Exclude<GitHubOAuthFailureStage, "code_exchange">,
    path: string,
    token: string
  ): Promise<Result<Response, GitHubOAuthFailure>> {
    return this.#request(stage, `${this.#apiBaseUrl}${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": GITHUB_API_VERSION
      }
    });
  }

  async #request(stage: GitHubOAuthFailureStage, input: string, init: RequestInit): Promise<Result<Response, GitHubOAuthFailure>> {
    try {
      return ok(await this.#fetch(input, init));
    } catch {
      return err(oauthFailure({ stage, reason: "transport", upstreamStatus: null }));
    }
  }
}

export function createGitHubAuth(config: GitHubAppConfig, fetch?: FetchLike): {
  tokenProvider: GitHubAppTokenProvider;
  oauthClient: GitHubOAuthClient;
} {
  return {
    tokenProvider: new GitHubAppTokenProvider({ appId: config.appId, privateKey: config.privateKey, fetch }),
    oauthClient: new GitHubOAuthClient({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      publicApiUrl: config.publicApiUrl,
      fetch
    })
  };
}

function decodeUser(value: unknown): GitHubUser | undefined {
  if (!isRecord(value)
    || (!Number.isSafeInteger(value.id) && (typeof value.id !== "string" || value.id.length === 0))
    || (typeof value.id === "number" && value.id <= 0)
    || typeof value.login !== "string"
    || value.login.length === 0) return undefined;
  return {
    id: String(value.id),
    login: value.login,
    ...(typeof value.name === "string" && value.name ? { name: value.name } : {}),
    ...(typeof value.avatar_url === "string" ? { avatarUrl: value.avatar_url } : {})
  };
}

function decodeInstallations(value: unknown): Array<Omit<AuthorizedInstallation, "repositories">> | undefined {
  if (!isRecord(value) || !Array.isArray(value.installations)) return undefined;
  const result: Array<Omit<AuthorizedInstallation, "repositories">> = [];
  for (const installation of value.installations) {
    if (!isRecord(installation)
      || !Number.isSafeInteger(installation.id)
      || Number(installation.id) <= 0
      || !isRecord(installation.account)
      || typeof installation.account.login !== "string"
      || installation.account.login.length === 0) return undefined;
    const rawType = typeof installation.account.type === "string" ? installation.account.type.toLowerCase() : "";
    if (rawType !== "organization" && rawType !== "user") return undefined;
    result.push({ id: installation.id as number, accountLogin: installation.account.login, accountType: rawType });
  }
  return result;
}

function decodeRepositoryAccesses(value: unknown): AuthorizedInstallation["repositories"] | undefined {
  if (!isRecord(value) || !Array.isArray(value.repositories)) return undefined;
  const repositories: AuthorizedInstallation["repositories"][number][] = [];
  for (const repository of value.repositories) {
    if (!isRecord(repository)
      || !Number.isSafeInteger(repository.id)
      || Number(repository.id) <= 0
      || !isRecord(repository.permissions)
      || typeof repository.permissions.pull !== "boolean"
      || typeof repository.permissions.push !== "boolean"
      || typeof repository.permissions.admin !== "boolean") return undefined;
    if (!repository.permissions.pull && !repository.permissions.push && !repository.permissions.admin) return undefined;
    repositories.push({
      repositoryId: repository.id as number,
      permissions: {
        contents: repository.permissions.push || repository.permissions.admin ? "write" : "read"
      }
    });
  }
  return repositories;
}

function decodeProviderCode(value: unknown): GitHubOAuthProviderCode | null {
  if (!isRecord(value) || typeof value.error !== "string") return null;
  if (value.error === "bad_verification_code"
    || value.error === "incorrect_client_credentials"
    || value.error === "redirect_uri_mismatch"
    || value.error === "unverified_user_email") return value.error;
  return null;
}

function oauthFailure(input: {
  stage: GitHubOAuthFailureStage;
  reason: GitHubOAuthFailureReason;
  upstreamStatus: number | null;
  providerCode?: GitHubOAuthProviderCode | null;
}): GitHubOAuthFailure {
  return {
    type: "GitHubOAuthFailure",
    stage: input.stage,
    reason: input.reason,
    upstreamStatus: input.upstreamStatus,
    providerCode: input.providerCode ?? null
  };
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => undefined) as Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
