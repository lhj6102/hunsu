import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  BridgeServiceManager,
  ServiceInstallInput,
  ServiceResult,
  ServiceStatus
} from "../apps/bridge/src/service/types.ts";
import { resolveHunsuPaths, type HunsuPaths } from "../apps/bridge/src/state/paths.ts";
import {
  HOME_OWNERSHIP_SCHEMA,
  createHomeOwnershipStore
} from "../apps/bridge/src/setup/homeOwnership.ts";
import {
  BRIDGE_PACKAGE_VERSION,
  RUNTIME_INSTALL_SCHEMA,
  createRuntimeInstallStore,
  serviceInputForInstallation,
  type RuntimeInstallDocument,
  type RuntimeInstallation
} from "../apps/bridge/src/setup/runtimeInstaller.ts";
import type { StagedRuntimeCommandRunner } from "../apps/bridge/src/setup/stagedRuntimeInstaller.ts";
import {
  SETUP_TRANSACTION_SCHEMA,
  createSetupTransactionStore,
  setupLockPath,
  setupTransactionPath,
  type SetupTransaction
} from "../apps/bridge/src/setup/setupTransaction.ts";
import {
  nodeVersionIsSupported,
  setupBridge,
  type BridgeSetupOptions,
  type SetupFailurePhase,
  type SetupVerification
} from "../apps/bridge/src/setup/setup.ts";

const INSTALLATION_ID = "install_setup_transaction_test";

test("setup rejects unsupported Node and dry-run has no filesystem or service side effects", async () => {
  assert.equal(nodeVersionIsSupported("v22.17.99"), false);
  assert.equal(nodeVersionIsSupported("v22.18.0"), true);
  assert.equal(nodeVersionIsSupported("v23.0.0"), true);
  const fixture = await createFixture();
  try {
    const unsupported = await setupBridge({ ...fixture.options(), nodeVersion: "v22.17.99" });
    assert.equal(unsupported.ok, false);
    if (!unsupported.ok) assert.equal(unsupported.code, "NODE_VERSION_UNSUPPORTED");
    assert.deepEqual(fixture.events, []);

    const dryRun = await setupBridge({ ...fixture.options(), dryRun: true });
    assert.equal(dryRun.ok, true);
    if (dryRun.ok) {
      assert.equal(dryRun.value.dryRun, true);
      assert.equal(dryRun.value.runtimePath, join(fixture.paths.runtimeVersionsDirectory, BRIDGE_PACKAGE_VERSION));
      assert.equal(dryRun.value.npmCommand.args.includes(dryRun.value.runtimePath), false);
      assert.equal(dryRun.value.npmCommand.args.some(value => value.includes("staging")), true);
    }
    assert.equal(await exists(fixture.paths.home), false);
    assert.deepEqual(fixture.events, []);
  } finally {
    await fixture.cleanup();
  }
});

test("initial setup stages, verifies, activates, journals, starts, and atomically commits one exact runtime", async () => {
  const fixture = await createFixture();
  try {
    const result = await setupBridge(fixture.options());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.packageVersion, BRIDGE_PACKAGE_VERSION);
    assert.equal(result.value.started, true);
    assert.equal(result.value.idempotent, false);
    assert.equal(await exists(result.value.cliPath), true);
    assert.equal(await exists(setupTransactionPath(fixture.paths)), false);
    assert.equal(await exists(setupLockPath(fixture.paths)), false);
    assert.equal(await exists(join(fixture.paths.runtimeDirectory, "staging", "setup-test")), false);
    assert.deepEqual(fixture.events.slice(0, 6), [
      "phase:ownership-marker",
      "phase:credential-ensure",
      "credentials.ensure",
      "phase:npm-install",
      "npm.install",
      "phase:candidate-verification"
    ]);
    assert.ok(fixture.events.indexOf("credentials.ensure") < fixture.events.indexOf("npm.install"));
    assert.equal(fixture.service.installed(), true);
    assert.equal(fixture.service.running(), true);
    assert.equal(fixture.service.input()?.runtimePath, result.value.runtimePath);
    const install = await createRuntimeInstallStore(fixture.paths).read();
    assert.equal(install?.installationId, INSTALLATION_ID);
    assert.equal(install?.current.packageVersion, BRIDGE_PACKAGE_VERSION);
    assert.equal(install?.current.runtimePath, result.value.runtimePath);
    assert.equal(install?.previous, null);
    const marker = JSON.parse(await readFile(fixture.paths.homeOwnershipFile, "utf8")) as { schema?: string; installationId?: string };
    assert.equal(marker.schema, HOME_OWNERSHIP_SCHEMA);
    assert.equal(marker.installationId, INSTALLATION_ID);
  } finally {
    await fixture.cleanup();
  }
});

