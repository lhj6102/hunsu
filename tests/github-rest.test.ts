import assert from "node:assert/strict";
import test from "node:test";
import { GitHubAuthorityError, GitHubRestTransport, type RepositoryLocator } from "../packages/github-store/src/index.ts";

const repository: RepositoryLocator = {
  installationId: 19,
  repositoryId: 23,
  owner: "hunsu",
  name: "sample",
  defaultBranch: "main"
};
const eventPath = `projects/project-alpha/events/2026/07/${"1".repeat(32)}.json`;
const eventFilePath = `.hunsu/v2/${eventPath}`;

test("GitHub REST transport uses installation authority and a non-forced CAS update", async () => {
  const parentSha = "a".repeat(40);
  const resultSha = "b".repeat(40);
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let tokenRequests = 0;
  const transport = new GitHubRestTransport({
    async authorityProvider(installationId) {
      tokenRequests += 1;
      assert.equal(installationId, repository.installationId);
      return verifiedAuthority("test-installation-value");
    },
    fetch: async function (this: unknown, input, init = {}) {
      assert.equal(this, undefined);
      const url = String(input);
      calls.push({ url, init });
      const method = init.method ?? "GET";
      if (method === "GET" && url.includes("/git/ref/heads/hunsu/state")) {
        return json({ object: { sha: parentSha } });
      }
      if (method === "GET" && url.endsWith(`/git/commits/${parentSha}`)) {
        return json({ tree: { sha: "tree-parent" } });
      }
      if (method === "POST" && url.endsWith("/git/trees")) return json({ sha: "tree-result" });
      if (method === "POST" && url.endsWith("/git/commits")) return json({ sha: resultSha });
      if (method === "PATCH" && url.includes("/git/refs/heads/hunsu/state")) return json({ object: { sha: resultSha } });
      return json({ message: `Unexpected ${method} ${url}` }, 500);
    }
  });

  const committed = await transport.commitFiles({
    repository,
    branch: "hunsu/state",
    expectedHeadSha: parentSha,
    message: "Hunsu state mutation",
    updates: [{ path: ".hunsu/v2/workspace.json", content: "{}\n" }]
  });
  assert.deepEqual(committed, { ok: true, value: resultSha });
  assert.equal(tokenRequests, calls.length);

  for (const call of calls) {
    const headers = new Headers(call.init.headers);
    assert.equal(headers.get("authorization"), "Bearer " + "test-installation-value");
    assert.equal(headers.get("user-agent"), "hunsu-plugin-production");
    assert.ok(headers.get("x-github-api-version"));
  }
  const update = calls.find(call => (call.init.method ?? "GET") === "PATCH");
  assert.ok(update);
  assert.deepEqual(JSON.parse(String(update.init.body)), { sha: resultSha, force: false });
  const commitBody = JSON.parse(String(calls.find(call => call.url.endsWith("/git/commits") && call.init.method === "POST")?.init.body));
  assert.deepEqual(commitBody.parents, [parentSha]);
  const treeBody = JSON.parse(String(calls.find(call => call.url.endsWith("/git/trees") && call.init.method === "POST")?.init.body));
  assert.deepEqual(treeBody, {
    base_tree: "tree-parent",
    tree: [{
      path: ".hunsu/v2/workspace.json",
      mode: "100644",
      type: "blob",
      content: "{}\n"
    }]
  });
  assert.equal(calls.some(call => call.url.endsWith("/git/blobs")), false);
  const referenceReads = calls.filter(call => call.url.includes("/git/ref/"));
  assert.ok(referenceReads.length > 0);
  for (const call of referenceReads) {
    assert.equal(call.init.cache, "no-store");
  }
});

test("GitHub REST transport rejects a stale head before creating a tree", async () => {
  let calls = 0;
  const transport = new GitHubRestTransport({
    authorityProvider: async () => verifiedAuthority("test-installation-value"),
    fetch: async () => {
      calls += 1;
      return json({ object: { sha: "c".repeat(40) } });
    }
  });
  const result = await transport.commitFiles({
    repository,
    branch: "hunsu/state",
    expectedHeadSha: "a".repeat(40),
    message: "stale",
    updates: [{ path: ".hunsu/v2/workspace.json", content: "{}\n" }]
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "conflict");
  assert.equal(calls, 1);
});

test("GitHub REST uses verified installation authority instead of user-oriented repository permissions", async () => {
  const transport = new GitHubRestTransport({
    authorityProvider: async () => verifiedAuthority("verified-contents-write-token"),
    fetch: async input => {
      assert.equal(
        String(input),
        "https://api.github.com/installation/repositories?per_page=100&page=1"
      );
      return json({
        total_count: 1,
        repositories: [{
          id: repository.repositoryId,
          name: repository.name,
          default_branch: repository.defaultBranch,
          private: true,
          owner: { login: repository.owner },
          permissions: { admin: false, push: false, pull: true }
        }]
      });
    }
  });

  assert.deepEqual(await transport.listInstallationRepositories(repository.installationId), {
    ok: true,
    value: [{ ...repository, private: true, permissions: { contents: "write" } }]
  });
});

test("GitHub REST preserves primary and secondary rate-limit retry boundaries", async t => {
  const now = Date.UTC(2026, 6, 14, 8, 0, 0);
  const scenarios = [
    {
      name: "primary reset",
      status: 429,
      message: "API rate limit exceeded for installation ID 19.",
      headers: {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(Math.floor(now / 1_000) + 125),
        "x-github-request-id": "RATE:PRIMARY"
      },
      retryAfterSeconds: 125,
      requestId: "RATE:PRIMARY"
    },
    {
      name: "secondary retry-after",
      status: 403,
      message: "You have exceeded a secondary rate limit.",
      headers: { "retry-after": "73", "x-ratelimit-remaining": "4999" },
      retryAfterSeconds: 73,
      requestId: undefined
    },
    {
      name: "secondary fallback",
      status: 403,
      message: "Secondary rate limit exceeded.",
      headers: {},
      retryAfterSeconds: 60,
      requestId: undefined
    },
    {
      name: "primary fallback without reset header",
      status: 403,
      message: "API rate limit exceeded for installation ID 19.",
      headers: { "x-ratelimit-remaining": "0" },
      retryAfterSeconds: 60,
      requestId: undefined
    },
    {
      name: "bare 429 fallback",
      status: 429,
      message: "Too many requests",
      headers: {},
      retryAfterSeconds: 60,
      requestId: undefined
    }
  ] as const;

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const transport = new GitHubRestTransport({
        authorityProvider: async () => verifiedAuthority("rate-limited-token"),
        now: () => now,
        fetch: async () => new Response(JSON.stringify({ message: scenario.message }), {
          status: scenario.status,
          headers: { "content-type": "application/json", ...scenario.headers }
        })
      });

      const result = await transport.readBranchHead(repository, "hunsu/state");
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.deepEqual(result.error, {
        code: "rate_limited",
        message: scenario.message,
        status: scenario.status,
        retryAfterSeconds: scenario.retryAfterSeconds,
        ...(scenario.requestId ? { requestId: scenario.requestId } : {})
      });
    });
  }
});

test("GitHub REST serializes installation requests and short-circuits the Retry-After window", async () => {
  let now = Date.UTC(2026, 6, 14, 8, 0, 0);
  let authorityRequests = 0;
  let githubRequests = 0;
  const transport = new GitHubRestTransport({
    authorityProvider: async () => {
      authorityRequests += 1;
      return verifiedAuthority("rate-limited-token");
    },
    now: () => now,
    fetch: async () => {
      githubRequests += 1;
      if (githubRequests === 1) {
        return json({ message: "You have exceeded a secondary rate limit." }, 403, {
          "retry-after": "60",
          "x-github-request-id": "RATE:COOLDOWN"
        });
      }
      return json({ object: { sha: "a".repeat(40) } });
    }
  });

  const concurrent = await Promise.all([
    transport.readBranchHead(repository, "hunsu/state"),
    transport.readBranchHead(repository, "hunsu/state"),
    transport.readBranchHead(repository, "hunsu/state")
  ]);
  assert.equal(githubRequests, 1);
  assert.equal(authorityRequests, 1);
  for (const result of concurrent) {
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "rate_limited");
      assert.equal(result.error.retryAfterSeconds, 60);
      assert.equal(result.error.requestId, "RATE:COOLDOWN");
    }
  }

  now += 30_000;
  const waiting = await transport.readBranchHead(repository, "hunsu/state");
  assert.equal(waiting.ok, false);
  if (!waiting.ok) assert.equal(waiting.error.retryAfterSeconds, 30);
  assert.equal(githubRequests, 1);
  assert.equal(authorityRequests, 1);

  now += 30_000;
  assert.deepEqual(await transport.readBranchHead(repository, "hunsu/state"), {
    ok: true,
    value: "a".repeat(40)
  });
  assert.equal(githubRequests, 2);
  assert.equal(authorityRequests, 2);
});

