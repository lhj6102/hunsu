import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { loadDomainStore } from "./domain-store.ts";
import { ensureGitRepository, git } from "./git.ts";
import type { ArtifactActionDefinition } from "@hunsu/protocol";

export type ArtifactActionRunStatus = "queued" | "running" | "succeeded" | "failed" | "stopped";

export type ArtifactActionRunSource = {
  moveId?: string;
  commit: string;
  ref: string;
};

export type ArtifactActionAliasRecord = {
  alias: string;
  service?: string;
  containerPort?: number;
  healthPath?: string;
  target?: string;
  internalUrl?: string;
  externalPath: string;
  directUrl?: string;
};

export type ArtifactActionRunRecord = {
  runId: string;
  actionId: string;
  roadmapId?: string;
  action: ArtifactActionDefinition;
  source: ArtifactActionRunSource;
  status: ArtifactActionRunStatus;
  sourceWorktree?: {
    path: string;
    commit: string;
    createdAt: string;
    removedAt?: string;
  };
  env: Record<string, string>;
  aliases?: Record<string, ArtifactActionAliasRecord>;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  createdAt: string;
  updatedAt: string;
  stoppedAt?: string;
  error?: string;
};

export type ArtifactActionRunInput = {
  cwd?: string;
  actionId: string;
  moveId?: string;
  commit?: string;
  roadmapId?: string;
  env?: Record<string, string>;
  ambientEnv?: Record<string, string | undefined>;
  processEnv?: Record<string, string | undefined>;
  worktreeRoot?: string;
  baseActionPath?: string;
  now?: string;
};

export type ArtifactActionRunPlan = {
  action: ArtifactActionDefinition;
  run: ArtifactActionRunRecord;
  commands: ArtifactActionCommand[];
};

export type ArtifactActionCommand = {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
};

export type ArtifactActionCommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string> }
) => { status: number; stdout: string; stderr: string };

export type ArtifactActionRunOptions = {
  runner?: ArtifactActionCommandRunner;
  store?: boolean;
  processEnv?: Record<string, string | undefined>;
};

type ResolvedActionSource = {
  source: ArtifactActionRunSource;
  actions: ArtifactActionDefinition[];
};

export function listArtifactActions(cwd = process.cwd(), moveId?: string): ArtifactActionDefinition[] {
  const root = ensureGitRepository(cwd);
  const store = loadDomainStore(root);
  if (moveId) {
    const move = store.board.moves.find(candidate => candidate.id === moveId);
    if (!move) {
      throw new Error(`No MOVE found for Artifact Action source: ${moveId}`);
    }
    const node = store.board.nodes.find(candidate => candidate.id === move.toNodeId);
    return cloneActions(move.snapshot?.artifactActions ?? node?.artifactActions ?? []);
  }
  return cloneActions(store.board.artifactActions);
}

export function planArtifactActionRun(input: ArtifactActionRunInput): ArtifactActionRunPlan {
  const root = ensureGitRepository(input.cwd ?? process.cwd());
  const resolved = resolveActionSource(root, input);
  const action = resolved.actions.find(candidate => candidate.id === input.actionId);
  if (!action) {
    throw new Error(`Unknown Artifact Action for selected source: ${input.actionId}`);
  }
  validateActionSourceScope(action, resolved.source);
  const now = input.now ?? new Date().toISOString();
  const runId = artifactActionRunId(action.id, resolved.source, now);
  const externalBase = input.baseActionPath ?? actionRunBasePath(input.roadmapId, runId);
  const aliases = action.kind === "host"
    ? aliasesForAction(action, externalBase)
    : undefined;
  const env = resolveActionEnv(action, input.env, input.ambientEnv);
  const run: ArtifactActionRunRecord = {
    runId,
    actionId: action.id,
    roadmapId: input.roadmapId,
    action: cloneAction(action),
    source: resolved.source,
    status: "queued",
    env: sanitizeEnvForStorage(action, env),
    aliases,
    createdAt: now,
    updatedAt: now
  };
  return {
    action: cloneAction(action),
    run,
    commands: actionCommands(root, action, run, env)
  };
}

