const REDACTED_VALUE = "[redacted]";

const SENSITIVE_QUERY_PARAMETER_NAMES = new Set([
  "hunsuBridgeToken",
  "hunsuRelayToken",
  "token",
  "access_token",
  "refresh_token",
  "authorization",
  "controlToken",
  "bridgeControlToken",
  "code",
  "state"
].map(name => name.toLowerCase()));

const SENSITIVE_QUERY_PARAMETER_PATTERN = [
  "hunsuBridgeToken",
  "hunsuRelayToken",
  "access_token",
  "refresh_token",
  "authorization",
  "controlToken",
  "bridgeControlToken",
  "token",
  "code",
  "state"
].join("|");

const SENSITIVE_ASSIGNMENT_NAME_PATTERN = [
  SENSITIVE_QUERY_PARAMETER_PATTERN,
  "apiKey",
  "accessToken",
  "refreshToken",
  "authToken",
  "bridgeAuthToken",
  "controlToken",
  "bridgeControlToken",
  "OPENAI_API_KEY",
  "CODEX_ACCESS_TOKEN"
].join("|");

const QUERY_PARAMETER = /([?&])([^=&#\s"'<>\\]+)=([^&#\s"'<>\\]*)/giu;
const ENCODED_QUERY_PARAMETER = new RegExp(
  `((?:%3f|%26)(?:${SENSITIVE_QUERY_PARAMETER_PATTERN})(?:%3d|=))((?:(?!%26|%23)[^\\s"'<>\\\\])+)`,
  "giu"
);
const SECRET_JSON_FIELD = /("(?:[^"\\]*(?:token|secret|api.?key|authorization|credential|auth\.json|password|cookie)[^"\\]*)"\s*:\s*)("(?:\\.|[^"\\])*"|[^,}\]\s]+)/giu;
const SECRET_ASSIGNMENT = new RegExp(
  `(^|[\\s,;])(${SENSITIVE_ASSIGNMENT_NAME_PATTERN})(\\s*=\\s*)(?:Bearer\\s+)?[^\\s,;&]+`,
  "gimu"
);

/**
 * Redact sensitive query-parameter values without depending on the value's
 * length, alphabet, or token format.
 */
export function redactDiagnosticUrl(value: string): string {
  return value.replace(QUERY_PARAMETER, (match, separator: string, rawName: string, rawValue: string) => {
    const name = normalizedQueryParameterName(rawName);
    if (!SENSITIVE_QUERY_PARAMETER_NAMES.has(name)) {
      return match;
    }
    return `${separator}${rawName}=${redactedValue(rawValue)}`;
  });
}

/**
 * Redact secrets from arbitrary diagnostic text, including URLs and JSON log
 * lines. Full JSON strings are deep-sanitized so JSON nested inside another
 * diagnostic value receives the same treatment.
 */
export function redactDiagnosticText(value: string): string {
  const structured = redactStructuredDiagnosticText(value);
  if (structured !== undefined) {
    return structured;
  }

  return redactDiagnosticUrl(value)
    .replace(ENCODED_QUERY_PARAMETER, (_match, prefix: string, rawValue: string) => `${prefix}${redactedValue(rawValue)}`)
    .replace(/sk-[A-Za-z0-9_-]{10,}/gu, REDACTED_VALUE)
    .replace(/\bhunsu_bridge_[A-Za-z0-9_-]+\b/giu, REDACTED_VALUE)
    .replace(/(OPENAI_API_KEY|CODEX_ACCESS_TOKEN)(\s*=\s*)(?:"[^"]*"|'[^']*'|\S+)/giu, `$1$2${REDACTED_VALUE}`)
    .replace(/~\/\.codex\/auth\.json/giu, REDACTED_VALUE)
    .replace(SECRET_JSON_FIELD, `$1"${REDACTED_VALUE}"`)
    .replace(SECRET_ASSIGNMENT, (_match, prefix: string, name: string, equals: string) => `${prefix}${name}${equals}${REDACTED_VALUE}`)
    .replace(/(Bearer\s+)(?!\[redacted\])[^\s,"'\\]+/giu, `$1${REDACTED_VALUE}`);
}

/** Deep-sanitize a complete diagnostics value before it crosses a boundary. */
export function sanitizeDiagnostics(value: unknown): unknown {
  return sanitizeDiagnosticsValue(value, new WeakSet<object>());
}

/**
 * Fail closed when an unsanitized value reaches a persistence, rendering, or
 * clipboard boundary. The error intentionally never includes the unsafe data.
 */
export function assertDiagnosticsSafe(value: unknown): void {
  assertDiagnosticsValueSafe(value, new WeakSet<object>());
}

function sanitizeDiagnosticsValue(value: unknown, ancestors: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return redactDiagnosticText(value);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      return "[circular]";
    }
    ancestors.add(value);
    const sanitized = value.map((child, index) => isSensitiveCliFlag(value[index - 1])
      ? REDACTED_VALUE
      : sanitizeDiagnosticsValue(child, ancestors));
    ancestors.delete(value);
    return sanitized;
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (ancestors.has(value)) {
    return "[circular]";
  }

  ancestors.add(value);
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = isSensitiveDiagnosticKey(key)
      ? REDACTED_VALUE
      : sanitizeDiagnosticsValue(child, ancestors);
  }
  ancestors.delete(value);
  return result;
}

function assertDiagnosticsValueSafe(value: unknown, ancestors: WeakSet<object>): void {
  if (typeof value === "string") {
    if (redactDiagnosticText(value) !== value) {
      throw unsafeDiagnosticsError();
    }
    return;
  }
  if (typeof value !== "object" || value === null || value instanceof Date) {
    return;
  }
  if (ancestors.has(value)) {
    return;
  }

  ancestors.add(value);
  for (const [index, [key, child]] of Object.entries(value).entries()) {
    if (Array.isArray(value) && isSensitiveCliFlag(value[index - 1]) && child !== REDACTED_VALUE) {
      throw unsafeDiagnosticsError();
    }
    if (isSensitiveDiagnosticKey(key) && child !== REDACTED_VALUE) {
      throw unsafeDiagnosticsError();
    }
    assertDiagnosticsValueSafe(child, ancestors);
  }
  ancestors.delete(value);
}

function redactStructuredDiagnosticText(value: string): string | undefined {
  const trimmed = value.trim();
  if (!(trimmed.startsWith("{") && trimmed.endsWith("}"))
    && !(trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }
    const sanitized = sanitizeDiagnostics(parsed);
    if (JSON.stringify(parsed) === JSON.stringify(sanitized)) {
      return undefined;
    }
    return JSON.stringify(sanitized);
  } catch (_error) {
    return undefined;
  }
}

function normalizedQueryParameterName(rawName: string): string {
  const withoutHtmlEntity = rawName.replace(/^amp;/iu, "");
  try {
    return decodeURIComponent(withoutHtmlEntity.replace(/\+/gu, " ")).toLowerCase();
  } catch (_error) {
    return withoutHtmlEntity.toLowerCase();
  }
}

function isSensitiveDiagnosticKey(key: string): boolean {
  return /token|secret|api.?key|authorization|credential|auth\.json|password|cookie/iu.test(key);
}

function isSensitiveCliFlag(value: unknown): boolean {
  if (typeof value !== "string" || !/^--?[^=]+$/u.test(value)) {
    return false;
  }
  const normalized = value.replace(/^--?/u, "").replace(/[-_]/gu, "");
  return isSensitiveDiagnosticKey(normalized)
    || SENSITIVE_QUERY_PARAMETER_NAMES.has(normalized.toLowerCase());
}

function redactedValue(value: string): string {
  return isRedactedValue(value) ? value : REDACTED_VALUE;
}

function isRedactedValue(value: string): boolean {
  if (value.toLowerCase() === REDACTED_VALUE) {
    return true;
  }
  try {
    return decodeURIComponent(value).toLowerCase() === REDACTED_VALUE;
  } catch (_error) {
    return false;
  }
}

function unsafeDiagnosticsError(): Error {
  return new Error("Diagnostics contain sensitive data.");
}
