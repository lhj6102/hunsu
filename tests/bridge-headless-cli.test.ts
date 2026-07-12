import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseBridgeCliArgs, runBridgeCli } from "../apps/bridge/src/cli.ts";
import { runBridgeClientCommand } from "../apps/bridge/src/client/clientCommands.ts";
import { bridgeNotRunningResult, cliSuccess } from "../apps/bridge/src/client/cliResult.ts";
import type { BridgeControlClient, BridgeControlRequest } from "../apps/bridge/src/client/controlClient.ts";
import { startBridgeDaemon, type RunningBridgeDaemon } from "../apps/bridge/src/daemon/daemon.ts";
import { resolveHunsuPaths } from "../apps/bridge/src/state/paths.ts";

const fakeCodexPath = fileURLToPath(new URL("fixtures/fake-codex.mjs", import.meta.url));

test("every offline client command family returns the exact stable BRIDGE_NOT_RUNNING result without creating state", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunsu-headless-cli-"));
  const home = join(root, "not-created-state");
  const workspace = join(root, "workspace");
  const codexHome = join(root, "codex-home");
  const commands: string[][] = [
    ["status"],
    ["logs"],
    ["provider", "list"],
    ["provider", "status"],
    ["provider", "check", "codex"],
    ["provider", "set", "codex", "--codex-home", codexHome],
    ["provider", "reset", "codex"],
    ["workspace", "list"],
    ["workspace", "add", workspace],
    ["workspace", "inspect", "ws_missing"],
    ["workspace", "remove", "ws_missing"],
    ["workspace", "open", "ws_missing"],
    ["workspace", "grant", "ws_missing"],
    ["workspace", "revoke", "ws_missing"],
    ["credential", "rotate"],
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

    assert.equal(await exists(home), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("global options are position-independent and duplicate, unknown, or command-inapplicable options fail as one JSON result", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunsu-headless-cli-options-"));
  const home = join(root, "state");
  try {
    const positioned = await invoke(["--json", "--home", home, "status"]);
    assert.equal(positioned.code, 1);
    assert.deepEqual(positioned.stdout, [JSON.stringify(bridgeNotRunningResult())]);
    assert.deepEqual(positioned.stderr, []);

    const invalidCommands = [
      ["status", "--home", home, "--home", home, "--json"],
      ["status", "--unknown", "value", "--json"],
      ["status", "--binary", fakeCodexPath, "--json"],
      ["status", "--runtime-path", root, "--json"],
      ["status", "--json=false"]
    ];
    for (const command of invalidCommands) {
      const result = await invoke(command);
      assert.equal(result.code, 1, command.join(" "));
      assert.equal(result.stdout.length, 1, command.join(" "));
      assert.deepEqual(result.stderr, [], command.join(" "));
      const parsed = JSON.parse(result.stdout[0]!) as { ok?: boolean; code?: string; message?: string };
      assert.equal(parsed.ok, false, command.join(" "));
      assert.equal(parsed.code, "BRIDGE_STATE_INVALID", command.join(" "));
      assert.equal(typeof parsed.message, "string", command.join(" "));
    }

    assert.equal(parseBridgeCliArgs(["daemon", "--runtime-path", root]).flags.get("runtime-path"), root);

    const help = await invoke(["--json", "help"]);
    assert.equal(help.code, 0);
    assert.equal(help.stdout.length, 1);
    assert.deepEqual(help.stderr, []);
    const helpResult = JSON.parse(help.stdout[0]!) as { value?: { usage?: string } };
    assert.match(helpResult.value?.usage ?? "", /--codex-home <path>/u);
    assert.match(helpResult.value?.usage ?? "", /--home <path>\s+Use an explicit HUNSU_HOME/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--home always selects HUNSU_HOME while --codex-home configures Codex Home", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "hunsu-headless-cli-homes-"));
  const home = join(root, "bridge-state");
  const codexHome = join(root, "codex-state");
  let daemon: RunningBridgeDaemon | undefined;
  try {
    daemon = await startBridgeDaemon({
      home,
      port: 0,
      cwd: root,
      development: true,
      env: { HUNSU_FAKE_CODEX_MODE: "ready" },
      openBrowser: async () => undefined
    });
    const configured = await invoke([
      "--json",
      "--codex-home",
      codexHome,
      "provider",
      "set",
      "codex",
      "--home",
      home,
      "--binary",
      fakeCodexPath
    ]);
    assert.equal(configured.code, 0, configured.stdout.join("\n"));
    assert.equal(configured.stdout.length, 1);
    assert.deepEqual(configured.stderr, []);
    const config = JSON.parse(await readFile(join(home, "config.json"), "utf8")) as {
      provider?: { kind?: string; binaryPath?: string; home?: string };
    };
    assert.deepEqual(config.provider, {
      kind: "codex",
      binaryPath: fakeCodexPath,
      home: codexHome
    });

    const oldAmbiguous = await invoke(["provider", "set", "codex", "--home", codexHome, "--json"]);
    assert.equal(oldAmbiguous.code, 1);
    assert.equal(oldAmbiguous.stdout.length, 1);
    assert.deepEqual(oldAmbiguous.stderr, []);
    const oldResult = JSON.parse(oldAmbiguous.stdout[0]!) as { ok?: boolean; code?: string; message?: string };
    assert.equal(oldResult.ok, false);
    assert.equal(oldResult.code, "BRIDGE_NOT_RUNNING");
    assert.match(oldResult.message ?? "", /--home selects HUNSU_HOME; use --codex-home/u);
    assert.equal(await exists(codexHome), false);
  } finally {
    await daemon?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("provider client operations use a bounded probe-and-control deadline", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunsu-headless-provider-timeout-"));
  const calls: Array<{ path: string; input?: BridgeControlRequest }> = [];
  const client: BridgeControlClient = {
    endpoint: async () => "http://127.0.0.1:43127",
    probe: async () => ({ state: "hunsu-healthy" }),
    health: async () => undefined,
    async request(path, input) {
      calls.push({ path, input });
      return cliSuccess("Provider operation completed.");
    }
  };
  try {
    for (const argv of [
      ["provider", "list"],
      ["provider", "status"],
      ["provider", "check", "codex"],
      ["provider", "set", "codex", "--binary", fakeCodexPath],
      ["provider", "reset", "codex"]
    ]) {
      assert.equal(await runBridgeClientCommand({
        parsed: parseBridgeCliArgs(argv),
        paths: resolveHunsuPaths({ home: root }),
        client,
        emit: result => result.ok ? 0 : 1
      }), 0);
    }
    assert.equal(calls.length, 5);
    assert.equal(calls.every(call => call.input?.timeoutMs === 20_000), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("credential rotate emits the stable safe JSON result and leaves the daemon authenticated", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunsu-headless-cli-rotation-"));
  const home = join(root, "state");
  let daemon: RunningBridgeDaemon | undefined;
  try {
    daemon = await startBridgeDaemon({
      home,
      port: 0,
      cwd: root,
      development: true,
      openBrowser: async () => undefined
    });
    const rotated = await invoke(["credential", "rotate", "--home", home, "--json"]);
    assert.equal(rotated.code, 0);
    assert.deepEqual(rotated.stderr, []);
    assert.deepEqual(rotated.stdout, [JSON.stringify({
      schema: "hunsu.bridge.cli-result.v1",
      ok: true,
      code: "CONTROL_CREDENTIAL_ROTATED",
      message: "Hunsu Bridge control credential was rotated.",
      value: { rotated: true, pairingPreserved: true }
    })]);
    const status = await invoke(["status", "--home", home, "--json"]);
    assert.equal(status.code, 0);
    assert.equal(JSON.parse(status.stdout[0]!).ok, true);
  } finally {
    await daemon?.close().catch(() => undefined);
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

test("doctor returns a successful issue envelope when config and credential state are corrupt", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunsu-headless-cli-corrupt-doctor-"));
  const home = join(root, "state");
  try {
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "config.json"), "{not-json", "utf8");
    await writeFile(join(home, "credentials.json"), `${JSON.stringify({ schema: "wrong" })}\n`, "utf8");
    const result = await invoke(["doctor", "--home", home, "--json"]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout.length, 1);
    assert.deepEqual(result.stderr, []);
    const parsed = JSON.parse(result.stdout[0]!) as {
      ok?: boolean;
      value?: { mode?: string; issues?: Array<{ code?: string; message?: string }> };
    };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.value?.mode, "offline");
    assert.equal(parsed.value?.issues?.filter(issue => issue.code === "BRIDGE_STATE_INVALID").length, 2);
    assert.equal(JSON.stringify(parsed.value?.issues).includes(root), false);
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
