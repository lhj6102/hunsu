import assert from "node:assert/strict";
import test from "node:test";
import {
  authContextDigest,
  decodePendingAuthorizationCode,
  decodeRefreshGrant,
  decodeRefreshGrantRotation,
  encodePendingAuthorizationCode,
  encodeRefreshGrant,
  encodeRefreshGrantRotation,
  InMemoryEphemeralStateStore,
  type AuthContext,
  type PendingAuthorizationCode,
  type RefreshGrant,
  type RefreshGrantRotation
} from "../apps/api/src/index.ts";

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

const pending: PendingAuthorizationCode = {
  clientId: "client-one",
  redirectUri: "https://client.example.test/callback",
  challenge: "c".repeat(43),
  audience: "https://api.example.test/mcp",
  context,
  expiresAt: 1_030
};

const mcpContext: AuthContext = { ...context, client: "mcp" };
const refreshGrant: RefreshGrant = {
  familyId: "f".repeat(24),
  clientDigest: "c".repeat(43),
  context: mcpContext,
  contextDigest: authContextDigest(mcpContext),
  scope: "hunsu",
  audience: "https://api.example.test/mcp",
  currentGeneration: 0,
  currentTokenDigest: "t".repeat(43),
  status: "active",
  expiresAt: 1_100
};

const refreshRotation: RefreshGrantRotation = {
  familyId: refreshGrant.familyId,
  clientDigest: refreshGrant.clientDigest,
  scope: "hunsu",
  audience: refreshGrant.audience,
  presentedGeneration: 0,
  presentedTokenDigest: refreshGrant.currentTokenDigest,
  nextGeneration: 1,
  nextTokenDigest: "n".repeat(43)
};

test("in-memory ephemeral state is expiring, single-use, and atomically claimed", async () => {
  let now = 1_000;
  const store = new InMemoryEphemeralStateStore({ now: () => now });

  await store.createConsent({ id: "consent-one", expiresAt: now + 30 });
  const consentUses = await Promise.all([
    store.consumeConsent("consent-one"),
    store.consumeConsent("consent-one")
  ]);
  assert.deepEqual(consentUses.sort(), [false, true]);

  await store.createConsent({ id: "expired-consent", expiresAt: now + 1 });
  now += 1;
  assert.equal(await store.consumeConsent("expired-consent"), false);

  await store.createAuthorizationCode("code-one", pending);
  const codeUses = await Promise.all([
    store.consumeAuthorizationCode("code-one"),
    store.consumeAuthorizationCode("code-one")
  ]);
  assert.equal(codeUses.filter(Boolean).length, 1);
  assert.deepEqual(codeUses.find(Boolean), pending);
});

test("in-memory webhook delivery lifecycle leases, completes, releases, and retries atomically", async () => {
  let now = 2_000;
  const store = new InMemoryEphemeralStateStore({ now: () => now });

  const concurrent = await Promise.all(Array.from(
    { length: 8 },
    () => store.claimWebhookDelivery("delivery-concurrent", now + 30)
  ));
  assert.equal(concurrent.filter(Boolean).length, 1);
  assert.equal(await store.claimWebhookDelivery("delivery-concurrent", now + 30), false);

  assert.equal(await store.claimWebhookDelivery("delivery-crashed", now + 5), true);
  assert.equal(await store.claimWebhookDelivery("delivery-crashed", now + 30), false);
  now += 5;
  assert.equal(await store.claimWebhookDelivery("delivery-crashed", now + 30), true);

  const completedLeaseExpiresAt = now + 30;
  assert.equal(await store.claimWebhookDelivery("delivery-completed", completedLeaseExpiresAt), true);
  assert.equal(await store.completeWebhookDelivery(
    "delivery-completed",
    completedLeaseExpiresAt,
    now + 300
  ), true);
  assert.equal(await store.releaseWebhookDelivery(
    "delivery-completed",
    completedLeaseExpiresAt
  ), false);
  assert.equal(await store.claimWebhookDelivery("delivery-completed", now + 30), false);
  now += 300;
  assert.equal(await store.claimWebhookDelivery("delivery-completed", now + 30), true);

  const releasedLeaseExpiresAt = now + 30;
  assert.equal(await store.claimWebhookDelivery("delivery-released", releasedLeaseExpiresAt), true);
  assert.equal(await store.releaseWebhookDelivery(
    "delivery-released",
    releasedLeaseExpiresAt
  ), true);
  assert.equal(await store.claimWebhookDelivery("delivery-released", now + 30), true);
  assert.equal(await store.claimWebhookDelivery("delivery-invalid", now), false);

  const staleLeaseExpiresAt = now + 5;
  assert.equal(await store.claimWebhookDelivery("delivery-fenced", staleLeaseExpiresAt), true);
  now += 5;
  const currentLeaseExpiresAt = now + 30;
  assert.equal(await store.claimWebhookDelivery("delivery-fenced", currentLeaseExpiresAt), true);
  assert.equal(await store.completeWebhookDelivery(
    "delivery-fenced",
    staleLeaseExpiresAt,
    now + 300
  ), false);
  assert.equal(await store.releaseWebhookDelivery(
    "delivery-fenced",
    staleLeaseExpiresAt
  ), false);
  assert.equal(await store.completeWebhookDelivery(
    "delivery-fenced",
    currentLeaseExpiresAt,
    now + 300
  ), true);
});