test("same-version setup verifies and reuses the exact CLI without npm or a second daemon", async () => {
  const fixture = await createFixture();
  try {
    assert.equal((await setupBridge(fixture.options())).ok, true);
    fixture.events.length = 0;
    const second = await setupBridge(fixture.options({ transactionId: "setup-second" }));
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.value.idempotent, true);
    assert.equal(second.value.started, false);
    assert.equal(fixture.events.includes("npm.install"), false);
    assert.equal(fixture.events.filter(event => event === "service.start").length, 0);
    assert.equal(fixture.events.filter(event => event === "service.restart").length, 0);
    assert.equal(fixture.service.daemonStarts(), 1);
  } finally {
    await fixture.cleanup();
  }
});

test("upgrade switches side-by-side and records the previous verified runtime", async () => {
  const fixture = await createFixture();
  try {
    const previous = await fixture.seedPreviousRuntime("0.2.0-next.0");
    const result = await setupBridge(fixture.options());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.upgraded, true);
    assert.equal(fixture.service.input()?.packageVersion, BRIDGE_PACKAGE_VERSION);
    const install = await createRuntimeInstallStore(fixture.paths).read();
    assert.deepEqual(install?.previous, previous.current);
    assert.equal(await exists(previous.current.cliPath), true);
    assert.equal(await exists(result.value.cliPath), true);
  } finally {
    await fixture.cleanup();
  }
});

const FIRST_INSTALL_FAILURES: SetupFailurePhase[] = [
  "ownership-marker",
  "credential-ensure",
  "npm-install",
  "candidate-verification",
  "staging-rename",
  "transaction-write",
  "service-definition-install",
  "service-start",
  "health-verification",
  "authentication-verification",
  "version-verification",
  "install-record-commit"
];

test("every first-install phase failure compensates to no daemon, definition, candidate, record, or journal", async t => {
  for (const phase of FIRST_INSTALL_FAILURES) {
    await t.test(phase, async () => {
      const fixture = await createFixture();
      try {
        const result = await setupBridge(fixture.options({ failPhases: [phase] }));
        assert.equal(result.ok, false);
        assert.equal(fixture.service.installed(), false, phase);
        assert.equal(fixture.service.running(), false, phase);
        assert.equal(await exists(join(fixture.paths.runtimeVersionsDirectory, BRIDGE_PACKAGE_VERSION)), false, phase);
        assert.equal(await exists(fixture.paths.runtimeInstallFile), false, phase);
        assert.equal(await exists(setupTransactionPath(fixture.paths)), false, phase);
        assert.equal(await readFile(fixture.paths.configFile, "utf8"), "config-preserved\n", phase);
        assert.equal(await readFile(fixture.paths.workspacesFile, "utf8"), "workspaces-preserved\n", phase);
        assert.equal(await readFile(fixture.paths.credentialsFile, "utf8"), "credentials-preserved\n", phase);
      } finally {
        await fixture.cleanup();
      }
    });
  }
});

test("upgrade failures restore the previous service, install record, and runtime", async t => {
  const phases: SetupFailurePhase[] = [
    "previous-service-stop",
    "service-definition-install",
    "service-start",
    "health-verification",
    "authentication-verification",
    "version-verification",
    "install-record-commit"
  ];
  for (const phase of phases) {
    await t.test(phase, async () => {
      const fixture = await createFixture();
      try {
        const previous = await fixture.seedPreviousRuntime("0.2.0-next.0");
        const result = await setupBridge(fixture.options({ failPhases: [phase] }));
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.code, "SETUP_VERIFICATION_FAILED");
        assert.equal(fixture.service.installed(), true);
        assert.equal(fixture.service.running(), true);
        assert.equal(fixture.service.input()?.packageVersion, previous.current.packageVersion);
        assert.deepEqual(await createRuntimeInstallStore(fixture.paths).read(), previous);
        assert.equal(await exists(previous.current.cliPath), true);
        assert.equal(await exists(join(fixture.paths.runtimeVersionsDirectory, BRIDGE_PACKAGE_VERSION)), false);
        assert.equal(await exists(setupTransactionPath(fixture.paths)), false);
      } finally {
        await fixture.cleanup();
      }
    });
  }
});

