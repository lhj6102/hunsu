import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveHunsuPaths } from "../apps/bridge/src/state/paths.ts";
import { localBridgeTarballSource } from "../apps/bridge/src/setup/runtimePackageSource.ts";
import {
  StagedRuntimeCleanupError,
  defaultStagedRuntimeFileSystem,
  installStagedRuntime,
  planStagedRuntimeInstall,
  type StagedRuntimeCommand,
  type StagedRuntimeCommandRunner,
  type StagedRuntimeFileSystem
} from "../apps/bridge/src/setup/stagedRuntimeInstaller.ts";
import { HUNSU_BRIDGE_VERSION } from "../apps/bridge/src/version.ts";

test("runtime installation verifies a staged exact package before atomically activating its stable path", async () => {
  const home = await mkdtemp(join(tmpdir(), "hunsu-staged-runtime-"));
  const paths = resolveHunsuPaths({ home });
  const commands: StagedRuntimeCommand[] = [];
  const runner = packageRunner(commands);
  try {
    const plan = planStagedRuntimeInstall({
      paths,
      transactionId: "transaction-one",
      nodePath: process.execPath
    });
    const result = await installStagedRuntime({ plan, commandRunner: runner });
    assert.equal(result.reused, false);
    assert.equal(result.installation.packageVersion, HUNSU_BRIDGE_VERSION);
    assert.equal(result.installation.runtimePath, join(paths.runtimeVersionsDirectory, HUNSU_BRIDGE_VERSION));
    assert.equal(result.installation.cliPath, join(
      paths.runtimeVersionsDirectory,
      HUNSU_BRIDGE_VERSION,
      "node_modules",
      "@hunsu",
      "bridge",
      "dist",
      "cli.js"
    ));
    assert.match(result.installation.cliSha256, /^[a-f0-9]{64}$/u);
    await access(result.installation.cliPath);
    await assert.rejects(access(plan.stagingPath));
    assert.deepEqual(commands[0]?.args.slice(0, 7), [
      "install",
      "--ignore-scripts",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      "--prefix",
      plan.stagingPath
    ]);
    assert.equal(commands[0]?.args.at(-1), `@hunsu/bridge@${HUNSU_BRIDGE_VERSION}`);

    const secondPlan = planStagedRuntimeInstall({
      paths,
      transactionId: "transaction-two",
      nodePath: process.execPath
    });
    const second = await installStagedRuntime({ plan: secondPlan, commandRunner: runner });
    assert.equal(second.reused, true);
    assert.equal(second.installation.cliSha256, result.installation.cliSha256);
    await assert.rejects(access(secondPlan.stagingPath));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("runtime installation rejects wrong identity and unresolved workspace dependencies before activation", async () => {
  const home = await mkdtemp(join(tmpdir(), "hunsu-invalid-staged-runtime-"));
  const paths = resolveHunsuPaths({ home });
  try {
    const wrongVersion = planStagedRuntimeInstall({
      paths,
      transactionId: "wrong-version",
      nodePath: process.execPath
    });
    await assert.rejects(
      installStagedRuntime({
        plan: wrongVersion,
        commandRunner: packageRunner([], { version: "9.9.9" })
      }),
      /name or exact version/u
    );
    await assert.rejects(access(wrongVersion.runtimePath));
    await assert.rejects(access(wrongVersion.stagingPath));

    const workspaceDependency = planStagedRuntimeInstall({
      paths,
      transactionId: "workspace-dependency",
      nodePath: process.execPath
    });
    await assert.rejects(
      installStagedRuntime({
        plan: workspaceDependency,
        commandRunner: packageRunner([], { dependencies: { "@hunsu/core": "workspace:*" } })
      }),
      /unresolved workspace dependency/u
    );
    await assert.rejects(access(workspaceDependency.runtimePath));

    const badEngine = planStagedRuntimeInstall({
      paths,
      transactionId: "bad-engine",
      nodePath: process.execPath
    });
    await assert.rejects(
      installStagedRuntime({
        plan: badEngine,
        commandRunner: packageRunner([], { engine: ">=99.0" })
      }),
      /Node engine/u
    );

    const emptyCli = planStagedRuntimeInstall({
      paths,
      transactionId: "empty-cli",
      nodePath: process.execPath
    });
    await assert.rejects(
      installStagedRuntime({
        plan: emptyCli,
        commandRunner: packageRunner([], { cliText: "" })
      }),
      /CLI is empty/u
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("npm and cleanup failures leave no activated runtime and distinguish rollback failure", async () => {
  const home = await mkdtemp(join(tmpdir(), "hunsu-staged-failure-"));
  const paths = resolveHunsuPaths({ home });
  try {
    const npmFailure = planStagedRuntimeInstall({ paths, transactionId: "npm-failure", nodePath: process.execPath });
    await assert.rejects(
      installStagedRuntime({
        plan: npmFailure,
        commandRunner: async () => ({ exitCode: 1, stdout: "", stderr: "failed" })
      }),
      /npm could not install/u
    );
    await assert.rejects(access(npmFailure.stagingPath));
    await assert.rejects(access(npmFailure.runtimePath));

    const cleanupFailure = planStagedRuntimeInstall({ paths, transactionId: "cleanup-failure", nodePath: process.execPath });
    const fileSystem: StagedRuntimeFileSystem = {
      ...defaultStagedRuntimeFileSystem,
      async rmdir(path) {
        if (path === cleanupFailure.stagingPath) throw new Error("injected cleanup failure");
        await defaultStagedRuntimeFileSystem.rmdir(path);
      }
    };
    await assert.rejects(
      installStagedRuntime({
        plan: cleanupFailure,
        fileSystem,
        commandRunner: async () => ({ exitCode: 1, stdout: "", stderr: "failed" })
      }),
      error => error instanceof StagedRuntimeCleanupError && error.code === "ROLLBACK_FAILED"
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("failed replacement restores an existing same-version runtime before returning", async () => {
  const home = await mkdtemp(join(tmpdir(), "hunsu-staged-restore-"));
  const paths = resolveHunsuPaths({ home });
  const initialPlan = planStagedRuntimeInstall({ paths, transactionId: "initial", nodePath: process.execPath });
  try {
    await installStagedRuntime({
      plan: initialPlan,
      commandRunner: packageRunner([], { cliText: "old-cli\n" })
    });
    const replacement = planStagedRuntimeInstall({ paths, transactionId: "replacement", nodePath: process.execPath });
    const fileSystem: StagedRuntimeFileSystem = {
      ...defaultStagedRuntimeFileSystem,
      async rename(from, to) {
        if (from === replacement.stagingPath && to === replacement.runtimePath) {
          throw new Error("injected activation rename failure");
        }
        await rename(from, to);
      }
    };
    await assert.rejects(
      installStagedRuntime({
        plan: replacement,
        protectedRuntimePath: replacement.runtimePath,
        fileSystem,
        commandRunner: packageRunner([], { cliText: "new-cli\n" })
      }),
      /could not be verified and activated/u
    );
    assert.equal(await readFile(replacement.cliPath, "utf8"), "old-cli\n");
    await assert.rejects(access(replacement.quarantinePath));
    await assert.rejects(access(replacement.stagingPath));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("runtime staging refuses intermediate links and manifest or CLI links without touching targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunsu-staged-links-"));
  const paths = resolveHunsuPaths({ home: join(root, "home") });
  const external = join(root, "external");
  try {
    await mkdir(paths.runtimeDirectory, { recursive: true });
    await mkdir(external, { recursive: true });
    await writeFile(join(external, "survives.txt"), "survives\n", "utf8");
    await symlink(external, paths.runtimeStagingDirectory, process.platform === "win32" ? "junction" : "dir");
    const linkedRoot = planStagedRuntimeInstall({ paths, transactionId: "linked-root", nodePath: process.execPath });
    await assert.rejects(
      installStagedRuntime({ plan: linkedRoot, commandRunner: packageRunner([]) }),
      /unsafe filesystem type/u
    );
    assert.equal(await readFile(join(external, "survives.txt"), "utf8"), "survives\n");

    await rm(paths.runtimeStagingDirectory, { force: true });
    const linkedCli = planStagedRuntimeInstall({ paths, transactionId: "linked-cli", nodePath: process.execPath });
    await assert.rejects(
      installStagedRuntime({
        plan: linkedCli,
        commandRunner: async command => {
          const prefix = command.args[command.args.indexOf("--prefix") + 1]!;
          const packageRoot = join(prefix, "node_modules", "@hunsu", "bridge");
          await mkdir(join(packageRoot, "dist"), { recursive: true });
          await writeFile(join(packageRoot, "package.json"), JSON.stringify({
            name: "@hunsu/bridge",
            version: HUNSU_BRIDGE_VERSION,
            engines: { node: ">=24.18" }
          }), "utf8");
          await symlink(join(external, "survives.txt"), join(packageRoot, "dist", "cli.js"), "file");
          return { exitCode: 0, stdout: "", stderr: "" };
        }
      }),
      /unsafe manifest or CLI filesystem type/u
    );
    assert.equal(await readFile(join(external, "survives.txt"), "utf8"), "survives\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows runtime plan invokes npm.cmd through an encoded non-interactive PowerShell boundary", () => {
  const paths = resolveHunsuPaths({ home: "C:\\Users\\qa\\Hunsu", platform: "win32" });
  const plan = planStagedRuntimeInstall({
    paths,
    transactionId: "windows-plan",
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    platform: "win32"
  });
  assert.equal(plan.npmCommand.command, "powershell.exe");
  assert.equal(plan.npmCommand.args.includes("-EncodedCommand"), true);
  const encoded = plan.npmCommand.args.at(-1)!;
  const script = Buffer.from(encoded, "base64").toString("utf16le");
  assert.match(script, /npm\.cmd/u);
  assert.match(script, /--prefix/u);
  assert.match(script, /0\.2\.0-next\.9/u);
});

test("local tarball setup keeps the local file URL internal and still targets the exact stable version directory", async () => {
  const home = await mkdtemp(join(tmpdir(), "hunsu-local-runtime-"));
  const paths = resolveHunsuPaths({ home });
  try {
    const tarballPath = join(home, "hunsu-bridge.tgz");
    await writeFile(tarballPath, "fixture", "utf8");
    const plan = planStagedRuntimeInstall({
      paths,
      transactionId: "local-tarball",
      nodePath: process.execPath,
      source: localBridgeTarballSource(tarballPath)
    });
    assert.equal(plan.packageSpec.startsWith("file:"), true);
    assert.equal(plan.npmCommand.args.at(-1), plan.packageSpec);
    assert.equal(plan.runtimePath, join(paths.runtimeVersionsDirectory, HUNSU_BRIDGE_VERSION));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

function packageRunner(
  commands: StagedRuntimeCommand[],
  overrides: {
    name?: string;
    version?: string;
    dependencies?: Record<string, string>;
    engine?: string;
    cliText?: string;
  } = {}
): StagedRuntimeCommandRunner {
  return async command => {
    commands.push(structuredClone(command));
    const prefixIndex = command.args.indexOf("--prefix");
    assert.notEqual(prefixIndex, -1);
    const prefix = command.args[prefixIndex + 1]!;
    const packageRoot = join(prefix, "node_modules", "@hunsu", "bridge");
    await mkdir(join(packageRoot, "dist"), { recursive: true });
    await writeFile(join(packageRoot, "package.json"), `${JSON.stringify({
      name: overrides.name ?? "@hunsu/bridge",
      version: overrides.version ?? HUNSU_BRIDGE_VERSION,
      engines: { node: overrides.engine ?? ">=24.18" },
      ...(overrides.dependencies ? { dependencies: overrides.dependencies } : {})
    })}\n`, "utf8");
    await writeFile(join(packageRoot, "dist", "cli.js"), overrides.cliText ?? "#!/usr/bin/env node\n", "utf8");
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}
