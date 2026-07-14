import type { PluginSafeError, ToolResponse } from "./contract.ts";
import {
  findHunsuTool,
  HUNSU_MCP_TOOLS,
  isRetiredHunsuV1Tool,
  type HunsuToolName,
  type HunsuToolDefinition,
  type JsonSchema
} from "./tools.ts";

export type JsonRpcId = string | number | null;

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
};

export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId; error: { code: number; message: string; data?: unknown } };

export interface McpToolDispatcher<Context> {
  call(name: HunsuToolName, argumentsValue: Record<string, unknown>, context: Context): Promise<ToolResponse<unknown>>;
}

export async function handleMcpRequest<Context>(
  input: unknown,
  dispatcher: McpToolDispatcher<Context>,
  context: Context
): Promise<JsonRpcResponse | undefined> {
  const request = decodeRequest(input);
  if (!request.ok) return jsonRpcError(null, -32600, request.message);
  if (request.value.id === undefined && request.value.method.startsWith("notifications/")) return undefined;
  const id = request.value.id ?? null;

  if (request.value.method === "initialize") {
    return jsonRpcResult(id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "hunsu", version: "0.2.0" }
    });
  }
  if (request.value.method === "ping") return jsonRpcResult(id, {});
  if (request.value.method === "tools/list") {
    return jsonRpcResult(id, {
      tools: HUNSU_MCP_TOOLS.map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
          readOnlyHint: tool.readOnly,
          destructiveHint: false,
          idempotentHint: !tool.readOnly,
          openWorldHint: true
        }
      }))
    });
  }
  if (request.value.method !== "tools/call") return jsonRpcError(id, -32601, `Unknown method ${request.value.method}.`);
  if (!isRecord(request.value.params) || typeof request.value.params.name !== "string") {
    return jsonRpcError(id, -32602, "tools/call requires a tool name and arguments object.");
  }
  const tool = findHunsuTool(request.value.params.name);
  if (!tool && isRetiredHunsuV1Tool(request.value.params.name)) {
    return jsonRpcResult(id, toolCallResult({
      ok: false,
      error: {
        code: "unsupported_protocol_version",
        message: `Hunsu v2 does not support retired tool ${request.value.params.name}.`,
        retryable: false,
        recovery: "Reload the v2 tool list and use Node-scoped Goals, Runner Values, and Coaching transitions."
      }
    }));
  }
  if (!tool) return jsonRpcError(id, -32602, `Unknown Hunsu tool ${request.value.params.name}.`);
  const argumentsValue = request.value.params.arguments ?? {};
  if (!isRecord(argumentsValue)) return jsonRpcError(id, -32602, "Tool arguments must be an object.");
  if (tool.requiresUserConfirmation && argumentsValue.confirmedByUser !== true) {
    return jsonRpcResult(id, toolCallResult({
      ok: false,
      error: {
        code: "confirmation_required",
        message: tool.confirmationMessage ?? "This mutation requires explicit user confirmation.",
        retryable: true,
        recovery: tool.confirmationRecovery ?? "Show the exact proposed mutation and ask the user to confirm before retrying."
      }
    }));
  }
  const validation = validateSchema(tool, argumentsValue);
  if (validation) return jsonRpcError(id, -32602, validation);

  try {
    return jsonRpcResult(id, toolCallResult(await dispatcher.call(tool.name, argumentsValue, context)));
  } catch {
    const error: PluginSafeError = {
      code: "temporarily_unavailable",
      message: "The Hunsu service could not complete the tool call.",
      retryable: true,
      recovery: "Retry once. If the error repeats, reload the Project state before continuing."
    };
    return jsonRpcResult(id, toolCallResult({ ok: false, error }));
  }
}

function toolCallResult(response: ToolResponse<unknown>): unknown {
  const text = JSON.stringify(response);
  return {
    content: [{ type: "text", text }],
    structuredContent: response,
    isError: !response.ok
  };
}

function validateSchema(tool: HunsuToolDefinition, value: Record<string, unknown>): string | undefined {
  return validateValue(tool.inputSchema, value, "arguments");
}

