import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexCliLaunchCommand } from "../apps/bridge/src/runtime-providers/codex/codexDetection.ts";
import { runDefaultCodexInstaller } from "../apps/bridge/src/runtime-providers/codex/codexInstall.ts";

test("Codex CLI launch uses ComSpec for Windows cmd and bat shims", () => {
  const commandPath = String.raw`C:\Users\Dev User\AppData\Roaming\npm\codex.cmd`;
  assert.deepEqual(
    codexCliLaunchCommand(commandPath, ["login", "--device-auth"], { ComSpec: String.raw`C:\Windows\System32\cmd.exe` }, "win32"),
    {
      command: String.raw`C:\Windows\System32\cmd.exe`,
      args: ["/d", "/s", "/c", `""${commandPath}" "login" "--device-auth""`]
    }
  );

  const batchPath = String.raw`C:\tools\codex.bat`;
  assert.deepEqual(
    codexCliLaunchCommand(batchPath, ["login"], { COMSPEC: String.raw`D:\Windows\cmd.exe` }, "win32"),
    {
      command: String.raw`D:\Windows\cmd.exe`,
      args: ["/d", "/s", "/c", `""${batchPath}" "login""`]
    }
  );
});

test("Codex CLI launch executes native binaries directly", () => {
  assert.deepEqual(
    codexCliLaunchCommand(String.raw`C:\tools\codex.exe`, ["login"], {}, "win32"),
    { command: String.raw`C:\tools\codex.exe`, args: ["login"] }
  );
  assert.deepEqual(
    codexCliLaunchCommand("/tmp/codex.cmd", ["login"], {}, "linux"),
    { command: "/tmp/codex.cmd", args: ["login"] }
  );
});

test("Codex installer launches npm.cmd through ComSpec on Windows", async () => {
  const root = mkdtempSync(join(tmpdir(), "hunsu-codex-installer-launch-"));
  const comspec = join(root, "cmd.exe");
  const evidence = join(root, "args.json");
  writeFileSync(comspec, [
    `#!${process.execPath}`,
    "const fs = require('node:fs');",
    "fs.writeFileSync(process.env.HUNSU_TEST_INSTALL_ARGS, JSON.stringify(process.argv.slice(2)));"
  ].join("\n"), "utf8");
  chmodSync(comspec, 0o755);
  try {
    const result = await runDefaultCodexInstaller({
      env: {
        ComSpec: comspec,
        HUNSU_TEST_INSTALL_ARGS: evidence
      },
      platform: "win32"
    });
    assert.equal(result.ok, true);
    assert.equal(result.command, "npm.cmd");
    assert.deepEqual(result.args, ["install", "-g", "@openai/codex@latest"]);
    assert.deepEqual(JSON.parse(readFileSync(evidence, "utf8")), [
      "/d",
      "/s",
      "/c",
      '""npm.cmd" "install" "-g" "@openai/codex@latest""'
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
