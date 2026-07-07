import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";
import { GitError, HunsuError } from "./errors.ts";
import { createBoardFromCommits } from "./board.ts";
import { parseCommitSha, parseGitRef } from "./primitives.ts";
import { serializeTrailers } from "./trailer.ts";
import type { Board, CommitRecord, MoveEvent, MoveEventStatus } from "./model.ts";
import type { CommitSha, GitRef } from "./primitives.ts";

const RECORD_SEPARATOR = "\x1e";
const FIELD_SEPARATOR = "\x1f";
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const LOG_FORMAT = [
  "%H",
  "%h",
  "%P",
  "%D",
  "%an",
  "%aI",
  "%s",
  "%B"
].join(FIELD_SEPARATOR);

type GitOptions = {
  cwd?: string;
  input?: string;
  env?: Record<string, string | undefined>;
};

export type GitLogOptions = {
  cwd?: string;
  refs?: string[];
};

export type HunsuCommitOptions = {
  cwd?: string;
  id: string;
  targetMove: MoveEvent;
  newRun: string;
  artifactText: string;
  actor?: string;
  role?: string;
  priority?: string;
};

export type HunsuCommitResult = {
  commitSha: CommitSha;
  markerRef: GitRef;
  runRef: GitRef;
  artifactPath: string;
  message: string;
};

export type MoveCommitResult = {
  commitSha: CommitSha;
  message: string;
};

export type FinalizedMoveCommitOptions = {
  cwd?: string;
  runId: string;
  moveId: string;
  goal: string;
  finalizerMessage: string;
  actor?: string;
};

export type MemberPathCommitOptions = {
  cwd?: string;
  runId: string;
  pathId: string;
  executorId: string;
  goal: string;
  requires: string[] | "PrevMove";
  paths?: string[];
};

export type MemberPathCommitResult = {
  commitSha: CommitSha;
  parentSha: CommitSha;
  treeSha: string;
  parentTreeSha: string;
  treeChanged: boolean;
  message: string;
};

export type SquashMoveCommitOptions = {
  cwd?: string;
  fromRef: string;
  runRef: string;
  message: string;
};

export type SquashMoveCommitResult = {
  commitSha: CommitSha;
  parentSha: CommitSha;
  fromSha: CommitSha;
  runRef: GitRef;
  message: string;
};

export function git(args: string[], options: GitOptions = {}): string {
  const result = spawnSync("git", args, {
    cwd: options.cwd,
    input: options.input,
    encoding: "utf8",
    maxBuffer: GIT_MAX_BUFFER,
    env: options.env
  });

  if (result.status !== 0) {
    throw new GitError(args, result.stderr.trim());
  }

  return result.stdout;
}

export function ensureGitRepository(cwd = process.cwd()): string {
  return git(["rev-parse", "--show-toplevel"], { cwd }).trim();
}

export function readCommitRecords(options: GitLogOptions = {}): CommitRecord[] {
  const hasCommit = git(["rev-list", "--all", "--max-count=1"], { cwd: options.cwd }).trim();
  if (!hasCommit) {
    return [];
  }

  const refs = options.refs && options.refs.length > 0 ? options.refs : ["--all"];
  const output = git(["log", "--date-order", `--format=${RECORD_SEPARATOR}${LOG_FORMAT}`, ...refs], {
    cwd: options.cwd
  });

  return output
    .split(RECORD_SEPARATOR)
    .filter(record => record.trim() !== "")
    .map(parseLogRecord);
}

export function loadBoardFromGit(options: GitLogOptions = {}): Board {
  return createBoardFromCommits(readCommitRecords(options));
}