export function startArtifactActionRun(input: ArtifactActionRunInput, options: ArtifactActionRunOptions = {}): ArtifactActionRunRecord {
  const root = ensureGitRepository(input.cwd ?? process.cwd());
  const plan = planArtifactActionRun(input);
  const now = input.now ?? new Date().toISOString();
  const sourceWorktree = createActionSourceWorktree(root, plan.run.runId, plan.run.source.commit, now, input.worktreeRoot);
  const processEnv = input.processEnv ?? options.processEnv;
  const runner = options.runner ?? ((command, args, commandOptions) => spawnCommand(command, args, { ...commandOptions, processEnv }));
  let run: ArtifactActionRunRecord = {
    ...plan.run,
    status: plan.action.kind === "host" ? "running" : "running",
    sourceWorktree,
    updatedAt: now
  };
  const resolvedEnv = resolveActionEnv(plan.action, input.env, input.ambientEnv);
  const commands = actionCommands(root, plan.action, run, resolvedEnv);
  try {
    if (plan.action.runner.type === "docker_compose") {
      runActionCommand(runner, commands[0]);
      runActionCommand(runner, commands[1]);
      run.aliases = attachDirectAliasUrls(root, run, runner, resolvedEnv);
      run.status = "running";
    } else {
      const result = runActionCommand(runner, commands[0]);
      run.exitCode = result.status;
      run.stdout = result.stdout;
      run.stderr = result.stderr;
      run.status = plan.action.kind === "host" ? "running" : "succeeded";
      if (plan.action.kind === "check") {
        const removed = removeActionSourceWorktree(root, sourceWorktree.path);
        run.sourceWorktree = { ...sourceWorktree, removedAt: removed };
      }
    }
    run.updatedAt = new Date().toISOString();
  } catch (error) {
    run.status = "failed";
    run.updatedAt = new Date().toISOString();
    run.error = error instanceof Error ? error.message : String(error);
    const removed = removeActionSourceWorktree(root, sourceWorktree.path);
    run.sourceWorktree = { ...sourceWorktree, removedAt: removed };
  }
  if (options.store !== false) {
    writeArtifactActionRun(root, run);
  }
  if (run.status === "failed") {
    throw new Error(run.error ?? `Artifact Action ${run.runId} failed`);
  }
  return run;
}

