import type { RepositoryLocator } from "@hunsu/github-store";

export type GitHubUser = {
  id: string;
  login: string;
  name?: string;
  avatarUrl?: string;
};

export type AuthorizedRepositoryAccess = {
  repositoryId: number;
  permissions: {
    contents: "read" | "write";
  };
};

export type AuthorizedInstallation = {
  id: number;
  accountLogin: string;
  accountType: "organization" | "user";
  repositories: readonly AuthorizedRepositoryAccess[];
};

export type AuthContext = {
  subject: string;
  user: GitHubUser;
  installations: readonly AuthorizedInstallation[];
  selectedInstallationId?: number;
  client: "web" | "mcp";
};

export type ApiErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "invalid_request"
  | "conflict"
  | "stale_state"
  | "stale_base"
  | "result_unreachable"
  | "confirmation_required"
  | "temporarily_unavailable";

export type ApiError = {
  code: ApiErrorCode;
  message: string;
  status: number;
  retryable: boolean;
  retryAfterSeconds?: number;
  requestId?: string;
  expectedStateSha?: string;
  actualStateSha?: string;
  fieldErrors?: Record<string, string>;
};

export type ApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ApiError };

export type LocatedProject = {
  repository: RepositoryLocator;
  projectId: string;
};

export type MutationResult<T> = {
  value: T;
  stateHeadSha: string;
  synchronizedAt: string;
};

export function apiOk<T>(value: T): ApiResult<T> {
  return { ok: true, value };
}

export function apiFailure(error: ApiError): ApiResult<never> {
  return { ok: false, error };
}

export function invalidRequest(message: string, fieldErrors?: Record<string, string>): ApiResult<never> {
  return apiFailure({
    code: "invalid_request",
    message,
    status: 400,
    retryable: false,
    ...(fieldErrors ? { fieldErrors } : {})
  });
}
