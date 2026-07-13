export type LogicalSubmissionKey = {
  keyFor: (input: unknown) => string;
  succeeded: () => void;
  abandon: () => void;
};

/**
 * Keeps one idempotency key attached to one logical mutation payload.
 *
 * A transport failure does not clear the key, so a retry of the same JSON
 * payload reaches the server with the original key. A changed payload starts
 * a new logical submission, and an acknowledged success releases the key.
 */
export function createLogicalSubmissionKey(
  scope: string,
  createKey: (scope: string) => string = idempotencyKey
): LogicalSubmissionKey {
  let pending: { fingerprint: string; key: string } | undefined;

  return {
    keyFor(input) {
      const fingerprint = jsonFingerprint(input);
      if (!pending || pending.fingerprint !== fingerprint) {
        pending = { fingerprint, key: createKey(scope) };
      }
      return pending.key;
    },
    succeeded() {
      pending = undefined;
    },
    abandon() {
      pending = undefined;
    }
  };
}

function idempotencyKey(scope: string): string {
  const token = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${scope}:${token}`;
}

function jsonFingerprint(input: unknown): string {
  const fingerprint = JSON.stringify(input, (_key, value: unknown) => {
    if (!isPlainObject(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]));
  });
  if (fingerprint === undefined) {
    throw new TypeError("Logical mutation input must be JSON serializable.");
  }
  return fingerprint;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
