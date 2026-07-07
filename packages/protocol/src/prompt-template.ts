import { DomainInvariantError, workflowError, type DomainWorkflowError } from "./errors.ts";
import { ok, type Result } from "./result.ts";

export const PROMPT_TEMPLATE_ENGINE_V1 = "hunsu-template-v1" as const;

export type PromptTemplate = {
  engine: typeof PROMPT_TEMPLATE_ENGINE_V1;
  template: string;
};

export type PromptTemplateContext = Record<string, unknown>;

export function promptTemplateFromText(template: string): PromptTemplate {
  return { engine: PROMPT_TEMPLATE_ENGINE_V1, template };
}

export function decodePromptTemplate(value: unknown, path: string): Result<PromptTemplate, DomainWorkflowError> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return workflowError(`${path} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(["engine", "template"]);
  const unexpected = Object.keys(record).filter(key => !allowed.has(key));
  if (unexpected.length > 0) {
    return workflowError(`${path} has unsupported field: ${unexpected[0]}`);
  }
  if (!("engine" in record)) {
    return workflowError(`${path}.engine is required`);
  }
  if (!("template" in record)) {
    return workflowError(`${path}.template is required`);
  }
  if (record.engine !== PROMPT_TEMPLATE_ENGINE_V1) {
    return workflowError(`${path}.engine must be ${PROMPT_TEMPLATE_ENGINE_V1}`);
  }
  if (typeof record.template !== "string") {
    return workflowError(`${path}.template must be a string`);
  }
  return ok({ engine: PROMPT_TEMPLATE_ENGINE_V1, template: record.template });
}

export function assertValidPromptTemplate(value: unknown, path: string): asserts value is PromptTemplate {
  const result = decodePromptTemplate(value, path);
  if (!result.ok) {
    throw new DomainInvariantError(result.error.message);
  }
}

export function renderPromptTemplate(template: PromptTemplate, context: PromptTemplateContext): string {
  assertValidPromptTemplate(template, "promptTemplate");
  return template.template.replace(/\{\{\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[[0-9]+\])*)\s*\}\}/g, (_match, expression: string) => {
    const value = resolveTemplateExpression(context, expression);
    if (value === undefined || value === null) {
      throw new DomainInvariantError(`Prompt template value is unavailable: ${expression}`);
    }
    return formatTemplateValue(value);
  });
}

function resolveTemplateExpression(context: PromptTemplateContext, expression: string): unknown {
  const tokens = expression.match(/[A-Za-z_$][\w$]*|\[[0-9]+\]/g);
  if (!tokens || tokens.join("").replace(/\]\[/g, "][") === "") {
    return undefined;
  }
  let current: unknown = context;
  for (const token of tokens) {
    if (token.startsWith("[")) {
      const index = Number(token.slice(1, -1));
      if (!Array.isArray(current)) {
        return undefined;
      }
      current = current[index];
      continue;
    }
    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[token];
  }
  return current;
}

function formatTemplateValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(formatTemplateValue).join("\n");
  }
  if (typeof value === "object" && value !== null) {
    return JSON.stringify(value);
  }
  return "";
}