test("authorization-code storage envelope is versioned and rejects unknown or corrupt state", () => {
  const envelope = {
    schema: "hunsu.ephemeral-authorization-code.v1",
    clientId: pending.clientId,
    redirectUri: pending.redirectUri,
    challenge: pending.challenge,
    audience: pending.audience,
    context: pending.context,
    expiresAt: pending.expiresAt
  };

  assert.deepEqual(encodePendingAuthorizationCode(pending), envelope);
  assert.deepEqual(decodePendingAuthorizationCode(envelope), { ok: true, value: pending });
  assert.equal(decodePendingAuthorizationCode({ ...envelope, schema: "hunsu.ephemeral-authorization-code.v2" }).ok, false);
  assert.equal(decodePendingAuthorizationCode({ ...envelope, unexpected: true }).ok, false);
  assert.equal(decodePendingAuthorizationCode({
    ...envelope,
    context: { ...context, user: { ...context.user, unexpected: true } }
  }).ok, false);
  assert.equal(decodePendingAuthorizationCode({
    ...envelope,
    context: {
      ...context,
      installations: [{
        ...context.installations[0],
        repositories: [{
          ...context.installations[0].repositories[0],
          permissions: { contents: "write", unexpected: true }
        }]
      }]
    }
  }).ok, false);
  assert.equal(decodePendingAuthorizationCode({ ...envelope, expiresAt: "later" }).ok, false);
  assert.equal(decodePendingAuthorizationCode({ ...envelope, challenge: "too-short" }).ok, false);
  assert.equal(decodePendingAuthorizationCode({
    ...envelope,
    context: { ...context, client: "mcp" }
  }).ok, false);
  assert.equal(decodePendingAuthorizationCode("corrupt-json-value").ok, false);
});

test("refresh-grant storage envelopes are exact, versioned, and context-bound", () => {
  const grantEnvelope = encodeRefreshGrant(refreshGrant);
  const rotationEnvelope = encodeRefreshGrantRotation(refreshRotation);

  assert.deepEqual(decodeRefreshGrant(grantEnvelope), { ok: true, value: refreshGrant });
  assert.deepEqual(decodeRefreshGrantRotation(rotationEnvelope), { ok: true, value: refreshRotation });
  assert.equal(decodeRefreshGrant({
    ...(grantEnvelope as Record<string, unknown>),
    schema: "hunsu.ephemeral-refresh-grant.v2"
  }).ok, false);
  assert.equal(decodeRefreshGrant({
    ...(grantEnvelope as Record<string, unknown>),
    contextDigest: "x".repeat(43)
  }).ok, false);
  assert.equal(decodeRefreshGrant({
    ...(grantEnvelope as Record<string, unknown>),
    context: { ...mcpContext, unexpected: true }
  }).ok, false);
  assert.equal(decodeRefreshGrant({
    ...(grantEnvelope as Record<string, unknown>),
    unexpected: true
  }).ok, false);
  assert.equal(decodeRefreshGrantRotation({
    ...(rotationEnvelope as Record<string, unknown>),
    nextGeneration: 2
  }).ok, false);
  assert.equal(decodeRefreshGrantRotation({
    ...(rotationEnvelope as Record<string, unknown>),
    scope: "other"
  }).ok, false);
  const reorderedContext: AuthContext = {
    subject: mcpContext.subject,
    user: {
      login: mcpContext.user.login,
      id: mcpContext.user.id
    },
    installations: [...mcpContext.installations].reverse().map(installation => ({
      ...installation,
      repositories: [...installation.repositories].reverse()
    })),
    selectedInstallationId: mcpContext.selectedInstallationId,
    client: "mcp"
  };
  assert.equal(authContextDigest(reorderedContext), authContextDigest(mcpContext));
});

test("in-memory refresh rotation is atomic and replay revokes the token family", async () => {
  let now = 1_000;
  const store = new InMemoryEphemeralStateStore({ now: () => now });
  assert.equal(await store.createRefreshGrant(refreshGrant), true);
  assert.equal(await store.createRefreshGrant(refreshGrant), false);

  const rotations = await Promise.all([
    store.rotateRefreshGrant(refreshRotation),
    store.rotateRefreshGrant(refreshRotation)
  ]);
  assert.equal(rotations.filter(result => result.status === "rotated").length, 1);
  assert.equal(rotations.filter(result => result.status === "replayed").length, 1);
  assert.equal((await store.rotateRefreshGrant({
    ...refreshRotation,
    presentedGeneration: 1,
    presentedTokenDigest: refreshRotation.nextTokenDigest,
    nextGeneration: 2,
    nextTokenDigest: "z".repeat(43)
  })).status, "revoked");

  assert.equal((await store.rotateRefreshGrant({
    ...refreshRotation,
    familyId: "m".repeat(24)
  })).status, "missing");
  assert.equal(await store.createRefreshGrant({
    ...refreshGrant,
    familyId: "e".repeat(24),
    expiresAt: now
  }), false);
  now = refreshGrant.expiresAt;
  assert.equal((await store.rotateRefreshGrant({
    ...refreshRotation,
    familyId: refreshGrant.familyId
  })).status, "expired");
});