test("GitHub REST applies installation cooldown when authority minting is rate limited", async () => {
  let now = Date.UTC(2026, 6, 14, 8, 0, 0);
  let authorityRequests = 0;
  let githubRequests = 0;
  const transport = new GitHubRestTransport({
    now: () => now,
    authorityProvider: async () => {
      authorityRequests += 1;
      if (authorityRequests === 1) {
        throw new GitHubAuthorityError({
          code: "rate_limited",
          message: "Too many installation token requests",
          status: 429,
          retryAfterSeconds: 47,
          requestId: "RATE:TOKEN-MINT"
        });
      }
      return verifiedAuthority("recovered-installation-token");
    },
    fetch: async () => {
      githubRequests += 1;
      return json({ object: { sha: "a".repeat(40) } });
    }
  });

  const concurrent = await Promise.all([
    transport.readBranchHead(repository, "hunsu/state"),
    transport.readBranchHead(repository, "hunsu/state"),
    transport.readBranchHead(repository, "hunsu/state")
  ]);
  assert.equal(authorityRequests, 1);
  assert.equal(githubRequests, 0);
  for (const result of concurrent) {
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "rate_limited");
      assert.equal(result.error.retryAfterSeconds, 47);
      assert.equal(result.error.requestId, "RATE:TOKEN-MINT");
    }
  }

  now += 47_000;
  assert.deepEqual(await transport.readBranchHead(repository, "hunsu/state"), {
    ok: true,
    value: "a".repeat(40)
  });
  assert.equal(authorityRequests, 2);
  assert.equal(githubRequests, 1);
});

test("GitHub REST suppresses queued token mints during transient and forbidden authority cooldowns", async t => {
  const scenarios = [
    {
      name: "upstream 503 with Retry-After",
      error: {
        code: "invalid_response" as const,
        message: "GitHub installation token request failed with 503.",
        status: 503,
        retryAfterSeconds: 7,
        requestId: "UPSTREAM:TOKEN-MINT"
      },
      cooldownMs: 7_000
    },
    {
      name: "non-rate 403",
      error: {
        code: "forbidden" as const,
        message: "GitHub rejected the installation token request.",
        status: 403,
        requestId: "AUTH:TOKEN-MINT"
      },
      cooldownMs: 30_000
    }
  ] as const;

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      let now = Date.UTC(2026, 6, 14, 8, 0, 0);
      let authorityRequests = 0;
      let githubRequests = 0;
      const transport = new GitHubRestTransport({
        now: () => now,
        authorityProvider: async () => {
          authorityRequests += 1;
          if (authorityRequests === 1) throw new GitHubAuthorityError(scenario.error);
          return verifiedAuthority("recovered-installation-token");
        },
        fetch: async () => {
          githubRequests += 1;
          return json({ object: { sha: "a".repeat(40) } });
        }
      });

      const concurrent = await Promise.all([
        transport.readBranchHead(repository, "hunsu/state"),
        transport.readBranchHead(repository, "hunsu/state"),
        transport.readBranchHead(repository, "hunsu/state")
      ]);
      assert.equal(authorityRequests, 1);
      assert.equal(githubRequests, 0);
      assert.equal(concurrent.every(result => !result.ok && result.error.code === scenario.error.code), true);

      now += scenario.cooldownMs - 1_000;
      const waiting = await transport.readBranchHead(repository, "hunsu/state");
      assert.equal(waiting.ok, false);
      assert.equal(authorityRequests, 1);
      assert.equal(githubRequests, 0);
      if (!waiting.ok && "retryAfterSeconds" in scenario.error) {
        assert.equal(waiting.error.retryAfterSeconds, 1);
      }

      now += 1_000;
      assert.deepEqual(await transport.readBranchHead(repository, "hunsu/state"), {
        ok: true,
        value: "a".repeat(40)
      });
      assert.equal(authorityRequests, 2);
      assert.equal(githubRequests, 1);
    });
  }
});

test("GitHub REST suppresses queued calls during upstream 5xx and network cooldowns", async t => {
  const scenarios = [
    {
      name: "REST 503 with Retry-After",
      cooldownMs: 7_000,
      firstResponse() {
        return json({ message: "GitHub is temporarily unavailable" }, 503, {
          "retry-after": "7",
          "x-github-request-id": "UPSTREAM:REST"
        });
      },
      expectedError: {
        code: "invalid_response" as const,
        message: "GitHub is temporarily unavailable",
        status: 503,
        retryAfterSeconds: 7,
        requestId: "UPSTREAM:REST"
      }
    },
    {
      name: "network failure",
      cooldownMs: 5_000,
      firstResponse(): Response {
        throw new Error("socket details must not escape");
      },
      expectedError: {
        code: "network" as const,
        message: "GitHub request failed before receiving a usable response.",
        retryAfterSeconds: 5
      }
    }
  ] as const;

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      let now = Date.UTC(2026, 6, 14, 8, 0, 0);
      let authorityRequests = 0;
      let githubRequests = 0;
      const transport = new GitHubRestTransport({
        now: () => now,
        authorityProvider: async () => {
          authorityRequests += 1;
          return verifiedAuthority("installation-token");
        },
        fetch: async () => {
          githubRequests += 1;
          return githubRequests === 1
            ? scenario.firstResponse()
            : json({ object: { sha: "a".repeat(40) } });
        }
      });

      const concurrent = await Promise.all([
        transport.readBranchHead(repository, "hunsu/state"),
        transport.readBranchHead(repository, "hunsu/state"),
        transport.readBranchHead(repository, "hunsu/state")
      ]);
      assert.equal(authorityRequests, 1);
      assert.equal(githubRequests, 1);
      for (const result of concurrent) {
        assert.equal(result.ok, false);
        if (!result.ok) assert.deepEqual(result.error, scenario.expectedError);
      }

      now += scenario.cooldownMs - 1_000;
      const waiting = await transport.readBranchHead(repository, "hunsu/state");
      assert.equal(waiting.ok, false);
      if (!waiting.ok) assert.equal(waiting.error.retryAfterSeconds, 1);
      assert.equal(authorityRequests, 1);
      assert.equal(githubRequests, 1);

      now += 1_000;
      assert.deepEqual(await transport.readBranchHead(repository, "hunsu/state"), {
        ok: true,
        value: "a".repeat(40)
      });
      assert.equal(authorityRequests, 2);
      assert.equal(githubRequests, 2);
    });
  }
});

test("GitHub REST times out a stalled fetch and releases queued installation requests", async () => {
  assert.throws(() => new GitHubRestTransport({
    authorityProvider: async () => verifiedAuthority("installation-token"),
    requestTimeoutMs: 2_147_483_648
  }), /between 1 and 2147483647 milliseconds/u);
  let now = Date.UTC(2026, 6, 14, 8, 0, 0);
  let authorityRequests = 0;
  let githubRequests = 0;
  const transport = new GitHubRestTransport({
    now: () => now,
    requestTimeoutMs: 20,
    authorityProvider: async () => {
      authorityRequests += 1;
      return verifiedAuthority("installation-token");
    },
    fetch: async (_input, init = {}) => {
      githubRequests += 1;
      if (githubRequests > 1) return json({ object: { sha: "a".repeat(40) } });
      return new Promise<Response>((_resolve, reject) => {
        const signal = init.signal;
        if (!signal) {
          reject(new Error("A GitHub request deadline signal was not provided."));
          return;
        }
        const aborted = () => reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
        if (signal.aborted) aborted();
        else signal.addEventListener("abort", aborted, { once: true });
      });
    }
  });

  const results = await Promise.race([
    Promise.all([
      transport.readBranchHead(repository, "hunsu/state"),
      transport.readBranchHead(repository, "hunsu/state")
    ]),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Queued GitHub request lock was not released.")), 500))
  ]);
  assert.equal(githubRequests, 1);
  assert.equal(authorityRequests, 1);
  for (const result of results) {
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "network");
      assert.equal(result.error.message, "GitHub request timed out before receiving a complete response.");
      assert.equal(result.error.retryAfterSeconds, 5);
    }
  }

  now += 5_000;
  assert.deepEqual(await transport.readBranchHead(repository, "hunsu/state"), {
    ok: true,
    value: "a".repeat(40)
  });
  assert.equal(githubRequests, 2);
  assert.equal(authorityRequests, 2);
});

test("GitHub REST times out a stalled installation authority and releases its request lock", async () => {
  let now = Date.UTC(2026, 6, 14, 8, 0, 0);
  let authorityRequests = 0;
  let githubRequests = 0;
  const transport = new GitHubRestTransport({
    now: () => now,
    requestTimeoutMs: 20,
    authorityProvider: async () => {
      authorityRequests += 1;
      if (authorityRequests === 1) return new Promise(() => {});
      return verifiedAuthority("recovered-installation-token");
    },
    fetch: async () => {
      githubRequests += 1;
      return json({ object: { sha: "a".repeat(40) } });
    }
  });

  const results = await Promise.race([
    Promise.all([
      transport.readBranchHead(repository, "hunsu/state"),
      transport.readBranchHead(repository, "hunsu/state")
    ]),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Stalled authority kept the request lock.")), 500))
  ]);
  assert.equal(authorityRequests, 1);
  assert.equal(githubRequests, 0);
  for (const result of results) {
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "network");
      assert.equal(result.error.message, "GitHub request timed out before receiving a complete response.");
      assert.equal(result.error.retryAfterSeconds, 5);
    }
  }

  now += 5_000;
  assert.deepEqual(await transport.readBranchHead(repository, "hunsu/state"), {
    ok: true,
    value: "a".repeat(40)
  });
  assert.equal(authorityRequests, 2);
  assert.equal(githubRequests, 1);
});

