#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// pnpm forwards its conventional `--` argument separator to this script for
// filtered package commands, so discard only that standalone delimiter before
// validating the script's own options.
const args = process.argv.slice(2).filter(argument => argument !== "--");
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = optionValue("--directory") ?? join(packageRoot, "src-tauri/target/release/bundle");
const output = optionValue("--output") ?? join(directory, "artifact-size-report.json");
const sidecarManifest = optionValue("--sidecar-manifest") ?? join(packageRoot, "dist/sidecar-manifest.json");
const expectedSidecarTarget = optionValue("--target");
const upgradeEvidencePath = optionValue("--upgrade-evidence");
const baselinePath = optionValue("--baseline");
const artifactZipPath = optionValue("--artifact-zip");
const sizeException = optionValue("--size-exception");
const tauriConfigPath = optionValue("--tauri-config") ?? join(packageRoot, "src-tauri/tauri.conf.json");
const helperPaths = optionValues("--helper-path");
const root = resolve(directory);

validateArguments();
if (!existsSync(root) || !statSync(root).isDirectory()) {
  throw new Error(`Missing artifact directory: ${root}`);
}

const artifacts = walk(root)
  .filter(path => resolve(path) !== resolve(output))
  .map(path => fileMeasurement(relative(root, path).split("\\").join("/"), path))
  .sort((left, right) => left.path.localeCompare(right.path));
const totalBytes = artifacts.reduce((total, artifact) => total + artifact.sizeBytes, 0);
const sidecars = sidecarSizes(resolve(sidecarManifest), expectedSidecarTarget);
const installer = windowsInstallerMeasurement(artifacts, expectedSidecarTarget);
const installed = installedExecutableMeasurements(upgradeEvidencePath);
const helpers = helperMeasurements(helperPaths);
const artifactZip = optionalFileMeasurement(artifactZipPath, "artifact ZIP");
const baseline = baselinePath ? windowsSizeBaseline(resolve(baselinePath)) : undefined;
const packagingPolicy = verifyPackagingPolicy(tauriConfigPath, Boolean(baseline));
const policy = baseline
  ? evaluateGrowthPolicy({
      baseline,
      installerBytes: installer?.sizeBytes,
      artifactZipBytes: artifactZip?.sizeBytes,
      exception: sizeException
    })
  : undefined;

const report = {
  schema: "hunsu.bridge-desktop-artifact-sizes.v3",
  generatedAt: new Date().toISOString(),
  target: expectedSidecarTarget ?? null,
  totalBytes,
  totalMiB: toMiB(totalBytes),
  measurements: {
    installer: installer ?? null,
    artifactZip: artifactZip
      ? { ...artifactZip, measurementKind: "staged-artifact-zip" }
      : null,
    installedApp: installed?.app ?? null,
    installedSidecar: installed?.sidecar ?? null,
    installerLifecycleHelpers: {
      sizeBytes: helpers.reduce((total, helper) => total + helper.sizeBytes, 0),
      sizeMiB: toMiB(helpers.reduce((total, helper) => total + helper.sizeBytes, 0)),
      files: helpers
    }
  },
  artifacts,
  sidecars,
  policy: policy ?? null,
  packaging: packagingPolicy
};

mkdirSync(dirname(resolve(output)), { recursive: true });
writeFileSync(resolve(output), `${JSON.stringify(report, null, 2)}\n`, "utf8");

for (const artifact of artifacts) {
  console.log(`${artifact.sizeMiB.toFixed(2)} MiB  ${artifact.path}`);
}
for (const sidecar of sidecars) {
  console.log(`${sidecar.sizeMiB.toFixed(2)} MiB  sidecar:${sidecar.target} ${sidecar.file}`);
}
if (installer) console.log(`${installer.sizeMiB.toFixed(2)} MiB  windows-installer`);
if (artifactZip) console.log(`${artifactZip.sizeMiB.toFixed(2)} MiB  staged-artifact-zip`);
if (installed) {
  console.log(`${installed.app.sizeMiB.toFixed(2)} MiB  installed-app`);
  console.log(`${installed.sidecar.sizeMiB.toFixed(2)} MiB  installed-sidecar`);
}
console.log(`${report.measurements.installerLifecycleHelpers.sizeMiB.toFixed(2)} MiB  installer-lifecycle-helpers`);
console.log(`${report.totalMiB.toFixed(2)} MiB  total`);

if (policy?.status === "failed") {
  const failures = policy.checks
    .filter(check => check.status === "failed")
    .map(check => `${check.metric} is ${check.growthBytes} bytes above baseline; allowed growth is ${check.allowedGrowthBytes} bytes`)
    .join("; ");
  throw new Error(`Windows artifact size regression policy failed: ${failures}. Add only an explicit reviewed --size-exception when the growth is intentional.`);
}

