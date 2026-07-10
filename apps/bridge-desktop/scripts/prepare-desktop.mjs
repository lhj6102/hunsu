#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildNativeSidecars } from "./build-native-sidecars.mjs";
import { cleanPreparedSidecars, currentSidecarTarget } from "./prepare-sidecars.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = resolve(root, "dist");

export async function prepareDesktopSidecar(options = {}) {
  const target = currentSidecarTarget(options.platform, options.arch);
  const outputDir = resolve(options.distDir ?? dist);
  const buildSidecars = options.buildSidecars ?? buildNativeSidecars;

  cleanPreparedSidecars(outputDir);
  try {
    const result = await buildSidecars({ target: target.target, distDir: outputDir });
    validatePreparedDesktopSidecar(result, target.target);
    return result;
  } catch (error) {
    cleanPreparedSidecars(outputDir);
    throw error;
  }
}

function validatePreparedDesktopSidecar(result, expectedTarget) {
  const builtTargets = result?.artifacts?.map(artifact => artifact.target) ?? [];
  if (builtTargets.length !== 1 || builtTargets[0] !== expectedTarget) {
    throw new Error(
      `Desktop preparation must build exactly the current Hunsu Bridge sidecar target ${expectedTarget}; built ${builtTargets.join(", ") || "none"}.`
    );
  }

  const preparedTargets = result?.preparedManifest?.artifacts?.map(artifact => artifact.target) ?? [];
  if (result?.preparedManifest?.target !== expectedTarget || preparedTargets.length !== 1 || preparedTargets[0] !== expectedTarget) {
    throw new Error(
      `Desktop preparation must prepare exactly the current Hunsu Bridge sidecar target ${expectedTarget}; prepared ${preparedTargets.join(", ") || "none"}.`
    );
  }
}

function isCurrentScriptEntrypoint() {
  const entrypoint = process.argv[1];
  return Boolean(entrypoint) && import.meta.url === pathToFileURL(resolve(entrypoint)).href;
}

if (isCurrentScriptEntrypoint()) {
  prepareDesktopSidecar()
    .then(result => {
      console.log(`Prepared Hunsu Bridge desktop sidecar for ${result.preparedManifest.target} in ${dist}.`);
    })
    .catch(error => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
