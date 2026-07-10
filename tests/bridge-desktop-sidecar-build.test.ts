import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type SidecarTarget = {
  target: string;
  platform: string;
  arch: string;
  extension: string;
};

type CommandRunner = (command: string, args: string[], options?: { cwd?: string }) => unknown;
type VersionRunner = (command: string, args: string[], options?: { cwd?: string }) => {
  stdout: string;
  stderr: string;
};

type SidecarManifest = {
  schema: string;
  target: string;
  artifacts: Array<{ target: string; file: string; kind: string }>;
};

type SidecarBuilderModule = {
  buildNativeSidecars(options?: {
    bundleOnly?: boolean;
    nodeVersion?: string;
    seaNodePath?: string;
    distDir?: string;
    nativeDir?: string;
    cacheDir?: string;
    dependencies?: {
      versionRunner?: VersionRunner;
      commandRunner?: CommandRunner;
      bundleSidecar?: (bundlePath: string) => Promise<string>;
      createSeaBlob?: (input: { nodeExecutable: string; bundlePath: string; blobPath: string; seaConfigPath: string }) => string;
    };
  }): Promise<unknown>;
  createSeaBlob(input: {
    nodeExecutable?: string;
    bundlePath: string;
    blobPath: string;
    seaConfigPath?: string;
    runner?: CommandRunner;
  }): string;
  finalizeNativeSidecar(input: {
    artifactPath: string;
    blobPath: string;
    bundlePath: string;
    distDir?: string;
    nativeDir: string;
    target: SidecarTarget;
    runner?: CommandRunner;
    hostPlatform?: string;
    validateArtifact?: (artifactPath: string) => void;
    prepareSidecars?: (input: { nativeDir: string; target: string }) => SidecarManifest;
    smokeTest?: (input: { bundlePath: string; manifest: SidecarManifest }) => void;
  }): SidecarManifest;
  normalizeNodeVersion(version: string): string;
  resolveSeaBuilderNodeExecutable(input: {
    configuredNodeVersion: string;
    nodeExecutable?: string;
    runner?: VersionRunner;
  }): string;
  signInjectedMacOsSidecar(input: {
    artifactPath: string;
    target: SidecarTarget;
    runner?: CommandRunner;
    hostPlatform?: string;
  }): void;
};

const sidecarBuilder = await import(
  new URL("../apps/bridge-desktop/scripts/build-native-sidecars.mjs", import.meta.url).href
) as SidecarBuilderModule;

const darwinTarget: SidecarTarget = {
  target: "aarch64-apple-darwin",
  platform: "darwin",
  arch: "arm64",
  extension: ""
};

const linuxTarget: SidecarTarget = {
  target: "x86_64-unknown-linux-gnu",
  platform: "linux",
  arch: "x64",
  extension: ""
};

test("SEA builder defaults to process.execPath and accepts the exact Node version", () => {
  const resolved = sidecarBuilder.resolveSeaBuilderNodeExecutable({
    configuredNodeVersion: "22.22.0",
    runner(command, args) {
      assert.equal(command, process.execPath);
      assert.deepEqual(args, ["--version"]);
      return { stdout: "v22.22.0\n", stderr: "" };
    }
  });

  assert.equal(resolved, process.execPath);
});

test("SEA builder normalizes a leading v on both configured and reported versions", () => {
  assert.equal(sidecarBuilder.normalizeNodeVersion(" v22.22.0\n"), "22.22.0");
  assert.equal(sidecarBuilder.resolveSeaBuilderNodeExecutable({
    configuredNodeVersion: "v22.22.0",
    runner: () => ({ stdout: "v22.22.0\n", stderr: "" })
  }), process.execPath);
});

test("SEA builder rejects a version mismatch before bundle or blob generation", async () => {
  const operations: string[] = [];

  await assert.rejects(sidecarBuilder.buildNativeSidecars({
    bundleOnly: true,
    nodeVersion: "22.22.0",
    dependencies: {
      versionRunner: () => ({ stdout: "v22.21.0\n", stderr: "" }),
      commandRunner: () => operations.push("postject"),
      bundleSidecar: async bundlePath => {
        operations.push("bundle");
        return bundlePath;
      },
      createSeaBlob: input => {
        operations.push("blob");
        return input.blobPath;
      }
    }
  }), error => {
    assert.match(String(error), /SEA builder Node is 22\.21\.0, but the embedded runtime is 22\.22\.0/);
    assert.match(String(error), /HUNSU_BRIDGE_SEA_NODE_PATH/);
    return true;
  });
  assert.deepEqual(operations, []);
});