export function listArtifactActionRuns(cwd = process.cwd()): ArtifactActionRunRecord[] {
  const root = ensureGitRepository(cwd);
  const dir = actionRunStoreDir(root);
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter(file => file.endsWith(".json"))
    .map(file => readArtifactActionRun(root, file.slice(0, -".json".length)))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function readArtifactActionRun(cwd: string, runId: string): ArtifactActionRunRecord {
  const root = ensureGitRepository(cwd);
  const path = actionRunRecordPath(root, runId);
  if (!existsSync(path)) {
    throw new Error(`Unknown Artifact Action Run: ${runId}`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as ArtifactActionRunRecord;
}

export function stopArtifactActionRun(cwd: string, runId: string, options: ArtifactActionRunOptions = {}): ArtifactActionRunRecord {
  const root = ensureGitRepository(cwd);
  const run = readArtifactActionRun(root, runId);
  const runner = options.runner ?? ((command, args, commandOptions) => spawnCommand(command, args, { ...commandOptions, processEnv: options.processEnv }));
  const env = resolveActionEnv(run.action, run.env, options.processEnv);
  if (run.action.runner.type === "docker_compose") {
    runActionCommand(runner, composeCommand(root, run, ["down"], env));
  } else if (run.action.runner.stopCommand) {
    runActionCommand(runner, shellCommand(root, run, run.action.runner.stopCommand, env));
  }
  const removedAt = run.sourceWorktree?.path ? removeActionSourceWorktree(root, run.sourceWorktree.path) : undefined;
  const stopped: ArtifactActionRunRecord = {
    ...run,
    sourceWorktree: run.sourceWorktree ? { ...run.sourceWorktree, removedAt } : undefined,
    status: "stopped",
    stoppedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  if (options.store !== false) {
    writeArtifactActionRun(root, stopped);
  }
  return stopped;
}

function resolveActionSource(root: string, input: ArtifactActionRunInput): ResolvedActionSource {
  if (input.moveId && input.commit) {
    throw new Error("Artifact Action source accepts either moveId or commit, not both");
  }
  const store = loadDomainStore(root);
  if (input.moveId) {
    const move = store.board.moves.find(candidate => candidate.id === input.moveId);
    if (!move) {
      throw new Error(`No MOVE found for Artifact Action source: ${input.moveId}`);
    }
    const node = store.board.nodes.find(candidate => candidate.id === move.toNodeId);
    return {
      source: {
        moveId: move.id,
        commit: git(["rev-parse", "--verify", `${move.commit}^{commit}`], { cwd: root }).trim(),
        ref: move.commit
      },
      actions: cloneActions(move.snapshot?.artifactActions ?? node?.artifactActions ?? [])
    };
  }
  const ref = input.commit ?? "HEAD";
  return {
    source: {
      commit: git(["rev-parse", "--verify", `${ref}^{commit}`], { cwd: root }).trim(),
      ref
    },
    actions: cloneActions(store.board.artifactActions)
  };
}

function validateActionSourceScope(action: ArtifactActionDefinition, source: ArtifactActionRunSource): void {
  if (action.sourceScope === "move" && !source.moveId) {
    throw new Error(`Artifact Action ${action.id} can only run against a MOVE source`);
  }
  if (action.sourceScope === "commit" && source.moveId) {
    throw new Error(`Artifact Action ${action.id} can only run against a commit source`);
  }
}

function resolveActionEnv(
  action: ArtifactActionDefinition,
  overrides: Record<string, string> = {},
  ambientEnv: Record<string, string | undefined> = {}
): Record<string, string> {
  const env: Record<string, string> = {};
  const declared = new Set<string>();
  for (const [name, spec] of Object.entries(action.env ?? {})) {
    declared.add(name);
    if ("default" in spec) {
      env[name] = overrides[name] ?? String(spec.default);
    } else if ("value" in spec) {
      env[name] = overrides[name] ?? String(spec.value);
    } else if ("alias" in spec) {
      const alias = action.aliases?.[spec.alias];
      if (!alias) {
        throw new Error(`Artifact Action env ${name} references unknown alias: ${spec.alias}`);
      }
      env[name] = String(alias.containerPort ?? alias.target ?? "");
    } else if ("fromAliasUrl" in spec) {
      const alias = action.aliases?.[spec.fromAliasUrl];
      if (!alias) {
        throw new Error(`Artifact Action env ${name} references unknown alias: ${spec.fromAliasUrl}`);
      }
      env[name] = alias.service && alias.containerPort ? `http://${alias.service}:${alias.containerPort}` : String(alias.target ?? "");
    } else if (spec.required) {
      const value = overrides[name] ?? ambientEnv[name];
      if (!value) {
        throw new Error(`Artifact Action env ${name} is required but not set`);
      }
      env[name] = value;
    }
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (!declared.has(name)) {
      env[name] = value;
    }
  }
  return env;
}

function sanitizeEnvForStorage(action: ArtifactActionDefinition, env: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    const spec = action.env?.[name];
    sanitized[name] = spec && "required" in spec && spec.secret ? "<secret>" : value;
  }
  return sanitized;
}

function actionCommands(root: string, action: ArtifactActionDefinition, run: ArtifactActionRunRecord, env: Record<string, string>): ArtifactActionCommand[] {
  if (action.runner.type === "docker_compose") {
    return [
      composeCommand(root, run, ["build"], env),
      composeCommand(root, run, ["up", "-d"], env)
    ];
  }
  return [shellCommand(root, run, action.runner.command, env)];
}

function composeCommand(root: string, run: ArtifactActionRunRecord, args: string[], env: Record<string, string>): ArtifactActionCommand {
  if (run.action.runner.type !== "docker_compose") {
    throw new Error(`Artifact Action ${run.actionId} does not use docker compose`);
  }
  const shortCommit = run.source.commit.slice(0, 12);
  const projectName = sanitizeProjectName(expandTemplate(run.action.runner.projectName ?? `hunsu-${run.actionId}-${shortCommit}`, {
    actionId: run.actionId,
    runId: run.runId,
    commit: run.source.commit,
    shortCommit,
    moveId: run.source.moveId ?? ""
  }));
  return {
    command: "docker",
    args: ["compose", "-f", resolve(run.sourceWorktree?.path ?? root, run.action.runner.file), "-p", projectName, ...args],
    cwd: run.sourceWorktree?.path ?? root,
    env
  };
}

function shellCommand(root: string, run: ArtifactActionRunRecord, command: string, env: Record<string, string>): ArtifactActionCommand {
  return {
    command: "sh",
    args: ["-lc", command],
    cwd: run.sourceWorktree?.path ?? root,
    env
  };
}

function runActionCommand(runner: ArtifactActionCommandRunner, command: ArtifactActionCommand): { status: number; stdout: string; stderr: string } {
  const result = runner(command.command, command.args, { cwd: command.cwd, env: command.env });
  if (result.status !== 0) {
    throw new Error(`${command.command} ${command.args.join(" ")} failed\n${result.stderr || result.stdout}`);
  }
  return result;
}

function aliasesForAction(action: ArtifactActionDefinition, externalBase: string): Record<string, ArtifactActionAliasRecord> | undefined {
  if (!action.aliases) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(action.aliases).map(([alias, value]) => [
    alias,
    {
      alias,
      service: value.service,
      containerPort: value.containerPort,
      healthPath: value.healthPath,
      target: value.target,
      internalUrl: value.service && value.containerPort ? `http://${value.service}:${value.containerPort}` : value.target,
      externalPath: `${externalBase}/${encodeURIComponent(alias)}/`
    }
  ]));
}

function attachDirectAliasUrls(root: string, run: ArtifactActionRunRecord, runner: ArtifactActionCommandRunner, env: Record<string, string>): Record<string, ArtifactActionAliasRecord> | undefined {
  if (!run.aliases || run.action.runner.type !== "docker_compose") {
    return run.aliases;
  }
  const runnerDefinition = run.action.runner;
  return Object.fromEntries(Object.entries(run.aliases).map(([alias, value]) => {
    if (!value.service || !value.containerPort) {
      return [alias, value];
    }
    const result = runner("docker", ["compose", "-f", resolve(run.sourceWorktree?.path ?? root, runnerDefinition.file), "-p", sanitizeProjectName(expandTemplate(runnerDefinition.projectName ?? `hunsu-${run.actionId}-${run.source.commit.slice(0, 12)}`, {
      actionId: run.actionId,
      runId: run.runId,
      commit: run.source.commit,
      shortCommit: run.source.commit.slice(0, 12),
      moveId: run.source.moveId ?? ""
    })), "port", value.service, String(value.containerPort)], {
      cwd: run.sourceWorktree?.path ?? root,
      env
    });
    if (result.status !== 0 || !result.stdout.trim()) {
      return [alias, value];
    }
    return [alias, { ...value, directUrl: formatDirectUrl(result.stdout.trim()) }];
  }));
}

function createActionSourceWorktree(root: string, runId: string, commit: string, createdAt: string, requestedWorktreeRoot?: string): NonNullable<ArtifactActionRunRecord["sourceWorktree"]> {
  const worktreeRoot = resolve(requestedWorktreeRoot ?? join(tmpdir(), "hunsu-action-runs", `${basename(root)}-${hashPath(root)}`));
  const path = join(worktreeRoot, sanitizeRunId(runId));
  mkdirSync(worktreeRoot, { recursive: true });
  if (existsSync(path)) {
    removeActionSourceWorktree(root, path);
    rmSync(path, { recursive: true, force: true });
  }
  git(["worktree", "add", "--detach", path, commit], { cwd: root });
  return { path, commit, createdAt };
}

function removeActionSourceWorktree(root: string, path: string): string {
  const removedAt = new Date().toISOString();
  if (!existsSync(path)) {
    return removedAt;
  }
  try {
    git(["worktree", "remove", "--force", path], { cwd: root });
  } catch (_error) {
    rmSync(path, { recursive: true, force: true });
    git(["worktree", "prune"], { cwd: root });
  }
  return removedAt;
}

function writeArtifactActionRun(root: string, run: ArtifactActionRunRecord): void {
  mkdirSync(actionRunStoreDir(root), { recursive: true });
  writeFileSync(actionRunRecordPath(root, run.runId), `${JSON.stringify(run, null, 2)}\n`, "utf8");
}

function actionRunStoreDir(root: string): string {
  return join(root, ".hunsu", "action-runs");
}

function actionRunRecordPath(root: string, runId: string): string {
  return join(actionRunStoreDir(root), `${sanitizeRunId(runId)}.json`);
}

function actionRunBasePath(roadmapId: string | undefined, runId: string): string {
  return roadmapId
    ? `/api/roadmaps/${encodeURIComponent(roadmapId)}/action-runs/${encodeURIComponent(runId)}/proxy`
    : `/api/action-runs/${encodeURIComponent(runId)}/proxy`;
}

function artifactActionRunId(actionId: string, source: ArtifactActionRunSource, now: string): string {
  return sanitizeRunId(`${actionId}-${source.moveId ?? source.commit.slice(0, 12)}-${now.replace(/[^0-9A-Za-z]/g, "").slice(0, 14)}`);
}

function sanitizeRunId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "action-run";
}

function sanitizeProjectName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63) || "hunsu-action";
}

