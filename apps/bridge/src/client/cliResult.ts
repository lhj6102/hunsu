import { BridgeStateError } from "../state/atomicJsonStore.ts";

export const BRIDGE_CLI_RESULT_SCHEMA = "hunsu.bridge.cli-result.v1" as const;

export const BRIDGE_NOT_RUNNING_MESSAGE = "Start Hunsu Bridge with `hunsu-bridge service start`.";

export type BridgeErrorCode =
  | "BRIDGE_NOT_RUNNING"
  | "BRIDGE_ALREADY_RUNNING"
  | "BRIDGE_PORT_IN_USE"
  | "BRIDGE_START_TIMEOUT"
  | "BRIDGE_STOP_TIMEOUT"
  | "BRIDGE_CONTROL_UNAVAILABLE"
  | "BRIDGE_CONTROL_UNAUTHORIZED"
  | "BRIDGE_STATE_INVALID"
  | "SERVICE_NOT_INSTALLED"
  | "SERVICE_ALREADY_INSTALLED"
  | "SERVICE_INSTALL_FAILED"
  | "SERVICE_START_FAILED"
  | "SERVICE_STOP_FAILED"
  | "SERVICE_STATUS_UNAVAILABLE"
  | "NODE_VERSION_UNSUPPORTED"
  | "RUNTIME_INSTALL_FAILED"
  | "SETUP_VERIFICATION_FAILED"
  | "ROLLBACK_FAILED"
  | "PROVIDER_NOT_CONFIGURED"
  | "PROVIDER_BINARY_NOT_FOUND"
  | "PROVIDER_LOGIN_REQUIRED"
  | "PROVIDER_CHECK_FAILED"
  | "WORKSPACE_NOT_FOUND"
  | "WORKSPACE_ALREADY_REGISTERED"
  | "WORKSPACE_PATH_INVALID"
  | "PAIRING_ROTATION_FAILED"
  | "BROWSER_OPEN_FAILED"
  | "ACCOUNT_LOGIN_REQUIRED"
  | "REMOTE_ENABLE_FAILED"
  | "REMOTE_CONNECTION_FAILED"
  | "DIAGNOSTICS_SENSITIVE_DATA_DETECTED";

export type BridgeRecovery = {
  command?: string;
  documentation?: string;
};

export type BridgeCliSuccess<T = unknown> = {
  schema: typeof BRIDGE_CLI_RESULT_SCHEMA;
  ok: true;
  code: "OK" | string;
  message: string;
  value?: T;
};

export type BridgeCliFailure = {
  schema: typeof BRIDGE_CLI_RESULT_SCHEMA;
  ok: false;
  code: BridgeErrorCode | string;
  message: string;
  recovery?: BridgeRecovery;
};

export type BridgeCliResult<T = unknown> = BridgeCliSuccess<T> | BridgeCliFailure;

export class BridgeError extends Error {
  readonly code: BridgeErrorCode | string;
  readonly recovery?: BridgeRecovery;
  readonly cause?: unknown;

  constructor(code: BridgeErrorCode | string, message: string, options: { recovery?: BridgeRecovery; cause?: unknown } = {}) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.recovery = options.recovery;
    this.cause = options.cause;
  }
}

export function cliSuccess<T>(message: string, value?: T, code = "OK"): BridgeCliSuccess<T> {
  return {
    schema: BRIDGE_CLI_RESULT_SCHEMA,
    ok: true,
    code,
    message,
    ...(value === undefined ? {} : { value })
  };
}

export function cliFailure(
  code: BridgeErrorCode | string,
  message: string,
  recovery?: BridgeRecovery
): BridgeCliFailure {
  return {
    schema: BRIDGE_CLI_RESULT_SCHEMA,
    ok: false,
    code,
    message,
    ...(recovery ? { recovery } : {})
  };
}

export function bridgeNotRunningResult(): BridgeCliFailure {
  return cliFailure("BRIDGE_NOT_RUNNING", BRIDGE_NOT_RUNNING_MESSAGE);
}

export function bridgeErrorResult(error: unknown): BridgeCliFailure {
  if (error instanceof BridgeError) {
    return cliFailure(error.code, error.message, error.recovery);
  }
  if (error instanceof BridgeStateError) {
    return cliFailure(error.code, error.message);
  }
  return cliFailure(
    "BRIDGE_CONTROL_UNAVAILABLE",
    "Hunsu Bridge command failed unexpectedly."
  );
}
