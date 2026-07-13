import { useRef } from "react";
import { createLogicalSubmissionKey, type LogicalSubmissionKey } from "@/shared/api/logicalSubmissionKey";

export function useLogicalSubmissionKey(scope: string): LogicalSubmissionKey {
  const current = useRef<{ scope: string; submission: LogicalSubmissionKey } | undefined>(undefined);
  if (!current.current || current.current.scope !== scope) {
    current.current = { scope, submission: createLogicalSubmissionKey(scope) };
  }
  return current.current.submission;
}