test("GitHub REST invalidates a rejected installation token and retries once", async () => {
  let authorityVersion = 1;
  const authorizationHeaders: string[] = [];
  let invalidations = 0;
  const transport = new GitHubRestTransport({
    authorityProvider: async () => verifiedAuthority(`installation-token-${authorityVersion}`),
    invalidateAuthority: (installationId, rejectedToken) => {
      assert.equal(installationId, repository.installationId);
      assert.equal(rejectedToken, "installation-token-1");
      invalidations += 1;
      authorityVersion += 1;
    },
    fetch: async (_input, init = {}) => {
      authorizationHeaders.push(new Headers(init.headers).get("authorization") ?? "");
      return authorizationHeaders.length === 1
        ? json({ message: "Bad credentials" }, 401)
        : json({ object: { sha: "a".repeat(40) } });
    }
  });

  assert.deepEqual(await transport.readBranchHead(repository, "hunsu/state"), {
    ok: true,
    value: "a".repeat(40)
  });
  assert.equal(invalidations, 1);
  assert.deepEqual(authorizationHeaders, [
    "Bearer installation-token-1",
    "Bearer installation-token-2"
  ]);
});

test("GitHub REST reads and creates immutable managed Node tags", async () => {
  const nodeSha = "b".repeat(40);
  const ref = `refs/tags/hunsu/node/project-alpha/${nodeSha}`;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const transport = new GitHubRestTransport({
    authorityProvider: async () => verifiedAuthority("verified-contents-write-token"),
    fetch: async (input, init = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if ((init.method ?? "GET") === "GET" && url.endsWith(`/git/ref/tags/hunsu/node/project-alpha/${nodeSha}`)) {
        return json({ ref, object: { sha: nodeSha } });
      }
      if (init.method === "POST" && url.endsWith("/git/refs")) {
        return json({ ref, object: { sha: nodeSha } }, 201);
      }
      return json({ message: `Unexpected ${init.method ?? "GET"} ${url}` }, 500);
    }
  });

  assert.deepEqual(await transport.readRef(repository, ref), { ok: true, value: nodeSha });
  assert.deepEqual(await transport.createRef(repository, ref, nodeSha), { ok: true, value: nodeSha });
  const read = calls[0];
  assert.equal(read.init.cache, "no-store");
  const create = calls[1];
  assert.equal(create.init.method, "POST");
  assert.deepEqual(JSON.parse(String(create.init.body)), { ref, sha: nodeSha });
});

test("GitHub REST batches managed Node anchor verification by paginated ref connection", async () => {
  const projectId = "project-alpha";
  const prefix = `refs/tags/hunsu/node/${projectId}/`;
  const commits = Array.from({ length: 201 }, (_, index) => {
    const nodeSha = (index + 1).toString(16).padStart(40, "0");
    return {
      prefix: "refs/tags/",
      name: `hunsu/node/${projectId}/${nodeSha}`,
      target: {
        __typename: "Commit",
        oid: nodeSha,
        message: `Node ${index + 1}\n\nManaged by Hunsu.`,
        tree: { oid: (index + 1001).toString(16).padStart(40, "0") }
      }
    };
  });
  const bodies: Array<Record<string, unknown>> = [];
  const transport = new GitHubRestTransport({
    authorityProvider: async () => verifiedAuthority("verified-contents-write-token"),
    fetch: async (_input, init = {}) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      bodies.push(body);
      const variables = body.variables as Record<string, unknown>;
      const after = variables.after;
      const offset = after === null ? 0 : Number(String(after).replace("cursor-", ""));
      const nodes = commits.slice(offset, offset + 100);
      const next = offset + nodes.length;
      return json({
        data: {
          repository: {
            refs: {
              nodes,
              pageInfo: {
                hasNextPage: next < commits.length,
                endCursor: next < commits.length ? `cursor-${next}` : null
              }
            }
          }
        }
      });
    }
  });

  const result = await transport.listManagedNodeAnchors(repository, projectId);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.length, 201);
  assert.equal(bodies.length, 3, "201 Nodes require three GraphQL requests, not 402 per-Node REST calls");
  assert.deepEqual(bodies.map(body => (body.variables as Record<string, unknown>).after), [null, "cursor-100", "cursor-200"]);
  assert.equal((bodies[0]!.variables as Record<string, unknown>).refPrefix, prefix);
  assert.match(String(bodies[0]!.query), /refs\(refPrefix: \$refPrefix/u);
  assert.deepEqual(result.value[0], {
    managedRef: `${commits[0]!.prefix}${commits[0]!.name}`,
    nodeSha: commits[0]!.target.oid,
    treeSha: commits[0]!.target.tree.oid,
    commitMessage: commits[0]!.target.message
  });
});

test("GitHub REST accepts GitHub's scoped prefix split for managed Node refs", async () => {
  const projectId = "Project_Alpha";
  const nodeSha = "b".repeat(40);
  const treeSha = "c".repeat(40);
  const refPrefix = `refs/tags/hunsu/node/${projectId}/`;
  const transport = new GitHubRestTransport({
    authorityProvider: async () => verifiedAuthority("verified-contents-write-token"),
    fetch: async () => json({
      data: {
        repository: {
          refs: {
            nodes: [{
              prefix: refPrefix,
              name: nodeSha,
              target: {
                __typename: "Commit",
                oid: nodeSha,
                message: "Production root",
                tree: { oid: treeSha }
              }
            }],
            pageInfo: { hasNextPage: false, endCursor: null }
          }
        }
      }
    })
  });

  assert.deepEqual(await transport.listManagedNodeAnchors(repository, projectId), {
    ok: true,
    value: [{
      managedRef: `${refPrefix}${nodeSha}`,
      nodeSha,
      treeSha,
      commitMessage: "Production root"
    }]
  });
});

test("GitHub REST rejects arbitrary managed Node ref splits even when they concatenate to the expected ref", async () => {
  const projectId = "project-alpha";
  const nodeSha = "b".repeat(40);
  const transport = new GitHubRestTransport({
    authorityProvider: async () => verifiedAuthority("verified-contents-write-token"),
    fetch: async () => json({
      data: {
        repository: {
          refs: {
            nodes: [{
              prefix: "refs/tags/hunsu/",
              name: `node/${projectId}/${nodeSha}`,
              target: {
                __typename: "Commit",
                oid: nodeSha,
                message: "Production root",
                tree: { oid: "c".repeat(40) }
              }
            }],
            pageInfo: { hasNextPage: false, endCursor: null }
          }
        }
      }
    })
  });

  const result = await transport.listManagedNodeAnchors(repository, projectId);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "invalid_response");
    assert.match(result.error.message, /invalid managed Node ref or commit/u);
  }
});

test("GitHub REST verifies only requested managed Node anchors in bounded exact batches", async () => {
  const projectId = "project-alpha";
  const nodeShas = Array.from({ length: 101 }, (_, index) => (index + 1).toString(16).padStart(40, "0"));
  const bodies: Array<{ query: string; variables: Record<string, string> }> = [];
  const transport = new GitHubRestTransport({
    authorityProvider: async () => verifiedAuthority("verified-contents-write-token"),
    fetch: async (_input, init = {}) => {
      const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, string> };
      bodies.push(body);
      const refs = Object.entries(body.variables).filter(([key]) => /^ref\d+$/u.test(key));
      return json({ data: { repository: Object.fromEntries(refs.map(([key, ref]) => {
        const nodeSha = ref.split("/").at(-1)!;
        return [key.replace("ref", "r"), {
          target: {
            __typename: "Commit", oid: nodeSha, message: `Node ${nodeSha.slice(-4)}`,
            tree: { oid: `${nodeSha.slice(0, 39)}f` }
          }
        }];
      })) } });
    }
  });

  const result = await transport.readManagedNodeAnchors(repository, projectId, nodeShas);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.length, 101);
  assert.equal(bodies.length, 3);
  assert.deepEqual(bodies.map(body => Object.keys(body.variables).filter(key => /^ref\d+$/u.test(key)).length), [50, 50, 1]);
  assert.equal(bodies.every(body => body.query.includes("ref(qualifiedName:") && !body.query.includes("refs(refPrefix:")), true);
  assert.deepEqual(result.value.map(anchor => anchor.nodeSha), nodeShas);
});

test("GitHub REST rejects unmanaged refs and mismatched managed-ref creation responses", async () => {
  const nodeSha = "b".repeat(40);
  const ref = `refs/tags/hunsu/node/project-alpha/${nodeSha}`;
  let calls = 0;
  const transport = new GitHubRestTransport({
    authorityProvider: async () => verifiedAuthority("verified-contents-write-token"),
    fetch: async () => {
      calls += 1;
      return json({
        ref: `refs/tags/hunsu/node/project-beta/${nodeSha}`,
        object: { sha: nodeSha }
      }, 201);
    }
  });

  const unmanagedRead = await transport.readRef(repository, "refs/tags/release/v1");
  assert.equal(unmanagedRead.ok, false);
  if (!unmanagedRead.ok) assert.equal(unmanagedRead.error.code, "invalid_response");
  const invalidSha = await transport.createRef(repository, ref, "not-a-full-sha");
  assert.equal(invalidSha.ok, false);
  if (!invalidSha.ok) assert.equal(invalidSha.error.code, "invalid_response");
  assert.equal(calls, 0);

  const mismatched = await transport.createRef(repository, ref, nodeSha);
  assert.equal(mismatched.ok, false);
  if (!mismatched.ok) {
    assert.equal(mismatched.error.code, "invalid_response");
    assert.match(mismatched.error.message, /unexpected ref or commit SHA/u);
  }
  assert.equal(calls, 1);
});