test("cleanup and previous-restore failures return ROLLBACK_FAILED with a retained recovery journal", async t => {
  await t.test("first install service cleanup", async () => {
    const fixture = await createFixture();
    try {
      const result = await setupBridge(fixture.options({
        failPhases: ["health-verification", "candidate-service-cleanup"]
      }));
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, "ROLLBACK_FAILED");
      assert.equal(await exists(setupTransactionPath(fixture.paths)), true);
    } finally {
      await fixture.cleanup();
    }
  });
  await t.test("first install runtime cleanup", async () => {
    const fixture = await createFixture();
    try {
      const result = await setupBridge(fixture.options({
        failPhases: ["health-verification", "candidate-runtime-cleanup"]
      }));
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, "ROLLBACK_FAILED");
      assert.equal(await exists(join(fixture.paths.runtimeVersionsDirectory, BRIDGE_PACKAGE_VERSION)), true);
      assert.equal(await exists(setupTransactionPath(fixture.paths)), true);
    } finally {
      await fixture.cleanup();
    }
  });
  for (const restorePhase of ["previous-definition-restore", "previous-runtime-restart"] as const) {
    await t.test(restorePhase, async () => {
      const fixture = await createFixture();
      try {
        await fixture.seedPreviousRuntime("0.2.0-next.0");
        const result = await setupBridge(fixture.options({
          failPhases: ["health-verification", restorePhase]
        }));
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.code, "ROLLBACK_FAILED");
        assert.equal(await exists(setupTransactionPath(fixture.paths)), true);
      } finally {
        await fixture.cleanup();
      }
    });
  }
});

test("setup automatically recovers an interrupted first-install transaction before continuing", async () => {
  const fixture = await createFixture();
  try {
    await fixture.prepareHome();
    const candidate = await seedRuntime(fixture.paths, BRIDGE_PACKAGE_VERSION, "interrupted-candidate");
    fixture.service.seed(serviceInputForInstallation(candidate, fixture.paths.home), true, true);
    const timestamp = "2026-07-12T00:00:00.000Z";
    const pending: SetupTransaction = {
      schema: SETUP_TRANSACTION_SCHEMA,
      transactionId: "interrupted",
      phase: "candidate-started",
      candidate,
      previous: null,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    await createSetupTransactionStore(fixture.paths).write(pending);
    const result = await setupBridge(fixture.options());
    assert.equal(result.ok, true);
    assert.equal(await exists(setupTransactionPath(fixture.paths)), false);
    assert.equal(fixture.service.installed(), true);
    assert.equal(fixture.service.running(), true);
    assert.equal(fixture.service.input()?.packageVersion, BRIDGE_PACKAGE_VERSION);
  } finally {
    await fixture.cleanup();
  }
});

type Fixture = Awaited<ReturnType<typeof createFixture>>;

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "hunsu-transactional-setup-"));
  const paths = resolveHunsuPaths({ home: join(root, "home") });
  const events: string[] = [];
  const service = fakeServiceManager(events);
  let prepared = false;

  const prepareHome = async (): Promise<void> => {
    if (prepared) return;
    prepared = true;
    await mkdir(paths.home, { recursive: true });
    await Promise.all([
      writeFile(paths.configFile, "config-preserved\n", "utf8"),
      writeFile(paths.workspacesFile, "workspaces-preserved\n", "utf8"),
      writeFile(paths.credentialsFile, "credentials-preserved\n", { encoding: "utf8", mode: 0o600 })
    ]);
  };

  const options = (input: {
    failPhases?: SetupFailurePhase[];
    transactionId?: string;
  } = {}): BridgeSetupOptions => {
    const remaining = new Set(input.failPhases ?? []);
    return {
      paths,
      credentialStore: {
        async ensure() {
          await prepareHome();
          events.push("credentials.ensure");
          return {
            schema: "hunsu.bridge.credentials.v1",
            controlToken: "hunsu_control_fixture",
            account: null,
            relay: null
          };
        }
      },
      serviceManager: service,
      verifyRuntime: async installation => service.verification(installation),
      npmRunner: packageRunner(events),
      nodePath: process.execPath,
      nodeVersion: process.version,
      now: () => new Date("2026-07-12T01:02:03.000Z"),
      createInstallationId: () => INSTALLATION_ID,
      createTransactionId: () => input.transactionId ?? "setup-test",
      onPhase: async phase => {
        await prepareHome();
        events.push(`phase:${phase}`);
        if (remaining.delete(phase)) throw new Error(`injected ${phase}`);
      }
    };
  };

  const seedPreviousRuntime = async (version: string): Promise<RuntimeInstallDocument> => {
    await prepareHome();
    const current = await seedRuntime(paths, version, `previous-${version}`);
    const document: RuntimeInstallDocument = {
      schema: RUNTIME_INSTALL_SCHEMA,
      installationId: INSTALLATION_ID,
      current,
      previous: null,
      serviceInput: serviceInputForInstallation(current, paths.home),
      updatedAt: current.installedAt
    };
    await createRuntimeInstallStore(paths).write(document);
    await createHomeOwnershipStore(paths).write({
      schema: HOME_OWNERSHIP_SCHEMA,
      installationId: INSTALLATION_ID,
      createdAt: current.installedAt,
      home: paths.home
    });
    service.seed(document.serviceInput, true, true);
    return document;
  };

  return {
    root,
    paths,
    events,
    service,
    options,
    prepareHome,
    seedPreviousRuntime,
    cleanup: () => rm(root, { recursive: true, force: true })
  };
}

