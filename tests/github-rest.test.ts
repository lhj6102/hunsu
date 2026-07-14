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
const eventFilePath = `.hunsu/${eventPath}`;

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
    updates: [{ path: ".hunsu/workspace.json", content: "{}\n" }]
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
      path: ".hunsu/workspace.json",
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
    updates: [{ path: ".hunsu/workspace.json", content: "{}\n" }]
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

test("GitHub REST initializes state from the created ref response without rereading the ref", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const transport = new GitHubRestTransport({
    authorityProvider: async () => verifiedAuthority("verified-contents-write-token"),
    fetch: async (input, init = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (init.method === "POST" && url.endsWith("/git/refs")) {
        return json({ object: { sha: "a".repeat(40) } }, 201);
      }
      if (url.endsWith(`/git/commits/${"a".repeat(40)}`)) {
        return json({ tree: { sha: "created-root-tree" } });
      }
      if (url.endsWith("/git/trees/created-root-tree")) {
        return json({ tree: [{ path: ".hunsu", type: "tree", sha: "created-state-tree" }] });
      }
      if (url.endsWith("/git/trees/created-state-tree?recursive=1")) {
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
      files: { [`.hunsu/projects/project-alpha/events/2026/07/${"1".repeat(32)}.json`]: "{}\n" }
    }
  });
  assert.equal(calls.some(call => call.url.includes("/git/ref/")), false);
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
      if (url.endsWith("/git/trees/state-tree?recursive=1")) return json({ truncated: false, tree: [
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
});

test("GitHub REST fetches reconstruction inputs without downloading derived materializations", async () => {
  const headSha = "d".repeat(40);
  const eventContent = "{\"schema\":\"hunsu.project-event.v1\"}\n";
  const derived = [
    { path: "projects/project-alpha/project.json", sha: "project-blob" },
    { path: "projects/project-alpha/coach.json", sha: "coach-blob" },
    { path: "projects/project-alpha/goals/goal-one.json", sha: "goal-blob" },
    { path: "projects/project-alpha/runners/player-one.json", sha: "runner-blob" },
    { path: "projects/project-alpha/runs/run-one.json", sha: "run-blob" },
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
      if (url.endsWith("/git/trees/state-tree?recursive=1")) {
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
        [`.hunsu/${eventPath}`]: eventContent
      }
    }
  });
  const requestedOids = calls
    .filter(call => call.url.endsWith("/graphql"))
    .flatMap(call => graphqlOidVariables((JSON.parse(String(call.init.body)) as { variables: Record<string, string> }).variables));
  assert.deepEqual(requestedOids, ["event-blob"]);
  assert.equal(derived.some(entry => requestedOids.includes(entry.sha)), false);
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
      if (url.endsWith("/git/trees/state-tree?recursive=1")) return json({ truncated: false, tree: entries });
      if (url.endsWith("/graphql")) return graphqlBlobResponse(init, contents);
      return json({ message: `Unexpected ${init.method ?? "GET"} ${url}` }, 500);
    }
  });

  const result = await transport.readBranch(repository, "hunsu/state");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value?.files[`.hunsu/${fixtures[500].path}`], fixtures[500].content);
  assert.equal(result.value?.files[`.hunsu/${sharedPath}`], fixtures[0].content);
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
      if (url.endsWith("/git/trees/state-tree?recursive=1")) return json({ truncated: false, tree: entries });
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
        if (url.endsWith("/git/trees/state-tree?recursive=1")) {
          return json({ truncated: false, tree: [{
            path: eventPath,
            type: "blob",
            sha: "event-blob",
            size: Buffer.byteLength(content, "utf8")
          }] });
        }
        if (url.endsWith("/graphql")) {
          return json({ data: { repository: { b0: {
            oid: "event-blob",
            byteSize: Buffer.byteLength(content, "utf8"),
            isBinary: false,
            isTruncated: fallback.isTruncated,
            text: fallback.text
          } } } });
        }
        if (url.endsWith("/git/blobs/event-blob")) {
          restBlobReads += 1;
          return json({ encoding: "base64", content: Buffer.from(content, "utf8").toString("base64") });
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
      if (url.endsWith("/git/trees/state-tree?recursive=1")) {
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
        return json({ encoding: "base64", content: Buffer.from(contents.get(restSha) ?? "", "utf8").toString("base64") });
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
      if (url.endsWith("/git/trees/state-tree?recursive=1")) {
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
        if (url.endsWith("/git/trees/state-tree?recursive=1")) {
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
      if (method === "GET" && url.endsWith("/git/trees/state-tree?recursive=1")) {
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
      path: `.hunsu/events/event-${index}.json`,
      content: `{"event":${index}}\n`
    }))
  }), { ok: true, value: committedSha });

  const githubRequests = calls.length;
  const installationTokenMintRequests = 1;
  assert.equal(calls.filter(call => call.url.endsWith("/graphql")).length, 26);
  assert.equal(calls.some(call => call.url.endsWith("/git/blobs")), false);
  assert.equal(githubRequests, 45);
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

function graphqlOidVariables(variables: Record<string, string>): string[] {
  return Object.entries(variables)
    .filter(([key]) => /^oid\d+$/u.test(key))
    .sort(([left], [right]) => Number(left.slice(3)) - Number(right.slice(3)))
    .map(([, value]) => value);
}

function graphqlBlob(sha: string, content: string) {
  return {
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