function validateArguments() {
  const valueOptions = new Set([
    "--directory",
    "--output",
    "--sidecar-manifest",
    "--target",
    "--upgrade-evidence",
    "--baseline",
    "--artifact-zip",
    "--size-exception",
    "--tauri-config",
    "--helper-path"
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (!valueOptions.has(option)) {
      throw new Error(`Unknown artifact size report option: ${option}`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for artifact size report option: ${option}`);
    }
    index += 1;
  }
  for (const option of valueOptions) {
    if (option === "--helper-path") continue;
    if (optionValues(option).length > 1) {
      throw new Error(`Artifact size report option was provided more than once: ${option}`);
    }
  }
  if (sizeException !== undefined && (sizeException.trim().length < 12 || sizeException.length > 300)) {
    throw new Error("A size exception must contain a concise reviewed rationale between 12 and 300 characters.");
  }
  if (baselinePath && !expectedSidecarTarget?.endsWith("pc-windows-msvc")) {
    throw new Error("The Windows artifact size baseline may only be applied to a Windows target.");
  }
  if (baselinePath && (!upgradeEvidencePath || !artifactZipPath)) {
    throw new Error("The Windows size guard requires upgrade evidence and a staged artifact ZIP measurement.");
  }
}

function optionValue(name) {
  return optionValues(name)[0];
}

function optionValues(name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1] !== undefined) values.push(args[index + 1]);
  }
  return values;
}

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function fileMeasurement(path, sourcePath) {
  const sizeBytes = statSync(sourcePath).size;
  return { path, sizeBytes, sizeMiB: toMiB(sizeBytes) };
}

function optionalFileMeasurement(path, label) {
  if (!path) return undefined;
  const resolvedPath = resolve(path);
  if (!existsSync(resolvedPath) || !statSync(resolvedPath).isFile()) {
    throw new Error(`Missing ${label}: ${resolvedPath}`);
  }
  const sizeBytes = statSync(resolvedPath).size;
  return { sizeBytes, sizeMiB: toMiB(sizeBytes) };
}

function windowsInstallerMeasurement(entries, target) {
  if (!target?.endsWith("pc-windows-msvc")) return undefined;
  const installers = entries.filter(entry => entry.path.startsWith("nsis/") && entry.path.toLowerCase().endsWith(".exe"));
  if (installers.length !== 1) {
    throw new Error(`Expected exactly one Windows NSIS installer in the artifact bundle, found ${installers.length}.`);
  }
  return installers[0];
}

function installedExecutableMeasurements(path) {
  if (!path) return undefined;
  const resolvedPath = resolve(path);
  if (!existsSync(resolvedPath) || !statSync(resolvedPath).isFile()) {
    throw new Error(`Missing Windows installer upgrade evidence: ${resolvedPath}`);
  }
  let evidence;
  try {
    evidence = JSON.parse(readFileSync(resolvedPath, "utf8"));
  } catch {
    throw new Error(`Windows installer upgrade evidence is not valid JSON: ${resolvedPath}`);
  }
  if (evidence?.schema !== "hunsu.windows-installer-upgrade-e2e.v1" || evidence?.result !== "passed") {
    throw new Error(`Windows installer upgrade evidence did not record a passing v1 run: ${resolvedPath}`);
  }
  const appBytes = evidence?.measurements?.installedAppBytes;
  const sidecarBytes = evidence?.measurements?.installedSidecarBytes;
  if (!Number.isSafeInteger(appBytes) || appBytes <= 0 || !Number.isSafeInteger(sidecarBytes) || sidecarBytes <= 0) {
    throw new Error(`Windows installer upgrade evidence is missing installed executable sizes: ${resolvedPath}`);
  }
  return {
    app: { sizeBytes: appBytes, sizeMiB: toMiB(appBytes) },
    sidecar: { sizeBytes: sidecarBytes, sizeMiB: toMiB(sidecarBytes) }
  };
}

function helperMeasurements(explicitPaths) {
  const paths = explicitPaths.length > 0
    ? explicitPaths.map(path => resolve(path))
    : [
        join(packageRoot, "src-tauri/windows/installer-template.nsi"),
        join(packageRoot, "src-tauri/windows/installer-hooks.nsh"),
        join(packageRoot, "src-tauri/windows/stop-existing-bridge.ps1")
      ];
  const existing = paths.filter(path => existsSync(path) && statSync(path).isFile());
  if (baselinePath && existing.length !== paths.length) {
    const missing = paths.filter(path => !existing.includes(path)).map(path => basename(path)).join(", ");
    throw new Error(`Missing installer lifecycle helper source for the Windows size guard: ${missing}`);
  }
  return existing
    .map(path => fileMeasurement(basename(path), path))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function sidecarSizes(manifestPath, expectedTarget) {
  if (!existsSync(manifestPath)) {
    throw new Error(`Missing sidecar manifest: ${manifestPath}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest?.schema !== "hunsu.bridge-sidecars.v1" || !Array.isArray(manifest.artifacts)) {
    throw new Error(`Invalid sidecar manifest: ${manifestPath}`);
  }
  if (manifest.artifacts.length !== 1) {
    throw new Error(`Expected exactly one staged sidecar, found ${manifest.artifacts.length}.`);
  }
  const artifact = manifest.artifacts[0];
  if (typeof artifact?.target !== "string" || typeof artifact?.file !== "string" || basename(artifact.file) !== artifact.file) {
    throw new Error(`Invalid sidecar artifact entry in ${manifestPath}`);
  }
  if (manifest.target !== artifact.target) {
    throw new Error(`Sidecar manifest target ${String(manifest.target)} does not match ${artifact.target}.`);
  }
  if (expectedTarget && artifact.target !== expectedTarget) {
    throw new Error(`Expected sidecar target ${expectedTarget}, found ${artifact.target}.`);
  }
  const path = resolve(dirname(manifestPath), artifact.file);
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`Missing staged sidecar artifact: ${path}`);
  }
  const sizeBytes = statSync(path).size;
  return [{
    target: artifact.target,
    file: artifact.file,
    sizeBytes,
    sizeMiB: toMiB(sizeBytes)
  }];
}

function windowsSizeBaseline(path) {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`Missing Windows artifact size baseline: ${path}`);
  }
  const baseline = JSON.parse(readFileSync(path, "utf8"));
  if (baseline?.schema !== "hunsu.bridge-desktop-windows-size-baseline.v1"
    || !Number.isSafeInteger(baseline?.measurements?.installerBytes)
    || baseline.measurements.installerBytes <= 0
    || !Number.isSafeInteger(baseline?.measurements?.artifactZipBytes)
    || baseline.measurements.artifactZipBytes <= 0
    || typeof baseline?.policy?.maximumGrowthPercent !== "number"
    || baseline.policy.maximumGrowthPercent <= 0
    || !Number.isSafeInteger(baseline?.policy?.minimumGrowthAllowanceBytes)
    || baseline.policy.minimumGrowthAllowanceBytes <= 0) {
    throw new Error(`Invalid Windows artifact size baseline: ${path}`);
  }
  return baseline;
}