export function buildMoveCommitMessage(input: {
  goal: string;
  run: string;
  move: string | number;
  summary?: string;
  why?: string;
  alternatives?: string;
  evidence?: string;
  risks?: string;
  next?: string;
  role?: string;
  actor?: string;
  status?: MoveEventStatus;
}): string {
  const subject = `move: ${input.summary ?? input.goal}`;
  const body = [
    `Goal: ${input.goal}`,
    input.why ? `Why: ${input.why}` : undefined,
    input.alternatives ? `Alternatives: ${input.alternatives}` : undefined,
    input.evidence ? `Evidence: ${input.evidence}` : undefined,
    input.risks ? `Risks: ${input.risks}` : undefined,
    input.next ? `Next: ${input.next}` : undefined
  ].filter(Boolean);

  const trailers = serializeTrailers({
    "Hunsu-Event": "move",
    "Hunsu-Run": input.run,
    "Hunsu-Move": input.move,
    "Hunsu-Goal": input.goal,
    "Hunsu-Role": input.role ?? "team",
    "Hunsu-Actor": input.actor ?? "agent:codex",
    "Hunsu-Status": input.status ?? "complete"
  });

  return `${subject}\n\n${body.join("\n")}\n\n${trailers}\n`;
}

export function createMoveCommit(message: string, options: { cwd?: string } = {}): MoveCommitResult {
  const cwd = options.cwd ?? process.cwd();
  const tempDir = createRepoTempDir(cwd, "hunsu-move-");
  const messageFile = join(tempDir, "message.txt");

  try {
    writeFileSync(messageFile, message, "utf8");
    git(["commit", "-F", messageFile], { cwd });
    const commitSha = parseCommitSha(git(["rev-parse", "HEAD"], { cwd }).trim());
    return { commitSha, message };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export function createMoveCommitFromWorktree(message: string, options: { cwd?: string } = {}): MoveCommitResult {
  const cwd = options.cwd ?? process.cwd();
  const changes = git(["status", "--porcelain=v1"], { cwd }).trim();
  if (!changes) {
    throw new HunsuError("Cannot create MOVE commit without worktree changes");
  }
  git(["add", "--all"], { cwd });
  return createMoveCommit(message, { cwd });
}

export function buildFinalizedMoveCommitMessage(input: FinalizedMoveCommitOptions): string {
  const message = input.finalizerMessage.trim();
  if (!message) {
    throw new HunsuError("MOVE finalizer returned an empty commit message");
  }
  const trailers = serializeTrailers({
    "Hunsu-Event": "move",
    "Hunsu-Run": input.runId,
    "Hunsu-Move": input.moveId,
    "Hunsu-Goal": input.goal,
    "Hunsu-Role": "move-finalizer",
    "Hunsu-Actor": input.actor ?? "agent:codex",
    "Hunsu-Status": "complete"
  });
  return `${message}\n\n${trailers}\n`;
}

export function createFinalizedMoveCommit(options: FinalizedMoveCommitOptions): MoveCommitResult {
  const cwd = options.cwd ?? process.cwd();
  const tempDir = createRepoTempDir(cwd, "hunsu-final-move-");
  const messageFile = join(tempDir, "message.txt");
  const message = buildFinalizedMoveCommitMessage(options);

  try {
    writeFileSync(messageFile, message, "utf8");
    git(["commit", "--allow-empty", "-F", messageFile], { cwd });
    const commitSha = parseCommitSha(git(["rev-parse", "--verify", "HEAD"], { cwd }).trim());
    return { commitSha, message };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export function buildMemberPathCommitMessage(input: MemberPathCommitOptions): string {
  const requires = Array.isArray(input.requires) ? input.requires.join(",") : input.requires;
  const trailers = serializeTrailers({
    "Hunsu-Event": "member-path",
    "Hunsu-Run": input.runId,
    "Hunsu-Path": input.pathId,
    "Hunsu-Member": input.executorId,
    "Hunsu-Goal": input.goal,
    "Hunsu-Requires": requires
  });

  return [
    `path: ${input.pathId} (${input.executorId})`,
    "",
    `Goal: ${input.goal}`,
    "",
    `Requires: ${requires}`,
    "",
    trailers
  ].join("\n") + "\n";
}

export function createMemberPathCommitFromWorktree(options: MemberPathCommitOptions): MemberPathCommitResult {
  const cwd = options.cwd ?? process.cwd();
  const tempDir = createRepoTempDir(cwd, "hunsu-path-");
  const messageFile = join(tempDir, "message.txt");
  const message = buildMemberPathCommitMessage(options);

  try {
    const parentSha = ensureCommitParent(cwd);
    const parentTreeSha = git(["rev-parse", "--verify", `${parentSha}^{tree}`], { cwd }).trim();
    writeFileSync(messageFile, message, "utf8");
    const paths = options.paths?.filter(path => path.trim() !== "");
    if (paths && paths.length > 0) {
      git(["add", "--all", "--", ...paths], { cwd });
    } else {
      git(["add", "--all"], { cwd });
    }
    git(["commit", "--allow-empty", "-F", messageFile], { cwd });
    const commitSha = parseCommitSha(git(["rev-parse", "--verify", "HEAD"], { cwd }).trim());
    const treeSha = git(["rev-parse", "--verify", `${commitSha}^{tree}`], { cwd }).trim();
    return {
      commitSha,
      parentSha,
      treeSha,
      parentTreeSha,
      treeChanged: treeSha !== parentTreeSha,
      message
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function ensureCommitParent(cwd: string): CommitSha {
  try {
    return parseCommitSha(git(["rev-parse", "--verify", "HEAD"], { cwd }).trim());
  } catch (_error) {
    git(["commit", "--allow-empty", "-m", "hunsu: initialize repository worktree"], { cwd });
    return parseCommitSha(git(["rev-parse", "--verify", "HEAD"], { cwd }).trim());
  }
}

export function createSquashMoveCommit(options: SquashMoveCommitOptions): SquashMoveCommitResult {
  const cwd = options.cwd ?? process.cwd();
  const tempDir = createRepoTempDir(cwd, "hunsu-squash-");
  const messageFile = join(tempDir, "message.txt");
  const runHeadRef = parseGitRef(toHeadRef(options.runRef));

  try {
    writeFileSync(messageFile, options.message, "utf8");
    const parentSha = parseCommitSha(git(["rev-parse", "--verify", options.runRef], { cwd }).trim());
    const fromSha = parseCommitSha(git(["rev-parse", "--verify", options.fromRef], { cwd }).trim());
    assertAncestor(parentSha, fromSha, cwd);
    const tree = git(["rev-parse", `${fromSha}^{tree}`], { cwd }).trim();
    const commitSha = parseCommitSha(git(["commit-tree", tree, "-p", parentSha, "-F", messageFile], { cwd }).trim());
    git(["update-ref", runHeadRef, commitSha, parentSha], { cwd });
    return { commitSha, parentSha, fromSha, runRef: runHeadRef, message: options.message };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export function buildHunsuCommitMessage(options: HunsuCommitOptions): string {
  const firstLine = options.artifactText
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line.length > 0);
  const title = firstLine?.replace(/^#+\s*/, "") || `intervention on ${options.targetMove.moveId}`;
  const trailers = serializeTrailers({
    "Hunsu-Event": "hunsu",
    "Hunsu-ID": options.id,
    "Hunsu-Target": options.targetMove.commit.sha,
    "Hunsu-Source-Run": options.targetMove.runId,
    "Hunsu-New-Run": options.newRun,
    "Hunsu-Role": options.role ?? "director",
    "Hunsu-Actor": options.actor ?? "human",
    "Hunsu-Priority": options.priority
  });

  return `hunsu: ${title}\n\n${options.artifactText.trim()}\n\n${trailers}\n`;
}

export function createHunsuCommit(options: HunsuCommitOptions): HunsuCommitResult {
  const cwd = options.cwd ?? process.cwd();
  const message = buildHunsuCommitMessage(options);
  const artifactPath = `.hunsu/hunsus/${options.id}.md`;
  const runRef = parseGitRef(`refs/heads/${options.newRun}`);
  const markerRef = parseGitRef(`refs/heads/hunsu/${options.id}/from/${options.targetMove.commit.shortSha}`);
  const indexDir = createRepoTempDir(cwd, "hunsu-index-");
  const indexPath = join(indexDir, "index");
  const artifactFile = join(indexDir, "artifact.md");
  const messageFile = join(indexDir, "message.txt");
  const env = { GIT_INDEX_FILE: indexPath };

  try {
    assertRefMissing(runRef, cwd);
    assertRefMissing(markerRef, cwd);
    writeFileSync(artifactFile, `${options.artifactText.trim()}\n`, "utf8");
    writeFileSync(messageFile, message, "utf8");
    git(["read-tree", `${options.targetMove.commit.sha}^{tree}`], { cwd, env });
    const blob = git(["hash-object", "-w", artifactFile], { cwd }).trim();
    git(["update-index", "--add", "--cacheinfo", `100644,${blob},${artifactPath}`], { cwd, env });
    const tree = git(["write-tree"], { cwd, env }).trim();
    const commitSha = parseCommitSha(git(["commit-tree", tree, "-p", options.targetMove.commit.sha, "-F", messageFile], { cwd }).trim());
    git(["update-ref", runRef, commitSha], { cwd });
    git(["update-ref", markerRef, commitSha], { cwd });
    return { commitSha, markerRef, runRef, artifactPath, message };
  } finally {
    rmSync(indexDir, { recursive: true, force: true });
  }
}

export function updateMainToMove(move: MoveEvent, options: { cwd?: string } = {}): string {
  git(["update-ref", "refs/heads/main", move.commit.sha], { cwd: options.cwd });
  return move.commit.sha;
}

function assertRefMissing(ref: string, cwd: string): void {
  const result = spawnSync("git", ["show-ref", "--verify", "--quiet", ref], {
    cwd,
    encoding: "utf8"
  });
  if (result.status === 0) {
    throw new HunsuError(`Ref already exists: ${ref}`);
  }
  if (result.status !== 1) {
    throw new GitError(["show-ref", "--verify", "--quiet", ref], result.stderr.trim());
  }
}

function createRepoTempDir(cwd: string, prefix: string): string {
  const gitPath = git(["rev-parse", "--git-path", "hunsu/tmp"], { cwd }).trim();
  const tempRoot = isAbsolute(gitPath) ? gitPath : join(cwd, gitPath);
  mkdirSync(tempRoot, { recursive: true });
  return mkdtempSync(join(tempRoot, prefix));
}

function assertAncestor(ancestorSha: string, descendantSha: string, cwd: string): void {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", ancestorSha, descendantSha], {
    cwd,
    encoding: "utf8"
  });
  if (result.status === 0) {
    return;
  }
  if (result.status === 1) {
    throw new HunsuError(`${ancestorSha} is not an ancestor of ${descendantSha}`);
  }
  throw new GitError(["merge-base", "--is-ancestor", ancestorSha, descendantSha], result.stderr.trim());
}

function toHeadRef(ref: string): string {
  return ref.startsWith("refs/") ? ref : `refs/heads/${ref}`;
}

function parseLogRecord(record: string): CommitRecord {
  const fields = splitFields(record, 8);
  const [sha, shortSha, parents, refs, authorName, authoredAt, subject, body] = fields;
  return {
    sha: parseCommitSha(sha),
    shortSha,
    parents: parents ? parents.split(" ") : [],
    refs: refs ? refs.split(", ").filter(Boolean).map(ref => parseGitRef(ref)) : [],
    authorName,
    authoredAt,
    subject,
    body
  };
}

function splitFields(record: string, count: number): string[] {
  const fields: string[] = [];
  let remainder = record;
  for (let index = 0; index < count - 1; index += 1) {
    const separator = remainder.indexOf(FIELD_SEPARATOR);
    if (separator === -1) {
      fields.push(remainder);
      remainder = "";
      continue;
    }
    fields.push(remainder.slice(0, separator));
    remainder = remainder.slice(separator + 1);
  }
  fields.push(remainder);
  return fields;
}
