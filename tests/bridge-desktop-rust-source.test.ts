import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const rustSourcePath = join(
  process.cwd(),
  "apps/bridge-desktop/src-tauri/src/main.rs"
);

test("Bridge desktop Rust tray menu propagates construction errors and returns its menu", () => {
  const source = readFileSync(rustSourcePath, "utf8");
  const trayMenu = source.match(
    /fn bridge_tray_menu\([\s\S]*?\n\}\n\nasync fn refresh_bridge_tray_menu/u
  )?.[0];

  assert.ok(trayMenu, "bridge_tray_menu must remain present");
  assert.match(trayMenu, /MenuItemBuilder[\s\S]*?\.build\(app\)\?/u);
  assert.match(trayMenu, /\.build\(\)\?;\s+Ok\(menu\)/u);
  assert.doesNotMatch(trayMenu, /\.unwrap\(\)|\.expect\(/u);
});

test("Bridge desktop Rust quit confirmation uses blocking_show as a boolean", () => {
  const source = readFileSync(rustSourcePath, "utf8");
  const quitFlow = source.match(
    /async fn quit_bridge_app_async\([\s\S]*?\n\}\n\n#\[derive/u
  )?.[0];

  assert.ok(quitFlow, "quit_bridge_app_async must remain present");
  assert.match(quitFlow, /\.blocking_show\(\);\s+if !should_quit \{/u);
  assert.match(quitFlow, /QuitBackgroundPreference::StopBackground[\s\S]*?\.arg\("stop"\)/u);
  assert.match(quitFlow, /app\.exit\(0\)/u);
  assert.doesNotMatch(source, /MessageDialogResult|matches!\(should_quit/u);
});
