import assert from "node:assert/strict";
import test from "node:test";
import { resolveHunsuPaths } from "../apps/bridge/src/state/paths.ts";
import type { BridgeCredentials } from "../apps/bridge/src/state/credentialStore.ts";
import type {
  BridgeServiceManager,
  ServiceInstallInput,
  ServiceResult,
  ServiceStatus
} from "../apps/bridge/src/service/types.ts";
import {
  BRIDGE_PACKAGE_SPEC,
  BRIDGE_PACKAGE_VERSION,
  RUNTIME_INSTALL_SCHEMA,
  planStableRuntimeInstall,
  serviceInputForInstallation,
  type RuntimeCommand,
  type RuntimeFileSystem,
  type RuntimeInstallDocument,
  type RuntimeInstallation,
  type RuntimeInstallStore
} from "../apps/bridge/src/setup/runtimeInstaller.ts";
import { nodeVersionIsSupported, setupBridge } from "../apps/bridge/src/setup/setup.ts";
import { removeBridge } from "../apps/bridge/src/setup/uninstall.ts";

const paths = resolveHunsuPaths({ home: "/tmp/hunsu-setup", platform: "linux" });
const targetPlan = planStableRuntimeInstall({
  paths,
  nodePath: "/opt/node/bin/node",
  platform: "linux"
});

test("setup rejects Node below 22.18 and dry-run performs no external action", async () => {
  assert.equal(nodeVersionIsSupported("v22.17.99"), false);
  assert.equal(nodeVersionIsSupported("v22.18.0"), true);
  assert.equal(nodeVersionIsSupported("v23.0.0"), true);

  const events: string[] = [];
  const unsupported = await setupBridge({
    paths,
    credentialStore: credentials(events),
    serviceManager: fakeServiceManager(events),
    verifyRuntime: async () => {
      events.push("verify");
      return { health: true, authenticated: true, version: BRIDGE_PACKAGE_VERSION };
    },
    installStore: memoryInstallStore(),
    fileSystem: memoryRuntimeFileSystem(),
    npmRunner: async command => {
      events.push(`npm:${command.args.join(" ")}`);
      return commandOk();
    },
    nodePath: "/opt/node/bin/node",
    nodeVersion: "v22.17.99"
  });
  assert.equal(unsupported.ok, false);
  if (!unsupported.ok) assert.equal(unsupported.code, "NODE_VERSION_UNSUPPORTED");
  assert.equal(events.length, 0);

  const dryRun = await setupBridge({
    paths,
    credentialStore: credentials(events),
    serviceManager: fakeServiceManager(events),
    verifyRuntime: async () => {
      events.push("verify");
      return { health: true, authenticated: true, version: BRIDGE_PACKAGE_VERSION };
    },
    installStore: memoryInstallStore(),
    fileSystem: memoryRuntimeFileSystem(),
    npmRunner: async command => {
      events.push(`npm:${command.args.join(" ")}`);
      return commandOk();
    },
    nodePath: "/opt/node/bin/node",
    nodeVersion: "v22.18.0",
    dryRun: true
  });
  assert.equal(dryRun.ok, true);
  if (dryRun.ok) {
    assert.equal(dryRun.value.dryRun, true);
    assert.deepEqual(dryRun.value.npmCommand, {
      command: "npm",
      args: ["install", "--omit=dev", "--prefix", targetPlan.runtimePath, BRIDGE_PACKAGE_SPEC]
    });
  }
  assert.deepEqual(events, []);
});

