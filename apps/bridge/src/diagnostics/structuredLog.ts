import { appendFile, chmod, mkdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { sanitizeDiagnostics, assertDiagnosticsSafe } from "./redaction.ts";
import type { HunsuPaths } from "../state/paths.ts";
import { isNodeError } from "../state/atomicJsonStore.ts";

export const STRUCTURED_LOG_SCHEMA = "hunsu.bridge.log.v1" as const;
export const DEFAULT_STRUCTURED_LOG_MAX_BYTES = 1_048_576;
export const DEFAULT_STRUCTURED_LOG_MAX_FILES = 3;

export type StructuredLogLevel = "debug" | "info" | "warn" | "error";

export type StructuredLogEvent = {
  level: StructuredLogLevel;
  event: string;
  message?: string;
  data?: unknown;
};

export type StructuredLogRecord = {
  schema: typeof STRUCTURED_LOG_SCHEMA;
  timestamp: string;
  level: StructuredLogLevel;
  event: string;
  message?: string;
  data?: unknown;
};

export type StructuredLog = {
  append(event: StructuredLogEvent): Promise<StructuredLogRecord>;
  read(options?: { limit?: number }): Promise<StructuredLogRecord[]>;
};

export function createStructuredLog(input: {
  paths: HunsuPaths;
  maxBytes?: number;
  maxFiles?: number;
  now?: () => Date;
}): StructuredLog {
  const maxBytes = positiveInteger(input.maxBytes ?? DEFAULT_STRUCTURED_LOG_MAX_BYTES, "maxBytes");
  const maxFiles = positiveInteger(input.maxFiles ?? DEFAULT_STRUCTURED_LOG_MAX_FILES, "maxFiles");
  const now = input.now ?? (() => new Date());
  let writeQueue = Promise.resolve();

  const append = async (event: StructuredLogEvent): Promise<StructuredLogRecord> => {
    const task = writeQueue.then(async () => {
      if (!event.event.trim()) throw new Error("Structured log event name must be non-empty.");
      const unsafeRecord: StructuredLogRecord = {
        schema: STRUCTURED_LOG_SCHEMA,
        timestamp: now().toISOString(),
        level: event.level,
        event: event.event,
        ...(event.message === undefined ? {} : { message: event.message }),
        ...(event.data === undefined ? {} : { data: event.data })
      };
      let record = sanitizeRecord(unsafeRecord);
      let line = `${JSON.stringify(record)}\n`;
      if (Buffer.byteLength(line) > maxBytes) {
        record = sanitizeRecord({
          schema: STRUCTURED_LOG_SCHEMA,
          timestamp: unsafeRecord.timestamp,
          level: unsafeRecord.level,
          event: unsafeRecord.event,
          message: "Structured log event exceeded the configured size limit.",
          data: { truncated: true }
        });
        line = `${JSON.stringify(record)}\n`;
      }
      if (Buffer.byteLength(line) > maxBytes) {
        throw new Error("Structured log maxBytes is too small for a valid record.");
      }
      await mkdir(input.paths.logsDirectory, { recursive: true, mode: 0o700 });
      await rotateIfRequired(input.paths.structuredLogFile, Buffer.byteLength(line), maxBytes, maxFiles);
      await appendFile(input.paths.structuredLogFile, line, { encoding: "utf8", mode: 0o600 });
      await chmod(input.paths.structuredLogFile, 0o600);
      return record;
    });
    writeQueue = task.then(() => undefined, () => undefined);
    return task;
  };

  return {
    append,
    async read(options = {}) {
      await writeQueue;
      const records: StructuredLogRecord[] = [];
      for (const file of historicalLogFiles(input.paths.structuredLogFile, maxFiles)) {
        const contents = await readOptional(file);
        if (contents === undefined) continue;
        for (const line of contents.split(/\r?\n/u)) {
          if (!line.trim()) continue;
          const record = parseRecord(line);
          if (record) records.push(record);
        }
      }
      const limit = options.limit;
      if (limit === undefined) return records;
      const safeLimit = Math.max(0, Math.trunc(limit));
      return safeLimit === 0 ? [] : records.slice(-safeLimit);
    }
  };
}

function sanitizeRecord(record: StructuredLogRecord): StructuredLogRecord {
  const sanitized = sanitizeDiagnostics(record);
  assertDiagnosticsSafe(sanitized);
  return sanitized as StructuredLogRecord;
}

function parseRecord(line: string): StructuredLogRecord | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!isStructuredLogRecord(parsed)) return undefined;
    return sanitizeRecord(parsed);
  } catch (_error) {
    return undefined;
  }
}

async function rotateIfRequired(file: string, incomingBytes: number, maxBytes: number, maxFiles: number): Promise<void> {
  let currentSize = 0;
  try {
    currentSize = (await stat(file)).size;
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
  if (currentSize === 0 || currentSize + incomingBytes <= maxBytes) return;

  if (maxFiles === 1) {
    await unlink(file).catch(error => {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    });
    return;
  }

  await unlink(`${file}.${maxFiles - 1}`).catch(error => {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  });
  for (let index = maxFiles - 2; index >= 1; index -= 1) {
    await renameIfPresent(`${file}.${index}`, `${file}.${index + 1}`);
  }
  await renameIfPresent(file, `${file}.1`);
}

async function renameIfPresent(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
}

function historicalLogFiles(file: string, maxFiles: number): string[] {
  const files: string[] = [];
  for (let index = maxFiles - 1; index >= 1; index -= 1) files.push(`${file}.${index}`);
  files.push(file);
  return files;
}

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${field} must be a positive integer.`);
  return value;
}

function isStructuredLogRecord(value: unknown): value is StructuredLogRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.schema === STRUCTURED_LOG_SCHEMA
    && typeof record.timestamp === "string"
    && (record.level === "debug" || record.level === "info" || record.level === "warn" || record.level === "error")
    && typeof record.event === "string";
}