function validateValue(schema: JsonSchema, value: unknown, path: string): string | undefined {
  if (schema["x-hunsu-canonical-json"] === true) return validateCanonicalJson(value, path);
  if (Array.isArray(schema.oneOf)) {
    const variants = schema.oneOf.filter(isRecord) as JsonSchema[];
    const matches = variants.filter(variant => validateValue(variant, value, path) === undefined).length;
    if (matches !== 1) return `${path} must match exactly one supported variant.`;
  }
  if (schema.const !== undefined && value !== schema.const) return `${path} must equal ${JSON.stringify(schema.const)}.`;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return `${path} has an unsupported value.`;
  if (schema.type === "object") {
    if (!isRecord(value)) return `${path} must be an object.`;
    const properties = isRecord(schema.properties) ? schema.properties as Record<string, JsonSchema> : {};
    const required = Array.isArray(schema.required) ? schema.required.filter(item => typeof item === "string") as string[] : [];
    for (const key of required) if (value[key] === undefined) return `${path}.${key} is required.`;
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (properties[key] === undefined) return `${path}.${key} is not supported.`;
    }
    for (const [key, nested] of Object.entries(value)) {
      if (nested !== undefined && properties[key]) {
        const failure = validateValue(properties[key], nested, `${path}.${key}`);
        if (failure) return failure;
      }
    }
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) return `${path} must be an array.`;
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return `${path} has too few items.`;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return `${path} has too many items.`;
    if (schema.uniqueItems === true && new Set(value.map(item => JSON.stringify(item))).size !== value.length) return `${path} must contain unique items.`;
    if (isRecord(schema.items)) {
      for (let index = 0; index < value.length; index += 1) {
        const failure = validateValue(schema.items, value[index], `${path}[${index}]`);
        if (failure) return failure;
      }
    }
  }
  if (schema.type === "string") {
    if (typeof value !== "string") return `${path} must be a string.`;
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return `${path} is too short.`;
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return `${path} is too long.`;
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) return `${path} has an invalid format.`;
    if (schema.format === "uri") {
      try {
        const url = new URL(value);
        if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
          return `${path} must be a credential-free HTTP(S) URL.`;
        }
      } catch {
        return `${path} must be a credential-free HTTP(S) URL.`;
      }
    }
    if (schema.format === "date-time"
      && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
        || !Number.isFinite(Date.parse(value)))) {
      return `${path} must be a valid RFC 3339 timestamp.`;
    }
  }
  if (schema.type === "integer") {
    if (!Number.isSafeInteger(value)
      || (typeof schema.minimum === "number" && (value as number) < schema.minimum)
      || (typeof schema.maximum === "number" && (value as number) > schema.maximum)) {
      return `${path} must be a valid integer.`;
    }
  }
  return undefined;
}

function validateCanonicalJson(value: unknown, path: string): string | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return undefined;
  if (typeof value === "number") {
    return Number.isFinite(value) && !Object.is(value, -0)
      ? undefined
      : `${path} must contain only canonical JSON values.`;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const failure = validateCanonicalJson(value[index], `${path}[${index}]`);
      if (failure) return failure;
    }
    return undefined;
  }
  if (!isRecord(value)) return `${path} must contain only canonical JSON values.`;
  for (const [key, nested] of Object.entries(value)) {
    const failure = validateCanonicalJson(nested, `${path}.${key}`);
    if (failure) return failure;
  }
  return undefined;
}

function decodeRequest(input: unknown): { ok: true; value: JsonRpcRequest } | { ok: false; message: string } {
  if (!isRecord(input) || input.jsonrpc !== "2.0" || typeof input.method !== "string") {
    return { ok: false, message: "Invalid JSON-RPC request." };
  }
  if (input.id !== undefined && input.id !== null && typeof input.id !== "string" && typeof input.id !== "number") {
    return { ok: false, message: "Invalid JSON-RPC id." };
  }
  return { ok: true, value: input as JsonRpcRequest };
}

function jsonRpcResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
