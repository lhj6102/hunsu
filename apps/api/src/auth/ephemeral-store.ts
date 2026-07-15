import { err, ok, type Result } from "@hunsu/protocol";
import { createHash } from "node:crypto";
import type { AuthContext } from "../types.ts";

const AUTHORIZATION_CODE_SCHEMA = "hunsu.ephemeral-authorization-code.v1";
const REFRESH_GRANT_SCHEMA = "hunsu.ephemeral-refresh-grant.v1";
const REFRESH_ROTATION_SCHEMA = "hunsu.ephemeral-refresh-rotation.v1";

export type ConsentState = Readonly<{
  id: string;
  expiresAt: number;
}>;

export type PendingAuthorizationCode = Readonly<{
  clientId: string;
  redirectUri: string;
  challenge: string;
  audience: string;
  context: AuthContext;
  expiresAt: number;
}>;

export type RefreshGrant = Readonly<{
  familyId: string;
  clientDigest: string;
  context: AuthContext;
  contextDigest: string;
  scope: "hunsu";
  audience: string;
  currentGeneration: number;
  currentTokenDigest: string;
  status: "active" | "revoked";
  expiresAt: number;
}>;

export type RefreshGrantRotation = Readonly<{
  familyId: string;
  clientDigest: string;
  scope: "hunsu";
  audience: string;
  presentedGeneration: number;
  presentedTokenDigest: string;
  nextGeneration: number;
  nextTokenDigest: string;
}>;

export type RefreshGrantRotationResult =
  | Readonly<{ status: "rotated"; grant: RefreshGrant }>
  | Readonly<{ status: "corrupt" | "expired" | "invalid" | "missing" | "replayed" | "revoked" }>;

export interface EphemeralStateStore {
  createConsent(input: ConsentState): Promise<void>;
  consumeConsent(id: string): Promise<boolean>;

  createAuthorizationCode(code: string, input: PendingAuthorizationCode): Promise<void>;
  consumeAuthorizationCode(code: string): Promise<PendingAuthorizationCode | undefined>;

  createRefreshGrant(input: RefreshGrant): Promise<boolean>;
  rotateRefreshGrant(input: RefreshGrantRotation): Promise<RefreshGrantRotationResult>;

  claimWebhookDelivery(deliveryId: string, expiresAt: number): Promise<boolean>;
  completeWebhookDelivery(
    deliveryId: string,
    leaseExpiresAt: number,
    completedExpiresAt: number
  ): Promise<boolean>;
  releaseWebhookDelivery(deliveryId: string, leaseExpiresAt: number): Promise<boolean>;
}

export type EphemeralStateDecodeError = Readonly<{
  code: "invalid_ephemeral_state";
  message: string;
}>;

export function decodePendingAuthorizationCode(
  input: unknown
): Result<PendingAuthorizationCode, EphemeralStateDecodeError> {
  if (!hasExactKeys(input, [
    "schema",
    "clientId",
    "redirectUri",
    "challenge",
    "audience",
    "context",
    "expiresAt"
  ])
    || input.schema !== AUTHORIZATION_CODE_SCHEMA
    || typeof input.clientId !== "string"
    || input.clientId.length === 0
    || typeof input.redirectUri !== "string"
    || input.redirectUri.length === 0
    || typeof input.challenge !== "string"
    || !/^[A-Za-z0-9_-]{43,128}$/u.test(input.challenge)
    || typeof input.audience !== "string"
    || !isSafeAudience(input.audience)
    || !isExactAuthContext(input.context)
    || !isExpiry(input.expiresAt)) {
    return err({
      code: "invalid_ephemeral_state",
      message: "Stored OAuth authorization-code state is invalid."
    });
  }

  return ok({
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    challenge: input.challenge,
    audience: input.audience,
    context: cloneAuthContext(input.context),
    expiresAt: input.expiresAt
  });
}

export function encodePendingAuthorizationCode(input: PendingAuthorizationCode): unknown {
  const cloned = clonePendingAuthorizationCode(input);
  return {
    schema: AUTHORIZATION_CODE_SCHEMA,
    clientId: cloned.clientId,
    redirectUri: cloned.redirectUri,
    challenge: cloned.challenge,
    audience: cloned.audience,
    context: cloned.context,
    expiresAt: cloned.expiresAt
  };
}

