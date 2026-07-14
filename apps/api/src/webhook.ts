import { createHmac, timingSafeEqual } from "node:crypto";
import { normalizeGitHubWebhook } from "@hunsu/github-store";
import type { EphemeralStateStore } from "./auth/ephemeral-store.ts";
import type { HunsuApplicationService } from "./application-service.ts";
import { apiFailure, apiOk, type ApiResult } from "./types.ts";

const WEBHOOK_PROCESSING_LEASE_SECONDS = 5 * 60;
const WEBHOOK_COMPLETED_TTL_SECONDS = 24 * 60 * 60;

export class GitHubWebhookProcessor {
  readonly #secret: string;
  readonly #service: HunsuApplicationService;
  readonly #stateStore: EphemeralStateStore;
  readonly #now: () => number;

  constructor(input: {
    secret: string;
    service: HunsuApplicationService;
    stateStore: EphemeralStateStore;
    now?: () => number;
  }) {
    if (!input.secret) throw new Error("GitHub webhook secret is required.");
    this.#secret = input.secret;
    this.#service = input.service;
    this.#stateStore = input.stateStore;
    this.#now = input.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async process(headers: Headers, rawBody: Uint8Array): Promise<ApiResult<{ accepted: true; duplicate: boolean; signal: string }>> {
    const signature = headers.get("x-hub-signature-256");
    const deliveryId = headers.get("x-github-delivery");
    const eventName = headers.get("x-github-event");
    if (!signature || !deliveryId || !eventName) {
      return apiFailure({ code: "invalid_request", message: "GitHub webhook headers are incomplete.", status: 400, retryable: false });
    }
    if (!verifySignature(this.#secret, rawBody, signature)) {
      return apiFailure({ code: "forbidden", message: "GitHub webhook signature is invalid.", status: 401, retryable: false });
    }
    if (!/^[A-Za-z0-9-]{1,128}$/u.test(deliveryId)) {
      return apiFailure({ code: "invalid_request", message: "GitHub delivery id is invalid.", status: 400, retryable: false });
    }
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(rawBody).toString("utf8")) as unknown;
    } catch {
      return apiFailure({ code: "invalid_request", message: "GitHub webhook body is not valid JSON.", status: 400, retryable: false });
    }
    const normalized = normalizeGitHubWebhook(eventName, payload);
    if (!normalized.ok) return apiFailure({ code: "invalid_request", message: normalized.error.message, status: 400, retryable: false });

    const now = this.#now();
    const leaseExpiresAt = now + WEBHOOK_PROCESSING_LEASE_SECONDS;
    const claimed = await this.#stateStore.claimWebhookDelivery(deliveryId, leaseExpiresAt);
    if (!claimed) return apiOk({ accepted: true, duplicate: true, signal: "duplicate" });

    try {
      if (normalized.value.kind === "state_ref_changed") {
        this.#service.invalidateRepository(normalized.value.repository);
      } else if (normalized.value.kind === "installation_changed") {
        this.#service.invalidateInstallation(normalized.value.installationId);
      } else if (normalized.value.kind === "repository_grant_changed") {
        this.#service.invalidateInstallation(normalized.value.installationId);
      }

      const completed = await this.#stateStore.completeWebhookDelivery(
        deliveryId,
        leaseExpiresAt,
        this.#now() + WEBHOOK_COMPLETED_TTL_SECONDS
      );
      if (!completed) {
        await this.#releaseDelivery(deliveryId, leaseExpiresAt);
        return apiFailure({
          code: "temporarily_unavailable",
          message: "The GitHub webhook processing lease expired before completion.",
          status: 503,
          retryable: true
        });
      }
    } catch (error) {
      await this.#releaseDelivery(deliveryId, leaseExpiresAt);
      throw error;
    }

    return apiOk({ accepted: true, duplicate: false, signal: normalized.value.kind });
  }

  async #releaseDelivery(deliveryId: string, leaseExpiresAt: number): Promise<void> {
    await this.#stateStore.releaseWebhookDelivery(deliveryId, leaseExpiresAt);
  }
}

export function verifySignature(secret: string, rawBody: Uint8Array, signature: string): boolean {
  if (!/^sha256=[0-9a-f]{64}$/u.test(signature)) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const expectedBytes = Buffer.from(expected, "ascii");
  const providedBytes = Buffer.from(signature, "ascii");
  return expectedBytes.length === providedBytes.length && timingSafeEqual(expectedBytes, providedBytes);
}
