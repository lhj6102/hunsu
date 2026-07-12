export function selectPromotionPullRequest({ pullRequests, reviewsByPullRequest, currentSha, qaLeaders }) {
  const normalizedCurrentSha = normalizeSha(currentSha);
  const leaders = new Set(parseQaLeaders(qaLeaders));
  if (leaders.size === 0) {
    throw new Error("HUNSU_QA_LEADERS must list at least one GitHub username.");
  }
  const candidates = pullRequests.filter(pullRequest =>
    pullRequest.merged_at
    && pullRequest.base?.ref === "main"
    && pullRequest.head?.ref === "preview"
    && pullRequest.head?.repo?.full_name === pullRequest.base?.repo?.full_name
    && normalizeSha(pullRequest.merge_commit_sha) === normalizedCurrentSha
  );
  if (candidates.length !== 1) {
    throw new Error(`Expected exactly one merged preview-to-main pull request for ${normalizedCurrentSha}; found ${candidates.length}.`);
  }
  const pullRequest = candidates[0];
  const previewSha = normalizeSha(pullRequest.head?.sha);
  const author = String(pullRequest.user?.login ?? "").toLowerCase();
  const latestReviewByLeader = new Map();
  for (const review of reviewsByPullRequest[pullRequest.number] ?? []) {
    const login = String(review.user?.login ?? "").toLowerCase();
    if (!leaders.has(login) || review.state === "COMMENTED" || review.state === "PENDING") continue;
    const submittedAt = Date.parse(review.submitted_at ?? "") || 0;
    const previous = latestReviewByLeader.get(login);
    if (!previous || submittedAt >= previous.submittedAt) {
      latestReviewByLeader.set(login, { review, submittedAt });
    }
  }
  const blockingReview = [...latestReviewByLeader.entries()].find(([login, value]) =>
    login !== author && value.review.state === "CHANGES_REQUESTED"
  );
  if (blockingReview) {
    throw new Error(`QA leader @${blockingReview[0]} still requests changes on PR #${pullRequest.number}.`);
  }
  const approval = [...latestReviewByLeader.entries()].find(([login, value]) =>
    login !== author
    && value.review.state === "APPROVED"
    && normalizeSha(value.review.commit_id) === previewSha
  );
  if (!approval) {
    throw new Error(`PR #${pullRequest.number} needs an independent QA leader approval on exact preview head ${previewSha}.`);
  }
  return {
    pullRequestNumber: pullRequest.number,
    previewSha,
    qaLeader: approval[0],
    qaApprovedAt: approval[1].review.submitted_at
  };
}

export function parseQaLeaders(value) {
  return [...new Set(String(value ?? "")
    .split(",")
    .map(login => login.trim().replace(/^@/u, "").toLowerCase())
    .filter(Boolean))];
}

function normalizeSha(value) {
  const sha = String(value ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(sha)) {
    throw new Error(`Invalid Git commit SHA: ${String(value)}`);
  }
  return sha;
}
