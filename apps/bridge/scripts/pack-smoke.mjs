import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:net";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const command = name => process.platform === "win32" ? `${name}.cmd` : name;
const expectedFiles = [
  "LICENSE",
  "README.md",
  "dist/cli.js",
  "dist/index.d.ts",
  "dist/index.js",
  "package.json"
];
const forbiddenPackageSegments = new Set([
  "src",
  "test",
  "tests",
  "apps",
  "packages",
  ["bridge", "desktop"].join("-"),
  ["src", "tauri"].join("-")
]);
const forbiddenPrototypeSignatures = [
  ["bridge", "desktop"].join("-"),
  ["src", "tauri"].join("-"),
  `@${["tauri", "apps"].join("-")}`,
  ["tauri", "conf"].join("."),
  ["Tau", "ri"].join(""),
  ["post", "ject"].join("")
];
const forbiddenFixtureSecrets = [
  "account-secret",
  "historical-raw-token",
  "hunsu_bridge_pair_super-secret-value",
  "hunsu_control_raw-control-token",
  "private-refresh-token",
  "raw-access-token",
  "stable-control-token"
];

export async function runBridgePackSmoke(options = {}) {
  const started = performance.now();
  const temporaryRoot = await mkdtemp(join(tmpdir(), "hunsu-bridge-package-"));
  const packDirectory = join(temporaryRoot, "pack");
  const extractDirectory = join(temporaryRoot, "extract");
  const installDirectory = join(temporaryRoot, "install");
  const hunsuHome = join(temporaryRoot, "home");
  let daemon;

  try {
    await Promise.all([
      mkdir(packDirectory, { recursive: true }),
      mkdir(extractDirectory, { recursive: true }),
      mkdir(installDirectory, { recursive: true })
    ]);

    await run(command("pnpm"), ["--filter", "@hunsu/bridge", "build"], {
      cwd: repositoryRoot,
      timeout: 60_000
    });
    await run(command("pnpm"), [
      "--filter",
      "@hunsu/bridge",
      "pack",
      "--pack-destination",
      packDirectory
    ], { cwd: repositoryRoot, timeout: 60_000 });

    const tarballs = (await readdir(packDirectory)).filter(file => file.endsWith(".tgz"));
    assert.deepEqual(tarballs.length, 1, "pnpm pack must produce exactly one Bridge tarball");
    const tarball = join(packDirectory, tarballs[0]);
    const tarballBytes = (await stat(tarball)).size;
    assert.ok(tarballBytes > 0, "the Bridge tarball must not be empty");

    await run("tar", ["-xzf", tarball, "-C", extractDirectory], { timeout: 30_000 });
    const packedRoot = join(extractDirectory, "package");
    const files = (await walkFiles(packedRoot)).sort();
    assert.deepEqual(files, expectedFiles, "the public tarball must contain only the bundled runtime, types, metadata, README, and license");

    const manifest = JSON.parse(await readFile(join(packedRoot, "package.json"), "utf8"));
    auditManifest(manifest);
    await auditPackageContents(packedRoot, files);

    const cleanEnvironment = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith("npm_config_"))
    );
    const npmEnvironment = {
      ...cleanEnvironment,
      npm_config_audit: "false",
      npm_config_cache: join(temporaryRoot, "npm-cache"),
      npm_config_fund: "false",
      npm_config_offline: "true",
      npm_config_update_notifier: "false"
    };
    await run(command("npm"), ["init", "-y"], {
      cwd: installDirectory,
      env: npmEnvironment,
      timeout: 30_000
    });
    await run(command("npm"), [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--offline",
      tarball
    ], { cwd: installDirectory, env: npmEnvironment, timeout: 60_000 });

    const installedRoot = join(installDirectory, "node_modules", "@hunsu", "bridge");
    assert.deepEqual((await walkFiles(installedRoot)).sort(), expectedFiles);

    await assertPublicApiContract(installDirectory, npmEnvironment);

    const versionRun = await run(command("npx"), [
      "--no-install",
      "hunsu-bridge",
      "--version",
      "--json"
    ], { cwd: installDirectory, env: npmEnvironment, timeout: 30_000 });
    const versionResult = parseStrictCliJson(versionRun);
    assertCliSuccess(versionResult);
    assert.equal(versionResult.value?.version, manifest.version);

    daemon = spawn(command("npx"), [
      "--no-install",
      "hunsu-bridge",
      "dev",
      "--port",
      "0",
      "--home",
      hunsuHome,
      "--cwd",
      installDirectory,
      "--json"
    ], {
      cwd: installDirectory,
      env: npmEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    const readiness = await waitForReadyResult(daemon, 20_000);
    const ready = readiness.result;
    auditCapturedOutput(readiness);
    assertCliSuccess(ready);
    assert.equal(ready.value?.version, manifest.version);
    assert.equal(ready.value?.protocolVersion, "local-bridge-v1");
    const endpoint = new URL(String(ready.value?.endpoint));
    assert.equal(endpoint.hostname, "127.0.0.1");
    assert.ok(Number(endpoint.port) > 0);

    const credentials = JSON.parse(await readFile(join(hunsuHome, "credentials.json"), "utf8"));
    const controlToken = String(credentials.controlToken);
    assert.equal(
      /^hunsu_control_[A-Za-z0-9_-]+$/u.test(controlToken),
      true,
      "The generated control credential has an invalid format."
    );
    auditCapturedOutput(readiness, [controlToken]);

    const pairingRun = await run(command("npx"), [
      "--no-install",
      "hunsu-bridge",
      "pair",
      "--home",
      hunsuHome,
      "--json"
    ], { cwd: installDirectory, env: npmEnvironment, timeout: 30_000 });
    const pairingResult = parseStrictCliJson(pairingRun, [controlToken]);
    assertCliSuccess(pairingResult);
    assert.equal(Object.hasOwn(pairingResult.value ?? {}, "pairingUrl"), false);

    const statusRun = await run(command("npx"), [
      "--no-install",
      "hunsu-bridge",
      "status",
      "--home",
      hunsuHome,
      "--json"
    ], { cwd: installDirectory, env: npmEnvironment, timeout: 30_000 });
    const statusResult = parseStrictCliJson(statusRun, [controlToken]);
    assertCliSuccess(statusResult);
    assert.equal(statusResult.value?.endpoint, endpoint.toString().replace(/\/$/u, ""));
    assert.equal(statusResult.value?.version, manifest.version);

    const stopRun = await run(process.execPath, [
      "--input-type=module",
      "--eval",
      authenticatedShutdownProgram
    ], {
      cwd: installDirectory,
      env: { ...npmEnvironment, HUNSU_HOME: hunsuHome },
      timeout: 30_000
    });
    const stopResult = parseStrictCliJson(stopRun, [controlToken]);
    assertCliSuccess(stopResult);
    await waitForExit(daemon, 10_000);
    auditCapturedOutput(readiness, [controlToken]);
    readiness.stop();
    assert.equal(daemon.exitCode, 0, "the foreground daemon must exit cleanly after authenticated shutdown");
    daemon = undefined;
    await assertPortReleased(endpoint.hostname, Number(endpoint.port));

    if (options.outputDirectory) {
      const outputDirectory = resolve(options.outputDirectory);
      await mkdir(outputDirectory, { recursive: true });
      await copyFile(tarball, join(outputDirectory, basename(tarball)));
    }

    return {
      packageName: manifest.name,
      version: manifest.version,
      nodeEngine: manifest.engines.node,
      tarballBytes,
      files,
      endpoint: endpoint.toString().replace(/\/$/u, ""),
      durationMs: Math.round(performance.now() - started)
    };
  } finally {
    if (daemon && daemon.exitCode === null) {
      daemon.kill("SIGTERM");
      await waitForExit(daemon, 2_000).catch(() => {
        daemon?.kill("SIGKILL");
      });
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function auditManifest(manifest) {
  assert.equal(manifest.name, "@hunsu/bridge");
  assert.equal(manifest.version, "0.2.0-next.0");
  assert.equal(manifest.private, false);
  assert.equal(manifest.type, "module");
  assert.deepEqual(manifest.repository, {
    type: "git",
    url: "git+https://github.com/lhj6102/hunsu.git",
    directory: "apps/bridge"
  });
  assert.deepEqual(manifest.bin, { "hunsu-bridge": "./dist/cli.js" });
  assert.equal(manifest.engines?.node, ">=22.18");
  assertNodeEngineSupported(process.versions.node);
  assert.deepEqual(manifest.exports, {
    ".": {
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
      default: "./dist/index.js"
    }
  });
  assert.equal(manifest.dependencies, undefined, "the bundled package must not install workspace runtime dependencies");
  assert.equal(manifest.optionalDependencies, undefined);
  assert.equal(manifest.peerDependencies, undefined);
  const serialized = JSON.stringify(manifest);
  assert.doesNotMatch(serialized, /workspace:|\blink:|file:\.\.\/\.\.\//u);
  assert.doesNotMatch(JSON.stringify(manifest.exports), /(?:^|\/)src(?:\/|$)|(?<!\.d)\.ts(?:"|$)/u);
}

async function auditPackageContents(root, files) {
  for (const file of files) {
    const segments = file.split("/");
    assert.equal(
      segments.some(segment => forbiddenPackageSegments.has(segment.toLowerCase())),
      false,
      `${file} contains a forbidden source, test, workspace, or retired-prototype segment`
    );
    const contents = await readFile(join(root, ...file.split("/")), "utf8");
    for (const signature of forbiddenPrototypeSignatures) {
      assert.equal(contents.toLowerCase().includes(signature.toLowerCase()), false, `${file} contains retired prototype content`);
    }
    for (const secret of forbiddenFixtureSecrets) {
      assert.equal(contents.includes(secret), false, `${file} contains a test credential fixture`);
    }
    if (file.endsWith(".js")) auditRuntimeImports(contents, file);
  }
}

function auditRuntimeImports(contents, file) {
  assert.equal(contents.includes(repositoryRoot), false, `${file} must not embed the repository path`);
  assert.doesNotMatch(contents, /sourceMappingURL=/u);
  assert.doesNotMatch(contents, /\/packages\/[^/]+\/src\/|\/apps\/bridge\/src\//u);
  const imports = [
    ...Array.from(contents.matchAll(/\bfrom["']([^"']+)["']/gu), match => match[1]),
    ...Array.from(contents.matchAll(/\bimport\(["']([^"']+)["']\)/gu), match => match[1])
  ];
  for (const specifier of imports) {
    assert.match(specifier, /^node:/u, `${file} has an unbundled runtime import: ${specifier}`);
  }
}

function assertNodeEngineSupported(version) {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  assert.ok(major > 22 || (major === 22 && minor >= 18), `package smoke requires Node >=22.18, received ${version}`);
}

function assertCliSuccess(result) {
  assert.equal(result.schema, "hunsu.bridge.cli-result.v1");
  assert.equal(result.ok, true, result.message ?? "Bridge CLI command failed");
  assert.equal(result.code, "OK");
}

function parseStrictCliJson(output, secrets = []) {
  auditCapturedOutput(output, secrets);
  assert.equal(output.stderr.trim() === "", true, "Bridge CLI JSON mode wrote to stderr.");
  const lines = output.stdout.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  assert.equal(lines.length === 1, true, "Bridge CLI JSON mode must emit exactly one stdout line.");
  let value;
  try {
    value = JSON.parse(lines[0]);
  } catch (_error) {
    assert.fail("Bridge CLI JSON mode emitted invalid JSON.");
  }
  assert.equal(value?.schema === "hunsu.bridge.cli-result.v1", true, "Bridge CLI emitted the wrong result schema.");
  return value;
}

function auditCapturedOutput(output, secrets = []) {
  const combined = `${output.stdout}\n${output.stderr}`;
  assert.equal(/hunsuBridgeToken=/u.test(combined), false, "Captured output contains a token-bearing browser URL.");
  assert.equal(/hunsu_(?:control|bridge_pair)_[A-Za-z0-9_-]{8,}/u.test(combined), false, "Captured output contains a raw Bridge credential.");
  for (const secret of secrets) {
    assert.equal(combined.includes(secret), false, "Captured output contains a generated credential.");
  }
}

async function assertPublicApiContract(installDirectory, environment) {
  const runtimeProgram = `
    import * as bridge from "@hunsu/bridge";
    process.stdout.write(JSON.stringify(Object.keys(bridge).sort()) + "\\n");
  `;
  const runtime = await run(process.execPath, ["--input-type=module", "--eval", runtimeProgram], {
    cwd: installDirectory,
    env: environment,
    timeout: 30_000
  });
  assert.equal(runtime.stderr.trim(), "");
  assert.deepEqual(JSON.parse(runtime.stdout), [
    "BRIDGE_CLI_RESULT_SCHEMA",
    "HUNSU_BRIDGE_PROTOCOL_VERSION",
    "HUNSU_BRIDGE_VERSION",
    "createBridgeControlClient",
    "resolveHunsuHome",
    "resolveHunsuPaths",
    "runBridgeCli",
    "startBridgeDaemon"
  ]);

  const consumer = `
    import {
      BRIDGE_CLI_RESULT_SCHEMA,
      HUNSU_BRIDGE_PROTOCOL_VERSION,
      HUNSU_BRIDGE_VERSION,
      createBridgeControlClient,
      resolveHunsuHome,
      resolveHunsuPaths,
      runBridgeCli,
      startBridgeDaemon,
      type BridgeCliResult,
      type BridgeControlClient,
      type BridgeControlRequest,
      type BridgeDaemonOptions,
      type BridgeHealth,
      type BridgeRuntimeIdentity,
      type HunsuPaths,
      type RelaySocket,
      type RunningBridgeDaemon
    } from "@hunsu/bridge";

    const home: string = resolveHunsuHome({ home: "/tmp/hunsu-api-contract" });
    const paths: HunsuPaths = resolveHunsuPaths({ home });
    const client: BridgeControlClient = createBridgeControlClient({ paths, timeoutMs: 10 });
    const request: BridgeControlRequest = { method: "GET", timeoutMs: 10 };
    const options: BridgeDaemonOptions = { home, host: "127.0.0.1", port: 0, development: true };
    const health: Promise<BridgeHealth | undefined> = client.health();
    const status: Promise<BridgeCliResult<BridgeRuntimeIdentity>> = client.request("/v1/control/status", request);
    const daemon: Promise<RunningBridgeDaemon> = startBridgeDaemon(options);
    const socket: RelaySocket | undefined = undefined;
    const exitCode: Promise<number> = runBridgeCli(["--version", "--json"]);
    void [BRIDGE_CLI_RESULT_SCHEMA, HUNSU_BRIDGE_PROTOCOL_VERSION, HUNSU_BRIDGE_VERSION, health, status, daemon, socket, exitCode];
  `;
  const consumerPath = join(installDirectory, "bridge-consumer.ts");
  await writeFile(consumerPath, consumer, "utf8");
  await run(process.execPath, [
    join(repositoryRoot, "node_modules", "typescript", "bin", "tsc"),
    "--noEmit",
    "--strict",
    "--target", "ES2022",
    "--module", "NodeNext",
    "--moduleResolution", "NodeNext",
    "--lib", "ES2022,DOM",
    consumerPath
  ], { cwd: installDirectory, env: environment, timeout: 30_000 });
}

async function walkFiles(root, current = root) {
  const files = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(root, path));
    else if (entry.isFile()) files.push(relative(root, path).split(sep).join("/"));
  }
  return files;
}

async function run(executable, args, options = {}) {
  try {
    const result = await execFileAsync(executable, args, {
      ...options,
      encoding: "utf8",
      maxBuffer: 20 * 1_024 * 1_024,
      windowsHide: true
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const exitCode = typeof error?.code === "number" ? error.code : "unknown";
    throw new Error(`Package-smoke subprocess failed with exit code ${exitCode}.`);
  }
}

function waitForReadyResult(child, timeoutMs) {
  return new Promise((resolveReady, rejectReady) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      cleanupCapture();
      rejectReady(new Error("Timed out waiting for packed Bridge daemon readiness."));
    }, timeoutMs);
    const onStdout = chunk => {
      stdout += chunk.toString();
      for (const line of stdout.split(/\r?\n/u)) {
        try {
          const value = JSON.parse(line);
          if (value?.schema === "hunsu.bridge.cli-result.v1") {
            cleanupReadyWait();
            resolveReady({
              result: value,
              get stdout() { return stdout; },
              get stderr() { return stderr; },
              stop: cleanupCapture
            });
            return;
          }
        } catch (_error) {
          // Wait for a complete JSON line.
        }
      }
    };
    const onStderr = chunk => { stderr += chunk.toString(); };
    const onExit = (code, signal) => {
      cleanupCapture();
      rejectReady(new Error(`Packed Bridge daemon exited before readiness (${code ?? signal}).`));
    };
    const cleanupReadyWait = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
    };
    const cleanupCapture = () => {
      cleanupReadyWait();
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
    };
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.once("exit", onExit);
  });
}

function waitForExit(child, timeoutMs) {
  if ((child.exitCode !== null || child.signalCode !== null)
    && child.stdout?.readableEnded !== false
    && child.stderr?.readableEnded !== false) return Promise.resolve();
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      child.off("close", onClose);
      rejectExit(new Error("Timed out waiting for the packed Bridge daemon to exit."));
    }, timeoutMs);
    const onClose = () => {
      clearTimeout(timer);
      resolveExit();
    };
    child.once("close", onClose);
  });
}

async function assertPortReleased(host, port) {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  await new Promise((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose()));
}

const authenticatedShutdownProgram = `
import { createBridgeControlClient, resolveHunsuPaths } from "@hunsu/bridge";
const paths = resolveHunsuPaths({ home: process.env.HUNSU_HOME });
const result = await createBridgeControlClient({ paths }).request("/v1/control/shutdown", { method: "POST" });
process.stdout.write(JSON.stringify(result) + "\\n");
if (!result.ok) process.exitCode = 1;
`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runBridgePackSmoke().then(result => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
