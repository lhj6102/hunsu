import { InvalidTrailerError, MissingTrailerError } from "./errors.ts";
import type { TrailerMap } from "./model.ts";

const TRAILER_LINE = /^([A-Za-z][A-Za-z0-9-]*):[ \t]*(.*)$/;

export function parseTrailers(message: string): TrailerMap {
  const lines = message.replace(/\r\n/g, "\n").split("\n");
  let end = lines.length - 1;

  while (end >= 0 && lines[end].trim() === "") {
    end -= 1;
  }

  const trailerLines: string[] = [];
  for (let index = end; index >= 0; index -= 1) {
    const line = lines[index];
    if (line.trim() === "") {
      break;
    }
    if (!TRAILER_LINE.test(line)) {
      break;
    }
    trailerLines.unshift(line);
  }

  const trailers: TrailerMap = new Map();
  for (const line of trailerLines) {
    const match = line.match(TRAILER_LINE);
    if (!match) {
      throw new InvalidTrailerError(`Invalid trailer line: ${line}`);
    }
    const [, key, value] = match;
    const values = trailers.get(key) ?? [];
    values.push(value.trim());
    trailers.set(key, values);
  }

  return trailers;
}

export function getTrailer(trailers: TrailerMap, key: string): string | undefined {
  const values = trailers.get(key);
  return values?.[values.length - 1];
}

export function requireTrailer(trailers: TrailerMap, key: string, commitSha: string): string {
  const value = getTrailer(trailers, key);
  if (!value) {
    throw new MissingTrailerError(commitSha, key);
  }
  return value;
}

export function serializeTrailers(trailers: Record<string, string | number | boolean | undefined>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(trailers)) {
    if (value === undefined) {
      continue;
    }
    lines.push(`${key}: ${String(value)}`);
  }
  return lines.join("\n");
}

export function formatMoveNumber(value: string | number): string {
  const raw = String(value).trim();
  if (/^M\d+$/i.test(raw)) {
    return raw.slice(1).padStart(4, "0");
  }
  if (/^\d+$/.test(raw)) {
    return raw.padStart(4, "0");
  }
  return raw;
}

export function formatMoveId(value: string | number): string {
  const number = formatMoveNumber(value);
  return /^M/i.test(number) ? number.toUpperCase() : `M${number}`;
}