test("initial setup installs the exact package to a stable path, preserves credentials, starts once, and commits install.json", async () => {
  const events: string[] = [];
  const fileSystem = memoryRuntimeFileSystem();
  const installStore = memoryInstallStore();
  const service = fakeServiceManager(events);
  const credentialStore = credentials(events);
  const npmCommands: RuntimeCommand[] = [];
  const result = await setupBridge({
    paths,
    credentialStore,
    serviceManager: service,
    verifyRuntime: async installation => {
      events.push(`verify:${installation.packageVersion}`);
      return { health: true, authenticated: true, version: installation.packageVersion };
    },
    installStore,
    fileSystem,
    npmRunner: async command => {
      events.push("npm.install");
      npmCommands.push(command);
      fileSystem.add(targetPlan.cliPath);
      return commandOk();
    },
    nodePath: "/opt/node/bin/node",
    nodeVersion: "v22.18.0",
    platform: "linux",
    now: () => new Date("2026-07-12T01:02:03.000Z")
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value.commands, {
      status: "npx @hunsu/bridge@next status",
      doctor: "npx @hunsu/bridge@next doctor",
      remove: "npx @hunsu/bridge@next remove"
    });
  }
  assert.deepEqual(npmCommands, [{
    command: "npm",
    args: ["install", "--omit=dev", "--prefix", targetPlan.runtimePath, `@hunsu/bridge@${BRIDGE_PACKAGE_VERSION}`]
  }]);
  assert.deepEqual(events, [
    "npm.install",
    "credentials.ensure",
    `service.install:${BRIDGE_PACKAGE_VERSION}`,
    "service.start",
    `verify:${BRIDGE_PACKAGE_VERSION}`
  ]);
  assert.equal(credentialStore.controlToken(), "stable-control-token");

  const document = installStore.value();
  assert.ok(document);
  assert.equal(document.current.packageVersion, BRIDGE_PACKAGE_VERSION);
  assert.equal(document.current.runtimePath, targetPlan.runtimePath);
  assert.equal(document.current.cliPath, targetPlan.cliPath);
  assert.equal(document.previous, null);
  assert.deepEqual(document.serviceInput, {
    nodePath: "/opt/node/bin/node",
    cliPath: targetPlan.cliPath,
    hunsuHome: paths.home,
    packageVersion: BRIDGE_PACKAGE_VERSION,
    runtimePath: targetPlan.runtimePath
  });
});

test("same-version setup is idempotent: no npm install, credential rotation, service duplication, or second daemon", async () => {
  const events: string[] = [];
  const current = targetInstallation();
  const document = installDocument(current, null);
  const installStore = memoryInstallStore(document);
  const fileSystem = memoryRuntimeFileSystem([current.cliPath]);
  const credentialStore = credentials(events);
  const service = fakeServiceManager(events, { installed: true, running: true, installChanged: false });
  let npmCalls = 0;

  const result = await setupBridge({
    paths,
    credentialStore,
    serviceManager: service,
    verifyRuntime: async installation => {
      events.push(`verify:${installation.packageVersion}`);
      return { health: true, authenticated: true, version: BRIDGE_PACKAGE_VERSION };
    },
    installStore,
    fileSystem,
    npmRunner: async () => {
      npmCalls += 1;
      return commandOk();
    },
    nodePath: "/opt/node/bin/node",
    nodeVersion: "v22.18.9",
    platform: "linux"
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.idempotent, true);
    assert.equal(result.value.started, false);
  }
  assert.equal(npmCalls, 0);
  assert.equal(credentialStore.controlToken(), "stable-control-token");
  assert.deepEqual(events, [
    "credentials.ensure",
    `service.install:${BRIDGE_PACKAGE_VERSION}`,
    "service.status",
    `verify:${BRIDGE_PACKAGE_VERSION}`
  ]);
});

test("upgrade installs side-by-side, stops the old service, switches once, verifies, and records previous", async () => {
  const events: string[] = [];
  const previous = oldInstallation();
  const installStore = memoryInstallStore(installDocument(previous, null));
  const fileSystem = memoryRuntimeFileSystem([previous.cliPath]);
  const result = await setupBridge({
    paths,
    credentialStore: credentials(events),
    serviceManager: fakeServiceManager(events, { installed: true, running: true, installChanged: true }),
    verifyRuntime: async installation => {
      events.push(`verify:${installation.packageVersion}`);
      return { health: true, authenticated: true, version: installation.packageVersion };
    },
    installStore,
    fileSystem,
    npmRunner: async command => {
      events.push("npm.install");
      assert.deepEqual(command.args, ["install", "--omit=dev", "--prefix", targetPlan.runtimePath, BRIDGE_PACKAGE_SPEC]);
      fileSystem.add(targetPlan.cliPath);
      return commandOk();
    },
    nodePath: "/opt/node/bin/node",
    nodeVersion: "v22.18.0",
    platform: "linux"
  });

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.upgraded, true);
  assert.deepEqual(events, [
    "npm.install",
    "credentials.ensure",
    "service.stop",
    `service.install:${BRIDGE_PACKAGE_VERSION}`,
    "service.start",
    `verify:${BRIDGE_PACKAGE_VERSION}`
  ]);
  const document = installStore.value();
  assert.equal(document?.current.packageVersion, BRIDGE_PACKAGE_VERSION);
  assert.deepEqual(document?.previous, previous);
  assert.equal(await fileSystem.exists(previous.cliPath), true);
  assert.equal(await fileSystem.exists(targetPlan.cliPath), true);
});

