import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  GitHubWebhookProcessor,
  InMemoryEphemeralStateStore,
  type HunsuApplicationService
} from "../apps/api/src/index.ts";

const SECRET = "webhook-lifecycle-secret";

test("state-ref webhooks invalidate once without eagerly reconstructing GitHub state", async () => {
  const invalidated: Array<{ installationId: number; repositoryId: number }> = [];
  const service = {
    invalidateRepository(repository: { installationId: number; repositoryId: number }) {
      invalidated.push({
        installationId: repository.installationId,
        repositoryId: repository.repositoryId
      });
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

  const accepted = await processor.process(request.headers, request.body);
  assert.deepEqual(accepted, {
    ok: true,
    value: { accepted: true, duplicate: false, signal: "state_ref_changed" }
  });
  assert.deepEqual(invalidated, [{ installationId: 17, repositoryId: 29 }]);

  const duplicate = await processor.process(request.headers, request.body);
  assert.deepEqual(duplicate, {
    ok: true,
    value: { accepted: true, duplicate: true, signal: "duplicate" }
  });
  assert.equal(invalidated.length, 1);
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
