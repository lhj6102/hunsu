import {
  MAX_NODE_PAYLOAD_DECODED_BYTES,
  MAX_NODE_PAYLOAD_ENCODED_BYTES,
  NODE_PAYLOAD_CODEC,
  NODE_PAYLOAD_ENVELOPE_SCHEMA,
  computeNodePayloadDigest,
  type NodePayload,
  type NodePayloadDigest,
  type NodePayloadEnvelope,
  type NonNegativeInteger
} from "@hunsu/protocol";
import { gzipSync, gunzipSync } from "fflate";
import { canonicalJson, sha256 } from "./canonical-json.ts";
import type { StoreResult } from "./types.ts";

export {
  MAX_NODE_PAYLOAD_DECODED_BYTES as MAX_NODE_DECODED_BYTES,
  MAX_NODE_PAYLOAD_ENCODED_BYTES as MAX_NODE_ENCODED_BYTES,
  NODE_PAYLOAD_CODEC as NODE_ENVELOPE_CODEC,
  NODE_PAYLOAD_ENVELOPE_SCHEMA as NODE_ENVELOPE_SCHEMA
};
export type { NodePayloadEnvelope as NodeEnvelope };

const PAYLOAD_DIGEST = /^hunsu-node-payload-v1:sha256:[0-9a-f]{64}$/u;

export function encodeNodeEnvelope(value: NodePayload): StoreResult<NodePayloadEnvelope> {
  let json: string;
  let decoded: Uint8Array;
  try {
    json = canonicalJson(value);
    decoded = new TextEncoder().encode(json);
  } catch {
    return failure("Node payload cannot be represented as canonical JSON.");
  }
  if (decoded.byteLength > MAX_NODE_PAYLOAD_DECODED_BYTES) {
    return failure(`Node payload exceeds the ${MAX_NODE_PAYLOAD_DECODED_BYTES} byte decoded limit.`);
  }
  const compressed = gzipSync(decoded, { level: 9, mtime: 0 });
  const data = Buffer.from(compressed).toString("base64");
  const encodedSize = new TextEncoder().encode(data).byteLength;
  if (encodedSize > MAX_NODE_PAYLOAD_ENCODED_BYTES) {
    return failure(`Node payload exceeds the ${MAX_NODE_PAYLOAD_ENCODED_BYTES} byte encoded limit.`);
  }
  return {
    ok: true,
    value: {
      schema: NODE_PAYLOAD_ENVELOPE_SCHEMA,
      codec: NODE_PAYLOAD_CODEC,
      decodedSize: decoded.byteLength as NonNegativeInteger,
      encodedSize: encodedSize as NonNegativeInteger,
      digest: computeNodePayloadDigest(value),
      data: data as NodePayloadEnvelope["data"]
    }
  };
}

export function decodeNodeEnvelope(input: unknown): StoreResult<{ value: unknown; digest: NodePayloadDigest }> {
  const envelope = decodeEnvelopeShape(input);
  if (!envelope.ok) return envelope;
  let compressed: Uint8Array;
  try {
    compressed = Uint8Array.from(Buffer.from(envelope.value.data, "base64"));
  } catch {
    return failure("Node envelope data is not valid base64.");
  }
  if (Buffer.from(compressed).toString("base64") !== envelope.value.data) {
    return failure("Node envelope data is not canonical base64.");
  }
  if (compressed.byteLength < 4 || gzipDecodedSize(compressed) !== envelope.value.decodedSize) {
    return failure("Node envelope gzip size does not match decodedSize.");
  }
  let decoded: Uint8Array;
  try {
    decoded = gunzipSync(compressed, { out: new Uint8Array(envelope.value.decodedSize) });
  } catch {
    return failure("Node envelope gzip data is invalid.");
  }
  if (decoded.byteLength !== envelope.value.decodedSize || decoded.byteLength > MAX_NODE_PAYLOAD_DECODED_BYTES) {
    return failure("Node envelope decoded size does not match its data.");
  }
  let json: string;
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
  } catch {
    return failure("Node envelope decoded data is not valid UTF-8.");
  }
  const digest = `hunsu-node-payload-v1:sha256:${sha256(json)}` as NodePayloadDigest;
  if (digest !== envelope.value.digest) return failure("Node envelope digest does not match its decoded payload.");
  try {
    const value: unknown = JSON.parse(json);
    if (canonicalJson(value) !== json) return failure("Node envelope payload is not canonical JSON.");
    return { ok: true, value: { value, digest } };
  } catch {
    return failure("Node envelope decoded payload is not valid JSON.");
  }
}

function gzipDecodedSize(value: Uint8Array): number {
  const offset = value.byteLength - 4;
  return (value[offset]!
    | (value[offset + 1]! << 8)
    | (value[offset + 2]! << 16)
    | (value[offset + 3]! << 24)) >>> 0;
}

function decodeEnvelopeShape(input: unknown): StoreResult<NodePayloadEnvelope> {
  if (!isRecord(input)) return failure("Node envelope must be an object.");
  const keys = Object.keys(input).sort();
  const expected = ["codec", "data", "decodedSize", "digest", "encodedSize", "schema"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    return failure("Node envelope contains missing or unsupported fields.");
  }
  if (input.schema !== NODE_PAYLOAD_ENVELOPE_SCHEMA || input.codec !== NODE_PAYLOAD_CODEC) {
    return failure("Node envelope has an unsupported schema or codec.");
  }
  if (!Number.isSafeInteger(input.decodedSize)
    || (input.decodedSize as number) < 0
    || (input.decodedSize as number) > MAX_NODE_PAYLOAD_DECODED_BYTES
    || !Number.isSafeInteger(input.encodedSize)
    || (input.encodedSize as number) < 0
    || (input.encodedSize as number) > MAX_NODE_PAYLOAD_ENCODED_BYTES
    || typeof input.digest !== "string"
    || !PAYLOAD_DIGEST.test(input.digest)
    || typeof input.data !== "string"
    || new TextEncoder().encode(input.data).byteLength !== input.encodedSize
  ) {
    return failure("Node envelope metadata is invalid.");
  }
  return {
    ok: true,
    value: {
      schema: NODE_PAYLOAD_ENVELOPE_SCHEMA,
      codec: NODE_PAYLOAD_CODEC,
      decodedSize: input.decodedSize as NonNegativeInteger,
      encodedSize: input.encodedSize as NonNegativeInteger,
      digest: input.digest as NodePayloadDigest,
      data: input.data as NodePayloadEnvelope["data"]
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function failure(message: string): StoreResult<never> {
  return { ok: false, error: { code: "integrity", message } };
}