test("GitHub REST reads full commit structure and maps a missing commit to undefined", async () => {
  const commitSha = "c".repeat(40);
  const treeSha = "d".repeat(40);
  const parentSha = "a".repeat(40);
  let missing = false;
  const transport = new GitHubRestTransport({
    authorityProvider: async () => verifiedAuthority("verified-contents-write-token"),
    fetch: async input => missing
      ? json({ message: "Not Found" }, 404)
      : json({ sha: commitSha, tree: { sha: treeSha }, parents: [{ sha: parentSha }], message: "Run result\n\nEvidence complete." })
  });

  assert.deepEqual(await transport.readCommit(repository, commitSha), {
    ok: true,
    value: { sha: commitSha, treeSha, parentShas: [parentSha], message: "Run result\n\nEvidence complete." }
  });
  missing = true;
  assert.deepEqual(await transport.readCommit(repository, commitSha), { ok: true, value: undefined });
});

test("GitHub REST creates deterministic Coaching-compatible commits", async () => {
  const sourceSha = "a".repeat(40);
  const treeSha = "b".repeat(40);
  const coachingSha = "c".repeat(40);
  const timestamp = "2026-07-15T01:02:03.000Z";
  const message = `Hunsu coaching project-alpha/proposal-one\n\nNode-Plan-Digest: ${"d".repeat(64)}`;
  const bodies: unknown[] = [];
  const transport = new GitHubRestTransport({
    authorityProvider: async () => verifiedAuthority("verified-contents-write-token"),
    fetch: async (_input, init = {}) => {
      bodies.push(JSON.parse(String(init.body)));
      return json({ sha: coachingSha, tree: { sha: treeSha }, parents: [{ sha: sourceSha }], message }, 201);
    }
  });
  const input = { repository, parentSha: sourceSha, treeSha, message, timestamp };

  const expected = {
    ok: true as const,
    value: { sha: coachingSha, treeSha, parentShas: [sourceSha], message }
  };
  assert.deepEqual(await transport.createCommit(input), expected);
  assert.deepEqual(await transport.createCommit(input), expected);
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[0], {
    message,
    tree: treeSha,
    parents: [sourceSha],
    author: { name: "Hunsu", email: "noreply@hunsu.app", date: timestamp },
    committer: { name: "Hunsu", email: "noreply@hunsu.app", date: timestamp }
  });
  assert.deepEqual(bodies[1], bodies[0]);
});

test("GitHub REST rejects malformed commit inputs and responses", async () => {
  const sourceSha = "a".repeat(40);
  const treeSha = "b".repeat(40);
  let calls = 0;
  const transport = new GitHubRestTransport({
    authorityProvider: async () => verifiedAuthority("verified-contents-write-token"),
    fetch: async () => {
      calls += 1;
      return json({ sha: "c".repeat(40), tree: { sha: treeSha }, parents: [], message: "Coaching" }, 201);
    }
  });

  const invalid = await transport.createCommit({
    repository,
    parentSha: sourceSha,
    treeSha,
    message: "Coaching",
    timestamp: "2026-07-15T01:02:03Z"
  });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.error.code, "invalid_response");
  assert.equal(calls, 0);

  const malformed = await transport.readCommit(repository, sourceSha);
  assert.equal(malformed.ok, false);
  if (!malformed.ok) {
    assert.equal(malformed.error.code, "invalid_response");
    assert.match(malformed.error.message, /invalid SHA/u);
  }
  assert.equal(calls, 1);

  const mismatchedCreated = new GitHubRestTransport({
    authorityProvider: async () => verifiedAuthority("verified-contents-write-token"),
    fetch: async () => json({
      sha: "c".repeat(40),
      tree: { sha: treeSha },
      parents: [{ sha: sourceSha }],
      message: "Unexpected message"
    }, 201)
  });
  const mismatched = await mismatchedCreated.createCommit({
    repository,
    parentSha: sourceSha,
    treeSha,
    message: "Coaching",
    timestamp: "2026-07-15T01:02:03.000Z"
  });
  assert.equal(mismatched.ok, false);
  if (!mismatched.ok) assert.match(mismatched.error.message, /exactly match/u);
});

test("GitHub REST initializes state from the created ref response without rereading the ref", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const transport = new GitHubRestTransport({
    authorityProvider: async () => verifiedAuthority("verified-contents-write-token"),
    fetch: async (input, init = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (init.method === "POST" && url.endsWith("/git/refs")) {
        return json({ ref: "refs/heads/hunsu/state", object: { sha: "a".repeat(40) } }, 201);
      }
      if (url.endsWith(`/git/commits/${"a".repeat(40)}`)) {
        return json({ tree: { sha: "created-root-tree" } });
      }
      if (url.endsWith("/git/trees/created-root-tree")) {
        return json({ tree: [{ path: ".hunsu", type: "tree", sha: "created-state-tree" }] });
      }
      if (url.endsWith("/git/trees/created-state-tree")) {
        return json({ tree: [{ path: "v2", type: "tree", sha: "created-v2-tree" }] });
      }
      if (url.endsWith("/git/trees/created-v2-tree?recursive=1")) {
        return json({ truncated: false, tree: [{ path: `projects/project-alpha/events/2026/07/${"1".repeat(32)}.json`, type: "blob", sha: "event-blob" }] });
      }
      if (url.endsWith("/graphql")) {
        return graphqlBlobResponse(init, new Map([["event-blob", "{}\n"]]));
      }
      return json({ message: `Unexpected ${init.method ?? "GET"} ${url}` }, 500);
    }
  });

  assert.deepEqual(await transport.createBranch(repository, "hunsu/state", "a".repeat(40)), {
    ok: true,
    value: {
      headSha: "a".repeat(40),
      files: { [`.hunsu/v2/projects/project-alpha/events/2026/07/${"1".repeat(32)}.json`]: "{}\n" }
    }
  });
  assert.equal(calls.some(call => call.url.includes("/git/ref/")), false);
});

test("GitHub REST rejects a created branch response with the wrong ref or base SHA", async () => {
  const baseSha = "a".repeat(40);
  let calls = 0;
  const transport = new GitHubRestTransport({
    authorityProvider: async () => verifiedAuthority("verified-contents-write-token"),
    fetch: async () => {
      calls += 1;
      return json({ ref: "refs/heads/hunsu/run/wrong", object: { sha: "b".repeat(40) } }, 201);
    }
  });
  const created = await transport.createBranch(repository, "hunsu/run/project/base/run", baseSha);
  assert.equal(created.ok, false);
  if (!created.ok) assert.match(created.error.message, /unexpected ref or base commit/u);
  assert.equal(calls, 1, "a mismatched create response must fail before any tree read");
});

test("GitHub REST reads only the dedicated state subtree", async () => {
  const headSha = "d".repeat(40);
  const calls: string[] = [];
  const transport = new GitHubRestTransport({
    authorityProvider: async () => verifiedAuthority("test-installation-value"),
    fetch: async (input, init = {}) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/git/ref/heads/hunsu/state")) return json({ object: { sha: headSha } });
      if (url.endsWith(`/git/commits/${headSha}`)) return json({ tree: { sha: "root-tree" } });
      if (url.endsWith("/git/trees/root-tree")) return json({ tree: [
        { path: ".hunsu", type: "tree", sha: "state-tree" },
        { path: "src", type: "tree", sha: "source-tree" }
      ] });
      if (url.endsWith("/git/trees/state-tree")) return json({ tree: [
        { path: "v2", type: "tree", sha: "v2-tree" },
        { path: "legacy", type: "tree", sha: "v1-tree" }
      ] });
      if (url.endsWith("/git/trees/v2-tree?recursive=1")) return json({ truncated: false, tree: [
        { path: eventPath, type: "blob", sha: "event-blob" }
      ] });
      if (url.endsWith("/graphql")) {
        return graphqlBlobResponse(init, new Map([["event-blob", "{}\n"]]));
      }
      return json({ message: `Unexpected ${url}` }, 500);
    }
  });
  const result = await transport.readBranch(repository, "hunsu/state");
  assert.deepEqual(result, { ok: true, value: { headSha, files: { [eventFilePath]: "{}\n" } } });
  assert.equal(calls.some(url => url.includes("source-tree")), false);
  assert.equal(calls.some(url => url.includes("v1-tree")), false);
});

for (const scenario of ["repository root", "Hunsu state root"] as const) {
  test(`GitHub REST rejects a truncated ${scenario} before treating v2 state as absent`, async () => {
    const headSha = "d".repeat(40);
    const transport = new GitHubRestTransport({
      authorityProvider: async () => verifiedAuthority("test-installation-value"),
      fetch: async input => {
        const url = String(input);
        if (url.includes("/git/ref/heads/hunsu/state")) return json({ object: { sha: headSha } });
        if (url.endsWith(`/git/commits/${headSha}`)) return json({ tree: { sha: "root-tree" } });
        if (url.endsWith("/git/trees/root-tree")) {
          return scenario === "repository root"
            ? json({ truncated: true, tree: [] })
            : json({ truncated: false, tree: [{ path: ".hunsu", type: "tree", sha: "state-tree" }] });
        }
        if (url.endsWith("/git/trees/state-tree")) return json({ truncated: true, tree: [] });
        return json({ message: `Unexpected ${url}` }, 500);
      }
    });

    const result = await transport.readBranch(repository, "hunsu/state");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "invalid_response");
      assert.match(result.error.message, /truncated/u);
    }
  });
}

