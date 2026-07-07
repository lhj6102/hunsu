import { err, type Result } from "./result.ts";

export class DomainInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainInvariantError";
  }
}

export type DomainWorkflowError = {
  type: "DomainWorkflowError";
  message: string;
};

export function workflowError(message: string): Result<never, DomainWorkflowError> {
  return err({ type: "DomainWorkflowError", message });
}

export function toDomainWorkflowError(error: unknown): DomainWorkflowError {
  return {
    type: "DomainWorkflowError",
    message: error instanceof Error ? error.message : String(error)
  };
}

export function unwrapWorkflowResult<T>(result: Result<T, DomainWorkflowError>): T {
  if (result.ok) {
    return result.value;
  }
  throw new DomainInvariantError(result.error.message);
}

export function unwrapDomainModelResult<T>(result: Result<T, { message: string }>): T {
  if (result.ok) {
    return result.value;
  }
  throw new DomainInvariantError(result.error.message);
}