export function clonePendingAuthorizationCode(input: PendingAuthorizationCode): PendingAuthorizationCode {
  return {
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    challenge: input.challenge,
    audience: input.audience,
    context: cloneAuthContext(input.context),
    expiresAt: input.expiresAt
  };
}

export function decodeRefreshGrant(
  input: unknown
): Result<RefreshGrant, EphemeralStateDecodeError> {
  if (!hasExactKeys(input, [
    "schema",
    "familyId",
    "clientDigest",
    "context",
    "contextDigest",
    "scope",
    "audience",
    "currentGeneration",
    "currentTokenDigest",
    "status",
    "expiresAt"
  ])
    || input.schema !== REFRESH_GRANT_SCHEMA
    || typeof input.familyId !== "string"
    || !/^[A-Za-z0-9_-]{24}$/u.test(input.familyId)
    || typeof input.clientDigest !== "string"
    || !/^[A-Za-z0-9_-]{43}$/u.test(input.clientDigest)
    || !isExactAuthContext(input.context, "mcp")
    || typeof input.contextDigest !== "string"
    || !/^[A-Za-z0-9_-]{43}$/u.test(input.contextDigest)
    || input.contextDigest !== authContextDigest(input.context)
    || input.scope !== "hunsu"
    || typeof input.audience !== "string"
    || !isSafeAudience(input.audience)
    || !isNonNegativeInteger(input.currentGeneration)
    || typeof input.currentTokenDigest !== "string"
    || !/^[A-Za-z0-9_-]{43}$/u.test(input.currentTokenDigest)
    || (input.status !== "active" && input.status !== "revoked")
    || !isExpiry(input.expiresAt)) {
    return err({
      code: "invalid_ephemeral_state",
      message: "Stored OAuth refresh-grant state is invalid."
    });
  }

  return ok({
    familyId: input.familyId,
    clientDigest: input.clientDigest,
    context: cloneAuthContext(input.context),
    contextDigest: input.contextDigest,
    scope: input.scope,
    audience: input.audience,
    currentGeneration: input.currentGeneration,
    currentTokenDigest: input.currentTokenDigest,
    status: input.status,
    expiresAt: input.expiresAt
  });
}

export function encodeRefreshGrant(input: RefreshGrant): unknown {
  const cloned = cloneRefreshGrant(input);
  return {
    schema: REFRESH_GRANT_SCHEMA,
    familyId: cloned.familyId,
    clientDigest: cloned.clientDigest,
    context: cloned.context,
    contextDigest: cloned.contextDigest,
    scope: cloned.scope,
    audience: cloned.audience,
    currentGeneration: cloned.currentGeneration,
    currentTokenDigest: cloned.currentTokenDigest,
    status: cloned.status,
    expiresAt: cloned.expiresAt
  };
}

export function cloneRefreshGrant(input: RefreshGrant): RefreshGrant {
  return {
    familyId: input.familyId,
    clientDigest: input.clientDigest,
    context: cloneAuthContext(input.context),
    contextDigest: input.contextDigest,
    scope: input.scope,
    audience: input.audience,
    currentGeneration: input.currentGeneration,
    currentTokenDigest: input.currentTokenDigest,
    status: input.status,
    expiresAt: input.expiresAt
  };
}

export function decodeRefreshGrantRotation(
  input: unknown
): Result<RefreshGrantRotation, EphemeralStateDecodeError> {
  if (!hasExactKeys(input, [
    "schema",
    "familyId",
    "clientDigest",
    "scope",
    "audience",
    "presentedGeneration",
    "presentedTokenDigest",
    "nextGeneration",
    "nextTokenDigest"
  ])
    || input.schema !== REFRESH_ROTATION_SCHEMA
    || typeof input.familyId !== "string"
    || !/^[A-Za-z0-9_-]{24}$/u.test(input.familyId)
    || typeof input.clientDigest !== "string"
    || !/^[A-Za-z0-9_-]{43}$/u.test(input.clientDigest)
    || input.scope !== "hunsu"
    || typeof input.audience !== "string"
    || !isSafeAudience(input.audience)
    || !isNonNegativeInteger(input.presentedGeneration)
    || typeof input.presentedTokenDigest !== "string"
    || !/^[A-Za-z0-9_-]{43}$/u.test(input.presentedTokenDigest)
    || !isNonNegativeInteger(input.nextGeneration)
    || input.nextGeneration !== input.presentedGeneration + 1
    || typeof input.nextTokenDigest !== "string"
    || !/^[A-Za-z0-9_-]{43}$/u.test(input.nextTokenDigest)) {
    return err({
      code: "invalid_ephemeral_state",
      message: "OAuth refresh rotation input is invalid."
    });
  }

  return ok({
    familyId: input.familyId,
    clientDigest: input.clientDigest,
    scope: input.scope,
    audience: input.audience,
    presentedGeneration: input.presentedGeneration,
    presentedTokenDigest: input.presentedTokenDigest,
    nextGeneration: input.nextGeneration,
    nextTokenDigest: input.nextTokenDigest
  });
}

