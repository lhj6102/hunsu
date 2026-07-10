#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const artifactSizeReportName = "artifact-size-report.json";
const managedBridgeEvidenceName = "windows-managed-bridge-e2e-evidence.json";
const installedAppEvidenceName = "windows-installed-app-e2e-evidence.json";
const checksumFileName = "SHA256SUMS.txt";

const targetArtifactRules = new Map([
  ["x86_64-pc-windows-msvc", [{ directory: "nsis", extension: ".exe" }]],
  ["aarch64-pc-windows-msvc", [{ directory: "nsis", extension: ".exe" }]],
  ["x86_64-apple-darwin", [{ directory: "dmg", extension: ".dmg" }]],
  ["aarch64-apple-darwin", [{ directory: "dmg", extension: ".dmg" }]],
  [
    "x86_64-unknown-linux-gnu",
    [
      { directory: "deb", extension: ".deb" },
      { directory: "appimage", extension: ".AppImage" }
    ]
  ],
  [
    "aarch64-unknown-linux-gnu",
    [
      { directory: "deb", extension: ".deb" },
      { directory: "appimage", extension: ".AppImage" }
    ]
  ]
]);

export const supportedDesktopArtifactTargets = Object.freeze([...targetArtifactRules.keys()]);

export function stageDesktopArtifacts(input) {
  const target = requiredValue(input?.target, "target");
  const rules = targetArtifactRules.get(target);
  if (!rules) {
    throw new Error(
      `Unsupported desktop artifact target: ${target}. Expected one of: ${supportedDesktopArtifactTargets.join(", ")}.`
    );
  }

  const bundleRoot = resolve(requiredValue(input?.bundleDir, "bundleDir"));
  const outputRoot = resolve(requiredValue(input?.outputDir, "outputDir"));
  if (containsPath(outputRoot, bundleRoot) || containsPath(bundleRoot, outputRoot)) {
    throw new Error(
      `Artifact output directory must not overlap the source bundle directory: ${outputRoot}`
    );
  }
  const includeSizeReport = input?.includeSizeReport ?? false;
  if (typeof includeSizeReport !== "boolean") {
    throw new Error("Desktop artifact staging includeSizeReport must be a boolean.");
  }

  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(outputRoot, { recursive: true });

  if (!existsSync(bundleRoot) || !statSync(bundleRoot).isDirectory()) {
    throw new Error(`Missing desktop bundle directory: ${bundleRoot}`);
  }

  const installers = rules
    .flatMap(rule => matchingInstallers(bundleRoot, rule))
    .sort((left, right) => comparePaths(left.relativePath, right.relativePath));
  if (installers.length === 0) {
    const expectedPaths = rules
      .map(rule => `${rule.directory}/*${rule.extension}`)
      .join(" or ");
    throw new Error(
      `Expected at least one installer for desktop target ${target} (${expectedPaths}) under ${bundleRoot}.`
    );
  }

  for (const installer of installers) {
    copyIntoStage(installer.sourcePath, outputRoot, installer.relativePath);
  }

  const reportPath = join(bundleRoot, artifactSizeReportName);
  if (includeSizeReport && (!existsSync(reportPath) || !statSync(reportPath).isFile())) {
    throw new Error(`Missing requested desktop artifact size report: ${reportPath}`);
  }
  if (includeSizeReport) {
    copyIntoStage(reportPath, outputRoot, artifactSizeReportName);
  }

  const evidencePath = optionalSourceFile(input?.evidencePath, "managed Bridge E2E evidence");
  if (evidencePath) {
    if (containsPath(outputRoot, evidencePath)) {
      throw new Error(`Managed Bridge E2E evidence must be outside the artifact output directory: ${evidencePath}`);
    }
    validateManagedBridgeEvidence(evidencePath);
    copyIntoStage(evidencePath, outputRoot, managedBridgeEvidenceName);
  }

  const installedEvidencePath = optionalSourceFile(input?.installedEvidencePath, "installed Bridge App E2E evidence");
  if (installedEvidencePath) {
    if (containsPath(outputRoot, installedEvidencePath)) {
      throw new Error(`Installed Bridge App E2E evidence must be outside the artifact output directory: ${installedEvidencePath}`);
    }
    validateInstalledAppEvidence(installedEvidencePath);
    copyIntoStage(installedEvidencePath, outputRoot, installedAppEvidenceName);
  }

  const stagedFiles = walkFiles(outputRoot)
    .map(path => portableRelativePath(outputRoot, path))
    .filter(path => path !== checksumFileName)
    .sort(comparePaths);
  const checksums = stagedFiles.map(path => {
    const digest = createHash("sha256")
      .update(readFileSync(join(outputRoot, ...path.split("/"))))
      .digest("hex");
    return `${digest}  ${path}`;
  });
  writeFileSync(join(outputRoot, checksumFileName), `${checksums.join("\n")}\n`, "utf8");

  return {
    target,
    bundleDir: bundleRoot,
    outputDir: outputRoot,
    files: [...stagedFiles, checksumFileName]
  };
}

