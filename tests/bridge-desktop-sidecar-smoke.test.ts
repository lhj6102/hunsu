import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const linuxTarget = "x86_64-unknown-linux-gnu";

type SmokeRunnerOptions = {
  cwd: string;
  encoding: string;
  timeout: number;
  windowsHide: boolean;
  env: NodeJS.ProcessEnv;
};

type SmokeRunnerResult = {
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
  status?: number | null;
  error?: Error & { code?: string };
};

type SmokeInput = {
  target: string;
  sidecar: string;
  runnerPlatform?: NodeJS.Platform;
  runnerArch?: string;
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  temporaryRoot?: string;
  logger?: (message: string) => void;
  writeOutput?: (value: string) => void;
  runner?: (command: string, args: string[], options: SmokeRunnerOptions) => SmokeRunnerResult;
  makeTemporaryDirectory?: (prefix: string) => string;
  removeTemporaryDirectory?: (directory: string) => void;
};

type SmokeResult = {
  target: string;
  executable: string;
  elapsedMs: number;
  stdout: string;
  stderr: string;
  stateDirectory: string;
};

type SidecarSmokeModule = {
  defaultSmokeTimeoutMs: number;
  smokeNativeSidecar(input: SmokeInput): SmokeResult;
};

const sidecarSmoke = await import(
  new URL("../apps/bridge-desktop/scripts/smoke-native-sidecar.mjs", import.meta.url).href
) as SidecarSmokeModule;

type SidecarFixture = {
  root: string;
  executable: string;
  temporaryRoot: string;
};

function createSidecarFixture(name: string): SidecarFixture {
  const root = mkdtempSync(join(tmpdir(), `hunsu-sidecar-smoke-${name}-`));
  const executable = join(root, `hunsu-bridge-sidecar-${linuxTarget}`);
  const temporaryRoot = join(root, "temporary-state");
  writeFileSync(executable, "fixture", "utf8");
  mkdirSync(temporaryRoot);
  return { root, executable, temporaryRoot };
}

function matchingInput(
  fixture: SidecarFixture,
  runner: NonNullable<SmokeInput["runner"]>
): SmokeInput {
  return {
    target: linuxTarget,
    sidecar: fixture.executable,
    runnerPlatform: "linux",
    runnerArch: "x64",
    temporaryRoot: fixture.temporaryRoot,
    runner
  };
}

function assertTemporaryRootIsEmpty(fixture: SidecarFixture): void {
  assert.deepEqual(readdirSync(fixture.temporaryRoot), []);
}