test("SEA builder uses an explicitly configured matching Node executable", async () => {
  const explicitNode = "/opt/node-22.22.0/bin/node";
  const operations: string[] = [];

  await sidecarBuilder.buildNativeSidecars({
    bundleOnly: true,
    nodeVersion: "22.22.0",
    seaNodePath: explicitNode,
    dependencies: {
      versionRunner(command) {
        assert.equal(command, explicitNode);
        return { stdout: "v22.22.0\n", stderr: "" };
      },
      bundleSidecar: async bundlePath => {
        operations.push("bundle");
        return bundlePath;
      },
      createSeaBlob: input => {
        assert.equal(input.nodeExecutable, explicitNode);
        operations.push("blob");
        return input.blobPath;
      }
    }
  });

  assert.deepEqual(operations, ["bundle", "blob"]);
});

test("SEA builder routes bundle-only output through an explicit dist directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-sea-dist-test-"));
  const distDir = join(root, "dist");
  try {
    await sidecarBuilder.buildNativeSidecars({
      bundleOnly: true,
      nodeVersion: "22.22.0",
      distDir,
      nativeDir: join(root, "native"),
      cacheDir: join(root, "cache"),
      dependencies: {
        versionRunner: () => ({ stdout: "v22.22.0\n", stderr: "" }),
        bundleSidecar: async bundlePath => {
          assert.equal(bundlePath, join(distDir, "sidecar-bundle.cjs"));
          return bundlePath;
        },
        createSeaBlob: input => {
          assert.equal(input.blobPath, join(distDir, "hunsu-bridge-sidecar.blob"));
          assert.equal(input.seaConfigPath, join(distDir, "sidecar-sea-config.json"));
          return input.blobPath;
        }
      }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SEA builder rejects an explicitly configured mismatched Node executable", () => {
  const explicitNode = "/opt/node-22.21.0/bin/node";
  assert.throws(() => sidecarBuilder.resolveSeaBuilderNodeExecutable({
    configuredNodeVersion: "22.22.0",
    nodeExecutable: explicitNode,
    runner(command) {
      assert.equal(command, explicitNode);
      return { stdout: "v22.21.0\n", stderr: "" };
    }
  }), /SEA builder Node is 22\.21\.0, but the embedded runtime is 22\.22\.0/);
});

test("HUNSU_BRIDGE_SIDECAR_NODE_VERSION overrides still require an exact SEA builder match", async () => {
  const previousVersion = process.env.HUNSU_BRIDGE_SIDECAR_NODE_VERSION;
  const previousSeaNodePath = process.env.HUNSU_BRIDGE_SEA_NODE_PATH;
  const operations: string[] = [];
  process.env.HUNSU_BRIDGE_SIDECAR_NODE_VERSION = "22.23.0";
  process.env.HUNSU_BRIDGE_SEA_NODE_PATH = "/opt/node-22.22.0/bin/node";
  try {
    await assert.rejects(sidecarBuilder.buildNativeSidecars({
      bundleOnly: true,
      dependencies: {
        versionRunner(command) {
          assert.equal(command, "/opt/node-22.22.0/bin/node");
          return { stdout: "v22.22.0\n", stderr: "" };
        },
        bundleSidecar: async bundlePath => {
          operations.push("bundle");
          return bundlePath;
        },
        createSeaBlob: input => {
          operations.push("blob");
          return input.blobPath;
        }
      }
    }), /SEA builder Node is 22\.22\.0, but the embedded runtime is 22\.23\.0/);
    assert.deepEqual(operations, []);
  } finally {
    if (previousVersion === undefined) delete process.env.HUNSU_BRIDGE_SIDECAR_NODE_VERSION;
    else process.env.HUNSU_BRIDGE_SIDECAR_NODE_VERSION = previousVersion;
    if (previousSeaNodePath === undefined) delete process.env.HUNSU_BRIDGE_SEA_NODE_PATH;
    else process.env.HUNSU_BRIDGE_SEA_NODE_PATH = previousSeaNodePath;
  }
});

test("createSeaBlob invokes the explicitly supplied Node executable", () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-sea-config-test-"));
  const seaConfigPath = join(root, "sea-config.json");
  const calls: Array<{ command: string; args: string[] }> = [];
  try {
    const blobPath = join(root, "sidecar.blob");
    sidecarBuilder.createSeaBlob({
      nodeExecutable: "/opt/matching-node/bin/node",
      bundlePath: join(root, "bundle.cjs"),
      blobPath,
      seaConfigPath,
      runner(command, args) {
        calls.push({ command, args });
      }
    });

    assert.deepEqual(calls, [{
      command: "/opt/matching-node/bin/node",
      args: ["--experimental-sea-config", seaConfigPath]
    }]);
    assert.equal(JSON.parse(readFileSync(seaConfigPath, "utf8")).output, blobPath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Darwin sidecar finalization orders postject, sign, verify, validation, and smoke", () => {
  const fixture = createArtifactFixture();
  const operations: string[] = [];
  const codesignCalls: Array<{ command: string; args: string[] }> = [];
  const manifest = testManifest(darwinTarget);
  try {
    sidecarBuilder.finalizeNativeSidecar({
      ...fixture,
      target: darwinTarget,
      hostPlatform: "darwin",
      runner(command, args) {
        if (command === "codesign") {
          const operation = args[0] === "--force" ? "sign" : "verify";
          operations.push(operation);
          codesignCalls.push({ command, args });
          return;
        }
        assert.match(args[0] ?? "", /postject/);
        operations.push("postject");
      },
      validateArtifact: () => operations.push("validate"),
      prepareSidecars: () => {
        operations.push("prepare");
        return manifest;
      },
      smokeTest: () => operations.push("smoke")
    });

    assert.deepEqual(operations, ["postject", "sign", "verify", "validate", "prepare", "smoke"]);
    assert.deepEqual(
      operations.filter(operation => operation !== "prepare"),
      ["postject", "sign", "verify", "validate", "smoke"]
    );
    assert.deepEqual(codesignCalls, [
      {
        command: "codesign",
        args: ["--force", "--sign", "-", "--timestamp=none", fixture.artifactPath]
      },
      {
        command: "codesign",
        args: ["--verify", "--strict", "--verbose=2", fixture.artifactPath]
      }
    ]);
  } finally {
    fixture.cleanup();
  }
});

test("non-Darwin sidecars do not invoke codesign", () => {
  let commandCount = 0;
  sidecarBuilder.signInjectedMacOsSidecar({
    artifactPath: "/tmp/hunsu-linux-sidecar",
    target: linuxTarget,
    hostPlatform: "linux",
    runner: () => {
      commandCount += 1;
    }
  });
  assert.equal(commandCount, 0);
});

test("Darwin sidecar signing failure stops finalization", () => {
  const fixture = createArtifactFixture();
  const operations: string[] = [];
  try {
    assert.throws(() => sidecarBuilder.finalizeNativeSidecar({
      ...fixture,
      target: darwinTarget,
      hostPlatform: "darwin",
      runner(command, args) {
        if (command !== "codesign") {
          operations.push("postject");
          return;
        }
        operations.push(args[0] === "--force" ? "sign" : "verify");
        if (args[0] === "--force") throw new Error("signing failed");
      },
      validateArtifact: () => operations.push("validate"),
      prepareSidecars: () => testManifest(darwinTarget),
      smokeTest: () => operations.push("smoke")
    }), /signing failed/);
    assert.deepEqual(operations, ["postject", "sign"]);
  } finally {
    fixture.cleanup();
  }
});

test("Darwin sidecar signature verification failure stops finalization", () => {
  const fixture = createArtifactFixture();
  const operations: string[] = [];
  try {
    assert.throws(() => sidecarBuilder.finalizeNativeSidecar({
      ...fixture,
      target: darwinTarget,
      hostPlatform: "darwin",
      runner(command, args) {
        if (command !== "codesign") {
          operations.push("postject");
          return;
        }
        const operation = args[0] === "--force" ? "sign" : "verify";
        operations.push(operation);
        if (operation === "verify") throw new Error("verification failed");
      },
      validateArtifact: () => operations.push("validate"),
      prepareSidecars: () => testManifest(darwinTarget),
      smokeTest: () => operations.push("smoke")
    }), /verification failed/);
    assert.deepEqual(operations, ["postject", "sign", "verify"]);
  } finally {
    fixture.cleanup();
  }
});

test("Darwin sidecars require a Darwin signing host", () => {
  assert.throws(() => sidecarBuilder.signInjectedMacOsSidecar({
    artifactPath: "/tmp/hunsu-macos-sidecar",
    target: darwinTarget,
    hostPlatform: "linux",
    runner: () => assert.fail("codesign must not run on a non-Darwin host")
  }), /must be signed on a Darwin host/);
});

function createArtifactFixture() {
  const root = mkdtempSync(join(tmpdir(), "hunsu-sidecar-finalize-test-"));
  const artifactPath = join(root, "hunsu-bridge-sidecar-aarch64-apple-darwin");
  writeFileSync(artifactPath, Buffer.alloc(4096));
  return {
    artifactPath,
    blobPath: join(root, "sidecar.blob"),
    bundlePath: join(root, "bundle.cjs"),
    nativeDir: root,
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

function testManifest(target: SidecarTarget): SidecarManifest {
  return {
    schema: "hunsu.bridge-sidecars.v1",
    target: target.target,
    artifacts: [{
      target: target.target,
      file: `hunsu-bridge-sidecar-${target.target}${target.extension}`,
      kind: "native-executable"
    }]
  };
}
