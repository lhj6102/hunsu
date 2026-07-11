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
        artifactId?: number;
        artifactSizeBytes?: number;
        artifactDigest?: string;
        evidenceFiles?: string[];
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
  assert.equal(windowsRun?.runId, 29143013811);
  assert.equal(windowsRun?.commit, "29bbb2d903500612b3cc6d7a5853acc267eec89c");
  assert.equal(windowsRun?.status, "passed");
  assert.match(windowsRun?.evidenceUrl ?? "", /github\.com\/lhj6102\/hunsu\/actions\/runs\/29143013811/u);
  assert.equal(windowsRun?.artifactId, 8245874656);
  assert.equal(windowsRun?.artifactSizeBytes, 25064955);
  assert.equal(windowsRun?.artifactDigest, "sha256:0d3142388ab68a98c1e661bb3ca52dac8c60d2558ac2cc7cb2b9537aa7f44ca0");
  assert.ok(windowsRun?.evidenceFiles?.includes("docs/qa/windows-x64-installed-app-29143013811.md"));
  assert.ok(windowsRun?.evidenceFiles?.includes("docs/qa/windows-x64-installed-app-29143013811-visual-review.json"));

  const visualReviewPath = join(ROOT, "docs/qa/windows-x64-installed-app-29143013811-visual-review.json");
  const visualReview = JSON.parse(readFileSync(visualReviewPath, "utf8")) as {
    schema?: string;
    reviewedAt?: string;
    workflowRunId?: number;
    workflowRunAttempt?: number;
    candidateCommit?: string;
    artifact?: { name?: string; id?: number; digest?: string };
    screenshot?: { file?: string; sha256?: string };
    reviewer?: { kind?: string; canonicalTask?: string; contextPolicy?: string };
    rubric?: string[];
    verdict?: string;
  };
  assert.equal(visualReview.schema, "hunsu.windows-installed-app-visual-review.v1");
  assert.match(visualReview.reviewedAt ?? "", /^2026-07-11T\d{2}:\d{2}:\d{2}Z$/u);
  assert.equal(visualReview.workflowRunId, 29143013811);
  assert.equal(visualReview.workflowRunAttempt, 1);
  assert.equal(visualReview.candidateCommit, "29bbb2d903500612b3cc6d7a5853acc267eec89c");
  assert.deepEqual(visualReview.artifact, {
    name: "hunsu-bridge-windows-x64",
    id: 8245874656,
    digest: "sha256:0d3142388ab68a98c1e661bb3ca52dac8c60d2558ac2cc7cb2b9537aa7f44ca0"
  });
  assert.deepEqual(visualReview.screenshot, {
    file: "windows-installed-app-e2e-screenshot.png",
    sha256: "b5aa9da0c3a57313c9cbf55643e727b072d3b46cb1874d374d2986ebb62a2748"
  });
  assert.equal(visualReview.reviewer?.kind, "independent-codex-subagent");
  assert.equal(visualReview.reviewer?.canonicalTask, "/root/windows_visual_review_29143013811");
  assert.match(visualReview.reviewer?.contextPolicy ?? "", /no prior conversation, reviews, or conclusions/u);
  assert.equal((visualReview.rubric?.length ?? 0) >= 9, true);
  assert.equal(visualReview.verdict, "VISUAL PASS");
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
