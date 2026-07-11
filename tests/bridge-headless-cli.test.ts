import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runBridgeCli } from "../apps/bridge/src/cli.ts";
import { bridgeNotRunningResult } from "../apps/bridge/src/client/cliResult.ts";

test("every offline client command family returns the exact stable BRIDGE_NOT_RUNNING result without creating state", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunsu-headless-cli-"));
  const home = join(root, "not-created-state");
  const workspace = join(root, "workspace");
  const commands: string[][] = [
    ["status"],
    ["logs"],
    ["provider", "list"],
    ["provider", "status"],
    ["provider", "check", "codex"],
    ["provider", "reset", "codex"],
    ["workspace", "list"],
    ["workspace", "add", workspace],
    ["workspace", "inspect", "ws_missing"],
    ["workspace", "remove", "ws_missing"],
    ["workspace", "open", "ws_missing"],
    ["workspace", "grant", "ws_missing"],
    ["workspace", "revoke", "ws_missing"],
    ["pair"],
    ["pair", "revoke"],
    ["open"],
    ["login", "--no-open"],
    ["logout"],
    ["remote", "status"],
    ["remote", "enable"],
    ["remote", "disable"]
  ];
  try {
    const pid = process.pid;
    for (const command of commands) {
      const output = await invoke([...command, "--home", home, "--json"]);
      assert.equal(output.code, 1, command.join(" "));
      assert.deepEqual(output.stdout, [JSON.stringify(bridgeNotRunningResult())], command.join(" "));
      assert.deepEqual(output.stderr, [], command.join(" "));
      assert.equal(process.pid, pid);
      assert.equal(await exists(home), false, `${command.join(" ")} must not create HUNSU_HOME`);
    }

    const previousHome = process.env.HUNSU_HOME;
    process.env.HUNSU_HOME = home;
    try {
      const providerSet = await invoke(["provider", "set", "codex", "--home", join(root, "codex-home"), "--json"]);
      assert.equal(providerSet.code, 1);
      assert.deepEqual(providerSet.stdout, [JSON.stringify(bridgeNotRunningResult())]);
      assert.deepEqual(providerSet.stderr, []);
    } finally {
      if (previousHome === undefined) delete process.env.HUNSU_HOME;
      else process.env.HUNSU_HOME = previousHome;
    }
    assert.equal(await exists(home), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline doctor is an explicit read-only exception and does not start or persist a daemon", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunsu-headless-cli-doctor-"));
  const home = join(root, "state");
  try {
    const result = await invoke(["doctor", "--home", home, "--json"]);
    assert.equal(result.code, 0);
    assert.deepEqual(result.stderr, []);
    assert.equal(result.stdout.length, 1);
    const parsed = JSON.parse(result.stdout[0]!) as {
      ok: boolean;
      code: string;
      value?: { mode?: string; state?: { runtimePresent?: boolean } };
    };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.code, "OK");
    assert.equal(parsed.value?.mode, "offline");
    assert.equal(parsed.value?.state?.runtimePresent, false);
    assert.equal(await exists(home), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function invoke(argv: string[]): Promise<{ code: number; stdout: string[]; stderr: string[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runBridgeCli(argv, {
    stdout: value => stdout.push(value),
    stderr: value => stderr.push(value)
  });
  return { code, stdout, stderr };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (_error) {
    return false;
  }
}