test("GitHub REST fetches reconstruction inputs without downloading derived materializations", async () => {
  const headSha = "d".repeat(40);
  const eventContent = "{\"schema\":\"hunsu.project-event.v2\"}\n";
  const derived = [
    { path: "projects/project-alpha/project.json", sha: "project-blob" },
    { path: `projects/project-alpha/nodes/${"a".repeat(40)}/node.hunsu`, sha: "node-blob" },
    { path: "projects/project-alpha/graph/latest.json", sha: "graph-blob" },
    { path: "projects/project-alpha/snapshots/latest.json", sha: "snapshot-blob" }
  ];
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const transport = new GitHubRestTransport({
    authorityProvider: async () => verifiedAuthority("test-installation-value"),
    fetch: async (input, init = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/git/ref/heads/hunsu/state")) return json({ object: { sha: headSha } });
      if (url.endsWith(`/git/commits/${headSha}`)) return json({ tree: { sha: "root-tree" } });
      if (url.endsWith("/git/trees/root-tree")) {
        return json({ tree: [{ path: ".hunsu", type: "tree", sha: "state-tree" }] });
      }
      if (url.endsWith("/git/trees/state-tree")) {
        return json({ tree: [{ path: "v2", type: "tree", sha: "v2-tree" }] });
      }
      if (url.endsWith("/git/trees/v2-tree?recursive=1")) {
        return json({ truncated: false, tree: [
          { path: "workspace.json", type: "blob", sha: "workspace-blob", size: 100 },
          { path: eventPath, type: "blob", sha: "event-blob", size: Buffer.byteLength(eventContent, "utf8") },
          ...derived.map(entry => ({ ...entry, type: "blob", size: 100 }))
        ] });
      }
      if (url.endsWith("/graphql")) {
        return graphqlBlobResponse(init, new Map([
          ["event-blob", eventContent]
        ]));
      }
      return json({ message: `Unexpected ${init.method ?? "GET"} ${url}` }, 500);
    }
  });

  assert.deepEqual(await transport.readBranch(repository, "hunsu/state"), {
    ok: true,
    value: {
      headSha,
      files: {
        [`.hunsu/v2/${eventPath}`]: eventContent
      }
    }
  });
  const requestedOids = calls
    .filter(call => call.url.endsWith("/graphql"))
    .flatMap(call => graphqlOidVariables((JSON.parse(String(call.init.body)) as { variables: Record<string, string> }).variables));
  assert.deepEqual(requestedOids, ["event-blob"]);
  assert.equal(derived.some(entry => requestedOids.includes(entry.sha)), false);
});

test("exact-head dashboard reads fetch only requested read models or the selected Node payload", async () => {
  const headSha = "e".repeat(40);
  const selectedNodeSha = "a".repeat(40);
  const siblingNodeSha = "b".repeat(40);
  const projectRoot = ".hunsu/v2/projects/project-alpha";
  const fixtures = [
    { path: ".hunsu/v2/workspace.json", sha: "1".repeat(40), content: "workspace\n" },
    { path: `${projectRoot}/project.json`, sha: "2".repeat(40), content: "catalog alpha\n" },
    { path: ".hunsu/v2/projects/project-beta/project.json", sha: "3".repeat(40), content: "catalog beta\n" },
    { path: `${projectRoot}/graph/latest.json`, sha: "4".repeat(40), content: "graph\n" },
    { path: `${projectRoot}/snapshots/latest.json`, sha: "5".repeat(40), content: "activity\n" },
    { path: `${projectRoot}/indexes/events/latest.json`, sha: "6".repeat(40), content: "event index\n" },
    { path: `${projectRoot}/events/2026/07/${"1".repeat(32)}.json`, sha: "7".repeat(40), content: "raw event\n" },
    { path: `${projectRoot}/nodes/${selectedNodeSha}/node.hunsu`, sha: "8".repeat(40), content: "selected node\n" },
    { path: `${projectRoot}/nodes/${siblingNodeSha}/node.hunsu`, sha: "9".repeat(40), content: "sibling node\n" }
  ];
  const fixtureByPath = new Map(fixtures.map(fixture => [fixture.path, fixture]));
  const contents = new Map(fixtures.map(fixture => [fixture.sha, fixture.content]));
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const transport = new GitHubRestTransport({
    authorityProvider: async () => verifiedAuthority("test-installation-value"),
    fetch: async (input, init = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/graphql")) {
        const body = JSON.parse(String(init.body)) as { query: string };
        return body.query.includes("ResolveExactHunsuState")
          ? graphqlExactStateResponse(init, headSha, fixtureByPath)
          : graphqlBlobResponse(init, contents);
      }
      return json({ message: `Unexpected ${init.method ?? "GET"} ${url}` }, 500);
    }
  });

  const reads = [
    {
      selections: [
        { kind: "workspace" },
        { kind: "project_read_model", projectId: "project-alpha", model: "catalog" },
        { kind: "project_read_model", projectId: "project-beta", model: "catalog" }
      ] as const,
      expectedPaths: [
        ".hunsu/v2/projects/project-alpha/project.json",
        ".hunsu/v2/projects/project-beta/project.json",
        ".hunsu/v2/workspace.json"
      ],
      expectedOids: ["1".repeat(40), "2".repeat(40), "3".repeat(40)]
    },
    {
      selections: [{ kind: "project_read_model", projectId: "project-alpha", model: "graph" }] as const,
      expectedPaths: [`${projectRoot}/graph/latest.json`],
      expectedOids: ["4".repeat(40)]
    },
    {
      selections: [{ kind: "project_read_model", projectId: "project-alpha", model: "event_index" }] as const,
      expectedPaths: [`${projectRoot}/indexes/events/latest.json`],
      expectedOids: ["6".repeat(40)]
    },
    {
      selections: [{ kind: "node_payload", projectId: "project-alpha", nodeSha: selectedNodeSha }] as const,
      expectedPaths: [`${projectRoot}/nodes/${selectedNodeSha}/node.hunsu`],
      expectedOids: ["8".repeat(40)]
    }
  ];

  for (const read of reads) {
    const start = calls.length;
    const result = await transport.readStateFilesAtHead(repository, headSha, read.selections);
    assert.equal(result.ok, true);
    if (!result.ok) continue;
    assert.equal(result.value.stateHeadSha, headSha);
    assert.equal(result.value.v2State, "present");
    assert.deepEqual(Object.keys(result.value.files).sort(), [...read.expectedPaths].sort());
    const readCalls = calls.slice(start);
    const requestedOids = readCalls
      .filter(call => call.url.endsWith("/graphql"))
      .flatMap(call => graphqlOidVariables((JSON.parse(String(call.init.body)) as { variables: Record<string, string> }).variables));
    assert.deepEqual(requestedOids.sort(), [...read.expectedOids].sort());
    const requestedPaths = readCalls
      .filter(call => call.url.endsWith("/graphql"))
      .flatMap(call => graphqlExpressionPaths((JSON.parse(String(call.init.body)) as { variables: Record<string, string> }).variables, headSha));
    assert.deepEqual(requestedPaths.sort(), [...read.expectedPaths].sort());
    assert.equal(readCalls.some(call => call.url.includes("/git/trees/")), false);
    assert.equal(readCalls.some(call => call.url.includes("/git/commits/")), false);
    assert.equal(readCalls.some(call => call.url.includes("/git/ref/")), false);
    assert.equal(requestedOids.includes("7".repeat(40)), false);
    assert.equal(requestedOids.includes("9".repeat(40)), false);
  }
});

test("exact-head reads distinguish a v1-only state commit from corrupt v2 state", async () => {
  const headSha = "c".repeat(40);
  const v1Calls: Array<{ url: string; init: RequestInit }> = [];
  const v1Only = new GitHubRestTransport({
    authorityProvider: async () => verifiedAuthority("test-installation-value"),
    fetch: async (input, init = {}) => {
      v1Calls.push({ url: String(input), init });
      return json({ data: { repository: {
        head: { __typename: "Commit", oid: headSha },
        v2: null,
        b0: null
      } } });
    }
  });

  assert.deepEqual(await v1Only.readStateFilesAtHead(repository, headSha, [{ kind: "workspace" }]), {
    ok: true,
    value: { stateHeadSha: headSha, v2State: "absent", files: {} }
  });
  const derived = await v1Only.readStateFilesAtHead(repository, headSha, [{
    kind: "project_read_model",
    projectId: "project-alpha",
    model: "graph"
  }]);
  assert.equal(derived.ok, false);
  if (!derived.ok) assert.equal(derived.error.code, "not_found");
  assert.equal(v1Calls.length, 2);
  assert.equal(v1Calls.some(call => call.url.includes("/git/trees/")), false);

  let corruptCalls = 0;
  const corruptV2 = new GitHubRestTransport({
    authorityProvider: async () => verifiedAuthority("test-installation-value"),
    fetch: async () => {
      corruptCalls += 1;
      return json({ data: { repository: {
        head: { __typename: "Commit", oid: headSha },
        v2: { __typename: "Tree", oid: "d".repeat(40) },
        b0: null
      } } });
    }
  });
  const corrupt = await corruptV2.readStateFilesAtHead(repository, headSha, [{ kind: "workspace" }]);
  assert.equal(corrupt.ok, false);
  if (!corrupt.ok) assert.equal(corrupt.error.code, "not_found");
  assert.equal(corruptCalls, 1);
});

