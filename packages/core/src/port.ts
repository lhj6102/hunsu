import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { type Command, type DestinationSeedInput, type HarnessSnapshot } from "@hunsu/protocol";
import { hasHunsuRuntimeState, loadDomainStore, readDomainEventRefs, writeCommands } from "./domain-store.ts";
import { GitError } from "./errors.ts";
import { ensureGitRepository, git } from "./git.ts";

export type HunsuPortInspection = {
  root: string;
  isGitRepository: boolean;
  isHunsuRoadmap: boolean;
  packageManager?: "pnpm" | "npm" | "yarn" | "bun";
  packageScripts: Record<string, string>;
  docker: {
    dockerfiles: string[];
    composeFiles: string[];
  };
  artifactActions: {
    configured: boolean;
    count: number;
    issues: string[];
  };
  env: {
    files: string[];
    hardcodedHints: string[];
  };
  recommendedFiles: HunsuPortFilePlan[];
  issues: string[];
};

export type HunsuPortFilePlan = {
  path: string;
  action: "create";
  reason: string;
  content: string;
};

export type HunsuPortPlanInput = {
  cwd?: string;
  title?: string;
  goal?: string;
  destinations?: DestinationSeedInput[];
  harness?: HarnessSnapshot;
};

export type HunsuPortPlan = {
  root: string;
  title: string;
  goal: string;
  destinations: DestinationSeedInput[];
  inspection: HunsuPortInspection;
  files: HunsuPortFilePlan[];
  commands: Command[];
};

export type HunsuPortApplyResult = {
  root: string;
  plan: HunsuPortPlan;
  writtenFiles: string[];
  acceptedEvents: ReturnType<typeof writeCommands>["acceptedEvents"];
  board: ReturnType<typeof writeCommands>["board"];
};