function packageRunner(events: string[]): StagedRuntimeCommandRunner {
  return async command => {
    events.push("npm.install");
    const prefixIndex = command.args.indexOf("--prefix");
    assert.notEqual(prefixIndex, -1);
    const prefix = command.args[prefixIndex + 1]!;
    const packageRoot = join(prefix, "node_modules", "@hunsu", "bridge");
    await mkdir(join(packageRoot, "dist"), { recursive: true });
    await writeFile(join(packageRoot, "package.json"), `${JSON.stringify({
      name: "@hunsu/bridge",
      version: BRIDGE_PACKAGE_VERSION,
      engines: { node: ">=22.18" }
    })}\n`, "utf8");
    await writeFile(join(packageRoot, "dist", "cli.js"), "#!/usr/bin/env node\n", "utf8");
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}

function fakeServiceManager(events: string[]): BridgeServiceManager & {
  installed(): boolean;
  running(): boolean;
  input(): ServiceInstallInput | undefined;
  daemonStarts(): number;
  seed(input: ServiceInstallInput, installed: boolean, running: boolean): void;
  verification(installation: RuntimeInstallation): SetupVerification;
} {
  let installed = false;
  let running = false;
  let currentInput: ServiceInstallInput | undefined;
  let daemonStarts = 0;
  return {
    async install(input) {
      const changed = !currentInput || JSON.stringify(currentInput) !== JSON.stringify(input);
      currentInput = structuredClone(input);
      installed = true;
      events.push(`service.install:${input.packageVersion}`);
      return serviceOk(changed);
    },
    async uninstall() {
      events.push("service.uninstall");
      installed = false;
      running = false;
      currentInput = undefined;
      return serviceOk(true);
    },
    async start() {
      events.push("service.start");
      if (!installed) return serviceFailure("SERVICE_NOT_INSTALLED");
      if (!running) daemonStarts += 1;
      running = true;
      return serviceOk(true);
    },
    async stop() {
      events.push("service.stop");
      running = false;
      return installed ? serviceOk(true) : serviceFailure("SERVICE_NOT_INSTALLED");
    },
    async restart() {
      events.push("service.restart");
      if (!installed) return serviceFailure("SERVICE_NOT_INSTALLED");
      daemonStarts += 1;
      running = true;
      return serviceOk(true);
    },
    async status(): Promise<ServiceStatus> {
      events.push("service.status");
      return {
        installed,
        manager: "systemd-user",
        managerState: running ? "running" : "stopped",
        health: running ? "healthy" : "offline",
        authentication: running ? "authenticated" : "unavailable",
        definitionPath: "fixture",
        ...(currentInput ? {
          packageVersion: currentInput.packageVersion,
          runtimePath: currentInput.runtimePath
        } : {})
      };
    },
    installed: () => installed,
    running: () => running,
    input: () => currentInput && structuredClone(currentInput),
    daemonStarts: () => daemonStarts,
    seed(input, nextInstalled, nextRunning) {
      currentInput = structuredClone(input);
      installed = nextInstalled;
      running = nextRunning;
      if (nextRunning) daemonStarts = 1;
    },
    verification(installation) {
      return {
        health: running,
        authenticated: running,
        version: currentInput?.packageVersion ?? "unavailable",
        runtimePath: currentInput?.runtimePath ?? installation.runtimePath
      };
    }
  };
}

async function seedRuntime(paths: HunsuPaths, version: string, cliText: string): Promise<RuntimeInstallation> {
  const runtimePath = join(paths.runtimeVersionsDirectory, version);
  const packageRoot = join(runtimePath, "node_modules", "@hunsu", "bridge");
  const cliPath = join(packageRoot, "dist", "cli.js");
  await mkdir(join(packageRoot, "dist"), { recursive: true });
  await writeFile(join(packageRoot, "package.json"), `${JSON.stringify({
    name: "@hunsu/bridge",
    version,
    engines: { node: ">=22.18" }
  })}\n`, "utf8");
  await writeFile(cliPath, `${cliText}\n`, "utf8");
  return {
    packageVersion: version,
    runtimePath,
    nodePath: process.execPath,
    cliPath,
    installedAt: "2026-07-12T00:00:00.000Z"
  };
}

function serviceOk(changed: boolean): ServiceResult {
  return { ok: true, code: "OK", message: "ok", manager: "systemd-user", changed };
}

function serviceFailure(code: "SERVICE_NOT_INSTALLED"): ServiceResult {
  return { ok: false, code, message: "not installed", manager: "systemd-user" };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (_error) {
    return false;
  }
}

void (undefined as unknown as Fixture);
