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
const installedAppScreenshotName = "windows-installed-app-e2e-screenshot.png";
const installerUpgradeEvidenceName = "windows-installer-upgrade-e2e-evidence.json";
const dogfoodBuildOnlyNoticeName = "DOGFOOD-BUILD-ONLY.txt";
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
  const dogfoodBuildOnly = input?.dogfoodBuildOnly ?? false;
  if (typeof dogfoodBuildOnly !== "boolean") {
    throw new Error("Desktop artifact staging dogfoodBuildOnly must be a boolean.");
  }
  if (dogfoodBuildOnly && (includeSizeReport
    || input?.evidencePath !== undefined
    || input?.installedEvidencePath !== undefined
    || input?.installedScreenshotPath !== undefined
    || input?.upgradeEvidencePath !== undefined)) {
    throw new Error("Dogfood build-only artifacts cannot include gated validation evidence or size reports.");
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
    validateArtifactSizeReport(reportPath, target);
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
  const installedScreenshotPath = optionalSourceFile(input?.installedScreenshotPath, "installed Bridge App E2E screenshot");
  if (Boolean(installedEvidencePath) !== Boolean(installedScreenshotPath)) {
    throw new Error("Installed Bridge App E2E evidence and screenshot must be staged together.");
  }
  if (installedEvidencePath) {
    if (containsPath(outputRoot, installedEvidencePath)) {
      throw new Error(`Installed Bridge App E2E evidence must be outside the artifact output directory: ${installedEvidencePath}`);
    }
    if (containsPath(outputRoot, installedScreenshotPath)) {
      throw new Error(`Installed Bridge App E2E screenshot must be outside the artifact output directory: ${installedScreenshotPath}`);
    }
    validatePngScreenshot(installedScreenshotPath);
    validateInstalledAppEvidence(installedEvidencePath, installedScreenshotPath);
    copyIntoStage(installedEvidencePath, outputRoot, installedAppEvidenceName);
    copyIntoStage(installedScreenshotPath, outputRoot, installedAppScreenshotName);
  }

  const upgradeEvidencePath = optionalSourceFile(input?.upgradeEvidencePath, "Windows installer upgrade E2E evidence");
  if (upgradeEvidencePath) {
    if (containsPath(outputRoot, upgradeEvidencePath)) {
      throw new Error(`Windows installer upgrade E2E evidence must be outside the artifact output directory: ${upgradeEvidencePath}`);
    }
    if (!includeSizeReport) {
      throw new Error("Windows installer upgrade E2E evidence requires the artifact size report to be staged.");
    }
    validateInstallerUpgradeEvidence(upgradeEvidencePath);
    copyIntoStage(upgradeEvidencePath, outputRoot, installerUpgradeEvidenceName);
  }

  if (dogfoodBuildOnly) {
    writeFileSync(
      join(outputRoot, dogfoodBuildOnlyNoticeName),
      [
        "Hunsu Bridge dogfood build-only artifact",
        "",
        "Automated repository, lifecycle, installed-app, upgrade, and size validation was skipped.",
        "Use this artifact only for manual dogfooding QA.",
        "releaseEligible=false",
        ""
      ].join("\n"),
      "utf8"
    );
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
    ["--installed-evidence-path", "installedEvidencePath"],
    ["--installed-screenshot-path", "installedScreenshotPath"],
    ["--upgrade-evidence-path", "upgradeEvidencePath"]
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
    if (option === "--dogfood-build-only") {
      if (Object.hasOwn(options, "dogfoodBuildOnly")) {
        throw new Error(`Desktop artifact staging option was provided more than once: ${option}`);
      }
      options.dogfoodBuildOnly = true;
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
    if (property === "evidencePath" || property === "installedEvidencePath" || property === "installedScreenshotPath" || property === "upgradeEvidencePath") {
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
  validateArtifactProvenance(evidence?.provenance, "sidecarSha256", "Managed Bridge", path);
  if (/\b[a-z][a-z0-9+.-]*:\/\/|hunsuBridgeToken/iu.test(text)) {
    throw new Error(`Managed Bridge E2E evidence contains a URL or credential parameter: ${path}`);
  }
}

function validateInstalledAppEvidence(path, screenshotPath) {
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
    "version-labels",
    "advanced-presentation"
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
  validateArtifactProvenance(evidence?.provenance, "installerSha256", "Installed Bridge App", path);
  for (const digestName of ["screenshotSha256", "sanitizedLogSha256"]) {
    if (!isSha256(evidence?.provenance?.[digestName])) {
      throw new Error(`Installed Bridge App E2E evidence has invalid ${digestName} provenance: ${path}`);
    }
  }
  const screenshotDigest = createHash("sha256").update(readFileSync(screenshotPath)).digest("hex");
  if (evidence.provenance.screenshotSha256 !== screenshotDigest) {
    throw new Error(`Installed Bridge App E2E screenshot does not match its evidence digest: ${path}`);
  }
  if (evidence?.observations?.nativeClipboardRoundTrip !== true
    || evidence?.observations?.sidecarConsoleWindows !== 0
    || evidence?.observations?.liveLegacyPairingRevoked !== true
    || evidence?.observations?.workspaceRoadmapIdMatched !== true
    || evidence?.observations?.screenshotFile !== installedAppScreenshotName) {
    throw new Error(`Installed Bridge App E2E evidence is missing required native observations: ${path}`);
  }
  const portConflictFeedback = evidence?.observations?.portConflictFeedback;
  if (portConflictFeedback?.code !== "BRIDGE_PORT_IN_USE"
    || !Number.isInteger(portConflictFeedback?.configuredPort)
    || portConflictFeedback.configuredPort < 1
    || portConflictFeedback.configuredPort > 65_535
    || portConflictFeedback.retryInstruction
      !== `Stop the other process using Bridge port ${portConflictFeedback.configuredPort}, then open the Connection section and select Start Bridge.`) {
    throw new Error(`Installed Bridge App E2E evidence is missing actionable configured-port feedback: ${path}`);
  }
  const advancedPresentation = evidence?.observations?.advancedPresentation;
  if (advancedPresentation?.selectedTab !== "Runtime Providers"
    || advancedPresentation?.selectedStylingDistinct !== true
    || advancedPresentation?.globalRemoteControlCount !== 0
    || advancedPresentation?.workspaceRemoteActionCount !== 1
    || advancedPresentation?.gitLabelCount !== 1) {
    throw new Error(`Installed Bridge App E2E evidence is missing unambiguous Advanced presentation: ${path}`);
  }
  if (/\b[a-z][a-z0-9+.-]*:\/\/|hunsuBridgeToken|hunsuRelayToken|authorization|access_token|refresh_token/iu.test(text)) {
    throw new Error(`Installed Bridge App E2E evidence contains a URL or credential parameter: ${path}`);
  }
}

function validateInstallerUpgradeEvidence(path) {
  const text = readFileSync(path, "utf8");
  let evidence;
  try {
    evidence = JSON.parse(text);
  } catch {
    throw new Error(`Windows installer upgrade E2E evidence is not valid JSON: ${path}`);
  }
  if (evidence?.schema !== "hunsu.windows-installer-upgrade-e2e.v1"
    || evidence?.schemaVersion !== 1
    || evidence?.result !== "passed") {
    throw new Error(`Windows installer upgrade E2E evidence did not record a passing schema-v1 run: ${path}`);
  }
  for (const scenario of ["A", "B", "C", "D", "E", "F"]) {
    if (evidence?.scenarios?.[scenario]?.result !== "passed") {
      throw new Error(`Windows installer upgrade E2E evidence is missing passing scenario ${scenario}: ${path}`);
    }
  }
  const provenance = evidence?.provenance;
  if (!provenance || typeof provenance !== "object"
    || !/^(?:local|\d+)$/u.test(provenance.runId ?? "")
    || !/^(?:local|\d+)$/u.test(provenance.runAttempt ?? "")
    || !/^(?:local|[a-f0-9]{40,64})$/u.test(provenance.candidateSha ?? "")
    || provenance.target !== "x86_64-pc-windows-msvc"
    || provenance.expectedAppVersion !== "0.1.1"
    || !isSha256(provenance.installerSha256)
    || !isSha256(provenance.candidateSidecarSha256)
    || !isSha256(provenance.installDirectoryId)
    || !Number.isFinite(Date.parse(provenance.startedAt ?? ""))
    || !Number.isFinite(Date.parse(provenance.completedAt ?? ""))
    || Date.parse(provenance.completedAt) < Date.parse(provenance.startedAt)) {
    throw new Error(`Windows installer upgrade E2E evidence has invalid provenance: ${path}`);
  }
  for (const measurement of ["installerBytes", "installedAppBytes", "installedSidecarBytes"]) {
    if (!Number.isSafeInteger(evidence?.measurements?.[measurement]) || evidence.measurements[measurement] <= 0) {
      throw new Error(`Windows installer upgrade E2E evidence has invalid ${measurement}: ${path}`);
    }
  }
  if (!isSha256(evidence?.measurements?.installedSidecarSha256)
    || evidence.measurements.installedSidecarSha256 !== provenance.candidateSidecarSha256
    || evidence?.scenarios?.A?.candidateVersion !== "0.1.1"
    || evidence?.scenarios?.A?.installedSidecarSha256 !== provenance.candidateSidecarSha256
    || evidence?.scenarios?.E?.launchReportedCode !== "BRIDGE_PORT_IN_USE"
    || evidence?.scenarios?.F?.similarExecutableOutsideTargetPreserved !== true) {
    throw new Error(`Windows installer upgrade E2E evidence is missing required upgrade observations: ${path}`);
  }
  if (/\b[a-z][a-z0-9+.-]*:\/\/|hunsuBridgeToken|hunsuRelayToken|authorization|access_token|refresh_token|controlToken/iu.test(text)
    || containsFullUserProfilePath(evidence)) {
    throw new Error(`Windows installer upgrade E2E evidence contains a URL, credential parameter, or full user-profile path: ${path}`);
  }
}

function containsFullUserProfilePath(value) {
  if (typeof value === "string") return /[a-z]:\\users\\/iu.test(value);
  if (Array.isArray(value)) return value.some(containsFullUserProfilePath);
  if (value && typeof value === "object") return Object.values(value).some(containsFullUserProfilePath);
  return false;
}

function validateArtifactSizeReport(path, target) {
  let report;
  try {
    report = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`Desktop artifact size report is not valid JSON: ${path}`);
  }
  if (report?.schema !== "hunsu.bridge-desktop-artifact-sizes.v3"
    || report?.target !== target
    || !Number.isSafeInteger(report?.totalBytes)
    || report.totalBytes < 0
    || report?.packaging?.fixedWebViewRuntimeBundled !== false
    || report?.packaging?.fixedWebViewRuntimeAllowedForThisChange !== false) {
    throw new Error(`Desktop artifact size report has an invalid v3 contract: ${path}`);
  }
  if (target === "x86_64-pc-windows-msvc") {
    const measurements = report?.measurements;
    const policy = report?.policy;
    const policyChecks = Array.isArray(policy?.checks) ? policy.checks : [];
    const installerCheck = policyChecks.find(check => check?.metric === "installerBytes");
    const artifactZipCheck = policyChecks.find(check => check?.metric === "artifactZipBytes");
    const hasExceptedCheck = policyChecks.some(check => check?.status === "excepted");
    const validException = policy?.status !== "passed-with-reviewed-exception"
      ? policy?.reviewedException === null && !hasExceptedCheck
      : typeof policy?.reviewedException === "string"
        && policy.reviewedException.trim().length >= 12
        && policy.reviewedException.length <= 300
        && hasExceptedCheck;
    if (!Number.isSafeInteger(measurements?.installer?.sizeBytes)
      || measurements.installer.sizeBytes <= 0
      || !Number.isSafeInteger(measurements?.artifactZip?.sizeBytes)
      || measurements.artifactZip.sizeBytes <= 0
      || !Number.isSafeInteger(measurements?.installedApp?.sizeBytes)
      || measurements.installedApp.sizeBytes <= 0
      || !Number.isSafeInteger(measurements?.installedSidecar?.sizeBytes)
      || measurements.installedSidecar.sizeBytes <= 0
      || !Number.isSafeInteger(measurements?.installerLifecycleHelpers?.sizeBytes)
      || measurements.installerLifecycleHelpers.sizeBytes <= 0
      || report?.packaging?.configurationChecked !== true
      || !["passed", "passed-with-reviewed-exception"].includes(policy?.status)
      || policy?.maximumGrowthPercent !== 5
      || policy?.minimumGrowthAllowanceBytes !== 1_048_576
      || policy?.baselineSource?.workflowRunId !== "29147290486"
      || policy?.baselineSource?.artifactId !== "8247220443"
      || installerCheck?.baselineBytes !== 24_997_090
      || installerCheck?.currentBytes !== measurements.installer.sizeBytes
      || !["passed", "excepted"].includes(installerCheck?.status)
      || artifactZipCheck?.baselineBytes !== 25_065_843
      || artifactZipCheck?.currentBytes !== measurements.artifactZip.sizeBytes
      || !["passed", "excepted"].includes(artifactZipCheck?.status)
      || !validException) {
      throw new Error(`Windows x64 artifact size report is missing guarded installer measurements: ${path}`);
    }
  }
}

function validateArtifactProvenance(provenance, binaryDigestName, label, path) {
  if (!provenance || typeof provenance !== "object"
    || !/^(?:local|\d+)$/u.test(provenance.runId ?? "")
    || !/^(?:local|\d+)$/u.test(provenance.runAttempt ?? "")
    || !/^(?:local|[a-f0-9]{40,64})$/u.test(provenance.headSha ?? "")
    || provenance.target !== "x86_64-pc-windows-msvc"
    || typeof provenance.runnerOs !== "string" || provenance.runnerOs.trim() === ""
    || typeof provenance.runnerImage !== "string" || provenance.runnerImage.trim() === ""
    || !Number.isFinite(Date.parse(provenance.startedAt ?? ""))
    || !Number.isFinite(Date.parse(provenance.completedAt ?? ""))
    || Date.parse(provenance.completedAt) < Date.parse(provenance.startedAt)
    || !isSha256(provenance[binaryDigestName])) {
    throw new Error(`${label} E2E evidence has invalid artifact provenance: ${path}`);
  }
}

function validatePngScreenshot(path) {
  const contents = readFileSync(path);
  const pngSignature = "89504e470d0a1a0a";
  if (contents.length <= 8 || contents.subarray(0, 8).toString("hex") !== pngSignature) {
    throw new Error(`Installed Bridge App E2E screenshot is not a non-empty PNG: ${path}`);
  }
}

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const result = stageDesktopArtifacts(parseStageDesktopArtifactArguments(process.argv.slice(2)));
  console.log(`Staged ${result.files.length - 1} desktop artifact file(s) for ${result.target} in ${result.outputDir}.`);
}
