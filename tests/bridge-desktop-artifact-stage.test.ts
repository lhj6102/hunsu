import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

type ArtifactStageModule = {
  supportedDesktopArtifactTargets: readonly string[];
  stageDesktopArtifacts(input: {
    bundleDir: string;
    outputDir: string;
    target: string;
    includeSizeReport?: boolean;
    evidencePath?: string;
    installedEvidencePath?: string;
    installedScreenshotPath?: string;
  }): { files: string[] };
};

const scriptPath = join(process.cwd(), "apps/bridge-desktop/scripts/stage-desktop-artifacts.mjs");
const artifactStage = await import(pathToFileURL(scriptPath).href) as ArtifactStageModule;

test("desktop artifact staging selects only installers for each supported target and checksums exactly what it stages", () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-desktop-artifact-stage-"));
  const bundleDir = join(root, "bundle");
  const outputDir = join(root, "staged");

  try {
    writeFixture(join(bundleDir, "nsis", "Hunsu_0.1.0_x64-setup.exe"), "windows-installer");
    writeFixture(join(bundleDir, "nsis", "Hunsu_0.1.0_x64-setup.exe.sig"), "not-an-installer");
    writeFixture(join(bundleDir, "nsis", "unpacked", "helper.exe"), "unpacked-output");
    writeFixture(join(bundleDir, "msi", "Hunsu_0.1.0_x64.msi"), "other-windows-bundle");
    writeFixture(join(bundleDir, "dmg", "Hunsu_0.1.0_x64.dmg"), "macos-installer");
    writeFixture(join(bundleDir, "macos", "Hunsu.app", "Contents", "MacOS", "Hunsu"), "unpacked-app");
    writeFixture(join(bundleDir, "deb", "hunsu_0.1.0_amd64.deb"), "debian-installer");
    writeFixture(join(bundleDir, "appimage", "hunsu_0.1.0_amd64.AppImage"), "appimage-installer");
    writeFixture(join(bundleDir, "appimage", "hunsu_0.1.0_amd64.AppImage.tar.gz"), "not-an-appimage");
    writeFixture(join(bundleDir, "rpm", "hunsu-0.1.0.x86_64.rpm"), "other-linux-bundle");
    writeFixture(join(bundleDir, "artifact-size-report.json"), "{\"totalBytes\":123}\n");

    const expectations = new Map<string, string[]>([
      ["x86_64-pc-windows-msvc", ["artifact-size-report.json", "nsis/Hunsu_0.1.0_x64-setup.exe"]],
      ["aarch64-pc-windows-msvc", ["artifact-size-report.json", "nsis/Hunsu_0.1.0_x64-setup.exe"]],
      ["x86_64-apple-darwin", ["artifact-size-report.json", "dmg/Hunsu_0.1.0_x64.dmg"]],
      ["aarch64-apple-darwin", ["artifact-size-report.json", "dmg/Hunsu_0.1.0_x64.dmg"]],
      [
        "x86_64-unknown-linux-gnu",
        ["appimage/hunsu_0.1.0_amd64.AppImage", "artifact-size-report.json", "deb/hunsu_0.1.0_amd64.deb"]
      ],
      [
        "aarch64-unknown-linux-gnu",
        ["appimage/hunsu_0.1.0_amd64.AppImage", "artifact-size-report.json", "deb/hunsu_0.1.0_amd64.deb"]
      ]
    ]);

    assert.deepEqual([...artifactStage.supportedDesktopArtifactTargets].sort(), [...expectations.keys()].sort());
    for (const [target, expectedFiles] of expectations) {
      writeFixture(join(outputDir, "stale-unpacked-output", "Hunsu.exe"), "stale");

      artifactStage.stageDesktopArtifacts({ bundleDir, outputDir, target, includeSizeReport: true });

      const files = listFiles(outputDir);
      assert.deepEqual(files, [...expectedFiles, "SHA256SUMS.txt"].sort(), target);
      assert.equal(existsSync(join(outputDir, "stale-unpacked-output", "Hunsu.exe")), false, target);
      assertChecksumsMatchEveryStagedFile(outputDir);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("desktop artifact staging omits a size report unless explicitly requested", () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-desktop-artifact-stage-no-report-"));
  const bundleDir = join(root, "bundle");
  const outputDir = join(root, "staged");

  try {
    writeFixture(join(bundleDir, "dmg", "Hunsu.dmg"), "macos-installer");
    writeFixture(join(bundleDir, "artifact-size-report.json"), "{\"totalBytes\":123}\n");
    artifactStage.stageDesktopArtifacts({
      bundleDir,
      outputDir,
      target: "aarch64-apple-darwin"
    });

    assert.deepEqual(listFiles(outputDir), ["SHA256SUMS.txt", "dmg/Hunsu.dmg"]);
    assertChecksumsMatchEveryStagedFile(outputDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("desktop artifact staging retains safe passing Windows lifecycle evidence in the checksum manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-desktop-artifact-stage-evidence-"));
  const bundleDir = join(root, "bundle");
  const outputDir = join(root, "staged");
  const evidencePath = join(root, "managed-evidence.json");

  try {
    writeFixture(join(bundleDir, "nsis", "Hunsu.exe"), "windows-installer");
    writeFixture(evidencePath, JSON.stringify({
      schemaVersion: 1,
      result: "passed",
      provenance: artifactProvenance("sidecarSha256"),
      scenarios: Object.fromEntries(["A", "B", "C", "D", "E", "F"].map(scenario => [scenario, { result: "passed" }]))
    }));
    artifactStage.stageDesktopArtifacts({
      bundleDir,
      outputDir,
      target: "x86_64-pc-windows-msvc",
      evidencePath
    });

    assert.deepEqual(listFiles(outputDir), [
      "SHA256SUMS.txt",
      "nsis/Hunsu.exe",
      "windows-managed-bridge-e2e-evidence.json"
    ]);
    assertChecksumsMatchEveryStagedFile(outputDir);

    writeFixture(evidencePath, JSON.stringify({
      schemaVersion: 1,
      result: "passed",
      provenance: artifactProvenance("sidecarSha256"),
      scenarios: Object.fromEntries(["A", "B", "C", "D", "E", "F"].map(scenario => [scenario, { result: "passed" }])),
      unsafe: "https://example.invalid/?hunsuBridgeToken=raw"
    }));
    assert.throws(
      () => artifactStage.stageDesktopArtifacts({
        bundleDir,
        outputDir,
        target: "x86_64-pc-windows-msvc",
        evidencePath
      }),
      /evidence contains a URL or credential parameter/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("desktop artifact staging retains safe installed NSIS WebView evidence with a closed manual release gate", () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-desktop-artifact-stage-installed-evidence-"));
  const bundleDir = join(root, "bundle");
  const outputDir = join(root, "staged");
  const installedEvidencePath = join(root, "installed-evidence.json");
  const installedScreenshotPath = join(root, "installed-screenshot.png");
  const checks = [
    "silent-isolated-install",
    "installed-webview-cdp",
    "lifecycle-controls",
    "open-handoff-once",
    "workspace-open-handoff-once",
    "exact-workspace-id",
    "diagnostics-copy-redaction",
    "installed-native-clipboard",
    "no-eaddrinuse-log",
    "installed-remains-stopped",
    "ui-port-conflict-feedback",
    "sidecar-no-console-window",
    "live-migration-revocation",
    "no-webview-console-errors",
    "visual-screenshot",
    "provider-validate-recheck-feedback",
    "version-labels"
  ];

  try {
    writeFixture(join(bundleDir, "nsis", "Hunsu.exe"), "windows-installer");
    writePngFixture(installedScreenshotPath);
    const screenshotSha256 = createHash("sha256").update(readFileSync(installedScreenshotPath)).digest("hex");
    writeFixture(installedEvidencePath, JSON.stringify({
      schemaVersion: 1,
      result: "passed",
      candidateKind: "installed-nsis",
      checks,
      provenance: {
        ...artifactProvenance("installerSha256"),
        screenshotSha256,
        sanitizedLogSha256: "c".repeat(64)
      },
      observations: {
        nativeClipboardRoundTrip: true,
        sidecarConsoleWindows: 0,
        liveLegacyPairingRevoked: true,
        workspaceRoadmapIdMatched: true,
        screenshotFile: "windows-installed-app-e2e-screenshot.png"
      },
      releaseGate: {
        automatedInstalledAppQa: "passed",
        manualVisualQa: "required",
        releaseEligible: false
      }
    }));
    artifactStage.stageDesktopArtifacts({
      bundleDir,
      outputDir,
      target: "x86_64-pc-windows-msvc",
      installedEvidencePath,
      installedScreenshotPath
    });

    assert.deepEqual(listFiles(outputDir), [
      "SHA256SUMS.txt",
      "nsis/Hunsu.exe",
      "windows-installed-app-e2e-evidence.json",
      "windows-installed-app-e2e-screenshot.png"
    ]);
    assertChecksumsMatchEveryStagedFile(outputDir);

    writeFixture(installedEvidencePath, JSON.stringify({
      schemaVersion: 1,
      result: "passed",
      candidateKind: "installed-nsis",
      checks,
      provenance: {
        ...artifactProvenance("installerSha256"),
        screenshotSha256,
        sanitizedLogSha256: "c".repeat(64)
      },
      observations: {
        nativeClipboardRoundTrip: true,
        sidecarConsoleWindows: 0,
        liveLegacyPairingRevoked: true,
        workspaceRoadmapIdMatched: true,
        screenshotFile: "windows-installed-app-e2e-screenshot.png"
      },
      releaseGate: {
        automatedInstalledAppQa: "passed",
        manualVisualQa: "required",
        releaseEligible: true
      }
    }));
    assert.throws(
      () => artifactStage.stageDesktopArtifacts({
        bundleDir,
        outputDir,
        target: "x86_64-pc-windows-msvc",
        installedEvidencePath,
        installedScreenshotPath
      }),
      /release gate closed pending manual QA/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("desktop artifact staging clears stale output and fails when the target has no installer", () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-desktop-artifact-stage-empty-"));
  const bundleDir = join(root, "bundle");
  const outputDir = join(root, "staged");

  try {
    writeFixture(join(bundleDir, "nsis", "Hunsu.exe.blockmap"), "metadata-only");
    writeFixture(join(bundleDir, "artifact-size-report.json"), "{}\n");
    writeFixture(join(outputDir, "stale.exe"), "stale");

    assert.throws(
      () => artifactStage.stageDesktopArtifacts({
        bundleDir,
        outputDir,
        target: "x86_64-pc-windows-msvc"
      }),
      /Expected at least one installer.*nsis\/\*\.exe/
    );
    assert.deepEqual(listFiles(outputDir), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("desktop artifact staging CLI accepts bundle, output, and target options", () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-desktop-artifact-stage-cli-"));
  const bundleDir = join(root, "bundle");
  const outputDir = join(root, "staged");

  try {
    writeFixture(join(bundleDir, "deb", "hunsu.deb"), "debian-installer");
    const result = spawnSync(process.execPath, [
      scriptPath,
      "--bundle-dir",
      bundleDir,
      "--output-dir",
      outputDir,
      "--target",
      "x86_64-unknown-linux-gnu"
    ], { encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Staged 1 desktop artifact file/);
    assert.deepEqual(listFiles(outputDir), ["SHA256SUMS.txt", "deb/hunsu.deb"]);
    assertChecksumsMatchEveryStagedFile(outputDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeFixture(path: string, contents: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
}

function writePngFixture(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.from("89504e470d0a1a0a00", "hex"));
}

function artifactProvenance(digestName: "sidecarSha256" | "installerSha256") {
  return {
    runId: "123456",
    runAttempt: "1",
    headSha: "b".repeat(40),
    target: "x86_64-pc-windows-msvc",
    runnerOs: "Windows Server QA",
    runnerImage: "windows-latest",
    startedAt: "2026-07-11T00:00:00.000Z",
    completedAt: "2026-07-11T00:01:00.000Z",
    [digestName]: "a".repeat(64)
  };
}

function listFiles(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(path).map(child => `${entry.name}/${child}`));
    } else if (entry.isFile()) {
      files.push(relative(directory, path).split(sep).join("/"));
    }
  }
  return files.sort();
}

function assertChecksumsMatchEveryStagedFile(outputDir: string) {
  const checksumPath = join(outputDir, "SHA256SUMS.txt");
  const checksumLines = readFileSync(checksumPath, "utf8").trimEnd().split("\n");
  const checksumEntries = checksumLines.map(line => {
    const match = /^([a-f0-9]{64})  (.+)$/u.exec(line);
    assert.ok(match, `Invalid checksum line: ${line}`);
    return { digest: match[1], path: match[2] };
  });
  const stagedFiles = listFiles(outputDir).filter(path => path !== "SHA256SUMS.txt");

  assert.deepEqual(checksumEntries.map(entry => entry.path), stagedFiles);
  for (const entry of checksumEntries) {
    const digest = createHash("sha256")
      .update(readFileSync(join(outputDir, ...entry.path.split("/"))))
      .digest("hex");
    assert.equal(entry.digest, digest, entry.path);
  }
}
