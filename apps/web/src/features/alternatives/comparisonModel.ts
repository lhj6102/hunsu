export type ComparableRun = {
  id: string;
  status: string;
};

export function canRecordAlternativeDecision(run: ComparableRun, comparisonId: string | undefined): boolean {
  return run.status === "completed" && typeof comparisonId === "string" && comparisonId.length > 0;
}
