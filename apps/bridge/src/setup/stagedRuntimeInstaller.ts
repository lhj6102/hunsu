import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink
} from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, win32 } from "node:path";
import { isWindowsPowerShellCommand, windowsPowerShellEnvironment } from "../windowsPowerShell.ts";
import type { HunsuPaths } from "../state/paths.ts";
import type {
  RuntimeInstallation,
  VerifiedRuntimeInstallation
} from "./runtimeInstaller.ts";
import {
  executingBridgeRuntimeSource,
  runtimePackageName,
  runtimePackageSpec,
  runtimePackageVersion,
  validateRuntimePackageSource,
  type RuntimePackageSource
} from "./runtimePackageSource.ts";

export type StagedRuntimeCommand = {
  command: string;
  args: string[];
};

export type StagedRuntimeCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type StagedRuntimeCommandRunner = (
  command: StagedRuntimeCommand
) => Promise<StagedRuntimeCommandResult>;

export type StagedRuntimeFileSystem = {
  lstat(path: string): Promise<Stats | undefined>;
  realpath(path: string): Promise<string>;
  readdir(path: string): Promise<string[]>;
  mkdir(path: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  readFile(path: string): Promise<Buffer>;
};

export type StagedRuntimePlan = {
  source: RuntimePackageSource;
  packageName: "@hunsu/bridge";
  packageVersion: string;
  packageSpec: string;
  transactionId: string;
  home: string;
  runtimeDirectory: string;
  stagingRoot: string;
  stagingPath: string;
  stagingCliPath: string;
  stagingManifestPath: string;
  runtimeVersionsDirectory: string;
  runtimePath: string;
  quarantinePath: string;
  cliPath: string;
  manifestPath: string;
  nodePath: string;
  npmCommand: StagedRuntimeCommand;
};

export type StagedRuntimeInstallResult = {
  installation: VerifiedRuntimeInstallation;
  reused: boolean;
};

export class StagedRuntimeInstallError extends Error {
  readonly code = "RUNTIME_INSTALL_FAILED" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StagedRuntimeInstallError";
  }
}

export class StagedRuntimeCleanupError extends Error {
  readonly code = "ROLLBACK_FAILED" as const;

  constructor(message = "The failed staged runtime could not be restored or removed safely.", options?: ErrorOptions) {
    super(message, options);
    this.name = "StagedRuntimeCleanupError";
  }
}

