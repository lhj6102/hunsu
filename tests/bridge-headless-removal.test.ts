import assert from "node:assert/strict";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, parse } from "node:path";
import test from "node:test";
import type {
  BridgeServiceManager,
  ServiceStatus
} from "../apps/bridge/src/service/types.ts";
import { createWindowsTaskSchedulerServiceManager } from "../apps/bridge/src/service/windowsTaskScheduler.ts";
import { resolveHunsuPaths, type HunsuPaths } from "../apps/bridge/src/state/paths.ts";
import {
  HOME_OWNERSHIP_SCHEMA,
  createHomeOwnershipStore,
  ensureHomeOwnership,
  windowsHomeOwnershipAclPowerShellInvocation
} from "../apps/bridge/src/setup/homeOwnership.ts";
import {
  BRIDGE_PACKAGE_VERSION,
  RUNTIME_INSTALL_SCHEMA,
  createRuntimeInstallStore,
  serviceInputForInstallation,
  type RuntimeInstallDocument,
  type RuntimeInstallation
} from "../apps/bridge/src/setup/runtimeInstaller.ts";
import { removeBridge } from "../apps/bridge/src/setup/uninstall.ts";
import { acquireSetupOperationLock } from "../apps/bridge/src/setup/setupTransaction.ts";
import { defaultOwnedDataFileSystem } from "../apps/bridge/src/setup/ownedDataRemoval.ts";

const INSTALLATION_ID = "install_removal_test_0001";
const OTHER_INSTALLATION_ID = "install_removal_test_0002";

test("ownership marker records canonical home with user-only permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunsu-ownership-marker-"));
  const paths = resolveHunsuPaths({ home: join(root, "state") });
  try {
    const marker = await ensureHomeOwnership({
      store: createHomeOwnershipStore(paths),
      expectedInstallationId: INSTALLATION_ID,
      now: () => new Date("2026-07-12T01:02:03.000Z")
    });
    assert.deepEqual(marker, {
      schema: HOME_OWNERSHIP_SCHEMA,
      installationId: INSTALLATION_ID,
      createdAt: "2026-07-12T01:02:03.000Z",
      home: await realpath(paths.home)
    });
    const persisted = JSON.parse(await readFile(paths.homeOwnershipFile, "utf8")) as unknown;
    assert.deepEqual(persisted, marker);
    if (process.platform !== "win32") {
      assert.equal((await stat(paths.homeOwnershipFile)).mode & 0o777, 0o600);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows ownership marker ACL hardening uses one encoded injection-safe current-user-only command", () => {
  const markerPath = "C:\\Users\\O'Brien\\Hunsu Bridge\\.hunsu-bridge-home.json";
  const invocation = windowsHomeOwnershipAclPowerShellInvocation(markerPath);
  assert.equal(invocation.command, "powershell.exe");
  assert.deepEqual(invocation.args.slice(0, -1), [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand"
  ]);
  assert.equal(invocation.args.includes(markerPath), false);

  const command = Buffer.from(invocation.args.at(-1) ?? "", "base64").toString("utf16le");
  assert.match(command, /\$OwnershipMarkerPath = 'C:\\Users\\O''Brien\\Hunsu Bridge\\\.hunsu-bridge-home\.json'/u);
  assert.match(command, /WindowsIdentity\]::GetCurrent\(\)\.User/u);
  assert.match(command, /FileSecurity\]::new\(\)/u);
  assert.match(command, /SetOwner\(\$sid\)/u);
  assert.match(command, /SetAccessRuleProtection\(\$true, \$false\)/u);
  assert.match(command, /FileSystemAccessRule\]::new\(\$sid/u);
  assert.match(command, /FileSystemRights\]::FullControl/u);
  assert.match(command, /AccessControlType\]::Allow/u);
  assert.match(command, /System\.IO\.File\]::SetAccessControl\(\$OwnershipMarkerPath, \$acl\)/u);
  assert.doesNotMatch(command, /param\(|Get-Acl|Set-Acl|New-Object|NTAccount/u);
  assert.throws(
    () => windowsHomeOwnershipAclPowerShellInvocation("C:\\Hunsu\nInjected\\.hunsu-bridge-home.json"),
    /control characters/u
  );
});