type PackageJson = {
  scripts?: Record<string, string>;
  packageManager?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const DEFAULT_PORT_TITLE = "Port Git Project";
const DEFAULT_PORT_GOAL = "Make this project ready for Hunsu-managed MOVEs and Artifact Actions.";

export function inspectHunsuPort(cwd = process.cwd()): HunsuPortInspection {
  const target = resolve(cwd);
  const issues: string[] = [];
  let root = target;
  let isGitRepository = false;

  try {
    root = ensureGitRepository(target);
    isGitRepository = true;
  } catch (error) {
    issues.push("Not a Git repository. Hunsu Port expects an existing Git project.");
  }

  const packageJson = readPackageJson(root);
  const packageScripts = packageJson?.scripts ?? {};
  const packageManager = detectPackageManager(root, packageJson);
  const dockerfiles = listRootFiles(root, /^Dockerfile(?:\.|$)/);
  const composeFiles = listRootFiles(root, /^(?:docker-)?compose(?:\.[^.]+)?\.ya?ml$/);
  const isHunsuRoadmap = isGitRepository && hasHunsuStateOrLegacyRefs(root);
  const artifactActions = inspectArtifactActions(root);
  const env = inspectEnvHints(root, packageScripts);
  const recommendedFiles: HunsuPortFilePlan[] = [];

  if (!packageJson && isGitRepository) {
    issues.push("No package.json found. Port can still create Roadmap state, but Artifact Actions may need a later Hunsu setup.");
  }
  if (isGitRepository && !isHunsuRoadmap) {
    issues.push("Hunsu runtime state is missing. Port apply will create Initial Team state.");
  }

  return {
    root,
    isGitRepository,
    isHunsuRoadmap,
    packageManager,
    packageScripts,
    docker: {
      dockerfiles,
      composeFiles
    },
    artifactActions,
    env,
    recommendedFiles,
    issues
  };
}

export function planHunsuPort(input: HunsuPortPlanInput = {}): HunsuPortPlan {
  const inspection = inspectHunsuPort(input.cwd);
  if (!inspection.isGitRepository) {
    throw new Error("Hunsu Port requires an existing Git repository");
  }
  const title = input.title?.trim() || basename(inspection.root) || DEFAULT_PORT_TITLE;
  const goal = input.goal?.trim() || DEFAULT_PORT_GOAL;
  const destinations = input.destinations && input.destinations.length > 0
    ? input.destinations
    : [{ id: "destination_001", title: "Establish artifact-action-ready product execution", priority: 100 }];
  const commands: Command[] = inspection.isHunsuRoadmap
    ? []
    : [{
        type: "CreateInitialTeam",
        requestId: createId("req", title),
        lineId: `run/${createId("req", title)}`,
        title,
        goal,
        destinations,
        harness: input.harness
      }];
  return {
    root: inspection.root,
    title,
    goal,
    destinations,
    inspection,
    files: [],
    commands
  };
}

export function applyHunsuPort(input: HunsuPortPlanInput = {}): HunsuPortApplyResult {
  const plan = planHunsuPort(input);
  const writtenFiles: string[] = [];
  for (const file of plan.files) {
    const path = join(plan.root, file.path);
    if (existsSync(path)) {
      continue;
    }
    writeFileSync(path, file.content, "utf8");
    writtenFiles.push(file.path);
  }
  const result = plan.commands.length > 0
    ? writeCommands(plan.commands, { cwd: plan.root, commitMessage: `hunsu: port ${plan.title}` })
    : { acceptedEvents: [], board: loadDomainStore(plan.root).board };
  return {
    root: plan.root,
    plan,
    writtenFiles,
    acceptedEvents: result.acceptedEvents,
    board: result.board
  };
}

function inspectArtifactActions(root: string): HunsuPortInspection["artifactActions"] {
  if (!hasHunsuStateOrLegacyRefs(root)) {
    return {
      configured: false,
      count: 0,
      issues: []
    };
  }
  const board = loadDomainStore(root).board;
  return {
    configured: board.artifactActions.length > 0,
    count: board.artifactActions.length,
    issues: []
  };
}

function detectPackageManager(root: string, packageJson: PackageJson | undefined): HunsuPortInspection["packageManager"] {
  if (existsSync(join(root, "pnpm-lock.yaml")) || packageJson?.packageManager?.startsWith("pnpm@")) {
    return "pnpm";
  }
  if (existsSync(join(root, "yarn.lock")) || packageJson?.packageManager?.startsWith("yarn@")) {
    return "yarn";
  }
  if (existsSync(join(root, "bun.lockb")) || existsSync(join(root, "bun.lock")) || packageJson?.packageManager?.startsWith("bun@")) {
    return "bun";
  }
  if (existsSync(join(root, "package-lock.json")) || packageJson) {
    return "npm";
  }
  return undefined;
}

function readPackageJson(root: string): PackageJson | undefined {
  const path = join(root, "package.json");
  if (!existsSync(path)) {
    return undefined;
  }
  return JSON.parse(readFileSync(path, "utf8")) as PackageJson;
}

function listRootFiles(root: string, pattern: RegExp): string[] {
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return [];
  }
  return readdirSync(root)
    .filter(file => pattern.test(file))
    .sort();
}

function hasHunsuStateOrLegacyRefs(root: string): boolean {
  try {
    return hasHunsuRuntimeState(root)
      || readDomainEventRefs(root).length > 0
      || git(["for-each-ref", "--count=1", "--format=%(refname)", "refs/hunsu"], { cwd: root }).trim().length > 0;
  } catch (error) {
    if (error instanceof GitError) {
      return false;
    }
    throw error;
  }
}

function inspectEnvHints(root: string, scripts: Record<string, string>): HunsuPortInspection["env"] {
  const files = [".env", ".env.local", ".env.development", ".env.example"].filter(file => existsSync(join(root, file)));
  const hardcodedHints = Object.entries(scripts)
    .filter(([, script]) => /\b(?:3000|5173|8080|4187)\b|localhost|127\.0\.0\.1/.test(script))
    .map(([name]) => `package.json scripts.${name}`);
  for (const file of ["vite.config.ts", "vite.config.js", "next.config.js", "next.config.mjs"]) {
    const path = join(root, file);
    if (!existsSync(path)) {
      continue;
    }
    const text = readFileSync(path, "utf8");
    if (/\b(?:3000|5173|8080|4187)\b|localhost|127\.0\.0\.1/.test(text)) {
      hardcodedHints.push(file);
    }
  }
  return { files, hardcodedHints };
}

function createId(prefix: string, value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return `${prefix}_${slug || "project"}`;
}
