import { createHmac, timingSafeEqual } from "node:crypto";
import { normalizeGitHubWebhook } from "@hunsu/github-store";
import type { HunsuApplicationService } from "./application-service.ts";
import { apiFailure, apiOk, type ApiResult } from "./types.ts";

export class GitHubWebhookProcessor {
  readonly #secret: string;
  readonly #service: HunsuApplicationService;
  readonly #deliveries = new Set<string>();

  constructor(input: { secret: string; service: HunsuApplicationService }) {
    if (!input.secret) throw new Error("GitHub webhook secret is required.");
    this.#secret = input.secret;
    this.#service = input.service;
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
    if (this.#deliveries.has(deliveryId)) return apiOk({ accepted: true, duplicate: true, signal: "duplicate" });
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(rawBody).toString("utf8")) as unknown;
    } catch {
      return apiFailure({ code: "invalid_request", message: "GitHub webhook body is not valid JSON.", status: 400, retryable: false });
    }
    const normalized = normalizeGitHubWebhook(eventName, payload);
    if (!normalized.ok) return apiFailure({ code: "invalid_request", message: normalized.error.message, status: 400, retryable: false });

    if (normalized.value.kind === "state_ref_changed") {
      const reconciled = await this.#service.reconcileRepository(normalized.value.repository);
      if (!reconciled.ok) return reconciled;
    } else if (normalized.value.kind === "installation_changed") {
      this.#service.invalidateInstallation(normalized.value.installationId);
    } else if (normalized.value.kind === "repository_grant_changed") {
      this.#service.invalidateInstallation(normalized.value.installationId);
    }

    this.#deliveries.add(deliveryId);
    trimSet(this.#deliveries, 10_000);
    return apiOk({ accepted: true, duplicate: false, signal: normalized.value.kind });
  }
}

export function verifySignature(secret: string, rawBody: Uint8Array, signature: string): boolean {
  if (!/^sha256=[0-9a-f]{64}$/u.test(signature)) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const expectedBytes = Buffer.from(expected, "ascii");
  const providedBytes = Buffer.from(signature, "ascii");
  return expectedBytes.length === providedBytes.length && timingSafeEqual(expectedBytes, providedBytes);
}

function trimSet(values: Set<string>, maximum: number): void {
  while (values.size > maximum) {
    const oldest = values.values().next().value as string | undefined;
    if (!oldest) return;
    values.delete(oldest);
  }
}