for (const scenario of [
  {
    name: "a missing exact head",
    repositoryData: { head: null, v2: null, b0: null },
    code: "not_found"
  },
  {
    name: "a mismatched exact head OID",
    repositoryData: {
      head: { __typename: "Commit", oid: "d".repeat(40) },
      v2: { __typename: "Tree", oid: "a".repeat(40) },
      b0: null
    },
    code: "invalid_response"
  },
  {
    name: "a non-commit exact head",
    repositoryData: {
      head: { __typename: "Blob", oid: "c".repeat(40) },
      v2: { __typename: "Tree", oid: "a".repeat(40) },
      b0: null
    },
    code: "invalid_response"
  },
  {
    name: "a non-tree v2 root",
    repositoryData: {
      head: { __typename: "Commit", oid: "c".repeat(40) },
      v2: { __typename: "Blob", oid: "a".repeat(40) },
      b0: null
    },
    code: "invalid_response"
  },
  {
    name: "a non-blob selected path",
    repositoryData: {
      head: { __typename: "Commit", oid: "c".repeat(40) },
      v2: { __typename: "Tree", oid: "a".repeat(40) },
      b0: { __typename: "Tree", oid: "b".repeat(40) }
    },
    code: "invalid_response"
  }
] as const) {
  test(`exact-head reads reject ${scenario.name}`, async () => {
    const headSha = "c".repeat(40);
    let calls = 0;
    const transport = new GitHubRestTransport({
      authorityProvider: async () => verifiedAuthority("test-installation-value"),
      fetch: async () => {
        calls += 1;
        return json({ data: { repository: scenario.repositoryData } });
      }
    });
    const result = await transport.readStateFilesAtHead(repository, headSha, [{ kind: "workspace" }]);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, scenario.code);
    assert.equal(calls, 1);
  });
}

test("exact-head reads reject oversized metadata before requesting blob content or REST fallback", async () => {
  const headSha = "c".repeat(40);
  const nodeSha = "b".repeat(40);
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const transport = new GitHubRestTransport({
    authorityProvider: async () => verifiedAuthority("test-installation-value"),
    fetch: async (input, init = {}) => {
      calls.push({ url: String(input), init });
      return json({ data: { repository: {
        head: { __typename: "Commit", oid: headSha },
        v2: { __typename: "Tree", oid: "a".repeat(40) },
        b0: {
          __typename: "Blob",
          oid: "d".repeat(40),
          byteSize: 2 * 1024 * 1024 + 1,
          isBinary: false
        }
      } } });
    }
  });
  const result = await transport.readStateFilesAtHead(repository, headSha, [{
    kind: "node_payload",
    projectId: "project-alpha",
    nodeSha
  }]);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "invalid_response");
    assert.match(result.error.message, /exceeds its/u);
  }
  assert.equal(calls.length, 1);
  assert.equal(calls.some(call => call.url.includes("/git/blobs/")), false);
  const query = (JSON.parse(String(calls[0].init.body)) as { query: string }).query;
  assert.match(query, /ResolveExactHunsuState/u);
  assert.doesNotMatch(query, /ReadHunsuBlobs/u);
});

test("exact-head reads single-flight and cache immutable selections without sharing mutable snapshots", async () => {
  const headSha = "c".repeat(40);
  const path = ".hunsu/v2/workspace.json";
  const content = "workspace current\n";
  const fixture = { sha: "d".repeat(40), content };
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const transport = new GitHubRestTransport({
    authorityProvider: async () => verifiedAuthority("test-installation-value"),
    fetch: async (input, init = {}) => {
      calls.push({ url: String(input), init });
      const body = JSON.parse(String(init.body)) as { query: string };
      return body.query.includes("ResolveExactHunsuState")
        ? graphqlExactStateResponse(init, headSha, new Map([[path, fixture]]))
        : graphqlBlobResponse(init, new Map([[fixture.sha, fixture.content]]));
    }
  });
  const selection = [{ kind: "workspace" }] as const;
  const concurrent = await Promise.all([
    transport.readStateFilesAtHead(repository, headSha, selection),
    transport.readStateFilesAtHead(repository, headSha, selection),
    transport.readStateFilesAtHead(repository, headSha, selection)
  ]);
  assert.equal(concurrent.every(result => result.ok), true);
  assert.equal(calls.length, 2);
  const first = concurrent[0];
  if (first.ok) (first.value.files as Record<string, string>)[path] = "mutated\n";
  const cached = await transport.readStateFilesAtHead(repository, headSha, selection);
  assert.equal(cached.ok, true);
  if (cached.ok) assert.equal(cached.value.files[path], content);
  assert.equal(calls.length, 2);
});

test("exact-head reads bound truncated-blob REST fallback to four objects", async () => {
  const headSha = "c".repeat(40);
  const fixtures = Array.from({ length: 5 }, (_, index) => ({
    path: `.hunsu/v2/projects/project-${index}/project.json`,
    sha: (index + 1).toString(16).repeat(40),
    content: `catalog ${index}\n`
  }));
  const fixtureByPath = new Map(fixtures.map(fixture => [fixture.path, fixture]));
  const contentByOid = new Map(fixtures.map(fixture => [fixture.sha, fixture.content]));
  let restReads = 0;
  const transport = new GitHubRestTransport({
    authorityProvider: async () => verifiedAuthority("test-installation-value"),
    fetch: async (input, init = {}) => {
      const url = String(input);
      if (url.endsWith("/graphql")) {
        const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, string> };
        if (body.query.includes("ResolveExactHunsuState")) return graphqlExactStateResponse(init, headSha, fixtureByPath);
        const oids = graphqlOidVariables(body.variables);
        return json({ data: { repository: Object.fromEntries(oids.map((oid, index) => [
          `b${index}`,
          { ...graphqlBlob(oid, contentByOid.get(oid) ?? ""), text: null }
        ])) } });
      }
      const oid = url.match(/\/git\/blobs\/([0-9a-f]{40})$/u)?.[1];
      if (oid) {
        restReads += 1;
        const content = contentByOid.get(oid) ?? "";
        return json({
          sha: oid,
          size: Buffer.byteLength(content, "utf8"),
          encoding: "base64",
          content: Buffer.from(content, "utf8").toString("base64")
        });
      }
      return json({ message: `Unexpected ${url}` }, 500);
    }
  });
  const result = await transport.readStateFilesAtHead(repository, headSha, fixtures.map((_, index) => ({
    kind: "project_read_model" as const,
    projectId: `project-${index}`,
    model: "catalog" as const
  })));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error.message, /too many truncated/u);
  assert.equal(restReads, 4);
});

test("GitHub REST batches 501 unique state blob OIDs into two GraphQL requests and deduplicates a shared OID", async () => {
  const headSha = "d".repeat(40);
  const fixtures = stateBlobFixtures(501);
  const contents = new Map(fixtures.map(fixture => [fixture.sha, fixture.content]));
  const entries = fixtures.map(fixture => ({
    path: fixture.path,
    type: "blob",
    sha: fixture.sha,
    size: Buffer.byteLength(fixture.content, "utf8")
  }));
  const sharedPath = `projects/project-beta/events/2026/07/${"f".repeat(32)}.json`;
  entries.push({ ...entries[0], path: sharedPath });
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const transport = new GitHubRestTransport({
    authorityProvider: async () => verifiedAuthority("test-installation-value"),
    fetch: async (input, init = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/git/ref/heads/hunsu/state")) return json({ object: { sha: headSha } });
      if (url.endsWith(`/git/commits/${headSha}`)) return json({ tree: { sha: "root-tree" } });
      if (url.endsWith("/git/trees/root-tree")) {
        return json({ tree: [{ path: ".hunsu", type: "tree", sha: "state-tree" }] });
      }
      if (url.endsWith("/git/trees/state-tree")) return json({ tree: [{ path: "v2", type: "tree", sha: "v2-tree" }] });
      if (url.endsWith("/git/trees/v2-tree?recursive=1")) return json({ truncated: false, tree: entries });
      if (url.endsWith("/graphql")) return graphqlBlobResponse(init, contents);
      return json({ message: `Unexpected ${init.method ?? "GET"} ${url}` }, 500);
    }
  });

  const result = await transport.readBranch(repository, "hunsu/state");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value?.files[`.hunsu/v2/${fixtures[500].path}`], fixtures[500].content);
  assert.equal(result.value?.files[`.hunsu/v2/${sharedPath}`], fixtures[0].content);
  assert.equal(calls.filter(call => call.url.endsWith("/graphql")).length, 2);
  assert.equal(calls.some(call => call.url.includes("/git/blobs/")), false);
  const graphqlBodies = calls
    .filter(call => call.url.endsWith("/graphql"))
    .map(call => JSON.parse(String(call.init.body)) as { variables: Record<string, string> });
  assert.equal(graphqlOidVariables(graphqlBodies[0].variables).length, 500);
  assert.equal(graphqlOidVariables(graphqlBodies[1].variables).length, 1);
  assert.equal(graphqlBodies.flatMap(body => graphqlOidVariables(body.variables)).length, 501);
});

test("GitHub REST rejects state above the explicit Free-plan blob budget before GraphQL fan-out", async () => {
  const headSha = "d".repeat(40);
  const entries = stateBlobFixtures(6501).map(fixture => ({
    path: fixture.path,
    type: "blob",
    sha: fixture.sha,
    size: Buffer.byteLength(fixture.content, "utf8")
  }));
  let graphqlRequests = 0;
  const transport = new GitHubRestTransport({
    authorityProvider: async () => verifiedAuthority("test-installation-value"),
    fetch: async input => {
      const url = String(input);
      if (url.includes("/git/ref/heads/hunsu/state")) return json({ object: { sha: headSha } });
      if (url.endsWith(`/git/commits/${headSha}`)) return json({ tree: { sha: "root-tree" } });
      if (url.endsWith("/git/trees/root-tree")) {
        return json({ tree: [{ path: ".hunsu", type: "tree", sha: "state-tree" }] });
      }
      if (url.endsWith("/git/trees/state-tree")) return json({ tree: [{ path: "v2", type: "tree", sha: "v2-tree" }] });
      if (url.endsWith("/git/trees/v2-tree?recursive=1")) return json({ truncated: false, tree: entries });
      if (url.endsWith("/graphql")) graphqlRequests += 1;
      return json({ message: `Unexpected ${url}` }, 500);
    }
  });

  const result = await transport.readBranch(repository, "hunsu/state");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "invalid_response");
    assert.match(result.error.message, /supported limit of 6500 unique blobs/u);
  }
  assert.equal(graphqlRequests, 0);
});

