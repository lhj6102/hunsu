import type { HunsuEphemeralState } from "../cloudflare/HunsuEphemeralState.ts";
import type {
  ConsentState,
  EphemeralStateStore,
  PendingAuthorizationCode
} from "./ephemeral-store.ts";

type EphemeralNamespace = DurableObjectNamespace<HunsuEphemeralState>;

export class DurableObjectEphemeralStateStore implements EphemeralStateStore {
  readonly #namespace: EphemeralNamespace;
  readonly #now: () => number;

  constructor(input: { namespace: EphemeralNamespace; now?: () => number }) {
    this.#namespace = input.namespace;
    this.#now = input.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async createConsent(input: ConsentState): Promise<void> {
    const stub = await this.#stub("consent", input.id);
    await stub.createConsent(input);
  }

  async consumeConsent(id: string): Promise<boolean> {
    const stub = await this.#stub("consent", id);
    return stub.consumeConsent(this.#now());
  }

  async createAuthorizationCode(code: string, input: PendingAuthorizationCode): Promise<void> {
    const stub = await this.#stub("authorization-code", code);
    await stub.createAuthorizationCode(input);
  }

  async consumeAuthorizationCode(code: string): Promise<PendingAuthorizationCode | undefined> {
    const stub = await this.#stub("authorization-code", code);
    return stub.consumeAuthorizationCode(this.#now());
  }

  async claimWebhookDelivery(deliveryId: string, expiresAt: number): Promise<boolean> {
    const stub = await this.#stub("webhook-delivery", deliveryId);
    return stub.claimWebhookDelivery(expiresAt, this.#now());
  }

  async completeWebhookDelivery(
    deliveryId: string,
    leaseExpiresAt: number,
    completedExpiresAt: number
  ): Promise<boolean> {
    const stub = await this.#stub("webhook-delivery", deliveryId);
    return stub.completeWebhookDelivery(leaseExpiresAt, completedExpiresAt, this.#now());
  }

  async releaseWebhookDelivery(deliveryId: string, leaseExpiresAt: number): Promise<boolean> {
    const stub = await this.#stub("webhook-delivery", deliveryId);
    return stub.releaseWebhookDelivery(leaseExpiresAt);
  }

  async #stub(kind: "consent" | "authorization-code" | "webhook-delivery", key: string) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${kind}\0${key}`));
    const name = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    return this.#namespace.getByName(`${kind}:${name}`);
  }
}
