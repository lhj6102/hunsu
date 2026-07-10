import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

type SidecarBuildResult = {
  artifacts: Array<{ target: string }>;
  preparedManifest: {
    target: string;
    artifacts: Array<{ target: string; file: string; kind: string }>;
  };
};

type PrepareDesktopSidecar = (options: {
  platform?: NodeJS.Platform;
  arch?: string;
  distDir?: string;
  buildSidecars?: (options: { target: string; distDir: string }) => Promise<SidecarBuildResult>;
}) => Promise<SidecarBuildResult>;

const sidecarNames = [
  "hunsu-bridge-sidecar",
  "hunsu-bridge-sidecar.exe",
  "hunsu-bridge-sidecar-x86_64-apple-darwin",
  "hunsu-bridge-sidecar-aarch64-apple-darwin",
  "hunsu-bridge-sidecar-x86_64-unknown-linux-gnu",
  "hunsu-bridge-sidecar-aarch64-unknown-linux-gnu",
  "hunsu-bridge-sidecar-x86_64-pc-windows-msvc.exe",
  "hunsu-bridge-sidecar-aarch64-pc-windows-msvc.exe"
];

async function loadPrepareDesktopSidecar(): Promise<PrepareDesktopSidecar> {
  // The production helper is an executable ESM script, so it intentionally has no TypeScript declaration surface.
  // @ts-expect-error TS7016 -- test the script's exported seam directly.
  const module = await import("../apps/bridge-desktop/scripts/prepare-desktop.mjs") as {
    prepareDesktopSidecar: PrepareDesktopSidecar;
  };
  return module.prepareDesktopSidecar;
}

test("Bridge desktop preparation builds only the current target from a clean dist", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-desktop-prepare-clean-"));
  const distDir = join(root, "missing-dist");
  const prepareDesktopSidecar = await loadPrepareDesktopSidecar();
  let requestedTarget = "";

  try {
    const result = await prepareDesktopSidecar({
      platform: "linux",
      arch: "x64",
      distDir,
      buildSidecars: async ({ target, distDir: requestedDistDir }) => {
        requestedTarget = target;
        assert.equal(requestedDistDir, distDir);
        assert.equal(existsSync(distDir), false);
        mkdirSync(distDir, { recursive: true });
        const file = `hunsu-bridge-sidecar-${target}`;
        writeFileSync(join(distDir, file), "sidecar", "utf8");
        writeFileSync(join(distDir, "sidecar-manifest.json"), "manifest", "utf8");
        return {
          artifacts: [{ target }],
          preparedManifest: {
            target,
            artifacts: [{ target, file, kind: "native-executable" }]
          }
        };
      }
    });

    assert.equal(requestedTarget, "x86_64-unknown-linux-gnu");
    assert.equal(result.preparedManifest.target, requestedTarget);
    assert.deepEqual(readdirSync(distDir).sort(), [
      `hunsu-bridge-sidecar-${requestedTarget}`,
      "sidecar-manifest.json"
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Bridge desktop preparation removes stale generic, other-target, and manifest outputs", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-desktop-prepare-stale-"));
  const distDir = join(root, "dist");
  const expectedTarget = "aarch64-apple-darwin";
  const expectedArtifact = `hunsu-bridge-sidecar-${expectedTarget}`;
  const prepareDesktopSidecar = await loadPrepareDesktopSidecar();

  try {
    mkdirSync(distDir, { recursive: true });
    for (const name of sidecarNames) {
      writeFileSync(join(distDir, name), "stale", "utf8");
    }
    writeFileSync(join(distDir, "sidecar-manifest.json"), "stale manifest", "utf8");
    writeFileSync(join(distDir, "unrelated-output.txt"), "keep", "utf8");

    await prepareDesktopSidecar({
      platform: "darwin",
      arch: "arm64",
      distDir,
      buildSidecars: async ({ target, distDir: requestedDistDir }) => {
        assert.equal(target, expectedTarget);
        assert.equal(requestedDistDir, distDir);
        assert.deepEqual(readdirSync(distDir), ["unrelated-output.txt"]);
        writeFileSync(join(distDir, expectedArtifact), "sidecar", "utf8");
        writeFileSync(join(distDir, "sidecar-manifest.json"), "manifest", "utf8");
        return {
          artifacts: [{ target }],
          preparedManifest: {
            target,
            artifacts: [{ target, file: expectedArtifact, kind: "native-executable" }]
          }
        };
      }
    });

    assert.deepEqual(readdirSync(distDir).sort(), [
      expectedArtifact,
      "sidecar-manifest.json",
      "unrelated-output.txt"
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Bridge desktop preparation removes partial prepared outputs after failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-desktop-prepare-failure-"));
  const distDir = join(root, "dist");
  const prepareDesktopSidecar = await loadPrepareDesktopSidecar();

  try {
    mkdirSync(distDir, { recursive: true });
    await assert.rejects(
      prepareDesktopSidecar({
        platform: "win32",
        arch: "arm64",
        distDir,
        buildSidecars: async ({ target, distDir: requestedDistDir }) => {
          assert.equal(requestedDistDir, distDir);
          writeFileSync(join(distDir, `hunsu-bridge-sidecar-${target}.exe`), "partial", "utf8");
          writeFileSync(join(distDir, "sidecar-manifest.json"), "stale", "utf8");
          throw new Error("toolchain unavailable");
        }
      }),
      /toolchain unavailable/
    );
    assert.deepEqual(readdirSync(distDir), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Bridge desktop development wires one non-recursive preparation command to Tauri", () => {
  const packageJson = JSON.parse(readFileSync(join(process.cwd(), "apps/bridge-desktop/package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const tauriConfig = JSON.parse(readFileSync(join(process.cwd(), "apps/bridge-desktop/src-tauri/tauri.conf.json"), "utf8")) as {
    build: { beforeDevCommand: string; beforeBuildCommand: string };
    bundle: { externalBin: string[]; resources: string[] };
  };

  assert.equal(
    packageJson.scripts["desktop:prepare"],
    "pnpm run build:ui && tsc -p tsconfig.build.json && node --conditions=development scripts/prepare-desktop.mjs"
  );
  assert.equal(
    packageJson.scripts["desktop:dev"],
    "pnpm run typecheck && pnpm run desktop:prepare && pnpm exec tauri dev"
  );
  assert.doesNotMatch(packageJson.scripts["desktop:prepare"] ?? "", /tauri|desktop:dev/);
  assert.equal(tauriConfig.build.beforeDevCommand, "");
  assert.equal(tauriConfig.build.beforeBuildCommand, "pnpm run build");
  assert.deepEqual(tauriConfig.bundle.externalBin, ["../dist/hunsu-bridge-sidecar"]);
  assert.deepEqual(tauriConfig.bundle.resources, ["../dist/sidecar-manifest.json"]);

  const externalBinName = basename(tauriConfig.bundle.externalBin[0] ?? "");
  assert.equal(externalBinName, "hunsu-bridge-sidecar");
  assert.equal(sidecarNames.every(name => name === externalBinName || name === `${externalBinName}.exe` || name.startsWith(`${externalBinName}-`)), true);
});