function expandTemplate(value: string, variables: Record<string, string>): string {
  return value.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (_, key: string) => variables[key] ?? "");
}

function hashPath(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 12);
}

function formatDirectUrl(output: string): string {
  const line = output.split(/\r?\n/).find(Boolean) ?? output;
  const match = line.match(/(?:0\.0\.0\.0|127\.0\.0\.1|localhost|\[::\]|::):(\d+)$/);
  if (match) {
    return `http://127.0.0.1:${match[1]}`;
  }
  if (/^https?:\/\//.test(line)) {
    return line;
  }
  return `http://${line}`;
}

function spawnCommand(command: string, args: string[], options: { cwd: string; env: Record<string, string>; processEnv?: Record<string, string | undefined> }): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...filterProcessEnv(options.processEnv), ...options.env },
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function filterProcessEnv(env: Record<string, string | undefined> | undefined): Record<string, string> | undefined {
  if (env === undefined) {
    return undefined;
  }
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      next[key] = value;
    }
  }
  return next;
}

function cloneActions(actions: ArtifactActionDefinition[]): ArtifactActionDefinition[] {
  return actions.map(cloneAction).sort((left, right) => left.displayOrder - right.displayOrder || String(left.id).localeCompare(String(right.id)));
}

function cloneAction(action: ArtifactActionDefinition): ArtifactActionDefinition {
  return {
    ...action,
    env: action.env ? Object.fromEntries(Object.entries(action.env).map(([key, value]) => [key, { ...value }])) : undefined,
    runner: { ...action.runner },
    aliases: action.aliases ? Object.fromEntries(Object.entries(action.aliases).map(([key, value]) => [key, { ...value }])) : undefined,
    evidence: action.evidence ? { ...action.evidence, paths: action.evidence.paths?.slice() } : undefined
  };
}
