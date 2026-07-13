import {
  clonePendingAuthorizationCode,
  type ConsentState,
  type EphemeralStateStore,
  type PendingAuthorizationCode
} from "./ephemeral-store.ts";

const MAXIMUM_RECORDS = 10_000;

type WebhookDeliveryState = Readonly<{
  status: "processing" | "completed";
  expiresAt: number;
}>;

export class InMemoryEphemeralStateStore implements EphemeralStateStore {
  readonly #now: () => number;
  readonly #consents = new Map<string, ConsentState>();
  readonly #authorizationCodes = new Map<string, PendingAuthorizationCode>();
  readonly #webhookDeliveries = new Map<string, WebhookDeliveryState>();

  constructor(input: { now?: () => number } = {}) {
    this.#now = input.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async createConsent(input: ConsentState): Promise<void> {
    this.#pruneExpired();
    this.#consents.set(input.id, { ...input });
    trimMap(this.#consents);
  }

  async consumeConsent(id: string): Promise<boolean> {
    const consent = this.#consents.get(id);
    this.#consents.delete(id);
    return consent !== undefined && consent.expiresAt > this.#now();
  }

  async createAuthorizationCode(code: string, input: PendingAuthorizationCode): Promise<void> {
    this.#pruneExpired();
    this.#authorizationCodes.set(code, clonePendingAuthorizationCode(input));
    trimMap(this.#authorizationCodes);
  }

  async consumeAuthorizationCode(code: string): Promise<PendingAuthorizationCode | undefined> {
    const pending = this.#authorizationCodes.get(code);
    this.#authorizationCodes.delete(code);
    return pending !== undefined && pending.expiresAt > this.#now()
      ? clonePendingAuthorizationCode(pending)
      : undefined;
  }

  async claimWebhookDelivery(deliveryId: string, expiresAt: number): Promise<boolean> {
    this.#pruneExpired();
    const now = this.#now();
    if (expiresAt <= now) return false;
    const existing = this.#webhookDeliveries.get(deliveryId);
    if (existing !== undefined && existing.expiresAt > now) return false;
    this.#webhookDeliveries.set(deliveryId, { status: "processing", expiresAt });
    trimMap(this.#webhookDeliveries);
    return true;
  }

  async completeWebhookDelivery(
    deliveryId: string,
    leaseExpiresAt: number,
    completedExpiresAt: number
  ): Promise<boolean> {
    const now = this.#now();
    const existing = this.#webhookDeliveries.get(deliveryId);
    if (completedExpiresAt <= now
      || existing?.status !== "processing"
      || existing.expiresAt !== leaseExpiresAt
      || existing.expiresAt <= now) {
      if (existing?.status === "processing"
        && existing.expiresAt === leaseExpiresAt
        && existing.expiresAt <= now) {
        this.#webhookDeliveries.delete(deliveryId);
      }
      return false;
    }
    this.#webhookDeliveries.set(deliveryId, {
      status: "completed",
      expiresAt: completedExpiresAt
    });
    return true;
  }

  async releaseWebhookDelivery(deliveryId: string, leaseExpiresAt: number): Promise<boolean> {
    const existing = this.#webhookDeliveries.get(deliveryId);
    if (existing?.status !== "processing" || existing.expiresAt !== leaseExpiresAt) return false;
    this.#webhookDeliveries.delete(deliveryId);
    return true;
  }

  #pruneExpired(): void {
    const now = this.#now();
    for (const [id, consent] of this.#consents) {
      if (consent.expiresAt <= now) this.#consents.delete(id);
    }
    for (const [code, pending] of this.#authorizationCodes) {
      if (pending.expiresAt <= now) this.#authorizationCodes.delete(code);
    }
    for (const [deliveryId, state] of this.#webhookDeliveries) {
      if (state.expiresAt <= now) this.#webhookDeliveries.delete(deliveryId);
    }
  }
}

function trimMap<K, V>(values: Map<K, V>): void {
  while (values.size > MAXIMUM_RECORDS) {
    const oldest = values.keys().next().value as K | undefined;
    if (oldest === undefined) return;
    values.delete(oldest);
  }
}