test("native sidecar smoke runs status exactly once with isolated state and default spawn options", () => {
  const fixture = createSidecarFixture("success");
  const cwd = join(fixture.root, "working-directory");
  const calls: Array<{ command: string; args: string[]; options: SmokeRunnerOptions }> = [];
  const logs: string[] = [];
  const output: string[] = [];
  const stdout = "Hunsu Bridge\r\nStatus:\r\n  Local Bridge: running\r\n";

  try {
    const result = sidecarSmoke.smokeNativeSidecar({
      ...matchingInput(fixture, (command, args, options) => {
        calls.push({ command, args, options });
        return { status: 0, stdout, stderr: "" };
      }),
      cwd,
      env: {
        PASSTHROUGH: "preserved",
        HUNSU_BRIDGE_APP_STATE_PATH: "/unsafe/shared-state.json",
        HUNSU_ROADMAP_REGISTRY_PATH: "/unsafe/shared-roadmaps.json"
      },
      logger: message => logs.push(message),
      writeOutput: value => output.push(value)
    });

    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.ok(call);
    assert.equal(call.command, fixture.executable);
    assert.deepEqual(call.args, ["status"]);
    assert.equal(call.options.cwd, cwd);
    assert.equal(call.options.encoding, "utf8");
    assert.equal(call.options.timeout, sidecarSmoke.defaultSmokeTimeoutMs);
    assert.equal(call.options.timeout, 60_000);
    assert.equal(call.options.windowsHide, true);
    assert.equal(call.options.env.PASSTHROUGH, "preserved");

    const expectedStatePaths = {
      HUNSU_BRIDGE_APP_STATE_PATH: join(result.stateDirectory, "state.json"),
      HUNSU_ROADMAP_REGISTRY_PATH: join(result.stateDirectory, "roadmaps.json"),
      HUNSU_BRIDGE_CREDENTIAL_PATH: join(result.stateDirectory, "credentials.json"),
      HUNSU_RELAY_REGISTRY_PATH: join(result.stateDirectory, "relay.json"),
      HUNSU_BRIDGE_APP_LOG_PATH: join(result.stateDirectory, "bridge-app.log")
    };
    for (const [key, expectedPath] of Object.entries(expectedStatePaths)) {
      assert.equal(call.options.env[key], expectedPath);
      assert.equal(dirname(expectedPath), result.stateDirectory);
    }

    assert.equal(result.target, linuxTarget);
    assert.equal(result.executable, fixture.executable);
    assert.equal(result.stdout, stdout);
    assert.equal(result.stderr, "");
    assert.deepEqual(output, [stdout]);
    assert.deepEqual(logs.slice(0, 3), [
      `[sidecar-smoke] target=${linuxTarget}`,
      `[sidecar-smoke] executable=${fixture.executable}`,
      "[sidecar-smoke] starting status command"
    ]);
    assert.match(logs.at(-1) ?? "", /^\[sidecar-smoke\] completed in \d+\.\d+s$/u);
    assert.equal(existsSync(result.stateDirectory), false);
    assertTemporaryRootIsEmpty(fixture);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("native sidecar smoke reports a nonzero status and captured process output", () => {
  const fixture = createSidecarFixture("nonzero");
  try {
    assert.throws(
      () => sidecarSmoke.smokeNativeSidecar(matchingInput(fixture, () => ({
        status: 23,
        stdout: "partial stdout\n",
        stderr: "fatal stderr\n"
      }))),
      error => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /exited with code 23 while running `status`/u);
        assert.match(error.message, new RegExp(`Target: ${linuxTarget}`, "u"));
        assert.ok(error.message.includes(`Executable: ${fixture.executable}`));
        assert.match(error.message, /Captured stdout:\npartial stdout/u);
        assert.match(error.message, /Captured stderr:\nfatal stderr/u);
        return true;
      }
    );
    assertTemporaryRootIsEmpty(fixture);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("native sidecar smoke reports ETIMEDOUT with target, executable, and captured output", () => {
  const fixture = createSidecarFixture("timeout");
  const timeoutError = Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT" });
  try {
    assert.throws(
      () => sidecarSmoke.smokeNativeSidecar({
        ...matchingInput(fixture, () => ({
          status: null,
          error: timeoutError,
          stdout: Buffer.from("status began\n", "utf8"),
          stderr: "status stalled\n"
        })),
        timeoutMs: 1_234
      }),
      error => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /timed out after 1234 ms while running `status`/u);
        assert.match(error.message, new RegExp(`Target: ${linuxTarget}`, "u"));
        assert.ok(error.message.includes(`Executable: ${fixture.executable}`));
        assert.match(error.message, /Captured stdout:\nstatus began/u);
        assert.match(error.message, /Captured stderr:\nstatus stalled/u);
        return true;
      }
    );
    assertTemporaryRootIsEmpty(fixture);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("native sidecar smoke reports non-timeout spawn errors and cleans isolated state", () => {
  const fixture = createSidecarFixture("spawn-error");
  const spawnError = Object.assign(new Error("spawn EACCES"), { code: "EACCES" });
  try {
    assert.throws(
      () => sidecarSmoke.smokeNativeSidecar(matchingInput(fixture, () => ({
        status: null,
        error: spawnError,
        stdout: "spawn stdout\n",
        stderr: "spawn stderr\n"
      }))),
      error => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /failed to spawn while running `status`/u);
        assert.match(error.message, /Reason: spawn EACCES/u);
        assert.match(error.message, /Captured stdout:\nspawn stdout/u);
        assert.match(error.message, /Captured stderr:\nspawn stderr/u);
        return true;
      }
    );
    assertTemporaryRootIsEmpty(fixture);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("native sidecar smoke rejects successful process output missing a status marker", () => {
  const fixture = createSidecarFixture("malformed");
  try {
    assert.throws(
      () => sidecarSmoke.smokeNativeSidecar(matchingInput(fixture, () => ({
        status: 0,
        stdout: "Hunsu Bridge\nStatus:\n  Something Else: running\n",
        stderr: "unexpected shape\n"
      }))),
      error => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /status output is missing expected Hunsu Bridge markers/u);
        assert.match(error.message, /Captured stdout:\nHunsu Bridge\nStatus:/u);
        assert.match(error.message, /Captured stderr:\nunexpected shape/u);
        return true;
      }
    );
    assertTemporaryRootIsEmpty(fixture);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("native sidecar smoke rejects a missing target executable before invoking the runner", () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-sidecar-smoke-missing-"));
  const executable = join(root, `hunsu-bridge-sidecar-${linuxTarget}`);
  let runnerCalls = 0;
  let temporaryDirectoryCalls = 0;
  try {
    assert.throws(() => sidecarSmoke.smokeNativeSidecar({
      target: linuxTarget,
      sidecar: executable,
      runnerPlatform: "linux",
      runnerArch: "x64",
      runner: () => {
        runnerCalls += 1;
        return { status: 0, stdout: "", stderr: "" };
      },
      makeTemporaryDirectory: prefix => {
        temporaryDirectoryCalls += 1;
        return prefix;
      }
    }), error => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, `Expected native sidecar is missing: ${executable}`);
      return true;
    });
    assert.equal(runnerCalls, 0);
    assert.equal(temporaryDirectoryCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native sidecar smoke rejects unsupported targets and incorrect target filenames", () => {
  const fixture = createSidecarFixture("target-validation");
  try {
    assert.throws(() => sidecarSmoke.smokeNativeSidecar({
      target: "unsupported-target",
      sidecar: fixture.executable
    }), /Unsupported sidecar target: unsupported-target/u);

    assert.throws(() => sidecarSmoke.smokeNativeSidecar({
      target: linuxTarget,
      sidecar: join(fixture.root, "renamed-sidecar"),
      runnerPlatform: "linux",
      runnerArch: "x64"
    }), new RegExp(`Expected sidecar filename hunsu-bridge-sidecar-${linuxTarget}, found renamed-sidecar`, "u"));
    assertTemporaryRootIsEmpty(fixture);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("native sidecar smoke rejects a target and runner architecture mismatch", () => {
  const fixture = createSidecarFixture("runner-mismatch");
  let runnerCalls = 0;
  try {
    assert.throws(() => sidecarSmoke.smokeNativeSidecar({
      ...matchingInput(fixture, () => {
        runnerCalls += 1;
        return { status: 0, stdout: "", stderr: "" };
      }),
      runnerArch: "arm64"
    }), error => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        `Sidecar target ${linuxTarget} requires linux/x64, but this runner is linux/arm64.`
      );
      return true;
    });
    assert.equal(runnerCalls, 0);
    assertTemporaryRootIsEmpty(fixture);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("native sidecar smoke removes temporary state when logging throws", () => {
  const fixture = createSidecarFixture("throwing-logger");
  let runnerCalls = 0;
  try {
    assert.throws(() => sidecarSmoke.smokeNativeSidecar({
      ...matchingInput(fixture, () => {
        runnerCalls += 1;
        return { status: 0, stdout: "", stderr: "" };
      }),
      logger: () => {
        throw new Error("logger exploded");
      }
    }), /logger exploded/u);
    assert.equal(runnerCalls, 0);
    assertTemporaryRootIsEmpty(fixture);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
