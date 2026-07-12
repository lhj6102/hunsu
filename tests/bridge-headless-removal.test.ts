import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import test from "node:test";
import type {
  BridgeServiceManager,
  ServiceStatus
} from "../apps/bridge/src/service/types.ts";
import { resolveHunsuPaths, type HunsuPaths } from "../apps/bridge/src/state/paths.ts";
import {
  HOME_OWNERSHIP_SCHEMA,
  createHomeOwnershipStore,
  ensureHomeOwnership
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
