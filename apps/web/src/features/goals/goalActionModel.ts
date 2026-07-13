export type RunWithLifecycle = {
  status: string;
  updatedAt: string;
};

export function latestCompletedRun<T extends RunWithLifecycle>(runs: readonly T[]): T | undefined {
  return [...runs]
    .filter(run => run.status === "completed")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}
