import { err, ok, type Result } from "@hunsu/protocol";
import type { AuthContext } from "../types.ts";

const AUTHORIZATION_CODE_SCHEMA = "hunsu.ephemeral-authorization-code.v1";

export type ConsentState = Readonly<{
  id: string;
  expiresAt: number;
}>;

export type PendingAuthorizationCode = Readonly<{
  clientId: string;
  redirectUri: string;
  challenge: string;
  context: AuthContext;
  expiresAt: number;
}>;

export interface EphemeralStateStore {
  createConsent(input: ConsentState): Promise<void>;
  consumeConsent(id: string): Promise<boolean>;

  createAuthorizationCode(code: string, input: PendingAuthorizationCode): Promise<void>;
  consumeAuthorizationCode(code: string): Promise<PendingAuthorizationCode | undefined>;

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
    || !isAuthContext(input.context)
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
    context: cloned.context,
    expiresAt: cloned.expiresAt
  };
}

export function clonePendingAuthorizationCode(input: PendingAuthorizationCode): PendingAuthorizationCode {
  return {
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    challenge: input.challenge,
    context: cloneAuthContext(input.context),
    expiresAt: input.expiresAt
  };
}

function isAuthContext(value: unknown): value is AuthContext {
  return hasExactKeys(
    value,
    ["subject", "user", "installations", "client"],
    ["selectedInstallationId"]
  )
    && typeof value.subject === "string"
    && value.subject.length > 0
    && value.client === "web"
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