export function encodeRefreshGrantRotation(input: RefreshGrantRotation): unknown {
  return {
    schema: REFRESH_ROTATION_SCHEMA,
    familyId: input.familyId,
    clientDigest: input.clientDigest,
    scope: input.scope,
    audience: input.audience,
    presentedGeneration: input.presentedGeneration,
    presentedTokenDigest: input.presentedTokenDigest,
    nextGeneration: input.nextGeneration,
    nextTokenDigest: input.nextTokenDigest
  };
}

export function isExactAuthContext(
  value: unknown,
  expectedClient: "web" | "mcp" = "web"
): value is AuthContext {
  return hasExactKeys(
    value,
    ["subject", "user", "installations", "client"],
    ["selectedInstallationId"]
  )
    && typeof value.subject === "string"
    && value.subject.length > 0
    && value.client === expectedClient
    && hasExactKeys(value.user, ["id", "login"], ["name", "avatarUrl"])
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

export function authContextDigest(context: AuthContext): string {
  return createHash("sha256").update(JSON.stringify({
    subject: context.subject,
    user: {
      id: context.user.id,
      login: context.user.login,
      ...(context.user.name === undefined ? {} : { name: context.user.name }),
      ...(context.user.avatarUrl === undefined ? {} : { avatarUrl: context.user.avatarUrl })
    },
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
    ...(context.selectedInstallationId === undefined
      ? {}
      : { selectedInstallationId: context.selectedInstallationId }),
    client: context.client
  }), "utf8").digest("base64url");
}

function isInstallation(value: unknown): boolean {
  return hasExactKeys(value, ["id", "accountLogin", "accountType", "repositories"])
    && Number.isSafeInteger(value.id)
    && Number(value.id) > 0
    && typeof value.accountLogin === "string"
    && value.accountLogin.length > 0
    && (value.accountType === "organization" || value.accountType === "user")
    && Array.isArray(value.repositories)
    && value.repositories.every(repository => hasExactKeys(repository, ["repositoryId", "permissions"])
      && Number.isSafeInteger(repository.repositoryId)
      && Number(repository.repositoryId) > 0
      && hasExactKeys(repository.permissions, ["contents"])
      && (repository.permissions.contents === "read" || repository.permissions.contents === "write"))
    && uniqueIds(value.repositories, "repositoryId");
}

function uniqueIds(values: readonly unknown[], key: "id" | "repositoryId"): boolean {
  const ids = values.flatMap(value => isRecord(value) && Number.isSafeInteger(value[key])
    ? [Number(value[key])]
    : []);
  return ids.length === values.length && new Set(ids).size === ids.length;
}

function isExpiry(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isSafeAudience(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:")
      && !url.username
      && !url.password
      && !url.hash;
  } catch {
    return false;
  }
}

function cloneAuthContext(context: AuthContext): AuthContext {
  return {
    subject: context.subject,
    user: {
      id: context.user.id,
      login: context.user.login,
      ...(context.user.name === undefined ? {} : { name: context.user.name }),
      ...(context.user.avatarUrl === undefined ? {} : { avatarUrl: context.user.avatarUrl })
    },
    installations: context.installations.map(item => ({
      id: item.id,
      accountLogin: item.accountLogin,
      accountType: item.accountType,
      repositories: item.repositories.map(repository => ({
        repositoryId: repository.repositoryId,
        permissions: { contents: repository.permissions.contents }
      }))
    })),
    ...(context.selectedInstallationId === undefined
      ? {}
      : { selectedInstallationId: context.selectedInstallationId }),
    client: context.client
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = []
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every(key => Object.hasOwn(value, key))
    && keys.every(key => allowed.has(key));
}
