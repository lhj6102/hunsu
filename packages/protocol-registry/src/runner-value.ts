import { err, ok, type CanonicalJsonValue, type Result, type RunnerValueDecodeError } from "@hunsu/protocol";
import { canonicalJson } from "./canonical.ts";
import type { RunnerValueSchema } from "./model.ts";

export function decodeRunnerValuePayload(
  schema: RunnerValueSchema,
  value: CanonicalJsonValue,
  path = "$.value"
): Result<CanonicalJsonValue, RunnerValueDecodeError> {
  switch (schema.type) {
    case "object": {
      if (!isRecord(value)) return invalid(path, "value must be an object");
      const unknown = Object.keys(value).filter(key => !Object.hasOwn(schema.properties, key)).sort();
      if (unknown.length > 0) return invalid(path, `unsupported keys: ${unknown.join(", ")}`);
      for (const key of schema.required) {
        if (!Object.hasOwn(value, key)) return invalid(`${path}.${key}`, "required value is missing");
      }
      const decoded: Record<string, CanonicalJsonValue> = {};
      for (const key of Object.keys(value).sort()) {
        const propertySchema = schema.properties[key];
        if (!propertySchema) return invalid(`${path}.${key}`, "unsupported value");
        const property = decodeRunnerValuePayload(propertySchema, value[key]!, `${path}.${key}`);
        if (!property.ok) return property;
        Object.defineProperty(decoded, key, {
          value: property.value,
          enumerable: true,
          configurable: true,
          writable: true
        });
      }
      return ok(decoded);
    }
    case "array": {
      if (!Array.isArray(value)) return invalid(path, "value must be an array");
      if (value.length < schema.minItems || value.length > schema.maxItems) {
        return invalid(path, `array length must be between ${schema.minItems} and ${schema.maxItems}`);
      }
      const decoded: CanonicalJsonValue[] = [];
      const canonicalItems = new Set<string>();
      for (let index = 0; index < value.length; index += 1) {
        const item = decodeRunnerValuePayload(schema.items, value[index]!, `${path}[${index}]`);
        if (!item.ok) return item;
        if (schema.uniqueItems) {
          const canonical = canonicalJson(item.value, `${path}[${index}]`);
          if (!canonical.ok) return invalid(canonical.error.path, canonical.error.message);
          if (canonicalItems.has(canonical.value)) return invalid(`${path}[${index}]`, "array items must be unique");
          canonicalItems.add(canonical.value);
        }
        decoded.push(item.value);
      }
      return ok(decoded);
    }
    case "contiguous_ordered_array": {
      if (!Array.isArray(value)) return invalid(path, "value must be an array");
      if (value.length < schema.minItems || value.length > schema.maxItems) {
        return invalid(path, `array length must be between ${schema.minItems} and ${schema.maxItems}`);
      }
      const decoded: CanonicalJsonValue[] = [];
      const orders = new Set<number>();
      for (let index = 0; index < value.length; index += 1) {
        const item = decodeRunnerValuePayload(schema.items, value[index]!, `${path}[${index}]`);
        if (!item.ok) return item;
        if (!isRecord(item.value)) return invalid(`${path}[${index}]`, "value must be an object");
        const orderValue = item.value[schema.orderField];
        if (!Number.isSafeInteger(orderValue)) {
          return invalid(`${path}[${index}].${schema.orderField}`, "order value must be a safe integer");
        }
        const order = Number(orderValue);
        if (orders.has(order)) {
          return invalid(`${path}[${index}].${schema.orderField}`, "order values must be unique");
        }
        orders.add(order);
        decoded.push(item.value);
      }
      for (let offset = 0; offset < decoded.length; offset += 1) {
        const expected = schema.startAt + offset;
        if (!orders.has(expected)) {
          return invalid(
            path,
            `order values must form a contiguous sequence from ${schema.startAt}; missing ${expected}`
          );
        }
      }
      return ok(decoded);
    }
    case "string":
      return typeof value === "string" && value.length >= schema.minLength && value.length <= schema.maxLength
        ? ok(value)
        : invalid(path, `value must be text between ${schema.minLength} and ${schema.maxLength} characters`);
    case "string_enum":
      return typeof value === "string" && schema.values.includes(value)
        ? ok(value)
        : invalid(path, `value must be one of ${schema.values.join(", ")}`);
    case "integer":
      return Number.isSafeInteger(value) && Number(value) >= schema.minimum && Number(value) <= schema.maximum
        ? ok(value)
        : invalid(path, `value must be an integer between ${schema.minimum} and ${schema.maximum}`);
    case "number":
      return typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)
        && value >= schema.minimum && value <= schema.maximum
        ? ok(value)
        : invalid(path, `value must be a number between ${schema.minimum} and ${schema.maximum}`);
    case "boolean":
      return typeof value === "boolean" ? ok(value) : invalid(path, "value must be boolean");
    case "null":
      return value === null ? ok(null) : invalid(path, "value must be null");
  }
}

function isRecord(value: CanonicalJsonValue): value is { readonly [key: string]: CanonicalJsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(path: string, message: string): Result<never, RunnerValueDecodeError> {
  return err({ type: "RunnerValueDecodeError", path, message });
}