export const defaultStagedRuntimeFileSystem: StagedRuntimeFileSystem = {
  async lstat(path) {
    try {
      return await lstat(path);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
  },
  realpath,
  readdir,
  async mkdir(path) {
    await mkdir(path, { recursive: true, mode: 0o700 });
  },
  unlink,
  rmdir,
  rename,
  readFile
};

export const createDefaultStagedRuntimeCommandRunner = (
  processEnv: Readonly<Record<string, string | undefined>> = {}
): StagedRuntimeCommandRunner => command => new Promise(resolveResult => {
  execFile(command.command, command.args, {
    encoding: "utf8",
    ...(isWindowsPowerShellCommand(command.command)
      ? { env: windowsPowerShellEnvironment(processEnv) }
      : {}),
    windowsHide: true,
    maxBuffer: 1024 * 1024
  }, (error, stdout, stderr) => {
    resolveResult({
      exitCode: error && "code" in error && typeof error.code === "number" ? error.code : error ? 1 : 0,
      stdout: stdout ?? "",
      stderr: stderr ?? (error instanceof Error ? error.message : "")
    });
  });
});

export const defaultStagedRuntimeCommandRunner = createDefaultStagedRuntimeCommandRunner();

export function planStagedRuntimeInstall(input: {
  paths: HunsuPaths;
  transactionId: string;
  nodePath: string;
  source?: RuntimePackageSource;
  npmCommand?: string;
  platform?: NodeJS.Platform;
}): StagedRuntimePlan {
  const platform = input.platform ?? process.platform;
  const path = platform === "win32" ? win32 : posix;
  const absolute = platform === "win32" ? win32.isAbsolute : isAbsolute;
  if (!absolute(input.nodePath) || containsControlCharacter(input.nodePath)) {
    throw new StagedRuntimeInstallError("The Node executable path must be absolute.");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(input.transactionId)) {
    throw new StagedRuntimeInstallError("The setup transaction id is invalid.");
  }
  const source = validateRuntimePackageSource(input.source ?? executingBridgeRuntimeSource());
  const packageVersion = runtimePackageVersion(source);
  const stagingRoot = input.paths.runtimeStagingDirectory;
  const stagingPath = path.join(stagingRoot, input.transactionId);
  const runtimePath = path.join(input.paths.runtimeVersionsDirectory, packageVersion);
  const quarantinePath = path.join(input.paths.runtimeVersionsDirectory, `.${packageVersion}.previous`);
  const packageSegments = ["node_modules", "@hunsu", "bridge"];
  const stagingPackagePath = path.join(stagingPath, ...packageSegments);
  const runtimePackagePath = path.join(runtimePath, ...packageSegments);
  const npmArgs = [
    "install",
    "--ignore-scripts",
    "--omit=dev",
    "--no-audit",
    "--no-fund",
    "--prefix",
    stagingPath,
    runtimePackageSpec(source)
  ];
  return {
    source,
    packageName: runtimePackageName(source),
    packageVersion,
    packageSpec: runtimePackageSpec(source),
    transactionId: input.transactionId,
    home: input.paths.home,
    runtimeDirectory: input.paths.runtimeDirectory,
    stagingRoot,
    stagingPath,
    stagingCliPath: path.join(stagingPackagePath, "dist", "cli.js"),
    stagingManifestPath: path.join(stagingPackagePath, "package.json"),
    runtimeVersionsDirectory: input.paths.runtimeVersionsDirectory,
    runtimePath,
    quarantinePath,
    cliPath: path.join(runtimePackagePath, "dist", "cli.js"),
    manifestPath: path.join(runtimePackagePath, "package.json"),
    nodePath: input.nodePath,
    npmCommand: platform === "win32"
      ? windowsNpmCommand(input.npmCommand ?? "npm.cmd", npmArgs)
      : { command: input.npmCommand ?? "npm", args: npmArgs }
  };
}

export async function installStagedRuntime(input: {
  plan: StagedRuntimePlan;
  commandRunner?: StagedRuntimeCommandRunner;
  processEnv?: Readonly<Record<string, string | undefined>>;
  fileSystem?: StagedRuntimeFileSystem;
  now?: () => Date;
  nodeVersion?: string;
  protectedRuntimePath?: string;
  onPhase?: (phase: "npm-install" | "candidate-verification" | "staging-rename") => void | Promise<void>;
}): Promise<StagedRuntimeInstallResult> {
  const fileSystem = input.fileSystem ?? defaultStagedRuntimeFileSystem;
  const commandRunner = input.commandRunner ?? createDefaultStagedRuntimeCommandRunner(input.processEnv ?? {});
  const now = input.now ?? (() => new Date());
  const canonicalHome = await ensureSafeRuntimeRoots(input.plan, fileSystem);
  await recoverQuarantine(input.plan, fileSystem, canonicalHome, input.nodeVersion ?? process.version);
  await removeOwnedDirectory(input.plan.stagingRoot, input.plan.stagingPath, fileSystem, canonicalHome);
  await fileSystem.mkdir(input.plan.stagingPath);
  let quarantined = false;
  try {
    await assertSafeDirectory(input.plan.stagingPath, canonicalHome, fileSystem);
    await input.onPhase?.("npm-install");
    const result = await commandRunner(input.plan.npmCommand);
    if (result.exitCode !== 0) {
      throw new StagedRuntimeInstallError("npm could not install the exact Hunsu Bridge runtime package.");
    }
    await input.onPhase?.("candidate-verification");
    const staged = await verifyRuntimePackage({
      root: input.plan.stagingPath,
      manifestPath: input.plan.stagingManifestPath,
      cliPath: input.plan.stagingCliPath,
      expectedName: input.plan.packageName,
      expectedVersion: input.plan.packageVersion,
      fileSystem,
      canonicalHome,
      nodeVersion: input.nodeVersion ?? process.version
    });

    if (await fileSystem.lstat(input.plan.runtimePath)) {
      let existing: { cliSha256: string } | undefined;
      try {
        existing = await verifyRuntimePackage({
          root: input.plan.runtimePath,
          manifestPath: input.plan.manifestPath,
          cliPath: input.plan.cliPath,
          expectedName: input.plan.packageName,
          expectedVersion: input.plan.packageVersion,
          fileSystem,
          canonicalHome,
          nodeVersion: input.nodeVersion ?? process.version
        });
      } catch (error) {
        if (samePath(input.protectedRuntimePath, input.plan.runtimePath)) {
          throw new StagedRuntimeInstallError(
            "The currently recorded runtime is incomplete or invalid; preserve it and run offline repair before retrying setup.",
            { cause: error }
          );
        }
      }
      if (existing?.cliSha256 === staged.cliSha256) {
        await removeOwnedDirectory(input.plan.stagingRoot, input.plan.stagingPath, fileSystem, canonicalHome);
        return {
          installation: installationFromPlan(input.plan, existing.cliSha256, now),
          reused: true
        };
      }
      await assertSafeDirectory(input.plan.runtimePath, canonicalHome, fileSystem);
      await fileSystem.rename(input.plan.runtimePath, input.plan.quarantinePath);
      quarantined = true;
    }

    try {
      await input.onPhase?.("staging-rename");
      await fileSystem.rename(input.plan.stagingPath, input.plan.runtimePath);
    } catch (error) {
      if (quarantined) {
        try {
          await fileSystem.rename(input.plan.quarantinePath, input.plan.runtimePath);
          quarantined = false;
        } catch (restoreError) {
          throw new StagedRuntimeCleanupError(
            "The staged runtime activation failed and the previous version directory could not be restored.",
            { cause: restoreError }
          );
        }
      }
      throw error;
    }

    if (quarantined) {
      try {
        await removeOwnedDirectory(
          input.plan.runtimeVersionsDirectory,
          input.plan.quarantinePath,
          fileSystem,
          canonicalHome
        );
      } catch (error) {
        try {
          await removeOwnedDirectory(
            input.plan.runtimeVersionsDirectory,
            input.plan.runtimePath,
            fileSystem,
            canonicalHome
          );
          await fileSystem.rename(input.plan.quarantinePath, input.plan.runtimePath);
        } catch (restoreError) {
          throw new StagedRuntimeCleanupError(
            "The replacement runtime could not be committed or rolled back safely.",
            { cause: restoreError }
          );
        }
        throw new StagedRuntimeCleanupError("The replacement runtime could not remove its quarantine directory.", { cause: error });
      }
    }
    return {
      installation: installationFromPlan(input.plan, staged.cliSha256, now),
      reused: false
    };
  } catch (error) {
    try {
      await removeOwnedDirectory(input.plan.stagingRoot, input.plan.stagingPath, fileSystem, canonicalHome);
    } catch (cleanupError) {
      throw new StagedRuntimeCleanupError(
        "The failed staged runtime could not be removed; remove the runtime staging directory before retrying setup.",
        { cause: cleanupError }
      );
    }
    if (error instanceof StagedRuntimeInstallError || error instanceof StagedRuntimeCleanupError) throw error;
    throw new StagedRuntimeInstallError("The staged Hunsu Bridge runtime could not be verified and activated.", { cause: error });
  }
}

export async function removeCandidateRuntime(input: {
  paths: HunsuPaths;
  installation: RuntimeInstallation;
  previous: RuntimeInstallation | null;
  fileSystem?: StagedRuntimeFileSystem;
}): Promise<{ removed: boolean }> {
  if (input.previous && samePath(input.previous.runtimePath, input.installation.runtimePath)) {
    return { removed: false };
  }
  const fileSystem = input.fileSystem ?? defaultStagedRuntimeFileSystem;
  const plan = planStagedRuntimeInstall({
    paths: input.paths,
    transactionId: "candidate-cleanup",
    nodePath: input.installation.nodePath,
    source: {
      kind: "registry-exact",
      packageName: "@hunsu/bridge",
      version: input.installation.packageVersion
    }
  });
  const canonicalHome = await ensureSafeRuntimeRoots(plan, fileSystem);
  if (!samePath(plan.runtimePath, input.installation.runtimePath)) {
    throw new StagedRuntimeCleanupError("The candidate runtime path is not the exact owned version directory.");
  }
  await removeOwnedDirectory(plan.runtimeVersionsDirectory, plan.runtimePath, fileSystem, canonicalHome);
  return { removed: true };
}

export async function verifyExistingStableRuntime(input: {
  plan: StagedRuntimePlan;
  fileSystem?: StagedRuntimeFileSystem;
  nodeVersion?: string;
}): Promise<{ cliSha256: string }> {
  const fileSystem = input.fileSystem ?? defaultStagedRuntimeFileSystem;
  const canonicalHome = await ensureSafeRuntimeRoots(input.plan, fileSystem);
  await recoverQuarantine(input.plan, fileSystem, canonicalHome, input.nodeVersion ?? process.version);
  return verifyRuntimePackage({
    root: input.plan.runtimePath,
    manifestPath: input.plan.manifestPath,
    cliPath: input.plan.cliPath,
    expectedName: input.plan.packageName,
    expectedVersion: input.plan.packageVersion,
    fileSystem,
    canonicalHome,
    nodeVersion: input.nodeVersion ?? process.version
  });
}

export function windowsNpmCommand(executable: string, args: readonly string[]): StagedRuntimeCommand {
  if (!executable.trim() || containsControlCharacter(executable)) {
    throw new StagedRuntimeInstallError("The npm command is invalid.");
  }
  const array = args.map(powerShellLiteral).join(", ");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$npm = ${powerShellLiteral(executable)}`,
    `$arguments = @(${array})`,
    "& $npm @arguments",
    "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }"
  ].join("\n");
  return {
    command: "powershell.exe",
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64")
    ]
  };
}

async function ensureSafeRuntimeRoots(
  plan: StagedRuntimePlan,
  fileSystem: StagedRuntimeFileSystem
): Promise<string> {
  const homeStats = await fileSystem.lstat(plan.home);
  if (!homeStats?.isDirectory() || homeStats.isSymbolicLink()) {
    throw new StagedRuntimeInstallError("The configured Hunsu home has an unsafe filesystem type.");
  }
  const canonicalHome = resolve(await fileSystem.realpath(plan.home));
  for (const path of [plan.runtimeDirectory, plan.stagingRoot, plan.runtimeVersionsDirectory]) {
    if (!await fileSystem.lstat(path)) await fileSystem.mkdir(path);
    await assertSafeDirectory(path, canonicalHome, fileSystem);
  }
  assertLexicalContainment(plan.stagingRoot, plan.stagingPath);
  assertLexicalContainment(plan.runtimeVersionsDirectory, plan.runtimePath);
  assertLexicalContainment(plan.runtimeVersionsDirectory, plan.quarantinePath);
  return canonicalHome;
}

async function recoverQuarantine(
  plan: StagedRuntimePlan,
  fileSystem: StagedRuntimeFileSystem,
  canonicalHome: string,
  nodeVersion: string
): Promise<void> {
  if (!await fileSystem.lstat(plan.quarantinePath)) return;
  await assertSafeDirectory(plan.quarantinePath, canonicalHome, fileSystem);
  if (!await fileSystem.lstat(plan.runtimePath)) {
    await fileSystem.rename(plan.quarantinePath, plan.runtimePath);
    return;
  }
  let finalIsValid = false;
  try {
    await verifyRuntimePackage({
      root: plan.runtimePath,
      manifestPath: plan.manifestPath,
      cliPath: plan.cliPath,
      expectedName: plan.packageName,
      expectedVersion: plan.packageVersion,
      fileSystem,
      canonicalHome,
      nodeVersion
    });
    finalIsValid = true;
  } catch (_error) {
    finalIsValid = false;
  }
  if (finalIsValid) {
    await removeOwnedDirectory(plan.runtimeVersionsDirectory, plan.quarantinePath, fileSystem, canonicalHome);
    return;
  }
  await removeOwnedDirectory(plan.runtimeVersionsDirectory, plan.runtimePath, fileSystem, canonicalHome);
  await fileSystem.rename(plan.quarantinePath, plan.runtimePath);
}

async function verifyRuntimePackage(input: {
  root: string;
  manifestPath: string;
  cliPath: string;
  expectedName: "@hunsu/bridge";
  expectedVersion: string;
  fileSystem: StagedRuntimeFileSystem;
  canonicalHome: string;
  nodeVersion: string;
}): Promise<{ cliSha256: string }> {
  await assertSafeDirectory(input.root, input.canonicalHome, input.fileSystem);
  await assertRegularContainedFile(input.manifestPath, input.root, input.canonicalHome, input.fileSystem);
  await assertRegularContainedFile(input.cliPath, input.root, input.canonicalHome, input.fileSystem);
  const manifestBytes = await input.fileSystem.readFile(input.manifestPath);
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch (error) {
    throw new StagedRuntimeInstallError("The installed runtime package manifest is invalid.", { cause: error });
  }
  if (!isRecord(manifest)
    || manifest.name !== input.expectedName
    || manifest.version !== input.expectedVersion) {
    throw new StagedRuntimeInstallError("The installed runtime package name or exact version does not match the candidate.");
  }
  const engine = isRecord(manifest.engines) && typeof manifest.engines.node === "string"
    ? manifest.engines.node
    : undefined;
  if (!engine || !nodeSatisfiesBridgeEngine(input.nodeVersion, engine)) {
    throw new StagedRuntimeInstallError("The installed runtime package has an unsupported Node engine contract.");
  }
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
    const dependencies = manifest[field];
    if (dependencies === undefined) continue;
    if (!isRecord(dependencies)) {
      throw new StagedRuntimeInstallError("The installed runtime dependency contract is invalid.");
    }
    for (const specifier of Object.values(dependencies)) {
      if (typeof specifier !== "string" || /^(?:workspace:|link:|file:)/u.test(specifier)) {
        throw new StagedRuntimeInstallError("The installed runtime contains an unresolved workspace dependency.");
      }
    }
  }
  const cliBytes = await input.fileSystem.readFile(input.cliPath);
  if (cliBytes.byteLength === 0) throw new StagedRuntimeInstallError("The installed runtime CLI is empty.");
  return { cliSha256: createHash("sha256").update(cliBytes).digest("hex") };
}

async function assertRegularContainedFile(
  path: string,
  root: string,
  canonicalHome: string,
  fileSystem: StagedRuntimeFileSystem
): Promise<void> {
  assertLexicalContainment(root, path);
  const stats = await fileSystem.lstat(path);
  if (!stats?.isFile() || stats.isSymbolicLink()) {
    throw new StagedRuntimeInstallError("The installed runtime contains an unsafe manifest or CLI filesystem type.");
  }
  const canonical = resolve(await fileSystem.realpath(path));
  if (!isContained(canonicalHome, canonical, false) || !isContained(resolve(await fileSystem.realpath(root)), canonical, false)) {
    throw new StagedRuntimeInstallError("The installed runtime manifest or CLI resolves outside its owned directory.");
  }
}

async function assertSafeDirectory(
  path: string,
  canonicalHome: string,
  fileSystem: StagedRuntimeFileSystem
): Promise<void> {
  const stats = await fileSystem.lstat(path);
  if (!stats?.isDirectory() || stats.isSymbolicLink()) {
    throw new StagedRuntimeInstallError("A runtime directory has an unsafe filesystem type.");
  }
  const canonical = resolve(await fileSystem.realpath(path));
  if (!isContained(canonicalHome, canonical, false)) {
    throw new StagedRuntimeInstallError("A runtime directory resolves outside the canonical Hunsu home.");
  }
}

async function removeOwnedDirectory(
  allowedRoot: string,
  target: string,
  fileSystem: StagedRuntimeFileSystem,
  canonicalHome: string
): Promise<void> {
  assertLexicalContainment(allowedRoot, target);
  const targetStats = await fileSystem.lstat(target);
  if (!targetStats) return;
  if (!targetStats.isDirectory() || targetStats.isSymbolicLink()) {
    throw new StagedRuntimeCleanupError("A runtime cleanup target has an unsafe filesystem type.");
  }
  await removeEntry(target, fileSystem, canonicalHome);
}

async function removeEntry(
  path: string,
  fileSystem: StagedRuntimeFileSystem,
  canonicalHome: string
): Promise<void> {
  const stats = await fileSystem.lstat(path);
  if (!stats) return;
  if (stats.isSymbolicLink()) {
    await fileSystem.unlink(path);
    return;
  }
  if (stats.isFile()) {
    const canonical = resolve(await fileSystem.realpath(path));
    if (!isContained(canonicalHome, canonical, false)) {
      throw new StagedRuntimeCleanupError("A runtime file resolves outside the canonical Hunsu home.");
    }
    await fileSystem.unlink(path);
    return;
  }
  if (!stats.isDirectory()) {
    throw new StagedRuntimeCleanupError("A runtime cleanup entry has an unsupported filesystem type.");
  }
  await assertSafeDirectory(path, canonicalHome, fileSystem);
  for (const child of await fileSystem.readdir(path)) {
    if (!child || child === "." || child === ".." || child.includes("/") || child.includes("\\")) {
      throw new StagedRuntimeCleanupError("A runtime directory contains an invalid entry name.");
    }
    await removeEntry(posixOrWinJoin(path, child), fileSystem, canonicalHome);
  }
  await assertSafeDirectory(path, canonicalHome, fileSystem);
  await fileSystem.rmdir(path);
}

function installationFromPlan(
  plan: StagedRuntimePlan,
  cliSha256: string,
  now: () => Date
): VerifiedRuntimeInstallation {
  return {
    packageVersion: plan.packageVersion,
    runtimePath: plan.runtimePath,
    nodePath: plan.nodePath,
    cliPath: plan.cliPath,
    cliSha256,
    installedAt: now().toISOString()
  };
}

function nodeSatisfiesBridgeEngine(version: string, engine: string): boolean {
  const versionMatch = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/u);
  const engineMatch = engine.trim().match(/^>=(\d+)\.(\d+)(?:\.(\d+))?$/u);
  if (!versionMatch || !engineMatch) return false;
  const current = versionMatch.slice(1, 4).map(Number);
  const minimum = [Number(engineMatch[1]), Number(engineMatch[2]), Number(engineMatch[3] ?? 0)];
  for (let index = 0; index < current.length; index += 1) {
    if (current[index]! > minimum[index]!) return true;
    if (current[index]! < minimum[index]!) return false;
  }
  return true;
}

function powerShellLiteral(value: string): string {
  if (containsControlCharacter(value)) throw new StagedRuntimeInstallError("The npm command contains an unsafe value.");
  return `'${value.replaceAll("'", "''")}'`;
}

function assertLexicalContainment(parent: string, candidate: string): void {
  const child = relative(resolve(parent), resolve(candidate));
  if (!child || child.startsWith("..") || isAbsolute(child)) {
    throw new StagedRuntimeInstallError("The runtime path is outside its Hunsu-owned directory.");
  }
}

function isContained(parent: string, child: string, includeParent: boolean): boolean {
  const candidate = relative(resolve(parent), resolve(child));
  if (candidate === "") return includeParent;
  return !candidate.startsWith("..") && !isAbsolute(candidate);
}

function samePath(left: string | undefined, right: string): boolean {
  if (!left) return false;
  const resolvedLeft = resolve(left);
  const resolvedRight = resolve(right);
  return process.platform === "win32"
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

function posixOrWinJoin(parent: string, child: string): string {
  return parent.includes("\\") ? win32.join(parent, child) : posix.join(parent, child);
}

function containsControlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