function verifyPackagingPolicy(path, required) {
  if (!required) {
    return {
      configurationChecked: false,
      fixedWebViewRuntimeBundled: false,
      fixedWebViewRuntimeAllowedForThisChange: false
    };
  }
  const resolvedPath = resolve(path);
  if (!existsSync(resolvedPath) || !statSync(resolvedPath).isFile()) {
    throw new Error(`Missing Tauri configuration for the Windows packaging policy: ${resolvedPath}`);
  }
  let config;
  try {
    config = JSON.parse(readFileSync(resolvedPath, "utf8"));
  } catch {
    throw new Error(`Tauri configuration is not valid JSON: ${resolvedPath}`);
  }
  const windowsBundleConfig = config?.bundle?.windows ?? {};
  const webviewMode = windowsBundleConfig?.webviewInstallMode?.type;
  const resources = Array.isArray(config?.bundle?.resources) ? config.bundle.resources : [];
  const fixedRuntimeResource = resources.some(resource => typeof resource === "string" && /(?:fixed.?runtime|webview2)/iu.test(resource));
  if (webviewMode === "fixedRuntime" || fixedRuntimeResource) {
    throw new Error("A fixed WebView runtime is not allowed in the Windows installer upgrade fix.");
  }
  return {
    configurationChecked: true,
    fixedWebViewRuntimeBundled: false,
    fixedWebViewRuntimeAllowedForThisChange: false
  };
}

function evaluateGrowthPolicy({ baseline, installerBytes, artifactZipBytes, exception }) {
  if (!Number.isSafeInteger(installerBytes) || !Number.isSafeInteger(artifactZipBytes)) {
    throw new Error("Windows artifact size policy requires installer and artifact ZIP sizes.");
  }
  const metrics = [
    ["installerBytes", baseline.measurements.installerBytes, installerBytes],
    ["artifactZipBytes", baseline.measurements.artifactZipBytes, artifactZipBytes]
  ];
  const checks = metrics.map(([metric, baselineBytes, currentBytes]) => {
    const percentageAllowance = Math.ceil(baselineBytes * baseline.policy.maximumGrowthPercent / 100);
    const allowedGrowthBytes = Math.max(percentageAllowance, baseline.policy.minimumGrowthAllowanceBytes);
    const growthBytes = currentBytes - baselineBytes;
    const exceeded = growthBytes > allowedGrowthBytes;
    return {
      metric,
      baselineBytes,
      currentBytes,
      growthBytes,
      allowedGrowthBytes,
      maximumBytes: baselineBytes + allowedGrowthBytes,
      status: exceeded ? (exception ? "excepted" : "failed") : "passed"
    };
  });
  const failed = checks.some(check => check.status === "failed");
  const excepted = checks.some(check => check.status === "excepted");
  return {
    status: failed ? "failed" : excepted ? "passed-with-reviewed-exception" : "passed",
    maximumGrowthPercent: baseline.policy.maximumGrowthPercent,
    minimumGrowthAllowanceBytes: baseline.policy.minimumGrowthAllowanceBytes,
    reviewedException: exception ?? null,
    baselineSource: baseline.source,
    checks
  };
}

function toMiB(bytes) {
  return Number((bytes / 1024 / 1024).toFixed(2));
}