for (const fallback of [
  { name: "truncated GraphQL text", isTruncated: true, text: "{}\n" as string | null },
  { name: "null GraphQL text", isTruncated: false, text: null }
]) {
  test(`GitHub REST uses one REST fallback for ${fallback.name}`, async () => {
    const headSha = "d".repeat(40);
    const content = "{}\n";
    let restBlobReads = 0;
    const transport = new GitHubRestTransport({
      authorityProvider: async () => verifiedAuthority("test-installation-value"),
      fetch: async (input, init = {}) => {
        const url = String(input);
        if (url.includes("/git/ref/heads/hunsu/state")) return json({ object: { sha: headSha } });
        if (url.endsWith(`/git/commits/${headSha}`)) return json({ tree: { sha: "root-tree" } });
        if (url.endsWith("/git/trees/root-tree")) {
          return json({ tree: [{ path: ".hunsu", type: "tree", sha: "state-tree" }] });
        }
        if (url.endsWith("/git/trees/state-tree")) {
          return json({ tree: [{ path: "v2", type: "tree", sha: "v2-tree" }] });
        }
        if (url.endsWith("/git/trees/v2-tree?recursive=1")) {
          return json({ truncated: false, tree: [{
            path: eventPath,
            type: "blob",
            sha: "event-blob",
            size: Buffer.byteLength(content, "utf8")
          }] });
        }
        if (url.endsWith("/graphql")) {
          return json({ data: { repository: { b0: {
            __typename: "Blob",
            oid: "event-blob",
            byteSize: Buffer.byteLength(content, "utf8"),
            isBinary: false,
            isTruncated: fallback.isTruncated,
            text: fallback.text
          } } } });
        }
        if (url.endsWith("/git/blobs/event-blob")) {
          restBlobReads += 1;
          return json({
            sha: "event-blob",
            size: Buffer.byteLength(content, "utf8"),
            encoding: "base64",
            content: Buffer.from(content, "utf8").toString("base64")
          });
        }
        return json({ message: `Unexpected ${init.method ?? "GET"} ${url}` }, 500);
      }
    });

    assert.deepEqual(await transport.readBranch(repository, "hunsu/state"), {
      ok: true,
      value: { headSha, files: { [eventFilePath]: content } }
    });
    assert.equal(restBlobReads, 1);
  });
}

test("GitHub REST allocates four REST fallbacks when a small state read has request budget", async () => {
  const headSha = "d".repeat(40);
  const fixtures = stateBlobFixtures(4);
  const contents = new Map(fixtures.map(fixture => [fixture.sha, fixture.content]));
  let restBlobReads = 0;
  const transport = new GitHubRestTransport({
    authorityProvider: async () => verifiedAuthority("test-installation-value"),
    fetch: async (input, init = {}) => {
      const url = String(input);
      if (url.includes("/git/ref/heads/hunsu/state")) return json({ object: { sha: headSha } });
      if (url.endsWith(`/git/commits/${headSha}`)) return json({ tree: { sha: "root-tree" } });
      if (url.endsWith("/git/trees/root-tree")) {
        return json({ tree: [{ path: ".hunsu", type: "tree", sha: "state-tree" }] });
      }
      if (url.endsWith("/git/trees/state-tree")) {
        return json({ tree: [{ path: "v2", type: "tree", sha: "v2-tree" }] });
      }
      if (url.endsWith("/git/trees/v2-tree?recursive=1")) {
        return json({ truncated: false, tree: fixtures.map(fixture => ({
          path: fixture.path,
          type: "blob",
          sha: fixture.sha,
          size: Buffer.byteLength(fixture.content, "utf8")
        })) });
      }
      if (url.endsWith("/graphql")) {
        const body = JSON.parse(String(init.body)) as { variables: Record<string, string> };
        return json({ data: { repository: Object.fromEntries(graphqlOidVariables(body.variables).map((sha, index) => [
          `b${index}`,
          { ...graphqlBlob(sha, contents.get(sha) ?? ""), text: null }
        ])) } });
      }
      const restSha = url.match(/\/git\/blobs\/([0-9a-f]{40})$/u)?.[1];
      if (restSha) {
        restBlobReads += 1;
        const content = contents.get(restSha) ?? "";
        return json({
          sha: restSha,
          size: Buffer.byteLength(content, "utf8"),
          encoding: "base64",
          content: Buffer.from(content, "utf8").toString("base64")
        });
      }
      return json({ message: `Unexpected ${init.method ?? "GET"} ${url}` }, 500);
    }
  });

  const result = await transport.readBranch(repository, "hunsu/state");
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(Object.keys(result.value?.files ?? {}).length, 4);
  assert.equal(restBlobReads, 4);
});

const invalidGraphqlBlobResponses: ReadonlyArray<{
  name: string;
  payload: unknown;
  expectedMessage: RegExp;
  treeSize?: number;
}> = [
  {
    name: "GraphQL errors",
    payload: { errors: [{ message: "query failed" }] },
    expectedMessage: /returned errors/u
  },
  {
    name: "a wrong OID",
    payload: { data: { repository: { b0: graphqlBlob("wrong-blob", "{}\n") } } },
    expectedMessage: /wrong object/u
  },
  {
    name: "a binary blob",
    payload: { data: { repository: { b0: { ...graphqlBlob("event-blob", "{}\n"), isBinary: true } } } },
    expectedMessage: /not complete UTF-8 text/u
  },
  {
    name: "a tree byte-size mismatch",
    payload: { data: { repository: { b0: { ...graphqlBlob("event-blob", "{}\n"), byteSize: 4 } } } },
    expectedMessage: /does not match its tree size/u
  },
  {
    name: "a text byte-size mismatch",
    payload: { data: { repository: { b0: { ...graphqlBlob("event-blob", "{}\n"), byteSize: 4 } } } },
    expectedMessage: /content does not match its byte size/u,
    treeSize: 4
  },
  {
    name: "a missing alias",
    payload: { data: { repository: {} } },
    expectedMessage: /wrong object/u
  }
];

test("GitHub REST recognizes a successful-status GraphQL rate-limit response", async () => {
  const headSha = "d".repeat(40);
  const now = Date.UTC(2026, 6, 14, 8, 0, 0);
  const transport = new GitHubRestTransport({
    authorityProvider: async () => verifiedAuthority("test-installation-value"),
    now: () => now,
    fetch: async input => {
      const url = String(input);
      if (url.includes("/git/ref/heads/hunsu/state")) return json({ object: { sha: headSha } });
      if (url.endsWith(`/git/commits/${headSha}`)) return json({ tree: { sha: "root-tree" } });
      if (url.endsWith("/git/trees/root-tree")) {
        return json({ tree: [{ path: ".hunsu", type: "tree", sha: "state-tree" }] });
      }
      if (url.endsWith("/git/trees/state-tree")) {
        return json({ tree: [{ path: "v2", type: "tree", sha: "v2-tree" }] });
      }
      if (url.endsWith("/git/trees/v2-tree?recursive=1")) {
        return json({ truncated: false, tree: [{
          path: eventPath,
          type: "blob",
          sha: "event-blob",
          size: 3
        }] });
      }
      if (url.endsWith("/graphql")) {
        return new Response(JSON.stringify({ errors: [{ message: "API rate limit exceeded for this installation." }] }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(Math.floor(now / 1_000) + 90)
          }
        });
      }
      return json({ message: `Unexpected ${url}` }, 500);
    }
  });

  const result = await transport.readBranch(repository, "hunsu/state");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.error, {
    code: "rate_limited",
    message: "API rate limit exceeded for this installation.",
    status: 200,
    retryAfterSeconds: 90
  });
});

for (const scenario of invalidGraphqlBlobResponses) {
  test(`GitHub REST rejects ${scenario.name} in a state blob response`, async () => {
    const headSha = "d".repeat(40);
    const transport = new GitHubRestTransport({
      authorityProvider: async () => verifiedAuthority("test-installation-value"),
      fetch: async (input, init = {}) => {
        const url = String(input);
        if (url.includes("/git/ref/heads/hunsu/state")) return json({ object: { sha: headSha } });
        if (url.endsWith(`/git/commits/${headSha}`)) return json({ tree: { sha: "root-tree" } });
        if (url.endsWith("/git/trees/root-tree")) {
          return json({ tree: [{ path: ".hunsu", type: "tree", sha: "state-tree" }] });
        }
        if (url.endsWith("/git/trees/state-tree")) {
          return json({ tree: [{ path: "v2", type: "tree", sha: "v2-tree" }] });
        }
        if (url.endsWith("/git/trees/v2-tree?recursive=1")) {
          return json({ truncated: false, tree: [{
            path: eventPath,
            type: "blob",
            sha: "event-blob",
            size: scenario.treeSize ?? 3
          }] });
        }
        if (url.endsWith("/graphql")) return json(scenario.payload);
        return json({ message: `Unexpected ${init.method ?? "GET"} ${url}` }, 500);
      }
    });

    const result = await transport.readBranch(repository, "hunsu/state");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "invalid_response");
    assert.match(result.error.message, scenario.expectedMessage);
  });
}

