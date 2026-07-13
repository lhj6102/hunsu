export function alternativeDecisionRequest(
  comparisonId: string,
  expectedStateSha: string,
  idempotencyKey: string
): { comparisonId: string; expectedStateSha: string; idempotencyKey: string } {
  return { comparisonId, expectedStateSha, idempotencyKey };
}
