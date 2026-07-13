import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { SessionConfig } from "@hunsu/config";
import type { AuthContext, AuthorizedInstallation, GitHubUser } from "../types.ts";

type JsonRecord = Record<string, unknown>;

export type SessionClaims = {
  v: 1;
  purpose: "web-session";
  sub: string;
  user: GitHubUser;
  installations: AuthorizedInstallation[];
  selectedInstallationId?: number;
  iat: number;
  exp: number;
};

export class SignedTokenService {
  readonly #secret: string;
  readonly #now: () => number;

  constructor(secret: string, now: () => number = () => Date.now()) {
    if (Buffer.byteLength(secret, "utf8") < 32) throw new Error("Signed token secret must contain at least 32 bytes.");
    this.#secret = secret;
    this.#now = now;
  }

  issue(payload: JsonRecord): string {
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = this.#signature(encoded);
    return `${encoded}.${signature}`;
  }

  verify(token: string, purpose: string): JsonRecord | undefined {
    const [encoded, provided, extra] = token.split(".");
    if (!encoded || !provided || extra !== undefined) return undefined;
    const expected = this.#signature(encoded);
    const expectedBytes = Buffer.from(expected, "ascii");
    const providedBytes = Buffer.from(provided, "ascii");
    if (expectedBytes.length !== providedBytes.length || !timingSafeEqual(expectedBytes, providedBytes)) return undefined;
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
    } catch {
      return undefined;
    }
    if (!isRecord(payload) || payload.purpose !== purpose || typeof payload.exp !== "number" || payload.exp <= Math.floor(this.#now() / 1000)) {
      return undefined;
    }
    return payload;
  }

  nonce(bytes = 24): string {
    return randomBytes(bytes).toString("base64url");
  }

  #signature(encoded: string): string {
    return createHmac("sha256", this.#secret).update(encoded, "utf8").digest("base64url");
  }
}

export class SessionManager {
  readonly config: SessionConfig;
  readonly tokens: SignedTokenService;
  readonly #now: () => number;

  constructor(config: SessionConfig, now: () => number = () => Date.now()) {
    this.config = config;
    this.#now = now;
    this.tokens = new SignedTokenService(config.secret, now);
  }

  issue(input: {
    user: GitHubUser;
    installations: readonly AuthorizedInstallation[];
    selectedInstallationId?: number;
  }): { token: string; cookie: string; claims: SessionClaims } {
    const now = Math.floor(this.#now() / 1000);
    const claims: SessionClaims = {
      v: 1,
      purpose: "web-session",
      sub: `github:${input.user.id}`,
      user: structuredClone(input.user),
      installations: input.installations.map(cloneInstallation),
      ...(input.selectedInstallationId ? { selectedInstallationId: input.selectedInstallationId } : {}),
      iat: now,
      exp: now + this.config.ttlSeconds
    };
    if (!isSessionClaims(claims as unknown as JsonRecord)) throw new Error("Cannot issue a session with an invalid GitHub authorization context.");
    const token = this.tokens.issue(claims as unknown as JsonRecord);
    return { token, cookie: this.cookie(token, this.config.ttlSeconds), claims };
  }

  authenticate(request: Request): AuthContext | undefined {
    const token = cookieValue(request.headers.get("cookie"), this.config.cookieName);
    if (!token) return undefined;
    const claims = this.tokens.verify(token, "web-session");
    return claims && isSessionClaims(claims)
      ? {
          subject: String(claims.sub),
          user: claims.user as GitHubUser,
          installations: claims.installations as AuthorizedInstallation[],
          ...(typeof claims.selectedInstallationId === "number" ? { selectedInstallationId: claims.selectedInstallationId } : {}),
          client: "web"
        }
      : undefined;
  }

  clearCookie(): string {
    return this.cookie("", 0);
  }

  transientCookie(name: string, value: string, maxAgeSeconds: number): string {
    return serializeCookie(name, value, {
      maxAgeSeconds,
      secure: this.config.secure,
      sameSite: "Lax",
      path: "/",
      httpOnly: true
    });
  }

  readCookie(request: Request, name: string): string | undefined {
    return cookieValue(request.headers.get("cookie"), name);
  }

  #cookie(value: string, maxAgeSeconds: number): string {
    return serializeCookie(this.config.cookieName, value, {
      maxAgeSeconds,
      secure: this.config.secure,
      sameSite: "Lax",
      path: "/",
      httpOnly: true
    });
  }

  private cookie(value: string, maxAgeSeconds: number): string {
    return this.#cookie(value, maxAgeSeconds);
  }
}

function isSessionClaims(value: JsonRecord): boolean {
  return value.v === 1
    && value.purpose === "web-session"
    && typeof value.sub === "string"
    && isGitHubUser(value.user)
    && Array.isArray(value.installations)
    && value.installations.every(isInstallation)
    && uniqueInstallationIds(value.installations)
    && (value.selectedInstallationId === undefined
      || (Number.isSafeInteger(value.selectedInstallationId)
        && Number(value.selectedInstallationId) > 0
        && value.installations.some(item => isRecord(item) && item.id === value.selectedInstallationId)));
}

function isGitHubUser(value: unknown): value is GitHubUser {
  return isRecord(value)
    && typeof value.id === "string"
    && value.id.length > 0
    && typeof value.login === "string"
    && value.login.length > 0
    && (value.name === undefined || typeof value.name === "string")
    && (value.avatarUrl === undefined || typeof value.avatarUrl === "string");
}

function isInstallation(value: unknown): value is AuthorizedInstallation {
  return isRecord(value)
    && Number.isSafeInteger(value.id)
    && Number(value.id) > 0
    && typeof value.accountLogin === "string"
    && value.accountLogin.length > 0
    && (value.accountType === "organization" || value.accountType === "user")
    && Array.isArray(value.repositories)
    && value.repositories.every(isRepositoryAccess)
    && uniqueRepositoryIds(value.repositories);
}

function isRepositoryAccess(value: unknown): boolean {
  return isRecord(value)
    && Number.isSafeInteger(value.repositoryId)
    && Number(value.repositoryId) > 0
    && isRecord(value.permissions)
    && (value.permissions.contents === "read" || value.permissions.contents === "write");
}

function uniqueInstallationIds(installations: readonly unknown[]): boolean {
  const ids = installations.flatMap(item => isRecord(item) && Number.isSafeInteger(item.id) ? [Number(item.id)] : []);
  return ids.length === installations.length && new Set(ids).size === ids.length;
}

function uniqueRepositoryIds(repositories: readonly unknown[]): boolean {
  const ids = repositories.flatMap(item => isRecord(item) && Number.isSafeInteger(item.repositoryId) ? [Number(item.repositoryId)] : []);
  return ids.length === repositories.length && new Set(ids).size === ids.length;
}

function cloneInstallation(installation: AuthorizedInstallation): AuthorizedInstallation {
  return {
    id: installation.id,
    accountLogin: installation.accountLogin,
    accountType: installation.accountType,
    repositories: installation.repositories.map(repository => ({
      repositoryId: repository.repositoryId,
      permissions: { contents: repository.permissions.contents }
    }))
  };
}

function serializeCookie(
  name: string,
  value: string,
  options: { maxAgeSeconds: number; secure: boolean; sameSite: "Lax"; path: string; httpOnly: boolean }
): string {
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(name)) throw new Error("Invalid cookie name.");
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`,
    `Path=${options.path}`,
    `SameSite=${options.sameSite}`
  ];
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

function cookieValue(header: string | null, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
