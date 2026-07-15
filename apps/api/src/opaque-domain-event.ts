import { createHash } from "node:crypto";
import { type StoreResult } from "@hunsu/github-store";
import {
  canonicalJson,
  decodeCanonicalJsonValue,
  decodeDomainEvent,
  encodeDomainEvent,
  type DomainEvent,
  type RunnerValueTypeRegistry
} from "@hunsu/protocol";
import { gunzipSync, gzipSync } from "fflate";

export const OPAQUE_DOMAIN_EVENT_SCHEMA = "hunsu.opaque-domain-event.v1" as const;
export const OPAQUE_DOMAIN_EVENT_CODEC = "canonical-json+deterministic-gzip+base64" as const;
export const MAX_OPAQUE_DOMAIN_EVENT_DECODED_BYTES = 4 * 1_048_576;
export const MAX_OPAQUE_DOMAIN_EVENT_ENCODED_BYTES = 6 * 1_048_576;

const DIGEST = /^hunsu-domain-event-v2:sha256:[0-9a-f]{64}$/u;

export type OpaqueDomainEvent = {
  readonly schema: typeof OPAQUE_DOMAIN_EVENT_SCHEMA;
  readonly codec: typeof OPAQUE_DOMAIN_EVENT_CODEC;
  readonly decodedSize: number;
  readonly encodedSize: number;
  readonly digest: string;
  readonly data: string;
};

export function encodeOpaqueDomainEvent(event: DomainEvent): StoreResult<OpaqueDomainEvent> {
  const canonical = encodeDomainEvent(event);
  const decoded = new TextEncoder().encode(canonical);
  if (decoded.byteLength > MAX_OPAQUE_DOMAIN_EVENT_DECODED_BYTES) {
    return failure(`Domain event exceeds the ${MAX_OPAQUE_DOMAIN_EVENT_DECODED_BYTES} byte decoded limit.`);
  }
  const compressed = gzipSync(decoded, { level: 9, mtime: 0 });
  const data = Buffer.from(compressed).toString("base64");
  const encodedSize = Buffer.byteLength(data, "utf8");
  if (encodedSize > MAX_OPAQUE_DOMAIN_EVENT_ENCODED_BYTES) {
    return failure(`Domain event exceeds the ${MAX_OPAQUE_DOMAIN_EVENT_ENCODED_BYTES} byte encoded limit.`);
  }
  return ok({
    schema: OPAQUE_DOMAIN_EVENT_SCHEMA,
    codec: OPAQUE_DOMAIN_EVENT_CODEC,
    decodedSize: decoded.byteLength,
    encodedSize,
    digest: digest(canonical),
    data
  });
}

export function decodeOpaqueDomainEvent(
  input: unknown,
  runnerTypes: RunnerValueTypeRegistry
): StoreResult<DomainEvent> {
  const envelope = decodeEnvelope(input);
  if (!envelope.ok) return envelope;
  const compressed = Buffer.from(envelope.value.data, "base64");
  if (compressed.toString("base64") !== envelope.value.data) {
    return failure("Opaque Domain event data must be canonical padded base64.");
  }
  if (compressed.byteLength < 4 || gzipDecodedSize(compressed) !== envelope.value.decodedSize) {
    return failure("Opaque Domain event gzip size does not match decodedSize.");
  }

  let decodedBytes: Uint8Array;
  try {
    decodedBytes = gunzipSync(compressed, {
      out: new Uint8Array(envelope.value.decodedSize)
    });
  } catch {
    return failure("Opaque Domain event gzip data is invalid.");
  }
  let canonical: string;
  try {
    canonical = new TextDecoder("utf-8", { fatal: true }).decode(decodedBytes);
  } catch {
    return failure("Opaque Domain event data is not valid UTF-8.");
  }
  if (digest(canonical) !== envelope.value.digest) {
    return failure("Opaque Domain event digest does not match its decoded data.");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(canonical);
  } catch {
    return failure("Opaque Domain event data is not valid JSON.");
  }
  const canonicalValue = decodeCanonicalJsonValue(raw);
  if (!canonicalValue.ok || `${canonicalJson(canonicalValue.value)}\n` !== canonical) {
    return failure("Opaque Domain event data is not canonical event JSON.");
  }

  const event = decodeDomainEvent(canonical, runnerTypes);
  if (!event.ok) {
    return failure(`Opaque Domain event is invalid at ${event.error.path}: ${event.error.message}`);
  }
  return ok(event.value);
}

export function verifiedOpaqueDomainEventDigest(input: unknown): StoreResult<string> {
  const envelope = decodeEnvelope(input);
  return envelope.ok ? ok(envelope.value.digest) : envelope;
}

function decodeEnvelope(input: unknown): StoreResult<OpaqueDomainEvent> {
  if (!isRecord(input)) return failure("Opaque Domain event must be an object.");
  const expected = ["codec", "data", "decodedSize", "digest", "encodedSize", "schema"];
  const keys = Object.keys(input).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    return failure("Opaque Domain event contains missing or unsupported fields.");
  }
  if (input.schema !== OPAQUE_DOMAIN_EVENT_SCHEMA || input.codec !== OPAQUE_DOMAIN_EVENT_CODEC) {
    return failure("Opaque Domain event has an unsupported schema or codec.");
  }
  if (!Number.isSafeInteger(input.decodedSize)
    || (input.decodedSize as number) < 1
    || (input.decodedSize as number) > MAX_OPAQUE_DOMAIN_EVENT_DECODED_BYTES
    || !Number.isSafeInteger(input.encodedSize)
    || (input.encodedSize as number) < 1
    || (input.encodedSize as number) > MAX_OPAQUE_DOMAIN_EVENT_ENCODED_BYTES
    || typeof input.digest !== "string"
    || !DIGEST.test(input.digest)
    || typeof input.data !== "string"
    || Buffer.byteLength(input.data, "utf8") !== input.encodedSize
  ) {
    return failure("Opaque Domain event metadata is invalid.");
  }
  return ok({
    schema: OPAQUE_DOMAIN_EVENT_SCHEMA,
    codec: OPAQUE_DOMAIN_EVENT_CODEC,
    decodedSize: input.decodedSize as number,
    encodedSize: input.encodedSize as number,
    digest: input.digest,
    data: input.data
  });
}

function gzipDecodedSize(value: Uint8Array): number {
  const offset = value.byteLength - 4;
  return (value[offset]!
    | (value[offset + 1]! << 8)
    | (value[offset + 2]! << 16)
    | (value[offset + 3]! << 24)) >>> 0;
}

function digest(value: string): string {
  const hash = createHash("sha256").update(value, "utf8").digest("hex");
  return `hunsu-domain-event-v2:sha256:${hash}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function ok<T>(value: T): StoreResult<T> {
  return { ok: true, value };
}

function failure(message: string): StoreResult<never> {
  return { ok: false, error: { code: "invalid_event", message } };
}