test("GitHub REST keeps a 6001-blob completion-shaped sequence below the Workers Free subrequest limit", async () => {
  const headSha = "d".repeat(40);
  const baseSha = "a".repeat(40);
  const mainSha = "e".repeat(40);
  const resultSha = "f".repeat(40);
  const committedSha = "c".repeat(40);
  const fixtures = stateBlobFixtures(6001);
  const contents = new Map(fixtures.map(fixture => [fixture.sha, fixture.content]));
  const entries = fixtures.map(fixture => ({
    path: fixture.path,
    type: "blob",
    sha: fixture.sha,
    size: Buffer.byteLength(fixture.content, "utf8")
  }));
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const transport = new GitHubRestTransport({
    authorityProvider: async () => verifiedAuthority("test-installation-value"),
    fetch: async (input, init = {}) => {
      const url = String(input);
      const method = init.method ?? "GET";
      calls.push({ url, init });
      if (url.includes("/installation/repositories")) {
        return json({ total_count: 1, repositories: [{
          id: repository.repositoryId,
          name: repository.name,
          default_branch: repository.defaultBranch,
          private: true,
          owner: { login: repository.owner }
        }] });
      }
      if (url.includes("/git/ref/heads/hunsu/state")) return json({ object: { sha: headSha } });
      if (url.includes("/git/ref/heads/hunsu/run/")) return json({ object: { sha: resultSha } });
      if (url.includes("/git/ref/heads/main")) return json({ object: { sha: mainSha } });
      if (method === "GET" && url.endsWith(`/git/commits/${headSha}`)) return json({ tree: { sha: "root-tree" } });
      if (method === "GET" && url.endsWith(`/git/commits/${resultSha}`)) return json({ tree: { sha: "result-tree" } });
      if (method === "GET" && url.endsWith("/git/trees/root-tree")) {
        return json({ tree: [{ path: ".hunsu", type: "tree", sha: "state-tree" }] });
      }
      if (method === "GET" && url.endsWith("/git/trees/state-tree")) {
        return json({ tree: [{ path: "v2", type: "tree", sha: "v2-tree" }] });
      }
      if (method === "GET" && url.endsWith("/git/trees/v2-tree?recursive=1")) {
        return json({ truncated: false, tree: entries });
      }
      if (method === "POST" && url.endsWith("/graphql")) return graphqlBlobResponse(init, contents);
      if (method === "GET" && url.includes(`/compare/${baseSha}...${resultSha}`)) return json({ status: "ahead" });
      if (method === "GET" && url.includes(`/compare/${resultSha}...${resultSha}`)) return json({ status: "identical" });
      if (method === "POST" && url.endsWith("/git/trees")) return json({ sha: "completed-tree" });
      if (method === "POST" && url.endsWith("/git/commits")) return json({ sha: committedSha });
      if (method === "PATCH" && url.includes("/git/refs/heads/hunsu/state")) {
        return json({ object: { sha: committedSha } });
      }
      return json({ message: `Unexpected ${method} ${url}` }, 500);
    }
  });

  assert.equal((await transport.listInstallationRepositories(repository.installationId)).ok, true);
  const firstRead = await transport.readBranch(repository, "hunsu/state");
  assert.equal(firstRead.ok, true);
  if (firstRead.ok) assert.equal(Object.keys(firstRead.value?.files ?? {}).length, 6001);
  assert.deepEqual(await transport.readBranch(repository, "hunsu/run/project/goal/run"), {
    ok: true,
    value: { headSha: resultSha, files: {} }
  });
  assert.deepEqual(await transport.commitExists(repository, resultSha), { ok: true, value: true });
  assert.deepEqual(await transport.compareCommits(repository, baseSha, resultSha), { ok: true, value: "ahead" });
  assert.deepEqual(await transport.compareCommits(repository, resultSha, resultSha), { ok: true, value: "identical" });
  assert.deepEqual(await transport.readBranch(repository, "main"), {
    ok: true,
    value: { headSha: mainSha, files: {} }
  });
  assert.equal((await transport.readBranch(repository, "hunsu/state")).ok, true);
  assert.deepEqual(await transport.commitFiles({
    repository,
    branch: "hunsu/state",
    expectedHeadSha: headSha,
    message: "Complete Hunsu Run",
    updates: Array.from({ length: 8 }, (_, index) => ({
      path: `.hunsu/v2/projects/project/events/2026/07/event-${index}.json`,
      content: `{"event":${index}}\n`
    }))
  }), { ok: true, value: committedSha });

  const githubRequests = calls.length;
  const installationTokenMintRequests = 1;
  assert.equal(calls.filter(call => call.url.endsWith("/graphql")).length, 26);
  assert.equal(calls.some(call => call.url.endsWith("/git/blobs")), false);
  assert.equal(githubRequests, 47);
  assert.ok(githubRequests + installationTokenMintRequests < 50);
});

test("GitHub REST reads a branch head without downloading its commit or tree", async () => {
  const headSha = "e".repeat(40);
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const transport = new GitHubRestTransport({
    authorityProvider: async () => verifiedAuthority("test-installation-value"),
    fetch: async (input, init = {}) => {
      calls.push({ url: String(input), init });
      return json({ object: { sha: headSha } });
    }
  });

  assert.deepEqual(await transport.readBranchHead(repository, "hunsu/state"), { ok: true, value: headSha });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/git\/ref\/heads\/hunsu\/state$/u);
  assert.equal(calls[0].init.cache, "no-store");
});

test("GitHub REST resolves non-state branch heads without downloading trees", async () => {
  let calls = 0;
  const transport = new GitHubRestTransport({
    authorityProvider: async () => verifiedAuthority("test-installation-value"),
    fetch: async () => {
      calls += 1;
      return json({ object: { sha: "e".repeat(40) } });
    }
  });
  assert.deepEqual(await transport.readBranch(repository, "main"), {
    ok: true,
    value: { headSha: "e".repeat(40), files: {} }
  });
  assert.equal(calls, 1);
});

function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  const responseHeaders = new Headers(headers);
  if (!responseHeaders.has("content-type")) responseHeaders.set("content-type", "application/json");
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders
  });
}

function graphqlBlobResponse(init: RequestInit, contents: ReadonlyMap<string, string>): Response {
  const body = JSON.parse(String(init.body)) as { variables: Record<string, string> };
  const repository: Record<string, unknown> = {};
  const oids = graphqlOidVariables(body.variables);
  for (let index = 0; index < oids.length; index += 1) {
    const sha = oids[index];
    const content = contents.get(sha);
    assert.notEqual(content, undefined, `missing fixture for GraphQL OID ${sha}`);
    repository[`b${index}`] = graphqlBlob(sha, content ?? "");
  }
  return json({ data: { repository } });
}

function graphqlExactStateResponse(
  init: RequestInit,
  headSha: string,
  fixtures: ReadonlyMap<string, { readonly sha: string; readonly content: string }>
): Response {
  const body = JSON.parse(String(init.body)) as { variables: Record<string, string> };
  const repository: Record<string, unknown> = {
    head: { __typename: "Commit", oid: headSha },
    v2: { __typename: "Tree", oid: "f".repeat(40) }
  };
  const expressions = Object.entries(body.variables)
    .filter(([key]) => /^expr\d+$/u.test(key))
    .sort(([left], [right]) => Number(left.slice(4)) - Number(right.slice(4)));
  for (let index = 0; index < expressions.length; index += 1) {
    const expression = expressions[index][1];
    const path = expression.slice(`${headSha}:`.length);
    const fixture = fixtures.get(path);
    repository[`b${index}`] = fixture === undefined
      ? null
      : {
          __typename: "Blob",
          oid: fixture.sha,
          byteSize: Buffer.byteLength(fixture.content, "utf8"),
          isBinary: false
        };
  }
  return json({ data: { repository } });
}

function graphqlExpressionPaths(variables: Record<string, string>, headSha: string): string[] {
  return Object.entries(variables)
    .filter(([key]) => /^expr\d+$/u.test(key))
    .sort(([left], [right]) => Number(left.slice(4)) - Number(right.slice(4)))
    .map(([, expression]) => {
      assert.ok(expression.startsWith(`${headSha}:`));
      return expression.slice(`${headSha}:`.length);
    });
}

function graphqlOidVariables(variables: Record<string, string>): string[] {
  return Object.entries(variables)
    .filter(([key]) => /^oid\d+$/u.test(key))
    .sort(([left], [right]) => Number(left.slice(3)) - Number(right.slice(3)))
    .map(([, value]) => value);
}

function graphqlBlob(sha: string, content: string) {
  return {
    __typename: "Blob",
    oid: sha,
    byteSize: Buffer.byteLength(content, "utf8"),
    isBinary: false,
    isTruncated: false,
    text: content
  };
}

function stateBlobFixtures(count: number): Array<{ path: string; sha: string; content: string }> {
  return Array.from({ length: count }, (_, index) => ({
    path: `projects/project-alpha/events/2026/07/${index.toString(16).padStart(32, "0")}.json`,
    sha: index.toString(16).padStart(40, "0"),
    content: `{"index":${index}}\n`
  }));
}

function verifiedAuthority(token: string) {
  return { token, permissions: { contents: "write" as const } };
}
