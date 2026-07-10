import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

test("Bridge desktop Rust validation is locked and avoids duplicate workflow compilation", () => {
  const rootPackage = JSON.parse(
    readFileSync(join(process.cwd(), "package.json"), "utf8")
  ) as { scripts: Record<string, string> };
  const workflow = readFileSync(
    join(process.cwd(), ".github/workflows/bridge-desktop-artifacts.yml"),
    "utf8"
  );

  assert.equal(
    rootPackage.scripts["check:desktop-rust"],
    "cargo fmt --manifest-path apps/bridge-desktop/src-tauri/Cargo.toml -- --check && cargo check --locked --manifest-path apps/bridge-desktop/src-tauri/Cargo.toml"
  );
  assert.equal(
    existsSync(join(process.cwd(), "apps/bridge-desktop/src-tauri/Cargo.lock")),
    true
  );
  assert.match(workflow, /cache-on-failure: true/u);
  assert.doesNotMatch(workflow, /cargo check/u);
});
