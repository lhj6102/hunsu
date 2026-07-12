export type PromotionPullRequest = {
  number: number;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  base?: { ref?: string; repo?: { full_name?: string } };
  head?: { ref?: string; sha?: string; repo?: { full_name?: string } };
  user?: { login?: string };
};

export type PromotionReview = {
  state?: string;
  commit_id?: string;
  submitted_at?: string;
  user?: { login?: string };
};

export function selectPromotionPullRequest(input: {
  pullRequests: PromotionPullRequest[];
  reviewsByPullRequest: Record<number, PromotionReview[]>;
  currentSha: string;
  qaLeaders: string;
}): {
  pullRequestNumber: number;
  previewSha: string;
  qaLeader: string;
  qaApprovedAt: string;
};

export function parseQaLeaders(value: unknown): string[];
