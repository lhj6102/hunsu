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

test("Bridge desktop Rust quit flow wires immediate confirmation to bounded commands", () => {
  const source = readFileSync(rustSourcePath, "utf8");
  const quitEntryStart = source.indexOf("fn quit_bridge_app(");
  const confirmationBoundaryStart = source.indexOf(
    "fn confirm_before_resolving_quit_preference"
  );
  const quitEntry = source.slice(quitEntryStart, confirmationBoundaryStart);
  const preferenceRead = source.match(
    /async fn quit_background_preference\([\s\S]*?\n\}\n\nfn quit_background_preference_from_output/u
  )?.[0];
  const stopCommand = source.match(
    /async fn stop_background_bridge\([\s\S]*?\n\}\n\nfn stop_command_result_is_success/u
  )?.[0];

  assert.equal(quitEntryStart >= 0, true);
  assert.equal(confirmationBoundaryStart > quitEntryStart, true);
  assert.match(quitEntry, /QUIT_CONFIRMATION_MESSAGE[\s\S]*?\.blocking_show\(\)/u);
  assert.equal(
    quitEntry.indexOf(".blocking_show()") <
      quitEntry.indexOf("finish_confirmed_quit"),
    true
  );
  assert.match(
    source,
    /Your configured background-service preference will be applied\./u
  );
  assert.match(
    source,
    /const QUIT_PREFERENCE_ARGS: \[&str; 3\] = \["settings", "quit-behavior", "get"\]/u
  );
  assert.match(source, /const QUIT_PREFERENCE_TIMEOUT: Duration = Duration::from_secs\(1\)/u);
  assert.ok(preferenceRead, "lightweight quit preference read must remain present");
  assert.doesNotMatch(preferenceRead, /bridge_snapshot|snapshot/u);
  assert.match(source, /const QUIT_STOP_ARGS: \[&str; 2\] = \["stop", "--json"\]/u);
  assert.match(source, /const QUIT_STOP_TIMEOUT: Duration = Duration::from_secs\(10\)/u);
  assert.ok(stopCommand, "bounded stop command must remain present");
  assert.match(stopCommand, /tokio::time::timeout/u);
  assert.match(source, /output\.status\.success\(\)[\s\S]*result\["ok"\]\.as_bool\(\)/u);
  assert.match(source, /show_stop_background_failure\(&app, failure\);\s+return;/u);
});
