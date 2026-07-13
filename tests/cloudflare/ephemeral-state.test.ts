import { env } from "cloudflare:workers";
import { evictAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DurableObjectEphemeralStateStore } from "../../apps/api/src/auth/cloudflare-ephemeral-store.ts";
import type { PendingAuthorizationCode } from "../../apps/api/src/auth/ephemeral-store.ts";

// Keep scheduled alarms in the future while expiry decisions use the adapter's
// injected clock. This prevents real-time alarm delivery from racing the tests.
const NOW = 2_000_000_000;

const pendingAuthorizationCode: PendingAuthorizationCode = {
  clientId: "client-id",
  redirectUri: "https://client.example.test/callback",
  challenge: "c".repeat(43),
  context: {
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
  },
  expiresAt: NOW + 300
};

describe("HunsuEphemeralState Durable Object", () => {
  it("persists consent across adapter instances and Durable Object eviction", async () => {
    const creator = storeAt(NOW);
    await creator.createConsent({ id: "persistent-consent", expiresAt: NOW + 60 });

    await evictAllDurableObjects();

    const consumer = storeAt(NOW + 1);
    expect(await consumer.consumeConsent("persistent-consent")).toBe(true);
    expect(await creator.consumeConsent("persistent-consent")).toBe(false);
    expect(await alarmFor("consent", "persistent-consent")).toBeNull();
  });

  it("atomically consumes a consent nonce exactly once", async () => {
    const creator = storeAt(NOW);
    await creator.createConsent({ id: "atomic-consent", expiresAt: NOW + 60 });

    const results = await Promise.all([
      storeAt(NOW + 1).consumeConsent("atomic-consent"),
      storeAt(NOW + 1).consumeConsent("atomic-consent"),
      storeAt(NOW + 1).consumeConsent("atomic-consent")
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("rejects expired consent without reviving it", async () => {
    await storeAt(NOW).createConsent({ id: "expired-consent", expiresAt: NOW + 5 });

    expect(await storeAt(NOW + 5).consumeConsent("expired-consent")).toBe(false);
    expect(await storeAt(NOW + 1).consumeConsent("expired-consent")).toBe(false);
  });

  it("persists and atomically consumes one authorization code", async () => {
    await storeAt(NOW).createAuthorizationCode("persistent-code", pendingAuthorizationCode);
    await evictAllDurableObjects();

    const results = await Promise.all([
      storeAt(NOW + 1).consumeAuthorizationCode("persistent-code"),
      storeAt(NOW + 1).consumeAuthorizationCode("persistent-code")
    ]);
    const consumed = results.filter((value): value is PendingAuthorizationCode => value !== undefined);

    expect(consumed).toHaveLength(1);
    expect(consumed[0]).toEqual(pendingAuthorizationCode);
  });

  it("removes expired authorization codes", async () => {
    await storeAt(NOW).createAuthorizationCode("expired-code", {
      ...pendingAuthorizationCode,
      expiresAt: NOW + 5
    });

    expect(await storeAt(NOW + 5).consumeAuthorizationCode("expired-code")).toBeUndefined();
    expect(await storeAt(NOW + 1).consumeAuthorizationCode("expired-code")).toBeUndefined();
    expect(await alarmFor("authorization-code", "expired-code")).toBeNull();
  });

  it("coordinates active webhook leases, crash recovery, and explicit release", async () => {
    const first = storeAt(NOW);
    const second = storeAt(NOW);

    expect(await first.claimWebhookDelivery("delivery-one", NOW + 60)).toBe(true);
    await evictAllDurableObjects();
    expect(await second.claimWebhookDelivery("delivery-one", NOW + 60)).toBe(false);

    expect(await storeAt(NOW + 60).claimWebhookDelivery("delivery-one", NOW + 120)).toBe(true);
    expect(await storeAt(NOW + 60).claimWebhookDelivery("delivery-one", NOW + 120)).toBe(false);

    expect(await storeAt(NOW + 60).releaseWebhookDelivery(
      "delivery-one",
      NOW + 120
    )).toBe(true);
    expect(await storeAt(NOW + 61).claimWebhookDelivery("delivery-one", NOW + 120)).toBe(true);
    expect(await storeAt(NOW + 61).claimWebhookDelivery("invalid-expiry", NOW + 61)).toBe(false);
  });

  it("retains completed webhook delivery markers for the full dedupe TTL", async () => {
    const store = storeAt(NOW);
    expect(await store.claimWebhookDelivery("delivery-completed", NOW + 60)).toBe(true);
    expect(await store.completeWebhookDelivery(
      "delivery-completed",
      NOW + 60,
      NOW + 24 * 60 * 60
    )).toBe(true);

    expect(await store.releaseWebhookDelivery("delivery-completed", NOW + 60)).toBe(false);
    expect(await storeAt(NOW + 60).claimWebhookDelivery("delivery-completed", NOW + 120)).toBe(false);
    expect(await storeAt(NOW + 24 * 60 * 60).claimWebhookDelivery(
      "delivery-completed",
      NOW + 24 * 60 * 60 + 60
    )).toBe(true);
  });

  it("allows exactly one concurrent webhook claimant", async () => {
    const claims = await Promise.all(Array.from(
      { length: 6 },
      () => storeAt(NOW).claimWebhookDelivery("delivery-concurrent", NOW + 60)
    ));

    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it("fences stale webhook workers after a replacement lease is claimed", async () => {
    const deliveryId = "delivery-fenced";
    const staleLeaseExpiresAt = NOW + 5;
    const currentLeaseExpiresAt = NOW + 60;

    expect(await storeAt(NOW).claimWebhookDelivery(deliveryId, staleLeaseExpiresAt)).toBe(true);
    expect(await storeAt(staleLeaseExpiresAt).claimWebhookDelivery(
      deliveryId,
      currentLeaseExpiresAt
    )).toBe(true);
    expect(await storeAt(staleLeaseExpiresAt).completeWebhookDelivery(
      deliveryId,
      staleLeaseExpiresAt,
      NOW + 300
    )).toBe(false);
    expect(await storeAt(staleLeaseExpiresAt).releaseWebhookDelivery(
      deliveryId,
      staleLeaseExpiresAt
    )).toBe(false);
    expect(await storeAt(staleLeaseExpiresAt).completeWebhookDelivery(
      deliveryId,
      currentLeaseExpiresAt,
      NOW + 300
    )).toBe(true);
  });

  it("fails closed and clears the alarm for corrupt persisted authorization-code JSON", async () => {
    const code = "corrupt-code";
    await storeAt(NOW).createAuthorizationCode(code, pendingAuthorizationCode);
    const stub = await stubFor("authorization-code", code);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE ephemeral_record SET payload = ? WHERE singleton = 1",
        "{not-json"
      );
    });

    expect(await storeAt(NOW + 1).consumeAuthorizationCode(code)).toBeUndefined();
    expect(await alarmFor("authorization-code", code)).toBeNull();
  });
});

function storeAt(now: number): DurableObjectEphemeralStateStore {
  return new DurableObjectEphemeralStateStore({
    namespace: env.EPHEMERAL_STATE,
    now: () => now
  });
}

async function alarmFor(
  kind: "consent" | "authorization-code" | "webhook-delivery",
  key: string
): Promise<number | null> {
  const stub = await stubFor(kind, key);
  return runInDurableObject(stub, async (_instance, state) => state.storage.getAlarm());
}

async function stubFor(
  kind: "consent" | "authorization-code" | "webhook-delivery",
  key: string
) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${kind}\0${key}`));
  const name = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  return env.EPHEMERAL_STATE.getByName(`${kind}:${name}`);
}
