import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

test("Bridge platform QA matrix is machine-checkable for native and browser targets", () => {
  const path = join(ROOT, "docs/qa/bridge-platform-matrix.json");
  const matrix = JSON.parse(readFileSync(path, "utf8")) as {
    schema: string;
    nativeHostResults: {
      status: string;
      realRuns: Array<{
        target?: string;
        runId?: number;
        commit?: string;
        status?: string;
        evidenceUrl?: string;
      }>;
      externalBlocker?: string;
    };
    targets: Array<{
      target: string;
      status: string;
      nativeHostExecuted?: boolean;
      evidence: string[];
      checks: string[];
      browsers?: string[];
    }>;
  };

  assert.equal(matrix.schema, "hunsu.bridge-platform-qa.v1");
  assert.equal(matrix.nativeHostResults.status, "windows-x64-installed-app-gate-passed");
  assert.equal(matrix.nativeHostResults.realRuns.length >= 1, true);
  const windowsRun = matrix.nativeHostResults.realRuns.find(run => run.target === "Windows x64");
  assert.equal(windowsRun?.runId, 29118028406);
  assert.match(windowsRun?.commit ?? "", /^[0-9a-f]{40}$/u);
  assert.equal(windowsRun?.status, "passed");
  assert.match(windowsRun?.evidenceUrl ?? "", /github\.com\/lhj6102\/hunsu\/actions\/runs\/29118028406/u);
  assert.match(matrix.nativeHostResults.externalBlocker ?? "", /Human installed-app visual QA/);
  assert.match(matrix.nativeHostResults.externalBlocker ?? "", /releaseEligible false/);
  assert.deepEqual(matrix.targets.map(target => target.target), [
    "macOS",
    "Windows",
    "Linux GUI",
    "Linux no-GUI",
    "Browsers"
  ]);

  for (const target of matrix.targets) {
    assert.notEqual(target.status, "future");
    assert.notEqual(target.status, "unvalidated");
    assert.ok(target.evidence.length >= 4, `${target.target} should list concrete evidence files`);
    assert.ok(target.checks.length >= 5, `${target.target} should list platform checks`);
    for (const evidence of target.evidence) {
      assert.equal(existsSync(join(ROOT, evidence)), true, `${target.target} evidence missing: ${evidence}`);
    }
    if (target.status === "validated-by-contract") {
      assert.equal(target.nativeHostExecuted, false, `${target.target} should not mark native-host execution inside a contract-only row`);
    }
  }

  const browsers = matrix.targets.find(target => target.target === "Browsers")?.browsers;
  assert.deepEqual(browsers, ["Chrome", "Safari", "Edge", "Firefox"]);
  const windows = matrix.targets.find(target => target.target === "Windows");
  assert.equal(windows?.status, "windows-x64-installed-app-gate-passed");
  assert.equal(windows?.nativeHostExecuted, true);
});