export function parseStageDesktopArtifactArguments(args) {
  const optionNames = new Map([
    ["--bundle-dir", "bundleDir"],
    ["--output-dir", "outputDir"],
    ["--target", "target"],
    ["--evidence-path", "evidencePath"],
    ["--installed-evidence-path", "installedEvidencePath"]
  ]);
  const options = {};

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--include-size-report") {
      if (Object.hasOwn(options, "includeSizeReport")) {
        throw new Error(`Desktop artifact staging option was provided more than once: ${option}`);
      }
      options.includeSizeReport = true;
      continue;
    }
    const property = optionNames.get(option);
    if (!property) {
      throw new Error(`Unknown desktop artifact staging option: ${option}`);
    }
    if (Object.hasOwn(options, property)) {
      throw new Error(`Desktop artifact staging option was provided more than once: ${option}`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for desktop artifact staging option: ${option}`);
    }
    options[property] = value;
    index += 1;
  }

  for (const [option, property] of optionNames) {
    if (property === "evidencePath" || property === "installedEvidencePath") {
      continue;
    }
    if (!Object.hasOwn(options, property)) {
      throw new Error(`Missing required desktop artifact staging option: ${option}`);
    }
  }
  return options;
}

function matchingInstallers(bundleRoot, rule) {
  const directory = join(bundleRoot, rule.directory);
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    return [];
  }
  return readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(rule.extension))
    .map(entry => ({
      sourcePath: join(directory, entry.name),
      relativePath: `${rule.directory}/${entry.name}`
    }));
}

function copyIntoStage(sourcePath, outputRoot, relativePath) {
  const destination = join(outputRoot, ...relativePath.split("/"));
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(sourcePath, destination);
}

function walkFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function portableRelativePath(root, path) {
  return relative(root, path).split(sep).join("/");
}

function containsPath(parent, candidate) {
  const path = relative(parent, candidate);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function requiredValue(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Desktop artifact staging requires a non-empty ${name}.`);
  }
  return value;
}

function optionalSourceFile(value, name) {
  if (value === undefined) {
    return undefined;
  }
  const path = resolve(requiredValue(value, name));
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`Missing ${name}: ${path}`);
  }
  return path;
}

function validateManagedBridgeEvidence(path) {
  const text = readFileSync(path, "utf8");
  let evidence;
  try {
    evidence = JSON.parse(text);
  } catch {
    throw new Error(`Managed Bridge E2E evidence is not valid JSON: ${path}`);
  }
  if (evidence?.schemaVersion !== 1 || evidence?.result !== "passed") {
    throw new Error(`Managed Bridge E2E evidence did not record a passing schema-v1 run: ${path}`);
  }
  for (const scenario of ["A", "B", "C", "D", "E", "F"]) {
    if (evidence?.scenarios?.[scenario]?.result !== "passed") {
      throw new Error(`Managed Bridge E2E evidence is missing passing scenario ${scenario}: ${path}`);
    }
  }
  if (/\b[a-z][a-z0-9+.-]*:\/\/|hunsuBridgeToken/iu.test(text)) {
    throw new Error(`Managed Bridge E2E evidence contains a URL or credential parameter: ${path}`);
  }
}

function validateInstalledAppEvidence(path) {
  const text = readFileSync(path, "utf8");
  let evidence;
  try {
    evidence = JSON.parse(text);
  } catch {
    throw new Error(`Installed Bridge App E2E evidence is not valid JSON: ${path}`);
  }
  const requiredChecks = [
    "silent-isolated-install",
    "installed-webview-cdp",
    "lifecycle-controls",
    "open-handoff-once",
    "workspace-open-handoff-once",
    "diagnostics-copy-redaction",
    "no-eaddrinuse-log",
    "provider-validate-recheck-feedback",
    "version-labels"
  ];
  if (evidence?.schemaVersion !== 1 || evidence?.result !== "passed" || evidence?.candidateKind !== "installed-nsis") {
    throw new Error(`Installed Bridge App E2E evidence did not record a passing schema-v1 NSIS run: ${path}`);
  }
  if (!Array.isArray(evidence.checks) || requiredChecks.some(check => !evidence.checks.includes(check))) {
    throw new Error(`Installed Bridge App E2E evidence is missing required checks: ${path}`);
  }
  if (evidence?.releaseGate?.automatedInstalledAppQa !== "passed"
    || evidence?.releaseGate?.manualVisualQa !== "required"
    || evidence?.releaseGate?.releaseEligible !== false) {
    throw new Error(`Installed Bridge App E2E evidence must keep the candidate release gate closed pending manual QA: ${path}`);
  }
  if (/\b[a-z][a-z0-9+.-]*:\/\/|hunsuBridgeToken|hunsuRelayToken|authorization|access_token|refresh_token/iu.test(text)) {
    throw new Error(`Installed Bridge App E2E evidence contains a URL or credential parameter: ${path}`);
  }
}

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const result = stageDesktopArtifacts(parseStageDesktopArtifactArguments(process.argv.slice(2)));
  console.log(`Staged ${result.files.length - 1} desktop artifact file(s) for ${result.target} in ${result.outputDir}.`);
}
