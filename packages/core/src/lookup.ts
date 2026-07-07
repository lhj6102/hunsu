import { LookupError } from "./errors.ts";
import type { Board, MoveEvent } from "./model.ts";
import { formatMoveId } from "./trailer.ts";

export type LookupOptions = {
  runId?: string;
};

export function resolveMove(board: Board, selector: string, options: LookupOptions = {}): MoveEvent {
  const normalized = normalizeSelector(selector);
  const candidates = board.moves.filter(move => {
    if (options.runId && move.runId !== options.runId) {
      return false;
    }
    return (
      move.commit.sha === selector ||
      move.commit.sha.startsWith(selector) ||
      move.commit.shortSha === selector ||
      move.moveId === normalized ||
      move.moveNumber === selector ||
      `${move.runId}:${move.moveId}` === selector
    );
  });

  if (candidates.length === 0) {
    throw new LookupError(`No move found for ${selector}`);
  }

  const unique = dedupeBySha(candidates);
  if (unique.length > 1) {
    const choices = unique.map(move => `${move.runId}:${move.moveId}@${move.commit.shortSha}`).join(", ");
    throw new LookupError(`Ambiguous move selector ${selector}: ${choices}`);
  }

  return unique[0];
}

export function nextHunsuId(board: Board): string {
  const highest = board.hunsus.reduce((max, hunsu) => {
    const match = hunsu.hunsuId.match(/^h(\d+)$/i);
    if (!match) {
      return max;
    }
    return Math.max(max, Number(match[1]));
  }, 0);
  return `h${String(highest + 1).padStart(3, "0")}`;
}

export function defaultHunsuRun(sourceRun: string, hunsuId: string): string {
  const suffix = hunsuId.replace(/^h/i, "h");
  return `${sourceRun}-${suffix}`;
}

function normalizeSelector(selector: string): string {
  if (/^M?\d+$/i.test(selector)) {
    return formatMoveId(selector);
  }
  return selector;
}

function dedupeBySha(moves: MoveEvent[]): MoveEvent[] {
  const seen = new Set<string>();
  const unique: MoveEvent[] = [];
  for (const move of moves) {
    if (seen.has(move.commit.sha)) {
      continue;
    }
    seen.add(move.commit.sha);
    unique.push(move);
  }
  return unique;
}
