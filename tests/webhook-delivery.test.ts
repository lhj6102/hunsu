import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  apiFailure,
  apiOk,
  GitHubWebhookProcessor,
  InMemoryEphemeralStateStore,
  type HunsuApplicationService
} from "../apps/api/src/index.ts";

const SECRET = "webhook-lifecycle-secret";

test("webhook reconciliation failure explicitly releases its lease for a safe retry", async () => {
  let attempts = 0;
  const service = {
    async reconcileRepository() {
      attempts += 1;
      return attempts === 1
        ? apiFailure({
            code: "temporarily_unavailable",
            message: "GitHub state was temporarily unavailable.",
            status: 503,
            retryable: true
          })
        : apiOk({ projectCount: 1 });
    },
    invalidateInstallation() {}
  } as unknown as HunsuApplicationService;
  const processor = new GitHubWebhookProcessor({
    secret: SECRET,
    service,
    stateStore: new InMemoryEphemeralStateStore({ now: () => 1_000 }),
    now: () => 1_000
  });
  const request = webhookRequest();

  const failed = await processor.process(request.headers, request.body);
  assert.equal(failed.ok, false);
  assert.equal(attempts, 1);

  const retried = await processor.process(request.headers, request.body);
  assert.deepEqual(retried, {
    ok: true,
    value: { accepted: true, duplicate: false, signal: "state_ref_changed" }
  });
  assert.equal(attempts, 2);

  const duplicate = await processor.process(request.headers, request.body);
  assert.deepEqual(duplicate, {
    ok: true,
    value: { accepted: true, duplicate: true, signal: "duplicate" }
  });
  assert.equal(attempts, 2);
});

function webhookRequest(): { headers: Headers; body: Uint8Array } {
  const source = JSON.stringify({
    ref: "refs/heads/hunsu/state",
    before: "a".repeat(40),
    after: "b".repeat(40),
    installation: { id: 17 },
    repository: {
      id: 29,
      name: "product",
      default_branch: "main",
      owner: { login: "acme" }
    }
  });
  const signature = `sha256=${createHmac("sha256", SECRET).update(source).digest("hex")}`;
  return {
    headers: new Headers({
      "x-hub-signature-256": signature,
      "x-github-delivery": "delivery-retry",
      "x-github-event": "push"
    }),
    body: Buffer.from(source, "utf8")
  };
}