test("Windows ownership markers are ACL-hardened before atomic commit and failed hardening preserves the marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunsu-windows-ownership-marker-"));
  const paths = resolveHunsuPaths({ home: join(root, "state") });
  const hardened: string[] = [];
  const store = createHomeOwnershipStore(paths, {
    platform: "win32",
    windowsAclHardener: async temporaryFile => {
      assert.notEqual(temporaryFile, paths.homeOwnershipFile);
      assert.match(basename(temporaryFile), /^\.\.hunsu-bridge-home\.json\..+\.tmp$/u);
      assert.equal(JSON.parse(await readFile(temporaryFile, "utf8")).schema, HOME_OWNERSHIP_SCHEMA);
      hardened.push(temporaryFile);
    }
  });
  try {
    const marker = await ensureHomeOwnership({
      store,
      expectedInstallationId: INSTALLATION_ID,
      now: () => new Date("2026-07-12T01:02:03.000Z")
    });
    assert.equal(hardened.length, 1);

    await ensureHomeOwnership({ store, expectedInstallationId: INSTALLATION_ID });
    assert.equal(hardened.length, 2, "an existing marker must be re-hardened during setup verification");

    const original = await readFile(paths.homeOwnershipFile, "utf8");
    const failingStore = createHomeOwnershipStore(paths, {
      platform: "win32",
      windowsAclHardener: async () => { throw new Error("injected ACL failure"); }
    });
    await assert.rejects(
      () => failingStore.write({ ...marker, createdAt: "2026-07-12T02:03:04.000Z" }),
      /Unable to persist Bridge state file/u
    );
    assert.equal(await readFile(paths.homeOwnershipFile, "utf8"), original);
    assert.deepEqual((await readdir(paths.home)).filter(entry => entry.endsWith(".tmp")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("default and custom leaf homes containing only Hunsu entries are removed", async t => {
  const root = await mkdtemp(join(tmpdir(), "hunsu-owned-leaf-"));
  const homes = [
    resolveHunsuPaths({
      platform: process.platform,
      userHome: join(root, "user"),
      localAppData: join(root, "local-app-data")
    }),
    resolveHunsuPaths({ home: join(root, "custom", "bridge") })
  ];
  try {
    for (const [index, paths] of homes.entries()) {
      await t.test(index === 0 ? "default home" : "custom leaf home", async () => {
        await writeCompleteOwnedHome(paths);
        const events: string[] = [];
        const result = await removeBridge(
          { deleteData: true, confirmed: true },
          { paths, serviceManager: fakeServiceManager(events) }
        );
        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.deepEqual(result.value, {
          removedRuntime: true,
          deletedData: true,
          deleted: ["config.json", "workspaces.json", "credentials.json", "runtime.json", "runtime", "logs"],
          preservedUnknownEntries: [],
          homeDirectoryRemoved: true,
          dryRun: false
        });
        assert.deepEqual(events, ["service.uninstall"]);
        assert.equal(await exists(paths.home), false);
        assert.equal(await exists(paths.homeOwnershipFile), false);
        assert.equal(await exists(paths.runtimeInstallFile), false);
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tmp-style and Documents-style broad homes preserve every unknown top-level entry", async t => {
  const root = await mkdtemp(join(tmpdir(), "hunsu-owned-broad-"));
  const homes = [
    resolveHunsuPaths({ home: join(root, "shared-tmp") }),
    resolveHunsuPaths({ home: join(root, "user", "Documents") })
  ];
  try {
    for (const [index, paths] of homes.entries()) {
      await t.test(index === 0 ? "tmp-style broad home" : "Documents-style broad home", async () => {
        await writeCompleteOwnedHome(paths);
        await writeFile(join(paths.home, "user-notes.txt"), "preserve\n", "utf8");
        await mkdir(join(paths.home, "personal-project", "nested"), { recursive: true });
        await writeFile(join(paths.home, "personal-project", "nested", "keep.txt"), "preserve\n", "utf8");
        const result = await removeBridge(
          { deleteData: true, confirmed: true },
          { paths, serviceManager: fakeServiceManager([]) }
        );
        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.deepEqual(result.value.preservedUnknownEntries, ["personal-project", "user-notes.txt"]);
        assert.equal(result.value.homeDirectoryRemoved, false);
        assert.equal(await readFile(join(paths.home, "user-notes.txt"), "utf8"), "preserve\n");
        assert.equal(
          await readFile(join(paths.home, "personal-project", "nested", "keep.txt"), "utf8"),
          "preserve\n"
        );
        for (const owned of [
          paths.configFile,
          paths.workspacesFile,
          paths.credentialsFile,
          paths.runtimeFile,
          paths.runtimeDirectory,
          paths.logsDirectory,
          paths.homeOwnershipFile
        ]) {
          assert.equal(await exists(owned), false);
        }
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("markerless next.0-style installs and missing ownership markers refuse destructive removal", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunsu-owned-markerless-"));
  try {
    for (const installationId of [null, INSTALLATION_ID] as const) {
      const paths = resolveHunsuPaths({ home: join(root, installationId === null ? "legacy" : "missing-marker") });
      await writeCompleteOwnedHome(paths, { installationId, writeMarker: false });
      const events: string[] = [];
      const result = await removeBridge(
        { deleteData: true, confirmed: true },
        { paths, serviceManager: fakeServiceManager(events) }
      );
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, "BRIDGE_DATA_DELETE_REFUSED");
      assert.deepEqual(events, []);
      assert.equal(await exists(paths.configFile), true);
      assert.equal(await exists(paths.runtimeInstallFile), true);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ordinary removal cleans a markerless next.0 runtime while preserving all user data", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunsu-owned-legacy-remove-"));
  const paths = resolveHunsuPaths({ home: join(root, "legacy") });
  try {
    await writeCompleteOwnedHome(paths, { installationId: null, writeMarker: false });
    const events: string[] = [];
    const result = await removeBridge({}, { paths, serviceManager: fakeServiceManager(events) });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.deletedData, false);
    assert.deepEqual(result.value.deleted, ["runtime.json", "runtime"]);
    assert.equal(result.value.homeDirectoryRemoved, false);
    assert.deepEqual(events, ["service.uninstall"]);
    assert.equal(await exists(paths.runtimeDirectory), false);
    assert.equal(await exists(paths.runtimeFile), false);
    for (const preserved of [paths.configFile, paths.workspacesFile, paths.credentialsFile, paths.logsDirectory]) {
      assert.equal(await exists(preserved), true);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ordinary Windows removal waits for the owned scheduled task process before deleting runtime state", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunsu-owned-windows-exit-race-"));
  const paths = resolveHunsuPaths({ home: join(root, "state") });
  const events: string[] = [];
  let shutdownRequested = false;
  let shutdownStateChecks = 0;
  let taskState: "Running" | "Queued" | "Ready" = "Running";
  try {
    await writeCompleteOwnedHome(paths, { installationId: null, writeMarker: false });
    const serviceManager = createWindowsTaskSchedulerServiceManager({
      commandRunner: async command => {
        const script = command.args.at(-1) ?? "";
        if (script.includes("Get-ScheduledTask")) {
          if (shutdownRequested && script.includes("ExpandProperty State")) {
            shutdownStateChecks += 1;
            if (shutdownStateChecks === 1) {
              events.push("task:query-error");
              return { exitCode: 1, stdout: "", stderr: "transient query failure" };
            }
            taskState = shutdownStateChecks === 2 ? "Queued" : "Ready";
          }
          events.push(`task:${taskState.toLowerCase()}`);
          return { exitCode: 0, stdout: `${taskState}\n`, stderr: "" };
        }
        if (script.includes("Unregister-ScheduledTask")) {
          assert.equal(taskState, "Ready", "the task must own no running daemon before it is unregistered");
          events.push("task:unregister");
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (script.includes("Stop-ScheduledTask")) {
          events.push("task:force-stop");
          taskState = "Ready";
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      requestAuthenticatedShutdown: async () => {
        events.push("shutdown");
        shutdownRequested = true;
        return true;
      },
      probeHealth: async () => false,
      sleep: async () => undefined,
      stopTimeoutMs: 20,
      pollIntervalMs: 5
    });

    const result = await removeBridge({}, { paths, serviceManager });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.removedRuntime, true);
    assert.ok(events.indexOf("task:query-error") < events.indexOf("task:queued"));
    assert.ok(events.indexOf("task:queued") < events.indexOf("task:ready"));
    assert.ok(events.indexOf("task:ready") < events.indexOf("task:unregister"));
    assert.equal(events.includes("task:force-stop"), false);
    assert.equal(await exists(paths.runtimeFile), false);
    assert.equal(await exists(paths.runtimeDirectory), false);
    assert.equal(await exists(paths.runtimeInstallFile), false);
    for (const preserved of [paths.configFile, paths.workspacesFile, paths.credentialsFile, paths.logsDirectory]) {
      assert.equal(await exists(preserved), true);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ordinary Windows removal preserves runtime when a missing task leaves a healthy orphan that cannot shut down", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunsu-missing-task-orphan-"));
  const paths = resolveHunsuPaths({ home: join(root, "state") });
  const events: string[] = [];
  try {
    await writeCompleteOwnedHome(paths, { installationId: null, writeMarker: false });
    const serviceManager = createWindowsTaskSchedulerServiceManager({
      commandRunner: async command => {
        const script = command.args.at(-1) ?? "";
        if (script.includes("Get-ScheduledTask")) {
          events.push("task:missing");
          return { exitCode: 0, stdout: "__HUNSU_TASK_NOT_FOUND__\n", stderr: "" };
        }
        if (script.includes("Stop-ScheduledTask")) {
          events.push("task:stop-failed");
          return { exitCode: 1, stdout: "", stderr: "task missing" };
        }
        return { exitCode: 1, stdout: "", stderr: "unexpected command" };
      },
      requestAuthenticatedShutdown: async () => {
        events.push("shutdown:rejected");
        return false;
      },
      probeHealth: async () => true,
      sleep: async () => undefined,
      stopTimeoutMs: 5,
      pollIntervalMs: 5
    });

    const result = await removeBridge({}, { paths, serviceManager });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "SERVICE_STOP_FAILED");
    assert.deepEqual(events, ["task:missing", "shutdown:rejected", "task:stop-failed"]);
    assert.equal(await exists(paths.runtimeFile), true);
    assert.equal(await exists(paths.runtimeDirectory), true);
    assert.equal(await exists(paths.runtimeInstallFile), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ordinary removal of a broad Documents-style home without an install only uninstalls the service", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunsu-owned-documents-no-install-"));
  const paths = resolveHunsuPaths({ home: join(root, "user", "Documents") });
  try {
    await mkdir(join(paths.home, "personal-project", "nested"), { recursive: true });
    await Promise.all([
      writeFile(paths.configFile, "user-owned config\n", "utf8"),
      writeFile(join(paths.home, "user-notes.txt"), "preserve\n", "utf8"),
      writeFile(join(paths.home, "personal-project", "nested", "keep.txt"), "preserve\n", "utf8")
    ]);
    const events: string[] = [];
    const result = await removeBridge({}, { paths, serviceManager: fakeServiceManager(events) });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value, {
      removedRuntime: false,
      deletedData: false,
      deleted: [],
      preservedUnknownEntries: ["personal-project", "user-notes.txt"],
      homeDirectoryRemoved: false,
      dryRun: false
    });
    assert.deepEqual(events, ["service.uninstall"]);
    assert.equal(await readFile(paths.configFile, "utf8"), "user-owned config\n");
    assert.equal(await readFile(join(paths.home, "user-notes.txt"), "utf8"), "preserve\n");
    assert.equal(await readFile(join(paths.home, "personal-project", "nested", "keep.txt"), "utf8"), "preserve\n");
    assert.equal(await exists(paths.runtimeDirectory), false, "the lock must not leave a new runtime behind");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ordinary removal preserves an unverified existing runtime and reports that it was not removed", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunsu-owned-unverified-runtime-"));
  const paths = resolveHunsuPaths({ home: join(root, "state") });
  try {
    await mkdir(paths.runtimeDirectory, { recursive: true });
    await writeFile(join(paths.runtimeDirectory, "user-owned.txt"), "preserve\n", "utf8");
    await writeFile(paths.runtimeFile, "preserve\n", "utf8");
    const events: string[] = [];
    const result = await removeBridge({}, { paths, serviceManager: fakeServiceManager(events) });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.removedRuntime, false);
    assert.deepEqual(result.value.deleted, []);
    assert.deepEqual(events, ["service.uninstall"]);
    assert.equal(await readFile(join(paths.runtimeDirectory, "user-owned.txt"), "utf8"), "preserve\n");
    assert.equal(await readFile(paths.runtimeFile, "utf8"), "preserve\n");
    assert.equal(await exists(paths.setupLockFile), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a valid-looking install record with external runtime paths cannot authorize broad-home deletion", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunsu-owned-external-install-paths-"));
  const paths = resolveHunsuPaths({ home: join(root, "user", "Documents") });
  const externalRuntime = join(root, "external-runtime");
  try {
    const externalCli = join(externalRuntime, "node_modules", "@hunsu", "bridge", "dist", "cli.js");
    await mkdir(dirname(externalCli), { recursive: true });
    await writeFile(externalCli, "external CLI\n", "utf8");
    await mkdir(paths.runtimeDirectory, { recursive: true });
    await writeFile(join(paths.runtimeDirectory, "personal-runtime-data.txt"), "preserve\n", "utf8");
    const current: RuntimeInstallation = {
      ...runtimeInstallation(paths),
      runtimePath: externalRuntime,
      cliPath: externalCli
    };
    await createRuntimeInstallStore(paths).write({
      schema: RUNTIME_INSTALL_SCHEMA,
      installationId: null,
      current,
      previous: null,
      serviceInput: serviceInputForInstallation(current, paths.home),
      updatedAt: current.installedAt
    });

    const events: string[] = [];
    const result = await removeBridge({}, { paths, serviceManager: fakeServiceManager(events) });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.removedRuntime, false);
    assert.deepEqual(result.value.deleted, []);
    assert.deepEqual(events, ["service.uninstall"]);
    assert.equal(await readFile(join(paths.runtimeDirectory, "personal-runtime-data.txt"), "utf8"), "preserve\n");
    assert.equal(await exists(paths.runtimeInstallFile), true);
    assert.equal(await readFile(externalCli, "utf8"), "external CLI\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ordinary runtime deletion keeps the setup lock until recursive deletion is finished", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunsu-owned-runtime-lock-held-"));
  const paths = resolveHunsuPaths({ home: join(root, "state") });
  try {
    await writeCompleteOwnedHome(paths, { installationId: null, writeMarker: false });
    const unlinked: string[] = [];
    const fileSystem = {
      ...defaultOwnedDataFileSystem,
      async unlink(path: string) {
        assert.notEqual(path, paths.setupLockFile, "owned-data deletion must not unlink its active operation lock");
        assert.equal(await exists(paths.setupLockFile), true, "the operation lock must remain held during deletion");
        unlinked.push(path);
        await defaultOwnedDataFileSystem.unlink(path);
      }
    };
    const result = await removeBridge({}, {
      paths,
      serviceManager: fakeServiceManager([]),
      fileSystem
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.removedRuntime, true);
    assert.equal(unlinked.includes(paths.runtimeInstallFile), true);
    assert.equal(await exists(paths.runtimeDirectory), false);
    assert.equal(await exists(paths.setupLockFile), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a linked runtime causes ordinary removal to fail before service mutation or external traversal", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunsu-owned-runtime-link-"));
  const paths = resolveHunsuPaths({ home: join(root, "state") });
  const external = join(root, "external-runtime");
  try {
    await mkdir(paths.home, { recursive: true });
    await mkdir(external, { recursive: true });
    await writeFile(join(external, "survives.txt"), "outside\n", "utf8");
    await symlink(external, paths.runtimeDirectory, process.platform === "win32" ? "junction" : "dir");
    const events: string[] = [];
    const result = await removeBridge({}, { paths, serviceManager: fakeServiceManager(events) });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "RUNTIME_INSTALL_FAILED");
    assert.deepEqual(events, []);
    assert.equal((await lstat(paths.runtimeDirectory)).isSymbolicLink(), true);
    assert.equal(await readFile(join(external, "survives.txt"), "utf8"), "outside\n");
    assert.deepEqual(await readdir(external), ["survives.txt"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mismatched canonical home and installation identity refuse destructive removal", async t => {
  const root = await mkdtemp(join(tmpdir(), "hunsu-owned-mismatch-"));
  try {
    await t.test("canonical home mismatch", async () => {
      const paths = resolveHunsuPaths({ home: join(root, "canonical-mismatch") });
      const otherHome = join(root, "other-home");
      await mkdir(otherHome, { recursive: true });
      await writeCompleteOwnedHome(paths, { markerHome: await realpath(otherHome) });
      await assertRemovalRefusedWithoutMutation(paths);
    });
    await t.test("installation id mismatch", async () => {
      const paths = resolveHunsuPaths({ home: join(root, "identity-mismatch") });
      await writeCompleteOwnedHome(paths, { markerInstallationId: OTHER_INSTALLATION_ID });
      await assertRemovalRefusedWithoutMutation(paths);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a symlink or junction inside logs is unlinked without traversing its target", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunsu-owned-link-"));
  const paths = resolveHunsuPaths({ home: join(root, "state") });
  const external = join(root, "external-target");
  try {
    await writeCompleteOwnedHome(paths);
    await mkdir(external, { recursive: true });
    await writeFile(join(external, "survives.txt"), "outside\n", "utf8");
    await symlink(
      external,
      join(paths.logsDirectory, "external-link"),
      process.platform === "win32" ? "junction" : "dir"
    );
    const result = await removeBridge(
      { deleteData: true, confirmed: true },
      { paths, serviceManager: fakeServiceManager([]) }
    );
    assert.equal(result.ok, true);
    assert.equal(await readFile(join(external, "survives.txt"), "utf8"), "outside\n");
    assert.equal(await exists(paths.home), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a symlinked or junction HUNSU_HOME is refused without traversing its target", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunsu-owned-home-link-"));
  const targetPaths = resolveHunsuPaths({ home: join(root, "target") });
  const linkedHome = join(root, "linked-home");
  try {
    await writeCompleteOwnedHome(targetPaths);
    await symlink(targetPaths.home, linkedHome, process.platform === "win32" ? "junction" : "dir");
    const events: string[] = [];
    const result = await removeBridge(
      { deleteData: true, confirmed: true },
      { paths: resolveHunsuPaths({ home: linkedHome }), serviceManager: fakeServiceManager(events) }
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "BRIDGE_DATA_DELETE_REFUSED");
    assert.deepEqual(events, []);
    assert.equal(await exists(targetPaths.credentialsFile), true);
    assert.equal(await exists(targetPaths.runtimeInstallFile), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("filesystem root, user home, current repository, and its ancestors are protected", async () => {
  const candidates = [
    parse(process.cwd()).root,
    process.env.HOME,
    process.cwd(),
    dirname(process.cwd())
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  for (const home of new Set(candidates)) {
    const events: string[] = [];
    const result = await removeBridge(
      { deleteData: true, confirmed: true },
      { paths: resolveHunsuPaths({ home }), serviceManager: fakeServiceManager(events) }
    );
    assert.equal(result.ok, false, home);
    if (!result.ok) assert.equal(result.code, "BRIDGE_DATA_DELETE_REFUSED", home);
    assert.deepEqual(events, [], home);
  }
});

test("remove returns SETUP_IN_PROGRESS without touching service or data while setup owns the operation lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunsu-remove-lock-"));
  const paths = resolveHunsuPaths({ home: join(root, "state") });
  const events: string[] = [];
  try {
    await writeCompleteOwnedHome(paths);
    const lease = await acquireSetupOperationLock(paths, "setup");
    try {
      const result = await removeBridge({}, { paths, serviceManager: fakeServiceManager(events) });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, "SETUP_IN_PROGRESS");
      assert.deepEqual(events, []);
      assert.equal(await exists(paths.runtimeInstallFile), true);
    } finally {
      await lease.release();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeCompleteOwnedHome(paths: HunsuPaths, options: {
  installationId?: string | null;
  markerInstallationId?: string;
  markerHome?: string;
  writeMarker?: boolean;
} = {}): Promise<void> {
  const installationId = options.installationId === undefined ? INSTALLATION_ID : options.installationId;
  await mkdir(paths.logsDirectory, { recursive: true });
  await Promise.all([
    writeFile(paths.configFile, "{}\n", "utf8"),
    writeFile(paths.workspacesFile, "{}\n", "utf8"),
    writeFile(paths.credentialsFile, "{}\n", { encoding: "utf8", mode: 0o600 }),
    writeFile(paths.runtimeFile, "{}\n", "utf8"),
    writeFile(paths.structuredLogFile, "{}\n", "utf8")
  ]);
  const current = runtimeInstallation(paths);
  await mkdir(dirname(current.cliPath), { recursive: true });
  await writeFile(current.cliPath, "fixture CLI\n", "utf8");
  const document: RuntimeInstallDocument = {
    schema: RUNTIME_INSTALL_SCHEMA,
    installationId,
    current,
    previous: null,
    serviceInput: serviceInputForInstallation(current, paths.home),
    updatedAt: current.installedAt
  };
  await createRuntimeInstallStore(paths).write(document);
  if (options.writeMarker !== false) {
    await createHomeOwnershipStore(paths).write({
      schema: HOME_OWNERSHIP_SCHEMA,
      installationId: options.markerInstallationId ?? INSTALLATION_ID,
      createdAt: "2026-07-12T00:00:00.000Z",
      home: options.markerHome ?? await realpath(paths.home)
    });
  }
}

function runtimeInstallation(paths: HunsuPaths): RuntimeInstallation {
  return {
    packageVersion: BRIDGE_PACKAGE_VERSION,
    runtimePath: join(paths.runtimeVersionsDirectory, BRIDGE_PACKAGE_VERSION),
    nodePath: process.execPath,
    cliPath: join(paths.runtimeVersionsDirectory, BRIDGE_PACKAGE_VERSION, "node_modules", "@hunsu", "bridge", "dist", "cli.js"),
    cliSha256: "0".repeat(64),
    installedAt: "2026-07-12T00:00:00.000Z"
  };
}

async function assertRemovalRefusedWithoutMutation(paths: HunsuPaths): Promise<void> {
  const events: string[] = [];
  const result = await removeBridge(
    { deleteData: true, confirmed: true },
    { paths, serviceManager: fakeServiceManager(events) }
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "BRIDGE_DATA_DELETE_REFUSED");
  assert.deepEqual(events, []);
  assert.equal(await exists(paths.credentialsFile), true);
  assert.equal(await exists(paths.runtimeInstallFile), true);
}

function fakeServiceManager(events: string[]): BridgeServiceManager {
  return {
    async install() {
      events.push("service.install");
      return { ok: true, code: "OK", message: "ok", manager: "systemd-user", changed: true };
    },
    async uninstall() {
      events.push("service.uninstall");
      return { ok: true, code: "OK", message: "ok", manager: "systemd-user", changed: true };
    },
    async start() {
      events.push("service.start");
      return { ok: true, code: "OK", message: "ok", manager: "systemd-user", changed: true };
    },
    async stop() {
      events.push("service.stop");
      return { ok: true, code: "OK", message: "ok", manager: "systemd-user", changed: true };
    },
    async restart() {
      events.push("service.restart");
      return { ok: true, code: "OK", message: "ok", manager: "systemd-user", changed: true };
    },
    async status(): Promise<ServiceStatus> {
      events.push("service.status");
      return {
        installed: true,
        manager: "systemd-user",
        managerState: "running",
        health: "healthy",
        authentication: "authenticated",
        definitionPath: "fixture"
      };
    }
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (_error) {
    return false;
  }
}