test("failed candidate verification restores and verifies the previous service definition", async () => {
  const events: string[] = [];
  const previous = oldInstallation();
  const originalDocument = installDocument(previous, null);
  const installStore = memoryInstallStore(originalDocument);
  const fileSystem = memoryRuntimeFileSystem([previous.cliPath]);
  const service = fakeServiceManager(events, { installed: true, running: true, installChanged: true });
  const result = await setupBridge({
    paths,
    credentialStore: credentials(events),
    serviceManager: service,
    verifyRuntime: async installation => {
      events.push(`verify:${installation.packageVersion}`);
      return installation.packageVersion === previous.packageVersion
        ? { health: true, authenticated: true, version: previous.packageVersion }
        : { health: true, authenticated: false, version: BRIDGE_PACKAGE_VERSION };
    },
    installStore,
    fileSystem,
    npmRunner: async () => {
      events.push("npm.install");
      fileSystem.add(targetPlan.cliPath);
      return commandOk();
    },
    nodePath: "/opt/node/bin/node",
    nodeVersion: "v22.18.0",
    platform: "linux"
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "SETUP_VERIFICATION_FAILED");
  assert.deepEqual(events, [
    "npm.install",
    "credentials.ensure",
    "service.stop",
    `service.install:${BRIDGE_PACKAGE_VERSION}`,
    "service.start",
    `verify:${BRIDGE_PACKAGE_VERSION}`,
    "service.stop",
    `service.install:${previous.packageVersion}`,
    "service.start",
    `verify:${previous.packageVersion}`
  ]);
  assert.deepEqual(installStore.value(), originalDocument);
  assert.equal(service.installInputs().at(-1)?.cliPath, previous.cliPath);
});

test("an upgrade service-definition failure restores and verifies the previous runtime", async () => {
  const events: string[] = [];
  const previous = oldInstallation();
  const originalDocument = installDocument(previous, null);
  const installStore = memoryInstallStore(originalDocument);
  const fileSystem = memoryRuntimeFileSystem([previous.cliPath]);
  let installCount = 0;
  const service = fakeServiceManager(events, {
    installed: true,
    running: true,
    installChanged: true,
    installResult: input => {
      installCount += 1;
      return installCount === 1
        ? serviceFailure("systemd-user", "SERVICE_INSTALL_FAILED")
        : serviceOk("systemd-user", true);
    }
  });
  const result = await setupBridge({
    paths,
    credentialStore: credentials(events),
    serviceManager: service,
    verifyRuntime: async installation => {
      events.push(`verify:${installation.packageVersion}`);
      return {
        health: true,
        authenticated: true,
        version: installation.packageVersion
      };
    },
    installStore,
    fileSystem,
    npmRunner: async () => {
      events.push("npm.install");
      fileSystem.add(targetPlan.cliPath);
      return commandOk();
    },
    nodePath: "/opt/node/bin/node",
    nodeVersion: "v22.18.0",
    platform: "linux"
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "SETUP_VERIFICATION_FAILED");
  assert.deepEqual(events, [
    "npm.install",
    "credentials.ensure",
    "service.stop",
    `service.install:${BRIDGE_PACKAGE_VERSION}`,
    "service.stop",
    `service.install:${previous.packageVersion}`,
    "service.start",
    `verify:${previous.packageVersion}`
  ]);
  assert.deepEqual(installStore.value(), originalDocument);
  assert.equal(service.installInputs().at(-1)?.cliPath, previous.cliPath);
});

test("a rollback that cannot restore the previous definition reports ROLLBACK_FAILED", async () => {
  const previous = oldInstallation();
  const installStore = memoryInstallStore(installDocument(previous, null));
  const fileSystem = memoryRuntimeFileSystem([previous.cliPath]);
  let installCount = 0;
  const service = fakeServiceManager([], {
    installed: true,
    running: true,
    installChanged: true,
    installResult: input => {
      installCount += 1;
      return installCount === 1
        ? serviceOk("systemd-user", true)
        : serviceFailure("systemd-user", "SERVICE_INSTALL_FAILED");
    }
  });
  const result = await setupBridge({
    paths,
    credentialStore: credentials([]),
    serviceManager: service,
    verifyRuntime: async installation => ({
      health: true,
      authenticated: false,
      version: installation.packageVersion
    }),
    installStore,
    fileSystem,
    npmRunner: async () => {
      fileSystem.add(targetPlan.cliPath);
      return commandOk();
    },
    nodePath: "/opt/node/bin/node",
    nodeVersion: "v22.18.0",
    platform: "linux"
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "ROLLBACK_FAILED");
});

test("initial setup rejects a healthy authenticated daemon with the wrong version and removes its service definition", async () => {
  const events: string[] = [];
  const fileSystem = memoryRuntimeFileSystem();
  const installStore = memoryInstallStore();
  const result = await setupBridge({
    paths,
    credentialStore: credentials(events),
    serviceManager: fakeServiceManager(events),
    verifyRuntime: async () => {
      events.push("verify:wrong-version");
      return { health: true, authenticated: true, version: "0.1.2" };
    },
    installStore,
    fileSystem,
    npmRunner: async () => {
      events.push("npm.install");
      fileSystem.add(targetPlan.cliPath);
      return commandOk();
    },
    nodePath: "/opt/node/bin/node",
    nodeVersion: "v22.18.0",
    platform: "linux"
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "SETUP_VERIFICATION_FAILED");
  assert.deepEqual(events, [
    "npm.install",
    "credentials.ensure",
    `service.install:${BRIDGE_PACKAGE_VERSION}`,
    "service.start",
    "verify:wrong-version",
    "service.uninstall"
  ]);
  assert.equal(installStore.value(), undefined);
});

test("remove preserves user state by default and destructive removal requires explicit confirmation", async () => {
  const stateFiles = [paths.configFile, paths.workspacesFile, paths.credentialsFile];
  const fileSystem = memoryRuntimeFileSystem([
    ...stateFiles,
    paths.runtimeFile,
    paths.runtimeInstallFile,
    targetPlan.cliPath
  ]);
  const installStore = memoryInstallStore(installDocument(targetInstallation(), null));
  const events: string[] = [];
  const service = fakeServiceManager(events, { installed: true, running: true });

  const result = await removeBridge({}, { paths, serviceManager: service, fileSystem, installStore });
  assert.equal(result.ok, true);
  assert.deepEqual(events, ["service.uninstall"]);
  for (const path of stateFiles) assert.equal(await fileSystem.exists(path), true);
  assert.equal(await fileSystem.exists(paths.runtimeFile), false);
  assert.equal(await fileSystem.exists(targetPlan.cliPath), false);
  assert.equal(installStore.value(), undefined);

  const destructiveEvents: string[] = [];
  const destructiveFiles = memoryRuntimeFileSystem([...stateFiles, targetPlan.cliPath]);
  const destructiveService = fakeServiceManager(destructiveEvents, { installed: true, running: true });
  const blocked = await removeBridge({ deleteData: true }, {
    paths,
    serviceManager: destructiveService,
    fileSystem: destructiveFiles,
    installStore: memoryInstallStore()
  });
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.code, "CONFIRMATION_REQUIRED");
  assert.deepEqual(destructiveEvents, []);
  for (const path of stateFiles) assert.equal(await destructiveFiles.exists(path), true);

  const confirmed = await removeBridge({ deleteData: true, confirmed: true }, {
    paths,
    serviceManager: destructiveService,
    fileSystem: destructiveFiles,
    installStore: memoryInstallStore(installDocument(targetInstallation(), null))
  });
  assert.equal(confirmed.ok, true);
  for (const path of stateFiles) assert.equal(await destructiveFiles.exists(path), false);
});

test("destructive removal refuses an unverified or mismatched HUNSU_HOME before touching the service", async () => {
  const events: string[] = [];
  const service = fakeServiceManager(events, { installed: true, running: true });
  const unverified = await removeBridge({ deleteData: true, confirmed: true }, {
    paths,
    serviceManager: service,
    fileSystem: memoryRuntimeFileSystem(),
    installStore: memoryInstallStore()
  });
  assert.equal(unverified.ok, false);
  if (!unverified.ok) assert.equal(unverified.code, "RUNTIME_INSTALL_FAILED");

  const mismatched = installDocument(targetInstallation(), null);
  mismatched.serviceInput.hunsuHome = `${paths.home}-different`;
  const mismatch = await removeBridge({ deleteData: true, confirmed: true }, {
    paths,
    serviceManager: service,
    fileSystem: memoryRuntimeFileSystem(),
    installStore: memoryInstallStore(mismatched)
  });
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) assert.equal(mismatch.code, "RUNTIME_INSTALL_FAILED");
  assert.deepEqual(events, []);
});

function targetInstallation(): RuntimeInstallation {
  return {
    packageVersion: BRIDGE_PACKAGE_VERSION,
    runtimePath: targetPlan.runtimePath,
    nodePath: "/opt/node/bin/node",
    cliPath: targetPlan.cliPath,
    installedAt: "2026-07-12T00:00:00.000Z"
  };
}

function oldInstallation(): RuntimeInstallation {
  return {
    packageVersion: "0.1.2",
    runtimePath: `${paths.runtimeVersionsDirectory}/0.1.2`,
    nodePath: "/opt/node/bin/node",
    cliPath: `${paths.runtimeVersionsDirectory}/0.1.2/node_modules/@hunsu/bridge/dist/cli.js`,
    installedAt: "2026-07-11T00:00:00.000Z"
  };
}

function installDocument(current: RuntimeInstallation, previous: RuntimeInstallation | null): RuntimeInstallDocument {
  return {
    schema: RUNTIME_INSTALL_SCHEMA,
    current,
    previous,
    serviceInput: serviceInputForInstallation(current, paths.home),
    updatedAt: current.installedAt
  };
}

function memoryInstallStore(initial?: RuntimeInstallDocument): RuntimeInstallStore & {
  value(): RuntimeInstallDocument | undefined;
} {
  let document = initial === undefined ? undefined : structuredClone(initial);
  return {
    read: async () => document === undefined ? undefined : structuredClone(document),
    write: async value => {
      document = structuredClone(value);
    },
    clear: async () => {
      document = undefined;
    },
    value: () => document === undefined ? undefined : structuredClone(document)
  };
}

function memoryRuntimeFileSystem(initial: string[] = []): RuntimeFileSystem & {
  add(path: string): void;
} {
  const entries = new Set(initial);
  return {
    exists: async path => entries.has(path),
    mkdir: async path => {
      entries.add(path);
    },
    remove: async path => {
      for (const entry of [...entries]) {
        if (entry === path || entry.startsWith(`${path}/`)) entries.delete(entry);
      }
    },
    add: path => entries.add(path)
  };
}

function credentials(events: string[]): {
  ensure(): Promise<BridgeCredentials>;
  controlToken(): string;
} {
  const value: BridgeCredentials = {
    schema: "hunsu.bridge.credentials.v1",
    controlToken: "stable-control-token",
    account: null,
    relay: null
  };
  return {
    async ensure() {
      events.push("credentials.ensure");
      return value;
    },
    controlToken: () => value.controlToken
  };
}

function fakeServiceManager(events: string[], options: {
  installed?: boolean;
  running?: boolean;
  installChanged?: boolean;
  installResult?: (input: ServiceInstallInput) => ServiceResult;
} = {}): BridgeServiceManager & { installInputs(): ServiceInstallInput[] } {
  let installed = options.installed ?? false;
  let running = options.running ?? false;
  const inputs: ServiceInstallInput[] = [];
  const manager = "systemd-user" as const;
  return {
    async install(input) {
      inputs.push(structuredClone(input));
      events.push(`service.install:${input.packageVersion}`);
      const custom = options.installResult?.(input);
      if (custom) return custom;
      const changed = options.installChanged ?? !installed;
      installed = true;
      return serviceOk(manager, changed);
    },
    async uninstall() {
      events.push("service.uninstall");
      installed = false;
      running = false;
      return serviceOk(manager, true);
    },
    async start() {
      events.push("service.start");
      running = true;
      return serviceOk(manager, true);
    },
    async stop() {
      events.push("service.stop");
      running = false;
      return serviceOk(manager, true);
    },
    async restart() {
      events.push("service.restart");
      running = true;
      return serviceOk(manager, true);
    },
    async status(): Promise<ServiceStatus> {
      events.push("service.status");
      return {
        installed,
        manager,
        managerState: running ? "running" : "stopped",
        health: running ? "healthy" : "offline",
        authentication: running ? "authenticated" : "unavailable",
        definitionPath: "/home/test/.config/systemd/user/hunsu-bridge.service"
      };
    },
    installInputs: () => structuredClone(inputs)
  };
}

function serviceOk(manager: "systemd-user", changed: boolean): ServiceResult {
  return { ok: true, code: "OK", message: "ok", manager, changed };
}

function serviceFailure(manager: "systemd-user", code: "SERVICE_INSTALL_FAILED"): ServiceResult {
  return { ok: false, code, message: "failed", manager };
}

function commandOk() {
  return { exitCode: 0, stdout: "", stderr: "" };
}
