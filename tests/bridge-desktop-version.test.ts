import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const candidateVersion = "0.1.1";
const desktopPackage = JSON.parse(
  readFileSync("apps/bridge-desktop/package.json", "utf8")
) as { version?: string };
const tauriConfig = JSON.parse(
  readFileSync("apps/bridge-desktop/src-tauri/tauri.conf.json", "utf8")
) as { version?: string };
const cargoManifest = readFileSync(
  "apps/bridge-desktop/src-tauri/Cargo.toml",
  "utf8"
);
const cargoLock = readFileSync(
  "apps/bridge-desktop/src-tauri/Cargo.lock",
  "utf8"
);
const bridgeAppSource = readFileSync(
  "apps/bridge-desktop/src/main.ts",
  "utf8"
);

test("Windows upgrade candidate keeps the desktop version synchronized at 0.1.1", () => {
  assert.equal(desktopPackage.version, candidateVersion);
  assert.equal(tauriConfig.version, candidateVersion);
  assert.match(
    cargoManifest,
    /^name = "hunsu-bridge"\nversion = "0\.1\.1"$/mu
  );
  assert.match(
    cargoLock,
    /\[\[package\]\]\nname = "hunsu-bridge"\nversion = "0\.1\.1"\n/u
  );
  assert.match(
    bridgeAppSource,
    /const HUNSU_BRIDGE_APP_VERSION = "0\.1\.1";/u
  );
  assert.notEqual(candidateVersion, "0.1.0");
});
