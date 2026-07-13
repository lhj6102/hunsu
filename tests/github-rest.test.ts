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
    async tokenProvider(installationId) {
      tokenRequests += 1;
      assert.equal(installationId, repository.installationId);
      return "test-installation-value";
    },
    async fetch(input, init = {}) {
      const url = String(input);
      calls.push({ url, init });
      const method = init.method ?? "GET";
      if (method === "GET" && url.includes("/git/ref/heads/hunsu/state")) {
        return json({ object: { sha: parentSha } });
      }
      if (method === "GET" && url.endsWith(`/git/commits/${parentSha}`)) {
        return json({ tree: { sha: "tree-parent" } });
      }
      if (method === "POST" && url.endsWith("/git/blobs")) return json({ sha: "blob-result" });
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
    assert.ok(headers.get("x-github-api-version"));
  }
  const update = calls.find(call => (call.init.method ?? "GET") === "PATCH");
  assert.ok(update);
  assert.deepEqual(JSON.parse(String(update.init.body)), { sha: resultSha, force: false });
  const commitBody = JSON.parse(String(calls.find(call => call.url.endsWith("/git/commits") && call.init.method === "POST")?.init.body));
  assert.deepEqual(commitBody.parents, [parentSha]);
});

test("GitHub REST transport rejects a stale head before creating blobs", async () => {
  let calls = 0;
  const transport = new GitHubRestTransport({
    tokenProvider: async () => "test-installation-value",
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

test("GitHub REST accepts installation repository payloads without repository permissions", async () => {
  const transport = new GitHubRestTransport({
    tokenProvider: async () => "verified-contents-write-token",
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
          owner: { login: repository.owner }
        }]
      });
    }
  });

  assert.deepEqual(await transport.listInstallationRepositories(repository.installationId), {
    ok: true,
    value: [{ ...repository, private: true, permissions: { contents: "write" } }]
  });
});

test("GitHub REST reads only the dedicated state subtree", async () => {
  const headSha = "d".repeat(40);
  const calls: string[] = [];
  const transport = new GitHubRestTransport({
    tokenProvider: async () => "test-installation-value",
    fetch: async input => {
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
      if (url.endsWith("/git/blobs/workspace-blob")) {
        return json({ encoding: "base64", content: Buffer.from("{}\n", "utf8").toString("base64") });
      }
      return json({ message: `Unexpected ${url}` }, 500);
    }
  });
  const result = await transport.readBranch(repository, "hunsu/state");
  assert.deepEqual(result, { ok: true, value: { headSha, files: { ".hunsu/workspace.json": "{}\n" } } });
  assert.equal(calls.some(url => url.includes("source-tree")), false);
});

test("GitHub REST resolves non-state branch heads without downloading trees", async () => {
  let calls = 0;
  const transport = new GitHubRestTransport({
    tokenProvider: async () => "test-installation-value",
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
