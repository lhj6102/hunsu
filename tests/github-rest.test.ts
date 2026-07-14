import assert from "node:assert/strict";
import test from "node:test";
import { GitHubRestTransport, type RepositoryLocator } from "../packages/github-store/src/index.ts";

const repository: RepositoryLocator = {
  installationId: 19,
  repositoryId: 23,
  owner: "hunsu",
  name: "sample",
  defaultBranch: "main"
};

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
        return json({ truncated: false, tree: [{ path: "reserved.json", type: "blob", sha: "reserved-blob" }] });
      }
      if (url.endsWith("/graphql")) {
        return graphqlBlobResponse(init, new Map([["reserved-blob", "reserved\n"]]));
      }
      return json({ message: `Unexpected ${init.method ?? "GET"} ${url}` }, 500);
    }
  });

  assert.deepEqual(await transport.createBranch(repository, "hunsu/state", "a".repeat(40)), {
    ok: true,
    value: {
      headSha: "a".repeat(40),
      files: { ".hunsu/reserved.json": "reserved\n" }
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
        { path: "workspace.json", type: "blob", sha: "workspace-blob" }
      ] });
      if (url.endsWith("/graphql")) {
        return graphqlBlobResponse(init, new Map([["workspace-blob", "{}\n"]]));
      }
      return json({ message: `Unexpected ${url}` }, 500);
    }
  });
  const result = await transport.readBranch(repository, "hunsu/state");
  assert.deepEqual(result, { ok: true, value: { headSha, files: { ".hunsu/workspace.json": "{}\n" } } });
  assert.equal(calls.some(url => url.includes("source-tree")), false);
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
  entries.push({ ...entries[0], path: "shared.json" });
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
  assert.equal(result.value?.files[".hunsu/shared.json"], fixtures[0].content);
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
            path: "workspace.json",
            type: "blob",
            sha: "workspace-blob",
            size: Buffer.byteLength(content, "utf8")
          }] });
        }
        if (url.endsWith("/graphql")) {
          return json({ data: { repository: { b0: {
            oid: "workspace-blob",
            byteSize: Buffer.byteLength(content, "utf8"),
            isBinary: false,
            isTruncated: fallback.isTruncated,
            text: fallback.text
          } } } });
        }
        if (url.endsWith("/git/blobs/workspace-blob")) {
          restBlobReads += 1;
          return json({ encoding: "base64", content: Buffer.from(content, "utf8").toString("base64") });
        }
        return json({ message: `Unexpected ${init.method ?? "GET"} ${url}` }, 500);
      }
    });

    assert.deepEqual(await transport.readBranch(repository, "hunsu/state"), {
      ok: true,
      value: { headSha, files: { ".hunsu/workspace.json": content } }
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
    payload: { data: { repository: { b0: { ...graphqlBlob("workspace-blob", "{}\n"), isBinary: true } } } },
    expectedMessage: /not complete UTF-8 text/u
  },
  {
    name: "a tree byte-size mismatch",
    payload: { data: { repository: { b0: { ...graphqlBlob("workspace-blob", "{}\n"), byteSize: 4 } } } },
    expectedMessage: /does not match its tree size/u
  },
  {
    name: "a text byte-size mismatch",
    payload: { data: { repository: { b0: { ...graphqlBlob("workspace-blob", "{}\n"), byteSize: 4 } } } },
    expectedMessage: /content does not match its byte size/u,
    treeSize: 4
  },
  {
    name: "a missing alias",
    payload: { data: { repository: {} } },
    expectedMessage: /wrong object/u
  }
];

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
            path: "workspace.json",
            type: "blob",
            sha: "workspace-blob",
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
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
    path: `events/event-${index}.json`,
    sha: index.toString(16).padStart(40, "0"),
    content: `{"index":${index}}\n`
  }));
}

function verifiedAuthority(token: string) {
  return { token, permissions: { contents: "write" as const } };
}
