import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDoctorReport } from "../apps/bridge/src/diagnostics/doctor.ts";
import { resolveHunsuPaths } from "../apps/bridge/src/state/paths.ts";
import {
  executingBridgeRuntimeSource,
  localBridgeTarballSource,
  runtimePackageSpec,
  type RuntimePackageSource
} from "../apps/bridge/src/setup/runtimePackageSource.ts";
import {
  SETUP_TRANSACTION_SCHEMA,
  SetupInProgressError,
  acquireSetupOperationLock,
  createSetupTransactionStore,
  setupLockPath,
  type SetupTransaction
} from "../apps/bridge/src/setup/setupTransaction.ts";
import { HUNSU_BRIDGE_VERSION } from "../apps/bridge/src/version.ts";

test("setup operation lock serializes setup, removal, and service mutations", async () => {
  const home = await mkdtemp(join(tmpdir(), "hunsu-setup-lock-"));
  const paths = resolveHunsuPaths({ home });
  try {
    const first = await acquireSetupOperationLock(paths, "setup");
    await assert.rejects(
      acquireSetupOperationLock(paths, "remove"),
      error => error instanceof SetupInProgressError && error.code === "SETUP_IN_PROGRESS"
    );
    await first.release();

    const second = await acquireSetupOperationLock(paths, "service-mutation");
    await second.release();
    await second.release();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("setup operation lock reclaims a recorded dead process", async () => {
  const home = await mkdtemp(join(tmpdir(), "hunsu-setup-stale-lock-"));
  const paths = resolveHunsuPaths({ home });
  try {
    await acquireSetupOperationLock(paths, "setup", {
      pid: 999_999,
      isProcessAlive: () => false
    });
    const recovered = await acquireSetupOperationLock(paths, "runtime-upgrade", {
      isProcessAlive: () => false
    });
    await recovered.release();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("setup operation lock recovers an invalid partial file that the atomic linker can never create", async () => {
  const home = await mkdtemp(join(tmpdir(), "hunsu-setup-partial-lock-"));
  const paths = resolveHunsuPaths({ home });
  try {
    await mkdir(paths.runtimeDirectory, { recursive: true });
    await writeFile(setupLockPath(paths), "", "utf8");
    const recovered = await acquireSetupOperationLock(paths, "setup", {
      isProcessAlive: () => false
    });
    await recovered.release();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("setup transaction journal round-trips only the explicit transaction contract", async () => {
  const home = await mkdtemp(join(tmpdir(), "hunsu-setup-journal-"));
  const paths = resolveHunsuPaths({ home });
  const store = createSetupTransactionStore(paths);
  const timestamp = "2026-07-12T00:00:00.000Z";
  const transaction: SetupTransaction = {
    schema: SETUP_TRANSACTION_SCHEMA,
    transactionId: "transaction-test",
    phase: "candidate-staged",
    candidate: {
      packageVersion: HUNSU_BRIDGE_VERSION,
      runtimePath: join(paths.runtimeVersionsDirectory, HUNSU_BRIDGE_VERSION),
      nodePath: process.execPath,
      cliPath: join(paths.runtimeVersionsDirectory, HUNSU_BRIDGE_VERSION, "node_modules", "@hunsu", "bridge", "dist", "cli.js"),
      installedAt: timestamp
    },
    previous: null,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  try {
    assert.equal(await store.read(), undefined);
    await store.write(transaction);
    assert.deepEqual(await store.read(), transaction);
    await store.clear();
    assert.equal(await store.read(), undefined);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("offline doctor reports an incomplete setup phase without exposing transaction paths", async () => {
  const home = await mkdtemp(join(tmpdir(), "hunsu-setup-doctor-"));
  const paths = resolveHunsuPaths({ home });
  const timestamp = "2026-07-12T00:00:00.000Z";
  try {
    await createSetupTransactionStore(paths).write({
      schema: SETUP_TRANSACTION_SCHEMA,
      transactionId: "doctor-transaction",
      phase: "service-switched",
      candidate: {
        packageVersion: HUNSU_BRIDGE_VERSION,
        runtimePath: join(paths.runtimeVersionsDirectory, HUNSU_BRIDGE_VERSION),
        nodePath: process.execPath,
        cliPath: join(paths.runtimeVersionsDirectory, HUNSU_BRIDGE_VERSION, "node_modules", "@hunsu", "bridge", "dist", "cli.js"),
        installedAt: timestamp
      },
      previous: null,
      createdAt: timestamp,
      updatedAt: timestamp
    });
    const report = await createDoctorReport({ paths, online: false });
    assert.equal(report.state.setupTransactionPhase, "service-switched");
    assert.equal(report.issues.some(issue => issue.code === "SETUP_TRANSACTION_INCOMPLETE"), true);
    const serialized = JSON.stringify(report.issues);
    assert.equal(serialized.includes(paths.home), false);
    assert.equal(serialized.includes(paths.setupTransactionFile), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("setup transaction journal strips unknown fields and rejects malformed candidate paths", async () => {
  const home = await mkdtemp(join(tmpdir(), "hunsu-setup-journal-validation-"));
  const paths = resolveHunsuPaths({ home });
  const store = createSetupTransactionStore(paths);
  const timestamp = "2026-07-12T00:00:00.000Z";
  try {
    const transaction = {
      schema: SETUP_TRANSACTION_SCHEMA,
      transactionId: "strict-transaction",
      phase: "candidate-staged",
      candidate: {
        packageVersion: HUNSU_BRIDGE_VERSION,
        runtimePath: join(paths.runtimeVersionsDirectory, HUNSU_BRIDGE_VERSION),
        nodePath: process.execPath,
        cliPath: join(paths.runtimeVersionsDirectory, HUNSU_BRIDGE_VERSION, "node_modules", "@hunsu", "bridge", "dist", "cli.js"),
        installedAt: timestamp,
        accidentalToken: "hunsu_control_must_not_persist"
      },
      previous: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      accidentalCredential: "private-refresh-token"
    } as unknown as SetupTransaction;
    await store.write(transaction);
    const raw = await readFile(paths.setupTransactionFile, "utf8");
    assert.doesNotMatch(raw, /must_not_persist|private-refresh-token/u);

    const malformed = JSON.parse(raw) as Record<string, unknown>;
    malformed.candidate = {
      packageVersion: HUNSU_BRIDGE_VERSION,
      runtimePath: "relative/runtime",
      nodePath: process.execPath,
      cliPath: "relative/cli.js",
      installedAt: timestamp
    };
    await writeFile(paths.setupTransactionFile, JSON.stringify(malformed), "utf8");
    await assert.rejects(store.read(), /candidate\.runtimePath must be absolute/u);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("runtime package source accepts only the executing exact registry version or an absolute local tarball", () => {
  const registry = executingBridgeRuntimeSource();
  assert.deepEqual(registry, {
    kind: "registry-exact",
    packageName: "@hunsu/bridge",
    version: HUNSU_BRIDGE_VERSION
  });
  assert.equal(runtimePackageSpec(registry), `@hunsu/bridge@${HUNSU_BRIDGE_VERSION}`);

  const tarball = localBridgeTarballSource(join(tmpdir(), "hunsu-bridge.tgz"));
  assert.equal(tarball.kind, "local-tarball");
  assert.equal(runtimePackageSpec(tarball).startsWith("file:"), true);
  assert.throws(() => localBridgeTarballSource("bridge.tgz"), /absolute local \.tgz/u);
  assert.throws(() => localBridgeTarballSource("https://example.com/bridge.tgz"), /absolute local \.tgz/u);
  assert.throws(() => localBridgeTarballSource(join(tmpdir(), "bridge.tar.gz")), /absolute local \.tgz/u);
  assert.throws(
    () => runtimePackageSpec({
      kind: "local-tarball",
      fileUrl: "https://example.com/bridge.tgz",
      expectedVersion: "1.2.3"
    } as RuntimePackageSource),
    /local file URL/u
  );
  assert.throws(
    () => runtimePackageSpec({
      kind: "registry-exact",
      packageName: "@hunsu/bridge",
      version: "next"
    }),
    /exact/u
  );
  if (process.platform !== "win32") {
    assert.throws(() => localBridgeTarballSource("C:\\temp\\bridge.tgz"), /absolute local \.tgz/u);
  }
});
